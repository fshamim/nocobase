/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 054 R1 — receipt reconciliation inside the scheduled Gold promotion.
 *
 * Sellerboard imports move the arrival evidence (ordered -> inbound -> stock
 * bucket shifts) but nothing used to stamp that evidence onto Silver order
 * lines outside of a manual admin action. This module is the seam the
 * Sellerboard-triggered Gold promotion runs *before* publishing, so the inbound
 * pane's arrival chips and `confirmInboundCompletion` eligibility are produced
 * by the machine and survive republish.
 *
 * This writes input data (Silver order-line receipt fields). The Gold engine
 * already consumes those fields at read time, so there is no formula change and
 * no Gold version bump.
 */

import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import type { EcobaseDatabase } from '../../../source-import/server/import-service';
import {
  EcobaseOrderReceiptReconciliationService,
  receiptReconciliationOrderIdsForRefresh,
  type ReceiptReconciliationResult,
} from './order-receipt-reconciliation-service';

/** Matches the Silver order scan budget used by the manual Gold rebuild path. */
export const SCHEDULED_RECEIPT_RECONCILIATION_ORDER_LIMIT = 20000;

export interface ScheduledReceiptReconciliationInput {
  /** Companies whose Sellerboard data committed in this window. Empty = unknown scope. */
  companyIds?: readonly string[];
  evaluatedAt?: string;
}

export interface ScheduledReceiptReconciliationOutcome {
  scopedCompanyIds: string[];
  candidateOrderIds: string[];
  reconciliation: ReceiptReconciliationResult | null;
}

export interface ScheduledReceiptReconciliationLogger {
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

function text(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Selects and reconciles the receipt candidates for one scheduled refresh.
 *
 * Eligibility stays owned by `receiptReconciliationOrderIdsForRefresh`: orders
 * still sitting in `awaiting_amazon_stock` / `partially_observed`. The company
 * scope only *narrows* which orders that selector sees; when the scope is
 * unknowable the full Silver order set is offered and every reconciliation
 * eligible open order is refreshed (correctness over cleverness — the candidate
 * set is small).
 *
 * Throws on repository or reconciliation failure; the caller decides isolation.
 */
export async function reconcileReceiptsForScheduledRefresh(
  db: EcobaseDatabase,
  input: ScheduledReceiptReconciliationInput = {},
): Promise<ScheduledReceiptReconciliationOutcome> {
  const scopedCompanyIds = [
    ...new Set((input.companyIds ?? []).map(text).filter((id): id is string => Boolean(id))),
  ].sort();
  const orders = (
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({
      limit: SCHEDULED_RECEIPT_RECONCILIATION_ORDER_LIMIT,
    })
  ).map(record);
  const scopedOrders = scopedCompanyIds.length
    ? orders.filter((order) => scopedCompanyIds.includes(text(order.companyId) ?? ''))
    : orders;
  // No explicit affected-order ids: a committed Sellerboard unit identifies a
  // source connection and its company, never individual Silver orders. The
  // company scope is applied above by narrowing the order set instead.
  const candidateOrderIds = receiptReconciliationOrderIdsForRefresh(scopedOrders, []);
  if (candidateOrderIds.length === 0) {
    return { scopedCompanyIds, candidateOrderIds, reconciliation: null };
  }
  const reconciliation = await new EcobaseOrderReceiptReconciliationService(db).reconcileAffectedOrders({
    orderIds: candidateOrderIds,
    evaluatedAt: input.evaluatedAt,
  });
  return { scopedCompanyIds, candidateOrderIds, reconciliation };
}

/**
 * Accumulates the company scope of committed Sellerboard import units across a
 * debounce window and reconciles it once per Gold promotion.
 *
 * `reconcilePendingScope` never throws: a reconciliation failure is logged and
 * counted, and the caller still publishes Gold.
 */
export class EcobaseScheduledReceiptReconciler {
  private pendingCompanyIds = new Set<string>();
  private failureCount = 0;
  private lastError?: string;

  constructor(
    private readonly db: EcobaseDatabase,
    private readonly logger?: ScheduledReceiptReconciliationLogger,
  ) {}

  get failures() {
    return this.failureCount;
  }

  get lastFailureMessage() {
    return this.lastError;
  }

  recordCommittedUnit(unit: { companyId?: string }) {
    const companyId = text(unit.companyId);
    if (companyId) this.pendingCompanyIds.add(companyId);
  }

  async reconcilePendingScope(evaluatedAt?: string): Promise<ScheduledReceiptReconciliationOutcome | null> {
    // Snapshot and clear first: units committed while this runs belong to the
    // next promotion window, never to this one.
    const companyIds = [...this.pendingCompanyIds].sort();
    this.pendingCompanyIds.clear();
    try {
      const outcome = await reconcileReceiptsForScheduledRefresh(this.db, { companyIds, evaluatedAt });
      this.logger?.info?.('Ecobase scheduled receipt reconciliation completed.', {
        scopedCompanyIds: outcome.scopedCompanyIds,
        candidateOrderCount: outcome.candidateOrderIds.length,
        updatedOrders: outcome.reconciliation?.updatedOrders ?? 0,
        updatedLines: outcome.reconciliation?.updatedLines ?? 0,
        reviewRequired: outcome.reconciliation?.reviewRequired ?? 0,
        errorCount: outcome.reconciliation?.errors.length ?? 0,
      });
      return outcome;
    } catch (error) {
      this.failureCount += 1;
      this.lastError =
        error instanceof Error ? error.message : 'Ecobase scheduled receipt reconciliation failed with a non-Error.';
      this.logger?.error?.('Ecobase scheduled receipt reconciliation failed; Gold publication proceeds.', {
        scopedCompanyIds: companyIds,
        failureCount: this.failureCount,
        lastError: this.lastError,
      });
      return null;
    }
  }
}
