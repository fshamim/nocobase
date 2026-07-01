import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

type PlainRecord = Record<string, unknown>;

export type ManagementKpiPeriod = 'yesterday' | '7d' | '30d';
export type ManagementKpiUnit = 'currency' | 'count' | 'percent' | 'days';
export type ManagementKpiDirection = 'improved' | 'regressed' | 'flat' | 'new' | 'insufficient_history';
export type ManagementKpiTone = 'success' | 'error' | 'warning' | 'default';
export type ManagementKpiConfidence = 'complete' | 'partial' | 'insufficient';

type MetricAggregation = 'sum' | 'ratio' | 'weighted_average' | 'latest';
type MetricSourceLayer = 'silver' | 'gold';

type MetricDefinition = {
  key: string;
  label: string;
  unit: ManagementKpiUnit;
  aggregation: MetricAggregation;
  higherIsBetter: boolean;
  sourceLayer: MetricSourceLayer;
  sourceCollection: string;
  explanation: string;
};

type FactValues = {
  metricDate: string;
  company?: string;
  companyScope: string;
  metricKey: string;
  value: number | null;
  sourceDateStart: string;
  sourceDateEnd: string;
  sourceRowCount: number;
  sourceGoldDate?: string;
  payload?: PlainRecord;
};

type FactBuildSummary = {
  factCount: number;
  metrics: Record<string, number>;
  dateStart?: string;
  dateEnd?: string;
  skippedMetrics: string[];
};

export type ManagementKpiTrend = {
  key: string;
  label: string;
  value: number | null;
  previousValue: number | null;
  absoluteDelta: number | null;
  percentDelta: number | null;
  slopePerDay: number | null;
  direction: ManagementKpiDirection;
  tone: ManagementKpiTone;
  period: ManagementKpiPeriod;
  unit: ManagementKpiUnit;
  higherIsBetter: boolean;
  explanation: string;
  confidence: ManagementKpiConfidence;
  currentPointCount: number;
  previousPointCount: number;
  expectedPointCount: number;
  sourceLayer: MetricSourceLayer;
  sourceCollection: string;
  sourceWindowStart: string | null;
  sourceWindowEnd: string | null;
  previousSourceWindowStart: string | null;
  previousSourceWindowEnd: string | null;
  warning?: string;
};

export type ManagementKpiTrendResult = {
  date: string;
  company?: string;
  period: ManagementKpiPeriod;
  kpis: ManagementKpiTrend[];
  availablePeriods: ManagementKpiPeriod[];
  warnings: string[];
};

const METRIC_VERSION = 'v1';
const PERIOD_DAYS: Record<ManagementKpiPeriod, number> = { yesterday: 1, '7d': 7, '30d': 30 };
const ACTIVE_INVENTORY_ACTIONS = new Set(['overdue', 'order_today', 'order_soon', 'missing_lead_time']);
const CLOSED_ORDER_STATUS_PARTS = ['complete', 'completed', 'closed', 'cancelled', 'canceled', 'rejected'];

export const MANAGEMENT_KPI_FACT_DEFINITIONS: MetricDefinition[] = [
  {
    key: 'sales',
    label: 'Sales',
    unit: 'currency',
    aggregation: 'sum',
    higherIsBetter: true,
    sourceLayer: 'silver',
    sourceCollection: ECOBASE_COLLECTIONS.silverListingDailyFacts,
    explanation: 'Revenue generated in this period. Rising sales usually means demand is improving.',
  },
  {
    key: 'profit',
    label: 'Profit',
    unit: 'currency',
    aggregation: 'sum',
    higherIsBetter: true,
    sourceLayer: 'silver',
    sourceCollection: ECOBASE_COLLECTIONS.silverListingDailyFacts,
    explanation: 'Estimated profit generated in this period. Use this to judge whether sales growth is profitable.',
  },
  {
    key: 'units',
    label: 'Units',
    unit: 'count',
    aggregation: 'sum',
    higherIsBetter: true,
    sourceLayer: 'silver',
    sourceCollection: ECOBASE_COLLECTIONS.silverListingDailyFacts,
    explanation: 'Units sold in this period. Higher volume can increase replenishment and operations pressure.',
  },
  {
    key: 'margin',
    label: 'Margin',
    unit: 'percent',
    aggregation: 'ratio',
    higherIsBetter: true,
    sourceLayer: 'silver',
    sourceCollection: ECOBASE_COLLECTIONS.silverListingDailyFacts,
    explanation: 'Profit kept from each dollar of sales. Falling margin means growth is becoming less profitable.',
  },
  {
    key: 'refundRate',
    label: 'Refund rate',
    unit: 'percent',
    aggregation: 'ratio',
    higherIsBetter: false,
    sourceLayer: 'silver',
    sourceCollection: ECOBASE_COLLECTIONS.silverListingDailyFacts,
    explanation:
      'Refunds as a share of units sold. A rising rate can point to product, listing, or customer-fit issues.',
  },
  {
    key: 'buyBoxPct',
    label: 'Buy Box %',
    unit: 'percent',
    aggregation: 'weighted_average',
    higherIsBetter: true,
    sourceLayer: 'silver',
    sourceCollection: ECOBASE_COLLECTIONS.silverTrafficSnapshots,
    explanation: 'How often offers win the Buy Box. A lower rate can reduce sales even when demand exists.',
  },
  {
    key: 'conversionRate',
    label: 'Conversion rate',
    unit: 'percent',
    aggregation: 'weighted_average',
    higherIsBetter: true,
    sourceLayer: 'silver',
    sourceCollection: ECOBASE_COLLECTIONS.silverTrafficSnapshots,
    explanation: 'How often shoppers turn into orders. A lower rate can point to pricing, listing, or offer issues.',
  },
  {
    key: 'inventoryMoneyAtRisk',
    label: 'Inventory money at risk',
    unit: 'currency',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
    explanation: 'Profit at risk if replenishment is not handled. Lower is better.',
  },
  {
    key: 'urgentInventorySkuCount',
    label: 'Urgent OOS SKUs',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
    explanation: 'Products needing action now to avoid stockouts or lost sales.',
  },
  {
    key: 'overdueInventorySkuCount',
    label: 'Overdue reorder SKUs',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
    explanation: 'Products that should already have been reordered. These need immediate follow-up.',
  },
  {
    key: 'aTierInventoryRiskCount',
    label: 'A-tier risk SKUs',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
    explanation: 'High-priority products where delays can hurt profit most.',
  },
  {
    key: 'next7DayOosSkuCount',
    label: 'Next 7-day OOS SKUs',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
    explanation: 'Products likely to run out within a week. These are near-term revenue risks.',
  },
  {
    key: 'missingLeadTimeCount',
    label: 'Missing lead times',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
    explanation: 'Products missing supplier lead-time evidence. Planning dates are less reliable until filled.',
  },
  {
    key: 'staleLeadTimeCount',
    label: 'Stale lead times',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
    explanation: 'Products using old lead-time evidence. Refresh it before trusting reorder timing.',
  },
  {
    key: 'orderMoneyAtRisk',
    label: 'Order money at risk',
    unit: 'currency',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldOrderPlanningRows,
    explanation: 'Profit tied to orders that still need action or monitoring. Lower is better.',
  },
  {
    key: 'ordersNeedingCheck',
    label: 'Orders needing check',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldOrderPlanningRows,
    explanation:
      'Orders whose status is not reliable enough yet. The team should check these before relying on the order status.',
  },
  {
    key: 'staleOrderCount',
    label: 'Stale orders',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldOrderPlanningRows,
    explanation: 'Orders that have gone quiet or missed an update. Follow up to prevent hidden delays.',
  },
  {
    key: 'openOrderActionCount',
    label: 'Open order actions',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldOrderPlanningRows,
    explanation: 'Orders with a recorded next step. Use this to size today’s order follow-up workload.',
  },
  {
    key: 'supplierAttentionMoneyAtRisk',
    label: 'Supplier attention money',
    unit: 'currency',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldSupplierAttentionRows,
    explanation: 'Profit depending on suppliers that need attention. Lower means supplier risk is under control.',
  },
  {
    key: 'supplierAttentionCount',
    label: 'Supplier attention rows',
    unit: 'count',
    aggregation: 'latest',
    higherIsBetter: false,
    sourceLayer: 'gold',
    sourceCollection: ECOBASE_COLLECTIONS.goldSupplierAttentionRows,
    explanation: 'Suppliers needing contact, approval, lead-time, or follow-up work.',
  },
];

const DEFINITION_BY_KEY = new Map(MANAGEMENT_KPI_FACT_DEFINITIONS.map((definition) => [definition.key, definition]));

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

function safeNumber(value: unknown) {
  return asNumber(value) ?? 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stableUuid(value: string) {
  const hex = createHash('sha1').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeDate(value: string, label = 'date') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Ecobase management KPI facts failed: ${label} must be an ISO date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Ecobase management KPI facts failed: ${label} is not a valid calendar date.`);
  }
  return value;
}

function dateOnly(value: unknown) {
  return asString(value)?.slice(0, 10);
}

function dateAdd(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function inRange(date: unknown, start: string, end: string) {
  const value = dateOnly(date);
  return Boolean(value && value >= start && value <= end);
}

function onOrBefore(date: unknown, end: string) {
  const value = dateOnly(date);
  return Boolean(value && value <= end);
}

function beforeDate(date: unknown, end: string) {
  const value = dateOnly(date);
  return Boolean(value && value < end);
}

function companyScope(company?: string) {
  return company ?? 'all';
}

function companyMatches(rowCompany: string | undefined, company?: string) {
  return !company || rowCompany === company;
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

function isClosedStatus(value: unknown) {
  const status = (asString(value) ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  return CLOSED_ORDER_STATUS_PARTS.some((part) => status.includes(part));
}

function asPlainRows(rows: unknown[]) {
  return rows.map(toPlainRecord);
}

function latestFact(facts: PlainRecord[]) {
  return [...facts].sort((left, right) =>
    String(right.metricDate ?? '').localeCompare(String(left.metricDate ?? '')),
  )[0];
}

function numericValue(fact?: PlainRecord) {
  return fact ? asNumber(fact.value) ?? null : null;
}

function directionForDelta(current: number, previous: number, higherIsBetter: boolean): ManagementKpiDirection {
  const delta = current - previous;
  if (previous === 0 && current !== 0) return 'new';
  if (Math.abs(delta) < 0.0001) return 'flat';
  return (higherIsBetter ? delta > 0 : delta < 0) ? 'improved' : 'regressed';
}

function toneForDirection(direction: ManagementKpiDirection): ManagementKpiTone {
  if (direction === 'improved') return 'success';
  if (direction === 'regressed') return 'error';
  if (direction === 'new') return 'warning';
  return 'default';
}

function slopePerDay(facts: PlainRecord[]) {
  const ordered = [...facts]
    .map((fact) => ({ date: dateOnly(fact.metricDate), value: asNumber(fact.value) }))
    .filter((item): item is { date: string; value: number } => Boolean(item.date && typeof item.value === 'number'))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (ordered.length < 2) return null;
  const first = new Date(`${ordered[0].date}T00:00:00.000Z`).getTime();
  const points = ordered.map((item) => ({
    x: (new Date(`${item.date}T00:00:00.000Z`).getTime() - first) / 86_400_000,
    y: item.value,
  }));
  const xMean = points.reduce((total, item) => total + item.x, 0) / points.length;
  const yMean = points.reduce((total, item) => total + item.y, 0) / points.length;
  const denominator = points.reduce((total, item) => total + (item.x - xMean) ** 2, 0);
  if (denominator === 0) return null;
  const numerator = points.reduce((total, item) => total + (item.x - xMean) * (item.y - yMean), 0);
  return round(numerator / denominator, 3);
}

function factPointCount(facts: PlainRecord[]) {
  return new Set(facts.map((fact) => dateOnly(fact.metricDate)).filter(Boolean)).size;
}

function sourceWindow(facts: PlainRecord[], edge: 'start' | 'end') {
  const dates = facts
    .map((fact) => dateOnly(fact.metricDate))
    .filter((date): date is string => Boolean(date))
    .sort();
  return edge === 'start' ? dates[0] ?? null : dates[dates.length - 1] ?? null;
}

function ratioFromPayload(facts: PlainRecord[], numeratorKey: string, denominatorKey: string) {
  let numerator = 0;
  let denominator = 0;
  for (const fact of facts) {
    const payload = isRecord(fact.payload) ? fact.payload : {};
    numerator += safeNumber(payload[numeratorKey]);
    denominator += safeNumber(payload[denominatorKey]);
  }
  if (denominator > 0) return round((numerator / denominator) * 100, 1);
  const values = facts.map(numericValue).filter((value): value is number => typeof value === 'number');
  return values.length ? round(values.reduce((total, value) => total + value, 0) / values.length, 1) : null;
}

function weightedAverageFromPayload(facts: PlainRecord[], weightKey: string) {
  let weightedTotal = 0;
  let weightTotal = 0;
  let simpleTotal = 0;
  let simpleCount = 0;
  for (const fact of facts) {
    const value = numericValue(fact);
    if (typeof value !== 'number') continue;
    simpleTotal += value;
    simpleCount += 1;
    const payload = isRecord(fact.payload) ? fact.payload : {};
    const weight = Math.max(safeNumber(payload[weightKey]), 0);
    if (weight > 0) {
      weightedTotal += value * weight;
      weightTotal += weight;
    }
  }
  if (weightTotal > 0) return round(weightedTotal / weightTotal, 1);
  return simpleCount > 0 ? round(simpleTotal / simpleCount, 1) : null;
}

function aggregateFacts(definition: MetricDefinition, facts: PlainRecord[]) {
  if (!facts.length) return null;
  if (definition.aggregation === 'sum')
    return round(
      facts.reduce((total, fact) => total + safeNumber(fact.value), 0),
      2,
    );
  if (definition.aggregation === 'latest') return numericValue(latestFact(facts));
  if (definition.key === 'margin') return ratioFromPayload(facts, 'profit', 'sales');
  if (definition.key === 'refundRate') return ratioFromPayload(facts, 'refunds', 'units');
  if (definition.aggregation === 'weighted_average') return weightedAverageFromPayload(facts, 'sessions');
  return null;
}

function makeFact(values: FactValues): PlainRecord {
  const definition = DEFINITION_BY_KEY.get(values.metricKey);
  if (!definition) {
    throw new Error(`Ecobase management KPI facts failed: metric "${values.metricKey}" is not defined.`);
  }
  const naturalKey = `${METRIC_VERSION}:${values.metricDate}:${values.companyScope}:${values.metricKey}`;
  return {
    id: stableUuid(naturalKey),
    naturalKey,
    metricDate: values.metricDate,
    company: values.company,
    companyScope: values.companyScope,
    metricKey: values.metricKey,
    metricLabel: definition.label,
    unit: definition.unit,
    value: values.value,
    aggregation: definition.aggregation,
    higherIsBetter: definition.higherIsBetter,
    sourceLayer: definition.sourceLayer,
    sourceCollection: definition.sourceCollection,
    sourceDateStart: values.sourceDateStart,
    sourceDateEnd: values.sourceDateEnd,
    sourceRowCount: values.sourceRowCount,
    sourceGoldDate: values.sourceGoldDate,
    metricVersion: METRIC_VERSION,
    generatedAt: new Date().toISOString(),
    payload: values.payload ?? {},
  };
}

function addSummary(summary: FactBuildSummary, fact: PlainRecord) {
  summary.factCount += 1;
  const key = asString(fact.metricKey) ?? 'unknown';
  summary.metrics[key] = (summary.metrics[key] ?? 0) + 1;
  const metricDate = dateOnly(fact.metricDate);
  if (metricDate) {
    summary.dateStart = summary.dateStart && summary.dateStart < metricDate ? summary.dateStart : metricDate;
    summary.dateEnd = summary.dateEnd && summary.dateEnd > metricDate ? summary.dateEnd : metricDate;
  }
}

function pushScopedRow<T extends { company?: string }>(groups: Map<string, T[]>, row: T, company?: string) {
  if (company) {
    if (row.company === company) groups.set(company, [...(groups.get(company) ?? []), row]);
    return;
  }
  groups.set('all', [...(groups.get('all') ?? []), row]);
  if (row.company) groups.set(row.company, [...(groups.get(row.company) ?? []), row]);
}

function pushDailyScopedRow<T extends { metricDate: string; company?: string }>(
  groups: Map<string, T[]>,
  row: T,
  company?: string,
) {
  const add = (scope: string) =>
    groups.set(`${row.metricDate}:${scope}`, [...(groups.get(`${row.metricDate}:${scope}`) ?? []), row]);
  if (company) {
    if (row.company === company) add(company);
    return;
  }
  add('all');
  if (row.company) add(row.company);
}

function dailyGroupParts(key: string) {
  const [metricDate, ...scopeParts] = key.split(':');
  return { metricDate, scope: scopeParts.join(':') };
}

export class EcobaseManagementKpiFactsService {
  constructor(private db: EcobaseDatabase) {}

  async refreshForDate(params: { date: string; company?: string }): Promise<FactBuildSummary> {
    const date = normalizeDate(params.date);
    const silverFacts = await this.buildSilverFacts({ startDate: date, endDate: date, company: params.company });
    const goldFacts = await this.buildGoldFacts(date, params.company);
    return this.upsertFacts([...silverFacts, ...goldFacts], []);
  }

  async backfillSilverDerivedFacts(params: {
    startDate: string;
    endDate: string;
    company?: string;
  }): Promise<FactBuildSummary> {
    const startDate = normalizeDate(params.startDate, 'startDate');
    const endDate = normalizeDate(params.endDate, 'endDate');
    if (startDate > endDate) {
      throw new Error('Ecobase management KPI facts backfill failed: startDate must be on or before endDate.');
    }
    const facts = await this.buildSilverFacts({ startDate, endDate, company: params.company });
    return this.upsertFacts(facts, [
      'inventoryMoneyAtRisk',
      'urgentInventorySkuCount',
      'overdueInventorySkuCount',
      'aTierInventoryRiskCount',
      'next7DayOosSkuCount',
      'missingLeadTimeCount',
      'staleLeadTimeCount',
      'orderMoneyAtRisk',
      'ordersNeedingCheck',
      'staleOrderCount',
      'openOrderActionCount',
      'supplierAttentionMoneyAtRisk',
      'supplierAttentionCount',
    ]);
  }

  async getTrend(params: {
    date: string;
    company?: string;
    period?: ManagementKpiPeriod;
  }): Promise<ManagementKpiTrendResult> {
    const date = normalizeDate(params.date);
    const company = asString(params.company);
    const period = params.period ?? '7d';
    const days = PERIOD_DAYS[period];
    const scope = companyScope(company);
    const facts = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts).find({
        filter: { companyScope: scope, metricVersion: METRIC_VERSION },
        sort: ['metricDate'],
        limit: 100000,
      }),
    ).filter((fact) => onOrBefore(fact.metricDate, date));
    const warnings = [] as string[];
    const kpis = MANAGEMENT_KPI_FACT_DEFINITIONS.map((definition) => {
      const metricFacts = facts.filter((fact) => asString(fact.metricKey) === definition.key);
      const anchor = metricFacts
        .map((fact) => dateOnly(fact.metricDate))
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      if (!anchor) {
        return this.insufficientTrend(definition, period, days, null, null, 'insufficient_history');
      }
      if (anchor < date) {
        warnings.push(`${definition.label} uses source data through ${anchor}; requested brief date is ${date}.`);
      }
      const currentStart = dateAdd(anchor, -(days - 1));
      const previousEnd = dateAdd(currentStart, -1);
      const previousStart = dateAdd(previousEnd, -(days - 1));
      const currentFacts = metricFacts.filter((fact) => inRange(fact.metricDate, currentStart, anchor));
      const previousFacts = metricFacts.filter((fact) => inRange(fact.metricDate, previousStart, previousEnd));
      const currentValue = aggregateFacts(definition, currentFacts);
      const previousValue = aggregateFacts(definition, previousFacts);
      const currentPointCount = factPointCount(currentFacts);
      const previousPointCount = factPointCount(previousFacts);
      if (currentValue === null || previousValue === null || currentPointCount < days || previousPointCount < days) {
        return this.insufficientTrend(
          definition,
          period,
          days,
          currentFacts,
          previousFacts,
          currentValue === null || currentPointCount < days ? 'insufficient_history' : 'partial_history',
        );
      }
      const absoluteDelta = round(currentValue - previousValue, 2);
      const percentDelta =
        previousValue === 0
          ? currentValue === 0
            ? 0
            : null
          : round((absoluteDelta / Math.abs(previousValue)) * 100, 1);
      const direction = directionForDelta(currentValue, previousValue, definition.higherIsBetter);
      const confidence: ManagementKpiConfidence = 'complete';
      return {
        key: definition.key,
        label: definition.label,
        value: currentValue,
        previousValue,
        absoluteDelta,
        percentDelta,
        slopePerDay: slopePerDay(currentFacts),
        direction,
        tone: toneForDirection(direction),
        period,
        unit: definition.unit,
        higherIsBetter: definition.higherIsBetter,
        explanation: definition.explanation,
        confidence,
        currentPointCount,
        previousPointCount,
        expectedPointCount: days,
        sourceLayer: definition.sourceLayer,
        sourceCollection: definition.sourceCollection,
        sourceWindowStart: sourceWindow(currentFacts, 'start'),
        sourceWindowEnd: sourceWindow(currentFacts, 'end'),
        previousSourceWindowStart: sourceWindow(previousFacts, 'start'),
        previousSourceWindowEnd: sourceWindow(previousFacts, 'end'),
        warning: confidence === 'partial' ? 'partial_history' : undefined,
      };
    });
    return {
      date,
      ...(company ? { company } : {}),
      period,
      kpis,
      availablePeriods: ['yesterday', '7d', '30d'],
      warnings,
    };
  }

  private insufficientTrend(
    definition: MetricDefinition,
    period: ManagementKpiPeriod,
    expectedPointCount: number,
    currentFacts: PlainRecord[] | null,
    previousFacts: PlainRecord[] | null,
    warning: string,
  ): ManagementKpiTrend {
    return {
      key: definition.key,
      label: definition.label,
      value: currentFacts ? aggregateFacts(definition, currentFacts) : null,
      previousValue: previousFacts ? aggregateFacts(definition, previousFacts) : null,
      absoluteDelta: null,
      percentDelta: null,
      slopePerDay: currentFacts ? slopePerDay(currentFacts) : null,
      direction: 'insufficient_history',
      tone: 'default',
      period,
      unit: definition.unit,
      higherIsBetter: definition.higherIsBetter,
      explanation: definition.explanation,
      confidence: 'insufficient',
      currentPointCount: currentFacts ? factPointCount(currentFacts) : 0,
      previousPointCount: previousFacts ? factPointCount(previousFacts) : 0,
      expectedPointCount,
      sourceLayer: definition.sourceLayer,
      sourceCollection: definition.sourceCollection,
      sourceWindowStart: currentFacts ? sourceWindow(currentFacts, 'start') : null,
      sourceWindowEnd: currentFacts ? sourceWindow(currentFacts, 'end') : null,
      previousSourceWindowStart: previousFacts ? sourceWindow(previousFacts, 'start') : null,
      previousSourceWindowEnd: previousFacts ? sourceWindow(previousFacts, 'end') : null,
      warning,
    };
  }

  private async upsertFacts(facts: PlainRecord[], skippedMetrics: string[]): Promise<FactBuildSummary> {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts);
    const summary: FactBuildSummary = { factCount: 0, metrics: {}, skippedMetrics };
    for (const fact of facts) {
      const naturalKey = asString(fact.naturalKey);
      if (!naturalKey) {
        throw new Error('Ecobase management KPI facts failed: fact is missing naturalKey.');
      }
      const existing = toPlainRecord(await repository.findOne({ filter: { naturalKey } }));
      if (existing.id) {
        await repository.update({ filterByTk: asString(existing.id) ?? fact.id, values: fact });
      } else {
        await repository.create({ values: fact });
      }
      addSummary(summary, fact);
    }
    return summary;
  }

  private async buildSilverFacts(params: { startDate: string; endDate: string; company?: string }) {
    const companyByProductId = await this.companyByProductId();
    const listingRows = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).find({ limit: 100000 }),
    ).filter((row) => inRange(row.snapshotDate, params.startDate, params.endDate));
    const trafficRows = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).find({ limit: 100000 }),
    ).filter((row) => inRange(row.snapshotDate, params.startDate, params.endDate));
    return [
      ...this.buildListingFacts(listingRows, companyByProductId, params.company),
      ...this.buildTrafficFacts(trafficRows, companyByProductId, params.company),
    ];
  }

  private buildListingFacts(rows: PlainRecord[], companyByProductId: Map<string, string>, company?: string) {
    type ListingRow = PlainRecord & { metricDate: string; company?: string };
    const groups = new Map<string, ListingRow[]>();
    for (const row of rows) {
      const metricDate = dateOnly(row.snapshotDate);
      if (!metricDate) continue;
      const rowCompany =
        asString(row.company) ??
        asString(row.companyName) ??
        companyByProductId.get(asString(row.companyProductId) ?? '');
      if (!companyMatches(rowCompany, company)) continue;
      pushDailyScopedRow(groups, { ...row, metricDate, company: rowCompany }, company);
    }
    const facts = [] as PlainRecord[];
    for (const [key, groupRows] of groups) {
      const { metricDate, scope } = dailyGroupParts(key);
      const companyName = scope === 'all' ? undefined : scope;
      const sales = sum(groupRows, 'sales');
      const profit = round(
        groupRows.reduce(
          (total, row) => total + (asNumber(row.profit) ?? asNumber(row.netProfit) ?? asNumber(row.grossProfit) ?? 0),
          0,
        ),
        2,
      );
      const units = sum(groupRows, 'units');
      const refunds = sum(groupRows, 'refunds');
      const margin = sales > 0 ? round((profit / sales) * 100, 1) : null;
      const refundRate = units > 0 ? round((refunds / units) * 100, 1) : null;
      const common = {
        metricDate,
        company: companyName,
        companyScope: scope,
        sourceDateStart: metricDate,
        sourceDateEnd: metricDate,
        sourceRowCount: groupRows.length,
      };
      facts.push(
        makeFact({ ...common, metricKey: 'sales', value: sales, payload: { sales } }),
        makeFact({ ...common, metricKey: 'profit', value: profit, payload: { profit } }),
        makeFact({ ...common, metricKey: 'units', value: units, payload: { units } }),
        makeFact({ ...common, metricKey: 'margin', value: margin, payload: { sales, profit } }),
        makeFact({ ...common, metricKey: 'refundRate', value: refundRate, payload: { refunds, units } }),
      );
    }
    return facts;
  }

  private buildTrafficFacts(rows: PlainRecord[], companyByProductId: Map<string, string>, company?: string) {
    type TrafficRow = PlainRecord & { metricDate: string; company?: string };
    const groups = new Map<string, TrafficRow[]>();
    for (const row of rows) {
      const metricDate = dateOnly(row.snapshotDate);
      if (!metricDate) continue;
      const rowCompany =
        asString(row.company) ??
        asString(row.companyName) ??
        companyByProductId.get(asString(row.companyProductId) ?? '');
      if (!companyMatches(rowCompany, company)) continue;
      pushDailyScopedRow(groups, { ...row, metricDate, company: rowCompany }, company);
    }
    const facts = [] as PlainRecord[];
    for (const [key, groupRows] of groups) {
      const { metricDate, scope } = dailyGroupParts(key);
      const companyName = scope === 'all' ? undefined : scope;
      const sessions = sum(groupRows, 'sessions');
      const buyBoxPct = this.weightedMetric(groupRows, 'buyBoxPercentage', 'sessions');
      const conversionRate = this.weightedMetric(groupRows, 'conversionRate', 'sessions');
      const common = {
        metricDate,
        company: companyName,
        companyScope: scope,
        sourceDateStart: metricDate,
        sourceDateEnd: metricDate,
        sourceRowCount: groupRows.length,
      };
      facts.push(
        makeFact({ ...common, metricKey: 'buyBoxPct', value: buyBoxPct, payload: { sessions } }),
        makeFact({ ...common, metricKey: 'conversionRate', value: conversionRate, payload: { sessions } }),
      );
    }
    return facts;
  }

  private weightedMetric(rows: PlainRecord[], valueField: string, weightField: string) {
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
    return simpleCount > 0 ? round(simpleTotal / simpleCount, 1) : null;
  }

  private async companyByProductId() {
    const companies = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({ limit: 10000 }),
    );
    const companyNameById = new Map(
      companies.flatMap((company) => {
        const id = asString(company.id);
        const name = asString(company.name);
        return id && name ? [[id, name] as const] : [];
      }),
    );
    const products = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: 100000 }),
    );
    return new Map(
      products.flatMap((product) => {
        const id = asString(product.id);
        const name = asString(product.companyName) ?? companyNameById.get(asString(product.companyId) ?? '');
        return id && name ? [[id, name] as const] : [];
      }),
    );
  }

  private async buildGoldFacts(date: string, company?: string) {
    return [
      ...(await this.buildInventoryFacts(date, company)),
      ...(await this.buildOrderFacts(date, company)),
      ...(await this.buildSupplierFacts(date, company)),
    ];
  }

  private scopedGroups(rows: PlainRecord[], company?: string) {
    const groups = new Map<string, PlainRecord[]>();
    for (const row of rows) {
      const rowCompany = asString(row.company) ?? asString(row.companyName);
      if (!companyMatches(rowCompany, company)) continue;
      pushScopedRow(groups, { ...row, company: rowCompany }, company);
    }
    return groups;
  }

  private async buildInventoryFacts(date: string, company?: string) {
    const rows = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({
        filter: company ? { calculationDate: date, company } : { calculationDate: date },
        limit: 100000,
      }),
    );
    const facts = [] as PlainRecord[];
    for (const [scope, groupRows] of this.scopedGroups(rows, company)) {
      const activeRows = groupRows.filter((row) => ACTIVE_INVENTORY_ACTIONS.has(asString(row.actionStatus) ?? ''));
      const companyName = scope === 'all' ? undefined : scope;
      const common = {
        metricDate: date,
        company: companyName,
        companyScope: scope,
        sourceDateStart: date,
        sourceDateEnd: date,
        sourceGoldDate: date,
        sourceRowCount: groupRows.length,
      };
      facts.push(
        makeFact({ ...common, metricKey: 'inventoryMoneyAtRisk', value: sum(activeRows, 'estimatedProfitRisk') }),
        makeFact({ ...common, metricKey: 'urgentInventorySkuCount', value: activeRows.length }),
        makeFact({
          ...common,
          metricKey: 'overdueInventorySkuCount',
          value: count(activeRows, (row) => asString(row.actionStatus) === 'overdue'),
        }),
        makeFact({
          ...common,
          metricKey: 'aTierInventoryRiskCount',
          value: count(activeRows, (row) => asString(row.tier) === 'A'),
        }),
        makeFact({
          ...common,
          metricKey: 'next7DayOosSkuCount',
          value: count(activeRows, (row) => onOrBefore(row.estimatedOosDate, dateAdd(date, 7))),
        }),
        makeFact({
          ...common,
          metricKey: 'missingLeadTimeCount',
          value: count(
            activeRows,
            (row) =>
              asString(row.leadTimeFreshness) === 'missing' || asString(row.actionStatus) === 'missing_lead_time',
          ),
        }),
        makeFact({
          ...common,
          metricKey: 'staleLeadTimeCount',
          value: count(activeRows, (row) => asString(row.leadTimeFreshness) === 'stale'),
        }),
      );
    }
    return facts;
  }

  private async buildOrderFacts(date: string, company?: string) {
    const rows = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).find({
        filter: company ? { companyName: company } : {},
        limit: 100000,
      }),
    )
      .filter((row) => !dateOnly(row.latestGoldCalculationDate) || dateOnly(row.latestGoldCalculationDate) === date)
      .filter((row) => !isClosedStatus(row.currentStatus ?? row.canonicalStatus ?? row.lifecycleStatus));
    const facts = [] as PlainRecord[];
    for (const [scope, groupRows] of this.scopedGroups(rows, company)) {
      const riskyRows = groupRows.filter(
        (row) =>
          Boolean(row.statusCheckRequired) ||
          safeNumber(row.moneyAtRisk) > 0 ||
          Boolean(asString(row.nextAction)) ||
          safeNumber(row.daysSinceLastActivity) >= 3,
      );
      const companyName = scope === 'all' ? undefined : scope;
      const common = {
        metricDate: date,
        company: companyName,
        companyScope: scope,
        sourceDateStart: date,
        sourceDateEnd: date,
        sourceGoldDate: date,
        sourceRowCount: groupRows.length,
      };
      facts.push(
        makeFact({ ...common, metricKey: 'orderMoneyAtRisk', value: sum(riskyRows, 'moneyAtRisk') }),
        makeFact({
          ...common,
          metricKey: 'ordersNeedingCheck',
          value: count(riskyRows, (row) => Boolean(row.statusCheckRequired)),
        }),
        makeFact({
          ...common,
          metricKey: 'staleOrderCount',
          value: count(
            riskyRows,
            (row) => safeNumber(row.daysSinceLastActivity) >= 7 || beforeDate(row.nextActionDueAt, date),
          ),
        }),
        makeFact({
          ...common,
          metricKey: 'openOrderActionCount',
          value: count(riskyRows, (row) => Boolean(asString(row.nextAction))),
        }),
      );
    }
    return facts;
  }

  private async buildSupplierFacts(date: string, company?: string) {
    const rows = asPlainRows(
      await this.db.getRepository(ECOBASE_COLLECTIONS.goldSupplierAttentionRows).find({
        filter: company ? { calculationDate: date, companyName: company } : { calculationDate: date },
        limit: 100000,
      }),
    );
    const facts = [] as PlainRecord[];
    for (const [scope, groupRows] of this.scopedGroups(rows, company)) {
      const companyName = scope === 'all' ? undefined : scope;
      const common = {
        metricDate: date,
        company: companyName,
        companyScope: scope,
        sourceDateStart: date,
        sourceDateEnd: date,
        sourceGoldDate: date,
        sourceRowCount: groupRows.length,
      };
      facts.push(
        makeFact({ ...common, metricKey: 'supplierAttentionMoneyAtRisk', value: sum(groupRows, 'moneyAtRisk') }),
        makeFact({ ...common, metricKey: 'supplierAttentionCount', value: groupRows.length }),
      );
    }
    return facts;
  }
}
