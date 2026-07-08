/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { EcobaseMedallionNormalizationService } from '../../features/semantic-model/server/medallion-normalization-service';

class FakeRepository implements EcobaseRepository {
  rows: Record<string, unknown>[] = [];

  async find(params?: { filter?: Record<string, unknown>; filterByTk?: string | number; limit?: number }) {
    const rows = this.rows.filter((row) => matches(row, params));
    return rows.slice(0, params?.limit ?? rows.length);
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
    this.rows = this.rows.map((row) => (matches(row, params) ? { ...row, ...params.values } : row));
    return this.rows.filter((row) => matches(row, params));
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

async function seedBronze(db: FakeDatabase, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
    values: {
      id: `bronze-${db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows.length + 1}`,
      sourceConnectionId: 'source-1',
      importRunId: 'import-1',
      sourceType: 'google_sheets',
      sourceDataset: 'MasterStock.csv',
      sourceRecordKey: `MasterStock.csv:${payload.ASIN ?? payload['Order ID'] ?? 'row'}`,
      rowHash: `hash-${JSON.stringify(payload).length}`,
      payload,
      normalizationStatus: 'pending',
      ...overrides,
    },
  });
}

describe('EcobaseMedallionNormalizationService', () => {
  it('normalizes product inventory rows into silver identity and fact tables', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00PUSNY5A',
      SKU: 'W101',
      Title: 'Lesson Plan',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '386',
      Reserved: '13',
      Ordered: '500',
      'Estimated Sales Velocity': '9.79',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 1, ignored: 0, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows[0]).toMatchObject({
      sellableStock: 386,
      reserved: 13,
      ordered: 500,
      salesVelocity: 9.79,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[0].normalizationStatus).toBe('normalized');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows.length).toBeGreaterThan(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows[0].relation).toBe('created_from');
  });

  it('links missing-marketplace order details to the existing Sellerboard company product', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00PUSNY5A',
      SKU: 'W101',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '386',
      SalesOrganic: '100',
      UnitsOrganic: '8',
    });
    await seedBronze(
      db,
      {
        'Order ID': 'EF-ORDER-1',
        Timestamp: '10/07/2023 08:00:00',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-200',
        Supplier: 'Beta Supply',
        ASIN: 'B00PUSNY5A',
        SKU: 'W101',
        Qty: '60',
        PPU: '1.25',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).rows[0]).toMatchObject({
      marketplace: 'Amazon.com',
    });
    const companyProducts = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows;
    expect(companyProducts).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows[0].companyProductId).toBe(
      companyProducts[0].id,
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0].companyProductId).toBe(companyProducts[0].id);
  });

  it('normalizes order detail rows into silver orders and lines', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        'Order ID': 'OD-NEW',
        Timestamp: '10/07/2023 08:00:00',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-201',
        Supplier: 'Beta Supply',
        ASIN: 'B0057XUD02',
        SKU: 'V-651-A',
        Qty: '60',
        PPU: '1.25',
        'Order type': 'New',
        'Lead time(day)': '12',
        'T.Profit': '240',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      orderRef: 'OD-NEW',
      orderDate: '2023-07-10',
      lifecyclePhase: 'imported',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      orderedQty: 60,
      unitCost: 1.25,
      expectedProfit: 240,
    });
  });

  it('keeps expected sellable dates in silver without falling back to legacy supplier order lines', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        'Order ID': 'MX2626C',
        Timestamp: '06/02/2026',
        Company: 'Muxtex INC',
        'SR ID': 'SRO-202',
        Supplier: 'Discount Pond Supply',
        ASIN: 'B0002DHFIU',
        SKU: 'SUP02745',
        Qty: '3',
        PPU: '197.91',
        'ETA on Amazon': '2026-03-02',
      },
      { sourceDataset: 'Pre-Order Sheet.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'MX2626C',
        Timestamp: '06/02/2026',
        Company: 'Muxtex INC',
        'SR ID': 'SRO-202',
        Supplier: 'Discount Pond Supply',
        ASIN: 'B0002DHFIU',
        SKU: 'SUP02745',
        Qty: '3',
        PPU: '197.91',
        'AM Status': 'Cleared',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'MX2626C',
        Timestamp: '06/02/2026',
        Company: 'Muxtex INC',
        'SR ID': 'SRO-202',
        Supplier: 'Discount Pond Supply',
        ASIN: 'B0009YYURQ',
        SKU: 'SUP02745',
        Qty: '1',
        PPU: '10.00',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    const lines = db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows;
    expect(lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ orderedQty: 3, expectedSellableDate: '2026-03-02' })]),
    );
    expect(lines.find((line) => line.orderedQty === 1)).not.toHaveProperty('expectedSellableDate');
  });

  it('is idempotent when the same bronze row is normalized again', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00PUSNY5A',
      SKU: 'W101',
      'SR ID': 'SRO-203',
      Supplier: 'Alpha Supply',
      'FBA/FBM Stock': '10',
    });
    const service = new EcobaseMedallionNormalizationService(db);
    await service.normalizePending();
    const firstLinkCount = db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows.length;
    await db
      .getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords)
      .update({ filterByTk: 'bronze-1', values: { normalizationStatus: 'pending' } });

    const result = await service.normalizePending();

    expect(result).toMatchObject({ normalized: 1, failed: 0, links: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows).toHaveLength(firstLinkCount);
  });

  it('uses SR ID as supplier identity across supplier name drift', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Muxtex INC',
      'SR ID': 'SRO-9095',
      Supplier: 'Premierwd',
      ASIN: 'B07B43WF8G',
      SKU: '381',
      Qty: '1',
    });
    await seedBronze(db, {
      Company: 'Muxtex INC',
      'SR ID': 'sro-9095',
      Supplier: 'Premier WD',
      ASIN: 'B07B43NW4G',
      SKU: '380',
      Qty: '1',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).rows).toEqual([
      expect.objectContaining({ normalizedExternalSupplierCode: 'SRO-9095' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(2);
  });

  it('imports supplier lead-time ranges and warns on invalid lead-time text', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-250',
      Supplier: 'Lead Supply',
      ASIN: 'B00LEAD001',
      SKU: 'LEAD-1',
      'Lead time(day)': '1-2 weeks',
    });
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-251',
      Supplier: 'Invalid Lead Supply',
      ASIN: 'B00LEAD002',
      SKU: 'LEAD-2',
      'Lead time(day)': 'OOS',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ leadTimeDays: 14 })]),
    );
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
        .rows.find((supplierProduct) => supplierProduct.productId !== undefined && supplierProduct.leadTimeDays !== 14),
    ).not.toHaveProperty('leadTimeDays');
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[1]).toMatchObject({
      issueSeverity: 'warning',
      issueCode: 'lead_time_unparsed',
    });
  });

  it('does not create name-only suppliers when SR ID is missing or invalid', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      Supplier: 'Name Only Supply',
      ASIN: 'B00PUSNY5A',
      SKU: 'W101',
      Qty: '1',
    });
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      'SR ID': 'duplicate',
      Supplier: 'Duplicate Supply',
      ASIN: 'B00PUSNY5B',
      SKU: 'W102',
      Qty: '1',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).rows).toHaveLength(0);
  });

  it('links ASIN-only supplier tracker rows to existing company products without SKU-equals-ASIN duplicates', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Stop Shop LLC',
      ASIN: 'B0764NLBH1',
      SKU: '2-Pack',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '10',
    });
    await seedBronze(
      db,
      {
        'SR ID': 'SRO-300',
        'Supplier Name': 'Lake Industries',
        ASIN: 'B0764NLBH1',
        'Reached Via': 'Stop Shop LLC',
      },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows[0]).toMatchObject({ sku: '2-Pack' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows[0]).not.toHaveProperty('supplierSku');
  });

  it('does not link supplier tracker rows to old ASIN-as-SKU duplicate products', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Stop Shop LLC',
      ASIN: 'B00DUPLICATE',
      SKU: 'B00DUPLICATE',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '10',
    });
    await seedBronze(
      db,
      {
        'SR ID': 'SRO-302',
        'Supplier Name': 'Lake Industries',
        ASIN: 'B00DUPLICATE',
        'Reached Via': 'Stop Shop LLC',
      },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[1]).toMatchObject({
      issueSeverity: 'warning',
      issueCode: 'supplier_product_unresolved',
    });
  });

  it('keeps order header supplier while using detail supplier for mismatched order lines', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        'Order ID': 'PO-1',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-H',
        Supplier: 'Header Supply',
        'Order status': 'ORDERED',
      },
      { sourceDataset: 'Purchase Orders.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'PO-1',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-L',
        Supplier: 'Line Supply',
        ASIN: 'B00LINE001',
        SKU: 'LINE-SKU',
        Qty: '2',
        PPU: '4.50',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    const headerSupplier = db
      .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
      .rows.find((supplier) => supplier.displayName === 'Header Supply');
    const lineSupplierRef = db
      .getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs)
      .rows.find((ref) => ref.normalizedExternalSupplierCode === 'SRO-L');
    const line = db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0];
    const lineSupplierProduct = db
      .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
      .rows.find((supplierProduct) => supplierProduct.id === line.supplierProductId);

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      orderRef: 'PO-1',
      supplierId: headerSupplier?.id,
    });
    expect(lineSupplierProduct).toMatchObject({ supplierId: lineSupplierRef?.supplierId });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[1]).toMatchObject({
      issueSeverity: 'warning',
      issueCode: 'order_supplier_mismatch',
    });
  });

  it('does not guess ASIN-only supplier tracker links when company products are ambiguous', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Stop Shop LLC',
      ASIN: 'B01DAYLVYG',
      SKU: '38670',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '10',
    });
    await seedBronze(db, {
      Company: 'Stop Shop LLC',
      ASIN: 'B01DAYLVYG',
      SKU: 'Pitcher Cartridge',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '5',
    });
    await seedBronze(
      db,
      {
        'SR ID': 'SRO-301',
        'Supplier Name': 'Lake Industries',
        ASIN: 'B01DAYLVYG',
        'Reached Via': 'Stop Shop LLC',
      },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[2]).toMatchObject({
      issueSeverity: 'warning',
      issueCode: 'supplier_product_unresolved',
    });
  });

  it('marks mapper failures clearly without stopping the batch', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, { Company: '!!!', ASIN: 'B001', SKU: 'SKU-1' });
    await seedBronze(db, { Company: 'Ecofission LLC', ASIN: 'B002', SKU: 'SKU-2' });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(1);
    expect(result.normalized).toBe(1);
    expect(result.errors[0]).toMatch(/companyKey/);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[0].normalizationStatus).toBe('failed');
  });
});
