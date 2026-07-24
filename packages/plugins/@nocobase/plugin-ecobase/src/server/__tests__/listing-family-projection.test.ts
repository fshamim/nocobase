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
  deriveListingReviewCategories,
  buildCorrectedGoldProjection,
  correctedFamilyActionProjectionDigest,
  correctedListingRowDigest,
  deriveCorrectedFamilyActionsFromListingRows,
  derivePersistedCorrectedCandidateEvidence,
  type CorrectedListingPerformanceInput,
  type CorrectedListingPerformanceRow,
  type FrozenFamilyDecisionInput,
} from '../../features/inventory-planning/server/listing-family-projection';
import { CORRECTED_INVENTORY_PLANNING_ROW_FIELDS } from '../../features/inventory-planning/server/gold-schema-contract';
import { decideReplenishment } from '../../features/inventory-planning/server/replenishment-decision';

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function decision(eligible: boolean) {
  return decideReplenishment({
    administrativelyExcluded: false,
    lifecycleDiscontinuedOrPaused: false,
    hasFrozenTarget: true,
    targetSelectionState: 'automatic',
    identityEvidenceValid: true,
    baselineEvidenceValid: true,
    inventoryDisposition: 'none',
    baselineState: 'ranked',
    baselineTier: eligible ? 'B' : 'D',
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
  });
}

function fixture() {
  const listings: CorrectedListingPerformanceInput[] = [];
  const families: FrozenFamilyDecisionInput[] = [];
  let companyProductIndex = 0;
  for (let familyIndex = 0; familyIndex < 1919; familyIndex += 1) {
    const familyKey = `family-${String(familyIndex).padStart(4, '0')}`;
    const twoMembers = familyIndex < 443 || familyIndex === 1636;
    const memberCount = twoMembers ? 2 : 1;
    const memberCompanyProductIds: string[] = [];
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      const companyProductId = `cp-${String(companyProductIndex).padStart(4, '0')}`;
      memberCompanyProductIds.push(companyProductId);
      const reviewRepresentativeCase = familyIndex === 1636;
      listings.push({
        companyProductId,
        companyProductFamilyId: familyKey,
        companyId: `company-${familyIndex % 4}`,
        amazonAccountId: `account-${familyIndex % 10}`,
        marketplace: 'Amazon.com',
        asin: `B${String(familyIndex).padStart(9, '0')}`,
        sku: reviewRepresentativeCase ? `SKU-${1 - memberIndex}` : `SKU-${memberIndex}`,
        baselineTier: familyIndex === 0 && memberIndex === 0 ? 'D' : 'B',
        baselineTierScore: familyIndex === 1 && memberIndex === 1 ? '1000.00000000' : '10.00000000',
        baselineState: 'ranked',
        baselineConfidence: 'full',
        inventoryDisposition: 'none',
        productCoverageDigest: sha256(`coverage:${companyProductId}`),
        replenishmentDecision: decision(!(familyIndex === 0 && memberIndex === 0)),
        calculationEvidence: { sourceCompanyProductId: companyProductId },
        recommendedOrderQty: memberIndex === 0 ? '25.00000000' : null,
      });
      companyProductIndex += 1;
    }
    const automatic = familyIndex < 1636;
    families.push({
      familyKey,
      companyProductFamilyId: familyKey,
      companyId: `company-${familyIndex % 4}`,
      amazonAccountId: `account-${familyIndex % 10}`,
      marketplace: 'Amazon.com',
      canonicalAsin: `B${String(familyIndex).padStart(9, '0')}`,
      targetSelectionState: automatic ? 'automatic' : 'review',
      targetCompanyProductId: automatic ? memberCompanyProductIds[0] : null,
      memberCompanyProductIds,
      targetSelectionEvidence: { frozenStep: 18, familyIndex },
    });
  }
  if (companyProductIndex !== 2363) throw new Error(`Fixture produced ${companyProductIndex} listings.`);
  return { listings, families };
}

const provenance = {
  runId: 'candidate-run-1',
  calculationDate: '2026-07-18',
  ruleVersion: 'individual_dynamic_6m_profit_trend_v2',
  algorithmContractVersion: 'individual_monthly_profit_performance_v2',
  currentProjectionGateMode: 'informational' as const,
  resolvedPlanningSettingsDigest: sha256('settings'),
  sourceCoverageDigest: sha256('coverage'),
  sourceInputDigest: sha256('source'),
  protectedSilverFingerprint: sha256('protected'),
  candidateInputDigest: sha256('candidate'),
  generatedAt: '2026-07-20T00:00:00.000Z',
};

describe('corrected listing and frozen-target family projection', () => {
  it('keeps exactly 2,363 independent listing rows and derives exactly 1,919 singular family actions', () => {
    const frozen = fixture();
    const protectedBefore = JSON.stringify(frozen.families);
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });

    expect(result.listingRows).toHaveLength(2363);
    expect(result.familyActions).toHaveLength(1919);
    expect(new Set(result.listingRows.map((row) => row.companyProductId))).toHaveLength(2363);
    expect(new Set(result.familyActions.map((action) => action.familyKey))).toHaveLength(1919);
    expect(result.runMetadata).toMatchObject({
      ruleVersion: provenance.ruleVersion,
      algorithmContractVersion: provenance.algorithmContractVersion,
      currentProjectionGateMode: 'informational',
      canonicalSerializerVersion: 'canonical_json_schema_normalized_bytewise_v2',
      listingRowDigestVersion: 'listing_performance_digest_v2',
      familyActionProjectionDigestVersion: 'family_action_digest_v2',
      resolvedPlanningSettingsDigest: provenance.resolvedPlanningSettingsDigest,
      sourceCoverageDigest: provenance.sourceCoverageDigest,
      sourceInputDigest: provenance.sourceInputDigest,
      protectedSilverFingerprint: provenance.protectedSilverFingerprint,
      candidateInputDigest: provenance.candidateInputDigest,
      listingRowCount: 2363,
      familyActionProjectionCount: 1919,
      protectedDomainMutationCount: 0,
    });
    expect(result.runMetadata.listingRowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.runMetadata.familyActionProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(frozen.families)).toBe(protectedBefore);
  });

  it('derives identical listing and family evidence from PostgreSQL-hydrated date-only rows', () => {
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...fixture(),
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const persistedRows = result.listingRows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([field, value]) => [
          field,
          typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : value,
        ]),
      ),
    ) as unknown as CorrectedListingPerformanceRow[];

    const persisted = derivePersistedCorrectedCandidateEvidence(persistedRows, {
      runId: provenance.runId,
      generatedAt: provenance.generatedAt,
    });

    expect(persisted).toMatchObject({
      listingRowCount: 2363,
      listingRowDigest: result.runMetadata.listingRowDigest,
      familyActionProjectionCount: 1919,
      familyActionProjectionDigest: result.runMetadata.familyActionProjectionDigest,
    });

    const observedAt = '2026-07-21T14:15:16.789Z';
    persistedRows[0].supplierOrderAuthorityAsOf = new Date(observedAt) as unknown as string;
    const timestampEvidence = derivePersistedCorrectedCandidateEvidence(persistedRows, {
      runId: provenance.runId,
      generatedAt: provenance.generatedAt,
    });
    expect(timestampEvidence.listingRows[0].supplierOrderAuthorityAsOf).toBe(observedAt);
  });

  it('preserves frozen automatic targets, blocks an ineligible target, and exposes alternates as evidence only', () => {
    const frozen = fixture();
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const action = result.familyActions.find((item) => item.familyKey === 'family-0000');

    expect(action).toMatchObject({
      targetSelectionState: 'frozen_target',
      targetCompanyProductId: 'cp-0000',
      actionSourceCompanyProductId: 'cp-0000',
      replenishmentEligibility: 'blocked_baseline_tier_d',
      primaryActionPane: 'performanceReview',
      alternateRecommendationCompanyProductIds: ['cp-0001'],
      recommendedOrderQty: '25.00000000',
      listing: expect.objectContaining({ companyProductId: 'cp-0000', baselineTier: 'D' }),
      linkedMemberEvidence: [
        { companyProductId: 'cp-0000', listingReviewCategories: ['tier_d'] },
        { companyProductId: 'cp-0001', listingReviewCategories: [] },
      ],
    });
    expect(action?.targetCompanyProductId).not.toBe('cp-0001');
  });

  it('keeps all review targets null and chooses only a deterministic display representative', () => {
    const frozen = fixture();
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const reviewActions = result.familyActions.filter((item) => item.targetSelectionState === 'review_required');
    const representativeCase = result.familyActions.find((item) => item.familyKey === 'family-1636');

    expect(reviewActions).toHaveLength(283);
    expect(reviewActions.every((item) => item.targetCompanyProductId === null)).toBe(true);
    expect(reviewActions.every((item) => item.actionSourceCompanyProductId === null)).toBe(true);
    expect(representativeCase).toMatchObject({
      representativeCompanyProductId: 'cp-2080',
      targetCompanyProductId: null,
      actionSourceCompanyProductId: null,
      replenishmentEligibility: 'review_missing_target',
      primaryActionPane: 'dataReadiness',
      primaryActionReasonCode: 'frozen_family_target_review',
      recommendedOrderQty: null,
      listing: null,
    });
  });

  it('never aggregates one member profit into the frozen target listing or family action', () => {
    const frozen = fixture();
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const members = result.listingRows.filter((row) => row.companyProductFamilyId === 'family-0001');
    const action = result.familyActions.find((item) => item.familyKey === 'family-0001');

    expect(members.map((row) => row.baselineTierScore)).toEqual(['10.00000000', '1000.00000000']);
    expect(action?.listing).toMatchObject({ baselineTierScore: '10.00000000' });
    expect(action?.listing).not.toMatchObject({ baselineTierScore: '1010.00000000' });
  });

  it('is byte-stable under input reordering and binds every corrected provenance field', () => {
    const frozen = fixture();
    const first = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const replay = buildCorrectedGoldProjection({
      ...provenance,
      listings: [...frozen.listings].reverse(),
      families: [...frozen.families].reverse().map((family) => ({
        ...family,
        memberCompanyProductIds: [...family.memberCompanyProductIds].reverse(),
      })),
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });

    expect(replay.runMetadata.listingRowDigest).toBe(first.runMetadata.listingRowDigest);
    expect(replay.runMetadata.familyActionProjectionDigest).toBe(first.runMetadata.familyActionProjectionDigest);
    expect(replay.listingRows).toEqual(first.listingRows);
    expect(replay.familyActions).toEqual(first.familyActions);
    expect(
      deriveCorrectedFamilyActionsFromListingRows(first.listingRows, {
        runId: provenance.runId,
        generatedAt: provenance.generatedAt,
      }),
    ).toEqual(first.familyActions);
  });

  it('keeps listing and family digests stable after persistence fills every contract field with null', () => {
    const frozen = fixture();
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const persistedRows = result.listingRows.map((row, index) => {
      const values = row as Record<string, unknown>;
      return {
        id: `persisted-${index}`,
        naturalKey: row.naturalKey,
        refreshRunId: row.refreshRunId,
        createdAt: '2026-07-20T00:00:01.000Z',
        updatedAt: '2026-07-20T00:00:01.000Z',
        lastRefreshedAt: '2026-07-20T00:00:01.000Z',
        ...Object.fromEntries(CORRECTED_INVENTORY_PLANNING_ROW_FIELDS.map((field) => [field, values[field] ?? null])),
      } as unknown as CorrectedListingPerformanceRow;
    });
    const sparseRows = persistedRows.map(
      (row) =>
        Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as CorrectedListingPerformanceRow,
    );
    const persistedActions = deriveCorrectedFamilyActionsFromListingRows(persistedRows, {
      runId: provenance.runId,
      generatedAt: provenance.generatedAt,
    });
    const sparseActions = deriveCorrectedFamilyActionsFromListingRows(sparseRows, {
      runId: provenance.runId,
      generatedAt: provenance.generatedAt,
    });

    expect(correctedListingRowDigest(persistedRows)).toBe(result.runMetadata.listingRowDigest);
    expect(correctedListingRowDigest(sparseRows)).toBe(result.runMetadata.listingRowDigest);
    expect(correctedFamilyActionProjectionDigest(persistedActions)).toBe(
      result.runMetadata.familyActionProjectionDigest,
    );
    expect(correctedFamilyActionProjectionDigest(sparseActions)).toBe(result.runMetadata.familyActionProjectionDigest);
  });

  it('normalizes only proven ORM coercions before listing and family digesting', () => {
    const frozen = fixture();
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const prePersistence = result.listingRows.map((row, index) =>
      index === 0
        ? {
            ...row,
            daysOfCover: '12.5',
            pipelineStock: '2',
            reservedStock: '1',
            salesVelocity: '3.25',
            recommendedOrderQty: 25,
          }
        : row,
    );
    const postPersistence = prePersistence.map((row, index) =>
      index === 0
        ? {
            ...row,
            daysOfCover: 12.5,
            pipelineStock: 2,
            reservedStock: 1,
            salesVelocity: 3.25,
            recommendedOrderQty: '25.00000000',
          }
        : row,
    );
    const options = { runId: provenance.runId, generatedAt: provenance.generatedAt };

    expect(correctedListingRowDigest(prePersistence)).toBe(correctedListingRowDigest(postPersistence));
    expect(
      correctedFamilyActionProjectionDigest(deriveCorrectedFamilyActionsFromListingRows(prePersistence, options)),
    ).toBe(
      correctedFamilyActionProjectionDigest(deriveCorrectedFamilyActionsFromListingRows(postPersistence, options)),
    );
  });

  it('uses bytewise ordering for adversarial punctuation and case regardless of host locale behavior', () => {
    const frozen = fixture();
    const result = buildCorrectedGoldProjection({
      ...provenance,
      ...frozen,
      expectedListingCount: 2363,
      expectedFamilyActionCount: 1919,
    });
    const orderValues = ['A-', 'a.', 'A0', 'a_', 'Aa', 'a~'];
    const rows = result.listingRows.slice(0, orderValues.length).map((row, index) => ({
      ...row,
      companyId: 'ordering-company',
      amazonAccountId: 'ordering-account',
      marketplace: index % 2 ? 'AMAZON.COM' : 'amazon.com',
      asin: `B${String(index).padStart(9, '0')}`,
      sku: orderValues[index],
      companyProductId: `ordering-listing-${index}`,
      naturalKey: `ordering-listing-${index}`,
    }));
    const actions = result.familyActions.slice(0, orderValues.length).map((action, index) => ({
      ...action,
      naturalKey: orderValues[index],
      familyKey: orderValues[index],
    }));
    const listingDigest = correctedListingRowDigest(rows);
    const familyDigest = correctedFamilyActionProjectionDigest(actions);
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare');
    Object.defineProperty(String.prototype, 'localeCompare', {
      configurable: true,
      writable: true,
      value() {
        return 0;
      },
    });
    try {
      expect(correctedListingRowDigest(rows)).toBe(listingDigest);
      expect(correctedFamilyActionProjectionDigest(actions)).toBe(familyDigest);
    } finally {
      if (descriptor) Object.defineProperty(String.prototype, 'localeCompare', descriptor);
    }
  });

  it('fails closed on count, membership, duplicate identity, review-target, and frozen-target drift', () => {
    const frozen = fixture();
    expect(() =>
      buildCorrectedGoldProjection({
        ...provenance,
        ...frozen,
        listings: frozen.listings.slice(1),
        expectedListingCount: 2363,
        expectedFamilyActionCount: 1919,
      }),
    ).toThrow('expected 2363 listing rows');
    expect(() =>
      buildCorrectedGoldProjection({
        ...provenance,
        ...frozen,
        listings: [...frozen.listings, frozen.listings[0]],
        expectedListingCount: 2364,
        expectedFamilyActionCount: 1919,
      }),
    ).toThrow('duplicate companyProductId');
    expect(() =>
      buildCorrectedGoldProjection({
        ...provenance,
        ...frozen,
        families: frozen.families.map((family, index) =>
          index === 0 ? { ...family, targetCompanyProductId: 'cp-9999' } : family,
        ),
        expectedListingCount: 2363,
        expectedFamilyActionCount: 1919,
      }),
    ).toThrow('frozen target is not a member');
    expect(() =>
      buildCorrectedGoldProjection({
        ...provenance,
        ...frozen,
        families: frozen.families.map((family) =>
          family.familyKey === 'family-1636' ? { ...family, targetCompanyProductId: 'cp-2078' } : family,
        ),
        expectedListingCount: 2363,
        expectedFamilyActionCount: 1919,
      }),
    ).toThrow('review family must keep targetCompanyProductId null');
  });

  it('tolerates the discontinuedPaused pane value without crashing or misfiling (task 002 old-page tolerance)', () => {
    // The legacy Inventory Planning page filters rows by strict pane-name
    // equality across its 11 panes; a discontinuedPaused row simply matches
    // none of them (invisible on the legacy page — acceptable; crash is not).
    const categories = deriveListingReviewCategories({
      primaryActionPane: 'discontinuedPaused',
      baselineState: 'no_movement',
      replenishmentEligibility: 'excluded_discontinued',
    });
    expect(categories).not.toContain('data_readiness');
    expect(Array.isArray(categories)).toBe(true);
  });
});
