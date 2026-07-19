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
  LEGACY_STEP19_GOLD_DIGEST_CONTRACT,
  legacyStep19GoldProjectionSql,
  projectLegacyStep19GoldRow,
} from '../../features/inventory-planning/server/legacy-gold-digest-contract';
import goldInventoryPlanningAccessAudits from '../collections/gold-inventory-planning-access-audits';
import goldInventoryPlanningRefreshRuns from '../collections/gold-inventory-planning-refresh-runs';
import goldInventoryPlanningRows from '../collections/gold-inventory-planning-rows';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import planningSettings from '../collections/planning-settings';
import sourceCoverageIntervals from '../collections/source-coverage-intervals';
import sourceCoverageMemberships from '../collections/source-coverage-memberships';
import { LEGACY_STEP19_GOLD_CANDIDATE_MANIFEST } from './fixtures/legacy-step19-gold-candidate-manifest';

interface FieldOptions {
  name: string;
  type: string;
  allowNull?: boolean;
  defaultValue?: unknown;
  precision?: number;
  scale?: number;
  unique?: boolean;
  index?: boolean;
  uiSchema?: { enum?: Array<{ value: string }> };
  target?: string;
  foreignKey?: string;
}

interface CollectionOptions {
  name: string;
  fields?: FieldOptions[];
  indexes?: Array<{ unique?: boolean; fields: string[] }>;
}

function options(value: unknown) {
  return value as CollectionOptions;
}

function field(collection: unknown, name: string) {
  const match = options(collection).fields?.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Expected ${options(collection).name} to define ${name}.`);
  return match;
}

const RUN_FIELDS = [
  'ruleVersion',
  'algorithmContractVersion',
  'canonicalSerializerVersion',
  'candidateInputDigestVersion',
  'sourceCoverageDigestVersion',
  'listingRowDigestVersion',
  'familyActionProjectionDigestVersion',
  'resolvedPlanningSettingsJson',
  'resolvedPlanningSettingsDigest',
  'currentProjectionGateMode',
  'protectedSilverFingerprint',
  'sourceCoverageDigest',
  'sourceInputsJson',
  'sourceInputsDigest',
  'candidateInputDigest',
  'listingRowCount',
  'listingRowDigest',
  'familyActionProjectionCount',
  'familyActionProjectionDigest',
  'productionVerificationJson',
  'productionVerificationDigest',
  'independentVerificationJson',
  'independentVerificationDigest',
  'materializedAt',
  'verifiedAt',
  'rejectedAt',
  'supersededAt',
  'retiredAt',
  'terminalReasonCode',
  'terminalReasonJson',
  'publicationPayloadDigest',
] as const;

const GOLD_DECIMAL_FIELDS = [
  'baselineTotalUnits',
  'baselineTotalProfit',
  'baselineWeightedProfitPerUnit',
  'averageMonthlyUnits',
  'averageMonthlyProfit',
  'baselineTierScore',
  'bestMonthlyUnits',
  'bestMonthlyProfit',
  'worstMonthlyUnits',
  'worstMonthlyProfit',
  'lastClosedMonthUnits',
  'lastClosedMonthProfit',
  'lastClosedMonthTierScore',
  'currentMonthUnits',
  'currentMonthProfit',
  'projectedMonthlyUnits',
  'projectedMonthlyProfit',
  'currentProjectedTierScore',
  'expectedAverageUnitsMtd',
  'expectedBestUnitsMtd',
  'expectedWorstUnitsMtd',
  'expectedAverageProfitMtd',
  'expectedBestProfitMtd',
  'expectedWorstProfitMtd',
  'rollingUnits30',
  'recommendedOrderQty',
] as const;

const GOLD_DATE_FIELDS = [
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
] as const;

const GOLD_JSON_FIELDS = [
  'monthlyPerformanceEvidence',
  'baselineReasonCodes',
  'lastClosedMonthReasonCodes',
  'currentProjectionReasonCodes',
  'trendReasonCodes',
  'paceEvidence',
  'listingReviewCategories',
  'calculationEvidence',
] as const;

const GOLD_BOOLEAN_FIELDS = [
  'newReplenishmentActionable',
  'oosAlertActionable',
  'supplyActionable',
  'existingOrderFollowUp',
  'isFrozenFamilyTarget',
] as const;

const GOLD_INTEGER_FIELDS = ['baselineEligibleMonthCount', 'currentCoveredDays'] as const;
const GOLD_UUID_FIELDS = ['companyId', 'amazonAccountId', 'familyTargetCompanyProductId'] as const;
const GOLD_STRING_FIELDS = [
  'marketplace',
  'ruleVersion',
  'algorithmContractVersion',
  'resolvedPlanningSettingsDigest',
  'productCoverageDigest',
  'baselineConfidence',
  'baselineTier',
  'baselineState',
  'lastClosedMonthTier',
  'lastClosedMonthState',
  'currentProjectedTier',
  'currentProjectedState',
  'currentProjectionConfidence',
  'closedTierMovement',
  'projectedTierMovement',
  'quantityPaceStatus',
  'profitPaceStatus',
  'aggregatePaceStatus',
  'paceCause',
  'rollingVelocityEvidenceStatus',
  'inventoryDisposition',
  'inventoryDispositionReasonCode',
  'replenishmentEligibility',
  'replenishmentBlockReasonCode',
  'existingOrderFollowUpAction',
  'primaryActionPane',
  'primaryActionReasonCode',
] as const;

const ALL_NEW_GOLD_FIELDS = [
  ...GOLD_DECIMAL_FIELDS,
  ...GOLD_DATE_FIELDS,
  ...GOLD_JSON_FIELDS,
  ...GOLD_BOOLEAN_FIELDS,
  ...GOLD_INTEGER_FIELDS,
  ...GOLD_UUID_FIELDS,
  ...GOLD_STRING_FIELDS,
] as const;

describe('tiering-detour additive schema', () => {
  it('adds the complete run lifecycle and digest contract without backfilling legacy runs', () => {
    const statusValues = field(goldInventoryPlanningRefreshRuns, 'status').uiSchema?.enum?.map((item) => item.value);
    expect(statusValues).toEqual([
      'requested',
      'running',
      'materialized',
      'verified',
      'published',
      'failed',
      'superseded',
      'rejected',
      'retired',
      'succeeded',
    ]);
    for (const name of RUN_FIELDS) {
      expect(field(goldInventoryPlanningRefreshRuns, name)).toMatchObject({ name });
      expect(field(goldInventoryPlanningRefreshRuns, name).allowNull).not.toBe(false);
      expect(field(goldInventoryPlanningRefreshRuns, name).defaultValue).toBeUndefined();
    }
    expect(field(goldInventoryPlanningRefreshRuns, 'candidateInputDigest')).toMatchObject({
      type: 'string',
      index: true,
    });
  });

  it('defines source coverage, membership reconciliation, and access audit collections', () => {
    expect(options(sourceCoverageIntervals).name).toBe(ECOBASE_COLLECTIONS.sourceCoverageIntervals);
    expect(options(sourceCoverageMemberships).name).toBe(ECOBASE_COLLECTIONS.sourceCoverageMemberships);
    expect(options(goldInventoryPlanningAccessAudits).name).toBe(ECOBASE_COLLECTIONS.goldInventoryPlanningAccessAudits);

    for (const name of [
      'naturalKey',
      'sourceConnectionId',
      'companyId',
      'amazonAccountId',
      'marketplace',
      'metricSet',
      'coveredStartDate',
      'coveredEndDate',
      'continuousCoverage',
      'sourceAsOfDate',
      'sourceVersion',
      'importRunId',
      'inputDigest',
      'scopeDigest',
      'productScopeEvidenceVersion',
      'coverageStatus',
      'supersedesCoverageIntervalId',
      'evidenceJson',
    ]) {
      expect(field(sourceCoverageIntervals, name)).toMatchObject({ name });
    }
    expect(field(sourceCoverageIntervals, 'naturalKey')).toMatchObject({ type: 'string', unique: true });
    expect(options(sourceCoverageIntervals).indexes).toContainEqual({
      unique: false,
      fields: ['sourceConnectionId', 'companyId', 'amazonAccountId', 'marketplace', 'metricSet', 'coverageStatus'],
    });

    for (const name of [
      'naturalKey',
      'coverageIntervalId',
      'companyProductId',
      'monthStart',
      'membershipStatus',
      'scopeEvidenceKinds',
      'scopeEvidenceDigest',
      'sourceMetricRowCount',
      'normalizedFactLinkCount',
      'metricReconciliationStatus',
      'metricEvidenceDigest',
    ]) {
      expect(field(sourceCoverageMemberships, name)).toMatchObject({ name });
    }
    expect(options(sourceCoverageMemberships).indexes).toContainEqual({
      unique: true,
      fields: ['coverageIntervalId', 'companyProductId', 'monthStart'],
    });

    for (const name of [
      'occurredAt',
      'actorUserId',
      'runId',
      'purpose',
      'outcome',
      'reasonCode',
      'requestId',
      'metadataJson',
    ]) {
      expect(field(goldInventoryPlanningAccessAudits, name)).toMatchObject({ name });
    }
  });

  it('adds projection settings with explicit upgrade defaults', () => {
    expect(field(planningSettings, 'minimumProjectionCoveredDays')).toMatchObject({
      type: 'integer',
      allowNull: false,
      defaultValue: 14,
    });
    expect(field(planningSettings, 'paceTolerancePercent')).toMatchObject({
      type: 'decimal',
      precision: 30,
      scale: 8,
      allowNull: false,
      defaultValue: 0,
    });
    expect(field(planningSettings, 'projectionPolicyVersion')).toMatchObject({
      type: 'string',
      allowNull: false,
      defaultValue: 'evidence_driven_v1',
    });
    expect(field(planningSettings, 'currentProjectionGateMode')).toMatchObject({
      type: 'string',
      allowNull: false,
      defaultValue: 'informational',
    });
  });

  it('adds every corrected Gold field as nullable and uses decimal(30,8) for calculated values', () => {
    expect(new Set(ALL_NEW_GOLD_FIELDS).size).toBe(83);
    for (const name of ALL_NEW_GOLD_FIELDS) {
      const definition = field(goldInventoryPlanningRows, name);
      expect(definition.allowNull).not.toBe(false);
      expect(definition.defaultValue).toBeUndefined();
    }
    for (const name of GOLD_DECIMAL_FIELDS) {
      expect(field(goldInventoryPlanningRows, name)).toMatchObject({ type: 'decimal', precision: 30, scale: 8 });
    }
    for (const name of GOLD_DATE_FIELDS) expect(field(goldInventoryPlanningRows, name).type).toBe('dateOnly');
    for (const name of GOLD_JSON_FIELDS) expect(field(goldInventoryPlanningRows, name).type).toBe('jsonb');
    for (const name of GOLD_BOOLEAN_FIELDS) expect(field(goldInventoryPlanningRows, name).type).toBe('boolean');
    for (const name of GOLD_INTEGER_FIELDS) expect(field(goldInventoryPlanningRows, name).type).toBe('integer');
    for (const name of GOLD_UUID_FIELDS) expect(field(goldInventoryPlanningRows, name).type).toBe('uuid');
    for (const name of GOLD_STRING_FIELDS) expect(field(goldInventoryPlanningRows, name).type).toBe('string');
  });

  it('keeps the exact 2,363-row Step 19 upgrade projection stable after additive null columns', () => {
    expect(LEGACY_STEP19_GOLD_DIGEST_CONTRACT).toEqual(LEGACY_STEP19_GOLD_CANDIDATE_MANIFEST);
    expect(LEGACY_STEP19_GOLD_DIGEST_CONTRACT.fields).toHaveLength(194);

    const legacySchemaFields = options(goldInventoryPlanningRows)
      .fields!.map((definition) => definition.foreignKey ?? definition.name)
      .filter((name) => !ALL_NEW_GOLD_FIELDS.includes(name as (typeof ALL_NEW_GOLD_FIELDS)[number]))
      .filter((name) => name !== 'lastRefreshedAt')
      .sort();
    expect(legacySchemaFields).toEqual([...LEGACY_STEP19_GOLD_DIGEST_CONTRACT.fields]);

    const legacyRow = Object.fromEntries(
      LEGACY_STEP19_GOLD_DIGEST_CONTRACT.fields.map((name, index) => [name, index % 7 === 0 ? null : `${name}:value`]),
    );
    const upgradedRow = {
      ...legacyRow,
      ...Object.fromEntries(ALL_NEW_GOLD_FIELDS.map((name) => [name, null])),
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      lastRefreshedAt: '2026-07-19T00:00:00.000Z',
    };

    expect(projectLegacyStep19GoldRow(upgradedRow)).toEqual(legacyRow);
    expect(legacyStep19GoldProjectionSql('legacy_row')).toContain('jsonb_each(to_jsonb(legacy_row))');
    expect(() => legacyStep19GoldProjectionSql('legacy row')).toThrow(
      'EcoBase legacy Gold digest projection rejected invalid SQL row alias "legacy row".',
    );
  });
});
