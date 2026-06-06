import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseOperatorWorkspaceService } from '../services/operator-workspace-service';

interface FindParams {
  filter?: Record<string, unknown>;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    const filtered = this.records.filter((record) =>
      Object.entries(params.filter ?? {}).every(([key, value]) => {
        if (value === undefined) {
          return true;
        }
        if (typeof value === 'object' && value !== null && Array.isArray((value as { $in?: unknown[] }).$in)) {
          return (value as { $in: unknown[] }).$in.includes(record[key]);
        }
        return record[key] === value;
      }),
    );
    return filtered.slice(0, params.limit ?? filtered.length);
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    const record = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(record);
    return record;
  }

  async update({ filter, filterByTk, values }: { filter?: Record<string, unknown>; filterByTk?: string | number; values: Record<string, unknown> }) {
    const records = filterByTk ? this.records.filter((record) => record.id === filterByTk) : await this.find({ filter });
    records.forEach((record) => Object.assign(record, values));
    return records;
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

describe('EcobaseOperatorWorkspaceService', () => {
  it('groups every plugin-owned collection with counts, warning evidence, and starter views', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.companies).create({
      values: { id: 'company-1', name: 'Ecofission LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.companies).create({
      values: { id: 'company-2', name: 'Other Co' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: 'source-1', companyId: 'company-1', sourceType: 'sellerboard' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: 'source-2', companyId: 'company-2', sourceType: 'sellerboard' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: { id: 'run-1', sourceConnectionId: 'source-1', status: 'success', startedAt: '2026-06-05T00:00:00.000Z' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: { id: 'run-2', sourceConnectionId: 'source-2', status: 'success', startedAt: '2026-06-05T00:00:00.000Z' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: { id: 'raw-1', importRunId: 'run-1', rowNumber: 1, payload: {}, issueSeverity: 'warning' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: { id: 'raw-2', importRunId: 'run-2', rowNumber: 1, payload: {}, issueSeverity: 'warning' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: { id: 'product-1', company: 'Ecofission LLC', canonicalAsin: 'B00TEST', mappingStatus: 'needs_review' },
    });

    const workspace = await new EcobaseOperatorWorkspaceService(db).getWorkspace({
      company: 'Ecofission LLC',
      sourceConnectionId: 'source-1',
    });

    expect(workspace.domains.map((domain) => domain.key)).toContain('source_import');
    expect(workspace.domains.flatMap((domain) => domain.collections).map((collection) => collection.collectionName)).toEqual(
      expect.arrayContaining([ECOBASE_COLLECTIONS.rawImportRows, ECOBASE_COLLECTIONS.planningProducts, ECOBASE_COLLECTIONS.aiAnswers]),
    );
    expect(workspace.domains.flatMap((domain) => domain.collections)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collectionName: ECOBASE_COLLECTIONS.rawImportRows, readOnly: true, rowCount: 1, warningCount: 1 }),
        expect.objectContaining({ collectionName: ECOBASE_COLLECTIONS.planningProducts, rowCount: 1, freshnessStatus: 'fresh' }),
      ]),
    );
    expect(workspace.starterViews.map((view) => view.key)).toEqual(
      expect.arrayContaining(['latest-products', 'oos-reorder-candidates', 'critical-alerts', 'stale-source-warnings']),
    );
    expect(workspace.starterViews.find((view) => view.key === 'latest-products')?.filters).toMatchObject({ company: 'Ecofission LLC' });

    const sourceOnlyWorkspace = await new EcobaseOperatorWorkspaceService(db).getWorkspace({ sourceConnectionId: 'source-1' });
    expect(sourceOnlyWorkspace.filters).toMatchObject({ company: 'Ecofission LLC', sourceConnectionId: 'source-1' });
    const sourceOnlyPreview = await new EcobaseOperatorWorkspaceService(db).previewView({
      viewKey: 'latest-products',
      filters: { sourceConnectionId: 'source-1' },
    });
    expect(sourceOnlyPreview.rows).toEqual([expect.objectContaining({ id: 'product-1', company: 'Ecofission LLC' })]);

    const unscopedWorkspace = await new EcobaseOperatorWorkspaceService(db).getWorkspace();
    expect(unscopedWorkspace.scopeRequired).toBe(true);
    expect(unscopedWorkspace.domains.flatMap((domain) => domain.collections)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collectionName: ECOBASE_COLLECTIONS.rawImportRows, rowCount: 0, freshnessStatus: 'scope_required' }),
      ]),
    );
    await expect(new EcobaseOperatorWorkspaceService(db).previewView({ collectionName: ECOBASE_COLLECTIONS.rawImportRows })).rejects.toThrow(
      'company or sourceConnectionId scope is required',
    );
  });

  it('previews scoped views and persists saved business view definitions without schema changes', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({
      values: { id: 'alert-1', company: 'Ecofission LLC', status: 'open', severity: 'critical', title: 'OOS risk' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({
      values: { id: 'alert-2', company: 'Other Co', status: 'open', severity: 'critical', title: 'Other risk' },
    });
    const service = new EcobaseOperatorWorkspaceService(db);

    const preview = await service.previewView({ viewKey: 'critical-alerts', filters: { company: 'Ecofission LLC' } });
    expect(preview.collectionName).toBe(ECOBASE_COLLECTIONS.alerts);
    expect(preview.rows).toEqual([expect.objectContaining({ id: 'alert-1', company: 'Ecofission LLC' })]);

    const saved = await service.saveBusinessView({
      key: 'saved-critical-alerts',
      title: 'Saved critical alerts',
      collectionName: ECOBASE_COLLECTIONS.alerts,
      columns: ['company', 'severity', 'title'],
      filters: { company: 'Ecofission LLC', status: 'open' },
      sort: ['-severity'],
      groupBy: ['company'],
    });
    const workspace = await service.getWorkspace({ company: 'Ecofission LLC' });

    expect(saved).toMatchObject({ key: 'saved-critical-alerts', collectionName: ECOBASE_COLLECTIONS.alerts, sort: ['-severity'], groupBy: ['company'] });
    expect(workspace.savedViews).toEqual([expect.objectContaining({ key: 'saved-critical-alerts', title: 'Saved critical alerts' })]);

    const savedPreview = await service.previewView({ viewKey: 'saved-critical-alerts', filters: { company: 'Ecofission LLC' } });
    expect(savedPreview.groupedRows).toEqual([{ key: { company: 'Ecofission LLC' }, rowCount: 1 }]);
  });
});
