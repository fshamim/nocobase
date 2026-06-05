import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseComparisonService } from './comparison-service';
import { EcobaseDataWarningService } from './data-warning-service';
import type { EcobaseDatabase } from './import-service';

type PlainRecord = Record<string, unknown>;
type EvidenceReference = { type: string; id?: string; label?: string; warning?: string };

type AiAnswerParams = {
  question: string;
  company?: string;
  date?: string;
  periodType?: 'daily' | 'weekly' | 'monthly';
  period?: string;
};

type CoverageStatus = 'answerable' | 'answerable-with-warning' | 'blocked-by-missing-source';

const APPENDIX_A_COVERAGE = [
  {
    group: 'operational_intelligence',
    questions: 'Which products are off track today/week/month? Why? Biggest profit gap? Immediate attention? No operational action?',
    requiredData: ['planningCalculationSnapshots', 'alerts', 'taskLinks', 'dataWarnings'],
    retrievalTool: 'ecobaseAi:answer operational_intelligence',
    expectedEvidenceType: ['planning_product', 'alert', 'data_warning'],
    status: 'answerable' as CoverageStatus,
  },
  {
    group: 'okr_accountability',
    questions: 'Which OKRs are off track? Which areas/persons/tasks lack progress?',
    requiredData: ['clickupTaskSnapshots', 'taskLinks', 'okrs', 'okrMetricSnapshots'],
    retrievalTool: 'ecobaseAi:answer okr_accountability',
    expectedEvidenceType: ['clickup_task_snapshot', 'okr_metric_snapshot'],
    status: 'answerable' as CoverageStatus,
  },
  {
    group: 'stock_inventory',
    questions: 'Current OOS, likely OOS soon, urgent reorder, estimated profit loss, late reorder.',
    requiredData: ['inventorySnapshots', 'planningParameters', 'supplierLeadTimes', 'alertEvaluations'],
    retrievalTool: 'ecobaseAi:answer stock_inventory',
    expectedEvidenceType: ['alert', 'planning_product', 'supplier_order_line'],
    status: 'answerable-with-warning' as CoverageStatus,
  },
  {
    group: 'order_management',
    questions: 'Delayed orders, no recent updates, immediate follow-up, profitability impact, orders to place this week, whether order is already placed, current/alternative suppliers, lead-time/contact freshness.',
    requiredData: ['supplierOrders', 'supplierOrderLines', 'supplierOrderActivities', 'supplierProductLinks', 'supplierLeadTimes'],
    retrievalTool: 'ecobaseAi:answer order_management',
    expectedEvidenceType: ['supplier_order', 'supplier_order_line', 'supplier_order_activity'],
    status: 'answerable-with-warning' as CoverageStatus,
  },
  {
    group: 'comparative_strategic',
    questions: 'Week/month comparisons, improving/declining products/accounts, consistent underperformers, recovery action impact.',
    requiredData: ['listingDailyFacts', 'reportItems', 'taskLinks', 'alerts'],
    retrievalTool: 'ecobaseAi:answer comparative_strategic',
    expectedEvidenceType: ['comparison_row', 'report_item', 'task_link'],
    status: 'answerable' as CoverageStatus,
  },
  {
    group: 'ai_query_system',
    questions: 'Management focus today, five biggest SKU problems, highest financial risks, urgent interventions, team focus.',
    requiredData: ['alerts', 'alertEvaluations', 'sourceConnections', 'importRuns'],
    retrievalTool: 'ecobaseAi:answer ai_query_system',
    expectedEvidenceType: ['alert', 'alert_evaluation', 'source_status'],
    status: 'answerable' as CoverageStatus,
  },
];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function idOf(record: PlainRecord) {
  return asString(record.id) ?? asString(record.naturalKey) ?? asString(record.dedupeKey) ?? asString(record.externalTaskId);
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function sortByRisk(rows: PlainRecord[]) {
  return [...rows].sort((left, right) => (asNumber(right.estimatedProfitRisk) ?? 0) - (asNumber(left.estimatedProfitRisk) ?? 0));
}

export class EcobaseAiRetrievalService {
  constructor(private db: EcobaseDatabase) {}

  coverageMatrix() {
    return APPENDIX_A_COVERAGE;
  }

  async retrieveFacts(params: AiAnswerParams) {
    const companyFilter = params.company ? { company: params.company } : undefined;
    const alerts = await this.db.getRepository(ECOBASE_COLLECTIONS.alerts).find({ filter: { ...(companyFilter ?? {}), status: 'open' }, sort: ['-lastSeenAt'], limit: 50 });
    const calculations = await this.db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).find({ filter: companyFilter, sort: ['-calculationDate'], limit: 50 });
    const supplierOrders = await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).find({ filter: companyFilter, sort: ['-updatedAt'], limit: 50 });
    const supplierOrderLines = await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).find({ filter: companyFilter, sort: ['-expectedSellableDate'], limit: 50 });
    const supplierActivities = await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities).find({ filter: companyFilter, sort: ['-occurredAt'], limit: 50 });
    const supplierLinks = await this.db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).find({ sort: ['-lastOrderedAt'], limit: 50 });
    const leadTimes = await this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).find({ sort: ['-confirmedAt'], limit: 50 });
    const clickupTasks = await this.db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).find({ sort: ['-snapshotDate'], limit: 50 });
    const taskLinks = await this.db.getRepository(ECOBASE_COLLECTIONS.taskLinks).find({ limit: 50 });
    const okrs = await this.db.getRepository(ECOBASE_COLLECTIONS.okrs).find({ limit: 50 });
    const okrMetrics = await this.db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).find({ sort: ['-snapshotDate'], limit: 50 });
    const reportRuns = await this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns).find({ filter: companyFilter, sort: ['-generatedAt'], limit: 10 });
    const reportItems = await this.db.getRepository(ECOBASE_COLLECTIONS.reportItems).find({ sort: ['sortOrder'], limit: 100 });
    const importStatuses = await this.sourceStatuses();
    const comparison = await new EcobaseComparisonService(this.db).comparePerformance({
      periodType: params.periodType ?? 'daily',
      period: params.period,
      currentStartDate: params.date,
      currentEndDate: params.date,
      company: params.company,
      groupBy: 'planning_product',
    });
    return {
      planningProducts: calculations,
      alerts,
      reports: { reportRuns, reportItems },
      importStatuses,
      dataWarnings: importStatuses.flatMap((status) => Array.isArray(status.warnings) ? status.warnings : []),
      supplierOrders,
      supplierOrderLines,
      supplierActivities,
      supplierLeadTimes: leadTimes,
      supplierProductCandidates: supplierLinks,
      accountability: { clickupTasks, taskLinks, okrs, okrMetrics },
      comparativeRollups: comparison.rows,
    };
  }

  async answerQuestion(params: AiAnswerParams) {
    const question = asString(params.question);
    if (!question) {
      throw new Error('Ecobase AI answer failed: question is required.');
    }
    const facts = await this.retrieveFacts(params);
    const group = this.classifyQuestion(question);
    const evidenceReferences = this.selectEvidence(group, facts);
    const warnings = this.collectWarnings(facts, group, evidenceReferences);
    const response = this.composeResponse(question, group, facts, evidenceReferences, warnings);
    const dataCompleteness = warnings.length ? 'answerable-with-warning' : 'complete';
    const answer = {
      id: randomUUID(),
      question,
      response,
      company: params.company,
      provider: 'ecobase-plugin-retrieval',
      model: 'deterministic-evidence-v1',
      confidence: evidenceReferences.length ? 'evidence-backed' : 'low-missing-source',
      dataCompleteness,
      evidenceReferences,
      warnings,
      coverageGroup: group,
      createdAt: new Date().toISOString(),
    };
    await this.db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).create({ values: answer });
    return answer;
  }

  private classifyQuestion(question: string) {
    const normalized = question.toLowerCase();
    if (includesAny(normalized, ['okr', 'accountability', 'owner', 'person', 'task', 'clickup', 'inactive', 'overdue'])) return 'okr_accountability';
    if (includesAny(normalized, ['stock', 'oos', 'reorder', 'inventory', 'profit loss', 'late reorder'])) return 'stock_inventory';
    if (includesAny(normalized, ['order', 'supplier', 'lead time', 'contact', 'already placed', 'alternative'])) return 'order_management';
    if (includesAny(normalized, ['compare', 'week', 'month', 'trend', 'declining', 'improving', 'underperform'])) return 'comparative_strategic';
    if (includesAny(normalized, ['focus', 'biggest', 'financial risk', 'urgent', 'team'])) return 'ai_query_system';
    return 'operational_intelligence';
  }

  private selectEvidence(group: string, facts: Awaited<ReturnType<EcobaseAiRetrievalService['retrieveFacts']>>) {
    const refs: EvidenceReference[] = [];
    const add = (type: string, rows: unknown[], labelField?: string) => {
      for (const row of rows.map(asRecord).slice(0, 10)) {
        refs.push({ type, id: idOf(row), label: asString(row[labelField ?? 'title']) ?? asString(row.canonicalAsin) ?? asString(row.externalTaskId) ?? asString(row.status) });
      }
    };
    if (['operational_intelligence', 'stock_inventory', 'ai_query_system'].includes(group)) {
      add('alert', facts.alerts, 'alertType');
      add('planning_product', facts.planningProducts, 'canonicalAsin');
    }
    if (group === 'order_management' || group === 'stock_inventory') {
      add('supplier_order', facts.supplierOrders, 'externalOrderRef');
      add('supplier_order_line', facts.supplierOrderLines, 'planningProductId');
      add('supplier_order_activity', facts.supplierActivities, 'activityType');
      add('supplier_lead_time', facts.supplierLeadTimes, 'supplierName');
      add('supplier_product_candidate', facts.supplierProductCandidates, 'supplierName');
    }
    if (group === 'okr_accountability' || group === 'ai_query_system') {
      add('clickup_task_snapshot', facts.accountability.clickupTasks, 'taskName');
      add('task_link', facts.accountability.taskLinks, 'targetRef');
      add('okr_metric_snapshot', facts.accountability.okrMetrics, 'okrId');
    }
    if (group === 'comparative_strategic' || group === 'ai_query_system') {
      add('comparison_row', facts.comparativeRollups, 'label');
      add('report_item', facts.reports.reportItems, 'title');
    }
    for (const status of facts.importStatuses.slice(0, 10).map(asRecord)) {
      refs.push({ type: 'source_status', id: asString(status.sourceConnectionId), label: asString(status.connectionName) });
    }
    return refs.filter((ref, index, all) => all.findIndex((other) => `${other.type}:${other.id}` === `${ref.type}:${ref.id}`) === index);
  }

  private collectWarnings(facts: Awaited<ReturnType<EcobaseAiRetrievalService['retrieveFacts']>>, group: string, evidenceReferences: EvidenceReference[]) {
    const warnings: EvidenceReference[] = facts.importStatuses
      .filter((status) => Number(asRecord(status).warningCount ?? 0) > 0)
      .map((status) => ({ type: 'data_warning', id: asString(asRecord(status).sourceConnectionId), label: asString(asRecord(status).connectionName), warning: asString(asRecord(asRecord(status).latestWarning).message) ?? 'source warning recorded' }));
    if (evidenceReferences.length === 0) {
      warnings.push({ type: 'missing_source', warning: `No scoped evidence was available for ${group}.` });
    }
    return warnings;
  }

  private composeResponse(question: string, group: string, facts: Awaited<ReturnType<EcobaseAiRetrievalService['retrieveFacts']>>, evidenceReferences: EvidenceReference[], warnings: EvidenceReference[]) {
    const topAlerts = sortByRisk(facts.alerts.map(asRecord)).slice(0, 5).map((alert) => `${asString(alert.canonicalAsin) ?? asString(alert.subjectRef) ?? 'unknown'} (${asString(alert.alertType) ?? 'alert'} / ${asString(alert.severity) ?? 'unknown severity'})`);
    const topComparisons = facts.comparativeRollups.map(asRecord).slice(0, 5).map((row) => `${asString(row.label) ?? asString(row.key) ?? 'unknown'}: ${asString(row.classification) ?? 'unclassified'}, profit change ${asNumber(asRecord(row.change).netProfit) ?? 0}`);
    const tasks = facts.accountability.clickupTasks.map(asRecord).slice(0, 5).map((task) => `${asString(task.taskName) ?? asString(task.externalTaskId) ?? 'task'} owned by ${asString(task.assignee) ?? 'missing owner'} in ${asString(task.operationalArea) ?? 'missing area'}`);
    const orders = facts.supplierOrders.map(asRecord).slice(0, 5).map((order) => `${asString(order.externalOrderRef) ?? asString(order.id) ?? 'order'} status ${asString(order.status) ?? 'unknown'} supplier ${asString(order.supplierName) ?? asString(order.supplier) ?? 'unknown'}`);
    const parts = [`Question: ${question}`, `Coverage group: ${group}.`];
    if (['operational_intelligence', 'stock_inventory', 'ai_query_system'].includes(group)) parts.push(`Highest-priority alert evidence: ${topAlerts.length ? topAlerts.join('; ') : 'no alert evidence available'}.`);
    if (group === 'order_management' || group === 'stock_inventory') parts.push(`Supplier-order evidence: ${orders.length ? orders.join('; ') : 'no supplier-order evidence available'}.`);
    if (group === 'okr_accountability' || group === 'ai_query_system') parts.push(`Accountability evidence: ${tasks.length ? tasks.join('; ') : 'no ClickUp/OKR evidence available'}.`);
    if (group === 'comparative_strategic' || group === 'ai_query_system') parts.push(`Comparative evidence: ${topComparisons.length ? topComparisons.join('; ') : 'no comparison evidence available'}. Recovery-action impact is labelled correlation only, not proven causation.`);
    parts.push(`Evidence references: ${evidenceReferences.length}.`);
    if (warnings.length) parts.push(`Warnings: ${warnings.map((warning) => warning.warning ?? warning.label ?? warning.type).join('; ')}.`);
    parts.push('This retrieval layer cannot create, suppress, or resolve deterministic alerts.');
    return parts.join(' ');
  }

  private async sourceStatuses() {
    const sourceConnections = await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({ sort: ['name'] });
    const warningService = new EcobaseDataWarningService(this.db);
    return Promise.all(sourceConnections.map(async (sourceConnection) => {
      const sourceConnectionId = asString(asRecord(sourceConnection).id);
      if (!sourceConnectionId) throw new Error('Ecobase AI retrieval failed: source connection is missing id.');
      const warningAssessment = await warningService.assessSourceConnection(sourceConnectionId);
      return { sourceConnectionId, connectionName: asString(asRecord(sourceConnection).name), warningCount: warningAssessment.warnings.length, latestWarning: warningAssessment.latestWarning, warnings: warningAssessment.warnings };
    }));
  }
}

export { APPENDIX_A_COVERAGE };
