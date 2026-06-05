import { describe, expect, it } from 'vitest';
import { clickupAccessCheckAdapter, clickupFixtureAdapter, createSourceAdapterRegistry } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseAccountabilityService } from '../services/accountability-service';
import { EcobaseDataWarningService } from '../services/data-warning-service';
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

  async update({ filter, filterByTk, values }: { filter?: Record<string, unknown>; filterByTk?: string | number; values: Record<string, unknown> }) {
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error('MemoryRepository update failed: matching record was not found.');
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

function createDb() {
  const db = new MemoryDatabase();
  db.getRepository(ECOBASE_COLLECTIONS.companies).create({
    values: { id: 'company-1', name: 'ACME', code: 'ACME', timezone: 'UTC' },
  });
  db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
    values: { id: 'product-1', company: 'ACME', canonicalAsin: 'B013TASK', title: 'Accountability SKU', mappingStatus: 'confirmed' },
  });
  return db;
}

describe('Ecobase accountability import and alert evaluation', () => {
  it('imports ClickUp task snapshots, links, OKRs, and creates deterministic accountability alerts', async () => {
    const db = createDb();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-clickup-1',
        name: 'ClickUp fixture',
        sourceType: 'clickup',
        domain: 'accountability',
        freshnessSlaMinutes: 60,
        config: {
          tasks: [
            {
              externalTaskId: 'CU-1',
              taskName: 'Contact supplier',
              status: 'open',
              priority: 'high',
              dueDate: '2026-06-03',
              lastMeaningfulUpdateAt: '2026-06-02T00:00:00.000Z',
              planningProductId: 'product-1',
              operationalArea: 'supplier_orders',
            },
          ],
          okrs: [{ externalOkrId: 'OKR-1', company: 'ACME', title: 'Restore stockouts', owner: 'ops', period: '2026-Q2' }],
          okrMetricSnapshots: [{ externalOkrId: 'OKR-1', metricName: 'OOS recovery', snapshotDate: '2026-06-05', progressPercent: 45, status: 'off_track' }],
        },
        active: true,
      },
    });

    const importService = new EcobaseImportService(db, createSourceAdapterRegistry([clickupFixtureAdapter]));
    const run = await importService.runAdapterImport({
      sourceConnectionId: 'source-clickup-1',
      adapterName: 'clickup-fixture',
      sourceIdentifier: 'manual-accountability',
      sourceVersion: '2026-06-05',
      idempotencyKey: 'source-clickup-1:manual-accountability:2026-06-05',
    });

    expect(run.status).toBe('success');
    expect(db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.taskLinks).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.okrs).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).all()).toHaveLength(1);

    const alerts = db.getRepository(ECOBASE_COLLECTIONS.alerts).all();
    expect(alerts.map((alert) => alert.primaryRootCauseCode).sort()).toEqual([
      'clickup_task_missing_owner',
      'clickup_task_overdue',
      'missing_operational_action_inactive_clickup',
      'okr_off_track',
    ]);
    expect(alerts.find((alert) => alert.primaryRootCauseCode === 'clickup_task_missing_owner')).toMatchObject({
      alertType: 'accountability',
      planningProductId: 'product-1',
      company: 'ACME',
      canonicalAsin: 'B013TASK',
      status: 'open',
    });
  });

  it('resolves stale task alerts when the latest snapshot becomes assigned, updated, and not overdue', async () => {
    const db = createDb();
    const taskRepo = db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots);
    taskRepo.create({
      values: {
        id: 'task-snapshot-1',
        naturalKey: 'task-1-old',
        sourceConnectionId: 'source-clickup-1',
        snapshotDate: '2026-06-05',
        externalTaskId: 'CU-1',
        taskName: 'Contact supplier',
        status: 'open',
        priority: 'high',
        dueDate: '2026-06-03',
        lastMeaningfulUpdateAt: '2026-06-02T00:00:00.000Z',
      },
    });

    const service = new EcobaseAccountabilityService(db);
    await service.evaluateAccountability({ sourceConnectionId: 'source-clickup-1', evaluationDate: '2026-06-05' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.alerts).all().filter((alert) => alert.status === 'open')).toHaveLength(3);

    taskRepo.create({
      values: {
        id: 'task-snapshot-2',
        naturalKey: 'task-1-new',
        sourceConnectionId: 'source-clickup-1',
        snapshotDate: '2026-06-06',
        externalTaskId: 'CU-1',
        taskName: 'Contact supplier',
        status: 'open',
        priority: 'high',
        assignee: 'Ops Owner',
        dueDate: '2026-06-08',
        lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
      },
    });

    await service.evaluateAccountability({ sourceConnectionId: 'source-clickup-1', evaluationDate: '2026-06-06' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.alerts).all().filter((alert) => alert.status === 'open')).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.alerts).all().filter((alert) => alert.status === 'resolved')).toHaveLength(3);
  });

  it('exposes scheduled no-newer-data skips as source warnings', async () => {
    const db = createDb();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-clickup-scheduled',
        name: 'ClickUp scheduled',
        sourceType: 'clickup',
        domain: 'accountability',
        config: {},
        active: true,
      },
    });
    db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-success',
        sourceConnectionId: 'source-clickup-scheduled',
        adapterName: 'clickup-fixture',
        sourceIdentifier: 'scheduled',
        sourceVersion: '2026-06-05',
        idempotencyKey: 'success',
        startedAt: new Date('2026-06-05T01:00:00.000Z'),
        finishedAt: new Date('2026-06-05T01:01:00.000Z'),
        status: 'success',
        rowCount: 1,
        normalizedCount: 1,
        warningCount: 0,
        errorCount: 0,
      },
    });
    db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-skipped',
        sourceConnectionId: 'source-clickup-scheduled',
        adapterName: 'clickup-fixture',
        sourceIdentifier: 'scheduled',
        sourceVersion: '2026-06-05',
        idempotencyKey: 'skipped',
        startedAt: new Date('2026-06-05T02:00:00.000Z'),
        finishedAt: new Date('2026-06-05T02:01:00.000Z'),
        status: 'skipped',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 1,
        errorCount: 0,
      },
    });

    const warnings = await new EcobaseDataWarningService(db).assessSourceConnection('source-clickup-scheduled', '2026-06-05');

    expect(warnings.warnings.map((warning) => warning.code)).toContain('no_newer_data_skipped');
  });

  it('records blocked ClickUp credential audits and exposes them as source warnings', async () => {
    const db = createDb();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-clickup-blocked',
        name: 'ClickUp live',
        sourceType: 'clickup',
        domain: 'accountability',
        config: { warningPolicy: { required: true } },
        active: true,
      },
    });

    const importService = new EcobaseImportService(db, createSourceAdapterRegistry([clickupAccessCheckAdapter]));
    await importService.runAdapterImport({
      sourceConnectionId: 'source-clickup-blocked',
      adapterName: 'clickup-access-check',
      sourceIdentifier: 'live-access',
      sourceVersion: '2026-06-05',
      idempotencyKey: 'source-clickup-blocked:live-access:2026-06-05',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits).all()).toHaveLength(1);
    const warnings = await new EcobaseDataWarningService(db).assessSourceConnection('source-clickup-blocked', '2026-06-05');
    expect(warnings.warnings.map((warning) => warning.code)).toContain('credential_blocked');
  });
});
