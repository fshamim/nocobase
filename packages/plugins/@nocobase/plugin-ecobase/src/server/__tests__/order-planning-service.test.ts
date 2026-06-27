import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseOrderPlanningService } from '../services/order-planning-service';

class FakeRepository implements EcobaseRepository {
  rows: Record<string, unknown>[] = [];

  async find(params?: { filter?: Record<string, unknown>; filterByTk?: string | number; limit?: number }) {
    const rows = this.rows.filter((row) => matches(row, params));
    return typeof params?.limit === 'number' ? rows.slice(0, params.limit) : rows;
  }

  async findOne(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.find((row) => matches(row, params)) ?? null;
  }

  async create(params: { values: Record<string, unknown> }) {
    const row = { ...params.values, createdAt: params.values.createdAt ?? '2026-06-24T10:00:00.000Z' };
    this.rows.push(row);
    return row;
  }

  async update(params: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const rows = this.rows.filter((row) => matches(row, params));
    rows.forEach((row) => Object.assign(row, params.values));
    return rows[0] ?? null;
  }
}

class FakeDatabase implements EcobaseDatabase {
  repositories = new Map<string, FakeRepository>();
  touched = new Set<string>();

  getRepository(name: string) {
    this.touched.add(name);
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

function matches(
  row: Record<string, unknown>,
  params?: { filter?: Record<string, unknown>; filterByTk?: string | number },
) {
  if (params?.filterByTk !== undefined && row.id !== params.filterByTk) return false;
  return Object.entries(params?.filter ?? {}).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray((value as { $in?: unknown[] }).$in)) {
      return (value as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === value;
  });
}

async function seed(db: FakeDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
    values: { id: 'company-1', name: 'SampleAM', companyKey: 'SAM' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
    values: { id: 'supplier-1', normalizedName: 'acme', displayName: 'Acme Supply' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
    values: { id: 'supplier-2', normalizedName: 'beta', displayName: 'Beta Supply' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: 'product-1', asin: 'B001', sku: 'SKU-1', title: 'First product' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: 'product-2', asin: 'B002', sku: 'SKU-2', title: 'Second product' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: 'product-3', asin: 'B003', sku: 'SKU-3', title: 'Third product' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: { id: 'company-product-1', companyId: 'company-1', productId: 'product-1' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: { id: 'company-product-2', companyId: 'company-1', productId: 'product-2' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: { id: 'company-product-3', companyId: 'company-1', productId: 'product-3' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
    values: { id: 'supplier-product-1', supplierId: 'supplier-1', productId: 'product-1' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
    values: {
      id: 'order-1',
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderRef: 'SAM062426A',
      orderDate: '2026-06-24',
      dailySequenceLetter: 'A',
      lifecycleStatus: 'In Progress',
      nextAction: 'confirm invoice',
      expectedDeliveryDate: '2026-06-30',
      remarks: 'Fallback remark',
      createdAt: '2026-06-20T00:00:00.000Z',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
    values: {
      id: 'order-2',
      companyId: 'company-1',
      supplierId: 'supplier-2',
      orderRef: 'SAM062426B',
      orderDate: '2026-06-19',
      dailySequenceLetter: 'B',
      lifecycleStatus: 'Draft',
      expectedDeliveryDate: '2026-07-05',
      createdAt: '2026-06-21T00:00:00.000Z',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
    values: {
      id: 'line-1',
      orderId: 'order-1',
      companyProductId: 'company-product-1',
      supplierProductId: 'supplier-product-1',
      orderedQty: 10,
      unitCost: 2,
      expectedProfit: 50,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
    values: {
      id: 'line-2',
      orderId: 'order-1',
      companyProductId: 'company-product-2',
      supplierProductId: 'supplier-product-1',
      orderedQty: 5,
      unitCost: 4,
      expectedProfit: 20,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
    values: {
      id: 'line-3',
      orderId: 'order-2',
      companyProductId: 'company-product-3',
      supplierProductId: 'supplier-product-1',
      orderedQty: 1,
      expectedProfit: 30,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
    values: {
      id: 'gold-1',
      company: 'SampleAM',
      supplierOrderRef: 'SAM062426A',
      calculationDate: '2026-06-24',
      tier: 'B',
      estimatedProfitRisk: 300,
      estimatedOosDate: '2026-06-28',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
    values: {
      id: 'gold-2',
      company: 'SampleAM',
      supplierOrderRef: 'SAM062426A',
      calculationDate: '2026-06-24',
      tier: 'B',
      estimatedProfitRisk: 50,
      estimatedOosDate: '2026-06-26',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverInvoices).create({
    values: {
      id: 'invoice-1',
      orderId: 'order-1',
      invoiceNumber: 'INV-1',
      invoiceType: 'normal',
      status: 'In Progress',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
    values: {
      id: 'comment-1',
      entityType: 'order',
      entityId: 'order-1',
      actorType: 'operator',
      commentType: 'note',
      body: 'Call supplier today',
      createdAt: '2026-06-23T12:00:00.000Z',
    },
  });
}

describe('EcobaseOrderPlanningService', () => {
  it('loads medallion-only order planning rows sorted by supplier risk and OOS urgency', async () => {
    const db = new FakeDatabase();
    await seed(db);

    const result = await new EcobaseOrderPlanningService(db).listOrders({ companyId: 'company-1', hideClosed: false });

    expect(result.rows[0]).toMatchObject({
      id: 'order-1',
      supplierName: 'Acme Supply',
      asinCount: 2,
      lineCount: 2,
      moneyAtRisk: 350,
      riskSource: 'gold',
      earliestOosDate: '2026-06-26',
      latestComment: 'Call supplier today',
    });
    expect(result.rows[1]).toMatchObject({ id: 'order-2', moneyAtRisk: 30, riskSource: 'silver_estimate' });
    expect(db.touched).not.toContain(ECOBASE_COLLECTIONS.supplierOrders);
    expect(db.touched).not.toContain(ECOBASE_COLLECTIONS.supplierOrderLines);
    expect(db.touched).not.toContain(ECOBASE_COLLECTIONS.planningProducts);
  });

  it('prioritizes tier before money at risk', async () => {
    const db = new FakeDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'gold-order-2-a-tier',
        company: 'SampleAM',
        supplierOrderRef: 'SAM062426B',
        calculationDate: '2026-06-24',
        tier: 'A',
        estimatedProfitRisk: 1,
        estimatedOosDate: '2026-07-01',
      },
    });

    const result = await new EcobaseOrderPlanningService(db).listOrders({ companyId: 'company-1', hideClosed: false });

    expect(result.rows[0]).toMatchObject({ id: 'order-2', tier: 'A', moneyAtRisk: 1 });
    expect(result.rows[1]).toMatchObject({ id: 'order-1', tier: 'B', moneyAtRisk: 350 });
  });

  it('loads linked invoices in order detail', async () => {
    const db = new FakeDatabase();
    await seed(db);

    const detail = await new EcobaseOrderPlanningService(db).getOrderDetail('order-1');

    expect(detail.invoices).toEqual([
      expect.objectContaining({ id: 'invoice-1', invoiceNumber: 'INV-1', status: 'In Progress' }),
    ]);
  });

  it('covers MX6426A by resolving Google Sheets completed latest order to ORDERED with status check', async () => {
    const db = new FakeDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-1',
      values: { orderRef: 'MX6426A', lifecycleStatus: 'Completed' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).update({
      filter: { supplierOrderRef: 'SAM062426A' },
      values: { supplierOrderRef: 'MX6426A' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-2',
      values: { lifecycleStatus: 'Rejected', orderDate: '2026-05-20' },
    });

    const result = await new EcobaseOrderPlanningService(db).listOrders({ companyId: 'company-1', hideClosed: false });

    expect(result.rows.find((row) => row.id === 'order-1')).toMatchObject({
      orderRef: 'MX6426A',
      currentStatus: 'ORDERED',
      statusCheckRequired: true,
      moneyAtRisk: 350,
    });
  });

  it('closes older Google Sheets completed cycles when a later same-product order exists', async () => {
    const db = new FakeDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-1',
      values: { lifecycleStatus: 'Completed', orderDate: '2026-06-20' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-2',
      values: { lifecycleStatus: 'Rejected', orderDate: '2026-06-24' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).update({
      filterByTk: 'line-3',
      values: { companyProductId: 'company-product-1' },
    });

    const result = await new EcobaseOrderPlanningService(db).listOrders({ companyId: 'company-1', hideClosed: false });

    expect(result.rows.find((row) => row.id === 'order-1')).toMatchObject({
      currentStatus: 'COMPLETE',
      statusSource: 'source_history',
      moneyAtRisk: 0,
    });
  });

  it('uses linked invoice evidence to close stale rejected rows', async () => {
    const db = new FakeDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-1',
      values: {
        orderRef: 'EF112123B',
        lifecycleStatus: 'Rejected',
        orderDate: '2026-06-22',
        statusEvidenceJson: { sourceOrderStatus: 'Rejected' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInvoices).update({
      filterByTk: 'invoice-1',
      values: { invoiceNumber: '12089', status: 'Uploaded' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).update({
      filter: { supplierOrderRef: 'SAM062426A' },
      values: { supplierOrderRef: 'EF112123B' },
    });

    const result = await new EcobaseOrderPlanningService(db).listOrders({ companyId: 'company-1', hideClosed: false });

    expect(result.rows.find((row) => row.id === 'order-1')).toMatchObject({
      currentStatus: 'COMPLETE',
      statusSource: 'historical_invoice_evidence',
      moneyAtRisk: 0,
      statusEvidence: expect.objectContaining({ invoiceStatus: 'Uploaded' }),
    });
  });

  it('uses embedded dates in long order refs before imported fallback dates', async () => {
    const db = new FakeDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-1',
      values: {
        orderRef: 'USA-RH-NU-10252025-01',
        orderDate: '2026-06-22',
        statusEvidenceJson: { sourceOrderStatus: 'In Progress' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).update({
      filter: { supplierOrderRef: 'SAM062426A' },
      values: { supplierOrderRef: 'USA-RH-NU-10252025-01' },
    });

    const result = await new EcobaseOrderPlanningService(db).listOrders({ companyId: 'company-1', hideClosed: false });

    expect(result.rows.find((row) => row.id === 'order-1')).toMatchObject({
      currentStatus: 'COMPLETE',
      statusSource: 'historical_age_evidence',
      moneyAtRisk: 0,
      statusEvidence: expect.objectContaining({ orderDate: '2025-10-25' }),
    });
  });

  it('materializes gold order-planning rows and serves the queue from them', async () => {
    const db = new FakeDatabase();
    await seed(db);
    const service = new EcobaseOrderPlanningService(db);

    await service.refreshReadModel({ companyId: 'company-1' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-1',
      values: { nextAction: 'changed after refresh' },
    });

    const result = await service.listOrders({ companyId: 'company-1', hideClosed: false });

    expect(db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).rows).toHaveLength(2);
    expect(
      db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).rows.find((row) => row.id === 'order-1'),
    ).toMatchObject({
      orderId: 'order-1',
      moneyAtRisk: 350,
      currentStatus: 'IN-PROGRESS',
    });
    expect(result.rows.find((row) => row.id === 'order-1')?.nextAction).toBe('confirm invoice');
  });

  it('updates order status as an operator override and appends an audit comment', async () => {
    const db = new FakeDatabase();
    await seed(db);

    const detail = await new EcobaseOrderPlanningService(db).updateOrder({
      orderId: 'order-1',
      values: { lifecycleStatus: 'INBOUND MONITORING' },
      actorUserId: 'user-1',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.find((row) => row.id === 'order-1')).toMatchObject({
      lifecycleStatus: 'INBOUND MONITORING',
      canonicalStatus: 'INBOUND MONITORING',
      statusSource: 'operator',
      statusCheckRequired: false,
      operatorStatusOverrideByUserId: 'user-1',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows.at(-1)).toMatchObject({
      entityType: 'order',
      entityId: 'order-1',
      body: 'Status changed from In Progress to INBOUND MONITORING.',
    });
    expect(detail.order.currentStatus).toBe('INBOUND MONITORING');
  });

  it('updates invoice status and appends an order audit comment', async () => {
    const db = new FakeDatabase();
    await seed(db);

    const detail = await new EcobaseOrderPlanningService(db).updateInvoice({
      invoiceId: 'invoice-1',
      status: 'Completed',
      actorUserId: 'user-1',
    });

    expect(
      db.getRepository(ECOBASE_COLLECTIONS.silverInvoices).rows.find((row) => row.id === 'invoice-1'),
    ).toMatchObject({
      status: 'Completed',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows.at(-1)).toMatchObject({
      entityType: 'order',
      entityId: 'order-1',
      body: 'Invoice INV-1 status changed from In Progress to Completed.',
    });
    expect(detail.invoices[0]).toMatchObject({ status: 'Completed' });
  });

  it('soft-deletes comments from order detail and latest-comment rollups', async () => {
    const db = new FakeDatabase();
    await seed(db);
    const service = new EcobaseOrderPlanningService(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: 'order-1',
      values: { remarks: null },
    });
    await service.refreshReadModel({ companyId: 'company-1' });

    const detail = await service.deleteComment({
      orderId: 'order-1',
      commentId: 'comment-1',
      actorUserId: 'user-1',
    });

    expect(
      db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows.find((row) => row.id === 'comment-1'),
    ).toMatchObject({
      deletedByUserId: 'user-1',
      workflowDetectionStatus: 'deleted',
    });
    expect(
      db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).rows.find((row) => row.id === 'order-1'),
    ).toMatchObject({
      latestComment: null,
    });
    expect(detail.comments).toHaveLength(0);
    expect(detail.order.latestComment).toBeUndefined();
  });

  it('updates line fields and appends comments to silver comments', async () => {
    const db = new FakeDatabase();
    await seed(db);

    const detail = await new EcobaseOrderPlanningService(db).updateLine({
      orderLineId: 'line-1',
      values: { orderedQty: 12, unitCost: 3 },
      commentBody: 'Adjusted line quantity',
      actorUserId: 'user-1',
    });

    expect(
      db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.find((row) => row.id === 'line-1'),
    ).toMatchObject({
      orderedQty: 12,
      unitCost: 3,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows.at(-1)).toMatchObject({
      entityType: 'order_line',
      entityId: 'line-1',
      body: 'Adjusted line quantity',
    });
    expect(detail.order.id).toBe('order-1');
  });
});
