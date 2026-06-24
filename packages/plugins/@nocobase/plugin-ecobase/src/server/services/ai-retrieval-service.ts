import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';

type PlainRecord = Record<string, unknown>;
type EvidenceReference = { type: string; id?: string; label?: string; warning?: string };

export type AiAnswerParams = {
  question: string;
  company?: string;
  date?: string;
  calculationDate?: string;
  periodType?: 'daily' | 'weekly' | 'monthly';
  period?: string;
  limit?: number;
};

type AiAnswerOptions = {
  persist?: boolean;
};

type CoverageStatus = 'answerable' | 'answerable-with-warning' | 'blocked-by-missing-source';

const APPENDIX_A_COVERAGE = [
  {
    group: 'operational_intelligence',
    questions: 'What is the current operating focus and what needs attention?',
    requiredData: ['goldInventoryPlanningRows', 'goldSupplierAttentionRows', 'goldAlerts'],
    retrievalTool: 'ecobase_retrieve_facts',
    expectedEvidenceType: ['gold_inventory_planning_row', 'gold_supplier_attention_row', 'gold_alert'],
    status: 'answerable' as CoverageStatus,
  },
  {
    group: 'stock_inventory',
    questions: 'Current OOS, likely OOS soon, urgent reorder, estimated profit loss, late reorder.',
    requiredData: ['goldInventoryPlanningRows', 'silverInventorySnapshots', 'silverListingDailyFacts'],
    retrievalTool: 'ecobase_inventory_digest',
    expectedEvidenceType: ['gold_inventory_planning_row', 'silver_inventory_snapshot', 'silver_listing_daily_fact'],
    status: 'answerable' as CoverageStatus,
  },
  {
    group: 'order_management',
    questions:
      'Delayed orders, no recent updates, immediate follow-up, whether order is already placed, current suppliers, expected sellable dates.',
    requiredData: ['silverOrders', 'silverOrderLines', 'silverSuppliers', 'goldSupplierAttentionRows'],
    retrievalTool: 'ecobase_supplier_orders',
    expectedEvidenceType: ['silver_order', 'silver_order_line', 'silver_supplier'],
    status: 'answerable' as CoverageStatus,
  },
  {
    group: 'comparative_strategic',
    questions: 'Velocity, sales, profit, and margin comparisons from the silver fact layer.',
    requiredData: ['silverListingDailyFacts', 'silverInventorySnapshots'],
    retrievalTool: 'ecobase_retrieve_facts',
    expectedEvidenceType: ['silver_listing_daily_fact', 'silver_inventory_snapshot'],
    status: 'answerable-with-warning' as CoverageStatus,
  },
  {
    group: 'ai_query_system',
    questions:
      'Management focus today, five biggest SKU problems, highest financial risks, urgent interventions, team focus.',
    requiredData: ['goldInventoryPlanningRows', 'goldSupplierAttentionRows', 'goldAlerts', 'silverOrders'],
    retrievalTool: 'ecobase_answer_ephemeral',
    expectedEvidenceType: ['gold_inventory_planning_row', 'gold_supplier_attention_row', 'gold_alert'],
    status: 'answerable' as CoverageStatus,
  },
];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function asRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function idOf(record: PlainRecord) {
  return asString(record.id) ?? asString(record.naturalKey) ?? asString(record.orderRef) ?? asString(record.asin);
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function limited(value: unknown, defaultValue: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), max)
    : defaultValue;
}

function sortByRisk(rows: PlainRecord[]) {
  return [...rows].sort(
    (left, right) =>
      (asNumber(right.estimatedProfitRisk ?? right.moneyAtRisk) ?? 0) -
      (asNumber(left.estimatedProfitRisk ?? left.moneyAtRisk) ?? 0),
  );
}

function productLabel(row: PlainRecord) {
  return asString(row.asin) ?? asString(row.sku) ?? asString(row.title) ?? idOf(row) ?? 'unknown product';
}

function compactRows(rows: PlainRecord[], fields: string[], limit = rows.length) {
  return rows.slice(0, limit).map((row) => {
    const output: PlainRecord = {};
    for (const field of ['id', 'naturalKey', ...fields]) {
      const value = row[field];
      if (value !== undefined && value !== null && value !== '') {
        output[field] = value;
      }
    }
    return output;
  });
}

const INVENTORY_FACT_FIELDS = [
  'company',
  'calculationDate',
  'asin',
  'sku',
  'title',
  'supplierName',
  'supplierId',
  'actionStatus',
  'estimatedOosDate',
  'latestSafeReorderDate',
  'expectedSellableDate',
  'leadTimeDays',
  'leadTimeFreshnessStatus',
  'supplierOrderStatus',
  'supplierOrderRef',
  'recommendedAction',
  'estimatedProfitRisk',
  'moneyAtRisk',
  'suggestedReorderQty',
  'recommendedBestQty',
];

const SUPPLIER_ATTENTION_FIELDS = [
  'company',
  'supplierId',
  'supplierName',
  'asin',
  'sku',
  'recommendedAction',
  'attentionReason',
  'moneyAtRisk',
  'orderRef',
  'orderStatus',
  'expectedSellableDate',
  'leadTimeDays',
  'leadTimeFreshnessStatus',
];

const ORDER_FIELDS = [
  'company',
  'orderRef',
  'externalOrderRef',
  'supplierId',
  'supplierName',
  'lifecycleStatus',
  'status',
  'orderDate',
  'expectedSellableDate',
  'nextAction',
  'trackingId',
];

const ORDER_LINE_FIELDS = [
  'company',
  'orderRef',
  'supplierId',
  'supplierName',
  'asin',
  'sku',
  'title',
  'quantity',
  'orderedQty',
  'expectedSellableDate',
  'leadTimeDays',
  'lineStatus',
  'sourceStage',
];

export class EcobaseAiRetrievalService {
  constructor(private db: EcobaseDatabase) {}

  coverageMatrix() {
    return APPENDIX_A_COVERAGE;
  }

  async inventoryDigest(params: Partial<AiAnswerParams> = {}) {
    const limit = limited(params.limit, 10, 25);
    const rows = await this.goldInventoryRows(params, limit);
    const supplierAttentionRows = sortByRisk(
      await this.findRows(ECOBASE_COLLECTIONS.goldSupplierAttentionRows, { sort: ['-moneyAtRisk'], limit }),
    ).slice(0, limit);
    const alerts = await this.findRows(ECOBASE_COLLECTIONS.goldAlerts, { filter: { status: 'open' }, limit });
    const calculationDate = asString(rows[0]?.calculationDate) ?? params.calculationDate ?? params.date;
    const urgentRows = rows.filter((row) =>
      ['overdue', 'order_now', 'order_soon', 'stale_lead_time', 'missing_lead_time'].includes(
        asString(row.actionStatus) ?? '',
      ),
    );
    return {
      sourceModel: 'silver-gold-medallion',
      oldTablesUsed: false,
      filters: { company: params.company ?? null, calculationDate: calculationDate ?? null },
      summary: {
        rowCount: rows.length,
        urgentCount: urgentRows.length,
        supplierAttentionCount: supplierAttentionRows.length,
        alertCount: alerts.length,
        moneyAtRisk: rows.reduce((sum, row) => sum + (asNumber(row.estimatedProfitRisk) ?? 0), 0),
      },
      sections: {
        orderNow: compactRows(urgentRows, INVENTORY_FACT_FIELDS, limit),
        supplierAttentionRows: compactRows(supplierAttentionRows, SUPPLIER_ATTENTION_FIELDS, limit),
        alerts: compactRows(
          alerts,
          ['company', 'severity', 'status', 'title', 'message', 'asin', 'sku', 'createdAt'],
          limit,
        ),
        topRiskRows: compactRows(rows, INVENTORY_FACT_FIELDS, limit),
      },
    };
  }

  async supplierOrderEvidence(params: Partial<AiAnswerParams> & { status?: string } = {}) {
    const limit = limited(params.limit, 10, 25);
    const orderFilter: PlainRecord = {};
    if (params.status) orderFilter.lifecycleStatus = params.status;
    const orders = await this.findRows(ECOBASE_COLLECTIONS.silverOrders, {
      filter: Object.keys(orderFilter).length ? orderFilter : undefined,
      sort: ['-orderDate'],
      limit,
    });
    return {
      sourceModel: 'silver-gold-medallion',
      oldTablesUsed: false,
      filters: { company: params.company ?? null, status: params.status ?? null },
      orders: compactRows(
        params.company ? orders.filter((order) => JSON.stringify(order).includes(String(params.company))) : orders,
        ORDER_FIELDS,
        limit,
      ),
      orderLines: compactRows(
        await this.findRows(ECOBASE_COLLECTIONS.silverOrderLines, { sort: ['-expectedSellableDate'], limit }),
        ORDER_LINE_FIELDS,
        limit,
      ),
      suppliers: compactRows(
        await this.findRows(ECOBASE_COLLECTIONS.silverSuppliers, { sort: ['nextFollowUpAt'], limit }),
        ['company', 'displayName', 'normalizedName', 'approvalStatus', 'nextFollowUpAt', 'contactName', 'email'],
        limit,
      ),
      supplierProducts: compactRows(
        await this.findRows(ECOBASE_COLLECTIONS.silverSupplierProducts, { limit }),
        ['supplierId', 'productId', 'supplierSku', 'unitCost', 'leadTimeDays', 'analysisStatus'],
        limit,
      ),
      supplierAttentionRows: compactRows(
        await this.findRows(ECOBASE_COLLECTIONS.goldSupplierAttentionRows, {
          sort: ['-moneyAtRisk'],
          limit,
        }),
        SUPPLIER_ATTENTION_FIELDS,
        limit,
      ),
    };
  }

  async budgetRecommendations(params: Partial<AiAnswerParams> & { budget?: number }) {
    const budget = asNumber(params.budget);
    if (budget === undefined || budget <= 0) {
      throw new Error('Ecobase budget recommendation failed: budget must be greater than zero.');
    }
    const digest = await this.inventoryDigest(params);
    return {
      sourceModel: 'silver-gold-medallion',
      oldTablesUsed: false,
      budget,
      note: 'Gold inventory rows do not currently expose unit purchase cost, so this ranks approvals by money at risk instead of pretending to spend the budget.',
      recommendations: digest.sections.topRiskRows.slice(0, 20).map((row) => ({
        company: row.company,
        asin: row.asin,
        sku: row.sku,
        supplierName: row.supplierName,
        actionStatus: row.actionStatus,
        estimatedProfitRisk: row.estimatedProfitRisk,
        suggestedReorderQty: row.suggestedReorderQty ?? row.recommendedBestQty,
        estimatedOosDate: row.estimatedOosDate,
        expectedSellableDate: row.expectedSellableDate,
      })),
    };
  }

  async retrieveFacts(params: AiAnswerParams) {
    const limit = limited(params.limit, 10, 25);
    const inventoryDigest = await this.inventoryDigest({ ...params, limit });
    const supplierOrders = await this.supplierOrderEvidence({ ...params, limit });
    return {
      sourceModel: 'silver-gold-medallion',
      oldTablesUsed: false,
      inventoryDigest,
      gold: {
        inventoryPlanningRows: inventoryDigest.sections.topRiskRows,
        supplierAttentionRows: inventoryDigest.sections.supplierAttentionRows,
        alerts: inventoryDigest.sections.alerts,
      },
      silver: {
        products: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverProducts, { limit }),
          ['asin', 'sku', 'title', 'brand', 'company'],
          limit,
        ),
        companyProducts: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverCompanyProducts, { limit }),
          ['company', 'productId', 'asin', 'sku', 'status'],
          limit,
        ),
        suppliers: supplierOrders.suppliers,
        supplierProducts: supplierOrders.supplierProducts,
        companyProductSuppliers: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, { limit }),
          ['company', 'productId', 'supplierId', 'supplierSku', 'role', 'leadTimeDays'],
          limit,
        ),
        orders: supplierOrders.orders,
        orderLines: supplierOrders.orderLines,
        inventorySnapshots: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverInventorySnapshots, {
            sort: ['-snapshotDate'],
            limit,
          }),
          ['company', 'asin', 'sku', 'snapshotDate', 'sellableQty', 'reservedQty', 'inboundQty'],
          limit,
        ),
        listingDailyFacts: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverListingDailyFacts, {
            sort: ['-snapshotDate'],
            limit,
          }),
          ['company', 'asin', 'sku', 'snapshotDate', 'unitsOrdered', 'orderedProductSales', 'buyBoxPercentage'],
          limit,
        ),
        tasks: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverTasks, { limit }),
          ['company', 'title', 'status', 'priority', 'owner', 'dueDate'],
          limit,
        ),
        taskLinks: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverTaskLinks, { limit }),
          ['taskId', 'entityType', 'entityId', 'asin', 'sku'],
          limit,
        ),
        humanApprovals: compactRows(
          await this.findRows(ECOBASE_COLLECTIONS.silverHumanApprovals, { limit }),
          ['company', 'entityType', 'entityId', 'status', 'approvedBy', 'approvedAt'],
          limit,
        ),
      },
    };
  }

  async answerQuestion(params: AiAnswerParams, options: AiAnswerOptions = {}) {
    const question = asString(params.question);
    if (!question) {
      throw new Error('Ecobase AI answer failed: question is required.');
    }
    const facts = await this.retrieveFacts(params);
    const group = this.classifyQuestion(question);
    const evidenceReferences = this.selectEvidence(group, facts);
    const warnings = this.collectWarnings(facts, evidenceReferences);
    const response = this.composeResponse(question, group, facts, evidenceReferences, warnings);
    const dataCompleteness = warnings.length ? 'answerable-with-warning' : 'complete';
    const answer = {
      id: randomUUID(),
      question,
      response,
      company: params.company,
      provider: 'ecobase-plugin-retrieval',
      model: 'silver-gold-medallion-v1',
      confidence: evidenceReferences.length ? 'evidence-backed' : 'low-missing-source',
      dataCompleteness,
      evidenceReferences,
      warnings,
      coverageGroup: group,
      createdAt: new Date().toISOString(),
    };
    if (options.persist !== false) {
      await this.db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).create({ values: answer });
    }
    return answer;
  }

  private classifyQuestion(question: string) {
    const normalized = question.toLowerCase();
    if (includesAny(normalized, ['task', 'approval', 'owner', 'follow up', 'follow-up']))
      return 'operational_intelligence';
    if (includesAny(normalized, ['stock', 'oos', 'reorder', 'inventory', 'profit loss', 'late reorder']))
      return 'stock_inventory';
    if (includesAny(normalized, ['order', 'supplier', 'lead time', 'contact', 'already placed', 'alternative']))
      return 'order_management';
    if (includesAny(normalized, ['compare', 'week', 'month', 'trend', 'declining', 'improving', 'velocity', 'margin']))
      return 'comparative_strategic';
    if (includesAny(normalized, ['focus', 'biggest', 'financial risk', 'urgent', 'team', 'next action']))
      return 'ai_query_system';
    return 'operational_intelligence';
  }

  private selectEvidence(group: string, facts: Awaited<ReturnType<EcobaseAiRetrievalService['retrieveFacts']>>) {
    const refs: EvidenceReference[] = [];
    const add = (type: string, rows: unknown[], labelField?: string) => {
      for (const row of rows.map(asRecord).slice(0, 10)) {
        refs.push({ type, id: idOf(row), label: asString(row[labelField ?? 'title']) ?? productLabel(row) });
      }
    };
    if (['operational_intelligence', 'stock_inventory', 'ai_query_system'].includes(group)) {
      add('gold_inventory_planning_row', facts.gold.inventoryPlanningRows, 'asin');
      add('gold_supplier_attention_row', facts.gold.supplierAttentionRows, 'recommendedAction');
      add('gold_alert', facts.gold.alerts, 'alertType');
    }
    if (group === 'order_management' || group === 'stock_inventory') {
      add('silver_order', facts.silver.orders, 'orderRef');
      add('silver_order_line', facts.silver.orderLines, 'expectedSellableDate');
      add('silver_supplier', facts.silver.suppliers, 'displayName');
    }
    if (group === 'comparative_strategic' || group === 'ai_query_system') {
      add('silver_listing_daily_fact', facts.silver.listingDailyFacts, 'snapshotDate');
      add('silver_inventory_snapshot', facts.silver.inventorySnapshots, 'snapshotDate');
    }
    return refs.filter(
      (ref, index, all) => all.findIndex((other) => `${other.type}:${other.id}` === `${ref.type}:${ref.id}`) === index,
    );
  }

  private collectWarnings(
    facts: Awaited<ReturnType<EcobaseAiRetrievalService['retrieveFacts']>>,
    evidenceReferences: EvidenceReference[],
  ) {
    const warnings: EvidenceReference[] = [];
    if (facts.sourceModel !== 'silver-gold-medallion' || facts.oldTablesUsed !== false) {
      warnings.push({ type: 'source_model', warning: 'Evidence was not limited to the silver/gold medallion model.' });
    }
    if (evidenceReferences.length === 0) {
      warnings.push({ type: 'missing_source', warning: 'No scoped silver/gold evidence was available.' });
    }
    return warnings;
  }

  private composeResponse(
    question: string,
    group: string,
    facts: Awaited<ReturnType<EcobaseAiRetrievalService['retrieveFacts']>>,
    evidenceReferences: EvidenceReference[],
    warnings: EvidenceReference[],
  ) {
    const topRisks = facts.gold.inventoryPlanningRows.slice(0, 5).map((row) => {
      const record = asRecord(row);
      return `${productLabel(record)}: ${asString(record.actionStatus) ?? 'review'}; risk ${
        asNumber(record.estimatedProfitRisk) ?? 0
      }; OOS ${asString(record.estimatedOosDate) ?? 'unknown'}; supplier ${asString(record.supplierName) ?? 'unknown'}`;
    });
    const supplierActions = facts.gold.supplierAttentionRows.slice(0, 5).map((row) => {
      const record = asRecord(row);
      return `${asString(record.recommendedAction) ?? 'review supplier'}; risk ${asNumber(record.moneyAtRisk) ?? 0}`;
    });
    const orders = facts.silver.orders.slice(0, 5).map((order) => {
      const record = asRecord(order);
      return `${asString(record.orderRef) ?? idOf(record) ?? 'order'} status ${
        asString(record.lifecycleStatus) ?? 'unknown'
      } next ${asString(record.nextAction) ?? 'review'}`;
    });
    const parts = [
      `Question: ${question}`,
      `Coverage group: ${group}.`,
      'Evidence source: silver/gold medallion tables only.',
    ];
    if (topRisks.length) parts.push(`Top inventory risks: ${topRisks.join('; ')}.`);
    if (supplierActions.length) parts.push(`Supplier attention: ${supplierActions.join('; ')}.`);
    if (orders.length) parts.push(`Supplier/order evidence: ${orders.join('; ')}.`);
    parts.push(`Evidence references: ${evidenceReferences.length}.`);
    if (warnings.length)
      parts.push(
        `Warnings: ${warnings.map((warning) => warning.warning ?? warning.label ?? warning.type).join('; ')}.`,
      );
    parts.push(
      'Recommended next actions should be treated as read-only guidance; this tool cannot create, update, or resolve operational records.',
    );
    return parts.join(' ');
  }

  private async goldInventoryRows(params: Partial<AiAnswerParams>, limit: number) {
    const filter: PlainRecord = {};
    const calculationDate = params.calculationDate ?? params.date;
    if (params.company) filter.company = params.company;
    if (calculationDate) filter.calculationDate = calculationDate;
    const rows = await this.findRows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      filter: Object.keys(filter).length ? filter : undefined,
      sort: ['-calculationDate'],
      limit: Math.max(limit * 5, 100),
    });
    const latestDate =
      calculationDate ??
      rows
        .map((row) => asString(row.calculationDate))
        .filter(Boolean)
        .sort()
        .at(-1);
    const scopedRows = latestDate ? rows.filter((row) => asString(row.calculationDate) === latestDate) : rows;
    return sortByRisk(scopedRows).slice(0, limit);
  }

  private async findRows(collection: string, params: PlainRecord = {}) {
    return (await this.db.getRepository(collection).find(params)).map(asRecord);
  }
}
