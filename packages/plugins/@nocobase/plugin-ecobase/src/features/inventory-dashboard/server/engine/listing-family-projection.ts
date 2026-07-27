/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import {
  CORRECTED_INVENTORY_PLANNING_ROW_FIELDS,
  correctedInventoryPlanningDigestProjection,
  normalizeCorrectedInventoryPlanningDigestValue,
  omitObsoleteInventoryPlanningRowFields,
} from './gold-schema-contract';
import type { CurrentProjectionGateMode } from './monthly-performance';
import type { ReplenishmentDecisionResult } from './replenishment-decision';

// v2 (Batch D, 2026-07): sparse-tolerant evidence model — partial months rank at month-rate,
// data-as-of anchored rolling windows with graded confidence, observed-day divisors, reversed
// velocity-gap routing, confidence-gated blocking dispositions. Bumped so run identity
// (candidateInputDigest → derived idempotency key) can never reuse a v1 run for identical
// silver inputs after the behavior change.
// v3 (065: eligibility ladder adopts recentTier (two-month window), 2026-07) — membership is now
// decided by `currentProjectedTier ?? lastClosedMonthTier` instead of the baseline: a new
// recent-movement gate exiles rows unranked in both recent months, the baseline no-movement and
// baseline-tier-D gates are gone, and a trusted current rank waives the baseline-confidence
// review. Same silver inputs now yield different panes/eligibility, so the version moves for the
// same reason as the v2 bump — run identity must never reuse a v2 run for a v3 formula.
// v4 (068-2: trusted current rank bypasses first-closed-month review gates, 2026-07) — the
// last-closed no-movement (10) and unknown-period (12) review gates now carry the same
// trusted-current-rank bypass gate 13 has, so a brand-new seller with a trusted rank reaches the
// operational panes instead of waiting for its first month to close. Same silver inputs, different
// panes/eligibility ⇒ the version moves again.
export const CORRECTED_TIER_RULE_VERSION = 'individual_dynamic_6m_profit_trend_v4';
export const CORRECTED_ALGORITHM_CONTRACT_VERSION = 'individual_monthly_profit_performance_v2';
export const CORRECTED_CANONICAL_SERIALIZER_VERSION = 'canonical_json_schema_normalized_bytewise_v2';
export const CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION = 'candidate_input_digest_v1';
export const CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION = 'source_coverage_digest_v1';
export const CORRECTED_LISTING_ROW_DIGEST_VERSION = 'listing_performance_digest_v2';
export const CORRECTED_FAMILY_ACTION_DIGEST_VERSION = 'family_action_digest_v2';

export type ListingReviewCategory =
  | 'tier_d'
  | 'no_movement'
  | 'closed_decline'
  | 'projected_decline'
  | 'stuck'
  | 'excess'
  | 'data_readiness';

const LISTING_REVIEW_CATEGORIES = new Set<ListingReviewCategory>([
  'tier_d',
  'no_movement',
  'closed_decline',
  'projected_decline',
  'stuck',
  'excess',
  'data_readiness',
]);

interface CorrectedListingPerformanceFields {
  companyProductId: string;
  companyProductFamilyId: string;
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  asin: string;
  sku: string;
  baselineTier: string | null;
  baselineTierScore: string | null;
  baselineState: string;
  baselineConfidence: string;
  inventoryDisposition: string;
  productCoverageDigest: string;
}

export interface CorrectedListingPerformanceInput extends CorrectedListingPerformanceFields, Record<string, unknown> {
  replenishmentDecision: ReplenishmentDecisionResult;
}

export interface FrozenFamilyDecisionInput {
  familyKey: string;
  companyProductFamilyId: string;
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  canonicalAsin: string;
  targetSelectionState: 'automatic' | 'review';
  targetCompanyProductId: string | null;
  memberCompanyProductIds: string[];
  targetSelectionEvidence: Record<string, unknown>;
}

export type CorrectedListingPerformanceRow = CorrectedListingPerformanceFields &
  Record<string, unknown> &
  ReplenishmentDecisionResult & {
    naturalKey: string;
    refreshRunId: string;
    calculationDate: string;
    ruleVersion: typeof CORRECTED_TIER_RULE_VERSION;
    algorithmContractVersion: typeof CORRECTED_ALGORITHM_CONTRACT_VERSION;
    currentProjectionGateMode: CurrentProjectionGateMode;
    resolvedPlanningSettingsDigest: string;
    sourceCoverageDigest: string;
    sourceInputDigest: string;
    protectedSilverFingerprint: string;
    candidateInputDigest: string;
    listingReviewCategories: ListingReviewCategory[];
  };

export interface CorrectedFamilyActionProjection extends Record<string, unknown> {
  runId: string;
  generatedAt: string;
  naturalKey: string;
  familyKey: string;
  companyProductFamilyId: string;
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  canonicalAsin: string;
  targetSelectionState: 'frozen_target' | 'review_required';
  targetCompanyProductId: string | null;
  representativeCompanyProductId: string;
  actionSourceCompanyProductId: string | null;
  memberCount: number;
  primaryActionPane: string;
  primaryActionReasonCode: string;
  replenishmentEligibility: string;
  replenishmentBlockReasonCode: string;
  existingOrderFollowUp: boolean;
  existingOrderFollowUpAction: string;
  newReplenishmentActionable: boolean;
  oosAlertActionable: boolean;
  supplyActionable: boolean;
  recommendedOrderQty: unknown;
  alternateRecommendationCompanyProductIds: string[];
  targetSelectionEvidence: Record<string, unknown>;
  listing: Record<string, unknown> | null;
  linkedMemberEvidence: Array<{
    companyProductId: string;
    listingReviewCategories: ListingReviewCategory[];
  }>;
}

interface CorrectedFamilyActionSnapshot {
  familyKey: string;
  companyProductFamilyId: string;
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  canonicalAsin: string;
  targetSelectionState: 'automatic' | 'review';
  targetCompanyProductId: string | null;
  targetSelectionEvidence: Record<string, unknown>;
}

export interface CorrectedGoldProjectionInput {
  runId: string;
  calculationDate: string;
  ruleVersion: typeof CORRECTED_TIER_RULE_VERSION;
  algorithmContractVersion: typeof CORRECTED_ALGORITHM_CONTRACT_VERSION;
  currentProjectionGateMode: CurrentProjectionGateMode;
  resolvedPlanningSettingsDigest: string;
  sourceCoverageDigest: string;
  sourceInputDigest: string;
  protectedSilverFingerprint: string;
  candidateInputDigest: string;
  generatedAt: string;
  listings: CorrectedListingPerformanceInput[];
  families: FrozenFamilyDecisionInput[];
  expectedListingCount: number;
  expectedFamilyActionCount: number;
}

export interface CorrectedGoldProjectionResult {
  listingRows: CorrectedListingPerformanceRow[];
  familyActions: CorrectedFamilyActionProjection[];
  runMetadata: {
    ruleVersion: typeof CORRECTED_TIER_RULE_VERSION;
    algorithmContractVersion: typeof CORRECTED_ALGORITHM_CONTRACT_VERSION;
    currentProjectionGateMode: CurrentProjectionGateMode;
    resolvedPlanningSettingsDigest: string;
    sourceCoverageDigest: string;
    sourceInputDigest: string;
    protectedSilverFingerprint: string;
    candidateInputDigest: string;
    canonicalSerializerVersion: typeof CORRECTED_CANONICAL_SERIALIZER_VERSION;
    candidateInputDigestVersion: typeof CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION;
    sourceCoverageDigestVersion: typeof CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION;
    listingRowDigestVersion: typeof CORRECTED_LISTING_ROW_DIGEST_VERSION;
    familyActionProjectionDigestVersion: typeof CORRECTED_FAMILY_ACTION_DIGEST_VERSION;
    listingRowCount: number;
    listingRowDigest: string;
    familyActionProjectionCount: number;
    familyActionProjectionDigest: string;
    protectedDomainMutationCount: 0;
  };
}

export class CorrectedGoldProjectionError extends Error {
  readonly code = 'ECOBASE_GOLD_PROJECTION_CONTRACT_VIOLATION';

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CorrectedGoldProjectionError';
  }
}

function required(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CorrectedGoldProjectionError(`EcoBase corrected Gold projection requires ${field}.`, { field });
  }
  return value.trim();
}

function sha256Digest(value: unknown, field: string) {
  const normalized = required(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new CorrectedGoldProjectionError(`EcoBase corrected Gold projection requires ${field} as SHA-256.`, {
      field,
    });
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

type ListingIdentity = Pick<
  CorrectedListingPerformanceInput,
  'companyProductId' | 'companyId' | 'amazonAccountId' | 'marketplace' | 'asin' | 'sku'
>;

function normalizedIdentity(row: ListingIdentity) {
  return [
    required(row.companyId, 'listing.companyId'),
    required(row.amazonAccountId, 'listing.amazonAccountId'),
    required(row.marketplace, 'listing.marketplace').toLowerCase(),
    required(row.asin, 'listing.asin').toUpperCase(),
    required(row.sku, 'listing.sku').toLowerCase(),
    required(row.companyProductId, 'listing.companyProductId'),
  ];
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareListings(left: ListingIdentity, right: ListingIdentity) {
  return compareText(normalizedIdentity(left).join('\u0000'), normalizedIdentity(right).join('\u0000'));
}

function listingDigestProjection(row: CorrectedListingPerformanceRow) {
  return correctedInventoryPlanningDigestProjection(row);
}

const FAMILY_ACTION_DIGEST_FIELDS = [
  'naturalKey',
  'familyKey',
  'companyProductFamilyId',
  'companyId',
  'amazonAccountId',
  'marketplace',
  'canonicalAsin',
  'targetSelectionState',
  'targetCompanyProductId',
  'representativeCompanyProductId',
  'actionSourceCompanyProductId',
  'memberCount',
  'primaryActionPane',
  'primaryActionReasonCode',
  'replenishmentEligibility',
  'replenishmentBlockReasonCode',
  'existingOrderFollowUp',
  'existingOrderFollowUpAction',
  'newReplenishmentActionable',
  'oosAlertActionable',
  'supplyActionable',
  'recommendedOrderQty',
  'alternateRecommendationCompanyProductIds',
  'targetSelectionEvidence',
  'listing',
  'linkedMemberEvidence',
] as const;

function familyDigestProjection(action: CorrectedFamilyActionProjection) {
  return Object.fromEntries(
    FAMILY_ACTION_DIGEST_FIELDS.map((field) => [
      field,
      normalizeCorrectedInventoryPlanningDigestValue(field, action[field]),
    ]),
  );
}

export function correctedListingRowDigest(rows: CorrectedListingPerformanceRow[]) {
  return digest([...rows].sort(compareListings).map(listingDigestProjection));
}

export function correctedFamilyActionProjectionDigest(actions: CorrectedFamilyActionProjection[]) {
  return digest(
    [...actions].sort((left, right) => compareText(left.familyKey, right.familyKey)).map(familyDigestProjection),
  );
}

const PERSISTED_DATE_ONLY_FIELDS = new Set([
  'sourceAsOfDate',
  'baselineWindowStartDate',
  'baselineWindowEndDate',
  'bestUnitsMonth',
  'bestProfitMonth',
  'worstUnitsMonth',
  'worstProfitMonth',
  'lastClosedMonth',
  'currentMonthStartDate',
  'currentCoverageEndDate',
  'rollingVelocityWindowStartDate',
  'rollingVelocityWindowEndDate',
  'calculationDate',
  'salesVelocityWindowStart',
  'salesVelocityWindowEnd',
  'salesVelocityAsOfDate',
  'inventoryAsOfDate',
  'estimatedOosDate',
  'positionEstimatedOosDate',
  'latestSafeReorderDate',
  'expectedArrivalDate',
  'expectedArrivalAsOf',
]);

function canonicalPersistedListingRow(row: CorrectedListingPerformanceRow) {
  return Object.fromEntries(
    Object.entries(row).map(([field, value]) => {
      if (!(value instanceof Date)) return [field, value];
      if (Number.isNaN(value.getTime())) {
        throw new CorrectedGoldProjectionError(
          `EcoBase persisted corrected Gold row requires ${field} as a valid PostgreSQL date.`,
          { field },
        );
      }
      const iso = value.toISOString();
      return [field, PERSISTED_DATE_ONLY_FIELDS.has(field) ? iso.slice(0, 10) : iso];
    }),
  ) as unknown as CorrectedListingPerformanceRow;
}

export function derivePersistedCorrectedCandidateEvidence(
  rows: CorrectedListingPerformanceRow[],
  params: { runId: string; generatedAt: string },
) {
  const listingRows = rows.map(canonicalPersistedListingRow);
  const familyActions = deriveCorrectedFamilyActionsFromListingRows(listingRows, params);
  return {
    listingRows,
    listingRowCount: listingRows.length,
    listingRowDigest: correctedListingRowDigest(listingRows),
    familyActionProjectionCount: familyActions.length,
    familyActionProjectionDigest: correctedFamilyActionProjectionDigest(familyActions),
  };
}

export function deriveListingReviewCategories(row: Record<string, unknown>): ListingReviewCategory[] {
  const categories = new Set<ListingReviewCategory>();
  if ([row.baselineTier, row.lastClosedMonthTier, row.currentProjectedTier].includes('D')) {
    categories.add('tier_d');
  }
  if ([row.baselineState, row.lastClosedMonthState, row.currentProjectedState].includes('no_movement')) {
    categories.add('no_movement');
  }
  if (row.closedTierMovement === 'declined') categories.add('closed_decline');
  if (row.projectedTierMovement === 'declined') categories.add('projected_decline');
  if (row.inventoryDisposition === 'no_sell_through') categories.add('stuck');
  if (row.inventoryDisposition === 'over_60_days_cover') categories.add('excess');
  if (
    row.primaryActionPane === 'dataReadiness' ||
    row.baselineState === 'unclassified' ||
    ['blocked_insufficient_evidence', 'review_missing_target'].includes(String(row.replenishmentEligibility ?? ''))
  ) {
    categories.add('data_readiness');
  }
  return [...categories].sort();
}

export function listingMemberPerformanceEvidence(row: CorrectedListingPerformanceRow) {
  return {
    companyProductId: row.companyProductId,
    baselineTier: row.baselineTier,
    baselineTierScore: row.baselineTierScore,
    baselineState: row.baselineState,
    baselineConfidence: row.baselineConfidence,
    inventoryDisposition: row.inventoryDisposition,
    replenishmentEligibility: row.replenishmentEligibility,
    primaryActionPane: row.primaryActionPane,
    listingReviewCategories: row.listingReviewCategories,
  };
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function actionListing(row: CorrectedListingPerformanceRow) {
  return structuredClone(listingDigestProjection(row));
}

function correctedFamilyAction(
  snapshot: CorrectedFamilyActionSnapshot,
  members: CorrectedListingPerformanceRow[],
  options: { runId: string; generatedAt: string },
): CorrectedFamilyActionProjection {
  const sortedMembers = [...members].sort(compareListings);
  if (!sortedMembers.length) {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold family-action projection found no members for "${snapshot.familyKey}".`,
    );
  }
  const representative = sortedMembers[0];
  const target = snapshot.targetCompanyProductId
    ? sortedMembers.find((member) => member.companyProductId === snapshot.targetCompanyProductId)
    : undefined;
  if (snapshot.targetSelectionState === 'automatic' && !target) {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold projection family "${snapshot.familyKey}" frozen target is not a member.`,
    );
  }
  if (snapshot.targetSelectionState === 'review' && snapshot.targetCompanyProductId !== null) {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold projection review family must keep targetCompanyProductId null (${snapshot.familyKey}).`,
    );
  }
  // Task 002: a fully discontinued/paused family must not fall back into Data
  // Readiness review — it belongs to the visible discontinuedPaused pane.
  const allMembersDiscontinued = sortedMembers.every((member) => member.primaryActionPane === 'discontinuedPaused');
  const decision = target
    ? {
        primaryActionPane: target.primaryActionPane,
        primaryActionReasonCode: target.primaryActionReasonCode,
        replenishmentEligibility: target.replenishmentEligibility,
        replenishmentBlockReasonCode: target.replenishmentBlockReasonCode,
        existingOrderFollowUp: target.existingOrderFollowUp,
        existingOrderFollowUpAction: target.existingOrderFollowUpAction,
        newReplenishmentActionable: target.newReplenishmentActionable,
        oosAlertActionable: target.oosAlertActionable,
        supplyActionable: target.supplyActionable,
      }
    : allMembersDiscontinued
      ? {
          primaryActionPane: 'discontinuedPaused',
          primaryActionReasonCode: 'lifecycle_discontinued_or_paused',
          replenishmentEligibility: 'excluded_discontinued',
          replenishmentBlockReasonCode: 'excluded_discontinued',
          existingOrderFollowUp: false,
          existingOrderFollowUpAction: 'none',
          newReplenishmentActionable: false,
          oosAlertActionable: false,
          supplyActionable: false,
        }
      : {
          primaryActionPane: 'dataReadiness',
          primaryActionReasonCode: 'frozen_family_target_review',
          replenishmentEligibility: 'review_missing_target',
          replenishmentBlockReasonCode: 'review_missing_target',
          existingOrderFollowUp: false,
          existingOrderFollowUpAction: 'none',
          newReplenishmentActionable: false,
          oosAlertActionable: false,
          supplyActionable: false,
        };
  const alternateRecommendationCompanyProductIds =
    target && target.replenishmentEligibility !== 'eligible'
      ? sortedMembers
          .filter(
            (member) =>
              member.companyProductId !== target.companyProductId && member.replenishmentEligibility === 'eligible',
          )
          .map((member) => member.companyProductId)
      : [];
  return {
    runId: required(options.runId, 'familyAction.runId'),
    generatedAt: required(options.generatedAt, 'familyAction.generatedAt'),
    naturalKey: snapshot.familyKey,
    familyKey: snapshot.familyKey,
    companyProductFamilyId: snapshot.companyProductFamilyId,
    companyId: snapshot.companyId,
    amazonAccountId: snapshot.amazonAccountId,
    marketplace: snapshot.marketplace,
    canonicalAsin: snapshot.canonicalAsin,
    targetSelectionState: target ? 'frozen_target' : 'review_required',
    targetCompanyProductId: snapshot.targetCompanyProductId,
    representativeCompanyProductId: target?.companyProductId ?? representative.companyProductId,
    actionSourceCompanyProductId: target?.companyProductId ?? null,
    memberCount: sortedMembers.length,
    ...decision,
    recommendedOrderQty: target?.recommendedOrderQty ?? null,
    alternateRecommendationCompanyProductIds,
    targetSelectionEvidence: structuredClone(snapshot.targetSelectionEvidence),
    listing: target ? actionListing(target) : null,
    linkedMemberEvidence: sortedMembers.map((member) => ({
      companyProductId: member.companyProductId,
      listingReviewCategories: [...member.listingReviewCategories].sort(),
    })),
  };
}

function familyActionSnapshot(row: CorrectedListingPerformanceRow): CorrectedFamilyActionSnapshot {
  const snapshot = plainRecord(plainRecord(row.calculationEvidence).familyActionSnapshot);
  const targetSelectionState = snapshot.targetSelectionState;
  if (targetSelectionState !== 'automatic' && targetSelectionState !== 'review') {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold listing "${row.companyProductId}" is missing its immutable family-action snapshot.`,
    );
  }
  let targetCompanyProductId: string | null;
  if (snapshot.targetCompanyProductId === null) {
    targetCompanyProductId = null;
  } else if (typeof snapshot.targetCompanyProductId === 'string') {
    targetCompanyProductId = snapshot.targetCompanyProductId;
  } else {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold listing "${row.companyProductId}" has an invalid frozen family target snapshot.`,
    );
  }
  return {
    familyKey: required(snapshot.familyKey, 'familyActionSnapshot.familyKey'),
    companyProductFamilyId: required(snapshot.companyProductFamilyId, 'familyActionSnapshot.companyProductFamilyId'),
    companyId: required(snapshot.companyId, 'familyActionSnapshot.companyId'),
    amazonAccountId: required(snapshot.amazonAccountId, 'familyActionSnapshot.amazonAccountId'),
    marketplace: required(snapshot.marketplace, 'familyActionSnapshot.marketplace'),
    canonicalAsin: required(snapshot.canonicalAsin, 'familyActionSnapshot.canonicalAsin'),
    targetSelectionState,
    targetCompanyProductId,
    targetSelectionEvidence: structuredClone(plainRecord(snapshot.targetSelectionEvidence)),
  };
}

export function deriveCorrectedFamilyActionsFromListingRows(
  listingRows: CorrectedListingPerformanceRow[],
  options: { runId: string; generatedAt: string },
) {
  const rowsByFamily = new Map<string, CorrectedListingPerformanceRow[]>();
  const snapshotsByFamily = new Map<string, CorrectedFamilyActionSnapshot>();
  for (const row of listingRows) {
    if (row.refreshRunId !== options.runId) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold listing "${row.companyProductId}" belongs to run "${row.refreshRunId}", not "${options.runId}".`,
      );
    }
    const snapshot = familyActionSnapshot(row);
    if (row.companyProductFamilyId !== snapshot.companyProductFamilyId) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold listing "${row.companyProductId}" has family snapshot drift.`,
      );
    }
    const existing = snapshotsByFamily.get(snapshot.familyKey);
    if (existing && canonicalJson(existing) !== canonicalJson(snapshot)) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold family "${snapshot.familyKey}" has conflicting immutable snapshots.`,
      );
    }
    snapshotsByFamily.set(snapshot.familyKey, snapshot);
    rowsByFamily.set(snapshot.familyKey, [...(rowsByFamily.get(snapshot.familyKey) ?? []), row]);
  }
  return [...snapshotsByFamily]
    .sort(([left], [right]) => compareText(left, right))
    .map(([familyKey, snapshot]) => correctedFamilyAction(snapshot, rowsByFamily.get(familyKey) ?? [], options));
}

export function buildCorrectedGoldProjection(input: CorrectedGoldProjectionInput): CorrectedGoldProjectionResult {
  if (!Number.isSafeInteger(input.expectedListingCount) || input.expectedListingCount < 0) {
    throw new CorrectedGoldProjectionError('EcoBase corrected Gold projection expected listing count is invalid.');
  }
  if (!Number.isSafeInteger(input.expectedFamilyActionCount) || input.expectedFamilyActionCount < 0) {
    throw new CorrectedGoldProjectionError(
      'EcoBase corrected Gold projection expected family-action count is invalid.',
    );
  }
  if (input.listings.length !== input.expectedListingCount) {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold projection expected ${input.expectedListingCount} listing rows; received ${input.listings.length}.`,
    );
  }
  if (input.families.length !== input.expectedFamilyActionCount) {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold projection expected ${input.expectedFamilyActionCount} family actions; received ${input.families.length}.`,
    );
  }
  if (input.ruleVersion !== CORRECTED_TIER_RULE_VERSION) {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold projection requires rule ${CORRECTED_TIER_RULE_VERSION}.`,
    );
  }
  if (input.algorithmContractVersion !== CORRECTED_ALGORITHM_CONTRACT_VERSION) {
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold projection requires algorithm ${CORRECTED_ALGORITHM_CONTRACT_VERSION}.`,
    );
  }
  if (!['informational', 'evidence_driven'].includes(input.currentProjectionGateMode)) {
    throw new CorrectedGoldProjectionError('EcoBase corrected Gold projection gate mode is invalid.');
  }
  const runId = required(input.runId, 'runId');
  const calculationDate = required(input.calculationDate, 'calculationDate');
  const generatedAt = required(input.generatedAt, 'generatedAt');
  const resolvedPlanningSettingsDigest = sha256Digest(
    input.resolvedPlanningSettingsDigest,
    'resolvedPlanningSettingsDigest',
  );
  const sourceCoverageDigest = sha256Digest(input.sourceCoverageDigest, 'sourceCoverageDigest');
  const sourceInputDigest = sha256Digest(input.sourceInputDigest, 'sourceInputDigest');
  const protectedSilverFingerprint = sha256Digest(input.protectedSilverFingerprint, 'protectedSilverFingerprint');
  const candidateInputDigest = sha256Digest(input.candidateInputDigest, 'candidateInputDigest');

  const listingById = new Map<string, CorrectedListingPerformanceInput>();
  for (const listing of input.listings) {
    const companyProductId = required(listing.companyProductId, 'listing.companyProductId');
    if (listingById.has(companyProductId)) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold projection found duplicate companyProductId "${companyProductId}".`,
      );
    }
    required(listing.companyProductFamilyId, 'listing.companyProductFamilyId');
    sha256Digest(listing.productCoverageDigest, `listing.${companyProductId}.productCoverageDigest`);
    normalizedIdentity(listing);
    listingById.set(companyProductId, listing);
  }

  const listingRows = [...input.listings].sort(compareListings).map((listing): CorrectedListingPerformanceRow => {
    const cloned = structuredClone(listing) as CorrectedListingPerformanceInput;
    const { replenishmentDecision, ...performance } = cloned;
    const cleanPerformance = omitObsoleteInventoryPlanningRowFields(performance);
    const naturalKey = `${runId}:listing:${digest(normalizedIdentity(listing))}`;
    const performanceRow = {
      ...cleanPerformance,
      productCoverageDigest: sha256Digest(
        listing.productCoverageDigest,
        `listing.${listing.companyProductId}.productCoverageDigest`,
      ),
      naturalKey,
      refreshRunId: runId,
      calculationDate,
      ruleVersion: CORRECTED_TIER_RULE_VERSION,
      algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
      currentProjectionGateMode: input.currentProjectionGateMode,
      resolvedPlanningSettingsDigest,
      sourceCoverageDigest,
      sourceInputDigest,
      protectedSilverFingerprint,
      candidateInputDigest,
      ...replenishmentDecision,
    };
    const correctedRow = {
      ...performanceRow,
      listingReviewCategories: deriveListingReviewCategories(performanceRow),
    };
    return {
      ...Object.fromEntries(
        CORRECTED_INVENTORY_PLANNING_ROW_FIELDS.map((field) => [field, correctedRow[field] ?? null]),
      ),
      naturalKey,
      refreshRunId: runId,
    } as CorrectedListingPerformanceRow;
  });
  const projectedListingById = new Map(listingRows.map((row) => [row.companyProductId, row]));

  const familyKeys = new Set<string>();
  const assignedMembers = new Set<string>();
  const familyActions: CorrectedFamilyActionProjection[] = [];
  for (const frozenFamily of [...input.families].sort((left, right) => compareText(left.familyKey, right.familyKey))) {
    const familyKey = required(frozenFamily.familyKey, 'family.familyKey');
    if (familyKeys.has(familyKey)) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold projection found duplicate family "${familyKey}".`,
      );
    }
    familyKeys.add(familyKey);
    if (!['automatic', 'review'].includes(frozenFamily.targetSelectionState)) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold projection family "${familyKey}" has invalid state.`,
      );
    }
    if (frozenFamily.targetSelectionState === 'review' && frozenFamily.targetCompanyProductId !== null) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold projection review family must keep targetCompanyProductId null (${familyKey}).`,
      );
    }
    if (frozenFamily.targetSelectionState === 'automatic' && !frozenFamily.targetCompanyProductId) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold projection automatic family "${familyKey}" requires its frozen target.`,
      );
    }
    const memberIds = [...new Set(frozenFamily.memberCompanyProductIds)];
    if (!memberIds.length || memberIds.length !== frozenFamily.memberCompanyProductIds.length) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold projection family "${familyKey}" has empty or duplicate membership.`,
      );
    }
    const members = memberIds.map((companyProductId) => {
      if (assignedMembers.has(companyProductId)) {
        throw new CorrectedGoldProjectionError(
          `EcoBase corrected Gold projection member "${companyProductId}" belongs to more than one family.`,
        );
      }
      const member = projectedListingById.get(companyProductId);
      if (!member || member.companyProductFamilyId !== frozenFamily.companyProductFamilyId) {
        throw new CorrectedGoldProjectionError(
          `EcoBase corrected Gold projection family "${familyKey}" has membership drift for "${companyProductId}".`,
        );
      }
      const memberIdentityMatches =
        member.companyId === frozenFamily.companyId &&
        member.amazonAccountId === frozenFamily.amazonAccountId &&
        member.marketplace.trim().toLowerCase() === frozenFamily.marketplace.trim().toLowerCase() &&
        member.asin.trim().toUpperCase() === frozenFamily.canonicalAsin.trim().toUpperCase();
      if (!memberIdentityMatches) {
        throw new CorrectedGoldProjectionError(
          `EcoBase corrected Gold projection family "${familyKey}" has identity drift for "${companyProductId}".`,
        );
      }
      assignedMembers.add(companyProductId);
      return member;
    });
    const sortedMembers = members.sort((left, right) => compareListings(left, right));
    const target = frozenFamily.targetCompanyProductId
      ? projectedListingById.get(frozenFamily.targetCompanyProductId)
      : undefined;
    if (
      frozenFamily.targetSelectionState === 'automatic' &&
      (!target || !memberIds.includes(frozenFamily.targetCompanyProductId as string))
    ) {
      throw new CorrectedGoldProjectionError(
        `EcoBase corrected Gold projection family "${familyKey}" frozen target is not a member.`,
      );
    }
    const snapshot: CorrectedFamilyActionSnapshot = {
      familyKey,
      companyProductFamilyId: required(frozenFamily.companyProductFamilyId, 'family.companyProductFamilyId'),
      companyId: required(frozenFamily.companyId, 'family.companyId'),
      amazonAccountId: required(frozenFamily.amazonAccountId, 'family.amazonAccountId'),
      marketplace: required(frozenFamily.marketplace, 'family.marketplace'),
      canonicalAsin: required(frozenFamily.canonicalAsin, 'family.canonicalAsin'),
      targetSelectionState: frozenFamily.targetSelectionState,
      targetCompanyProductId: frozenFamily.targetCompanyProductId,
      targetSelectionEvidence: structuredClone(frozenFamily.targetSelectionEvidence),
    };
    for (const member of sortedMembers) {
      const isTarget = member.companyProductId === frozenFamily.targetCompanyProductId;
      member.isFrozenFamilyTarget = isTarget;
      member.familyTargetCompanyProductId = frozenFamily.targetCompanyProductId;
      member.calculationEvidence = {
        ...plainRecord(member.calculationEvidence),
        familyActionSnapshot: structuredClone(snapshot),
      };
    }
    familyActions.push(correctedFamilyAction(snapshot, sortedMembers, { runId, generatedAt }));
  }
  if (assignedMembers.size !== listingRows.length) {
    const unassigned = listingRows
      .filter((listing) => !assignedMembers.has(listing.companyProductId))
      .map((listing) => listing.companyProductId);
    throw new CorrectedGoldProjectionError(
      `EcoBase corrected Gold projection has ${unassigned.length} listing memberships not owned by one family.`,
      { unassigned },
    );
  }

  const listingRowDigest = correctedListingRowDigest(listingRows);
  const familyActionProjectionDigest = correctedFamilyActionProjectionDigest(familyActions);
  return {
    listingRows,
    familyActions,
    runMetadata: {
      ruleVersion: CORRECTED_TIER_RULE_VERSION,
      algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
      currentProjectionGateMode: input.currentProjectionGateMode,
      resolvedPlanningSettingsDigest,
      sourceCoverageDigest,
      sourceInputDigest,
      protectedSilverFingerprint,
      candidateInputDigest,
      canonicalSerializerVersion: CORRECTED_CANONICAL_SERIALIZER_VERSION,
      candidateInputDigestVersion: CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION,
      sourceCoverageDigestVersion: CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION,
      listingRowDigestVersion: CORRECTED_LISTING_ROW_DIGEST_VERSION,
      familyActionProjectionDigestVersion: CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
      listingRowCount: listingRows.length,
      listingRowDigest,
      familyActionProjectionCount: familyActions.length,
      familyActionProjectionDigest,
      protectedDomainMutationCount: 0,
    },
  };
}

export function filterListingPerformanceReview(
  listingRows: CorrectedListingPerformanceRow[],
  requestedCategories: ListingReviewCategory[],
) {
  const selectedCategories = [...new Set(requestedCategories)].sort();
  for (const category of selectedCategories) {
    if (!LISTING_REVIEW_CATEGORIES.has(category)) {
      throw new CorrectedGoldProjectionError(
        `EcoBase listing-performance review received unsupported listing review category "${category}".`,
        { category },
      );
    }
  }
  const rows = listingRows.filter((row) => {
    const categories = Array.isArray(row.listingReviewCategories) ? row.listingReviewCategories : [];
    if (selectedCategories.length === 0) return true;
    return selectedCategories.some((category) => categories.includes(category));
  });
  return {
    scope: 'listing_performance_review' as const,
    selectedCategories,
    listingCount: rows.length,
    actionCount: 0 as const,
    rows,
  };
}
