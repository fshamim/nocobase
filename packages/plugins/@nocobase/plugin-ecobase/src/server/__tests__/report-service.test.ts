import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseReportActions } from '../plugin';
import { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseReportService } from '../services/report-service';

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

async function seedReportData(db: MemoryDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({ values: { id: 'source-1', name: 'Sellerboard QA', sourceType: 'sellerboard', domain: 'amazon_operations', active: true, required: true, freshnessSlaMinutes: 1440 } });
  await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({ values: { id: 'run-1', sourceConnectionId: 'source-1', adapterName: 'sellerboard_csv', sourceIdentifier: 'qa', sourceVersion: '2026-06-05', idempotencyKey: 'qa-run-1', status: 'success', rowCount: 10, normalizedCount: 10, warningCount: 0, startedAt: '2026-06-05T08:00:00.000Z', finishedAt: '2026-06-05T08:01:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({ values: { id: 'product-1', naturalKey: 'ACME:B00REPORT', company: 'ACME', canonicalAsin: 'B00REPORT', title: 'Report product' } });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'fact-current', sourceConnectionId: 'source-1', planningProductId: 'product-1', snapshotDate: '2026-06-05', company: 'ACME', asin: 'B00REPORT', sku: 'SKU-REPORT', sales: 200, units: 10, netProfit: 100, payload: { accountKey: 'US', tier: 'A' } } });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'fact-prior', sourceConnectionId: 'source-1', planningProductId: 'product-1', snapshotDate: '2026-06-04', company: 'ACME', asin: 'B00REPORT', sku: 'SKU-REPORT', sales: 150, units: 8, netProfit: 70, payload: { accountKey: 'US', tier: 'A' } } });
  await db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).create({ values: { naturalKey: 'calc-1', planningProductId: 'product-1', calculationDate: '2026-06-05', company: 'ACME', canonicalAsin: 'B00REPORT', tier: 'A', sellableStock: 1, pipelineStock: 20, daysOfCover: 1, restockDeadlineImproved: '2026-06-07', profitGap: -80, estimatedProfitRisk: 500, calculationStatus: 'complete', dataCompleteness: 'complete' } });
  await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({ values: { id: 'alert-1', dedupeKey: 'alert-1', openedAt: '2026-06-05T08:00:00.000Z', planningProductId: 'product-1', company: 'ACME', canonicalAsin: 'B00REPORT', alertType: 'reorder_needed', severity: 'critical', status: 'open', primaryRootCauseCode: 'reorder_needed', subjectRef: 'planning_product:product-1', actionRequired: 'Place supplier order.', evidence: { calculationId: 'calc-1' }, dataWarnings: [{ code: 'missing_velocity' }], rootCauses: [{ code: 'reorder_needed' }], lastSeenAt: '2026-06-05T08:05:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({ values: { id: 'order-1', company: 'ACME', supplierId: 'supplier-1', supplierName: 'Supplier One', externalOrderRef: 'PO-1', status: 'ordered' } });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({ values: { id: 'line-1', company: 'ACME', supplierOrderId: 'order-1', planningProductId: 'product-1', openQty: 20, expectedSellableDate: '2026-06-12', status: 'ordered', observedAt: '2026-06-05T08:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).create({ values: { id: 'task-1', sourceConnectionId: 'source-1', snapshotDate: '2026-06-05', externalTaskId: 'CU-1', taskName: 'Call supplier', assignee: 'Ops', priority: 'high', status: 'open', operationalArea: 'Purchasing', lastMeaningfulUpdateAt: '2026-06-03T00:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).create({ values: { id: 'okr-snap-1', okrId: 'okr-1', snapshotDate: '2026-06-05', status: 'off_track', owner: 'Ops', area: 'Purchasing' } });
}

describe('Ecobase report service', () => {
  it('creates report run and evidence-linked report items for daily preview', async () => {
    const db = new MemoryDatabase();
    await seedReportData(db);

    const report = await new EcobaseReportService(db).generateReport({ company: 'ACME', frequency: 'daily', date: '2026-06-05', emailEnabled: true });

    expect(report).toMatchObject({ frequency: 'daily', periodStart: '2026-06-05', periodEnd: '2026-06-05', status: 'preview_generated', emailStatus: 'email_not_configured' });
    expect(report.executiveSummary).toContain('critical alerts');
    expect(report.items.map((item) => item.itemType)).toEqual(expect.arrayContaining(['critical_alert', 'oos_reorder_risk', 'supplier_order_risk', 'accountability_task', 'okr_status', 'comparative_trend', 'data_quality']));
    expect(report.items.find((item) => item.itemType === 'critical_alert')).toMatchObject({ evidenceRefType: 'alert', evidenceRefId: 'alert-1' });
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).find()).toHaveLength(1);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportItems).find()).toHaveLength(report.items.length);
  });

  it('supports weekly and monthly reports through the same public action seam', async () => {
    const db = new MemoryDatabase();
    await seedReportData(db);
    const next = vi.fn();
    const context = createActionContext(db, { company: 'ACME', frequency: 'weekly', period: '2026-W23' });

    await createEcobaseReportActions().generatePreview(context, next);

    expect(context.body).toEqual({ data: expect.objectContaining({ frequency: 'weekly', periodStart: '2026-06-01', periodEnd: '2026-06-07', emailStatus: 'preview_only' }) });
    expect(next).toHaveBeenCalledOnce();

    const monthly = await new EcobaseReportService(db).generateReport({ company: 'ACME', frequency: 'monthly', period: '2026-06' });
    expect(monthly).toMatchObject({ frequency: 'monthly', periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  });
});
