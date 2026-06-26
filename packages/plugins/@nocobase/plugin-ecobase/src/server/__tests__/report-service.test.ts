import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseReportActions } from '../plugin';
import { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseReportService } from '../services/report-service';
import { EcobaseDailyOperationsBriefDeliveryService } from '../services/daily-operations-brief-delivery-service';
import {
  EcobaseDailyOperationsBriefNarrativeService,
  NarrativeGroundingValidator,
  type EcoNarrativeProvider,
} from '../services/daily-operations-brief-narrative-service';
import type { DailyEvidencePack } from '../services/daily-operations-brief-service';

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
  async destroy({ filter, filterByTk }: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    const rows = this.filterRecords({ filter, filterByTk });
    this.records = this.records.filter((record) => !rows.includes(record));
    return rows.length;
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
  await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: {
      id: 'source-1',
      name: 'Sellerboard QA',
      sourceType: 'sellerboard',
      domain: 'amazon_operations',
      active: true,
      required: true,
      freshnessSlaMinutes: 1440,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
    values: {
      id: 'run-1',
      sourceConnectionId: 'source-1',
      adapterName: 'sellerboard_csv',
      sourceIdentifier: 'qa',
      sourceVersion: '2026-06-05',
      idempotencyKey: 'qa-run-1',
      status: 'success',
      rowCount: 10,
      normalizedCount: 10,
      warningCount: 0,
      startedAt: '2026-06-05T08:00:00.000Z',
      finishedAt: '2026-06-05T08:01:00.000Z',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
    values: {
      id: 'product-1',
      naturalKey: 'ACME:B00REPORT',
      company: 'ACME',
      canonicalAsin: 'B00REPORT',
      title: 'Report product',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
    values: {
      naturalKey: 'fact-current',
      sourceConnectionId: 'source-1',
      planningProductId: 'product-1',
      snapshotDate: '2026-06-05',
      company: 'ACME',
      asin: 'B00REPORT',
      sku: 'SKU-REPORT',
      sales: 200,
      units: 10,
      netProfit: 100,
      payload: { accountKey: 'US', tier: 'A' },
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
    values: {
      naturalKey: 'fact-prior',
      sourceConnectionId: 'source-1',
      planningProductId: 'product-1',
      snapshotDate: '2026-06-04',
      company: 'ACME',
      asin: 'B00REPORT',
      sku: 'SKU-REPORT',
      sales: 150,
      units: 8,
      netProfit: 70,
      payload: { accountKey: 'US', tier: 'A' },
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).create({
    values: {
      naturalKey: 'calc-1',
      planningProductId: 'product-1',
      calculationDate: '2026-06-05',
      company: 'ACME',
      canonicalAsin: 'B00REPORT',
      tier: 'A',
      sellableStock: 1,
      pipelineStock: 20,
      daysOfCover: 1,
      restockDeadlineImproved: '2026-06-07',
      profitGap: -80,
      estimatedProfitRisk: 500,
      calculationStatus: 'complete',
      dataCompleteness: 'complete',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.alerts).create({
    values: {
      id: 'alert-1',
      dedupeKey: 'alert-1',
      openedAt: '2026-06-05T08:00:00.000Z',
      planningProductId: 'product-1',
      company: 'ACME',
      canonicalAsin: 'B00REPORT',
      alertType: 'reorder_needed',
      severity: 'critical',
      status: 'open',
      primaryRootCauseCode: 'reorder_needed',
      subjectRef: 'planning_product:product-1',
      actionRequired: 'Place supplier order.',
      evidence: { calculationId: 'calc-1' },
      dataWarnings: [{ code: 'missing_velocity' }],
      rootCauses: [{ code: 'reorder_needed' }],
      lastSeenAt: '2026-06-05T08:05:00.000Z',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
    values: {
      id: 'order-1',
      company: 'ACME',
      supplierId: 'supplier-1',
      supplierName: 'Supplier One',
      externalOrderRef: 'PO-1',
      status: 'ordered',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
    values: {
      id: 'line-1',
      company: 'ACME',
      supplierOrderId: 'order-1',
      planningProductId: 'product-1',
      openQty: 20,
      expectedSellableDate: '2026-06-12',
      status: 'ordered',
      observedAt: '2026-06-05T08:00:00.000Z',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).create({
    values: {
      id: 'task-1',
      sourceConnectionId: 'source-1',
      snapshotDate: '2026-06-05',
      externalTaskId: 'CU-1',
      taskName: 'Call supplier',
      assignee: 'Ops',
      priority: 'high',
      status: 'open',
      operationalArea: 'Purchasing',
      lastMeaningfulUpdateAt: '2026-06-03T00:00:00.000Z',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).create({
    values: {
      id: 'okr-snap-1',
      okrId: 'okr-1',
      snapshotDate: '2026-06-05',
      status: 'off_track',
      owner: 'Ops',
      area: 'Purchasing',
    },
  });
}

describe('Ecobase report service', () => {
  it('creates report run and evidence-linked report items for daily preview', async () => {
    const db = new MemoryDatabase();
    await seedReportData(db);

    const report = await new EcobaseReportService(db).generateReport({
      company: 'ACME',
      frequency: 'daily',
      date: '2026-06-05',
      emailEnabled: true,
    });

    expect(report).toMatchObject({
      frequency: 'daily',
      periodStart: '2026-06-05',
      periodEnd: '2026-06-05',
      status: 'preview_generated',
      emailStatus: 'email_not_configured',
    });
    expect(report.executiveSummary).toContain('critical alerts');
    expect(report.items.map((item) => item.itemType)).toEqual(
      expect.arrayContaining([
        'critical_alert',
        'oos_reorder_risk',
        'supplier_order_risk',
        'accountability_task',
        'okr_status',
        'comparative_trend',
        'data_quality',
      ]),
    );
    expect(report.items.find((item) => item.itemType === 'critical_alert')).toMatchObject({
      evidenceRefType: 'alert',
      evidenceRefId: 'alert-1',
    });
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).find()).toHaveLength(1);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportItems).find()).toHaveLength(report.items.length);
  });

  it('generates idempotent daily operations brief evidence without secrets', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-brief-1',
        name: 'Sellerboard Brief',
        sourceType: 'sellerboard',
        domain: 'amazon_operations',
        active: true,
        required: true,
        freshnessSlaMinutes: 1440,
        secretRef: 'secret://sellerboard',
        config: { company: 'ACME', token: 'do-not-leak', warningPolicy: { required: true } },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-brief-1',
        sourceConnectionId: 'source-brief-1',
        adapterName: 'sellerboard_csv',
        sourceIdentifier: 'brief',
        sourceVersion: '2026-06-01',
        idempotencyKey: 'brief-run-1',
        status: 'success',
        rowCount: 20,
        normalizedCount: 20,
        warningCount: 0,
        startedAt: '2026-06-01T08:00:00.000Z',
        finishedAt: '2026-06-01T08:01:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: 'product-brief-1',
        naturalKey: 'ACME:B00BRIEF',
        company: 'ACME',
        canonicalAsin: 'B00BRIEF',
        title: 'Brief product',
        auditSummary: { source: 'inventory_planning_fallback' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
      values: {
        naturalKey: 'inventory-brief-1',
        sourceConnectionId: 'source-brief-1',
        planningProductId: 'product-brief-1',
        snapshotDate: '2026-06-10',
        company: 'ACME',
        asin: 'B00BRIEF',
        sku: 'SKU-BRIEF',
        stock: 0,
        reserved: 1,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: 3,
        payload: {},
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningParameters).create({
      values: {
        naturalKey: 'parameter-brief-1',
        sourceConnectionId: 'source-brief-1',
        planningProductId: 'product-brief-1',
        company: 'ACME',
        asin: 'B00BRIEF',
        sku: 'SKU-BRIEF',
        supplier: 'Brief Supplier',
        supplierId: 'supplier-brief-1',
        leadTimeDays: 24,
        confirmedAt: '2026-01-01T00:00:00.000Z',
        profitPerUnit: 10,
        payload: {},
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
      values: { id: 'supplier-brief-1', naturalKey: 'supplier:ACME:brief', company: 'ACME', name: 'Brief Supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).create({
      values: {
        id: 'supplier-link-1',
        company: 'ACME',
        planningProductId: 'product-brief-1',
        supplierId: 'supplier-brief-1',
        supplierName: 'Brief Supplier',
        role: 'preferred',
        confidence: 'high',
        active: true,
        lastSeenAt: '2026-06-01T00:00:00.000Z',
        payload: {},
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).create({
      values: {
        naturalKey: 'lead-time-brief-1',
        company: 'ACME',
        supplierId: 'supplier-brief-1',
        supplierName: 'Brief Supplier',
        planningProductId: 'product-brief-1',
        asin: 'B00BRIEF',
        sku: 'SKU-BRIEF',
        scope: 'product',
        leadTimeDays: 24,
        confirmedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).create({
      values: {
        naturalKey: 'calc-brief-1',
        planningProductId: 'product-brief-1',
        calculationDate: '2026-06-10',
        company: 'ACME',
        canonicalAsin: 'B00BRIEF',
        tier: 'A',
        sellableStock: 0,
        pipelineStock: 0,
        daysOfCover: 0,
        salesVelocity: 3,
        leadTimeDays: 24,
        restockDeadlineImproved: '2026-06-01',
        oosDate: '2026-06-11',
        estimatedProfitRisk: 750,
        calculationStatus: 'complete',
        dataCompleteness: 'complete',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
      values: {
        id: 'order-brief-1',
        company: 'ACME',
        supplierId: 'supplier-brief-1',
        supplierName: 'Brief Supplier',
        externalOrderRef: 'PO-BRIEF-1',
        status: 'payment_pending',
        lastMeaningfulUpdateAt: '2026-06-09T00:00:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
      values: {
        id: 'line-brief-1',
        company: 'ACME',
        supplierOrderId: 'order-brief-1',
        planningProductId: 'product-brief-1',
        asin: 'B00BRIEF',
        sku: 'SKU-BRIEF',
        orderedQty: 20,
        receivedQty: 0,
        expectedSellableDate: '2026-06-20',
        status: 'payment_pending',
        observedAt: '2026-06-09T00:00:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).create({
      values: {
        id: 'gold-order-brief-1',
        orderId: 'silver-order-brief-1',
        orderRef: 'PO-BRIEF-1',
        companyName: 'ACME',
        supplierId: 'supplier-brief-1',
        supplierName: 'Brief Supplier',
        currentStatus: 'IN-PROGRESS',
        statusSource: 'fallback',
        statusCheckRequired: true,
        nextAction: 'Verify order status',
        lineCount: 1,
        asinCount: 1,
        moneyAtRisk: 750,
        riskSource: 'oos_risk',
        earliestOosDate: '2026-06-11',
        daysUntilOos: 1,
        daysSinceLastActivity: 4,
        latestGoldCalculationDate: '2026-06-10',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).create({
      values: {
        id: 'task-brief-1',
        sourceConnectionId: 'source-brief-1',
        snapshotDate: '2026-06-10',
        externalTaskId: 'CU-BRIEF-1',
        taskName: 'Confirm PO-BRIEF-1 with supplier',
        assignee: 'Ops',
        priority: 'high',
        status: 'open',
        operationalArea: 'Purchasing',
        dueDate: '2026-06-09',
        lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
      },
    });

    const context = createActionContext(db, { company: 'ACME', date: '2026-06-10', maxItems: 5 });
    await createEcobaseReportActions().generateDailyOperationsBriefEvidence(context, vi.fn());

    const body = context.body as { data: { evidencePack: Record<string, unknown>; reportRunId: string } };
    expect(body.data).toMatchObject({
      idempotencyKey: 'daily_operations:2026-06-10:ACME',
      status: 'evidence_generated',
      focus: 'inventory_risk',
      evidencePack: expect.objectContaining({
        summaryCounts: expect.objectContaining({
          inventoryRiskCount: 1,
          includedInventoryRiskCount: 1,
          supplierOrderContextCount: 1,
          orderPlanningRiskCount: 1,
          taskRiskCount: 1,
        }),
        inventoryRisks: [
          expect.objectContaining({
            asin: 'B00BRIEF',
            velocityPerDay: 3,
            estimatedProfitRisk: expect.any(Number),
            supplierOrderState: 'placed_not_purchased',
          }),
        ],
        supplierOrderContext: [
          expect.objectContaining({
            externalOrderRef: 'PO-BRIEF-1',
            coverageState: 'payment_pending',
            isTrustedCoverage: false,
            openQty: 20,
          }),
        ],
        orderPlanningRisks: [
          expect.objectContaining({ orderRef: 'PO-BRIEF-1', orderRiskType: 'status_check', statusCheckRequired: true }),
        ],
        okrAccountabilityRisks: [expect.objectContaining({ taskId: 'CU-BRIEF-1', riskType: 'task_overdue' })],
      }),
    });
    expect(JSON.stringify(body.data.evidencePack)).not.toContain('do-not-leak');
    expect(JSON.stringify(body.data.evidencePack)).not.toContain('secret://sellerboard');
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).find()).toHaveLength(1);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportItems).find()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemType: 'inventory_risk', evidenceRefType: 'daily_inventory_risk' }),
        expect.objectContaining({ itemType: 'supplier_order_action', evidenceRefType: 'daily_supplier_order_context' }),
        expect.objectContaining({ itemType: 'order_planning_action', evidenceRefType: 'daily_order_planning_risk' }),
        expect.objectContaining({ itemType: 'accountability_task', evidenceRefType: 'daily_okr_accountability_risk' }),
      ]),
    );

    const secondContext = createActionContext(db, { company: 'ACME', date: '2026-06-10', maxItems: 5 });
    await createEcobaseReportActions().generateDailyOperationsBriefEvidence(secondContext, vi.fn());
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).find()).toHaveLength(1);
    const secondBody = secondContext.body as { data: { reportRunId: string } };
    expect(secondBody.data.reportRunId).toBe(body.data.reportRunId);
  });

  it('supports weekly and monthly reports through the same public action seam', async () => {
    const db = new MemoryDatabase();
    await seedReportData(db);
    const next = vi.fn();
    const context = createActionContext(db, { company: 'ACME', frequency: 'weekly', period: '2026-W23' });

    await createEcobaseReportActions().generatePreview(context, next);

    expect(context.body).toEqual({
      data: expect.objectContaining({
        frequency: 'weekly',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-07',
        emailStatus: 'preview_only',
      }),
    });
    expect(next).toHaveBeenCalledOnce();

    const monthly = await new EcobaseReportService(db).generateReport({
      company: 'ACME',
      frequency: 'monthly',
      period: '2026-06',
    });
    expect(monthly).toMatchObject({ frequency: 'monthly', periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  });

  it('generates and persists an Eco daily operations brief narrative from bounded evidence', async () => {
    const db = new MemoryDatabase();
    const provider: EcoNarrativeProvider = {
      async generate(input) {
        const request = JSON.parse(input.userPrompt) as { evidencePack: DailyEvidencePack };
        const noActionEvidenceId = request.evidencePack.dataWarnings[0].evidenceId;
        return JSON.stringify({
          subject: 'Ecobase daily brief: no major exceptions',
          bodyMarkdown: `# Ecobase Daily Operations Brief — ${request.evidencePack.date}\n\n## Director action points\n\n- **Review today** with evidence ${noActionEvidenceId}.`,
          citedEvidenceIds: [noActionEvidenceId],
          dataWarningsMentioned: [],
          confidence: 'high',
        });
      },
    };

    const result = await new EcobaseDailyOperationsBriefNarrativeService(db, provider).generateBrief({
      date: '2026-06-10',
      company: 'ACME',
    });

    expect(result).toMatchObject({
      status: 'ready_to_send',
      validationStatus: 'passed',
      subject: 'Ecobase daily brief: no major exceptions',
    });
    expect(result.bodyHtml).toContain('<section');
    expect(result.bodyHtml).toContain('<strong style="font-weight:700;color:#141414;">Review');
    expect(result.bodyHtml).toContain('today</span>');
    expect(result.bodyHtml).not.toContain('**Review today**');
    const run = await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).findOne({ filterByTk: result.reportRunId });
    expect(run).toMatchObject({
      status: 'ready_to_send',
      validationStatus: 'passed',
      deliveryStatus: 'preview_ready',
      subject: result.subject,
    });
    expect(JSON.stringify(run.aiPrompt)).not.toContain('secret://');
    expect(JSON.stringify(run.aiPrompt)).not.toContain('do-not-leak');
  });

  it('reuses the generated Eco daily operations brief once per day', async () => {
    const db = new MemoryDatabase();
    let calls = 0;
    const provider: EcoNarrativeProvider = {
      async generate(input) {
        calls += 1;
        const request = JSON.parse(input.userPrompt) as { evidencePack: DailyEvidencePack };
        const evidenceId = request.evidencePack.dataWarnings[0].evidenceId;
        return JSON.stringify({
          subject: 'Ecobase daily brief: reused preview',
          bodyMarkdown: `# Ecobase Daily Operations Brief — ${request.evidencePack.date}\n\nDo today. Cited evidence: ${evidenceId}.`,
          citedEvidenceIds: [evidenceId],
          dataWarningsMentioned: [],
          confidence: 'high',
        });
      },
    };
    const service = new EcobaseDailyOperationsBriefNarrativeService(db, provider);

    const first = await service.generateBrief({ date: '2026-06-10', company: 'ACME' });
    const second = await service.generateBrief({ date: '2026-06-10', company: 'ACME' });

    expect(calls).toBe(1);
    expect(second).toMatchObject({
      reportRunId: first.reportRunId,
      status: 'ready_to_send',
      subject: 'Ecobase daily brief: reused preview',
      bodyMarkdown: first.bodyMarkdown,
    });
  });

  it('repairs one invalid JSON Eco response before grounding validation', async () => {
    const db = new MemoryDatabase();
    let calls = 0;
    const provider: EcoNarrativeProvider = {
      async generate(input) {
        calls += 1;
        if (!input.repairPrompt) return 'Here is the brief in prose, not JSON.';
        const request = JSON.parse(input.userPrompt) as { evidencePack: DailyEvidencePack };
        const evidenceId = request.evidencePack.dataWarnings[0].evidenceId;
        return JSON.stringify({
          subject: 'Ecobase daily brief repaired',
          bodyMarkdown: `# Ecobase Daily Operations Brief — ${request.evidencePack.date}\n\nNo major exception needs action today. Cited evidence: ${evidenceId}.`,
          citedEvidenceIds: [evidenceId],
          dataWarningsMentioned: [],
          confidence: 'medium',
        });
      },
    };

    const result = await new EcobaseDailyOperationsBriefNarrativeService(db, provider).generateBrief({
      date: '2026-06-10',
      company: 'ACME',
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: 'ready_to_send', validationStatus: 'passed', usedRepair: true });
  });

  it('blocks unsupported Eco citations before send', async () => {
    const db = new MemoryDatabase();
    const provider: EcoNarrativeProvider = {
      async generate() {
        return JSON.stringify({
          subject: 'Ecobase daily brief: urgent unsupported ASIN',
          bodyMarkdown: '# Ecobase Daily Operations Brief\n\nOrder unsupported ASIN B00BAD999 today.',
          citedEvidenceIds: ['evidence:does-not-exist'],
          dataWarningsMentioned: [],
          confidence: 'high',
        });
      },
    };

    const result = await new EcobaseDailyOperationsBriefNarrativeService(db, provider).generateBrief({
      date: '2026-06-10',
      company: 'ACME',
    });

    expect(result).toMatchObject({ status: 'blocked_ai_validation_failed', validationStatus: 'failed' });
    expect(result.validationErrors).toEqual(
      expect.arrayContaining([
        'Narrative cited unsupported evidence id evidence:does-not-exist.',
        'Narrative referenced unsupported ASIN B00BAD999.',
      ]),
    );
  });

  it('does not mistake management wording for unsupported supplier orders', () => {
    const pack: DailyEvidencePack = {
      generatedAt: '2026-06-10T00:00:00.000Z',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      focus: 'inventory_risk',
      focusReason: 'Inventory risk outranks other current signals.',
      summaryCounts: {},
      sourceStatus: [],
      inventoryRisks: [],
      supplierOrderContext: [],
      orderPlanningRisks: [],
      leadTimeIssues: [],
      performanceTrends: [],
      buyBoxRisks: [],
      okrAccountabilityRisks: [],
      dataWarnings: [],
      omissions: [],
      assumptions: [],
    };

    const result = new NarrativeGroundingValidator().validate(pack, {
      subject: 'Daily action points',
      bodyMarkdown: '# Brief\n\n## Director action points\n\nFollow up with Discount POND Supply.',
      citedEvidenceIds: [],
      dataWarningsMentioned: [],
      confidence: 'high',
    });

    expect(result.validationErrors).toEqual([]);
  });

  it('persists provider failures as blocked report runs without deterministic fallback', async () => {
    const db = new MemoryDatabase();
    const provider: EcoNarrativeProvider = {
      async generate() {
        throw new Error('provider rate limited');
      },
    };

    const result = await new EcobaseDailyOperationsBriefNarrativeService(db, provider).generateBrief({
      date: '2026-06-10',
      company: 'ACME',
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked_ai_provider_unavailable',
        validationStatus: 'failed',
        validationErrors: ['provider rate limited'],
      }),
    );
    const run = await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).findOne({ filterByTk: result.reportRunId });
    expect(run).toMatchObject({
      status: 'blocked_ai_provider_unavailable',
      deliveryStatus: 'blocked',
      emailStatus: 'blocked',
    });
  });

  it('marks daily operations brief delivery sent and failed without creating duplicate runs', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).create({
      values: {
        id: 'report-ready-1',
        company: 'ACME',
        frequency: 'daily',
        periodStart: '2026-06-10',
        periodEnd: '2026-06-10',
        status: 'ready_to_send',
        emailStatus: 'preview_ready',
        emailEnabled: false,
        generatedAt: '2026-06-10T00:00:00.000Z',
        briefType: 'daily_operations',
        validationStatus: 'passed',
        deliveryStatus: 'preview_ready',
        subject: 'Ready brief',
        bodyMarkdown: '# Ready',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).create({
      values: {
        id: 'report-failed-1',
        company: 'ACME',
        frequency: 'daily',
        periodStart: '2026-06-10',
        periodEnd: '2026-06-10',
        status: 'ready_to_send',
        emailStatus: 'preview_ready',
        emailEnabled: false,
        generatedAt: '2026-06-10T00:00:00.000Z',
        briefType: 'daily_operations',
        validationStatus: 'passed',
        deliveryStatus: 'preview_ready',
        subject: 'Ready brief',
        bodyMarkdown: '# Ready',
      },
    });

    const service = new EcobaseDailyOperationsBriefDeliveryService(db);
    const sent = await service.markSent({
      reportRunId: 'report-ready-1',
      deliveryProvider: 'nocobase-email',
      messageId: 'message-1',
    });
    const failed = await service.markFailed({ reportRunId: 'report-failed-1', error: 'SMTP configuration missing' });

    expect(sent).toMatchObject({
      deliveryStatus: 'sent',
      emailStatus: 'sent',
      deliveryProvider: 'nocobase-email',
      deliveryMessageId: 'message-1',
    });
    expect(failed).toMatchObject({
      deliveryStatus: 'send_failed',
      emailStatus: 'send_failed',
      deliveryError: 'SMTP configuration missing',
    });
    expect(await db.getRepository(ECOBASE_COLLECTIONS.reportRuns).find()).toHaveLength(2);
  });

  it('blocks workflow-send generation when no recipient is configured', async () => {
    const db = new MemoryDatabase();
    const provider: EcoNarrativeProvider = {
      async generate() {
        return '{}';
      },
    };

    const result = await new EcobaseDailyOperationsBriefNarrativeService(db, provider).generateBrief({
      date: '2026-06-10',
      mode: 'workflow_send',
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked_delivery_configuration',
        validationStatus: 'failed',
        validationErrors: ['Ecobase daily operations brief delivery failed: workflow_send mode requires a recipient.'],
      }),
    );
  });

  it('requires Eco to mention stale or missing-data warnings in the narrative', () => {
    const pack: DailyEvidencePack = {
      generatedAt: '2026-06-10T00:00:00.000Z',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      focus: 'source_quality',
      focusReason: '1 source warning limits confidence.',
      summaryCounts: { dataWarningCount: 1 },
      sourceStatus: [],
      inventoryRisks: [],
      supplierOrderContext: [],
      leadTimeIssues: [],
      dataWarnings: [
        {
          evidenceId: 'warning-1',
          code: 'source_stale',
          message: 'Sellerboard source is stale.',
          severity: 'warning',
          metadata: {},
        },
      ],
      omissions: [],
      assumptions: [],
    };

    const result = new NarrativeGroundingValidator().validate(pack, {
      subject: 'Ecobase daily brief',
      bodyMarkdown: '# Brief\n\nNo action today.',
      citedEvidenceIds: [],
      dataWarningsMentioned: [],
      confidence: 'high',
    });

    expect(result).toEqual({
      validationStatus: 'failed',
      validationErrors: ['Narrative omitted data-warning section.'],
    });
  });
});
