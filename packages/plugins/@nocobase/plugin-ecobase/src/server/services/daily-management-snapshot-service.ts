import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { DailyEvidencePack } from './daily-operations-brief-service';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

type PlainRecord = Record<string, unknown>;

export type KpiPeriod = 'yesterday' | '7d' | '30d';
export type KpiUnit = 'currency' | 'count' | 'percent' | 'date' | 'days';
export type KpiDirection = 'improved' | 'regressed' | 'flat' | 'new' | 'missing_baseline';
export type KpiTone = 'success' | 'error' | 'warning' | 'default';

export type DailyManagementSnapshot = PlainRecord & {
  id: string;
  snapshotDate: string;
  company?: string;
  companyScope: string;
  reportRunId: string;
  generatedAt: string;
};

export type KpiTrend = {
  key: string;
  label: string;
  value: number | string | null;
  previousValue: number | string | null;
  absoluteDelta: number | null;
  percentDelta: number | null;
  direction: KpiDirection;
  tone: KpiTone;
  period: KpiPeriod;
  unit: KpiUnit;
  higherIsBetter: boolean;
  explanation: string;
};

export type DailyManagementSnapshotTrend = {
  date: string;
  company?: string;
  period: KpiPeriod;
  currentSnapshot?: DailyManagementSnapshot;
  baselineSnapshot?: DailyManagementSnapshot;
  kpis: KpiTrend[];
  availablePeriods: KpiPeriod[];
  warnings: string[];
};

type KpiDefinition = {
  key: string;
  label: string;
  unit: KpiUnit;
  higherIsBetter: boolean;
  explanation: string;
};

const ACTIVE_INVENTORY_ACTIONS = new Set(['overdue', 'order_today', 'order_soon', 'missing_lead_time']);
const PURCHASED_SUPPLIER_STATES = new Set(['purchased_pipeline']);
const PERIOD_DAYS: Record<KpiPeriod, number> = { yesterday: 1, '7d': 7, '30d': 30 };

export const MANAGEMENT_KPI_DEFINITIONS: KpiDefinition[] = [
  {
    key: 'inventoryMoneyAtRisk',
    label: 'Inventory money at risk',
    unit: 'currency',
    higherIsBetter: false,
    explanation: 'Profit exposure from products likely to stock out.',
  },
  {
    key: 'urgentInventorySkuCount',
    label: 'Urgent OOS SKUs',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'SKUs needing reorder, lead-time, or OOS action.',
  },
  {
    key: 'overdueInventorySkuCount',
    label: 'Overdue reorder SKUs',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'SKUs already past the safe reorder date.',
  },
  {
    key: 'aTierInventoryRiskCount',
    label: 'A-tier risk SKUs',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Highest-value inventory risks.',
  },
  {
    key: 'next7DayOosSkuCount',
    label: 'Next 7-day OOS SKUs',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Products estimated to stock out within seven days.',
  },
  {
    key: 'earliestOosDate',
    label: 'Earliest OOS date',
    unit: 'date',
    higherIsBetter: true,
    explanation: 'Soonest expected stockout. Later is better.',
  },
  {
    key: 'weightedDaysOfCover',
    label: 'Weighted days of cover',
    unit: 'days',
    higherIsBetter: true,
    explanation: 'Portfolio breathing room weighted toward higher-risk products.',
  },
  {
    key: 'untrustedCoverageSkuCount',
    label: 'Untrusted coverage SKUs',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Risk rows not backed by purchased/inbound supplier-order coverage.',
  },
  {
    key: 'missingLeadTimeCount',
    label: 'Missing lead times',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Rows where lead time is missing.',
  },
  {
    key: 'staleLeadTimeCount',
    label: 'Stale lead times',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Rows where lead-time evidence is stale.',
  },
  {
    key: 'orderMoneyAtRisk',
    label: 'Order money at risk',
    unit: 'currency',
    higherIsBetter: false,
    explanation: 'Profit tied to orders that need operator action.',
  },
  {
    key: 'ordersNeedingCheck',
    label: 'Orders needing check',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Orders with unresolved lifecycle/status evidence.',
  },
  {
    key: 'staleOrderCount',
    label: 'Stale orders',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Orders overdue for an update or inactive for too long.',
  },
  {
    key: 'openOrderActionCount',
    label: 'Open order actions',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Open order rows with a next action.',
  },
  {
    key: 'supplierAttentionMoneyAtRisk',
    label: 'Supplier attention money',
    unit: 'currency',
    higherIsBetter: false,
    explanation: 'Money at risk concentrated in supplier attention rows.',
  },
  {
    key: 'supplierAttentionCount',
    label: 'Supplier attention rows',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Suppliers or supplier/product links needing attention.',
  },
  {
    key: 'dataWarningCount',
    label: 'Data warnings',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Warnings that affect trust in the current brief.',
  },
  {
    key: 'staleSourceCount',
    label: 'Stale sources',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Sources that are inactive, stale, or incomplete.',
  },
  {
    key: 'fallbackMappingCount',
    label: 'Fallback mappings',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Identity, supplier, or mapping evidence that relied on fallbacks.',
  },
  {
    key: 'todayActionCount',
    label: 'Today action count',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'Inventory, order, and task rows management should review today.',
  },
  {
    key: 'sales7d',
    label: '7-day sales',
    unit: 'currency',
    higherIsBetter: true,
    explanation: 'Sales over the last seven days ending on the report date.',
  },
  {
    key: 'profit7d',
    label: '7-day profit',
    unit: 'currency',
    higherIsBetter: true,
    explanation: 'Profit over the last seven days ending on the report date.',
  },
  {
    key: 'margin7d',
    label: '7-day margin',
    unit: 'percent',
    higherIsBetter: true,
    explanation: 'Profit divided by sales over the last seven days.',
  },
  {
    key: 'units7d',
    label: '7-day units',
    unit: 'count',
    higherIsBetter: true,
    explanation: 'Units sold over the last seven days.',
  },
  {
    key: 'refundRate7d',
    label: '7-day refund rate',
    unit: 'percent',
    higherIsBetter: false,
    explanation: 'Refund pressure over the last seven days.',
  },
  {
    key: 'buyBoxPct7d',
    label: '7-day Buy Box %',
    unit: 'percent',
    higherIsBetter: true,
    explanation: 'Weighted Buy Box percentage over the last seven days.',
  },
  {
    key: 'conversionRate7d',
    label: '7-day conversion rate',
    unit: 'percent',
    higherIsBetter: true,
    explanation: 'Traffic conversion rate over the last seven days.',
  },
  {
    key: 'targetOffTrackCount',
    label: 'Targets off track',
    unit: 'count',
    higherIsBetter: false,
    explanation: 'OKR/target signals that are off track.',
  },
];

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null;
}

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

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function safeNumber(value: unknown) {
  return asNumber(value) ?? 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function dateAdd(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function diffDays(left: string, right: string) {
  return Math.round(
    (new Date(`${left}T00:00:00.000Z`).getTime() - new Date(`${right}T00:00:00.000Z`).getTime()) / 86_400_000,
  );
}

function normalizeDate(value: string, label = 'date') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Ecobase daily management snapshot failed: ${label} must be an ISO date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Ecobase daily management snapshot failed: ${label} is not a valid calendar date.`);
  }
  return value;
}

function dateOnly(value: unknown) {
  return asString(value)?.slice(0, 10);
}

function inRange(date: unknown, start: string, end: string) {
  const value = dateOnly(date);
  return Boolean(value && value >= start && value <= end);
}

function rowCompany(row: PlainRecord) {
  return asString(row.company) ?? asString(row.companyName);
}

function matchesCompany(row: PlainRecord, company?: string) {
  if (!company) return true;
  const label = rowCompany(row);
  return !label || label === company;
}

function isClosedStatus(value: unknown) {
  const status = (asString(value) ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  return ['complete', 'completed', 'closed', 'cancelled', 'canceled', 'rejected'].some((part) => status.includes(part));
}

function sum(rows: PlainRecord[], field: string) {
  return round(
    rows.reduce((total, row) => total + safeNumber(row[field]), 0),
    2,
  );
}

function count(rows: PlainRecord[], predicate: (row: PlainRecord) => boolean) {
  return rows.reduce((total, row) => total + (predicate(row) ? 1 : 0), 0);
}

function minDate(rows: PlainRecord[], fields: string[]) {
  return rows
    .flatMap((row) => fields.map((field) => dateOnly(row[field])))
    .filter((value): value is string => Boolean(value))
    .sort()[0];
}

function weightedAverage(rows: PlainRecord[], valueField: string, weightField: string) {
  let weightedTotal = 0;
  let weightTotal = 0;
  let simpleTotal = 0;
  let simpleCount = 0;
  for (const row of rows) {
    const value = asNumber(row[valueField]);
    if (typeof value !== 'number') continue;
    simpleTotal += value;
    simpleCount += 1;
    const weight = Math.max(safeNumber(row[weightField]), 0);
    if (weight > 0) {
      weightedTotal += value * weight;
      weightTotal += weight;
    }
  }
  if (weightTotal > 0) return round(weightedTotal / weightTotal, 1);
  return simpleCount > 0 ? round(simpleTotal / simpleCount, 1) : undefined;
}

function sourceIsStale(source: PlainRecord) {
  if (!asBoolean(source.active, true)) return true;
  if (safeNumber(source.warningCount) > 0) return true;
  const warnings = Array.isArray(source.warnings) ? source.warnings.map(toPlainRecord) : [];
  return warnings.some((warning) => /stale|fresh|inactive|missing|incomplete/i.test(JSON.stringify(warning)));
}

function fallbackWarning(warning: PlainRecord) {
  const text = JSON.stringify(warning).toLowerCase();
  return /fallback|mapping|identity|supplier.*missing|inferred/.test(text);
}

function evidenceRiskRows(pack?: DailyEvidencePack) {
  return Array.isArray(pack?.inventoryRisks) ? pack.inventoryRisks.map((item) => item as PlainRecord) : [];
}

function evidenceOrderRows(pack?: DailyEvidencePack) {
  return Array.isArray(pack?.orderPlanningRisks) ? pack.orderPlanningRisks.map((item) => item as PlainRecord) : [];
}

function evidenceWarnings(pack?: DailyEvidencePack) {
  return Array.isArray(pack?.dataWarnings) ? pack.dataWarnings.map((item) => item as PlainRecord) : [];
}

function evidenceSourceStatus(pack?: DailyEvidencePack) {
  return Array.isArray(pack?.sourceStatus) ? pack.sourceStatus.map((item) => item as PlainRecord) : [];
}

function trafficKey(row: PlainRecord) {
  return [asString(row.asin)?.toUpperCase() ?? '', asString(row.sku) ?? ''].join(':');
}

function metricValue(snapshot: PlainRecord | undefined, key: string) {
  if (!snapshot) return null;
  const value = snapshot[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = asNumber(value);
  if (typeof parsed === 'number') return parsed;
  return asString(value) ?? null;
}

function numericDelta(
  current: number,
  previous: number,
  higherIsBetter: boolean,
): Pick<KpiTrend, 'absoluteDelta' | 'percentDelta' | 'direction' | 'tone'> {
  const absoluteDelta = round(current - previous, 2);
  const percentDelta =
    previous === 0 ? (current === 0 ? 0 : null) : round(((current - previous) / Math.abs(previous)) * 100, 1);
  const direction: KpiDirection =
    previous === 0 && current !== 0
      ? 'new'
      : Math.abs(absoluteDelta) < 0.0001
      ? 'flat'
      : (higherIsBetter ? absoluteDelta > 0 : absoluteDelta < 0)
      ? 'improved'
      : 'regressed';
  const tone: KpiTone =
    direction === 'improved'
      ? 'success'
      : direction === 'regressed'
      ? 'error'
      : direction === 'new'
      ? 'warning'
      : 'default';
  return { absoluteDelta, percentDelta, direction, tone };
}

function compareMetric(
  definition: KpiDefinition,
  currentSnapshot: PlainRecord,
  baselineSnapshot: PlainRecord | undefined,
  period: KpiPeriod,
): KpiTrend {
  const value = metricValue(currentSnapshot, definition.key);
  const previousValue = metricValue(baselineSnapshot, definition.key);
  const base = {
    key: definition.key,
    label: definition.label,
    value,
    previousValue,
    period,
    unit: definition.unit,
    higherIsBetter: definition.higherIsBetter,
    explanation: definition.explanation,
  };
  if (!baselineSnapshot || previousValue === null || value === null) {
    return {
      ...base,
      absoluteDelta: null,
      percentDelta: null,
      direction: 'missing_baseline',
      tone: 'default',
    };
  }
  if (definition.unit === 'date') {
    const currentDate = typeof value === 'string' ? value.slice(0, 10) : undefined;
    const previousDate = typeof previousValue === 'string' ? previousValue.slice(0, 10) : undefined;
    if (!currentDate || !previousDate) {
      return { ...base, absoluteDelta: null, percentDelta: null, direction: 'missing_baseline', tone: 'default' };
    }
    const absoluteDelta = diffDays(currentDate, previousDate);
    const direction: KpiDirection =
      absoluteDelta === 0
        ? 'flat'
        : (definition.higherIsBetter ? absoluteDelta > 0 : absoluteDelta < 0)
        ? 'improved'
        : 'regressed';
    return {
      ...base,
      absoluteDelta,
      percentDelta: null,
      direction,
      tone: direction === 'improved' ? 'success' : direction === 'regressed' ? 'error' : 'default',
    };
  }
  if (typeof value !== 'number' || typeof previousValue !== 'number') {
    return { ...base, absoluteDelta: null, percentDelta: null, direction: 'missing_baseline', tone: 'default' };
  }
  return { ...base, ...numericDelta(value, previousValue, definition.higherIsBetter) };
}

export class EcobaseDailyManagementSnapshotService {
  constructor(private db: EcobaseDatabase) {}

  async upsertFromEvidence(params: {
    date: string;
    company?: string;
    reportRunId: string;
    evidencePack?: DailyEvidencePack;
  }): Promise<DailyManagementSnapshot> {
    const snapshotDate = normalizeDate(params.date, 'snapshotDate');
    const company = asString(params.company);
    const companyScope = company ?? 'all';
    const values = await this.buildSnapshotValues({
      snapshotDate,
      company,
      companyScope,
      reportRunId: params.reportRunId,
      evidencePack: params.evidencePack,
    });
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.dailyManagementSnapshots);
    const existing = toPlainRecord(await repository.findOne({ filter: { snapshotDate, companyScope } }));
    const id = asString(existing.id) ?? randomUUID();
    const record = { id, ...values };
    if (existing.id) {
      await repository.update({ filterByTk: id, values: record });
    } else {
      await repository.create({ values: record });
    }
    return toPlainRecord(await repository.findOne({ filterByTk: id })) as DailyManagementSnapshot;
  }

  async getTrend(params: {
    date: string;
    company?: string;
    period?: KpiPeriod;
  }): Promise<DailyManagementSnapshotTrend> {
    const date = normalizeDate(params.date);
    const company = asString(params.company);
    const companyScope = company ?? 'all';
    const period = params.period ?? '7d';
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.dailyManagementSnapshots);
    const currentSnapshot = toPlainRecord(
      await repository.findOne({ filter: { snapshotDate: date, companyScope } }),
    ) as DailyManagementSnapshot;
    const baselineDate = dateAdd(date, -PERIOD_DAYS[period]);
    const baselineSnapshot = toPlainRecord(
      await repository.findOne({ filter: { snapshotDate: baselineDate, companyScope } }),
    ) as DailyManagementSnapshot;
    const warnings = [] as string[];
    if (!currentSnapshot.id) warnings.push(`No management snapshot exists for ${date}.`);
    if (!baselineSnapshot.id) warnings.push(`No ${period} baseline management snapshot exists for ${baselineDate}.`);
    return {
      date,
      ...(company ? { company } : {}),
      period,
      currentSnapshot: currentSnapshot.id ? currentSnapshot : undefined,
      baselineSnapshot: baselineSnapshot.id ? baselineSnapshot : undefined,
      kpis: currentSnapshot.id
        ? MANAGEMENT_KPI_DEFINITIONS.map((definition) =>
            compareMetric(definition, currentSnapshot, baselineSnapshot.id ? baselineSnapshot : undefined, period),
          )
        : [],
      availablePeriods: ['yesterday', '7d', '30d'],
      warnings,
    };
  }

  private async buildSnapshotValues(params: {
    snapshotDate: string;
    company?: string;
    companyScope: string;
    reportRunId: string;
    evidencePack?: DailyEvidencePack;
  }) {
    const inventoryRows = await this.currentInventoryRows(params.snapshotDate, params.company, params.evidencePack);
    const orderRows = await this.currentOrderRows(params.company, params.evidencePack);
    const supplierAttentionRows = await this.supplierAttentionRows(params.company);
    const listingMetrics = await this.listingMetrics(params.snapshotDate, params.company);
    const trafficMetrics = await this.trafficMetrics(params.snapshotDate, params.company);
    const dataWarnings = evidenceWarnings(params.evidencePack);
    const sourceStatus = evidenceSourceStatus(params.evidencePack);
    const activeRiskRows = inventoryRows.filter((row) =>
      ACTIVE_INVENTORY_ACTIONS.has(asString(row.actionStatus) ?? ''),
    );
    const sevenDaysOut = dateAdd(params.snapshotDate, 7);
    const staleOrders = orderRows.filter(
      (row) =>
        safeNumber(row.daysSinceLastActivity) >= 7 ||
        Boolean(dateOnly(row.nextActionDueAt) && dateOnly(row.nextActionDueAt)! < params.snapshotDate),
    );
    const taskRiskCount = Array.isArray(params.evidencePack?.okrAccountabilityRisks)
      ? params.evidencePack.okrAccountabilityRisks.filter(
          (risk) => risk.riskType === 'task_overdue' || risk.riskType === 'task_inactive',
        ).length
      : 0;
    const targetOffTrackCount = Array.isArray(params.evidencePack?.okrAccountabilityRisks)
      ? params.evidencePack.okrAccountabilityRisks.filter((risk) => risk.riskType === 'okr_off_track').length
      : 0;

    const snapshotPayload = {
      metricSources: {
        inventoryRows: inventoryRows.length,
        activeRiskRows: activeRiskRows.length,
        orderRows: orderRows.length,
        supplierAttentionRows: supplierAttentionRows.length,
        dataWarnings: dataWarnings.length,
        sourceStatus: sourceStatus.length,
      },
      evidenceFocus: params.evidencePack?.focus,
      evidenceFocusReason: params.evidencePack?.focusReason,
    };

    return {
      snapshotDate: params.snapshotDate,
      company: params.company,
      companyScope: params.companyScope,
      reportRunId: params.reportRunId,
      generatedAt: new Date().toISOString(),
      inventoryMoneyAtRisk: sum(activeRiskRows, 'estimatedProfitRisk'),
      urgentInventorySkuCount: activeRiskRows.length,
      overdueInventorySkuCount: count(activeRiskRows, (row) => asString(row.actionStatus) === 'overdue'),
      aTierInventoryRiskCount: count(activeRiskRows, (row) => asString(row.tier) === 'A'),
      next7DayOosSkuCount: count(activeRiskRows, (row) =>
        Boolean(dateOnly(row.estimatedOosDate) && dateOnly(row.estimatedOosDate)! <= sevenDaysOut),
      ),
      earliestOosDate: minDate(activeRiskRows, ['estimatedOosDate']),
      weightedDaysOfCover: weightedAverage(activeRiskRows, 'daysOfCover', 'estimatedProfitRisk'),
      untrustedCoverageSkuCount: count(
        activeRiskRows,
        (row) => !PURCHASED_SUPPLIER_STATES.has(asString(row.supplierOrderState) ?? ''),
      ),
      missingLeadTimeCount: count(
        activeRiskRows,
        (row) => asString(row.leadTimeFreshness) === 'missing' || asString(row.actionStatus) === 'missing_lead_time',
      ),
      staleLeadTimeCount: count(activeRiskRows, (row) => asString(row.leadTimeFreshness) === 'stale'),
      orderMoneyAtRisk: sum(orderRows, 'moneyAtRisk'),
      ordersNeedingCheck: count(orderRows, (row) => asBoolean(row.statusCheckRequired)),
      staleOrderCount: staleOrders.length,
      openOrderActionCount: count(orderRows, (row) => Boolean(asString(row.nextAction))),
      supplierAttentionMoneyAtRisk: sum(supplierAttentionRows, 'moneyAtRisk'),
      supplierAttentionCount: supplierAttentionRows.length,
      dataWarningCount: dataWarnings.filter((warning) => asString(warning.severity) === 'warning').length,
      staleSourceCount: sourceStatus.filter(sourceIsStale).length,
      fallbackMappingCount:
        dataWarnings.filter(fallbackWarning).length +
        count(activeRiskRows, (row) =>
          ['fallback_or_inferred', 'missing'].includes(asString(row.supplierEvidenceState) ?? ''),
        ),
      todayActionCount: activeRiskRows.length + orderRows.length + taskRiskCount,
      buyBoxRiskCount: Array.isArray(params.evidencePack?.buyBoxRisks) ? params.evidencePack.buyBoxRisks.length : 0,
      performanceTrendCount: Array.isArray(params.evidencePack?.performanceTrends)
        ? params.evidencePack.performanceTrends.length
        : 0,
      targetOffTrackCount,
      ...listingMetrics,
      ...trafficMetrics,
      snapshotPayload,
    };
  }

  private async currentInventoryRows(date: string, company?: string, evidencePack?: DailyEvidencePack) {
    const rows = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({
        filter: company ? { company } : {},
        sort: ['-estimatedProfitRisk'],
        limit: 10000,
      })
    )
      .map(toPlainRecord)
      .filter((row) => matchesCompany(row, company));
    const datedRows = rows.filter((row) => dateOnly(row.calculationDate) === date);
    if (datedRows.length > 0) return datedRows;
    const evidenceRows = evidenceRiskRows(evidencePack);
    return evidenceRows.length > 0 ? evidenceRows : rows;
  }

  private async currentOrderRows(company?: string, evidencePack?: DailyEvidencePack) {
    const rows = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).find({
        filter: company ? { companyName: company } : {},
        sort: ['-moneyAtRisk'],
        limit: 10000,
      })
    )
      .map(toPlainRecord)
      .filter((row) => matchesCompany(row, company))
      .filter((row) => !isClosedStatus(row.currentStatus ?? row.canonicalStatus ?? row.lifecycleStatus));
    const riskyRows = rows.filter(
      (row) =>
        asBoolean(row.statusCheckRequired) ||
        safeNumber(row.moneyAtRisk) > 0 ||
        Boolean(asString(row.nextAction)) ||
        safeNumber(row.daysSinceLastActivity) >= 3,
    );
    if (riskyRows.length > 0) return riskyRows;
    const evidenceRows = evidenceOrderRows(evidencePack);
    return evidenceRows.length > 0 ? evidenceRows : riskyRows;
  }

  private async supplierAttentionRows(company?: string) {
    return (
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.goldSupplierAttentionRows)
        .find({ sort: ['-moneyAtRisk'], limit: 5000 })
    )
      .map(toPlainRecord)
      .filter((row) => matchesCompany(row, company));
  }

  private async listingMetrics(date: string, company?: string) {
    const start = dateAdd(date, -6);
    const rows = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).find({
        filter: company ? { company } : {},
        sort: ['-snapshotDate'],
        limit: 20000,
      })
    )
      .map(toPlainRecord)
      .filter((row) => matchesCompany(row, company))
      .filter((row) => inRange(row.snapshotDate, start, date));
    const sales7d = sum(rows, 'sales');
    const profit7d = round(
      rows.reduce(
        (total, row) => total + (asNumber(row.netProfit) ?? asNumber(row.grossProfit) ?? asNumber(row.profit) ?? 0),
        0,
      ),
      2,
    );
    const units7d = sum(rows, 'units');
    const refunds = sum(rows, 'refunds');
    const margin7d = sales7d !== 0 ? round((profit7d / sales7d) * 100, 1) : undefined;
    const weightedRefundRate = weightedAverage(rows, 'refundRate', 'units');
    const refundRate7d = units7d > 0 && refunds > 0 ? round((refunds / units7d) * 100, 1) : weightedRefundRate;
    return { sales7d, profit7d, units7d, margin7d, refundRate7d };
  }

  private async trafficMetrics(date: string, company?: string) {
    const start = dateAdd(date, -6);
    const productKeys = company ? await this.companyProductTrafficKeys(company) : undefined;
    const rows = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).find({ sort: ['-snapshotDate'], limit: 20000 })
    )
      .map(toPlainRecord)
      .filter((row) => inRange(row.snapshotDate, start, date))
      .filter((row) => !productKeys || productKeys.has(trafficKey(row)));
    const sessions = sum(rows, 'sessions');
    const unitsOrdered = sum(rows, 'unitsOrdered');
    const buyBoxPct7d = weightedAverage(rows, 'buyBoxPercentage', 'sessions');
    const explicitConversionRate = weightedAverage(rows, 'conversionRate', 'sessions');
    const conversionRate7d =
      sessions > 0 && unitsOrdered > 0 ? round((unitsOrdered / sessions) * 100, 1) : explicitConversionRate;
    return { buyBoxPct7d, conversionRate7d };
  }

  private async companyProductTrafficKeys(company: string) {
    const products = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).find({ filter: { company }, limit: 10000 })
    ).map(toPlainRecord);
    return new Set(
      products
        .map((product) =>
          [
            asString(product.canonicalAsin)?.toUpperCase() ?? asString(product.asin)?.toUpperCase() ?? '',
            asString(product.sku) ?? '',
          ].join(':'),
        )
        .filter((key) => key !== ':'),
    );
  }
}
