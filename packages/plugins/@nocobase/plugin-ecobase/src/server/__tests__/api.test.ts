import { describe, expect, it, vi } from 'vitest';
import { createSourceAdapterRegistry, noopTestAdapter } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseImportActions, createEcobaseSupplierOrderActions } from '../plugin';
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
      status: 'confirmed',
      expectedDeliveryDate: '2025-07-24',
    });
    await actions.updateOrderOperatorFields(updateOrderContext, vi.fn());
    expect(updateOrderContext.body).toMatchObject({
      data: expect.objectContaining({
        status: 'confirmed',
        statusSource: 'manual',
        expectedDeliveryDate: '2025-07-24',
        expectedDeliveryDateSource: 'manual',
      }),
    });

    const updateLineContext = createActionContext(db, {
      supplierOrderLineId: 'supplier-order-line-1',
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
      actions.updateOrderOperatorFields(createActionContext(db, { supplierOrderId: 'supplier-order-1', status: 'bad' }), vi.fn()),
    ).rejects.toThrow('Ecobase supplier-order update failed: status "bad" is not supported.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, { supplierOrderLineId: 'supplier-order-line-1', expectedSellableDate: '25/07/2025' }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedSellableDate must use YYYY-MM-DD.');
    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, { supplierOrderId: 'supplier-order-1', expectedDeliveryDate: '2025-02-31' }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedDeliveryDate must be a valid calendar date.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, { supplierOrderLineId: 'supplier-order-line-1', expectedSellableDate: '2025-99-99' }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedSellableDate must be a valid calendar date.');

    const leapDateContext = createActionContext(db, {
      supplierOrderLineId: 'supplier-order-line-1',
      expectedSellableDate: '2024-02-29',
    });
    await actions.updateLineOperatorFields(leapDateContext, vi.fn());
    expect(leapDateContext.body).toMatchObject({
      data: expect.objectContaining({ expectedSellableDate: '2024-02-29' }),
    });

    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
      values: { id: 1, naturalKey: 'legacy-order-1', company: 'Ecofission LLC', status: 'planned' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
      values: { id: 1, naturalKey: 'legacy-line-1', supplierOrderId: 1, orderedQty: 1, receivedQty: 0 },
    });
    await actions.updateOrderOperatorFields(createActionContext(db, { supplierOrderId: 1, status: 'confirmed' }), vi.fn());
    await actions.updateLineOperatorFields(createActionContext(db, { supplierOrderLineId: 1, receivedQty: 1 }), vi.fn());
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).all().find((record) => record.id === 1)).toMatchObject({
      status: 'confirmed',
      statusSource: 'manual',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).all().find((record) => record.id === 1)).toMatchObject({
      receivedQty: 1,
      receivedQtySource: 'manual',
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
});
