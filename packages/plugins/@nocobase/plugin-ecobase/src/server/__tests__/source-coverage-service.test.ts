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
  FROZEN_COVERAGE_BOOTSTRAP_MANIFEST,
  frozenCoverageBootstrapApplyConfirmation,
  type CoverageEvidencePlan,
} from '../../features/source-import/server/source-coverage-service';
import { frozenCoverageBootstrapFixture } from './fixtures/frozen-coverage-bootstrap-fixture';
import {
  FROZEN_COVERAGE_IMPORT_FIXTURE_PLAN_DIGEST,
  FROZEN_STRICT_COVERAGE_PLAN_DIGEST,
  frozenCoverageImportProjectionFixture,
} from './fixtures/frozen-coverage-import-projection-fixture';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { TD02A_STRICT_REFERENCE_MANIFEST } from './fixtures/td02a-strict-reference-manifest';

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
    for (const sort of [...(params.sort ?? [])].reverse()) {
      const descending = sort.startsWith('-');
      const field = descending ? sort.slice(1) : sort;
      records.sort((left, right) => {
        const compared = String(left[field]).localeCompare(String(right[field]));
        return descending ? -compared : compared;
      });
    }
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
      Object.entries(params.filter ?? {}).every(([key, expected]) => {
        if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return item[key] === expected;
        const operators = expected as { $gt?: unknown; $in?: unknown[] };
        if (operators.$gt !== undefined && String(item[key]).localeCompare(String(operators.$gt)) <= 0) return false;
        if (operators.$in !== undefined && !operators.$in.includes(item[key])) return false;
        return true;
      }),
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

// An incoming interval whose window sits fully inside the seeded 2026-01-01..2026-01-31 active
// interval, with a distinct sourceVersion so it reaches the overlap lineage branch (not the
// same-natural-key idempotency branch). Digests default to content that differs from the seeded
// interval; pass the seeded digests to exercise the "same content" quiet-skip clause.
function staleWithinPlan(
  sourceVersion: string,
  sourceAsOfDate: string,
  coveredEndDate: string,
  digests: { inputDigest?: string; scopeDigest?: string } = {},
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
        coveredEndDate,
        continuousCoverage: true,
        sourceAsOfDate,
        sourceVersion,
        importRunId: `run-${sourceVersion}`,
        inputDigest: digests.inputDigest ?? '5'.repeat(64),
        scopeDigest: digests.scopeDigest ?? '6'.repeat(64),
        evidenceJson: { observedDateCount: 20 },
      },
    ],
    memberships: [
      {
        intervalNaturalKey,
        companyProductId: scope.companyProductId,
        monthStart: scope.monthStart,
        scopeEvidenceKinds: ['profit_by_product_daily'],
        scopeEvidenceDigest: '7'.repeat(64),
        sourceMetricRowCount: 20,
        normalizedFactLinkCount: 20,
        metricReconciliationStatus: 'complete',
        metricEvidenceDigest: '8'.repeat(64),
      },
    ],
  };
}

// Same natural key as evidencePlan() (sourceVersion 'v1', equal as-of), but the interval scope and
// membership set changed — mid-run auto-add resolved an extra product. `restated` also changes an
// existing member's per-product evidence (Sellerboard same-day restatement).
function sameKeyChangedPlan(scopeDigest: string, options: { restated?: boolean } = {}): CoverageEvidencePlan {
  const intervalNaturalKey = 'coverage:source-1:account-1:2026-01-01:v1';
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
        sourceAsOfDate: '2026-02-01',
        sourceVersion: 'v1',
        importRunId: 'run-grown',
        inputDigest: '1'.repeat(64),
        scopeDigest,
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
        metricEvidenceDigest: options.restated ? 'e'.repeat(64) : '4'.repeat(64),
      },
      {
        intervalNaturalKey,
        companyProductId: 'company-product-2',
        monthStart: scope.monthStart,
        scopeEvidenceKinds: ['profit_by_product_daily'],
        scopeEvidenceDigest: '5'.repeat(64),
        sourceMetricRowCount: 20,
        normalizedFactLinkCount: 20,
        metricReconciliationStatus: 'complete',
        metricEvidenceDigest: '6'.repeat(64),
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

  it('projects history rows by authoritative dataset and normalized fact date instead of source-key and slash-date heuristics', async () => {
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'history-run',
          status: 'success',
          adapterName: 'sellerboard-history-csv',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-07-16',
        },
      ],
      [ECOBASE_COLLECTIONS.sourceConnections]: [{ id: 'source-1', companyId: 'company-1' }],
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
        { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
      ],
      [ECOBASE_COLLECTIONS.silverProducts]: [{ id: 'product-1', asin: 'B007P55HOW', sku: 'DC50944' }],
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: [
        {
          id: 'company-product-1',
          companyId: 'company-1',
          amazonAccountId: 'account-1',
          productId: 'product-1',
        },
      ],
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: [
        {
          id: 'bronze-history-1',
          importRunId: 'history-run',
          sourceDataset: 'sellerboard_daily_facts',
          sourceRecordKey: 'Company_Dashboard_by_product.csv:B007P55HOW:DC50944:2',
          observedAt: '2026-07-16',
          rowHash: 'a'.repeat(64),
          payload: {
            period: '05/03/2026',
            marketplace: 'Amazon.com',
            asin: 'B007P55HOW',
            listingSku: 'DC50944',
            units: 2,
            netProfit: 3,
          },
        },
      ],
      [ECOBASE_COLLECTIONS.silverListingDailyFacts]: [
        {
          id: 'fact-history-1',
          companyProductId: 'company-product-1',
          snapshotDate: '2026-03-05',
          units: 2,
          profit: 3,
        },
      ],
      [ECOBASE_COLLECTIONS.silverNormalizationLinks]: [
        {
          id: 'link-history-1',
          importRunId: 'history-run',
          bronzeRecordId: 'bronze-history-1',
          silverEntityType: 'silverListingDailyFact',
          silverEntityId: 'fact-history-1',
          sourceRowHash: 'a'.repeat(64),
        },
      ],
    });

    await expect(new EcobaseSourceCoverageService(db).maintainSuccessfulImport('history-run')).resolves.toMatchObject({
      recorded: true,
      intervalCount: 1,
      membershipCount: 1,
      reconciliation: { intervalCreatedCount: 1, membershipCreatedCount: 1 },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([
      expect.objectContaining({
        coveredStartDate: '2026-03-01',
        coveredEndDate: '2026-03-31',
        continuousCoverage: false,
        evidenceJson: expect.objectContaining({ adapterName: 'sellerboard-history-csv', observedDateCount: 1 }),
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([
      expect.objectContaining({
        companyProductId: 'company-product-1',
        monthStart: '2026-03-01',
        scopeEvidenceKinds: ['profit_by_product_daily'],
        metricReconciliationStatus: 'complete',
      }),
    ]);
  });

  it('fails closed instead of guessing a current metric date from an ambiguous slash-formatted payload', async () => {
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'current-run',
          status: 'success',
          adapterName: 'sellerboard-api',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-07-16',
        },
      ],
      [ECOBASE_COLLECTIONS.sourceConnections]: [{ id: 'source-1', companyId: 'company-1' }],
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
        { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
      ],
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: [
        {
          id: 'bronze-current-ambiguous-date',
          importRunId: 'current-run',
          sourceDataset: 'sellerboard_daily_facts',
          sourceRecordKey: 'profit_by_product_daily-Profit by Product.csv:B007P55HOW:DC50944',
          rowHash: 'b'.repeat(64),
          payload: {
            period: '7/3/2026',
            marketplace: 'Amazon.com',
            asin: 'B007P55HOW',
            listingSku: 'DC50944',
            units: 2,
            netProfit: 3,
          },
        },
      ],
    });

    await expect(new EcobaseSourceCoverageService(db).maintainSuccessfulImport('current-run')).resolves.toEqual({
      recorded: false,
      importRunId: 'current-run',
      reasonCode: 'source_evidence_empty',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
  });

  it.each([
    ['missing', []],
    [
      'duplicate',
      [
        {
          id: 'link-history-1',
          importRunId: 'history-run',
          bronzeRecordId: 'bronze-history-1',
          silverEntityType: 'silverListingDailyFact',
          silverEntityId: 'fact-history-1',
          sourceRowHash: 'a'.repeat(64),
        },
        {
          id: 'link-history-2',
          importRunId: 'history-run',
          bronzeRecordId: 'bronze-history-1',
          silverEntityType: 'silverListingDailyFact',
          silverEntityId: 'fact-history-1',
          sourceRowHash: 'a'.repeat(64),
        },
      ],
    ],
  ])('fails closed when normalized metric-link evidence is %s', async (_case, links) => {
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'history-run',
          status: 'success',
          adapterName: 'sellerboard-history-csv',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-07-16',
        },
      ],
      [ECOBASE_COLLECTIONS.sourceConnections]: [{ id: 'source-1', companyId: 'company-1' }],
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
        { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
      ],
      [ECOBASE_COLLECTIONS.silverProducts]: [{ id: 'product-1', asin: 'B007P55HOW', sku: 'DC50944' }],
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: [
        {
          id: 'company-product-1',
          companyId: 'company-1',
          amazonAccountId: 'account-1',
          productId: 'product-1',
        },
      ],
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: [
        {
          id: 'bronze-history-1',
          importRunId: 'history-run',
          sourceDataset: 'sellerboard_daily_facts',
          sourceRecordKey: 'Company_Dashboard_by_product.csv:B007P55HOW:DC50944:2',
          observedAt: '2026-07-16',
          rowHash: 'a'.repeat(64),
          payload: {
            period: '05/03/2026',
            marketplace: 'Amazon.com',
            asin: 'B007P55HOW',
            listingSku: 'DC50944',
            units: 2,
            netProfit: 3,
          },
        },
      ],
      [ECOBASE_COLLECTIONS.silverListingDailyFacts]: [
        {
          id: 'fact-history-1',
          companyProductId: 'company-product-1',
          snapshotDate: '2026-03-05',
          units: 2,
          profit: 3,
        },
      ],
      [ECOBASE_COLLECTIONS.silverNormalizationLinks]: links as PlainRecord[],
    });

    await expect(new EcobaseSourceCoverageService(db).maintainSuccessfulImport('history-run')).resolves.toEqual({
      recorded: false,
      importRunId: 'history-run',
      reasonCode: 'source_evidence_empty',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
  });

  it('uses the linked fact date while preserving fail-closed metric reconciliation', async () => {
    const dates = Array.from({ length: 31 }, (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`);
    const bronzeRows = dates.map((snapshotDate, index) => ({
      id: `bronze-history-${index}`,
      importRunId: 'history-run',
      sourceDataset: 'sellerboard_daily_facts',
      sourceRecordKey: `Company_Dashboard_by_product.csv:B007P55HOW:DC50944:${index + 2}`,
      observedAt: '2026-07-16',
      rowHash: String(index).padStart(64, 'a').slice(-64),
      payload: {
        period: `${index + 1}/03/2026`,
        marketplace: 'Amazon.com',
        asin: 'B007P55HOW',
        listingSku: 'DC50944',
        units: 2,
        netProfit: 3,
      },
    }));
    const facts = dates.map((snapshotDate, index) => ({
      id: `fact-history-${index}`,
      companyProductId: 'company-product-1',
      snapshotDate,
      units: 2,
      profit: 3,
    }));
    const links = dates.map((_snapshotDate, index) => ({
      id: `link-history-${index}`,
      importRunId: 'history-run',
      bronzeRecordId: `bronze-history-${index}`,
      silverEntityType: 'silverListingDailyFact',
      silverEntityId: `fact-history-${index}`,
      sourceRowHash: index === 14 ? 'f'.repeat(64) : bronzeRows[index].rowHash,
    }));
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'history-run',
          status: 'success',
          adapterName: 'sellerboard-history-csv',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-07-16',
        },
      ],
      [ECOBASE_COLLECTIONS.sourceConnections]: [{ id: 'source-1', companyId: 'company-1' }],
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
        { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
      ],
      [ECOBASE_COLLECTIONS.silverProducts]: [{ id: 'product-1', asin: 'B007P55HOW', sku: 'DC50944' }],
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: [
        {
          id: 'company-product-1',
          companyId: 'company-1',
          amazonAccountId: 'account-1',
          productId: 'product-1',
        },
      ],
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: bronzeRows,
      [ECOBASE_COLLECTIONS.silverListingDailyFacts]: facts,
      [ECOBASE_COLLECTIONS.silverNormalizationLinks]: links,
    });
    const service = new EcobaseSourceCoverageService(db);

    await expect(service.maintainSuccessfulImport('history-run')).resolves.toMatchObject({
      recorded: true,
      intervalCount: 1,
      membershipCount: 1,
    });
    await expect(service.evaluateProductMonth({ ...scope, monthStart: '2026-03-01' })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'metric_normalization_mismatch',
      trustedZeroWhenNoFacts: false,
    });
  });

  it('uses proved report-date format to keep a linked current fact-date mismatch fail-closed', async () => {
    const currentDates = Array.from({ length: 16 }, (_, index) => `2026-07-${String(index + 1).padStart(2, '0')}`);
    const factDates = [...currentDates, '2026-07-02'];
    const bronzeRows = factDates.map((_factDate, index) => ({
      id: `bronze-current-${index}`,
      importRunId: 'current-run',
      sourceDataset: 'sellerboard_daily_facts',
      sourceRecordKey: `profit_by_product_daily-Profit by Product.csv:B007P55HOW:DC50944:${index + 2}`,
      observedAt: '2026-07-16',
      rowHash: String(index).padStart(64, 'b').slice(-64),
      payload: {
        period: index < 16 ? `7/${index + 1}/2026` : '7/1/2026',
        marketplace: 'Amazon.com',
        asin: 'B007P55HOW',
        listingSku: 'DC50944',
        units: 2,
        netProfit: 3,
      },
    }));
    const facts = factDates.map((snapshotDate, index) => ({
      id: `fact-current-${index}`,
      companyProductId: 'company-product-1',
      snapshotDate,
      units: 2,
      profit: 3,
    }));
    const links = factDates.map((_snapshotDate, index) => ({
      id: `link-current-${index}`,
      importRunId: 'current-run',
      bronzeRecordId: `bronze-current-${index}`,
      silverEntityType: 'silverListingDailyFact',
      silverEntityId: `fact-current-${index}`,
      sourceRowHash: bronzeRows[index].rowHash,
    }));
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'current-run',
          status: 'success',
          adapterName: 'sellerboard-api',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-07-16',
        },
      ],
      [ECOBASE_COLLECTIONS.sourceConnections]: [{ id: 'source-1', companyId: 'company-1' }],
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
        { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
      ],
      [ECOBASE_COLLECTIONS.silverProducts]: [{ id: 'product-1', asin: 'B007P55HOW', sku: 'DC50944' }],
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: [
        {
          id: 'company-product-1',
          companyId: 'company-1',
          amazonAccountId: 'account-1',
          productId: 'product-1',
        },
      ],
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: bronzeRows,
      [ECOBASE_COLLECTIONS.silverListingDailyFacts]: facts,
      [ECOBASE_COLLECTIONS.silverNormalizationLinks]: links,
    });
    const service = new EcobaseSourceCoverageService(db);

    await expect(service.maintainSuccessfulImport('current-run')).resolves.toMatchObject({
      recorded: true,
      intervalCount: 1,
      membershipCount: 1,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([
      expect.objectContaining({ continuousCoverage: true }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([
      expect.objectContaining({ metricReconciliationStatus: 'incomplete' }),
    ]);
  });

  it('dates current stock evidence from the explicit Sellerboard import as-of contract', async () => {
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.importRuns]: [
        {
          id: 'current-run',
          status: 'success',
          adapterName: 'sellerboard-api',
          sourceConnectionId: 'source-1',
          sourceVersion: '2026-07-16',
        },
      ],
      [ECOBASE_COLLECTIONS.sourceConnections]: [{ id: 'source-1', companyId: 'company-1' }],
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
        { id: 'account-1', companyId: 'company-1', marketplace: 'Amazon.com' },
      ],
      [ECOBASE_COLLECTIONS.silverProducts]: [{ id: 'product-1', asin: 'B007P55HOW', sku: 'DC50944' }],
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: [
        {
          id: 'company-product-1',
          companyId: 'company-1',
          amazonAccountId: 'account-1',
          productId: 'product-1',
        },
      ],
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: [
        {
          id: 'bronze-stock-1',
          importRunId: 'current-run',
          sourceDataset: 'amazon_listing_inventory',
          sourceRecordKey: 'stock_daily-Stock Daily Data.csv:B007P55HOW:DC50944',
          observedAt: '2026-07-16',
          rowHash: 'c'.repeat(64),
          payload: {
            period: '7/3/2026',
            marketplace: 'Amazon.com',
            asin: 'B007P55HOW',
            listingSku: 'DC50944',
          },
        },
      ],
    });

    await expect(new EcobaseSourceCoverageService(db).maintainSuccessfulImport('current-run')).resolves.toMatchObject({
      recorded: true,
      intervalCount: 1,
      membershipCount: 1,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([
      expect.objectContaining({ coveredStartDate: '2026-07-01', coveredEndDate: '2026-07-16' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([
      expect.objectContaining({
        monthStart: '2026-07-01',
        scopeEvidenceKinds: ['stock_daily'],
        metricReconciliationStatus: 'incomplete',
      }),
    ]);
  });

  it('locks the independent strict reference and all dependent acceptance partitions', () => {
    expect(FROZEN_COVERAGE_BOOTSTRAP_MANIFEST.version).toBe(TD02A_STRICT_REFERENCE_MANIFEST.version);
    expect(FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST).toBe(TD02A_STRICT_REFERENCE_MANIFEST.evidenceDigest);
    expect(FROZEN_COVERAGE_BOOTSTRAP_MANIFEST.strictPlanDigest).toBe(TD02A_STRICT_REFERENCE_MANIFEST.planDigest);
    expect(FROZEN_COVERAGE_BOOTSTRAP_MANIFEST.expected).toEqual(TD02A_STRICT_REFERENCE_MANIFEST.coverage);
    expect(Object.values(TD02A_STRICT_REFERENCE_MANIFEST.dependentAcceptance.baselineResults)).toEqual(
      expect.arrayContaining([21, 53, 440, 141, 416, 1292]),
    );
    expect(
      Object.values(TD02A_STRICT_REFERENCE_MANIFEST.dependentAcceptance.baselineResults).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(2363);
    expect(
      Object.values(TD02A_STRICT_REFERENCE_MANIFEST.dependentAcceptance.currentProjectionConfidence).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(2363);
    expect(TD02A_STRICT_REFERENCE_MANIFEST.dependentAcceptance).toMatchObject({
      listingCount: 2363,
      familyActionCount: 1919,
      currentProjectionGateMode: 'informational',
      candidateDigest: null,
    });
  });

  it('dry-runs the digest-bound frozen bootstrap with the exact TD-02A partition and zero writes', async () => {
    const fixture = frozenCoverageBootstrapFixture();
    const db = new MemoryDatabase({
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: fixture.companyProducts,
    });
    const protectedBefore = JSON.stringify(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).all());
    const service = new EcobaseSourceCoverageService(db);
    expect(FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST).toBe(
      '8a8115d136c8b887a06f460ffcad1c546da103c6fd552ddfa17fae7e341cabf8',
    );
    expect(FROZEN_COVERAGE_BOOTSTRAP_MANIFEST.strictPlanDigest).toBe(FROZEN_STRICT_COVERAGE_PLAN_DIGEST);

    await expect(
      service.bootstrapFrozenEvidence({
        mode: 'dry-run',
        expectedEvidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
        plan: fixture.plan,
      }),
    ).resolves.toMatchObject({
      mode: 'dry-run',
      planDigest: '93082e86d7709e0090f22ebdc59558d80ef6e624d0d9522b19aef87f33e89f1d',
      history: {
        intervalCount: 54,
        continuousIntervalCount: 42,
        discontinuousIntervalCount: 12,
        membershipCount: 3718,
      },
      baseline: {
        listingCount: 2363,
        productMonthCount: 14178,
        eligibleCompleteCount: 3667,
        productScopeUnknownCount: 10364,
        coverageDiscontinuousCount: 142,
        metricNormalizationMismatchCount: 5,
        confidenceCounts: { full: 260, moderate: 400, low: 411, none: 1292 },
      },
      current: {
        intervalCount: 10,
        continuousIntervalCount: 5,
        incompleteIntervalCount: 5,
        membershipCount: 2319,
        metricNormalizationMismatchCount: 100,
        completeScopeMetricNormalizationMismatchCount: 88,
      },
      predictedLedgerWriteCount: 6101,
      predictedProtectedDomainMutationCount: 0,
      reconciliation: null,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
    expect(JSON.stringify(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).all())).toBe(protectedBefore);
  });

  it('projects all eight frozen runs deterministically to the digest-bound TD-02A plan without writes', async () => {
    const fixture = frozenCoverageImportProjectionFixture();
    const importRuns = fixture.seeds[ECOBASE_COLLECTIONS.importRuns];
    const historyRunIds = new Set(
      importRuns.filter((run) => run.adapterName === 'sellerboard-history-csv').map((run) => String(run.id)),
    );
    const bronzeRows = fixture.seeds[ECOBASE_COLLECTIONS.bronzeSourceRecords];
    const historyRows = bronzeRows.filter((row) => historyRunIds.has(String(row.importRunId)));
    const historyPeriods = historyRows.map((row) => String((row.payload as PlainRecord).period));
    expect(fixture.importRunIds).toHaveLength(8);
    expect(importRuns.filter((run) => run.adapterName === 'sellerboard-history-csv')).toHaveLength(4);
    expect(importRuns.filter((run) => run.adapterName === 'sellerboard-api')).toHaveLength(4);
    expect(historyRows.every((row) => row.sourceDataset === 'sellerboard_daily_facts')).toBe(true);
    expect(
      historyRows.every(
        (row) =>
          !String(row.sourceRecordKey).startsWith('profit_by_product_daily-') &&
          !String(row.sourceRecordKey).startsWith('stock_daily-'),
      ),
    ).toBe(true);
    expect(historyRows.every((row) => row.observedAt === '2026-07-16')).toBe(true);
    expect(historyPeriods).toContain('13/1/2026');
    expect(historyPeriods).toContain('4/13/2026');
    const stockRows = bronzeRows.filter((row) => row.sourceDataset === 'amazon_listing_inventory');
    expect(stockRows).toHaveLength(10);
    expect(stockRows.every((row) => row.observedAt === '2026-07-16')).toBe(true);
    expect(stockRows.every((row) => (row.payload as PlainRecord).period === undefined)).toBe(true);

    const irrelevantLinks = Array.from({ length: 200_001 }, (_, index) => ({
      id: `irrelevant-link-${String(index).padStart(6, '0')}`,
      importRunId: 'unselected-run',
      silverEntityType: 'silverCompany',
    }));
    const productionSeeds = {
      ...fixture.seeds,
      [ECOBASE_COLLECTIONS.silverNormalizationLinks]: [
        ...irrelevantLinks,
        ...fixture.seeds[ECOBASE_COLLECTIONS.silverNormalizationLinks],
      ],
    };
    const reversedSeeds = Object.fromEntries(
      Object.entries(productionSeeds).map(([collection, rows]) => [collection, [...rows].reverse()]),
    );
    const db = new MemoryDatabase(productionSeeds);
    const reversedDb = new MemoryDatabase(reversedSeeds);
    const protectedBefore = JSON.stringify(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).all());

    type ProjectionInternals = {
      loadCoverageProjection(importRunIds: string[]): Promise<unknown>;
      frozenImportPlan(importRunId: string, snapshot: unknown): Promise<CoverageEvidencePlan>;
    };
    const project = async (database: MemoryDatabase, importRunIds: string[]) => {
      const service = new EcobaseSourceCoverageService(database);
      const internals = service as unknown as ProjectionInternals;
      const selectedRunIds = [...importRunIds].sort();
      const snapshot = await internals.loadCoverageProjection(selectedRunIds);
      const plans = await Promise.all(
        selectedRunIds.map((importRunId) => internals.frozenImportPlan(importRunId, snapshot)),
      );
      return service.bootstrapFrozenEvidence({
        mode: 'dry-run',
        expectedEvidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
        plan: {
          intervals: plans.flatMap((plan) => plan.intervals),
          memberships: plans.flatMap((plan) => plan.memberships),
        },
      });
    };
    const first = await project(db, fixture.importRunIds);
    const replay = await project(reversedDb, [...fixture.importRunIds].reverse());

    expect(first).toEqual(replay);
    expect(frozenCoverageBootstrapApplyConfirmation(first.planDigest)).toBe(
      `APPLY_TD02A_COVERAGE_${FROZEN_COVERAGE_IMPORT_FIXTURE_PLAN_DIGEST.slice(0, 16)}`,
    );
    expect(first).toMatchObject({
      mode: 'dry-run',
      evidenceDigest: '8a8115d136c8b887a06f460ffcad1c546da103c6fd552ddfa17fae7e341cabf8',
      planDigest: FROZEN_COVERAGE_IMPORT_FIXTURE_PLAN_DIGEST,
      history: {
        intervalCount: 54,
        continuousIntervalCount: 42,
        discontinuousIntervalCount: 12,
        membershipCount: 3718,
      },
      baseline: {
        listingCount: 2363,
        productMonthCount: 14178,
        eligibleCompleteCount: 3667,
        productScopeUnknownCount: 10364,
        coverageDiscontinuousCount: 142,
        metricNormalizationMismatchCount: 5,
        confidenceCounts: { full: 260, moderate: 400, low: 411, none: 1292 },
      },
      current: {
        intervalCount: 10,
        continuousIntervalCount: 5,
        incompleteIntervalCount: 5,
        membershipCount: 2319,
        metricNormalizationMismatchCount: 100,
        completeScopeMetricNormalizationMismatchCount: 88,
      },
      predictedLedgerWriteCount: 6101,
      predictedProtectedDomainMutationCount: 0,
      reconciliation: null,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
    expect(reversedDb.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(reversedDb.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
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
      reconciliation: { intervalCreatedCount: 64, membershipCreatedCount: 6037, noOp: false },
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
        idempotentMembershipCount: 6037,
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
    // Same natural key, equal as-of, changed interval evidence -> supersede in place (the latest
    // pull is the truth; naturalKey is unique so no second row is forked), not a conflict.
    await expect(service.reconcileEvidence(evidencePlan('v1', '9'.repeat(64)))).resolves.toMatchObject({
      intervalCreatedCount: 0,
      supersededInPlaceCount: 1,
      idempotentMembershipCount: 1,
      noOp: false,
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

  it('quietly skips a stale re-serve fully within a newer active interval without erroring', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseSourceCoverageService(db);
    // Establish the held ACTIVE interval: 2026-01-01..2026-01-31 as-of 2026-02-01.
    await expect(service.reconcileEvidence(evidencePlan())).resolves.toMatchObject({ intervalCreatedCount: 1 });

    // Older as-of, narrower window fully within the held one -> quiet no-op + informational flag.
    const older = await service.reconcileEvidence(staleWithinPlan('older', '2026-01-25', '2026-01-20'));
    expect(older).toMatchObject({
      intervalCreatedCount: 0,
      membershipCreatedCount: 0,
      supersededIntervalCount: 0,
      noOp: true,
    });
    expect(older.coverageSkippedStale).toEqual([
      {
        metricSet: 'sellerboard_units_net_profit_v1',
        incomingAsOf: '2026-01-25',
        heldAsOf: '2026-02-01',
        window: '2026-01-01..2026-01-20',
        heldCoverageStatus: 'active',
        coveringActiveKey: 'coverage:source-1:account-1:2026-01-01:v1',
        incomingInputDigest: '5'.repeat(64),
        incomingScopeDigest: '6'.repeat(64),
        heldInputDigest: '1'.repeat(64),
        heldScopeDigest: '2'.repeat(64),
      },
    ]);

    // Equal as-of, fully within, and identical content already held -> still a quiet no-op + flag
    // (precedence: equal as-of skips only when the digest matches; changed content supersedes).
    const equal = await service.reconcileEvidence(
      staleWithinPlan('equal', '2026-02-01', '2026-01-22', {
        inputDigest: '1'.repeat(64),
        scopeDigest: '2'.repeat(64),
      }),
    );
    expect(equal).toMatchObject({ intervalCreatedCount: 0, membershipCreatedCount: 0, noOp: true });
    expect(equal.coverageSkippedStale).toEqual([
      {
        metricSet: 'sellerboard_units_net_profit_v1',
        incomingAsOf: '2026-02-01',
        heldAsOf: '2026-02-01',
        window: '2026-01-01..2026-01-22',
        heldCoverageStatus: 'active',
        coveringActiveKey: 'coverage:source-1:account-1:2026-01-01:v1',
        incomingInputDigest: '1'.repeat(64),
        incomingScopeDigest: '2'.repeat(64),
        heldInputDigest: '1'.repeat(64),
        heldScopeDigest: '2'.repeat(64),
      },
    ]);

    // Existing coverage is left untouched: still exactly one active interval, unchanged window/as-of,
    // and no membership was written for the skipped reports.
    const intervals = db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all();
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({
      coverageStatus: 'active',
      coveredEndDate: '2026-01-31',
      sourceAsOfDate: '2026-02-01',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toHaveLength(1);
  });

  it('supersedes in place on equal-as-of scope growth and restatement, and stays a no-op on identical content', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseSourceCoverageService(db);
    // Establish v1: window 01-01..01-31 as-of 02-01 with one member.
    await expect(service.reconcileEvidence(evidencePlan())).resolves.toMatchObject({
      intervalCreatedCount: 1,
      membershipCreatedCount: 1,
    });

    // (branch: supersede) same natural key, equal as-of, changed scope + a newly-resolved product
    // (mid-run auto-add) -> replace the held evidence in place and extend the membership set. No
    // second interval row is forked (naturalKey is unique).
    const grown = await service.reconcileEvidence(sameKeyChangedPlan('7'.repeat(64)));
    expect(grown).toMatchObject({
      intervalCreatedCount: 0,
      supersededInPlaceCount: 1,
      membershipCreatedCount: 1,
      idempotentMembershipCount: 1,
      membershipUpdatedCount: 0,
      noOp: false,
    });
    const intervals = db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all();
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ coverageStatus: 'active', scopeDigest: '7'.repeat(64) });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toHaveLength(2);

    // (branch: identical) replaying the exact same grown content -> idempotent no-op.
    await expect(service.reconcileEvidence(sameKeyChangedPlan('7'.repeat(64)))).resolves.toMatchObject({
      intervalCreatedCount: 0,
      supersededInPlaceCount: 0,
      membershipCreatedCount: 0,
      membershipUpdatedCount: 0,
      idempotentIntervalCount: 1,
      idempotentMembershipCount: 2,
      noOp: true,
    });

    // (branch: restatement) equal as-of, same-day restatement of an existing member's numbers ->
    // supersede in place and refresh that member's evidence rather than erroring.
    const restated = await service.reconcileEvidence(sameKeyChangedPlan('8'.repeat(64), { restated: true }));
    expect(restated).toMatchObject({
      supersededInPlaceCount: 1,
      membershipUpdatedCount: 1,
      membershipCreatedCount: 0,
      idempotentMembershipCount: 1,
      noOp: false,
    });
    // The company product remains eligible after the in-place supersession.
    await expect(service.evaluateProductMonth(scope)).resolves.toMatchObject({
      eligible: true,
      reasonCode: 'eligible_complete_month',
    });
  });

  /**
   * Issue 062. Sellerboard serves two report families per night into ONE key space: the stock
   * report (as-of = tonight) mints the current-month key every night and supersedes yesterday's,
   * while the month-to-date profit report lags two days and therefore always re-serves a key the
   * stock lineage just superseded. The same-natural-key branch treated any non-active match as a
   * fatal conflict, which rolled back entire scheduled nights. These tests walk the month rollover
   * night by night — the case that makes the July gap unrecoverable after Aug 1.
   */
  const NIGHT_WALK_METRIC_SET = 'sellerboard_units_net_profit_v1';

  function nightWalkKey(monthStart: string, asOf: string) {
    return `coverage:source-1:account-1:${NIGHT_WALK_METRIC_SET}:${monthStart}:${asOf}`;
  }

  function nightWalkDigest(seed: string) {
    return seed
      .replace(/[^a-f0-9]/g, '')
      .padEnd(64, '0')
      .slice(0, 64);
  }

  // The nightly stock report: as-of is tonight, evidence carries no by-day profit rows.
  function stockNightPlan(monthStart: string, asOf: string): CoverageEvidencePlan {
    return nightPlan('stock', monthStart, asOf, false);
  }

  // The month-to-date profit report: as-of lags two days behind the run night.
  function profitNightPlan(monthStart: string, asOf: string): CoverageEvidencePlan {
    return nightPlan('profit', monthStart, asOf, true);
  }

  function nightPlan(
    kind: 'stock' | 'profit',
    monthStart: string,
    asOf: string,
    continuousCoverage: boolean,
  ): CoverageEvidencePlan {
    const intervalNaturalKey = nightWalkKey(monthStart, asOf);
    return {
      intervals: [
        {
          naturalKey: intervalNaturalKey,
          sourceConnectionId: scope.sourceConnectionId,
          companyId: scope.companyId,
          amazonAccountId: scope.amazonAccountId,
          marketplace: scope.marketplace,
          coveredStartDate: monthStart,
          coveredEndDate: asOf,
          continuousCoverage,
          sourceAsOfDate: asOf,
          sourceVersion: asOf,
          importRunId: `run-${kind}-${asOf}`,
          inputDigest: nightWalkDigest(`${kind}-input-${asOf}`),
          scopeDigest: nightWalkDigest(`${kind}-scope-${asOf}`),
          evidenceJson: { reportKind: kind },
        },
      ],
      memberships: [
        {
          intervalNaturalKey,
          companyProductId: scope.companyProductId,
          monthStart,
          scopeEvidenceKinds: [kind === 'stock' ? 'stock_daily' : 'profit_by_product_daily'],
          scopeEvidenceDigest: nightWalkDigest(`${kind}-member-${asOf}`),
          sourceMetricRowCount: kind === 'stock' ? 0 : 30,
          normalizedFactLinkCount: kind === 'stock' ? 0 : 30,
          metricReconciliationStatus: 'complete',
          metricEvidenceDigest: nightWalkDigest(`${kind}-metric-${asOf}`),
        },
      ],
    };
  }

  it('walks the July/August month rollover: skips a superseded same-key re-serve, still supersedes the active head', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseSourceCoverageService(db);
    const intervalRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals);

    // Jul 30 + Jul 31 nights: the stock report mints the July key and supersedes yesterday's.
    await expect(service.reconcileEvidence(stockNightPlan('2026-07-01', '2026-07-30'))).resolves.toMatchObject({
      intervalCreatedCount: 1,
    });
    await expect(service.reconcileEvidence(stockNightPlan('2026-07-01', '2026-07-31'))).resolves.toMatchObject({
      intervalCreatedCount: 1,
      supersededIntervalCount: 1,
    });
    const supersededBefore = { ...intervalRepo.all().find((row) => row.sourceAsOfDate === '2026-07-30') };
    expect(supersededBefore).toMatchObject({ coverageStatus: 'superseded' });

    // Aug 1 night: the profit report's data date is 07-30 — the key the stock lineage superseded
    // yesterday. An ACTIVE July head (as-of 07-31) covers that window, so this is a quiet skip.
    const aug1 = await service.reconcileEvidence(profitNightPlan('2026-07-01', '2026-07-30'));
    expect(aug1).toMatchObject({
      intervalCreatedCount: 0,
      membershipCreatedCount: 0,
      supersededIntervalCount: 0,
      supersededInPlaceCount: 0,
      membershipUpdatedCount: 0,
      noOp: true,
    });
    expect(aug1.coverageSkippedStale).toEqual([
      {
        metricSet: NIGHT_WALK_METRIC_SET,
        incomingAsOf: '2026-07-30',
        heldAsOf: '2026-07-30',
        window: '2026-07-01..2026-07-30',
        heldCoverageStatus: 'superseded',
        coveringActiveKey: nightWalkKey('2026-07-01', '2026-07-31'),
        incomingInputDigest: nightWalkDigest('profit-input-2026-07-30'),
        incomingScopeDigest: nightWalkDigest('profit-scope-2026-07-30'),
        heldInputDigest: nightWalkDigest('stock-input-2026-07-30'),
        heldScopeDigest: nightWalkDigest('stock-scope-2026-07-30'),
      },
    ]);
    // MUST-NOT 1/2: the superseded provenance row is neither mutated nor resurrected, and no row
    // was added for the skipped report.
    expect(intervalRepo.all()).toHaveLength(2);
    expect(intervalRepo.all().find((row) => row.sourceAsOfDate === '2026-07-30')).toEqual(supersededBefore);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toHaveLength(2);

    // Aug 2 night: the profit report's data date is 07-31 — the ACTIVE July head. The existing
    // supersede-in-place branch still fires and hands July's head to the profit evidence.
    const aug2 = await service.reconcileEvidence(profitNightPlan('2026-07-01', '2026-07-31'));
    expect(aug2).toMatchObject({
      intervalCreatedCount: 0,
      supersededInPlaceCount: 1,
      membershipUpdatedCount: 1,
      noOp: false,
    });
    expect(aug2.coverageSkippedStale).toEqual([]);
    expect(intervalRepo.all().find((row) => row.naturalKey === nightWalkKey('2026-07-01', '2026-07-31'))).toMatchObject(
      {
        coverageStatus: 'active',
        continuousCoverage: true,
        inputDigest: nightWalkDigest('profit-input-2026-07-31'),
        importRunId: 'run-profit-2026-07-31',
      },
    );

    // Aug 1..Aug 3 nights, August lineage: the stock report mints and supersedes August keys while
    // July's head stays untouched (no overlap, so no lineage branch).
    await service.reconcileEvidence(stockNightPlan('2026-08-01', '2026-08-01'));
    await service.reconcileEvidence(stockNightPlan('2026-08-01', '2026-08-02'));
    await service.reconcileEvidence(stockNightPlan('2026-08-01', '2026-08-03'));

    // Aug 3 night: the profit report's data date is 08-01, superseded inside the August lineage.
    const aug3 = await service.reconcileEvidence(profitNightPlan('2026-08-01', '2026-08-01'));
    expect(aug3).toMatchObject({ intervalCreatedCount: 0, noOp: true });
    expect(aug3.coverageSkippedStale).toEqual([
      expect.objectContaining({
        incomingAsOf: '2026-08-01',
        heldCoverageStatus: 'superseded',
        coveringActiveKey: nightWalkKey('2026-08-01', '2026-08-03'),
      }),
    ]);
    expect(intervalRepo.all().filter((row) => row.coverageStatus === 'active')).toHaveLength(2);
  });

  it('skips a superseded same-key re-serve whether digests match or differ, and fails closed for an orphan', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseSourceCoverageService(db);
    await service.reconcileEvidence(stockNightPlan('2026-07-01', '2026-07-30'));
    await service.reconcileEvidence(stockNightPlan('2026-07-01', '2026-07-31'));

    // Identical digests: since dad51a40b9 gated the idempotent branch on `active`, even a byte-for-
    // byte replay of the superseded row threw. It must skip.
    const identical = await service.reconcileEvidence(stockNightPlan('2026-07-01', '2026-07-30'));
    expect(identical).toMatchObject({ intervalCreatedCount: 0, supersededInPlaceCount: 0, noOp: true });
    expect(identical.coverageSkippedStale).toEqual([
      expect.objectContaining({
        heldCoverageStatus: 'superseded',
        incomingInputDigest: nightWalkDigest('stock-input-2026-07-30'),
        heldInputDigest: nightWalkDigest('stock-input-2026-07-30'),
      }),
    ]);

    // Different digests (the real incident: stock evidence held, profit evidence incoming).
    const differing = await service.reconcileEvidence(profitNightPlan('2026-07-01', '2026-07-30'));
    expect(differing).toMatchObject({ intervalCreatedCount: 0, noOp: true });
    expect(differing.coverageSkippedStale).toHaveLength(1);

    // Orphan: a superseded row whose scope has no ACTIVE interval covering the incoming window
    // must keep failing closed rather than skipping silently.
    const orphanDb = new MemoryDatabase();
    const orphanService = new EcobaseSourceCoverageService(orphanDb);
    await seedInterval(orphanDb, {
      id: 'orphan-interval',
      naturalKey: nightWalkKey('2026-07-01', '2026-07-30'),
      coveredStartDate: '2026-07-01',
      coveredEndDate: '2026-07-30',
      continuousCoverage: false,
      sourceAsOfDate: '2026-07-30',
      sourceVersion: '2026-07-30',
      inputDigest: nightWalkDigest('stock-input-2026-07-30'),
      scopeDigest: nightWalkDigest('stock-scope-2026-07-30'),
      coverageStatus: 'superseded',
    });
    await expect(orphanService.reconcileEvidence(profitNightPlan('2026-07-01', '2026-07-30'))).rejects.toMatchObject({
      code: 'ECOBASE_COVERAGE_CONFLICT',
      details: {
        heldCoverageStatus: 'superseded',
        heldInputDigest: nightWalkDigest('stock-input-2026-07-30'),
        incomingInputDigest: nightWalkDigest('profit-input-2026-07-30'),
      },
    });
    expect(orphanDb.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toHaveLength(1);
  });
});
