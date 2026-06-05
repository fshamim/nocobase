import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseDashboardActions } from '../plugin';
import { EcobaseDashboardService } from '../services/dashboard-service';
import { EcobaseDatabase, EcobaseRepository } from '../services/import-service';

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {}) {
    const filtered = this.filterRecords(params);
    return this.sortRecords(filtered, params.sort).slice(0, params.limit ?? filtered.length);
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
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error('MemoryRepository update failed: matching record was not found.');
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  private filterRecords(params: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
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

async function seedDashboard(db: MemoryDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: { id: 'source-1', name: 'Sellerboard QA', sourceType: 'sellerboard', domain: 'amazon_operations', active: true, required: true, freshnessSlaMinutes: 1440 },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
    values: { id: 'run-1', sourceConnectionId: 'source-1', status: 'success', rowCount: 10, normalizedCount: 10, warningCount: 1, startedAt: '2026-06-05T08:00:00.000Z', completedAt: '2026-06-05T08:01:00.000Z' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
    values: { id: 'product-1', naturalKey: 'ACME:B00DASH', company: 'ACME', canonicalAsin: 'B00DASH', title: 'Dashboard product' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
    values: { naturalKey: 'fact-current', sourceConnectionId: 'source-1', planningProductId: 'product-1', snapshotDate: '2026-06-05', company: 'ACME', asin: 'B00DASH', sku: 'SKU-DASH', sales: 200, units: 10, netProfit: 100, payload: { accountKey: 'US', tier: 'A' } },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
    values: { naturalKey: 'fact-prior', sourceConnectionId: 'source-1', planningProductId: 'product-1', snapshotDate: '2026-06-04', company: 'ACME', asin: 'B00DASH', sku: 'SKU-DASH', sales: 160, units: 8, netProfit: 80, payload: { accountKey: 'US', tier: 'A' } },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).create({
    values: { naturalKey: 'calc-1', planningProductId: 'product-1', calculationDate: '2026-06-05', company: 'ACME', canonicalAsin: 'B00DASH', tier: 'A', sellableStock: 2, pipelineStock: 30, daysOfCover: 2, restockDeadlineImproved: '2026-06-07', profitGap: -50, estimatedProfitRisk: 300, calculationStatus: 'complete', dataCompleteness: 'complete' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({
    values: { id: 'alert-1', planningProductId: 'product-1', company: 'ACME', canonicalAsin: 'B00DASH', alertType: 'reorder_needed', severity: 'critical', status: 'open', primaryRootCauseCode: 'reorder_needed', subjectRef: 'planning_product:product-1', actionRequired: 'Place supplier order.', evidence: { source: 'test' }, dataWarnings: [{ code: 'stale_successful_run' }], rootCauses: [{ code: 'reorder_needed' }], lastSeenAt: '2026-06-05T08:05:00.000Z' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
    values: { id: 'order-1', company: 'ACME', supplierId: 'supplier-1', supplierName: 'Supplier One', externalOrderRef: 'PO-1', status: 'ordered', lastMeaningfulUpdateAt: '2026-06-01T00:00:00.000Z' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
    values: { id: 'line-1', company: 'ACME', supplierOrderId: 'order-1', planningProductId: 'product-1', asin: 'B00DASH', openQty: 20, expectedDeliveryDate: '2026-06-10', expectedSellableDate: '2026-06-12', status: 'ordered', observedAt: '2026-06-05T08:00:00.000Z' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).create({
    values: { id: 'task-1', sourceConnectionId: 'source-1', snapshotDate: '2026-06-05', externalTaskId: 'CU-1', taskName: 'Call Supplier One', assignee: 'Ops', status: 'open', priority: 'high', lastMeaningfulUpdateAt: '2026-06-03T00:00:00.000Z', operationalArea: 'Purchasing' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).create({
    values: { id: 'okr-snap-1', okrId: 'okr-1', snapshotDate: '2026-06-05', status: 'off_track', owner: 'Ops', area: 'Purchasing' },
  });
}

describe('Ecobase dashboard service', () => {
  it('returns management dashboard data from normalized internal tables only', async () => {
    const db = new MemoryDatabase();
    await seedDashboard(db);

    const dashboard = await new EcobaseDashboardService(db).getDashboard({ company: 'ACME', periodType: 'daily', period: '2026-06-05' });

    expect(dashboard.importStatuses).toHaveLength(1);
    expect(dashboard.warningSummary).toMatchObject({ sourceCount: 1 });
    expect(dashboard.profitStockRollups.byCompany[0]).toMatchObject({ key: 'ACME', sellableStock: 2, pipelineStock: 30, profitGap: -50 });
    expect(dashboard.comparison.accountOrCompany.rows[0]).toMatchObject({ key: 'ACME', change: expect.objectContaining({ netProfit: 20 }) });
    expect(dashboard.comparison.planningProducts.rows[0]).toMatchObject({ key: 'product-1' });
    expect(dashboard.comparison.rawListings.rows[0]).toMatchObject({ key: 'ACME:B00DASH:SKU-DASH' });
    expect(dashboard.atRiskProducts[0]).toMatchObject({ canonicalAsin: 'B00DASH', primaryRootCauseCode: 'reorder_needed', actionRequired: 'Place supplier order.' });
    expect(dashboard.supplierOrderDelays[0]).toMatchObject({ supplier: 'Supplier One', orderRef: 'PO-1', expectedSellableDate: '2026-06-12', linkedPlanningProductId: 'product-1' });
    expect(dashboard.accountability.latestTasks[0]).toMatchObject({ externalTaskId: 'CU-1', assignee: 'Ops', operationalArea: 'Purchasing' });
    expect(dashboard.drilldowns.alerts[0]).toMatchObject({ alertId: 'alert-1', dataWarnings: [{ code: 'stale_successful_run' }] });
  });

  it('updates MVP dashboard settings through the public action seam', async () => {
    const db = new MemoryDatabase();
    const context = createActionContext(db, { buyBoxRiskThreshold: 75, dailyReportSchedule: '08:30' });
    const next = vi.fn();

    await createEcobaseDashboardActions().updateSettings(context, next);

    expect(context.body).toEqual({ data: expect.objectContaining({ buyBoxRiskThreshold: 75, dailyReportSchedule: '08:30', timezone: 'Asia/Karachi' }) });
    expect(next).toHaveBeenCalledOnce();

    const settingsContext = createActionContext(db);
    await createEcobaseDashboardActions().settings(settingsContext, vi.fn());
    expect(settingsContext.body).toEqual({ data: expect.objectContaining({ buyBoxRiskThreshold: 75 }) });
  });
});
