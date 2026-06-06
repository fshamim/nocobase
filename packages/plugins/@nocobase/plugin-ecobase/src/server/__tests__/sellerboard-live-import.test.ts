import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceAdapterRegistry, sellerboardApiAdapter } from '../adapters';
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
      if (leftValue === rightValue) return 0;
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

function sellerboardGoodsCsv(date: string, netProfit: number) {
  return `Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,Refunds,GrossProfit,NetProfit,Sessions,Unit Session Percentage\n${date},Amazon.com,B007P55HOW,DC50944,Dampp Chaser,63.40,3,0,20.1,${netProfit},30,10%`;
}

function createService(csv = sellerboardGoodsCsv('2026-06-05', 15.2)) {
  const db = new MemoryDatabase();
  db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: {
      id: 'sellerboard-source-1',
      name: 'Sellerboard live source',
      sourceType: 'sellerboard',
      domain: 'amazon_operations',
      config: {
        reportUrls: [
          {
            name: 'Profit by Product Dashboard Daily Data',
            category: 'profit_by_product_daily',
            url: 'https://sellerboard.test/report.csv?t=redacted',
          },
        ],
        schedule: { dailyRefreshTime: '09:00', retryIntervalMinutes: 60 },
        requireFreshData: true,
      },
      active: true,
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, text: async () => csv })),
  );
  return { db, service: new EcobaseImportService(db, createSourceAdapterRegistry([sellerboardApiAdapter])) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sellerboard live URL import', () => {
  it('fetches live Sellerboard CSV URLs and normalizes through the existing CSV path', async () => {
    const { db, service } = createService();

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'manual-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 2, warningCount: 0 });
    expect(fetch).toHaveBeenCalledWith('https://sellerboard.test/report.csv?t=redacted', { headers: {} });
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()[0].sourceKey).toContain('profit_by_product_daily');
  });

  it('marks scheduled imports stale and waits for retry when Sellerboard has not published fresh data yet', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-04', 15.2));

    const first = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });
    expect(first.results[0]).toMatchObject({ status: 'stale' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()[0]).toMatchObject({ status: 'stale' });

    const waiting = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:30:00.000Z' });
    expect(waiting.results[0]).toMatchObject({ status: 'waiting_retry', latestRunStatus: 'stale' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => sellerboardGoodsCsv('2026-06-05', 22.1) })),
    );
    const fresh = await service.runScheduledSellerboardImports({ now: '2026-06-05T23:02:00.000Z' });
    expect(fresh.results[0]).toMatchObject({ status: 'success' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all()).toHaveLength(1);
  });

  it('records a durable skipped run when scheduled same-day Sellerboard data was already imported', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));

    const first = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });
    expect(first.results[0]).toMatchObject({ status: 'success' });

    const second = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:02:00.000Z' });
    expect(second.results[0]).toMatchObject({ status: 'skipped' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([
      expect.objectContaining({ status: 'success', idempotencyKey: 'sellerboard-source-1:sellerboard-scheduled:2026-06-05' }),
      expect.objectContaining({ status: 'skipped' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all()).toHaveLength(1);
  });

  it('keeps mixed fresh and stale report runs retryable instead of marking the whole source fresh', async () => {
    const { db, service } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          reportUrls: [
            { name: 'Fresh report', category: 'profit_by_product_daily', url: 'https://sellerboard.test/fresh.csv' },
            { name: 'Stale report', category: 'profit_dashboard', url: 'https://sellerboard.test/stale.csv' },
          ],
          schedule: { dailyRefreshTime: '09:00', retryIntervalMinutes: 60 },
          requireFreshData: true,
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        text: async () => sellerboardGoodsCsv(url.includes('stale') ? '2026-06-04' : '2026-06-05', 18.4),
      })),
    );

    const run = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });

    expect(run.results[0]).toMatchObject({ status: 'stale' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits).all()).toEqual([
      expect.objectContaining({ status: 'stale', blockerCode: 'sellerboard_data_not_fresh' }),
    ]);

    const waiting = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:30:00.000Z' });
    expect(waiting.results[0]).toMatchObject({ status: 'waiting_retry', latestRunStatus: 'stale' });
  });

  it('records missing Sellerboard URL configuration as a credential blocker audit record', async () => {
    const { db, service } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: { config: {} },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'blocked', normalizedCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits).all()).toEqual([
      expect.objectContaining({ status: 'blocked', blockerCode: 'sellerboard_credentials_missing' }),
    ]);
  });

  it('ties invalid live Sellerboard CSV shapes to raw row errors on the import run', async () => {
    const { db, service } = createService('Unexpected,Header\nvalue,1');
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          reportUrls: [
            {
              name: 'Malformed report',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/malformed.csv?t=redacted',
            },
          ],
          requireFreshData: false,
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'failed', errorCount: 1, normalizedCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([
      expect.objectContaining({ issueCode: 'csv_shape_unknown', normalizedStatus: 'failed' }),
    ]);
  });

  it('ties row-level live Sellerboard CSV warnings to the import run while keeping valid sibling rows', async () => {
    const mixedCsv = `Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,Refunds,GrossProfit,NetProfit,Sessions,Unit Session Percentage
2026-06-05,Amazon.com,,,Missing Identity,10,1,0,4,3,5,20%
2026-06-05,Amazon.com,B007P55HOW,DC50944,Dampp Chaser,63.40,3,0,20.1,15.2,30,10%`;
    const { db, service } = createService(mixedCsv);

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([
      expect.objectContaining({ rowNumber: 2, issueCode: 'csv_row_identity_missing', issueSeverity: 'warning' }),
      expect.objectContaining({ rowNumber: 3, normalizedStatus: 'success' }),
    ]);
  });

  it('force-refresh overwrites same-day normalized snapshots instead of duplicating them', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));

    await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-force-refresh',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => sellerboardGoodsCsv('2026-06-05', 31.5) })),
    );
    await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-force-refresh',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    const facts = db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ netProfit: 31.5 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(2);
  });

  it('documents live-gate persistence defaults and destructive-reset guardrails', () => {
    const pluginRoot = resolve(__dirname, '../../..');
    const compose = readFileSync(resolve(pluginRoot, 'docker/live-gate.compose.yml'), 'utf8');
    const start = readFileSync(resolve(pluginRoot, 'scripts/start-live-gate.sh'), 'utf8');
    const stop = readFileSync(resolve(pluginRoot, 'scripts/stop-live-gate.sh'), 'utf8');
    const backup = readFileSync(resolve(pluginRoot, 'scripts/backup-live-gate-db.sh'), 'utf8');
    const startup = readFileSync(resolve(pluginRoot, 'docker/live-gate-startup.sh'), 'utf8');

    expect(compose).toContain('ecobase-live-gate-postgres:/var/lib/postgresql/data');
    expect(startup).toContain('existing QA database detected; preserving data');
    expect(startup).toContain('applicationVersion');
    expect(start).toContain('down --remove-orphans');
    expect(start).toContain('ECOBASE_LIVE_GATE_CONFIRM_DESTROY=destroy-live-sellerboard-data');
    expect(stop).toContain('down --remove-orphans');
    expect(stop).toContain('down --volumes --remove-orphans');
    expect(backup).toContain('pg_dump --username nocobase --dbname nocobase');
  });
});
