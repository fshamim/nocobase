/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import {
  calculateInventoryDisposition,
  type PipelineCondition,
  type RollingVelocityConfidence,
} from './inventory-disposition';
import {
  buildCorrectedGoldProjection,
  CORRECTED_ALGORITHM_CONTRACT_VERSION,
  CORRECTED_TIER_RULE_VERSION,
  type CorrectedGoldProjectionResult,
  type CorrectedListingPerformanceInput,
  type FrozenFamilyDecisionInput,
} from './listing-family-projection';
import {
  calculateMonthlyPaceStatus,
  type MonthlyPerformanceCoverageReason,
  type MonthlyPerformanceEvidence,
  type MonthlyPerformanceFactInput,
} from './monthly-performance';
import { decideReplenishment, type ExistingOrderStage } from './replenishment-decision';

const CandidateDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
const DAY_MS = 86_400_000;

export interface CorrectedCandidateSettings {
  readonly profitTierAThreshold: number;
  readonly profitTierBThreshold: number;
  readonly profitTierCThreshold: number;
  readonly minimumProjectionCoveredDays: number;
  readonly paceTolerancePercent: number;
  readonly safetyBufferDays: number;
  readonly reorderCycleDays: number;
  readonly targetCoverDays: number;
  readonly orderSoonWindowDays: number;
  readonly leadTimeFreshnessDays: number;
  readonly purchasedPipelineGraceDays: number;
  readonly defaultSupplierLeadTimeDays: number;
  readonly fbaReceivingBufferDays: number;
}

export interface CorrectedOperationalListingIdentity {
  readonly companyProductId: string;
  readonly companyProductFamilyId: string;
  readonly companyId: string;
  readonly amazonAccountId: string;
  readonly marketplace: string;
  readonly asin: string;
  readonly sku: string;
  readonly company: string;
  readonly title: string | null;
  readonly brand: string | null;
  readonly productStatus: string | null;
}

export interface CorrectedOperationalPlanningSnapshot {
  readonly planningExcluded: boolean;
  readonly safetyBufferDays: number;
  readonly reorderCycleDays: number;
  readonly targetCoverDays: number;
  readonly orderSoonWindowDays: number;
  readonly leadTimeFreshnessDays: number;
  readonly purchasedPipelineGraceDays: number;
  readonly leadTimeDays: number;
}

export interface CorrectedOperationalInventorySnapshot {
  readonly inventoryAsOfDate: string | null;
  /** sellable + reserved + amazon pipeline — the R2 stock total (gold `currentPlanningStock`). */
  readonly currentPlanningStock: number | null;
  readonly onHandSellableStock: number | null;
  readonly amazonPipelineStock: number | null;
  readonly supplierPipelineStock: number | null;
  readonly inventoryPositionStock: number | null;
  readonly futurePositionStock: number | null;
  readonly sellableStock: number | null;
  readonly reservedStock: number | null;
  readonly pipelineStock: number | null;
  readonly inboundStock: number | null;
  readonly orderedStock: number | null;
  readonly prepStock: number | null;
  readonly awdStock: number | null;
}

export interface CorrectedOperationalOrderSnapshot {
  readonly state: string | null;
  readonly stale: boolean;
  readonly workflowStage: string | null;
  readonly operationalStatus: string | null;
  readonly orderId: string | null;
  readonly status: string | null;
  readonly reference: string | null;
  readonly openQty: number | null;
  readonly purchasedOpenQty: number | null;
  readonly placedNotPurchasedOpenQty: number | null;
  readonly pipelineHealthStatus: string | null;
  readonly expectedArrivalDate: string | null;
  readonly expectedArrivalStatus: string | null;
  readonly authorityStatus: string | null;
  readonly authoritySource: string | null;
  readonly authorityTaskRef: string | null;
  readonly authorityAsOf: string | null;
  readonly authorityEvidence: unknown;
  readonly receiptStatus: string | null;
  readonly receiptObservedAt: string | null;
  readonly receiptCompletionReason: string | null;
  readonly receiptEvidence: unknown;
}

export interface CorrectedOperationalSupplierSnapshot {
  readonly supplierId: string | null;
  readonly supplierName: string | null;
  readonly supplierSource: string | null;
  readonly supplierRole: string | null;
  readonly supplierConfidence: string | null;
  readonly unitCost: number | null;
  readonly unitCostSource: string | null;
  readonly supplierAvailability: string | null;
  readonly leadTimeAvailability: string | null;
  readonly unitCostAvailability: string | null;
  readonly leadTimeConfirmedAt: string | null;
  readonly leadTimeFreshness: string | null;
}

export interface CorrectedOperationalListingSnapshot {
  readonly identity: CorrectedOperationalListingIdentity;
  readonly planning: CorrectedOperationalPlanningSnapshot;
  readonly inventory: CorrectedOperationalInventorySnapshot;
  readonly order: CorrectedOperationalOrderSnapshot;
  readonly supplier: CorrectedOperationalSupplierSnapshot;
  readonly sourceEvidence: unknown;
}

export interface CorrectedCandidateFamilySnapshot {
  readonly familyKey: string;
  readonly companyProductFamilyId: string;
  readonly companyId: string;
  readonly amazonAccountId: string;
  readonly marketplace: string;
  readonly canonicalAsin: string;
  readonly targetCompanyProductId: string | null;
  readonly memberCompanyProductIds: readonly string[];
  readonly targetSelectionEvidence: unknown;
}

export interface CorrectedCandidateSourceFact {
  readonly companyProductId: string;
  readonly snapshotDate: string;
  readonly units: unknown;
  readonly netProfit: unknown;
}

export interface CorrectedCandidateCoverageInterval {
  readonly id: string;
  readonly companyId: string;
  readonly amazonAccountId: string;
  readonly marketplace: string;
  readonly metricSet: string;
  readonly coveredStartDate: string;
  readonly coveredEndDate: string;
  readonly continuousCoverage: boolean;
  readonly coverageStatus: string;
  readonly sourceAsOfDate: string;
  readonly sourceVersion: string;
}

export interface CorrectedCandidateCoverageMembership {
  readonly id: string;
  readonly coverageIntervalId: string;
  readonly companyProductId: string;
  readonly monthStart: string;
  readonly membershipStatus: string;
  readonly metricReconciliationStatus: string;
  readonly normalizedFactLinkCount: number;
}

export interface CorrectedCandidateBuilderInput {
  readonly runId: string;
  readonly candidateInputDigest: string;
  readonly calculationDate: string;
  readonly generatedAt: string;
  readonly settings: CorrectedCandidateSettings;
  readonly resolvedPlanningSettingsDigest: string;
  readonly sourceCoverageDigest: string;
  readonly sourceInputDigest: string;
  readonly protectedSilverFingerprint: string;
  readonly listings: readonly CorrectedOperationalListingSnapshot[];
  readonly families: readonly CorrectedCandidateFamilySnapshot[];
  readonly sourceFacts: readonly CorrectedCandidateSourceFact[];
  readonly coverageIntervals: readonly CorrectedCandidateCoverageInterval[];
  readonly coverageMemberships: readonly CorrectedCandidateCoverageMembership[];
}

export type CorrectedCandidateBuilderResult = CorrectedGoldProjectionResult;

export class CorrectedCandidateBuilderError extends Error {
  constructor(
    readonly code:
      | 'ECOBASE_CORRECTED_CANDIDATE_CARDINALITY_MISMATCH'
      | 'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT'
      | 'ECOBASE_CORRECTED_CANDIDATE_INVALID_DATE',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CorrectedCandidateBuilderError';
  }
}

type CoverageEvidence = {
  reasonCode: MonthlyPerformanceCoverageReason;
  intervalIds: string[];
  membershipIds: string[];
  coveredThroughDate: string | null;
};

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function objectEvidence(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : {};
}

function utcDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CorrectedCandidateBuilderError(
      'ECOBASE_CORRECTED_CANDIDATE_INVALID_DATE',
      `EcoBase corrected candidate requires ${field} as a UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new CorrectedCandidateBuilderError(
      'ECOBASE_CORRECTED_CANDIDATE_INVALID_DATE',
      `EcoBase corrected candidate requires ${field} as a valid UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  return date;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  return dateOnly(new Date(utcDate(value, 'date').getTime() + days * DAY_MS));
}

function monthStart(value: string, offset = 0) {
  const date = utcDate(value, 'calculationDate');
  return dateOnly(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)));
}

function monthEnd(value: string) {
  const date = utcDate(value, 'monthStart');
  return dateOnly(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

function closedMonthStarts(calculationDate: string) {
  return [-6, -5, -4, -3, -2, -1].map((offset) => monthStart(calculationDate, offset));
}

function datesBetween(start: string, end: string) {
  const values: string[] = [];
  for (let value = start; value <= end; value = addDays(value, 1)) values.push(value);
  return values;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sourceOrder(interval: CorrectedCandidateCoverageInterval) {
  return `${interval.sourceAsOfDate}\u0000${interval.sourceVersion}\u0000${interval.id}`;
}

function sameScope(interval: CorrectedCandidateCoverageInterval, identity: CorrectedOperationalListingIdentity) {
  return (
    interval.coverageStatus === 'active' &&
    interval.companyId === identity.companyId &&
    interval.amazonAccountId === identity.amazonAccountId &&
    interval.marketplace.toLowerCase() === identity.marketplace.toLowerCase() &&
    interval.metricSet === 'sellerboard_units_net_profit_v1'
  );
}

type CoverageMembershipIndex = ReadonlyMap<string, readonly CorrectedCandidateCoverageMembership[]>;

function coverageMembershipKey(companyProductId: string, membershipMonth: string) {
  return `${companyProductId}\u0000${membershipMonth}`;
}

function coverageForRange(
  listing: CorrectedOperationalListingSnapshot,
  start: string,
  end: string,
  intervals: readonly CorrectedCandidateCoverageInterval[],
  membershipsByListingMonth: CoverageMembershipIndex,
  actualClosedMonthFactCount?: number,
): CoverageEvidence {
  const scoped = intervals.filter((interval) => sameScope(interval, listing.identity));
  if (!scoped.length) {
    return { reasonCode: 'coverage_interval_missing', intervalIds: [], membershipIds: [], coveredThroughDate: null };
  }
  const selectedByMonth = new Map<string, Set<string>>();
  for (const date of datesBetween(start, end)) {
    const owner = scoped
      .filter((interval) => interval.coveredStartDate <= date && interval.coveredEndDate >= date)
      .sort((left, right) => sourceOrder(right).localeCompare(sourceOrder(left)))[0];
    if (!owner || owner.continuousCoverage !== true) {
      return {
        reasonCode: 'coverage_discontinuous',
        intervalIds: [...new Set(scoped.map((interval) => interval.id))].sort(),
        membershipIds: [],
        coveredThroughDate: null,
      };
    }
    const key = monthStart(date);
    selectedByMonth.set(key, new Set([...(selectedByMonth.get(key) ?? []), owner.id]));
  }
  const selectedIntervalIds = [...new Set([...selectedByMonth.values()].flatMap((ids) => [...ids]))].sort();
  const selectedMemberships: CorrectedCandidateCoverageMembership[] = [];
  for (const [membershipMonth, intervalIds] of selectedByMonth) {
    for (const intervalId of intervalIds) {
      const membership = membershipsByListingMonth
        .get(coverageMembershipKey(listing.identity.companyProductId, membershipMonth))
        ?.find((candidate) => candidate.coverageIntervalId === intervalId && candidate.membershipStatus === 'in_scope');
      if (!membership) {
        return {
          reasonCode: 'product_scope_unknown',
          intervalIds: selectedIntervalIds,
          membershipIds: selectedMemberships.map((candidate) => candidate.id).sort(),
          coveredThroughDate: null,
        };
      }
      selectedMemberships.push(membership);
    }
  }
  if (
    selectedMemberships.some(
      (membership) =>
        membership.metricReconciliationStatus !== 'complete' ||
        (actualClosedMonthFactCount !== undefined && membership.normalizedFactLinkCount !== actualClosedMonthFactCount),
    )
  ) {
    return {
      reasonCode: 'metric_normalization_mismatch',
      intervalIds: selectedIntervalIds,
      membershipIds: selectedMemberships.map((membership) => membership.id).sort(),
      coveredThroughDate: null,
    };
  }
  return {
    reasonCode: 'eligible_complete_month',
    intervalIds: selectedIntervalIds,
    membershipIds: selectedMemberships.map((membership) => membership.id).sort(),
    coveredThroughDate: end,
  };
}

function currentCoverage(
  listing: CorrectedOperationalListingSnapshot,
  calculationDate: string,
  intervals: readonly CorrectedCandidateCoverageInterval[],
  membershipsByListingMonth: CoverageMembershipIndex,
) {
  const start = monthStart(calculationDate);
  const coveredThroughDate = intervals
    .filter((interval) => sameScope(interval, listing.identity))
    .map((interval) => interval.coveredEndDate)
    .filter((date) => date >= start && date <= calculationDate)
    .sort()
    .at(-1);
  if (!coveredThroughDate) {
    return {
      reasonCode: 'coverage_interval_missing' as const,
      intervalIds: [],
      membershipIds: [],
      coveredThroughDate: null,
    };
  }
  const coverage = coverageForRange(listing, start, coveredThroughDate, intervals, membershipsByListingMonth);
  // Sparse-tolerant month-to-date: expose the current month's data as-of even when coverage is
  // only partial (coverageForRange leaves it null off the complete path), so a brand-new or
  // gap-covered current month can still project a tier from the facts it does carry.
  return { ...coverage, coveredThroughDate: coverage.coveredThroughDate ?? coveredThroughDate };
}

/**
 * D1 — the latest COVERED sales day for a listing's coverage scope, never past the
 * calculation date. This is the data's real as-of: a normally-lagging sellerboard feed
 * leaves it a couple of days behind `calculationDate`. Returns null when the scope has no
 * active coverage at all (a truly-absent feed, not lag). The rolling velocity window and the
 * inventory freshness reference anchor here so a lagging feed shortens nothing; date math
 * (OOS/order-by projections) keeps using `calculationDate`.
 */
function salesCoverageEndDate(
  listing: CorrectedOperationalListingSnapshot,
  calculationDate: string,
  intervals: readonly CorrectedCandidateCoverageInterval[],
): string | null {
  return (
    intervals
      .filter((interval) => sameScope(interval, listing.identity))
      .map((interval) => interval.coveredEndDate)
      .filter((date) => date <= calculationDate)
      .sort()
      .at(-1) ?? null
  );
}

function factsForRange(facts: readonly CorrectedCandidateSourceFact[], start: string, end: string) {
  return facts
    .filter((fact) => fact.snapshotDate >= start && fact.snapshotDate <= end)
    .sort((left, right) => left.snapshotDate.localeCompare(right.snapshotDate))
    .map(
      (fact): MonthlyPerformanceFactInput => ({
        date: fact.snapshotDate,
        units: fact.units,
        netProfit: fact.netProfit,
      }),
    );
}

function dailyUnits(facts: readonly CorrectedCandidateSourceFact[], start: string, end: string) {
  const byDate = new Map<string, Decimal>();
  for (const fact of facts.filter((candidate) => candidate.snapshotDate >= start && candidate.snapshotDate <= end)) {
    try {
      const units = new CandidateDecimal(String(fact.units));
      if (!units.isFinite()) throw new Error('not finite');
      byDate.set(fact.snapshotDate, (byDate.get(fact.snapshotDate) ?? new CandidateDecimal(0)).plus(units));
    } catch {
      return [{ date: fact.snapshotDate, units: 'invalid' }];
    }
  }
  return [...byDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, units]) => ({ date, units: units.toFixed() }));
}

function pipelineCondition(order: CorrectedOperationalOrderSnapshot): PipelineCondition {
  if (!['placed_not_purchased', 'purchased_pipeline'].includes(order.state ?? '')) return 'none';
  if (order.stale || order.pipelineHealthStatus === 'late') return 'stalled';
  return 'active';
}

function existingOrderStage(order: CorrectedOperationalOrderSnapshot): ExistingOrderStage {
  if (order.state === 'placed_not_purchased') return 'pre_purchase';
  if (order.state !== 'purchased_pipeline') return 'none';
  const stage = `${order.workflowStage ?? ''} ${order.operationalStatus ?? ''}`.toLowerCase().replaceAll('-', '_');
  if (stage.includes('inbound') || stage.includes('shipped')) return 'inbound';
  if (stage.includes('prep') || stage.includes('preparing') || stage.includes('paid')) return 'in_prep';
  return 'pre_purchase';
}

export function independentRecommendedOrderQty(
  listing: CorrectedOperationalListingSnapshot,
  salesVelocity: string | null,
  actionable: boolean,
) {
  const velocity = finite(salesVelocity);
  const futurePosition = listing.inventory.futurePositionStock;
  if (!actionable || velocity === undefined || velocity <= 0 || futurePosition === null) return null;
  // T2: coverage horizon is the per-product operator override when present, else the
  // settings default (45). `listing.planning.targetCoverDays` is resolved upstream as
  // `companyProduct.targetCoverDays ?? settings.targetCoverDays` — never hardcoded here.
  return Math.max(Math.ceil(velocity * listing.planning.targetCoverDays - futurePosition), 0);
}

// ---------------------------------------------------------------------------
// Supply Action derivations (dashboard v2 T1/T3): the effective-velocity ladder
// (F4), stockout dates (F1), the latest safe order-by date (F2, with the V1
// receiving-buffer horizon amendment) and money at risk (F3). All null-safe and
// settings-driven; the run's `calculationDate` (never `new Date()`) is the clock.
// ---------------------------------------------------------------------------

const MONEY_RISK_BASIS = 'uncovered_days_x_velocity_x_profit_per_unit';

// D3 — quiet source-freshness surfacing. The sales feed is month-to-date and may lag a few days
// (D2 decision: alert only when older than 3 days). 'current' ≤ 3 days behind, 'delayed' beyond,
// 'no_coverage' when the current month has no covered sales day yet. Per-company (all of a
// company's rows share one coverage scope, so they carry the same status).
const SOURCE_FRESHNESS_MAX_AGE_DAYS = 3;

function deriveSourceFreshnessStatus(sourceAsOfDate: string | null, calculationDate: string): string {
  if (!sourceAsOfDate) return 'no_coverage';
  const ageDays = Math.round(
    (utcDate(calculationDate, 'calculationDate').getTime() - utcDate(sourceAsOfDate, 'sourceAsOfDate').getTime()) /
      DAY_MS,
  );
  return ageDays <= SOURCE_FRESHNESS_MAX_AGE_DAYS ? 'current' : 'delayed';
}

function roundTo8(value: number) {
  return new CandidateDecimal(value).toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN).toNumber();
}

function roundMoney(value: number) {
  // Nudge off floating-point dust before rounding to cents (mirrors the codebase convention).
  return Math.round((value + Math.sign(value) * 1e-9) * 100) / 100;
}

export type EffectiveVelocityBasis = 'rolling_30' | 'last_closed_month' | 'baseline_average' | 'none';

export interface EffectiveVelocityInput {
  readonly calculationDate: string;
  /** Disposition's rolling velocity (fixed8; non-null ⇔ ≥1 observed day, may be 0). */
  readonly rollingSalesVelocity: string | null;
  readonly rollingVelocityWindowEndDate: string;
  /** Confidence of the rolling velocity, graded by observed days (see inventory-disposition). */
  readonly rollingVelocityConfidence: RollingVelocityConfidence;
  readonly monthlyPerformanceEvidence: readonly MonthlyPerformanceEvidence[];
  readonly averageMonthlyUnits: string | null;
  readonly sourceAsOfDate: string | null;
}

export interface EffectiveVelocity {
  /** Persisted gold `salesVelocity` (fixed8), or null when no rung applies. */
  salesVelocity: string | null;
  salesVelocityBasis: EffectiveVelocityBasis;
  salesVelocityAsOfDate: string | null;
  /**
   * Confidence of the chosen basis: the rolling grade for rolling_30, else a fixed rung grade
   * (last_closed_month → medium, baseline_average → low). Only a high-confidence rolling basis
   * is "trusted"; every other outcome is an estimate.
   */
  salesVelocityConfidence: RollingVelocityConfidence;
  /** Numeric mirror of `salesVelocity` for downstream math. */
  velocity: number | null;
}

/**
 * F4 velocity fallback ladder (V7): trusted rolling window → most recent closed eligible
 * month → baseline average → none. The chosen value is persisted WITH provenance
 * (`salesVelocityBasis` + `salesVelocityAsOfDate`) so estimates never look authoritative.
 * Disposition's own trusted-only outputs (`rollingVelocityEvidenceStatus`, `daysOfCover`,
 * the evidence blob) remain the trusted-path authority and are never rewritten here.
 */
export function resolveEffectiveVelocity(input: EffectiveVelocityInput): EffectiveVelocity {
  // Rung 1 — trusted rolling 30/30 coverage. trusted_zero stays 0: real evidence of no
  // sales must never be replaced by an estimate.
  const trusted = finite(input.rollingSalesVelocity);
  if (trusted !== undefined) {
    return {
      salesVelocity: input.rollingSalesVelocity,
      salesVelocityBasis: 'rolling_30',
      salesVelocityAsOfDate: input.rollingVelocityWindowEndDate,
      salesVelocityConfidence: input.rollingVelocityConfidence,
      velocity: trusted,
    };
  }
  // Rung 2 — most recent closed eligible month: monthlyUnits / real days in that month.
  const month = [...input.monthlyPerformanceEvidence]
    .filter((candidate) => candidate.eligible === true && finite(candidate.monthlyUnits) !== undefined)
    .sort((left, right) => right.monthStart.localeCompare(left.monthStart))[0];
  if (month) {
    const daysInMonth = Number(month.monthEnd.slice(8, 10));
    // Round to the persisted 8dp precision BEFORE mirroring to number so downstream math
    // uses exactly the value the row carries (Number(salesVelocity) === velocity).
    const velocity = new CandidateDecimal(String(month.monthlyUnits))
      .div(daysInMonth)
      .toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN);
    return {
      salesVelocity: velocity.toFixed(8),
      salesVelocityBasis: 'last_closed_month',
      salesVelocityAsOfDate: month.monthEnd,
      salesVelocityConfidence: 'medium',
      velocity: velocity.toNumber(),
    };
  }
  // Rung 3 — baseline average (mean of eligible closed months) over a 30-day month.
  if (finite(input.averageMonthlyUnits) !== undefined) {
    const velocity = new CandidateDecimal(String(input.averageMonthlyUnits))
      .div(30)
      .toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN);
    return {
      salesVelocity: velocity.toFixed(8),
      salesVelocityBasis: 'baseline_average',
      salesVelocityAsOfDate: input.sourceAsOfDate ?? input.calculationDate,
      salesVelocityConfidence: 'low',
      velocity: velocity.toNumber(),
    };
  }
  return {
    salesVelocity: null,
    salesVelocityBasis: 'none',
    salesVelocityAsOfDate: null,
    salesVelocityConfidence: 'none',
    velocity: null,
  };
}

export type ReorderDueKind = 'trusted' | 'estimated';

export interface ReorderTimingInput {
  readonly calculationDate: string;
  /** EFFECTIVE daily sell-through (units/day) from the F4 ladder (may be 0 under trusted_zero). */
  readonly salesVelocity: number | null;
  /** Ladder rung that produced the velocity — only a high-confidence rolling_30 is trusted. */
  readonly salesVelocityBasis: EffectiveVelocityBasis;
  /** Confidence of the effective velocity — a reorder is 'trusted' only at high-confidence rolling_30. */
  readonly salesVelocityConfidence: RollingVelocityConfidence;
  /** Sellable-only cover days (trusted disposition value, or the caller's freshness-gated fallback estimate). */
  readonly daysOfCover: number | null;
  /** sellable + amazon pipeline + supplier pipeline. */
  readonly futurePositionStock: number | null;
  readonly leadTimeDays: number;
  readonly fbaReceivingBufferDays: number;
  readonly safetyBufferDays: number;
}

export interface ReorderTiming {
  estimatedOosDate: string | null;
  positionDaysOfCover: number | null;
  positionEstimatedOosDate: string | null;
  daysUntilOos: number | null;
  latestSafeReorderDate: string | null;
  daysUntilSafeReorder: number | null;
  /**
   * Reorder-due membership kind: 'trusted' (due under the trusted rolling basis),
   * 'estimated' (due under a fallback basis — approved D2 membership, reason code
   * `estimated_velocity_reorder_due`), or null (not due / no usable velocity). Derived
   * from `daysUntilSafeReorder` so kind and scalar can never disagree (parity guarantee).
   */
  reorderDueKind: ReorderDueKind | null;
  /**
   * True ⇔ reorderDueKind === 'trusted'. V1 amendment: the reorder horizon is
   * `leadTimeDays + fbaReceivingBufferDays + safetyBufferDays` (goods must arrive AND be
   * received before stockout). Position-based; never true under an estimated basis.
   */
  trustedReorderDue: boolean;
}

export function deriveReorderTiming(input: ReorderTimingInput): ReorderTiming {
  const velocity = input.salesVelocity;
  const usableVelocity = velocity !== null && Number.isFinite(velocity) && velocity > 0;
  const reorderHorizonDays = input.leadTimeDays + input.fbaReceivingBufferDays + input.safetyBufferDays;

  // F1a sellable runway: calcDate + floor(daysOfCover). The caller supplies either the
  // trusted disposition cover or the fallback estimate; null ⇒ no sellable runway
  // (e.g. zero stock, stale inventory, no usable velocity).
  const estimatedOosDate =
    input.daysOfCover !== null && Number.isFinite(input.daysOfCover)
      ? addDays(input.calculationDate, Math.floor(input.daysOfCover))
      : null;

  // F1b position runway (includes inbound/ordered/supplier pipeline), computed from the
  // EFFECTIVE velocity for trusted and estimated bases alike; deliberately NOT
  // freshness-gated so reorderDueKind and daysUntilSafeReorder never diverge.
  const positionCoverDays =
    usableVelocity && input.futurePositionStock !== null ? input.futurePositionStock / (velocity as number) : null;
  const daysUntilOos = positionCoverDays !== null ? Math.floor(positionCoverDays) : null;
  const positionEstimatedOosDate = daysUntilOos !== null ? addDays(input.calculationDate, daysUntilOos) : null;

  // F2 order-by: positionOOS − horizon. latestSafeReorderDate is the whole-day calendar
  // rendering; daysUntilSafeReorder is the exact fractional runway−horizon (a `double`
  // column) whose sign decides due-ness for BOTH kinds.
  const latestSafeReorderDate =
    daysUntilOos !== null ? addDays(input.calculationDate, daysUntilOos - reorderHorizonDays) : null;
  const daysUntilSafeReorder = positionCoverDays !== null ? roundTo8(positionCoverDays - reorderHorizonDays) : null;
  const due = daysUntilSafeReorder !== null && daysUntilSafeReorder <= 0;
  // Trusted only under a HIGH-confidence rolling window (dense recent coverage). A sparse rolling
  // window, a closed-month fallback, or a baseline average are all estimates — honest provenance.
  const trustedBasis = input.salesVelocityBasis === 'rolling_30' && input.salesVelocityConfidence === 'high';
  const reorderDueKind = due ? (trustedBasis ? 'trusted' : 'estimated') : null;

  return {
    estimatedOosDate,
    positionDaysOfCover: positionCoverDays !== null ? roundTo8(positionCoverDays) : null,
    positionEstimatedOosDate,
    daysUntilOos,
    latestSafeReorderDate,
    daysUntilSafeReorder,
    reorderDueKind,
    trustedReorderDue: reorderDueKind === 'trusted',
  };
}

export interface MoneyRiskInput {
  readonly calculationDate: string;
  /** decision.newReplenishmentActionable — money at risk is only meaningful when reorder-due/overdue. */
  readonly applicable: boolean;
  readonly salesVelocity: number | null;
  /** Ladder provenance of the velocity — persisted in moneyRiskInputs so estimates stay marked. */
  readonly salesVelocityBasis: EffectiveVelocityBasis;
  readonly baselineWeightedProfitPerUnit: number | null;
  /** floor(futurePositionStock / velocity) from {@link deriveReorderTiming}. */
  readonly daysUntilOos: number | null;
  readonly positionEstimatedOosDate: string | null;
  readonly leadTimeDays: number;
  readonly fbaReceivingBufferDays: number;
}

export interface MoneyRisk {
  estimatedProfitRisk: number | null;
  estimatedProfitRiskBasis: string | null;
  moneyRiskStatus: string | null;
  moneyRiskUncoveredDays: number | null;
  moneyRiskInputs: Record<string, unknown> | null;
}

const MONEY_RISK_NOT_APPLICABLE: MoneyRisk = {
  estimatedProfitRisk: null,
  estimatedProfitRiskBasis: null,
  moneyRiskStatus: null,
  moneyRiskUncoveredDays: null,
  moneyRiskInputs: null,
};

export function deriveMoneyRisk(input: MoneyRiskInput): MoneyRisk {
  if (!input.applicable) return { ...MONEY_RISK_NOT_APPLICABLE };

  const velocity = input.salesVelocity;
  const profitPerUnit = input.baselineWeightedProfitPerUnit;
  const arrivalOffsetDays = input.leadTimeDays + input.fbaReceivingBufferDays;
  const inputs: Record<string, unknown> = {
    salesVelocity: velocity,
    salesVelocityBasis: input.salesVelocityBasis,
    baselineWeightedProfitPerUnit: profitPerUnit,
    leadTimeDays: input.leadTimeDays,
    fbaReceivingBufferDays: input.fbaReceivingBufferDays,
    arrivalOffsetDays,
    positionEstimatedOosDate: input.positionEstimatedOosDate,
    daysUntilOos: input.daysUntilOos,
    calculationDate: input.calculationDate,
  };

  const velocityUsable = velocity !== null && Number.isFinite(velocity) && velocity > 0;
  const profitUsable = profitPerUnit !== null && Number.isFinite(profitPerUnit);
  const positionKnown = input.daysUntilOos !== null && input.positionEstimatedOosDate !== null;
  if (!positionKnown || !velocityUsable || !profitUsable) {
    const missingInputs = [
      positionKnown ? undefined : 'position_oos',
      velocityUsable ? undefined : 'sales_velocity',
      profitUsable ? undefined : 'profit_per_unit',
    ].filter((value): value is string => value !== undefined);
    return {
      estimatedProfitRisk: null,
      estimatedProfitRiskBasis: MONEY_RISK_BASIS,
      moneyRiskStatus: 'unknown',
      moneyRiskUncoveredDays: null,
      moneyRiskInputs: { ...inputs, missingInputs },
    };
  }

  // If ordered today, goods arrive after arrivalOffsetDays; the uncovered stockout gap is how
  // many whole days the position OOS precedes that arrival. Equivalent to the plan's
  // max(0, (calcDate + leadTime + fbaBuffer) − positionEstimatedOosDate).
  const uncoveredDays = Math.max(0, arrivalOffsetDays - (input.daysUntilOos as number));
  const estimatedProfitRisk = roundMoney(uncoveredDays * (velocity as number) * (profitPerUnit as number));
  return {
    estimatedProfitRisk,
    estimatedProfitRiskBasis: MONEY_RISK_BASIS,
    moneyRiskStatus: uncoveredDays > 0 ? 'at_risk' : 'covered',
    moneyRiskUncoveredDays: uncoveredDays,
    moneyRiskInputs: { ...inputs, uncoveredDays, missingInputs: [] },
  };
}

function correctedActionStatus(decision: ReturnType<typeof decideReplenishment>) {
  if (decision.replenishmentEligibility === 'excluded') return 'excluded';
  if (decision.existingOrderFollowUp) return 'already_ordered';
  if (decision.primaryActionPane === 'stuckInventory') return 'no_sell_through';
  if (decision.primaryActionPane === 'zeroStock') return 'overdue';
  if (decision.primaryActionPane === 'supplyAction') return 'order_today';
  if (decision.replenishmentEligibility === 'eligible') return 'sufficient_stock';
  return 'watch';
}

function listingInput(
  listing: CorrectedOperationalListingSnapshot,
  family: CorrectedCandidateFamilySnapshot,
  input: CorrectedCandidateBuilderInput,
  facts: readonly CorrectedCandidateSourceFact[],
  membershipsByListingMonth: CoverageMembershipIndex,
): CorrectedListingPerformanceInput {
  const companyProductId = listing.identity.companyProductId;
  const closedMonths = closedMonthStarts(input.calculationDate).map((closedMonth) => {
    const monthFacts = factsForRange(facts, closedMonth, monthEnd(closedMonth));
    const coverage = coverageForRange(
      listing,
      closedMonth,
      monthEnd(closedMonth),
      input.coverageIntervals,
      membershipsByListingMonth,
      monthFacts.length,
    );
    return {
      monthStart: closedMonth,
      coverageReason: coverage.reasonCode,
      facts: monthFacts,
      coverage,
    };
  });
  const current = currentCoverage(listing, input.calculationDate, input.coverageIntervals, membershipsByListingMonth);
  const currentFacts = current.coveredThroughDate
    ? factsForRange(facts, monthStart(input.calculationDate), current.coveredThroughDate)
    : [];
  const performance = calculateMonthlyPaceStatus({
    asOfDate: input.calculationDate,
    months: closedMonths.map(({ monthStart: closedMonth, coverageReason, facts: monthFacts }) => ({
      monthStart: closedMonth,
      coverageReason,
      facts: monthFacts,
    })),
    currentMonth: {
      coverageReason: current.reasonCode,
      coveredThroughDate: current.coveredThroughDate,
      facts: currentFacts,
    },
    thresholds: {
      profitTierAThreshold: input.settings.profitTierAThreshold,
      profitTierBThreshold: input.settings.profitTierBThreshold,
      profitTierCThreshold: input.settings.profitTierCThreshold,
    },
    minimumProjectionCoveredDays: input.settings.minimumProjectionCoveredDays,
    currentProjectionGateMode: 'informational',
    paceTolerancePercent: input.settings.paceTolerancePercent,
  });
  // D1: anchor the trailing 30-day rolling window to the latest covered sales day (data
  // as-of), not calendar today, so a lagging feed keeps a fully-covered window trusted.
  const salesCoverageEnd = salesCoverageEndDate(listing, input.calculationDate, input.coverageIntervals);
  const salesEvidenceAsOf = salesCoverageEnd ?? input.calculationDate;
  const rollingStart = addDays(salesEvidenceAsOf, -29);
  const rollingCoverage = coverageForRange(
    listing,
    rollingStart,
    salesEvidenceAsOf,
    input.coverageIntervals,
    membershipsByListingMonth,
  );
  // Freshness reference: the freshest data day we hold. A snapshot at (or, when the inventory
  // feed leads sales, after) the sales as-of stays fresh; a snapshot that genuinely trails the
  // sales feed still ages, and a snapshot dated beyond today still reads invalid_future.
  const inventorySnapshotDate = listing.inventory.inventoryAsOfDate;
  const freshnessAsOf =
    inventorySnapshotDate && inventorySnapshotDate > salesEvidenceAsOf && inventorySnapshotDate <= input.calculationDate
      ? inventorySnapshotDate
      : salesEvidenceAsOf;
  const disposition = calculateInventoryDisposition({
    asOfDate: freshnessAsOf,
    salesEvidenceAsOfDate: salesEvidenceAsOf,
    coverageReason: rollingCoverage.reasonCode,
    dailyUnits: dailyUnits(facts, rollingStart, salesEvidenceAsOf),
    sellableOnHandStock: listing.inventory.onHandSellableStock,
    inventorySnapshotDate,
    reservedStock: listing.inventory.reservedStock,
    pipelineStock: listing.inventory.pipelineStock,
    orderPipelineStatus: pipelineCondition(listing.order),
  });
  const isFrozenTarget = family.targetCompanyProductId === companyProductId;
  // T3 (F4): effective-velocity ladder with persisted provenance. Disposition's trusted-only
  // outputs stay authoritative and untouched; the ladder only fills the gap they leave.
  const effectiveVelocity = resolveEffectiveVelocity({
    calculationDate: input.calculationDate,
    rollingSalesVelocity: disposition.salesVelocity,
    rollingVelocityWindowEndDate: disposition.rollingVelocityWindowEndDate,
    rollingVelocityConfidence: disposition.rollingVelocityConfidence,
    monthlyPerformanceEvidence: performance.monthlyPerformanceEvidence,
    averageMonthlyUnits: performance.averageMonthlyUnits,
    sourceAsOfDate: current.coveredThroughDate,
  });
  // Sellable cover for the F1a date: disposition's trusted value, else the same
  // sellable/velocity formula under the fallback basis — still gated on fresh inventory
  // and positive sellable stock so stale/zero rows keep a null sellable runway.
  const sellableStock = finite(disposition.sellableOnHandStock);
  const effectiveDaysOfCover =
    finite(disposition.daysOfCover) ??
    (effectiveVelocity.velocity !== null &&
    effectiveVelocity.velocity > 0 &&
    disposition.inventoryFreshnessStatus === 'fresh' &&
    sellableStock !== undefined &&
    sellableStock > 0
      ? sellableStock / effectiveVelocity.velocity
      : null);
  // T1 (F1/F2 + V1 horizon): stockout dates, the order-by date and the reorder-due membership
  // kind all share one reorder horizon so the kind and daysUntilSafeReorder cannot disagree.
  const reorderTiming = deriveReorderTiming({
    calculationDate: input.calculationDate,
    salesVelocity: effectiveVelocity.velocity,
    salesVelocityBasis: effectiveVelocity.salesVelocityBasis,
    salesVelocityConfidence: effectiveVelocity.salesVelocityConfidence,
    daysOfCover: effectiveDaysOfCover,
    futurePositionStock: listing.inventory.futurePositionStock,
    leadTimeDays: listing.planning.leadTimeDays,
    fbaReceivingBufferDays: input.settings.fbaReceivingBufferDays,
    safetyBufferDays: listing.planning.safetyBufferDays,
  });
  // Task 002 plumbing: lifecycle comes from identity.productStatus (companyProduct
  // lifecycleStatus); discontinued/paused must NOT be swallowed by the legacy
  // planning-excluded mapping so the visible pane branch can fire.
  const lifecycleStatus = (listing.identity.productStatus ?? '').trim().toLowerCase();
  const lifecycleDiscontinuedOrPaused = lifecycleStatus === 'discontinued' || lifecycleStatus === 'paused';
  const decision = decideReplenishment({
    administrativelyExcluded: listing.planning.planningExcluded && !lifecycleDiscontinuedOrPaused,
    lifecycleDiscontinuedOrPaused,
    hasFrozenTarget: isFrozenTarget,
    targetSelectionState: isFrozenTarget ? 'automatic' : 'review',
    identityEvidenceValid: true,
    // Reversed philosophy: a current-month projection is real trailing-30 evidence. A brand-new
    // product with only month-to-date data (no closed baseline) is NOT "missing baseline" — it has
    // a projected tier, so it must never be dumped into Data Readiness for lacking closed history.
    baselineEvidenceValid:
      performance.baselineState !== 'unclassified' || performance.currentProjectedState === 'ranked',
    inventoryDisposition: disposition.inventoryDisposition,
    baselineState: performance.baselineState,
    baselineTier: performance.baselineTier,
    baselineConfidence: performance.baselineConfidence,
    lastClosedMonthState: performance.lastClosedMonthState,
    lastClosedMonthTier: performance.lastClosedMonthTier,
    closedTierMovement: performance.closedTierMovement,
    currentProjectionGateMode: 'informational',
    currentProjectionConfidence: performance.currentProjectionConfidence,
    currentProjectedState: performance.currentProjectedState,
    currentProjectedTier: performance.currentProjectedTier,
    projectedTierMovement: performance.projectedTierMovement,
    existingOrderStage: existingOrderStage(listing.order),
    trustedZeroStock:
      disposition.inventoryFreshnessStatus === 'fresh' && Number(disposition.sellableOnHandStock ?? 'NaN') === 0,
    reorderDueKind: reorderTiming.reorderDueKind ?? 'none',
  });
  const productCoverageDigest = digest({
    companyProductId,
    closedMonths: closedMonths.map(({ monthStart: closedMonth, coverage }) => ({
      monthStart: closedMonth,
      ...coverage,
    })),
    current,
    rolling: { start: rollingStart, end: salesEvidenceAsOf, ...rollingCoverage },
  });
  const monthlyPerformanceEvidence = performance.monthlyPerformanceEvidence.map((month, index) => ({
    ...month,
    coverageIntervalIds: closedMonths[index].coverage.intervalIds,
    coverageMembershipIds: closedMonths[index].coverage.membershipIds,
  }));
  const recommendedOrderQty = independentRecommendedOrderQty(
    listing,
    effectiveVelocity.salesVelocity,
    decision.newReplenishmentActionable,
  );
  const estimatedOrderCost =
    recommendedOrderQty !== null && listing.supplier.unitCost !== null
      ? recommendedOrderQty * listing.supplier.unitCost
      : null;
  // F3: money at risk — only when the family needs a new order (reorder-due Supply Action or
  // overdue Zero Stock); null-safe on velocity + per-unit profit + a known position OOS.
  const moneyRisk = deriveMoneyRisk({
    calculationDate: input.calculationDate,
    applicable: decision.newReplenishmentActionable,
    salesVelocity: effectiveVelocity.velocity,
    salesVelocityBasis: effectiveVelocity.salesVelocityBasis,
    baselineWeightedProfitPerUnit: finite(performance.baselineWeightedProfitPerUnit) ?? null,
    daysUntilOos: reorderTiming.daysUntilOos,
    positionEstimatedOosDate: reorderTiming.positionEstimatedOosDate,
    leadTimeDays: listing.planning.leadTimeDays,
    fbaReceivingBufferDays: input.settings.fbaReceivingBufferDays,
  });
  return {
    ...listing.identity,
    ...listing.planning,
    ...listing.inventory,
    ...performance,
    ...disposition,
    salesVelocity: effectiveVelocity.salesVelocity,
    salesVelocityBasis: effectiveVelocity.salesVelocityBasis,
    salesVelocityAsOfDate: effectiveVelocity.salesVelocityAsOfDate,
    estimatedOosDate: reorderTiming.estimatedOosDate,
    positionDaysOfCover: reorderTiming.positionDaysOfCover,
    positionEstimatedOosDate: reorderTiming.positionEstimatedOosDate,
    daysUntilOos: reorderTiming.daysUntilOos,
    latestSafeReorderDate: reorderTiming.latestSafeReorderDate,
    daysUntilSafeReorder: reorderTiming.daysUntilSafeReorder,
    ...moneyRisk,
    monthlyPerformanceEvidence,
    sourceAsOfDate: current.coveredThroughDate,
    sourceFreshnessStatus: deriveSourceFreshnessStatus(current.coveredThroughDate, input.calculationDate),
    productCoverageDigest,
    isFrozenFamilyTarget: isFrozenTarget,
    familyTargetCompanyProductId: family.targetCompanyProductId,
    recommendedOrderQty,
    estimatedOrderCost,
    actionStatus: correctedActionStatus(decision),
    supplierOrderState: listing.order.state,
    supplierOrderStale: listing.order.stale,
    supplierOrderWorkflowStage: listing.order.workflowStage,
    supplierOrderOperationalStatus: listing.order.operationalStatus,
    supplierOrderId: listing.order.orderId,
    supplierOrderStatus: listing.order.status,
    supplierOrderRef: listing.order.reference,
    supplierOrderOpenQty: listing.order.openQty,
    supplierOrderPurchasedOpenQty: listing.order.purchasedOpenQty,
    supplierOrderPlacedNotPurchasedOpenQty: listing.order.placedNotPurchasedOpenQty,
    pipelineHealthStatus: listing.order.pipelineHealthStatus,
    expectedArrivalDate: listing.order.expectedArrivalDate,
    expectedArrivalStatus: listing.order.expectedArrivalStatus,
    supplierOrderAuthorityStatus: listing.order.authorityStatus,
    supplierOrderAuthoritySource: listing.order.authoritySource,
    supplierOrderAuthorityTaskRef: listing.order.authorityTaskRef,
    supplierOrderAuthorityAsOf: listing.order.authorityAsOf,
    supplierOrderAuthorityEvidence: structuredClone(listing.order.authorityEvidence),
    amazonReceiptStatus: listing.order.receiptStatus,
    amazonReceiptObservedAt: listing.order.receiptObservedAt,
    amazonReceiptCompletionReason: listing.order.receiptCompletionReason,
    amazonReceiptEvidenceJson: structuredClone(listing.order.receiptEvidence),
    ...listing.supplier,
    calculationEvidence: {
      sourceEvidence: structuredClone(listing.sourceEvidence),
      coverage: {
        closedMonths: closedMonths.map(({ monthStart: closedMonth, coverage }) => ({
          monthStart: closedMonth,
          ...coverage,
        })),
        current,
        rolling: { start: rollingStart, end: salesEvidenceAsOf, ...rollingCoverage },
      },
      pace: performance.paceEvidence,
      disposition,
    },
    replenishmentDecision: decision,
  };
}

function validateCatalog(input: CorrectedCandidateBuilderInput) {
  const listingsById = new Map(input.listings.map((listing) => [listing.identity.companyProductId, listing]));
  if (listingsById.size !== input.listings.length) {
    throw new CorrectedCandidateBuilderError(
      'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
      'EcoBase corrected candidate catalog contains duplicate company-product listings.',
    );
  }
  const assigned = new Set<string>();
  for (const family of input.families) {
    if (!family.memberCompanyProductIds.length) {
      throw new CorrectedCandidateBuilderError(
        'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
        `EcoBase corrected candidate family "${family.familyKey}" has no catalog members.`,
      );
    }
    for (const memberId of family.memberCompanyProductIds) {
      const listing = listingsById.get(memberId);
      if (
        !listing ||
        listing.identity.companyProductFamilyId !== family.companyProductFamilyId ||
        assigned.has(memberId)
      ) {
        throw new CorrectedCandidateBuilderError(
          'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
          `EcoBase corrected candidate family membership drifted for "${memberId}".`,
          { familyKey: family.familyKey, memberId },
        );
      }
      assigned.add(memberId);
    }
    if (family.targetCompanyProductId && !family.memberCompanyProductIds.includes(family.targetCompanyProductId)) {
      throw new CorrectedCandidateBuilderError(
        'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
        `EcoBase corrected candidate family "${family.familyKey}" target is not a catalog member.`,
      );
    }
  }
  if (assigned.size !== input.listings.length) {
    throw new CorrectedCandidateBuilderError(
      'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
      `EcoBase corrected candidate catalog left ${input.listings.length - assigned.size} listings without one family.`,
    );
  }
  return listingsById;
}

export function buildCorrectedInventoryPlanningCandidate(
  input: CorrectedCandidateBuilderInput,
): CorrectedCandidateBuilderResult {
  utcDate(input.calculationDate, 'calculationDate');
  const listingsById = validateCatalog(input);
  const familyInputs: FrozenFamilyDecisionInput[] = input.families.map((family) => ({
    familyKey: family.familyKey,
    companyProductFamilyId: family.companyProductFamilyId,
    companyId: family.companyId,
    amazonAccountId: family.amazonAccountId,
    marketplace: family.marketplace,
    canonicalAsin: family.canonicalAsin,
    targetSelectionState: family.targetCompanyProductId ? 'automatic' : 'review',
    targetCompanyProductId: family.targetCompanyProductId,
    memberCompanyProductIds: [...family.memberCompanyProductIds],
    targetSelectionEvidence: objectEvidence(family.targetSelectionEvidence),
  }));
  const factsByListing = new Map<string, CorrectedCandidateSourceFact[]>();
  for (const fact of input.sourceFacts) {
    factsByListing.set(fact.companyProductId, [...(factsByListing.get(fact.companyProductId) ?? []), fact]);
  }
  const membershipsByListingMonth = new Map<string, CorrectedCandidateCoverageMembership[]>();
  for (const membership of input.coverageMemberships) {
    const key = coverageMembershipKey(membership.companyProductId, membership.monthStart);
    membershipsByListingMonth.set(key, [...(membershipsByListingMonth.get(key) ?? []), membership]);
  }
  const listingInputs = input.families.flatMap((family) =>
    family.memberCompanyProductIds.map((memberId) =>
      listingInput(
        listingsById.get(memberId) as CorrectedOperationalListingSnapshot,
        family,
        input,
        factsByListing.get(memberId) ?? [],
        membershipsByListingMonth,
      ),
    ),
  );
  return buildCorrectedGoldProjection({
    runId: input.runId,
    calculationDate: input.calculationDate,
    ruleVersion: CORRECTED_TIER_RULE_VERSION,
    algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
    currentProjectionGateMode: 'informational',
    resolvedPlanningSettingsDigest: input.resolvedPlanningSettingsDigest,
    sourceCoverageDigest: input.sourceCoverageDigest,
    sourceInputDigest: input.sourceInputDigest,
    protectedSilverFingerprint: input.protectedSilverFingerprint,
    candidateInputDigest: input.candidateInputDigest,
    generatedAt: input.generatedAt,
    listings: listingInputs,
    families: familyInputs,
    expectedListingCount: input.listings.length,
    expectedFamilyActionCount: input.families.length,
  });
}
