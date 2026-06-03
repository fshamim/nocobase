import { describe, expect, it } from 'vitest';
import { createSourceAdapterRegistry, noopTestAdapter } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseDatabase, EcobaseImportService, EcobaseRepository } from '../services/import-service';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string;
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

  async update({ filterByTk, values }: { filterByTk: string; values: Record<string, unknown> }) {
    const record = this.records.find((item) => item.id === filterByTk);
    if (!record) {
      throw new Error(`MemoryRepository update failed: record ${filterByTk} was not found.`);
    }
    Object.assign(record, values);
    return record;
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
        latestRunStatus: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      }),
    ]);
  });
});
