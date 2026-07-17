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
import {
  approvedAmazonIdentitySource,
  EcobaseMedallionNormalizationService,
} from '../../features/semantic-model/server/medallion-normalization-service';

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
  sequelize?: { query: (sql: string, options: unknown) => Promise<unknown[]> };

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
  const sourceType = String(overrides.sourceType ?? 'sellerboard');
  const sourceDataset = String(overrides.sourceDataset ?? 'amazon_listing_inventory');
  const importRunId = `import-${sourceType}-${sourceDataset}`;
  if (!(await db.getRepository(ECOBASE_COLLECTIONS.importRuns).findOne({ filterByTk: importRunId }))) {
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: importRunId,
        adapterName: String(
          overrides.adapterName ?? (sourceType === 'sellerboard' ? 'sellerboard-api' : 'google-sheets-migration-csv'),
        ),
      },
    });
  }
  return db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
    values: {
      id: `bronze-${db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows.length + 1}`,
      sourceConnectionId: 'source-1',
      importRunId,
      sourceType,
      sourceDataset,
      sourceRecordKey: `${sourceDataset}:${payload.ASIN ?? payload['Order ID'] ?? 'row'}`,
      rowHash: `hash-${JSON.stringify(payload).length}`,
      payload,
      observedAt: '2026-06-01T00:00:00.000Z',
      normalizationStatus: 'pending',
      ...overrides,
    },
  });
}

async function seedOrderPrerequisites(db: FakeDatabase, detail: Record<string, unknown>) {
  const company = String(detail.Company);
  const supplierCode = String(detail['SR ID']);
  const supplierName = String(detail.Supplier);
  const orderRef = String(detail['Order ID']);
  const timestamp = detail.Timestamp ?? '01/06/2026';
  await seedBronze(
    db,
    { 'SR ID': supplierCode, 'Supplier Name': supplierName, 'Reached Via': company },
    { sourceType: 'google_sheets', sourceDataset: 'Supplier Analysis Tracker.csv' },
  );
  await seedBronze(
    db,
    { 'Order ID': orderRef, Timestamp: timestamp, Company: company, 'SR ID': supplierCode, Supplier: supplierName },
    { sourceType: 'google_sheets', sourceDataset: 'Purchase Orders.csv' },
  );
}

async function seedOrderBundle(db: FakeDatabase, detail: Record<string, unknown>) {
  await seedOrderPrerequisites(db, detail);
  return seedBronze(db, detail, { sourceType: 'google_sheets', sourceDataset: 'OrderDetails.csv' });
}

describe('EcobaseMedallionNormalizationService', () => {
  it('creates Amazon identity only for explicit Sellerboard adapters and datasets', () => {
    expect(
      approvedAmazonIdentitySource({
        sourceType: 'sellerboard',
        adapterName: 'sellerboard-api',
        sourceDataset: 'amazon_listing_inventory',
      }),
    ).toBe(true);
    expect(
      approvedAmazonIdentitySource({
        sourceType: 'sellerboard',
        adapterName: 'sellerboard-history-csv',
        sourceDataset: 'sellerboard_daily_facts',
      }),
    ).toBe(false);
    expect(
      approvedAmazonIdentitySource({
        sourceType: 'sellerboard',
        adapterName: 'unapproved-sellerboard-adapter',
        sourceDataset: 'amazon_listing_inventory',
      }),
    ).toBe(false);
    expect(
      approvedAmazonIdentitySource({
        sourceType: 'google_sheets',
        adapterName: 'google-sheets-migration-csv',
        sourceDataset: 'amazon_listing_inventory',
      }),
    ).toBe(false);
  });
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
      'AWD Stock': '7',
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
      awdStock: 7,
      sourceConnectionId: 'source-1',
      salesVelocity: 9.79,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[0].normalizationStatus).toBe('normalized');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows.length).toBeGreaterThan(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows[0].relation).toBe('created_from');
  });

  it('keeps Sellerboard history facts on existing listings without creating catalog identity', async () => {
    const db = new FakeDatabase();
    const service = new EcobaseMedallionNormalizationService(db);
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00CURRENT',
      SKU: 'CURRENT-SKU',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '1',
    });
    await service.normalizePending();
    await seedBronze(
      db,
      {
        Company: 'Ecofission LLC',
        ASIN: 'B00CURRENT',
        SKU: 'CURRENT-SKU',
        Marketplace: 'Amazon.com',
        period: '06/12/2026',
        SalesOrganic: '10',
      },
      {
        sourceDataset: 'sellerboard_daily_facts',
        adapterName: 'sellerboard-history-csv',
        observedAt: '2026-06-12T00:00:00.000Z',
      },
    );
    await seedBronze(
      db,
      {
        Company: 'Ecofission LLC',
        ASIN: 'B00HISTORY',
        SKU: 'HISTORY-ONLY',
        Marketplace: 'Amazon.com',
        period: '2026-07-01',
        SalesOrganic: '10',
      },
      { sourceDataset: 'sellerboard_daily_facts', adapterName: 'sellerboard-history-csv' },
    );

    const result = await service.normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).rows).toEqual([
      expect.objectContaining({ snapshotDate: '2026-06-12' }),
    ]);
  });

  it('normalizes Sellerboard history units and sales as channel totals', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00TOTALS',
      SKU: 'TOTAL-SKU',
      Marketplace: 'Amazon.com',
      SalesOrganic: '100',
      SalesPPC: '20',
      SalesSponsoredProducts: '30',
      SalesSponsoredDisplay: '5',
      UnitsOrganic: '8',
      UnitsPPC: '2',
      UnitsSponsoredProducts: '3',
      UnitsSponsoredDisplay: '1',
      NetProfit: '70',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 1, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).rows[0]).toMatchObject({
      sales: 155,
      units: 14,
      profit: 70,
    });
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
    await seedOrderBundle(db, {
      'Order ID': 'EF-ORDER-1',
      Timestamp: '10/07/2023 08:00:00',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-200',
      Supplier: 'Beta Supply',
      ASIN: 'B00PUSNY5A',
      SKU: 'W101',
      Qty: '60',
      PPU: '1.25',
    });

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

  it('maps an exact supplier SKU alias to existing Sellerboard identity without creating a legacy listing', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        Company: 'Ecofission LLC',
        ASIN: 'B0177E9JPS',
        SKU: 'ETC-120A',
        Marketplace: 'Amazon.com',
        'FBA/FBM Stock': '12',
      },
      { sourceType: 'sellerboard', sourceDataset: 'sellerboard_daily_facts' },
    );
    await seedOrderBundle(db, {
      'Order ID': 'EF-ETC-1',
      Timestamp: '10/07/2026 08:00:00',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-ETC',
      Supplier: 'ETC Supply',
      ASIN: 'B0177E9JPS',
      SKU: 'ETC120A',
      Qty: '5',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toEqual([
      expect.objectContaining({ asin: 'B0177E9JPS', sku: 'ETC-120A' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      sourceAsin: 'B0177E9JPS',
      sourceSupplierSku: 'ETC120A',
      productMappingStatus: 'resolved',
    });
  });

  it('retains an unresolved legacy order line without creating Amazon identity', async () => {
    const db = new FakeDatabase();
    await seedOrderBundle(db, {
      'Order ID': 'EF-UNRESOLVED-1',
      Timestamp: '10/07/2026 08:00:00',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-UNRESOLVED',
      Supplier: 'Unresolved Supply',
      ASIN: 'B00UNRESOLVED',
      SKU: 'SUPPLIER-ONLY-SKU',
      Qty: '5',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toEqual([
      expect.objectContaining({
        sourceAsin: 'B00UNRESOLVED',
        sourceSupplierSku: 'SUPPLIER-ONLY-SKU',
        productMappingStatus: 'unresolved',
        orderedQty: 5,
      }),
    ]);
  });

  it('normalizes Purchase Orders headers before OrderDetails regardless of bronze row order', async () => {
    const db = new FakeDatabase();
    const detail = {
      'Order ID': 'EF1000A',
      Timestamp: '10/07/2023 08:00:00',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-200',
      Supplier: 'Ordered Supply',
      ASIN: 'B0057XUD02',
      SKU: 'V-651-A',
      Qty: '2',
    };
    await seedBronze(
      db,
      { 'SR ID': 'SRO-200', 'Supplier Name': 'Ordered Supply', 'Reached Via': 'Ecofission LLC' },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );
    await seedBronze(db, detail, { sourceDataset: 'OrderDetails.csv' });
    await seedBronze(
      db,
      {
        'Order ID': detail['Order ID'],
        Timestamp: detail.Timestamp,
        Company: detail.Company,
        'SR ID': detail['SR ID'],
        Supplier: detail.Supplier,
      },
      { sourceDataset: 'Purchase Orders.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 3, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toHaveLength(1);
  });

  it('uses one supplier_ids identity and header authority for projected order datasets', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        supplierExternalRef: 'SRO-300',
        supplierName: 'Acme, Inc.',
        companyProvenance: 'Ecofission LLC',
      },
      { sourceType: 'google_sheets', sourceDataset: 'supplier_tracker' },
    );
    await seedBronze(
      db,
      {
        orderRef: 'EF3000A',
        occurredAt: '2026-07-01T10:00:00.000Z',
        company: 'Ecofission LLC',
        supplierExternalRef: 'SRO-300',
        supplierName: 'Acme Inc',
        sourceAsin: 'B000000300',
        sourceSupplierSku: 'SKU-300',
        quantity: 3,
      },
      { sourceType: 'google_sheets', sourceDataset: 'order_details' },
    );
    await seedBronze(
      db,
      {
        orderRef: 'EF3000A',
        occurredAt: '2026-07-01T09:00:00.000Z',
        company: 'Ecofission LLC',
        supplierExternalRef: 'SRO-300',
        supplierName: 'ACME INC',
        status: 'In Progress',
      },
      { sourceType: 'google_sheets', sourceDataset: 'purchase_orders' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();
    const supplier = db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows[0];

    expect(result).toMatchObject({ normalized: 3, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).rows).toEqual([
      expect.objectContaining({
        supplierId: supplier.id,
        sourceSystem: 'supplier_ids',
        normalizedExternalSupplierCode: 'SRO-300',
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toEqual([
      expect.objectContaining({ orderRef: 'EF3000A', supplierId: supplier.id }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toHaveLength(1);
  });

  it('ignores order rows whose SR ID was not established by Supplier Management', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        'Order ID': 'EF1000B',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-MISSING',
        Supplier: 'Missing Supplier',
      },
      { sourceDataset: 'Purchase Orders.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ ignored: 1, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[0]).toMatchObject({
      normalizationStatus: 'ignored',
      issueCode: 'order_supplier_not_established',
    });
  });

  it('normalizes order detail rows into silver orders and lines', async () => {
    const db = new FakeDatabase();
    await seedOrderBundle(db, {
      'Order ID': 'EF1001A',
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
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      orderRef: 'EF1001A',
      orderDate: '2023-07-10',
      lifecyclePhase: 'imported',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      orderedQty: 60,
      unitCost: 1.25,
      expectedProfit: 240,
    });
  });

  it('preserves UPC as unresolved supplier identity when SKU is blank', async () => {
    const db = new FakeDatabase();
    await seedOrderBundle(db, {
      'Order ID': 'SS21424D',
      Timestamp: '14/02/2024 20:00:13',
      Company: 'Stop Shop LLC',
      'SR ID': 'SRO-6770',
      Supplier: 'Lake Industries',
      ASIN: 'B01DAYLVYG',
      UPC: '13189438670',
      SKU: '',
      Qty: '75',
      PPU: '23.8',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      sourceAsin: 'B01DAYLVYG',
      sourceSupplierSku: '13189438670',
      productMappingStatus: 'unresolved',
      orderedQty: 75,
      unitCost: 23.8,
    });
  });

  it('keeps expected sellable dates in silver without falling back to legacy supplier order lines', async () => {
    const db = new FakeDatabase();
    await seedOrderPrerequisites(db, {
      'Order ID': 'MX2626C',
      Timestamp: '06/02/2026',
      Company: 'Muxtex INC',
      'SR ID': 'SRO-202',
      Supplier: 'Discount Pond Supply',
    });
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
      expect.arrayContaining([
        expect.objectContaining({
          orderedQty: 3,
          expectedSellableDate: '2026-03-02',
          expectedArrivalDate: '2026-03-02',
          expectedArrivalStatus: 'imported',
          expectedArrivalSource: 'Pre-Order Sheet.csv:expected_sellable_date',
          expectedArrivalConfidence: 'authoritative',
        }),
      ]),
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

  it('ignores incomplete and unsupported order rows at the normalization boundary', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        'Order ID': 'USA-OTHER-1',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-1',
        Supplier: 'Supplier',
        ASIN: 'B000000001',
        SKU: 'SKU-1',
        Qty: '2',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'EF1001A',
        Company: 'Ecofission LLC',
        Supplier: 'Supplier',
        ASIN: 'B000000001',
        SKU: 'SKU-1',
        Qty: '2',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ ignored: 2, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toHaveLength(0);
  });

  it('registers an authoritative supplier SR ID without inventing company linkage', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      { 'SR ID': 'SRO-UNASSIGNED', 'Supplier Name': 'Unassigned Supplier' },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 1, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toEqual([
      expect.objectContaining({ displayName: 'Unassigned Supplier' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).rows).toEqual([
      expect.objectContaining({ normalizedExternalSupplierCode: 'SRO-UNASSIGNED' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).rows).toHaveLength(0);
  });

  it('imports supplier lead-time ranges and defaults unavailable lead-time text', async () => {
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
      Supplier: 'Unavailable Lead Supply',
      ASIN: 'B00LEAD002',
      SKU: 'LEAD-2',
      'Lead time(day)': 'OOS',
    });
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-252',
      Supplier: 'Blank Lead Supply',
      ASIN: 'B00LEAD003',
      SKU: 'LEAD-3',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leadTimeDays: 14 }),
        expect.objectContaining({ leadTimeDays: 30 }),
      ]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(3);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[1]).not.toMatchObject({
      issueCode: 'lead_time_unparsed',
    });
  });

  it('does not overwrite a specific supplier lead time with a later default row', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-253',
      Supplier: 'Stable Lead Supply',
      ASIN: 'B00LEAD004',
      SKU: 'LEAD-4',
      'Lead time(day)': '7',
    });
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-253',
      Supplier: 'Stable Lead Supply',
      ASIN: 'B00LEAD004',
      SKU: 'LEAD-4',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows[0]).toMatchObject({ leadTimeDays: 7 });
  });

  it('fails supplier rows with unsupported numeric lead-time text', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-BAD-LEAD',
      Supplier: 'Bad Lead Supply',
      ASIN: 'B00BADLEAD',
      SKU: 'BAD-LEAD',
      'Lead time(day)': '0',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('lead time "0"');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(0);
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

  it('keeps ASIN-only supplier tracker rows unresolved without an approved family target', async () => {
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
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[1]).toMatchObject({
      issueCode: 'supplier_product_unresolved',
    });
  });

  it('keeps Supplier Management identity authoritative when order rows reuse the supplier code', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Muxtex INC',
      ASIN: 'B007DOLLAR',
      SKU: 'DOLLAR-SKU',
      'FBA/FBM Stock': '10',
    });
    await seedBronze(
      db,
      {
        'SR ID': 'SRO-67',
        'Supplier Name': '7Dollar',
        ASIN: 'B007DOLLAR',
        'Reached Via': 'Muxtex INC',
      },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'MX-1',
        Timestamp: '02/01/2026',
        Company: 'Muxtex INC',
        'SR ID': 'SRO-67',
        Supplier: '7dollar order alias',
      },
      { sourceDataset: 'Purchase Orders.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'MX-1',
        Timestamp: '02/01/2026',
        Company: 'Muxtex INC',
        'SR ID': 'SRO-67',
        Supplier: '7dollar order alias',
        ASIN: 'B007DOLLAR',
        SKU: 'DOLLAR-SKU',
        Qty: '2',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toEqual([
      expect.objectContaining({ displayName: '7Dollar', normalizedName: '7dollar' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).rows).toEqual([
      expect.objectContaining({
        role: 'candidate',
        lastUsedAt: '2026-01-02T00:00:00.000Z',
      }),
    ]);
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

  it('keeps ClickUp status above later Purchase Orders status inference', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      { 'SR ID': 'SRO-CLICKUP', 'Supplier Name': 'ClickUp Supplier', 'Reached Via': 'Ecofission LLC' },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'EF-CLICKUP-1',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-CLICKUP',
        Supplier: 'ClickUp Supplier',
        'Order status': 'ORDERED',
      },
      { sourceDataset: 'Purchase Orders.csv' },
    );
    const service = new EcobaseMedallionNormalizationService(db);
    await service.normalizePending();
    const order = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: order.id as string,
      values: {
        canonicalStatus: 'shipped_inbound',
        lifecycleStatus: 'shipped_inbound',
        statusSource: 'clickup_csv',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).update({
      filterByTk: 'bronze-2',
      values: { normalizationStatus: 'pending' },
    });

    const result = await service.normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      canonicalStatus: 'shipped_inbound',
      lifecycleStatus: 'shipped_inbound',
      statusSource: 'clickup_csv',
    });
  });

  it('rejects OrderDetails suppliers that disagree with the Purchase Orders header', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      { 'SR ID': 'SRO-H', 'Supplier Name': 'Header Supply', 'Reached Via': 'Ecofission LLC' },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );
    await seedBronze(
      db,
      { 'SR ID': 'SRO-L', 'Supplier Name': 'Line Supply', 'Reached Via': 'Ecofission LLC' },
      { sourceDataset: 'Supplier Analysis Tracker.csv' },
    );
    await seedBronze(
      db,
      {
        'Order ID': 'EF2001A',
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
        'Order ID': 'EF2001A',
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

    expect(result).toMatchObject({ normalized: 3, failed: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[3]).toMatchObject({
      normalizationStatus: 'failed',
      normalizedError: expect.stringMatching(/supplier conflicts/),
    });
  });

  it('ignores OrderDetails rows whose company disagrees with the supported order prefix', async () => {
    const db = new FakeDatabase();
    await seedOrderPrerequisites(db, {
      'Order ID': 'EF-COMPANY-1',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-COMPANY',
      Supplier: 'Company Supplier',
    });
    await seedBronze(
      db,
      {
        'Order ID': 'EF-COMPANY-1',
        Company: 'Muxtex INC',
        'SR ID': 'SRO-COMPANY',
        Supplier: 'Company Supplier',
        ASIN: 'B00COMPANY',
        SKU: 'COMPANY-SKU',
        Qty: '2',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 2, ignored: 1, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[2]).toMatchObject({
      normalizationStatus: 'ignored',
    });
  });

  it('retains ASIN-only OrderDetails as unresolved without an approved family target', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Stop Shop LLC',
      ASIN: 'B00UNIQUE',
      SKU: 'UNIQUE-SKU',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '5',
    });
    await seedOrderBundle(db, {
      'Order ID': 'SS-UNIQUE-1',
      Company: 'Stop Shop LLC',
      'SR ID': 'SRO-UNIQUE',
      Supplier: 'Unique Supplier',
      ASIN: 'B00UNIQUE',
      Qty: '3',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toEqual([
      expect.objectContaining({ sourceAsin: 'B00UNIQUE', productMappingStatus: 'unresolved', orderedQty: 3 }),
    ]);
  });

  it('retains tied ASIN-only OrderDetails as unresolved without guessing a target', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Stop Shop LLC',
      ASIN: 'B00TIED',
      SKU: 'TIED-A',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '5',
    });
    await seedBronze(db, {
      Company: 'Stop Shop LLC',
      ASIN: 'B00TIED',
      SKU: 'TIED-B',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '4',
    });
    await seedOrderBundle(db, {
      'Order ID': 'SS-TIED-1',
      Company: 'Stop Shop LLC',
      'SR ID': 'SRO-TIED',
      Supplier: 'Tied Supplier',
      ASIN: 'B00TIED',
      Qty: '3',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 5, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toEqual([
      expect.objectContaining({ sourceAsin: 'B00TIED', productMappingStatus: 'unresolved', orderedQty: 3 }),
    ]);
  });

  it('deduplicates equivalent source lines and preserves non-equivalent repeated product lines', async () => {
    const db = new FakeDatabase();
    const detail = {
      'Order ID': 'EF-DUP-1',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-DUP',
      Supplier: 'Duplicate Supplier',
      ASIN: 'B00DUPLINE',
      SKU: 'DUP-SKU',
      Qty: '2',
    };
    await seedOrderPrerequisites(db, detail);
    const sourceRecordKey = 'OrderDetails.csv:EF-DUP-1:B00DUPLINE:DUP-SKU';
    await seedBronze(db, detail, { sourceDataset: 'OrderDetails.csv', sourceRecordKey, rowHash: 'hash-a' });
    await seedBronze(
      db,
      { ...detail, Qty: '3' },
      { sourceDataset: 'OrderDetails.csv', sourceRecordKey, rowHash: 'hash-b' },
    );
    await seedBronze(db, detail, { sourceDataset: 'OrderDetails.csv', sourceRecordKey, rowHash: 'hash-a' });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    const lines = db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows;
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.orderedQty).sort()).toEqual([2, 3]);
    expect(new Set(lines.map((line) => line.sourceLineKey))).toHaveProperty('size', 2);
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks)
        .rows.filter((link) => link.silverEntityType === 'silverOrderLine'),
    ).toHaveLength(3);
  });

  it('preserves same-ASIN SKU aliases as distinct order lines', async () => {
    const db = new FakeDatabase();
    const firstLine = {
      'Order ID': 'EF1002A',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-202',
      Supplier: 'Alias Supplier',
      ASIN: 'B00ALIAS',
      SKU: 'ALIAS-A',
      Qty: '2',
    };
    await seedOrderPrerequisites(db, firstLine);
    await seedBronze(db, firstLine, {
      sourceDataset: 'OrderDetails.csv',
      sourceRecordKey: 'OrderDetails.csv:EF1002A:B00ALIAS:ALIAS-A',
      rowHash: 'alias-a',
    });
    await seedBronze(
      db,
      { ...firstLine, SKU: 'ALIAS-B', Qty: '4' },
      {
        sourceDataset: 'OrderDetails.csv',
        sourceRecordKey: 'OrderDetails.csv:EF1002A:B00ALIAS:ALIAS-B',
        rowHash: 'alias-b',
      },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(0);
    const lines = db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows;
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.sourceSupplierSku).sort()).toEqual(['ALIAS-A', 'ALIAS-B']);
    expect(lines.every((line) => line.productMappingStatus === 'unresolved')).toBe(true);
    expect(lines.every((line) => line.companyProductId === undefined)).toBe(true);
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

  it('prefers row timestamp over bad generic date cells and warns on optional invoice paid dates', async () => {
    const db = new FakeDatabase();
    await seedOrderBundle(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00DATETS',
      SKU: 'DATE-TS',
      Date: '#REF!',
      Timestamp: '17/06/2023 18:15:23',
      'FBA/FBM Stock': '4',
      'SR ID': 'SRO-DATE',
      Supplier: 'Date Supplier',
      'Order ID': 'EF3001A',
      Qty: '2',
      'Invoice No': 'INV-BAD-DATE',
      'Date of Payment': '#REF!',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({ orderDate: '2023-06-17' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInvoices).rows[0]).not.toHaveProperty('paidAt');
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[2]).toMatchObject({
      issueSeverity: 'warning',
      issueCode: 'invoice_paid_date_unparsed',
    });
  });

  it('warns and omits invalid optional expected sellable dates', async () => {
    const db = new FakeDatabase();
    await seedOrderBundle(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00ETAERR',
      SKU: 'ETA-ERR',
      Timestamp: '23/10/2025',
      'SR ID': 'SRO-ETA',
      Supplier: 'ETA Supplier',
      'Order ID': 'EF4001A',
      Qty: '2',
      'ETA on Amazon': 'OOS',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      expectedArrivalStatus: 'unknown',
      expectedArrivalSource: 'insufficient_silver_evidence',
      expectedArrivalConfidence: 'none',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).not.toHaveProperty('expectedSellableDate');
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[2]).toMatchObject({
      issueSeverity: 'warning',
      issueCode: 'expected_sellable_date_unparsed',
    });
  });

  it('resolves a Sellerboard company from the Bronze source association when foreign keys are not projected', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        ASIN: 'B00SOURCECOMPANY',
        SKU: 'SOURCE-COMPANY',
        Date: '1/8/2026',
        SalesOrganic: '10',
        UnitsOrganic: '2',
      },
      {
        sourceConnectionId: undefined,
        sourceConnection: {
          id: 'source-1',
          company: { id: 'company-1', name: 'Ecofission LLC' },
        },
        sourceType: 'sellerboard',
        sourceDataset: 'sellerboard_daily_facts',
        observedAt: new Date('2026-01-08T00:00:00.000Z'),
      },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 1, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).rows).toHaveLength(1);
  });

  it('uses the requested source scope when the Bronze model hides its foreign key', async () => {
    const db = new FakeDatabase();
    db.sequelize = {
      query: async (sql, options) => {
        expect(sql).toContain('JOIN "silverCompanies"');
        expect(options).toEqual({ replacements: { sourceConnectionId: 'source-1' } });
        return [[{ name: 'Ecofission LLC' }], {}];
      },
    };
    const bronze = await seedBronze(
      db,
      {
        ASIN: 'B00SCOPEDCOMPANY',
        SKU: 'SCOPED-COMPANY',
        Date: '1/8/2026',
        SalesOrganic: '10',
        UnitsOrganic: '2',
      },
      {
        sourceType: 'sellerboard',
        sourceDataset: 'sellerboard_daily_facts',
        observedAt: new Date('2026-01-08T00:00:00.000Z'),
      },
    );
    bronze.toJSON = () => {
      const { sourceConnectionId: _, toJSON: __, ...visible } = bronze;
      return visible;
    };

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending({
      sourceConnectionId: 'source-1',
    });

    expect(result).toMatchObject({ normalized: 1, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).rows).toHaveLength(1);
  });

  it('uses adapter-normalized observedAt for Sellerboard dates', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        Company: 'Retail Heaven Inc',
        ASIN: 'B00RETAILDATE',
        SKU: 'RETAIL-DATE',
        period: '7/12/2026',
        SalesOrganic: '10',
        UnitsOrganic: '2',
      },
      {
        sourceType: 'sellerboard',
        sourceDataset: 'sellerboard_daily_facts',
        observedAt: new Date('2026-07-12T00:00:00.000Z'),
      },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).rows[0]).toMatchObject({
      snapshotDate: '2026-07-12',
    });
  });

  it('uses Date-object observedAt when source rows do not carry a date column', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        Company: 'Ecofission LLC',
        ASIN: 'B00DATEOBS',
        SKU: 'DATE-OBS',
        'FBA/FBM Stock': '3',
      },
      { observedAt: new Date('2026-07-08T00:00:00.000Z') },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows[0]).toMatchObject({
      snapshotDate: '2026-07-08',
    });
  });

  it('fails invalid source dates instead of defaulting them to today', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        Company: 'Ecofission LLC',
        ASIN: 'B00BADDATE',
        SKU: 'BAD-DATE',
        Date: '99/99/2026',
      },
      { sourceType: 'google_sheets' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('date "99/99/2026"');
  });

  it('marks mapper failures clearly without stopping the batch', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, { Company: '!!!', ASIN: 'B001', SKU: 'SKU-1' });
    await seedBronze(db, { Company: 'Ecofission LLC', ASIN: 'B002', SKU: 'SKU-2' });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(1);
    expect(result.normalized).toBe(1);
    expect(result.errors[0]).toMatch(/unrecognized company/);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[0]).toMatchObject({
      normalizationStatus: 'failed',
      issueSeverity: 'error',
      issueCode: 'normalization_failed',
      normalizedError: expect.stringMatching(/unrecognized company/),
    });
  });
});
