import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { isReliableSupplierOrderCoverageStatus, normalizeSupplierOrderStatus } from './supplier-order-service';
import { toPlainRecord } from './import-service';
import { EcobasePlanningCalculationService } from './planning-calculation-service';
import { isProfitTier, profitTierFor, profitTierMovement, profitTierRank } from './profit-tier';

const DEFAULT_LEAD_TIME_FRESHNESS_DAYS = 60;
const DEFAULT_ORDER_SOON_WINDOW_DAYS = 14;
const DEFAULT_REORDER_CYCLE_DAYS = 30;
const DEFAULT_SAFETY_BUFFER_DAYS = 7;
const FALLBACK_RECORD_LIMIT = 100000;
const ORDER_PLACED_NOT_PURCHASED_STATUSES = new Set([
  'draft',
  'supplier_contacted',
  'supplier_confirmed',
  'approval_pending',
  'payment_pending',
  'blocked',
]);
const ACTIVE_PURCHASED_PIPELINE_STATUSES = new Set(['paid', 'supplier_preparing', 'shipped_inbound']);
const PURCHASED_PIPELINE_GRACE_DAYS = 3;

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
  limit?: number;
}

export interface InventoryBudgetOptimizationQuery extends InventoryPlanningQuery {
  budget: number;
  horizonDays?: number;
}

type PlainRecord = Record<string, unknown>;

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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

function isoDate(value: string | Date) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = value.includes('T') ? value : `${value}T00:00:00.000Z`;
  return new Date(normalized).toISOString().slice(0, 10);
}

function dateOnly(value: unknown) {
  const text = asString(value);
  if (!text) return undefined;
  const date = new Date(text.includes('T') ? text : `${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function profitMetricKey(company: string, asin: string, sku?: string) {
  return `${company}:${asin.toUpperCase()}:${sku ?? ''}`;
}

function diffDays(left: string, right: string) {
  const leftDate = new Date(`${left}T00:00:00.000Z`).getTime();
  const rightDate = new Date(`${right}T00:00:00.000Z`).getTime();
  return Math.round((leftDate - rightDate) / 86_400_000);
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + Math.floor(days));
  return isoDate(next);
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

function supplierCoverageStatus(order: PlainRecord) {
  const status = normalizeSupplierOrderStatus(asString(order.status));
  if (['completed', 'rejected', 'cancelled'].includes(status)) return status;
  if (includesStatusText(order.paymentStatus, ['completed', 'complete', 'paid'])) return 'paid';
  if (status === 'approval_pending' && includesStatusText(order.approvalStatus, ['approved'])) return 'payment_pending';
  return status;
}

function isPlacedNotPurchasedSupplierOrderStatus(status: string | undefined) {
  return status ? ORDER_PLACED_NOT_PURCHASED_STATUSES.has(status) : false;
}

function isActivePurchasedPipelineStatus(status: string | undefined) {
  return status ? ACTIVE_PURCHASED_PIPELINE_STATUSES.has(status) : false;
}

function isActivePurchasedPipelineDate(line: PlainRecord, order: PlainRecord, calculationDate?: string) {
  if (!calculationDate) return true;
  const expectedSellableDate =
    asString(line.expectedSellableDate) ?? asString(line.expectedDeliveryDate) ?? asString(order.expectedDeliveryDate);
  if (!expectedSellableDate) return true;
  return diffDays(isoDate(expectedSellableDate), calculationDate) >= -PURCHASED_PIPELINE_GRACE_DAYS;
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
  calculationDate?: string,
) {
  let purchasedOpenQty = 0;
  let placedNotPurchasedOpenQty = 0;
  let latestPlaced: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;
  let latestPurchased: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;
  let historySelected: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;

  for (const line of lines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order);
    const orderedQty = asNumber(line.orderedQty) ?? 0;
    const receivedQty = asNumber(line.receivedQty) ?? 0;
    const openQty = Math.max(orderedQty - receivedQty, 0);
    const sortValue = supplierOrderSortValue(line, order);
    if (!historySelected || sortValue > historySelected.sortValue) {
      historySelected = { line, order, sortValue };
    }
    if (openQty <= 0 || !isPlacedNotPurchasedSupplierOrderStatus(status)) continue;
    placedNotPurchasedOpenQty += openQty;
    if (!latestPlaced || sortValue > latestPlaced.sortValue) {
      latestPlaced = { line, order, sortValue };
    }
  }

  for (const line of lines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order);
    const orderedQty = asNumber(line.orderedQty) ?? 0;
    const receivedQty = asNumber(line.receivedQty) ?? 0;
    const openQty = Math.max(orderedQty - receivedQty, 0);
    if (openQty <= 0 || !isReliableSupplierOrderCoverageStatus(status)) continue;
    const sortValue = supplierOrderSortValue(line, order);
    const newerRecoveryCycleStarted = latestPlaced && latestPlaced.sortValue > sortValue;
    if (
      newerRecoveryCycleStarted ||
      !isActivePurchasedPipelineStatus(status) ||
      !isActivePurchasedPipelineDate(line, order, calculationDate)
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
    supplierOrderStatus: reference?.order ? supplierCoverageStatus(reference.order) : undefined,
    supplierOrderRef: asString(reference?.order.externalOrderRef) ?? asString(reference?.order.id),
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

function selectSupplierLink(links: PlainRecord[]) {
  const active = links.filter((link) => asBoolean(link.active) !== false);
  return (
    active.find((link) => asString(link.role) === 'preferred') ??
    active.find((link) => asString(link.role) === 'latest_history') ??
    active.find((link) => asString(link.role) === 'candidate') ??
    active.find((link) => asString(link.role) === 'discovered') ??
    active[0]
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
  'previousTier',
  'tierMovement',
  'profitPerUnit',
  'estimatedProfitRisk',
  'estimatedProfitRiskBasis',
  'recommendedBestQty',
  'salesVelocity',
  'suggestedReorderQty',
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

  private async calculateRows(query: InventoryPlanningQuery = {}) {
    const calculationDate = isoDate(query.calculationDate ?? new Date());
    const safetyBufferDays = query.safetyBufferDays ?? DEFAULT_SAFETY_BUFFER_DAYS;
    const orderSoonWindowDays = query.orderSoonWindowDays ?? DEFAULT_ORDER_SOON_WINDOW_DAYS;
    const leadTimeFreshnessDays = query.leadTimeFreshnessDays ?? DEFAULT_LEAD_TIME_FRESHNESS_DAYS;
    const reorderCycleDays = query.reorderCycleDays ?? DEFAULT_REORDER_CYCLE_DAYS;
    const productFilter = query.company ? { company: query.company } : {};
    const scanLimit = query.limit ? Math.max(query.limit, Math.min(query.limit * 4, 500)) : undefined;
    const products = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).find({
        filter: productFilter,
        ...(scanLimit ? { limit: scanLimit } : {}),
      })
    )
      .map(toPlainRecord)
      .filter((product) => asString(toPlainRecord(product.auditSummary).source) !== 'inventory_planning_fallback');

    if (products.length === 0) {
      return this.listFallbackRows({
        company: query.company,
        calculationDate,
        leadTimeFreshnessDays,
        orderSoonWindowDays,
        safetyBufferDays,
        reorderCycleDays,
        limit: query.limit,
        scanLimit,
      });
    }

    const rows = [] as PlainRecord[];
    for (const product of products) {
      const planningProductId = asString(product.id);
      if (!planningProductId) continue;
      const calculation = toPlainRecord(
        await new EcobasePlanningCalculationService(this.db).calculatePlanningProduct({
          planningProductId,
          calculationDate,
          safetyBufferDays,
          persist: false,
        }),
      );
      rows.push(
        await this.buildRow({
          product,
          calculation,
          calculationDate,
          leadTimeFreshnessDays,
          orderSoonWindowDays,
          reorderCycleDays,
        }),
      );
    }

    return this.sortPlanningRows(rows).slice(0, query.limit ?? rows.length);
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
    const orderFilter = query.company ? { company: query.company } : {};
    const supplierOrders = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).find({
        filter: orderFilter,
        sort: ['-lastMeaningfulUpdateAt'],
        limit: 1000,
      })
    ).map(toPlainRecord);
    const supplierOrderLines = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).find({
        filter: orderFilter,
        sort: ['-observedAt'],
        limit: 5000,
      })
    ).map(toPlainRecord);
    const suppliers = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).find({
        filter: orderFilter,
        sort: ['company', 'name'],
        limit: 2000,
      })
    ).map(toPlainRecord);
    const supplierNameById = new Map(
      suppliers
        .map((supplier) => [asString(supplier.id), asString(supplier.name)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
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
            supplierName:
              supplierNameById.get(asString(existingOrder.supplierId) ?? '') ?? asString(existingOrder.supplierName),
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
      .map((candidate) => {
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
    limit?: number;
    scanLimit?: number;
  }) {
    const activeSourceConnectionIds = await this.activeSourceConnectionIds();
    const sourceConnectionCompanies = await this.sourceConnectionCompanies();
    const inventoryRows = (
      await this.findFallbackRecords(ECOBASE_COLLECTIONS.inventorySnapshots, {
        company: params.company,
        sourceConnectionCompanies,
        activeSourceConnectionIds,
        sort: ['-snapshotDate'],
        limit: params.scanLimit,
      })
    ).filter((row) => {
      const snapshotDate = dateOnly(row.snapshotDate);
      return Boolean(snapshotDate && snapshotDate <= params.calculationDate);
    });
    const parameterRows = await this.findFallbackRecords(ECOBASE_COLLECTIONS.planningParameters, {
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
    const parameterByProduct = new Map<string, PlainRecord>();
    for (const parameter of parameterRows) {
      const key = this.fallbackProductKey(parameter, sourceConnectionCompanies);
      if (key && !parameterByProduct.has(key)) {
        parameterByProduct.set(key, parameter);
      }
    }

    const seen = new Set<string>();
    const rows: PlainRecord[] = [];
    for (const inventory of inventoryRows) {
      const key = this.fallbackProductKey(inventory, sourceConnectionCompanies);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(
        await this.buildFallbackRow({
          inventory,
          parameter: parameterByProduct.get(key) ?? {},
          sourceConnectionCompanies,
          profitMetrics,
          calculationDate: params.calculationDate,
          leadTimeFreshnessDays: params.leadTimeFreshnessDays,
          orderSoonWindowDays: params.orderSoonWindowDays,
          safetyBufferDays: params.safetyBufferDays,
          reorderCycleDays: params.reorderCycleDays,
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
    const facts = await this.findFallbackRecords(ECOBASE_COLLECTIONS.listingDailyFacts, {
      company: params.company,
      sourceConnectionCompanies: params.sourceConnectionCompanies,
      activeSourceConnectionIds: await this.activeSourceConnectionIds(),
    });
    const start = monthStart(params.calculationDate);
    const index: ProfitMetricsIndex = { exact: new Map(), byAsin: new Map() };

    for (const fact of facts) {
      const snapshotDate = dateOnly(fact.snapshotDate);
      if (!snapshotDate || snapshotDate < start || snapshotDate > params.calculationDate) continue;
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

  private addProfitMetric(metrics: Map<string, ProfitMetrics>, key: string, fact: PlainRecord) {
    const metric = metrics.get(key) ?? { sales: 0, units: 0, profit: 0, refunds: 0 };
    metric.sales += asNumber(fact.sales) ?? 0;
    metric.units += asNumber(fact.units) ?? 0;
    metric.profit += asNumber(fact.netProfit) ?? asNumber(fact.profit) ?? 0;
    metric.refunds += asNumber(fact.refunds) ?? 0;
    metric.profitPerUnit = metric.units > 0 ? metric.profit / metric.units : undefined;
    metrics.set(key, metric);
  }

  private profitMetricsFor(metrics: ProfitMetricsIndex, company: string, asin?: string, sku?: string) {
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
    calculationDate: string;
    leadTimeFreshnessDays: number;
    orderSoonWindowDays: number;
    safetyBufferDays: number;
    reorderCycleDays: number;
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
    const orderHistoryLeadTime =
      typeof importedLeadTimeDays !== 'number' && asString(orderHistorySupplier.supplierId)
        ? await this.findLeadTime(
            { id: asString(orderHistorySupplier.supplierId), name: asString(orderHistorySupplier.supplierName) },
            {},
            {},
            company,
            undefined,
            asin,
            sku,
          )
        : {};
    const orderHistoryLines = await this.findOrderLinesByProduct({ company, asin, sku });
    const orderHistoryDerivedLeadTime = this.leadTimeFromOrderHistory(
      orderHistoryLines,
      await this.supplierOrdersByLine(orderHistoryLines),
    );
    const leadTimeDays =
      importedLeadTimeDays ?? asNumber(orderHistoryLeadTime.leadTimeDays) ?? orderHistoryDerivedLeadTime.leadTimeDays;
    const recommendedBestQty =
      asNumber(params.inventory.recommendedReorderQuantity) ??
      payloadNumber(params.inventory, ['Recommended quantity for  reordering']) ??
      payloadNumber(params.parameter, ['recommendedBestQty', 'Rec.Best Qty', 'Rec. Best Qty']);
    const profitPerUnit =
      asNumber(params.parameter.profitPerUnit) ??
      payloadNumber(params.parameter, ['profitPerUnit', 'Profit Per Unit', 'Per.Unit Profit']) ??
      sellerboardProfitMetrics?.profitPerUnit;
    const importedProfitRisk =
      payloadNumber(params.inventory, ['Missed profit (est)', 'Profit forecast (30 days)', 'profitForecast30Days']) ??
      payloadNumber(params.parameter, ['Missed profit (est)', 'Profit forecast (30 days)', 'profitForecast30Days']);
    const { tier, tierScore } = profitTierFor(profitPerUnit, recommendedBestQty);
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
    });
    const openOrderCoverageQty = supplierOrderState.supplierOrderPurchasedOpenQty;
    const expectedSellableDate = await this.earliestFallbackExpectedSellableDate({ company, asin, sku });
    const suggestedReorderQty = this.suggestedReorderQuantity({
      salesVelocity,
      leadTimeDays,
      safetyBufferDays: params.safetyBufferDays,
      reorderCycleDays: params.reorderCycleDays,
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
      stuck: stockBuckets.sellableStock > stockBuckets.reservedStock,
      daysOfCover,
      estimatedOosDate,
      latestSafeReorderDate,
      daysUntilSafeReorder,
      actionStatus,
      suggestedReorderQty,
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
        estimatedProfitRiskBasis,
        sellerboardProfitMetrics,
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
  }) {
    const planningProductId = asString(params.product.id) ?? '';
    const company = asString(params.product.company);
    const inventoryRows = await findRecords(this.db, ECOBASE_COLLECTIONS.inventorySnapshots, { planningProductId });
    const parameterRows = await findRecords(this.db, ECOBASE_COLLECTIONS.planningParameters, { planningProductId });
    const supplierLinks = await findRecords(this.db, ECOBASE_COLLECTIONS.supplierProductLinks, { planningProductId });
    let orderLines = await findRecords(this.db, ECOBASE_COLLECTIONS.supplierOrderLines, { planningProductId });
    const latestInventory = latestByDate(inventoryRows, 'snapshotDate') ?? {};
    const latestParameter = latestByDate(parameterRows, 'lastImportRunId') ?? parameterRows[0] ?? {};
    const supplierLink = selectSupplierLink(supplierLinks) ?? {};
    const supplier = await this.findSupplier(supplierLink, latestParameter, company);
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
    const supplierOrderState = summarizeSupplierOrderState(orderLines, supplierOrderById, params.calculationDate);
    const openOrderCoverageQty = supplierOrderState.supplierOrderPurchasedOpenQty;
    const orderHistorySupplier =
      !asString(supplier.name) && !asString(latestParameter.supplier)
        ? await this.findOrderHistorySupplier({ company, asin, sku })
        : {};
    let leadTime = await this.findLeadTime(
      supplier,
      supplierLink,
      latestParameter,
      company,
      planningProductId,
      asin,
      sku,
    );
    if (typeof asNumber(leadTime.leadTimeDays) !== 'number' && asString(orderHistorySupplier.supplierId)) {
      leadTime = await this.findLeadTime(
        { id: asString(orderHistorySupplier.supplierId), name: asString(orderHistorySupplier.supplierName) },
        {},
        {},
        company,
        planningProductId,
        asin,
        sku,
      );
    }
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
            -(leadTimeDays + (asNumber(params.calculation.safetyBufferDays) ?? DEFAULT_SAFETY_BUFFER_DAYS)),
          )
        : undefined;
    const latestSafeReorderDate = calculationSafeReorderDate ?? derivedSafeReorderDate;
    const daysUntilSafeReorder = latestSafeReorderDate
      ? diffDays(latestSafeReorderDate, params.calculationDate)
      : undefined;
    const suggestedReorderQty = this.suggestedReorderQuantity({
      salesVelocity,
      leadTimeDays,
      safetyBufferDays: asNumber(params.calculation.safetyBufferDays) ?? DEFAULT_SAFETY_BUFFER_DAYS,
      reorderCycleDays: params.reorderCycleDays,
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
      asString(supplier.name) ??
      asString(leadTime.supplierName) ??
      asString(latestParameter.supplier) ??
      asString(orderHistorySupplier.supplierName);
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
      brand:
        payloadString(supplierLink, ['latestBrand', 'brand']) ?? payloadString(latestParameter, ['Brand', 'brand']),
      productStatus,
      planningExcluded: excluded,
      tier,
      tierScore: asNumber(params.calculation.tierScore) ?? fallbackTier.tierScore,
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
      stuck: stockBuckets.sellableStock > stockBuckets.reservedStock,
      daysOfCover: asNumber(params.calculation.daysOfCover),
      estimatedOosDate: asString(params.calculation.oosDate),
      latestSafeReorderDate,
      daysUntilSafeReorder,
      actionStatus,
      suggestedReorderQty,
      supplierId:
        asString(supplier.id) ??
        asString(supplierLink.supplierId) ??
        asString(latestParameter.supplierId) ??
        asString(orderHistorySupplier.supplierId),
      supplierName,
      supplierSource:
        asString(supplierLink.source) ??
        (asString(orderHistorySupplier.supplierName) ? 'order_details_history' : 'planning_parameter'),
      supplierRole:
        asString(supplierLink.role) ??
        (asString(orderHistorySupplier.supplierName) ? 'latest_order_history' : 'latest_history'),
      supplierConfidence:
        asString(supplierLink.confidence) ?? (asString(orderHistorySupplier.supplierName) ? 'medium' : 'medium'),
      leadTimeDays,
      leadTimeConfirmedAt,
      leadTimeFreshness,
      leadTimeSource: supplierName ? 'supplier_or_planning_parameter' : 'planning_parameter_without_supplier_mapping',
      openOrderCoverageQty,
      ...supplierOrderState,
      expectedSellableDate: this.earliestExpectedSellableDate(orderLines),
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
        suggestedReorderQuantityFormula:
          'max((velocity * (leadTimeDays + safetyBufferDays + reorderCycleDays)) - totalPlanningStock - openOrderCoverageQty, 0)',
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

  private async sourceConnectionCompanies() {
    const connections = (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({}))
      .map(toPlainRecord)
      .filter((connection) => asBoolean(connection.active) !== false);
    const companyRows = (await this.db.getRepository(ECOBASE_COLLECTIONS.companies).find({})).map(toPlainRecord);
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

  private async findSupplier(link: PlainRecord, parameter: PlainRecord, company?: string) {
    const supplierRepo = this.db.getRepository(ECOBASE_COLLECTIONS.suppliers);
    const linkSupplierId = asString(link.supplierId);
    const parameterSupplierId = asString(parameter.supplierId);
    const byLinkId = linkSupplierId ? toPlainRecord(await supplierRepo.findOne({ filterByTk: linkSupplierId })) : {};
    if (asString(byLinkId.id)) return byLinkId;
    const byParameterId = parameterSupplierId
      ? toPlainRecord(await supplierRepo.findOne({ filterByTk: parameterSupplierId }))
      : {};
    if (asString(byParameterId.id)) return byParameterId;
    const supplierName = asString(parameter.supplier);
    return supplierName
      ? toPlainRecord(await supplierRepo.findOne({ filter: { name: supplierName, ...(company ? { company } : {}) } }))
      : {};
  }

  private async supplierOrderStateForProduct(params: {
    company?: string;
    asin?: string;
    sku?: string;
    calculationDate?: string;
  }) {
    const lines = await this.findOrderLinesByProduct(params);
    return summarizeSupplierOrderState(lines, await this.supplierOrdersByLine(lines), params.calculationDate);
  }

  private async supplierOrdersByLine(lines: PlainRecord[]) {
    const supplierOrderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const supplierOrderById = new Map<string, PlainRecord>();
    for (const line of lines) {
      const supplierOrderId = asString(line.supplierOrderId);
      if (supplierOrderId && !supplierOrderById.has(supplierOrderId)) {
        supplierOrderById.set(
          supplierOrderId,
          toPlainRecord(await supplierOrderRepo.findOne({ filterByTk: supplierOrderId })),
        );
      }
    }
    return supplierOrderById;
  }

  private async withLatestSupplierOrderActivity(rows: PlainRecord[]) {
    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const activityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities);
    const orderCache = new Map<string, PlainRecord>();
    const result: PlainRecord[] = [];
    for (const row of rows) {
      const company = asString(row.company);
      const ref = asString(row.supplierOrderRef);
      if (!company || !ref) {
        result.push(row);
        continue;
      }
      const cacheKey = `${company}:${ref}`;
      let order = orderCache.get(cacheKey);
      if (!order) {
        order = toPlainRecord(await orderRepo.findOne({ filter: { company, externalOrderRef: ref } }));
        orderCache.set(cacheKey, order);
      }
      const supplierOrderId = asString(order.id);
      const latestActivity = supplierOrderId
        ? toPlainRecord(
            (
              await activityRepo.find({
                filter: { supplierOrderId },
                sort: ['-occurredAt'],
                limit: 1,
              })
            )[0],
          )
        : {};
      result.push({
        ...row,
        supplierOrderId,
        latestSupplierOrderActivityType: asString(latestActivity.activityType),
        latestSupplierOrderActivityAt: sortableDateValue(latestActivity.occurredAt),
        latestSupplierOrderActivityNote: asString(latestActivity.notes),
      });
    }
    return result;
  }

  private leadTimeFromOrderHistory(orderLines: PlainRecord[], supplierOrderById: Map<string, PlainRecord>) {
    const candidates = orderLines
      .map((line) => {
        const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '') ?? {};
        const start = dateOnly(order.orderDate) ?? dateOnly(line.observedAt);
        const end =
          dateOnly(line.expectedSellableDate) ??
          dateOnly(line.expectedDeliveryDate) ??
          dateOnly(order.expectedDeliveryDate);
        const leadTimeDays = start && end ? diffDays(end, start) : undefined;
        return {
          leadTimeDays,
          confirmedAt: dateOnly(line.observedAt) ?? dateOnly(order.orderDate),
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
    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const filters: PlainRecord[] = [];
    if (params.asin) filters.push({ asin: params.asin, ...(params.company ? { company: params.company } : {}) });
    if (params.sku) filters.push({ sku: params.sku, ...(params.company ? { company: params.company } : {}) });
    const byId = new Map<string, PlainRecord>();
    for (const filter of filters) {
      const lines = (await lineRepo.find({ filter, limit: 100 })).map(toPlainRecord);
      for (const line of lines) {
        const id =
          asString(line.id) ?? `${asString(line.supplierOrderId) ?? ''}:${asString(line.sourceOrderLineRef) ?? ''}`;
        byId.set(id, line);
      }
    }
    return [...byId.values()];
  }

  private async findOrderHistorySupplier(params: { company?: string; asin?: string; sku?: string }) {
    const filters: PlainRecord[] = [];
    if (params.asin) filters.push({ asin: params.asin, ...(params.company ? { company: params.company } : {}) });
    if (params.sku) filters.push({ sku: params.sku, ...(params.company ? { company: params.company } : {}) });
    for (const filter of filters) {
      const lines = (
        await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).find({ filter, limit: 20 })
      ).map(toPlainRecord);
      const latestLine = latestByDate(lines, 'observedAt') ?? latestByDate(lines, 'expectedDeliveryDate') ?? lines[0];
      const supplierId = asString(latestLine?.supplierId);
      if (!supplierId) continue;
      const supplier = toPlainRecord(
        await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).findOne({ filterByTk: supplierId }),
      );
      return {
        supplierId,
        supplierName:
          asString(supplier.name) ?? payloadString(latestLine, ['Supplier', 'Supplier Name', 'supplierName']),
        evidence: {
          source: 'supplier_order_lines',
          sourceOrderLineRef: asString(latestLine.sourceOrderLineRef),
          observedAt: asString(latestLine.observedAt),
        },
      };
    }
    return {};
  }

  private async findLeadTime(
    supplier: PlainRecord,
    link: PlainRecord,
    parameter: PlainRecord,
    company?: string,
    planningProductId?: string,
    asin?: string,
    sku?: string,
  ) {
    const leadTimeRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes);
    const supplierRefId = asString(supplier.id) ?? asString(link.supplierId);
    const externalSupplierCode = asString(supplier.supplierId) ?? asString(parameter.supplierId);
    const supplierName = asString(supplier.name) ?? asString(parameter.supplier);
    const scoped = (filter: PlainRecord) => ({ ...filter, ...(company ? { company } : {}) });
    const findScoped = async (base: PlainRecord) => {
      const productScopedRows = planningProductId
        ? (
            await leadTimeRepo.find({
              filter: scoped({ ...base, planningProductId }),
              sort: ['-confirmedAt'],
              limit: 1,
            })
          ).map(toPlainRecord)
        : [];
      if (productScopedRows[0]) return productScopedRows[0];
      const productFilters = [
        ...(asin ? [{ ...base, asin: asin.toUpperCase(), scope: 'product' }] : []),
        ...(sku ? [{ ...base, sku, scope: 'product' }] : []),
      ];
      for (const filter of productFilters) {
        const productRows = (
          await leadTimeRepo.find({
            filter: scoped(filter),
            sort: ['-confirmedAt'],
            limit: 1,
          })
        ).map(toPlainRecord);
        if (productRows[0]) return productRows[0];
      }
      const orderHistoryRows = (
        await leadTimeRepo.find({
          filter: scoped({ ...base, source: 'order_details' }),
          sort: ['-confirmedAt'],
          limit: 1,
        })
      ).map(toPlainRecord);
      return orderHistoryRows[0] ?? {};
    };
    const bySupplierRef = supplierRefId ? await findScoped({ supplierRefId }) : {};
    if (asString(bySupplierRef.id) || typeof bySupplierRef.leadTimeDays === 'number') return bySupplierRef;
    const byExternalCode = externalSupplierCode ? await findScoped({ supplierId: externalSupplierCode }) : {};
    if (asString(byExternalCode.id) || typeof byExternalCode.leadTimeDays === 'number') return byExternalCode;
    return supplierName ? await findScoped({ supplierName }) : {};
  }

  private suggestedReorderQuantity(params: {
    salesVelocity?: number;
    leadTimeDays?: number;
    safetyBufferDays: number;
    reorderCycleDays: number;
    currentPlanningStock: number;
    openOrderCoverageQty: number;
  }) {
    if (!params.salesVelocity || params.salesVelocity <= 0 || typeof params.leadTimeDays !== 'number') {
      return 0;
    }
    const coverageTargetDays = params.leadTimeDays + params.safetyBufferDays + params.reorderCycleDays;
    const neededUnits = params.salesVelocity * coverageTargetDays;
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
