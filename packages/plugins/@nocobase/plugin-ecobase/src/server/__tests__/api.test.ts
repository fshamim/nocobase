import { describe, expect, it, vi } from 'vitest';
import { createSourceAdapterRegistry, googleSheetsMigrationCsvAdapter, noopTestAdapter } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseAiTools } from '../ecobase-ai-tools';
import {
  createEcobaseAiActions,
  createEcobaseAlertActions,
  createEcobaseImportActions,
  createEcobaseInventoryPlanningActions,
  createEcobaseMedallionWorkflowActions,
  createEcobaseSilverDataActions,
  createEcobaseSupplierManagementActions,
  createEcobaseSupplierOrderActions,
} from '../plugin';
import { EcobaseDatabase, EcobaseRepository } from '../services/import-service';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    const filtered = this.filterRecords(params);
    return this.sortRecords(filtered, params.sort).slice(0, params.limit ?? filtered.length);
  }

  async findOne(params: FindParams = {}) {
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
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error(`MemoryRepository update failed: matching record was not found.`);
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  async destroy({ filter, filterByTk }: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    const records = this.filterRecords({ filter, filterByTk });
    this.records = this.records.filter((record) => !records.includes(record));
    return records.length;
  }

  all() {
    return this.records;
  }

  private filterRecords(params: FindParams) {
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
      const leftValue = String(left[key] ?? '');
      const rightValue = String(right[key] ?? '');
      if (leftValue === rightValue) {
        return 0;
      }
      const result = leftValue > rightValue ? 1 : -1;
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
    body: undefined,
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

describe('Ecobase AI public API seam', () => {
  it('answers ephemerally without creating an aiAnswers audit row', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseAiActions();
    const context = createActionContext(db, {
      question: 'Which supplier should I contact first?',
      company: 'Ecofission LLC',
    });

    await actions.askEphemeral(context, vi.fn());

    expect(context.body?.data).toMatchObject({
      question: 'Which supplier should I contact first?',
      company: 'Ecofission LLC',
      provider: 'ecobase-plugin-retrieval',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).all()).toHaveLength(0);
  });

  it('registers read-only Ecobase AI employee tools with stable names', async () => {
    const db = new MemoryDatabase();
    const tools = createEcobaseAiTools();
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      'ecobase_source_status',
      'ecobase_daily_operations_brief',
      'ecobase_product_context',
      'ecobase_performance_trends',
      'ecobase_buybox_trends',
      'ecobase_okr_status',
      'ecobase_inventory_digest',
      'ecobase_optimize_budget',
      'ecobase_supplier_orders',
      'ecobase_retrieve_facts',
      'ecobase_answer_ephemeral',
    ]);
    expect(
      tools.every(
        (tool) => tool.scope === 'CUSTOM' && tool.defaultPermission === 'ALLOW' && tool.execution === 'backend',
      ),
    ).toBe(true);

    const answerTool = tools.find((tool) => tool.definition.name === 'ecobase_answer_ephemeral');
    if (!answerTool) {
      throw new Error('Expected ecobase_answer_ephemeral tool to be registered.');
    }
    const result = await answerTool.invoke(
      { db } as any,
      { question: 'What is stale?', company: 'Ecofission LLC' },
      'tool-call-1',
    );
    expect(result.status).toBe('success');
    expect(db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).all()).toHaveLength(0);
  });

  it('answers inventory questions from silver/gold medallion tables only', async () => {
    const oldBusinessTables = new Set([
      ECOBASE_COLLECTIONS.planningCalculationSnapshots,
      ECOBASE_COLLECTIONS.alerts,
      ECOBASE_COLLECTIONS.inventoryPlanningRows,
      ECOBASE_COLLECTIONS.supplierOrders,
      ECOBASE_COLLECTIONS.supplierOrderLines,
      ECOBASE_COLLECTIONS.supplierOrderActivities,
      ECOBASE_COLLECTIONS.supplierLeadTimes,
      ECOBASE_COLLECTIONS.supplierProductLinks,
      ECOBASE_COLLECTIONS.listingDailyFacts,
      ECOBASE_COLLECTIONS.inventorySnapshots,
    ]);
    class GuardedDatabase extends MemoryDatabase {
      getRepository(name: string) {
        if (oldBusinessTables.has(name)) {
          throw new Error(`Old table access is forbidden for Eco AI tools: ${name}`);
        }
        return super.getRepository(name);
      }
    }
    const db = new GuardedDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'gold-row-1',
        calculationDate: '2026-06-24',
        company: 'Ecofission LLC',
        asin: 'B001',
        sku: 'SKU-1',
        actionStatus: 'order_soon',
        estimatedProfitRisk: 1000,
        supplierName: 'Acme',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: { id: 'order-1', company: 'Ecofission LLC', orderRef: 'EF1', lifecycleStatus: 'approval_pending' },
    });

    const tools = createEcobaseAiTools();
    const digestTool = tools.find((tool) => tool.definition.name === 'ecobase_inventory_digest');
    const answerTool = tools.find((tool) => tool.definition.name === 'ecobase_answer_ephemeral');
    if (!digestTool || !answerTool) {
      throw new Error('Expected Ecobase medallion AI tools to be registered.');
    }

    const digest = await digestTool.invoke(
      { db } as any,
      { company: 'Ecofission LLC', calculationDate: '2026-06-24' },
      'tool-call-1',
    );
    const answer = await answerTool.invoke(
      { db } as any,
      { question: 'What are the current inventory planning next actions?', company: 'Ecofission LLC' },
      'tool-call-2',
    );

    expect(digest.status).toBe('success');
    expect(digest.content).toContain('silver-gold-medallion');
    expect(digest.content).toContain('"oldTablesUsed":false');
    expect(answer.status).toBe('success');
    expect(answer.content).toContain('Evidence source: silver/gold medallion tables only.');
  });
});

describe('Ecobase inventory-planning public API seam', () => {
  it('rejects budget optimization without a positive budget', async () => {
    const actions = createEcobaseInventoryPlanningActions();
    await expect(
      actions.optimizeBudget(createActionContext(new MemoryDatabase(), { budget: 0 }), vi.fn()),
    ).rejects.toThrow('Ecobase budget optimizer requires a budget greater than zero.');
  });
});

describe('Ecobase supplier-order public API seam', () => {
  it('creates medallion draft orders and lines through the API seam', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', companyKey: 'SAM', name: 'SampleAM' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-1', normalizedName: 'acme', displayName: 'Acme' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-1', asin: 'B001', sku: 'SKU-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-1', companyId: 'company-1', productId: 'product-1', amazonAccountId: 'account-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-1', supplierId: 'supplier-1', productId: 'product-1' },
    });

    const orderContext = createActionContext(db, {
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderDate: '2026-06-22',
      expectedDeliveryDate: '2026-07-01',
    });
    await actions.createMedallionDraftOrder(orderContext, vi.fn());
    const order = orderContext.body?.data as Record<string, unknown>;

    const lineContext = createActionContext(db, {
      orderId: order.id,
      companyProductId: 'company-product-1',
      supplierProductId: 'supplier-product-1',
      orderedQty: 8,
      unitCost: 2.5,
      expectedSellableDate: '2026-07-05',
    });
    await actions.addMedallionOrderLine(lineContext, vi.fn());

    expect(orderContext.body).toMatchObject({
      data: expect.objectContaining({ orderRef: 'SAM062226A', lifecycleStatus: 'draft' }),
    });
    expect(lineContext.body).toMatchObject({
      data: expect.objectContaining({ orderId: order.id, orderedQty: 8, expectedSellableDate: '2026-07-05' }),
    });
  });

  it('creates comments, approvals, and deterministic workflow execution through API seam', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseMedallionWorkflowActions();
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-1',
        companyId: 'company-1',
        supplierId: 'supplier-1',
        orderRef: 'SAM062226A',
        orderDate: '2026-06-22',
        dailySequenceLetter: 'A',
        lifecycleStatus: 'draft',
      },
    });

    const commentContext = createActionContext(db, {
      entityType: 'order',
      entityId: 'order-1',
      actorType: 'operator',
      commentType: 'status_update',
      body: 'Supplier confirmed.',
      workflowAction: {
        title: 'Confirm order',
        actionType: 'update_order_status',
        actionPayloadJson: { orderId: 'order-1', lifecycleStatus: 'confirmed' },
      },
    });
    await actions.createComment(commentContext, vi.fn());
    const approval = commentContext.body?.data.approval as Record<string, unknown>;
    expect({ ...approval }).toMatchObject({ actionType: 'update_order_status', status: 'pending' });

    const executeContext = createActionContext(db, { approvalId: approval.id, approvedByUserId: 'reviewer-1' });
    await actions.approveAndExecute(executeContext, vi.fn());
    expect(executeContext.body).toMatchObject({ data: expect.objectContaining({ status: 'executed' }) });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({ lifecycleStatus: 'confirmed' });
  });

  it('exposes coverage queries and explicit operator-owned line updates', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: 'planning-product-1',
        naturalKey: 'planning-product:Ecofission LLC:B00TEST',
        company: 'Ecofission LLC',
        canonicalAsin: 'B00TEST',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
      values: {
        id: 'supplier-order-1',
        naturalKey: 'supplier-order:Ecofission LLC:PO-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-1',
        status: 'confirmed',
        statusSource: 'import',
        sourceStage: 'purchase_order',
        externalOrderRef: 'PO-1',
        lastImportRunId: 'import-run-1',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
      values: {
        id: 'supplier-order-line-1',
        naturalKey: 'supplier-order-line:PO-1:1',
        supplierOrderId: 'supplier-order-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-1',
        planningProductId: 'planning-product-1',
        orderedQty: 20,
        receivedQty: 0,
        receivedQtySource: 'import',
        expectedSellableDate: '2025-07-20',
        expectedSellableDateSource: 'imported_expected_sellable_date',
        sourceOrderLineRef: 'PO-1:1',
        sourceStage: 'purchase_order',
        lastImportRunId: 'import-run-1',
      },
    });
    const actions = createEcobaseSupplierOrderActions();

    const updateOrderContext = createActionContext(db, {
      supplierOrderId: 'supplier-order-1',
      company: 'Ecofission LLC',
      status: 'confirmed',
      expectedDeliveryDate: '2025-07-24',
    });
    await actions.updateOrderOperatorFields(updateOrderContext, vi.fn());
    expect(updateOrderContext.body).toMatchObject({
      data: expect.objectContaining({
        status: 'supplier_confirmed',
        statusSource: 'manual',
        expectedDeliveryDate: '2025-07-24',
        expectedDeliveryDateSource: 'manual',
      }),
    });

    const updateLineContext = createActionContext(db, {
      supplierOrderLineId: 'supplier-order-line-1',
      company: 'Ecofission LLC',
      receivedQty: 5,
      expectedSellableDate: '2025-07-25',
    });
    await actions.updateLineOperatorFields(updateLineContext, vi.fn());
    expect(updateLineContext.body).toMatchObject({
      data: expect.objectContaining({
        receivedQty: 5,
        receivedQtySource: 'manual',
        expectedSellableDate: '2025-07-25',
        expectedSellableDateSource: 'manual',
      }),
    });

    await actions.updateOrderOperatorFields(
      createActionContext(db, { supplierOrderId: 'supplier-order-1', company: 'Ecofission LLC', status: 'paid' }),
      vi.fn(),
    );

    const coverageContext = createActionContext(db, {
      planningProductId: 'planning-product-1',
      stockoutDate: '2025-07-30',
    });
    await actions.getCoverage(coverageContext, vi.fn());
    expect(coverageContext.body).toMatchObject({
      data: expect.objectContaining({
        planningProductId: 'planning-product-1',
        totalOpenQty: 15,
        coverageState: 'arrives_before_stockout',
      }),
    });

    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, { supplierOrderId: 'supplier-order-1', company: 'Ecofission LLC', status: 'bad' }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: status "bad" is not supported.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, {
          supplierOrderLineId: 'supplier-order-line-1',
          company: 'Ecofission LLC',
          expectedSellableDate: '25/07/2025',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedSellableDate must use YYYY-MM-DD.');
    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, {
          supplierOrderId: 'supplier-order-1',
          company: 'Ecofission LLC',
          expectedDeliveryDate: '2025-02-31',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedDeliveryDate must be a valid calendar date.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, {
          supplierOrderLineId: 'supplier-order-line-1',
          company: 'Ecofission LLC',
          expectedSellableDate: '2025-99-99',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedSellableDate must be a valid calendar date.');
    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, { supplierOrderId: 'supplier-order-1', company: 'Other LLC', status: 'confirmed' }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: order belongs to a different company.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, { supplierOrderLineId: 'supplier-order-line-1', company: 'Other LLC', receivedQty: 1 }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order line update failed: line belongs to a different company.');

    const leapDateContext = createActionContext(db, {
      supplierOrderLineId: 'supplier-order-line-1',
      company: 'Ecofission LLC',
      expectedSellableDate: '2024-02-29',
    });
    await actions.updateLineOperatorFields(leapDateContext, vi.fn());
    expect(leapDateContext.body).toMatchObject({
      data: expect.objectContaining({ expectedSellableDate: '2024-02-29' }),
    });

    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
      values: {
        id: 1,
        naturalKey: 'legacy-order-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-1',
        status: 'planned',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
      values: {
        id: 1,
        naturalKey: 'legacy-line-1',
        supplierOrderId: 1,
        company: 'Ecofission LLC',
        supplierId: 'supplier-1',
        orderedQty: 1,
        receivedQty: 0,
      },
    });
    await actions.updateOrderOperatorFields(
      createActionContext(db, { supplierOrderId: 1, company: 'Ecofission LLC', status: 'confirmed' }),
      vi.fn(),
    );
    await actions.updateLineOperatorFields(
      createActionContext(db, { supplierOrderLineId: 1, company: 'Ecofission LLC', receivedQty: 1 }),
      vi.fn(),
    );
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrders)
        .all()
        .find((record) => record.id === 1),
    ).toMatchObject({
      status: 'supplier_confirmed',
      statusSource: 'manual',
    });
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrderLines)
        .all()
        .find((record) => record.id === 1),
    ).toMatchObject({
      receivedQty: 1,
      receivedQtySource: 'manual',
    });
  });
});

describe('Ecobase supplier-order workspace API seam', () => {
  it('updates an order supplier by company-scoped supplier selection and keeps lines in sync', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
      values: {
        id: 'supplier-old',
        naturalKey: 'supplier:Ecofission LLC:old',
        company: 'Ecofission LLC',
        name: 'Old Supplier',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
      values: {
        id: 'supplier-new',
        naturalKey: 'supplier:Ecofission LLC:new',
        company: 'Ecofission LLC',
        name: 'New Supplier',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
      values: {
        id: 'supplier-other',
        naturalKey: 'supplier:Other LLC:new',
        company: 'Other LLC',
        name: 'Other Supplier',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
      values: {
        id: 'order-1',
        naturalKey: 'supplier-order:Ecofission LLC:ORDER-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-old',
        status: 'approval_pending',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
      values: {
        id: 'line-1',
        naturalKey: 'supplier-order-line:Ecofission LLC:ORDER-1:1',
        supplierOrderId: 'order-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-old',
        orderedQty: 5,
        receivedQty: 0,
      },
    });

    await actions.updateOrderOperatorFields(
      createActionContext(db, {
        supplierOrderId: 'order-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-new',
        externalOrderRef: 'ORDER-1A',
        orderDate: '2026-06-09',
      }),
      vi.fn(),
    );

    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrders)
        .all()
        .find((record) => record.id === 'order-1'),
    ).toMatchObject({
      supplierId: 'supplier-new',
      supplierName: 'New Supplier',
      externalOrderRef: 'ORDER-1A',
      orderDate: '2026-06-09',
    });
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrderLines)
        .all()
        .find((record) => record.id === 'line-1'),
    ).toMatchObject({
      supplierId: 'supplier-new',
    });
    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, {
          supplierOrderId: 'order-1',
          company: 'Ecofission LLC',
          supplierId: 'supplier-other',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: supplier belongs to a different company.');
  });

  it('creates planned orders from reorder candidates, records activity, and isolates companies', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Order sheet',
        company: 'Ecofission LLC',
        sourceType: 'google_sheets',
        domain: 'order_management',
        config: {},
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: { id: 'eco-import-run', sourceConnectionId: '11111111-1111-4111-8111-111111111111', status: 'success' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: '22222222-2222-4222-8222-222222222222',
        naturalKey: 'planning-product:Ecofission LLC:B00ORDER',
        company: 'Ecofission LLC',
        canonicalAsin: 'B00ORDER',
        title: 'Order candidate',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: '33333333-3333-4333-8333-333333333333',
        naturalKey: 'planning-product:Other LLC:B00ORDER',
        company: 'Other LLC',
        canonicalAsin: 'B00ORDER',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
      values: {
        id: '44444444-4444-4444-8444-444444444444',
        naturalKey: 'supplier:Ecofission LLC:preferred supplier',
        company: 'Ecofission LLC',
        name: 'Preferred Supplier',
        sourceConnectionId: '11111111-1111-4111-8111-111111111111',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).create({
      values: {
        id: '55555555-5555-4555-8555-555555555555',
        naturalKey:
          'supplier-product-link:Ecofission LLC:22222222-2222-4222-8222-222222222222:44444444-4444-4444-8444-444444444444:preferred',
        company: 'Ecofission LLC',
        planningProductId: '22222222-2222-4222-8222-222222222222',
        supplierId: '44444444-4444-4444-8444-444444444444',
        role: 'preferred',
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: {
        id: 'raw-row-eco-company',
        importRunId: 'eco-import-run',
        rowNumber: 1,
        payload: { company: 'Ecofission LLC' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: {
        id: 'raw-row-other-company',
        importRunId: 'other-import-run',
        rowNumber: 2,
        payload: { company: 'Other LLC' },
      },
    });

    const unscopedWorkspace = createActionContext(db, { stockoutDate: '2025-07-20' });
    await actions.workspace(unscopedWorkspace, vi.fn());
    expect(unscopedWorkspace.body.data).toMatchObject({
      reorderCandidates: [],
      supplierOrders: [],
      supplierOrderLines: [],
      rawImportRows: [],
      dataWarnings: ['company_filter_required'],
    });

    const workspaceBefore = createActionContext(db, { company: 'Ecofission LLC', stockoutDate: '2025-07-20' });
    await actions.workspace(workspaceBefore, vi.fn());
    expect(workspaceBefore.body).toMatchObject({
      data: {
        reorderCandidates: [
          expect.objectContaining({
            planningProductId: '22222222-2222-4222-8222-222222222222',
            preferredSupplierId: '44444444-4444-4444-8444-444444444444',
            coverage: expect.objectContaining({ coverageState: 'no_open_order' }),
          }),
        ],
        rawImportRows: [expect.objectContaining({ id: 'raw-row-eco-company', importRunId: 'eco-import-run' })],
      },
    });

    await expect(
      actions.createPlannedOrder(
        createActionContext(db, {
          company: 'Ecofission LLC',
          planningProductId: '22222222-2222-4222-8222-222222222222',
          orderedQty: 12,
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase planned order failed: supplier selection is required.');

    const createOrderContext = createActionContext(db, {
      company: 'Ecofission LLC',
      planningProductId: '22222222-2222-4222-8222-222222222222',
      supplierId: '44444444-4444-4444-8444-444444444444',
      orderedQty: 12,
      expectedDeliveryDate: '2025-07-18',
      expectedSellableDate: '2025-07-19',
      externalOrderRef: 'PO-MANUAL-1',
      notes: 'created from workspace',
    });
    await actions.createPlannedOrder(createOrderContext, vi.fn());
    expect(createOrderContext.body).toMatchObject({
      data: {
        order: expect.objectContaining({ status: 'draft', sourceStage: 'manual', externalOrderRef: 'PO-MANUAL-1' }),
        line: expect.objectContaining({ orderedQty: 12, expectedSellableDate: '2025-07-19' }),
        coverage: expect.objectContaining({ coverageState: 'no_open_order', totalOpenQty: 0 }),
      },
    });

    const lineId = String(createOrderContext.body.data.line.id);
    await actions.updateLineOperatorFields(
      createActionContext(db, { supplierOrderLineId: lineId, company: 'Ecofission LLC', receivedQty: 5 }),
      vi.fn(),
    );
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrderLines)
        .all()
        .find((record) => record.id === lineId),
    ).toMatchObject({
      receivedQty: 5,
      receivedQtySource: 'manual',
    });

    const orderId = String(createOrderContext.body.data.order.id);
    await actions.recordActivity(
      createActionContext(db, {
        company: 'Ecofission LLC',
        supplierId: '44444444-4444-4444-8444-444444444444',
        supplierOrderId: orderId,
        activityType: 'contacted_supplier',
        occurredAt: '2025-07-10T09:30:00.000Z',
        notes: 'supplier contacted',
        nextFollowUpAt: '2025-07-12T09:30:00.000Z',
        contactEstablished: false,
      }),
      vi.fn(),
    );
    await actions.recordActivity(
      createActionContext(db, {
        company: 'Ecofission LLC',
        supplierId: '44444444-4444-4444-8444-444444444444',
        supplierOrderId: orderId,
        activityType: 'lead_time_checked',
        occurredAt: '2025-07-10T10:00:00.000Z',
        leadTimeDays: 9,
        notes: 'supplier confirmed',
      }),
      vi.fn(),
    );
    expect(
      await db
        .getRepository(ECOBASE_COLLECTIONS.suppliers)
        .findOne({ filterByTk: '44444444-4444-4444-8444-444444444444' }),
    ).toMatchObject({
      lastContactedAt: '2025-07-10T09:30:00.000Z',
      nextFollowUpAt: '2025-07-12T09:30:00.000Z',
      contactEstablished: false,
      approvalStatus: 'contacting',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).all()).toEqual([
      expect.objectContaining({
        supplierRefId: '44444444-4444-4444-8444-444444444444',
        leadTimeDays: 9,
        confirmedAt: '2025-07-10T10:00:00.000Z',
        source: 'manual',
      }),
    ]);
    for (const activityType of ['status_update', 'note', 'blocked', 'unblocked']) {
      await actions.recordActivity(
        createActionContext(db, {
          company: 'Ecofission LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType,
          notes: `${activityType} recorded`,
        }),
        vi.fn(),
      );
    }
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities)
        .all()
        .map((activity) => activity.activityType),
    ).toEqual(
      expect.arrayContaining([
        'contacted_supplier',
        'lead_time_checked',
        'status_update',
        'note',
        'blocked',
        'unblocked',
      ]),
    );
    await expect(
      actions.recordActivity(
        createActionContext(db, {
          company: 'Ecofission LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType: 'free_text_status',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity failed: activityType "free_text_status" is not supported.');
    await expect(
      actions.recordActivity(
        createActionContext(db, {
          company: 'Ecofission LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType: 'lead_time_checked',
          leadTimeDays: -1,
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity failed: leadTimeDays must be an integer from 0 to 3650.');
    await expect(
      actions.recordActivity(
        createActionContext(db, {
          company: 'Other LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType: 'contacted_supplier',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity failed: supplier belongs to a different company.');

    await actions.updateOrderOperatorFields(
      createActionContext(db, { supplierOrderId: orderId, company: 'Ecofission LLC', status: 'paid' }),
      vi.fn(),
    );

    const workspaceAfter = createActionContext(db, { company: 'Ecofission LLC', stockoutDate: '2025-07-20' });
    await actions.workspace(workspaceAfter, vi.fn());
    expect(workspaceAfter.body.data.reorderCandidates).toHaveLength(1);
    expect(workspaceAfter.body.data.reorderCandidates[0]).toMatchObject({
      coverage: expect.objectContaining({ totalOpenQty: 7 }),
      leadTimeDays: 9,
      latestContactAt: '2025-07-10T09:30:00.000Z',
    });
  });
});

describe('Ecobase import public API seam', () => {
  it('runs the no-op import through resource actions and reads source status', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));

    const runContext = createActionContext(db, {
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });
    const runNext = vi.fn();
    await actions.runNoop(runContext, runNext);

    expect(runContext.body).toMatchObject({
      data: {
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
        idempotencyKey: 'source-1:manual-noop:v1',
        status: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
    });
    expect(runNext).toHaveBeenCalledOnce();

    const statusContext = createActionContext(db);
    const statusNext = vi.fn();
    await actions.status(statusContext, statusNext);

    expect(statusContext.body).toEqual({
      data: [
        expect.objectContaining({
          sourceConnectionId: 'source-1',
          connectionName: 'No-op source',
          sourceType: 'noop_test',
          domain: 'foundation',
          active: true,
          required: false,
          freshnessSlaMinutes: null,
          latestRunStatus: 'success',
          rowCount: 0,
          normalizedCount: 0,
          warningCount: 0,
          latestRunWarningCount: 0,
          errorCount: 0,
          latestWarning: null,
          warnings: [],
        }),
      ],
    });
    expect(statusNext).toHaveBeenCalledOnce();
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([]);
  });

  it('normalizes pending bronze rows through resource actions', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        id: 'bronze-1',
        sourceConnectionId: 'source-1',
        importRunId: 'import-1',
        sourceType: 'google_sheets',
        sourceDataset: 'MasterStock.csv',
        sourceRecordKey: 'MasterStock.csv:B00PUSNY5A:W101',
        rowHash: 'hash-1',
        payload: {
          Company: 'Ecofission LLC',
          ASIN: 'B00PUSNY5A',
          SKU: 'W101',
          'FBA/FBM Stock': '386',
        },
        normalizationStatus: 'pending',
      },
    });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(db, { sourceConnectionId: 'source-1', limit: 10 });
    const next = vi.fn();

    await actions.normalizeBronzeToSilver(context, next);

    expect(context.body).toMatchObject({ data: { normalized: 1, failed: 0 } });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()[0].normalizationStatus).toBe('normalized');
    expect(next).toHaveBeenCalledOnce();
  });

  it('exposes missing required source warnings through the status action', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: { warningPolicy: { required: true } },
        active: true,
      },
    });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(db);

    await actions.status(context, vi.fn());

    expect(context.body).toEqual({
      data: [
        expect.objectContaining({
          sourceConnectionId: 'source-1',
          required: true,
          warningCount: 1,
          latestWarning: expect.objectContaining({ code: 'missing_required_source' }),
          warnings: [
            expect.objectContaining({
              code: 'missing_required_source',
              message: 'Required source "No-op source" has no successful import run.',
            }),
          ],
        }),
      ],
    });
  });

  it('rejects run requests without sourceConnectionId', async () => {
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(new MemoryDatabase());

    await expect(actions.runNoop(context, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'Ecobase no-op import requires sourceConnectionId.',
    });
  });

  it('analyzes CSV bundles and creates matching manual CSV source connections', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([googleSheetsMigrationCsvAdapter]));
    const analyzeContext = createActionContext(db, {
      files: [{ name: 'Supplier IDs.csv', content: 'Company,SR ID,Supplier Name\nEcofission LLC,SRO-36,3Dmatsusa' }],
    });
    await actions.analyzeCsvBundle(analyzeContext, vi.fn());

    expect(analyzeContext.body.data).toMatchObject({
      files: [
        expect.objectContaining({
          detectedShape: 'supplier-ids',
          adapterName: 'google-sheets-migration-csv',
          importable: true,
        }),
      ],
      groups: [
        expect.objectContaining({
          adapterName: 'google-sheets-migration-csv',
          sourceType: 'google_sheets',
          domain: 'order_management',
        }),
      ],
    });

    const saveContext = createActionContext(db, {
      name: 'Order CSV upload',
      companyName: 'Ecofission LLC',
      sourceType: 'google_sheets',
      domain: 'order_management',
    });
    await actions.saveCsvSourceConnection(saveContext, vi.fn());

    expect(saveContext.body.data).toMatchObject({
      name: 'Order CSV upload',
      sourceType: 'google_sheets',
      domain: 'order_management',
      config: { manualCsvBundle: true },
      active: true,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.companies).all()).toEqual([
      expect.objectContaining({ name: 'Ecofission LLC' }),
    ]);
  });

  it('lists available adapters through the public action', async () => {
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(new MemoryDatabase());
    const next = vi.fn();

    await actions.adapters(context, next);

    expect(context.body).toEqual({
      data: [
        expect.objectContaining({
          name: 'noop-test',
          sourceType: 'noop_test',
          title: 'No-op test adapter',
        }),
      ],
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('saves, lists, and deletes Sellerboard live source configuration', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));

    const saveContext = createActionContext(db, {
      name: 'Sellerboard Live Company',
      companyName: 'Live Company LLC',
      timezone: 'UTC',
      dailyRefreshTime: '02:30',
      refreshIntervalMinutes: 720,
      retryIntervalMinutes: 45,
      freshnessSlaMinutes: 180,
      active: true,
      scheduleEnabled: true,
      reportUrls: [
        {
          name: 'Profit Dashboard Data',
          category: 'profit_dashboard',
          url: 'https://app.sellerboard.com/report.csv',
        },
      ],
    });

    await actions.saveSellerboardSource(saveContext, vi.fn());
    const source = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()[0];
    expect(source).toMatchObject({
      name: 'Sellerboard Live Company',
      sourceType: 'sellerboard',
      domain: 'amazon_operations',
      active: true,
      freshnessSlaMinutes: 180,
      config: {
        requireFreshData: true,
        schedule: { enabled: true, dailyRefreshTime: '02:30', refreshIntervalMinutes: 720, retryIntervalMinutes: 45 },
        reportUrls: [
          {
            name: 'Profit Dashboard Data',
            category: 'profit_dashboard',
            url: 'https://app.sellerboard.com/report.csv',
          },
        ],
      },
    });

    const latestRun = await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'sellerboard-run-1',
        sourceConnectionId: source.id,
        adapterName: 'sellerboard-api',
        sourceIdentifier: 'sellerboard-scheduled',
        sourceVersion: '2026-06-08T17:25:00.000Z',
        startedAt: '2026-06-08T17:20:00.000Z',
        finishedAt: '2026-06-08T17:21:00.000Z',
        status: 'partial',
        rowCount: 308,
        normalizedCount: 924,
        warningCount: 0,
        errorCount: 2,
        errorMessage: 'Sellerboard live import failed: URL returned HTTP 401.',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: {
        importRunId: latestRun.id,
        rowNumber: 0,
        sourceKey: 'profit_dashboard:Profit Dashboard Data',
        normalizedStatus: 'failed',
        normalizedError: 'Sellerboard live import failed: URL returned HTTP 401.',
        issueSeverity: 'error',
        issueCode: 'sellerboard_live_fetch_failed',
        payload: { reportName: 'Profit Dashboard Data', category: 'profit_dashboard' },
      },
    });

    const listContext = createActionContext(db);
    await actions.listSellerboardSources(listContext, vi.fn());
    expect(listContext.body.data).toEqual([
      expect.objectContaining({
        sourceConnectionId: source.id,
        name: 'Sellerboard Live Company',
        companyName: 'Live Company LLC',
        reportUrls: [expect.objectContaining({ category: 'profit_dashboard' })],
        schedule: { enabled: true, dailyRefreshTime: '02:30', refreshIntervalMinutes: 720, retryIntervalMinutes: 45 },
        latestRunStatus: 'partial',
        latestRunWarningCount: 0,
        latestRunErrorCount: 2,
        latestRunErrorMessage: 'Sellerboard live import failed: URL returned HTTP 401.',
        latestRunLogs: [
          expect.objectContaining({
            importRunId: 'sellerboard-run-1',
            status: 'partial',
            issues: [
              expect.objectContaining({
                severity: 'error',
                code: 'sellerboard_live_fetch_failed',
                message: 'Sellerboard live import failed: URL returned HTTP 401.',
              }),
            ],
          }),
        ],
      }),
    ]);

    const deleteContext = createActionContext(db, { sourceConnectionId: String(source.id) });
    await actions.deleteSellerboardSource(deleteContext, vi.fn());
    expect(deleteContext.body).toEqual({ data: { sourceConnectionId: source.id, deleted: true } });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()).toEqual([]);
  });
});

describe('Ecobase alert public API seam', () => {
  it('evaluates deterministic alerts through the public resource action and lists open alerts', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: 'alert-product-1',
        naturalKey: 'planning-product:Alerts:B010API',
        company: 'Alerts LLC',
        canonicalAsin: 'B010API',
        title: 'API alert product',
        mappingStatus: 'confirmed',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
      values: {
        naturalKey: 'inventory:alert-product-1:2025-07-10',
        sourceConnectionId: 'source-1',
        planningProductId: 'alert-product-1',
        snapshotDate: '2025-07-10',
        company: 'Alerts LLC',
        asin: 'B010API',
        stock: 0,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: 4,
        recommendedReorderQuantity: 20,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningParameters).create({
      values: {
        naturalKey: 'parameter:alert-product-1',
        sourceConnectionId: 'source-1',
        planningProductId: 'alert-product-1',
        company: 'Alerts LLC',
        asin: 'B010API',
        leadTimeDays: 10,
        profitPerUnit: 5,
        recommendedBestQty: 50,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.targetRows).create({
      values: {
        naturalKey: 'target:alert-product-1:2025-07',
        sourceConnectionId: 'source-1',
        planningProductId: 'alert-product-1',
        company: 'Alerts LLC',
        periodType: 'monthly',
        period: '2025-07',
        targetScope: 'planning_product',
        profitTarget: 100,
      },
    });

    const actions = createEcobaseAlertActions();
    const evaluateContext = createActionContext(db, {
      planningProductId: 'alert-product-1',
      calculationDate: '2025-07-10',
    });
    await actions.evaluate(evaluateContext, vi.fn());

    expect(evaluateContext.body.data.productCount).toBe(1);
    expect(evaluateContext.body.data.summaries[0].rootCauseCodes).toContain('current_oos');
    expect(evaluateContext.body.data.summaries[0].rootCauseCodes).toContain('no_supplier_order_placed');

    const listContext = createActionContext(db, { company: 'Alerts LLC', status: 'open' });
    await actions.list(listContext, vi.fn());
    expect(listContext.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alertType: 'oos',
          primaryRootCauseCode: 'current_oos',
          actionRequired: 'Restore sellable Amazon stock immediately or confirm an active recovery order.',
        }),
      ]),
    );
  });
});

describe('Ecobase supplier-management public API seam', () => {
  it('refreshes money-first supplier attention and exposes lookup-based mutation actions', async () => {
    const db = new MemoryDatabase();
    const supplierA = await db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
      values: {
        id: 'supplier-a',
        naturalKey: 'supplier:Money LLC:name:high value',
        sourceConnectionId: 'source-a',
        supplierId: 'S-A',
        name: 'High Value Supplier',
        normalizedName: 'high value supplier',
        company: 'Money LLC',
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
      values: {
        id: 'supplier-b',
        naturalKey: 'supplier:Money LLC:name:blocked low value',
        sourceConnectionId: 'source-b',
        supplierId: 'S-B',
        name: 'Blocked Low Value Supplier',
        normalizedName: 'blocked low value supplier',
        company: 'Money LLC',
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: 'product-a',
        naturalKey: 'planning-product:Money LLC:B0MONEY',
        company: 'Money LLC',
        canonicalAsin: 'B0MONEY',
        title: 'Money Product',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).create({
      values: {
        naturalKey: 'supplier-product-link:Money LLC:product-a:supplier-a:latest_history:test',
        company: 'Money LLC',
        planningProductId: 'product-a',
        supplierId: 'supplier-a',
        role: 'latest_history',
        source: 'test',
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.inventoryPlanningRows).create({
      values: {
        id: 'row-a',
        naturalKey: 'inventory-planning-row:Money LLC:B0MONEY:2025-07-10',
        company: 'Money LLC',
        planningProductId: 'product-a',
        asin: 'B0MONEY',
        supplierId: 'supplier-a',
        actionStatus: 'order_now',
        estimatedOosDate: '2025-07-15',
        estimatedProfitRisk: 5000,
        leadTimeFreshness: 'missing',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).create({
      values: {
        naturalKey: 'supplier-lead-time:Money LLC:supplier-a:product-a',
        sourceConnectionId: 'source-a',
        supplierRefId: 'supplier-a',
        supplierName: 'High Value Supplier',
        company: 'Money LLC',
        planningProductId: 'product-a',
        asin: 'B0MONEY',
        scope: 'product',
        leadTimeDays: 14,
        confirmedAt: '2025-04-01T00:00:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
      values: {
        id: 'order-a',
        naturalKey: 'supplier-order:Money LLC:HIGH-1',
        sourceConnectionId: 'source-a',
        company: 'Money LLC',
        supplierId: 'supplier-a',
        sourceStage: 'order_detail',
        status: 'received',
        externalOrderRef: 'HIGH-1',
        orderDate: '2025-06-01',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
      values: {
        id: 'line-a',
        naturalKey: 'supplier-order-line:Money LLC:HIGH-1:B0DIRECT:SKU-DIRECT',
        supplierOrderId: 'order-a',
        company: 'Money LLC',
        supplierId: 'supplier-a',
        asin: 'B0DIRECT',
        sku: 'SKU-DIRECT',
        brand: 'Direct Brand',
        orderedQty: 12,
        receivedQty: 12,
        unitCost: 4.5,
        sourceOrderLineRef: 'HIGH-1:B0DIRECT:SKU-DIRECT',
        sourceStage: 'order_detail',
        observedAt: '2025-06-01T00:00:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
      values: {
        id: 'order-b',
        naturalKey: 'supplier-order:Money LLC:LOW-1',
        sourceConnectionId: 'source-b',
        company: 'Money LLC',
        supplierId: 'supplier-b',
        sourceStage: 'purchase_order',
        status: 'blocked',
        externalOrderRef: 'LOW-1',
        expectedDeliveryDate: '2025-07-01',
      },
    });

    const actions = createEcobaseSupplierManagementActions();
    const refreshContext = createActionContext(db, { company: 'Money LLC', calculationDate: '2025-07-10' });
    await actions.refreshAttentionRows(refreshContext, vi.fn());
    expect(refreshContext.body.data.rows[0]).toMatchObject({
      supplierId: 'supplier-a',
      totalEstimatedProfitRisk: 5000,
      attentionStatus: 'urgent',
      staleLeadTimeCount: 1,
      contactSoon: true,
      recommendedAction: 'Contact supplier soon and update lead time',
    });

    const supplierOptionsContext = createActionContext(db, { company: 'Money LLC', search: 'high' });
    await actions.supplierOptions(supplierOptionsContext, vi.fn());
    expect(supplierOptionsContext.body.data).toEqual([
      expect.objectContaining({ value: 'supplier-a', label: 'High Value Supplier' }),
    ]);

    const productOptionsContext = createActionContext(db, { company: 'Money LLC', search: 'B0DIRECT' });
    await actions.productOptions(productOptionsContext, vi.fn());
    expect(productOptionsContext.body.data).toEqual([
      expect.objectContaining({ value: 'history:B0DIRECT:SKU-DIRECT', asin: 'B0DIRECT', sku: 'SKU-DIRECT' }),
    ]);

    const updateContext = createActionContext(db, {
      company: 'Money LLC',
      supplierId: 'supplier-a',
      receivedEmail: 'ops@example.com',
      activityNotes: 'Confirmed preferred supplier contact.',
    });
    await actions.updateSupplierProfile(updateContext, vi.fn());
    expect(updateContext.body.data.receivedEmail).toBe('ops@example.com');
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities).all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ supplierId: 'supplier-a', activityType: 'note' })]),
    );

    const detailContext = createActionContext(db, {
      company: 'Money LLC',
      supplierId: 'supplier-a',
      calculationDate: '2025-07-10',
    });
    await actions.detail(detailContext, vi.fn());
    expect(detailContext.body.data.productLinks).toEqual([
      expect.objectContaining({ planningProductId: 'product-a', role: 'latest_history' }),
    ]);
    expect(detailContext.body.data.knownSupplierProducts).toEqual([
      expect.objectContaining({ asin: 'B0DIRECT', sku: 'SKU-DIRECT', orderCount: 1, totalOrderedQty: 12 }),
    ]);

    const createOrderContext = createActionContext(db, {
      company: 'Money LLC',
      supplierId: supplierA.id,
      externalOrderRef: 'SUP-PO-1',
      status: 'draft',
    });
    await actions.createSupplierOrder(createOrderContext, vi.fn());
    expect(createOrderContext.body.data).toMatchObject({
      company: 'Money LLC',
      supplierId: 'supplier-a',
      externalOrderRef: 'SUP-PO-1',
      sourceStage: 'manual',
    });
  });
});

describe('Ecobase Silver Data operator API', () => {
  async function seedSilverData(db: MemoryDatabase) {
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-1', asin: 'B00HHCWH0K', sku: '450316', title: 'Copper Wire', brand: 'Muxtex' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-2', asin: 'B07YQ9JYMY', sku: 'B-104C', title: 'Pool Set', brand: 'Aramith' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Muxtex INC', companyKey: 'muxtex' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-1', companyId: 'company-1', productId: 'product-1', lifecycleStatus: 'active' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-2', companyId: 'company-1', productId: 'product-2', lifecycleStatus: 'active' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-1', displayName: 'edhoy', normalizedName: 'edhoy', approvalStatus: 'approved' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-1', supplierId: 'supplier-1', productId: 'product-1', supplierSku: 'ED-450316' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-2', supplierId: 'supplier-1', productId: 'product-2', supplierSku: 'ED-B104C' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-1',
        companyId: 'company-1',
        supplierId: 'supplier-1',
        orderRef: 'MX21324A',
        trackingId: 'TRK-1',
        orderDate: '2026-06-10',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-2',
        companyId: 'company-1',
        supplierId: 'supplier-1',
        orderRef: 'MX99999A',
        trackingId: 'TRK-2',
        orderDate: '2026-05-20',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-1',
        orderId: 'order-1',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 12,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-2',
        orderId: 'order-1',
        companyProductId: 'company-product-2',
        supplierProductId: 'supplier-product-2',
        orderedQty: 4,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInvoices).create({
      values: { id: 'invoice-1', orderId: 'order-1', invoiceNumber: 'INV-10481', status: 'waiting' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTasks).create({
      values: { id: 'task-1', title: 'Follow up edhoy', status: 'open' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTaskLinks).create({
      values: { id: 'task-link-1', taskId: 'task-1', entityType: 'supplier', entityId: 'supplier-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverHumanApprovals).create({
      values: { id: 'approval-1', title: 'Approve order change', actionType: 'update_order', status: 'pending' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverHumanApprovalLinks).create({
      values: { id: 'approval-link-1', humanApprovalId: 'approval-1', entityType: 'order', entityId: 'order-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
      values: {
        id: 'target-1',
        entityType: 'product',
        entityId: 'product-1',
        metric: 'profit',
        periodType: 'month',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        targetValue: 100,
      },
    });
  }

  it('searches across product, supplier, order, and invoice keys', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { query: '450316' });

    await actions.search(context, vi.fn());

    expect(context.body?.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'product', id: 'product-1' }),
        expect.objectContaining({ type: 'orderLine', id: 'order-line-1' }),
      ]),
    );

    const supplierContext = createActionContext(db, { query: 'edhoy' });
    await actions.search(supplierContext, vi.fn());
    expect(supplierContext.body?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'supplier', id: 'supplier-1' })]),
    );

    const orderContext = createActionContext(db, { query: 'MX21324A' });
    await actions.search(orderContext, vi.fn());
    expect(orderContext.body?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'order', id: 'order-1' })]),
    );

    const invoiceContext = createActionContext(db, { query: 'INV-10481' });
    await actions.search(invoiceContext, vi.fn());
    expect(invoiceContext.body?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'invoice', id: 'invoice-1' })]),
    );
  });

  it('looks up bounded entity types without global cross-table matches', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();

    const supplierContext = createActionContext(db, { type: 'supplier', query: 'edhoy' });
    await actions.lookup(supplierContext, vi.fn());
    expect(supplierContext.body?.data).toEqual([expect.objectContaining({ type: 'supplier', id: 'supplier-1' })]);

    const productContext = createActionContext(db, { type: 'product', query: '450316' });
    await actions.lookup(productContext, vi.fn());
    expect(productContext.body?.data).toEqual([expect.objectContaining({ type: 'product', id: 'product-1' })]);

    const orderContext = createActionContext(db, { type: 'order', query: 'MX21324A' });
    await actions.lookup(orderContext, vi.fn());
    expect(orderContext.body?.data).toEqual([expect.objectContaining({ type: 'order', id: 'order-1' })]);
  });

  it('applies date filters to bounded lookup and linked context', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();

    const lookup = createActionContext(db, {
      type: 'order',
      query: 'MX',
      dateFrom: '2026-06-10',
      dateTo: '2026-06-10',
    });
    await actions.lookup(lookup, vi.fn());
    expect(lookup.body?.data).toEqual([expect.objectContaining({ type: 'order', id: 'order-1' })]);

    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-2', name: 'Other LLC', companyKey: 'other' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-3',
        companyId: 'company-2',
        supplierId: 'supplier-1',
        orderRef: 'OT11111A',
        orderDate: '2026-06-10',
      },
    });

    const context = createActionContext(db, {
      focus: { type: 'company', id: 'company-1' },
      dateFrom: '2026-06-10',
      dateTo: '2026-06-10',
      pageSize: 100,
    });
    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('companies')).toEqual(['company-1']);
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orders')).not.toContain('order-2');
    expect(ids('orders')).not.toContain('order-3');
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
  });

  it('resolves search matches into linked records without unrelated same-order products', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { query: '450316', pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('products')).toContain('product-1');
    expect(ids('companyProducts')).toContain('company-product-1');
    expect(ids('supplierProducts')).toContain('supplier-product-1');
    expect(ids('orderLines')).toContain('order-line-1');
    expect(ids('orders')).toContain('order-1');
    expect(ids('products')).not.toContain('product-2');
    expect(ids('orderLines')).not.toContain('order-line-2');
  });

  it('keeps order focus scoped to the selected order only', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-2',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'order', id: 'order-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
    expect(ids('orderLines')).not.toContain('order-line-3');
  });

  it('keeps supplier focus scoped to the selected supplier', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-2', displayName: 'Delphi Glass', normalizedName: 'delphi glass' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-3', supplierId: 'supplier-2', productId: 'product-1', supplierSku: 'DG-450316' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: { id: 'order-3', companyId: 'company-1', supplierId: 'supplier-2', orderRef: 'DG11111A' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-3',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-3',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'supplier', id: 'supplier-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('suppliers')).toEqual(['supplier-1']);
    expect(ids('supplierProducts')).toEqual(expect.arrayContaining(['supplier-product-1', 'supplier-product-2']));
    expect(ids('supplierProducts')).not.toContain('supplier-product-3');
    expect(ids('orderLines')).not.toContain('order-line-3');

    const searchContext = createActionContext(db, { query: 'edhoy', pageSize: 100 });
    await actions.context(searchContext, vi.fn());
    const searchSections = searchContext.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const searchIds = (key: string) =>
      searchSections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(searchIds('suppliers')).toEqual(['supplier-1']);
    expect(searchIds('supplierProducts')).not.toContain('supplier-product-3');
  });

  it('keeps order-line focus scoped to the selected line and its order', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-2',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'orderLine', id: 'order-line-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('products')).toEqual(['product-1']);
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orderLines')).toEqual(['order-line-1']);
    expect(ids('invoices')).toEqual(['invoice-1']);
  });

  it('resolves invoice focus through its order lines and products', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'invoice', id: 'invoice-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('invoices')).toEqual(['invoice-1']);
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('products')).toEqual(expect.arrayContaining(['product-1', 'product-2']));
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
  });

  it('keeps exact order search scoped to the matched order only', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-2',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { query: 'MX21324A', pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
    expect(ids('orderLines')).not.toContain('order-line-3');
  });

  it('resolves company focus into only that company products and orders', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-2', name: 'Other LLC', companyKey: 'other' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-3', companyId: 'company-2', productId: 'product-1', lifecycleStatus: 'active' },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'company', id: 'company-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('companies')).toEqual(['company-1']);
    expect(ids('products')).toEqual(expect.arrayContaining(['product-1', 'product-2']));
    expect(ids('companyProducts')).toEqual(expect.arrayContaining(['company-product-1', 'company-product-2']));
    expect(ids('companyProducts')).not.toContain('company-product-3');
    expect(ids('orders')).toEqual(expect.arrayContaining(['order-1', 'order-2']));
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
  });

  it('resolves product focus into related orders, lines, supplier, tasks, approvals, and targets', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'product', id: 'product-1' } });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('companyProducts')).toContain('company-product-1');
    expect(ids('supplierProducts')).toContain('supplier-product-1');
    expect(ids('orderLines')).toContain('order-line-1');
    expect(ids('orders')).toContain('order-1');
    expect(ids('invoices')).toContain('invoice-1');
    expect(ids('tasks')).toContain('task-1');
    expect(ids('approvals')).toContain('approval-1');
    expect(ids('targets')).toContain('target-1');
    expect(ids('products')).not.toContain('product-2');
    expect(ids('orders')).not.toContain('order-2');
    expect(ids('orderLines')).not.toContain('order-line-2');
  });

  it('rejects read-only updates and links drawer comments to the selected entity', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();

    const rejected = createActionContext(db, { type: 'product', id: 'product-1', values: { id: 'bad' } });
    await expect(actions.updateRecord(rejected, vi.fn())).rejects.toThrow('read-only fields rejected: id');

    const update = createActionContext(db, {
      type: 'product',
      id: 'product-1',
      values: { title: 'Updated Copper Wire' },
    });
    await actions.updateRecord(update, vi.fn());
    expect(update.body?.data.record.title).toBe('Updated Copper Wire');

    const comment = createActionContext(db, {
      type: 'product',
      id: 'product-1',
      body: 'Operator confirmed SKU mapping.',
    });
    await actions.addComment(comment, vi.fn());
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toEqual([
      expect.objectContaining({
        entityType: 'product',
        entityId: 'product-1',
        body: 'Operator confirmed SKU mapping.',
      }),
    ]);
  });
});
