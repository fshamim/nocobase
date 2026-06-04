import { describe, expect, it, vi } from 'vitest';
import { createSourceAdapterRegistry, noopTestAdapter } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseImportActions } from '../plugin';
import { EcobaseDatabase, EcobaseRepository } from '../services/import-service';

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

function createActionContext(db: EcobaseDatabase, values: Record<string, unknown> = {}) {
  return {
    action: { params: { values } },
    db,
    body: undefined,
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

describe('Ecobase import public API seam', () => {
  it('runs the no-op import through resource actions and reads source status', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));

    const runContext = createActionContext(db, {
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });
    const runNext = vi.fn();
    await actions.runNoop(runContext, runNext);

    expect(runContext.body).toMatchObject({
      data: {
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
      },
    });
    expect(runNext).toHaveBeenCalledOnce();

    const statusContext = createActionContext(db);
    const statusNext = vi.fn();
    await actions.status(statusContext, statusNext);

    expect(statusContext.body).toEqual({
      data: [
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
      ],
    });
    expect(statusNext).toHaveBeenCalledOnce();
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([]);
  });

  it('rejects run requests without sourceConnectionId', async () => {
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(new MemoryDatabase());

    await expect(actions.runNoop(context, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'Ecobase no-op import requires sourceConnectionId.',
    });
  });

  it('lists available adapters through the public action', async () => {
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(new MemoryDatabase());
    const next = vi.fn();

    await actions.adapters(context, next);

    expect(context.body).toEqual({
      data: [
        expect.objectContaining({
          name: 'noop-test',
          sourceType: 'noop_test',
          title: 'No-op test adapter',
        }),
      ],
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
