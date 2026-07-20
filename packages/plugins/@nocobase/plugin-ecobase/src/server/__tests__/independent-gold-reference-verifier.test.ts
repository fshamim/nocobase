/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { buildCorrectedGoldProjection } from '../../features/inventory-planning/server/listing-family-projection';
import { EcobaseGoldRefreshRunService } from '../../features/inventory-planning/server/gold-refresh-run-service';
import {
  EcobaseIndependentGoldReferenceVerifier,
  referenceProtectedSilverFingerprint,
} from '../../features/inventory-planning/server/independent-gold-reference-verifier';

class MemoryRepository implements EcobaseRepository {
  readonly rows: Record<string, unknown>[] = [];

  async find(params: { filter?: Record<string, unknown>; sort?: string[]; limit?: number } = {}) {
    let rows = this.rows.filter((row) =>
      Object.entries(params.filter ?? {}).every(([key, value]) => row[key] === value),
    );
    const [sort] = params.sort ?? [];
    if (sort) {
      const descending = sort.startsWith('-');
      const key = descending ? sort.slice(1) : sort;
      rows = [...rows].sort((left, right) => {
        const result = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
        return descending ? -result : result;
      });
    }
    return rows.slice(0, params.limit ?? rows.length);
  }

  async findOne(params: { filter?: Record<string, unknown>; filterByTk?: string | number } = {}) {
    if (params.filterByTk !== undefined) return this.rows.find((row) => row.id === params.filterByTk) ?? null;
    return (await this.find({ filter: params.filter, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    const row = { ...values };
    this.rows.push(row);
    return row;
  }

  async update({ filterByTk, values }: { filterByTk?: string | number; values: Record<string, unknown> }) {
    const row = this.rows.find((candidate) => candidate.id === filterByTk);
    if (!row) throw new Error(`MemoryRepository update failed: ${String(filterByTk)} was not found.`);
    Object.assign(row, values);
    return row;
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor() {
    for (const name of Object.values(ECOBASE_COLLECTIONS)) this.repositories.set(name, new MemoryRepository());
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`MemoryDatabase failed: ${name} was not registered.`);
    return repository;
  }
}

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function fixed(value: number) {
  return value.toFixed(8);
}

const MONTHS = [
  ['2026-01-01', '2026-01-31', 300],
  ['2026-02-01', '2026-02-28', 200],
  ['2026-03-01', '2026-03-31', 100],
  ['2026-04-01', '2026-04-30', 0],
  ['2026-05-01', '2026-05-31', -10],
  ['2026-06-01', '2026-06-30', 10],
] as const;

async function fixture() {
  const db = new MemoryDatabase();
  const companyProductId = '11111111-1111-4111-8111-111111111111';
  const familyId = '22222222-2222-4222-8222-222222222222';
  const companyId = '33333333-3333-4333-8333-333333333333';
  const accountId = '44444444-4444-4444-8444-444444444444';
  const intervalId = '55555555-5555-4555-8555-555555555555';
  const facts = db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts);
  for (const [monthStart, , profit] of MONTHS) {
    await facts.create({
      values: {
        id: `fact:${monthStart}`,
        companyProductId,
        snapshotDate: monthStart,
        units: 10,
        profit,
      },
    });
  }
  await db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).create({
    values: {
      id: intervalId,
      companyId,
      amazonAccountId: accountId,
      marketplace: 'Amazon.com',
      metricSet: 'sellerboard_units_net_profit_v1',
      coveredStartDate: '2026-01-01',
      coveredEndDate: '2026-06-30',
      continuousCoverage: true,
      coverageStatus: 'active',
    },
  });
  for (const [monthStart] of MONTHS) {
    await db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).create({
      values: {
        id: `membership:${monthStart}`,
        coverageIntervalId: intervalId,
        companyProductId,
        monthStart,
        membershipStatus: 'in_scope',
        metricReconciliationStatus: 'complete',
        normalizedFactLinkCount: 1,
      },
    });
  }
  const protectedSilverFingerprint = await referenceProtectedSilverFingerprint(db);
  const monthlyPerformanceEvidence = MONTHS.map(([monthStart, monthEnd, profit]) => ({
    monthStart,
    monthEnd,
    eligible: true,
    reasonCode: 'eligible_complete_month',
    sourceFactCount: 1,
    monthlyUnits: fixed(10),
    monthlyProfit: fixed(profit),
    monthlyProfitPerUnit: fixed(profit / 10),
    monthlyTierScore: fixed(profit),
  }));
  const result = buildCorrectedGoldProjection({
    runId: 'reference-run',
    calculationDate: '2026-07-18',
    ruleVersion: 'individual_dynamic_6m_profit_trend_v1',
    algorithmContractVersion: 'individual_monthly_profit_performance_v1',
    currentProjectionGateMode: 'informational',
    resolvedPlanningSettingsDigest: sha('settings'),
    sourceCoverageDigest: sha('coverage'),
    sourceInputDigest: sha('source'),
    protectedSilverFingerprint,
    candidateInputDigest: sha('candidate'),
    generatedAt: '2026-07-20T00:00:00.000Z',
    expectedListingCount: 1,
    expectedFamilyActionCount: 1,
    listings: [
      {
        planningProductId: companyProductId,
        company: 'ACME',
        companyProductId,
        companyProductFamilyId: familyId,
        companyId,
        amazonAccountId: accountId,
        marketplace: 'Amazon.com',
        asin: 'B000000001',
        sku: 'REFERENCE-SKU',
        baselineTier: 'B',
        baselineTierScore: fixed(100),
        baselineState: 'ranked',
        baselineConfidence: 'full',
        baselineEligibleMonthCount: 6,
        baselineWindowStartDate: '2026-01-01',
        baselineWindowEndDate: '2026-06-30',
        baselineTotalUnits: fixed(60),
        baselineTotalProfit: fixed(600),
        baselineWeightedProfitPerUnit: fixed(10),
        averageMonthlyUnits: fixed(10),
        averageMonthlyProfit: fixed(100),
        bestMonthlyUnits: fixed(10),
        bestUnitsMonth: '2026-01-01',
        worstMonthlyUnits: fixed(10),
        worstUnitsMonth: '2026-01-01',
        bestMonthlyProfit: fixed(300),
        bestProfitMonth: '2026-01-01',
        worstMonthlyProfit: fixed(-10),
        worstProfitMonth: '2026-05-01',
        lastClosedMonth: '2026-06-01',
        lastClosedMonthUnits: fixed(10),
        lastClosedMonthProfit: fixed(10),
        monthlyPerformanceEvidence,
        inventoryDisposition: 'none',
        inventoryDispositionReasonCode: 'trusted_positive_velocity',
        productCoverageDigest: sha('product-coverage'),
        replenishmentDecision: {
          replenishmentEligibility: 'eligible',
          replenishmentBlockReasonCode: 'eligible_informational_projection',
          primaryActionPane: 'supplyAction',
          primaryActionReasonCode: 'trusted_reorder_due',
          newReplenishmentActionable: true,
          oosAlertActionable: true,
          supplyActionable: true,
          existingOrderFollowUp: false,
          existingOrderFollowUpAction: 'none',
        },
        recommendedOrderQty: fixed(25),
      },
    ],
    families: [
      {
        familyKey: familyId,
        companyProductFamilyId: familyId,
        companyId,
        amazonAccountId: accountId,
        marketplace: 'Amazon.com',
        canonicalAsin: 'B000000001',
        targetSelectionState: 'automatic',
        targetCompanyProductId: companyProductId,
        memberCompanyProductIds: [companyProductId],
        targetSelectionEvidence: { frozenStep: 18 },
      },
    ],
  });
  await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).create({
    values: {
      id: 'reference-run',
      status: 'materialized',
      calculationDate: '2026-07-18',
      materializedAt: '2026-07-20T00:00:00.000Z',
      rowCount: 1,
      ...result.runMetadata,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
    values: { id: '66666666-6666-4666-8666-666666666666', ...result.listingRows[0] },
  });
  return { db, facts };
}

describe('independent Gold reference verifier', () => {
  it('recalculates corrected listing formulas, coverage, family actions, and digests from persisted evidence', async () => {
    const { db } = await fixture();

    await expect(new EcobaseIndependentGoldReferenceVerifier(db).verify('reference-run')).resolves.toMatchObject({
      valid: true,
      verifierVersion: 'independent_gold_reference_v1',
      contractMode: 'corrected',
      listingRowCount: 1,
      familyActionProjectionCount: 1,
      formulaVerifiedListingCount: 1,
      coverageVerifiedMonthCount: 6,
      protectedSilverFingerprintMatched: true,
    });
  });

  it('fails closed when persisted source facts drift after candidate materialization', async () => {
    const { db, facts } = await fixture();
    await facts.update({ filterByTk: 'fact:2026-03-01', values: { profit: 101 } });

    await expect(new EcobaseIndependentGoldReferenceVerifier(db).verify('reference-run')).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_INDEPENDENT_VERIFICATION_FAILED',
      details: {
        mismatchCodeHistogram: expect.objectContaining({ MONTHLY_PROFIT_MISMATCH: 1 }),
      },
    });
  });

  it('reports deterministic capped mismatch diagnostics without exposing the full mismatch set', async () => {
    const { db, facts } = await fixture();
    await facts.update({ filterByTk: 'fact:2026-03-01', values: { profit: 101 } });

    const error = await new EcobaseIndependentGoldReferenceVerifier(db).verify('reference-run').then(
      () => undefined,
      (reason) => reason as { message: string; details: Record<string, unknown> },
    );
    if (!error) throw new Error('Independent verifier diagnostic fixture unexpectedly passed.');
    const histogram = error.details.mismatchCodeHistogram as Record<string, number>;
    const samples = error.details.mismatchSamples as Array<{ code: string; message: string }>;

    expect(histogram).toMatchObject({ MONTHLY_PROFIT_MISMATCH: 1 });
    expect(Object.keys(histogram)).toEqual([...Object.keys(histogram)].sort());
    expect(samples.length).toBeGreaterThan(0);
    expect(samples).toHaveLength(Math.min(3, Object.keys(histogram).length));
    expect(samples.every((sample) => /^[A-Z0-9_]+$/.test(sample.code))).toBe(true);
    expect(
      samples.every(
        (sample) =>
          sample.message.length <= 160 &&
          [...sample.message].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127),
      ),
    ).toBe(true);
    expect(error.details).not.toHaveProperty('mismatches');
    expect(error.message).toContain('histogram=');
    expect(error.message).toContain('samples=');
    expect(error.message.length).toBeLessThanOrEqual(2000);
  });

  it('detects action leakage independently of the persisted family-action digest', async () => {
    const { db } = await fixture();
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).update({
      filterByTk: '66666666-6666-4666-8666-666666666666',
      values: { baselineConfidence: 'moderate' },
    });

    await expect(new EcobaseIndependentGoldReferenceVerifier(db).verify('reference-run')).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_INDEPENDENT_VERIFICATION_FAILED',
      details: {
        mismatchCodeHistogram: expect.objectContaining({ ACTION_LEAK: 1 }),
      },
    });
  });

  it('blocks the materialized-to-verified lifecycle transition when reference evidence drifts', async () => {
    const { db, facts } = await fixture();
    await facts.update({ filterByTk: 'fact:2026-03-01', values: { profit: 101 } });

    await expect(new EcobaseGoldRefreshRunService(db).verify('reference-run')).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_INDEPENDENT_VERIFICATION_FAILED',
    });
    const run = await db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)
      .findOne({ filterByTk: 'reference-run' });
    expect(run).toMatchObject({ status: 'materialized' });
    expect(run).not.toHaveProperty('independentVerificationJson');
  });

  it('has no production calculator, projector, or decision-engine imports', () => {
    const implementation = readFileSync(
      join(
        process.cwd(),
        'packages/plugins/@nocobase/plugin-ecobase/src/features/inventory-planning/server/independent-gold-reference-verifier.ts',
      ),
      'utf8',
    );
    for (const forbidden of [
      './monthly-performance',
      './inventory-disposition',
      './replenishment-decision',
      './listing-family-projection',
      './inventory-planning-service',
      'calculateMonthlyPerformance',
      'deriveCorrectedFamilyActionsFromListingRows',
      'decideReplenishment',
    ]) {
      expect(implementation).not.toContain(forbidden);
    }
  });
});
