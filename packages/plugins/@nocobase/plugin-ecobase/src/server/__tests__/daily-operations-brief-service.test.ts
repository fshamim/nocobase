import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseDailyOperationsBriefService } from '../services/daily-operations-brief-service';

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  constructor(private records: Record<string, unknown>[] = []) {}
  async find(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {}) {
    const rows = this.filterRecords(params);
    return this.sortRows(rows, params.sort).slice(0, params.limit ?? rows.length);
  }
  async findOne(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }
  async create({ values }: { values: Record<string, unknown> }) {
    const record = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(record);
    return record;
  }
  async update({ filter, filterByTk, values }: { filter?: Record<string, unknown>; filterByTk?: string | number; values: Record<string, unknown> }) {
    const rows = this.filterRecords({ filter, filterByTk });
    if (!rows.length) throw new Error('MemoryRepository update failed: record not found.');
    rows.forEach((row) => Object.assign(row, values));
    return rows[0];
  }
  private filterRecords(params: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    if (params.filterByTk) return this.records.filter((record) => record.id === params.filterByTk);
    const filter = params.filter ?? {};
    return this.records.filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value));
  }
  private sortRows(rows: Record<string, unknown>[], sort: string[] = []) {
    const [first] = sort;
    if (!first) return rows;
    const descending = first.startsWith('-');
    const key = descending ? first.slice(1) : first;
    return [...rows].sort((left, right) => {
      const result = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
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
    if (!repository) throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    return repository;
  }
}

function service(db = new MemoryDatabase()) {
  return { db, brief: new EcobaseDailyOperationsBriefService(db) };
}

async function seedProduct(db: MemoryDatabase, values: Record<string, unknown> = {}) {
  await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({ values: {
    id: values.id ?? 'product-1',
    naturalKey: values.naturalKey ?? 'ACME:B00FOCUS',
    company: values.company ?? 'ACME',
    canonicalAsin: values.canonicalAsin ?? 'B00FOCUS',
    sku: values.sku,
    title: values.title ?? 'Focus product',
  } });
}

describe('EcobaseDailyOperationsBriefService broader evidence focus', () => {
  it('chooses Buy Box focus from a deterministic win-rate drop', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-buybox', canonicalAsin: 'B00BUYBOX' });
    await db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).create({ values: { naturalKey: 'traffic-prior', sourceConnectionId: 'source-1', snapshotDate: '2026-06-09', asin: 'B00BUYBOX', buyBoxPercentage: 96, unitsOrdered: 20, orderedProductSales: 400 } });
    await db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).create({ values: { naturalKey: 'traffic-current', sourceConnectionId: 'source-1', snapshotDate: '2026-06-10', asin: 'B00BUYBOX', buyBoxPercentage: 52, unitsOrdered: 5, orderedProductSales: 100 } });

    const evidence = await brief.buildEvidencePack({ company: 'ACME', date: '2026-06-10', timezone: 'Asia/Karachi', maxItems: 10 });

    expect(evidence.focus).toBe('buybox');
    expect(evidence.buyBoxRisks).toEqual([expect.objectContaining({ asin: 'B00BUYBOX', currentBuyBoxWinRate: 52, baselineBuyBoxWinRate: 96, winRateDropPoints: 44 })]);
  });

  it('chooses velocity focus when units drop and inventory is not urgent', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-velocity', canonicalAsin: 'B00VELO' });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'fact-prior', sourceConnectionId: 'source-1', planningProductId: 'product-velocity', snapshotDate: '2026-06-09', company: 'ACME', asin: 'B00VELO', units: 20, sales: 400, netProfit: 120 } });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'fact-current', sourceConnectionId: 'source-1', planningProductId: 'product-velocity', snapshotDate: '2026-06-10', company: 'ACME', asin: 'B00VELO', units: 5, sales: 100, netProfit: 30 } });

    const evidence = await brief.buildEvidencePack({ company: 'ACME', date: '2026-06-10', timezone: 'Asia/Karachi', maxItems: 10 });

    expect(evidence.focus).toBe('velocity');
    expect(evidence.performanceTrends).toEqual([expect.objectContaining({ trendType: 'velocity_drop', asin: 'B00VELO', velocityDropPercent: 75 })]);
  });

  it('chooses profit-gap focus when target profit is missed without a velocity drop', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-profit', canonicalAsin: 'B00PROFIT' });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'profit-prior', sourceConnectionId: 'source-1', planningProductId: 'product-profit', snapshotDate: '2026-06-09', company: 'ACME', asin: 'B00PROFIT', units: 10, sales: 200, netProfit: 40 } });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'profit-current', sourceConnectionId: 'source-1', planningProductId: 'product-profit', snapshotDate: '2026-06-10', company: 'ACME', asin: 'B00PROFIT', units: 10, sales: 200, netProfit: 40 } });
    await db.getRepository(ECOBASE_COLLECTIONS.targetRows).create({ values: { naturalKey: 'profit-target', sourceConnectionId: 'source-1', planningProductId: 'product-profit', company: 'ACME', period: '2026-06', periodType: 'monthly', asin: 'B00PROFIT', profitTarget: 100 } });

    const evidence = await brief.buildEvidencePack({ company: 'ACME', date: '2026-06-10', timezone: 'Asia/Karachi', maxItems: 10 });

    expect(evidence.focus).toBe('profit_gap');
    expect(evidence.performanceTrends).toEqual([expect.objectContaining({ trendType: 'profit_gap', asin: 'B00PROFIT', profitGap: 60 })]);
  });

  it('chooses OKR focus for off-track OKR and stale task evidence', async () => {
    const { db, brief } = service();
    await db.getRepository(ECOBASE_COLLECTIONS.okrs).create({ values: { id: 'okr-1', naturalKey: 'okr-1', company: 'ACME', title: 'Recover Buy Box', owner: 'Ops', operationalArea: 'Marketplace', period: '2026-Q2', status: 'active' } });
    await db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).create({ values: { naturalKey: 'okr-snapshot-1', okrId: 'okr-1', snapshotDate: '2026-06-10', metricName: 'Buy Box recovery', progressPercent: 40, status: 'off_track', owner: 'Ops', operationalArea: 'Marketplace' } });
    await db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).create({ values: { naturalKey: 'task-snapshot-1', sourceConnectionId: 'source-1', snapshotDate: '2026-06-10', externalTaskId: 'CU-1', taskName: 'Contact marketplace owner', status: 'open', priority: 'high', assignee: 'Ops', dueDate: '2026-06-08', lastMeaningfulUpdateAt: '2026-06-05T00:00:00.000Z' } });

    const evidence = await brief.buildEvidencePack({ company: 'ACME', date: '2026-06-10', timezone: 'Asia/Karachi', maxItems: 10 });

    expect(evidence.focus).toBe('okr');
    expect(evidence.okrAccountabilityRisks).toEqual(expect.arrayContaining([
      expect.objectContaining({ riskType: 'okr_off_track', okrTitle: 'Recover Buy Box', progressPercent: 40 }),
      expect.objectContaining({ riskType: 'task_overdue', taskId: 'CU-1' }),
    ]));
  });

  it('keeps critical source quality above otherwise valid Buy Box risk', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-source', canonicalAsin: 'B00SOURCE' });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({ values: { id: 'source-bad', name: 'Sellerboard ACME', sourceType: 'sellerboard', domain: 'amazon_operations', active: true, config: { warningPolicy: { required: true } }, freshnessSlaMinutes: 1440 } });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({ values: { id: 'run-bad', sourceConnectionId: 'source-bad', status: 'failed', errorMessage: 'download failed', startedAt: '2026-06-10T07:00:00.000Z', finishedAt: '2026-06-10T07:01:00.000Z' } });
    await db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).create({ values: { naturalKey: 'source-traffic-prior', sourceConnectionId: 'source-bad', snapshotDate: '2026-06-09', asin: 'B00SOURCE', buyBoxPercentage: 95 } });
    await db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).create({ values: { naturalKey: 'source-traffic-current', sourceConnectionId: 'source-bad', snapshotDate: '2026-06-10', asin: 'B00SOURCE', buyBoxPercentage: 50 } });

    const evidence = await brief.buildEvidencePack({ company: 'ACME', date: '2026-06-10', timezone: 'Asia/Karachi', maxItems: 10 });

    expect(evidence.focus).toBe('source_quality');
    expect(evidence.dataWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_required_source' }), expect.objectContaining({ code: 'failed_latest_run' })]));
    expect(evidence.buyBoxRisks).toHaveLength(1);
  });

  it('marks new products without baseline as watch-list evidence instead of off-track focus', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-new', canonicalAsin: 'B00NEW' });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'new-current', sourceConnectionId: 'source-1', planningProductId: 'product-new', snapshotDate: '2026-06-10', company: 'ACME', asin: 'B00NEW', units: 4, sales: 80, netProfit: 20 } });

    const evidence = await brief.buildEvidencePack({ company: 'ACME', date: '2026-06-10', timezone: 'Asia/Karachi', maxItems: 10 });

    expect(evidence.focus).toBe('no_major_exception');
    expect(evidence.performanceTrends).toEqual([expect.objectContaining({ asin: 'B00NEW', confidence: 'low', warnings: [expect.stringContaining('No prior-period')] })]);
  });

  it('uses mixed-domain priority order after inventory and supplier orders', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-mixed', canonicalAsin: 'B00MIXED' });
    await db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).create({ values: { naturalKey: 'mixed-traffic-prior', sourceConnectionId: 'source-1', snapshotDate: '2026-06-09', asin: 'B00MIXED', buyBoxPercentage: 90 } });
    await db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).create({ values: { naturalKey: 'mixed-traffic-current', sourceConnectionId: 'source-1', snapshotDate: '2026-06-10', asin: 'B00MIXED', buyBoxPercentage: 55 } });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'mixed-fact-prior', sourceConnectionId: 'source-1', planningProductId: 'product-mixed', snapshotDate: '2026-06-09', company: 'ACME', asin: 'B00MIXED', units: 20, sales: 400, netProfit: 120 } });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'mixed-fact-current', sourceConnectionId: 'source-1', planningProductId: 'product-mixed', snapshotDate: '2026-06-10', company: 'ACME', asin: 'B00MIXED', units: 5, sales: 100, netProfit: 30 } });
    await db.getRepository(ECOBASE_COLLECTIONS.okrs).create({ values: { id: 'okr-mixed', naturalKey: 'okr-mixed', company: 'ACME', title: 'Ops hygiene', owner: 'Ops', status: 'active' } });
    await db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).create({ values: { naturalKey: 'mixed-okr', okrId: 'okr-mixed', snapshotDate: '2026-06-10', metricName: 'Ops hygiene', progressPercent: 30, status: 'off_track', owner: 'Ops' } });

    const evidence = await brief.buildEvidencePack({ company: 'ACME', date: '2026-06-10', timezone: 'Asia/Karachi', maxItems: 10 });

    expect(evidence.focus).toBe('buybox');
    expect(evidence.summaryCounts).toMatchObject({ buyBoxRiskCount: 1, performanceTrendCount: 1, okrAccountabilityRiskCount: 1 });
  });
});
