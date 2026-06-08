import { describe, expect, it, vi } from 'vitest';
import { createSourceAdapterRegistry, noopTestAdapter } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseAlertActions, createEcobaseImportActions, createEcobaseSupplierOrderActions } from '../plugin';
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

describe('Ecobase supplier-order public API seam', () => {
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
      values: { id: 1, naturalKey: 'legacy-order-1', company: 'Ecofission LLC', supplierId: 'supplier-1', status: 'planned' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
      values: { id: 1, naturalKey: 'legacy-line-1', supplierOrderId: 1, company: 'Ecofission LLC', supplierId: 'supplier-1', orderedQty: 1, receivedQty: 0 },
    });
    await actions.updateOrderOperatorFields(
      createActionContext(db, { supplierOrderId: 1, company: 'Ecofission LLC', status: 'confirmed' }),
      vi.fn(),
    );
    await actions.updateLineOperatorFields(
      createActionContext(db, { supplierOrderLineId: 1, company: 'Ecofission LLC', receivedQty: 1 }),
      vi.fn(),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).all().find((record) => record.id === 1)).toMatchObject({
      status: 'supplier_confirmed',
      statusSource: 'manual',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).all().find((record) => record.id === 1)).toMatchObject({
      receivedQty: 1,
      receivedQtySource: 'manual',
    });
  });
});

describe('Ecobase supplier-order workspace API seam', () => {
  it('creates planned orders from reorder candidates, records activity, and isolates companies', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: '11111111-1111-4111-8111-111111111111', name: 'Order sheet', company: 'Ecofission LLC', sourceType: 'google_sheets', domain: 'order_management', config: {}, active: true },
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
        naturalKey: 'supplier-product-link:Ecofission LLC:22222222-2222-4222-8222-222222222222:44444444-4444-4444-8444-444444444444:preferred',
        company: 'Ecofission LLC',
        planningProductId: '22222222-2222-4222-8222-222222222222',
        supplierId: '44444444-4444-4444-8444-444444444444',
        role: 'preferred',
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: { id: 'raw-row-eco-company', importRunId: 'eco-import-run', rowNumber: 1, payload: { company: 'Ecofission LLC' } },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: { id: 'raw-row-other-company', importRunId: 'other-import-run', rowNumber: 2, payload: { company: 'Other LLC' } },
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

    const createOrderContext = createActionContext(db, {
      company: 'Ecofission LLC',
      planningProductId: '22222222-2222-4222-8222-222222222222',
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
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).all().find((record) => record.id === lineId)).toMatchObject({
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
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities).all().map((activity) => activity.activityType)).toEqual(
      expect.arrayContaining(['contacted_supplier', 'lead_time_checked', 'status_update', 'note', 'blocked', 'unblocked']),
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

    const listContext = createActionContext(db);
    await actions.listSellerboardSources(listContext, vi.fn());
    expect(listContext.body.data).toEqual([
      expect.objectContaining({
        sourceConnectionId: source.id,
        name: 'Sellerboard Live Company',
        companyName: 'Live Company LLC',
        reportUrls: [expect.objectContaining({ category: 'profit_dashboard' })],
        schedule: { enabled: true, dailyRefreshTime: '02:30', refreshIntervalMinutes: 720, retryIntervalMinutes: 45 },
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
