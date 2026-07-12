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
import {
  silverOrderStatus,
  silverSupplierOrderReadModel,
} from '../../supplier-management/server/silver-supplier-order-read-model';
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
import { summarizeHistoricalProductFacts } from './historical-product-metrics';
import { latestPreferredInventorySnapshot } from './order-receipt-evidence';

const GOLD_SOURCE_RECORD_LIMIT = 100000;
const TIER_RULE_VERSION = 'rolling_30d_min_4_v1';
const MINIMUM_TIER_UNITS_30_DAYS = 4;
const DEFAULT_SUPPLIER_LEAD_TIME_DAYS = 30;
export type InventoryPlanningActionStatus =
  | 'excluded'
  | 'missing_inventory'
  | 'missing_velocity'
  | 'no_sell_through'
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

export type InventoryCommandCenterPane =
  | 'supplyAction'
  | 'missingSupplier'
  | 'activeOrders'
  | 'stuckInventory'
  | 'duplicateProducts';

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

const COMMAND_CENTER_PANES: InventoryCommandCenterPane[] = [
  'supplyAction',
  'missingSupplier',
  'activeOrders',
  'stuckInventory',
  'duplicateProducts',
];

const COMMAND_CENTER_SORT_KEYS = new Set([
  'actionStatus',
  'asin',
  'daysOfCover',
  'daysUntilOos',
  'daysUntilSafeReorder',
  'estimatedProfitRisk',
  'currentPlanningStock',
  'familyCurrentPlanningStock',
  'familyDaysOfCover',
  'familyStuckAffectedValue',
  'expectedArrivalDate',
  'sku',
  'stockoutGapDays',
  'suggestedReorderQty',
  'supplierName',
  'tier',
  'title',
  'duplicatePrimarySku',
]);

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
  const expectedArrivalDate = optionalIsoDate(asString(row.expectedArrivalDate) ?? '');
  return estimatedOosDate && expectedArrivalDate ? diffDays(expectedArrivalDate, estimatedOosDate) : undefined;
}

export function calculateInventoryMoneyRisk(row: PlainRecord) {
  const salesVelocity = asNumber(row.salesVelocity);
  const profitPerUnit = asNumber(row.profitPerUnit);
  const daysOfCover = asNumber(row.daysOfCover);
  const targetCoverDays = asNumber(row.targetCoverDays);
  const missingInputs = [
    !(typeof salesVelocity === 'number' && salesVelocity > 0) ? 'trusted_velocity' : undefined,
    typeof profitPerUnit !== 'number' ? 'profit_per_unit' : undefined,
    typeof daysOfCover !== 'number' ? 'days_of_cover' : undefined,
    typeof targetCoverDays !== 'number' ? 'target_cover_days' : undefined,
  ].filter((value): value is string => Boolean(value));
  const inputs = {
    salesVelocity,
    profitPerUnit,
    daysOfCover,
    targetCoverDays,
    openOrderCoverageQty: asNumber(row.openOrderCoverageQty) ?? 0,
    stockoutGapDays: stockoutGapDays(row),
  };
  if (missingInputs.length > 0) {
    return {
      estimatedProfitRisk: undefined,
      estimatedProfitRiskBasis: 'uncovered_stockout_days_x_trusted_daily_velocity_x_profit_per_unit',
      moneyRiskStatus: 'unknown_missing_inputs',
      moneyRiskUncoveredDays: undefined,
      moneyRiskInputs: { ...inputs, missingInputs },
    };
  }

  const activeOrder = ['purchased_pipeline', 'placed_not_purchased'].includes(asString(row.supplierOrderState) ?? '');
  if (activeOrder && (!asString(row.expectedArrivalDate) || asString(row.expectedArrivalStatus) === 'unknown')) {
    return {
      estimatedProfitRisk: undefined,
      estimatedProfitRiskBasis: 'uncovered_stockout_days_x_trusted_daily_velocity_x_profit_per_unit',
      moneyRiskStatus: 'unknown_arrival',
      moneyRiskUncoveredDays: undefined,
      moneyRiskInputs: { ...inputs, missingInputs: ['expected_arrival'] },
    };
  }

  const coverageDays = (asNumber(row.openOrderCoverageQty) ?? 0) / (salesVelocity as number);
  const coverageShortfallDays = Math.max((targetCoverDays as number) - (daysOfCover as number) - coverageDays, 0);
  const timingGapDays = activeOrder ? Math.max(stockoutGapDays(row) ?? 0, 0) : 0;
  const uncoveredDays = Math.max(coverageShortfallDays, timingGapDays);
  const rawProfitRisk = uncoveredDays * (salesVelocity as number) * Math.max(profitPerUnit as number, 0);
  const estimatedProfitRisk = Math.round((rawProfitRisk + Math.sign(rawProfitRisk) * 1e-9) * 100) / 100;
  return {
    estimatedProfitRisk,
    estimatedProfitRiskBasis: 'uncovered_stockout_days_x_trusted_daily_velocity_x_profit_per_unit',
    moneyRiskStatus: estimatedProfitRisk > 0 ? 'resolved_positive' : 'resolved_zero',
    moneyRiskUncoveredDays: uncoveredDays,
    moneyRiskInputs: { ...inputs, coverageShortfallDays, timingGapDays, missingInputs: [] },
  };
}

function pipelineHealthStatus(row: PlainRecord, calculationDate: string) {
  const state = asString(row.supplierOrderState);
  if (state === 'placed_not_purchased') return 'placed_not_purchased';
  if (state !== 'purchased_pipeline') return 'none';
  if (asString(row.expectedArrivalStatus) === 'unknown') return 'unknown_timing';
  const gap = stockoutGapDays(row);
  if (typeof gap === 'number' && gap > 0) return 'late';
  const daysUntilExpectedArrival = daysUntilDate(row.expectedArrivalDate, calculationDate);
  if (typeof daysUntilExpectedArrival === 'number' && daysUntilExpectedArrival < 0) return 'late';
  return typeof daysUntilExpectedArrival === 'number' ? 'on_track' : 'unknown_timing';
}

function stuckClassification(row: PlainRecord, calculationDate?: string) {
  const currentStock = asNumber(row.currentPlanningStock) ?? 0;
  if (currentStock <= 0) return 'none';
  const live = ['active', 'live'].includes(asString(row.productStatus)?.toLowerCase() ?? '');
  const excluded = asString(row.actionStatus) === 'excluded' || asBoolean(row.planningExcluded) === true;
  if (!live || excluded) return 'none';
  const velocityStatus = asString(row.salesVelocityStatus);
  if (velocityStatus === 'missing') return 'insufficient_velocity_data';
  const trustedRollingVelocity = asString(row.salesVelocityBasis) === 'historical_rolling_30_days';
  const salesVelocity = asNumber(row.salesVelocity) ?? 0;
  const referenceDate = calculationDate ? isoDate(calculationDate) : undefined;
  const expectedArrivalDate = optionalIsoDate(asString(row.expectedArrivalDate) ?? '');
  const latestActivityAt = optionalIsoDate(asString(row.latestSupplierOrderActivityAt) ?? '');
  const graceDays = asNumber(row.purchasedPipelineGraceDays) ?? 30;
  const stalled = Boolean(
    referenceDate &&
      ((expectedArrivalDate && diffDays(referenceDate, expectedArrivalDate) > 0) ||
        (latestActivityAt && diffDays(referenceDate, latestActivityAt) > graceDays)),
  );
  if ((asNumber(row.reservedStock) ?? 0) > 0 && stalled) return 'reserved_stalled';
  if ((asNumber(row.pipelineStock) ?? 0) > 0 && stalled) return 'pipeline_stalled';
  if (velocityStatus === 'trusted_zero' && trustedRollingVelocity && salesVelocity <= 0) {
    return 'no_sell_through_with_stock';
  }
  if (velocityStatus !== 'trusted_positive' || !trustedRollingVelocity || salesVelocity <= 0) {
    return 'untrusted_velocity_data';
  }
  const daysOfCover = asNumber(row.daysOfCover) ?? 0;
  if (daysOfCover > 60) return 'over_60_doc';
  if (daysOfCover > 30) {
    const lastMonthQty = asNumber(row.lastMonthQty);
    const averageQty = asNumber(row.sixMonthAverageQty);
    return typeof lastMonthQty === 'number' && typeof averageQty === 'number' && lastMonthQty < averageQty
      ? 'declining_velocity_watch'
      : 'over_30_doc_watch';
  }
  return 'none';
}

function leadTimeNeedsReview(value: unknown) {
  return ['missing', 'stale'].includes(asString(value) ?? '');
}

function recommendedInventoryAction(row: PlainRecord) {
  const actionStatus = asString(row.actionStatus);
  if (asBoolean(row.familyStuckAction) === true) return 'review_stuck_inventory';
  if (!asString(row.supplierName)) return 'recover_supplier';
  if (leadTimeNeedsReview(row.leadTimeFreshness)) return 'confirm_lead_time';
  if (row.supplierOrderState === 'placed_not_purchased') return 'purchase_order';
  if (row.supplierOrderState === 'purchased_pipeline') return 'follow_up_order';
  if (['overdue', 'order_today', 'order_soon'].includes(String(actionStatus))) return 'create_order';
  if (asString(row.stuckClassification) !== 'none') return 'review_stuck_inventory';
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
    no_sell_through: 7,
    missing_inventory: 8,
    missing_velocity: 9,
    excluded: 10,
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
  if (status === 'watch' || status === 'missing_velocity' || status === 'no_sell_through') return 2;
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

function sortableDateValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function supplierOrderSortValue(line: PlainRecord, order: PlainRecord) {
  return sortableDateValue(
    order.lastMeaningfulUpdateAt ?? order.statusUpdatedAt ?? line.observedAt ?? order.orderDate ?? '',
  );
}

function validExpectedDate(value: unknown) {
  const date = asString(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}

function expectedArrivalEvidence(
  line: PlainRecord,
  order: PlainRecord,
  calculationDate: string | undefined,
  receivingBufferDays: number,
) {
  const imported = [
    { date: line.expectedArrivalDate, source: line.expectedArrivalSource },
    { date: line.expectedSellableDate, source: 'silver_order_line.expectedSellableDate' },
    { date: line.expectedDeliveryDate, source: 'silver_order_line.expectedDeliveryDate' },
    { date: order.expectedArrivalDate, source: order.expectedArrivalSource },
    { date: order.expectedDeliveryDate, source: 'silver_order.expectedDeliveryDate' },
  ].find((candidate) => validExpectedDate(candidate.date));
  const importedDate = validExpectedDate(imported?.date);
  if (importedDate) {
    return {
      expectedArrivalDate: importedDate,
      expectedArrivalStatus: 'imported',
      expectedArrivalSource: asString(imported?.source) ?? 'silver_order',
      expectedArrivalAsOf:
        validExpectedDate(line.expectedArrivalAsOf) ??
        validExpectedDate(order.expectedArrivalAsOf) ??
        validExpectedDate(order.orderDate),
      expectedArrivalConfidence: 'authoritative',
      expectedArrivalFreshness:
        calculationDate && importedDate < calculationDate ? 'stale' : calculationDate ? 'fresh' : 'unknown',
    };
  }
  const orderDate = validExpectedDate(order.orderDate);
  const leadTimeDays = asNumber(line.leadTimeDays);
  if (orderDate && typeof leadTimeDays === 'number' && leadTimeDays >= 0) {
    const expectedArrivalDate = addDays(orderDate, leadTimeDays + receivingBufferDays);
    return {
      expectedArrivalDate,
      expectedArrivalStatus: 'derived',
      expectedArrivalSource: 'silver_order.orderDate_plus_supplier_lead_time_plus_receiving_buffer',
      expectedArrivalAsOf: calculationDate,
      expectedArrivalConfidence: 'estimated',
      expectedArrivalFreshness:
        calculationDate && expectedArrivalDate < calculationDate ? 'stale' : calculationDate ? 'fresh' : 'unknown',
    };
  }
  return {
    expectedArrivalStatus: 'unknown',
    expectedArrivalSource: 'insufficient_silver_evidence',
    expectedArrivalAsOf: calculationDate,
    expectedArrivalConfidence: 'none',
    expectedArrivalFreshness: 'unknown',
  };
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
  const resolvedLines = lines.map((line) => {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    return order
      ? { ...line, ...expectedArrivalEvidence(line, order, calculationDate, purchasedPipelineGraceDays) }
      : line;
  });

  for (const line of resolvedLines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order, rules);
    const openQty = Math.max((asNumber(line.orderedQty) ?? 0) - (asNumber(line.receivedQty) ?? 0), 0);
    const sortValue = supplierOrderSortValue(line, order);
    if (!historySelected || sortValue > historySelected.sortValue) historySelected = { line, order, sortValue };
    if (openQty <= 0 || !isPlacedNotPurchasedSupplierOrderStatus(status, rules)) continue;
    placedNotPurchasedOpenQty += openQty;
    if (!latestPlaced || sortValue > latestPlaced.sortValue) latestPlaced = { line, order, sortValue };
  }

  for (const line of resolvedLines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order, rules);
    const openQty = Math.max((asNumber(line.orderedQty) ?? 0) - (asNumber(line.receivedQty) ?? 0), 0);
    if (openQty <= 0 || !isActivePurchasedPipelineStatus(status, rules)) continue;
    const sortValue = supplierOrderSortValue(line, order);
    const newerRecoveryCycleStarted = latestPlaced && latestPlaced.sortValue > sortValue;
    if (newerRecoveryCycleStarted) continue;
    purchasedOpenQty += openQty;
    if (!latestPurchased || sortValue > latestPurchased.sortValue) latestPurchased = { line, order, sortValue };
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
        : historySelected;
  const currentOpenQty = purchasedOpenQty > 0 ? purchasedOpenQty : placedNotPurchasedOpenQty;
  const referenceOpenQty = reference
    ? Math.max((asNumber(reference.line.orderedQty) ?? 0) - (asNumber(reference.line.receivedQty) ?? 0), 0)
    : 0;
  return {
    supplierOrderState: state,
    supplierOrderId: asString(reference?.order.id),
    supplierOrderStatus: reference?.order ? supplierCoverageStatus(reference.order, rules) : undefined,
    supplierOrderRef: asString(reference?.order.externalOrderRef) ?? asString(reference?.order.id),
    supplierOrderAuthorityStatus: asString(reference?.order.authorityStatus),
    supplierOrderAuthoritySource: asString(reference?.order.authoritySource) ?? asString(reference?.order.statusSource),
    supplierOrderAuthorityTaskRef: asString(reference?.order.authorityTaskRef),
    supplierOrderAuthorityAsOf: asString(reference?.order.authorityAsOf) ?? asString(reference?.order.updatedAt),
    supplierOrderAuthorityEvidence: toPlainRecord(reference?.order.authorityEvidenceJson),
    supplierOrderSortValue: reference?.sortValue,
    expectedArrivalDate: asString(reference?.line.expectedArrivalDate),
    expectedArrivalStatus: asString(reference?.line.expectedArrivalStatus) ?? 'unknown',
    expectedArrivalSource: asString(reference?.line.expectedArrivalSource) ?? 'insufficient_silver_evidence',
    expectedArrivalAsOf: asString(reference?.line.expectedArrivalAsOf),
    expectedArrivalConfidence: asString(reference?.line.expectedArrivalConfidence) ?? 'none',
    expectedArrivalFreshness: asString(reference?.line.expectedArrivalFreshness) ?? 'unknown',
    supplierOrderOpenQty: currentOpenQty,
    supplierOrderReferenceOpenQty: referenceOpenQty,
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
    leadTimeNeedsReview(row.leadTimeFreshness) ||
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
  'companyProductId',
  'companyProductFamilyId',
  'familyMarketplace',
  'familyCanonicalAsin',
  'familyRole',
  'familyMemberCount',
  'replenishmentTargetCompanyProductId',
  'replenishmentTargetSku',
  'familyTier',
  'familyTierScore',
  'familyCurrentPlanningStock',
  'familySellableStock',
  'familyReservedStock',
  'familyPipelineStock',
  'familyInboundStock',
  'familyOrderedStock',
  'familyPrepStock',
  'familyAwdStock',
  'familySalesVelocity',
  'familyDaysOfCover',
  'familyEstimatedOosDate',
  'familyOpenOrderCoverageQty',
  'familySuggestedReorderQty',
  'familyPreferredSupplierId',
  'familyPreferredSupplierProductId',
  'familyPreferredSupplierName',
  'familyUnitCost',
  'familyLeadTimeDays',
  'familyEstimatedOrderCost',
  'familyStuck',
  'familyStuckAction',
  'familyStuckClassification',
  'familyStuckAffectedMemberCount',
  'familyStuckAffectedUnits',
  'familyStuckAffectedValue',
  'familyStuckActiveOrderCount',
  'familyStuckEvidence',
  'familyRollupEvidence',
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
  'recentUnits30',
  'tierEligibilityReason',
  'tierRuleVersion',
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
  'moneyRiskStatus',
  'moneyRiskUncoveredDays',
  'moneyRiskInputs',
  'unitCost',
  'unitCostSource',
  'supplierAvailability',
  'leadTimeAvailability',
  'unitCostAvailability',
  'profitAvailability',
  'estimatedOrderCost',
  'recommendedBestQty',
  'salesVelocity',
  'salesVelocityBasis',
  'salesVelocityStatus',
  'salesVelocityWindowStart',
  'salesVelocityWindowEnd',
  'salesVelocityAsOfDate',
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
  'supplierOrderId',
  'supplierOrderStatus',
  'supplierOrderRef',
  'supplierOrderAuthorityStatus',
  'supplierOrderAuthoritySource',
  'supplierOrderAuthorityTaskRef',
  'supplierOrderAuthorityAsOf',
  'supplierOrderAuthorityEvidence',
  'supplierOrderOpenQty',
  'supplierOrderReferenceOpenQty',
  'supplierOrderPurchasedOpenQty',
  'supplierOrderPlacedNotPurchasedOpenQty',
  'pipelineHealthStatus',
  'stockoutGapDays',
  'stuck',
  'stuckClassification',
  'commandCenterPane',
  'commandCenterPaneReason',
  'planningEligibilityStatus',
  'planningEligibilityReason',
  'dataQualityStatus',
  'dataQualityIssues',
  'inventoryAsOfDate',
  'sourceFreshnessStatus',
  'latestSupplierOrderActivityType',
  'latestSupplierOrderActivityAt',
  'latestSupplierOrderActivityNote',
  'latestSupplierOrderActivityActor',
  'latestSupplierOrderActivityActorUserId',
  'latestSupplierOrderActivityActorDisplayName',
  'latestSupplierOrderActivityActorEmail',
  'latestSupplierOrderActivitySource',
  'recommendedEscalation',
  'daysOfCover',
  'estimatedOosDate',
  'daysUntilOos',
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
  'expectedArrivalDate',
  'expectedArrivalStatus',
  'expectedArrivalSource',
  'expectedArrivalAsOf',
  'expectedArrivalConfidence',
  'expectedArrivalFreshness',
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
      throw new Error(`Ecobase inventory command center pane must be one of ${COMMAND_CENTER_PANES.join(', ')}.`);
    }
    if (query.sortBy && !COMMAND_CENTER_SORT_KEYS.has(query.sortBy)) {
      throw new Error(
        `Ecobase inventory command center sortBy must be one of ${[...COMMAND_CENTER_SORT_KEYS].sort().join(', ')}.`,
      );
    }

    const rows = await this.readGoldRows({ ...query, limit: undefined });
    const calculationDate = asString(rows[0]?.calculationDate) ?? isoDate(query.calculationDate ?? new Date());
    const targetCoverDays = asNumber(rows[0]?.targetCoverDays);
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
      macroRisk: this.commandCenterMacroRisk(rows),
      riskBars: this.commandCenterRiskBars(rows),
      panes: {
        supplyAction: this.commandCenterPanePayload('supplyAction', rows, query),
        missingSupplier: this.commandCenterPanePayload('missingSupplier', rows, query),
        activeOrders: this.commandCenterPanePayload('activeOrders', rows, query),
        stuckInventory: this.commandCenterPanePayload('stuckInventory', rows, query),
        duplicateProducts: this.commandCenterPanePayload('duplicateProducts', rows, query),
      },
      selectedRow: selectedRow
        ? {
            row: this.commandCenterDrawerRow(selectedRow),
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

    const [company] = (
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
        .find({ filter: { name: query.company }, limit: 1 })
    ).map(toPlainRecord);
    const companyId = asString(company?.id);
    const companyOrderRows = companyId
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverOrders)
            .find({ filter: { companyId }, sort: ['-orderDate'], limit: 5000 })
        ).map(toPlainRecord)
      : [];
    const supplierAccountRows = companyId
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts)
            .find({ filter: { companyId }, limit: 5000 })
        ).map(toPlainRecord)
      : [];
    const scopedSupplierIds = [
      ...new Set(
        [
          ...companyOrderRows.map((order) => asString(order.supplierId)),
          ...supplierAccountRows.map((account) => asString(account.supplierId)),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const suppliers = scopedSupplierIds.length
      ? (
          await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).find({
            filter: { id: { $in: scopedSupplierIds.map(asRecordIdFilterValue) } },
            sort: ['displayName'],
            limit: scopedSupplierIds.length,
          })
        )
          .map(toPlainRecord)
          .filter((supplier) => isUuidValue(supplier.id))
          .map((supplier) => ({
            ...supplier,
            name: asString(supplier.displayName) ?? asString(supplier.name),
            company: query.company,
          }))
      : [];
    const supplierOrders = [
      ...(await this.supplierOrdersByLine(companyOrderRows.map((order) => ({ orderId: order.id })))).values(),
    ].sort((left, right) =>
      String(right.lastMeaningfulUpdateAt ?? '').localeCompare(String(left.lastMeaningfulUpdateAt ?? '')),
    );
    const productOrderLines = await this.findOrderLinesByProduct(query);
    const productOrdersById = await this.supplierOrdersByLine(productOrderLines);
    const orderLineHistory = productOrderLines
      .filter((line) => inventoryRowMatchesLine(query, line))
      .map((line): PlainRecord & { order: PlainRecord } => ({
        ...line,
        order: productOrdersById.get(String(line.supplierOrderId)) ?? {},
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
    const activities = await this.withActivityAuthors(
      productOrderIds.size > 0
        ? (
            await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).find({
              filter: {
                entityType: 'supplier_order',
                entityId: { $in: [...productOrderIds].map(asRecordIdFilterValue) },
              },
              limit: 500,
            })
          )
            .map(toPlainRecord)
            .map((comment) => ({
              ...comment,
              company: query.company,
              supplierOrderId: asString(comment.entityId),
              activityType: asString(comment.commentType),
              notes: asString(comment.body),
              occurredAt: sortableDateValue(comment.occurredAt ?? comment.createdAt ?? comment.updatedAt) || undefined,
            }))
        : [],
    );
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
    const safetyBufferDays = settings.safetyBufferDays;
    const reorderCycleDays = settings.reorderCycleDays;
    const orderSoonWindowDays = settings.orderSoonWindowDays;
    const targetCoverDays = settings.targetCoverDays;
    const leadTimeFreshnessDays = settings.leadTimeFreshnessDays;
    const purchasedPipelineGraceDays = settings.purchasedPipelineGraceDays;
    const profitTierThresholds: ProfitTierThresholds = settings;
    const statusRules = supplierOrderStatusRules(settings);
    const sellerboardSourceConnectionIds = await this.sellerboardSourceConnectionIds();

    const [
      companies,
      products,
      companyProducts,
      companyProductFamilies,
      inventorySnapshots,
      dailyFacts,
      suppliers,
      supplierProducts,
      productSuppliers,
      orders,
      orderLines,
      activityComments,
    ] = await Promise.all([
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanies),
      this.repoRows(ECOBASE_COLLECTIONS.silverProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProductFamilies),
      this.repoRows(ECOBASE_COLLECTIONS.silverInventorySnapshots),
      this.repoRows(ECOBASE_COLLECTIONS.silverListingDailyFacts),
      this.repoRows(ECOBASE_COLLECTIONS.silverSuppliers),
      this.repoRows(ECOBASE_COLLECTIONS.silverSupplierProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers),
      this.repoRows(ECOBASE_COLLECTIONS.silverOrders),
      this.repoRows(ECOBASE_COLLECTIONS.silverOrderLines),
      this.repoRows(ECOBASE_COLLECTIONS.silverActivityComments),
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

    const sellerboardCostResolver = await new EcobaseSellerboardCogsService(this.db).createResolver(
      companies.map((company) => asString(company.name)).filter((company): company is string => Boolean(company)),
    );
    const snapshotsByCompanyProduct = this.groupBy(inventorySnapshots, 'companyProductId');
    const factsByCompanyProduct = this.groupBy(dailyFacts, 'companyProductId');
    const companyProductsById = new Map(companyProducts.map((row) => [asString(row.id), row]));
    const familiesById = new Map(companyProductFamilies.map((row) => [asString(row.id), row]));
    const latestFactDateByCompanyId = new Map<string, string>();
    for (const fact of dailyFacts) {
      const companyId = asString(companyProductsById.get(asString(fact.companyProductId))?.companyId);
      const snapshotDate = asString(fact.snapshotDate);
      if (!companyId || !snapshotDate || snapshotDate > calculationDate) continue;
      const current = latestFactDateByCompanyId.get(companyId);
      if (!current || snapshotDate > current) latestFactDateByCompanyId.set(companyId, snapshotDate);
    }
    const ordersById = new Map(
      orders.map((order) => [
        asString(order.id),
        {
          ...order,
          status: silverOrderStatus(order),
          externalOrderRef: asString(order.orderRef),
        },
      ]),
    );
    const normalizedOrderLines: PlainRecord[] = orderLines.map((line) => ({
      ...line,
      supplierOrderId: asString(line.orderId),
      receivedQty: asNumber(line.confirmedQty) ?? 0,
      leadTimeDays: asNumber(supplierProductsById.get(asString(line.supplierProductId))?.leadTimeDays),
    }));
    const linesByCompanyProduct = this.groupBy(normalizedOrderLines, 'companyProductId');
    const latestActivityByOrderId = new Map<string, PlainRecord>();
    for (const comment of await this.withActivityAuthors(activityComments)) {
      if (comment.deletedAt) continue;
      const orderId = asString(comment.entityId);
      const occurredAt =
        asString(comment.occurredAt) ??
        asString(toPlainRecord(comment.contextSnapshotJson).occurredAt) ??
        asString(comment.createdAt);
      if (!orderId || !occurredAt) continue;
      const current = latestActivityByOrderId.get(orderId);
      const currentAt =
        asString(current?.occurredAt) ??
        asString(toPlainRecord(current?.contextSnapshotJson).occurredAt) ??
        asString(current?.createdAt);
      if (!currentAt || occurredAt > currentAt) latestActivityByOrderId.set(orderId, comment);
    }

    const rows: PlainRecord[] = [];
    for (const companyProduct of companyProducts) {
      const company = companiesById.get(asString(companyProduct.companyId));
      const companyName = asString(company?.name);
      if (query.company && companyName !== query.company) continue;
      const product = productsById.get(asString(companyProduct.productId));
      const companyProductId = asString(companyProduct.id);
      if (!companyProductId || !companyName || !product) continue;
      const companyProductFamilyId = asString(companyProduct.companyProductFamilyId);
      const family = familiesById.get(companyProductFamilyId) ?? {};
      const preferredSupplierProduct = supplierProductsById.get(asString(family.preferredSupplierProductId)) ?? {};
      const preferredSupplier = suppliersById.get(
        asString(family.preferredSupplierId) ?? asString(preferredSupplierProduct.supplierId),
      );
      const asin = asString(product.asin);
      const sku = asString(product.sku);

      const inventory = latestPreferredInventorySnapshot(
        snapshotsByCompanyProduct.get(companyProductId) ?? [],
        sellerboardSourceConnectionIds,
      );
      const stockBuckets = inventory
        ? this.stockBuckets(
            {
              stock: asNumber(inventory.sellableStock),
              reserved: asNumber(inventory.reserved),
              inbound: asNumber(inventory.inbound),
              ordered: asNumber(inventory.ordered),
              prepStock: asNumber(inventory.prepStock),
              awdStock: asNumber(inventory.awdStock),
            },
            {},
          )
        : {
            sellableStock: undefined,
            reservedStock: undefined,
            inboundStock: undefined,
            orderedStock: undefined,
            prepStock: undefined,
            awdStock: undefined,
            pipelineStock: undefined,
            currentPlanningStock: undefined,
          };
      const historical = summarizeHistoricalProductFacts(
        factsByCompanyProduct.get(companyProductId) ?? [],
        calculationDate,
        latestFactDateByCompanyId.get(asString(companyProduct.companyId) ?? ''),
      );
      const snapshotVelocity = asNumber(inventory?.salesVelocity);
      const hasRecentVelocity = typeof historical.recentUnits30 === 'number';
      const salesVelocity = hasRecentVelocity
        ? (historical.recentUnits30 ?? 0) / 30
        : typeof snapshotVelocity === 'number' && snapshotVelocity > 0
          ? snapshotVelocity
          : undefined;
      const salesVelocityBasis = hasRecentVelocity
        ? 'historical_rolling_30_days'
        : typeof salesVelocity === 'number'
          ? 'inventory_snapshot_fallback'
          : 'unavailable';
      const salesVelocityStatus = hasRecentVelocity
        ? salesVelocity > 0
          ? 'trusted_positive'
          : 'trusted_zero'
        : typeof salesVelocity === 'number'
          ? 'fallback_positive'
          : 'missing';
      const salesVelocityWindowStart = hasRecentVelocity
        ? historical.recentWindowStartDate
        : typeof salesVelocity === 'number'
          ? asString(inventory?.snapshotDate)
          : undefined;
      const salesVelocityWindowEnd = hasRecentVelocity
        ? historical.recentWindowEndDate
        : typeof salesVelocity === 'number'
          ? asString(inventory?.snapshotDate)
          : undefined;
      const salesVelocityAsOfDate = hasRecentVelocity
        ? historical.recentWindowEndDate
        : typeof salesVelocity === 'number'
          ? asString(inventory?.snapshotDate)
          : undefined;
      const supplierContext = supplierByProductId.get(companyProductId);
      const supplierProduct = toPlainRecord(supplierContext?.supplierProduct);
      const supplier = toPlainRecord(supplierContext?.supplier);
      const hasSupplier = Boolean(asString(supplier.id));
      const productOrderLines = linesByCompanyProduct.get(companyProductId) ?? [];
      const hasOrderSupplierEvidence = productOrderLines.some((line) => {
        const order = ordersById.get(asString(line.supplierOrderId));
        return Boolean(asString(line.supplierProductId) || asString(toPlainRecord(order).supplierId));
      });
      const hasOrderCostEvidence = productOrderLines.some((line) => typeof asNumber(line.unitCost) === 'number');
      const sourceLeadTimeDays = asNumber(supplierProduct.leadTimeDays);
      const leadTimeDays = sourceLeadTimeDays ?? DEFAULT_SUPPLIER_LEAD_TIME_DAYS;
      const supplierAvailability = hasSupplier
        ? 'resolved_silver_link'
        : supplierContext || hasOrderSupplierEvidence
          ? 'link_defect'
          : 'unavailable_no_evidence';
      const leadTimeAvailability =
        typeof sourceLeadTimeDays === 'number' ? 'resolved_silver_link' : 'resolved_default_30d';
      const leadTimeFreshness = typeof sourceLeadTimeDays === 'number' ? 'fresh' : 'default';
      const openOrder = summarizeSupplierOrderState(
        productOrderLines,
        ordersById,
        calculationDate,
        purchasedPipelineGraceDays,
        statusRules,
      );
      const openOrderCoverageQty =
        (asNumber(openOrder.supplierOrderPurchasedOpenQty) ?? 0) +
        (asNumber(openOrder.supplierOrderPlacedNotPurchasedOpenQty) ?? 0);
      const latestActivity = latestActivityByOrderId.get(asString(openOrder.supplierOrderId) ?? '');
      const latestActivityContext = toPlainRecord(latestActivity?.contextSnapshotJson);
      const estimatedOosDate =
        salesVelocity > 0 && typeof stockBuckets.currentPlanningStock === 'number'
          ? addDays(calculationDate, Math.floor(stockBuckets.currentPlanningStock / salesVelocity))
          : undefined;
      const latestSafeReorderDate =
        estimatedOosDate && typeof leadTimeDays === 'number'
          ? addDays(estimatedOosDate, -(leadTimeDays + safetyBufferDays))
          : undefined;
      const daysUntilSafeReorder = latestSafeReorderDate ? diffDays(latestSafeReorderDate, calculationDate) : undefined;
      const suggestedReorderQty =
        typeof stockBuckets.currentPlanningStock === 'number'
          ? this.suggestedReorderQuantity({
              salesVelocity,
              targetCoverDays,
              currentPlanningStock: stockBuckets.currentPlanningStock,
              openOrderCoverageQty,
            })
          : undefined;
      const supplierUnitCost = asNumber(supplierProduct.unitCost);
      const cogs = sellerboardCostResolver.resolve({ company: companyName, asin, sku, suggestedReorderQty });
      const unitCost = supplierUnitCost ?? cogs.unitCost;
      const unitCostSource = typeof supplierUnitCost === 'number' ? 'silver_supplier_product' : cogs.unitCostSource;
      const unitCostAvailability =
        typeof supplierUnitCost === 'number'
          ? 'resolved_supplier_product'
          : typeof cogs.unitCost === 'number'
            ? 'resolved_cogs'
            : cogs.unitCostStatus === 'ambiguous'
              ? 'unavailable_ambiguous'
              : supplierContext || hasOrderCostEvidence
                ? 'source_incomplete'
                : 'unavailable_no_evidence';
      const profitAvailability =
        historical.units > 0
          ? typeof historical.profitPerUnit === 'number'
            ? 'resolved_history'
            : 'source_incomplete'
          : historical.availableMonthCount > 0
            ? 'unavailable_no_sales'
            : 'unavailable_no_history';
      const productStatus = derivedProductStatus(asString(companyProduct.lifecycleStatus), stockBuckets);
      const daysOfCover =
        salesVelocity > 0 && typeof stockBuckets.currentPlanningStock === 'number'
          ? stockBuckets.currentPlanningStock / salesVelocity
          : undefined;
      const actionStatus =
        typeof stockBuckets.currentPlanningStock === 'number'
          ? this.actionStatus({
              excluded: isPlanningExcluded(asString(companyProduct.lifecycleStatus)),
              salesVelocity,
              salesVelocityStatus,
              leadTimeFreshness,
              daysUntilSafeReorder,
              orderSoonWindowDays,
              openOrderCoverageQty,
            })
          : 'missing_inventory';
      const recentUnits30 = historical.recentUnits30;
      const tierResult = profitTierFor(historical.profitPerUnit, recentUnits30, profitTierThresholds);
      const provisionalStuck = stuckClassification(
        {
          ...stockBuckets,
          daysOfCover,
          salesVelocity,
          salesVelocityBasis,
          salesVelocityStatus,
          productStatus,
          actionStatus,
          supplierOrderState: openOrder.supplierOrderState,
          expectedArrivalDate: openOrder.expectedArrivalDate,
          latestSupplierOrderActivityAt:
            asString(latestActivity?.occurredAt) ??
            asString(latestActivityContext.occurredAt) ??
            asString(latestActivity?.createdAt),
          purchasedPipelineGraceDays,
          lastMonthQty: historical.lastMonthQty,
          sixMonthAverageQty: historical.sixMonthAverageQty,
        },
        calculationDate,
      );
      const tierEligibilityReason =
        typeof recentUnits30 !== 'number'
          ? 'missing_recent_sales_evidence'
          : recentUnits30 < MINIMUM_TIER_UNITS_30_DAYS
            ? 'low_recent_demand'
            : ['over_60_doc', 'reserved_stalled', 'pipeline_stalled', 'no_sell_through_with_stock'].includes(
                  provisionalStuck,
                )
              ? 'stuck_inventory'
              : typeof historical.profitPerUnit !== 'number'
                ? 'missing_profit_evidence'
                : !tierResult.tier
                  ? 'non_positive_profit_score'
                  : 'eligible_recent_demand';
      const tier = tierEligibilityReason === 'eligible_recent_demand' ? tierResult.tier : undefined;
      const tierScore = tierResult.tierScore;

      rows.push({
        planningProductId: companyProductId,
        companyProductId,
        companyProductFamilyId,
        familyMarketplace: asString(family.marketplace),
        familyCanonicalAsin: asString(family.canonicalAsin),
        replenishmentTargetCompanyProductId: asString(family.replenishmentTargetCompanyProductId),
        familyPreferredSupplierId: asString(family.preferredSupplierId),
        familyPreferredSupplierProductId: asString(family.preferredSupplierProductId),
        familyPreferredSupplierName: asString(preferredSupplier?.displayName),
        familyUnitCost: asNumber(preferredSupplierProduct.unitCost),
        familyLeadTimeDays: asNumber(preferredSupplierProduct.leadTimeDays),
        familyRollupEvidence: {
          targetSelection: toPlainRecord(family.targetSelectionEvidenceJson),
          supplierSelection: toPlainRecord(family.supplierSelectionEvidenceJson),
          targetReviewRequired: family.targetReviewRequired === true,
          supplierReviewRequired: family.supplierReviewRequired === true,
        },
        productId: asString(product.id),
        calculationDate,
        company: companyName,
        asin,
        sku,
        title: asString(product.title),
        productStatus,
        actionStatus,
        tier,
        tierScore,
        recentUnits30,
        tierEligibilityReason,
        tierRuleVersion: TIER_RULE_VERSION,
        salesVelocity,
        salesVelocityBasis,
        salesVelocityStatus,
        salesVelocityWindowStart,
        salesVelocityWindowEnd,
        salesVelocityAsOfDate,
        profitPerUnit: historical.profitPerUnit,
        sixMonthMargin: historical.margin,
        lastMonthQty: historical.lastMonthQty,
        sixMonthAverageQty: historical.sixMonthAverageQty,
        sixMonthWorstQty: historical.sixMonthWorstQty,
        sixMonthBestQty: historical.sixMonthBestQty,
        ...stockBuckets,
        inventoryAsOfDate: asString(inventory?.snapshotDate),
        daysOfCover,
        estimatedOosDate,
        latestSafeReorderDate,
        daysUntilSafeReorder,
        suggestedReorderQty,
        safetyBufferDays,
        reorderCycleDays,
        targetCoverDays,
        orderSoonWindowDays,
        leadTimeFreshnessDays,
        purchasedPipelineGraceDays,
        leadTimeDays,
        leadTimeFreshness,
        supplierId: asString(supplier?.id),
        supplierName: asString(supplier?.displayName),
        supplierSource: hasSupplier ? 'silver_supplier_product' : undefined,
        supplierRole: supplierContext ? 'latest_used' : undefined,
        supplierConfidence: supplierContext ? 1 : undefined,
        supplierAvailability,
        leadTimeAvailability,
        unitCost,
        unitCostSource,
        unitCostAvailability,
        profitAvailability,
        estimatedOrderCost:
          typeof unitCost === 'number' && typeof suggestedReorderQty === 'number'
            ? unitCost * suggestedReorderQty
            : undefined,
        openOrderCoverageQty,
        ...openOrder,
        latestSupplierOrderActivityType: asString(latestActivity?.commentType),
        latestSupplierOrderActivityAt:
          asString(latestActivity?.occurredAt) ??
          asString(latestActivityContext.occurredAt) ??
          asString(latestActivity?.createdAt),
        latestSupplierOrderActivityNote: asString(latestActivity?.body),
        latestSupplierOrderActivityActor: asString(latestActivityContext.actor),
        latestSupplierOrderActivityActorUserId: asRecordIdString(latestActivity?.actorUserId),
        latestSupplierOrderActivityActorDisplayName: asString(latestActivity?.actorDisplayName),
        latestSupplierOrderActivityActorEmail: asString(latestActivity?.actorEmail),
        latestSupplierOrderActivitySource: asString(latestActivityContext.source),
        stuck: false,
        digestPriority: this.digestPriority(actionStatus, tier),
        evidence: {
          sourceLayer: 'silver',
          inventorySnapshotId: asString(inventory?.id),
          supplierProductId: asString(supplierProduct.id),
          historicalFactCount: (factsByCompanyProduct.get(companyProductId) ?? []).length,
          velocity: {
            basis: salesVelocityBasis,
            status: salesVelocityStatus,
            windowStart: salesVelocityWindowStart,
            windowEnd: salesVelocityWindowEnd,
            asOfDate: salesVelocityAsOfDate,
          },
          leadTime: {
            days: leadTimeDays,
            source: typeof sourceLeadTimeDays === 'number' ? 'silver_supplier_product' : 'system_default_30d',
          },
        },
      });
    }

    const resolvedRows = this.applyFamilyRollups(rows, calculationDate).map((row) =>
      this.finalizeGoldContract(row, calculationDate),
    );
    return this.sortPlanningRows(resolvedRows).slice(0, query.limit ?? resolvedRows.length);
  }

  private finalizeGoldContract(row: PlainRecord, calculationDate: string) {
    const productStatus = asString(row.productStatus)?.toLowerCase();
    const familyRole = asString(row.familyRole);
    const planningTarget = familyRole === 'target' || familyRole === 'unassigned';
    const live = productStatus === 'active' || productStatus === 'live';
    const tiered = isProfitTier(row.tier);
    const actionStatus = asString(row.actionStatus) ?? '';
    const excluded = actionStatus === 'excluded' || asBoolean(row.planningExcluded) === true;
    const supplierOrderState = asString(row.supplierOrderState) ?? '';
    const activeOrder =
      planningTarget &&
      live &&
      !excluded &&
      ['purchased_pipeline', 'placed_not_purchased'].includes(supplierOrderState);
    const listingStuck = stuckClassification(row, calculationDate);
    const familyStuckAction = asBoolean(row.familyStuckAction) === true;
    const stuck = familyStuckAction ? asString(row.familyStuckClassification) ?? listingStuck : listingStuck;
    const stuckInventory =
      !excluded &&
      (familyStuckAction ||
        (familyRole === 'unassigned' &&
          ['over_60_doc', 'no_sell_through_with_stock', 'reserved_stalled', 'pipeline_stalled'].includes(stuck)));
    const stockoutSoon =
      typeof asNumber(row.daysOfCover) === 'number' &&
      typeof asNumber(row.targetCoverDays) === 'number' &&
      (asNumber(row.daysOfCover) ?? Infinity) <= (asNumber(row.targetCoverDays) ?? 0);
    const supplyAction =
      live &&
      !excluded &&
      planningTarget &&
      !['over_30_doc_watch', 'declining_velocity_watch'].includes(listingStuck) &&
      tiered &&
      (asNumber(row.salesVelocity) ?? 0) > 0 &&
      stockoutSoon &&
      ['no_open_order', 'closed_history', ''].includes(supplierOrderState);
    const commandCenterPane = stuckInventory
      ? 'stuckInventory'
      : activeOrder
        ? 'activeOrders'
        : supplyAction
          ? 'supplyAction'
          : 'watch';
    const planningEligibilityStatus = excluded
      ? 'ineligible_excluded'
      : commandCenterPane !== 'watch'
        ? 'eligible'
        : familyRole === 'member'
          ? 'ineligible_family_member'
          : !live
            ? 'ineligible_inactive'
            : !tiered
              ? 'ineligible_unclassified_tier'
              : 'eligible_watch';
    const inventoryAsOfDate = optionalIsoDate(asString(row.inventoryAsOfDate) ?? '');
    const inventoryAgeDays = inventoryAsOfDate ? diffDays(calculationDate, inventoryAsOfDate) : undefined;
    const sourceFreshnessStatus =
      typeof inventoryAgeDays !== 'number'
        ? 'unknown'
        : inventoryAgeDays < 0
          ? 'invalid_future'
          : inventoryAgeDays <= 1
            ? 'fresh'
            : 'stale';
    const dataQualityIssues = [
      familyRole === 'unassigned' ? 'family_missing' : undefined,
      asString(row.salesVelocityStatus) === 'missing' ? 'velocity_missing' : undefined,
      sourceFreshnessStatus === 'fresh' ? undefined : `inventory_${sourceFreshnessStatus}`,
      asString(row.supplierAvailability)?.startsWith('resolved_') ? undefined : 'supplier_unavailable',
      asString(row.leadTimeAvailability)?.startsWith('resolved_') ? undefined : 'lead_time_unavailable',
      asString(row.unitCostAvailability)?.startsWith('resolved_') ? undefined : 'unit_cost_unavailable',
      asString(row.profitAvailability)?.startsWith('resolved_') ? undefined : 'profit_unavailable',
      activeOrder && asString(row.expectedArrivalStatus) === 'unknown' ? 'expected_arrival_unknown' : undefined,
      [
        'reserved_stalled',
        'pipeline_stalled',
        'no_sell_through_with_stock',
        'insufficient_velocity_data',
        'untrusted_velocity_data',
      ].includes(stuck)
        ? stuck
        : undefined,
    ].filter((issue): issue is string => Boolean(issue));
    const dataQualityStatus = dataQualityIssues.includes('velocity_missing')
      ? 'blocked'
      : dataQualityIssues.length > 0
        ? 'partial'
        : 'ready';
    const moneyRisk = calculateInventoryMoneyRisk(row);

    return {
      ...row,
      stuck: stuckInventory,
      stuckClassification: stuck,
      pipelineHealthStatus: pipelineHealthStatus(row, calculationDate),
      stockoutGapDays: stockoutGapDays(row),
      daysUntilOos: daysUntilDate(row.estimatedOosDate, calculationDate),
      commandCenterPane,
      commandCenterPaneReason:
        commandCenterPane === 'watch' ? 'no_command_center_action_required' : `classified_${commandCenterPane}`,
      planningEligibilityStatus,
      planningEligibilityReason:
        planningEligibilityStatus === 'eligible' ? `verified_${commandCenterPane}` : planningEligibilityStatus,
      ...moneyRisk,
      sourceFreshnessStatus,
      dataQualityStatus,
      dataQualityIssues,
      recommendedEscalation: recommendedInventoryAction({ ...row, stuckClassification: stuck }),
    };
  }

  private applyFamilyRollups(rows: PlainRecord[], calculationDate: string) {
    const groups = this.groupBy(rows, 'companyProductFamilyId');
    const resolvedByCompanyProductId = new Map<string, PlainRecord>();
    const sum = (members: PlainRecord[], field: string) =>
      members.reduce((total, row) => total + (asNumber(row[field]) ?? 0), 0);
    const actionableStuckReasons = new Set([
      'over_60_doc',
      'no_sell_through_with_stock',
      'reserved_stalled',
      'pipeline_stalled',
    ]);
    const supplierOrderFields = [
      'supplierOrderState',
      'supplierOrderId',
      'supplierOrderStatus',
      'supplierOrderRef',
      'supplierOrderAuthorityStatus',
      'supplierOrderAuthoritySource',
      'supplierOrderAuthorityTaskRef',
      'supplierOrderAuthorityAsOf',
      'supplierOrderAuthorityEvidence',
      'supplierOrderOpenQty',
      'supplierOrderReferenceOpenQty',
      'supplierOrderPurchasedOpenQty',
      'supplierOrderPlacedNotPurchasedOpenQty',
      'expectedArrivalDate',
      'expectedArrivalStatus',
      'expectedArrivalSource',
      'expectedArrivalAsOf',
      'expectedArrivalConfidence',
      'expectedArrivalFreshness',
      'latestSupplierOrderActivityType',
      'latestSupplierOrderActivityAt',
      'latestSupplierOrderActivityNote',
      'latestSupplierOrderActivityActor',
      'latestSupplierOrderActivityActorUserId',
      'latestSupplierOrderActivityActorDisplayName',
      'latestSupplierOrderActivityActorEmail',
      'latestSupplierOrderActivitySource',
    ];

    for (const [familyId, members] of groups) {
      const targetId = asString(members[0]?.replenishmentTargetCompanyProductId);
      const target = members.find((row) => asString(row.companyProductId) === targetId);
      const targetSku = asString(target?.sku);
      const supplierEvidence = toPlainRecord(toPlainRecord(members[0]?.familyRollupEvidence).supplierSelection);
      const sourceCompanyProductId = asString(supplierEvidence.sourceCompanyProductId);
      const orderedMembers = [...members].sort((left, right) =>
        (asString(right.supplierOrderSortValue) ?? '').localeCompare(asString(left.supplierOrderSortValue) ?? ''),
      );
      const orderSource =
        members.find((row) => asString(row.companyProductId) === sourceCompanyProductId) ??
        orderedMembers.find((row) => asString(row.supplierOrderRef));
      const stock = {
        familyCurrentPlanningStock: sum(members, 'currentPlanningStock'),
        familySellableStock: sum(members, 'sellableStock'),
        familyReservedStock: sum(members, 'reservedStock'),
        familyPipelineStock: sum(members, 'pipelineStock'),
        familyInboundStock: sum(members, 'inboundStock'),
        familyOrderedStock: sum(members, 'orderedStock'),
        familyPrepStock: sum(members, 'prepStock'),
        familyAwdStock: sum(members, 'awdStock'),
      };
      const velocityValues = members.map((row) => asNumber(row.salesVelocity)).filter((value) => value !== undefined);
      const familySalesVelocity = velocityValues.length
        ? velocityValues.reduce((total, value) => total + value, 0)
        : undefined;
      const grossOpenOrderCoverageQty = sum(members, 'openOrderCoverageQty');
      const familyOpenOrderCoverageQty = Math.max(0, grossOpenOrderCoverageQty - stock.familyPipelineStock);
      const familyDaysOfCover =
        typeof familySalesVelocity === 'number' && familySalesVelocity > 0
          ? stock.familyCurrentPlanningStock / familySalesVelocity
          : undefined;
      const familyEstimatedOosDate =
        typeof familyDaysOfCover === 'number' ? addDays(calculationDate, Math.floor(familyDaysOfCover)) : undefined;
      const familySuggestedReorderQty = target
        ? this.suggestedReorderQuantity({
            salesVelocity: familySalesVelocity,
            targetCoverDays: asNumber(target.targetCoverDays) ?? 0,
            currentPlanningStock: stock.familyCurrentPlanningStock,
            openOrderCoverageQty: familyOpenOrderCoverageQty,
          })
        : undefined;
      const familyUnitCost =
        asNumber(target?.familyUnitCost) ?? asNumber(orderSource?.unitCost) ?? asNumber(target?.unitCost);
      const familyLeadTimeDays =
        asNumber(target?.familyLeadTimeDays) ?? asNumber(orderSource?.leadTimeDays) ?? DEFAULT_SUPPLIER_LEAD_TIME_DAYS;
      const latestSafeReorderDate = familyEstimatedOosDate
        ? addDays(familyEstimatedOosDate, -(familyLeadTimeDays + (asNumber(target?.safetyBufferDays) ?? 0)))
        : undefined;
      const daysUntilSafeReorder = latestSafeReorderDate ? diffDays(latestSafeReorderDate, calculationDate) : undefined;
      const familyActionStatus = target
        ? this.actionStatus({
            excluded: asString(target.actionStatus) === 'excluded',
            salesVelocity: familySalesVelocity,
            salesVelocityStatus:
              typeof familySalesVelocity !== 'number'
                ? 'missing'
                : familySalesVelocity > 0
                  ? 'trusted_positive'
                  : 'trusted_zero',
            leadTimeFreshness: asNumber(target.familyLeadTimeDays) === undefined ? 'default' : 'fresh',
            daysUntilSafeReorder,
            orderSoonWindowDays: asNumber(target.orderSoonWindowDays) ?? 0,
            openOrderCoverageQty: familyOpenOrderCoverageQty,
          })
        : 'family_review_required';
      const classifiedMembers = members.map((row) => ({
        row,
        reason: stuckClassification(row, calculationDate),
      }));
      const affectedMembers = classifiedMembers.filter(({ reason }) => actionableStuckReasons.has(reason));
      const familyStuckReasons = [...new Set(affectedMembers.map(({ reason }) => reason))];
      const familyStuckReason = [
        'pipeline_stalled',
        'reserved_stalled',
        'no_sell_through_with_stock',
        'over_60_doc',
      ].find((reason) => familyStuckReasons.includes(reason));
      const familyStuckAffectedUnits = affectedMembers.reduce(
        (total, { row }) => total + (asNumber(row.currentPlanningStock) ?? 0),
        0,
      );
      const affectedWithCost = affectedMembers.filter(({ row }) => typeof asNumber(row.unitCost) === 'number');
      const familyStuckAffectedValue = affectedWithCost.reduce(
        (total, { row }) => total + (asNumber(row.currentPlanningStock) ?? 0) * (asNumber(row.unitCost) ?? 0),
        0,
      );
      const familyStuckActionRow = target ?? affectedMembers[0]?.row;
      const familyStuckActiveOrderCount = members.filter((row) =>
        ['purchased_pipeline', 'placed_not_purchased'].includes(asString(row.supplierOrderState) ?? ''),
      ).length;
      const familyStuckEvidence = {
        reasons: familyStuckReasons,
        affectedMembers: affectedMembers.map(({ row, reason }) => ({
          companyProductId: asString(row.companyProductId),
          sku: asString(row.sku),
          reason,
          units: asNumber(row.currentPlanningStock) ?? 0,
          unitCost: asNumber(row.unitCost),
          value:
            typeof asNumber(row.unitCost) === 'number'
              ? (asNumber(row.currentPlanningStock) ?? 0) * (asNumber(row.unitCost) ?? 0)
              : undefined,
          supplierOrderState: asString(row.supplierOrderState),
          expectedArrivalDate: asString(row.expectedArrivalDate),
        })),
        valueStatus:
          affectedMembers.length === 0
            ? 'not_applicable'
            : affectedWithCost.length === affectedMembers.length
              ? 'complete'
              : affectedWithCost.length
                ? 'partial'
                : 'missing',
        activeOrderCount: familyStuckActiveOrderCount,
      };
      const targetOrderValues = Object.fromEntries(supplierOrderFields.map((field) => [field, orderSource?.[field]]));
      const familyValues = {
        familyMemberCount: members.length,
        replenishmentTargetSku: targetSku,
        familyTier: asString(target?.tier),
        familyTierScore: asNumber(target?.tierScore),
        ...stock,
        familySalesVelocity,
        familyDaysOfCover,
        familyEstimatedOosDate,
        familyOpenOrderCoverageQty,
        familySuggestedReorderQty,
        familyUnitCost,
        familyLeadTimeDays,
        familyEstimatedOrderCost:
          typeof familyUnitCost === 'number' && typeof familySuggestedReorderQty === 'number'
            ? familyUnitCost * familySuggestedReorderQty
            : undefined,
        familyStuck: affectedMembers.length > 0,
        familyStuckClassification: familyStuckReason ?? 'none',
        familyStuckAffectedMemberCount: affectedMembers.length,
        familyStuckAffectedUnits,
        familyStuckAffectedValue: affectedWithCost.length ? familyStuckAffectedValue : undefined,
        familyStuckActiveOrderCount,
        familyStuckEvidence,
      };
      const familyRollup = {
        familyId,
        boundary: 'company_amazon_account_marketplace_asin',
        memberCompanyProductIds: members.map((row) => asString(row.companyProductId)),
        targetCompanyProductId: targetId,
        targetSku,
        sourceCompanyProductId,
        sourceSku: asString(supplierEvidence.sourceSku) ?? asString(orderSource?.sku),
        sourceOrderRef: asString(supplierEvidence.sourceOrderRef) ?? asString(orderSource?.supplierOrderRef),
        grossOpenOrderCoverageQty,
        sellerboardPipelineQty: stock.familyPipelineStock,
        netOpenOrderCoverageQty: familyOpenOrderCoverageQty,
        supplierOrderCoverageTreatment: 'pipeline_netting',
      };

      for (const row of members) {
        const isTarget = row === target;
        const preferredSupplierName =
          asString(target?.familyPreferredSupplierName) ?? asString(orderSource?.supplierName);
        const resolved = {
          ...row,
          ...familyValues,
          familyRole: isTarget ? 'target' : target ? 'member' : 'review',
          familyStuckAction: row === familyStuckActionRow && affectedMembers.length > 0,
          familySuggestedReorderQty: isTarget ? familySuggestedReorderQty : undefined,
          familyEstimatedOrderCost: isTarget ? familyValues.familyEstimatedOrderCost : undefined,
          actionStatus: isTarget ? familyActionStatus : 'family_member_no_reorder',
          suggestedReorderQty: isTarget ? familySuggestedReorderQty : undefined,
          estimatedOrderCost: isTarget ? familyValues.familyEstimatedOrderCost : undefined,
          ...(isTarget
            ? {
                ...targetOrderValues,
                openOrderCoverageQty: familyOpenOrderCoverageQty,
                latestSafeReorderDate,
                daysUntilSafeReorder,
                supplierId: asString(target?.familyPreferredSupplierId) ?? asString(orderSource?.supplierId),
                supplierName: preferredSupplierName,
                supplierSource: preferredSupplierName ? 'family_preferred_supplier' : undefined,
                supplierRole: preferredSupplierName ? 'preferred_for_family' : undefined,
                supplierConfidence: preferredSupplierName ? 1 : undefined,
                supplierAvailability: preferredSupplierName
                  ? 'resolved_family_preferred_supplier'
                  : target?.supplierAvailability,
                leadTimeDays: familyLeadTimeDays,
                leadTimeFreshness: asNumber(target?.familyLeadTimeDays) === undefined ? 'default' : 'fresh',
                leadTimeAvailability:
                  asNumber(target?.familyLeadTimeDays) === undefined
                    ? 'resolved_default_30d'
                    : 'resolved_family_preferred_supplier',
                unitCost: familyUnitCost,
                unitCostSource:
                  asNumber(target?.familyUnitCost) === undefined
                    ? orderSource?.unitCostSource
                    : 'family_preferred_supplier',
                unitCostAvailability:
                  typeof familyUnitCost === 'number'
                    ? 'resolved_family_preferred_supplier'
                    : target?.unitCostAvailability,
              }
            : {}),
          familyRollupEvidence: familyRollup,
          evidence: { ...toPlainRecord(row.evidence), familyRollup },
        };
        const companyProductId = asString(row.companyProductId);
        if (companyProductId) resolvedByCompanyProductId.set(companyProductId, resolved);
      }
    }

    return rows.map((row) => {
      const companyProductId = asString(row.companyProductId);
      return (
        (companyProductId ? resolvedByCompanyProductId.get(companyProductId) : undefined) ?? {
          ...row,
          familyRole: 'unassigned',
          familyMemberCount: 1,
        }
      );
    });
  }

  private async repoRows(collectionName: string, limit = GOLD_SOURCE_RECORD_LIMIT) {
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
      return latestRefresh ? records.filter((record) => asString(record.lastRefreshedAt) === latestRefresh) : records;
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
    const knownRiskRows = rows.filter((row) => typeof asNumber(row.estimatedProfitRisk) === 'number');
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const missingSupplierRows = this.commandCenterRowsForPane('missingSupplier', rows);
    const activeOrderRows = this.commandCenterRowsForPane('activeOrders', rows);
    const stuckRows = this.commandCenterRowsForPane('stuckInventory', rows);
    const urgentRows = [...supplyRows, ...missingSupplierRows, ...activeOrderRows].filter((row) =>
      ['overdue', 'order_today'].includes(String(row.actionStatus)),
    );
    const offTrackRows = activeOrderRows.filter((row) =>
      ['late', 'placed_not_purchased'].includes(asString(row.pipelineHealthStatus) ?? ''),
    );
    const followUpRows = activeOrderRows.filter((row) => asString(row.recommendedEscalation) === 'follow_up_order');
    const profitRisk = knownRiskRows.reduce((total, row) => total + (asNumber(row.estimatedProfitRisk) as number), 0);
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
        unknownCount: rows.length - knownRiskRows.length,
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

  private commandCenterMacroRisk(rows: PlainRecord[]) {
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const missingSupplierRows = this.commandCenterRowsForPane('missingSupplier', rows);
    const activeOrderRows = this.commandCenterRowsForPane('activeOrders', rows);
    const stuckRows = this.commandCenterRowsForPane('stuckInventory', rows);
    const risk = (items: PlainRecord[]) => {
      const known = items
        .map((row) => asNumber(row.estimatedProfitRisk))
        .filter((value): value is number => value !== undefined);
      return {
        value: Math.round(known.reduce((total, value) => total + value, 0) * 100) / 100,
        unknownCount: items.length - known.length,
      };
    };
    const activeLateRows = activeOrderRows.filter((row) =>
      ['late', 'placed_not_purchased'].includes(asString(row.pipelineHealthStatus) ?? ''),
    );
    const followUpRows = activeOrderRows.filter((row) => asString(row.recommendedEscalation) === 'follow_up_order');
    const noOrderRows = [...supplyRows, ...missingSupplierRows];
    const leadTimeGapRows = [...noOrderRows, ...activeOrderRows].filter((row) =>
      leadTimeNeedsReview(row.leadTimeFreshness),
    );
    return [
      { key: 'noOrderUrgent', label: 'No order + urgent', ...risk(noOrderRows), format: 'currency' },
      { key: 'activeOrderLate', label: 'Active order late', ...risk(activeLateRows), format: 'currency' },
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

  private commandCenterRiskBars(rows: PlainRecord[]) {
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const activeOrderRows = this.commandCenterRowsForPane('activeOrders', rows);
    const stuckRows = this.commandCenterRowsForPane('stuckInventory', rows);
    const countByAction = (values: string[]) =>
      values.map((value) => ({
        key: value,
        count: supplyRows.filter((row) => String(row.actionStatus) === value).length,
      }));
    return {
      supplyAction: countByAction(['overdue', 'order_today', 'order_soon', 'stale_lead_time']),
      activeOrders: ['purchased_pipeline', 'placed_not_purchased'].map((value) => ({
        key: value,
        count: activeOrderRows.filter((row) => row.supplierOrderState === value).length,
      })),
      pipelineHealth: ['on_track', 'late', 'unknown_timing', 'placed_not_purchased', 'none'].map((value) => ({
        key: value,
        count: activeOrderRows.filter((row) => asString(row.pipelineHealthStatus) === value).length,
      })),
      stuckInventory: ['over_60_doc', 'over_30_doc'].map((value) => ({
        key: value,
        count: stuckRows.filter((row) => asString(row.stuckClassification) === value).length,
      })),
    };
  }

  private commandCenterPanePayload(
    pane: InventoryCommandCenterPane,
    rows: PlainRecord[],
    query: InventoryPlanningCommandCenterQuery,
  ) {
    const page = asPositiveInteger(query.pane === pane ? query.page : undefined, 1, 10000);
    const pageSize = asPositiveInteger(query.pane === pane ? query.pageSize : undefined, 25, 100);
    const sortBy = query.pane === pane ? query.sortBy : undefined;
    const sortDirection = query.pane === pane ? query.sortDirection ?? 'desc' : 'desc';
    const filteredRows = this.sortCommandCenterRows(
      this.commandCenterRowsForPane(pane, rows).filter((row) => this.matchesCommandCenterFilters(row, query.filters)),
      sortBy ?? this.defaultCommandCenterSort(pane),
      sortDirection,
    );
    const start = (page - 1) * pageSize;
    const visibleRows = filteredRows.slice(start, start + pageSize);
    return {
      pane,
      page,
      pageSize,
      total: filteredRows.length,
      sortBy: sortBy ?? this.defaultCommandCenterSort(pane),
      sortDirection,
      rows: visibleRows.map((row) => {
        const familyId = asString(row.companyProductFamilyId);
        return {
          ...this.compactCommandCenterRow(row),
          familyMembers: rows
            .filter((member) => familyId && asString(member.companyProductFamilyId) === familyId)
            .map((member) => this.compactCommandCenterRow(member)),
        };
      }),
    };
  }

  private commandCenterRowsForPane(pane: InventoryCommandCenterPane, rows: PlainRecord[]) {
    const paneRows = rows.filter((row) => asString(row.commandCenterPane) === pane);
    if (pane !== 'supplyAction' && pane !== 'missingSupplier') return paneRows;
    const supplyRows = rows.filter((row) => asString(row.commandCenterPane) === 'supplyAction');
    return supplyRows.filter((row) => {
      const supplierResolved = asString(row.supplierAvailability)?.startsWith('resolved_') === true;
      return pane === 'supplyAction' ? supplierResolved : !supplierResolved;
    });
  }

  private matchesCommandCenterFilters(row: PlainRecord, filters: Record<string, unknown> | undefined) {
    if (!filters) return true;
    const matchesList = (field: string, value: unknown) => {
      const expected = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      return expected.length === 0 || expected.includes(row[field]);
    };
    if (!matchesList('tier', filters.tier)) return false;
    if (!matchesList('actionStatus', filters.actionStatus)) return false;
    if (!matchesList('supplierOrderState', filters.supplierOrderState)) return false;
    if (!matchesList('leadTimeFreshness', filters.leadTimeFreshness)) return false;
    if (typeof filters.minProfitRisk === 'number') {
      const risk = asNumber(row.estimatedProfitRisk);
      if (typeof risk !== 'number' || risk < filters.minProfitRisk) return false;
    }
    if (typeof filters.maxDaysUntilOos === 'number') {
      const daysUntilOos = asNumber(row.daysUntilOos);
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
    if (pane === 'stuckInventory') return 'familyStuckAffectedValue';
    if (pane === 'duplicateProducts') return 'currentPlanningStock';
    return 'estimatedProfitRisk';
  }

  private sortCommandCenterRows(rows: PlainRecord[], sortBy: string, direction: 'asc' | 'desc') {
    return [...rows].sort((left, right) => {
      const leftValue = this.commandCenterSortValue(left, sortBy);
      const rightValue = this.commandCenterSortValue(right, sortBy);
      if (leftValue === rightValue) return 0;
      if (leftValue === undefined || leftValue === null) return 1;
      if (rightValue === undefined || rightValue === null) return -1;
      const result = leftValue > rightValue ? 1 : -1;
      return direction === 'desc' ? -result : result;
    });
  }

  private commandCenterSortValue(row: PlainRecord, sortBy: string): string | number | undefined {
    if (sortBy === 'daysUntilOos') return asNumber(row.daysUntilOos);
    if (sortBy === 'stockoutGapDays') return asNumber(row.stockoutGapDays);
    if (sortBy === 'tier') return profitTierRank(row.tier);
    if (sortBy === 'actionStatus') return actionRank(row.actionStatus as InventoryPlanningActionStatus);
    if (
      [
        'estimatedProfitRisk',
        'suggestedReorderQty',
        'daysUntilSafeReorder',
        'daysOfCover',
        'currentPlanningStock',
        'familyCurrentPlanningStock',
        'familyDaysOfCover',
        'familyStuckAffectedValue',
      ].includes(sortBy)
    ) {
      return asNumber(row[sortBy]);
    }
    return asString(row[sortBy]);
  }

  private compactCommandCenterRow(row: PlainRecord) {
    const daysUntilOos = asNumber(row.daysUntilOos);
    const gapDays = asNumber(row.stockoutGapDays);
    return {
      id:
        asString(row.id) ??
        asString(row.naturalKey) ??
        `${asString(row.company) ?? ''}:${asString(row.asin) ?? ''}:${asString(row.sku) ?? ''}`,
      company: asString(row.company),
      planningProductId: asString(row.planningProductId),
      companyProductId: asString(row.companyProductId),
      companyProductFamilyId: asString(row.companyProductFamilyId),
      familyMarketplace: asString(row.familyMarketplace),
      familyCanonicalAsin: asString(row.familyCanonicalAsin),
      familyRole: asString(row.familyRole),
      familyMemberCount: asNumber(row.familyMemberCount),
      replenishmentTargetCompanyProductId: asString(row.replenishmentTargetCompanyProductId),
      replenishmentTargetSku: asString(row.replenishmentTargetSku),
      familyTier: asString(row.familyTier),
      familyTierScore: asNumber(row.familyTierScore),
      familyCurrentPlanningStock: asNumber(row.familyCurrentPlanningStock),
      familySellableStock: asNumber(row.familySellableStock),
      familyReservedStock: asNumber(row.familyReservedStock),
      familyPipelineStock: asNumber(row.familyPipelineStock),
      familyInboundStock: asNumber(row.familyInboundStock),
      familyOrderedStock: asNumber(row.familyOrderedStock),
      familyPrepStock: asNumber(row.familyPrepStock),
      familyAwdStock: asNumber(row.familyAwdStock),
      familySalesVelocity: asNumber(row.familySalesVelocity),
      familyDaysOfCover: asNumber(row.familyDaysOfCover),
      familyEstimatedOosDate: asString(row.familyEstimatedOosDate),
      familyOpenOrderCoverageQty: asNumber(row.familyOpenOrderCoverageQty),
      familySuggestedReorderQty: asNumber(row.familySuggestedReorderQty),
      familyPreferredSupplierId: asString(row.familyPreferredSupplierId),
      familyPreferredSupplierProductId: asString(row.familyPreferredSupplierProductId),
      familyPreferredSupplierName: asString(row.familyPreferredSupplierName),
      familyUnitCost: asNumber(row.familyUnitCost),
      familyLeadTimeDays: asNumber(row.familyLeadTimeDays),
      familyEstimatedOrderCost: asNumber(row.familyEstimatedOrderCost),
      familyStuck: asBoolean(row.familyStuck),
      familyStuckAction: asBoolean(row.familyStuckAction),
      familyStuckClassification: asString(row.familyStuckClassification),
      familyStuckAffectedMemberCount: asNumber(row.familyStuckAffectedMemberCount),
      familyStuckAffectedUnits: asNumber(row.familyStuckAffectedUnits),
      familyStuckAffectedValue: asNumber(row.familyStuckAffectedValue),
      familyStuckActiveOrderCount: asNumber(row.familyStuckActiveOrderCount),
      familyStuckEvidence: toPlainRecord(row.familyStuckEvidence),
      familyRollupEvidence: toPlainRecord(row.familyRollupEvidence),
      asin: asString(row.asin),
      sku: asString(row.sku),
      title: asString(row.title),
      productStatus: asString(row.productStatus),
      duplicatePrimarySku: asString(toPlainRecord(toPlainRecord(row.evidence).duplicateSkuGroup).primarySku),
      duplicatePrimaryCompanyProductId: asString(
        toPlainRecord(toPlainRecord(row.evidence).duplicateSkuGroup).primaryCompanyProductId,
      ),
      tier: asString(row.tier),
      tierScore: asNumber(row.tierScore),
      recentUnits30: asNumber(row.recentUnits30),
      tierEligibilityReason: asString(row.tierEligibilityReason),
      tierRuleVersion: asString(row.tierRuleVersion),
      previousTier: asString(row.previousTier),
      currentTier: asString(row.currentTier),
      currentTierScore: asNumber(row.currentTierScore),
      averageTier: asString(row.averageTier),
      averageTierScore: asNumber(row.averageTierScore),
      bestTier: asString(row.bestTier),
      bestTierScore: asNumber(row.bestTierScore),
      actionStatus: asString(row.actionStatus),
      estimatedProfitRisk: asNumber(row.estimatedProfitRisk),
      estimatedProfitRiskBasis: asString(row.estimatedProfitRiskBasis),
      moneyRiskStatus: asString(row.moneyRiskStatus),
      moneyRiskUncoveredDays: asNumber(row.moneyRiskUncoveredDays),
      moneyRiskInputs: toPlainRecord(row.moneyRiskInputs),
      salesVelocity: asNumber(row.salesVelocity),
      salesVelocityBasis: asString(row.salesVelocityBasis),
      salesVelocityStatus: asString(row.salesVelocityStatus),
      salesVelocityWindowStart: asString(row.salesVelocityWindowStart),
      salesVelocityWindowEnd: asString(row.salesVelocityWindowEnd),
      salesVelocityAsOfDate: asString(row.salesVelocityAsOfDate),
      profitPerUnit: asNumber(row.profitPerUnit),
      recommendedBestQty: asNumber(row.recommendedBestQty),
      targetCoverDays: asNumber(row.targetCoverDays),
      suggestedReorderQty: asNumber(row.suggestedReorderQty),
      unitCost: asNumber(row.unitCost),
      unitCostSource: asString(row.unitCostSource),
      supplierAvailability: asString(row.supplierAvailability),
      leadTimeAvailability: asString(row.leadTimeAvailability),
      unitCostAvailability: asString(row.unitCostAvailability),
      profitAvailability: asString(row.profitAvailability),
      planningEligibilityStatus: asString(row.planningEligibilityStatus),
      planningEligibilityReason: asString(row.planningEligibilityReason),
      dataQualityStatus: asString(row.dataQualityStatus),
      dataQualityIssues: Array.isArray(row.dataQualityIssues) ? row.dataQualityIssues : [],
      inventoryAsOfDate: asString(row.inventoryAsOfDate),
      sourceFreshnessStatus: asString(row.sourceFreshnessStatus),
      commandCenterPane: asString(row.commandCenterPane),
      commandCenterPaneReason: asString(row.commandCenterPaneReason),
      estimatedOrderCost: asNumber(row.estimatedOrderCost),
      currentPlanningStock: asNumber(row.currentPlanningStock),
      sellableStock: asNumber(row.sellableStock),
      reservedStock: asNumber(row.reservedStock),
      pipelineStock: asNumber(row.pipelineStock),
      inboundStock: asNumber(row.inboundStock),
      orderedStock: asNumber(row.orderedStock),
      prepStock: asNumber(row.prepStock),
      daysOfCover: asNumber(row.daysOfCover),
      estimatedOosDate: asString(row.estimatedOosDate),
      daysUntilOos,
      latestSafeReorderDate: asString(row.latestSafeReorderDate),
      daysUntilSafeReorder: asNumber(row.daysUntilSafeReorder),
      leadTimeDays: asNumber(row.leadTimeDays),
      leadTimeFreshness: asString(row.leadTimeFreshness),
      supplierName: asString(row.supplierName),
      supplierSource: asString(row.supplierSource),
      supplierConfidence: asString(row.supplierConfidence),
      supplierOrderState: asString(row.supplierOrderState),
      supplierOrderId: asString(row.supplierOrderId),
      supplierOrderStatus: asString(row.supplierOrderStatus),
      supplierOrderRef: asString(row.supplierOrderRef),
      supplierOrderAuthorityStatus: asString(row.supplierOrderAuthorityStatus),
      supplierOrderAuthoritySource: asString(row.supplierOrderAuthoritySource),
      supplierOrderAuthorityTaskRef: asString(row.supplierOrderAuthorityTaskRef),
      supplierOrderAuthorityAsOf: asString(row.supplierOrderAuthorityAsOf),
      supplierOrderAuthorityEvidence: toPlainRecord(row.supplierOrderAuthorityEvidence),
      supplierOrderOpenQty: asNumber(row.supplierOrderOpenQty),
      supplierOrderReferenceOpenQty: asNumber(row.supplierOrderReferenceOpenQty),
      latestSupplierOrderActivityType: asString(row.latestSupplierOrderActivityType),
      latestSupplierOrderActivityAt: sortableDateValue(row.latestSupplierOrderActivityAt) || undefined,
      latestSupplierOrderActivityNote: asString(row.latestSupplierOrderActivityNote),
      latestSupplierOrderActivityActor: asString(row.latestSupplierOrderActivityActor),
      latestSupplierOrderActivityActorUserId: asRecordIdString(row.latestSupplierOrderActivityActorUserId),
      latestSupplierOrderActivityActorDisplayName: asString(row.latestSupplierOrderActivityActorDisplayName),
      latestSupplierOrderActivityActorEmail: asString(row.latestSupplierOrderActivityActorEmail),
      latestSupplierOrderActivitySource: asString(row.latestSupplierOrderActivitySource),
      openOrderCoverageQty: asNumber(row.openOrderCoverageQty),
      expectedArrivalDate: asString(row.expectedArrivalDate),
      expectedArrivalStatus: asString(row.expectedArrivalStatus),
      expectedArrivalSource: asString(row.expectedArrivalSource),
      expectedArrivalAsOf: asString(row.expectedArrivalAsOf),
      expectedArrivalConfidence: asString(row.expectedArrivalConfidence),
      expectedArrivalFreshness: asString(row.expectedArrivalFreshness),
      pipelineHealthStatus: asString(row.pipelineHealthStatus),
      stockoutGapDays: gapDays,
      stuck: asBoolean(row.stuck),
      stuckClassification: asString(row.stuckClassification),
      tierMovement: asString(row.tierMovement),
      recommendedEscalation: asString(row.recommendedEscalation),
      lastMonthQty: asNumber(row.lastMonthQty),
      sixMonthAverageQty: asNumber(row.sixMonthAverageQty),
      sixMonthWorstQty: asNumber(row.sixMonthWorstQty),
      sixMonthBestQty: asNumber(row.sixMonthBestQty),
      sixMonthMargin: asNumber(row.sixMonthMargin),
      evidence: toPlainRecord(row.evidence),
    };
  }

  private commandCenterDrawerRow(row: PlainRecord) {
    return {
      ...this.compactCommandCenterRow(row),
      stockBuckets: {
        sellableStock: asNumber(row.sellableStock),
        reservedStock: asNumber(row.reservedStock),
        pipelineStock: asNumber(row.pipelineStock),
        inboundStock: asNumber(row.inboundStock),
        orderedStock: asNumber(row.orderedStock),
        prepStock: asNumber(row.prepStock),
        awdStock: asNumber(row.awdStock),
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
        staleOrMissingLeadTime: digestRows.filter((row) => leadTimeNeedsReview(row.leadTimeFreshness)).length,
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
        staleLeadTimes: urgentRows.filter((row) => leadTimeNeedsReview(row.leadTimeFreshness)).slice(0, 25),
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
        'missing_inventory',
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
      leadTimeFreshness: ['fresh', 'default', 'stale', 'missing'],
    };
  }

  async refreshReadModel(query: InventoryPlanningQuery = {}) {
    const calculationDate = isoDate(query.calculationDate ?? new Date());
    const rows = await this.calculateRows({
      ...query,
      calculationDate,
      limit: query.limit ?? GOLD_SOURCE_RECORD_LIMIT,
    });
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
        const value = field === 'calculationDate' ? calculationDate : row[field] ?? null;
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error(`Ecobase inventory-planning refresh failed: ${naturalKey}.${field} must be finite.`);
        }
        values[field] = value;
      }
      const previousSnapshot = this.previousTierSnapshotForRow(row, previousRows, calculationDate);
      const sameTierRule =
        Boolean(previousSnapshot) && asString(previousSnapshot?.tierRuleVersion) === asString(row.tierRuleVersion);
      const previousTier = sameTierRule && isProfitTier(previousSnapshot?.tier) ? previousSnapshot.tier : undefined;
      values.previousTier = previousTier ?? null;
      values.tierMovement = sameTierRule ? profitTierMovement(row.tier, previousSnapshot?.tier) ?? null : null;
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

  private previousTierSnapshotForRow(row: PlainRecord, previousRows: PlainRecord[], calculationDate: string) {
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
      .sort((left, right) => String(right.calculationDate ?? '').localeCompare(String(left.calculationDate ?? '')))[0];
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

  private async supplierOrdersByLine(lines: PlainRecord[]) {
    const orderIds = [
      ...new Set(
        lines
          .map((line) => asString(line.orderId) ?? asString(line.supplierOrderId))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (orderIds.length === 0) return new Map<string, PlainRecord>();

    const orders = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({
        filter: { id: { $in: orderIds.map(asRecordIdFilterValue) } },
        limit: orderIds.length,
      })
    ).map(toPlainRecord);
    const companyIds = [
      ...new Set(orders.map((order) => asString(order.companyId)).filter((id): id is string => Boolean(id))),
    ];
    const supplierIds = [
      ...new Set(orders.map((order) => asString(order.supplierId)).filter((id): id is string => Boolean(id))),
    ];
    const [companies, suppliers] = await Promise.all([
      companyIds.length > 0
        ? this.db
            .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
            .find({ filter: { id: { $in: companyIds.map(asRecordIdFilterValue) } }, limit: companyIds.length })
        : [],
      supplierIds.length > 0
        ? this.db
            .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
            .find({ filter: { id: { $in: supplierIds.map(asRecordIdFilterValue) } }, limit: supplierIds.length })
        : [],
    ]).then((groups) => groups.map((group) => group.map(toPlainRecord)));
    const companyById = new Map(companies.map((company) => [asString(company.id), company]));
    const supplierById = new Map(suppliers.map((supplier) => [asString(supplier.id), supplier]));

    const entries: [string, PlainRecord][] = [];
    for (const order of orders) {
      const orderId = asString(order.id);
      if (!orderId) continue;
      const company = companyById.get(asString(order.companyId));
      const supplier = supplierById.get(asString(order.supplierId));
      const companyName = asString(company?.name) ?? asString(order.company);
      const orderRef = asString(order.orderRef) ?? asString(order.externalOrderRef) ?? orderId;
      const orderDate = asString(order.orderDate);
      const observedAt = orderDate ? `${orderDate}T00:00:00.000Z` : undefined;
      entries.push([
        orderId,
        {
          ...order,
          naturalKey: companyName ? `supplier-order:${companyName}:${orderRef}` : undefined,
          company: companyName,
          externalOrderRef: orderRef,
          status: silverOrderStatus(order),
          statusUpdatedAt: asString(order.updatedAt) ?? asString(order.statusUpdatedAt) ?? observedAt,
          lastMeaningfulUpdateAt:
            asString(order.updatedAt) ??
            asString(order.lastMeaningfulUpdateAt) ??
            asString(order.statusUpdatedAt) ??
            observedAt,
          sourceStage:
            asString(order.orderIntent) ?? asString(order.lifecyclePhase) ?? asString(order.sourceStage) ?? 'imported',
          supplierName: asString(supplier?.displayName) ?? asString(supplier?.name) ?? asString(order.supplierName),
        },
      ]);
    }
    return new Map(entries);
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
    if (rows.length === 0) return rows;

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
    const orderByRow = new Map<PlainRecord, PlainRecord>();
    const supplierOrderIds = new Set<string>();
    for (const row of rows) {
      const company = asString(row.company);
      const ref = asString(row.supplierOrderRef);
      if (!company || !ref) continue;
      const order = orderCache.get(`${company}:${ref}`) ?? {};
      orderByRow.set(row, order);
      const supplierOrderId = asString(order.id);
      if (supplierOrderId) supplierOrderIds.add(supplierOrderId);
    }

    const activitySupplierOrderId = (activity: PlainRecord) =>
      asString(activity.supplierOrderId) ??
      (asString(activity.entityType) === 'supplier_order' ? asString(activity.entityId) : undefined);
    const activityDate = (activity: PlainRecord) =>
      String(
        toPlainRecord(activity.contextSnapshotJson).occurredAt ??
          activity.occurredAt ??
          activity.createdAt ??
          activity.updatedAt ??
          '',
      );
    const latestByOrderId = new Map<string, PlainRecord>();
    const activities = (await activityRepo.find({ limit: 10000 })).map(toPlainRecord);
    for (const activity of activities) {
      if (asString(activity.deletedAt)) continue;
      const supplierOrderId = activitySupplierOrderId(activity);
      if (!supplierOrderId || !supplierOrderIds.has(supplierOrderId)) continue;
      const current = latestByOrderId.get(supplierOrderId);
      if (!current || activityDate(activity).localeCompare(activityDate(current)) > 0) {
        latestByOrderId.set(supplierOrderId, activity);
      }
    }
    const latestActivities = await this.withActivityAuthors([...latestByOrderId.values()]);
    const latestWithAuthorsByOrderId = new Map(
      latestActivities
        .map((activity): [string, PlainRecord] | undefined => {
          const supplierOrderId = activitySupplierOrderId(activity);
          return supplierOrderId ? [supplierOrderId, activity] : undefined;
        })
        .filter((entry): entry is [string, PlainRecord] => Boolean(entry)),
    );

    return rows.map((row) => {
      const order = orderByRow.get(row) ?? {};
      const supplierOrderId = asString(order.id);
      const latestActivity = (supplierOrderId ? latestWithAuthorsByOrderId.get(supplierOrderId) : undefined) ?? {};
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
      return {
        ...row,
        supplierOrderId,
        latestSupplierOrderActivityType:
          asString(latestActivity.commentType) ?? asString(latestActivity.activityType) ?? 'order_status',
        latestSupplierOrderActivityAt: fallbackActivityAt ? sortableDateValue(fallbackActivityAt) : undefined,
        latestSupplierOrderActivityNote:
          asString(latestActivity.body) ?? asString(latestActivity.notes) ?? fallbackActivityNote,
        latestSupplierOrderActivityActor: asString(activityContext.actor) ?? asString(latestActivity.actor),
        latestSupplierOrderActivityActorUserId: asRecordIdString(latestActivity.actorUserId),
        latestSupplierOrderActivityActorDisplayName: asString(latestActivity.actorDisplayName),
        latestSupplierOrderActivityActorEmail: asString(latestActivity.actorEmail),
        latestSupplierOrderActivitySource: asString(activityContext.source),
      };
    });
  }

  private async findOrderLinesByProduct(params: {
    company?: string;
    asin?: string;
    sku?: string;
  }): Promise<PlainRecord[]> {
    const productFilter = params.asin
      ? { asin: params.asin.toUpperCase() }
      : params.sku
        ? { sku: params.sku }
        : undefined;
    if (!productFilter) return [];

    const [company] = params.company
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
            .find({ filter: { name: params.company }, limit: 1 })
        ).map(toPlainRecord)
      : [];
    const companyId = asString(company?.id);
    const products = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ filter: productFilter, limit: 5000 })
    ).map(toPlainRecord);
    const productIds = products.map((product) => asString(product.id)).filter((id): id is string => Boolean(id));
    if (productIds.length === 0) return [];

    const companyProductFilter: PlainRecord = { productId: { $in: productIds.map(asRecordIdFilterValue) } };
    if (companyId) companyProductFilter.companyId = companyId;
    const companyProducts = (
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
        .find({ filter: companyProductFilter, limit: 10000 })
    ).map(toPlainRecord);
    const companyProductIds = companyProducts
      .map((companyProduct) => asString(companyProduct.id))
      .filter((id): id is string => Boolean(id));
    if (companyProductIds.length === 0) return [];

    const rawLines = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).find({
        filter: { companyProductId: { $in: companyProductIds.map(asRecordIdFilterValue) } },
        limit: 10000,
      })
    ).map(toPlainRecord);
    if (rawLines.length === 0) return [];

    const orderIds = [
      ...new Set(rawLines.map((line) => asString(line.orderId)).filter((id): id is string => Boolean(id))),
    ];
    const supplierProductIds = [
      ...new Set(rawLines.map((line) => asString(line.supplierProductId)).filter((id): id is string => Boolean(id))),
    ];
    const [orders, supplierProducts] = await Promise.all([
      orderIds.length > 0
        ? this.db
            .getRepository(ECOBASE_COLLECTIONS.silverOrders)
            .find({ filter: { id: { $in: orderIds.map(asRecordIdFilterValue) } }, limit: orderIds.length })
        : [],
      supplierProductIds.length > 0
        ? this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).find({
            filter: { id: { $in: supplierProductIds.map(asRecordIdFilterValue) } },
            limit: supplierProductIds.length,
          })
        : [],
    ]).then((groups) => groups.map((group) => group.map(toPlainRecord)));
    const supplierIds = [
      ...new Set(
        [
          ...orders.map((order) => asString(order.supplierId)),
          ...supplierProducts.map((product) => asString(product.supplierId)),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const suppliers = supplierIds.length
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
            .find({ filter: { id: { $in: supplierIds.map(asRecordIdFilterValue) } }, limit: supplierIds.length })
        ).map(toPlainRecord)
      : [];

    const productById = new Map(products.map((product) => [asString(product.id), product]));
    const companyProductById = new Map(
      companyProducts.map((companyProduct) => [asString(companyProduct.id), companyProduct]),
    );
    const supplierProductById = new Map(supplierProducts.map((product) => [asString(product.id), product]));
    const supplierById = new Map(suppliers.map((supplier) => [asString(supplier.id), supplier]));
    const orderById = new Map(orders.map((order) => [asString(order.id), order]));

    return rawLines
      .map((line) => {
        const orderId = asString(line.orderId) ?? asString(line.supplierOrderId);
        const order = orderById.get(orderId);
        const companyProduct = companyProductById.get(asString(line.companyProductId));
        const supplierProduct = supplierProductById.get(asString(line.supplierProductId));
        const product = productById.get(asString(companyProduct?.productId) ?? asString(supplierProduct?.productId));
        const supplierId =
          asString(order?.supplierId) ?? asString(supplierProduct?.supplierId) ?? asString(line.supplierId);
        const supplier = supplierById.get(supplierId);
        const orderDate = asString(order?.orderDate);
        return {
          ...line,
          supplierOrderId: orderId,
          company: params.company,
          supplierId,
          supplierName: asString(supplier?.displayName) ?? asString(supplier?.name) ?? asString(line.supplierName),
          planningProductId: asString(line.companyProductId) ?? asString(line.planningProductId),
          companyProductId: asString(line.companyProductId) ?? asString(line.planningProductId),
          asin: asString(product?.asin)?.toUpperCase() ?? asString(line.asin)?.toUpperCase(),
          sku: asString(product?.sku) ?? asString(supplierProduct?.supplierSku) ?? asString(line.sku),
          title: asString(product?.title) ?? asString(line.title),
          brand: asString(product?.brand) ?? asString(line.brand),
          orderedQty: asNumber(line.orderedQty) ?? 0,
          receivedQty: asNumber(line.confirmedQty) ?? asNumber(line.receivedQty) ?? 0,
          unitCost: asNumber(line.unitCost) ?? asNumber(supplierProduct?.unitCost),
          expectedDeliveryDate: asString(line.expectedDeliveryDate) ?? asString(order?.expectedDeliveryDate),
          expectedArrivalDate: asString(line.expectedArrivalDate) ?? asString(line.expectedSellableDate),
          observedAt: orderDate ? `${orderDate}T00:00:00.000Z` : undefined,
          sourceStage: asString(order?.orderIntent) ?? asString(order?.lifecyclePhase) ?? 'imported',
          sourceOrderLineRef:
            asString(line.sourceOrderLineRef) ??
            [asString(order?.orderRef), asString(product?.asin), asString(product?.sku)].filter(Boolean).join(':'),
        };
      })
      .sort((left, right) => String(right.observedAt ?? '').localeCompare(String(left.observedAt ?? '')));
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
    targetCoverDays: number;
    currentPlanningStock: number;
    openOrderCoverageQty: number;
  }) {
    if (!params.salesVelocity || params.salesVelocity <= 0) return 0;
    const neededUnits = params.salesVelocity * params.targetCoverDays;
    return Math.max(Math.ceil(neededUnits - params.currentPlanningStock - params.openOrderCoverageQty), 0);
  }

  private actionStatus(params: {
    excluded: boolean;
    salesVelocity?: number;
    salesVelocityStatus?: string;
    leadTimeFreshness: string;
    daysUntilSafeReorder?: number;
    orderSoonWindowDays: number;
    openOrderCoverageQty: number;
  }): InventoryPlanningActionStatus {
    if (params.excluded) return 'excluded';
    if (params.salesVelocityStatus === 'trusted_zero') return 'no_sell_through';
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
