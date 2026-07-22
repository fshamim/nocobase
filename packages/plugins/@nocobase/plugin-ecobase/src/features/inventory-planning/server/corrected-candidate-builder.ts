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
import { calculateInventoryDisposition, type PipelineCondition } from './inventory-disposition';
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
  return coverageForRange(listing, start, coveredThroughDate, intervals, membershipsByListingMonth);
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

function independentRecommendedOrderQty(
  listing: CorrectedOperationalListingSnapshot,
  salesVelocity: string | null,
  actionable: boolean,
) {
  const velocity = finite(salesVelocity);
  const futurePosition = listing.inventory.futurePositionStock;
  if (!actionable || velocity === undefined || velocity <= 0 || futurePosition === null) return null;
  return Math.max(Math.ceil(velocity * listing.planning.targetCoverDays - futurePosition), 0);
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
  const rollingStart = addDays(input.calculationDate, -29);
  const rollingCoverage = coverageForRange(
    listing,
    rollingStart,
    input.calculationDate,
    input.coverageIntervals,
    membershipsByListingMonth,
  );
  const disposition = calculateInventoryDisposition({
    asOfDate: input.calculationDate,
    coverageReason: rollingCoverage.reasonCode,
    dailyUnits: dailyUnits(facts, rollingStart, input.calculationDate),
    sellableOnHandStock: listing.inventory.onHandSellableStock,
    inventorySnapshotDate: listing.inventory.inventoryAsOfDate,
    reservedStock: listing.inventory.reservedStock,
    pipelineStock: listing.inventory.pipelineStock,
    orderPipelineStatus: pipelineCondition(listing.order),
  });
  const isFrozenTarget = family.targetCompanyProductId === companyProductId;
  const velocity = finite(disposition.salesVelocity);
  const futurePosition = listing.inventory.futurePositionStock;
  const trustedReorderDue =
    disposition.rollingVelocityEvidenceStatus === 'trusted_positive' &&
    velocity !== undefined &&
    velocity > 0 &&
    futurePosition !== null &&
    futurePosition / velocity <= listing.planning.leadTimeDays + listing.planning.safetyBufferDays;
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
    baselineEvidenceValid: performance.baselineState !== 'unclassified',
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
    trustedReorderDue,
  });
  const productCoverageDigest = digest({
    companyProductId,
    closedMonths: closedMonths.map(({ monthStart: closedMonth, coverage }) => ({
      monthStart: closedMonth,
      ...coverage,
    })),
    current,
    rolling: { start: rollingStart, end: input.calculationDate, ...rollingCoverage },
  });
  const monthlyPerformanceEvidence = performance.monthlyPerformanceEvidence.map((month, index) => ({
    ...month,
    coverageIntervalIds: closedMonths[index].coverage.intervalIds,
    coverageMembershipIds: closedMonths[index].coverage.membershipIds,
  }));
  const recommendedOrderQty = independentRecommendedOrderQty(
    listing,
    disposition.salesVelocity,
    decision.newReplenishmentActionable,
  );
  const estimatedOrderCost =
    recommendedOrderQty !== null && listing.supplier.unitCost !== null
      ? recommendedOrderQty * listing.supplier.unitCost
      : null;
  return {
    ...listing.identity,
    ...listing.planning,
    ...listing.inventory,
    ...performance,
    ...disposition,
    monthlyPerformanceEvidence,
    sourceAsOfDate: current.coveredThroughDate,
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
        rolling: { start: rollingStart, end: input.calculationDate, ...rollingCoverage },
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
