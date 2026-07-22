/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { InventoryDisposition } from './inventory-disposition';
import type {
  BaselineConfidence,
  CurrentProjectionConfidence,
  CurrentProjectionGateMode,
  PerformanceState,
  ProfitTier,
  TierMovement,
} from './monthly-performance';

export type TargetSelectionState = 'automatic' | 'review';
export type ExistingOrderStage = 'none' | 'pre_purchase' | 'in_prep' | 'inbound';
export type ExistingOrderFollowUpAction = 'follow_up_existing_order' | 'none';
/**
 * Dashboard v2 T3 (approved D2): 'trusted' = reorder-due under the trusted rolling
 * velocity; 'estimated' = reorder-due under a fallback velocity basis (F4 ladder);
 * 'none' = not due or no usable velocity.
 */
export type ReplenishmentReorderDueKind = 'none' | 'trusted' | 'estimated';

export type ReplenishmentEligibility =
  | 'excluded'
  | 'excluded_discontinued'
  | 'review_missing_target'
  | 'blocked_stuck_inventory'
  | 'blocked_excess_inventory'
  | 'blocked_insufficient_evidence'
  | 'not_eligible_no_movement'
  | 'blocked_baseline_tier_d'
  | 'blocked_closed_tier_d'
  | 'review_closed_no_movement'
  | 'review_closed_tier_decline'
  | 'review_closed_period_unknown'
  | 'review_insufficient_baseline_confidence'
  | 'review_current_projection_evidence'
  | 'blocked_current_tier_d'
  | 'review_current_no_movement'
  | 'review_projected_tier_decline'
  | 'eligible';

export type ReplenishmentBlockReasonCode =
  | Exclude<ReplenishmentEligibility, 'eligible'>
  | 'eligible_informational_projection'
  | 'eligible_evidence_driven_projection';

export type PrimaryActionPane =
  | 'adminExcluded'
  | 'discontinuedPaused'
  | 'supplyAction'
  | 'activeOrders'
  | 'inPrepMonitoring'
  | 'inboundMonitoring'
  | 'healthyInventory'
  | 'excessInventory'
  | 'stuckInventory'
  | 'zeroStock'
  | 'dataReadiness'
  | 'performanceReview'
  | 'untieredProducts';

export type PrimaryActionReasonCode =
  | 'administrative_exclusion'
  | 'lifecycle_discontinued_or_paused'
  | 'frozen_family_target_review'
  | 'trusted_no_sell_through'
  | 'trusted_over_60_days_cover'
  | 'missing_or_invalid_baseline_evidence'
  | 'baseline_no_movement'
  | 'baseline_tier_d'
  | 'last_closed_tier_d'
  | 'last_closed_no_movement'
  | 'closed_tier_decline'
  | 'last_closed_period_unknown'
  | 'insufficient_baseline_confidence'
  | 'current_projection_evidence_unavailable'
  | 'current_projected_tier_d'
  | 'current_projected_no_movement'
  | 'projected_tier_decline'
  | 'existing_order_pre_purchase'
  | 'existing_order_in_prep'
  | 'existing_order_inbound'
  | 'trusted_zero_stock'
  | 'trusted_reorder_due'
  | 'estimated_velocity_reorder_due'
  | 'sufficient_stock';

export interface ReplenishmentDecisionInput {
  administrativelyExcluded: boolean;
  /** Task 002: company-product lifecycle is discontinued or paused. */
  lifecycleDiscontinuedOrPaused: boolean;
  hasFrozenTarget: boolean;
  targetSelectionState: TargetSelectionState;
  identityEvidenceValid: boolean;
  baselineEvidenceValid: boolean;
  inventoryDisposition: InventoryDisposition;
  baselineState: PerformanceState;
  baselineTier: ProfitTier | null;
  baselineConfidence: BaselineConfidence;
  lastClosedMonthState: PerformanceState;
  lastClosedMonthTier: ProfitTier | null;
  closedTierMovement: TierMovement;
  currentProjectionGateMode: CurrentProjectionGateMode;
  currentProjectionConfidence: CurrentProjectionConfidence;
  currentProjectedState: PerformanceState;
  currentProjectedTier: ProfitTier | null;
  projectedTierMovement: TierMovement;
  existingOrderStage: ExistingOrderStage;
  trustedZeroStock: boolean;
  reorderDueKind: ReplenishmentReorderDueKind;
}

export interface ReplenishmentDecisionResult {
  decisionPrecedence: number;
  replenishmentEligibility: ReplenishmentEligibility;
  replenishmentBlockReasonCode: ReplenishmentBlockReasonCode;
  primaryActionPane: PrimaryActionPane;
  primaryActionReasonCode: PrimaryActionReasonCode;
  currentProjectionGateMode: CurrentProjectionGateMode;
  existingOrderFollowUp: boolean;
  existingOrderFollowUpAction: ExistingOrderFollowUpAction;
  newReplenishmentActionable: boolean;
  oosAlertActionable: boolean;
  supplyActionable: boolean;
}

export class ReplenishmentDecisionError extends Error {
  readonly code = 'ECOBASE_REPLENISHMENT_DECISION_UNREACHABLE';

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplenishmentDecisionError';
  }
}

type Decision = {
  precedence: number;
  eligibility: ReplenishmentEligibility;
  pane: PrimaryActionPane;
  reason: PrimaryActionReasonCode;
};

const TIERS = new Set<ProfitTier>(['A', 'B', 'C', 'D']);
const STATES = new Set<PerformanceState>(['ranked', 'no_movement', 'unclassified']);
const CONFIDENCES = new Set<BaselineConfidence>(['full', 'moderate', 'low', 'none']);
const PROJECTION_CONFIDENCES = new Set<CurrentProjectionConfidence>(['trusted', 'early', 'unavailable']);
const MOVEMENTS = new Set<TierMovement>(['improved', 'stable', 'declined', 'not_comparable']);
const DISPOSITIONS = new Set<InventoryDisposition>([
  'none',
  'no_sell_through',
  'over_60_days_cover',
  'insufficient_velocity_evidence',
]);

function validateInput(input: ReplenishmentDecisionInput) {
  const booleanValues = [
    input.administrativelyExcluded,
    input.lifecycleDiscontinuedOrPaused,
    input.hasFrozenTarget,
    input.identityEvidenceValid,
    input.baselineEvidenceValid,
    input.trustedZeroStock,
  ];
  const valid =
    booleanValues.every((value) => typeof value === 'boolean') &&
    ['automatic', 'review'].includes(input.targetSelectionState) &&
    STATES.has(input.baselineState) &&
    (input.baselineTier === null || TIERS.has(input.baselineTier)) &&
    CONFIDENCES.has(input.baselineConfidence) &&
    STATES.has(input.lastClosedMonthState) &&
    (input.lastClosedMonthTier === null || TIERS.has(input.lastClosedMonthTier)) &&
    MOVEMENTS.has(input.closedTierMovement) &&
    ['informational', 'evidence_driven'].includes(input.currentProjectionGateMode) &&
    PROJECTION_CONFIDENCES.has(input.currentProjectionConfidence) &&
    STATES.has(input.currentProjectedState) &&
    (input.currentProjectedTier === null || TIERS.has(input.currentProjectedTier)) &&
    MOVEMENTS.has(input.projectedTierMovement) &&
    ['none', 'pre_purchase', 'in_prep', 'inbound'].includes(input.existingOrderStage) &&
    ['none', 'trusted', 'estimated'].includes(input.reorderDueKind) &&
    DISPOSITIONS.has(input.inventoryDisposition);
  if (!valid) {
    throw new ReplenishmentDecisionError(
      'EcoBase replenishment decision received an unsupported state; no fallback eligibility is allowed.',
      { input },
    );
  }
}

function eligibilityDecision(input: ReplenishmentDecisionInput): Decision {
  if (input.administrativelyExcluded) {
    return { precedence: 1, eligibility: 'excluded', pane: 'adminExcluded', reason: 'administrative_exclusion' };
  }
  // Task 002 (surgical v1.1): discontinued/paused families generate NO signals
  // — they route straight to the visible bottom pane before any other rule
  // (readiness, targets, dispositions, orders) can fire.
  if (input.lifecycleDiscontinuedOrPaused) {
    return {
      precedence: 2,
      eligibility: 'excluded_discontinued',
      pane: 'discontinuedPaused',
      reason: 'lifecycle_discontinued_or_paused',
    };
  }
  if (!input.hasFrozenTarget || input.targetSelectionState === 'review') {
    return {
      precedence: 2,
      eligibility: 'review_missing_target',
      pane: 'dataReadiness',
      reason: 'frozen_family_target_review',
    };
  }
  if (input.inventoryDisposition === 'no_sell_through') {
    return {
      precedence: 3,
      eligibility: 'blocked_stuck_inventory',
      pane: 'stuckInventory',
      reason: 'trusted_no_sell_through',
    };
  }
  if (input.inventoryDisposition === 'over_60_days_cover') {
    return {
      precedence: 4,
      eligibility: 'blocked_excess_inventory',
      pane: 'excessInventory',
      reason: 'trusted_over_60_days_cover',
    };
  }
  // T3 (approved D2): an estimated reorder-due row substitutes the F4 fallback velocity for
  // the missing rolling evidence, so velocity insufficiency alone no longer blocks it. Every
  // other readiness, baseline and tier gate below still applies unchanged.
  if (
    (input.inventoryDisposition === 'insufficient_velocity_evidence' && input.reorderDueKind !== 'estimated') ||
    !input.identityEvidenceValid ||
    !input.baselineEvidenceValid ||
    input.baselineState === 'unclassified' ||
    (input.baselineState === 'ranked' && input.baselineTier === null)
  ) {
    return {
      precedence: 5,
      eligibility: 'blocked_insufficient_evidence',
      pane: 'dataReadiness',
      reason: 'missing_or_invalid_baseline_evidence',
    };
  }
  if (input.baselineState === 'no_movement') {
    return {
      precedence: 6,
      eligibility: 'not_eligible_no_movement',
      pane: 'untieredProducts',
      reason: 'baseline_no_movement',
    };
  }
  if (input.baselineTier === 'D') {
    return {
      precedence: 7,
      eligibility: 'blocked_baseline_tier_d',
      pane: 'performanceReview',
      reason: 'baseline_tier_d',
    };
  }
  if (input.baselineConfidence === 'none') {
    return {
      precedence: 8,
      eligibility: 'blocked_insufficient_evidence',
      pane: 'dataReadiness',
      reason: 'missing_or_invalid_baseline_evidence',
    };
  }
  if (input.lastClosedMonthTier === 'D') {
    return {
      precedence: 9,
      eligibility: 'blocked_closed_tier_d',
      pane: 'performanceReview',
      reason: 'last_closed_tier_d',
    };
  }
  if (input.lastClosedMonthState === 'no_movement') {
    return {
      precedence: 10,
      eligibility: 'review_closed_no_movement',
      pane: 'performanceReview',
      reason: 'last_closed_no_movement',
    };
  }
  if (input.closedTierMovement === 'declined') {
    return {
      precedence: 11,
      eligibility: 'review_closed_tier_decline',
      pane: 'performanceReview',
      reason: 'closed_tier_decline',
    };
  }
  if (input.lastClosedMonthState === 'unclassified' || input.lastClosedMonthTier === null) {
    return {
      precedence: 12,
      eligibility: 'review_closed_period_unknown',
      pane: 'performanceReview',
      reason: 'last_closed_period_unknown',
    };
  }
  if (input.baselineConfidence !== 'full') {
    return {
      precedence: 13,
      eligibility: 'review_insufficient_baseline_confidence',
      pane: 'performanceReview',
      reason: 'insufficient_baseline_confidence',
    };
  }
  if (input.currentProjectionGateMode === 'informational') {
    return { precedence: 14, eligibility: 'eligible', pane: 'healthyInventory', reason: 'sufficient_stock' };
  }
  if (input.currentProjectionConfidence !== 'trusted') {
    return {
      precedence: 15,
      eligibility: 'review_current_projection_evidence',
      pane: 'performanceReview',
      reason: 'current_projection_evidence_unavailable',
    };
  }
  if (input.currentProjectedTier === 'D') {
    return {
      precedence: 16,
      eligibility: 'blocked_current_tier_d',
      pane: 'performanceReview',
      reason: 'current_projected_tier_d',
    };
  }
  if (input.currentProjectedState !== 'ranked' || input.currentProjectedTier === null) {
    return {
      precedence: 17,
      eligibility: 'review_current_no_movement',
      pane: 'performanceReview',
      reason: 'current_projected_no_movement',
    };
  }
  if (input.projectedTierMovement === 'declined') {
    return {
      precedence: 18,
      eligibility: 'review_projected_tier_decline',
      pane: 'performanceReview',
      reason: 'projected_tier_decline',
    };
  }
  return { precedence: 19, eligibility: 'eligible', pane: 'healthyInventory', reason: 'sufficient_stock' };
}

function eligiblePane(input: ReplenishmentDecisionInput): Pick<Decision, 'pane' | 'reason'> {
  if (input.existingOrderStage === 'pre_purchase') {
    return { pane: 'activeOrders', reason: 'existing_order_pre_purchase' };
  }
  if (input.existingOrderStage === 'in_prep') {
    return { pane: 'inPrepMonitoring', reason: 'existing_order_in_prep' };
  }
  if (input.existingOrderStage === 'inbound') {
    return { pane: 'inboundMonitoring', reason: 'existing_order_inbound' };
  }
  if (input.trustedZeroStock) return { pane: 'zeroStock', reason: 'trusted_zero_stock' };
  if (input.reorderDueKind === 'trusted') return { pane: 'supplyAction', reason: 'trusted_reorder_due' };
  if (input.reorderDueKind === 'estimated') return { pane: 'supplyAction', reason: 'estimated_velocity_reorder_due' };
  return { pane: 'healthyInventory', reason: 'sufficient_stock' };
}

export function decideReplenishment(input: ReplenishmentDecisionInput): ReplenishmentDecisionResult {
  validateInput(input);
  const decision = eligibilityDecision(input);
  const eligible = decision.eligibility === 'eligible';
  const pane = eligible ? eligiblePane(input) : { pane: decision.pane, reason: decision.reason };
  const existingOrderFollowUp = input.existingOrderStage !== 'none';
  const noOpenOrder = !existingOrderFollowUp;
  const oosAlertActionable = eligible && noOpenOrder && input.trustedZeroStock;
  const supplyActionable = eligible && noOpenOrder && !input.trustedZeroStock && input.reorderDueKind !== 'none';
  const replenishmentBlockReasonCode: ReplenishmentBlockReasonCode =
    decision.eligibility === 'eligible'
      ? input.currentProjectionGateMode === 'informational'
        ? 'eligible_informational_projection'
        : 'eligible_evidence_driven_projection'
      : decision.eligibility;
  return {
    decisionPrecedence: decision.precedence,
    replenishmentEligibility: decision.eligibility,
    replenishmentBlockReasonCode,
    primaryActionPane: pane.pane,
    primaryActionReasonCode: pane.reason,
    currentProjectionGateMode: input.currentProjectionGateMode,
    existingOrderFollowUp,
    existingOrderFollowUpAction: existingOrderFollowUp ? 'follow_up_existing_order' : 'none',
    newReplenishmentActionable: oosAlertActionable || supplyActionable,
    oosAlertActionable,
    supplyActionable,
  };
}
