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
import { EcobaseGoldRefreshRunService } from '../../features/inventory-planning/server/gold-refresh-run-service';
import { OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS } from '../../features/inventory-planning/server/gold-schema-contract';
import { EcobaseIndependentGoldReferenceVerifier } from '../../features/inventory-planning/server/independent-gold-reference-verifier';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseInventoryPlanningActions } from '../resource-actions';
import { EcobasePlanningSettingsService } from '../services/planning-settings-service';

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
  idempotencyKey: string | null = 'corrected-candidate-public-seam',
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
          ...(idempotencyKey ? { idempotencyKey } : {}),
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

async function refreshThroughPublicAction(
  db: MemoryDatabase,
  idempotencyKey: string | null = 'corrected-candidate-public-seam',
) {
  const { action, ctx, next } = publicRefreshInvocation(db, idempotencyKey);
  await action(ctx as never, next);
  expect(next).toHaveBeenCalledOnce();
  return (ctx.body as { data: Row }).data;
}

async function readThroughPublicAction(
  db: MemoryDatabase,
  actionName: 'workspace' | 'commandCenter' | 'digestPreview' | 'listingPerformanceReview',
  values: Row = {},
) {
  const action = createEcobaseInventoryPlanningActions()[actionName];
  const next = vi.fn(async () => undefined);
  const ctx: Row = {
    db,
    action: { params: { values } },
    body: undefined,
    throw(status: number, message: string) {
      throw new Error(`HTTP ${status}: ${message}`);
    },
  };
  await action(ctx as never, next);
  expect(next).toHaveBeenCalledOnce();
  return (ctx.body as { data: Row }).data;
}

function exactNames(value: unknown, names = new Set<string>()) {
  if (typeof value === 'string') names.add(value);
  if (Array.isArray(value)) value.forEach((item) => exactNames(item, names));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      names.add(key);
      exactNames(nested, names);
    }
  }
  return names;
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

  it('derives and reuses the mandated idempotency key when the admin action omits it', async () => {
    const db = fixture();

    const first = await refreshThroughPublicAction(db, null);
    const firstRun = first.run as Row;
    expect(first).toMatchObject({ reused: false, published: false });
    expect(firstRun.idempotencyKey).toBe(`inventory-planning:${firstRun.candidateInputDigest}`);

    const replay = await refreshThroughPublicAction(db, null);
    expect(replay).toMatchObject({
      reused: true,
      published: false,
      run: {
        id: firstRun.id,
        idempotencyKey: firstRun.idempotencyKey,
        candidateInputDigest: firstRun.candidateInputDigest,
        listingRowDigest: firstRun.listingRowDigest,
        familyActionProjectionDigest: firstRun.familyActionProjectionDigest,
      },
    });
    expect(db.goldRows.rows).toHaveLength(2363);
    expect(db.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)).toHaveLength(1);
  });

  it('materializes only the corrected unpublished listing/family contract through the admin action', async () => {
    const db = fixture();
    await new EcobasePlanningSettingsService(db).saveSettings({ targetCoverDays: 60 });

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
      targetCoverDays: 60,
      recommendedOrderQty: 10,
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

  it('applies a configured purchased-pipeline status to corrected public open-order coverage', async () => {
    const db = fixture();
    await new EcobasePlanningSettingsService(db).saveSettings({
      supplierOrderPurchasedPipelineStatuses: ['paid', 'Supplier Paid Wire'],
    });
    db.seed(ECOBASE_COLLECTIONS.silverSuppliers, [
      { id: 'supplier-custom-status', companyId: 'company-1', displayName: 'Custom Status Supplier' },
    ]);
    db.seed(ECOBASE_COLLECTIONS.silverOrders, [
      {
        id: 'order-custom-status',
        companyId: 'company-1',
        supplierId: 'supplier-custom-status',
        orderRef: 'CUSTOM-STATUS-1',
        orderDate: '2026-07-10',
        canonicalStatus: 'supplier_paid_wire',
        lifecycleStatus: 'supplier_paid_wire',
        operationalStatus: 'supplier_preparing',
        workflowStage: 'in_prep',
      },
    ]);
    db.seed(ECOBASE_COLLECTIONS.silverOrderLines, [
      {
        id: 'line-custom-status',
        orderId: 'order-custom-status',
        companyProductId: 'cp-0000',
        orderedQty: 20,
        confirmedQty: 0,
        productMappingStatus: 'resolved',
        mappingScope: 'exact_member',
      },
    ]);

    const materialized = await refreshThroughPublicAction(db, 'custom-purchased-status');
    const runId = String((materialized.run as Row).id);
    const lifecycle = new EcobaseGoldRefreshRunService(db);
    await lifecycle.verify(runId);
    await lifecycle.publish(runId);
    const workspace = await readThroughPublicAction(db, 'workspace');
    const row = workspace.rows.find((candidate) => candidate.companyProductId === 'cp-0000');

    expect(row).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      supplierOrderStatus: 'supplier_paid_wire',
      supplierOrderOpenQty: 20,
      existingOrderFollowUp: true,
      newReplenishmentActionable: false,
      recommendedOrderQty: null,
    });
  });

  it('ignores poisoned legacy tier, action, quantity, and target calculations at the public seam', async () => {
    const cleanDb = fixture();
    const clean = await refreshThroughPublicAction(cleanDb, 'clean-operational-snapshot');
    const cleanRun = clean.run as Row;

    expect(EcobaseInventoryPlanningService.prototype).not.toHaveProperty('calculateRows');
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

  it('rejects a non-informational gate-mode override without changing the materialized candidate', async () => {
    const db = fixture();
    const materialized = await refreshThroughPublicAction(db, 'gate-mode-locked');
    const run = materialized.run as Row;
    const invocation = publicRefreshInvocation(db, 'gate-mode-locked', {
      currentProjectionGateMode: 'evidence_driven',
    });

    await expect(invocation.action(invocation.ctx as never, invocation.next)).rejects.toMatchObject({
      status: 400,
      code: 'ECOBASE_CORRECTED_CANDIDATE_GATE_MODE_LOCKED',
      details: {
        requestedGateMode: 'evidence_driven',
        requiredGateMode: 'informational',
      },
    });
    expect(invocation.next).not.toHaveBeenCalled();
    expect(db.goldRows.rows).toHaveLength(2363);
    expect(db.goldRows.rows.every((row) => row.refreshRunId === run.id)).toBe(true);
    expect(db.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)).toEqual([
      expect.objectContaining({
        id: run.id,
        status: 'materialized',
        candidateInputDigest: run.candidateInputDigest,
        listingRowDigest: run.listingRowDigest,
        familyActionProjectionDigest: run.familyActionProjectionDigest,
      }),
    ]);
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

  it('serves a locally published corrected candidate through every family-action consumer without legacy names', async () => {
    const db = fixture();
    const legacyNames = new Set([
      ...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS,
      'actionStatus',
      'digestPriority',
      'estimatedProfitRisk',
      'estimatedProfitRiskBasis',
      'moneyRiskInputs',
      'moneyRiskStatus',
      'moneyRiskUncoveredDays',
      'recommendedBestQty',
      'recommendedEscalation',
      'salesVelocity',
      'salesVelocityBasis',
      'salesVelocityStatus',
    ]);
    const [emptyWorkspace, emptyCommandCenter, emptyDigest, emptyListingReview] = await Promise.all([
      readThroughPublicAction(db, 'workspace'),
      readThroughPublicAction(db, 'commandCenter'),
      readThroughPublicAction(db, 'digestPreview'),
      readThroughPublicAction(db, 'listingPerformanceReview'),
    ]);
    expect(emptyWorkspace.rows).toEqual([]);
    expect(emptyCommandCenter.metadata).toMatchObject({ denominatorCount: 0, publishedRunId: null });
    expect(emptyDigest.metadata).toMatchObject({ denominatorCount: 0, publishedRunId: null });
    expect(emptyListingReview).toMatchObject({ listingCount: 0, actionCount: 0, rows: [] });
    expect(
      [...legacyNames].filter((name) =>
        exactNames({ emptyWorkspace, emptyCommandCenter, emptyDigest, emptyListingReview }).has(name),
      ),
    ).toEqual([]);

    const dTierCompanyProductId = 'cp-0002';
    const noMovementCompanyProductId = 'cp-0004';
    for (const [prefix, companyProductId, units, profit] of [
      ['d-tier', dTierCompanyProductId, 10, -50],
      ['no-movement', noMovementCompanyProductId, 0, 0],
    ] as const) {
      db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts).push(
        ...[...monthStarts(), '2026-07-16'].map((snapshotDate, index) => ({
          id: `${prefix}-fact-${index + 1}`,
          companyProductId,
          snapshotDate,
          units,
          netProfit: profit,
          profit,
        })),
      );
      db.rows(ECOBASE_COLLECTIONS.sourceCoverageMemberships).push(
        ...[...monthStarts(), '2026-07-01'].map((monthStart, index) => ({
          id: `${prefix}-membership-${index + 1}`,
          coverageIntervalId: 'coverage-1',
          companyProductId,
          monthStart,
          membershipStatus: 'in_scope',
          metricReconciliationStatus: 'complete',
          normalizedFactLinkCount: 1,
        })),
      );
    }
    const materialized = await refreshThroughPublicAction(db, 'published-consumer-contract');
    const runId = String((materialized.run as Row).id);
    const lifecycle = new EcobaseGoldRefreshRunService(db);
    await lifecycle.verify(runId);
    await lifecycle.publish(runId);

    const [workspace, commandCenter, digest, listingReview] = await Promise.all([
      readThroughPublicAction(db, 'workspace'),
      readThroughPublicAction(db, 'commandCenter'),
      readThroughPublicAction(db, 'digestPreview'),
      readThroughPublicAction(db, 'listingPerformanceReview'),
    ]);
    const paneRows = Object.values(commandCenter.panes).flatMap((pane) =>
      Array.isArray((pane as Row).rows) ? ((pane as Row).rows as Row[]) : [],
    );
    const digestRows = Object.values(digest.sections).flatMap((rows) => (Array.isArray(rows) ? rows : []));
    const responseNames = exactNames({ workspace, commandCenter, digest, listingReview });

    expect(workspace.rows).toHaveLength(2363);
    expect(workspace.filters).toMatchObject({ baselineTiers: ['A', 'B', 'C', 'D'] });
    const correctedCalculationEvidence = (workspace.rows.find((row) => row.companyProductId === 'cp-0000') as Row)
      .calculationEvidence as Row;
    expect(correctedCalculationEvidence).toMatchObject({
      coverage: {
        closedMonths: expect.arrayContaining([
          expect.objectContaining({
            monthStart: '2026-01-01',
            intervalIds: ['coverage-1'],
            membershipIds: ['membership-1'],
          }),
        ]),
        current: expect.objectContaining({
          intervalIds: ['coverage-1'],
          membershipIds: ['membership-7'],
        }),
      },
      pace: {
        quantity: expect.any(Object),
        profit: expect.any(Object),
      },
      disposition: expect.objectContaining({
        rollingUnits30: '10.00000000',
        inventoryDisposition: 'none',
        inventoryDispositionReasonCode: 'none',
      }),
      familyActionSnapshot: expect.objectContaining({
        familyKey: 'family-0000',
        companyProductFamilyId: 'family-0000',
        targetSelectionState: 'automatic',
        targetCompanyProductId: 'cp-0000',
      }),
    });
    expect(exactNames(correctedCalculationEvidence).has('salesVelocity')).toBe(false);
    expect(commandCenter.metadata).toMatchObject({
      denominatorCount: 1919,
      publishedRunId: runId,
      baselineTierCounts: expect.objectContaining({ D: 1 }),
      baselineStateCounts: expect.objectContaining({ no_movement: 1 }),
      dataReadinessCount: expect.any(Number),
      nullAverageMonthlyProfitCount: expect.any(Number),
      actionDecisionCounts: {
        newReplenishment: 1,
        existingOrderFollowUp: 0,
        mutualExclusivityViolations: 0,
      },
    });
    expect(commandCenter.metadata.historyReadiness.fields).toEqual(
      expect.arrayContaining(['baselineTier', 'baselineWeightedProfitPerUnit', 'averageMonthlyProfit']),
    );
    expect(commandCenter.metadata.dataReadinessCount).toBeGreaterThan(0);
    expect(commandCenter.metadata.nullAverageMonthlyProfitCount).toBeGreaterThan(0);
    expect(
      Object.values(commandCenter.panes).reduce((total, pane) => total + Number((pane as Row).total ?? 0), 0),
    ).toBe(1919);
    expect(paneRows.length).toBeGreaterThan(0);
    expect(paneRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ companyProductId: dTierCompanyProductId, baselineTier: 'D' })]),
    );
    expect(digest.metadata).toMatchObject({ denominatorCount: 1919, publishedRunId: runId });
    expect(digestRows.length).toBeGreaterThan(0);
    expect(listingReview).toMatchObject({ listingCount: 2363, actionCount: 0 });
    expect(listingReview.rows).toHaveLength(2363);
    expect(listingReview.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyProductId: dTierCompanyProductId, baselineTier: 'D' }),
        expect.objectContaining({
          companyProductId: noMovementCompanyProductId,
          baselineState: 'no_movement',
          baselineTier: null,
        }),
        expect.objectContaining({ companyProductId: 'cp-0006', averageMonthlyProfit: null }),
      ]),
    );
    const [secondCommandCenter, secondListingReview] = await Promise.all([
      readThroughPublicAction(db, 'commandCenter'),
      readThroughPublicAction(db, 'listingPerformanceReview'),
    ]);
    for (const pane of Object.keys(commandCenter.panes)) {
      const firstPane = (commandCenter.panes as Row)[pane] as Row;
      const secondPane = (secondCommandCenter.panes as Row)[pane] as Row;
      expect(secondPane).toMatchObject({
        total: firstPane.total,
        rows: (firstPane.rows as Row[]).map((row) => expect.objectContaining({ naturalKey: row.naturalKey })),
      });
    }
    expect(secondListingReview.rows.map((row) => row.naturalKey)).toEqual(
      listingReview.rows.map((row) => row.naturalKey),
    );
    expect([...legacyNames].filter((name) => responseNames.has(name))).toEqual([]);
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
