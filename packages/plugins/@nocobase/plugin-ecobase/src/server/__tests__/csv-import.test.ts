/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  amazonOperationsCsvAdapter,
  amazonSpApiAccessCheckAdapter,
  analyzeCsvFiles,
  createSourceAdapterRegistry,
  googleSheetsMigrationCsvAdapter,
  sellerboardApiAdapter,
  sellerboardHistoryCsvAdapter,
} from '../../features/source-import/server/adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import {
  EcobaseDatabase,
  EcobaseImportService,
  EcobaseRepository,
} from '../../features/source-import/server/import-service';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import { EcobaseSupplierOrderService } from '../../features/supplier-management/server/supplier-order-service';
import { findForbiddenSourceMaterial } from '../../features/source-import/server/source-record-projection';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
  offset?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    const filtered = this.filterRecords(params);
    const offset = params.offset ?? 0;
    return this.sortRecords(filtered, params.sort).slice(offset, offset + (params.limit ?? filtered.length));
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

  async destroy({ filter = {} }: { filter?: Record<string, unknown> }) {
    const before = this.records.length;
    this.records = this.records.filter((record) =>
      Object.entries(filter).some(([key, expected]) => {
        const lessThan =
          typeof expected === 'object' && expected !== null ? (expected as { $lt?: unknown }).$lt : undefined;
        if (lessThan !== undefined) return String(record[key] ?? '') >= String(lessThan);
        return record[key] !== expected;
      }),
    );
    return before - this.records.length;
  }

  all() {
    return this.records;
  }

  private filterRecords(params: FindParams) {
    if (params.filterByTk) {
      return this.records.filter((record) => record.id === params.filterByTk);
    }
    const filter = params.filter ?? {};
    return this.records.filter((record) =>
      Object.entries(filter).every(([key, expected]) => {
        if (typeof expected === 'object' && expected !== null && Array.isArray((expected as { $in?: unknown[] }).$in)) {
          return (expected as { $in: unknown[] }).$in.includes(record[key]);
        }
        return record[key] === expected;
      }),
    );
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
  readonly sequelize = {
    query: async () => [],
    transaction: async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        | ((transaction: Record<string, never>) => Promise<unknown>)
        | undefined;
      if (!callback) throw new Error('MemoryDatabase transaction requires a callback.');
      return callback({});
    },
  };

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

const masterStockCsv = `Company,ASIN,SKU,Title,"ROI, %",FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier SKU
Ecofission LLC,B00PUSNY5A,W101,Lesson Plan,27,386,1681.3,9.79,40,0,13,0,500,Amazon.com,60,15,SUP-W101
Ecofission LLC,B00Q4UK3Q6,Excello,Planner,31,245,1100,1.1,71,100,54,0,120,Amazon.com,60,10,SUP-EX`;

const buyboxCsv = `Company,ASIN,Title,Sessions - Total,Page Views - Total,Featured Offer (Buy Box) Percentage,Units Ordered,Ordered Product Sales,Unit Session Percentage
Ecofission LLC,B0H2FFL218,Elan Publishing Company 7 Period,83,141,84.87%,11,$128.36,13.25%`;

const sameSupplierDifferentCompanyCsv = `Company,ASIN,SKU,Title,"ROI, %",FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier,SR ID
Ecofission LLC,B00PUSNY5A,W101,Lesson Plan,27,386,1681.3,9.79,40,0,13,0,500,Amazon.com,60,15,Shared Supplier,SRO-1
Other Company,B00PUSNY5A,W102,Lesson Plan Other,27,100,500,3,40,0,0,0,0,Amazon.com,60,40,Shared Supplier,SRO-1`;

const orderDetailsDetailedCsv = `Order ID,Timestamp,Company,SR ID,Supplier,Brand ,ASIN,SKU,Qty,PPU,Order type,Lead time(day),T.Profit,PO Status,AM Status
OD-OLD,17/06/2023 18:15:23,Ecofission LLC,SRO-A,Alpha Supply,Brand Legacy,B0057XUD02,V-651-A,50,0.95,New,10,190,,Cleared
OD-NEW,10/07/2023 08:00:00,Ecofission LLC,SRO-B,Beta Supply,Brand Fresh,B0057XUD02,V-651-A,60,1.25,New,12,240,Added to PO,Cleared`;

const purchaseOrdersDetailedCsv = `Timestamp,Order ID,SR ID ,Supplier,Company,Order Status,Payment Status,Approval Status,Expected Delivery
16/07/2025 07:30:00,PO-200,SRO-B,Beta Supply,Ecofission LLC,Completed,Completed,Approved,2025-07-24`;
const supplierAnalysisTrackerCsv =
  'Timestamp,SR ID,Supplier Name,ASIN,Wholesale Price List,Product Catalog,MAP agreement,Market,SR by,PR Portal Link,Username,pass,Contact Person,Reached Via,Recieved Email,Remarks,MOQ,Designation,Category,Amazon Allow,SA By,Status,Active Status,Easy Move(Sister Company ),Bulk Upload,Date of Update,Total NOP,TNOP Analysed,Prof. Products,Inv. margin >0.00%,Inv.margin>4.99%,Inv.margin>8.99%,Cleared POs Amount,Sheet Link,Remarks SA,Used ,Tasks Submitted\n9/21/2023 20:14:39,SRO-7036,locnproducts,B08838XBQN,https://price-list.test,https://catalog.test,https://map.test,USA,Nabeel Uddin,https://portal.test,source@example.com,secret,Danielle Townes,Ecofission LLC,locnproducts1@gmail.com,Initial note,$200,Sales Rep,Home,Yes,Analyst,Completed,Yes,Yes,Yes,5/20/2026,10,8,3,4,5,6,1200,https://sheet.test,SA note,Yes,Submitted';

async function seedLockedCorrectedCatalogForMappedOrderProjection(db: MemoryDatabase) {
  const products = db.getRepository(ECOBASE_COLLECTIONS.silverProducts);
  const companyProducts = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts);
  const families = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies);
  const existingCompanyProducts = companyProducts.all();
  if (existingCompanyProducts.length !== 2) {
    throw new Error(
      `Mapped-order projection fixture expected 2 existing listings; found ${existingCompanyProducts.length}.`,
    );
  }

  await db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).create({
    values: {
      id: 'account-muxtex',
      companyId: 'company-muxtex',
      marketplace: 'Amazon.com',
    },
  });
  const sourceConnection = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()[0];
  Object.assign(sourceConnection, {
    companyId: 'company-muxtex',
    amazonAccountId: 'account-muxtex',
    marketplace: 'Amazon.com',
  });
  existingCompanyProducts.forEach((row) =>
    Object.assign(row, {
      amazonAccountId: 'account-muxtex',
      companyProductFamilyId: 'family-mapped-order',
      lifecycleStatus: 'active',
    }),
  );
  await families.create({
    values: {
      id: 'family-mapped-order',
      companyId: 'company-muxtex',
      amazonAccountId: 'account-muxtex',
      marketplace: 'Amazon.com',
      canonicalAsin: 'B00D3QAK4Y',
      replenishmentTargetCompanyProductId: 'company-product-old',
      targetSelectionEvidenceJson: { source: 'csv_import_test' },
    },
  });

  let listingCount = existingCompanyProducts.length;
  for (let familyIndex = 1; familyIndex < 1919; familyIndex += 1) {
    const familyId = `family-filler-${String(familyIndex).padStart(4, '0')}`;
    const asin = `FILLER-ASIN-${String(familyIndex).padStart(4, '0')}`;
    const memberCount = familyIndex <= 443 ? 2 : 1;
    const memberIds: string[] = [];
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      const suffix = String(listingCount).padStart(4, '0');
      const productId = `product-filler-${suffix}`;
      const companyProductId = `company-product-filler-${suffix}`;
      memberIds.push(companyProductId);
      await products.create({
        values: { id: productId, asin, sku: `FILLER-SKU-${suffix}`, title: `Filler ${suffix}` },
      });
      await companyProducts.create({
        values: {
          id: companyProductId,
          companyId: 'company-muxtex',
          amazonAccountId: 'account-muxtex',
          productId,
          companyProductFamilyId: familyId,
          lifecycleStatus: 'active',
        },
      });
      listingCount += 1;
    }
    await families.create({
      values: {
        id: familyId,
        companyId: 'company-muxtex',
        amazonAccountId: 'account-muxtex',
        marketplace: 'Amazon.com',
        canonicalAsin: asin,
        replenishmentTargetCompanyProductId: memberIds[0],
        targetSelectionEvidenceJson: { source: 'csv_import_test_filler' },
      },
    });
  }
  if (listingCount !== 2363 || families.all().length !== 1919) {
    throw new Error(
      `Mapped-order projection fixture cardinality drifted: ${listingCount} listings and ${
        families.all().length
      } families.`,
    );
  }
  await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
    values: {
      id: 'inventory-mapped-order',
      companyProductId: 'company-product-old',
      sourceConnectionId: 'source-1',
      snapshotDate: '2026-06-16',
      sellableStock: 0,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      awdStock: 0,
    },
  });
}

function createService(sourceType = 'seller_central_file', domain = 'amazon_operations') {
  const db = new MemoryDatabase();
  db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: {
      id: 'source-1',
      name: 'Amazon operations source',
      sourceType,
      domain,
      config: {},
      active: true,
    },
  });
  const service = new EcobaseImportService(
    db,
    createSourceAdapterRegistry([
      amazonOperationsCsvAdapter,
      googleSheetsMigrationCsvAdapter,
      sellerboardApiAdapter,
      sellerboardHistoryCsvAdapter,
      amazonSpApiAccessCheckAdapter,
    ]),
  );
  return { db, service };
}

describe('Ecobase bronze import write path', () => {
  it('imports the Supplier IDs master through the supplier-management path', async () => {
    const items: unknown[] = [];
    for await (const item of googleSheetsMigrationCsvAdapter.import({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'supplier-master',
      sourceVersion: '2026-07-18',
      idempotencyKey: 'supplier-master:2026-07-18',
      config: {
        files: [{ name: 'Supplier IDs.csv', content: 'SR ID,Supplier Name\nSRO-36,3Dmatsusa' }],
      },
    })) {
      items.push(item);
    }

    expect(items).toEqual([
      expect.objectContaining({
        type: 'record',
        record: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({ supplierId: 'SRO-36', name: '3Dmatsusa' }),
          }),
        ]),
      }),
    ]);
  });

  it('rejects order CSVs from the generic adapter path', async () => {
    const items = [] as Array<{ type: string; issue?: { code?: string } }>;
    for await (const item of googleSheetsMigrationCsvAdapter.import({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'legacy-order-route',
      sourceVersion: '2026-07-16',
      idempotencyKey: 'legacy-order-route:2026-07-16',
      config: {
        files: [
          {
            name: 'Purchase Orders.csv',
            content:
              'Timestamp,Order ID,SR ID,Company,PO approval,Order status,Payment Status\n16/07/2026,EF71626A,SRO-36,Ecofission LLC,Approved,Completed,Paid',
          },
        ],
      },
    })) {
      items.push(item);
    }

    expect(items).toEqual([
      expect.objectContaining({
        type: 'rowIssue',
        issue: expect.objectContaining({ code: 'canonical_supplier_order_import_required' }),
      }),
    ]);
  });

  it('writes legacy inline CSV files into Bronze without creating Amazon identity', async () => {
    const { db, service } = createService('google_sheets', 'amazon_operations');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Ecofission LLC',
          files: [{ name: 'MasterStock.csv', content: masterStockCsv, expectedRowCount: 2 }],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'bronze-master-stock',
      sourceVersion: '2026-06-22',
      preserveAuditRun: true,
    });

    const bronzeFiles = db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceFiles).all();
    const bronzeRecords = db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all();

    expect(bronzeFiles).toHaveLength(1);
    expect(bronzeFiles[0]).toMatchObject({
      sourceConnectionId: 'source-1',
      fileName: 'MasterStock.csv',
    });
    expect(bronzeFiles[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bronzeRecords).toHaveLength(2);
    expect(bronzeRecords[0]).toMatchObject({
      sourceConnectionId: 'source-1',
      sourceType: 'google_sheets',
      sourceDataset: 'amazon_listing_inventory',
      normalizationStatus: 'normalized',
    });
    expect(bronzeRecords[0].rowHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bronzeRecords[0].retentionUntil).toBe('2026-07-22T00:00:00.000Z');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).all().length).toBeGreaterThan(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all()).toHaveLength(0);
    expect(run.summary).toMatchObject({ goldRefreshRequired: true, familyReconciliation: null });
  });

  it('rejects out-of-scope rows before Bronze and records the migration decision summary', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'MasterStock.csv', content: sameSupplierDifferentCompanyCsv, expectedRowCount: 2 }],
        },
      },
    });

    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        id: 'expired-bronze',
        retentionUntil: '2026-08-01T00:00:00.000Z',
        payload: { company: 'Ecofission LLC' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        id: 'current-bronze',
        retentionUntil: '2026-09-01T00:00:00.000Z',
        payload: { company: 'Ecofission LLC' },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'safe-boundary-company-scope',
      sourceVersion: '2026-07-13T00:00:00.000Z',
      startedAt: new Date('2026-08-13T00:00:00.000Z'),
      preserveAuditRun: true,
    });

    const bronzeRecords = db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all();
    expect(bronzeRecords).toHaveLength(2);
    expect(bronzeRecords.map((row) => row.id)).toContain('current-bronze');
    expect(bronzeRecords.map((row) => row.id)).not.toContain('expired-bronze');
    const importedBronze = bronzeRecords.find((row) => row.id !== 'current-bronze');
    expect(importedBronze).toMatchObject({
      sourceDataset: 'amazon_listing_inventory',
      payload: expect.objectContaining({ company: 'Ecofission LLC', asin: 'B00PUSNY5A', listingSku: 'W101' }),
      retentionUntil: '2026-08-12T00:00:00.000Z',
    });
    expect(JSON.stringify(importedBronze)).not.toContain('Other Company');
    expect(findForbiddenSourceMaterial(bronzeRecords)).toEqual([]);
    expect(run.summary).toMatchObject({
      migration: {
        profileVersion: '2026-07-13.1',
        acceptedCount: 1,
        discardedCount: 1,
        reviewCount: 0,
        reasons: { canonical_company: 1, company_out_of_scope: 1 },
      },
    });
  });

  it('keeps invalid source rows in bronze instead of rejecting the whole import', async () => {
    const { db, service } = createService('google_sheets', 'amazon_operations');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Ecofission LLC',
          files: [{ name: 'Unknown.csv', content: 'Unknown Header\nvalue', expectedRowCount: 1 }],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'bronze-unknown',
      sourceVersion: '2026-06-22',
      preserveAuditRun: true,
    });
    const bronzeRecords = db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all();

    expect(run.status).toBe('failed');
    expect(bronzeRecords).toHaveLength(1);
    expect(bronzeRecords[0]).toMatchObject({
      sourceDataset: 'source_issue',
      sourceRecordKey: 'Unknown.csv',
      normalizationStatus: 'failed',
      payload: { fileName: 'Unknown.csv', headerCount: 1 },
    });
  });

  it('does not duplicate identical bronze rows for audit re-runs', async () => {
    const { db, service } = createService('google_sheets', 'amazon_operations');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Ecofission LLC',
          files: [{ name: 'MasterStock.csv', content: masterStockCsv, expectedRowCount: 2 }],
        },
      },
    });

    for (const index of [1, 2]) {
      await service.runAdapterImport({
        sourceConnectionId: 'source-1',
        adapterName: 'google-sheets-migration-csv',
        sourceIdentifier: `bronze-master-stock-${index}`,
        sourceVersion: '2026-06-22',
        preserveAuditRun: true,
      });
    }

    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toHaveLength(2);
  });
});

describe('Ecobase current Amazon operations CSV import', () => {
  it('reconciles existing unmapped supplier-order lines idempotently', async () => {
    const { db } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-muxtex', name: 'Muxtex INC', companyKey: 'muxtex' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-old', asin: 'B00D3QAK4Y', sku: '2801054915' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-new', asin: 'B00D3QAK4Y', sku: '2801054915-NEW' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-old', companyId: 'company-muxtex', productId: 'product-old' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-new', companyId: 'company-muxtex', productId: 'product-new' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-franklin', normalizedName: 'franklin electric', displayName: 'Franklin Electric' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-mx61726d',
        companyId: 'company-muxtex',
        supplierId: 'supplier-franklin',
        orderRef: 'MX61726D',
        canonicalStatus: 'shipped_inbound',
        orderDate: '2026-06-16',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-mx61726d',
        orderId: 'order-mx61726d',
        sourceLineKey: 'sha256:4be51bf382b54b2b',
        sourceAsin: 'B00D3QAK4Y',
        sourceSupplierSku: '2801054915',
        orderedQty: 7,
        confirmedQty: 0,
        productMappingStatus: 'unresolved',
        productAnalysisStatus: 'mapping_missing',
      },
    });

    let transactionCount = 0;
    (db as MemoryDatabase & {
      sequelize: { transaction: (run: (transaction: object) => Promise<unknown>) => unknown };
    }).sequelize = {
      transaction: async (run) => {
        transactionCount += 1;
        return run({ id: `transaction-${transactionCount}` });
      },
    };
    const service = new EcobaseSupplierOrderService(db);
    await expect(service.reconcileAfterImport('repair-run')).resolves.toMatchObject({
      repaired: 1,
      ambiguous: 0,
      resolutionCounts: { byMethod: { exact: 1 }, byReason: {} },
    });
    await expect(service.reconcileAfterImport('repair-run-repeat')).resolves.toMatchObject({
      repaired: 0,
      ambiguous: 0,
    });
    expect(
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).findOne({ filterByTk: 'line-mx61726d' }),
    ).toMatchObject({
      companyProductId: 'company-product-old',
      supplierProductId: expect.any(String),
      productMappingStatus: 'resolved',
      productAnalysisStatus: 'reconciliation_resolved',
      productMappingEvidenceJson: {
        method: 'exact',
        sourceAsin: 'B00D3QAK4Y',
        sourceSupplierSku: '2801054915',
        supplierId: 'supplier-franklin',
        importRunId: 'repair-run',
      },
    });
    expect(transactionCount).toBe(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).all()).toEqual([
      expect.objectContaining({
        supplierId: 'supplier-franklin',
        productId: 'product-old',
        supplierSku: '2801054915',
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).all()).toHaveLength(1);

    Object.assign(await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).findOne({ filterByTk: 'order-mx61726d' }), {
      lifecycleStatus: 'shipped_inbound',
      operationalStatus: 'shipped_inbound',
      workflowStage: 'inbound',
    });
    await seedLockedCorrectedCatalogForMappedOrderProjection(db);
    const inventory = new EcobaseInventoryPlanningService(db);
    await inventory.refreshReadModel({ calculationDate: '2026-06-16' });
    const projected = db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .all()
      .find((row) => row.companyProductId === 'company-product-old');

    expect(projected).toMatchObject({
      companyProductId: 'company-product-old',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderRef: 'MX61726D',
      supplierOrderOpenQty: 7,
      existingOrderFollowUp: true,
      newReplenishmentActionable: false,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyProductId: 'company-product-old',
          supplierOrderRef: 'MX61726D',
          supplierOrderOpenQty: 7,
        }),
      ]),
    );
  });

  it('resolves a reviewed supplier-SKU alias from first-class source fields without creating a product', async () => {
    const { db } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-stop-shop', name: 'Stop Shop LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-etc', asin: 'B0177E9JPS', sku: 'ETC-120A' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-etc', companyId: 'company-stop-shop', productId: 'product-etc' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-etc', displayName: 'ETC supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: {
        id: 'supplier-product-etc-existing',
        supplierId: 'supplier-etc',
        productId: 'product-etc',
        supplierSku: 'ETC-CATALOG-OFFER',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-etc',
        companyId: 'company-stop-shop',
        supplierId: 'supplier-etc',
        orderRef: 'SS42826A',
        orderDate: '2026-06-16',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-etc',
        orderId: 'order-etc',
        sourceLineKey: 'sha256:etc-line',
        sourceAsin: 'B0177E9JPS',
        sourceSupplierSku: 'ETC120A',
        orderedQty: 1,
        productMappingStatus: 'unresolved',
      },
    });

    await expect(new EcobaseSupplierOrderService(db).reconcileAfterImport('repair-etc')).resolves.toMatchObject({
      repaired: 1,
      resolutionCounts: { byMethod: { reviewed_alias: 1 }, byReason: {} },
    });
    await expect(
      db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).findOne({ filterByTk: 'line-etc' }),
    ).resolves.toMatchObject({
      companyProductId: 'company-product-etc',
      supplierProductId: 'supplier-product-etc-existing',
      sourceSupplierSku: 'ETC120A',
      productMappingStatus: 'resolved',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).all()).toEqual([
      expect.objectContaining({ asin: 'B0177E9JPS', sku: 'ETC-120A' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).all()).toEqual([
      expect.objectContaining({
        supplierId: 'supplier-etc',
        productId: 'product-etc',
        supplierSku: 'ETC-CATALOG-OFFER',
      }),
    ]);
  });

  it('returns named reasons for multi-account ambiguity and missing current catalog', async () => {
    const { db } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-ambiguous', name: 'Ambiguous Inc' },
    });
    for (const account of [
      { id: 'account-one', marketplace: 'amazon.com' },
      { id: 'account-two', marketplace: 'amazon.ca' },
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).create({
        values: { ...account, companyId: 'company-ambiguous' },
      });
    }
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-ambiguous', asin: 'B00AMBIGUOUS', sku: 'AMAZON-SKU' },
    });
    for (const accountId of ['account-one', 'account-two']) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
        values: {
          id: `company-product-${accountId}`,
          companyId: 'company-ambiguous',
          amazonAccountId: accountId,
          productId: 'product-ambiguous',
        },
      });
    }
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-ambiguous', displayName: 'Ambiguous supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-ambiguous',
        companyId: 'company-ambiguous',
        supplierId: 'supplier-ambiguous',
        orderRef: 'AM1001A',
        orderDate: '2026-06-16',
      },
    });
    for (const line of [
      { id: 'line-ambiguous', sourceAsin: 'B00AMBIGUOUS', sourceSupplierSku: 'SUPPLIER-SKU' },
      { id: 'line-missing-catalog', sourceAsin: 'B00MISSING', sourceSupplierSku: 'MISSING-SKU' },
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
        values: {
          ...line,
          orderId: 'order-ambiguous',
          sourceLineKey: `sha256:${line.id}`,
          orderedQty: 1,
          productMappingStatus: 'unresolved',
        },
      });
    }

    await expect(new EcobaseSupplierOrderService(db).reconcileAfterImport('repair-unresolved')).resolves.toMatchObject({
      repaired: 0,
      ambiguous: 1,
      missing: 1,
      skipped: 0,
      resolutionCounts: {
        byMethod: {},
        byReason: { boundary_ambiguous: 1, product_not_found: 1 },
      },
    });
  });

  it('analyzes mixed CSV bundles before import', () => {
    const analysis = analyzeCsvFiles([
      { name: 'OrderDetails.csv', content: orderDetailsDetailedCsv },
      { name: 'Purchase Orders.csv', content: purchaseOrdersDetailedCsv },
      { name: 'Supplier IDs.csv', content: 'SR ID,Supplier Name\nSRO-36,3Dmatsusa' },
      {
        name: 'Supplier 2026.csv',
        content: 'SR ID,Supplier Name,Supplier Type\nSRO-36,3Dmatsusa,Brand Approved',
      },
      {
        name: 'Order Management Clickup Data.csv',
        content:
          'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name\n' +
          'task-1,https://app.clickup.com/t/task-1,New Order – SS7226A–Stop Shop Inc – USA – My Weigh,,approved-to-order,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
      },
      { name: 'Buybox.csv', content: buyboxCsv },
      { name: 'Unknown.csv', content: 'Not,A,Known,Shape\n1,2,3,4' },
    ]);

    expect(analysis.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'OrderDetails.csv',
          detectedShape: 'order-details',
          adapterName: 'supplier-order-csv',
          sourceType: 'google_sheets',
          domain: 'order_management',
          importable: true,
        }),
        expect.objectContaining({
          name: 'Purchase Orders.csv',
          detectedShape: 'purchase-orders',
          adapterName: 'supplier-order-csv',
          sourceType: 'google_sheets',
          domain: 'order_management',
          importable: true,
        }),
        expect.objectContaining({
          name: 'Supplier IDs.csv',
          detectedShape: 'supplier-ids',
          adapterName: 'google-sheets-migration-csv',
          sourceType: 'google_sheets',
          domain: 'supplier_management',
          importable: true,
        }),
        expect.objectContaining({
          name: 'Supplier 2026.csv',
          detectedShape: 'supplier-analysis-2026',
          adapterName: 'google-sheets-migration-csv',
          sourceType: 'google_sheets',
          domain: 'supplier_management',
          importable: true,
        }),
        expect.objectContaining({
          name: 'Order Management Clickup Data.csv',
          detectedShape: 'clickup-order-status',
          adapterName: 'clickup-order-status-csv',
          sourceType: 'clickup',
          domain: 'order_management',
          importable: true,
        }),
        expect.objectContaining({
          name: 'Buybox.csv',
          detectedShape: 'buybox',
          adapterName: 'amazon-operations-csv',
          sourceType: 'seller_central_file',
          domain: 'amazon_operations',
          importable: true,
        }),
        expect.objectContaining({
          name: 'Unknown.csv',
          detectedShape: 'unknown',
          adapterName: null,
          sourceType: null,
          domain: null,
          importable: false,
        }),
      ]),
    );
    expect(analysis.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapterName: 'supplier-order-csv',
          sourceType: 'google_sheets',
          domain: 'order_management',
          files: ['OrderDetails.csv', 'Purchase Orders.csv'],
        }),
        expect.objectContaining({
          adapterName: 'google-sheets-migration-csv',
          sourceType: 'google_sheets',
          domain: 'supplier_management',
          files: ['Supplier IDs.csv', 'Supplier 2026.csv'],
        }),
        expect.objectContaining({
          adapterName: 'clickup-order-status-csv',
          sourceType: 'clickup',
          domain: 'order_management',
          files: ['Order Management Clickup Data.csv'],
        }),
        expect.objectContaining({
          adapterName: 'amazon-operations-csv',
          sourceType: 'seller_central_file',
          domain: 'amazon_operations',
          files: ['Buybox.csv'],
        }),
      ]),
    );
  });

  it('analyzes semicolon Sellerboard history files for the history adapter', () => {
    const analysis = analyzeCsvFiles([
      {
        name: 'Fissionem_Dashboard_by_product_01_01_2026-03_07_2026.csv',
        content:
          '\uFEFFDate;Marketplace;ASIN;SKU;Name;SalesOrganic;SalesPPC;UnitsOrganic;UnitsPPC;NetProfit\n02/01/2026;Amazon.com;B007P55HOW;DC50944;Dampp Chaser;63.40;10.10;3;2;35',
      },
    ]);

    expect(analysis.files).toEqual([
      expect.objectContaining({
        detectedShape: 'sellerboard-history-dashboard-goods',
        adapterName: 'sellerboard-history-csv',
        sourceType: 'sellerboard',
        domain: 'amazon_operations',
        rowCount: 1,
        importable: true,
      }),
    ]);
  });

  it('analyzes semicolon Sellerboard COGS files for the COGS importer', () => {
    const analysis = analyzeCsvFiles([
      {
        name: 'Fissionem_Cost_of_Goods_Sold_(2026_07_04_04_50_18_570).csv',
        content:
          '\uFEFFASIN;"SKU";"Title";"CostPeriodStartDate";"Cost";"Marketplace"\nB00PUSNY5A;"W101";"Lesson plan";"28/02/2026";"4.3";"Amazon.com"',
      },
    ]);

    expect(analysis.files).toEqual([
      expect.objectContaining({
        detectedShape: 'sellerboard-cogs',
        adapterName: 'sellerboard-cogs-csv',
        sourceType: 'sellerboard',
        domain: 'amazon_operations',
        rowCount: 1,
        importable: true,
      }),
    ]);
    expect(analysis.groups).toEqual([
      expect.objectContaining({
        adapterName: 'sellerboard-cogs-csv',
        sourceType: 'sellerboard',
        domain: 'amazon_operations',
        files: ['Fissionem_Cost_of_Goods_Sold_(2026_07_04_04_50_18_570).csv'],
      }),
    ]);
  });

  it('imports one-time semicolon Sellerboard history rows with strict day-first dates', async () => {
    const { db, service } = createService('sellerboard');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Ecofission LLC',
          files: [
            {
              name: 'Fissionem_Dashboard_by_product_01_01_2026-03_07_2026.csv',
              content:
                '\uFEFFDate;Marketplace;ASIN;SKU;Name;SalesOrganic;SalesPPC;SalesSponsoredProducts;SalesSponsoredDisplay;UnitsOrganic;UnitsPPC;UnitsSponsoredProducts;UnitsSponsoredDisplay;Refunds;GrossProfit;NetProfit;Sessions;Unit Session Percentage\n02/01/2026;Amazon.com;B007P55HOW;DC50944;Dampp Chaser;63.40;10.10;5.50;1.00;3;2;1;1;0;20.1;35;30;10%',
            },
          ],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'sellerboard-history-csv',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({
      status: 'success',
      rowCount: 1,
      normalizedCount: 1,
      warningCount: 0,
      summary: { familyReconciliation: null },
    });
    const imported: any[] = [];
    for await (const item of sellerboardHistoryCsvAdapter.import({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-05',
      idempotencyKey: 'day-first-date-check',
      config: db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()[0].config as Record<string, unknown>,
    })) {
      imported.push(item);
    }
    expect(imported[0]).toMatchObject({
      type: 'record',
      record: {
        data: {
          company: 'Ecofission LLC',
          snapshotDate: '2026-01-02',
          asin: 'B007P55HOW',
          sku: 'DC50944',
          sales: 80,
          units: 7,
          netProfit: 35,
          margin: 43.75,
          profitPerUnit: 5,
        },
      },
    });
  });

  it('imports one-time semicolon Sellerboard history rows with month-first dates', async () => {
    const { db, service } = createService('sellerboard');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Retail Heaven Inc',
          files: [
            {
              name: 'Retail_Heaven_Inc_Dashboard_by_product_01_01_2026-03_07_2026.csv',
              content:
                'Date;Marketplace;ASIN;SKU;Name;SalesOrganic;UnitsOrganic;NetProfit\n1/2/2026;Amazon.com;B007P55HOW;DC50944;Dampp Chaser;10;2;8\n4/18/2026;Amazon.com;B007P55HOW;DC50944;Dampp Chaser;20;4;12',
            },
          ],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'sellerboard-history-csv',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 0 });
    const imported: any[] = [];
    for await (const item of sellerboardHistoryCsvAdapter.import({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-05',
      idempotencyKey: 'month-first-date-check',
      config: db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()[0].config as Record<string, unknown>,
    })) {
      imported.push(item);
    }
    expect(imported).toEqual([
      expect.objectContaining({
        type: 'record',
        record: expect.objectContaining({ data: expect.objectContaining({ snapshotDate: '2026-01-02' }) }),
      }),
      expect.objectContaining({
        type: 'record',
        record: expect.objectContaining({ data: expect.objectContaining({ snapshotDate: '2026-04-18' }) }),
      }),
    ]);
  });

  it('keeps the current partial month and six complete prior Sellerboard months only', async () => {
    const imported: any[] = [];
    for await (const item of sellerboardHistoryCsvAdapter.import({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-13T00:00:00.000Z',
      idempotencyKey: 'history-window-check',
      config: {
        defaultCompany: 'Ecofission LLC',
        files: [
          {
            name: 'Fissionem_Dashboard_by_product.csv',
            content: [
              'Date;Marketplace;ASIN;SKU;SalesOrganic;UnitsOrganic',
              '31/12/2025;Amazon.com;B000000001;SKU-1;1;1',
              '01/01/2026;Amazon.com;B000000001;SKU-1;2;2',
              '13/07/2026;Amazon.com;B000000001;SKU-1;3;3',
            ].join('\n'),
          },
        ],
      },
    })) {
      imported.push(item);
    }

    expect(imported).toHaveLength(2);
    expect(imported.map((item) => item.record.data.snapshotDate)).toEqual(['2026-01-01', '2026-07-13']);
  });

  it('rejects Sellerboard history dates after the import source version', async () => {
    const { db, service } = createService('sellerboard');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Retail Heaven Inc',
          files: [
            {
              name: 'Retail_Heaven_Inc_Dashboard_by_product_01_01_2026-03_07_2026.csv',
              content:
                'Date;Marketplace;ASIN;SKU;Name;SalesOrganic;UnitsOrganic;NetProfit\n4/18/2026;Amazon.com;B007P55HOW;DC50944;Dampp Chaser;10;2;8\n8/1/2026;Amazon.com;B007P55HOW;DC50944;Dampp Chaser;20;4;12',
            },
          ],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'sellerboard-history-csv',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'partial', rowCount: 2, normalizedCount: 1, errorCount: 1 });
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords)
        .all()
        .find((record) => record.rowNumber === 2),
    ).toMatchObject({ observedAt: '2026-04-18' });
    const imported: any[] = [];
    for await (const item of sellerboardHistoryCsvAdapter.import({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-05',
      idempotencyKey: 'future-date-check',
      config: db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()[0].config as Record<string, unknown>,
    })) {
      imported.push(item);
    }
    expect(imported).toEqual([
      expect.objectContaining({
        type: 'record',
        record: expect.objectContaining({ data: expect.objectContaining({ snapshotDate: '2026-04-18' }) }),
      }),
      expect.objectContaining({
        type: 'rowIssue',
        issue: expect.objectContaining({ code: 'sellerboard_history_date_future' }),
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ issueCode: 'sellerboard_history_date_future', normalizationStatus: 'failed' }),
      ]),
    );
  });

  it('rejects non-slash dates in Sellerboard history files', async () => {
    const { db, service } = createService('sellerboard');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Ecofission LLC',
          files: [
            {
              name: 'Fissionem_Dashboard_by_product_01_01_2026-03_07_2026.csv',
              content:
                'Date;Marketplace;ASIN;SKU;Name;SalesOrganic;UnitsOrganic;NetProfit\n2026-01-02;Amazon.com;B007P55HOW;DC50944;Dampp Chaser;63.40;3;15',
            },
          ],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'sellerboard-history-csv',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: '2026-07-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'failed', errorCount: 1, normalizedCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([
      expect.objectContaining({ issueCode: 'sellerboard_history_date_invalid', normalizationStatus: 'failed' }),
    ]);
  });

  it('imports CSV bundles without storing uploaded content in source connection config and skips unchanged re-uploads', async () => {
    const { db, service } = createService();
    const sourceConnection = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()[0];
    expect(sourceConnection.config).toEqual({});

    const first = await service.runCsvBundleImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'manual-buybox-bundle',
      sourceVersion: '2025-07-01',
      files: [{ name: 'Buybox.csv', content: buyboxCsv }],
    });
    const second = await service.runCsvBundleImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'manual-buybox-bundle',
      sourceVersion: '2025-07-01',
      files: [{ name: 'Buybox.csv', content: buyboxCsv }],
    });

    expect(first).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 1, warningCount: 0 });
    expect(first.summary.goldRefreshRequired).toBe(true);
    expect(second).toMatchObject({ status: 'skipped', rowCount: 0, normalizedCount: 0, warningCount: 1 });
    expect(sourceConnection.config).toEqual({});
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()[0].summary).toMatchObject({
      csvBundle: {
        files: [expect.objectContaining({ name: 'Buybox.csv', detectedShape: 'buybox', changed: true })],
      },
    });
  });

  it('imports only changed files from CSV bundle re-uploads', async () => {
    const { db, service } = createService();
    const changedBuyboxCsv = `${buyboxCsv}\nEcofission LLC,B0CHANGED,Changed Product,10,11,55%,2,$20.00,20%`;
    await service.runCsvBundleImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'manual-buybox-bundle',
      sourceVersion: '2025-07-01',
      files: [{ name: 'Buybox.csv', content: buyboxCsv }],
    });
    const changed = await service.runCsvBundleImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'manual-buybox-bundle',
      sourceVersion: '2025-07-02',
      files: [{ name: 'Buybox.csv', content: changedBuyboxCsv }],
    });

    expect(changed).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toHaveLength(2);
  });

  it('rejects CSV bundle adapter mismatches before writing import rows', async () => {
    const { db, service } = createService('google_sheets', 'order_management');
    await expect(
      service.runCsvBundleImport({
        sourceConnectionId: 'source-1',
        adapterName: 'google-sheets-migration-csv',
        sourceIdentifier: 'manual-mismatch-bundle',
        sourceVersion: '2025-07-01',
        files: [{ name: 'Buybox.csv', content: buyboxCsv }],
      }),
    ).rejects.toThrow('files do not match adapter "google-sheets-migration-csv"');
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(0);
  });

  it('preserves distinct import-run audit trails while normalized records are idempotently updated', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'Buybox.csv', content: buyboxCsv, expectedRowCount: 1, snapshotDate: '2025-07-01' }],
        },
      },
    });

    const first = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'buybox-sample',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });
    const second = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'buybox-sample',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(first.id).not.toBe(second.id);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toHaveLength(1);
  });

  it('writes skipped daily snapshot runs when there is no newer source version', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'Buybox.csv', content: buyboxCsv, expectedRowCount: 1, snapshotDate: '2025-07-01' }],
        },
      },
    });

    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'daily-buybox',
      sourceVersion: '2025-07-01',
    });
    const skipped = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'daily-buybox',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
      skipIfNoNewerData: true,
    });

    expect(skipped).toMatchObject({ status: 'skipped', rowCount: 0, normalizedCount: 0, warningCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(2);
  });

  it('isolates a failed Sellerboard report URL while a sibling report unit commits', async () => {
    const { db, service } = createService('sellerboard');
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          catalogMutationMode: 'rebuild',
          defaultCompany: 'Ecofission LLC',
          schedule: {
            enabled: true,
            dailyRefreshTime: '00:00',
            refreshIntervalMinutes: 1440,
            retryIntervalMinutes: 60,
          },
          reportUrls: [
            {
              name: 'Profit Dashboard Data',
              category: 'profit_dashboard',
              url: 'https://sellerboard.test/profit-dashboard.csv',
            },
            { name: 'Stock Daily Data', category: 'stock_daily', url: 'https://sellerboard.test/stock.csv' },
          ],
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('profit-dashboard')) {
          return new Response('', { status: 401 });
        }
        return new Response('ASIN,SKU,FBA/FBM Stock,"ROI, %"\nB000TEST,S-1,12,45', { status: 200 });
      }),
    );

    const results = await service.runScheduledSellerboardImports({ now: '2026-06-08T00:05:00.000Z' });

    expect(results.results).toEqual([
      expect.objectContaining({ reportKind: 'profit_dashboard', status: 'failed' }),
      expect.objectContaining({ reportKind: 'stock_daily', status: 'success' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([
      expect.objectContaining({ status: 'failed', rowCount: 0, normalizedCount: 0, errorCount: 1 }),
      expect.objectContaining({ status: 'success', rowCount: 1, normalizedCount: 3, errorCount: 0 }),
    ]);
  });

  it('records Sellerboard and Amazon SP-API live-source credential blockers', async () => {
    const sellerboard = createService('sellerboard');
    const sellerboardRun = await sellerboard.service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-live-check',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(sellerboardRun).toMatchObject({ status: 'blocked', normalizedCount: 1 });
    expect(sellerboard.db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits).all()).toEqual([
      expect.objectContaining({ status: 'blocked', blockerCode: 'sellerboard_credentials_missing' }),
    ]);

    const amazonSpApi = createService('amazon_sp_api');
    const amazonRun = await amazonSpApi.service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-sp-api-access-check',
      sourceIdentifier: 'sp-api-access-check',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(amazonRun).toMatchObject({ status: 'success', normalizedCount: 1 });
    expect(amazonSpApi.db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits).all()).toEqual([
      expect.objectContaining({ status: 'blocked', blockerCode: 'amazon_sp_api_access_missing' }),
    ]);
  });
});
