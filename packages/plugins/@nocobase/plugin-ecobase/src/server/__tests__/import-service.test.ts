import { describe, expect, it } from 'vitest';
import { createSourceAdapterRegistry, noopTestAdapter } from '../adapters';
import type { SourceAdapter } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseDatabase, EcobaseImportService, EcobaseRepository } from '../services/import-service';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    const filtered = this.filterRecords(params);
    return this.sortRecords(filtered, params.sort).slice(0, params.limit ?? filtered.length);
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    const record = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(record);
    return record;
  }

  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error(`MemoryRepository update failed: matching record was not found.`);
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  all() {
    return this.records;
  }

  private filterRecords(params: FindParams) {
    if (params.filterByTk) {
      return this.records.filter((record) => record.id === params.filterByTk);
    }
    const filter = params.filter ?? {};
    return this.records.filter((record) => Object.entries(filter).every(([key, expected]) => record[key] === expected));
  }

  private sortRecords(records: Record<string, unknown>[], sort: string[] = []) {
    const [firstSort] = sort;
    if (!firstSort) {
      return records;
    }
    const descending = firstSort.startsWith('-');
    const key = descending ? firstSort.slice(1) : firstSort;
    return [...records].sort((left, right) => {
      const leftValue = String(left[key] ?? '');
      const rightValue = String(right[key] ?? '');
      if (leftValue === rightValue) {
        return 0;
      }
      const result = leftValue > rightValue ? 1 : -1;
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor() {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository()));
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) {
      throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    }
    return repository;
  }
}

function createServiceWithSourceConnection() {
  const db = new MemoryDatabase();
  const sourceConnectionRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
  sourceConnectionRepo.create({
    values: {
      id: 'source-1',
      name: 'No-op source',
      sourceType: 'noop_test',
      domain: 'foundation',
      config: {},
      active: true,
    },
  });
  return {
    db,
    service: new EcobaseImportService(db, createSourceAdapterRegistry([noopTestAdapter])),
  };
}

describe('Ecobase no-op import and status seam', () => {
  it('creates an auditable completed import run with zero rows', async () => {
    const { db, service } = createServiceWithSourceConnection();

    const run = await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      sourceConnectionId: 'source-1',
      adapterName: 'noop-test',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
      idempotencyKey: 'source-1:manual-noop:v1',
      status: 'success',
      rowCount: 0,
      normalizedCount: 0,
      warningCount: 0,
      errorCount: 0,
    });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([]);
  });

  it('reuses the same run for the same source version and idempotency key', async () => {
    const { db, service } = createServiceWithSourceConnection();

    const first = await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });
    const second = await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });

    expect(second.id).toBe(first.id);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(1);
  });

  it('rejects source connections that do not match the selected adapter source type and domain', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'sellerboard-source',
        name: 'Sellerboard source',
        sourceType: 'sellerboard',
        domain: 'profitability',
        config: {},
        active: true,
      },
    });
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([noopTestAdapter]));

    await expect(
      service.runNoopImport({
        sourceConnectionId: 'sellerboard-source',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
      }),
    ).rejects.toThrow(
      'Ecobase import failed: source connection "sellerboard-source" has sourceType "sellerboard" but adapter "noop-test" requires "noop_test".',
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([]);
  });

  it('rejects source connections with unsupported domains before creating an import run', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'wrong-domain-source',
        name: 'Wrong domain source',
        sourceType: 'noop_test',
        domain: 'sellerboard',
        config: {},
        active: true,
      },
    });
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([noopTestAdapter]));

    await expect(
      service.runNoopImport({
        sourceConnectionId: 'wrong-domain-source',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
      }),
    ).rejects.toThrow(
      'Ecobase import failed: source connection "wrong-domain-source" has domain "sellerboard" but adapter "noop-test" supports domains: foundation.',
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([]);
  });

  it('rejects invalid generic supplier lead-time imports before persistence', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'Supplier lead-time source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const invalidLeadTimeAdapter: SourceAdapter = {
      metadata: {
        name: 'invalid-lead-time-test',
        title: 'Invalid lead-time test',
        sourceType: 'noop_test',
        supportedDomains: ['foundation'],
        version: '1',
      },
      async *import() {
        yield {
          type: 'record',
          rowNumber: 1,
          sourceKey: 'lead-times.csv:1',
          payload: { supplierName: 'Bad Supplier', leadTimeDays: -1 },
          record: {
            kind: 'supplier_lead_time',
            data: {
              naturalKey: 'supplier-lead-time:Ecofission LLC:bad-supplier',
              sourceConnectionId: 'source-1',
              supplierName: 'Bad Supplier',
              company: 'Ecofission LLC',
              leadTimeDays: -1,
              source: 'test',
            },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([invalidLeadTimeAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'invalid-lead-time-test',
      sourceIdentifier: 'invalid-lead-time',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      status: 'failed',
      errorCount: 1,
      errorMessage: 'Ecobase import failed: supplier_lead_time: leadTimeDays must be an integer from 0 to 3650.',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).all()).toEqual([]);
  });

  it('rejects invalid planning-parameter lead-time imports before persistence', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'Planning parameter source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const invalidPlanningParameterAdapter: SourceAdapter = {
      metadata: {
        name: 'invalid-planning-parameter-test',
        title: 'Invalid planning parameter test',
        sourceType: 'noop_test',
        supportedDomains: ['foundation'],
        version: '1',
      },
      async *import() {
        yield {
          type: 'record',
          rowNumber: 1,
          sourceKey: 'profit-planning.csv:1',
          payload: { asin: 'B00BADLEAD', leadTimeDays: 1.5 },
          record: {
            kind: 'planning_parameter',
            data: {
              naturalKey: 'planning-parameter:Ecofission LLC:B00BADLEAD',
              sourceConnectionId: 'source-1',
              company: 'Ecofission LLC',
              asin: 'B00BADLEAD',
              leadTimeDays: 1.5,
            },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([invalidPlanningParameterAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'invalid-planning-parameter-test',
      sourceIdentifier: 'invalid-planning-parameter',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      status: 'failed',
      errorCount: 1,
      errorMessage: 'Ecobase import failed: planning_parameter: leadTimeDays must be an integer from 0 to 3650.',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningParameters).all()).toEqual([]);
  });

  it('rejects non-number planning-parameter lead-time imports before persistence', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'Planning parameter source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const invalidPlanningParameterAdapter: SourceAdapter = {
      metadata: {
        name: 'invalid-planning-parameter-string-test',
        title: 'Invalid planning parameter string test',
        sourceType: 'noop_test',
        supportedDomains: ['foundation'],
        version: '1',
      },
      async *import() {
        yield {
          type: 'record',
          rowNumber: 1,
          sourceKey: 'profit-planning.csv:1',
          payload: { asin: 'B00STRINGLEAD', leadTimeDays: '4000' },
          record: {
            kind: 'planning_parameter',
            data: {
              naturalKey: 'planning-parameter:Ecofission LLC:B00STRINGLEAD',
              sourceConnectionId: 'source-1',
              company: 'Ecofission LLC',
              asin: 'B00STRINGLEAD',
              leadTimeDays: '4000',
            },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([invalidPlanningParameterAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'invalid-planning-parameter-string-test',
      sourceIdentifier: 'invalid-planning-parameter-string',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      status: 'failed',
      errorCount: 1,
      errorMessage: 'Ecobase import failed: planning_parameter: leadTimeDays must be a number.',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningParameters).all()).toEqual([]);
  });

  it('reads source/import status through the service seam used by the public API', async () => {
    const { service } = createServiceWithSourceConnection();
    await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });

    await expect(service.listSourceStatuses()).resolves.toEqual([
      expect.objectContaining({
        sourceConnectionId: 'source-1',
        connectionName: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        active: true,
        required: false,
        freshnessSlaMinutes: null,
        latestRunStatus: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        latestRunWarningCount: 0,
        errorCount: 0,
        latestWarning: null,
        warnings: [],
      }),
    ]);
  });

  it('surfaces stale source warnings from source-type freshness policies', async () => {
    const { db, service } = createServiceWithSourceConnection();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceWarningPolicies).create({
      values: {
        naturalKey: 'warning-policy:noop_test',
        sourceType: 'noop_test',
        freshnessSlaMinutes: 60,
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-success',
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
        idempotencyKey: 'source-1:manual-noop:v1',
        startedAt: '2025-01-01T00:00:00.000Z',
        finishedAt: '2025-01-01T00:10:00.000Z',
        status: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
    });

    const [status] = await service.listSourceStatuses();

    expect(status).toMatchObject({
      sourceConnectionId: 'source-1',
      required: false,
      freshnessSlaMinutes: 60,
      latestRunStatus: 'success',
      warningCount: 1,
      latestWarning: expect.objectContaining({ code: 'stale_successful_run' }),
    });
    expect(status.warnings).toEqual([
      expect.objectContaining({
        code: 'stale_successful_run',
        message: 'Latest successful import for source "No-op source" is stale.',
      }),
    ]);
  });

  it('surfaces failed latest run warnings separately from successful-run freshness', async () => {
    const { db, service } = createServiceWithSourceConnection();
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-success',
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
        idempotencyKey: 'source-1:manual-noop:v1',
        startedAt: '2025-06-01T00:00:00.000Z',
        finishedAt: '2025-06-01T00:10:00.000Z',
        status: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-failed',
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v2',
        idempotencyKey: 'source-1:manual-noop:v2',
        startedAt: '2025-06-02T00:00:00.000Z',
        finishedAt: '2025-06-02T00:10:00.000Z',
        status: 'failed',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 1,
        errorMessage: 'Boom',
      },
    });

    const [status] = await service.listSourceStatuses();

    expect(status).toMatchObject({
      latestImportRunId: 'run-failed',
      latestRunStatus: 'failed',
      warningCount: 1,
      latestWarning: expect.objectContaining({ code: 'failed_latest_run' }),
    });
    expect(status.warnings).toEqual([
      expect.objectContaining({
        code: 'failed_latest_run',
        importRunId: 'run-failed',
        message: 'Latest import for source "No-op source" failed.',
      }),
    ]);
  });
});
