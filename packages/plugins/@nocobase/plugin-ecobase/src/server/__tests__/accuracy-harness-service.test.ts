import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseAccuracyActions } from '../plugin';
import { EcobaseAccuracyHarnessService, REQUIRED_CHECKLIST_ITEMS } from '../services/accuracy-harness-service';
import { EcobaseDatabase, EcobaseRepository } from '../services/import-service';

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  constructor(private records: Record<string, unknown>[] = []) {}
  async find(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {}) { const rows = this.filter(params); return rows.slice(0, params.limit ?? rows.length); }
  async findOne(params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {}) { return (await this.find({ ...params, limit: 1 }))[0] ?? null; }
  async create({ values }: { values: Record<string, unknown> }) { const record = { id: values.id ?? `record-${this.sequence++}`, ...values }; this.records.push(record); return record; }
  async update({ filter, filterByTk, values }: { filter?: Record<string, unknown>; filterByTk?: string | number; values: Record<string, unknown> }) { const rows = this.filter({ filter, filterByTk }); rows.forEach((row) => Object.assign(row, values)); return rows[0] ?? null; }
  private filter(params: { filter?: Record<string, unknown>; filterByTk?: string | number }) { if (params.filterByTk) return this.records.filter((record) => record.id === params.filterByTk); const filter = params.filter ?? {}; return this.records.filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value)); }
}

class MemoryDatabase implements EcobaseDatabase {
  repos = new Map<string, MemoryRepository>();
  constructor() { Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repos.set(name, new MemoryRepository())); }
  getRepository(name: string) { const repo = this.repos.get(name); if (!repo) throw new Error(`missing repo ${name}`); return repo; }
}

function context(db: EcobaseDatabase, values: Record<string, unknown>) {
  return { action: { params: { values } }, db, body: undefined as any, throw(status: number, message: string) { const error = new Error(message) as Error & { status?: number }; error.status = status; throw error; } };
}

function approvedChecklist() {
  return REQUIRED_CHECKLIST_ITEMS.reduce((result, key) => ({ ...result, [key]: { status: 'approved', evidence: `${key}-evidence` } }), {});
}

async function seedBenchmark(db: MemoryDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({ values: { id: 'alert-1', company: 'ACME', subjectRef: 'product-1', planningProductId: 'product-1', rootCauses: [{ code: 'reorder_needed' }], primaryRootCauseCode: 'reorder_needed' } });
  await db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).create({ values: { id: 'answer-1', company: 'ACME', question: 'stock risk', response: 'B00AI needs reorder based on alert evidence', provider: 'ecobase-plugin-retrieval', model: 'deterministic-evidence-v1', confidence: 'evidence-backed', dataCompleteness: 'complete', evidenceReferences: [{ type: 'alert', id: 'alert-1' }], coverageGroup: 'stock_inventory', createdAt: '2026-06-05T08:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.benchmarkFixtures).create({ values: { id: 'fixture-critical', company: 'ACME', fixtureType: 'critical_detection', subjectRef: 'product-1', expectedSeverity: 'critical', createdAt: '2026-06-05T08:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.benchmarkFixtures).create({ values: { id: 'fixture-root', company: 'ACME', fixtureType: 'root_cause', subjectRef: 'product-1', expectedRootCauses: ['reorder_needed'], createdAt: '2026-06-05T08:00:00.000Z' } });
  await db.getRepository(ECOBASE_COLLECTIONS.benchmarkFixtures).create({ values: { id: 'fixture-ai', company: 'ACME', fixtureType: 'ai_answer', subjectRef: 'stock_inventory', expectedAnswerFacts: ['reorder'], requiredEvidenceTypes: ['alert'], createdAt: '2026-06-05T08:00:00.000Z' } });
}

describe('Ecobase accuracy harness service', () => {
  it('blocks formal evaluation until data-quality sign-off is approved by the user/business', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseAccuracyHarnessService(db);
    const draft = await service.recordSignoff({ company: 'ACME', status: 'draft', checklist: service.checklistTemplate() });

    const evaluation = await service.evaluate({ company: 'ACME', dataQualitySignoffId: draft.id });

    expect(evaluation.status).toBe('blocked_pending_data_quality_signoff');
    expect(evaluation.report).toMatchObject({ reason: expect.stringContaining('data-quality-signed-off') });
  });

  it('scores signed-off benchmark fixtures and separates benchmark categories', async () => {
    const db = new MemoryDatabase();
    await seedBenchmark(db);
    const service = new EcobaseAccuracyHarnessService(db);
    const signoff = await service.recordSignoff({ company: 'ACME', status: 'data-quality-signed-off', signedOffBy: 'business-owner', checklist: approvedChecklist() });

    const evaluation = await service.evaluate({ company: 'ACME', dataQualitySignoffId: signoff.id });

    expect(evaluation).toMatchObject({ status: 'passed', criticalDetectionAccuracy: 100, rootCauseAccuracy: 100, aiAnswerAccuracy: 100 });
    expect(evaluation.report).toMatchObject({ warningPolicy: expect.stringContaining('Warning-only') });
  });

  it('exposes checklist, sign-off, and evaluate public actions', async () => {
    const db = new MemoryDatabase();
    const next = vi.fn();
    const templateContext = context(db, {});
    await createEcobaseAccuracyActions().checklistTemplate(templateContext, next);
    expect(templateContext.body).toEqual({ data: expect.objectContaining({ sourceData: expect.any(Object), freshness: expect.any(Object) }) });

    const signoffContext = context(db, { status: 'draft' });
    await createEcobaseAccuracyActions().recordSignoff(signoffContext, next);
    expect(signoffContext.body).toEqual({ data: expect.objectContaining({ status: 'draft' }) });

    const evaluateContext = context(db, { dataQualitySignoffId: signoffContext.body.data.id });
    await createEcobaseAccuracyActions().evaluate(evaluateContext, next);
    expect(evaluateContext.body).toEqual({ data: expect.objectContaining({ status: 'blocked_pending_data_quality_signoff' }) });
  });
});
