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
