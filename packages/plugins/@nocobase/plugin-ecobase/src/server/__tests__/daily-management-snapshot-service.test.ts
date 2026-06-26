import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseDailyBriefPromptSettingsService } from '../services/daily-brief-prompt-settings-service';
import { EcobaseDailyManagementSnapshotService } from '../services/daily-management-snapshot-service';

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  constructor(private records: Record<string, unknown>[] = []) {}

  async find(
    params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {},
  ) {
    const rows = this.filterRecords(params);
    return this.sortRows(rows, params.sort).slice(0, params.limit ?? rows.length);
  }

  async findOne(
    params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {},
  ) {
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

describe('EcobaseDailyManagementSnapshotService', () => {
  it('persists management KPIs and compares the 7-day trend', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'baseline-risk',
        calculationDate: '2026-06-03',
        company: 'ACME',
        asin: 'B00BASE',
        actionStatus: 'overdue',
        tier: 'A',
        estimatedOosDate: '2026-06-04',
        estimatedProfitRisk: 500,
        leadTimeFreshness: 'missing',
        supplierOrderState: 'placed_not_purchased',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'current-risk',
        calculationDate: '2026-06-10',
        company: 'ACME',
        asin: 'B00CURR',
        actionStatus: 'order_today',
        tier: 'B',
        estimatedOosDate: '2026-06-12',
        estimatedProfitRisk: 300,
        leadTimeFreshness: 'fresh',
        supplierOrderState: 'purchased_pipeline',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
      values: {
        naturalKey: 'baseline-sales',
        snapshotDate: '2026-06-03',
        company: 'ACME',
        sales: 600,
        netProfit: 120,
        units: 12,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
      values: {
        naturalKey: 'current-sales',
        snapshotDate: '2026-06-10',
        company: 'ACME',
        sales: 1000,
        netProfit: 240,
        units: 20,
      },
    });

    const service = new EcobaseDailyManagementSnapshotService(db);
    await service.upsertFromEvidence({ date: '2026-06-03', company: 'ACME', reportRunId: 'report-baseline' });
    const current = await service.upsertFromEvidence({
      date: '2026-06-10',
      company: 'ACME',
      reportRunId: 'report-current',
    });
    const trend = await service.getTrend({ date: '2026-06-10', company: 'ACME', period: '7d' });

    expect(current).toMatchObject({
      snapshotDate: '2026-06-10',
      companyScope: 'ACME',
      inventoryMoneyAtRisk: 300,
      urgentInventorySkuCount: 1,
      sales7d: 1000,
      profit7d: 240,
    });
    expect(trend.warnings).toEqual([]);
    expect(trend.kpis.find((kpi) => kpi.key === 'inventoryMoneyAtRisk')).toMatchObject({
      previousValue: 500,
      value: 300,
      absoluteDelta: -200,
      direction: 'improved',
    });
    expect(trend.kpis.find((kpi) => kpi.key === 'sales7d')).toMatchObject({
      previousValue: 600,
      value: 1000,
      direction: 'improved',
    });
  });
});

describe('EcobaseDailyBriefPromptSettingsService', () => {
  it('saves global prompt settings without an undefined company filter', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseDailyBriefPromptSettingsService(db);

    const saved = await service.saveSettings({
      audience: 'Directors',
      tone: 'direct',
      directorInstructions: 'Lead with cash risk.',
      mustInclude: ['money at risk'],
    });
    const active = await service.getActiveSettings();

    expect(saved).toMatchObject({
      audience: 'Directors',
      tone: 'direct',
      directorInstructions: 'Lead with cash risk.',
      mustInclude: ['money at risk'],
    });
    expect(active.settings).toMatchObject(saved);
  });
});
