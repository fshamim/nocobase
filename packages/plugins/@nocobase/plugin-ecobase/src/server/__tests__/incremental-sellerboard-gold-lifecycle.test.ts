/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { createSourceAdapterRegistry, type SourceAdapter } from '../../features/source-import/server/adapters';
import { EcobaseGoldRefreshRunService } from '../../features/inventory-planning/server/gold-refresh-run-service';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import {
  EcobaseImportService,
  type EcobaseDatabase,
  type EcobaseRepository,
} from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Row = Record<string, unknown>;
type MemoryTransaction = { id: string; snapshot?: Map<string, Row[]> };
type FindParams = {
  filter?: Row;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
  offset?: number;
  transaction?: MemoryTransaction;
};

function matches(row: Row, filter: Row = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const operator = value as { $in?: unknown[]; $ne?: unknown };
      if (Array.isArray(operator.$in)) return operator.$in.includes(row[key]);
      if ('$ne' in operator) return row[key] !== operator.$ne;
    }
    return row[key] === value;
  });
}

class MemoryRepository implements EcobaseRepository {
  constructor(
    private readonly name: string,
    readonly rows: Row[],
    private readonly recordWrite: (transaction: unknown) => void,
  ) {}

  async find(params: FindParams = {}) {
    const source = params.transaction?.snapshot?.get(this.name) ?? this.rows;
    let rows = source.filter(
      (row) => (params.filterByTk === undefined || row.id === params.filterByTk) && matches(row, params.filter),
    );
    for (const sort of [...(params.sort ?? [])].reverse()) {
      const descending = sort.startsWith('-');
      const key = descending ? sort.slice(1) : sort;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
        return descending ? -comparison : comparison;
      });
    }
    const offset = params.offset ?? 0;
    return rows.slice(offset, offset + (params.limit ?? rows.length));
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values, transaction }: { values: Row; transaction?: unknown }) {
    this.recordWrite(transaction);
    const row = { id: values.id ?? `row-${this.rows.length + 1}`, ...values };
    this.rows.push(row);
    const snapshotRows = (transaction as MemoryTransaction | undefined)?.snapshot?.get(this.name);
    snapshotRows?.push(structuredClone(row));
    return row;
  }

  async update({ filter, filterByTk, values, transaction }: { filter?: Row; filterByTk?: string | number; values: Row; transaction?: unknown }) {
    this.recordWrite(transaction);
    const findTarget = (rows: Row[]) =>
      rows.find(
        (candidate) => (filterByTk === undefined || candidate.id === filterByTk) && matches(candidate, filter),
      );
    const row = findTarget(this.rows);
    if (!row) throw new Error('Memory repository update target was not found.');
    Object.assign(row, values);
    const snapshotRows = (transaction as MemoryTransaction | undefined)?.snapshot?.get(this.name);
    const snapshotRow = snapshotRows ? findTarget(snapshotRows) : undefined;
    if (snapshotRow) Object.assign(snapshotRow, structuredClone(values));
    return row;
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private readonly repositories = new Map<string, MemoryRepository>();
  readonly writeTransactions: unknown[] = [];
  readonly transactionTokens: MemoryTransaction[] = [];
  readonly transactionOptions: Row[] = [];
  activeTransactionCount = 0;
  onRepeatableReadSnapshot: (() => void) | undefined;
  readonly sequelize = {
    getDialect: () => 'postgres',
    query: async () => [],
    transaction: async <T>(
      optionsOrCallback: Row | ((transaction: MemoryTransaction) => Promise<T>),
      optionalCallback?: (transaction: MemoryTransaction) => Promise<T>,
    ) => {
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback;
      if (!callback) throw new Error('Memory transaction callback is required.');
      const rollbackSnapshot = new Map(
        [...this.repositories].map(([name, repository]) => [name, structuredClone(repository.rows)]),
      );
      const repeatableRead = options.isolationLevel === 'REPEATABLE READ';
      const transaction: MemoryTransaction = {
        id: `transaction-${this.transactionTokens.length + 1}`,
        ...(repeatableRead ? { snapshot: structuredClone(rollbackSnapshot) } : {}),
      };
      this.transactionTokens.push(transaction);
      this.activeTransactionCount += 1;
      if (repeatableRead) {
        this.transactionOptions.push(options);
        const hook = this.onRepeatableReadSnapshot;
        this.onRepeatableReadSnapshot = undefined;
        hook?.();
      }
      try {
        return await callback(transaction);
      } catch (error) {
        for (const [name, repository] of this.repositories) {
          repository.rows.splice(0, repository.rows.length, ...structuredClone(rollbackSnapshot.get(name) ?? []));
        }
        throw error;
      } finally {
        this.activeTransactionCount -= 1;
      }
    },
  };

  getRepository(name: string) {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryRepository(name, [], (transaction) => this.writeTransactions.push(transaction));
      this.repositories.set(name, repository);
    }
    return repository;
  }

  rows(name: string) {
    return this.getRepository(name).rows;
  }

  resetWriteEvidence() {
    this.writeTransactions.length = 0;
  }
}

function seedGoldFixture(db: MemoryDatabase) {
  db.rows(ECOBASE_COLLECTIONS.silverCompanies).push({ id: 'company-1', name: 'ACME' });
  db.rows(ECOBASE_COLLECTIONS.silverAmazonAccounts).push({
    id: 'account-1',
    companyId: 'company-1',
    marketplace: 'Amazon.com',
  });
  db.rows(ECOBASE_COLLECTIONS.silverProducts).push({
    id: 'product-1',
    asin: 'B000000001',
    sku: 'SKU-1',
    title: 'Snapshot product',
  });
  db.rows(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).push({
    id: 'family-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    marketplace: 'Amazon.com',
    canonicalAsin: 'B000000001',
    replenishmentTargetCompanyProductId: 'company-product-1',
    targetSelectionEvidenceJson: { source: 'test' },
  });
  db.rows(ECOBASE_COLLECTIONS.silverCompanyProducts).push({
    id: 'company-product-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    productId: 'product-1',
    companyProductFamilyId: 'family-1',
    lifecycleStatus: 'active',
  });
  db.rows(ECOBASE_COLLECTIONS.sourceConnections).push({
    id: 'sellerboard-1',
    companyId: 'company-1',
    sourceType: 'sellerboard',
    active: true,
  });
  db.rows(ECOBASE_COLLECTIONS.silverInventorySnapshots).push({
    id: 'inventory-1',
    companyProductId: 'company-product-1',
    sourceConnectionId: 'sellerboard-1',
    snapshotDate: '2026-07-16',
    sellableStock: 10,
    reserved: 0,
    inbound: 0,
    ordered: 0,
    prepStock: 0,
    awdStock: 0,
  });
  const dates = [
    '2026-01-01',
    '2026-02-01',
    '2026-03-01',
    '2026-04-01',
    '2026-05-01',
    '2026-06-01',
    '2026-07-16',
  ];
  db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts).push(
    ...dates.map((snapshotDate, index) => ({
      id: `fact-${index + 1}`,
      companyProductId: 'company-product-1',
      snapshotDate,
      units: 10,
      netProfit: 300,
      profit: 300,
    })),
  );
  db.rows(ECOBASE_COLLECTIONS.sourceCoverageIntervals).push({
    id: 'coverage-1',
    sourceConnectionId: 'sellerboard-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    marketplace: 'Amazon.com',
    metricSet: 'sellerboard_units_net_profit_v1',
    coveredStartDate: '2026-01-01',
    coveredEndDate: '2026-07-16',
    continuousCoverage: true,
    sourceAsOfDate: '2026-07-16',
    sourceVersion: '2026-07-16',
    coverageStatus: 'active',
  });
  db.rows(ECOBASE_COLLECTIONS.sourceCoverageMemberships).push(
    ...[...dates.slice(0, 6), '2026-07-01'].map((monthStart, index) => ({
      id: `membership-${index + 1}`,
      coverageIntervalId: 'coverage-1',
      companyProductId: 'company-product-1',
      monthStart,
      membershipStatus: 'in_scope',
      metricReconciliationStatus: 'complete',
      normalizedFactLinkCount: 1,
    })),
  );
}

function sellerboardReportAdapter(
  attempts = new Map<string, number>(),
  onImport: (reportKind: string) => void = () => undefined,
): SourceAdapter {
  return {
    metadata: {
      name: 'sellerboard-report-test',
      title: 'Sellerboard report test',
      sourceType: 'sellerboard',
      supportedDomains: ['foundation'],
      version: '1',
    },
    async *import(input) {
      const reportKind = String(input.config.reportKind);
      const attempt = (attempts.get(reportKind) ?? 0) + 1;
      attempts.set(reportKind, attempt);
      onImport(reportKind);
      if (typeof input.config.transientFailures === 'number' && attempt <= input.config.transientFailures) {
        throw new Error('ECONNRESET: Sellerboard report fetch failed transiently.');
      }
      yield {
        type: 'record',
        rowNumber: 2,
        sourceKey: 'sellerboard-report:2',
        payload: { reportKind: input.config.reportKind, value: 10 },
        record: {
          kind: 'source_access_audit',
          data: {
            naturalKey: `${input.sourceConnectionId}:${String(input.config.reportKind)}:audit`,
            sourceConnectionId: input.sourceConnectionId,
            status: 'available',
          },
        },
      };
      if (input.config.failAfterFirst === true) {
        yield {
          type: 'record',
          rowNumber: 3,
          sourceKey: 'sellerboard-report:3',
          payload: { reportKind: input.config.reportKind, value: 'invalid' },
          record: {
            kind: 'source_access_audit',
            data: { sourceConnectionId: input.sourceConnectionId, status: 'invalid' },
          },
        };
      }
    },
  };
}

describe('incremental Sellerboard-to-Gold lifecycle', () => {
  it('commits one source/report unit atomically and reuses an identical completed import', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'sellerboard-1',
        name: 'Sellerboard one',
        sourceType: 'sellerboard',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    db.resetWriteEvidence();
    const adapterTransactionDepths: number[] = [];
    const service = new EcobaseImportService(
      db,
      createSourceAdapterRegistry([
        sellerboardReportAdapter(new Map(), () => adapterTransactionDepths.push(db.activeTransactionCount)),
      ]),
    );
    const input = {
      sourceConnectionId: 'sellerboard-1',
      adapterName: 'sellerboard-report-test',
      sourceIdentifier: 'sellerboard:profit_dashboard',
      sourceVersion: '2026-07-22',
      idempotencyKey: 'sellerboard-1:profit_dashboard:input-a',
      runtimeConfig: { reportKind: 'profit_dashboard' },
    };

    const first = await service.runAdapterImport(input);
    const replay = await service.runAdapterImport({
      ...input,
      sourceVersion: '2026-07-23',
      idempotencyKey: 'sellerboard-1:profit_dashboard:another-caller-key',
    });

    expect(first).toMatchObject({
      status: 'success',
      normalizedCount: 1,
      idempotencyKey: expect.stringMatching(/^sellerboard-1:profit_dashboard:[a-f0-9]{64}$/),
      summary: {
        medallionNormalization: { failed: 0, errors: [] },
        reportUnitInputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(replay).toMatchObject({ id: first.id, status: 'success', reused: true });
    expect(adapterTransactionDepths).toEqual([0, 0]);
    expect(db.rows(ECOBASE_COLLECTIONS.importRuns)).toHaveLength(1);
    expect(db.rows(ECOBASE_COLLECTIONS.bronzeSourceRecords)).toHaveLength(1);
    expect(db.rows(ECOBASE_COLLECTIONS.sourceAccessAudits)).toHaveLength(1);
    expect(db.transactionTokens).toHaveLength(1);
    expect(db.writeTransactions).not.toContain(undefined);
    expect(new Set(db.writeTransactions)).toEqual(new Set(db.transactionTokens));
  });

  it('binds an in-flight Gold refresh to one repeatable-read snapshot and sees a later import on the next refresh', async () => {
    const db = new MemoryDatabase();
    seedGoldFixture(db);
    db.onRepeatableReadSnapshot = () => {
      for (const fact of db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts)) {
        fact.netProfit = -300;
        fact.profit = -300;
      }
    };
    const service = new EcobaseInventoryPlanningService(db);

    const first = await service.refreshAndPublish({ requestedByUserId: 'operator-1' });
    const firstRunId = String((first.run as Row).id);
    const firstRow = db
      .rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .find((row) => row.refreshRunId === firstRunId);
    const second = await service.refreshAndPublish({ requestedByUserId: 'operator-1' });
    const secondRunId = String((second.run as Row).id);
    const secondRow = db
      .rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .find((row) => row.refreshRunId === secondRunId);

    expect(db.transactionOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ isolationLevel: 'REPEATABLE READ' })]),
    );
    expect(firstRunId).not.toBe(secondRunId);
    expect(firstRow).toMatchObject({ baselineTier: 'A' });
    expect(secondRow).toMatchObject({ baselineTier: 'D' });
    expect(first).toMatchObject({ published: true });
    expect(second).toMatchObject({ published: true });
  });

  it('reuses an unchanged published Gold input without creating another run or row cohort', async () => {
    const db = new MemoryDatabase();
    seedGoldFixture(db);
    const service = new EcobaseInventoryPlanningService(db);

    const first = await service.refreshAndPublish({ requestedByUserId: 'operator-1' });
    const replay = await service.refreshAndPublish({ requestedByUserId: 'operator-1' });
    const firstRun = first.run as Row;

    expect(first).toMatchObject({
      status: 'published',
      goldRunId: firstRun.id,
      inputDigest: firstRun.candidateInputDigest,
      reused: false,
    });
    expect(replay).toMatchObject({
      status: 'reused',
      goldRunId: firstRun.id,
      inputDigest: firstRun.candidateInputDigest,
      reused: true,
    });
    expect(db.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)).toHaveLength(1);
    expect(db.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)).toHaveLength(1);
  });

  it('publishes a structurally valid partial snapshot with missing evidence represented as unknown', async () => {
    const db = new MemoryDatabase();
    seedGoldFixture(db);
    db.rows(ECOBASE_COLLECTIONS.silverInventorySnapshots).length = 0;
    db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts).splice(5, 1);
    db.rows(ECOBASE_COLLECTIONS.sourceCoverageMemberships).splice(5, 1);
    const service = new EcobaseInventoryPlanningService(db);

    const result = await service.refreshAndPublish({ requestedByUserId: 'operator-1' });
    const row = db
      .rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .find((candidate) => candidate.refreshRunId === result.goldRunId);

    expect(result).toMatchObject({ status: 'published', published: true });
    expect(row).toMatchObject({
      inventoryAsOfDate: null,
      onHandSellableStock: null,
      amazonPipelineStock: null,
      inventoryPositionStock: null,
      futurePositionStock: null,
      newReplenishmentActionable: false,
    });
    expect(row?.monthlyPerformanceEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monthStart: '2026-06-01',
          eligible: false,
          reasonCode: 'product_scope_unknown',
          monthlyUnits: null,
          monthlyProfit: null,
        }),
      ]),
    );
  });

  it('rejects duplicate, invalid, count-mismatched, and digest-mismatched Gold candidates at one boundary', async () => {
    const cases: Array<[string, (db: MemoryDatabase, run: Row, row: Row) => void]> = [
      [
        'duplicate natural key',
        (db, _run, row) => {
          db.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).push({ ...structuredClone(row), id: 'duplicate-row' });
        },
      ],
      ['invalid numeric value', (_db, _run, row) => Object.assign(row, { recommendedOrderQty: Number.NaN })],
      ['listing count mismatch', (_db, run) => Object.assign(run, { rowCount: 2, listingRowCount: 2 })],
      ['listing digest mismatch', (_db, run) => Object.assign(run, { listingRowDigest: '0'.repeat(64) })],
    ];

    for (const [name, mutate] of cases) {
      const db = new MemoryDatabase();
      seedGoldFixture(db);
      const materialized = await new EcobaseInventoryPlanningService(db).refreshReadModel({
        calculationDate: '2026-07-16',
        idempotencyKey: `boundary-${name}`,
      });
      const run = materialized.run as Row;
      const row = db
        .rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
        .find((candidate) => candidate.refreshRunId === run.id);
      if (!row) throw new Error(`Boundary fixture ${name} did not materialize a row.`);
      mutate(db, run, row);

      await expect(new EcobaseGoldRefreshRunService(db).verifyAndPublish(String(run.id)), name).rejects.toMatchObject({
        code: 'ECOBASE_GOLD_BOUNDARY_VALIDATION_FAILED',
      });
      expect(
        db.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).filter((candidate) => candidate.status === 'published'),
        name,
      ).toEqual([]);
    }
  });

  it('retains the previous published Gold pointer when atomic publication fails', async () => {
    const db = new MemoryDatabase();
    seedGoldFixture(db);
    const service = new EcobaseInventoryPlanningService(db);
    const first = await service.refreshAndPublish({ requestedByUserId: 'operator-1' });
    for (const fact of db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts)) fact.netProfit = 301;
    const runRepository = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns);
    const update = runRepository.update.bind(runRepository);
    runRepository.update = async (params) => {
      if (params.values.status === 'published' && String(params.filterByTk) !== first.goldRunId) {
        throw new Error('Injected publication write failure.');
      }
      return update(params);
    };

    const failed = await service.refreshAndPublish({ requestedByUserId: 'operator-1' });
    const published = db
      .rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)
      .filter((run) => run.status === 'published');

    expect(failed).toEqual({
      status: 'failed',
      code: 'ECOBASE_GOLD_AUTOMATIC_PUBLICATION_FAILED',
      previousPublicationRetained: true,
    });
    expect(published).toEqual([expect.objectContaining({ id: first.goldRunId })]);
  });

  it('retries only a transiently failed report unit and does not retry a non-retryable failure', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'sellerboard-1',
        name: 'Sellerboard one',
        sourceType: 'sellerboard',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    db.resetWriteEvidence();
    const attempts = new Map<string, number>();
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([sellerboardReportAdapter(attempts)]));
    const successful = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-1',
      adapterName: 'sellerboard-report-test',
      sourceIdentifier: 'sellerboard:profit_dashboard',
      sourceVersion: '2026-07-22',
      idempotencyKey: 'sellerboard-1:profit_dashboard:input-a',
      runtimeConfig: { reportKind: 'profit_dashboard' },
    });
    const retried = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-1',
      adapterName: 'sellerboard-report-test',
      sourceIdentifier: 'sellerboard:stock_daily',
      sourceVersion: '2026-07-23',
      idempotencyKey: 'sellerboard-1:stock_daily:input-b',
      runtimeConfig: { reportKind: 'stock_daily', transientFailures: 1 },
    });
    const auditRepository = db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits);
    const createAudit = auditRepository.create.bind(auditRepository);
    let injectWriteFailure = true;
    auditRepository.create = async (createParams) => {
      if (injectWriteFailure) {
        injectWriteFailure = false;
        throw new Error('Sellerboard report constraint violation.');
      }
      return createAudit(createParams);
    };
    const failed = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-1',
      adapterName: 'sellerboard-report-test',
      sourceIdentifier: 'sellerboard:profit_by_product_daily',
      sourceVersion: '2026-07-24',
      idempotencyKey: 'sellerboard-1:profit_by_product_daily:input-c',
      runtimeConfig: { reportKind: 'profit_by_product_daily' },
    });

    expect(successful).toMatchObject({ status: 'success' });
    expect(retried).toMatchObject({
      status: 'success',
      summary: {
        reportUnitRetry: {
          attemptCount: 2,
          backoffMs: 25,
          classification: 'retryable_transient',
          outcome: 'recovered',
        },
      },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      errorMessage: 'Sellerboard report constraint violation.',
      summary: {
        reportUnitRetry: { attemptCount: 1, backoffMs: 0, classification: 'non_retryable' },
      },
    });
    expect(Object.fromEntries(attempts)).toEqual({
      profit_dashboard: 1,
      stock_daily: 2,
      profit_by_product_daily: 1,
    });

    const replayedFailure = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-1',
      adapterName: 'sellerboard-report-test',
      sourceIdentifier: 'sellerboard:profit_by_product_daily',
      sourceVersion: '2026-07-25',
      idempotencyKey: 'sellerboard-1:profit_by_product_daily:new-caller-key',
      runtimeConfig: { reportKind: 'profit_by_product_daily' },
    });

    expect(replayedFailure).toMatchObject({ id: failed.id, status: 'success', reused: false });
    expect(Object.fromEntries(attempts)).toEqual({
      profit_dashboard: 1,
      stock_daily: 2,
      profit_by_product_daily: 2,
    });
    expect(db.rows(ECOBASE_COLLECTIONS.importRuns)).toHaveLength(3);
    expect(db.rows(ECOBASE_COLLECTIONS.sourceAccessAudits)).toHaveLength(3);
  });
});
