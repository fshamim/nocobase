/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  decideReplenishment,
  type ReplenishmentDecisionInput,
} from '../../features/inventory-planning/server/replenishment-decision';

function input(overrides: Partial<ReplenishmentDecisionInput> = {}): ReplenishmentDecisionInput {
  return {
    administrativelyExcluded: false,
    lifecycleDiscontinuedOrPaused: false,
    hasFrozenTarget: true,
    targetSelectionState: 'automatic',
    identityEvidenceValid: true,
    baselineEvidenceValid: true,
    inventoryDisposition: 'none',
    baselineState: 'ranked',
    baselineTier: 'B',
    baselineConfidence: 'full',
    lastClosedMonthState: 'ranked',
    lastClosedMonthTier: 'B',
    closedTierMovement: 'stable',
    currentProjectionGateMode: 'informational',
    currentProjectionConfidence: 'trusted',
    currentProjectedState: 'ranked',
    currentProjectedTier: 'B',
    projectedTierMovement: 'stable',
    existingOrderStage: 'none',
    trustedZeroStock: false,
    trustedReorderDue: false,
    ...overrides,
  };
}

describe('total replenishment and primary-pane decision', () => {
  it.each([
    [1, { administrativelyExcluded: true }, 'excluded', 'adminExcluded', 'administrative_exclusion'],
    [
      2,
      { lifecycleDiscontinuedOrPaused: true },
      'excluded_discontinued',
      'discontinuedPaused',
      'lifecycle_discontinued_or_paused',
    ],
    [2, { hasFrozenTarget: false }, 'review_missing_target', 'dataReadiness', 'frozen_family_target_review'],
    [2, { targetSelectionState: 'review' }, 'review_missing_target', 'dataReadiness', 'frozen_family_target_review'],
    [
      3,
      { inventoryDisposition: 'no_sell_through' },
      'blocked_stuck_inventory',
      'stuckInventory',
      'trusted_no_sell_through',
    ],
    [
      4,
      { inventoryDisposition: 'over_60_days_cover' },
      'blocked_excess_inventory',
      'excessInventory',
      'trusted_over_60_days_cover',
    ],
    [
      5,
      { inventoryDisposition: 'insufficient_velocity_evidence' },
      'blocked_insufficient_evidence',
      'dataReadiness',
      'missing_or_invalid_baseline_evidence',
    ],
    [
      5,
      { identityEvidenceValid: false },
      'blocked_insufficient_evidence',
      'dataReadiness',
      'missing_or_invalid_baseline_evidence',
    ],
    [
      5,
      { baselineEvidenceValid: false },
      'blocked_insufficient_evidence',
      'dataReadiness',
      'missing_or_invalid_baseline_evidence',
    ],
    [
      5,
      { baselineState: 'unclassified', baselineTier: null },
      'blocked_insufficient_evidence',
      'dataReadiness',
      'missing_or_invalid_baseline_evidence',
    ],
    [
      6,
      { baselineState: 'no_movement', baselineTier: null },
      'not_eligible_no_movement',
      'untieredProducts',
      'baseline_no_movement',
    ],
    [7, { baselineTier: 'D' }, 'blocked_baseline_tier_d', 'performanceReview', 'baseline_tier_d'],
    [
      8,
      { baselineConfidence: 'none' },
      'blocked_insufficient_evidence',
      'dataReadiness',
      'missing_or_invalid_baseline_evidence',
    ],
    [9, { lastClosedMonthTier: 'D' }, 'blocked_closed_tier_d', 'performanceReview', 'last_closed_tier_d'],
    [
      10,
      { lastClosedMonthState: 'no_movement', lastClosedMonthTier: null },
      'review_closed_no_movement',
      'performanceReview',
      'last_closed_no_movement',
    ],
    [11, { closedTierMovement: 'declined' }, 'review_closed_tier_decline', 'performanceReview', 'closed_tier_decline'],
    [
      12,
      { lastClosedMonthState: 'unclassified', lastClosedMonthTier: null },
      'review_closed_period_unknown',
      'performanceReview',
      'last_closed_period_unknown',
    ],
    [
      13,
      { baselineConfidence: 'moderate' },
      'review_insufficient_baseline_confidence',
      'performanceReview',
      'insufficient_baseline_confidence',
    ],
    [
      13,
      { baselineConfidence: 'low' },
      'review_insufficient_baseline_confidence',
      'performanceReview',
      'insufficient_baseline_confidence',
    ],
    [14, {}, 'eligible', 'healthyInventory', 'sufficient_stock'],
    [
      15,
      { currentProjectionGateMode: 'evidence_driven', currentProjectionConfidence: 'early' },
      'review_current_projection_evidence',
      'performanceReview',
      'current_projection_evidence_unavailable',
    ],
    [
      15,
      { currentProjectionGateMode: 'evidence_driven', currentProjectionConfidence: 'unavailable' },
      'review_current_projection_evidence',
      'performanceReview',
      'current_projection_evidence_unavailable',
    ],
    [
      16,
      { currentProjectionGateMode: 'evidence_driven', currentProjectedTier: 'D' },
      'blocked_current_tier_d',
      'performanceReview',
      'current_projected_tier_d',
    ],
    [
      17,
      {
        currentProjectionGateMode: 'evidence_driven',
        currentProjectedState: 'no_movement',
        currentProjectedTier: null,
      },
      'review_current_no_movement',
      'performanceReview',
      'current_projected_no_movement',
    ],
    [
      17,
      {
        currentProjectionGateMode: 'evidence_driven',
        currentProjectedState: 'unclassified',
        currentProjectedTier: null,
      },
      'review_current_no_movement',
      'performanceReview',
      'current_projected_no_movement',
    ],
    [
      18,
      { currentProjectionGateMode: 'evidence_driven', projectedTierMovement: 'declined' },
      'review_projected_tier_decline',
      'performanceReview',
      'projected_tier_decline',
    ],
    [19, { currentProjectionGateMode: 'evidence_driven' }, 'eligible', 'healthyInventory', 'sufficient_stock'],
  ] as const)(
    'applies precedence %i for %j',
    (decisionPrecedence, overrides, replenishmentEligibility, primaryActionPane, primaryActionReasonCode) => {
      const result = decideReplenishment(input(overrides as Partial<ReplenishmentDecisionInput>));

      expect(result).toMatchObject({
        decisionPrecedence,
        replenishmentEligibility,
        primaryActionPane,
        primaryActionReasonCode,
      });
      expect(result.replenishmentBlockReasonCode).toBe(
        replenishmentEligibility === 'eligible'
          ? result.currentProjectionGateMode === 'informational'
            ? 'eligible_informational_projection'
            : 'eligible_evidence_driven_projection'
          : replenishmentEligibility,
      );
    },
  );

  it('keeps informational projection visible but unable to alter eligibility or pane routing', () => {
    const result = decideReplenishment(
      input({
        currentProjectionGateMode: 'informational',
        currentProjectionConfidence: 'unavailable',
        currentProjectedState: 'ranked',
        currentProjectedTier: 'D',
        projectedTierMovement: 'declined',
      }),
    );

    expect(result).toMatchObject({
      replenishmentEligibility: 'eligible',
      primaryActionPane: 'healthyInventory',
      currentProjectionGateMode: 'informational',
    });
  });

  it.each([
    ['pre_purchase', 'activeOrders', 'existing_order_pre_purchase'],
    ['in_prep', 'inPrepMonitoring', 'existing_order_in_prep'],
    ['inbound', 'inboundMonitoring', 'existing_order_inbound'],
  ] as const)('routes eligible %s orders once without creating a new recommendation', (stage, pane, reason) => {
    const result = decideReplenishment(
      input({ existingOrderStage: stage, trustedZeroStock: true, trustedReorderDue: true }),
    );

    expect(result).toMatchObject({
      replenishmentEligibility: 'eligible',
      primaryActionPane: pane,
      primaryActionReasonCode: reason,
      existingOrderFollowUp: true,
      existingOrderFollowUpAction: 'follow_up_existing_order',
      newReplenishmentActionable: false,
      oosAlertActionable: false,
      supplyActionable: false,
    });
  });

  it('keeps existing-order follow-up nested in the already selected blocked/review pane', () => {
    const result = decideReplenishment(
      input({ inventoryDisposition: 'no_sell_through', existingOrderStage: 'inbound', trustedZeroStock: true }),
    );

    expect(result).toMatchObject({
      replenishmentEligibility: 'blocked_stuck_inventory',
      primaryActionPane: 'stuckInventory',
      existingOrderFollowUp: true,
      existingOrderFollowUpAction: 'follow_up_existing_order',
      newReplenishmentActionable: false,
      oosAlertActionable: false,
      supplyActionable: false,
    });
  });

  it('routes only eligible no-order stock actions and suppresses every blocked/review recommendation', () => {
    expect(decideReplenishment(input({ trustedZeroStock: true }))).toMatchObject({
      primaryActionPane: 'zeroStock',
      primaryActionReasonCode: 'trusted_zero_stock',
      newReplenishmentActionable: true,
      oosAlertActionable: true,
      supplyActionable: false,
    });
    expect(decideReplenishment(input({ trustedReorderDue: true }))).toMatchObject({
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'trusted_reorder_due',
      newReplenishmentActionable: true,
      oosAlertActionable: false,
      supplyActionable: true,
    });
    expect(decideReplenishment(input())).toMatchObject({
      primaryActionPane: 'healthyInventory',
      primaryActionReasonCode: 'sufficient_stock',
      newReplenishmentActionable: false,
      oosAlertActionable: false,
      supplyActionable: false,
    });

    for (const overrides of [
      { baselineTier: 'D' as const },
      { closedTierMovement: 'declined' as const },
      { baselineConfidence: 'moderate' as const },
      { currentProjectionGateMode: 'evidence_driven' as const, currentProjectedTier: 'D' as const },
    ]) {
      const result = decideReplenishment(input({ ...overrides, trustedZeroStock: true, trustedReorderDue: true }));
      expect(result.newReplenishmentActionable).toBe(false);
      expect(result.oosAlertActionable).toBe(false);
      expect(result.supplyActionable).toBe(false);
    }
  });

  it('is total across the coherent state cross-product with exactly one result and no action leakage', () => {
    const baselineVariants = [
      { baselineState: 'unclassified', baselineTier: null },
      { baselineState: 'no_movement', baselineTier: null },
      ...(['A', 'B', 'C', 'D'] as const).map((baselineTier) => ({ baselineState: 'ranked' as const, baselineTier })),
    ] as const;
    const closedVariants = [
      { lastClosedMonthState: 'unclassified', lastClosedMonthTier: null },
      { lastClosedMonthState: 'no_movement', lastClosedMonthTier: null },
      ...(['A', 'B', 'C', 'D'] as const).map((lastClosedMonthTier) => ({
        lastClosedMonthState: 'ranked' as const,
        lastClosedMonthTier,
      })),
    ] as const;
    const currentVariants = [
      { currentProjectionConfidence: 'unavailable', currentProjectedState: 'unclassified', currentProjectedTier: null },
      { currentProjectionConfidence: 'early', currentProjectedState: 'ranked', currentProjectedTier: 'C' },
      { currentProjectionConfidence: 'trusted', currentProjectedState: 'no_movement', currentProjectedTier: null },
      ...(['A', 'B', 'C', 'D'] as const).map((currentProjectedTier) => ({
        currentProjectionConfidence: 'trusted' as const,
        currentProjectedState: 'ranked' as const,
        currentProjectedTier,
      })),
    ] as const;
    const eligibilityValues = new Set([
      'excluded',
      'review_missing_target',
      'blocked_stuck_inventory',
      'blocked_excess_inventory',
      'blocked_insufficient_evidence',
      'not_eligible_no_movement',
      'blocked_baseline_tier_d',
      'blocked_closed_tier_d',
      'review_closed_no_movement',
      'review_closed_tier_decline',
      'review_closed_period_unknown',
      'review_insufficient_baseline_confidence',
      'review_current_projection_evidence',
      'blocked_current_tier_d',
      'review_current_no_movement',
      'review_projected_tier_decline',
      'eligible',
    ]);
    let examined = 0;
    for (const baseline of baselineVariants) {
      for (const closed of closedVariants) {
        for (const current of currentVariants) {
          for (const baselineConfidence of ['full', 'moderate', 'low', 'none'] as const) {
            for (const inventoryDisposition of [
              'none',
              'no_sell_through',
              'over_60_days_cover',
              'insufficient_velocity_evidence',
            ] as const) {
              for (const currentProjectionGateMode of ['informational', 'evidence_driven'] as const) {
                for (const existingOrderStage of ['none', 'pre_purchase', 'in_prep', 'inbound'] as const) {
                  const result = decideReplenishment(
                    input({
                      ...baseline,
                      ...closed,
                      ...current,
                      baselineConfidence,
                      inventoryDisposition,
                      currentProjectionGateMode,
                      existingOrderStage,
                      trustedZeroStock: true,
                      trustedReorderDue: true,
                    }),
                  );
                  expect(eligibilityValues.has(result.replenishmentEligibility)).toBe(true);
                  expect(typeof result.primaryActionPane).toBe('string');
                  expect(typeof result.primaryActionReasonCode).toBe('string');
                  if (result.replenishmentEligibility !== 'eligible') {
                    expect(result.newReplenishmentActionable).toBe(false);
                    expect(result.oosAlertActionable).toBe(false);
                    expect(result.supplyActionable).toBe(false);
                  }
                  examined += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(examined).toBe(32256);
  });
});
