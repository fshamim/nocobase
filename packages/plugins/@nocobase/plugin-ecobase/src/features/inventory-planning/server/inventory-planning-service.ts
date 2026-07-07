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
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import {
  EcobaseSupplierOrderService,
  normalizeSupplierOrderStatus,
} from '../../supplier-management/server/supplier-order-service';
import { silverSupplierOrderReadModel } from '../../supplier-management/server/silver-supplier-order-read-model';
import { toPlainRecord } from '../../source-import/server/import-service';
import { EcobaseSellerboardCogsService } from '../../source-import/server/sellerboard-cogs-service';
import { EcobaseSilverDataService } from '../../semantic-model/server/silver-data-service';
import { addDays, diffDays, isoDate, optionalIsoDate } from './planning-date';
import {
  DEFAULT_PLANNING_SETTINGS,
  EcobasePlanningSettingsService,
  type SupplierOrderStatusBuckets,
} from '../../../server/services/planning-settings-service';
import {
  isProfitTier,
  profitTierFor,
  profitTierMovement,
  profitTierRank,
  type ProfitTierThresholds,
} from './profit-tier';
import { summarizeHistoricalProductFacts, type HistoricalProductMetrics } from './historical-product-metrics';

const FALLBACK_RECORD_LIMIT = 100000;

export type InventoryPlanningActionStatus =
  | 'excluded'
  | 'missing_velocity'
  | 'missing_lead_time'
  | 'stale_lead_time'
  | 'overdue'
  | 'order_today'
  | 'order_soon'
  | 'already_ordered'
  | 'watch'
  | 'sufficient_stock';

export interface InventoryPlanningQuery {
  company?: string;
  calculationDate?: string;
  leadTimeFreshnessDays?: number;
  safetyBufferDays?: number;
  orderSoonWindowDays?: number;
  reorderCycleDays?: number;
  targetCoverDays?: number;
  purchasedPipelineGraceDays?: number;
  limit?: number;
}

export interface InventoryPlanningRowWorkspaceQuery {
  company?: string;
  planningProductId?: string;
  companyProductId?: string;
  asin?: string;
  sku?: string;
  supplierId?: string;
  limit?: number;
}

export interface InventoryBudgetOptimizationQuery extends InventoryPlanningQuery {
  budget: number;
  horizonDays?: number;
}

export type InventoryCommandCenterPane = 'supplyAction' | 'activeOrders' | 'stuckInventory';

export interface InventoryPlanningCommandCenterQuery extends InventoryPlanningQuery {
  pane?: InventoryCommandCenterPane;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  filters?: Record<string, unknown>;
  selectedRowId?: string;
  planningProductId?: string;
  companyProductId?: string;
  asin?: string;
  sku?: string;
}

type PlainRecord = Record<string, unknown>;

const COMMAND_CENTER_PANES: InventoryCommandCenterPane[] = ['supplyAction', 'activeOrders', 'stuckInventory'];

const COMMAND_CENTER_SORT_KEYS = new Set([
  'actionStatus',
  'asin',
  'daysOfCover',
  'daysUntilOos',
  'daysUntilSafeReorder',
  'estimatedProfitRisk',
  'currentPlanningStock',
  'expectedSellableDate',
  'sku',
  'stockoutGapDays',
  'suggestedReorderQty',
  'supplierName',
  'tier',
  'title',
]);

type ProfitMetrics = {
  sales: number;
  units: number;
  profit: number;
  refunds: number;
  profitPerUnit?: number;
};

type ProfitMetricsIndex = {
  exact: Map<string, ProfitMetrics>;
  byAsin: Map<string, ProfitMetrics>;
};

type HistoricalProfitMetricsIndex = {
  exact: Map<string, HistoricalProductMetrics>;
  byAsin: Map<string, HistoricalProductMetrics>;
};

type SupplierOrderStatusRules = {
  placedNotPurchased: Set<string>;
  purchasedPipeline: Set<string>;
  closed: Set<string>;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecordIdString(value: unknown): string | undefined {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim().length > 0
    ? String(value).trim()
    : undefined;
}

function asRecordIdFilterValue(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : value;
}

function displayNameForUser(user: PlainRecord) {
  return asString(user.nickname) ?? asString(user.name) ?? asString(user.email) ?? asString(user.username);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asPositiveInteger(value: unknown, fallback: number, max: number) {
  const parsed = asNumber(value);
  if (typeof parsed !== 'number') return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function commandCenterPane(value: unknown): InventoryCommandCenterPane | undefined {
  return COMMAND_CENTER_PANES.includes(value as InventoryCommandCenterPane)
    ? (value as InventoryCommandCenterPane)
    : undefined;
}

function daysUntilDate(date: unknown, calculationDate: string) {
  const value = optionalIsoDate(asString(date) ?? '');
  return value ? diffDays(value, calculationDate) : undefined;
}

function stockoutGapDays(row: PlainRecord) {
  const estimatedOosDate = optionalIsoDate(asString(row.estimatedOosDate) ?? '');
  const expectedSellableDate = optionalIsoDate(asString(row.expectedSellableDate) ?? '');
  return estimatedOosDate && expectedSellableDate ? diffDays(expectedSellableDate, estimatedOosDate) : undefined;
}

function pipelineHealthBucket(row: PlainRecord, calculationDate: string) {
  const state = asString(row.supplierOrderState);
  if (state === 'placed_not_purchased') return 'placed_not_purchased';
  if (state !== 'purchased_pipeline') return 'none';
  const gap = stockoutGapDays(row);
  if (typeof gap === 'number' && gap > 0) return 'late';
  const daysUntilExpectedSellable = daysUntilDate(row.expectedSellableDate, calculationDate);
  if (typeof daysUntilExpectedSellable === 'number' && daysUntilExpectedSellable < 0) return 'late_with_grace';
  return 'on_track';
}

function stuckBucket(row: PlainRecord) {
  if (!asBoolean(row.stuck)) return 'none';
  const daysOfCover = asNumber(row.daysOfCover) ?? 0;
  const reservedStock = asNumber(row.reservedStock) ?? 0;
  const salesVelocity = asNumber(row.salesVelocity) ?? 0;
  if (reservedStock > 0 && salesVelocity <= 0) return 'reserved_not_selling';
  if ((asNumber(row.pipelineStock) ?? 0) > 0 && salesVelocity <= 0) return 'pipeline_stalled';
  return daysOfCover > 60 ? 'high_cover_slow_sales' : 'none';
}

function recommendedInventoryAction(row: PlainRecord) {
  const actionStatus = asString(row.actionStatus);
  if (!asString(row.supplierName)) return 'recover_supplier';
  if (row.leadTimeFreshness !== 'fresh') return 'confirm_lead_time';
  if (row.supplierOrderState === 'placed_not_purchased') return 'purchase_order';
  if (row.supplierOrderState === 'purchased_pipeline') return 'follow_up_order';
  if (['overdue', 'order_today', 'order_soon'].includes(String(actionStatus))) return 'create_order';
  if (asBoolean(row.stuck)) return 'review_stuck_inventory';
  return 'watch';
}

function payload(record: PlainRecord): PlainRecord {
  const value = record.payload;
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function payloadString(record: PlainRecord, keys: string[]): string | undefined {
  const values = payload(record);
  for (const key of keys) {
    const direct = asString(record[key]);
    if (direct) return direct;
    const nested = asString(values[key]);
    if (nested) return nested;
  }
  return undefined;
}

function configString(record: PlainRecord, keys: string[]): string | undefined {
  const config = toPlainRecord(record.config);
  for (const key of keys) {
    const nested = asString(config[key]);
    if (nested) return nested;
  }
  return undefined;
}

function payloadNumber(record: PlainRecord, keys: string[]): number | undefined {
  const values = payload(record);
  for (const key of keys) {
    const direct = asNumber(record[key]);
    if (typeof direct === 'number') return direct;
    const nested = values[key];
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
    if (typeof nested === 'string' && nested.trim().length > 0) {
      const parsed = Number(nested.replace(/[$,%\s]/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function profitMetricKey(company: string, asin: string, sku?: string) {
  return `${company}:${asin.toUpperCase()}:${sku ?? ''}`;
}

function daysSince(date: string | undefined, today: string) {
  return date ? diffDays(today, isoDate(date)) : undefined;
}

function isPlanningExcluded(status: string | undefined) {
  const normalized = status?.trim().toLowerCase();
  return (
    normalized === 'not selling' ||
    normalized === 'hold' ||
    normalized === 'one time' ||
    normalized === 'inactive' ||
    normalized === 'discontinued' ||
    normalized === 'do not reorder'
  );
}

function derivedProductStatus(importedStatus: string | undefined, stockBuckets: PlainRecord) {
  if (importedStatus) return importedStatus;
  const sellable = asNumber(stockBuckets.sellableStock) ?? 0;
  const reserved = asNumber(stockBuckets.reservedStock) ?? 0;
  const inbound = asNumber(stockBuckets.inboundStock) ?? 0;
  const ordered = asNumber(stockBuckets.orderedStock) ?? 0;
  const prepOrAwd = (asNumber(stockBuckets.prepStock) ?? 0) + (asNumber(stockBuckets.awdStock) ?? 0);
  if (sellable === 0 && reserved > 0) return 'Reserved';
  if (sellable === 0 && reserved === 0 && (inbound > 0 || ordered > 0 || prepOrAwd > 0)) return 'OOS';
  if (sellable === 0 && reserved === 0) return 'Inactive';
  return 'Active';
}

function includesStatusText(value: unknown, terms: string[]) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function supplierOrderStatusRules(buckets: SupplierOrderStatusBuckets): SupplierOrderStatusRules {
  return {
    placedNotPurchased: new Set(buckets.supplierOrderPlacedNotPurchasedStatuses.map(normalizeSupplierOrderStatus)),
    purchasedPipeline: new Set(buckets.supplierOrderPurchasedPipelineStatuses.map(normalizeSupplierOrderStatus)),
    closed: new Set(buckets.supplierOrderClosedStatuses.map(normalizeSupplierOrderStatus)),
  };
}

function supplierCoverageStatus(order: PlainRecord, rules: SupplierOrderStatusRules) {
  const status = normalizeSupplierOrderStatus(asString(order.status));
  if (asString(order.statusSource) === 'manual' && asString(order.lastOperatorEditAt)) return status;
  if (rules.closed.has(status)) return status;
  if (includesStatusText(order.paymentStatus, ['completed', 'complete', 'paid'])) return 'paid';
  if (status === 'approval_pending' && includesStatusText(order.approvalStatus, ['approved'])) return 'payment_pending';
  return status;
}

function isPlacedNotPurchasedSupplierOrderStatus(status: string | undefined, rules: SupplierOrderStatusRules) {
  return status ? rules.placedNotPurchased.has(status) : false;
}

function isActivePurchasedPipelineStatus(status: string | undefined, rules: SupplierOrderStatusRules) {
  return status ? rules.purchasedPipeline.has(status) : false;
}

function isActivePurchasedPipelineDate(
  line: PlainRecord,
  order: PlainRecord,
  calculationDate: string | undefined,
  purchasedPipelineGraceDays: number,
) {
  if (!calculationDate) return true;
  const expectedSellableDate =
    asString(line.expectedSellableDate) ?? asString(line.expectedDeliveryDate) ?? asString(order.expectedDeliveryDate);
  if (!expectedSellableDate) return true;
  return diffDays(isoDate(expectedSellableDate), calculationDate) >= -purchasedPipelineGraceDays;
}

function actionRank(status: InventoryPlanningActionStatus) {
  return {
    overdue: 0,
    order_today: 1,
    missing_lead_time: 2,
    stale_lead_time: 2,
    order_soon: 3,
    already_ordered: 4,
    watch: 5,
    sufficient_stock: 6,
    missing_velocity: 7,
    excluded: 8,
  }[status];
}

function riskQueueRank(status: unknown) {
  if (
    status === 'overdue' ||
    status === 'order_today' ||
    status === 'missing_lead_time' ||
    status === 'stale_lead_time' ||
    status === 'order_soon'
  ) {
    return 0;
  }
  if (status === 'already_ordered') return 1;
  if (status === 'watch' || status === 'missing_velocity') return 2;
  if (status === 'sufficient_stock') return 3;
  if (status === 'excluded') return 4;
  return 5;
}

async function findRecords(db: EcobaseDatabase, collection: string, filter: PlainRecord) {
  return (await db.getRepository(collection).find({ filter })).map(toPlainRecord);
}

function latestByDate(records: PlainRecord[], field: string) {
  return [...records].sort((left, right) => String(right[field] ?? '').localeCompare(String(left[field] ?? '')))[0];
}

function inventorySnapshotSourceRank(record: PlainRecord, sellerboardSourceConnectionIds: Set<string>) {
  const sourceConnectionId = asString(record.sourceConnectionId);
  return sourceConnectionId && sellerboardSourceConnectionIds.has(sourceConnectionId) ? 0 : 1;
}

function latestPreferredInventorySnapshot(records: PlainRecord[], sellerboardSourceConnectionIds: Set<string>) {
  return [...records].sort((left, right) => {
    const sourceRank =
      inventorySnapshotSourceRank(left, sellerboardSourceConnectionIds) -
      inventorySnapshotSourceRank(right, sellerboardSourceConnectionIds);
    if (sourceRank !== 0) return sourceRank;
    return String(right.snapshotDate ?? '').localeCompare(String(left.snapshotDate ?? ''));
  })[0];
}

function inventorySnapshotWins(
  candidate: PlainRecord,
  current: PlainRecord,
  sellerboardSourceConnectionIds: Set<string>,
) {
  return latestPreferredInventorySnapshot([candidate, current], sellerboardSourceConnectionIds) === candidate;
}

function sortableDateValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function supplierOrderSortValue(line: PlainRecord, order: PlainRecord) {
  return sortableDateValue(
    order.lastMeaningfulUpdateAt ?? order.statusUpdatedAt ?? line.observedAt ?? order.orderDate ?? '',
  );
}

function summarizeSupplierOrderState(
  lines: PlainRecord[],
  supplierOrderById: Map<string, PlainRecord>,
  calculationDate: string | undefined,
  purchasedPipelineGraceDays: number,
  rules: SupplierOrderStatusRules,
) {
  let purchasedOpenQty = 0;
  let placedNotPurchasedOpenQty = 0;
  let latestPlaced: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;
  let latestPurchased: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;
  let historySelected: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;

  for (const line of lines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order, rules);
    const orderedQty = asNumber(line.orderedQty) ?? 0;
    const receivedQty = asNumber(line.receivedQty) ?? 0;
    const openQty = Math.max(orderedQty - receivedQty, 0);
    const sortValue = supplierOrderSortValue(line, order);
    if (!historySelected || sortValue > historySelected.sortValue) {
      historySelected = { line, order, sortValue };
    }
    if (openQty <= 0 || !isPlacedNotPurchasedSupplierOrderStatus(status, rules)) continue;
    placedNotPurchasedOpenQty += openQty;
    if (!latestPlaced || sortValue > latestPlaced.sortValue) {
      latestPlaced = { line, order, sortValue };
    }
  }

  for (const line of lines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order, rules);
    const orderedQty = asNumber(line.orderedQty) ?? 0;
    const receivedQty = asNumber(line.receivedQty) ?? 0;
    const openQty = Math.max(orderedQty - receivedQty, 0);
    if (openQty <= 0 || !isActivePurchasedPipelineStatus(status, rules)) continue;
    const sortValue = supplierOrderSortValue(line, order);
    const newerRecoveryCycleStarted = latestPlaced && latestPlaced.sortValue > sortValue;
    if (
      newerRecoveryCycleStarted ||
      !isActivePurchasedPipelineStatus(status, rules) ||
      !isActivePurchasedPipelineDate(line, order, calculationDate, purchasedPipelineGraceDays)
    )
      continue;
    purchasedOpenQty += openQty;
    if (!latestPurchased || sortValue > latestPurchased.sortValue) {
      latestPurchased = { line, order, sortValue };
    }
  }

  const state =
    purchasedOpenQty > 0
      ? 'purchased_pipeline'
      : placedNotPurchasedOpenQty > 0
        ? 'placed_not_purchased'
        : historySelected
          ? 'closed_history'
          : 'no_open_order';
  const reference =
    state === 'purchased_pipeline'
      ? latestPurchased
      : state === 'placed_not_purchased'
        ? latestPlaced
        : historySelected
          ? { line: historySelected.line, order: historySelected.order }
          : undefined;
  return {
    supplierOrderState: state,
    supplierOrderStatus: reference?.order ? supplierCoverageStatus(reference.order, rules) : undefined,
    supplierOrderRef: asString(reference?.order.externalOrderRef) ?? asString(reference?.order.id),
    expectedSellableDate: asString(reference?.line.expectedSellableDate),
    supplierOrderOpenQty:
      asNumber(reference?.line.orderedQty) !== undefined
        ? Math.max((asNumber(reference?.line.orderedQty) ?? 0) - (asNumber(reference?.line.receivedQty) ?? 0), 0)
        : undefined,
    supplierOrderPurchasedOpenQty: purchasedOpenQty,
    supplierOrderPlacedNotPurchasedOpenQty: placedNotPurchasedOpenQty,
  };
}

const DIGEST_ACTION_STATUSES = new Set([
  'overdue',
  'order_today',
  'order_soon',
  'missing_lead_time',
  'stale_lead_time',
]);

function digestOrderStateRank(row: PlainRecord) {
  const state = asString(row.supplierOrderState);
  if (state === 'no_open_order') return 0;
  if (state === 'placed_not_purchased') return 1;
  if (state === 'closed_history') return 1;
  if (state === 'purchased_pipeline') return 2;
  return 3;
}

function isDigestCandidateRow(row: PlainRecord) {
  return isProfitTier(row.tier);
}

function isUrgentDigestRow(row: PlainRecord) {
  return (
    DIGEST_ACTION_STATUSES.has(String(row.actionStatus)) &&
    row.supplierOrderState !== 'purchased_pipeline' &&
    isDigestCandidateRow(row)
  );
}

function needsSupplierAction(row: PlainRecord) {
  return (
    !asString(row.supplierName) ||
    row.leadTimeFreshness !== 'fresh' ||
    ['missing_lead_time', 'stale_lead_time'].includes(String(row.actionStatus))
  );
}

function plainArray(value: unknown): PlainRecord[] {
  return Array.isArray(value) ? value.map(toPlainRecord) : [];
}

function isUuidValue(value: unknown) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function inventoryRowMatchesLine(query: InventoryPlanningRowWorkspaceQuery, line: PlainRecord) {
  const rowPlanningProductId = asString(query.planningProductId);
  const linePlanningProductId = asString(line.planningProductId);
  const rowAsin = asString(query.asin)?.toUpperCase();
  const lineAsin = asString(line.asin)?.toUpperCase();
  const rowSku = asString(query.sku);
  const lineSku = asString(line.sku);
  return (
    (isUuidValue(rowPlanningProductId) && rowPlanningProductId === linePlanningProductId) ||
    Boolean(rowAsin && rowAsin === lineAsin) ||
    Boolean(rowSku && rowSku === lineSku)
  );
}

function companyNameFromRelation(value: unknown) {
  const relation = toPlainRecord(value);
  return asString(relation.name);
}

function companyLabelFromSourceConnection(connection: PlainRecord, companyNamesById: Map<string, string>) {
  const relationName = companyNameFromRelation(connection.company);
  if (relationName) return relationName;

  const companyId = asString(connection.companyId);
  if (companyId) return companyNamesById.get(companyId);

  return configString(connection, ['company', 'Company', 'defaultCompany']);
}

function companyFromRecord(record: PlainRecord, sourceConnectionCompanies: Map<string, string>) {
  const direct = asString(record.company) ?? payloadString(record, ['company', 'Company']);
  if (direct) return direct;
  const sourceConnectionId = asString(record.sourceConnectionId);
  return sourceConnectionId ? sourceConnectionCompanies.get(sourceConnectionId) : undefined;
}

function stableUuid(value: string) {
  const hex = createHash('sha1').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(
    (parseInt(hex.slice(16, 18), 16) & 0x3f) |
    0x80
  )
    .toString(16)
    .padStart(2, '0')}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function productIdentity(row: PlainRecord) {
  return (
    asString(row.planningProductId) ??
    `${asString(row.company) ?? ''}:${asString(row.asin) ?? ''}:${asString(row.sku) ?? ''}`
  );
}

function lineMatchesRow(line: PlainRecord, row: PlainRecord) {
  const rowPlanningProductId = asString(row.planningProductId);
  const linePlanningProductId = asString(line.planningProductId);
  const rowAsin = asString(row.asin)?.toUpperCase();
  const lineAsin = asString(line.asin)?.toUpperCase();
  const rowSku = asString(row.sku);
  const lineSku = asString(line.sku);
  return Boolean(
    (rowPlanningProductId && linePlanningProductId && rowPlanningProductId === linePlanningProductId) ||
      (rowAsin && lineAsin && rowAsin === lineAsin) ||
      (rowSku && lineSku && rowSku === lineSku),
  );
}

function openQty(line: PlainRecord) {
  return Math.max((asNumber(line.orderedQty) ?? 0) - (asNumber(line.receivedQty) ?? 0), 0);
}

function urgencyWeight(row: PlainRecord) {
  const status = asString(row.actionStatus);
  const tier = asString(row.tier);
  return (
    (status === 'overdue' ? 50 : 0) +
    (status === 'order_today' ? 35 : 0) +
    (status === 'order_soon' ? 15 : 0) +
    (status === 'missing_lead_time' || status === 'stale_lead_time' ? 5 : 0) +
    (tier === 'A' ? 20 : tier === 'B' ? 10 : tier === 'C' ? 3 : 0)
  );
}

function recommendedActionForStatus(status: unknown) {
  const normalized = asString(status);
  if (normalized === 'payment_pending') return 'pay';
  if (normalized === 'blocked') return 'review_blocker';
  if (['draft', 'supplier_contacted', 'supplier_confirmed', 'approval_pending'].includes(normalized ?? ''))
    return 'approve';
  return 'review';
}

const INVENTORY_PLANNING_ROW_FIELDS = [
  'planningProductId',
  'calculationDate',
  'company',
  'asin',
  'sku',
  'title',
  'brand',
  'productStatus',
  'planningExcluded',
  'actionStatus',
  'tier',
  'tierScore',
  'currentTier',
  'currentTierScore',
  'averageTier',
  'averageTierScore',
  'bestTier',
  'bestTierScore',
  'lastMonthQty',
  'sixMonthAverageQty',
  'sixMonthWorstQty',
  'sixMonthBestQty',
  'sixMonthMargin',
  'previousTier',
  'tierMovement',
  'profitPerUnit',
  'estimatedProfitRisk',
  'estimatedProfitRiskBasis',
  'recommendedBestQty',
  'salesVelocity',
  'suggestedReorderQty',
  'safetyBufferDays',
  'reorderCycleDays',
  'targetCoverDays',
  'orderSoonWindowDays',
  'leadTimeFreshnessDays',
  'purchasedPipelineGraceDays',
  'currentPlanningStock',
  'sellableStock',
  'reservedStock',
  'pipelineStock',
  'inboundStock',
  'orderedStock',
  'prepStock',
  'awdStock',
  'openOrderCoverageQty',
  'supplierOrderState',
  'supplierOrderStatus',
  'supplierOrderRef',
  'supplierOrderOpenQty',
  'supplierOrderPurchasedOpenQty',
  'supplierOrderPlacedNotPurchasedOpenQty',
  'stuck',
  'daysOfCover',
  'estimatedOosDate',
  'latestSafeReorderDate',
  'daysUntilSafeReorder',
  'supplierId',
  'supplierName',
  'supplierSource',
  'supplierRole',
  'supplierConfidence',
  'leadTimeDays',
  'leadTimeConfirmedAt',
  'leadTimeFreshness',
  'expectedSellableDate',
  'digestPriority',
  'evidence',
] as const;

export class EcobaseInventoryPlanningService {
  constructor(private db: EcobaseDatabase) {}

  async listRows(query: InventoryPlanningQuery = {}) {
    const goldRows = await this.readGoldRows(query);
    if (goldRows.length > 0) return goldRows;
    return this.calculateRows(query);
  }

  async workspace(query: InventoryPlanningQuery = {}) {
    const [filters, rows, digest] = await Promise.all([
      this.filterOptions(),
      this.listRows(query),
      this.digestPreview(query),
    ]);
    return { filters, rows, digest };
  }

  async commandCenter(query: InventoryPlanningCommandCenterQuery = {}) {
    if (query.pane && !commandCenterPane(query.pane)) {
      throw new Error('Ecobase inventory command center pane must be supplyAction, activeOrders, or stuckInventory.');
    }
    if (query.sortBy && !COMMAND_CENTER_SORT_KEYS.has(query.sortBy)) {
      throw new Error(
        `Ecobase inventory command center sortBy must be one of ${[...COMMAND_CENTER_SORT_KEYS].sort().join(', ')}.`,
      );
    }

    const rows = await this.withSellerboardCosts(await this.listRows({ ...query, limit: undefined }));
    const activeOrderRowsWithActivity = await this.withLatestSupplierOrderActivity(
      this.commandCenterRowsForPane('activeOrders', rows),
    );
    const settings = await new EcobasePlanningSettingsService(this.db).getResolvedSettings(query);
    const calculationDate = asString(rows[0]?.calculationDate) ?? isoDate(query.calculationDate ?? new Date());
    const targetCoverDays = asNumber(rows[0]?.targetCoverDays) ?? settings.targetCoverDays;
    const selectedRow = this.findCommandCenterSelectedRow(rows, query);
    return {
      generatedAt: new Date().toISOString(),
      metadata: {
        company: query.company ?? null,
        calculationDate,
        latestDataAsOf: this.latestCommandCenterTimestamp(rows),
        historyWindow: {
          label: '6 months',
          fields: ['lastMonthQty', 'sixMonthAverageQty', 'sixMonthWorstQty', 'sixMonthBestQty', 'sixMonthMargin'],
        },
        targetCoverDays,
      },
      summaryCards: this.commandCenterSummaryCards(rows),
      macroRisk: this.commandCenterMacroRisk(rows, calculationDate),
      riskBars: this.commandCenterRiskBars(rows, calculationDate),
      dailyAlertPreview: this.commandCenterRowsForPane('supplyAction', rows)
        .slice(0, 5)
        .map((row) => this.compactCommandCenterRow(row, calculationDate)),
      panes: {
        supplyAction: this.commandCenterPanePayload('supplyAction', rows, calculationDate, query),
        activeOrders: this.commandCenterPanePayload(
          'activeOrders',
          activeOrderRowsWithActivity,
          calculationDate,
          query,
        ),
        stuckInventory: this.commandCenterPanePayload('stuckInventory', rows, calculationDate, query),
      },
      selectedRow: selectedRow
        ? {
            row: this.commandCenterDrawerRow(selectedRow, calculationDate),
            workspace: await this.rowWorkspace({
              company: asString(selectedRow.company),
              planningProductId: asString(selectedRow.planningProductId),
              companyProductId: asString(selectedRow.companyProductId),
              asin: asString(selectedRow.asin),
              sku: asString(selectedRow.sku),
              supplierId: asString(selectedRow.supplierId),
              limit: 50,
            }),
          }
        : null,
    };
  }

  private async withSellerboardCosts(rows: PlainRecord[]): Promise<PlainRecord[]> {
    if (rows.length === 0) return rows;
    const companies = [
      ...new Set(rows.map((row) => asString(row.company)).filter((company): company is string => Boolean(company))),
    ];
    const resolver = await new EcobaseSellerboardCogsService(this.db).createResolver(companies);
    return rows.map((row) => ({ ...row, ...resolver.resolve(row) }));
  }

  async rowWorkspace(query: InventoryPlanningRowWorkspaceQuery) {
    const empty = {
      suppliers: [],
      supplierOrders: [],
      orderLineHistory: [],
      orderActivities: [],
      productTasks: [],
      productTargets: [],
      initialOrderEdit: null,
      actionDefaults: {},
    };
    if (!query.company) return empty;

    const workspace = await new EcobaseSupplierOrderService(this.db).getWorkspace({
      company: query.company,
      limit: query.limit ?? 500,
    });
    const suppliers = plainArray(workspace.suppliers).filter((supplier) => isUuidValue(supplier.id));
    const supplierOrders = plainArray(workspace.supplierOrders);
    const supplierOrderLines = plainArray(workspace.supplierOrderLines);
    const activities = await this.withActivityAuthors(plainArray(workspace.activities));
    const ordersById = new Map(supplierOrders.map((order) => [String(order.id), order]));
    const orderLineHistory = supplierOrderLines
      .filter((line) => inventoryRowMatchesLine(query, line))
      .map((line): PlainRecord & { order: PlainRecord } => ({
        ...line,
        order: ordersById.get(String(line.supplierOrderId)) ?? {},
      }))
      .sort((left, right) => {
        const leftDate = new Date(
          asString(left.observedAt) ??
            asString(left.order?.lastMeaningfulUpdateAt) ??
            asString(left.order?.createdAt) ??
            0,
        ).getTime();
        const rightDate = new Date(
          asString(right.observedAt) ??
            asString(right.order?.lastMeaningfulUpdateAt) ??
            asString(right.order?.createdAt) ??
            0,
        ).getTime();
        return rightDate - leftDate;
      });
    const firstProductOrder = toPlainRecord(orderLineHistory[0]?.order);
    const productOrderIds = new Set(orderLineHistory.map((line) => String(line.supplierOrderId)));
    const supplierId = isUuidValue(query.supplierId) ? query.supplierId : undefined;
    const actionableStatuses = new Set([
      'draft',
      'supplier_contacted',
      'supplier_confirmed',
      'approval_pending',
      'payment_pending',
      'paid',
      'supplier_preparing',
    ]);
    const matchingOrder = supplierId
      ? supplierOrders.find(
          (order) => asString(order.supplierId) === supplierId && actionableStatuses.has(String(order.status)),
        )
      : undefined;
    const silverContext = query.companyProductId
      ? await new EcobaseSilverDataService(this.db)
          .context({ focus: { type: 'companyProduct', id: query.companyProductId }, pageSize: 10 })
          .catch(() => ({ sections: [] }))
      : { sections: [] };
    const sections = plainArray(silverContext.sections);

    return {
      suppliers,
      supplierOrders,
      orderLineHistory,
      orderActivities: activities.filter(
        (activity) =>
          productOrderIds.has(String(activity.supplierOrderId)) ||
          (!activity.supplierOrderId && asString(activity.supplierId) === supplierId),
      ),
      productTasks: plainArray(sections.find((section) => section.key === 'tasks')?.rows),
      productTargets: plainArray(sections.find((section) => section.key === 'targets')?.rows),
      initialOrderEdit: firstProductOrder.id
        ? {
            supplierOrderId: String(firstProductOrder.id),
            supplierId: String(firstProductOrder.supplierId ?? ''),
            status: String(firstProductOrder.status ?? 'draft'),
            notes: '',
          }
        : null,
      actionDefaults: {
        draftSupplierId: supplierId ?? '',
        leadSupplierId: supplierId ?? '',
        addSupplierOrderId: matchingOrder?.id ? String(matchingOrder.id) : '',
      },
    };
  }

  private async calculateRows(query: InventoryPlanningQuery = {}) {
    const calculationDate = isoDate(query.calculationDate ?? new Date());
    const settings = await new EcobasePlanningSettingsService(this.db).getResolvedSettings(query);
    const orderSoonWindowDays = settings.orderSoonWindowDays;
    const targetCoverDays = settings.targetCoverDays;
    const purchasedPipelineGraceDays = settings.purchasedPipelineGraceDays;
    const profitTierThresholds: ProfitTierThresholds = settings;
    const statusRules = supplierOrderStatusRules(settings);
    const sellerboardSourceConnectionIds = await this.sellerboardSourceConnectionIds();

    const [
      companies,
      products,
      companyProducts,
      inventorySnapshots,
      dailyFacts,
      suppliers,
      supplierProducts,
      productSuppliers,
      orders,
      orderLines,
    ] = await Promise.all([
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanies),
      this.repoRows(ECOBASE_COLLECTIONS.silverProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverInventorySnapshots),
      this.repoRows(ECOBASE_COLLECTIONS.silverListingDailyFacts),
      this.repoRows(ECOBASE_COLLECTIONS.silverSuppliers),
      this.repoRows(ECOBASE_COLLECTIONS.silverSupplierProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers),
      this.repoRows(ECOBASE_COLLECTIONS.silverOrders),
      this.repoRows(ECOBASE_COLLECTIONS.silverOrderLines),
    ]);

    const companiesById = new Map(companies.map((row) => [asString(row.id), row]));
    const productsById = new Map(products.map((row) => [asString(row.id), row]));
    const suppliersById = new Map(suppliers.map((row) => [asString(row.id), row]));
    const supplierProductsById = new Map(supplierProducts.map((row) => [asString(row.id), row]));
    const supplierByProductId = new Map<string, PlainRecord>();
    for (const link of productSuppliers) {
      const companyProductId = asString(link.companyProductId);
      const supplierProduct = supplierProductsById.get(asString(link.supplierProductId));
      const supplier = suppliersById.get(asString(supplierProduct?.supplierId));
      if (companyProductId && supplierProduct) supplierByProductId.set(companyProductId, { supplierProduct, supplier });
    }

    const snapshotsByCompanyProduct = this.groupBy(inventorySnapshots, 'companyProductId');
    const factsByCompanyProduct = this.groupBy(dailyFacts, 'companyProductId');
    const ordersById = new Map(
      orders.map((order) => [
        asString(order.id),
        {
          ...order,
          status: asString(order.canonicalStatus) ?? asString(order.lifecycleStatus),
          externalOrderRef: asString(order.orderRef),
        },
      ]),
    );
    const linesByCompanyProduct = this.groupBy(
      orderLines.map((line) => ({
        ...line,
        supplierOrderId: asString(line.orderId),
        receivedQty: asNumber(line.confirmedQty) ?? 0,
      })),
      'companyProductId',
    );

    const rows: PlainRecord[] = [];
    for (const companyProduct of companyProducts) {
      const company = companiesById.get(asString(companyProduct.companyId));
      const companyName = asString(company?.name);
      if (query.company && companyName !== query.company) continue;
      const product = productsById.get(asString(companyProduct.productId));
      const companyProductId = asString(companyProduct.id);
      if (!companyProductId || !companyName || !product) continue;

      const inventory = latestPreferredInventorySnapshot(
        snapshotsByCompanyProduct.get(companyProductId) ?? [],
        sellerboardSourceConnectionIds,
      );
      const stockBuckets = this.stockBuckets(
        {
          stock: asNumber(inventory?.sellableStock),
          reserved: asNumber(inventory?.reserved),
          inbound: asNumber(inventory?.inbound),
          ordered: asNumber(inventory?.ordered),
          prepStock: asNumber(inventory?.prepStock),
        },
        {},
      );
      const historical = summarizeHistoricalProductFacts(
        factsByCompanyProduct.get(companyProductId) ?? [],
        calculationDate,
      );
      const salesVelocity = asNumber(inventory?.salesVelocity) ?? (historical.sixMonthAverageQty ?? 0) / 30;
      const supplierContext = supplierByProductId.get(companyProductId);
      const supplierProduct = toPlainRecord(supplierContext?.supplierProduct);
      const supplier = toPlainRecord(supplierContext?.supplier);
      const leadTimeDays = asNumber(supplierProduct.leadTimeDays);
      const leadTimeFreshness = typeof leadTimeDays === 'number' ? 'fresh' : 'missing';
      const openOrder = summarizeSupplierOrderState(
        linesByCompanyProduct.get(companyProductId) ?? [],
        ordersById,
        calculationDate,
        purchasedPipelineGraceDays,
        statusRules,
      );
      const openOrderCoverageQty =
        (asNumber(openOrder.supplierOrderPurchasedOpenQty) ?? 0) +
        (asNumber(openOrder.supplierOrderPlacedNotPurchasedOpenQty) ?? 0);
      const estimatedOosDate =
        salesVelocity > 0
          ? addDays(calculationDate, Math.floor(stockBuckets.currentPlanningStock / salesVelocity))
          : undefined;
      const latestSafeReorderDate =
        estimatedOosDate && typeof leadTimeDays === 'number' ? addDays(estimatedOosDate, -leadTimeDays) : undefined;
      const daysUntilSafeReorder = latestSafeReorderDate ? diffDays(latestSafeReorderDate, calculationDate) : undefined;
      const suggestedReorderQty = this.suggestedReorderQuantity({
        salesVelocity,
        leadTimeDays,
        targetCoverDays,
        currentPlanningStock: stockBuckets.currentPlanningStock,
        openOrderCoverageQty,
      });
      const tierQuantity =
        historical.sixMonthBestQty ?? historical.sixMonthAverageQty ?? salesVelocity * targetCoverDays;
      const { tier, tierScore } = profitTierFor(historical.profitPerUnit, tierQuantity, profitTierThresholds);
      const actionStatus = this.actionStatus({
        excluded: isPlanningExcluded(asString(companyProduct.lifecycleStatus)),
        salesVelocity,
        leadTimeFreshness,
        daysUntilSafeReorder,
        orderSoonWindowDays,
        openOrderCoverageQty,
      });
      const estimatedProfitRisk = isProfitTier(tier) ? (historical.profitPerUnit ?? 0) * suggestedReorderQty : 0;

      rows.push(
        this.applyProfitTierRiskGate({
          planningProductId: companyProductId,
          companyProductId,
          productId: asString(product.id),
          calculationDate,
          company: companyName,
          asin: asString(product.asin),
          sku: asString(product.sku),
          title: asString(product.title),
          productStatus: derivedProductStatus(asString(companyProduct.lifecycleStatus), stockBuckets),
          actionStatus,
          tier,
          tierScore,
          salesVelocity,
          profitPerUnit: historical.profitPerUnit,
          sixMonthMargin: historical.margin,
          lastMonthQty: historical.lastMonthQty,
          sixMonthAverageQty: historical.sixMonthAverageQty,
          sixMonthWorstQty: historical.sixMonthWorstQty,
          sixMonthBestQty: historical.sixMonthBestQty,
          ...stockBuckets,
          daysOfCover: salesVelocity > 0 ? stockBuckets.currentPlanningStock / salesVelocity : undefined,
          estimatedOosDate,
          latestSafeReorderDate,
          daysUntilSafeReorder,
          suggestedReorderQty,
          targetCoverDays,
          leadTimeDays,
          leadTimeFreshness,
          supplierId: asString(supplier?.id),
          supplierName: asString(supplier?.displayName),
          supplierSource: supplier ? 'silver_supplier_product' : undefined,
          supplierRole: supplierContext ? 'latest_used' : undefined,
          supplierConfidence: supplierContext ? 1 : undefined,
          unitCost: asNumber(supplierProduct.unitCost),
          estimatedOrderCost:
            typeof asNumber(supplierProduct.unitCost) === 'number'
              ? (asNumber(supplierProduct.unitCost) ?? 0) * suggestedReorderQty
              : undefined,
          openOrderCoverageQty,
          ...openOrder,
          stuck: salesVelocity <= 0 && stockBuckets.currentPlanningStock > 0,
          estimatedProfitRisk,
          estimatedProfitRiskBasis: isProfitTier(tier)
            ? 'silver_profit_per_unit_x_suggested_qty'
            : 'not_tiered_profit_inputs_missing',
          digestPriority: this.digestPriority(actionStatus, tier),
          evidence: {
            sourceLayer: 'silver',
            inventorySnapshotId: asString(inventory?.id),
            supplierProductId: asString(supplierProduct.id),
            historicalFactCount: (factsByCompanyProduct.get(companyProductId) ?? []).length,
          },
        }),
      );
    }

    return this.sortPlanningRows(rows).slice(0, query.limit ?? rows.length);
  }

  private async repoRows(collectionName: string, limit = FALLBACK_RECORD_LIMIT) {
    return (await this.db.getRepository(collectionName).find({ limit })).map(toPlainRecord);
  }

  private groupBy(rows: PlainRecord[], field: string) {
    const grouped = new Map<string, PlainRecord[]>();
    for (const row of rows) {
      const key = asString(row[field]);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return grouped;
  }

  private async readGoldRows(query: InventoryPlanningQuery = {}) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const requestedDate = query.calculationDate ? isoDate(query.calculationDate) : undefined;
    const companyFilter = query.company ? { company: query.company } : {};
    const readForDate = async (calculationDate: string) => {
      const records = (
        await repository.find({
          filter: { ...companyFilter, calculationDate },
          sort: ['-estimatedProfitRisk'],
        })
      ).map(toPlainRecord);
      const latestRefresh = records
        .map((record) => asString(record.lastRefreshedAt))
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      return (
        latestRefresh ? records.filter((record) => asString(record.lastRefreshedAt) === latestRefresh) : records
      ).map((record) => this.applyProfitTierRiskGate(record));
    };

    let rows = requestedDate ? await readForDate(requestedDate) : [];
    if (rows.length === 0 && !requestedDate) {
      const latest = await repository.findOne({
        filter: companyFilter,
        sort: ['-calculationDate'],
      });
      const latestDate = asString(toPlainRecord(latest).calculationDate);
      if (latestDate) {
        rows = await readForDate(latestDate);
      }
    }
    return this.sortPlanningRows(rows).slice(0, query.limit ?? rows.length);
  }

  private applyProfitTierRiskGate(row: PlainRecord) {
    if (isProfitTier(row.tier)) return row;
    return {
      ...row,
      estimatedProfitRisk: 0,
      estimatedProfitRiskBasis: 'not_tiered_profit_inputs_missing',
    };
  }

  private sortPlanningRows(rows: PlainRecord[]) {
    return [...rows].sort((left, right) => {
      const queue = riskQueueRank(left.actionStatus) - riskQueueRank(right.actionStatus);
      if (queue !== 0) return queue;
      const risk = (asNumber(right.estimatedProfitRisk) ?? 0) - (asNumber(left.estimatedProfitRisk) ?? 0);
      if (risk !== 0) return risk;
      const action =
        actionRank(left.actionStatus as InventoryPlanningActionStatus) -
        actionRank(right.actionStatus as InventoryPlanningActionStatus);
      if (action !== 0) return action;
      const tier = profitTierRank(left.tier) - profitTierRank(right.tier);
      if (tier !== 0) return tier;
      return (asNumber(right.suggestedReorderQty) ?? 0) - (asNumber(left.suggestedReorderQty) ?? 0);
    });
  }

  private latestCommandCenterTimestamp(rows: PlainRecord[]) {
    return (
      rows
        .map((row) => asString(row.lastRefreshedAt) ?? asString(row.calculationDate))
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    );
  }

  private commandCenterSummaryCards(rows: PlainRecord[]) {
    const tieredRows = rows.filter((row) => isProfitTier(row.tier));
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const activeOrderRows = this.commandCenterRowsForPane('activeOrders', rows);
    const stuckRows = this.commandCenterRowsForPane('stuckInventory', rows);
    const urgentRows = [...supplyRows, ...activeOrderRows].filter((row) =>
      ['overdue', 'order_today'].includes(String(row.actionStatus)),
    );
    const offTrackRows = activeOrderRows.filter(
      (row) => (stockoutGapDays(row) ?? 0) > 0 || String(row.supplierOrderState) === 'placed_not_purchased',
    );
    const followUpRows = activeOrderRows.filter((row) => recommendedInventoryAction(row) === 'follow_up_order');
    const profitRisk = tieredRows.reduce((total, row) => total + (asNumber(row.estimatedProfitRisk) ?? 0), 0);
    return [
      {
        key: 'urgentStockoutRisk',
        label: 'Urgent stockout risk',
        description: 'Overdue or order today',
        value: urgentRows.length,
      },
      {
        key: 'moneyAtRisk',
        label: 'Money at risk',
        description: 'A/B/C tier profit exposure',
        value: Math.round(profitRisk * 100) / 100,
        format: 'currency',
      },
      {
        key: 'supplyActionNeeded',
        label: 'Supply action needed',
        description: 'No active order placed',
        value: supplyRows.length,
      },
      {
        key: 'activeOrdersOffTrack',
        label: 'Active orders off-track',
        description: 'Expected after stockout',
        value: offTrackRows.length,
      },
      {
        key: 'followUpsDueToday',
        label: 'Follow-ups due today',
        description: 'Order comments/status needed',
        value: followUpRows.length,
      },
      {
        key: 'stuckInventory',
        label: 'Stuck inventory',
        description: '30/60+ DOC with sell-through',
        value: stuckRows.length,
      },
    ];
  }

  private commandCenterMacroRisk(rows: PlainRecord[], calculationDate: string) {
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const activeOrderRows = this.commandCenterRowsForPane('activeOrders', rows);
    const stuckRows = this.commandCenterRowsForPane('stuckInventory', rows);
    const sumRisk = (items: PlainRecord[]) =>
      Math.round(items.reduce((total, row) => total + (asNumber(row.estimatedProfitRisk) ?? 0), 0) * 100) / 100;
    const activeLateRows = activeOrderRows.filter(
      (row) => (stockoutGapDays(row) ?? 0) > 0 || pipelineHealthBucket(row, calculationDate) !== 'on_track',
    );
    const followUpRows = activeOrderRows.filter((row) => recommendedInventoryAction(row) === 'follow_up_order');
    const leadTimeGapRows = [...supplyRows, ...activeOrderRows].filter((row) => row.leadTimeFreshness !== 'fresh');
    return [
      { key: 'noOrderUrgent', label: 'No order + urgent', value: sumRisk(supplyRows), format: 'currency' },
      { key: 'activeOrderLate', label: 'Active order late', value: sumRisk(activeLateRows), format: 'currency' },
      { key: 'followUpsToday', label: 'Follow-ups today', value: followUpRows.length, suffix: 'orders' },
      {
        key: 'stuckCurrentStock',
        label: 'Stuck current stock',
        value: stuckRows.reduce((total, row) => total + (asNumber(row.currentPlanningStock) ?? 0), 0),
        suffix: 'units',
      },
      { key: 'leadTimeGaps', label: 'Lead-time gaps', value: leadTimeGapRows.length, suffix: 'rows' },
    ];
  }

  private commandCenterRiskBars(rows: PlainRecord[], calculationDate: string) {
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const activeOrderRows = this.commandCenterRowsForPane('activeOrders', rows);
    const stuckRows = this.commandCenterRowsForPane('stuckInventory', rows);
    const countByAction = (values: string[]) =>
      values.map((value) => ({
        key: value,
        count: supplyRows.filter((row) => String(row.actionStatus) === value).length,
      }));
    return {
      supplyAction: countByAction(['overdue', 'order_today', 'order_soon', 'missing_lead_time', 'stale_lead_time']),
      activeOrders: ['purchased_pipeline', 'placed_not_purchased'].map((value) => ({
        key: value,
        count: activeOrderRows.filter((row) => row.supplierOrderState === value).length,
      })),
      pipelineHealth: ['on_track', 'late_with_grace', 'late', 'placed_not_purchased', 'none'].map((value) => ({
        key: value,
        count: activeOrderRows.filter((row) => pipelineHealthBucket(row, calculationDate) === value).length,
      })),
      stuckInventory: ['high_cover_slow_sales', 'reserved_not_selling', 'pipeline_stalled'].map((value) => ({
        key: value,
        count: stuckRows.filter((row) => stuckBucket(row) === value).length,
      })),
    };
  }

  private commandCenterPanePayload(
    pane: InventoryCommandCenterPane,
    rows: PlainRecord[],
    calculationDate: string,
    query: InventoryPlanningCommandCenterQuery,
  ) {
    const page = asPositiveInteger(query.pane === pane ? query.page : undefined, 1, 10000);
    const pageSize = asPositiveInteger(query.pane === pane ? query.pageSize : undefined, 25, 100);
    const sortBy = query.pane === pane ? query.sortBy : undefined;
    const sortDirection = query.pane === pane ? query.sortDirection ?? 'desc' : 'desc';
    const filteredRows = this.sortCommandCenterRows(
      this.commandCenterRowsForPane(pane, rows).filter((row) =>
        this.matchesCommandCenterFilters(row, query.filters, calculationDate),
      ),
      sortBy ?? this.defaultCommandCenterSort(pane),
      sortDirection,
      calculationDate,
    );
    const start = (page - 1) * pageSize;
    return {
      pane,
      page,
      pageSize,
      total: filteredRows.length,
      sortBy: sortBy ?? this.defaultCommandCenterSort(pane),
      sortDirection,
      rows: filteredRows
        .slice(start, start + pageSize)
        .map((row) => this.compactCommandCenterRow(row, calculationDate)),
    };
  }

  private commandCenterRowsForPane(pane: InventoryCommandCenterPane, rows: PlainRecord[]) {
    const stockoutActionStatuses = ['overdue', 'order_today', 'order_soon', 'missing_lead_time', 'stale_lead_time'];
    const isStuckRow = (row: PlainRecord) => asBoolean(row.stuck) || stuckBucket(row) !== 'none';
    const isActiveOrderRow = (row: PlainRecord) =>
      isProfitTier(row.tier) &&
      ['purchased_pipeline', 'placed_not_purchased'].includes(String(row.supplierOrderState)) &&
      ([...stockoutActionStatuses, 'already_ordered'].includes(String(row.actionStatus)) || isStuckRow(row));

    if (pane === 'activeOrders') {
      return rows.filter(isActiveOrderRow);
    }
    if (pane === 'stuckInventory') {
      return rows.filter((row) => !isActiveOrderRow(row) && isStuckRow(row));
    }
    return rows.filter(
      (row) =>
        !isStuckRow(row) &&
        isProfitTier(row.tier) &&
        ['no_open_order', 'closed_history', ''].includes(String(row.supplierOrderState ?? '')) &&
        stockoutActionStatuses.includes(String(row.actionStatus)),
    );
  }

  private matchesCommandCenterFilters(
    row: PlainRecord,
    filters: Record<string, unknown> | undefined,
    calculationDate: string,
  ) {
    if (!filters) return true;
    const matchesList = (field: string, value: unknown) => {
      const expected = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      return expected.length === 0 || expected.includes(row[field]);
    };
    if (!matchesList('tier', filters.tier)) return false;
    if (!matchesList('actionStatus', filters.actionStatus)) return false;
    if (!matchesList('supplierOrderState', filters.supplierOrderState)) return false;
    if (!matchesList('leadTimeFreshness', filters.leadTimeFreshness)) return false;
    if (typeof filters.minProfitRisk === 'number' && (asNumber(row.estimatedProfitRisk) ?? 0) < filters.minProfitRisk)
      return false;
    if (typeof filters.maxDaysUntilOos === 'number') {
      const daysUntilOos = daysUntilDate(row.estimatedOosDate, calculationDate);
      if (typeof daysUntilOos !== 'number' || daysUntilOos > filters.maxDaysUntilOos) return false;
    }
    const search = asString(filters.search)?.toLowerCase();
    if (search) {
      const text = [row.asin, row.sku, row.title, row.supplierName]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      if (!text.includes(search)) return false;
    }
    return true;
  }

  private defaultCommandCenterSort(pane: InventoryCommandCenterPane) {
    if (pane === 'activeOrders') return 'stockoutGapDays';
    if (pane === 'stuckInventory') return 'daysOfCover';
    return 'estimatedProfitRisk';
  }

  private sortCommandCenterRows(
    rows: PlainRecord[],
    sortBy: string,
    direction: 'asc' | 'desc',
    calculationDate: string,
  ) {
    return [...rows].sort((left, right) => {
      const leftValue = this.commandCenterSortValue(left, sortBy, calculationDate);
      const rightValue = this.commandCenterSortValue(right, sortBy, calculationDate);
      if (leftValue === rightValue) return 0;
      if (leftValue === undefined || leftValue === null) return 1;
      if (rightValue === undefined || rightValue === null) return -1;
      const result = leftValue > rightValue ? 1 : -1;
      return direction === 'desc' ? -result : result;
    });
  }

  private commandCenterSortValue(
    row: PlainRecord,
    sortBy: string,
    calculationDate: string,
  ): string | number | undefined {
    if (sortBy === 'daysUntilOos') return daysUntilDate(row.estimatedOosDate, calculationDate);
    if (sortBy === 'stockoutGapDays') return stockoutGapDays(row);
    if (sortBy === 'tier') return profitTierRank(row.tier);
    if (sortBy === 'actionStatus') return actionRank(row.actionStatus as InventoryPlanningActionStatus);
    if (
      [
        'estimatedProfitRisk',
        'suggestedReorderQty',
        'daysUntilSafeReorder',
        'daysOfCover',
        'currentPlanningStock',
      ].includes(sortBy)
    ) {
      return asNumber(row[sortBy]);
    }
    return asString(row[sortBy]);
  }

  private compactCommandCenterRow(row: PlainRecord, calculationDate: string) {
    const daysUntilOos = daysUntilDate(row.estimatedOosDate, calculationDate);
    const gapDays = stockoutGapDays(row);
    return {
      id:
        asString(row.id) ??
        asString(row.naturalKey) ??
        `${asString(row.company) ?? ''}:${asString(row.asin) ?? ''}:${asString(row.sku) ?? ''}`,
      company: asString(row.company),
      planningProductId: asString(row.planningProductId),
      companyProductId: asString(row.companyProductId),
      asin: asString(row.asin),
      sku: asString(row.sku),
      title: asString(row.title),
      tier: asString(row.tier),
      tierScore: asNumber(row.tierScore),
      previousTier: asString(row.previousTier),
      currentTier: asString(row.currentTier),
      currentTierScore: asNumber(row.currentTierScore),
      averageTier: asString(row.averageTier),
      averageTierScore: asNumber(row.averageTierScore),
      bestTier: asString(row.bestTier),
      bestTierScore: asNumber(row.bestTierScore),
      actionStatus: asString(row.actionStatus),
      estimatedProfitRisk: asNumber(row.estimatedProfitRisk) ?? 0,
      estimatedProfitRiskBasis: asString(row.estimatedProfitRiskBasis),
      salesVelocity: asNumber(row.salesVelocity),
      profitPerUnit: asNumber(row.profitPerUnit),
      recommendedBestQty: asNumber(row.recommendedBestQty),
      targetCoverDays: asNumber(row.targetCoverDays),
      suggestedReorderQty: asNumber(row.suggestedReorderQty) ?? 0,
      unitCost: asNumber(row.unitCost),
      unitCostStatus: asString(row.unitCostStatus) ?? 'missing',
      unitCostSource: asString(row.unitCostSource),
      estimatedOrderCost: asNumber(row.estimatedOrderCost),
      currentPlanningStock: asNumber(row.currentPlanningStock) ?? 0,
      sellableStock: asNumber(row.sellableStock) ?? 0,
      reservedStock: asNumber(row.reservedStock) ?? 0,
      pipelineStock: asNumber(row.pipelineStock) ?? 0,
      inboundStock: asNumber(row.inboundStock) ?? 0,
      orderedStock: asNumber(row.orderedStock) ?? 0,
      prepStock: asNumber(row.prepStock) ?? 0,
      daysOfCover: asNumber(row.daysOfCover),
      estimatedOosDate: asString(row.estimatedOosDate),
      daysUntilOos,
      latestSafeReorderDate: asString(row.latestSafeReorderDate),
      daysUntilSafeReorder: asNumber(row.daysUntilSafeReorder),
      leadTimeDays: asNumber(row.leadTimeDays),
      leadTimeFreshness: asString(row.leadTimeFreshness),
      leadTimeSource:
        asString(row.leadTimeSource) ??
        (asString(row.supplierName) ? 'supplier_or_planning_parameter' : 'planning_parameter_without_supplier_mapping'),
      supplierName: asString(row.supplierName),
      supplierOrderState: asString(row.supplierOrderState),
      supplierOrderStatus: asString(row.supplierOrderStatus),
      supplierOrderRef: asString(row.supplierOrderRef),
      latestSupplierOrderActivityType: asString(row.latestSupplierOrderActivityType),
      latestSupplierOrderActivityAt: asString(row.latestSupplierOrderActivityAt),
      latestSupplierOrderActivityNote: asString(row.latestSupplierOrderActivityNote),
      latestSupplierOrderActivityActor: asString(row.latestSupplierOrderActivityActor),
      latestSupplierOrderActivityActorDisplayName: asString(row.latestSupplierOrderActivityActorDisplayName),
      latestSupplierOrderActivityActorEmail: asString(row.latestSupplierOrderActivityActorEmail),
      latestSupplierOrderActivitySource: asString(row.latestSupplierOrderActivitySource),
      openOrderCoverageQty: asNumber(row.openOrderCoverageQty) ?? 0,
      expectedSellableDate: asString(row.expectedSellableDate),
      pipelineHealthBucket: pipelineHealthBucket(row, calculationDate),
      stockoutGapDays: gapDays,
      stuck: asBoolean(row.stuck) ?? false,
      stuckBucket: stuckBucket(row),
      tierMovement: asString(row.tierMovement),
      recommendedAction: recommendedInventoryAction(row),
      lastMonthQty: asNumber(row.lastMonthQty),
      sixMonthAverageQty: asNumber(row.sixMonthAverageQty),
      sixMonthWorstQty: asNumber(row.sixMonthWorstQty),
      sixMonthBestQty: asNumber(row.sixMonthBestQty),
      sixMonthMargin: asNumber(row.sixMonthMargin),
    };
  }

  private commandCenterDrawerRow(row: PlainRecord, calculationDate: string) {
    return {
      ...this.compactCommandCenterRow(row, calculationDate),
      stockBuckets: {
        sellableStock: asNumber(row.sellableStock) ?? 0,
        reservedStock: asNumber(row.reservedStock) ?? 0,
        pipelineStock: asNumber(row.pipelineStock) ?? 0,
        inboundStock: asNumber(row.inboundStock) ?? 0,
        orderedStock: asNumber(row.orderedStock) ?? 0,
        prepStock: asNumber(row.prepStock) ?? 0,
        awdStock: asNumber(row.awdStock) ?? 0,
      },
      history: {
        lastMonthQty: asNumber(row.lastMonthQty),
        sixMonthAverageQty: asNumber(row.sixMonthAverageQty),
        sixMonthWorstQty: asNumber(row.sixMonthWorstQty),
        sixMonthBestQty: asNumber(row.sixMonthBestQty),
        sixMonthMargin: asNumber(row.sixMonthMargin),
      },
      evidence: toPlainRecord(row.evidence),
    };
  }

  private findCommandCenterSelectedRow(rows: PlainRecord[], query: InventoryPlanningCommandCenterQuery) {
    return rows.find((row) => {
      if (query.selectedRowId) {
        const rowId = asString(row.id) ?? asString(row.naturalKey);
        if (rowId === query.selectedRowId) return true;
      }
      if (query.planningProductId && row.planningProductId === query.planningProductId) return true;
      if (query.companyProductId && row.companyProductId === query.companyProductId) return true;
      if (query.asin && String(row.asin).toUpperCase() === query.asin.toUpperCase()) return true;
      return Boolean(query.sku && row.sku === query.sku);
    });
  }

  async digestPreview(query: InventoryPlanningQuery = {}) {
    const rows = await this.listRows({ ...query, limit: undefined });
    const tieredRows = rows.filter((row) => isProfitTier(row.tier));
    const digestRows = rows.filter(isDigestCandidateRow);
    const urgentRows = await this.withLatestSupplierOrderActivity(
      this.sortDigestRows(digestRows.filter(isUrgentDigestRow)),
    );
    const supplierActionItems = this.sortDigestRows(urgentRows.filter(needsSupplierAction));
    const supplierContactRows = supplierActionItems.filter((row) => asString(row.supplierName));
    return {
      generatedAt: new Date().toISOString(),
      company: query.company ?? null,
      summary: {
        overdue: digestRows.filter((row) => row.actionStatus === 'overdue').length,
        orderToday: digestRows.filter((row) => row.actionStatus === 'order_today').length,
        orderSoon: digestRows.filter((row) => row.actionStatus === 'order_soon').length,
        atRisk: urgentRows.length,
        staleOrMissingLeadTime: digestRows.filter((row) => row.leadTimeFreshness !== 'fresh').length,
        suppliersToContact: new Set(supplierContactRows.map((row) => row.supplierName).filter(Boolean)).size,
        noSupplierOrder: urgentRows.filter((row) => row.supplierOrderState === 'no_open_order').length,
        closedOrderHistoryOnly: urgentRows.filter((row) => row.supplierOrderState === 'closed_history').length,
        placedNotPurchased: urgentRows.filter((row) => row.supplierOrderState === 'placed_not_purchased').length,
        purchasedPipelineExcluded: digestRows.filter((row) => row.supplierOrderState === 'purchased_pipeline').length,
      },
      sections: {
        orderNow: urgentRows,
        noOrderProducts: urgentRows.filter((row) => row.supplierOrderState === 'no_open_order'),
        suppliersToContactFirst: this.rankSuppliers(supplierContactRows).slice(0, 10),
        supplierActionItems: supplierActionItems.slice(0, 25),
        staleLeadTimes: urgentRows.filter((row) => row.leadTimeFreshness !== 'fresh').slice(0, 25),
      },
    };
  }

  async optimizeBudget(query: InventoryBudgetOptimizationQuery) {
    const budget = asNumber(query.budget);
    if (typeof budget !== 'number' || budget <= 0) {
      throw new Error('Ecobase budget optimizer requires a budget greater than zero.');
    }
    const calculationDate = isoDate(query.calculationDate ?? new Date());
    const horizonDays = Math.max(Math.round(query.horizonDays ?? 30), 1);
    const rows = await this.listRows({ ...query, calculationDate, limit: query.limit ?? 500 });
    const urgentRows = this.sortDigestRows(
      rows.filter(
        (row) =>
          isProfitTier(row.tier) &&
          ['overdue', 'order_today', 'order_soon', 'missing_lead_time', 'stale_lead_time'].includes(
            String(row.actionStatus),
          ) &&
          row.supplierOrderState !== 'purchased_pipeline',
      ),
    );
    const silverOrders = await silverSupplierOrderReadModel(this.db, { company: query.company, limit: 1000 });
    const supplierOrders = silverOrders.supplierOrders;
    const supplierOrderLines = silverOrders.supplierOrderLines;
    const orderById = new Map(
      supplierOrders
        .map((order) => [asString(order.id), order] as const)
        .filter((entry): entry is [string, PlainRecord] => Boolean(entry[0])),
    );
    const ordersByCompanyAndRef = new Map(
      supplierOrders
        .map(
          (order) =>
            [
              `${asString(order.company) ?? ''}:${asString(order.externalOrderRef) ?? asString(order.id) ?? ''}`,
              order,
            ] as const,
        )
        .filter(([key]) => !key.endsWith(':')),
    );
    const linesByOrderId = new Map<string, PlainRecord[]>();
    for (const line of supplierOrderLines) {
      const orderId = asString(line.supplierOrderId);
      if (!orderId) continue;
      const current = linesByOrderId.get(orderId) ?? [];
      current.push(line);
      linesByOrderId.set(orderId, current);
    }

    const candidates = new Map<
      string,
      PlainRecord & { rows: PlainRecord[]; lineIds: Set<string>; reasonSet: Set<string>; urgency: number }
    >();
    const latestLineForRow = (row: PlainRecord) => supplierOrderLines.find((line) => lineMatchesRow(line, row));
    const addCandidateRow = (
      candidate: PlainRecord & { rows: PlainRecord[]; lineIds: Set<string>; reasonSet: Set<string>; urgency: number },
      row: PlainRecord,
    ) => {
      const identity = productIdentity(row);
      if (!candidate.rows.some((existing) => productIdentity(existing) === identity)) {
        candidate.rows.push(row);
        candidate.protectedProfit =
          Math.round(((asNumber(candidate.protectedProfit) ?? 0) + (asNumber(row.estimatedProfitRisk) ?? 0)) * 100) /
          100;
      }
      candidate.urgency = Math.max(candidate.urgency, urgencyWeight(row));
      const actionStatus = asString(row.actionStatus);
      const tier = asString(row.tier);
      if (actionStatus) candidate.reasonSet.add(actionStatus);
      if (tier) candidate.reasonSet.add(`tier_${tier.toLowerCase()}`);
      if (!asString(row.supplierName)) candidate.reasonSet.add('missing_supplier');
    };

    for (const row of urgentRows) {
      const supplierOrderRef = asString(row.supplierOrderRef);
      const company = asString(row.company) ?? '';
      const existingOrder = supplierOrderRef
        ? ordersByCompanyAndRef.get(`${company}:${supplierOrderRef}`) ?? orderById.get(supplierOrderRef)
        : undefined;
      if (existingOrder && row.supplierOrderState === 'placed_not_purchased') {
        const orderId = asString(existingOrder.id) ?? supplierOrderRef;
        const key = `order:${orderId}`;
        const orderLines = linesByOrderId.get(orderId) ?? [];
        let candidate = candidates.get(key);
        if (!candidate) {
          let spend = 0;
          let missingCost = false;
          let openQuantity = 0;
          const lineSummaries = [] as PlainRecord[];
          for (const line of orderLines) {
            const quantity = openQty(line);
            if (quantity <= 0) continue;
            openQuantity += quantity;
            const unitCost = asNumber(line.unitCost);
            if (typeof unitCost !== 'number' || unitCost <= 0) {
              missingCost = true;
            } else {
              spend += quantity * unitCost;
            }
            lineSummaries.push({
              supplierOrderLineId: asString(line.id),
              planningProductId: asString(line.planningProductId),
              asin: asString(line.asin),
              sku: asString(line.sku),
              brand: asString(line.brand),
              openQty: quantity,
              unitCost,
              lineSpend:
                typeof unitCost === 'number' && unitCost > 0 ? Math.round(quantity * unitCost * 100) / 100 : undefined,
            });
          }
          candidate = {
            key,
            candidateType: 'supplier_order',
            recommendedAction: recommendedActionForStatus(existingOrder.status),
            supplierOrderId: orderId,
            supplierOrderRef: asString(existingOrder.externalOrderRef) ?? orderId,
            supplierOrderStatus: asString(existingOrder.status),
            company,
            supplierId: asString(existingOrder.supplierId),
            supplierName: asString(existingOrder.supplierName),
            spend: missingCost || spend <= 0 ? undefined : Math.round(spend * 100) / 100,
            openQty: openQuantity,
            protectedProfit: 0,
            score: 0,
            adjustedScore: 0,
            lineSummaries,
            rows: [],
            lineIds: new Set(lineSummaries.map((line) => String(line.supplierOrderLineId ?? '')).filter(Boolean)),
            reasonSet: new Set<string>(),
            urgency: 0,
          };
          if (missingCost || spend <= 0) candidate.reasonSet.add('missing_unit_cost');
          if (asString(existingOrder.status)) candidate.reasonSet.add(asString(existingOrder.status) as string);
          candidates.set(key, candidate);
        }
        addCandidateRow(candidate, row);
        continue;
      }

      const suggestedQty = asNumber(row.suggestedReorderQty) ?? 0;
      const historyLine = latestLineForRow(row);
      const unitCost = asNumber(historyLine?.unitCost);
      const spend =
        suggestedQty > 0 && typeof unitCost === 'number' && unitCost > 0 ? suggestedQty * unitCost : undefined;
      const key = `product:${productIdentity(row)}`;
      const candidate: PlainRecord & {
        rows: PlainRecord[];
        lineIds: Set<string>;
        reasonSet: Set<string>;
        urgency: number;
      } = {
        key,
        candidateType: 'planning_product',
        recommendedAction: spend ? 'create_order' : 'recover_supplier_or_cost',
        planningProductId: asString(row.planningProductId),
        company: asString(row.company),
        asin: asString(row.asin),
        sku: asString(row.sku),
        title: asString(row.title),
        supplierId: asString(row.supplierId),
        supplierName: asString(row.supplierName),
        suggestedReorderQty: suggestedQty,
        unitCost,
        spend: spend ? Math.round(spend * 100) / 100 : undefined,
        protectedProfit: 0,
        score: 0,
        adjustedScore: 0,
        rows: [],
        lineIds: new Set<string>(),
        reasonSet: new Set<string>(),
        urgency: 0,
      };
      if (!spend) candidate.reasonSet.add('missing_unit_cost');
      addCandidateRow(candidate, row);
      candidates.set(key, candidate);
    }

    const rankedCandidates = [...candidates.values()]
      .map((candidate): PlainRecord => {
        const spend = asNumber(candidate.spend);
        const protectedProfit = asNumber(candidate.protectedProfit) ?? 0;
        const score = spend && spend > 0 ? protectedProfit / spend : 0;
        const adjustedScore = score * (1 + candidate.urgency / 100);
        const { rows: candidateRows, lineIds: _lineIds, reasonSet, urgency: _urgency, ...publicCandidate } = candidate;
        return {
          ...publicCandidate,
          score: Math.round(score * 10000) / 10000,
          adjustedScore: Math.round(adjustedScore * 10000) / 10000,
          urgencyScore: candidate.urgency,
          reasonCodes: [...reasonSet].sort(),
          rows: candidateRows.map((row) => ({
            planningProductId: asString(row.planningProductId),
            company: asString(row.company),
            asin: asString(row.asin),
            sku: asString(row.sku),
            title: asString(row.title),
            tier: asString(row.tier),
            actionStatus: asString(row.actionStatus),
            estimatedOosDate: asString(row.estimatedOosDate),
            estimatedProfitRisk: asNumber(row.estimatedProfitRisk) ?? 0,
            suggestedReorderQty: asNumber(row.suggestedReorderQty) ?? 0,
          })),
        };
      })
      .sort((left, right) => {
        const leftSpend = asNumber(left.spend);
        const rightSpend = asNumber(right.spend);
        if (!leftSpend && rightSpend) return 1;
        if (leftSpend && !rightSpend) return -1;
        const scoreDiff = (asNumber(right.adjustedScore) ?? 0) - (asNumber(left.adjustedScore) ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const urgencyDiff = (asNumber(right.urgencyScore) ?? 0) - (asNumber(left.urgencyScore) ?? 0);
        if (urgencyDiff !== 0) return urgencyDiff;
        return (asNumber(right.protectedProfit) ?? 0) - (asNumber(left.protectedProfit) ?? 0);
      });

    let selectedSpend = 0;
    let expectedProtectedProfit = 0;
    const recommendations: PlainRecord[] = [];
    const skipped: PlainRecord[] = [];
    for (const candidate of rankedCandidates) {
      const spend = asNumber(candidate.spend);
      if (!spend || spend <= 0) {
        skipped.push({ ...candidate, skipReason: 'missing_unit_cost' });
        continue;
      }
      if (selectedSpend + spend <= budget) {
        selectedSpend += spend;
        expectedProtectedProfit += asNumber(candidate.protectedProfit) ?? 0;
        recommendations.push(candidate);
      } else {
        skipped.push({ ...candidate, skipReason: 'exceeds_remaining_budget' });
      }
    }

    return {
      mode: 'budget_optimizer',
      generatedAt: new Date().toISOString(),
      company: query.company ?? null,
      calculationDate,
      horizonDays,
      budget: Math.round(budget * 100) / 100,
      candidateCount: rankedCandidates.length,
      selectedCount: recommendations.length,
      selectedSpend: Math.round(selectedSpend * 100) / 100,
      remainingBudget: Math.round((budget - selectedSpend) * 100) / 100,
      expectedProtectedProfit: Math.round(expectedProtectedProfit * 100) / 100,
      recommendations,
      skipped: skipped.slice(0, 25),
      assumptions: [
        'Budget optimization is optional; empty budget keeps the normal daily digest unchanged.',
        'Spend uses open quantity multiplied by imported or previously observed unit cost.',
        'Candidates missing unit cost are shown as skipped instead of selected silently.',
        'Protected profit uses the inventory-planning estimated profit risk for the selected horizon.',
      ],
    };
  }

  async filterOptions() {
    const sourceConnectionCompanies = await this.sourceConnectionCompanies();
    const rows = await this.listRows({ limit: 500 });
    const companies = [
      ...new Set([...sourceConnectionCompanies.values(), ...rows.map((row) => asString(row.company)).filter(Boolean)]),
    ].sort();
    const productStatuses = [...new Set(rows.map((row) => asString(row.productStatus)).filter(Boolean))].sort();
    return {
      companies,
      productStatuses,
      actionStatuses: [
        'overdue',
        'order_today',
        'missing_lead_time',
        'stale_lead_time',
        'order_soon',
        'already_ordered',
        'watch',
        'sufficient_stock',
        'excluded',
      ],
      tiers: ['A', 'B', 'C'],
      leadTimeFreshness: ['fresh', 'stale', 'missing'],
    };
  }

  async refreshReadModel(query: InventoryPlanningQuery = {}) {
    const calculationDate = isoDate(query.calculationDate ?? new Date());
    const rows = await this.calculateRows({ ...query, calculationDate, limit: query.limit ?? 500 });
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const previousRows = (await repository.find({ limit: 10000 })).map(toPlainRecord);
    const refreshedAt = new Date().toISOString();
    let created = 0;
    let updated = 0;

    for (const row of rows) {
      const planningProductId = asString(row.planningProductId) ?? asString(row.asin) ?? asString(row.sku);
      if (!planningProductId) continue;
      const naturalKey = `${calculationDate}:${asString(row.company) ?? 'all'}:${planningProductId}`;
      const values: PlainRecord = {
        id: stableUuid(naturalKey),
        naturalKey,
        lastRefreshedAt: refreshedAt,
      };
      for (const field of INVENTORY_PLANNING_ROW_FIELDS) {
        values[field] = field === 'calculationDate' ? calculationDate : row[field] ?? null;
      }
      const previousTier = this.previousTierForRow(row, previousRows, calculationDate);
      values.previousTier = previousTier ?? null;
      values.tierMovement = profitTierMovement(row.tier, previousTier) ?? null;
      const existing = await repository.findOne({ filter: { naturalKey } });
      if (existing) {
        const existingId = toPlainRecord(existing).id;
        if (typeof existingId !== 'string' && typeof existingId !== 'number') {
          throw new Error(`Ecobase inventory-planning refresh failed: row ${naturalKey} is missing id.`);
        }
        await repository.update({ filterByTk: existingId, values });
        updated += 1;
      } else {
        await repository.create({ values });
        created += 1;
      }
    }

    return { calculationDate, rowCount: rows.length, created, updated, lastRefreshedAt: refreshedAt };
  }

  private previousTierForRow(row: PlainRecord, previousRows: PlainRecord[], calculationDate: string) {
    const planningProductId = asString(row.planningProductId);
    const company = asString(row.company);
    if (!planningProductId || !company) return undefined;
    return previousRows
      .filter(
        (candidate) =>
          asString(candidate.planningProductId) === planningProductId &&
          asString(candidate.company) === company &&
          String(candidate.calculationDate ?? '') < calculationDate,
      )
      .sort((left, right) => String(right.calculationDate ?? '').localeCompare(String(left.calculationDate ?? '')))
      .map((candidate) => candidate.tier)
      .find(isProfitTier);
  }

  private async listFallbackRows(params: {
    company?: string;
    calculationDate: string;
    leadTimeFreshnessDays: number;
    orderSoonWindowDays: number;
    safetyBufferDays: number;
    reorderCycleDays: number;
    targetCoverDays: number;
    purchasedPipelineGraceDays: number;
    profitTierThresholds: ProfitTierThresholds;
    statusRules: SupplierOrderStatusRules;
    limit?: number;
    scanLimit?: number;
  }) {
    const activeSourceConnectionIds = await this.activeSourceConnectionIds();
    const sourceConnectionCompanies = await this.sourceConnectionCompanies();
    const sellerboardSourceConnectionIds = await this.sellerboardSourceConnectionIds();
    const inventoryRows = (
      await this.findFallbackRecords(ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        company: params.company,
        sourceConnectionCompanies,
        activeSourceConnectionIds,
        sort: ['-snapshotDate'],
        limit: FALLBACK_RECORD_LIMIT,
      })
    ).filter((row) => {
      const snapshotDate = optionalIsoDate(row.snapshotDate);
      return Boolean(snapshotDate && snapshotDate <= params.calculationDate);
    });
    const parameterRows = await this.findFallbackRecords(ECOBASE_COLLECTIONS.silverSupplierProducts, {
      company: params.company,
      sourceConnectionCompanies,
      activeSourceConnectionIds,
      limit: params.scanLimit ? Math.max(params.scanLimit * 2, 500) : undefined,
    });
    const profitMetrics = await this.profitMetricsByProduct({
      company: params.company,
      calculationDate: params.calculationDate,
      sourceConnectionCompanies,
    });
    const historicalProfitMetrics = await this.historicalProfitMetricsByProduct({
      company: params.company,
      calculationDate: params.calculationDate,
      sourceConnectionCompanies,
    });
    const parameterByProduct = new Map<string, PlainRecord>();
    for (const parameter of parameterRows) {
      const key = this.fallbackProductKey(parameter, sourceConnectionCompanies);
      if (key && !parameterByProduct.has(key)) {
        parameterByProduct.set(key, parameter);
      }
    }

    const inventoryByProduct = new Map<string, PlainRecord>();
    for (const inventory of inventoryRows) {
      const key = this.fallbackProductKey(inventory, sourceConnectionCompanies);
      if (!key) continue;
      const current = inventoryByProduct.get(key);
      if (!current || inventorySnapshotWins(inventory, current, sellerboardSourceConnectionIds)) {
        inventoryByProduct.set(key, inventory);
      }
    }

    const rows: PlainRecord[] = [];
    for (const [key, inventory] of inventoryByProduct) {
      rows.push(
        await this.buildFallbackRow({
          inventory,
          parameter: parameterByProduct.get(key) ?? {},
          sourceConnectionCompanies,
          profitMetrics,
          historicalProfitMetrics,
          calculationDate: params.calculationDate,
          leadTimeFreshnessDays: params.leadTimeFreshnessDays,
          orderSoonWindowDays: params.orderSoonWindowDays,
          safetyBufferDays: params.safetyBufferDays,
          reorderCycleDays: params.reorderCycleDays,
          targetCoverDays: params.targetCoverDays,
          purchasedPipelineGraceDays: params.purchasedPipelineGraceDays,
          profitTierThresholds: params.profitTierThresholds,
          statusRules: params.statusRules,
        }),
      );
    }

    return this.sortPlanningRows(rows).slice(0, params.limit ?? rows.length);
  }

  private async profitMetricsByProduct(params: {
    company?: string;
    calculationDate: string;
    sourceConnectionCompanies: Map<string, string>;
  }): Promise<ProfitMetricsIndex> {
    const facts = await this.findFallbackRecords(ECOBASE_COLLECTIONS.silverListingDailyFacts, {
      company: params.company,
      sourceConnectionCompanies: params.sourceConnectionCompanies,
      activeSourceConnectionIds: await this.activeSourceConnectionIds(),
    });
    const currentMonthStart = monthStart(params.calculationDate);
    let hasCurrentMonthFacts = false;
    let latestPriorFactDate: string | undefined;
    for (const fact of facts) {
      const snapshotDate = optionalIsoDate(fact.snapshotDate);
      if (!snapshotDate || snapshotDate > params.calculationDate) continue;
      if (snapshotDate >= currentMonthStart) {
        hasCurrentMonthFacts = true;
        break;
      }
      if (!latestPriorFactDate || snapshotDate > latestPriorFactDate) {
        latestPriorFactDate = snapshotDate;
      }
    }

    const start = hasCurrentMonthFacts || !latestPriorFactDate ? currentMonthStart : monthStart(latestPriorFactDate);
    const end = hasCurrentMonthFacts || !latestPriorFactDate ? params.calculationDate : latestPriorFactDate;
    const index: ProfitMetricsIndex = { exact: new Map(), byAsin: new Map() };

    for (const fact of facts) {
      const snapshotDate = optionalIsoDate(fact.snapshotDate);
      if (!snapshotDate || snapshotDate < start || snapshotDate > end) continue;
      const company = companyFromRecord(fact, params.sourceConnectionCompanies);
      const asin = asString(fact.asin);
      if (!company || !asin || asin === '__TOTAL__') continue;
      const sku = asString(fact.sku);
      this.addProfitMetric(index.byAsin, profitMetricKey(company, asin), fact);
      if (sku && sku !== asin) {
        this.addProfitMetric(index.exact, profitMetricKey(company, asin, sku), fact);
      }
    }

    return index;
  }

  private async historicalProfitMetricsByProduct(params: {
    company?: string;
    calculationDate: string;
    sourceConnectionCompanies: Map<string, string>;
  }): Promise<HistoricalProfitMetricsIndex> {
    const facts = await this.findFallbackRecords(ECOBASE_COLLECTIONS.silverListingDailyFacts, {
      company: params.company,
      sourceConnectionCompanies: params.sourceConnectionCompanies,
      activeSourceConnectionIds: await this.activeSourceConnectionIds(),
    });
    const exactFacts = new Map<string, PlainRecord[]>();
    const byAsinFacts = new Map<string, PlainRecord[]>();
    const addFact = (groups: Map<string, PlainRecord[]>, key: string, fact: PlainRecord) => {
      groups.set(key, [...(groups.get(key) ?? []), fact]);
    };

    for (const fact of facts) {
      const company = companyFromRecord(fact, params.sourceConnectionCompanies);
      const asin = asString(fact.asin);
      if (!company || !asin || asin === '__TOTAL__') continue;
      const sku = asString(fact.sku);
      addFact(byAsinFacts, profitMetricKey(company, asin), fact);
      if (sku && sku !== asin) {
        addFact(exactFacts, profitMetricKey(company, asin, sku), fact);
      }
    }

    const summarizeGroups = (groups: Map<string, PlainRecord[]>) =>
      new Map(
        [...groups.entries()].map(([key, groupedFacts]) => [
          key,
          summarizeHistoricalProductFacts(groupedFacts, params.calculationDate),
        ]),
      );

    return { exact: summarizeGroups(exactFacts), byAsin: summarizeGroups(byAsinFacts) };
  }

  private addProfitMetric(metrics: Map<string, ProfitMetrics>, key: string, fact: PlainRecord) {
    const metric = metrics.get(key) ?? { sales: 0, units: 0, profit: 0, refunds: 0 };
    metric.sales += asNumber(fact.sales) ?? 0;
    metric.units += asNumber(fact.units) ?? 0;
    metric.profit += asNumber(fact.netProfit) ?? asNumber(fact.profit) ?? 0;
    metric.refunds += asNumber(fact.refunds) ?? 0;
    metric.profitPerUnit = metric.units > 0 ? metric.profit / metric.units : undefined;
    metrics.set(key, metric);
  }

  private profitMetricsFor<T>(
    metrics: { exact: Map<string, T>; byAsin: Map<string, T> },
    company: string,
    asin?: string,
    sku?: string,
  ) {
    if (!asin) return undefined;
    return (
      (sku ? metrics.exact.get(profitMetricKey(company, asin, sku)) : undefined) ??
      metrics.byAsin.get(profitMetricKey(company, asin))
    );
  }

  private fallbackProductKey(record: PlainRecord, sourceConnectionCompanies: Map<string, string>) {
    const company = companyFromRecord(record, sourceConnectionCompanies);
    const asin = asString(record.asin) ?? payloadString(record, ['ASIN', 'asin']);
    const sku = asString(record.sku) ?? payloadString(record, ['SKU', 'sku']);
    return company && (asin || sku) ? `${company}:${asin ?? ''}:${sku ?? ''}` : undefined;
  }

  private async buildFallbackRow(params: {
    inventory: PlainRecord;
    parameter: PlainRecord;
    sourceConnectionCompanies: Map<string, string>;
    profitMetrics: ProfitMetricsIndex;
    historicalProfitMetrics: HistoricalProfitMetricsIndex;
    calculationDate: string;
    leadTimeFreshnessDays: number;
    orderSoonWindowDays: number;
    safetyBufferDays: number;
    reorderCycleDays: number;
    targetCoverDays: number;
    purchasedPipelineGraceDays: number;
    profitTierThresholds: ProfitTierThresholds;
    statusRules: SupplierOrderStatusRules;
  }) {
    const company =
      companyFromRecord(params.inventory, params.sourceConnectionCompanies) ??
      companyFromRecord(params.parameter, params.sourceConnectionCompanies);
    if (!company) {
      throw new Error('Ecobase inventory planning fallback failed: company scope is required.');
    }
    const asin =
      asString(params.inventory.asin) ?? asString(params.parameter.asin) ?? payloadString(params.inventory, ['ASIN']);
    const sku =
      asString(params.inventory.sku) ?? asString(params.parameter.sku) ?? payloadString(params.inventory, ['SKU']);
    const planningProductId = `fallback:${company}:${asin ?? ''}:${sku ?? ''}`;
    const sellerboardProfitMetrics = this.profitMetricsFor(params.profitMetrics, company, asin, sku);
    const historicalProfitMetrics = this.profitMetricsFor(params.historicalProfitMetrics, company, asin, sku);
    const stockBuckets = this.stockBuckets(params.inventory, {});
    const salesVelocity =
      asNumber(params.inventory.salesVelocity) ??
      payloadNumber(params.inventory, ['Estimated Sales Velocity', 'Exp Sales Vel', 'Sales Velocity']);
    const importedLeadTimeDays =
      asNumber(params.parameter.leadTimeDays) ??
      payloadNumber(params.parameter, ['Lead Time', 'Avg Lead Time', 'Lead time(day)', 'Manuf. time days']);
    const orderHistorySupplier = !asString(params.parameter.supplier)
      ? await this.findOrderHistorySupplier({ company, asin, sku })
      : {};
    const orderHistoryLines = await this.findOrderLinesByProduct({ company, asin, sku });
    const orderHistoryDerivedLeadTime = this.leadTimeFromOrderHistory(
      orderHistoryLines,
      await this.supplierOrdersByLine(orderHistoryLines),
    );
    const leadTimeDays = importedLeadTimeDays ?? orderHistoryDerivedLeadTime.leadTimeDays;
    const hasCompleteHistoricalWindow = Object.keys(historicalProfitMetrics?.monthlyUnits ?? {}).length >= 6;
    const importedRecommendedBestQty =
      payloadNumber(params.parameter, ['recommendedBestQty', 'Rec.Best Qty', 'Rec. Best Qty']) ??
      asNumber(params.inventory.recommendedReorderQuantity);
    const recommendedBestQty = hasCompleteHistoricalWindow
      ? historicalProfitMetrics?.sixMonthBestQty ?? importedRecommendedBestQty
      : importedRecommendedBestQty ?? historicalProfitMetrics?.sixMonthBestQty;
    const profitPerUnit =
      historicalProfitMetrics?.profitPerUnit ??
      asNumber(params.parameter.profitPerUnit) ??
      payloadNumber(params.parameter, ['profitPerUnit', 'Profit Per Unit', 'Per.Unit Profit']) ??
      sellerboardProfitMetrics?.profitPerUnit;
    const importedProfitRisk =
      payloadNumber(params.inventory, ['Missed profit (est)', 'Profit forecast (30 days)', 'profitForecast30Days']) ??
      payloadNumber(params.parameter, ['Missed profit (est)', 'Profit forecast (30 days)', 'profitForecast30Days']);
    const currentTierResult = profitTierFor(
      profitPerUnit,
      historicalProfitMetrics?.lastMonthQty,
      params.profitTierThresholds,
    );
    const averageTierResult = profitTierFor(
      profitPerUnit,
      historicalProfitMetrics?.sixMonthAverageQty,
      params.profitTierThresholds,
    );
    const bestTierResult = profitTierFor(
      profitPerUnit,
      historicalProfitMetrics?.sixMonthBestQty,
      params.profitTierThresholds,
    );
    const fallbackTierResult = profitTierFor(profitPerUnit, recommendedBestQty, params.profitTierThresholds);
    const selectedTierResult = hasCompleteHistoricalWindow ? currentTierResult : fallbackTierResult;
    const tier = selectedTierResult.tier;
    const tierScore = selectedTierResult.tierScore;
    const daysOfCover =
      salesVelocity && salesVelocity > 0 ? stockBuckets.currentPlanningStock / salesVelocity : undefined;
    const estimatedOosDate = typeof daysOfCover === 'number' ? addDays(params.calculationDate, daysOfCover) : undefined;
    const latestSafeReorderDate =
      typeof leadTimeDays === 'number' && estimatedOosDate
        ? addDays(estimatedOosDate, -(leadTimeDays + params.safetyBufferDays))
        : undefined;
    const daysUntilSafeReorder = latestSafeReorderDate
      ? diffDays(latestSafeReorderDate, params.calculationDate)
      : undefined;
    const productStatus = derivedProductStatus(
      payloadString(params.parameter, ['productStatus', 'Product Status', 'Product Status ', 'status', 'Status']) ??
        payloadString(params.inventory, ['productStatus', 'Product Status', 'Product Status ', 'status', 'Status']),
      stockBuckets,
    );
    const planningExcluded = isPlanningExcluded(productStatus);
    const leadTimeConfirmedAt =
      asString(orderHistoryLeadTime.confirmedAt) ??
      orderHistoryDerivedLeadTime.confirmedAt ??
      asString(params.parameter.confirmedAt) ??
      payloadString(params.parameter, ['confirmedAt', 'Lead Time Confirmed At']);
    const leadTimeAgeDays = daysSince(leadTimeConfirmedAt, params.calculationDate);
    const leadTimeFreshness =
      typeof leadTimeDays !== 'number'
        ? 'missing'
        : typeof leadTimeAgeDays === 'number' && leadTimeAgeDays > params.leadTimeFreshnessDays
          ? 'stale'
          : 'fresh';
    const supplierOrderState = await this.supplierOrderStateForProduct({
      company,
      asin,
      sku,
      calculationDate: params.calculationDate,
      purchasedPipelineGraceDays: params.purchasedPipelineGraceDays,
      statusRules: params.statusRules,
    });
    const openOrderCoverageQty = supplierOrderState.supplierOrderPurchasedOpenQty;
    const expectedSellableDate =
      asString(supplierOrderState.expectedSellableDate) ??
      (asString(supplierOrderState.supplierOrderRef)
        ? undefined
        : await this.earliestFallbackExpectedSellableDate({ company, asin, sku }));
    const suggestedReorderQty = this.suggestedReorderQuantity({
      salesVelocity,
      leadTimeDays,
      targetCoverDays: params.targetCoverDays,
      currentPlanningStock: stockBuckets.currentPlanningStock,
      openOrderCoverageQty,
    });
    const actionStatus = this.actionStatus({
      excluded: planningExcluded,
      salesVelocity,
      leadTimeFreshness,
      daysUntilSafeReorder,
      orderSoonWindowDays: params.orderSoonWindowDays,
      openOrderCoverageQty,
    });
    const riskDays =
      typeof leadTimeDays === 'number' && typeof salesVelocity === 'number' && typeof daysOfCover === 'number'
        ? Math.max(0, leadTimeDays + params.safetyBufferDays - daysOfCover)
        : undefined;
    const computedProfitRisk =
      typeof riskDays === 'number' && typeof profitPerUnit === 'number' && typeof salesVelocity === 'number'
        ? riskDays * salesVelocity * profitPerUnit
        : undefined;
    const estimatedProfitRisk = isProfitTier(tier) ? computedProfitRisk ?? importedProfitRisk ?? 0 : 0;
    const estimatedProfitRiskBasis = !isProfitTier(tier)
      ? 'not_tiered_profit_inputs_missing'
      : typeof computedProfitRisk === 'number'
        ? 'uncovered_oos_days × sales_velocity × profit_per_unit'
        : typeof importedProfitRisk === 'number'
          ? 'imported_missed_profit_or_30_day_profit_forecast'
          : 'not_available';
    const supplierName =
      asString(params.parameter.supplier) ??
      payloadString(params.parameter, ['Supplier Name', 'Supplier']) ??
      asString(orderHistorySupplier.supplierName);

    return {
      planningProductId,
      company,
      asin,
      sku,
      title:
        payloadString(params.inventory, ['Title', 'Product Name', 'Product']) ??
        payloadString(params.parameter, ['Title', 'Product Name', 'Product']),
      brand: payloadString(params.parameter, ['Brand', 'brand']),
      productStatus,
      planningExcluded,
      tier,
      tierScore,
      currentTier: currentTierResult.tier ?? 'unclassified',
      currentTierScore: currentTierResult.tierScore,
      averageTier: averageTierResult.tier ?? 'unclassified',
      averageTierScore: averageTierResult.tierScore,
      bestTier: bestTierResult.tier ?? 'unclassified',
      bestTierScore: bestTierResult.tierScore,
      lastMonthQty: historicalProfitMetrics?.lastMonthQty,
      sixMonthAverageQty: historicalProfitMetrics?.sixMonthAverageQty,
      sixMonthWorstQty: historicalProfitMetrics?.sixMonthWorstQty,
      sixMonthBestQty: historicalProfitMetrics?.sixMonthBestQty,
      sixMonthMargin: historicalProfitMetrics?.margin,
      profitPerUnit,
      recommendedBestQty,
      salesVelocity,
      currentPlanningStock: stockBuckets.currentPlanningStock,
      sellableStock: stockBuckets.sellableStock,
      pipelineStock: stockBuckets.pipelineStock,
      reservedStock: stockBuckets.reservedStock,
      inboundStock: stockBuckets.inboundStock,
      orderedStock: stockBuckets.orderedStock,
      prepStock: stockBuckets.prepStock,
      awdStock: stockBuckets.awdStock,
      stuck: typeof daysOfCover === 'number' && daysOfCover > 60,
      daysOfCover,
      estimatedOosDate,
      latestSafeReorderDate,
      daysUntilSafeReorder,
      actionStatus,
      suggestedReorderQty,
      safetyBufferDays: params.safetyBufferDays,
      reorderCycleDays: params.reorderCycleDays,
      targetCoverDays: params.targetCoverDays,
      orderSoonWindowDays: params.orderSoonWindowDays,
      leadTimeFreshnessDays: params.leadTimeFreshnessDays,
      purchasedPipelineGraceDays: params.purchasedPipelineGraceDays,
      supplierId: asString(params.parameter.supplierId) ?? asString(orderHistorySupplier.supplierId),
      supplierName,
      supplierSource: asString(orderHistorySupplier.supplierName)
        ? 'order_details_history'
        : 'planning_parameter_fallback',
      supplierRole: asString(orderHistorySupplier.supplierName) ? 'latest_order_history' : 'latest_history',
      supplierConfidence: asString(orderHistorySupplier.supplierName) ? 'medium' : 'low',
      leadTimeDays,
      leadTimeConfirmedAt,
      leadTimeFreshness,
      leadTimeSource: supplierName ? 'supplier_or_planning_parameter' : 'planning_parameter_without_supplier_mapping',
      openOrderCoverageQty,
      ...supplierOrderState,
      expectedSellableDate,
      estimatedProfitRisk,
      estimatedProfitRiskBasis,
      monthToDateRevenue:
        payloadNumber(params.inventory, ['MTD Revenue ', 'MTD Revenue', 'mtdRevenue', 'monthToDateRevenue']) ??
        sellerboardProfitMetrics?.sales,
      monthToDateUnitsSold:
        payloadNumber(params.inventory, ['MTD Unit Sold', 'MTD Units Sold', 'mtdUnitSold', 'monthToDateUnitsSold']) ??
        sellerboardProfitMetrics?.units,
      monthToDateProfit:
        payloadNumber(params.inventory, ['MTD Profit ', 'MTD Profit', 'mtdProfit', 'monthToDateProfit']) ??
        sellerboardProfitMetrics?.profit,
      digestPriority: this.digestPriority(actionStatus, tier),
      evidence: {
        fallbackReason:
          'planningProducts table is empty; row derived from inventory_snapshot and planning_parameter records.',
        leadTimeAgeDays,
        stockBuckets,
        planningSettings: {
          safetyBufferDays: params.safetyBufferDays,
          reorderCycleDays: params.reorderCycleDays,
          targetCoverDays: params.targetCoverDays,
          orderSoonWindowDays: params.orderSoonWindowDays,
          leadTimeFreshnessDays: params.leadTimeFreshnessDays,
          purchasedPipelineGraceDays: params.purchasedPipelineGraceDays,
        },
        estimatedProfitRiskBasis,
        sellerboardProfitMetrics,
        historicalProfitMetrics,
      },
    };
  }

  private async buildRow(params: {
    product: PlainRecord;
    calculation: PlainRecord;
    calculationDate: string;
    leadTimeFreshnessDays: number;
    orderSoonWindowDays: number;
    reorderCycleDays: number;
    targetCoverDays: number;
    purchasedPipelineGraceDays: number;
    profitTierThresholds: ProfitTierThresholds;
    statusRules: SupplierOrderStatusRules;
    sellerboardSourceConnectionIds: Set<string>;
  }) {
    const planningProductId = asString(params.product.id) ?? '';
    const company = asString(params.product.company);
    const inventoryRows = await findRecords(this.db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      companyProductId: planningProductId,
    });
    const parameterRows = await findRecords(this.db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
      productId: planningProductId,
    });
    let orderLines = (await silverSupplierOrderReadModel(this.db, { company, limit: 5000 })).supplierOrderLines.filter(
      (line) => asString(line.planningProductId) === planningProductId,
    );
    const latestInventory =
      latestPreferredInventorySnapshot(inventoryRows, params.sellerboardSourceConnectionIds) ?? {};
    const latestParameter = latestByDate(parameterRows, 'lastImportRunId') ?? parameterRows[0] ?? {};
    const supplier = await this.findSupplier(latestParameter);
    const stockBuckets = this.stockBuckets(latestInventory, params.calculation);
    const productStatus = derivedProductStatus(
      payloadString(latestParameter, ['productStatus', 'Product Status', 'Product Status ', 'status', 'Status']) ??
        payloadString(latestInventory, ['productStatus', 'Product Status', 'Product Status ', 'status', 'Status']) ??
        asString(params.product.status),
      stockBuckets,
    );
    const excluded = isPlanningExcluded(productStatus);
    const salesVelocity = asNumber(params.calculation.salesVelocity);
    const calculationTier = asString(params.calculation.tier);
    const fallbackTier = profitTierFor(
      asNumber(params.calculation.profitPerUnit),
      asNumber(params.calculation.recommendedBestQty),
      params.profitTierThresholds,
    );
    const asin =
      asString(params.product.canonicalAsin) ?? asString(latestInventory.asin) ?? asString(latestParameter.asin);
    const sku = asString(latestInventory.sku) ?? asString(latestParameter.sku);
    const orderLinesById = new Map(
      orderLines.map((line) => [
        asString(line.id) ?? `${asString(line.supplierOrderId) ?? ''}:${asString(line.sourceOrderLineRef) ?? ''}`,
        line,
      ]),
    );
    for (const line of await this.findOrderLinesByProduct({ company, asin, sku })) {
      const id =
        asString(line.id) ?? `${asString(line.supplierOrderId) ?? ''}:${asString(line.sourceOrderLineRef) ?? ''}`;
      orderLinesById.set(id, line);
    }
    orderLines = [...orderLinesById.values()];
    const supplierOrderById = await this.supplierOrdersByLine(orderLines);
    const supplierOrderState = summarizeSupplierOrderState(
      orderLines,
      supplierOrderById,
      params.calculationDate,
      params.purchasedPipelineGraceDays,
      params.statusRules,
    );
    const openOrderCoverageQty = supplierOrderState.supplierOrderPurchasedOpenQty;
    const orderHistorySupplier =
      !asString(supplier.displayName) && !asString(latestParameter.supplier)
        ? await this.findOrderHistorySupplier({ company, asin, sku })
        : {};
    const leadTime = latestParameter;
    const orderHistoryLeadTime = this.leadTimeFromOrderHistory(orderLines, supplierOrderById);
    const leadTimeDays =
      asNumber(leadTime.leadTimeDays) ??
      asNumber(orderHistoryLeadTime.leadTimeDays) ??
      asNumber(params.calculation.leadTimeDays);
    const leadTimeConfirmedAt = asString(leadTime.confirmedAt) ?? orderHistoryLeadTime.confirmedAt;
    const leadTimeAgeDays = daysSince(leadTimeConfirmedAt, params.calculationDate);
    const leadTimeFreshness =
      typeof leadTimeDays !== 'number'
        ? 'missing'
        : typeof leadTimeAgeDays === 'number' && leadTimeAgeDays > params.leadTimeFreshnessDays
          ? 'stale'
          : 'fresh';
    const calculationSafeReorderDate = asString(params.calculation.restockDeadlineImproved);
    const calculationOosDate = asString(params.calculation.oosDate);
    const derivedSafeReorderDate =
      !calculationSafeReorderDate && typeof leadTimeDays === 'number' && calculationOosDate
        ? addDays(
            calculationOosDate,
            -(
              leadTimeDays +
              (asNumber(params.calculation.safetyBufferDays) ?? DEFAULT_PLANNING_SETTINGS.safetyBufferDays)
            ),
          )
        : undefined;
    const latestSafeReorderDate = calculationSafeReorderDate ?? derivedSafeReorderDate;
    const daysUntilSafeReorder = latestSafeReorderDate
      ? diffDays(latestSafeReorderDate, params.calculationDate)
      : undefined;
    const suggestedReorderQty = this.suggestedReorderQuantity({
      salesVelocity,
      leadTimeDays,
      targetCoverDays: params.targetCoverDays,
      currentPlanningStock: stockBuckets.currentPlanningStock,
      openOrderCoverageQty,
    });
    const actionStatus = this.actionStatus({
      excluded,
      salesVelocity,
      leadTimeFreshness,
      daysUntilSafeReorder,
      orderSoonWindowDays: params.orderSoonWindowDays,
      openOrderCoverageQty,
    });
    const supplierName =
      asString(supplier.displayName) ??
      asString(leadTime.supplierName) ??
      asString(latestParameter.supplier) ??
      asString(orderHistorySupplier.supplierName);
    const calculationDaysOfCover = asNumber(params.calculation.daysOfCover);
    const tier = isProfitTier(calculationTier) ? calculationTier : fallbackTier.tier;
    const calculatedProfitRisk = asNumber(params.calculation.estimatedProfitRisk);
    const estimatedProfitRisk = isProfitTier(tier) ? calculatedProfitRisk ?? 0 : 0;
    const estimatedProfitRiskBasis = !isProfitTier(tier)
      ? 'not_tiered_profit_inputs_missing'
      : typeof calculatedProfitRisk === 'number'
        ? 'planning_calculation_estimated_profit_risk'
        : 'not_available';

    return {
      planningProductId,
      company,
      asin,
      sku,
      title: asString(params.product.title),
      brand: payloadString(latestParameter, ['Brand', 'brand']),
      productStatus,
      planningExcluded: excluded,
      tier,
      tierScore: asNumber(params.calculation.tierScore) ?? fallbackTier.tierScore,
      currentTier: asString(params.calculation.currentTier),
      currentTierScore: asNumber(params.calculation.currentTierScore),
      averageTier: asString(params.calculation.averageTier),
      averageTierScore: asNumber(params.calculation.averageTierScore),
      bestTier: asString(params.calculation.bestTier),
      bestTierScore: asNumber(params.calculation.bestTierScore),
      lastMonthQty: asNumber(params.calculation.lastMonthQty),
      sixMonthAverageQty: asNumber(params.calculation.sixMonthAverageQty),
      sixMonthWorstQty: asNumber(params.calculation.sixMonthWorstQty),
      sixMonthBestQty: asNumber(params.calculation.sixMonthBestQty),
      sixMonthMargin: asNumber(params.calculation.sixMonthMargin),
      profitPerUnit: asNumber(params.calculation.profitPerUnit),
      recommendedBestQty: asNumber(params.calculation.recommendedBestQty),
      salesVelocity,
      currentPlanningStock: stockBuckets.currentPlanningStock,
      sellableStock: stockBuckets.sellableStock,
      pipelineStock: stockBuckets.pipelineStock,
      reservedStock: stockBuckets.reservedStock,
      inboundStock: stockBuckets.inboundStock,
      orderedStock: stockBuckets.orderedStock,
      prepStock: stockBuckets.prepStock,
      awdStock: stockBuckets.awdStock,
      stuck: typeof calculationDaysOfCover === 'number' && calculationDaysOfCover > 60,
      daysOfCover: calculationDaysOfCover,
      estimatedOosDate: asString(params.calculation.oosDate),
      latestSafeReorderDate,
      daysUntilSafeReorder,
      actionStatus,
      suggestedReorderQty,
      safetyBufferDays: asNumber(params.calculation.safetyBufferDays) ?? DEFAULT_PLANNING_SETTINGS.safetyBufferDays,
      reorderCycleDays: params.reorderCycleDays,
      targetCoverDays: params.targetCoverDays,
      orderSoonWindowDays: params.orderSoonWindowDays,
      leadTimeFreshnessDays: params.leadTimeFreshnessDays,
      purchasedPipelineGraceDays: params.purchasedPipelineGraceDays,
      supplierId:
        asString(supplier.id) ?? asString(latestParameter.supplierId) ?? asString(orderHistorySupplier.supplierId),
      supplierName,
      supplierSource: asString(orderHistorySupplier.supplierName) ? 'order_details_history' : 'silver_supplier_product',
      supplierRole: asString(orderHistorySupplier.supplierName)
        ? 'latest_order_history'
        : 'latest_silver_supplier_product',
      supplierConfidence: asString(orderHistorySupplier.supplierName) ? 'medium' : 'medium',
      leadTimeDays,
      leadTimeConfirmedAt,
      leadTimeFreshness,
      leadTimeSource: supplierName ? 'supplier_or_planning_parameter' : 'planning_parameter_without_supplier_mapping',
      openOrderCoverageQty,
      ...supplierOrderState,
      expectedSellableDate:
        asString(supplierOrderState.expectedSellableDate) ??
        (asString(supplierOrderState.supplierOrderRef) ? undefined : this.earliestExpectedSellableDate(orderLines)),
      estimatedProfitRisk,
      estimatedProfitRiskBasis,
      monthToDateRevenue: payloadNumber(latestInventory, [
        'MTD Revenue ',
        'MTD Revenue',
        'mtdRevenue',
        'monthToDateRevenue',
      ]),
      monthToDateUnitsSold: payloadNumber(latestInventory, [
        'MTD Unit Sold',
        'MTD Units Sold',
        'mtdUnitSold',
        'monthToDateUnitsSold',
      ]),
      monthToDateProfit:
        payloadNumber(latestInventory, ['MTD Profit ', 'MTD Profit', 'mtdProfit', 'monthToDateProfit']) ??
        asNumber(params.calculation.achievedProfitMtd),
      digestPriority: this.digestPriority(actionStatus, tier),
      evidence: {
        calculation: params.calculation.evidence,
        productStatusSource: productStatus === 'Active' ? 'default' : 'backend_sheet_or_import_payload',
        leadTimeAgeDays,
        supplierLink,
        stockBuckets,
        planningSettings: {
          safetyBufferDays: asNumber(params.calculation.safetyBufferDays) ?? DEFAULT_PLANNING_SETTINGS.safetyBufferDays,
          reorderCycleDays: params.reorderCycleDays,
          targetCoverDays: params.targetCoverDays,
          orderSoonWindowDays: params.orderSoonWindowDays,
          leadTimeFreshnessDays: params.leadTimeFreshnessDays,
          purchasedPipelineGraceDays: params.purchasedPipelineGraceDays,
        },
        suggestedReorderQuantityFormula:
          'max((velocity * targetCoverDays) - totalPlanningStock - openOrderCoverageQty, 0)',
        estimatedProfitRiskBasis,
      },
    };
  }

  private stockBuckets(inventory: PlainRecord, calculation: PlainRecord) {
    const sellableStock = asNumber(inventory.stock) ?? asNumber(calculation.sellableStock) ?? 0;
    const reservedStock = asNumber(inventory.reserved) ?? 0;
    const inboundStock = asNumber(inventory.inbound) ?? 0;
    const orderedStock = asNumber(inventory.ordered) ?? 0;
    const prepStock =
      asNumber(inventory.prepStock) ??
      payloadNumber(inventory, ['Prep Stock', 'Prep Center Stock', 'FBA prep. stock Prep center 1 stock']) ??
      0;
    const awdStock = payloadNumber(inventory, ['AWD Stock', 'awdStock']) ?? 0;
    const pipelineStock = inboundStock + orderedStock + prepStock + awdStock;
    return {
      sellableStock,
      reservedStock,
      inboundStock,
      orderedStock,
      prepStock,
      awdStock,
      pipelineStock,
      currentPlanningStock: sellableStock + reservedStock + pipelineStock,
    };
  }

  private async activeSourceConnectionIds() {
    return new Set(
      (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({}))
        .map(toPlainRecord)
        .filter((connection) => asBoolean(connection.active) !== false)
        .map((connection) => asString(connection.id))
        .filter((id): id is string => Boolean(id)),
    );
  }

  private async sellerboardSourceConnectionIds() {
    return new Set(
      (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({}))
        .map(toPlainRecord)
        .filter(
          (connection) => asString(connection.sourceType) === 'sellerboard' && asBoolean(connection.active) !== false,
        )
        .map((connection) => asString(connection.id))
        .filter((id): id is string => Boolean(id)),
    );
  }

  private async sourceConnectionCompanies() {
    const connections = (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({}))
      .map(toPlainRecord)
      .filter((connection) => asBoolean(connection.active) !== false);
    const companyRows = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({})).map(toPlainRecord);
    const companyNamesById = new Map(
      companyRows
        .map((company) => [asString(company.id), asString(company.name)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const companies = new Map<string, string>();
    for (const connection of connections) {
      const id = asString(connection.id);
      const label = companyLabelFromSourceConnection(connection, companyNamesById);
      if (id && label) {
        companies.set(id, label);
      }
    }
    return companies;
  }

  private async findFallbackRecords(
    collection: string,
    params: {
      company?: string;
      sourceConnectionCompanies: Map<string, string>;
      activeSourceConnectionIds: Set<string>;
      sort?: string[];
      limit?: number;
    },
  ) {
    const repository = this.db.getRepository(collection);
    const limit = params.limit ?? FALLBACK_RECORD_LIMIT;
    if (!params.company) {
      return (await repository.find({ ...(params.sort ? { sort: params.sort } : {}), ...(limit ? { limit } : {}) }))
        .map(toPlainRecord)
        .filter((record) => this.recordUsesActiveSource(record, params.activeSourceConnectionIds));
    }

    const matchingSourceConnectionIds = [...params.sourceConnectionCompanies.entries()]
      .filter(([, company]) => company === params.company)
      .map(([id]) => id);
    const records = new Map<string, PlainRecord>();
    const addRecords = async (filter: PlainRecord) => {
      const found = (
        await repository.find({ filter, ...(params.sort ? { sort: params.sort } : {}), ...(limit ? { limit } : {}) })
      )
        .map(toPlainRecord)
        .filter((record) => this.recordUsesActiveSource(record, params.activeSourceConnectionIds));
      for (const record of found) {
        const key =
          asString(record.id) ??
          this.fallbackProductKey(record, params.sourceConnectionCompanies) ??
          JSON.stringify(record);
        records.set(key, record);
      }
    };

    await addRecords({ company: params.company });
    for (const sourceConnectionId of matchingSourceConnectionIds) {
      await addRecords({ sourceConnectionId });
    }
    return [...records.values()].slice(0, limit ?? records.size);
  }

  private recordUsesActiveSource(record: PlainRecord, activeSourceConnectionIds: Set<string>) {
    const sourceConnectionId = asString(record.sourceConnectionId);
    return !sourceConnectionId || activeSourceConnectionIds.has(sourceConnectionId);
  }

  private async findSupplier(parameter: PlainRecord) {
    const supplierRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers);
    const supplierId = asString(parameter.supplierId);
    const byId = supplierId ? toPlainRecord(await supplierRepo.findOne({ filterByTk: supplierId })) : {};
    if (asString(byId.id)) return byId;
    const supplierName = asString(parameter.supplier) ?? asString(parameter.supplierName);
    return supplierName ? toPlainRecord(await supplierRepo.findOne({ filter: { displayName: supplierName } })) : {};
  }

  private async supplierOrderStateForProduct(params: {
    company?: string;
    asin?: string;
    sku?: string;
    calculationDate?: string;
    purchasedPipelineGraceDays?: number;
    statusRules: SupplierOrderStatusRules;
  }) {
    const lines = await this.findOrderLinesByProduct(params);
    return summarizeSupplierOrderState(
      lines,
      await this.supplierOrdersByLine(lines),
      params.calculationDate,
      params.purchasedPipelineGraceDays ?? DEFAULT_PLANNING_SETTINGS.purchasedPipelineGraceDays,
      params.statusRules,
    );
  }

  private async supplierOrdersByLine(lines: PlainRecord[]) {
    const company = [...new Set(lines.map((line) => asString(line.company)).filter(Boolean))][0];
    const silverOrders = await silverSupplierOrderReadModel(this.db, { company, limit: 10000 });
    return new Map(
      silverOrders.supplierOrders
        .map((order) => [asString(order.id), order] as const)
        .filter((entry): entry is [string, PlainRecord] => Boolean(entry[0])),
    );
  }

  private async withActivityAuthors(activities: PlainRecord[]) {
    const userIds = [
      ...new Set(activities.map((activity) => asRecordIdString(activity.actorUserId)).filter(Boolean) as string[]),
    ];
    if (userIds.length === 0) return activities;

    let users: PlainRecord[];
    try {
      users = (
        await this.db
          .getRepository('users')
          .find({ filter: { id: { $in: userIds.map(asRecordIdFilterValue) } }, limit: userIds.length })
      ).map(toPlainRecord);
    } catch {
      return activities;
    }

    const usersById = new Map(users.map((user) => [asRecordIdString(user.id), user]));
    return activities.map((activity) => {
      const user = usersById.get(asRecordIdString(activity.actorUserId) ?? '');
      const actorDisplayName = user ? displayNameForUser(user) : undefined;
      return actorDisplayName ? { ...activity, actorDisplayName, actorEmail: asString(user?.email) } : activity;
    });
  }

  private async withLatestSupplierOrderActivity(rows: PlainRecord[]) {
    const activityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    const silverOrders = await silverSupplierOrderReadModel(this.db, { limit: 10000 });
    const orderCache = new Map(
      silverOrders.supplierOrders
        .map((order): [string, PlainRecord] => [
          `${asString(order.company) ?? ''}:${asString(order.externalOrderRef) ?? asString(order.id) ?? ''}`,
          order,
        ])
        .filter(([key]) => !key.endsWith(':')),
    );
    const result: PlainRecord[] = [];
    for (const row of rows) {
      const company = asString(row.company);
      const ref = asString(row.supplierOrderRef);
      if (!company || !ref) {
        result.push(row);
        continue;
      }
      const cacheKey = `${company}:${ref}`;
      const order = orderCache.get(cacheKey) ?? {};
      const supplierOrderId = asString(order.id);
      const latestActivity = supplierOrderId
        ? (
            await this.withActivityAuthors([
              (await activityRepo.find({ limit: 1000 }))
                .map(toPlainRecord)
                .filter(
                  (activity) =>
                    !asString(activity.deletedAt) &&
                    ((asString(activity.entityType) === 'supplier_order' &&
                      asString(activity.entityId) === supplierOrderId) ||
                      asString(activity.supplierOrderId) === supplierOrderId),
                )
                .sort((left, right) =>
                  String(
                    toPlainRecord(right.contextSnapshotJson).occurredAt ??
                      right.occurredAt ??
                      right.createdAt ??
                      right.updatedAt ??
                      '',
                  ).localeCompare(
                    String(
                      toPlainRecord(left.contextSnapshotJson).occurredAt ??
                        left.occurredAt ??
                        left.createdAt ??
                        left.updatedAt ??
                        '',
                    ),
                  ),
                )[0] ?? {},
            ])
          )[0] ?? {}
        : {};
      const activityContext = toPlainRecord(latestActivity.contextSnapshotJson);
      const fallbackActivityAt =
        activityContext.occurredAt ??
        latestActivity.occurredAt ??
        latestActivity.createdAt ??
        latestActivity.updatedAt ??
        order.lastMeaningfulUpdateAt ??
        order.statusUpdatedAt ??
        order.orderDate ??
        order.updatedAt;
      const fallbackActivityNote = asString(order.status) ? `Order status ${asString(order.status)}` : undefined;
      result.push({
        ...row,
        supplierOrderId,
        latestSupplierOrderActivityType:
          asString(latestActivity.commentType) ?? asString(latestActivity.activityType) ?? 'order_status',
        latestSupplierOrderActivityAt: fallbackActivityAt ? sortableDateValue(fallbackActivityAt) : undefined,
        latestSupplierOrderActivityNote:
          asString(latestActivity.body) ?? asString(latestActivity.notes) ?? fallbackActivityNote,
        latestSupplierOrderActivityActor: asString(activityContext.actor) ?? asString(latestActivity.actor),
        latestSupplierOrderActivityActorDisplayName: asString(latestActivity.actorDisplayName),
        latestSupplierOrderActivityActorEmail: asString(latestActivity.actorEmail),
        latestSupplierOrderActivitySource: asString(activityContext.source),
      });
    }
    return result;
  }

  private leadTimeFromOrderHistory(
    orderLines: PlainRecord[],
    supplierOrderById: Map<string, PlainRecord>,
  ): { leadTimeDays?: number; confirmedAt?: string; sourceOrderLineRef?: string } {
    const candidates = orderLines
      .map((line) => {
        const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '') ?? {};
        const start = optionalIsoDate(order.orderDate) ?? optionalIsoDate(line.observedAt);
        const end =
          optionalIsoDate(line.expectedSellableDate) ??
          optionalIsoDate(line.expectedDeliveryDate) ??
          optionalIsoDate(order.expectedDeliveryDate);
        const leadTimeDays = start && end ? diffDays(end, start) : undefined;
        return {
          leadTimeDays,
          confirmedAt: optionalIsoDate(line.observedAt) ?? optionalIsoDate(order.orderDate),
          sourceOrderLineRef: asString(line.sourceOrderLineRef),
        };
      })
      .filter(
        (candidate) =>
          typeof candidate.leadTimeDays === 'number' && candidate.leadTimeDays >= 0 && candidate.leadTimeDays <= 999,
      )
      .sort((left, right) => String(right.confirmedAt ?? '').localeCompare(String(left.confirmedAt ?? '')));
    return candidates[0] ?? {};
  }

  private async earliestFallbackExpectedSellableDate(params: { company?: string; asin?: string; sku?: string }) {
    const lines = await this.findOrderLinesByProduct(params);
    return this.earliestExpectedSellableDate(lines);
  }

  private async findOrderLinesByProduct(params: { company?: string; asin?: string; sku?: string }) {
    const lines = (await silverSupplierOrderReadModel(this.db, { company: params.company, limit: 10000 }))
      .supplierOrderLines;
    const byId = new Map<string, PlainRecord>();
    for (const line of lines) {
      const lineAsin = asString(line.asin);
      const lineSku = asString(line.sku);
      if (params.asin && lineAsin && lineAsin !== params.asin) continue;
      if (!params.asin && params.sku && lineSku !== params.sku) continue;
      if (params.asin || (params.sku && lineSku === params.sku)) {
        const id =
          asString(line.id) ?? `${asString(line.supplierOrderId) ?? ''}:${asString(line.sourceOrderLineRef) ?? ''}`;
        byId.set(id, line);
      }
    }
    return [...byId.values()];
  }

  private async findOrderHistorySupplier(params: { company?: string; asin?: string; sku?: string }) {
    const lines = await this.findOrderLinesByProduct(params);
    const latestLine = latestByDate(lines, 'observedAt') ?? latestByDate(lines, 'expectedDeliveryDate') ?? lines[0];
    const supplierId = asString(latestLine?.supplierId);
    if (!supplierId) return {};
    return {
      supplierId,
      supplierName:
        asString(latestLine.supplierName) ?? payloadString(latestLine, ['Supplier', 'Supplier Name', 'supplierName']),
      evidence: {
        source: 'silver_order_lines',
        sourceOrderLineRef: asString(latestLine.sourceOrderLineRef),
        observedAt: asString(latestLine.observedAt),
      },
    };
  }

  private suggestedReorderQuantity(params: {
    salesVelocity?: number;
    leadTimeDays?: number;
    targetCoverDays: number;
    currentPlanningStock: number;
    openOrderCoverageQty: number;
  }) {
    if (!params.salesVelocity || params.salesVelocity <= 0 || typeof params.leadTimeDays !== 'number') {
      return 0;
    }
    const neededUnits = params.salesVelocity * params.targetCoverDays;
    return Math.max(Math.ceil(neededUnits - params.currentPlanningStock - params.openOrderCoverageQty), 0);
  }

  private actionStatus(params: {
    excluded: boolean;
    salesVelocity?: number;
    leadTimeFreshness: string;
    daysUntilSafeReorder?: number;
    orderSoonWindowDays: number;
    openOrderCoverageQty: number;
  }): InventoryPlanningActionStatus {
    if (params.excluded) return 'excluded';
    if (!params.salesVelocity || params.salesVelocity <= 0) return 'missing_velocity';
    if (params.leadTimeFreshness === 'missing') return 'missing_lead_time';
    if (params.leadTimeFreshness === 'stale') return 'stale_lead_time';
    if (typeof params.daysUntilSafeReorder !== 'number') return 'missing_lead_time';
    if (params.openOrderCoverageQty > 0 && params.daysUntilSafeReorder <= params.orderSoonWindowDays)
      return 'already_ordered';
    if (params.daysUntilSafeReorder < 0) return 'overdue';
    if (params.daysUntilSafeReorder === 0) return 'order_today';
    if (params.daysUntilSafeReorder <= params.orderSoonWindowDays) return 'order_soon';
    return params.daysUntilSafeReorder <= params.orderSoonWindowDays * 2 ? 'watch' : 'sufficient_stock';
  }

  private earliestExpectedSellableDate(orderLines: PlainRecord[]) {
    return orderLines
      .map((line) => asString(line.expectedSellableDate))
      .filter(Boolean)
      .sort()[0];
  }

  private digestPriority(actionStatus: InventoryPlanningActionStatus, tier: unknown) {
    return profitTierRank(tier) * 100 + actionRank(actionStatus) * 10;
  }

  private sortDigestRows(rows: PlainRecord[]) {
    return [...rows].sort((left, right) => {
      const priority =
        (asNumber(left.digestPriority) ??
          this.digestPriority(left.actionStatus as InventoryPlanningActionStatus, left.tier)) -
        (asNumber(right.digestPriority) ??
          this.digestPriority(right.actionStatus as InventoryPlanningActionStatus, right.tier));
      if (priority !== 0) return priority;
      const orderState = digestOrderStateRank(left) - digestOrderStateRank(right);
      if (orderState !== 0) return orderState;
      const risk = (asNumber(right.estimatedProfitRisk) ?? 0) - (asNumber(left.estimatedProfitRisk) ?? 0);
      if (risk !== 0) return risk;
      return (asNumber(right.suggestedReorderQty) ?? 0) - (asNumber(left.suggestedReorderQty) ?? 0);
    });
  }

  private rankSuppliers(rows: PlainRecord[]) {
    const bySupplier = new Map<
      string,
      {
        supplierName: string;
        urgentCount: number;
        tierA: number;
        tierB: number;
        tierC: number;
        estimatedProfitRisk: number;
      }
    >();
    for (const row of rows) {
      const supplierName = asString(row.supplierName);
      if (!supplierName) continue;
      const existing = bySupplier.get(supplierName) ?? {
        supplierName,
        urgentCount: 0,
        tierA: 0,
        tierB: 0,
        tierC: 0,
        estimatedProfitRisk: 0,
      };
      existing.urgentCount += 1;
      existing.tierA += row.tier === 'A' ? 1 : 0;
      existing.tierB += row.tier === 'B' ? 1 : 0;
      existing.tierC += row.tier === 'C' ? 1 : 0;
      existing.estimatedProfitRisk += asNumber(row.estimatedProfitRisk) ?? 0;
      bySupplier.set(supplierName, existing);
    }
    return [...bySupplier.values()].sort((left, right) => {
      if (right.estimatedProfitRisk !== left.estimatedProfitRisk)
        return right.estimatedProfitRisk - left.estimatedProfitRisk;
      if (right.tierA !== left.tierA) return right.tierA - left.tierA;
      if (right.tierB !== left.tierB) return right.tierB - left.tierB;
      if (right.tierC !== left.tierC) return right.tierC - left.tierC;
      return right.urgentCount - left.urgentCount;
    });
  }
}
