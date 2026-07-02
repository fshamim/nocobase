import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseDataWarningService } from './data-warning-service';
import type { EcobaseDataWarning } from './data-warning-service';
import type { EcobaseDatabase, EcobaseRepository } from './import-service';
import { toPlainRecord } from './import-service';
import { DEFAULT_PLANNING_SETTINGS, EcobasePlanningSettingsService } from './planning-settings-service';
import { profitTierFor, type ProfitTierThresholds } from './profit-tier';

const RULE_VERSION = 'spreadsheet_parity_v1';
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

function isoDate(value: string | Date) {
  return (value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + Math.floor(days));
  return isoDate(next);
}

function diffDays(left: string, right: string) {
  const leftDate = new Date(`${left}T00:00:00.000Z`).getTime();
  const rightDate = new Date(`${right}T00:00:00.000Z`).getTime();
  return Math.round((leftDate - rightDate) / 86_400_000);
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

async function findByPlanningProduct(repo: EcobaseRepository, planningProductId: string) {
  return (await repo.find({ filter: { planningProductId } })).map(toPlainRecord);
}

export class EcobasePlanningCalculationService {
  constructor(private db: EcobaseDatabase) {}

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

    const inventoryRows = await findByPlanningProduct(
      this.db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots),
      planningProductId,
    );
    const factRows = await findByPlanningProduct(
      this.db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts),
      planningProductId,
    );
    const parameterRows = await findByPlanningProduct(
      this.db.getRepository(ECOBASE_COLLECTIONS.planningParameters),
      planningProductId,
    );
    const targetRows = await findByPlanningProduct(
      this.db.getRepository(ECOBASE_COLLECTIONS.targetRows),
      planningProductId,
    );
    const planningProductListings = await findByPlanningProduct(
      this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings),
      planningProductId,
    );
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

    if (params.persist !== false) {
      await this.upsertSnapshot(this.snapshotValues(result));
    }

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
    const pipelineStock = inboundStock + orderedStock + prepStock;
    const currentStockParity = sellableStock + reservedStock + pipelineStock;
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
    const recommendedBestQty =
      sumFirstNumbers(latestInventoryRows, ['recommendedReorderQuantity', 'Recommended quantity for  reordering']) ??
      sumFirstNumbers(params.parameterRows, ['recommendedBestQty', 'Rec.Best Qty', 'Rec. Best Qty']);
    const profitPerUnit = weightedProfitPerUnit(params.parameterRows);
    const safetyBufferDays =
      params.safetyBufferDays ??
      firstNumber(params.parameterRows, ['safetyBufferDays', 'Safety Buffer Days']) ??
      DEFAULT_PLANNING_SETTINGS.safetyBufferDays;
    const leadTimeDays = await this.resolveLeadTimeDays(params.product, params.parameterRows);
    const daysOfCover =
      salesVelocity && salesVelocity > 0 ? currentStockParity / salesVelocity : ZERO_VELOCITY_DAYS_OF_COVER_SENTINEL;
    const oosDate = addDays(params.calculationDate, daysOfCover);
    const restockDeadlineParity = typeof leadTimeDays === 'number' ? addDays(oosDate, -leadTimeDays) : undefined;
    const restockDeadlineImproved =
      typeof leadTimeDays === 'number' ? addDays(oosDate, -(leadTimeDays + safetyBufferDays)) : undefined;
    const daysLeftOrOverdue = restockDeadlineParity
      ? diffDays(restockDeadlineParity, params.calculationDate)
      : undefined;
    const daysRemainingInMonth = daysInMonth(params.calculationDate) - dayOfMonth(params.calculationDate);
    const estimatedMonthEndQuantity =
      typeof salesVelocity === 'number' ? currentStockParity - salesVelocity * daysRemainingInMonth : undefined;
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
    const { tier, tierScore } = profitTierFor(profitPerUnit, recommendedBestQty, params.profitTierThresholds);
    return {
      naturalKey: `${params.planningProductId}:${RULE_VERSION}:${params.calculationDate}`,
      planningProductId: params.planningProductId,
      calculationDate: params.calculationDate,
      ruleVersion: RULE_VERSION,
      company: asString(params.product.company),
      canonicalAsin: asString(params.product.canonicalAsin),
      tier: tier ?? 'unclassified',
      tierScore,
      currentStockParity,
      sellableStock,
      pipelineStock,
      salesVelocity,
      daysOfCover,
      oosDate,
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
        stockBuckets: { sellableStock, reservedStock, inboundStock, orderedStock, prepStock },
        velocityCandidates: {
          sevenDayAverage: averageUnitsForWindow(params.factRows, params.calculationDate, 7),
          thirtyDayAverage: averageUnitsForWindow(params.factRows, params.calculationDate, 30),
          sourceEstimatedVelocity,
        },
        riskDays,
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
      this.expectEqual('stock-parity', 'Sample calculation current stock parity', 20, sample.currentStockParity, {
        expectedFormula: 'stock + reserved + inbound + ordered + prepStock',
        sampleInventoryRows: 1,
      }),
      this.expectEqual('days-of-cover', 'Sample calculation days of cover', 10, sample.daysOfCover, {
        currentStockParity: sample.currentStockParity,
        salesVelocity: sample.salesVelocity,
      }),
      this.expectEqual(
        'restock-deadline-parity',
        'Sample calculation strict parity restock deadline excludes safety buffer',
        '2025-07-10',
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
        70,
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

  private async resolveLeadTimeDays(product: PlainRecord, parameterRows: PlainRecord[]) {
    const directLeadTime = firstNumber(parameterRows, [
      'leadTimeDays',
      'Lead Time',
      'Lead time(day)',
      'Manuf. time days',
    ]);
    if (typeof directLeadTime === 'number') {
      return directLeadTime;
    }
    const leadTimeRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes);
    for (const parameterRow of parameterRows) {
      const sourceConnectionId = asString(parameterRow.sourceConnectionId);
      const company = asString(parameterRow.company) ?? asString(product.company);
      const supplierId = asString(parameterRow.supplierId);
      const supplierName = asString(parameterRow.supplier);
      const asin = asString(parameterRow.asin) ?? asString(product.canonicalAsin);
      const sku = asString(parameterRow.sku);
      const scopedFilter = (identity: Record<string, string>) => ({
        ...identity,
        ...(sourceConnectionId ? { sourceConnectionId } : {}),
        ...(company ? { company } : {}),
      });
      const productScope = (identity: Record<string, string>) =>
        scopedFilter({ ...identity, scope: 'product', ...(asin ? { asin } : sku ? { sku } : {}) });
      const byProductId =
        supplierId && (asin || sku) ? await leadTimeRepo.findOne({ filter: productScope({ supplierId }) }) : null;
      const byProductName =
        !byProductId && supplierName && (asin || sku)
          ? await leadTimeRepo.findOne({ filter: productScope({ supplierName }) })
          : null;
      const leadTimeDays = asNumber(toPlainRecord(byProductId ?? byProductName).leadTimeDays);
      if (typeof leadTimeDays === 'number') {
        return leadTimeDays;
      }
    }
    return undefined;
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

  private snapshotValues(result: PlanningCalculationResult): PlainRecord {
    const { warningCount, warnings, ...snapshot } = result;
    return {
      ...snapshot,
      evidence: {
        ...toPlainRecord(snapshot.evidence),
        warningCount,
        warnings,
      },
    };
  }

  private async upsertSnapshot(values: PlainRecord) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots);
    const naturalKey = asString(values.naturalKey);
    if (!naturalKey) {
      throw new Error('Ecobase planning calculation failed: snapshot naturalKey is required.');
    }
    const existing = toPlainRecord(await repo.findOne({ filter: { naturalKey } }));
    const existingId = existing.id;
    if (typeof existingId === 'string' || typeof existingId === 'number') {
      await repo.update({ filterByTk: existingId, values });
    } else {
      await repo.create({ values });
    }
  }
}
