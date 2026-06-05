import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseAiActions } from '../plugin';
import { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { APPENDIX_A_COVERAGE, EcobaseAiRetrievalService } from '../services/ai-retrieval-service';

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  constructor(private records: Record<string, unknown>[] = []) {}
  async find(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {}) { return this.sort(this.filter(params), params.sort).slice(0, params.limit ?? this.records.length); }
  async findOne(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {}) { return (await this.find({ ...params, limit: 1 }))[0] ?? null; }
  async create({ values }: { values: Record<string, unknown> }) { const record = { id: values.id ?? `record-${this.sequence++}`, ...values }; this.records.push(record); return record; }
  async update({ filter, filterByTk, values }: { filter?: Record<string, unknown>; filterByTk?: string | number; values: Record<string, unknown> }) { const rows = this.filter({ filter, filterByTk }); rows.forEach((row) => Object.assign(row, values)); return rows[0] ?? null; }
  private filter(params: { filter?: Record<string, unknown>; filterByTk?: string | number }) { if (params.filterByTk) return this.records.filter((record) => record.id === params.filterByTk); const filter = params.filter ?? {}; return this.records.filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value)); }
  private sort(rows: Record<string, unknown>[], sort: string[] = []) { const [first] = sort; if (!first) return rows; const desc = first.startsWith('-'); const key = desc ? first.slice(1) : first; return [...rows].sort((a, b) => (desc ? -1 : 1) * String(a[key] ?? '').localeCompare(String(b[key] ?? ''))); }
}

class MemoryDatabase implements EcobaseDatabase {
  repositories = new Map<string, MemoryRepository>();
  constructor() { Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository())); }
  getRepository(name: string) { const repo = this.repositories.get(name); if (!repo) throw new Error(`missing repo ${name}`); return repo; }
}

function actionContext(db: EcobaseDatabase, values: Record<string, unknown>) {
  return { action: { params: { values } }, db, body: undefined as any, throw(status: number, message: string) { const error = new Error(message) as Error & { status?: number }; error.status = status; throw error; } };
}

async function seed(db: MemoryDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({ values: { id: 'source-1', name: 'Sellerboard', sourceType: 'sellerboard', domain: 'amazon_operations', active: true, required: true, freshnessSlaMinutes: 1440 } });
  await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({ values: { id: 'run-1', sourceConnectionId: 'source-1', adapterName: 'sellerboard_csv', sourceIdentifier: 'qa', sourceVersion: '2026-06-05', idempotencyKey: 'ai-run-1', status: 'success', rowCount: 10, normalizedCount: 10, warningCount: 0, startedAt: '2026-06-05T08:00:00.000Z', finishedAt: '2026-06-05T08:01:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).create({ values: { id: 'calc-1', naturalKey: 'calc-1', planningProductId: 'product-1', company: 'ACME', canonicalAsin: 'B00AI', calculationDate: '2026-06-05', tier: 'A', daysOfCover: 1, estimatedProfitRisk: 500, profitGap: -100 } });
  await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({ values: { id: 'alert-1', dedupeKey: 'alert-1', openedAt: '2026-06-05T08:00:00.000Z', planningProductId: 'product-1', company: 'ACME', canonicalAsin: 'B00AI', alertType: 'reorder_needed', severity: 'critical', status: 'open', primaryRootCauseCode: 'reorder_needed', subjectRef: 'planning_product:product-1', actionRequired: 'Place supplier order.', evidence: { calculationId: 'calc-1' }, lastSeenAt: '2026-06-05T08:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({ values: { id: 'order-1', company: 'ACME', externalOrderRef: 'PO-AI', supplierName: 'Supplier AI', status: 'ordered' } });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({ values: { id: 'line-1', company: 'ACME', supplierOrderId: 'order-1', planningProductId: 'product-1', expectedSellableDate: '2026-06-12', openQty: 20, status: 'ordered' } });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities).create({ values: { id: 'activity-1', supplierOrderId: 'order-1', activityType: 'supplier_contact', occurredAt: '2026-06-04T08:00:00.000Z', actor: 'Ops' } });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).create({ values: { id: 'lead-1', supplierId: 'supplier-1', supplierName: 'Supplier AI', leadTimeDays: 21, observedAt: '2026-06-01' } });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).create({ values: { id: 'link-1', planningProductId: 'product-1', supplierId: 'supplier-1', supplierName: 'Supplier AI', lastSeenAt: '2026-06-01' } });
  await db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).create({ values: { id: 'task-1', externalTaskId: 'CU-AI', taskName: 'Follow supplier', assignee: 'Ops', operationalArea: 'Purchasing', priority: 'high', status: 'open', snapshotDate: '2026-06-05', lastMeaningfulUpdateAt: '2026-06-02T00:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.taskLinks).create({ values: { id: 'task-link-1', externalTaskId: 'CU-AI', targetType: 'planning_product', targetRef: 'product-1', confidence: 0.9, observedAt: '2026-06-05T00:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.okrs).create({ values: { id: 'okr-1', title: 'Recover profit', owner: 'Ops', operationalArea: 'Purchasing' } });
  await db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).create({ values: { id: 'okr-snap-1', okrId: 'okr-1', status: 'off_track', owner: 'Ops', area: 'Purchasing', progressPercent: 40, snapshotDate: '2026-06-05' } });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'current', planningProductId: 'product-1', company: 'ACME', snapshotDate: '2026-06-05', asin: 'B00AI', sku: 'SKU-AI', sales: 200, units: 10, netProfit: 100, payload: { tier: 'A' } } });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({ values: { naturalKey: 'previous', planningProductId: 'product-1', company: 'ACME', snapshotDate: '2026-06-04', asin: 'B00AI', sku: 'SKU-AI', sales: 150, units: 7, netProfit: 60, payload: { tier: 'A' } } });
  await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).create({ values: { id: 'report-1', company: 'ACME', frequency: 'daily', periodStart: '2026-06-05', periodEnd: '2026-06-05', status: 'preview_generated', emailStatus: 'email_not_configured', generatedAt: '2026-06-05T08:10:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.reportItems).create({ values: { id: 'report-item-1', reportRunId: 'report-1', itemType: 'critical_alert', severity: 'critical', title: 'B00AI reorder', body: 'Place supplier order.', evidenceRefType: 'alert', evidenceRefId: 'alert-1', evidence: { alertId: 'alert-1' }, sortOrder: 1 } });
}

describe('Ecobase AI retrieval service', () => {
  it('maps every Appendix A group to retrieval evidence and stores answers without mutating alerts', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseAiRetrievalService(db);
    const alertCount = (await db.getRepository(ECOBASE_COLLECTIONS.alerts).find()).length;

    const questions = [
      'Which products are off track today and why?',
      'Which OKRs and ClickUp tasks lack progress?',
      'Which stock and OOS risks need reorder?',
      'Which supplier orders are delayed or need contact?',
      'Compare week trends and underperformers.',
      'What are the five biggest SKU problems and highest financial risk items for team focus?',
    ];
    const answers = [];
    for (const question of questions) answers.push(await service.answerQuestion({ question, company: 'ACME', date: '2026-06-05' }));

    expect(service.coverageMatrix()).toHaveLength(APPENDIX_A_COVERAGE.length);
    expect(new Set(answers.map((answer) => answer.coverageGroup)).size).toBe(6);
    expect(answers.every((answer) => answer.evidenceReferences.length > 0)).toBe(true);
    expect(answers.every((answer) => answer.response.includes('cannot create, suppress, or resolve deterministic alerts'))).toBe(true);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).find()).toHaveLength(6);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.alerts).find()).toHaveLength(alertCount);
  });

  it('exposes public retrieve, answer, and coverage actions', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const next = vi.fn();
    const answerContext = actionContext(db, { question: 'What are the biggest financial risks?', company: 'ACME', date: '2026-06-05' });
    await createEcobaseAiActions().answer(answerContext, next);
    expect(answerContext.body).toEqual({ data: expect.objectContaining({ provider: 'ecobase-plugin-retrieval', confidence: 'evidence-backed' }) });

    const retrievalContext = actionContext(db, { company: 'ACME', date: '2026-06-05' });
    await createEcobaseAiActions().retrieveFacts(retrievalContext, next);
    expect(retrievalContext.body).toEqual({ data: expect.objectContaining({ alerts: expect.any(Array), accountability: expect.any(Object), comparativeRollups: expect.any(Array) }) });

    const coverageContext = actionContext(db, {});
    await createEcobaseAiActions().coverage(coverageContext, next);
    expect(coverageContext.body).toEqual({ data: expect.arrayContaining([expect.objectContaining({ group: 'order_management' })]) });
  });
});
