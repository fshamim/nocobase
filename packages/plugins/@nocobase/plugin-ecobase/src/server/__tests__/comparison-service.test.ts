import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseComparisonActions } from '../plugin';
import { EcobaseComparisonService } from '../services/comparison-service';
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

  async update({ filter, filterByTk, values }: { filter?: Record<string, unknown>; filterByTk?: string | number; values: Record<string, unknown> }) {
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error('MemoryRepository update failed: matching record was not found.');
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
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
    body: undefined as unknown,
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

async function seedFact(
  db: MemoryDatabase,
  values: {
    id?: string;
    planningProductId?: string;
    snapshotDate: string;
    company?: string;
    asin?: string;
    sku?: string;
    netProfit: number;
    sales?: number;
    units?: number;
    accountKey?: string;
    tier?: string;
  },
) {
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
    values: {
      naturalKey: values.id ?? `${values.company ?? 'ACME'}:${values.asin ?? 'B00'}:${values.sku ?? 'SKU'}:${values.snapshotDate}`,
      sourceConnectionId: 'source-1',
      planningProductId: values.planningProductId ?? 'product-1',
      snapshotDate: values.snapshotDate,
      company: values.company ?? 'ACME',
      asin: values.asin ?? 'B00TEST',
      sku: values.sku ?? 'SKU-1',
      netProfit: values.netProfit,
      sales: values.sales ?? values.netProfit * 2,
      units: values.units ?? 1,
      payload: { accountKey: values.accountKey ?? 'US', tier: values.tier },
    },
  });
}

async function seedTarget(
  db: MemoryDatabase,
  values: {
    periodType: 'daily' | 'weekly' | 'monthly';
    period: string;
    profitTarget: number;
    company?: string;
    accountKey?: string;
    planningProductId?: string;
    asin?: string;
    sku?: string;
    tier?: string;
  },
) {
  await db.getRepository(ECOBASE_COLLECTIONS.targetRows).create({
    values: {
      naturalKey: `target:${values.periodType}:${values.period}:${values.planningProductId ?? values.accountKey ?? values.sku ?? values.tier ?? values.company}`,
      sourceConnectionId: 'source-1',
      targetScope: values.tier ? 'tier' : values.accountKey ? 'account' : values.planningProductId ? 'planning_product' : 'company',
      periodType: values.periodType,
      period: values.period,
      profitTarget: values.profitTarget,
      company: values.company ?? 'ACME',
      accountKey: values.accountKey,
      planningProductId: values.planningProductId,
      asin: values.asin,
      sku: values.sku,
      payload: { tier: values.tier },
    },
  });
}

describe('Ecobase comparison service', () => {
  it('returns week-over-week change and improving/declining product classifications', async () => {
    const db = new MemoryDatabase();
    await seedFact(db, { planningProductId: 'product-up', asin: 'BUP', sku: 'SKU-UP', snapshotDate: '2026-06-01', netProfit: 100 });
    await seedFact(db, { planningProductId: 'product-up', asin: 'BUP', sku: 'SKU-UP', snapshotDate: '2026-05-25', netProfit: 40 });
    await seedFact(db, { planningProductId: 'product-down', asin: 'BDOWN', sku: 'SKU-DOWN', snapshotDate: '2026-06-02', netProfit: 25 });
    await seedFact(db, { planningProductId: 'product-down', asin: 'BDOWN', sku: 'SKU-DOWN', snapshotDate: '2026-05-26', netProfit: 90 });

    const report = await new EcobaseComparisonService(db).comparePerformance({
      periodType: 'weekly',
      period: '2026-W23',
      groupBy: 'planning_product',
    });

    expect(report.current).toEqual({ startDate: '2026-06-01', endDate: '2026-06-07' });
    expect(report.previous).toEqual({ startDate: '2026-05-25', endDate: '2026-05-31' });
    expect(report.rows.find((row) => row.key === 'product-up')).toMatchObject({
      classification: 'improving',
      change: expect.objectContaining({ netProfit: 60, netProfitPercent: 150 }),
    });
    expect(report.rows.find((row) => row.key === 'product-down')).toMatchObject({
      classification: 'declining',
      change: expect.objectContaining({ netProfit: -65 }),
    });
  });

  it('returns month-over-month consistently underperforming product and target gap metrics', async () => {
    const db = new MemoryDatabase();
    await seedFact(db, { planningProductId: 'product-1', snapshotDate: '2026-06-05', netProfit: 80 });
    await seedFact(db, { planningProductId: 'product-1', snapshotDate: '2026-05-05', netProfit: 90 });
    await seedTarget(db, { periodType: 'monthly', period: '2026-06', planningProductId: 'product-1', profitTarget: 120 });
    await seedTarget(db, { periodType: 'monthly', period: '2026-05', planningProductId: 'product-1', profitTarget: 120 });

    const report = await new EcobaseComparisonService(db).comparePerformance({
      periodType: 'monthly',
      period: '2026-06',
      groupBy: 'planning_product',
    });

    expect(report.rows[0]).toMatchObject({
      classification: 'consistently_underperforming',
      current: expect.objectContaining({ netProfit: 80, targetProfit: 120, targetGap: -40 }),
      previous: expect.objectContaining({ netProfit: 90, targetProfit: 120, targetGap: -30 }),
    });
    expect(report.summary.consistentlyUnderperforming.map((row) => row.key)).toEqual(['product-1']);
  });

  it('includes data warnings when the prior period is missing or source runs are incomplete', async () => {
    const db = new MemoryDatabase();
    await seedFact(db, { planningProductId: 'product-1', snapshotDate: '2026-06-05', netProfit: 80 });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: { id: 'run-partial', sourceConnectionId: 'source-1', status: 'partial', sourceVersion: '2026-06-05' },
    });

    const report = await new EcobaseComparisonService(db).comparePerformance({
      periodType: 'daily',
      period: '2026-06-05',
      groupBy: 'planning_product',
    });

    expect(report.warnings.map((warning) => warning.code)).toEqual(['missing_prior_period', 'incomplete_source_period']);
    expect(report.rows[0].warnings.map((warning) => warning.code)).toEqual(['missing_prior_period']);
  });

  it('rolls up account-level target gaps through the same comparison service', async () => {
    const db = new MemoryDatabase();
    await seedFact(db, { planningProductId: 'product-1', snapshotDate: '2026-06-01', netProfit: 70, accountKey: 'US' });
    await seedFact(db, { planningProductId: 'product-2', snapshotDate: '2026-06-02', netProfit: 30, accountKey: 'US' });
    await seedFact(db, { planningProductId: 'product-1', snapshotDate: '2026-05-25', netProfit: 75, accountKey: 'US' });
    await seedTarget(db, { periodType: 'weekly', period: '2026-06-01:2026-06-07', accountKey: 'US', profitTarget: 150 });

    const report = await new EcobaseComparisonService(db).comparePerformance({
      periodType: 'weekly',
      currentStartDate: '2026-06-01',
      currentEndDate: '2026-06-07',
      groupBy: 'account',
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      key: 'US',
      current: expect.objectContaining({ netProfit: 100, targetProfit: 150, targetGap: -50 }),
      classification: 'underperforming',
    });
    expect(report.summary.accountTargetGaps.map((row) => row.key)).toEqual(['US']);
  });

  it('supports raw listing/SKU rollups and the public comparison action seam', async () => {
    const db = new MemoryDatabase();
    await seedFact(db, { planningProductId: 'product-1', asin: 'BRAW', sku: 'SKU-A', snapshotDate: '2026-06-05', netProfit: 12 });
    await seedFact(db, { planningProductId: 'product-1', asin: 'BRAW', sku: 'SKU-A', snapshotDate: '2026-06-04', netProfit: 10 });
    const context = createActionContext(db, {
      periodType: 'daily',
      period: '2026-06-05',
      groupBy: 'raw_listing_sku',
    });
    const next = vi.fn();

    await createEcobaseComparisonActions().compare(context, next);

    expect(context.body).toEqual({
      data: expect.objectContaining({
        groupBy: 'raw_listing_sku',
        rows: [
          expect.objectContaining({
            key: 'ACME:BRAW:SKU-A',
            label: 'BRAW / SKU-A',
            current: expect.objectContaining({ netProfit: 12 }),
            previous: expect.objectContaining({ netProfit: 10 }),
          }),
        ],
      }),
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
