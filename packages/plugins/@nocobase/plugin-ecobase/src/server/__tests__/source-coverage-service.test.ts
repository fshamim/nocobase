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
  EcobaseSourceCoverageService,
  FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
  type CoverageEvidencePlan,
} from '../../features/source-import/server/source-coverage-service';
import { frozenCoverageBootstrapFixture } from './fixtures/frozen-coverage-bootstrap-fixture';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type PlainRecord = Record<string, unknown>;
type FindParams = {
  filter?: PlainRecord;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
  transaction?: unknown;
};

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private readonly records: PlainRecord[] = []) {}

  async find(params: FindParams = {}) {
    const records = this.filter(params);
    return records.slice(0, params.limit ?? records.length);
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: PlainRecord; transaction?: unknown }) {
    const created = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(created);
    return created;
  }

  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: PlainRecord;
    filterByTk?: string | number | null;
    values: PlainRecord;
    transaction?: unknown;
  }) {
    const matches = this.filter({ filter, filterByTk: filterByTk ?? undefined });
    if (!matches.length) throw new Error('Memory coverage update did not match a record.');
    matches.forEach((item) => Object.assign(item, values));
    return matches[0];
  }

  all() {
    return this.records;
  }

  private filter(params: FindParams) {
    if (params.filterByTk !== undefined) return this.records.filter((item) => item.id === params.filterByTk);
    return this.records.filter((item) =>
      Object.entries(params.filter ?? {}).every(([key, expected]) => item[key] === expected),
    );
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor(seeds: Record<string, PlainRecord[]> = {}) {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) =>
      this.repositories.set(name, new MemoryRepository(seeds[name] ?? [])),
    );
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Missing memory repository ${name}.`);
    return repository;
  }
}

const scope = {
  sourceConnectionId: 'source-1',
  companyId: 'company-1',
  amazonAccountId: 'account-1',
  marketplace: 'Amazon.com',
  companyProductId: 'company-product-1',
  monthStart: '2026-01-01',
};

async function seedInterval(db: MemoryDatabase, values: PlainRecord = {}) {
  return db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).create({
    values: {
      id: 'interval-1',
      naturalKey: 'coverage:source-1:account-1:2026-01-01:v1',
      sourceConnectionId: scope.sourceConnectionId,
      companyId: scope.companyId,
      amazonAccountId: scope.amazonAccountId,
      marketplace: scope.marketplace,
      metricSet: 'sellerboard_units_net_profit_v1',
      coveredStartDate: '2026-01-01',
      coveredEndDate: '2026-01-31',
      continuousCoverage: true,
      sourceAsOfDate: '2026-02-01',
      sourceVersion: 'v1',
      importRunId: 'run-1',
      inputDigest: 'a'.repeat(64),
      scopeDigest: 'b'.repeat(64),
      productScopeEvidenceVersion: 'sellerboard_listing_scope_v1',
      coverageStatus: 'active',
      evidenceJson: {},
      ...values,
    },
  });
}

async function seedMembership(db: MemoryDatabase, values: PlainRecord = {}) {
  return db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).create({
    values: {
      id: 'membership-1',
      naturalKey: 'membership:interval-1:company-product-1:2026-01-01',
      coverageIntervalId: 'interval-1',
      companyProductId: scope.companyProductId,
      monthStart: scope.monthStart,
      membershipStatus: 'in_scope',
      scopeEvidenceKinds: ['profit_by_product_daily'],
      scopeEvidenceDigest: 'c'.repeat(64),
      sourceMetricRowCount: 1,
      normalizedFactLinkCount: 1,
      metricReconciliationStatus: 'complete',
      metricEvidenceDigest: 'd'.repeat(64),
      ...values,
    },
  });
}

function evidencePlan(
  sourceVersion = 'v1',
  inputDigest = '1'.repeat(64),
  importRunId = `run-${sourceVersion}`,
): CoverageEvidencePlan {
  const intervalNaturalKey = `coverage:source-1:account-1:2026-01-01:${sourceVersion}`;
  return {
    intervals: [
      {
        naturalKey: intervalNaturalKey,
        sourceConnectionId: scope.sourceConnectionId,
        companyId: scope.companyId,
        amazonAccountId: scope.amazonAccountId,
        marketplace: scope.marketplace,
        coveredStartDate: '2026-01-01',
        coveredEndDate: '2026-01-31',
        continuousCoverage: true,
        sourceAsOfDate: sourceVersion === 'v1' ? '2026-02-01' : '2026-02-02',
        sourceVersion,
        importRunId,
        inputDigest,
        scopeDigest: '2'.repeat(64),
        evidenceJson: { observedDateCount: 31 },
      },
    ],
    memberships: [
      {
        intervalNaturalKey,
        companyProductId: scope.companyProductId,
        monthStart: scope.monthStart,
        scopeEvidenceKinds: ['profit_by_product_daily'],
        scopeEvidenceDigest: '3'.repeat(64),
        sourceMetricRowCount: 31,
        normalizedFactLinkCount: 31,
        metricReconciliationStatus: 'complete',
        metricEvidenceDigest: '4'.repeat(64),
      },
    ],
  };
}

describe('EcoBase source coverage ledger', () => {
  it('distinguishes eligible trusted zero, missing product scope, discontinuity, and metric mismatch', async () => {
    const eligibleDb = new MemoryDatabase();
    await seedInterval(eligibleDb);
    await seedMembership(eligibleDb);

    await expect(new EcobaseSourceCoverageService(eligibleDb).evaluateProductMonth(scope)).resolves.toMatchObject({
      eligible: true,
      reasonCode: 'eligible_complete_month',
      trustedZeroWhenNoFacts: true,
    });

    const unknownDb = new MemoryDatabase();
    await seedInterval(unknownDb);
    await expect(new EcobaseSourceCoverageService(unknownDb).evaluateProductMonth(scope)).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'product_scope_unknown',
      trustedZeroWhenNoFacts: false,
    });

    const discontinuousDb = new MemoryDatabase();
    await seedInterval(discontinuousDb, { continuousCoverage: false });
    await seedMembership(discontinuousDb);
    await expect(new EcobaseSourceCoverageService(discontinuousDb).evaluateProductMonth(scope)).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'coverage_discontinuous',
      trustedZeroWhenNoFacts: false,
    });

    const mismatchDb = new MemoryDatabase();
    await seedInterval(mismatchDb);
    await seedMembership(mismatchDb, { metricReconciliationStatus: 'incomplete' });
    await expect(new EcobaseSourceCoverageService(mismatchDb).evaluateProductMonth(scope)).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'metric_normalization_mismatch',
      trustedZeroWhenNoFacts: false,
    });
  });

  it('requires product membership across every selected interval in a gap-free lineage', async () => {
    const db = new MemoryDatabase();
    await seedInterval(db, { id: 'interval-first', coveredEndDate: '2026-01-15', sourceAsOfDate: '2026-02-01' });
    await seedInterval(db, {
      id: 'interval-second',
      naturalKey: 'coverage:source-1:account-1:2026-01-16:v2',
      coveredStartDate: '2026-01-16',
      sourceAsOfDate: '2026-02-02',
      sourceVersion: 'v2',
    });
    await seedMembership(db, { id: 'membership-first', coverageIntervalId: 'interval-first' });

    await expect(new EcobaseSourceCoverageService(db).evaluateProductMonth(scope)).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'product_scope_unknown',
      trustedZeroWhenNoFacts: false,
    });
  });

  it('fails closed without ledger writes for partial imports and ambiguous account scope', async () => {
    const partialDb = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'partial-run',
          status: 'partial',
          adapterName: 'sellerboard-history-csv',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-02-01',
        },
      ],
    });
    await expect(new EcobaseSourceCoverageService(partialDb).maintainSuccessfulImport('partial-run')).resolves.toEqual({
      recorded: false,
      importRunId: 'partial-run',
      reasonCode: 'import_not_successful',
    });
    expect(partialDb.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);

    const ambiguousDb = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'success-run',
          status: 'success',
          adapterName: 'sellerboard-history-csv',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-02-01',
        },
      ],
      [ECOBASE_COLLECTIONS.sourceConnections]: [{ id: 'source-1', companyId: 'company-1' }],
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
        { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
        { id: 'account-2', companyId: 'company-1', marketplace: 'amazon.com' },
      ],
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: [
        {
          id: 'bronze-1',
          importRunId: 'success-run',
          sourceRecordKey: 'profit_by_product_daily-file.csv:1',
          payload: {
            period: '2026-01-01',
            marketplace: 'Amazon.com',
            asin: 'B007P55HOW',
            listingSku: 'DC50944',
          },
        },
      ],
    });
    await expect(
      new EcobaseSourceCoverageService(ambiguousDb).maintainSuccessfulImport('success-run'),
    ).resolves.toEqual({ recorded: false, importRunId: 'success-run', reasonCode: 'account_scope_unproven' });
    expect(ambiguousDb.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(ambiguousDb.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
  });

  it('dry-runs the digest-bound frozen bootstrap with the exact TD-02A partition and zero writes', async () => {
    const fixture = frozenCoverageBootstrapFixture();
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: fixture.companyProducts,
    });
    const protectedBefore = JSON.stringify(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).all());
    const service = new EcobaseSourceCoverageService(db);
    expect(FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST).toBe(
      'd4ab92cbf038620da8a89ada5b6976bf69bd46d9e3b485731627718c9dfff750',
    );

    await expect(
      service.bootstrapFrozenEvidence({
        mode: 'dry-run',
        expectedEvidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
        plan: fixture.plan,
      }),
    ).resolves.toMatchObject({
      mode: 'dry-run',
      planDigest: '38d0e58d18e3a24a073bcb66251d81bb1a3ff864fa9a44958c16620df461d4c8',
      history: {
        intervalCount: 54,
        continuousIntervalCount: 42,
        discontinuousIntervalCount: 12,
        membershipCount: 3729,
      },
      baseline: {
        listingCount: 2363,
        productMonthCount: 14178,
        eligibleCompleteCount: 3683,
        productScopeUnknownCount: 10353,
        coverageDiscontinuousCount: 142,
        metricNormalizationMismatchCount: 0,
        confidenceCounts: { full: 264, moderate: 396, low: 413, none: 1290 },
      },
      current: {
        intervalCount: 10,
        continuousIntervalCount: 5,
        incompleteIntervalCount: 5,
        membershipCount: 2317,
        metricNormalizationMismatchCount: 57,
        completeScopeMetricNormalizationMismatchCount: 52,
      },
      predictedLedgerWriteCount: 6110,
      predictedProtectedDomainMutationCount: 0,
      reconciliation: null,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
    expect(JSON.stringify(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).all())).toBe(protectedBefore);
  });

  it('rejects a wrong bootstrap digest and applies exact frozen evidence idempotently when explicitly requested', async () => {
    const fixture = frozenCoverageBootstrapFixture();
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: fixture.companyProducts,
    });
    const service = new EcobaseSourceCoverageService(db);
    await expect(
      service.bootstrapFrozenEvidence({
        mode: 'dry-run',
        expectedEvidenceDigest: '0'.repeat(64),
        plan: fixture.plan,
      }),
    ).rejects.toMatchObject({ code: 'ECOBASE_COVERAGE_BOOTSTRAP_DIGEST_MISMATCH' });

    const dryRun = await service.bootstrapFrozenEvidence({
      mode: 'dry-run',
      expectedEvidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
      plan: fixture.plan,
    });
    await expect(
      service.bootstrapFrozenEvidence({
        mode: 'apply',
        expectedEvidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
        expectedPlanDigest: 'f'.repeat(64),
        plan: fixture.plan,
      }),
    ).rejects.toMatchObject({ code: 'ECOBASE_COVERAGE_BOOTSTRAP_DIGEST_MISMATCH' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);

    await expect(
      service.bootstrapFrozenEvidence({
        mode: 'apply',
        expectedEvidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
        expectedPlanDigest: dryRun.planDigest,
        plan: fixture.plan,
      }),
    ).resolves.toMatchObject({
      mode: 'apply',
      reconciliation: { intervalCreatedCount: 64, membershipCreatedCount: 6046, noOp: false },
    });
    await expect(
      service.bootstrapFrozenEvidence({
        mode: 'apply',
        expectedEvidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
        expectedPlanDigest: dryRun.planDigest,
        plan: fixture.plan,
      }),
    ).resolves.toMatchObject({
      mode: 'apply',
      reconciliation: {
        intervalCreatedCount: 0,
        membershipCreatedCount: 0,
        idempotentIntervalCount: 64,
        idempotentMembershipCount: 6046,
        noOp: true,
      },
    });
  });

  it('is idempotent for identical evidence and permits only explicit newer lineage supersession', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseSourceCoverageService(db);

    await expect(service.reconcileEvidence(evidencePlan())).resolves.toMatchObject({
      intervalCreatedCount: 1,
      membershipCreatedCount: 1,
      noOp: false,
    });
    await expect(service.reconcileEvidence(evidencePlan())).resolves.toMatchObject({
      intervalCreatedCount: 0,
      membershipCreatedCount: 0,
      idempotentIntervalCount: 1,
      idempotentMembershipCount: 1,
      noOp: true,
    });
    await expect(service.reconcileEvidence(evidencePlan('v1', '1'.repeat(64), 'replay-run'))).resolves.toMatchObject({
      idempotentIntervalCount: 1,
      idempotentMembershipCount: 1,
      noOp: true,
    });
    await expect(service.reconcileEvidence(evidencePlan('v1', '9'.repeat(64)))).rejects.toMatchObject({
      code: 'ECOBASE_COVERAGE_CONFLICT',
    });

    await expect(service.reconcileEvidence(evidencePlan('v2'))).resolves.toMatchObject({
      intervalCreatedCount: 1,
      membershipCreatedCount: 1,
      supersededIntervalCount: 1,
      noOp: false,
    });
    await expect(service.evaluateProductMonth(scope)).resolves.toMatchObject({
      eligible: true,
      reasonCode: 'eligible_complete_month',
      intervalIds: expect.any(Array),
    });
  });
});
