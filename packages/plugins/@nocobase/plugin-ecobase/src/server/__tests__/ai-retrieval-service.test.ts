import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseAiActions } from '../plugin';
import { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { EcobaseAiRetrievalService } from '../services/ai-retrieval-service';

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
  await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({ values: { id: 'gold-inventory-1', company: 'ACME', calculationDate: '2026-06-05', asin: 'B00AI', sku: 'SKU-AI', title: 'AI product', supplierName: 'Supplier AI', supplierId: 'supplier-1', actionStatus: 'order_now', estimatedOosDate: '2026-06-06', expectedSellableDate: '2026-06-12', recommendedAction: 'Place supplier order.', estimatedProfitRisk: 500, moneyAtRisk: 500, suggestedReorderQty: 20 } });
  await db.getRepository(ECOBASE_COLLECTIONS.goldSupplierAttentionRows).create({ values: { id: 'gold-supplier-1', company: 'ACME', supplierId: 'supplier-1', supplierName: 'Supplier AI', asin: 'B00AI', sku: 'SKU-AI', recommendedAction: 'Follow supplier.', attentionReason: 'late_expected_sellable_date', moneyAtRisk: 500, orderRef: 'PO-AI', orderStatus: 'paid', expectedSellableDate: '2026-06-12', leadTimeDays: 21 } });
  await db.getRepository(ECOBASE_COLLECTIONS.goldAlerts).create({ values: { id: 'gold-alert-1', company: 'ACME', severity: 'critical', status: 'open', title: 'B00AI reorder', message: 'Place supplier order.', asin: 'B00AI', sku: 'SKU-AI', createdAt: '2026-06-05T08:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({ values: { id: 'alert-1', dedupeKey: 'alert-1', openedAt: '2026-06-05T08:00:00.000Z', planningProductId: 'product-1', company: 'ACME', canonicalAsin: 'B00AI', alertType: 'reorder_needed', severity: 'critical', status: 'open', primaryRootCauseCode: 'reorder_needed', subjectRef: 'planning_product:product-1', actionRequired: 'Place supplier order.', lastSeenAt: '2026-06-05T08:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({ values: { id: 'silver-order-1', company: 'ACME', orderRef: 'PO-AI', externalOrderRef: 'PO-AI', supplierId: 'supplier-1', supplierName: 'Supplier AI', lifecycleStatus: 'paid', status: 'paid', orderDate: '2026-06-01', expectedSellableDate: '2026-06-12', nextAction: 'Track supplier.' } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({ values: { id: 'silver-line-1', company: 'ACME', orderRef: 'PO-AI', supplierId: 'supplier-1', supplierName: 'Supplier AI', asin: 'B00AI', sku: 'SKU-AI', title: 'AI product', orderedQty: 20, expectedSellableDate: '2026-06-12', leadTimeDays: 21, lineStatus: 'open' } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({ values: { id: 'supplier-1', company: 'ACME', displayName: 'Supplier AI', normalizedName: 'supplier ai', approvalStatus: 'approved', nextFollowUpAt: '2026-06-06', contactName: 'Ops', email: 'ops@example.com' } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({ values: { id: 'supplier-product-1', supplierId: 'supplier-1', productId: 'product-1', supplierSku: 'SUP-AI', unitCost: 3, leadTimeDays: 21, analysisStatus: 'active' } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({ values: { id: 'silver-inventory-1', company: 'ACME', asin: 'B00AI', sku: 'SKU-AI', snapshotDate: '2026-06-05', sellableQty: 3, reservedQty: 0, inboundQty: 20 } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({ values: { id: 'silver-fact-1', company: 'ACME', asin: 'B00AI', sku: 'SKU-AI', snapshotDate: '2026-06-05', unitsOrdered: 10, orderedProductSales: 200, buyBoxPercentage: 95 } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverTasks).create({ values: { id: 'task-1', company: 'ACME', title: 'Follow supplier', status: 'open', priority: 'high', owner: 'Ops', dueDate: '2026-06-06' } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverTaskLinks).create({ values: { id: 'task-link-1', taskId: 'task-1', entityType: 'planning_product', entityId: 'product-1', asin: 'B00AI', sku: 'SKU-AI' } });
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

    const coverageGroups = service.coverageMatrix().map((entry) => entry.group);
    expect(coverageGroups).toHaveLength(5);
    expect([...new Set(answers.map((answer) => answer.coverageGroup))]).toEqual(expect.arrayContaining(coverageGroups));
    expect(answers.every((answer) => answer.evidenceReferences.length > 0)).toBe(true);
    expect(answers.every((answer) => answer.response.includes('cannot create, update, or resolve operational records'))).toBe(true);
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
    expect(retrievalContext.body).toEqual({
      data: expect.objectContaining({
        sourceModel: 'silver-gold-medallion',
        oldTablesUsed: false,
        gold: expect.objectContaining({ alerts: expect.any(Array), inventoryPlanningRows: expect.any(Array), supplierAttentionRows: expect.any(Array) }),
        silver: expect.objectContaining({ orders: expect.any(Array), listingDailyFacts: expect.any(Array) }),
      }),
    });

    const coverageContext = actionContext(db, {});
    await createEcobaseAiActions().coverage(coverageContext, next);
    expect(coverageContext.body).toEqual({ data: expect.arrayContaining([expect.objectContaining({ group: 'order_management' })]) });
  });
});
