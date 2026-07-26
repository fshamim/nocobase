/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { EcobaseDataWarningService } from '../../../server/services/data-warning-service';
import type { EcobaseDataWarning } from '../../../server/services/data-warning-service';
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';
import {
  DEFAULT_PLANNING_SETTINGS,
  EcobasePlanningSettingsService,
} from '../../../server/services/planning-settings-service';
import { addDays, diffDays, isoDate } from '../../inventory-dashboard/server/engine/planning-date';
import {
  profitTierFor,
  rollingDemandProfitTier,
  type ProfitTierThresholds,
} from '../../inventory-dashboard/server/engine/profit-tier';
import { summarizeHistoricalProductFacts } from '../../inventory-dashboard/server/engine/historical-product-metrics';

const RULE_VERSION = 'explicit_inventory_position_v2';
const ZERO_VELOCITY_DAYS_OF_COVER_SENTINEL = 999;

type PlainRecord = Record<string, unknown>;

export interface CalculatePlanningProductParams {
  planningProductId: string;
  calculationDate?: string;
  safetyBufferDays?: number;
  profitTierThresholds?: ProfitTierThresholds;
  persist?: boolean;
}

export interface PlanningBenchmarkResult {
  key: string;
  label: string;
  status: 'pass' | 'fail';
  expected: unknown;
  actual: unknown;
  evidence: Record<string, unknown>;
}

export interface PlanningCalculationResult extends PlainRecord {
  warnings: EcobaseDataWarning[];
  warningCount: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function payload(record: PlainRecord): PlainRecord {
  const value = record.payload;
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function payloadNumber(record: PlainRecord, keys: string[]): number | undefined {
  const values = payload(record);
  for (const key of keys) {
    const direct = asNumber(record[key]);
    if (typeof direct === 'number') {
      return direct;
    }
    const raw = values[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw.replace(/[$,%\s]/g, ''));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function sum(records: PlainRecord[], key: string) {
  return records.reduce((total, record) => total + (asNumber(record[key]) ?? 0), 0);
}

function sumFirstNumbers(records: PlainRecord[], keys: string[]): number | undefined {
  let total = 0;
  let found = false;
  for (const record of records) {
    const value = payloadNumber(record, keys);
    if (typeof value === 'number') {
      total += value;
      found = true;
    }
  }
  return found ? total : undefined;
}

function firstNumber(records: PlainRecord[], keys: string[]): number | undefined {
  for (const record of records) {
    const value = payloadNumber(record, keys);
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function daysInMonth(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
}

function dayOfMonth(date: string) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDate();
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

function latestDate(records: PlainRecord[], field: string) {
  return records
    .map((record) => asString(record[field]))
    .filter(Boolean)
    .sort()
    .at(-1);
}

function recordsForDate(records: PlainRecord[], field: string, date?: string) {
  return date ? records.filter((record) => asString(record[field]) === date) : records;
}

function preferSellerboardInventoryRows(records: PlainRecord[], sellerboardSourceConnectionIds: Set<string>) {
  const sellerboardRows = records.filter((record) => {
    const sourceConnectionId = asString(record.sourceConnectionId);
    return Boolean(sourceConnectionId && sellerboardSourceConnectionIds.has(sourceConnectionId));
  });
  return sellerboardRows.length > 0 ? sellerboardRows : records;
}

function averageUnitsForWindow(records: PlainRecord[], calculationDate: string, days: number) {
  const end = new Date(`${calculationDate}T00:00:00.000Z`).getTime();
  const start = end - (days - 1) * 86_400_000;
  const total = records.reduce((sumUnits, record) => {
    const snapshotDate = asString(record.snapshotDate);
    if (!snapshotDate) return sumUnits;
    const time = new Date(`${snapshotDate}T00:00:00.000Z`).getTime();
    if (time < start || time > end) return sumUnits;
    return sumUnits + (asNumber(record.units) ?? payloadNumber(record, ['Units', 'UnitsOrganic']) ?? 0);
  }, 0);
  return total > 0 ? total / days : undefined;
}

function weightedProfitPerUnit(parameterRows: PlainRecord[]) {
  let weightedProfit = 0;
  let quantity = 0;
  for (const row of parameterRows) {
    const profitPerUnit = payloadNumber(row, ['profitPerUnit', 'Profit Per Unit', 'Per.Unit Profit']);
    const recommendedQty = payloadNumber(row, ['recommendedBestQty', 'Rec.Best Qty', 'Rec. Best Qty']);
    if (typeof profitPerUnit === 'number' && typeof recommendedQty === 'number') {
      weightedProfit += profitPerUnit * recommendedQty;
      quantity += recommendedQty;
    }
  }
  return quantity > 0
    ? weightedProfit / quantity
    : firstNumber(parameterRows, ['profitPerUnit', 'Profit Per Unit', 'Per.Unit Profit']);
}

export class EcobasePlanningCalculationService {
  constructor(private db: EcobaseDatabase) {}

  private async sellerboardSourceConnectionIds() {
    const sourceConnections = (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({})).map(
      toPlainRecord,
    );
    return new Set(
      sourceConnections
        .filter((connection) => asString(connection.sourceType) === 'sellerboard' && connection.active !== false)
        .map((connection) => asString(connection.id))
        .filter((id): id is string => Boolean(id)),
    );
  }

  private async sourceRowsForPlanningProduct(product: PlainRecord, listings: PlainRecord[]) {
    const [companies, silverProducts, companyProducts, inventoryRows, factRows, supplierProducts, targetRows] =
      await Promise.all([
        this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({ limit: 100000 }),
        this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: 100000 }),
        this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: 100000 }),
        this.db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).find({ limit: 100000 }),
        this.db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).find({ limit: 100000 }),
        this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).find({ limit: 100000 }),
        this.db.getRepository(ECOBASE_COLLECTIONS.silverTargets).find({ limit: 100000 }),
      ]);
    const companyName = asString(product.company);
    const companyIds = new Set(
      companies
        .map(toPlainRecord)
        .filter((company) => !companyName || asString(company.name) === companyName)
        .map((company) => asString(company.id))
        .filter((id): id is string => Boolean(id)),
    );
    const productKeys = new Set(
      [product, ...listings]
        .map((row) => `${asString(row.canonicalAsin) ?? asString(row.asin) ?? ''}:${asString(row.sku) ?? ''}`)
        .filter((key) => key !== ':'),
    );
    const productIds = new Set(
      silverProducts
        .map(toPlainRecord)
        .filter((row) => productKeys.has(`${asString(row.asin) ?? ''}:${asString(row.sku) ?? ''}`))
        .map((row) => asString(row.id))
        .filter((id): id is string => Boolean(id)),
    );
    const companyProductIds = new Set(
      companyProducts
        .map(toPlainRecord)
        .filter(
          (row) =>
            productIds.has(asString(row.productId) ?? '') &&
            (companyIds.size === 0 || companyIds.has(asString(row.companyId) ?? '')),
        )
        .map((row) => asString(row.id))
        .filter((id): id is string => Boolean(id)),
    );
    const mappedInventoryRows = inventoryRows
      .map(toPlainRecord)
      .filter((row) => companyProductIds.has(asString(row.companyProductId) ?? ''))
      .map((row) => ({ ...row, stock: asNumber(row.sellableStock) ?? asNumber(row.stock) }));
    const mappedFactRows = factRows
      .map(toPlainRecord)
      .filter((row) => companyProductIds.has(asString(row.companyProductId) ?? ''))
      .map((row) => ({ ...row, netProfit: asNumber(row.profit) ?? asNumber(row.netProfit) }));
    const mappedParameterRows = supplierProducts
      .map(toPlainRecord)
      .filter((row) => productIds.has(asString(row.productId) ?? ''));
    const mappedTargetRows = targetRows
      .map(toPlainRecord)
      .filter((row) => !companyName || asString(row.company) === companyName)
      .map((row) => ({ ...row, profitTarget: asNumber(row.targetValue) ?? asNumber(row.profitTarget) }));
    return {
      inventoryRows: mappedInventoryRows,
      factRows: mappedFactRows,
      parameterRows: mappedParameterRows,
      targetRows: mappedTargetRows,
    };
  }

  async calculatePlanningProduct(params: CalculatePlanningProductParams) {
    const planningProductId = asString(params.planningProductId);
    if (!planningProductId) {
      throw new Error('Ecobase planning calculation failed: planningProductId is required.');
    }

    const calculationDate = isoDate(params.calculationDate ?? new Date());
    const productRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const product = toPlainRecord(await productRepo.findOne({ filterByTk: planningProductId }));
    if (!asString(product.id)) {
      throw new Error(`Ecobase planning calculation failed: planning product "${planningProductId}" was not found.`);
    }

    const planningProductListings = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).find({ filter: { planningProductId } })
    ).map(toPlainRecord);
    const sourceRows = await this.sourceRowsForPlanningProduct(product, planningProductListings);
    const inventoryRows = preferSellerboardInventoryRows(
      sourceRows.inventoryRows,
      await this.sellerboardSourceConnectionIds(),
    );
    const factRows = sourceRows.factRows;
    const parameterRows = sourceRows.parameterRows;
    const targetRows = sourceRows.targetRows;
    const settings = await new EcobasePlanningSettingsService(this.db).getResolvedSettings({
      safetyBufferDays: params.safetyBufferDays,
    });
    const result = await this.calculateFromRows({
      planningProductId,
      calculationDate,
      product,
      planningProductListings,
      inventoryRows,
      factRows,
      parameterRows,
      targetRows,
      safetyBufferDays: settings.safetyBufferDays,
      profitTierThresholds: params.profitTierThresholds ?? settings,
    });

    return result;
  }

  private async calculateFromRows(params: {
    planningProductId: string;
    calculationDate: string;
    product: PlainRecord;
    planningProductListings: PlainRecord[];
    inventoryRows: PlainRecord[];
    factRows: PlainRecord[];
    parameterRows: PlainRecord[];
    targetRows: PlainRecord[];
    safetyBufferDays?: number;
    profitTierThresholds?: ProfitTierThresholds;
  }): Promise<PlanningCalculationResult> {
    const latestInventoryDate = latestDate(params.inventoryRows, 'snapshotDate');
    const latestInventoryRows = recordsForDate(params.inventoryRows, 'snapshotDate', latestInventoryDate);
    const sellableStock = sum(latestInventoryRows, 'stock');
    const reservedStock = sum(latestInventoryRows, 'reserved');
    const inboundStock = sum(latestInventoryRows, 'inbound');
    const orderedStock = sum(latestInventoryRows, 'ordered');
    const prepStock = latestInventoryRows.reduce(
      (total, record) =>
        total + (asNumber(record.prepStock) ?? payloadNumber(record, ['Prep Stock', 'Prep Center Stock']) ?? 0),
      0,
    );
    const amazonPipelineStock = inboundStock + orderedStock + prepStock;
    const supplierPipelineStock = 0;
    const inventoryPositionStock = sellableStock + amazonPipelineStock + supplierPipelineStock;
    const currentStockParity = sellableStock + reservedStock + amazonPipelineStock;
    const sourceEstimatedVelocity =
      sumFirstNumbers(latestInventoryRows, [
        'salesVelocity',
        'Estimated Sales Velocity',
        'Exp Sales Vel',
        'Sales Velocity',
      ]) ?? sumFirstNumbers(params.parameterRows, ['Estimated Sales Velocity', 'Exp Sales Vel', 'Sales Velocity']);
    const velocityCandidates = [
      averageUnitsForWindow(params.factRows, params.calculationDate, 7),
      averageUnitsForWindow(params.factRows, params.calculationDate, 30),
      sourceEstimatedVelocity,
    ].filter((value): value is number => typeof value === 'number');
    const salesVelocity = velocityCandidates.length > 0 ? Math.max(...velocityCandidates) : undefined;
    const recentAsOfDate = latestDate(
      params.factRows.filter((row) => {
        const snapshotDate = asString(row.snapshotDate);
        return snapshotDate && snapshotDate <= params.calculationDate;
      }),
      'snapshotDate',
    );
    const historicalMetrics = summarizeHistoricalProductFacts(params.factRows, params.calculationDate, recentAsOfDate);
    const recommendedBestQty =
      historicalMetrics.sixMonthBestQty ??
      sumFirstNumbers(params.parameterRows, ['recommendedBestQty', 'Rec.Best Qty', 'Rec. Best Qty']);
    const profitPerUnit = historicalMetrics.profitPerUnit ?? weightedProfitPerUnit(params.parameterRows);
    const safetyBufferDays =
      params.safetyBufferDays ??
      firstNumber(params.parameterRows, ['safetyBufferDays', 'Safety Buffer Days']) ??
      DEFAULT_PLANNING_SETTINGS.safetyBufferDays;
    const leadTimeDays = await this.resolveLeadTimeDays(params.product, params.parameterRows);
    const daysOfCover =
      salesVelocity && salesVelocity > 0 ? sellableStock / salesVelocity : ZERO_VELOCITY_DAYS_OF_COVER_SENTINEL;
    const oosDate = addDays(params.calculationDate, daysOfCover);
    const positionDaysOfCover =
      salesVelocity && salesVelocity > 0
        ? inventoryPositionStock / salesVelocity
        : ZERO_VELOCITY_DAYS_OF_COVER_SENTINEL;
    const positionOosDate = addDays(params.calculationDate, positionDaysOfCover);
    const restockDeadlineParity = typeof leadTimeDays === 'number' ? addDays(oosDate, -leadTimeDays) : undefined;
    const restockDeadlineImproved =
      typeof leadTimeDays === 'number' ? addDays(oosDate, -(leadTimeDays + safetyBufferDays)) : undefined;
    const daysLeftOrOverdue = restockDeadlineParity
      ? diffDays(restockDeadlineParity, params.calculationDate)
      : undefined;
    const daysRemainingInMonth = daysInMonth(params.calculationDate) - dayOfMonth(params.calculationDate);
    const estimatedMonthEndQuantity =
      typeof salesVelocity === 'number' ? inventoryPositionStock - salesVelocity * daysRemainingInMonth : undefined;
    const restockNeeded =
      typeof estimatedMonthEndQuantity === 'number' && typeof recommendedBestQty === 'number'
        ? estimatedMonthEndQuantity < recommendedBestQty
        : false;
    const month = monthKey(params.calculationDate);
    const monthFacts = params.factRows.filter((row) => asString(row.snapshotDate)?.startsWith(month));
    const achievedProfitMtd = monthFacts.reduce(
      (total, row) => total + (asNumber(row.netProfit) ?? asNumber(row.grossProfit) ?? 0),
      0,
    );
    const monthlyTarget = this.sumMonthlyProfitTargets(params.targetRows, month);
    const proratedProfitTargetMtd =
      typeof monthlyTarget === 'number'
        ? (monthlyTarget * dayOfMonth(params.calculationDate)) / daysInMonth(params.calculationDate)
        : undefined;
    const profitGap =
      typeof proratedProfitTargetMtd === 'number' ? proratedProfitTargetMtd - achievedProfitMtd : undefined;
    const profitOffTrack = typeof profitGap === 'number' ? profitGap > 0 : false;
    const positiveSalesVelocity = salesVelocity && salesVelocity > 0 ? salesVelocity : undefined;
    const riskDays =
      typeof leadTimeDays === 'number' && typeof positiveSalesVelocity === 'number'
        ? Math.max(0, leadTimeDays + safetyBufferDays - daysOfCover)
        : undefined;
    const estimatedProfitRisk =
      typeof riskDays === 'number' && typeof positiveSalesVelocity === 'number' && typeof profitPerUnit === 'number'
        ? riskDays * positiveSalesVelocity * profitPerUnit
        : undefined;
    const warnings = await new EcobaseDataWarningService(this.db).listPlanningWarnings({
      planningProductId: params.planningProductId,
      calculationDate: params.calculationDate,
      product: params.product,
      planningProductListings: params.planningProductListings,
      inventoryRows: latestInventoryRows,
      factRows: params.factRows,
      parameterRows: params.parameterRows,
      targetRows: params.targetRows,
      salesVelocity: positiveSalesVelocity,
      leadTimeDays,
      monthlyTarget,
    });
    const completeness = this.dataCompleteness({
      salesVelocity: positiveSalesVelocity,
      leadTimeDays,
      profitPerUnit,
      recommendedBestQty,
    });
    const recentTierVelocity =
      typeof historicalMetrics.recentUnits30 === 'number' ? historicalMetrics.recentUnits30 / 30 : undefined;
    const tierDaysOfCover =
      typeof recentTierVelocity === 'number' && recentTierVelocity > 0 ? sellableStock / recentTierVelocity : undefined;
    const selectedTierResult = rollingDemandProfitTier({
      profitPerUnit: historicalMetrics.profitPerUnit,
      recentUnits30: historicalMetrics.recentUnits30,
      stuckInventory:
        sellableStock > 0 &&
        (historicalMetrics.recentUnits30 === 0 || (typeof tierDaysOfCover === 'number' && tierDaysOfCover > 60)),
      thresholds: params.profitTierThresholds,
    });
    const currentTierResult = profitTierFor(
      historicalMetrics.profitPerUnit,
      historicalMetrics.lastMonthQty,
      params.profitTierThresholds,
    );
    const averageTierResult = profitTierFor(
      historicalMetrics.profitPerUnit,
      historicalMetrics.sixMonthAverageQty,
      params.profitTierThresholds,
    );
    const bestTierResult = profitTierFor(
      historicalMetrics.profitPerUnit,
      historicalMetrics.sixMonthBestQty,
      params.profitTierThresholds,
    );
    return {
      naturalKey: `${params.planningProductId}:${RULE_VERSION}:${params.calculationDate}`,
      planningProductId: params.planningProductId,
      calculationDate: params.calculationDate,
      ruleVersion: RULE_VERSION,
      company: asString(params.product.company),
      canonicalAsin: asString(params.product.canonicalAsin),
      tier: selectedTierResult.tier ?? 'unclassified',
      tierScore: selectedTierResult.tierScore,
      recentUnits30: historicalMetrics.recentUnits30,
      tierEligibilityReason: selectedTierResult.tierEligibilityReason,
      tierRuleVersion: selectedTierResult.tierRuleVersion,
      currentTier: currentTierResult.tier ?? 'unclassified',
      currentTierScore: currentTierResult.tierScore,
      averageTier: averageTierResult.tier ?? 'unclassified',
      averageTierScore: averageTierResult.tierScore,
      bestTier: bestTierResult.tier ?? 'unclassified',
      bestTierScore: bestTierResult.tierScore,
      lastMonthQty: historicalMetrics.lastMonthQty,
      sixMonthAverageQty: historicalMetrics.sixMonthAverageQty,
      sixMonthWorstQty: historicalMetrics.sixMonthWorstQty,
      sixMonthBestQty: historicalMetrics.sixMonthBestQty,
      sixMonthMargin: historicalMetrics.margin,
      currentStockParity,
      onHandSellableStock: sellableStock,
      sellableStock,
      reservedStock,
      amazonPipelineStock,
      pipelineStock: amazonPipelineStock,
      supplierPipelineStock,
      inventoryPositionStock,
      futurePositionStock: inventoryPositionStock,
      salesVelocity,
      daysOfCover,
      oosDate,
      positionDaysOfCover,
      positionOosDate,
      leadTimeDays,
      safetyBufferDays,
      restockDeadlineParity,
      restockDeadlineImproved,
      latestSafeReorderWindowStart: restockDeadlineImproved,
      latestSafeReorderWindowEnd: restockDeadlineParity,
      daysLeftOrOverdue,
      urgentRestock: typeof daysLeftOrOverdue === 'number' ? daysLeftOrOverdue < 15 : false,
      restockNeeded,
      estimatedMonthEndQuantity,
      recommendedBestQty,
      profitPerUnit,
      achievedProfitMtd,
      proratedProfitTargetMtd,
      profitGap,
      profitOffTrack,
      estimatedProfitRisk,
      warningCount: warnings.length,
      warnings,
      dataCompleteness: completeness,
      calculationStatus: typeof leadTimeDays === 'number' ? 'calculated' : 'missing_lead_time',
      evidence: {
        latestInventoryDate,
        inventoryRowCount: latestInventoryRows.length,
        factRowCount: params.factRows.length,
        planningParameterCount: params.parameterRows.length,
        targetRowCount: params.targetRows.length,
        stockBuckets: {
          onHandSellableStock: sellableStock,
          reservedStock,
          amazonPipelineStock,
          supplierPipelineStock,
          inventoryPositionStock,
          inboundStock,
          orderedStock,
          prepStock,
        },
        velocityCandidates: {
          sevenDayAverage: averageUnitsForWindow(params.factRows, params.calculationDate, 7),
          thirtyDayAverage: averageUnitsForWindow(params.factRows, params.calculationDate, 30),
          sourceEstimatedVelocity,
        },
        riskDays,
        historicalMetrics,
        warningCount: warnings.length,
        warnings,
      },
      lastImportRunId:
        asString(latestInventoryRows[0]?.lastImportRunId) ?? asString(params.parameterRows[0]?.lastImportRunId),
    };
  }

  async validateBenchmarks(): Promise<{ status: 'pass' | 'fail'; rows: PlanningBenchmarkResult[] }> {
    const calculationDate = '2025-07-10';
    const sample = await this.calculateFromRows({
      planningProductId: 'benchmark-product',
      calculationDate,
      product: { id: 'benchmark-product', company: 'Ecofission LLC', canonicalAsin: 'B000BENCH' },
      planningProductListings: [],
      inventoryRows: [
        {
          snapshotDate: '2025-07-01',
          stock: 10,
          reserved: 2,
          inbound: 3,
          ordered: 4,
          prepStock: 1,
          salesVelocity: 2,
          recommendedReorderQuantity: 20,
          lastImportRunId: 'benchmark-import',
        },
      ],
      factRows: [{ snapshotDate: '2025-07-05', netProfit: 100 }],
      parameterRows: [{ leadTimeDays: 10, profitPerUnit: 5 }],
      targetRows: [{ periodType: 'monthly', period: '2025-07', profitTarget: 620 }],
    });
    const rows = [
      this.expectEqual('tier-a', 'Tier A threshold', 'A', profitTierFor(5, 50).tier, {
        profitPerUnit: 5,
        recommendedBestQty: 50,
      }),
      this.expectEqual('tier-b', 'Tier B threshold', 'B', profitTierFor(4, 25).tier, {
        profitPerUnit: 4,
        recommendedBestQty: 25,
      }),
      this.expectEqual('tier-c', 'Tier C threshold', 'C', profitTierFor(1, 50).tier, {
        profitPerUnit: 1,
        recommendedBestQty: 50,
      }),
      this.expectEqual('stock-parity', 'Sample compatibility stock total', 20, sample.currentStockParity, {
        expectedFormula: 'sellable + reserved + Amazon pipeline',
        sampleInventoryRows: 1,
      }),
      this.expectEqual(
        'inventory-position',
        'Sample inventory position excludes reserved',
        18,
        sample.inventoryPositionStock,
        {
          expectedFormula: 'on-hand sellable + Amazon pipeline + supplier pipeline',
          reservedStock: sample.reservedStock,
        },
      ),
      this.expectEqual('days-of-cover', 'Sample current days of cover uses sellable stock', 5, sample.daysOfCover, {
        onHandSellableStock: sample.onHandSellableStock,
        salesVelocity: sample.salesVelocity,
      }),
      this.expectEqual(
        'position-days-of-cover',
        'Sample position cover uses inventory position',
        9,
        sample.positionDaysOfCover,
        {
          inventoryPositionStock: sample.inventoryPositionStock,
          salesVelocity: sample.salesVelocity,
        },
      ),
      this.expectEqual(
        'restock-deadline-parity',
        'Sample calculation strict parity restock deadline excludes safety buffer',
        '2025-07-05',
        sample.restockDeadlineParity,
        {
          calculationDate,
          daysOfCover: sample.daysOfCover,
          leadTimeDays: sample.leadTimeDays,
        },
      ),
      this.expectEqual(
        'off-track',
        'Sample calculation profit off-track uses prorated MTD target',
        true,
        sample.profitOffTrack,
        {
          achievedProfitMtd: sample.achievedProfitMtd,
          proratedProfitTargetMtd: sample.proratedProfitTargetMtd,
        },
      ),
      this.expectEqual(
        'estimated-profit-risk',
        'Sample calculation estimated profit risk',
        120,
        sample.estimatedProfitRisk,
        {
          salesVelocity: sample.salesVelocity,
          profitPerUnit: sample.profitPerUnit,
          riskDays: toPlainRecord(sample.evidence).riskDays,
        },
      ),
    ];
    return { status: rows.every((row) => row.status === 'pass') ? 'pass' : 'fail', rows };
  }

  private async resolveLeadTimeDays(_product: PlainRecord, parameterRows: PlainRecord[]) {
    return firstNumber(parameterRows, ['leadTimeDays', 'Lead Time', 'Lead time(day)', 'Manuf. time days']);
  }

  private sumMonthlyProfitTargets(targetRows: PlainRecord[], month: string) {
    let total = 0;
    let found = false;
    for (const row of targetRows) {
      if (asString(row.periodType) !== 'monthly' || !asString(row.period)?.startsWith(month)) {
        continue;
      }
      const profitTarget = asNumber(row.profitTarget);
      if (typeof profitTarget === 'number') {
        total += profitTarget;
        found = true;
      }
    }
    return found ? total : undefined;
  }

  private dataCompleteness(values: {
    salesVelocity?: number;
    leadTimeDays?: number;
    profitPerUnit?: number;
    recommendedBestQty?: number;
  }) {
    const missing = Object.entries(values)
      .filter(([, value]) => typeof value !== 'number')
      .map(([key]) => key);
    return missing.length === 0 ? 'complete' : `missing:${missing.join(',')}`;
  }

  private expectEqual(
    key: string,
    label: string,
    expected: unknown,
    actual: unknown,
    evidence: Record<string, unknown>,
  ): PlanningBenchmarkResult {
    return { key, label, expected, actual, evidence, status: Object.is(expected, actual) ? 'pass' : 'fail' };
  }
}
