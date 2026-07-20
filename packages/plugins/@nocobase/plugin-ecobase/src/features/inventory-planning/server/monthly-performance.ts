/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';

const PerformanceDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export const INDIVIDUAL_MONTHLY_PERFORMANCE_ALGORITHM_VERSION = 'individual_monthly_profit_performance_v1';
export const MONTHLY_PERFORMANCE_CANONICAL_SERIALIZER_VERSION = 'canonical_json_decimal8_v1';
export const MONTHLY_PERFORMANCE_EVIDENCE_DIGEST_VERSION = 'monthly_performance_evidence_digest_v1';

export type MonthlyPerformanceCoverageReason =
  | 'eligible_complete_month'
  | 'coverage_interval_missing'
  | 'coverage_discontinuous'
  | 'product_scope_unknown'
  | 'units_metric_incomplete'
  | 'net_profit_metric_incomplete'
  | 'metric_normalization_mismatch'
  | 'invalid_units'
  | 'missing_net_profit';

export type BaselineConfidence = 'full' | 'moderate' | 'low' | 'none';
export type PerformanceState = 'ranked' | 'no_movement' | 'unclassified';
export type BaselineReasonCode =
  | 'baseline_tier_classified'
  | 'baseline_no_movement'
  | 'baseline_no_eligible_months'
  | 'baseline_invalid_units'
  | 'baseline_missing_profit';

export interface MonthlyPerformanceFactInput {
  date: string;
  units: unknown;
  netProfit: unknown;
}

export interface MonthlyPerformanceMonthInput {
  monthStart: string;
  coverageReason: MonthlyPerformanceCoverageReason;
  facts: MonthlyPerformanceFactInput[];
}

export interface MonthlyPerformanceInput {
  asOfDate: string;
  months: MonthlyPerformanceMonthInput[];
}

export interface MonthlyPerformanceEvidence {
  monthStart: string;
  monthEnd: string;
  eligible: boolean;
  reasonCode: MonthlyPerformanceCoverageReason;
  sourceFactCount: number;
  monthlyUnits: string | null;
  monthlyProfit: string | null;
  monthlyProfitPerUnit: string | null;
  monthlyTierScore: string | null;
}

interface ExactMonthlyPerformance {
  monthStart: string;
  monthlyUnits: string | null;
  monthlyProfit: string | null;
  monthlyProfitPerUnit: string | null;
  monthlyTierScore: string | null;
}

export interface MonthlyPerformanceResult {
  algorithmContractVersion: typeof INDIVIDUAL_MONTHLY_PERFORMANCE_ALGORITHM_VERSION;
  canonicalSerializerVersion: typeof MONTHLY_PERFORMANCE_CANONICAL_SERIALIZER_VERSION;
  evidenceDigestVersion: typeof MONTHLY_PERFORMANCE_EVIDENCE_DIGEST_VERSION;
  asOfDate: string;
  baselineWindowStartDate: string;
  baselineWindowEndDate: string;
  currentMonthStartDate: string;
  currentMonthEndDate: string;
  baselineEligibleMonthCount: number;
  baselineConfidence: BaselineConfidence;
  monthlyPerformanceEvidence: MonthlyPerformanceEvidence[];
  baselineTotalUnits: string | null;
  baselineTotalProfit: string | null;
  baselineWeightedProfitPerUnit: string | null;
  averageMonthlyUnits: string | null;
  averageMonthlyProfit: string | null;
  baselineTierScore: string | null;
  baselineState: PerformanceState;
  baselineReasonCodes: BaselineReasonCode[];
  bestMonthlyUnits: string | null;
  bestUnitsMonth: string | null;
  bestMonthlyProfit: string | null;
  bestProfitMonth: string | null;
  worstMonthlyUnits: string | null;
  worstUnitsMonth: string | null;
  worstMonthlyProfit: string | null;
  worstProfitMonth: string | null;
  lastClosedMonth: string;
  lastClosedEvidenceStatus: 'eligible' | 'unknown';
  lastClosedReasonCode: MonthlyPerformanceCoverageReason;
  lastClosedMonthUnits: string | null;
  lastClosedMonthProfit: string | null;
  lastClosedMonthProfitPerUnit: string | null;
  lastClosedMonthTierScore: string | null;
  exactValues: {
    monthly: ExactMonthlyPerformance[];
    baselineTotalUnits: string | null;
    baselineTotalProfit: string | null;
    baselineWeightedProfitPerUnit: string | null;
    averageMonthlyUnits: string | null;
    averageMonthlyProfit: string | null;
    baselineTierScore: string | null;
  };
  evidenceDigest: string;
}

export class MonthlyPerformanceError extends Error {
  constructor(
    readonly code:
      | 'ECOBASE_MONTHLY_PERFORMANCE_INVALID_DATE'
      | 'ECOBASE_MONTHLY_PERFORMANCE_DUPLICATE_MONTH'
      | 'ECOBASE_MONTHLY_PERFORMANCE_FACT_OUTSIDE_MONTH'
      | 'ECOBASE_MONTHLY_PERFORMANCE_DUPLICATE_FACT_DATE'
      | 'ECOBASE_MONTHLY_PERFORMANCE_REASON_INVALID'
      | 'ECOBASE_MONTHLY_PERFORMANCE_IDENTITY_MISMATCH'
      | 'ECOBASE_MONTHLY_PERFORMANCE_THRESHOLDS_INVALID'
      | 'ECOBASE_MONTHLY_PERFORMANCE_PROJECTION_SETTINGS_INVALID',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MonthlyPerformanceError';
  }
}

type CalculatedMonth = {
  evidence: MonthlyPerformanceEvidence;
  units: Decimal | null;
  profit: Decimal | null;
  profitPerUnit: Decimal | null;
  tierScore: Decimal | null;
};

const COVERAGE_REASONS = new Set<MonthlyPerformanceCoverageReason>([
  'eligible_complete_month',
  'coverage_interval_missing',
  'coverage_discontinuous',
  'product_scope_unknown',
  'units_metric_incomplete',
  'net_profit_metric_incomplete',
  'metric_normalization_mismatch',
  'invalid_units',
  'missing_net_profit',
]);

function utcDateOnly(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_INVALID_DATE',
      `EcoBase monthly performance requires ${field} as a valid UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_INVALID_DATE',
      `EcoBase monthly performance requires ${field} as a valid UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  return date;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthStart(date: Date, offset = 0) {
  return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)));
}

function monthEnd(monthStartValue: string) {
  const start = utcDateOnly(monthStartValue, 'monthStart');
  return isoDate(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)));
}

function decimalValue(value: unknown) {
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string' && !Decimal.isDecimal(value)) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  try {
    const parsed = new PerformanceDecimal(value as Decimal.Value);
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function fixed8(value: Decimal | null) {
  return value === null ? null : value.toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN).toFixed(8);
}

function exact(value: Decimal | null) {
  return value === null ? null : value.toSignificantDigits(40, Decimal.ROUND_HALF_EVEN).toFixed();
}

function confidence(monthsUsed: number): BaselineConfidence {
  if (monthsUsed === 6) return 'full';
  if (monthsUsed >= 3) return 'moderate';
  if (monthsUsed >= 1) return 'low';
  return 'none';
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_IDENTITY_MISMATCH',
      'EcoBase monthly performance canonical evidence contains an unsupported undefined value.',
    );
  }
  return encoded;
}

function calculateMonth(monthStartValue: string, input?: MonthlyPerformanceMonthInput): CalculatedMonth {
  const monthEndValue = monthEnd(monthStartValue);
  const coverageReason = input?.coverageReason ?? 'coverage_interval_missing';
  if (!COVERAGE_REASONS.has(coverageReason)) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_REASON_INVALID',
      `EcoBase monthly performance received unsupported coverage reason "${coverageReason}".`,
      { monthStart: monthStartValue, coverageReason },
    );
  }
  const facts = [...(input?.facts ?? [])].sort((left, right) => left.date.localeCompare(right.date));
  if (coverageReason !== 'eligible_complete_month') {
    return {
      evidence: {
        monthStart: monthStartValue,
        monthEnd: monthEndValue,
        eligible: false,
        reasonCode: coverageReason,
        sourceFactCount: facts.length,
        monthlyUnits: null,
        monthlyProfit: null,
        monthlyProfitPerUnit: null,
        monthlyTierScore: null,
      },
      units: null,
      profit: null,
      profitPerUnit: null,
      tierScore: null,
    };
  }

  const factDates = new Set<string>();
  for (const sourceFact of facts) {
    const date = isoDate(utcDateOnly(sourceFact.date, 'fact.date'));
    if (date < monthStartValue || date > monthEndValue) {
      throw new MonthlyPerformanceError(
        'ECOBASE_MONTHLY_PERFORMANCE_FACT_OUTSIDE_MONTH',
        `EcoBase monthly performance fact date ${date} is outside declared month ${monthStartValue}.`,
        { date, monthStart: monthStartValue },
      );
    }
    if (factDates.has(date)) {
      throw new MonthlyPerformanceError(
        'ECOBASE_MONTHLY_PERFORMANCE_DUPLICATE_FACT_DATE',
        `EcoBase monthly performance received duplicate daily fact date ${date} for month ${monthStartValue}.`,
        { date, monthStart: monthStartValue },
      );
    }
    factDates.add(date);
  }

  const units = facts.map((sourceFact) => decimalValue(sourceFact.units));
  if (units.some((value) => !value || value.isNegative())) {
    return invalidMonth(monthStartValue, monthEndValue, facts.length, 'invalid_units');
  }
  const profits = facts.map((sourceFact) => decimalValue(sourceFact.netProfit));
  if (profits.some((value) => !value)) {
    return invalidMonth(monthStartValue, monthEndValue, facts.length, 'missing_net_profit');
  }
  const monthlyUnits = units.reduce<Decimal>((total, value) => total.plus(value as Decimal), new PerformanceDecimal(0));
  const monthlyProfit = profits.reduce<Decimal>(
    (total, value) => total.plus(value as Decimal),
    new PerformanceDecimal(0),
  );
  const monthlyProfitPerUnit = monthlyUnits.isZero() ? null : monthlyProfit.div(monthlyUnits);
  return {
    evidence: {
      monthStart: monthStartValue,
      monthEnd: monthEndValue,
      eligible: true,
      reasonCode: 'eligible_complete_month',
      sourceFactCount: facts.length,
      monthlyUnits: fixed8(monthlyUnits),
      monthlyProfit: fixed8(monthlyProfit),
      monthlyProfitPerUnit: fixed8(monthlyProfitPerUnit),
      monthlyTierScore: fixed8(monthlyProfit),
    },
    units: monthlyUnits,
    profit: monthlyProfit,
    profitPerUnit: monthlyProfitPerUnit,
    tierScore: monthlyProfit,
  };
}

function invalidMonth(
  monthStartValue: string,
  monthEndValue: string,
  sourceFactCount: number,
  reasonCode: 'invalid_units' | 'missing_net_profit',
): CalculatedMonth {
  return {
    evidence: {
      monthStart: monthStartValue,
      monthEnd: monthEndValue,
      eligible: false,
      reasonCode,
      sourceFactCount,
      monthlyUnits: null,
      monthlyProfit: null,
      monthlyProfitPerUnit: null,
      monthlyTierScore: null,
    },
    units: null,
    profit: null,
    profitPerUnit: null,
    tierScore: null,
  };
}

function extrema(months: CalculatedMonth[], dimension: 'units' | 'profit', direction: 'best' | 'worst') {
  let selected: CalculatedMonth | undefined;
  for (const month of months) {
    const value = month[dimension];
    const selectedValue = selected?.[dimension];
    if (!value || !month.evidence.eligible) continue;
    if (
      !selectedValue ||
      (direction === 'best' ? value.greaterThanOrEqualTo(selectedValue) : value.lessThanOrEqualTo(selectedValue))
    ) {
      selected = month;
    }
  }
  return selected;
}

function baselineReason(params: {
  fatalReasons: Set<MonthlyPerformanceCoverageReason>;
  eligibleMonthCount: number;
  totalUnits: Decimal | null;
}): BaselineReasonCode[] {
  const reasons: BaselineReasonCode[] = [];
  if (params.fatalReasons.has('invalid_units')) reasons.push('baseline_invalid_units');
  if (params.fatalReasons.has('missing_net_profit')) reasons.push('baseline_missing_profit');
  if (reasons.length) return reasons;
  if (params.eligibleMonthCount === 0) return ['baseline_no_eligible_months'];
  if (params.totalUnits?.isZero()) return ['baseline_no_movement'];
  return ['baseline_tier_classified'];
}

export function calculateMonthlyPerformance(input: MonthlyPerformanceInput): MonthlyPerformanceResult {
  const asOf = utcDateOnly(input.asOfDate, 'asOfDate');
  const currentMonthStartDate = monthStart(asOf);
  const baselineMonthStarts = Array.from({ length: 6 }, (_, index) => monthStart(asOf, index - 6));
  const baselineWindowStartDate = baselineMonthStarts[0];
  const baselineWindowEndDate = isoDate(
    new Date(utcDateOnly(currentMonthStartDate, 'currentMonthStartDate').getTime() - 86_400_000),
  );
  const currentMonthEndDate = monthEnd(currentMonthStartDate);
  const inputByMonth = new Map<string, MonthlyPerformanceMonthInput>();
  for (const monthInput of input.months) {
    const start = utcDateOnly(monthInput.monthStart, 'monthStart');
    if (start.getUTCDate() !== 1) {
      throw new MonthlyPerformanceError(
        'ECOBASE_MONTHLY_PERFORMANCE_INVALID_DATE',
        `EcoBase monthly performance monthStart must be the first UTC day of a month; received "${monthInput.monthStart}".`,
        { monthStart: monthInput.monthStart },
      );
    }
    if (inputByMonth.has(monthInput.monthStart)) {
      throw new MonthlyPerformanceError(
        'ECOBASE_MONTHLY_PERFORMANCE_DUPLICATE_MONTH',
        `EcoBase monthly performance received duplicate month ${monthInput.monthStart}.`,
        { monthStart: monthInput.monthStart },
      );
    }
    inputByMonth.set(monthInput.monthStart, monthInput);
  }

  const calculatedMonths = baselineMonthStarts.map((start) => calculateMonth(start, inputByMonth.get(start)));
  const validMonths = calculatedMonths.filter((month) => month.evidence.eligible);
  const fatalReasons = new Set<MonthlyPerformanceCoverageReason>(
    calculatedMonths
      .map((month) => month.evidence.reasonCode)
      .filter((reason) => reason === 'invalid_units' || reason === 'missing_net_profit'),
  );
  const baselineInvalid = fatalReasons.size > 0;
  const baselineEligibleMonthCount = validMonths.length;

  let baselineTotalUnits: Decimal | null = null;
  let baselineTotalProfit: Decimal | null = null;
  let baselineWeightedProfitPerUnit: Decimal | null = null;
  let averageMonthlyUnits: Decimal | null = null;
  let averageMonthlyProfit: Decimal | null = null;
  let baselineTierScore: Decimal | null = null;
  let baselineState: PerformanceState = 'unclassified';
  if (!baselineInvalid && baselineEligibleMonthCount > 0) {
    baselineTotalUnits = validMonths.reduce(
      (total, month) => total.plus(month.units as Decimal),
      new PerformanceDecimal(0),
    );
    baselineTotalProfit = validMonths.reduce(
      (total, month) => total.plus(month.profit as Decimal),
      new PerformanceDecimal(0),
    );
    averageMonthlyUnits = baselineTotalUnits.div(baselineEligibleMonthCount);
    averageMonthlyProfit = baselineTotalProfit.div(baselineEligibleMonthCount);
    baselineTierScore = averageMonthlyProfit;
    if (baselineTotalUnits.isZero()) {
      baselineState = 'no_movement';
    } else {
      baselineWeightedProfitPerUnit = baselineTotalProfit.div(baselineTotalUnits);
      const identity = baselineWeightedProfitPerUnit.mul(averageMonthlyUnits);
      if (identity.minus(baselineTierScore).abs().greaterThan('0.00000001')) {
        throw new MonthlyPerformanceError(
          'ECOBASE_MONTHLY_PERFORMANCE_IDENTITY_MISMATCH',
          'EcoBase monthly performance weighted-profit identity exceeds 0.00000001.',
          { identity: exact(identity), baselineTierScore: exact(baselineTierScore) },
        );
      }
      baselineState = 'ranked';
    }
  }

  const extremaMonths = baselineInvalid ? [] : validMonths;
  const bestUnits = extrema(extremaMonths, 'units', 'best');
  const worstUnits = extrema(extremaMonths, 'units', 'worst');
  const bestProfit = extrema(extremaMonths, 'profit', 'best');
  const worstProfit = extrema(extremaMonths, 'profit', 'worst');
  const lastClosed = calculatedMonths[calculatedMonths.length - 1];
  const lastClosedEligible = lastClosed.evidence.eligible;
  const exactValues = {
    monthly: calculatedMonths.map((month) => ({
      monthStart: month.evidence.monthStart,
      monthlyUnits: exact(month.units),
      monthlyProfit: exact(month.profit),
      monthlyProfitPerUnit: exact(month.profitPerUnit),
      monthlyTierScore: exact(month.tierScore),
    })),
    baselineTotalUnits: exact(baselineTotalUnits),
    baselineTotalProfit: exact(baselineTotalProfit),
    baselineWeightedProfitPerUnit: exact(baselineWeightedProfitPerUnit),
    averageMonthlyUnits: exact(averageMonthlyUnits),
    averageMonthlyProfit: exact(averageMonthlyProfit),
    baselineTierScore: exact(baselineTierScore),
  };
  const canonicalEvidence: Omit<MonthlyPerformanceResult, 'exactValues' | 'evidenceDigest'> = {
    algorithmContractVersion: INDIVIDUAL_MONTHLY_PERFORMANCE_ALGORITHM_VERSION,
    canonicalSerializerVersion: MONTHLY_PERFORMANCE_CANONICAL_SERIALIZER_VERSION,
    evidenceDigestVersion: MONTHLY_PERFORMANCE_EVIDENCE_DIGEST_VERSION,
    asOfDate: input.asOfDate,
    baselineWindowStartDate,
    baselineWindowEndDate,
    currentMonthStartDate,
    currentMonthEndDate,
    baselineEligibleMonthCount,
    baselineConfidence: confidence(baselineEligibleMonthCount),
    monthlyPerformanceEvidence: calculatedMonths.map((month) => month.evidence),
    baselineTotalUnits: fixed8(baselineTotalUnits),
    baselineTotalProfit: fixed8(baselineTotalProfit),
    baselineWeightedProfitPerUnit: fixed8(baselineWeightedProfitPerUnit),
    averageMonthlyUnits: fixed8(averageMonthlyUnits),
    averageMonthlyProfit: fixed8(averageMonthlyProfit),
    baselineTierScore: fixed8(baselineTierScore),
    baselineState,
    baselineReasonCodes: baselineReason({
      fatalReasons,
      eligibleMonthCount: baselineEligibleMonthCount,
      totalUnits: baselineTotalUnits,
    }),
    bestMonthlyUnits: fixed8(bestUnits?.units ?? null),
    bestUnitsMonth: bestUnits?.evidence.monthStart ?? null,
    bestMonthlyProfit: fixed8(bestProfit?.profit ?? null),
    bestProfitMonth: bestProfit?.evidence.monthStart ?? null,
    worstMonthlyUnits: fixed8(worstUnits?.units ?? null),
    worstUnitsMonth: worstUnits?.evidence.monthStart ?? null,
    worstMonthlyProfit: fixed8(worstProfit?.profit ?? null),
    worstProfitMonth: worstProfit?.evidence.monthStart ?? null,
    lastClosedMonth: lastClosed.evidence.monthStart,
    lastClosedEvidenceStatus: lastClosedEligible ? ('eligible' as const) : ('unknown' as const),
    lastClosedReasonCode: lastClosed.evidence.reasonCode,
    lastClosedMonthUnits: lastClosedEligible ? lastClosed.evidence.monthlyUnits : null,
    lastClosedMonthProfit: lastClosedEligible ? lastClosed.evidence.monthlyProfit : null,
    lastClosedMonthProfitPerUnit: lastClosedEligible ? lastClosed.evidence.monthlyProfitPerUnit : null,
    lastClosedMonthTierScore: lastClosedEligible ? lastClosed.evidence.monthlyTierScore : null,
  };
  return {
    ...canonicalEvidence,
    exactValues,
    evidenceDigest: createHash('sha256').update(canonicalJson(canonicalEvidence)).digest('hex'),
  };
}

export type ProfitTier = 'A' | 'B' | 'C' | 'D';
export type TierMovement = 'improved' | 'stable' | 'declined' | 'not_comparable';
export type CurrentProjectionConfidence = 'trusted' | 'early' | 'unavailable';
export type CurrentProjectionGateMode = 'informational' | 'evidence_driven';

export interface MonthlyTierThresholds {
  profitTierAThreshold: unknown;
  profitTierBThreshold: unknown;
  profitTierCThreshold: unknown;
}

export interface CurrentMonthPerformanceInput {
  coverageReason: MonthlyPerformanceCoverageReason;
  coveredThroughDate: string | null;
  facts: MonthlyPerformanceFactInput[];
}

export interface MonthlyTierTrendInput extends MonthlyPerformanceInput {
  currentMonth: CurrentMonthPerformanceInput;
  thresholds: MonthlyTierThresholds;
  minimumProjectionCoveredDays: number;
  currentProjectionGateMode: CurrentProjectionGateMode;
}

export interface MonthlyTierEvidence {
  monthStart: string;
  tier: ProfitTier | null;
  state: PerformanceState;
  tierScore: string | null;
}

export type TrendReasonCode =
  | 'last_closed_tier_classified'
  | 'last_closed_no_movement'
  | 'last_closed_period_unknown'
  | 'current_projection_trusted'
  | 'current_projection_early'
  | 'current_projection_unavailable_coverage'
  | 'current_projection_unavailable_scope'
  | 'current_projection_unavailable_units'
  | 'current_projection_unavailable_profit'
  | 'current_projection_unavailable_normalization'
  | 'current_projection_no_movement'
  | 'closed_tier_improved'
  | 'closed_tier_stable'
  | 'closed_tier_declined'
  | 'closed_tier_not_comparable_unknown'
  | 'closed_tier_not_comparable_no_movement'
  | 'projected_tier_improved'
  | 'projected_tier_stable'
  | 'projected_tier_declined'
  | 'projected_tier_not_comparable_unknown'
  | 'projected_tier_not_comparable_no_movement';

export interface MonthlyTierTrendResult extends MonthlyPerformanceResult {
  monthlyTierEvidence: MonthlyTierEvidence[];
  baselineTier: ProfitTier | null;
  lastClosedMonthTier: ProfitTier | null;
  lastClosedMonthState: PerformanceState;
  closedTierMovement: TierMovement;
  currentCoverageEndDate: string | null;
  currentCoveredDays: number;
  currentMonthUnits: string | null;
  currentMonthProfit: string | null;
  projectedMonthlyUnits: string | null;
  projectedMonthlyProfit: string | null;
  currentProjectedTierScore: string | null;
  currentProjectedTier: ProfitTier | null;
  currentProjectedState: PerformanceState;
  currentProjectionConfidence: CurrentProjectionConfidence;
  currentProjectionGateMode: CurrentProjectionGateMode;
  currentProjectionAffectsEligibility: boolean;
  projectedTierMovement: TierMovement;
  projectedMovementComparisonBasis: 'last_closed' | 'baseline' | 'none';
  trendReasonCodes: TrendReasonCode[];
  exactTierTrendValues: {
    currentMonthUnits: string | null;
    currentMonthProfit: string | null;
    projectedMonthlyUnits: string | null;
    projectedMonthlyProfit: string | null;
    currentProjectedTierScore: string | null;
  };
}

type ValidatedThresholds = { a: Decimal; b: Decimal; c: Decimal };

function validateThresholds(thresholds: MonthlyTierThresholds): ValidatedThresholds {
  const a = decimalValue(thresholds.profitTierAThreshold);
  const b = decimalValue(thresholds.profitTierBThreshold);
  const c = decimalValue(thresholds.profitTierCThreshold);
  if (!a || !b || !c || !a.greaterThan(b) || !b.greaterThan(c)) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_THRESHOLDS_INVALID',
      'EcoBase monthly performance tier thresholds must be finite and satisfy A > B > C.',
      { thresholds },
    );
  }
  return { a, b, c };
}

function tierFor(score: Decimal, thresholds: ValidatedThresholds): ProfitTier {
  if (score.greaterThanOrEqualTo(thresholds.a)) return 'A';
  if (score.greaterThanOrEqualTo(thresholds.b)) return 'B';
  if (score.greaterThan(thresholds.c)) return 'C';
  return 'D';
}

function movement(from: ProfitTier | null, to: ProfitTier | null): TierMovement {
  if (!from || !to) return 'not_comparable';
  const ranks: Record<ProfitTier, number> = { A: 1, B: 2, C: 3, D: 4 };
  if (ranks[to] < ranks[from]) return 'improved';
  if (ranks[to] > ranks[from]) return 'declined';
  return 'stable';
}

function closedReasons(state: PerformanceState, movementValue: TierMovement): TrendReasonCode[] {
  const result: TrendReasonCode[] = [];
  if (state === 'ranked') result.push('last_closed_tier_classified');
  else if (state === 'no_movement') result.push('last_closed_no_movement');
  else result.push('last_closed_period_unknown');
  if (movementValue === 'improved') result.push('closed_tier_improved');
  else if (movementValue === 'stable') result.push('closed_tier_stable');
  else if (movementValue === 'declined') result.push('closed_tier_declined');
  else if (state === 'no_movement') result.push('closed_tier_not_comparable_no_movement');
  else result.push('closed_tier_not_comparable_unknown');
  return result;
}

function unavailableCurrentReason(reason: MonthlyPerformanceCoverageReason): TrendReasonCode {
  if (reason === 'product_scope_unknown') return 'current_projection_unavailable_scope';
  if (reason === 'units_metric_incomplete' || reason === 'invalid_units') {
    return 'current_projection_unavailable_units';
  }
  if (reason === 'net_profit_metric_incomplete' || reason === 'missing_net_profit') {
    return 'current_projection_unavailable_profit';
  }
  if (reason === 'metric_normalization_mismatch') return 'current_projection_unavailable_normalization';
  return 'current_projection_unavailable_coverage';
}

function projectedMovementReason(state: PerformanceState, movementValue: TierMovement): TrendReasonCode {
  if (movementValue === 'improved') return 'projected_tier_improved';
  if (movementValue === 'stable') return 'projected_tier_stable';
  if (movementValue === 'declined') return 'projected_tier_declined';
  return state === 'no_movement'
    ? 'projected_tier_not_comparable_no_movement'
    : 'projected_tier_not_comparable_unknown';
}

export function calculateMonthlyTierTrend(input: MonthlyTierTrendInput): MonthlyTierTrendResult {
  const thresholds = validateThresholds(input.thresholds);
  if (!COVERAGE_REASONS.has(input.currentMonth.coverageReason)) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_REASON_INVALID',
      `EcoBase monthly performance received unsupported current coverage reason "${input.currentMonth.coverageReason}".`,
      { coverageReason: input.currentMonth.coverageReason },
    );
  }
  if (
    !Number.isInteger(input.minimumProjectionCoveredDays) ||
    input.minimumProjectionCoveredDays < 1 ||
    input.minimumProjectionCoveredDays > 31
  ) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_PROJECTION_SETTINGS_INVALID',
      'EcoBase minimumProjectionCoveredDays must be an integer from 1 through 31.',
      { minimumProjectionCoveredDays: input.minimumProjectionCoveredDays },
    );
  }
  if (!['informational', 'evidence_driven'].includes(input.currentProjectionGateMode)) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_PROJECTION_SETTINGS_INVALID',
      `EcoBase currentProjectionGateMode must be informational or evidence_driven; received "${input.currentProjectionGateMode}".`,
    );
  }

  const performance = calculateMonthlyPerformance(input);
  const monthlyTierEvidence = performance.monthlyPerformanceEvidence.map((month, index): MonthlyTierEvidence => {
    const exactMonth = performance.exactValues.monthly[index];
    if (!month.eligible || !exactMonth.monthlyUnits || !exactMonth.monthlyTierScore) {
      return { monthStart: month.monthStart, tier: null, state: 'unclassified', tierScore: null };
    }
    const units = new PerformanceDecimal(exactMonth.monthlyUnits);
    if (units.isZero()) {
      return { monthStart: month.monthStart, tier: null, state: 'no_movement', tierScore: month.monthlyTierScore };
    }
    return {
      monthStart: month.monthStart,
      tier: tierFor(new PerformanceDecimal(exactMonth.monthlyTierScore), thresholds),
      state: 'ranked',
      tierScore: month.monthlyTierScore,
    };
  });
  const baselineTier =
    performance.baselineState === 'ranked' && performance.exactValues.baselineTierScore
      ? tierFor(new PerformanceDecimal(performance.exactValues.baselineTierScore), thresholds)
      : null;
  const lastClosedTierEvidence = monthlyTierEvidence[monthlyTierEvidence.length - 1];
  const lastClosedMonthTier = lastClosedTierEvidence.tier;
  const lastClosedMonthState = lastClosedTierEvidence.state;
  const closedTierMovement = movement(baselineTier, lastClosedMonthTier);

  let currentCoverageReason = input.currentMonth.coverageReason;
  let currentCoverageEndDate: string | null = null;
  let currentCoveredDays = 0;
  let currentMonth: CalculatedMonth | null = null;
  let currentProjectionConfidence: CurrentProjectionConfidence = 'unavailable';
  let currentMonthUnits: Decimal | null = null;
  let currentMonthProfit: Decimal | null = null;
  let projectedMonthlyUnits: Decimal | null = null;
  let projectedMonthlyProfit: Decimal | null = null;
  let currentProjectedState: PerformanceState = 'unclassified';
  let currentProjectedTier: ProfitTier | null = null;

  if (currentCoverageReason === 'eligible_complete_month') {
    const coveredThroughDate = input.currentMonth.coveredThroughDate;
    if (!coveredThroughDate) {
      throw new MonthlyPerformanceError(
        'ECOBASE_MONTHLY_PERFORMANCE_INVALID_DATE',
        'EcoBase eligible current coverage requires coveredThroughDate inside the current month and not later than asOfDate.',
      );
    }
    const coveredThrough = utcDateOnly(coveredThroughDate, 'coveredThroughDate');
    if (
      coveredThroughDate < performance.currentMonthStartDate ||
      coveredThroughDate > performance.currentMonthEndDate ||
      coveredThroughDate > performance.asOfDate
    ) {
      throw new MonthlyPerformanceError(
        'ECOBASE_MONTHLY_PERFORMANCE_INVALID_DATE',
        'EcoBase coveredThroughDate must be inside the current month and not later than asOfDate.',
        { coveredThroughDate, asOfDate: performance.asOfDate },
      );
    }
    for (const sourceFact of input.currentMonth.facts) {
      if (sourceFact.date > coveredThroughDate) {
        throw new MonthlyPerformanceError(
          'ECOBASE_MONTHLY_PERFORMANCE_FACT_OUTSIDE_MONTH',
          `EcoBase current fact date ${sourceFact.date} is later than coveredThroughDate ${coveredThroughDate}.`,
          { date: sourceFact.date, coveredThroughDate },
        );
      }
    }
    currentCoverageEndDate = isoDate(coveredThrough);
    currentCoveredDays = coveredThrough.getUTCDate();
    currentMonth = calculateMonth(performance.currentMonthStartDate, {
      monthStart: performance.currentMonthStartDate,
      coverageReason: 'eligible_complete_month',
      facts: input.currentMonth.facts,
    });
    currentCoverageReason = currentMonth.evidence.reasonCode;
    if (currentMonth.evidence.eligible) {
      currentMonthUnits = currentMonth.units;
      currentMonthProfit = currentMonth.profit;
      const daysInCurrentMonth = utcDateOnly(performance.currentMonthEndDate, 'currentMonthEndDate').getUTCDate();
      projectedMonthlyUnits = currentMonthUnits?.div(currentCoveredDays).mul(daysInCurrentMonth) ?? null;
      projectedMonthlyProfit = currentMonthProfit?.div(currentCoveredDays).mul(daysInCurrentMonth) ?? null;
      currentProjectionConfidence = currentCoveredDays >= input.minimumProjectionCoveredDays ? 'trusted' : 'early';
      if (currentMonthUnits?.isZero()) {
        currentProjectedState = 'no_movement';
      } else if (projectedMonthlyProfit) {
        currentProjectedState = 'ranked';
        currentProjectedTier = tierFor(projectedMonthlyProfit, thresholds);
      }
    }
  }

  const projectedMovementComparisonBasis = lastClosedMonthTier
    ? ('last_closed' as const)
    : baselineTier
      ? ('baseline' as const)
      : ('none' as const);
  const projectedReferenceTier = lastClosedMonthTier ?? baselineTier;
  const projectedTierMovement = movement(projectedReferenceTier, currentProjectedTier);
  const trendReasonCodes: TrendReasonCode[] = [...closedReasons(lastClosedMonthState, closedTierMovement)];
  if (currentProjectionConfidence === 'unavailable') {
    trendReasonCodes.push(unavailableCurrentReason(currentCoverageReason));
  } else {
    trendReasonCodes.push(
      currentProjectionConfidence === 'trusted' ? 'current_projection_trusted' : 'current_projection_early',
    );
    if (currentProjectedState === 'no_movement') trendReasonCodes.push('current_projection_no_movement');
  }
  trendReasonCodes.push(projectedMovementReason(currentProjectedState, projectedTierMovement));

  return {
    ...performance,
    monthlyTierEvidence,
    baselineTier,
    lastClosedMonthTier,
    lastClosedMonthState,
    closedTierMovement,
    currentCoverageEndDate,
    currentCoveredDays,
    currentMonthUnits: fixed8(currentMonthUnits),
    currentMonthProfit: fixed8(currentMonthProfit),
    projectedMonthlyUnits: fixed8(projectedMonthlyUnits),
    projectedMonthlyProfit: fixed8(projectedMonthlyProfit),
    currentProjectedTierScore: fixed8(projectedMonthlyProfit),
    currentProjectedTier,
    currentProjectedState,
    currentProjectionConfidence,
    currentProjectionGateMode: input.currentProjectionGateMode,
    currentProjectionAffectsEligibility:
      input.currentProjectionGateMode === 'evidence_driven' && currentProjectionConfidence === 'trusted',
    projectedTierMovement,
    projectedMovementComparisonBasis,
    trendReasonCodes,
    exactTierTrendValues: {
      currentMonthUnits: exact(currentMonthUnits),
      currentMonthProfit: exact(currentMonthProfit),
      projectedMonthlyUnits: exact(projectedMonthlyUnits),
      projectedMonthlyProfit: exact(projectedMonthlyProfit),
      currentProjectedTierScore: exact(projectedMonthlyProfit),
    },
  };
}

export type PaceStatus =
  | 'insufficient_evidence'
  | 'below_worst'
  | 'below_average'
  | 'on_average'
  | 'on_best'
  | 'above_best';
export type PaceCause = 'quantity' | 'profit' | 'both' | 'none';

export interface MonthlyPaceStatusInput extends MonthlyTierTrendInput {
  paceTolerancePercent: unknown;
}

interface PaceTargetEvidence {
  target: string | null;
  tolerance: string | null;
  lowerBound: string | null;
  upperBound: string | null;
}

interface PaceDimensionEvidence {
  actualMtd: string | null;
  average: PaceTargetEvidence;
  best: PaceTargetEvidence;
  worst: PaceTargetEvidence;
}

export interface MonthlyPaceStatusResult extends MonthlyTierTrendResult {
  paceTolerancePercent: string;
  expectedAverageUnitsMtd: string | null;
  expectedBestUnitsMtd: string | null;
  expectedWorstUnitsMtd: string | null;
  expectedAverageProfitMtd: string | null;
  expectedBestProfitMtd: string | null;
  expectedWorstProfitMtd: string | null;
  quantityPaceStatus: PaceStatus;
  profitPaceStatus: PaceStatus;
  aggregatePaceStatus: PaceStatus;
  paceCause: PaceCause;
  paceEvidence: {
    quantity: PaceDimensionEvidence;
    profit: PaceDimensionEvidence;
  };
}

type PaceTarget = {
  target: Decimal;
  tolerance: Decimal;
  lowerBound: Decimal;
  upperBound: Decimal;
};

type PaceDimension = {
  actual: Decimal | null;
  average: PaceTarget | null;
  best: PaceTarget | null;
  worst: PaceTarget | null;
};

function paceTarget(target: Decimal, tolerancePercent: Decimal): PaceTarget {
  const percentageTolerance = target.abs().mul(tolerancePercent).div(100);
  const minimumTolerance = new PerformanceDecimal('0.00000001');
  const tolerance = percentageTolerance.greaterThan(minimumTolerance) ? percentageTolerance : minimumTolerance;
  return {
    target,
    tolerance,
    lowerBound: target.minus(tolerance),
    upperBound: target.plus(tolerance),
  };
}

function targetEvidence(target: PaceTarget | null): PaceTargetEvidence {
  return {
    target: fixed8(target?.target ?? null),
    tolerance: fixed8(target?.tolerance ?? null),
    lowerBound: fixed8(target?.lowerBound ?? null),
    upperBound: fixed8(target?.upperBound ?? null),
  };
}

function classifyPace(dimension: PaceDimension): PaceStatus {
  const { actual, average, best, worst } = dimension;
  if (!actual || !average || !best || !worst) return 'insufficient_evidence';
  if (actual.lessThan(worst.lowerBound)) return 'below_worst';
  if (actual.lessThan(average.lowerBound)) return 'below_average';
  if (actual.greaterThan(best.upperBound)) return 'above_best';
  if (actual.greaterThanOrEqualTo(best.lowerBound)) return 'on_best';
  return 'on_average';
}

function aggregatePace(quantity: PaceStatus, profit: PaceStatus): { status: PaceStatus; cause: PaceCause } {
  const severity: Record<PaceStatus, number> = {
    insufficient_evidence: 0,
    below_worst: 1,
    below_average: 2,
    on_average: 3,
    on_best: 4,
    above_best: 5,
  };
  if (severity[quantity] === severity[profit]) {
    return {
      status: quantity,
      cause: quantity === 'insufficient_evidence' ? 'none' : 'both',
    };
  }
  return severity[quantity] < severity[profit]
    ? { status: quantity, cause: 'quantity' }
    : { status: profit, cause: 'profit' };
}

function exactMonthValue(
  result: MonthlyTierTrendResult,
  monthStartValue: string | null,
  field: 'monthlyUnits' | 'monthlyProfit',
) {
  const value = result.exactValues.monthly.find((month) => month.monthStart === monthStartValue)?.[field];
  return value ? new PerformanceDecimal(value) : null;
}

export function calculateMonthlyPaceStatus(input: MonthlyPaceStatusInput): MonthlyPaceStatusResult {
  const tolerancePercent = decimalValue(input.paceTolerancePercent);
  if (!tolerancePercent || tolerancePercent.isNegative() || tolerancePercent.greaterThan(100)) {
    throw new MonthlyPerformanceError(
      'ECOBASE_MONTHLY_PERFORMANCE_PROJECTION_SETTINGS_INVALID',
      'EcoBase paceTolerancePercent must be a finite decimal from 0 through 100.',
      { paceTolerancePercent: input.paceTolerancePercent },
    );
  }
  const result = calculateMonthlyTierTrend(input);
  const trusted = result.currentProjectionConfidence === 'trusted';
  const daysInCurrentMonth = utcDateOnly(result.currentMonthEndDate, 'currentMonthEndDate').getUTCDate();
  const factor = trusted ? new PerformanceDecimal(result.currentCoveredDays).div(daysInCurrentMonth) : null;
  const prorate = (value: string | null) =>
    factor && value !== null ? new PerformanceDecimal(value).mul(factor) : null;

  const expectedAverageUnitsMtd = prorate(result.exactValues.averageMonthlyUnits);
  const expectedBestUnitsMtd = prorate(
    exactMonthValue(result, result.bestUnitsMonth, 'monthlyUnits')?.toFixed() ?? null,
  );
  const expectedWorstUnitsMtd = prorate(
    exactMonthValue(result, result.worstUnitsMonth, 'monthlyUnits')?.toFixed() ?? null,
  );
  const expectedAverageProfitMtd = prorate(result.exactValues.averageMonthlyProfit);
  const expectedBestProfitMtd = prorate(
    exactMonthValue(result, result.bestProfitMonth, 'monthlyProfit')?.toFixed() ?? null,
  );
  const expectedWorstProfitMtd = prorate(
    exactMonthValue(result, result.worstProfitMonth, 'monthlyProfit')?.toFixed() ?? null,
  );
  const quantity: PaceDimension = {
    actual:
      trusted && result.exactTierTrendValues.currentMonthUnits
        ? new PerformanceDecimal(result.exactTierTrendValues.currentMonthUnits)
        : null,
    average: expectedAverageUnitsMtd ? paceTarget(expectedAverageUnitsMtd, tolerancePercent) : null,
    best: expectedBestUnitsMtd ? paceTarget(expectedBestUnitsMtd, tolerancePercent) : null,
    worst: expectedWorstUnitsMtd ? paceTarget(expectedWorstUnitsMtd, tolerancePercent) : null,
  };
  const profit: PaceDimension = {
    actual:
      trusted && result.exactTierTrendValues.currentMonthProfit
        ? new PerformanceDecimal(result.exactTierTrendValues.currentMonthProfit)
        : null,
    average: expectedAverageProfitMtd ? paceTarget(expectedAverageProfitMtd, tolerancePercent) : null,
    best: expectedBestProfitMtd ? paceTarget(expectedBestProfitMtd, tolerancePercent) : null,
    worst: expectedWorstProfitMtd ? paceTarget(expectedWorstProfitMtd, tolerancePercent) : null,
  };
  const quantityPaceStatus = classifyPace(quantity);
  const profitPaceStatus = classifyPace(profit);
  const aggregate = aggregatePace(quantityPaceStatus, profitPaceStatus);
  return {
    ...result,
    paceTolerancePercent: fixed8(tolerancePercent) as string,
    expectedAverageUnitsMtd: fixed8(expectedAverageUnitsMtd),
    expectedBestUnitsMtd: fixed8(expectedBestUnitsMtd),
    expectedWorstUnitsMtd: fixed8(expectedWorstUnitsMtd),
    expectedAverageProfitMtd: fixed8(expectedAverageProfitMtd),
    expectedBestProfitMtd: fixed8(expectedBestProfitMtd),
    expectedWorstProfitMtd: fixed8(expectedWorstProfitMtd),
    quantityPaceStatus,
    profitPaceStatus,
    aggregatePaceStatus: aggregate.status,
    paceCause: aggregate.cause,
    paceEvidence: {
      quantity: {
        actualMtd: fixed8(quantity.actual),
        average: targetEvidence(quantity.average),
        best: targetEvidence(quantity.best),
        worst: targetEvidence(quantity.worst),
      },
      profit: {
        actualMtd: fixed8(profit.actual),
        average: targetEvidence(profit.average),
        best: targetEvidence(profit.best),
        worst: targetEvidence(profit.worst),
      },
    },
  };
}
