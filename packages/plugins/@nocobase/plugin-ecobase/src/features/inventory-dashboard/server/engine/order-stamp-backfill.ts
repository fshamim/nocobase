/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 054 R4 — historical order stamp sweep.
 *
 * Orders imported before the T2.1 stamping matrix existed carry NULL `statusChangedAt` and
 * NULL `workflowStageEnteredAt`. The panes still render a day-clock for them because the
 * read paths fall back to `operatorStatusOverrideAt → authorityAsOf → orderDate`, but the
 * stamps themselves are empty, so the FIRST real status change after import cannot reset the
 * clock — the fallback keeps answering with an older date. This sweep writes the value the
 * fallback chain already shows into the stamp column, which changes nothing on screen today
 * and makes every future status change honest.
 *
 * Two properties make it safe to run repeatedly on production data:
 *
 * - **NULL-only.** A stamp that already holds a value is never read as a candidate, so it is
 *   never included in the update payload. Pre-stamped orders come out byte-identical.
 * - **Value-preserving.** The filled value is the first non-null of the same chain the panes
 *   read, normalised to an ISO instant. `orderDate` is a plain `YYYY-MM-DD` string and
 *   `parseDateMs` already reads such values as UTC midnight, so the day maths is unchanged.
 *
 * The sweep also closes the R2 gap: orders that were already sitting in `amazon_inbound` when
 * the inbound-entry baseline shipped have no stamped entry state. Their true entry state is
 * unrecoverable, so the sweep stamps the CURRENT snapshot through the R2 stamper and reports
 * it as `baselineProvenance: 'sweep_time_snapshot'` — from here on their bucket shift is
 * measured from the sweep date rather than from a fiction.
 *
 * Issue 070 — `authorityAsOf` is only an age signal for ClickUp-sourced orders.
 *
 * Every ClickUp apply stamped `authorityAsOf` with the RUN time on every order, including the
 * ones that run saw no ClickUp evidence for (fixed at the writer in `reconcileAuthority`). R4
 * then copied that run time into `statusChangedAt`, so a 2023 sheet order rendered as three
 * days old and evaded every follow-up flag. Two changes here:
 *
 * - `resolveOrderStampFallback` consults `authorityAsOf` ONLY for ClickUp-sourced orders. For
 *   every other order the chain falls straight through to `orderDate` — the one date the order
 *   actually owns.
 * - `repairOrderStamps` is the one-time corrective sweep for rows R4 already wiped: a
 *   non-ClickUp order whose `statusChangedAt` is byte-identical to its `authorityAsOf` gets
 *   re-derived from `orderDate`. Like the R4 sweep it defaults to a dry run and is idempotent.
 */

import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import type { EcobaseDatabase } from '../../../source-import/server/import-service';
import { AMAZON_INBOUND_WORKFLOW_STAGE, EcobaseInboundEntryBaselineStamper } from './inbound-entry-baseline';

type Row = Record<string, unknown>;

/** Matches the Silver order scan budget used by the scheduled reconciliation path. */
export const ORDER_STAMP_BACKFILL_ORDER_LIMIT = 20000;

/**
 * 070: the `statusSource` the ClickUp status import writes. It is the only writer whose
 * `authorityAsOf` describes the order's OWN status observation, so it is the only source whose
 * orders may take their stamp from that column.
 */
export const CLICKUP_STATUS_SOURCE = 'clickup_csv';

/** The pane fallback chain, minus the stamp column being filled. Order is the priority. */
export const ORDER_STAMP_FALLBACK_SOURCES = ['operatorStatusOverrideAt', 'authorityAsOf', 'orderDate'] as const;

export type OrderStampFallbackSource = (typeof ORDER_STAMP_FALLBACK_SOURCES)[number];

export type OrderStampFallbackCounts = Record<OrderStampFallbackSource, number>;

export interface OrderStampBackfillInput {
  /** Defaults to true, matching `backfillReceipts`: a bare call previews, it never writes. */
  dryRun?: boolean;
}

export interface OrderStampBackfillResult {
  dryRun: boolean;
  /** Scan counts. These describe the sweep's reach and stay non-zero on a second run. */
  ordersScanned: number;
  inboundOrdersScanned: number;
  /** Work counts. Every one of these is 0 on a second run — that is the idempotence proof. */
  ordersUpdated: number;
  statusChangedAtFilled: number;
  workflowStageEnteredAtFilled: number;
  statusChangedAtSources: OrderStampFallbackCounts;
  workflowStageEnteredAtSources: OrderStampFallbackCounts;
  inboundBaselineOrdersStamped: number;
  inboundBaselineLinesStamped: number;
  /** Orders left NULL because not one fallback source held a usable value. */
  ordersWithoutFallbackEvidence: number;
  /** Inbound lines whose listing yielded no usable snapshot, so no baseline was written. */
  inboundBaselineLinesUnresolved: number;
  /** The recorded decision: these baselines are the sweep's snapshot, not the true entry state. */
  baselineProvenance: 'sweep_time_snapshot';
}

export interface OrderStampBackfillLogger {
  info?: (...args: unknown[]) => void;
}

export interface OrderStampRepairInput {
  /** Defaults to true, exactly like `backfillOrderStamps`: a bare call previews, it never writes. */
  dryRun?: boolean;
}

/** The `statusSource` bucket key used for orders whose `statusSource` column is NULL. */
export const UNSOURCED_STATUS_SOURCE = 'unsourced';

export interface OrderStampRepairResult {
  dryRun: boolean;
  /** Scan counts. These describe the sweep's reach and stay non-zero on a second run. */
  ordersScanned: number;
  clickupSourcedOrdersSkipped: number;
  /** Work counts. Every one of these is 0 on a second run — that is the idempotence proof. */
  ordersUpdated: number;
  statusChangedAtRepaired: number;
  workflowStageEnteredAtRepaired: number;
  /** Repaired orders keyed by the `statusSource` that owned them. */
  ordersRepairedByStatusSource: Record<string, number>;
  /** Matched the wiped-stamp predicate but hold no `orderDate` to re-derive from. */
  ordersWithoutOrderDate: number;
}

function text(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

/**
 * An ISO instant for a stamp candidate. Date-only strings (`orderDate`) become UTC midnight,
 * which is exactly the instant `parseDateMs` already derives from them at read time.
 */
function isoInstant(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  const trimmed = text(value);
  if (!trimmed) return undefined;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

/**
 * NULL-only guard. Any value the column actually holds — including one this module could not
 * parse — counts as stamped, so a malformed stamp is left for a human rather than overwritten.
 */
function isStampMissing(value: unknown) {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim() === '';
}

/**
 * First non-null of `operatorStatusOverrideAt → authorityAsOf → orderDate`.
 *
 * 070: `authorityAsOf` is skipped entirely unless ClickUp is the order's status source. On any
 * other order that column holds the last ClickUp RUN time — evidence about the import, not about
 * the order — so reading it would restate a 2023 order as days old.
 */
export function resolveOrderStampFallback(order: Row): { at: string; source: OrderStampFallbackSource } | null {
  const clickupSourced = text(order.statusSource) === CLICKUP_STATUS_SOURCE;
  for (const source of ORDER_STAMP_FALLBACK_SOURCES) {
    if (source === 'authorityAsOf' && !clickupSourced) continue;
    const at = isoInstant(order[source]);
    if (at) return { at, source };
  }
  return null;
}

function zeroCounts(): OrderStampFallbackCounts {
  return { operatorStatusOverrideAt: 0, authorityAsOf: 0, orderDate: 0 };
}

export class EcobaseOrderStampBackfillService {
  constructor(
    private readonly db: EcobaseDatabase,
    private readonly logger?: OrderStampBackfillLogger,
  ) {}

  async backfillOrderStamps(input: OrderStampBackfillInput = {}): Promise<OrderStampBackfillResult> {
    const dryRun = input.dryRun !== false;
    const orders = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({ limit: ORDER_STAMP_BACKFILL_ORDER_LIMIT })
    ).map(record);
    const result: OrderStampBackfillResult = {
      dryRun,
      ordersScanned: 0,
      inboundOrdersScanned: 0,
      ordersUpdated: 0,
      statusChangedAtFilled: 0,
      workflowStageEnteredAtFilled: 0,
      statusChangedAtSources: zeroCounts(),
      workflowStageEnteredAtSources: zeroCounts(),
      inboundBaselineOrdersStamped: 0,
      inboundBaselineLinesStamped: 0,
      ordersWithoutFallbackEvidence: 0,
      inboundBaselineLinesUnresolved: 0,
      baselineProvenance: 'sweep_time_snapshot',
    };
    const stamper = new EcobaseInboundEntryBaselineStamper(this.db);

    for (const order of orders) {
      const orderId = text(order.id);
      if (!orderId) continue;
      result.ordersScanned += 1;

      const needsStatusChangedAt = isStampMissing(order.statusChangedAt);
      const needsStageEnteredAt = isStampMissing(order.workflowStageEnteredAt);
      const fallback = needsStatusChangedAt || needsStageEnteredAt ? resolveOrderStampFallback(order) : null;
      const values: Row = {};
      if (fallback) {
        if (needsStatusChangedAt) {
          values.statusChangedAt = fallback.at;
          result.statusChangedAtFilled += 1;
          result.statusChangedAtSources[fallback.source] += 1;
        }
        if (needsStageEnteredAt) {
          values.workflowStageEnteredAt = fallback.at;
          result.workflowStageEnteredAtFilled += 1;
          result.workflowStageEnteredAtSources[fallback.source] += 1;
        }
      } else if (needsStatusChangedAt || needsStageEnteredAt) {
        result.ordersWithoutFallbackEvidence += 1;
      }
      if (Object.keys(values).length > 0) {
        result.ordersUpdated += 1;
        if (!dryRun) {
          await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
        }
      }

      if (text(order.workflowStage) !== AMAZON_INBOUND_WORKFLOW_STAGE) continue;
      result.inboundOrdersScanned += 1;
      const baselines = await stamper.stampMissingBaselines({ orderId, dryRun });
      result.inboundBaselineLinesStamped += baselines.stampedLines;
      result.inboundBaselineLinesUnresolved += baselines.unresolvedLines;
      if (baselines.stampedLines > 0) result.inboundBaselineOrdersStamped += 1;
    }

    this.logger?.info?.('Ecobase order stamp backfill completed.', { ...result });
    return result;
  }

  /**
   * 070 one-time corrective sweep for the stamps R4 copied off `authorityAsOf`.
   *
   * Candidate: a NON-ClickUp-sourced order whose `statusChangedAt` is byte-identical to its
   * `authorityAsOf` — the exact signature R4 leaves behind, and a coincidence no other writer
   * produces, because every other writer stamps the two columns at different moments. Such an
   * order is re-derived from `orderDate`, the one date it actually owns.
   *
   * `workflowStageEnteredAt` is repaired under the SAME per-column test rather than blindly: a
   * later import may have stamped a REAL stage entry on one of these orders, and that is a true
   * signal the sweep must not overwrite. A stage stamp left NULL here is filled from `orderDate`
   * by the next `backfillOrderStamps` run anyway, so both paths converge.
   */
  async repairOrderStamps(input: OrderStampRepairInput = {}): Promise<OrderStampRepairResult> {
    const dryRun = input.dryRun !== false;
    const orders = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({ limit: ORDER_STAMP_BACKFILL_ORDER_LIMIT })
    ).map(record);
    const result: OrderStampRepairResult = {
      dryRun,
      ordersScanned: 0,
      clickupSourcedOrdersSkipped: 0,
      ordersUpdated: 0,
      statusChangedAtRepaired: 0,
      workflowStageEnteredAtRepaired: 0,
      ordersRepairedByStatusSource: {},
      ordersWithoutOrderDate: 0,
    };

    for (const order of orders) {
      const orderId = text(order.id);
      if (!orderId) continue;
      result.ordersScanned += 1;
      const statusSource = text(order.statusSource);
      if (statusSource === CLICKUP_STATUS_SOURCE) {
        result.clickupSourcedOrdersSkipped += 1;
        continue;
      }
      const authorityAsOf = isoInstant(order.authorityAsOf);
      if (!authorityAsOf || isoInstant(order.statusChangedAt) !== authorityAsOf) continue;
      const orderDate = isoInstant(order.orderDate);
      if (!orderDate) {
        result.ordersWithoutOrderDate += 1;
        continue;
      }
      // Already honest: the order's own date IS the stamped instant, so there is nothing to undo.
      if (orderDate === authorityAsOf) continue;

      const values: Row = { statusChangedAt: orderDate };
      result.statusChangedAtRepaired += 1;
      if (isoInstant(order.workflowStageEnteredAt) === authorityAsOf) {
        values.workflowStageEnteredAt = orderDate;
        result.workflowStageEnteredAtRepaired += 1;
      }
      const sourceKey = statusSource ?? UNSOURCED_STATUS_SOURCE;
      result.ordersRepairedByStatusSource[sourceKey] = (result.ordersRepairedByStatusSource[sourceKey] ?? 0) + 1;
      result.ordersUpdated += 1;
      if (!dryRun) {
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
      }
    }

    this.logger?.info?.('Ecobase order stamp repair completed.', { ...result });
    return result;
  }
}
