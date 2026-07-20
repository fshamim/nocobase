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

import { describe, expect, it, vi } from 'vitest';
import { EcobaseIndependentGoldReferenceVerifier } from '../../features/inventory-planning/server/independent-gold-reference-verifier';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseInventoryPlanningActions } from '../resource-actions';

type Row = Record<string, unknown>;
type Query = { filter?: Row; filterByTk?: string | number; sort?: string[]; limit?: number };

function matchesFilter(row: Row, filter: Row = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const operator = expected as Row;
      if ('$in' in operator) return (operator.$in as unknown[]).includes(row[key]);
      if ('$ne' in operator) return row[key] !== operator.$ne;
    }
    return row[key] === expected;
  });
}

class MemoryRepository implements EcobaseRepository {
  constructor(readonly rows: Row[] = []) {}

  async find(params: Query = {}) {
    let result = this.rows.filter(
      (row) =>
        (params.filterByTk === undefined || row.id === params.filterByTk) && matchesFilter(row, params.filter ?? {}),
    );
    for (const sort of [...(params.sort ?? [])].reverse()) {
      const descending = sort.startsWith('-');
      const key = descending ? sort.slice(1) : sort;
      result = [...result].sort((left, right) => {
        const comparison = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
        return descending ? -comparison : comparison;
      });
    }
    return result.slice(0, params.limit ?? result.length).map((row) => ({ ...row }));
  }

  async findOne(params: Query = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async count(params: Query = {}) {
    return (await this.find(params)).length;
  }

  async create({ values }: { values: Row }) {
    const row = { ...values };
    this.rows.push(row);
    return { ...row };
  }

  async update({ filter, filterByTk, values }: { filter?: Row; filterByTk?: string | number; values: Row }) {
    const targets = this.rows.filter(
      (row) => (filterByTk === undefined || row.id === filterByTk) && matchesFilter(row, filter ?? {}),
    );
    if (!targets.length) throw new Error('Corrected-candidate memory update found no row.');
    targets.forEach((row) => Object.assign(row, values));
    return { ...targets[0] };
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private readonly repositories = new Map<string, MemoryRepository>();
  readonly goldRows = this.repository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);

  getRepository(name: string) {
    return this.repository(name);
  }

  seed(name: string, rows: Row[]) {
    this.repository(name).rows.push(...rows.map((row) => ({ ...row })));
  }

  rows(name: string) {
    return this.repository(name).rows;
  }

  private repository(name: string) {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryRepository();
      this.repositories.set(name, repository);
    }
    return repository;
  }
}

function monthStarts() {
  return ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];
}

function fixture() {
  const db = new MemoryDatabase();
  const products: Row[] = [];
  const companyProducts: Row[] = [];
  const families: Row[] = [];
  let listingIndex = 0;
  for (let familyIndex = 0; familyIndex < 1919; familyIndex += 1) {
    const familyId = `family-${String(familyIndex).padStart(4, '0')}`;
    const asin = `ASIN-${String(familyIndex).padStart(4, '0')}`;
    const memberCount = familyIndex < 444 ? 2 : 1;
    const memberIds: string[] = [];
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      const suffix = String(listingIndex).padStart(4, '0');
      const companyProductId = `cp-${suffix}`;
      const productId = `product-${suffix}`;
      memberIds.push(companyProductId);
      products.push({ id: productId, asin, sku: `SKU-${suffix}`, title: `Corrected candidate ${suffix}` });
      companyProducts.push({
        id: companyProductId,
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        productId,
        companyProductFamilyId: familyId,
        lifecycleStatus: 'active',
      });
      listingIndex += 1;
    }
    families.push({
      id: familyId,
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      marketplace: 'Amazon.com',
      canonicalAsin: asin,
      replenishmentTargetCompanyProductId: memberIds[0],
      targetSelectionEvidenceJson: { source: 'frozen-family' },
    });
  }
  if (listingIndex !== 2363 || families.length !== 1919) throw new Error('Locked cardinality fixture drifted.');

  db.seed(ECOBASE_COLLECTIONS.silverCompanies, [{ id: 'company-1', name: 'ACME' }]);
  db.seed(ECOBASE_COLLECTIONS.silverAmazonAccounts, [
    { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
  ]);
  db.seed(ECOBASE_COLLECTIONS.sourceConnections, [
    { id: 'source-1', companyId: 'company-1', sourceType: 'sellerboard_api', active: true },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverProducts, products);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, families);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProducts, companyProducts);
  db.seed(ECOBASE_COLLECTIONS.silverInventorySnapshots, [
    {
      id: 'inventory-1',
      companyProductId: 'cp-0000',
      sourceConnectionId: 'source-1',
      snapshotDate: '2026-07-16',
      sellableStock: 10,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      awdStock: 0,
    },
  ]);
  db.seed(ECOBASE_COLLECTIONS.importRuns, [
    { id: 'history-run', adapterName: 'sellerboard-history-csv', status: 'success', normalizedCount: 7 },
  ]);
  db.seed(
    ECOBASE_COLLECTIONS.silverListingDailyFacts,
    [...monthStarts(), '2026-07-16'].map((snapshotDate, index) => ({
      id: `fact-${index + 1}`,
      companyProductId: 'cp-0000',
      snapshotDate,
      units: 10,
      netProfit: 300,
      profit: 300,
    })),
  );
  db.seed(ECOBASE_COLLECTIONS.sourceCoverageIntervals, [
    {
      id: 'coverage-1',
      sourceConnectionId: 'source-1',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      marketplace: 'Amazon.com',
      metricSet: 'sellerboard_units_net_profit_v1',
      coveredStartDate: '2026-01-01',
      coveredEndDate: '2026-07-16',
      continuousCoverage: true,
      sourceAsOfDate: '2026-07-16',
      sourceVersion: '2026-07-16',
      importRunId: 'history-run',
      coverageStatus: 'active',
    },
  ]);
  db.seed(
    ECOBASE_COLLECTIONS.sourceCoverageMemberships,
    [...monthStarts(), '2026-07-01'].map((monthStart, index) => ({
      id: `membership-${index + 1}`,
      coverageIntervalId: 'coverage-1',
      companyProductId: 'cp-0000',
      monthStart,
      membershipStatus: 'in_scope',
      metricReconciliationStatus: 'complete',
      normalizedFactLinkCount: 1,
    })),
  );
  return db;
}

function publicRefreshInvocation(
  db: MemoryDatabase,
  idempotencyKey = 'corrected-candidate-public-seam',
  overrides: Row = {},
) {
  const action = createEcobaseInventoryPlanningActions().refreshReadModel;
  const next = vi.fn();
  const ctx: Row = {
    db,
    state: { currentRoles: ['admin'], currentUser: { id: 'admin-1' } },
    action: {
      params: {
        values: {
          calculationDate: '2026-07-16',
          idempotencyKey,
          confirmation: 'REBUILD GOLD',
          ...overrides,
        },
      },
    },
    throw: (status: number, message: string) => {
      throw new Error(`${status}:${message}`);
    },
  };
  return { action, ctx, next };
}

async function refreshThroughPublicAction(db: MemoryDatabase, idempotencyKey = 'corrected-candidate-public-seam') {
  const { action, ctx, next } = publicRefreshInvocation(db, idempotencyKey);
  await action(ctx as never, next);
  expect(next).toHaveBeenCalledOnce();
  return (ctx.body as { data: Row }).data;
}

describe('corrected candidate public refresh seam', () => {
  it('rejects company-scoped and limited rebuilds before any lifecycle or Gold write', async () => {
    for (const [key, overrides] of [
      ['scoped', { company: 'ACME' }],
      ['limited', { limit: 100 }],
    ] as const) {
      const db = new MemoryDatabase();
      const { action, ctx, next } = publicRefreshInvocation(db, key, overrides);

      await expect(action(ctx as never, next)).rejects.toMatchObject({
        code: 'ECOBASE_CORRECTED_CANDIDATE_CARDINALITY_MISMATCH',
      });
      expect(next).not.toHaveBeenCalled();
      expect(db.goldRows.rows).toHaveLength(0);
      expect(db.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)).toHaveLength(0);
    }
  });

  it('fails closed with zero writes when the independent listing or family catalog cardinality drifts', async () => {
    const missingListing = fixture();
    missingListing.rows(ECOBASE_COLLECTIONS.silverCompanyProducts).pop();
    const missingListingInvocation = publicRefreshInvocation(missingListing, 'missing-listing');
    await expect(
      missingListingInvocation.action(missingListingInvocation.ctx as never, missingListingInvocation.next),
    ).rejects.toMatchObject({ code: 'ECOBASE_CORRECTED_CANDIDATE_CARDINALITY_MISMATCH' });
    expect(missingListing.goldRows.rows).toHaveLength(0);
    expect(missingListing.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)).toHaveLength(0);

    const missingFamily = fixture();
    const lastListing = missingFamily.rows(ECOBASE_COLLECTIONS.silverCompanyProducts).at(-1);
    if (!lastListing) throw new Error('Family-cardinality fixture listing is missing.');
    lastListing.companyProductFamilyId = 'family-0000';
    const missingFamilyInvocation = publicRefreshInvocation(missingFamily, 'missing-family');
    await expect(
      missingFamilyInvocation.action(missingFamilyInvocation.ctx as never, missingFamilyInvocation.next),
    ).rejects.toMatchObject({ code: 'ECOBASE_CORRECTED_CANDIDATE_CARDINALITY_MISMATCH' });
    expect(missingFamily.goldRows.rows).toHaveLength(0);
    expect(missingFamily.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)).toHaveLength(0);
  });

  it('materializes only the corrected unpublished listing/family contract through the admin action', async () => {
    const db = fixture();

    const result = await refreshThroughPublicAction(db);

    expect(result).toMatchObject({
      reused: false,
      published: false,
      rowCount: 2363,
      run: {
        status: 'materialized',
        ruleVersion: 'individual_dynamic_6m_profit_trend_v1',
        algorithmContractVersion: 'individual_monthly_profit_performance_v1',
        currentProjectionGateMode: 'informational',
        listingRowCount: 2363,
        familyActionProjectionCount: 1919,
      },
    });
    const run = result.run as Row;
    for (const field of [
      'candidateInputDigest',
      'resolvedPlanningSettingsDigest',
      'sourceCoverageDigest',
      'sourceInputsDigest',
      'protectedSilverFingerprint',
      'listingRowDigest',
      'familyActionProjectionDigest',
    ]) {
      expect(run[field], field).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(db.goldRows.rows).toHaveLength(2363);
    expect(db.goldRows.rows[0]).toMatchObject({
      companyProductId: 'cp-0000',
      baselineTier: 'A',
      baselineConfidence: 'full',
      currentProjectionGateMode: 'informational',
      refreshRunId: run.id,
    });
    expect(db.goldRows.rows[0]).not.toHaveProperty('tier');
    expect(db.goldRows.rows[0]).not.toHaveProperty('planningProductId');
    await expect(new EcobaseIndependentGoldReferenceVerifier(db).verify(String(run.id))).resolves.toMatchObject({
      valid: true,
      listingRowCount: 2363,
      familyActionProjectionCount: 1919,
      listingRowDigest: run.listingRowDigest,
      familyActionProjectionDigest: run.familyActionProjectionDigest,
    });
  });

  it('ignores poisoned legacy tier, action, quantity, and target calculations at the public seam', async () => {
    const cleanDb = fixture();
    const clean = await refreshThroughPublicAction(cleanDb, 'clean-operational-snapshot');
    const cleanRun = clean.run as Row;

    type CalculateRowsSeam = {
      calculateRows(query?: Row): Promise<Row[]>;
    };
    const prototype = EcobaseInventoryPlanningService.prototype as unknown as CalculateRowsSeam;
    const originalCalculateRows = prototype.calculateRows;
    const calculateRowsSpy = vi.spyOn(prototype, 'calculateRows').mockImplementation(async function (query) {
      const rows = await originalCalculateRows.call(this, query);
      return rows.map((row) => ({
        ...row,
        tier: 'D',
        tierScore: -999999,
        actionStatus: 'overdue',
        suggestedReorderQty: 999999,
        replenishmentTargetCompanyProductId: 'poison-target',
        familyTargetCompanyProductId: 'poison-target',
      }));
    });
    try {
      const poisonedDb = fixture();
      Object.assign(poisonedDb.rows(ECOBASE_COLLECTIONS.silverCompanyProducts)[0], {
        tier: 'D',
        tierScore: -999999,
        actionStatus: 'overdue',
        suggestedReorderQty: 999999,
        replenishmentTargetCompanyProductId: 'poison-target',
      });
      Object.assign(poisonedDb.rows(ECOBASE_COLLECTIONS.silverInventorySnapshots)[0], {
        tier: 'D',
        actionStatus: 'overdue',
        suggestedReorderQty: 999999,
      });
      const poisoned = await refreshThroughPublicAction(poisonedDb, 'poisoned-operational-snapshot');
      const poisonedRun = poisoned.run as Row;
      const first = poisonedDb.goldRows.rows[0];

      expect(calculateRowsSpy).not.toHaveBeenCalled();
      expect(poisonedRun.sourceInputsDigest).toBe(cleanRun.sourceInputsDigest);
      expect(first).toMatchObject({
        companyProductId: 'cp-0000',
        baselineTier: 'A',
        familyTargetCompanyProductId: 'cp-0000',
      });
      expect(first.actionStatus).not.toBe('overdue');
      expect(first.recommendedOrderQty).not.toBe(999999);
      expect(first).not.toHaveProperty('tier');
      expect(first).not.toHaveProperty('suggestedReorderQty');
      expect(first).not.toHaveProperty('replenishmentTargetCompanyProductId');
    } finally {
      calculateRowsSpy.mockRestore();
    }
  });

  it('reuses an identical request and rejects same-key changed source input without another Gold write', async () => {
    const db = fixture();
    const first = await refreshThroughPublicAction(db, 'candidate-replay');
    const replay = await refreshThroughPublicAction(db, 'candidate-replay');

    expect(replay).toMatchObject({
      reused: true,
      published: false,
      run: {
        id: (first.run as Row).id,
        candidateInputDigest: (first.run as Row).candidateInputDigest,
        listingRowDigest: (first.run as Row).listingRowDigest,
        familyActionProjectionDigest: (first.run as Row).familyActionProjectionDigest,
      },
    });
    expect(db.goldRows.rows).toHaveLength(2363);

    const changedFact = db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts)[0];
    changedFact.netProfit = 301;
    changedFact.profit = 301;
    const changed = publicRefreshInvocation(db, 'candidate-replay');
    await expect(changed.action(changed.ctx as never, changed.next)).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_IDEMPOTENCY_CONFLICT',
    });
    expect(db.goldRows.rows).toHaveLength(2363);
  });

  it('keeps a sparse baseline month unknown and suppresses new replenishment action', async () => {
    const db = fixture();
    db.rows(ECOBASE_COLLECTIONS.sourceCoverageMemberships).splice(1, 1);

    await refreshThroughPublicAction(db, 'sparse-baseline');

    expect(db.goldRows.rows[0]).toMatchObject({
      baselineEligibleMonthCount: 5,
      baselineConfidence: 'moderate',
      replenishmentEligibility: 'review_insufficient_baseline_confidence',
      newReplenishmentActionable: false,
      supplyActionable: false,
      oosAlertActionable: false,
    });
    expect(db.goldRows.rows[0].monthlyPerformanceEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monthStart: '2026-02-01',
          eligible: false,
          reasonCode: 'product_scope_unknown',
          monthlyUnits: null,
          monthlyProfit: null,
        }),
      ]),
    );
  });

  it('fails a metric-normalization mismatch closed instead of treating it as zero', async () => {
    const db = fixture();
    const membership = db
      .rows(ECOBASE_COLLECTIONS.sourceCoverageMemberships)
      .find((row) => row.monthStart === '2026-03-01');
    if (!membership) throw new Error('Metric-mismatch fixture membership is missing.');
    membership.metricReconciliationStatus = 'incomplete';

    await refreshThroughPublicAction(db, 'metric-mismatch');

    expect(db.goldRows.rows[0]).toMatchObject({
      baselineEligibleMonthCount: 5,
      baselineConfidence: 'moderate',
      newReplenishmentActionable: false,
    });
    expect(db.goldRows.rows[0].monthlyPerformanceEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monthStart: '2026-03-01',
          eligible: false,
          reasonCode: 'metric_normalization_mismatch',
          monthlyUnits: null,
          monthlyProfit: null,
        }),
      ]),
    );
  });

  it('keeps a proven current decline informational and does not let it hard-block an eligible baseline', async () => {
    const db = fixture();
    const currentFact = db
      .rows(ECOBASE_COLLECTIONS.silverListingDailyFacts)
      .find((row) => row.snapshotDate === '2026-07-16');
    if (!currentFact) throw new Error('Informational-current fixture fact is missing.');
    currentFact.netProfit = -1000;
    currentFact.profit = -1000;

    await refreshThroughPublicAction(db, 'informational-current');

    expect(db.goldRows.rows[0]).toMatchObject({
      currentProjectionGateMode: 'informational',
      baselineTier: 'A',
      currentProjectedTier: 'D',
      projectedTierMovement: 'declined',
      replenishmentEligibility: 'eligible',
      primaryActionPane: 'supplyAction',
      newReplenishmentActionable: true,
    });
  });

  it('preserves trusted zero movement as unranked and non-actionable', async () => {
    const db = fixture();
    for (const fact of db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts)) {
      fact.units = 0;
      fact.netProfit = 0;
      fact.profit = 0;
    }

    await refreshThroughPublicAction(db, 'trusted-zero-movement');

    expect(db.goldRows.rows[0]).toMatchObject({
      baselineEligibleMonthCount: 6,
      baselineConfidence: 'full',
      baselineState: 'no_movement',
      baselineTier: null,
      replenishmentEligibility: 'blocked_stuck_inventory',
      primaryActionPane: 'stuckInventory',
      newReplenishmentActionable: false,
    });
  });
});
