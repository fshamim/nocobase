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
} from '../../features/inventory-dashboard/server/engine/replenishment-decision';

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
    reorderDueKind: 'none',
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
    // 065: the two-month recent-movement window. Unranked in BOTH recent months ⇒ untiered,
    // and it outranks the dispositions so Stuck/Excess only ever hold recently-ranked products.
    [
      2,
      {
        lastClosedMonthState: 'no_movement',
        lastClosedMonthTier: null,
        currentProjectedState: 'no_movement',
        currentProjectedTier: null,
        closedTierMovement: 'not_comparable',
        projectedTierMovement: 'not_comparable',
      },
      'not_eligible_no_recent_movement',
      'untieredProducts',
      'no_recent_movement',
    ],
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
      {
        baselineState: 'unclassified',
        baselineTier: null,
        baselineEvidenceValid: false,
        currentProjectedState: 'unclassified',
        currentProjectedTier: null,
        currentProjectionConfidence: 'unavailable',
      },
      'blocked_insufficient_evidence',
      'dataReadiness',
      'missing_or_invalid_baseline_evidence',
    ],
    // 065: precedences 6 (baseline no-movement → untiered) and 7 (baseline tier D → review) are
    // deleted; baseline no longer decides membership. Their replacement behaviour — flowing on
    // when the recent window still ranks — is asserted in the dedicated cases below.
    [
      8,
      {
        baselineConfidence: 'none',
        currentProjectedState: 'unclassified',
        currentProjectedTier: null,
        currentProjectionConfidence: 'unavailable',
      },
      'blocked_insufficient_evidence',
      'dataReadiness',
      'missing_or_invalid_baseline_evidence',
    ],
    [9, { lastClosedMonthTier: 'D' }, 'blocked_closed_tier_d', 'performanceReview', 'last_closed_tier_d'],
    // 068-2: precedences 10 and 12 now carry the same trusted-current-rank bypass as 13, so — as
    // with the 13 rows below — these cases state an 'early' projection confidence to keep the gate
    // under test reachable. The trusted side of the bypass has its own cases further down.
    [
      10,
      { lastClosedMonthState: 'no_movement', lastClosedMonthTier: null, currentProjectionConfidence: 'early' },
      'review_closed_no_movement',
      'performanceReview',
      'last_closed_no_movement',
    ],
    [11, { closedTierMovement: 'declined' }, 'review_closed_tier_decline', 'performanceReview', 'closed_tier_decline'],
    [
      12,
      { lastClosedMonthState: 'unclassified', lastClosedMonthTier: null, currentProjectionConfidence: 'early' },
      'review_closed_period_unknown',
      'performanceReview',
      'last_closed_period_unknown',
    ],
    // 065: precedence 13 still reviews thin baselines, but only when the current rank is NOT
    // trusted — hence the explicit 'early' projection confidence here. The trusted bypass has
    // its own cases below.
    [
      13,
      { baselineConfidence: 'moderate', currentProjectionConfidence: 'early' },
      'review_insufficient_baseline_confidence',
      'performanceReview',
      'insufficient_baseline_confidence',
    ],
    [
      13,
      { baselineConfidence: 'low', currentProjectionConfidence: 'early' },
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
      input({ existingOrderStage: stage, trustedZeroStock: true, reorderDueKind: 'trusted' }),
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
    expect(decideReplenishment(input({ reorderDueKind: 'trusted' }))).toMatchObject({
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'trusted_reorder_due',
      newReplenishmentActionable: true,
      oosAlertActionable: false,
      supplyActionable: true,
    });
    expect(decideReplenishment(input({ reorderDueKind: 'estimated' }))).toMatchObject({
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'estimated_velocity_reorder_due',
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
      // 065: baselineTier 'D' no longer blocks (precedence 7 deleted) — recent tier D does, so
      // the blocking case is now expressed through the last-closed month (precedence 9).
      { lastClosedMonthTier: 'D' as const },
      { closedTierMovement: 'declined' as const },
      // 065: a thin baseline only blocks while the current rank is untrusted (precedence 13).
      { baselineConfidence: 'moderate' as const, currentProjectionConfidence: 'early' as const },
      { currentProjectionGateMode: 'evidence_driven' as const, currentProjectedTier: 'D' as const },
    ]) {
      const result = decideReplenishment(input({ ...overrides, trustedZeroStock: true, reorderDueKind: 'trusted' }));
      expect(result.newReplenishmentActionable).toBe(false);
      expect(result.oosAlertActionable).toBe(false);
      expect(result.supplyActionable).toBe(false);
    }
  });

  it('never flags a brand-new product (current-month projection, no closed baseline) as missing baseline', () => {
    // Only month-to-date data: no closed eligible month, but a projected tier from the current
    // month. Reversed philosophy — this is trailing-30 evidence, so it must NOT land in Data
    // Readiness / "missing baseline"; it flows to review (last closed period unknown) with a tier.
    const result = decideReplenishment(
      input({
        baselineState: 'unclassified',
        baselineTier: null,
        baselineConfidence: 'none',
        baselineEvidenceValid: true, // a current projection counts as evidence
        lastClosedMonthState: 'unclassified',
        lastClosedMonthTier: null,
        closedTierMovement: 'not_comparable',
        currentProjectionConfidence: 'early',
        currentProjectedState: 'ranked',
        currentProjectedTier: 'A',
        projectedTierMovement: 'not_comparable',
      }),
    );
    expect(result.primaryActionPane).not.toBe('dataReadiness');
    expect(result.primaryActionReasonCode).not.toBe('missing_or_invalid_baseline_evidence');
    expect(result).toMatchObject({
      primaryActionPane: 'performanceReview',
      primaryActionReasonCode: 'last_closed_period_unknown',
    });
  });

  it('never routes a velocity gap with a valid baseline to Data Readiness (reversed philosophy, D2)', () => {
    // A reorder-due estimate still lands in Supply Action with honest estimated provenance.
    expect(
      decideReplenishment(
        input({ inventoryDisposition: 'insufficient_velocity_evidence', reorderDueKind: 'estimated' }),
      ),
    ).toMatchObject({
      replenishmentEligibility: 'eligible',
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'estimated_velocity_reorder_due',
      newReplenishmentActionable: true,
      supplyActionable: true,
    });
    // Not reorder-due (plenty of stock) + a valid baseline ⇒ HEALTHY, not Data Readiness. A missing
    // rolling signal is not "missing evidence" — the baseline/ladder still supply the numbers.
    expect(
      decideReplenishment(input({ inventoryDisposition: 'insufficient_velocity_evidence', reorderDueKind: 'none' })),
    ).toMatchObject({
      replenishmentEligibility: 'eligible',
      primaryActionPane: 'healthyInventory',
      primaryActionReasonCode: 'sufficient_stock',
    });
    // Data Readiness now fires ONLY on true absence — an unclassified baseline (no eligible history).
    expect(
      decideReplenishment(
        input({
          inventoryDisposition: 'insufficient_velocity_evidence',
          reorderDueKind: 'none',
          baselineState: 'unclassified',
          baselineTier: null,
          baselineEvidenceValid: false,
        }),
      ),
    ).toMatchObject({
      replenishmentEligibility: 'blocked_insufficient_evidence',
      primaryActionPane: 'dataReadiness',
      primaryActionReasonCode: 'missing_or_invalid_baseline_evidence',
    });
  });

  it('keeps every outranking branch above estimated reorder-due membership', () => {
    expect(
      decideReplenishment(input({ inventoryDisposition: 'no_sell_through', reorderDueKind: 'estimated' })),
    ).toMatchObject({ primaryActionPane: 'stuckInventory', supplyActionable: false });
    expect(
      decideReplenishment(input({ inventoryDisposition: 'over_60_days_cover', reorderDueKind: 'estimated' })),
    ).toMatchObject({ primaryActionPane: 'excessInventory', supplyActionable: false });
    expect(decideReplenishment(input({ existingOrderStage: 'inbound', reorderDueKind: 'estimated' }))).toMatchObject({
      primaryActionPane: 'inboundMonitoring',
      existingOrderFollowUp: true,
      supplyActionable: false,
    });
    expect(decideReplenishment(input({ trustedZeroStock: true, reorderDueKind: 'estimated' }))).toMatchObject({
      primaryActionPane: 'zeroStock',
      primaryActionReasonCode: 'trusted_zero_stock',
      oosAlertActionable: true,
      supplyActionable: false,
    });
    // 065: baseline tier D is no longer an outranking branch (precedence 7 deleted). Recent tier
    // D still is, via the last closed month (precedence 9).
    expect(decideReplenishment(input({ lastClosedMonthTier: 'D', reorderDueKind: 'estimated' }))).toMatchObject({
      primaryActionPane: 'performanceReview',
      supplyActionable: false,
    });
  });

  describe('065 — recent-tier membership (two-month window)', () => {
    it('keeps a product whose recent window still ranks, in either month', () => {
      // Ranked now, silent last month — a recovering/new product stays a citizen.
      expect(
        decideReplenishment(
          input({
            lastClosedMonthState: 'no_movement',
            lastClosedMonthTier: null,
            closedTierMovement: 'not_comparable',
          }),
        ).primaryActionPane,
      ).not.toBe('untieredProducts');
      // Ranked last month, no current projection yet — still a citizen, and fully eligible.
      expect(
        decideReplenishment(
          input({
            currentProjectedState: 'unclassified',
            currentProjectedTier: null,
            currentProjectionConfidence: 'unavailable',
            projectedTierMovement: 'not_comparable',
          }),
        ),
      ).toMatchObject({ replenishmentEligibility: 'eligible', primaryActionPane: 'healthyInventory' });
    });

    it('exiles a phantom whose baseline still ranks A but whose recent window is silent', () => {
      // The phantom-exile proof: the strongest possible baseline cannot buy membership.
      const result = decideReplenishment(
        input({
          baselineState: 'ranked',
          baselineTier: 'A',
          baselineConfidence: 'full',
          lastClosedMonthState: 'no_movement',
          lastClosedMonthTier: null,
          closedTierMovement: 'not_comparable',
          currentProjectedState: 'no_movement',
          currentProjectedTier: null,
          projectedTierMovement: 'not_comparable',
        }),
      );

      expect(result).toMatchObject({
        decisionPrecedence: 2,
        replenishmentEligibility: 'not_eligible_no_recent_movement',
        primaryActionPane: 'untieredProducts',
        primaryActionReasonCode: 'no_recent_movement',
      });
    });

    it('outranks the stuck and excess dispositions so they hold only recently-ranked products', () => {
      for (const inventoryDisposition of ['no_sell_through', 'over_60_days_cover'] as const) {
        expect(
          decideReplenishment(
            input({
              inventoryDisposition,
              lastClosedMonthState: 'no_movement',
              lastClosedMonthTier: null,
              closedTierMovement: 'not_comparable',
              currentProjectedState: 'no_movement',
              currentProjectedTier: null,
              projectedTierMovement: 'not_comparable',
            }),
          ).primaryActionPane,
        ).toBe('untieredProducts');
      }
    });

    it('no longer exiles a baseline no-movement product that has a recent rank (precedence 6 deleted)', () => {
      // RED-PROOF: on the pre-065 ladder both of these returned untieredProducts /
      // baseline_no_movement at precedence 6.
      const stillRankingNow = decideReplenishment(input({ baselineState: 'no_movement', baselineTier: null }));
      expect(stillRankingNow.primaryActionPane).not.toBe('untieredProducts');
      expect(stillRankingNow).toMatchObject({
        decisionPrecedence: 14,
        replenishmentEligibility: 'eligible',
        primaryActionPane: 'healthyInventory',
      });

      // Same new-product citizenship, but last month was silent: it reviews on RECENT evidence
      // (precedence 10) rather than being exiled on baseline history.
      // 068-2: the current rank is stated as 'early' here — a TRUSTED one now bypasses precedence
      // 10 outright (see the 068-2 block below); the point of this case is only that baseline
      // history alone never exiles.
      expect(
        decideReplenishment(
          input({
            baselineState: 'no_movement',
            baselineTier: null,
            lastClosedMonthState: 'no_movement',
            lastClosedMonthTier: null,
            closedTierMovement: 'not_comparable',
            currentProjectionConfidence: 'early',
          }),
        ),
      ).toMatchObject({
        decisionPrecedence: 10,
        primaryActionPane: 'performanceReview',
        primaryActionReasonCode: 'last_closed_no_movement',
      });
    });

    it('no longer sends a baseline tier D product with a recent rank to review (precedence 7 deleted)', () => {
      // RED-PROOF: on the pre-065 ladder this returned performanceReview / baseline_tier_d at
      // precedence 7.
      const result = decideReplenishment(input({ baselineTier: 'D' }));

      expect(result.primaryActionReasonCode).not.toBe('baseline_tier_d');
      expect(result).toMatchObject({
        decisionPrecedence: 14,
        replenishmentEligibility: 'eligible',
        primaryActionPane: 'healthyInventory',
      });
    });

    it('waives the baseline-confidence review for a TRUSTED current rank (precedence 13 bypass)', () => {
      // BaselineConfidence has no 'partial' member; 'none' and 'low' are the thin-history values.
      for (const baselineConfidence of ['none', 'low', 'moderate'] as const) {
        expect(decideReplenishment(input({ baselineConfidence }))).toMatchObject({
          decisionPrecedence: 14,
          replenishmentEligibility: 'eligible',
          primaryActionPane: 'healthyInventory',
        });
      }
      // The bypass carries all the way to the far end of the ladder, not just to gate 14.
      expect(
        decideReplenishment(input({ baselineConfidence: 'none', currentProjectionGateMode: 'evidence_driven' })),
      ).toMatchObject({ decisionPrecedence: 19, replenishmentEligibility: 'eligible' });
    });

    it('requires trust for the bypass — an early or absent current rank still reviews', () => {
      expect(
        decideReplenishment(input({ baselineConfidence: 'none', currentProjectionConfidence: 'early' })),
      ).toMatchObject({
        decisionPrecedence: 13,
        replenishmentEligibility: 'review_insufficient_baseline_confidence',
        primaryActionPane: 'performanceReview',
      });
      // Trusted, but not currently RANKED (it survives on last month's rank) ⇒ no bypass.
      expect(
        decideReplenishment(
          input({
            baselineConfidence: 'low',
            currentProjectedState: 'no_movement',
            currentProjectedTier: null,
            projectedTierMovement: 'not_comparable',
          }),
        ),
      ).toMatchObject({ decisionPrecedence: 13, primaryActionPane: 'performanceReview' });
    });

    it('assigns the predicted redistribution categories across a synthetic population', () => {
      const population = {
        // Ranked six months ago, silent since ⇒ exiled by the recent window.
        phantomBaselineOnly: input({
          baselineState: 'ranked',
          baselineTier: 'A',
          lastClosedMonthState: 'no_movement',
          lastClosedMonthTier: null,
          closedTierMovement: 'not_comparable',
          currentProjectedState: 'no_movement',
          currentProjectedTier: null,
          projectedTierMovement: 'not_comparable',
        }),
        // Never ranked anywhere ⇒ exiled by the same gate, not by Data Readiness.
        twoDeadMonths: input({
          baselineState: 'no_movement',
          baselineTier: null,
          baselineConfidence: 'low',
          lastClosedMonthState: 'no_movement',
          lastClosedMonthTier: null,
          closedTierMovement: 'not_comparable',
          currentProjectedState: 'no_movement',
          currentProjectedTier: null,
          currentProjectionConfidence: 'unavailable',
          projectedTierMovement: 'not_comparable',
        }),
        // Brand-new seller: no closed history at all, trusted current rank. Admitted by the
        // recent window and NOT dumped in Data Readiness. 065 still parked it in review at
        // precedence 12; 068-2 bypasses 10/12/13 on the trusted rank, so it is a full citizen and
        // settles at 14 — healthy while it has stock.
        newSeller: input({
          baselineState: 'unclassified',
          baselineTier: null,
          baselineConfidence: 'none',
          lastClosedMonthState: 'unclassified',
          lastClosedMonthTier: null,
          closedTierMovement: 'not_comparable',
          currentProjectedState: 'ranked',
          currentProjectedTier: 'B',
          projectedTierMovement: 'not_comparable',
        }),
        // The case the 068-2 ruling was written for: the same first-month seller, reorder-due.
        // It must reach Supply Action rather than waiting for its first month to close.
        newSellerReorderDue: input({
          baselineState: 'unclassified',
          baselineTier: null,
          baselineConfidence: 'none',
          lastClosedMonthState: 'unclassified',
          lastClosedMonthTier: null,
          closedTierMovement: 'not_comparable',
          currentProjectedState: 'ranked',
          currentProjectedTier: 'B',
          projectedTierMovement: 'not_comparable',
          reorderDueKind: 'trusted',
        }),
        // Ranked last month, current projection not in yet ⇒ full citizen on the recent pair.
        lastClosedOnly: input({
          currentProjectedState: 'unclassified',
          currentProjectedTier: null,
          currentProjectionConfidence: 'unavailable',
          projectedTierMovement: 'not_comparable',
        }),
        // Ranked now and reorder-due ⇒ operational.
        currentRanked: input({ reorderDueKind: 'trusted' }),
      } as const;

      const panes = Object.fromEntries(
        Object.entries(population).map(([name, decisionInput]) => [
          name,
          decideReplenishment(decisionInput).primaryActionPane,
        ]),
      );

      expect(panes).toEqual({
        phantomBaselineOnly: 'untieredProducts',
        twoDeadMonths: 'untieredProducts',
        newSeller: 'healthyInventory',
        newSellerReorderDue: 'supplyAction',
        lastClosedOnly: 'healthyInventory',
        currentRanked: 'supplyAction',
      });
      expect(decideReplenishment(population.newSeller).primaryActionPane).not.toBe('dataReadiness');
    });
  });

  describe('068-2 — trusted first-month sellers promote to the operational panes', () => {
    // A first-month seller: no closed eligible month at all (baseline confidence 'none', last
    // closed period unknown), but the current month ranks on trusted evidence. Under 065 it sat
    // in Performance review until its first month closed; the user ruling is that a tiered,
    // profitable, moving product belongs in the operational panes — "especially if it's the new
    // one" — because a new product about to go out of stock must reach Supply Action.
    function firstMonthSeller(overrides: Partial<ReplenishmentDecisionInput> = {}): ReplenishmentDecisionInput {
      return input({
        baselineState: 'unclassified',
        baselineTier: null,
        baselineConfidence: 'none',
        lastClosedMonthState: 'unclassified',
        lastClosedMonthTier: null,
        closedTierMovement: 'not_comparable',
        currentProjectedState: 'ranked',
        currentProjectedTier: 'B',
        currentProjectionConfidence: 'trusted',
        projectedTierMovement: 'not_comparable',
        ...overrides,
      });
    }

    it('flows a trusted first-month seller past gates 10, 12 and 13 into the eligible panes', () => {
      // Reorder-due: the motivating case — Supply Action, actionable.
      expect(decideReplenishment(firstMonthSeller({ reorderDueKind: 'trusted' }))).toMatchObject({
        decisionPrecedence: 14,
        replenishmentEligibility: 'eligible',
        primaryActionPane: 'supplyAction',
        primaryActionReasonCode: 'trusted_reorder_due',
        newReplenishmentActionable: true,
        supplyActionable: true,
      });
      // Already out of stock: Zero-stock, with the OOS alert live.
      expect(decideReplenishment(firstMonthSeller({ trustedZeroStock: true }))).toMatchObject({
        replenishmentEligibility: 'eligible',
        primaryActionPane: 'zeroStock',
        primaryActionReasonCode: 'trusted_zero_stock',
        oosAlertActionable: true,
      });
      // Plenty of stock: healthy, not review.
      const healthy = decideReplenishment(firstMonthSeller());
      expect(healthy.primaryActionPane).not.toBe('performanceReview');
      expect(healthy).toMatchObject({
        replenishmentEligibility: 'eligible',
        primaryActionPane: 'healthyInventory',
        primaryActionReasonCode: 'sufficient_stock',
      });
      // The bypass carries to the far end of the ladder under the evidence-driven gate too.
      expect(decideReplenishment(firstMonthSeller({ currentProjectionGateMode: 'evidence_driven' }))).toMatchObject({
        decisionPrecedence: 19,
        replenishmentEligibility: 'eligible',
      });
    });

    it('flows a trusted seller whose last closed month showed no movement past gate 10', () => {
      // Existed last month and sold nothing; ranks this month on trusted evidence.
      const result = decideReplenishment(
        input({
          baselineConfidence: 'low',
          lastClosedMonthState: 'no_movement',
          lastClosedMonthTier: null,
          closedTierMovement: 'not_comparable',
          reorderDueKind: 'trusted',
        }),
      );

      expect(result.primaryActionReasonCode).not.toBe('last_closed_no_movement');
      expect(result).toMatchObject({
        decisionPrecedence: 14,
        replenishmentEligibility: 'eligible',
        primaryActionPane: 'supplyAction',
        supplyActionable: true,
      });
    });

    it('still reviews an EARLY current rank at gate 12 — the bypass requires trust', () => {
      // RED-PROOF for the width of the bypass: widening it to accept 'early' confidence breaks
      // this case. An early projection is not yet evidence of a real tier.
      expect(decideReplenishment(firstMonthSeller({ currentProjectionConfidence: 'early' }))).toMatchObject({
        decisionPrecedence: 12,
        replenishmentEligibility: 'review_closed_period_unknown',
        primaryActionPane: 'performanceReview',
        primaryActionReasonCode: 'last_closed_period_unknown',
      });
      // Same for the no-movement gate.
      expect(
        decideReplenishment(
          input({
            lastClosedMonthState: 'no_movement',
            lastClosedMonthTier: null,
            closedTierMovement: 'not_comparable',
            currentProjectionConfidence: 'early',
          }),
        ),
      ).toMatchObject({
        decisionPrecedence: 10,
        replenishmentEligibility: 'review_closed_no_movement',
        primaryActionPane: 'performanceReview',
      });
    });

    it('keeps D-rank products out of the promotion — 9 and 16 still block', () => {
      // Current-projected D, trusted, first month: blocked at 16 under the evidence-driven gate.
      expect(
        decideReplenishment(
          firstMonthSeller({ currentProjectedTier: 'D', currentProjectionGateMode: 'evidence_driven' }),
        ),
      ).toMatchObject({
        decisionPrecedence: 16,
        replenishmentEligibility: 'blocked_current_tier_d',
        primaryActionPane: 'performanceReview',
        primaryActionReasonCode: 'current_projected_tier_d',
      });
      // A last-closed D is outside this ruling's scope: gate 9 precedes the bypass entirely.
      expect(
        decideReplenishment(input({ lastClosedMonthTier: 'D', currentProjectedTier: 'B', reorderDueKind: 'trusted' })),
      ).toMatchObject({
        decisionPrecedence: 9,
        replenishmentEligibility: 'blocked_closed_tier_d',
        primaryActionPane: 'performanceReview',
        primaryActionReasonCode: 'last_closed_tier_d',
      });
    });
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
      'not_eligible_no_recent_movement',
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
                  for (const reorderDueKind of ['none', 'trusted', 'estimated'] as const) {
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
                        reorderDueKind,
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
    }
    expect(examined).toBe(96768);
  });
});
