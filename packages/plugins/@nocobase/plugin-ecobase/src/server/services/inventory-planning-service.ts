import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { isReliableSupplierOrderCoverageStatus } from './supplier-order-service';
import { toPlainRecord } from './import-service';
import { EcobasePlanningCalculationService } from './planning-calculation-service';

const DEFAULT_LEAD_TIME_FRESHNESS_DAYS = 60;
const DEFAULT_ORDER_SOON_WINDOW_DAYS = 14;
const DEFAULT_REORDER_CYCLE_DAYS = 30;
const DEFAULT_SAFETY_BUFFER_DAYS = 7;

export type InventoryPlanningActionStatus =
  | 'excluded'
  | 'missing_velocity'
  | 'missing_lead_time'
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

type PlainRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  return normalized === 'not selling' || normalized === 'hold' || normalized === 'one time' || normalized === 'inactive' || normalized === 'discontinued' || normalized === 'do not reorder';
}

function tierFor(profitPerUnit?: number, recommendedBestQty?: number, fallbackTierScore?: number) {
  const tierScore =
    typeof profitPerUnit === 'number' && typeof recommendedBestQty === 'number'
      ? profitPerUnit * recommendedBestQty
      : typeof fallbackTierScore === 'number'
        ? fallbackTierScore
        : 0;
  if (tierScore >= 250) return { tier: 'A', tierScore };
  if (tierScore >= 100) return { tier: 'B', tierScore };
  return { tier: 'C', tierScore };
}

function tierRank(tier: unknown) {
  if (tier === 'A') return 0;
  if (tier === 'B') return 1;
  if (tier === 'C') return 2;
  return 3;
}

function actionRank(status: InventoryPlanningActionStatus) {
  return {
    overdue: 0,
    order_today: 1,
    missing_lead_time: 2,
    order_soon: 3,
    already_ordered: 4,
    watch: 5,
    sufficient_stock: 6,
    missing_velocity: 7,
    excluded: 8,
  }[status];
}

async function findRecords(db: EcobaseDatabase, collection: string, filter: PlainRecord) {
  return (await db.getRepository(collection).find({ filter })).map(toPlainRecord);
}

function latestByDate(records: PlainRecord[], field: string) {
  return [...records].sort((left, right) => String(right[field] ?? '').localeCompare(String(left[field] ?? '')))[0];
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

function companyLabelFromSourceConnection(connection: PlainRecord) {
  const explicit = asString(connection.company) ?? payloadString(connection, ['company', 'Company']);
  if (explicit) return explicit;
  const name = asString(connection.name);
  if (!name) return undefined;
  return name
    .replace(/^Sellerboard\s*-\s*/i, '')
    .replace(/\s*Sellerboard$/i, '')
    .trim();
}

function companyFromRecord(record: PlainRecord, sourceConnectionCompanies: Map<string, string>) {
  const direct = asString(record.company) ?? payloadString(record, ['company', 'Company']);
  if (direct) return direct;
  const sourceConnectionId = asString(record.sourceConnectionId);
  return sourceConnectionId ? sourceConnectionCompanies.get(sourceConnectionId) : undefined;
}

function stableUuid(value: string) {
  const hex = createHash('sha1').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0')}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
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
  'profitPerUnit',
  'estimatedProfitRisk',
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

    return rows
      .sort((left, right) => {
        const action = actionRank(left.actionStatus as InventoryPlanningActionStatus) - actionRank(right.actionStatus as InventoryPlanningActionStatus);
        if (action !== 0) return action;
        const tier = tierRank(left.tier) - tierRank(right.tier);
        if (tier !== 0) return tier;
        return (asNumber(right.estimatedProfitRisk) ?? 0) - (asNumber(left.estimatedProfitRisk) ?? 0);
      })
      .slice(0, query.limit ?? rows.length);
  }

  async digestPreview(query: InventoryPlanningQuery = {}) {
    const rows = await this.listRows(query);
    const urgentRows = this.sortDigestRows(rows.filter((row) => ['overdue', 'order_today', 'order_soon', 'missing_lead_time'].includes(String(row.actionStatus))));
    const supplierActionItems = this.sortDigestRows(
      urgentRows.filter((row) => !asString(row.supplierName) || row.leadTimeFreshness !== 'fresh' || row.actionStatus === 'missing_lead_time'),
    );
    return {
      generatedAt: new Date().toISOString(),
      company: query.company ?? null,
      summary: {
        overdue: rows.filter((row) => row.actionStatus === 'overdue').length,
        orderToday: rows.filter((row) => row.actionStatus === 'order_today').length,
        orderSoon: rows.filter((row) => row.actionStatus === 'order_soon').length,
        atRisk: urgentRows.length,
        staleOrMissingLeadTime: rows.filter((row) => row.leadTimeFreshness !== 'fresh').length,
        suppliersToContact: new Set(urgentRows.map((row) => row.supplierName).filter(Boolean)).size,
      },
      sections: {
        orderNow: urgentRows.filter((row) => row.actionStatus === 'overdue' || row.actionStatus === 'order_today').slice(0, 25),
        suppliersToContactFirst: this.rankSuppliers(supplierActionItems.length > 0 ? supplierActionItems : urgentRows).slice(0, 10),
        supplierActionItems: supplierActionItems.slice(0, 25),
        staleLeadTimes: urgentRows.filter((row) => row.leadTimeFreshness !== 'fresh').slice(0, 25),
      },
    };
  }

  async filterOptions() {
    const sourceConnectionCompanies = await this.sourceConnectionCompanies();
    const rows = await this.listRows({ limit: 500 });
    const companies = [...new Set([...sourceConnectionCompanies.values(), ...rows.map((row) => asString(row.company)).filter(Boolean)])].sort();
    const productStatuses = [...new Set(rows.map((row) => asString(row.productStatus)).filter(Boolean))].sort();
    return {
      companies,
      productStatuses,
      actionStatuses: ['overdue', 'order_today', 'missing_lead_time', 'order_soon', 'already_ordered', 'watch', 'sufficient_stock', 'excluded'],
      tiers: ['A', 'B', 'C'],
      leadTimeFreshness: ['fresh', 'stale', 'missing'],
    };
  }

  async refreshReadModel(query: InventoryPlanningQuery = {}) {
    const calculationDate = isoDate(query.calculationDate ?? new Date());
    const rows = await this.listRows({ ...query, calculationDate, limit: query.limit ?? 500 });
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.inventoryPlanningRows);
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
        values[field] = field === 'calculationDate' ? calculationDate : row[field];
      }
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
    const sourceConnectionCompanies = await this.sourceConnectionCompanies();
    const inventoryRows = await this.findFallbackRecords(ECOBASE_COLLECTIONS.inventorySnapshots, {
      company: params.company,
      sourceConnectionCompanies,
      sort: ['-snapshotDate'],
      limit: params.scanLimit,
    });
    const parameterRows = await this.findFallbackRecords(ECOBASE_COLLECTIONS.planningParameters, {
      company: params.company,
      sourceConnectionCompanies,
      limit: params.scanLimit ? Math.max(params.scanLimit * 2, 500) : undefined,
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
      rows.push(await this.buildFallbackRow({
        inventory,
        parameter: parameterByProduct.get(key) ?? {},
        sourceConnectionCompanies,
        calculationDate: params.calculationDate,
        leadTimeFreshnessDays: params.leadTimeFreshnessDays,
        orderSoonWindowDays: params.orderSoonWindowDays,
        safetyBufferDays: params.safetyBufferDays,
        reorderCycleDays: params.reorderCycleDays,
      }));
    }

    return rows
      .sort((left, right) => {
        const action = actionRank(left.actionStatus as InventoryPlanningActionStatus) - actionRank(right.actionStatus as InventoryPlanningActionStatus);
        if (action !== 0) return action;
        const tier = tierRank(left.tier) - tierRank(right.tier);
        if (tier !== 0) return tier;
        return (asNumber(right.estimatedProfitRisk) ?? 0) - (asNumber(left.estimatedProfitRisk) ?? 0);
      })
      .slice(0, params.limit ?? rows.length);
  }

  private fallbackProductKey(record: PlainRecord, sourceConnectionCompanies: Map<string, string>) {
    const company = companyFromRecord(record, sourceConnectionCompanies) ?? 'all-companies';
    const asin = asString(record.asin) ?? payloadString(record, ['ASIN', 'asin']);
    const sku = asString(record.sku) ?? payloadString(record, ['SKU', 'sku']);
    return asin || sku ? `${company}:${asin ?? ''}:${sku ?? ''}` : undefined;
  }

  private async buildFallbackRow(params: {
    inventory: PlainRecord;
    parameter: PlainRecord;
    sourceConnectionCompanies: Map<string, string>;
    calculationDate: string;
    leadTimeFreshnessDays: number;
    orderSoonWindowDays: number;
    safetyBufferDays: number;
    reorderCycleDays: number;
  }) {
    const company = companyFromRecord(params.inventory, params.sourceConnectionCompanies) ?? companyFromRecord(params.parameter, params.sourceConnectionCompanies);
    const asin = asString(params.inventory.asin) ?? asString(params.parameter.asin) ?? payloadString(params.inventory, ['ASIN']);
    const sku = asString(params.inventory.sku) ?? asString(params.parameter.sku) ?? payloadString(params.inventory, ['SKU']);
    const planningProductId = `fallback:${company ?? 'all'}:${asin ?? ''}:${sku ?? ''}`;
    const stockBuckets = this.stockBuckets(params.inventory, {});
    const salesVelocity = asNumber(params.inventory.salesVelocity) ?? payloadNumber(params.inventory, ['Estimated Sales Velocity', 'Exp Sales Vel', 'Sales Velocity']);
    const importedLeadTimeDays = asNumber(params.parameter.leadTimeDays) ?? payloadNumber(params.parameter, ['Lead Time', 'Avg Lead Time', 'Lead time(day)', 'Manuf. time days']);
    const orderHistorySupplier = !asString(params.parameter.supplier)
      ? await this.findOrderHistorySupplier({ company, asin, sku })
      : {};
    const orderHistoryLeadTime = typeof importedLeadTimeDays !== 'number' && asString(orderHistorySupplier.supplierId)
      ? await this.findLeadTime(
          { id: asString(orderHistorySupplier.supplierId), name: asString(orderHistorySupplier.supplierName) },
          {},
          {},
          company,
        )
      : {};
    const leadTimeDays = importedLeadTimeDays ?? asNumber(orderHistoryLeadTime.leadTimeDays);
    const recommendedBestQty =
      asNumber(params.inventory.recommendedReorderQuantity) ??
      payloadNumber(params.inventory, ['Recommended quantity for  reordering']) ??
      payloadNumber(params.parameter, ['recommendedBestQty', 'Rec.Best Qty', 'Rec. Best Qty']);
    const profitPerUnit = asNumber(params.parameter.profitPerUnit) ?? payloadNumber(params.parameter, ['profitPerUnit', 'Profit Per Unit', 'Per.Unit Profit']);
    const fallbackTierScore = payloadNumber(params.inventory, ['Missed profit (est)', 'Profit forecast (30 days)', 'profitForecast30Days']) ?? payloadNumber(params.parameter, ['Missed profit (est)', 'Profit forecast (30 days)', 'profitForecast30Days']);
    const { tier, tierScore } = tierFor(profitPerUnit, recommendedBestQty, fallbackTierScore);
    const daysOfCover = salesVelocity && salesVelocity > 0 ? stockBuckets.currentPlanningStock / salesVelocity : undefined;
    const estimatedOosDate = typeof daysOfCover === 'number' ? addDays(params.calculationDate, daysOfCover) : undefined;
    const latestSafeReorderDate =
      typeof leadTimeDays === 'number' && estimatedOosDate
        ? addDays(estimatedOosDate, -(leadTimeDays + params.safetyBufferDays))
        : undefined;
    const daysUntilSafeReorder = latestSafeReorderDate ? diffDays(latestSafeReorderDate, params.calculationDate) : undefined;
    const productStatus =
      payloadString(params.parameter, ['productStatus', 'Product Status', 'status', 'Status']) ??
      payloadString(params.inventory, ['productStatus', 'Product Status', 'status', 'Status']) ??
      'Active';
    const planningExcluded = isPlanningExcluded(productStatus);
    const leadTimeConfirmedAt = asString(orderHistoryLeadTime.confirmedAt) ?? asString(params.parameter.confirmedAt) ?? payloadString(params.parameter, ['confirmedAt', 'Lead Time Confirmed At']);
    const leadTimeAgeDays = daysSince(leadTimeConfirmedAt, params.calculationDate);
    const leadTimeFreshness =
      typeof leadTimeDays !== 'number'
        ? 'missing'
        : typeof leadTimeAgeDays === 'number' && leadTimeAgeDays > params.leadTimeFreshnessDays
          ? 'stale'
          : 'fresh';
    const openOrderCoverageQty = 0;
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
    const estimatedProfitRisk =
      typeof riskDays === 'number' && typeof profitPerUnit === 'number' && typeof salesVelocity === 'number'
        ? riskDays * salesVelocity * profitPerUnit
        : fallbackTierScore;
    const estimatedProfitRiskBasis =
      typeof riskDays === 'number' && typeof profitPerUnit === 'number' && typeof salesVelocity === 'number'
        ? 'uncovered_oos_days × sales_velocity × profit_per_unit'
        : 'imported_missed_profit_or_30_day_profit_forecast';
    const supplierName = asString(params.parameter.supplier) ?? payloadString(params.parameter, ['Supplier Name', 'Supplier']) ?? asString(orderHistorySupplier.supplierName);

    return {
      planningProductId,
      company,
      asin,
      sku,
      title: payloadString(params.inventory, ['Title', 'Product Name', 'Product']) ?? payloadString(params.parameter, ['Title', 'Product Name', 'Product']),
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
      supplierSource: asString(orderHistorySupplier.supplierName) ? 'order_details_history' : 'planning_parameter_fallback',
      supplierRole: asString(orderHistorySupplier.supplierName) ? 'latest_order_history' : 'latest_history',
      supplierConfidence: asString(orderHistorySupplier.supplierName) ? 'medium' : 'low',
      leadTimeDays,
      leadTimeConfirmedAt,
      leadTimeFreshness,
      leadTimeSource: supplierName ? 'supplier_or_planning_parameter' : 'planning_parameter_without_supplier_mapping',
      openOrderCoverageQty,
      expectedSellableDate: undefined,
      estimatedProfitRisk,
      estimatedProfitRiskBasis,
      digestPriority: this.digestPriority(actionStatus, tier),
      evidence: {
        fallbackReason: 'planningProducts table is empty; row derived from inventory_snapshot and planning_parameter records.',
        leadTimeAgeDays,
        stockBuckets,
        estimatedProfitRiskBasis,
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
    const orderLines = await findRecords(this.db, ECOBASE_COLLECTIONS.supplierOrderLines, { planningProductId });
    const supplierOrderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const supplierOrderById = new Map<string, PlainRecord>();
    for (const line of orderLines) {
      const supplierOrderId = asString(line.supplierOrderId);
      if (supplierOrderId && !supplierOrderById.has(supplierOrderId)) {
        supplierOrderById.set(supplierOrderId, toPlainRecord(await supplierOrderRepo.findOne({ filterByTk: supplierOrderId })));
      }
    }
    const latestInventory = latestByDate(inventoryRows, 'snapshotDate') ?? {};
    const latestParameter = latestByDate(parameterRows, 'lastImportRunId') ?? parameterRows[0] ?? {};
    const supplierLink = selectSupplierLink(supplierLinks) ?? {};
    const supplier = await this.findSupplier(supplierLink, latestParameter, company);
    const stockBuckets = this.stockBuckets(latestInventory, params.calculation);
    const productStatus =
      payloadString(latestParameter, ['productStatus', 'Product Status', 'status', 'Status']) ??
      payloadString(latestInventory, ['productStatus', 'Product Status', 'status', 'Status']) ??
      asString(params.product.status) ??
      'Active';
    const excluded = isPlanningExcluded(productStatus);
    const openOrderCoverageQty = orderLines.reduce((total, line) => {
      const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
      if (!isReliableSupplierOrderCoverageStatus(asString(order?.status))) {
        return total;
      }
      const orderedQty = asNumber(line.orderedQty) ?? 0;
      const receivedQty = asNumber(line.receivedQty) ?? 0;
      return total + Math.max(orderedQty - receivedQty, 0);
    }, 0);
    const salesVelocity = asNumber(params.calculation.salesVelocity);
    const calculationTier = asString(params.calculation.tier);
    const fallbackTier = tierFor(
      asNumber(params.calculation.profitPerUnit),
      asNumber(params.calculation.recommendedBestQty),
      asNumber(params.calculation.estimatedProfitRisk),
    );
    const asin = asString(params.product.canonicalAsin) ?? asString(latestInventory.asin) ?? asString(latestParameter.asin);
    const sku = asString(latestInventory.sku) ?? asString(latestParameter.sku);
    const orderHistorySupplier = !asString(supplier.name) && !asString(latestParameter.supplier)
      ? await this.findOrderHistorySupplier({ company, asin, sku })
      : {};
    let leadTime = await this.findLeadTime(supplier, supplierLink, latestParameter, company, planningProductId);
    if (typeof asNumber(leadTime.leadTimeDays) !== 'number' && asString(orderHistorySupplier.supplierId)) {
      leadTime = await this.findLeadTime(
        { id: asString(orderHistorySupplier.supplierId), name: asString(orderHistorySupplier.supplierName) },
        {},
        {},
        company,
        planningProductId,
      );
    }
    const leadTimeDays = asNumber(leadTime.leadTimeDays) ?? asNumber(params.calculation.leadTimeDays);
    const leadTimeConfirmedAt = asString(leadTime.confirmedAt);
    const leadTimeAgeDays = daysSince(leadTimeConfirmedAt, params.calculationDate);
    const leadTimeFreshness =
      typeof leadTimeDays !== 'number'
        ? 'missing'
        : typeof leadTimeAgeDays === 'number' && leadTimeAgeDays > params.leadTimeFreshnessDays
          ? 'stale'
          : 'fresh';
    const calculationSafeReorderDate = asString(params.calculation.restockDeadlineImproved);
    const derivedSafeReorderDate =
      !calculationSafeReorderDate && typeof leadTimeDays === 'number' && asString(params.calculation.oosDate)
        ? addDays(asString(params.calculation.oosDate)!, -(leadTimeDays + (asNumber(params.calculation.safetyBufferDays) ?? DEFAULT_SAFETY_BUFFER_DAYS)))
        : undefined;
    const latestSafeReorderDate = calculationSafeReorderDate ?? derivedSafeReorderDate;
    const daysUntilSafeReorder = latestSafeReorderDate ? diffDays(latestSafeReorderDate, params.calculationDate) : undefined;
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
    const supplierName = asString(supplier.name) ?? asString(leadTime.supplierName) ?? asString(latestParameter.supplier) ?? asString(orderHistorySupplier.supplierName);
    const estimatedProfitRisk = asNumber(params.calculation.estimatedProfitRisk);
    const estimatedProfitRiskBasis = typeof estimatedProfitRisk === 'number'
      ? 'planning_calculation_estimated_profit_risk'
      : 'not_available';

    return {
      planningProductId,
      company,
      asin,
      sku,
      title: asString(params.product.title),
      brand: payloadString(supplierLink, ['latestBrand', 'brand']) ?? payloadString(latestParameter, ['Brand', 'brand']),
      productStatus,
      planningExcluded: excluded,
      tier: calculationTier && calculationTier !== 'unclassified' ? calculationTier : fallbackTier.tier,
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
      supplierId: asString(supplier.id) ?? asString(supplierLink.supplierId) ?? asString(latestParameter.supplierId) ?? asString(orderHistorySupplier.supplierId),
      supplierName,
      supplierSource: asString(supplierLink.source) ?? (asString(orderHistorySupplier.supplierName) ? 'order_details_history' : 'planning_parameter'),
      supplierRole: asString(supplierLink.role) ?? (asString(orderHistorySupplier.supplierName) ? 'latest_order_history' : 'latest_history'),
      supplierConfidence: asString(supplierLink.confidence) ?? (asString(orderHistorySupplier.supplierName) ? 'medium' : 'medium'),
      leadTimeDays,
      leadTimeConfirmedAt,
      leadTimeFreshness,
      leadTimeSource: supplierName ? 'supplier_or_planning_parameter' : 'planning_parameter_without_supplier_mapping',
      openOrderCoverageQty,
      expectedSellableDate: this.earliestExpectedSellableDate(orderLines),
      estimatedProfitRisk,
      estimatedProfitRiskBasis,
      digestPriority: this.digestPriority(actionStatus, calculationTier && calculationTier !== 'unclassified' ? calculationTier : fallbackTier.tier),
      evidence: {
        calculation: params.calculation.evidence,
        productStatusSource: productStatus === 'Active' ? 'default' : 'backend_sheet_or_import_payload',
        leadTimeAgeDays,
        supplierLink,
        stockBuckets,
        suggestedReorderQuantityFormula:
          'max((velocity * (leadTimeDays + safetyBufferDays + reorderCycleDays)) - currentPlanningStock - openOrderCoverageQty, 0)',
        estimatedProfitRiskBasis,
      },
    };
  }

  private stockBuckets(inventory: PlainRecord, calculation: PlainRecord) {
    const sellableStock = asNumber(inventory.stock) ?? asNumber(calculation.sellableStock) ?? 0;
    const reservedStock = asNumber(inventory.reserved) ?? 0;
    const inboundStock = asNumber(inventory.inbound) ?? 0;
    const orderedStock = asNumber(inventory.ordered) ?? 0;
    const prepStock = asNumber(inventory.prepStock) ?? payloadNumber(inventory, ['Prep Stock', 'Prep Center Stock', 'FBA prep. stock Prep center 1 stock']) ?? 0;
    const awdStock = payloadNumber(inventory, ['AWD Stock', 'awdStock']) ?? 0;
    const pipelineStock = reservedStock + inboundStock + orderedStock + prepStock + awdStock;
    return {
      sellableStock,
      reservedStock,
      inboundStock,
      orderedStock,
      prepStock,
      awdStock,
      pipelineStock,
      currentPlanningStock: sellableStock + pipelineStock,
    };
  }

  private async sourceConnectionCompanies() {
    const connections = (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({})).map(toPlainRecord);
    const companies = new Map<string, string>();
    for (const connection of connections) {
      const id = asString(connection.id);
      const label = companyLabelFromSourceConnection(connection);
      if (id && label) {
        companies.set(id, label);
      }
    }
    return companies;
  }

  private async findFallbackRecords(
    collection: string,
    params: { company?: string; sourceConnectionCompanies: Map<string, string>; sort?: string[]; limit?: number },
  ) {
    const repository = this.db.getRepository(collection);
    const limit = params.limit;
    if (!params.company) {
      return (await repository.find({ ...(params.sort ? { sort: params.sort } : {}), ...(limit ? { limit } : {}) })).map(toPlainRecord);
    }

    const matchingSourceConnectionIds = [...params.sourceConnectionCompanies.entries()]
      .filter(([, company]) => company === params.company)
      .map(([id]) => id);
    const records = new Map<string, PlainRecord>();
    const addRecords = async (filter: PlainRecord) => {
      const found = (await repository.find({ filter, ...(params.sort ? { sort: params.sort } : {}), ...(limit ? { limit } : {}) })).map(toPlainRecord);
      for (const record of found) {
        const key = asString(record.id) ?? this.fallbackProductKey(record, params.sourceConnectionCompanies) ?? JSON.stringify(record);
        records.set(key, record);
      }
    };

    await addRecords({ company: params.company });
    for (const sourceConnectionId of matchingSourceConnectionIds) {
      await addRecords({ sourceConnectionId });
    }
    return [...records.values()].slice(0, limit ?? records.size);
  }

  private async findSupplier(link: PlainRecord, parameter: PlainRecord, company?: string) {
    const supplierRepo = this.db.getRepository(ECOBASE_COLLECTIONS.suppliers);
    const linkSupplierId = asString(link.supplierId);
    const parameterSupplierId = asString(parameter.supplierId);
    const byLinkId = linkSupplierId ? toPlainRecord(await supplierRepo.findOne({ filterByTk: linkSupplierId })) : {};
    if (asString(byLinkId.id)) return byLinkId;
    const byParameterId = parameterSupplierId ? toPlainRecord(await supplierRepo.findOne({ filterByTk: parameterSupplierId })) : {};
    if (asString(byParameterId.id)) return byParameterId;
    const supplierName = asString(parameter.supplier);
    return supplierName ? toPlainRecord(await supplierRepo.findOne({ filter: { name: supplierName, ...(company ? { company } : {}) } })) : {};
  }

  private async findOrderHistorySupplier(params: { company?: string; asin?: string; sku?: string }) {
    const filters: PlainRecord[] = [];
    if (params.asin) filters.push({ asin: params.asin, ...(params.company ? { company: params.company } : {}) });
    if (params.sku) filters.push({ sku: params.sku, ...(params.company ? { company: params.company } : {}) });
    for (const filter of filters) {
      const lines = (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).find({ filter, limit: 20 })).map(toPlainRecord);
      const latestLine = latestByDate(lines, 'observedAt') ?? latestByDate(lines, 'expectedDeliveryDate') ?? lines[0];
      const supplierId = asString(latestLine?.supplierId);
      if (!supplierId) continue;
      const supplier = toPlainRecord(await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).findOne({ filterByTk: supplierId }));
      return {
        supplierId,
        supplierName: asString(supplier.name) ?? payloadString(latestLine, ['Supplier', 'Supplier Name', 'supplierName']),
        evidence: {
          source: 'supplier_order_lines',
          sourceOrderLineRef: asString(latestLine.sourceOrderLineRef),
          observedAt: asString(latestLine.observedAt),
        },
      };
    }
    return {};
  }

  private async findLeadTime(supplier: PlainRecord, link: PlainRecord, parameter: PlainRecord, company?: string, planningProductId?: string) {
    const leadTimeRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes);
    const supplierRefId = asString(supplier.id) ?? asString(link.supplierId);
    const externalSupplierCode = asString(supplier.supplierId) ?? asString(parameter.supplierId);
    const supplierName = asString(supplier.name) ?? asString(parameter.supplier);
    const scoped = (filter: PlainRecord) => ({ ...filter, ...(company ? { company } : {}) });
    const findScoped = async (base: PlainRecord) => {
      const rows = (await leadTimeRepo.find({ filter: scoped(base), sort: ['-confirmedAt'], limit: 100 })).map(toPlainRecord);
      if (planningProductId) {
        const productSpecific = rows.find((row) => asString(row.planningProductId) === planningProductId);
        if (productSpecific) return productSpecific;
      }
      return rows.find((row) => !asString(row.planningProductId)) ?? {};
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
    if (params.leadTimeFreshness === 'missing' || params.leadTimeFreshness === 'stale') return 'missing_lead_time';
    if (typeof params.daysUntilSafeReorder !== 'number') return 'missing_lead_time';
    if (params.openOrderCoverageQty > 0 && params.daysUntilSafeReorder <= params.orderSoonWindowDays) return 'already_ordered';
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
    return tierRank(tier) * 100 + actionRank(actionStatus) * 10;
  }

  private sortDigestRows(rows: PlainRecord[]) {
    return [...rows].sort((left, right) => {
      const priority = (asNumber(left.digestPriority) ?? this.digestPriority(left.actionStatus as InventoryPlanningActionStatus, left.tier)) -
        (asNumber(right.digestPriority) ?? this.digestPriority(right.actionStatus as InventoryPlanningActionStatus, right.tier));
      if (priority !== 0) return priority;
      return (asNumber(right.estimatedProfitRisk) ?? 0) - (asNumber(left.estimatedProfitRisk) ?? 0);
    });
  }

  private rankSuppliers(rows: PlainRecord[]) {
    const bySupplier = new Map<string, { supplierName: string; urgentCount: number; tierA: number; tierB: number; tierC: number; estimatedProfitRisk: number }>();
    for (const row of rows) {
      const supplierName = asString(row.supplierName) ?? 'Find supplier from OrderDetails';
      const existing = bySupplier.get(supplierName) ?? { supplierName, urgentCount: 0, tierA: 0, tierB: 0, tierC: 0, estimatedProfitRisk: 0 };
      existing.urgentCount += 1;
      existing.tierA += row.tier === 'A' ? 1 : 0;
      existing.tierB += row.tier === 'B' ? 1 : 0;
      existing.tierC += row.tier === 'C' ? 1 : 0;
      existing.estimatedProfitRisk += asNumber(row.estimatedProfitRisk) ?? 0;
      bySupplier.set(supplierName, existing);
    }
    return [...bySupplier.values()].sort((left, right) => {
      if (right.estimatedProfitRisk !== left.estimatedProfitRisk) return right.estimatedProfitRisk - left.estimatedProfitRisk;
      if (right.tierA !== left.tierA) return right.tierA - left.tierA;
      if (right.tierB !== left.tierB) return right.tierB - left.tierB;
      if (right.tierC !== left.tierC) return right.tierC - left.tierC;
      return right.urgentCount - left.urgentCount;
    });
  }
}
