/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import {
  calculateAmazonReceiptEvidence,
  type AmazonReceiptEvidence,
  type ReceiptInventorySnapshot,
  type ReceiptSalesFact,
} from './order-receipt-evidence';
import {
  isAmazonReceiptStatus,
  resolveAmazonReceiptState,
  type AmazonReceiptStatus,
  type AmazonReceiptTransition,
} from './order-receipt-state';

type Row = Record<string, unknown>;
type Transaction = unknown;

export interface ReconcileAffectedOrdersInput {
  orderIds: string[];
  evaluatedAt?: string;
}

export interface ReceiptReconciliationResult {
  processedOrders: number;
  updatedOrders: number;
  updatedLines: number;
  unchangedLines: number;
  reviewRequired: number;
  affectedFamilyIds: string[];
  errors: Array<{ orderId: string; lineId?: string; code: string; message: string }>;
}

interface LineResult {
  lineId: string;
  familyId?: string;
  status: AmazonReceiptStatus;
  observedAt?: string;
  evidenceKey: string;
  updated: boolean;
}

function text(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function number(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

function dateTime(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? value : undefined;
}

function dateTimeFromDate(date: string | undefined) {
  return dateTime(date ? `${date}T00:00:00.000Z` : undefined);
}

function evidenceKey(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clickupOperationalStatus(order: Row) {
  const statusEvidence = record(order.statusEvidenceJson);
  return text(record(statusEvidence.clickupStatusImport).clickupStatus) ?? text(order.lifecycleStatus);
}

function currentReceiptStatus(row: Row) {
  const value = text(row.amazonReceiptStatus);
  return value && isAmazonReceiptStatus(value) ? value : null;
}

function aggregateOrderStatus(statuses: AmazonReceiptStatus[]): AmazonReceiptStatus {
  if (statuses.length === 0 || statuses.includes('review_required')) return 'review_required';
  if (statuses.every((status) => status === 'not_applicable')) return 'not_applicable';
  const completed = statuses.filter(
    (status) =>
      status === 'amazon_stock_observed' || status === 'completed_by_later_inbound' || status === 'not_applicable',
  );
  if (completed.length === statuses.length) {
    return statuses.includes('amazon_stock_observed') ? 'amazon_stock_observed' : 'completed_by_later_inbound';
  }
  if (completed.length > 0 || statuses.includes('partially_observed')) return 'partially_observed';
  return 'awaiting_amazon_stock';
}

export class EcobaseOrderReceiptReconciliationService {
  constructor(private readonly db: EcobaseDatabase) {}

  async reconcileAffectedOrders(input: ReconcileAffectedOrdersInput): Promise<ReceiptReconciliationResult> {
    const orderIds = [...new Set(input.orderIds.map((id) => id.trim()).filter(Boolean))];
    if (orderIds.length === 0) {
      throw new Error('Ecobase receipt reconciliation requires at least one order ID.');
    }
    const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
    if (!Number.isFinite(new Date(evaluatedAt).getTime())) {
      throw new Error(`Ecobase receipt reconciliation received invalid evaluatedAt: ${evaluatedAt}.`);
    }

    const result: ReceiptReconciliationResult = {
      processedOrders: 0,
      updatedOrders: 0,
      updatedLines: 0,
      unchangedLines: 0,
      reviewRequired: 0,
      affectedFamilyIds: [],
      errors: [],
    };
    const familyIds = new Set<string>();
    const sellerboardSourceConnectionIds = await this.sellerboardSourceConnectionIds();

    for (const orderId of orderIds) {
      await this.inTransaction(async (transaction) => {
        const order = await this.findOne(ECOBASE_COLLECTIONS.silverOrders, orderId, transaction);
        if (!order) {
          result.errors.push({
            orderId,
            code: 'order_not_found',
            message: `Ecobase receipt reconciliation could not find Silver order ${orderId}.`,
          });
          return;
        }
        result.processedOrders += 1;
        const lines = await this.find(ECOBASE_COLLECTIONS.silverOrderLines, { orderId }, transaction);
        const lineResults: LineResult[] = [];
        for (const line of lines) {
          const lineResult = await this.reconcileLine({
            order,
            line,
            evaluatedAt,
            sellerboardSourceConnectionIds,
            transaction,
            errors: result.errors,
          });
          lineResults.push(lineResult);
          if (lineResult.familyId) familyIds.add(lineResult.familyId);
          if (lineResult.updated) result.updatedLines += 1;
          else result.unchangedLines += 1;
          if (lineResult.status === 'review_required') result.reviewRequired += 1;
        }

        const orderStatus = aggregateOrderStatus(lineResults.map((line) => line.status));
        const orderEvidence = {
          version: 1,
          lineEvidenceKeys: lineResults.map((line) => line.evidenceKey).sort(),
        };
        const orderEvidenceKey = evidenceKey(orderEvidence);
        const existingOrderEvidence = record(order.amazonReceiptEvidenceJson);
        if (
          currentReceiptStatus(order) !== orderStatus ||
          text(existingOrderEvidence.evidenceKey) !== orderEvidenceKey
        ) {
          const observedAt = lineResults
            .map((line) => line.observedAt)
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1);
          await this.update(
            ECOBASE_COLLECTIONS.silverOrders,
            orderId,
            {
              amazonReceiptStatus: orderStatus,
              amazonReceiptObservedAt: observedAt,
              amazonReceiptCompletionReason: `line_receipt_aggregate_${orderStatus}`,
              amazonReceiptEvidenceJson: { ...orderEvidence, evidenceKey: orderEvidenceKey },
            },
            transaction,
          );
          result.updatedOrders += 1;
        }
      });
    }

    result.affectedFamilyIds = [...familyIds].sort();
    return result;
  }

  private async reconcileLine(params: {
    order: Row;
    line: Row;
    evaluatedAt: string;
    sellerboardSourceConnectionIds: Set<string>;
    transaction: Transaction;
    errors: ReceiptReconciliationResult['errors'];
  }): Promise<LineResult> {
    const orderId = text(params.order.id)!;
    const lineId = text(params.line.id)!;
    const existingStatusText = text(params.line.amazonReceiptStatus);
    if (existingStatusText && !isAmazonReceiptStatus(existingStatusText)) {
      params.errors.push({
        orderId,
        lineId,
        code: 'invalid_existing_receipt_status',
        message: `Silver order line ${lineId} has unsupported Amazon receipt status ${existingStatusText}.`,
      });
      return this.persistReview(params.line, 'invalid_existing_receipt_status', params.transaction);
    }

    const overrideStatusText = text(params.line.amazonReceiptOverrideStatus);
    if (overrideStatusText && !isAmazonReceiptStatus(overrideStatusText)) {
      params.errors.push({
        orderId,
        lineId,
        code: 'invalid_receipt_override_status',
        message: `Silver order line ${lineId} has unsupported receipt override ${overrideStatusText}.`,
      });
      return this.persistReview(params.line, 'invalid_receipt_override_status', params.transaction);
    }
    const operatorOverride = overrideStatusText
      ? {
          status: overrideStatusText as AmazonReceiptStatus,
          reason: text(params.line.amazonReceiptOverrideReason) ?? '',
        }
      : undefined;
    const sourceOperationalStatus = clickupOperationalStatus(params.order);
    const sourceOnlyTransition = resolveAmazonReceiptState({
      currentStatus: currentReceiptStatus(params.line),
      sourceOperationalStatus,
      operatorOverride,
    });
    if (sourceOnlyTransition.outcome === 'rejected') {
      params.errors.push({
        orderId,
        lineId,
        code: sourceOnlyTransition.error,
        message: `Silver order line ${lineId} has a receipt override without a reason.`,
      });
      return this.persistReview(params.line, sourceOnlyTransition.error, params.transaction);
    }
    if (operatorOverride || sourceOnlyTransition.to === 'not_applicable') {
      return this.persistTransition(params.line, sourceOnlyTransition, undefined, undefined, params.transaction);
    }

    const companyProductId = text(params.line.companyProductId);
    if (!companyProductId)
      return this.persistReview(params.line, 'company_product_mapping_missing', params.transaction);
    const companyProduct = await this.findOne(
      ECOBASE_COLLECTIONS.silverCompanyProducts,
      companyProductId,
      params.transaction,
    );
    const familyId = text(companyProduct?.companyProductFamilyId);
    const amazonAccountId = text(companyProduct?.amazonAccountId);
    const companyId = text(companyProduct?.companyId);
    if (!companyProduct || !familyId || !amazonAccountId || !companyId) {
      return this.persistReview(params.line, 'company_product_family_missing', params.transaction);
    }
    const family = await this.findOne(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, familyId, params.transaction);
    const marketplace = text(family?.marketplace);
    if (
      !family ||
      !marketplace ||
      text(family.companyId) !== companyId ||
      text(family.amazonAccountId) !== amazonAccountId ||
      text(params.order.companyId) !== companyId
    ) {
      return this.persistReview(params.line, 'company_account_family_identity_mismatch', params.transaction);
    }

    const baselineAt = dateTime(params.line.amazonReceiptBaselineAt) ?? dateTime(params.order.authorityAsOf);
    if (!baselineAt)
      return this.persistReview(params.line, 'inbound_baseline_time_missing', params.transaction, familyId);
    const members = await this.find(
      ECOBASE_COLLECTIONS.silverCompanyProducts,
      { companyProductFamilyId: familyId },
      params.transaction,
    );
    const memberIds = members.map((member) => text(member.id)).filter((id): id is string => Boolean(id));
    const { snapshots, snapshotIdsByAggregateId } = await this.familySnapshots(
      memberIds,
      { companyId, amazonAccountId, marketplace, familyId, lineId },
      params.transaction,
    );
    const salesFacts = await this.familySalesFacts(
      memberIds,
      { companyId, amazonAccountId, marketplace, familyId },
      params.transaction,
    );
    const evidence = calculateAmazonReceiptEvidence({
      identity: {
        companyId,
        amazonAccountId,
        marketplace,
        companyProductFamilyId: familyId,
        orderLineId: lineId,
      },
      inboundObservedAt: baselineAt,
      evaluatedAt: params.evaluatedAt,
      sellerboardSourceConnectionIds: params.sellerboardSourceConnectionIds,
      snapshots,
      salesFacts,
      fulfillmentRoute: text(params.order.fulfillmentRoute),
    });
    const transition = resolveAmazonReceiptState({
      currentStatus: currentReceiptStatus(params.line),
      sourceOperationalStatus,
      sellerboardEvidence:
        evidence.outcome === 'observed' || evidence.outcome === 'review_required'
          ? { status: evidence.status, reason: evidence.reason }
          : undefined,
    });
    if (transition.outcome === 'rejected') {
      return this.persistReview(params.line, transition.error, params.transaction, familyId);
    }
    return this.persistTransition(
      params.line,
      transition,
      evidence,
      {
        familyId,
        baselineAt,
        sourceSnapshotIds: [
          ...(snapshotIdsByAggregateId.get(evidence.baselineSnapshotId ?? '') ?? []),
          ...(snapshotIdsByAggregateId.get(evidence.currentSnapshotId ?? '') ?? []),
        ],
      },
      params.transaction,
    );
  }

  private async persistReview(
    line: Row,
    reason: string,
    transaction: Transaction,
    familyId?: string,
  ): Promise<LineResult> {
    const currentStatus = currentReceiptStatus(line);
    const transition = resolveAmazonReceiptState({
      currentStatus,
      sellerboardEvidence: { status: 'review_required', reason },
    });
    if (transition.outcome === 'rejected') {
      throw new Error(`Ecobase receipt reconciliation rejected internal review transition for line ${text(line.id)}.`);
    }
    return this.persistTransition(line, transition, undefined, { familyId, reviewReason: reason }, transaction);
  }

  private async persistTransition(
    line: Row,
    transition: Exclude<AmazonReceiptTransition, { outcome: 'rejected' }>,
    receiptEvidence: AmazonReceiptEvidence | undefined,
    context:
      | { familyId?: string; baselineAt?: string; sourceSnapshotIds?: string[]; reviewReason?: string }
      | undefined,
    transaction: Transaction,
  ): Promise<LineResult> {
    const lineId = text(line.id)!;
    const evidence = {
      version: 1,
      lineId,
      familyId: context?.familyId,
      transitionReason: receiptEvidence?.reason ?? transition.reason,
      reviewReason: context?.reviewReason,
      sourceSnapshotIds: [...new Set(context?.sourceSnapshotIds ?? [])].sort(),
      receiptEvidence,
    };
    const key = evidenceKey(evidence);
    const existingEvidence = record(line.amazonReceiptEvidenceJson);
    const updated = currentReceiptStatus(line) !== transition.to || text(existingEvidence.evidenceKey) !== key;
    const observedAt =
      receiptEvidence?.outcome === 'observed' ? dateTimeFromDate(receiptEvidence.currentSnapshotDate) : undefined;
    if (updated) {
      await this.update(
        ECOBASE_COLLECTIONS.silverOrderLines,
        lineId,
        {
          amazonReceiptStatus: transition.to,
          amazonReceiptObservedQty:
            receiptEvidence?.outcome === 'observed' ? receiptEvidence.observedAddition : line.amazonReceiptObservedQty,
          amazonReceiptBaselineAt: context?.baselineAt ?? line.amazonReceiptBaselineAt,
          amazonReceiptObservedAt: observedAt ?? line.amazonReceiptObservedAt,
          amazonReceiptCompletionReason: context?.reviewReason ?? receiptEvidence?.reason ?? transition.reason,
          amazonReceiptEvidenceJson: { ...evidence, evidenceKey: key },
        },
        transaction,
      );
    }
    return {
      lineId,
      familyId: context?.familyId,
      status: transition.to,
      observedAt: observedAt ?? dateTime(line.amazonReceiptObservedAt),
      evidenceKey: key,
      updated,
    };
  }

  private async familySnapshots(
    memberIds: string[],
    identity: { companyId: string; amazonAccountId: string; marketplace: string; familyId: string; lineId: string },
    transaction: Transaction,
  ) {
    const groups = new Map<string, { rows: Row[]; sourceConnectionId?: string; snapshotDate: string }>();
    for (const companyProductId of memberIds) {
      for (const snapshot of await this.find(
        ECOBASE_COLLECTIONS.silverInventorySnapshots,
        { companyProductId },
        transaction,
      )) {
        const snapshotDate = text(snapshot.snapshotDate);
        if (!snapshotDate) continue;
        const sourceConnectionId = text(snapshot.sourceConnectionId);
        const groupKey = `${sourceConnectionId ?? 'unknown'}:${snapshotDate}`;
        const group = groups.get(groupKey) ?? { rows: [], sourceConnectionId, snapshotDate };
        group.rows.push(snapshot);
        groups.set(groupKey, group);
      }
    }
    const snapshotIdsByAggregateId = new Map<string, string[]>();
    const snapshots: ReceiptInventorySnapshot[] = [];
    for (const group of groups.values()) {
      const coveredMemberIds = new Set(
        group.rows.map((row) => text(row.companyProductId)).filter((id): id is string => Boolean(id)),
      );
      if (coveredMemberIds.size !== memberIds.length) continue;
      const sourceIds = group.rows
        .map((row) => text(row.id))
        .filter((id): id is string => Boolean(id))
        .sort();
      const id = evidenceKey({ identity: identity.familyId, group: group.snapshotDate, sourceIds });
      snapshotIdsByAggregateId.set(id, sourceIds);
      snapshots.push({
        id,
        companyId: identity.companyId,
        amazonAccountId: identity.amazonAccountId,
        marketplace: identity.marketplace,
        companyProductFamilyId: identity.familyId,
        sourceConnectionId: group.sourceConnectionId,
        snapshotDate: group.snapshotDate,
        sellableStock: group.rows.reduce((sum, row) => sum + (number(row.sellableStock) ?? 0), 0),
        reservedStock: group.rows.reduce((sum, row) => sum + (number(row.reserved) ?? 0), 0),
        inboundStock: group.rows.reduce((sum, row) => sum + (number(row.inbound) ?? 0), 0),
        awdStock: group.rows.reduce((sum, row) => sum + (number(row.awdStock) ?? 0), 0),
      });
    }
    return { snapshots, snapshotIdsByAggregateId };
  }

  private async familySalesFacts(
    memberIds: string[],
    identity: { companyId: string; amazonAccountId: string; marketplace: string; familyId: string },
    transaction: Transaction,
  ) {
    const unitsByDate = new Map<string, number>();
    for (const companyProductId of memberIds) {
      for (const fact of await this.find(
        ECOBASE_COLLECTIONS.silverListingDailyFacts,
        { companyProductId },
        transaction,
      )) {
        const snapshotDate = text(fact.snapshotDate);
        const units = number(fact.units);
        if (!snapshotDate || units === undefined) continue;
        unitsByDate.set(snapshotDate, (unitsByDate.get(snapshotDate) ?? 0) + Math.max(0, units));
      }
    }
    return [...unitsByDate.entries()].map<ReceiptSalesFact>(([snapshotDate, unitsSold]) => ({
      companyId: identity.companyId,
      amazonAccountId: identity.amazonAccountId,
      marketplace: identity.marketplace,
      companyProductFamilyId: identity.familyId,
      snapshotDate,
      unitsSold,
      trusted: true,
    }));
  }

  private async sellerboardSourceConnectionIds() {
    const connections = await this.find(ECOBASE_COLLECTIONS.sourceConnections, {});
    return new Set(
      connections
        .filter((connection) => text(connection.sourceType) === 'sellerboard' && connection.active !== false)
        .map((connection) => text(connection.id))
        .filter((id): id is string => Boolean(id)),
    );
  }

  private async find(collection: string, filter: Row, transaction?: Transaction) {
    return (
      (await (
        this.db.getRepository(collection) as EcobaseRepository & {
          find(params: { filter: Row; transaction?: Transaction }): Promise<unknown[]>;
        }
      ).find({ filter, transaction })) as unknown[]
    ).map(record);
  }

  private async findOne(collection: string, id: string, transaction?: Transaction) {
    const value = await (
      this.db.getRepository(collection) as EcobaseRepository & {
        findOne(params: { filterByTk: string; transaction?: Transaction }): Promise<unknown | null>;
      }
    ).findOne({ filterByTk: id, transaction });
    return value ? record(value) : undefined;
  }

  private async update(collection: string, id: string, values: Row, transaction?: Transaction) {
    await (
      this.db.getRepository(collection) as EcobaseRepository & {
        update(params: { filterByTk: string; values: Row; transaction?: Transaction }): Promise<unknown>;
      }
    ).update({ filterByTk: id, values, transaction });
  }

  private async inTransaction<T>(run: (transaction: Transaction) => Promise<T>) {
    if (typeof this.db.sequelize?.transaction === 'function') return this.db.sequelize.transaction(run);
    return run(undefined);
  }
}
