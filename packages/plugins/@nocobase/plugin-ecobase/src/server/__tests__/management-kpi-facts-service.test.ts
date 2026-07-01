import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseManagementKpiFactsService } from '../services/management-kpi-facts-service';

class MemoryRepository implements EcobaseRepository {
  constructor(public records: Record<string, unknown>[] = []) {}

  async find(params: { filter?: Record<string, unknown>; sort?: string[]; limit?: number } = {}) {
    const rows = this.filterRecords(params.filter ?? {});
    return this.sortRows(rows, params.sort).slice(0, params.limit ?? rows.length);
  }

  async findOne(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[] } = {}) {
    if (params.filterByTk) return this.records.find((record) => record.id === params.filterByTk) ?? null;
    return (await this.find({ filter: params.filter, sort: params.sort, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    this.records.push({ ...values });
    return values;
  }

  async update({
    filterByTk,
    filter,
    values,
  }: {
    filterByTk?: string | number;
    filter?: Record<string, unknown>;
    values: Record<string, unknown>;
  }) {
    const rows = filterByTk
      ? this.records.filter((record) => record.id === filterByTk)
      : this.filterRecords(filter ?? {});
    if (!rows.length) throw new Error('MemoryRepository update failed: record not found.');
    rows.forEach((row) => Object.assign(row, values));
    return rows[0];
  }

  private filterRecords(filter: Record<string, unknown>) {
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

function dateAdd(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function seedSilverDailyFacts(db: MemoryDatabase) {
  db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).records.push({ id: 'company-1', name: 'Ecofission LLC' });
  db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).records.push({
    id: 'company-product-1',
    companyId: 'company-1',
  });
  for (let index = 0; index < 14; index += 1) {
    const snapshotDate = dateAdd('2026-06-01', index);
    db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).records.push({
      id: `listing-${index}`,
      companyProductId: 'company-product-1',
      snapshotDate,
      sales: index < 7 ? 100 : 110,
      profit: index < 7 ? 20 : 30,
      units: index < 7 ? 10 : 11,
      refunds: index < 7 ? 1 : 0,
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).records.push({
      id: `traffic-${index}`,
      companyProductId: 'company-product-1',
      snapshotDate,
      sessions: 100,
      buyBoxPercentage: index < 7 ? 80 : 90,
      conversionRate: index < 7 ? 10 : 12,
    });
  }
}

describe('EcobaseManagementKpiFactsService', () => {
  it('backfills Silver daily facts and computes 7-day trends without snapshot baselines', async () => {
    const db = new MemoryDatabase();
    seedSilverDailyFacts(db);

    const service = new EcobaseManagementKpiFactsService(db);
    const summary = await service.backfillSilverDerivedFacts({ startDate: '2026-06-01', endDate: '2026-06-14' });
    expect(summary.metrics.sales).toBe(28);
    expect(summary.metrics.buyBoxPct).toBe(28);

    const beforeRerunCount = db.getRepository(ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts).records.length;
    await service.backfillSilverDerivedFacts({ startDate: '2026-06-01', endDate: '2026-06-14' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts).records).toHaveLength(beforeRerunCount);

    const trend = await service.getTrend({ date: '2026-06-14', period: '7d' });
    const sales = trend.kpis.find((row) => row.key === 'sales');
    const profit = trend.kpis.find((row) => row.key === 'profit');
    const buyBox = trend.kpis.find((row) => row.key === 'buyBoxPct');
    expect(sales).toMatchObject({
      value: 770,
      previousValue: 700,
      absoluteDelta: 70,
      direction: 'improved',
      confidence: 'complete',
    });
    expect(profit).toMatchObject({ value: 210, previousValue: 140, percentDelta: 50, direction: 'improved' });
    expect(buyBox).toMatchObject({ value: 90, previousValue: 80, direction: 'improved' });

    const trend30 = await service.getTrend({ date: '2026-06-14', period: '30d' });
    expect(trend30.kpis.find((row) => row.key === 'sales')).toMatchObject({
      value: 1470,
      previousValue: null,
      absoluteDelta: null,
      percentDelta: null,
      direction: 'insufficient_history',
      confidence: 'insufficient',
    });
  });

  it('writes current Gold risk KPI facts and reports insufficient trend history until prior facts exist', async () => {
    const db = new MemoryDatabase();
    db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).records.push(
      {
        id: 'inventory-1',
        calculationDate: '2026-06-14',
        company: 'Ecofission LLC',
        actionStatus: 'overdue',
        tier: 'A',
        estimatedProfitRisk: 500,
        estimatedOosDate: '2026-06-16',
        leadTimeFreshness: 'missing',
      },
      {
        id: 'inventory-2',
        calculationDate: '2026-06-14',
        company: 'Ecofission LLC',
        actionStatus: 'sufficient_stock',
        tier: 'B',
        estimatedProfitRisk: 100,
      },
    );
    db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).records.push({
      id: 'order-1',
      companyName: 'Ecofission LLC',
      currentStatus: 'ORDERED',
      latestGoldCalculationDate: '2026-06-14',
      moneyAtRisk: 300,
      statusCheckRequired: true,
      daysSinceLastActivity: 8,
      nextAction: 'Update order status',
    });
    db.getRepository(ECOBASE_COLLECTIONS.goldSupplierAttentionRows).records.push({
      id: 'supplier-1',
      calculationDate: '2026-06-14',
      companyName: 'Ecofission LLC',
      moneyAtRisk: 200,
    });

    const service = new EcobaseManagementKpiFactsService(db);
    const summary = await service.refreshForDate({ date: '2026-06-14' });
    expect(summary.metrics.inventoryMoneyAtRisk).toBe(2);
    expect(summary.metrics.orderMoneyAtRisk).toBe(2);
    expect(summary.metrics.supplierAttentionCount).toBe(2);

    const facts = db.getRepository(ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts).records;
    expect(facts.find((row) => row.metricKey === 'inventoryMoneyAtRisk' && row.companyScope === 'all')).toMatchObject({
      value: 500,
    });
    expect(
      facts.find((row) => row.metricKey === 'supplierAttentionCount' && row.companyScope === 'Ecofission LLC'),
    ).toMatchObject({ value: 1 });

    const trend = await service.getTrend({ date: '2026-06-14', company: 'Ecofission LLC', period: '7d' });
    expect(trend.kpis.find((row) => row.key === 'inventoryMoneyAtRisk')).toMatchObject({
      value: 500,
      previousValue: null,
      direction: 'insufficient_history',
      confidence: 'insufficient',
    });
  });
});
