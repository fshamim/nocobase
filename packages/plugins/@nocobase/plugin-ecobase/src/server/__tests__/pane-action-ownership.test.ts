/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCorrectedGoldProjection,
  filterListingPerformanceReview,
  type CorrectedListingPerformanceInput,
  type FrozenFamilyDecisionInput,
} from '../../features/inventory-dashboard/server/engine/listing-family-projection';
import {
  decideReplenishment,
  type ReplenishmentDecisionInput,
} from '../../features/inventory-dashboard/server/engine/replenishment-decision';

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function decision(overrides: Partial<ReplenishmentDecisionInput> = {}) {
  return decideReplenishment({
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
  });
}

function listing(params: {
  id: string;
  familyId: string;
  sku: string;
  decision?: ReturnType<typeof decision>;
  fields?: Record<string, unknown>;
}): CorrectedListingPerformanceInput {
  return {
    companyProductId: params.id,
    companyProductFamilyId: params.familyId,
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    marketplace: 'Amazon.com',
    asin: `ASIN-${params.familyId}`,
    sku: params.sku,
    baselineTier: 'B',
    baselineTierScore: '150.00000000',
    baselineState: 'ranked',
    baselineConfidence: 'full',
    inventoryDisposition: 'none',
    productCoverageDigest: sha(`coverage:${params.id}`),
    replenishmentDecision: params.decision ?? decision(),
    ...params.fields,
  };
}

function family(
  familyKey: string,
  members: string[],
  targetCompanyProductId: string | null,
): FrozenFamilyDecisionInput {
  return {
    familyKey,
    companyProductFamilyId: familyKey,
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    marketplace: 'Amazon.com',
    canonicalAsin: `ASIN-${familyKey}`,
    targetSelectionState: targetCompanyProductId ? 'automatic' : 'review',
    targetCompanyProductId,
    memberCompanyProductIds: members,
    targetSelectionEvidence: { frozenStep: 18 },
  };
}

function projection() {
  const listings = [
    listing({ id: 'cp-1', familyId: 'family-1', sku: 'A' }),
    listing({
      id: 'cp-2',
      familyId: 'family-1',
      sku: 'B',
      decision: decision({ identityEvidenceValid: false }),
      fields: {
        baselineTier: 'D',
        baselineState: 'no_movement',
        closedTierMovement: 'declined',
        projectedTierMovement: 'declined',
        inventoryDisposition: 'no_sell_through',
      },
    }),
    listing({
      id: 'cp-3',
      familyId: 'family-2',
      sku: 'A',
      decision: decision({ inventoryDisposition: 'over_60_days_cover', existingOrderStage: 'inbound' }),
      fields: { inventoryDisposition: 'over_60_days_cover' },
    }),
    listing({ id: 'cp-4', familyId: 'family-2', sku: 'B' }),
    listing({ id: 'cp-5', familyId: 'family-3', sku: 'B' }),
    listing({ id: 'cp-6', familyId: 'family-3', sku: 'A' }),
  ];
  const families = [
    family('family-1', ['cp-1', 'cp-2'], 'cp-1'),
    family('family-2', ['cp-3', 'cp-4'], 'cp-3'),
    family('family-3', ['cp-5', 'cp-6'], null),
  ];
  return buildCorrectedGoldProjection({
    runId: 'run-1',
    calculationDate: '2026-07-18',
    ruleVersion: 'individual_dynamic_6m_profit_trend_v5',
    algorithmContractVersion: 'individual_monthly_profit_performance_v2',
    currentProjectionGateMode: 'informational',
    resolvedPlanningSettingsDigest: sha('settings'),
    sourceCoverageDigest: sha('coverage'),
    sourceInputDigest: sha('source'),
    protectedSilverFingerprint: sha('protected'),
    candidateInputDigest: sha('candidate'),
    generatedAt: '2026-07-20T00:00:00.000Z',
    listings,
    families,
    expectedListingCount: 6,
    expectedFamilyActionCount: 3,
  });
}

describe('exclusive pane ownership and non-action listing review', () => {
  it('assigns deterministic sorted review categories to every affected listing independent of target ownership', () => {
    const result = projection();
    const affectedMember = result.listingRows.find((row) => row.companyProductId === 'cp-2');
    const excessTarget = result.listingRows.find((row) => row.companyProductId === 'cp-3');

    expect(affectedMember?.listingReviewCategories).toEqual([
      'closed_decline',
      'data_readiness',
      'no_movement',
      'projected_decline',
      'stuck',
      'tier_d',
    ]);
    expect(excessTarget?.listingReviewCategories).toEqual(['excess']);
    expect(result.familyActions.find((action) => action.familyKey === 'family-1')).toMatchObject({
      targetCompanyProductId: 'cp-1',
      primaryActionPane: 'healthyInventory',
      replenishmentEligibility: 'eligible',
    });
  });

  it('keeps exactly one family action/pane and nested order follow-up without blocked action leakage', () => {
    const result = projection();
    const actions = result.familyActions;
    const excess = actions.find((action) => action.familyKey === 'family-2');

    expect(actions).toHaveLength(3);
    expect(new Set(actions.map((action) => action.familyKey))).toHaveLength(3);
    expect(actions.every((action) => typeof action.primaryActionPane === 'string')).toBe(true);
    expect(excess).toMatchObject({
      targetCompanyProductId: 'cp-3',
      primaryActionPane: 'excessInventory',
      replenishmentEligibility: 'blocked_excess_inventory',
      existingOrderFollowUp: true,
      existingOrderFollowUpAction: 'follow_up_existing_order',
      newReplenishmentActionable: false,
      oosAlertActionable: false,
      supplyActionable: false,
    });
    expect(excess?.primaryActionPane).not.toBe('inboundMonitoring');
    expect(excess?.primaryActionPane).not.toBe('supplyAction');
    expect(excess?.primaryActionPane).not.toBe('zeroStock');
  });

  it('filters listing evidence without creating, duplicating, or rerouting an action', () => {
    const result = projection();
    const review = filterListingPerformanceReview(result.listingRows, ['stuck', 'tier_d']);

    expect(review).toMatchObject({
      scope: 'listing_performance_review',
      selectedCategories: ['stuck', 'tier_d'],
      listingCount: 1,
      actionCount: 0,
    });
    expect(review.rows.map((row) => row.companyProductId)).toEqual(['cp-2']);
    expect(result.familyActions).toHaveLength(3);
    expect(result.familyActions.find((action) => action.familyKey === 'family-1')?.primaryActionPane).toBe(
      'healthyInventory',
    );
  });

  it('rejects unknown listing review categories rather than silently broadening the filter', () => {
    const result = projection();
    expect(() => filterListingPerformanceReview(result.listingRows, ['stuck', 'unknown' as never])).toThrow(
      'unsupported listing review category',
    );
  });
});
