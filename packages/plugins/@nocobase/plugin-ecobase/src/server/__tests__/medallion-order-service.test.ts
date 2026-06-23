import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseMedallionOrderService } from '../services/medallion-order-service';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { toPlainRecord } from '../services/import-service';

class FakeRepository implements EcobaseRepository {
  rows: Record<string, unknown>[] = [];

  async find(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.filter((row) => matches(row, params));
  }

  async findOne(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.find((row) => matches(row, params)) ?? null;
  }

  async create(params: { values: Record<string, unknown> }) {
    this.rows.push({ ...params.values });
    return this.rows[this.rows.length - 1];
  }

  async update(params: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const matchesRows = this.rows.filter((row) => matches(row, params));
    matchesRows.forEach((row) => Object.assign(row, params.values));
    return matchesRows[0] ?? null;
  }
}

class FakeDatabase implements EcobaseDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
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
  return Object.entries(params?.filter ?? {}).every(([key, value]) => row[key] === value);
}

function idOf(record: unknown) {
  const id = toPlainRecord(record).id;
  if (typeof id !== 'string') throw new Error('Expected fake record to have a string id.');
  return id;
}

async function seedCore(db: FakeDatabase) {
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
}

describe('EcobaseMedallionOrderService', () => {
  it('generates order references and resets sequence by company/day', async () => {
    const db = new FakeDatabase();
    await seedCore(db);
    const service = new EcobaseMedallionOrderService(db);

    const first = await service.createDraftOrder({
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderDate: '2026-06-22',
    });
    const second = await service.createDraftOrder({
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderDate: '2026-06-22',
    });
    const nextDay = await service.createDraftOrder({
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderDate: '2026-06-23',
    });

    expect(toPlainRecord(first)).toMatchObject({ orderRef: 'SAM062226A', dailySequenceLetter: 'A' });
    expect(toPlainRecord(second)).toMatchObject({ orderRef: 'SAM062226B', dailySequenceLetter: 'B' });
    expect(toPlainRecord(nextDay)).toMatchObject({ orderRef: 'SAM062326A', dailySequenceLetter: 'A' });
  });

  it('fails clearly on the 27th order for a company/day', async () => {
    const db = new FakeDatabase();
    await seedCore(db);
    const service = new EcobaseMedallionOrderService(db);
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
        values: {
          id: `order-${letter}`,
          companyId: 'company-1',
          supplierId: 'supplier-1',
          orderRef: `SAM062226${letter}`,
          orderDate: '2026-06-22',
          dailySequenceLetter: letter,
        },
      });
    }

    await expect(
      service.createDraftOrder({ companyId: 'company-1', supplierId: 'supplier-1', orderDate: '2026-06-22' }),
    ).rejects.toThrow(/no order reference letters remain/);
  });

  it('creates draft orders, order lines, and normal invoices', async () => {
    const db = new FakeDatabase();
    await seedCore(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).create({
      values: {
        id: 'supplier-account-1',
        supplierId: 'supplier-1',
        companyId: 'company-1',
        accountName: 'Acme portal',
      },
    });
    const service = new EcobaseMedallionOrderService(db);

    const order = await service.createDraftOrder({
      companyId: 'company-1',
      supplierId: 'supplier-1',
      supplierAccountId: 'supplier-account-1',
      orderDate: '2026-06-22',
      expectedDeliveryDate: '2026-07-01',
      actorUserId: 'user-1',
    });
    const line = await service.createOrderLine({
      orderId: idOf(order),
      companyProductId: 'company-product-1',
      supplierProductId: 'supplier-product-1',
      orderedQty: 12,
      unitCost: 3.5,
      supplierPackSize: 6,
      prepInstruction: 'label required',
      expectedSellableDate: '2026-07-05',
    });
    const invoice = await service.createNormalInvoice({ orderId: idOf(order), invoiceNumber: 'INV-1', amount: 42 });
    const sameInvoice = await service.createNormalInvoice({
      orderId: idOf(order),
      invoiceNumber: 'INV-1B',
      amount: 45,
    });

    expect(toPlainRecord(order)).toMatchObject({
      companyId: 'company-1',
      supplierId: 'supplier-1',
      supplierAccountId: 'supplier-account-1',
      lifecyclePhase: 'draft',
      lifecycleStatus: 'draft',
      nextAction: 'supplier_confirmation',
      expectedDeliveryDate: '2026-07-01',
    });
    expect(toPlainRecord(line)).toMatchObject({
      orderId: idOf(order),
      orderedQty: 12,
      unitCost: 3.5,
      supplierPackSize: 6,
      prepInstruction: 'label required',
      expectedSellableDate: '2026-07-05',
    });
    expect(idOf(sameInvoice)).toBe(idOf(invoice));
    expect(toPlainRecord(sameInvoice)).toMatchObject({ invoiceType: 'normal', invoiceNumber: 'INV-1B', amount: 45 });
  });

  it('rejects missing references and invalid order-line quantities', async () => {
    const db = new FakeDatabase();
    await seedCore(db);
    const service = new EcobaseMedallionOrderService(db);
    const order = await service.createDraftOrder({
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderDate: '2026-06-22',
    });

    await expect(
      service.createDraftOrder({ companyId: 'missing-company', supplierId: 'supplier-1', orderDate: '2026-06-22' }),
    ).rejects.toThrow(/company missing-company does not exist/);
    await expect(
      service.createDraftOrder({ companyId: 'company-1', supplierId: 'missing-supplier', orderDate: '2026-06-22' }),
    ).rejects.toThrow(/supplier missing-supplier does not exist/);
    await expect(
      service.createDraftOrder({
        companyId: 'company-1',
        supplierId: 'supplier-1',
        supplierAccountId: 'missing-account',
        orderDate: '2026-06-22',
      }),
    ).rejects.toThrow(/supplier account missing-account does not exist/);
    await expect(
      service.createOrderLine({
        orderId: idOf(order),
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 0,
      }),
    ).rejects.toThrow(/orderedQty must be greater than zero/);
    await expect(
      service.createOrderLine({
        orderId: idOf(order),
        companyProductId: 'missing-company-product',
        supplierProductId: 'supplier-product-1',
        orderedQty: 1,
      }),
    ).rejects.toThrow(/company product missing-company-product does not exist/);
  });

  it('audits manual order reference edits', async () => {
    const db = new FakeDatabase();
    await seedCore(db);
    const service = new EcobaseMedallionOrderService(db);
    const order = await service.createDraftOrder({
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderDate: '2026-06-22',
    });

    const updated = await service.updateOrderRef(idOf(order), 'SAM-MANUAL-1', 'user-1');
    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows;

    expect(toPlainRecord(updated).orderRef).toBe('SAM-MANUAL-1');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      entityType: ECOBASE_COLLECTIONS.silverOrders,
      entityId: idOf(order),
      actorType: 'user',
      actorUserId: 'user-1',
      commentType: 'order_ref_edited',
    });
  });
});
