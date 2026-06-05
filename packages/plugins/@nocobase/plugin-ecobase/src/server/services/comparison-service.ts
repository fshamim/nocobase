import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';

type PlainRecord = Record<string, unknown>;
type ComparisonGroupBy = 'company' | 'account' | 'planning_product' | 'raw_listing_sku' | 'tier';
type ComparisonPeriodType = 'daily' | 'weekly' | 'monthly';

type PeriodRange = {
  startDate: string;
  endDate: string;
};

type FactTotals = {
  sales: number;
  units: number;
  refunds: number;
  grossProfit: number;
  netProfit: number;
  sessions: number;
  factCount: number;
};

type GroupAccumulator = {
  key: string;
  label: string;
  groupBy: ComparisonGroupBy;
  company?: string;
  accountKey?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  tier?: string;
  current: FactTotals;
  previous: FactTotals;
  currentTargetProfit: number;
  previousTargetProfit: number;
  warnings: ComparisonWarning[];
};

export type ComparisonWarning = {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  groupKey?: string;
  evidence?: PlainRecord;
};

export type ComparisonMetricSet = FactTotals & {
  targetProfit: number | null;
  targetGap: number | null;
};

export type ComparisonResultRow = {
  key: string;
  label: string;
  groupBy: ComparisonGroupBy;
  company?: string;
  accountKey?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  tier?: string;
  current: ComparisonMetricSet;
  previous: ComparisonMetricSet;
  change: {
    netProfit: number;
    netProfitPercent: number | null;
    sales: number;
    salesPercent: number | null;
    units: number;
    unitsPercent: number | null;
  };
  classification: 'improving' | 'declining' | 'consistently_underperforming' | 'underperforming' | 'stable';
  warnings: ComparisonWarning[];
};

export type ComparisonSummary = {
  improving: ComparisonResultRow[];
  declining: ComparisonResultRow[];
  consistentlyUnderperforming: ComparisonResultRow[];
  accountTargetGaps: ComparisonResultRow[];
};

export type ComparisonReport = {
  periodType: ComparisonPeriodType;
  current: PeriodRange;
  previous: PeriodRange;
  groupBy: ComparisonGroupBy;
  rows: ComparisonResultRow[];
  summary: ComparisonSummary;
  warnings: ComparisonWarning[];
};

export type ComparePerformanceParams = {
  periodType: ComparisonPeriodType;
  period?: string;
  currentStartDate?: string;
  currentEndDate?: string;
  previousStartDate?: string;
  previousEndDate?: string;
  groupBy?: ComparisonGroupBy;
  company?: string;
  planningProductId?: string;
};

const EMPTY_TOTALS: FactTotals = {
  sales: 0,
  units: 0,
  refunds: 0,
  grossProfit: 0,
  netProfit: 0,
  sessions: 0,
  factCount: 0,
};

function cloneTotals(): FactTotals {
  return { ...EMPTY_TOTALS };
}

function toPlainRecord(value: unknown): PlainRecord {
  if (typeof value === 'object' && value !== null) {
    if (typeof (value as { get?: (key?: string) => unknown }).get === 'function') {
      const raw = (value as { get: (key?: string) => unknown }).get();
      return typeof raw === 'object' && raw !== null ? (raw as PlainRecord) : (value as PlainRecord);
    }
    return value as PlainRecord;
  }
  return {};
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

function payloadString(record: PlainRecord, key: string): string | undefined {
  return asString(payload(record)[key]);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Ecobase comparison failed: ${label} must be an ISO date.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== value) {
    throw new Error(`Ecobase comparison failed: ${label} is not a valid calendar date.`);
  }
  return date;
}

function daysBetweenInclusive(range: PeriodRange) {
  const start = parseIsoDate(range.startDate, 'range startDate');
  const end = parseIsoDate(range.endDate, 'range endDate');
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function monthRange(period: string): PeriodRange {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error('Ecobase comparison failed: monthly period must use YYYY-MM.');
  }
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function previousMonthRange(range: PeriodRange): PeriodRange {
  const start = parseIsoDate(range.startDate, 'currentStartDate');
  const previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const previousEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0));
  return { startDate: isoDate(previousStart), endDate: isoDate(previousEnd) };
}

function weekRange(period: string): PeriodRange {
  const match = period.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    throw new Error('Ecobase comparison failed: weekly period must use YYYY-Www.');
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) {
    throw new Error('Ecobase comparison failed: weekly period week number must be between 01 and 53.');
  }
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const day = januaryFourth.getUTCDay() || 7;
  const mondayWeekOne = addDays(januaryFourth, 1 - day);
  const start = addDays(mondayWeekOne, (week - 1) * 7);
  return { startDate: isoDate(start), endDate: isoDate(addDays(start, 6)) };
}

function deriveRanges(params: ComparePerformanceParams): { current: PeriodRange; previous: PeriodRange } {
  const current = params.currentStartDate && params.currentEndDate
    ? { startDate: params.currentStartDate, endDate: params.currentEndDate }
    : params.periodType === 'daily'
      ? { startDate: params.period ?? '', endDate: params.period ?? '' }
      : params.periodType === 'weekly'
        ? weekRange(params.period ?? '')
        : monthRange(params.period ?? '');

  parseIsoDate(current.startDate, 'currentStartDate');
  parseIsoDate(current.endDate, 'currentEndDate');
  if (current.startDate > current.endDate) {
    throw new Error('Ecobase comparison failed: currentStartDate must be before or equal to currentEndDate.');
  }

  if (params.previousStartDate && params.previousEndDate) {
    const previous = { startDate: params.previousStartDate, endDate: params.previousEndDate };
    parseIsoDate(previous.startDate, 'previousStartDate');
    parseIsoDate(previous.endDate, 'previousEndDate');
    return { current, previous };
  }

  if (params.periodType === 'monthly') {
    return { current, previous: previousMonthRange(current) };
  }
  const length = daysBetweenInclusive(current);
  const currentStart = parseIsoDate(current.startDate, 'currentStartDate');
  const previousEnd = addDays(currentStart, -1);
  const previousStart = addDays(previousEnd, 1 - length);
  return { current, previous: { startDate: isoDate(previousStart), endDate: isoDate(previousEnd) } };
}

function addFact(totals: FactTotals, fact: PlainRecord) {
  totals.sales += asNumber(fact.sales) ?? 0;
  totals.units += asNumber(fact.units) ?? 0;
  totals.refunds += asNumber(fact.refunds) ?? 0;
  totals.grossProfit += asNumber(fact.grossProfit) ?? 0;
  totals.netProfit += asNumber(fact.netProfit) ?? 0;
  totals.sessions += asNumber(fact.sessions) ?? 0;
  totals.factCount += 1;
}

function percentChange(current: number, previous: number) {
  if (previous === 0) {
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

function periodCode(periodType: ComparisonPeriodType, range: PeriodRange) {
  if (periodType === 'daily') {
    return range.startDate;
  }
  if (periodType === 'monthly') {
    return range.startDate.slice(0, 7);
  }
  return `${range.startDate}:${range.endDate}`;
}

function targetMatchesGroup(target: PlainRecord, groupBy: ComparisonGroupBy, group: GroupAccumulator) {
  if (groupBy === 'company') {
    return asString(target.company) === group.company;
  }
  if (groupBy === 'account') {
    return asString(target.accountKey) === group.accountKey;
  }
  if (groupBy === 'planning_product') {
    return asString(target.planningProductId) === group.planningProductId;
  }
  if (groupBy === 'raw_listing_sku') {
    return asString(target.sku) === group.sku && (!group.company || asString(target.company) === group.company);
  }
  return payloadString(target, 'tier') === group.tier || asString(target.targetScope) === 'tier' && asString(target.asin) === group.tier;
}

function targetTotal(targets: PlainRecord[], periodType: ComparisonPeriodType, range: PeriodRange, groupBy: ComparisonGroupBy, group: GroupAccumulator) {
  const period = periodCode(periodType, range);
  return targets
    .filter((target) => asString(target.periodType) === periodType && asString(target.period) === period && targetMatchesGroup(target, groupBy, group))
    .reduce((total, target) => total + (asNumber(target.profitTarget) ?? 0), 0);
}

function classify(current: ComparisonMetricSet, previous: ComparisonMetricSet): ComparisonResultRow['classification'] {
  if (current.targetGap !== null && previous.targetGap !== null && current.targetGap < 0 && previous.targetGap < 0) {
    return 'consistently_underperforming';
  }
  if (current.targetGap !== null && current.targetGap < 0) {
    return 'underperforming';
  }
  if (current.netProfit > previous.netProfit) {
    return 'improving';
  }
  if (current.netProfit < previous.netProfit) {
    return 'declining';
  }
  return 'stable';
}

export class EcobaseComparisonService {
  constructor(private db: EcobaseDatabase) {}

  async comparePerformance(params: ComparePerformanceParams): Promise<ComparisonReport> {
    const groupBy = params.groupBy ?? 'planning_product';
    const { current, previous } = deriveRanges(params);
    const facts = (await this.db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).find({})).map(toPlainRecord);
    const targets = (await this.db.getRepository(ECOBASE_COLLECTIONS.targetRows).find({})).map(toPlainRecord);
    const calculationSnapshots = (await this.db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).find({})).map(toPlainRecord);
    const importRuns = (await this.db.getRepository(ECOBASE_COLLECTIONS.importRuns).find({})).map(toPlainRecord);

    const groups = new Map<string, GroupAccumulator>();
    this.assignFacts(groups, facts, current, previous, groupBy, params, calculationSnapshots);
    const warnings = this.periodWarnings(facts, importRuns, current, previous);

    const rows = [...groups.values()].map((group) => this.resultRow(group, targets, params.periodType, current, previous));
    rows.forEach((row) => {
      if (row.previous.factCount === 0) {
        row.warnings.push({
          code: 'missing_prior_period',
          severity: 'warning',
          message: `No prior-period facts are available for ${row.label}.`,
          groupKey: row.key,
        });
      }
    });

    return {
      periodType: params.periodType,
      current,
      previous,
      groupBy,
      rows: rows.sort((left, right) => right.current.netProfit - left.current.netProfit),
      summary: {
        improving: rows.filter((row) => row.classification === 'improving'),
        declining: rows.filter((row) => row.classification === 'declining'),
        consistentlyUnderperforming: rows.filter((row) => row.classification === 'consistently_underperforming'),
        accountTargetGaps: rows.filter((row) => row.groupBy === 'account' && row.current.targetGap !== null && row.current.targetGap < 0),
      },
      warnings,
    };
  }

  private assignFacts(
    groups: Map<string, GroupAccumulator>,
    facts: PlainRecord[],
    current: PeriodRange,
    previous: PeriodRange,
    groupBy: ComparisonGroupBy,
    params: ComparePerformanceParams,
    calculationSnapshots: PlainRecord[],
  ) {
    for (const fact of facts) {
      const snapshotDate = asString(fact.snapshotDate);
      if (!snapshotDate || !this.inAnyRange(snapshotDate, current, previous)) {
        continue;
      }
      if (params.company && asString(fact.company) !== params.company) {
        continue;
      }
      if (params.planningProductId && asString(fact.planningProductId) !== params.planningProductId) {
        continue;
      }
      const group = this.groupForFact(groups, fact, groupBy, calculationSnapshots, current.endDate);
      if (snapshotDate >= current.startDate && snapshotDate <= current.endDate) {
        addFact(group.current, fact);
      } else {
        addFact(group.previous, fact);
      }
    }
  }

  private inAnyRange(snapshotDate: string, current: PeriodRange, previous: PeriodRange) {
    return (snapshotDate >= current.startDate && snapshotDate <= current.endDate) || (snapshotDate >= previous.startDate && snapshotDate <= previous.endDate);
  }

  private groupForFact(
    groups: Map<string, GroupAccumulator>,
    fact: PlainRecord,
    groupBy: ComparisonGroupBy,
    calculationSnapshots: PlainRecord[],
    currentEndDate: string,
  ) {
    const key = this.groupKey(fact, groupBy, calculationSnapshots, currentEndDate);
    const existing = groups.get(key);
    if (existing) {
      return existing;
    }
    const record = this.newGroup(key, fact, groupBy, calculationSnapshots, currentEndDate);
    groups.set(key, record);
    return record;
  }

  private groupKey(fact: PlainRecord, groupBy: ComparisonGroupBy, calculationSnapshots: PlainRecord[], currentEndDate: string) {
    if (groupBy === 'company') {
      return asString(fact.company) ?? 'unknown-company';
    }
    if (groupBy === 'account') {
      return payloadString(fact, 'accountKey') ?? 'unknown-account';
    }
    if (groupBy === 'planning_product') {
      return asString(fact.planningProductId) ?? `${asString(fact.company) ?? 'unknown'}:${asString(fact.asin) ?? 'unknown-asin'}`;
    }
    if (groupBy === 'raw_listing_sku') {
      return [asString(fact.company) ?? 'unknown-company', asString(fact.asin) ?? 'unknown-asin', asString(fact.sku) ?? 'unknown-sku'].join(':');
    }
    return this.tierForFact(fact, calculationSnapshots, currentEndDate) ?? 'unclassified';
  }

  private newGroup(
    key: string,
    fact: PlainRecord,
    groupBy: ComparisonGroupBy,
    calculationSnapshots: PlainRecord[],
    currentEndDate: string,
  ): GroupAccumulator {
    const tier = this.tierForFact(fact, calculationSnapshots, currentEndDate);
    return {
      key,
      label: this.groupLabel(key, fact, groupBy, tier),
      groupBy,
      company: asString(fact.company),
      accountKey: payloadString(fact, 'accountKey'),
      planningProductId: asString(fact.planningProductId),
      asin: asString(fact.asin),
      sku: asString(fact.sku),
      tier,
      current: cloneTotals(),
      previous: cloneTotals(),
      currentTargetProfit: 0,
      previousTargetProfit: 0,
      warnings: [],
    };
  }

  private groupLabel(key: string, fact: PlainRecord, groupBy: ComparisonGroupBy, tier?: string) {
    if (groupBy === 'company') {
      return asString(fact.company) ?? key;
    }
    if (groupBy === 'account') {
      return payloadString(fact, 'accountKey') ?? key;
    }
    if (groupBy === 'planning_product') {
      return asString(fact.asin) ?? asString(fact.planningProductId) ?? key;
    }
    if (groupBy === 'raw_listing_sku') {
      return [asString(fact.asin), asString(fact.sku)].filter(Boolean).join(' / ') || key;
    }
    return tier ?? key;
  }

  private tierForFact(fact: PlainRecord, calculationSnapshots: PlainRecord[], currentEndDate: string) {
    const directTier = payloadString(fact, 'tier');
    if (directTier) {
      return directTier;
    }
    const planningProductId = asString(fact.planningProductId);
    if (!planningProductId) {
      return undefined;
    }
    return calculationSnapshots
      .filter((snapshot) => asString(snapshot.planningProductId) === planningProductId && asString(snapshot.calculationDate) <= currentEndDate)
      .sort((left, right) => String(right.calculationDate ?? '').localeCompare(String(left.calculationDate ?? '')))
      .map((snapshot) => asString(snapshot.tier))
      .find(Boolean);
  }

  private resultRow(group: GroupAccumulator, targets: PlainRecord[], periodType: ComparisonPeriodType, currentRange: PeriodRange, previousRange: PeriodRange): ComparisonResultRow {
    const currentTarget = targetTotal(targets, periodType, currentRange, group.groupBy, group);
    const previousTarget = targetTotal(targets, periodType, previousRange, group.groupBy, group);
    const current = this.metricSet(group.current, currentTarget);
    const previous = this.metricSet(group.previous, previousTarget);
    return {
      key: group.key,
      label: group.label,
      groupBy: group.groupBy,
      company: group.company,
      accountKey: group.accountKey,
      planningProductId: group.planningProductId,
      asin: group.asin,
      sku: group.sku,
      tier: group.tier,
      current,
      previous,
      change: {
        netProfit: current.netProfit - previous.netProfit,
        netProfitPercent: percentChange(current.netProfit, previous.netProfit),
        sales: current.sales - previous.sales,
        salesPercent: percentChange(current.sales, previous.sales),
        units: current.units - previous.units,
        unitsPercent: percentChange(current.units, previous.units),
      },
      classification: classify(current, previous),
      warnings: [...group.warnings],
    };
  }

  private metricSet(totals: FactTotals, target: number): ComparisonMetricSet {
    return {
      ...totals,
      targetProfit: target > 0 ? target : null,
      targetGap: target > 0 ? totals.netProfit - target : null,
    };
  }

  private periodWarnings(facts: PlainRecord[], importRuns: PlainRecord[], current: PeriodRange, previous: PeriodRange): ComparisonWarning[] {
    const currentCount = facts.filter((fact) => {
      const snapshotDate = asString(fact.snapshotDate);
      return snapshotDate && snapshotDate >= current.startDate && snapshotDate <= current.endDate;
    }).length;
    const previousCount = facts.filter((fact) => {
      const snapshotDate = asString(fact.snapshotDate);
      return snapshotDate && snapshotDate >= previous.startDate && snapshotDate <= previous.endDate;
    }).length;
    const warnings: ComparisonWarning[] = [];
    if (currentCount === 0) {
      warnings.push({ code: 'missing_current_period', severity: 'critical', message: 'No current-period facts are available for this comparison.' });
    }
    if (previousCount === 0) {
      warnings.push({ code: 'missing_prior_period', severity: 'warning', message: 'No prior-period facts are available for this comparison.' });
    }
    const incompleteRuns = importRuns.filter((run) => ['partial', 'failed', 'skipped'].includes(asString(run.status) ?? ''));
    for (const run of incompleteRuns) {
      warnings.push({
        code: asString(run.status) === 'skipped' ? 'no_newer_data_skipped' : 'incomplete_source_period',
        severity: asString(run.status) === 'failed' ? 'critical' : 'warning',
        message: `Comparison may be affected by ${asString(run.status)} import run ${asString(run.id) ?? '(unknown)'}.`,
        evidence: { importRunId: asString(run.id), status: asString(run.status), sourceVersion: asString(run.sourceVersion) },
      });
    }
    return warnings;
  }
}
