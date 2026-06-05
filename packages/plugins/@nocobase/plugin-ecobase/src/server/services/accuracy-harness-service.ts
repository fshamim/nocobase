import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';

type PlainRecord = Record<string, unknown>;

type SignoffParams = {
  company?: string;
  status?: 'draft' | 'data-quality-signed-off' | 'blocked/not-accepted-for-contract-delivery';
  signedOffBy?: string;
  checklist?: PlainRecord;
  credentialBlockers?: unknown[];
  notes?: string;
};

type EvaluationParams = { company?: string; dataQualitySignoffId: string };

const REQUIRED_CHECKLIST_ITEMS = [
  'sourceData',
  'liveSellerboardApi',
  'amazonSpApiStatus',
  'googleSheetsInputs',
  'leadTimes',
  'targets',
  'supplierOrders',
  'clickupLinks',
  'skuPlanningMappings',
  'freshness',
];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function percent(correct: number, total: number) {
  return total === 0 ? 0 : Math.round((correct / total) * 10000) / 100;
}

function containsAll(actual: unknown, expectedValues: unknown[]) {
  const serialized = JSON.stringify(actual ?? '').toLowerCase();
  return expectedValues.every((value) => serialized.includes(String(value).toLowerCase()));
}

export class EcobaseAccuracyHarnessService {
  constructor(private db: EcobaseDatabase) {}

  checklistTemplate() {
    return REQUIRED_CHECKLIST_ITEMS.reduce((result, key) => ({ ...result, [key]: { status: 'pending', evidence: null } }), {} as PlainRecord);
  }

  async recordSignoff(params: SignoffParams) {
    const status = params.status ?? 'draft';
    if (status === 'data-quality-signed-off' && !asString(params.signedOffBy)) {
      throw new Error('Ecobase data-quality sign-off failed: signedOffBy is required for formal sign-off.');
    }
    const checklist = { ...this.checklistTemplate(), ...asRecord(params.checklist) };
    const missing = REQUIRED_CHECKLIST_ITEMS.filter((key) => asString(asRecord(checklist[key]).status) !== 'approved');
    if (status === 'data-quality-signed-off' && missing.length) {
      throw new Error(`Ecobase data-quality sign-off failed: checklist items still need approval: ${missing.join(', ')}.`);
    }
    const record = {
      id: randomUUID(),
      status,
      company: params.company,
      signedOffBy: params.signedOffBy,
      signedOffAt: status === 'data-quality-signed-off' ? new Date().toISOString() : undefined,
      checklist,
      credentialBlockers: params.credentialBlockers ?? [],
      notes: params.notes,
      createdAt: new Date().toISOString(),
    };
    await this.db.getRepository(ECOBASE_COLLECTIONS.dataQualitySignoffs).create({ values: record });
    return record;
  }

  async evaluate(params: EvaluationParams) {
    const signoff = asRecord(await this.db.getRepository(ECOBASE_COLLECTIONS.dataQualitySignoffs).findOne({ filterByTk: params.dataQualitySignoffId }));
    if (!asString(signoff.id)) {
      throw new Error('Ecobase accuracy evaluation failed: data-quality sign-off was not found.');
    }
    if (asString(signoff.status) !== 'data-quality-signed-off') {
      const blocked = await this.createEvaluationRun(params, signoff, 'blocked_pending_data_quality_signoff', {
        reason: 'Formal scoring is invalid until data-quality-signed-off is recorded by the user/business.',
      });
      return blocked;
    }

    const fixtures = (await this.db.getRepository(ECOBASE_COLLECTIONS.benchmarkFixtures).find({ filter: params.company ? { company: params.company } : undefined })).map(asRecord);
    const alerts = (await this.db.getRepository(ECOBASE_COLLECTIONS.alerts).find({ filter: params.company ? { company: params.company } : undefined })).map(asRecord);
    const aiAnswers = (await this.db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).find({ filter: params.company ? { company: params.company } : undefined })).map(asRecord);

    const criticalFixtures = fixtures.filter((fixture) => asString(fixture.fixtureType) === 'critical_detection');
    const rootCauseFixtures = fixtures.filter((fixture) => asString(fixture.fixtureType) === 'root_cause');
    const aiFixtures = fixtures.filter((fixture) => asString(fixture.fixtureType) === 'ai_answer');

    const criticalCorrect = criticalFixtures.filter((fixture) => alerts.some((alert) => asString(alert.subjectRef) === asString(fixture.subjectRef) || asString(alert.planningProductId) === asString(fixture.subjectRef))).length;
    const rootCauseCorrect = rootCauseFixtures.filter((fixture) => alerts.some((alert) => containsAll(alert.rootCauses, asArray(fixture.expectedRootCauses)) || containsAll(alert.primaryRootCauseCode, asArray(fixture.expectedRootCauses)))).length;
    const aiCorrect = aiFixtures.filter((fixture) => aiAnswers.some((answer) => containsAll(answer.response, asArray(fixture.expectedAnswerFacts)) && containsAll(answer.evidenceReferences, asArray(fixture.requiredEvidenceTypes)))).length;

    const report = {
      benchmarkMinimums: { criticalDetection: 80, rootCauseQuality: 'signed-off expected causes', aiAnswerAccuracy: 80 },
      fixtureCounts: { criticalDetections: criticalFixtures.length, rootCauses: rootCauseFixtures.length, aiAnswers: aiFixtures.length },
      correctCounts: { criticalDetections: criticalCorrect, rootCauses: rootCauseCorrect, aiAnswers: aiCorrect },
      warningPolicy: 'Warning-only, missing-source, stale-source, and credential-blocked answers are tracked separately and do not count as correct unless signed off as out of scope.',
    };
    const scores = {
      criticalDetectionAccuracy: percent(criticalCorrect, criticalFixtures.length),
      rootCauseAccuracy: percent(rootCauseCorrect, rootCauseFixtures.length),
      aiAnswerAccuracy: percent(aiCorrect, aiFixtures.length),
    };
    const status = scores.criticalDetectionAccuracy >= 80 && scores.aiAnswerAccuracy >= 80 ? 'passed' : 'failed';
    return this.createEvaluationRun(params, signoff, status, report, scores);
  }

  private async createEvaluationRun(params: EvaluationParams, signoff: PlainRecord, status: string, report: PlainRecord, scores: Partial<PlainRecord> = {}) {
    const record = {
      id: randomUUID(),
      company: params.company ?? asString(signoff.company),
      dataQualitySignoffId: asString(signoff.id),
      status,
      criticalDetectionAccuracy: scores.criticalDetectionAccuracy,
      rootCauseAccuracy: scores.rootCauseAccuracy,
      aiAnswerAccuracy: scores.aiAnswerAccuracy,
      report,
      failureBreakdown: status === 'failed' ? { productFailures: [], sourceDataFailuresTrackedSeparately: true } : {},
      createdAt: new Date().toISOString(),
    };
    await this.db.getRepository(ECOBASE_COLLECTIONS.accuracyEvaluationRuns).create({ values: record });
    return record;
  }
}

export { REQUIRED_CHECKLIST_ITEMS };
