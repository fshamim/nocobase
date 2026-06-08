import { describe, expect, it, vi } from 'vitest';
import {
  amazonOperationsCsvAdapter,
  amazonSpApiAccessCheckAdapter,
  createSourceAdapterRegistry,
  googleSheetsMigrationCsvAdapter,
  sellerboardApiAdapter,
} from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseDatabase, EcobaseImportService, EcobaseRepository } from '../services/import-service';
import { EcobasePlanningCalculationService } from '../services/planning-calculation-service';
import { EcobaseInventoryPlanningService } from '../services/inventory-planning-service';
import { EcobaseSupplierOrderService } from '../services/supplier-order-service';

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

const masterStockCsv = `Company,ASIN,SKU,Title,"ROI, %",FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier SKU
Ecofission LLC,B00PUSNY5A,W101,Lesson Plan,27,386,1681.3,9.79,40,0,13,0,500,Amazon.com,60,15,SUP-W101
Ecofission LLC,B00Q4UK3Q6,Excello,Planner,31,245,1100,1.1,71,100,54,0,120,Amazon.com,60,10,SUP-EX`;

const buyboxCsv = `Company,ASIN,Title,Sessions - Total,Page Views - Total,Featured Offer (Buy Box) Percentage,Units Ordered,Ordered Product Sales,Unit Session Percentage
Ecofission LLC,B0H2FFL218,Elan Publishing Company 7 Period,83,141,84.87%,11,$128.36,13.25%`;

const malformedProfitPlanningCsv = `Company,ASIN,SKU,Supplier,Exp Sales Vel,Current Stock,Month,COGS,Rec.Best Qty,Rec.Best Profit
Ecofission LLC,B00Q4UK3Q6,Excello,ELAN Publishing Company,1.1,245,November/2025,4.23,100,120
Ecofission LLC,,,Missing Identity,1.0,10,November/2025,2.00,1,2`;

const supplierIdsCsv = `Company,SR ID,Supplier Name
Ecofission LLC,SRO-36,3Dmatsusa`;

const sameSupplierDifferentCompanyCsv = `Company,ASIN,SKU,Title,"ROI, %",FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier,SR ID
Ecofission LLC,B00PUSNY5A,W101,Lesson Plan,27,386,1681.3,9.79,40,0,13,0,500,Amazon.com,60,15,Shared Supplier,SRO-1
Other Company,B00PUSNY5A,W102,Lesson Plan Other,27,100,500,3,40,0,0,0,0,Amazon.com,60,40,Shared Supplier,SRO-1`;

const supplierOrderMasterStockCsv = `Company,ASIN,SKU,Title,"ROI, %",FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier,SR ID
Ecofission LLC,B0057XUD02,V-651-A,Valve Part,27,386,1681.3,9.79,40,0,13,0,500,Amazon.com,60,15,Alpha Supply,SRO-A`;

const supplierIdsDetailedCsv = `Company,SR ID,Supplier Name
Ecofission LLC,SRO-A,Alpha Supply
Ecofission LLC,SRO-B,Beta Supply`;

const globalSupplierIdsCsv = `SR ID,Supplier Name
SRO-ESS,Essence Supplier`;

const duplicateSupplierIdsCsv = `SR ID,Supplier Name
Duplicate,harkersonline
Duplicate,kiki-health
SRO-12801,New england quilt supply`;

const orderDetailsWithSupplierCodeOnlyCsv = `Order ID,Timestamp,Company,SR ID,Supplier,Brand ,ASIN,SKU,Qty,PPU,Order type,Lead time(day),T.Profit
OD-CODE,17/06/2023 18:15:23,Ecofission LLC,SRO-ESS,,Essence,B00ESSENCE,ESS-1,50,2.50,Restock,,100
OD-UNKNOWN,18/06/2023 18:15:23,Ecofission LLC,SRO-MISSING,,Unknown,B00UNKNOWN,UNK-1,10,1.00,Restock,,20`;

const orderDetailsDetailedCsv = `Order ID,Timestamp,Company,SR ID,Supplier,Brand ,ASIN,SKU,Qty,PPU,Order type,Lead time(day),T.Profit
OD-OLD,17/06/2023 18:15:23,Ecofission LLC,SRO-A,Alpha Supply,Brand Legacy,B0057XUD02,V-651-A,50,0.95,New,10,190
OD-NEW,10/07/2023 08:00:00,Ecofission LLC,SRO-B,Beta Supply,Brand Fresh,B0057XUD02,V-651-A,60,1.25,New,12,240`;

const preOrderSheetDetailedCsv = `Order ID,Timestamp,Company,SR ID,Supplier,Brand,ASIN,SKU,Qty,Expected Sellable Date
PO-200,15/07/2025 09:15:00,Ecofission LLC,SRO-B,Beta Supply,Brand Fresh,B0057XUD02,V-651-A,120,2025-07-22`;

const preOrderSheetWithoutSellableCsv = `Order ID,Timestamp,Company,SR ID,Supplier,Brand,ASIN,SKU,Qty,Expected Sellable Date
PO-200,15/07/2025 09:15:00,Ecofission LLC,SRO-B,Beta Supply,Brand Fresh,B0057XUD02,V-651-A,120,`;

const purchaseOrdersDetailedCsv = `Timestamp,Order ID,SR ID ,Supplier,Company,Payment Status,Approval Status,Expected Delivery
16/07/2025 07:30:00,PO-200,SRO-B,Beta Supply,Ecofission LLC,Paid,Approved,2025-07-24`;

const remainingShapeSamples = [
  {
    name: "Top SKU'S.csv",
    content:
      'Tier,Company,ASIN ,SKU,Supplier ,Brand,Title,COGS,Profit Per Unit,SKU Multiple Listings\nA,Ecofission LLC,B0006SDOFO,Olfa-RM,New england quilt supply,OLFA,Cutter,33.4,7.0,N',
    expectedCollection: ECOBASE_COLLECTIONS.rawListings,
  },
  {
    name: 'Profit Tracker.csv',
    content:
      'Current Week,Month,Company,ASIN,SKU,Brand,Supplier,Unit Target ,Refund Units,Profit Target,Profit Achieved,FBA,Rerv.,Inbound,Ordered,Current Stock,Days of Stock Left,Est. Sales Velocity,% Refund,BB %\n1,May 2026,Ecofission LLC,B0006SDOFO,Olfa-RM,OLFA,New england quilt supply,120,1,840,226.19,10,1,2,3,16,20,0.5,2%,90%',
    expectedCollection: ECOBASE_COLLECTIONS.listingDailyFacts,
  },
  {
    name: 'Fissionem_DashboardGoods.csv',
    content:
      'Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,Refunds,GrossProfit,NetProfit,Sessions,Unit Session Percentage\n30/04/2026,Amazon.com,B007P55HOW,DC50944 New,Dampp Chaser,63.40,3,0,20.1,15.2,30,10%',
    expectedCollection: ECOBASE_COLLECTIONS.listingDailyFacts,
  },
  {
    name: 'Fissionem_DashboardTotals.csv',
    content:
      'Date,SalesOrganic,UnitsOrganic,Orders,Refunds,NetProfit,Sessions,Unit Session Percentage\n30/04/2026,1673.73,40,45,2,500,300,13%',
    expectedCollection: ECOBASE_COLLECTIONS.listingDailyFacts,
  },
  {
    name: 'Fissionem_Stock.csv',
    content:
      'ASIN,SKU,Title,"ROI, %",FBA/FBM Stock,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Marketplace,Target stock range after new order days,Manuf. time days,Supplier SKU\nB00PUSNY5A,W101,Lesson Plan,26,376,9.89,39,0,Amazon.com,60,15,SUP-W101',
    expectedCollection: ECOBASE_COLLECTIONS.inventorySnapshots,
  },
  {
    name: 'OrderDetails.csv',
    content:
      'Order ID,Timestamp,Company,SR ID,Supplier,Brand ,ASIN,SKU,Qty,PPU,Order type,Lead time(day),T.Profit\nOD-1,17/06/2023 18:15:23,Ecofission LLC,SRO-1,Supplier,Sloan Valve,B0057XUD02,V-651-A,200,0.95,New,10,190',
    expectedCollection: ECOBASE_COLLECTIONS.supplierOrders,
    sourceType: 'google_sheets',
    domain: 'order_management',
    adapterName: 'google-sheets-migration-csv',
  },
  {
    name: 'Purchase Orders.csv',
    content:
      'Timestamp,Order ID,SR ID ,Supplier,Company,Exp. Cost ,Payment Status ,Total units\n17/06/2023 03:46:51,OD-1,SRO-1,Supplier,Ecofission LLC,190,Paid,200',
    expectedCollection: ECOBASE_COLLECTIONS.supplierOrders,
    sourceType: 'google_sheets',
    domain: 'order_management',
    adapterName: 'google-sheets-migration-csv',
  },
  {
    name: 'Pre-Order Sheet.csv',
    content:
      'Order ID,Timestamp,Company,SR ID,Supplier,Brand,ASIN,SKU,Qty,ETA on Amazon\nPO-1,17/06/2023 03:46:51,Ecofission LLC,SRO-1,Supplier,Sloan Valve,B0057XUD02,V-651-A,200,2023-06-30',
    expectedCollection: ECOBASE_COLLECTIONS.supplierOrders,
    sourceType: 'google_sheets',
    domain: 'order_management',
    adapterName: 'google-sheets-migration-csv',
  },
];

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
      amazonSpApiAccessCheckAdapter,
    ]),
  );
  return { db, service };
}

async function seedSupplierOrderSlice() {
  const { db, service } = createService('google_sheets', 'order_management');
  const sourceConnectionRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);

  sourceConnectionRepo.update({
    filterByTk: 'source-1',
    values: {
      config: {
        defaultCompany: 'Ecofission LLC',
        files: [
          {
            name: 'MasterStock.csv',
            content: supplierOrderMasterStockCsv,
            expectedRowCount: 1,
            snapshotDate: '2025-07-01',
          },
        ],
      },
    },
  });
  await service.runAdapterImport({
    sourceConnectionId: 'source-1',
    adapterName: 'google-sheets-migration-csv',
    sourceIdentifier: 'supplier-order-master-stock',
    sourceVersion: '2025-07-01',
    preserveAuditRun: true,
  });

  sourceConnectionRepo.update({
    filterByTk: 'source-1',
    values: {
      config: {
        defaultCompany: 'Ecofission LLC',
        files: [{ name: 'Supplier IDs.csv', content: supplierIdsDetailedCsv, expectedRowCount: 2 }],
      },
    },
  });
  const supplierRun = await service.runAdapterImport({
    sourceConnectionId: 'source-1',
    adapterName: 'google-sheets-migration-csv',
    sourceIdentifier: 'supplier-ids-detailed',
    sourceVersion: '2025-07-02',
    preserveAuditRun: true,
  });

  const planningProduct = db
    .getRepository(ECOBASE_COLLECTIONS.planningProducts)
    .all()
    .find((record) => record.canonicalAsin === 'B0057XUD02');
  if (!planningProduct?.id) {
    throw new Error('Expected seeded planning product for supplier-order slice.');
  }

  const suppliers = db.getRepository(ECOBASE_COLLECTIONS.suppliers).all();
  const supplierA = suppliers.find((record) => record.name === 'Alpha Supply');
  const supplierB = suppliers.find((record) => record.name === 'Beta Supply');
  if (!supplierA?.id || !supplierB?.id) {
    throw new Error('Expected supplier identities to seed Alpha Supply and Beta Supply.');
  }

  await db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).create({
    values: {
      naturalKey: `supplier-product-link:Ecofission LLC:${planningProduct.id}:${supplierA.id}:preferred:manual`,
      company: 'Ecofission LLC',
      planningProductId: planningProduct.id,
      supplierId: supplierA.id,
      role: 'preferred',
      source: 'manual',
      confidence: 'high',
      orderCount: 0,
      active: true,
      evidence: { reason: 'operator preference' },
      payload: { reason: 'operator preference' },
      lastImportRunId: 'manual',
    },
  });

  sourceConnectionRepo.update({
    filterByTk: 'source-1',
    values: {
      config: {
        defaultCompany: 'Ecofission LLC',
        files: [
          { name: 'OrderDetails.csv', content: orderDetailsDetailedCsv, expectedRowCount: 2 },
          { name: 'Pre-Order Sheet.csv', content: preOrderSheetDetailedCsv, expectedRowCount: 1 },
          { name: 'Purchase Orders.csv', content: purchaseOrdersDetailedCsv, expectedRowCount: 1 },
        ],
      },
    },
  });
  const orderRun = await service.runAdapterImport({
    sourceConnectionId: 'source-1',
    adapterName: 'google-sheets-migration-csv',
    sourceIdentifier: 'supplier-orders-detailed',
    sourceVersion: '2025-07-20',
    preserveAuditRun: true,
  });

  const purchaseOrder = db
    .getRepository(ECOBASE_COLLECTIONS.supplierOrders)
    .all()
    .find((record) => record.externalOrderRef === 'PO-200');
  if (!purchaseOrder?.id) {
    throw new Error('Expected purchase order PO-200 in supplier-order slice.');
  }

  return {
    db,
    service,
    supplierRun,
    orderRun,
    planningProductId: String(planningProduct.id),
    supplierA,
    supplierB,
    purchaseOrder,
  };
}

describe('Ecobase current Amazon operations CSV import', () => {
  it('imports MasterStock raw rows, verifies row count, and creates listing, inventory, and planning records', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [
            { name: 'MasterStock.csv', content: masterStockCsv, expectedRowCount: 2, snapshotDate: '2025-07-01' },
          ],
        },
      },
    });
    const importedRun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'master-stock-sample',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(importedRun).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 6, warningCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawListings).all()).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).all()).toEqual([
      expect.objectContaining({ asin: 'B00PUSNY5A', sku: 'W101', stock: 386, daysOfStockLeft: 40 }),
      expect.objectContaining({ asin: 'B00Q4UK3Q6', sku: 'Excello', stock: 245, daysOfStockLeft: 71 }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningParameters).all()).toHaveLength(2);
  });

  it('keeps supplier lead times distinct for the same supplier key in different companies', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [
            {
              name: 'MasterStock.csv',
              content: sameSupplierDifferentCompanyCsv,
              expectedRowCount: 2,
              snapshotDate: '2025-07-01',
            },
          ],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'same-supplier-different-company',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 10 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).all()).toEqual([
      expect.objectContaining({ company: 'Ecofission LLC', supplierId: 'SRO-1', leadTimeDays: 15 }),
      expect.objectContaining({ company: 'Other Company', supplierId: 'SRO-1', leadTimeDays: 40 }),
    ]);
  });

  it('uses MasterStock Lead Time as product-specific supplier lead time ahead of manufacturing days', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [
            {
              name: 'MasterStock.csv',
              content:
                'Company,ASIN,SKU,Title,"ROI, %",FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier,Lead Time\n' +
                'Ecofission LLC,B00PUSNY5A,W101,Lesson Plan,27,386,1681.3,9.79,40,0,13,0,500,Amazon.com,60,15,Lead Supplier,25',
              expectedRowCount: 1,
              snapshotDate: '2025-07-01',
            },
          ],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'masterstock-lead-time',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningParameters).all()).toEqual([
      expect.objectContaining({ asin: 'B00PUSNY5A', sku: 'W101', supplier: 'Lead Supplier', leadTimeDays: 25 }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).all()).toEqual([
      expect.objectContaining({
        company: 'Ecofission LLC',
        supplierName: 'Lead Supplier',
        asin: 'B00PUSNY5A',
        sku: 'W101',
        scope: 'product',
        leadTimeDays: 25,
      }),
    ]);
  });

  it('links planning inputs imported after raw listings so calculations use separate planning-source runs', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [
            { name: 'MasterStock.csv', content: masterStockCsv, expectedRowCount: 2, snapshotDate: '2025-07-01' },
          ],
        },
      },
    });
    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'master-stock-before-planning',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [
            {
              name: 'Profit Planning.csv',
              content: malformedProfitPlanningCsv,
              expectedRowCount: 2,
              snapshotDate: '2025-11-01',
            },
          ],
        },
      },
    });
    const planningRun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'profit-planning-after-master-stock',
      sourceVersion: '2025-11-01',
      preserveAuditRun: true,
    });

    expect(planningRun).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 3, warningCount: 1 });
    const excelloParameter = db
      .getRepository(ECOBASE_COLLECTIONS.planningParameters)
      .all()
      .find(
        (record) =>
          record.asin === 'B00Q4UK3Q6' && record.sku === 'Excello' && record.lastImportRunId === planningRun.id,
      );
    const excelloTarget = db
      .getRepository(ECOBASE_COLLECTIONS.targetRows)
      .all()
      .find((record) => record.asin === 'B00Q4UK3Q6' && record.sku === 'Excello');
    expect(excelloParameter).toEqual(expect.objectContaining({ planningProductId: expect.any(String) }));
    expect(excelloTarget).toEqual(
      expect.objectContaining({ planningProductId: expect.any(String), profitTarget: 120 }),
    );

    const result = await new EcobasePlanningCalculationService(db).calculatePlanningProduct({
      planningProductId: String(excelloParameter?.planningProductId),
      calculationDate: '2025-11-10',
      persist: false,
    });
    expect(result).toMatchObject({
      proratedProfitTargetMtd: expect.any(Number),
      dataCompleteness: expect.stringContaining('profitPerUnit'),
    });
  });

  it('maps Buybox into traffic snapshots through the same adapter seam', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'Buybox.csv', content: buyboxCsv, expectedRowCount: 1, snapshotDate: '2025-07-01' }],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'buybox-sample',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).all()).toEqual([
      expect.objectContaining({ asin: 'B0H2FFL218', sessions: 83, pageViews: 141, buyBoxPercentage: 84.87 }),
    ]);
  });

  it('rejects public filePaths without reading arbitrary server files', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: { config: { filePaths: ['/etc/passwd'] } },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'unsafe-file-paths',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'failed', rowCount: 0, normalizedCount: 0, errorCount: 1 });
    expect(run.errorMessage).toBeNull();
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([
      expect.objectContaining({
        normalizedStatus: 'failed',
        issueCode: 'csv_files_missing',
        payload: {},
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawListings).all()).toEqual([]);
  });

  it('does not echo unknown-shape headers in warning payloads', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: { config: { files: [{ name: 'unknown.csv', content: 'secret-token-value\n123' }] } },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'unknown-shape',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'failed', rowCount: 0, normalizedCount: 0, errorCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([
      expect.objectContaining({
        issueCode: 'csv_shape_unknown',
        payload: { fileName: 'unknown.csv', headerCount: 1 },
      }),
    ]);
  });

  it('recognizes the remaining required CSV shapes and Google Sheets order-management exports', async () => {
    for (const sample of remainingShapeSamples) {
      const { db, service } = createService(sample.sourceType, sample.domain);
      db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
        filterByTk: 'source-1',
        values: {
          config: {
            files: [{ name: sample.name, content: sample.content, expectedRowCount: 1, snapshotDate: '2025-07-01' }],
          },
        },
      });

      const run = await service.runAdapterImport({
        sourceConnectionId: 'source-1',
        adapterName: sample.adapterName ?? 'amazon-operations-csv',
        sourceIdentifier: sample.name,
        sourceVersion: '2025-07-01',
        preserveAuditRun: true,
      });

      expect(run, sample.name).toMatchObject({
        status: 'success',
        rowCount: 1,
        warningCount: ['OrderDetails.csv', 'Pre-Order Sheet.csv'].includes(sample.name) ? 1 : 0,
      });
      expect(db.getRepository(sample.expectedCollection).all(), sample.name).toHaveLength(1);
      if (sample.name === 'OrderDetails.csv') {
        expect(db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).all(), sample.name).toEqual([]);
      }
      expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all(), sample.name).toHaveLength(1);
    }
  });

  it('normalizes supplier-order sheets into supplier identities, history links, and coverage read models', async () => {
    const { db, service, supplierRun, orderRun, planningProductId, supplierA, supplierB, purchaseOrder } =
      await seedSupplierOrderSlice();

    expect(supplierRun).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 0 });
    expect(orderRun).toMatchObject({ status: 'success', rowCount: 4, normalizedCount: 4, warningCount: 0 });

    const supplierSummary = (
      supplierRun.summary as { files: Record<string, { sampleMappedRecord?: Record<string, unknown> }> }
    ).files;
    expect(supplierSummary['Supplier IDs.csv']).toMatchObject({
      rowCount: 2,
      sampleMappedRecord: expect.objectContaining({ kind: 'supplier_identity', company: 'Ecofission LLC' }),
    });

    const orderSummary = (
      orderRun.summary as { files: Record<string, { sampleMappedRecord?: Record<string, unknown> }> }
    ).files;
    expect(orderSummary['OrderDetails.csv']).toMatchObject({
      rowCount: 2,
      sampleMappedRecord: expect.objectContaining({ kind: 'supplier_order', sourceStage: 'order_detail' }),
    });
    expect(orderSummary['Pre-Order Sheet.csv']).toMatchObject({
      rowCount: 1,
      sampleMappedRecord: expect.objectContaining({ kind: 'supplier_order', sourceStage: 'pre_order' }),
    });
    expect(orderSummary['Purchase Orders.csv']).toMatchObject({
      rowCount: 1,
      sampleMappedRecord: expect.objectContaining({ kind: 'supplier_order', sourceStage: 'purchase_order' }),
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierExternalIdentities).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          company: 'Ecofission LLC',
          externalSupplierCode: 'SRO-A',
          externalSupplierName: 'Alpha Supply',
          sourceSystem: 'supplier_ids',
        }),
        expect.objectContaining({
          company: 'Ecofission LLC',
          externalSupplierCode: 'SRO-B',
          externalSupplierName: 'Beta Supply',
          sourceSystem: 'supplier_ids',
        }),
      ]),
    );

    expect(purchaseOrder).toMatchObject({
      status: 'paid',
      sourceStage: 'purchase_order',
      company: 'Ecofission LLC',
    });
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrders)
        .all()
        .filter((record) => record.sourceStage === 'order_detail'),
    ).toHaveLength(2);

    const productLinks = db
      .getRepository(ECOBASE_COLLECTIONS.supplierProductLinks)
      .all()
      .filter((record) => record.planningProductId === planningProductId && record.active !== false);
    expect(productLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'preferred', supplierId: supplierA.id, source: 'manual' }),
        expect.objectContaining({ role: 'candidate', supplierId: supplierA.id, source: 'order_details' }),
        expect.objectContaining({ role: 'latest_history', supplierId: supplierB.id, latestBrand: 'Brand Fresh' }),
        expect.objectContaining({ role: 'discovered', supplierId: supplierB.id, source: 'order_details' }),
      ]),
    );

    const supplierOrderService = new EcobaseSupplierOrderService(db);
    await supplierOrderService.recordActivity({
      company: 'Ecofission LLC',
      supplierId: String(supplierB.id),
      supplierOrderId: String(purchaseOrder.id),
      activityType: 'contacted_supplier',
      occurredAt: '2025-07-18T10:00:00.000Z',
      notes: 'Confirmed ship window',
    });

    const coverage = await supplierOrderService.getCoverage(planningProductId, '2025-07-25');
    expect(coverage).toMatchObject({
      coverageState: 'arrives_before_stockout',
      totalOpenQty: 120,
      usableOpenQtyBeforeOos: 120,
      lateOpenQty: 0,
      blockedOpenQty: 0,
      incompleteOpenQty: 0,
      nextExpectedSellableDate: '2025-07-22',
      blockedOpenOrder: false,
      unreliableCoverage: false,
    });
    expect(coverage.contactRecency).toMatchObject({
      source: 'order',
      occurredAt: '2025-07-18T10:00:00.000Z',
    });
    expect(coverage.linkedSupplierOrderIds).toContain(String(purchaseOrder.id));
    expect(coverage.linkedSupplierOrderLineIds).toHaveLength(1);
    expect(await supplierOrderService.getPrepBufferDays('Ecofission LLC')).toBe(0);

    const countsBeforeRerun = {
      identities: db.getRepository(ECOBASE_COLLECTIONS.supplierExternalIdentities).all().length,
      orders: db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).all().length,
      lines: db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).all().length,
      links: db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).all().length,
    };
    const rerun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'supplier-orders-detailed',
      sourceVersion: '2025-07-20',
      preserveAuditRun: true,
    });
    expect(rerun).toMatchObject({ status: 'success', rowCount: 4, normalizedCount: 4, warningCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierExternalIdentities).all()).toHaveLength(
      countsBeforeRerun.identities,
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).all()).toHaveLength(countsBeforeRerun.orders);
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).all()).toHaveLength(countsBeforeRerun.lines);
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).all()).toHaveLength(countsBeforeRerun.links);

    const purchaseOrderLine = db
      .getRepository(ECOBASE_COLLECTIONS.supplierOrderLines)
      .all()
      .find((record) => record.supplierOrderId === purchaseOrder.id);
    const sourceLineImportRunId = purchaseOrderLine?.lastImportRunId;
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Ecofission LLC',
          files: [{ name: 'Supplier IDs.csv', content: supplierIdsDetailedCsv, expectedRowCount: 2 }],
        },
      },
    });
    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'supplier-ids-only-after-orders',
      sourceVersion: '2025-07-21',
      preserveAuditRun: true,
    });
    const lineAfterSupplierOnlyImport = db
      .getRepository(ECOBASE_COLLECTIONS.supplierOrderLines)
      .all()
      .find((record) => record.id === purchaseOrderLine?.id);
    expect(lineAfterSupplierOnlyImport?.lastImportRunId).toBe(sourceLineImportRunId);
  });

  it('imports Supplier IDs rows with duplicate placeholder codes without aborting the source', async () => {
    const { db, service } = createService('google_sheets', 'order_management');
    const sourceConnectionRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);

    sourceConnectionRepo.update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'Supplier IDs.csv', content: duplicateSupplierIdsCsv, expectedRowCount: 3 }],
        },
      },
    });

    const supplierRun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'supplier-ids-with-duplicate-placeholders',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(supplierRun).toMatchObject({ status: 'success', rowCount: 3, normalizedCount: 3, warningCount: 0 });
    const suppliers = db.getRepository(ECOBASE_COLLECTIONS.suppliers).all();
    expect(suppliers.find((record) => record.name === 'harkersonline')).toMatchObject({ supplierId: undefined });
    expect(suppliers.find((record) => record.name === 'kiki-health')).toMatchObject({ supplierId: undefined });
    expect(suppliers.find((record) => record.name === 'New england quilt supply')).toMatchObject({ supplierId: 'SRO-12801' });
  });

  it('links order-details supplier codes through Supplier IDs and leaves unknown supplier lead time missing', async () => {
    const { db, service } = createService('google_sheets', 'order_management');
    const sourceConnectionRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);

    sourceConnectionRepo.update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'Supplier IDs.csv', content: globalSupplierIdsCsv, expectedRowCount: 1 }],
        },
      },
    });
    const supplierRun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'global-supplier-ids',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });
    expect(supplierRun).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 1, warningCount: 0 });

    sourceConnectionRepo.update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'OrderDetails.csv', content: orderDetailsWithSupplierCodeOnlyCsv, expectedRowCount: 2 }],
        },
      },
    });
    const orderRun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'order-details-code-only',
      sourceVersion: '2025-07-02',
      preserveAuditRun: true,
    });
    expect(orderRun).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 3 });

    const suppliers = db.getRepository(ECOBASE_COLLECTIONS.suppliers).all();
    const globalSupplier = suppliers.find((record) => record.supplierId === 'SRO-ESS' && record.company === '__global__');
    const linkedSupplier = suppliers.find((record) => record.supplierId === 'SRO-ESS' && record.company === 'Ecofission LLC');
    const unknownSupplier = suppliers.find((record) => record.supplierId === 'SRO-MISSING' && record.company === 'Ecofission LLC');
    expect(globalSupplier).toMatchObject({ name: 'Essence Supplier' });
    expect(linkedSupplier).toMatchObject({ name: 'Essence Supplier' });
    expect(unknownSupplier).toBeUndefined();
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).all()).toHaveLength(0);
  });

  it('preserves operator-owned supplier-order fields across re-imports and keeps blocked open quantity semantics', async () => {
    const { db, service, planningProductId, purchaseOrder } = await seedSupplierOrderSlice();
    const orderRepo = db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const lineRepo = db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const supplierOrderService = new EcobaseSupplierOrderService(db);
    const purchaseOrderLine = lineRepo.all().find((record) => record.supplierOrderId === purchaseOrder.id);
    if (!purchaseOrderLine?.id) {
      throw new Error('Expected pre-order line linked to purchase order PO-200.');
    }

    await supplierOrderService.updateOrderOperatorFields({
      supplierOrderId: String(purchaseOrder.id),
      company: 'Ecofission LLC',
      status: 'blocked',
      actor: 'operator-1',
    });
    await supplierOrderService.updateLineOperatorFields({
      supplierOrderLineId: String(purchaseOrderLine.id),
      company: 'Ecofission LLC',
      receivedQty: 10,
      expectedSellableDate: '2025-07-30',
      actor: 'operator-1',
    });

    const rerun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'supplier-orders-detailed',
      sourceVersion: '2025-07-20',
      preserveAuditRun: true,
    });
    expect(rerun).toMatchObject({ status: 'success', rowCount: 4, normalizedCount: 4, warningCount: 0 });

    const reloadedOrder = orderRepo.all().find((record) => record.id === purchaseOrder.id);
    const reloadedLine = lineRepo.all().find((record) => record.id === purchaseOrderLine.id);
    expect(reloadedOrder).toMatchObject({
      status: 'blocked',
      statusSource: 'manual',
      lastOperatorActor: 'operator-1',
    });
    expect(reloadedOrder?.lastOperatorEditAt).toBeTruthy();
    expect(reloadedLine).toMatchObject({
      receivedQty: 10,
      receivedQtySource: 'manual',
      expectedSellableDate: '2025-07-30',
      expectedSellableDateSource: 'manual',
      lastOperatorActor: 'operator-1',
    });
    expect(reloadedLine?.lastOperatorEditAt).toBeTruthy();

    const coverage = await supplierOrderService.getCoverage(planningProductId, '2025-07-25');
    expect(coverage).toMatchObject({
      coverageState: 'blocked_open_order',
      totalOpenQty: 110,
      usableOpenQtyBeforeOos: 0,
      lateOpenQty: 0,
      blockedOpenQty: 110,
      incompleteOpenQty: 0,
      blockedOpenOrder: true,
      unreliableCoverage: true,
    });
  });

  it('keeps draft/contacted orders out of coverage and treats supplier-confirmed orders as weak evidence', async () => {
    const { db, planningProductId, purchaseOrder } = await seedSupplierOrderSlice();
    const supplierOrderService = new EcobaseSupplierOrderService(db);

    await supplierOrderService.updateOrderOperatorFields({
      supplierOrderId: String(purchaseOrder.id),
      company: 'Ecofission LLC',
      status: 'supplier_confirmed',
      actor: 'operator-1',
    });
    let coverage = await supplierOrderService.getCoverage(planningProductId, '2025-07-25');
    expect(coverage).toMatchObject({
      coverageState: 'incomplete_or_stale',
      totalOpenQty: 120,
      usableOpenQtyBeforeOos: 0,
      incompleteOpenQty: 120,
      unreliableCoverage: true,
      dataWarnings: ['weak_order_status'],
    });

    await supplierOrderService.updateOrderOperatorFields({
      supplierOrderId: String(purchaseOrder.id),
      company: 'Ecofission LLC',
      status: 'draft',
      actor: 'operator-1',
    });
    coverage = await supplierOrderService.getCoverage(planningProductId, '2025-07-25');
    expect(coverage).toMatchObject({
      coverageState: 'no_open_order',
      totalOpenQty: 0,
      usableOpenQtyBeforeOos: 0,
    });

    const inventoryRows = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2025-07-20',
      leadTimeFreshnessDays: 60,
      orderSoonWindowDays: 14,
      limit: 10,
    });
    expect(inventoryRows.find((row) => row.planningProductId === planningProductId)?.openOrderCoverageQty).toBe(0);

    await supplierOrderService.updateOrderOperatorFields({
      supplierOrderId: String(purchaseOrder.id),
      company: 'Ecofission LLC',
      status: 'paid',
      actor: 'operator-1',
    });
    const paidRows = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2025-07-20',
      leadTimeFreshnessDays: 60,
      orderSoonWindowDays: 14,
      limit: 10,
    });
    expect(paidRows.find((row) => row.planningProductId === planningProductId)?.openOrderCoverageQty).toBe(120);
  });

  it('uses product-specific supplier lead time before supplier default lead time in the operator workspace', async () => {
    const { db, planningProductId, supplierA } = await seedSupplierOrderSlice();
    const supplierOrderService = new EcobaseSupplierOrderService(db);

    await supplierOrderService.updateSupplierLeadTime({
      company: 'Ecofission LLC',
      supplierId: String(supplierA.id),
      leadTimeDays: 21,
      confirmedAt: '2025-07-19T00:00:00.000Z',
      notes: 'Default supplier lead time.',
      actor: 'operator-1',
    });
    await supplierOrderService.updateSupplierLeadTime({
      company: 'Ecofission LLC',
      supplierId: String(supplierA.id),
      planningProductId,
      leadTimeDays: 35,
      confirmedAt: '2025-07-20T00:00:00.000Z',
      notes: 'Product-specific lead time.',
      actor: 'operator-1',
    });

    const workspace = await supplierOrderService.getWorkspace({ company: 'Ecofission LLC', limit: 10 });
    const candidate = workspace.reorderCandidates.find((row) => row.planningProductId === planningProductId);
    expect(candidate).toMatchObject({
      preferredSupplierId: supplierA.id,
      leadTimeDays: 35,
      leadTimeConfirmedAt: '2025-07-20T00:00:00.000Z',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ supplierRefId: supplierA.id, scope: 'default', leadTimeDays: 21 }),
        expect.objectContaining({ supplierRefId: supplierA.id, scope: 'product', planningProductId, leadTimeDays: 35 }),
      ]),
    );
  });

  it('preserves imported expected-sellable precedence when a later import only has delivery-date evidence', async () => {
    const { db, service, purchaseOrder } = await seedSupplierOrderSlice();
    const lineRepo = db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const sourceConnectionRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const purchaseOrderLine = lineRepo.all().find((record) => record.supplierOrderId === purchaseOrder.id);
    expect(purchaseOrderLine).toMatchObject({
      expectedSellableDate: '2025-07-22',
      expectedSellableDateSource: 'imported_expected_sellable_date',
    });

    sourceConnectionRepo.update({
      filterByTk: 'source-1',
      values: {
        config: {
          defaultCompany: 'Ecofission LLC',
          files: [
            { name: 'Pre-Order Sheet.csv', content: preOrderSheetWithoutSellableCsv, expectedRowCount: 1 },
            { name: 'Purchase Orders.csv', content: purchaseOrdersDetailedCsv, expectedRowCount: 1 },
          ],
        },
      },
    });
    const rerun = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'supplier-orders-without-arrival-date',
      sourceVersion: '2025-07-21',
      preserveAuditRun: true,
    });
    expect(rerun).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 0 });

    const reloadedLine = lineRepo.all().find((record) => record.id === purchaseOrderLine?.id);
    expect(reloadedLine).toMatchObject({
      expectedSellableDate: '2025-07-22',
      expectedSellableDateSource: 'imported_expected_sellable_date',
    });
  });

  it('reports ambiguous listing-level planning-product mappings explicitly', async () => {
    const { db } = await seedSupplierOrderSlice();
    const planningProductRepo = db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const listingRepo = db.getRepository(ECOBASE_COLLECTIONS.planningProductListings);
    await planningProductRepo.create({
      values: {
        id: 'planning-product-ambiguous-1',
        naturalKey: 'planning-product:Ecofission LLC:B0AMBIG1',
        company: 'Ecofission LLC',
        canonicalAsin: 'B0AMBIG1',
      },
    });
    await planningProductRepo.create({
      values: {
        id: 'planning-product-ambiguous-2',
        naturalKey: 'planning-product:Ecofission LLC:B0AMBIG2',
        company: 'Ecofission LLC',
        canonicalAsin: 'B0AMBIG2',
      },
    });
    await listingRepo.create({
      values: {
        naturalKey: 'planning-product-listing:Ecofission LLC:B0AMBIG1:AMBIG-SKU',
        company: 'Ecofission LLC',
        planningProductId: 'planning-product-ambiguous-1',
        canonicalAsin: 'B0AMBIG1',
        asin: 'B0AMBIG1',
        sku: 'AMBIG-SKU',
      },
    });
    await listingRepo.create({
      values: {
        naturalKey: 'planning-product-listing:Ecofission LLC:B0AMBIG2:AMBIG-SKU',
        company: 'Ecofission LLC',
        planningProductId: 'planning-product-ambiguous-2',
        canonicalAsin: 'B0AMBIG2',
        asin: 'B0AMBIG2',
        sku: 'AMBIG-SKU',
      },
    });

    const result = await new EcobaseSupplierOrderService(db).applyImportRecord(
      {
        kind: 'supplier_order',
        data: {
          company: 'Ecofission LLC',
          supplierName: 'Beta Supply',
          externalSupplierCode: 'SRO-B',
          sourceSystem: 'test',
          sourceConnectionId: 'source-1',
          externalOrderRef: 'AMBIG-PO-1',
          sourceStage: 'purchase_order',
          status: 'supplier_confirmed',
          lines: [{ sourceOrderLineRef: 'AMBIG-PO-1:1', sku: 'AMBIG-SKU', orderedQty: 10 }],
        },
      },
      'import-run-ambiguous',
    );

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'planning_product_mapping_ambiguous',
          payload: expect.objectContaining({
            planningProductIds: ['planning-product-ambiguous-1', 'planning-product-ambiguous-2'],
          }),
        }),
      ]),
    );
  });

  it('keeps valid rows when malformed rows produce row-level warnings', async () => {
    const { db, service } = createService();
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          files: [{ name: 'Profit Planning.csv', content: malformedProfitPlanningCsv, expectedRowCount: 2 }],
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'profit-planning-sample',
      sourceVersion: '2025-07',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 3, warningCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([
      expect.objectContaining({ normalizedStatus: 'success' }),
      expect.objectContaining({ normalizedStatus: 'pending', issueCode: 'csv_row_identity_missing' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.targetRows).all()).toEqual([
      expect.objectContaining({ period: '2025-11', periodType: 'monthly', profitTarget: 120 }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.suppliers).all()).toEqual([
      expect.objectContaining({ name: 'ELAN Publishing Company' }),
    ]);
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
    expect(db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toHaveLength(2);
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

  it('imports Google Sheets migration CSV exports through the same raw-row and normalized-record path', async () => {
    const { db, service } = createService('google_sheets', 'order_management');
    db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: { config: { files: [{ name: 'Supplier IDs.csv', content: supplierIdsCsv, expectedRowCount: 1 }] } },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'supplier-ids',
      sourceVersion: '2025-07-01',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 1, warningCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.supplierExternalIdentities).all()).toEqual([
      expect.objectContaining({
        company: 'Ecofission LLC',
        externalSupplierCode: 'SRO-36',
        externalSupplierName: '3Dmatsusa',
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.suppliers).all()).toEqual([
      expect.objectContaining({ supplierId: 'SRO-36', name: '3Dmatsusa', company: 'Ecofission LLC' }),
    ]);
  });

  it('treats scheduled rolling Sellerboard reports as fresh when they include the previous completed day', async () => {
    const { db, service } = createService('sellerboard');
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          schedule: { enabled: true, dailyRefreshTime: '00:00', refreshIntervalMinutes: 1440, retryIntervalMinutes: 60 },
          reportUrls: [
            {
              name: 'Profit Dashboard Data',
              category: 'profit_dashboard',
              url: 'https://sellerboard.test/profit-dashboard.csv',
            },
          ],
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('Date,Orders,SalesOrganic,NetProfit\n06/06/2026,1,10,4\n07/06/2026,2,20,8', { status: 200 }),
      ),
    );

    const results = await service.runScheduledSellerboardImports({ now: '2026-06-08T00:05:00.000Z' });

    expect(results.results).toEqual([expect.objectContaining({ status: 'success' })]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()[0]).toMatchObject({
      status: 'success',
      rowCount: 2,
      normalizedCount: 4,
      warningCount: 0,
      errorCount: 0,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all()).toEqual([
      expect.objectContaining({ snapshotDate: '2026-06-06' }),
      expect.objectContaining({ snapshotDate: '2026-06-07' }),
    ]);
  });

  it('skips already-normalized rolling Sellerboard days on scheduled refresh', async () => {
    const { db, service } = createService('sellerboard');
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          schedule: { enabled: true, dailyRefreshTime: '00:00', refreshIntervalMinutes: 1, retryIntervalMinutes: 60 },
          reportUrls: [
            {
              name: 'Profit Dashboard Data',
              category: 'profit_dashboard',
              url: 'https://sellerboard.test/profit-dashboard.csv',
            },
          ],
        },
      },
    });
    let csv = 'Date,Orders,SalesOrganic,NetProfit\n06/06/2026,1,10,4\n07/06/2026,2,20,8';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(csv, { status: 200 })),
    );

    await service.runScheduledSellerboardImports({ now: '2026-06-08T00:05:00.000Z' });
    const firstRun = db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()[0];
    csv = 'Date,Orders,SalesOrganic,NetProfit\n06/06/2026,1,10,4\n07/06/2026,2,20,8\n08/06/2026,3,30,12';
    await service.runScheduledSellerboardImports({ now: '2026-06-09T00:05:00.000Z' });
    const runs = db.getRepository(ECOBASE_COLLECTIONS.importRuns).all();
    const secondRun = runs[1];

    expect(firstRun).toMatchObject({ normalizedCount: 4 });
    expect(secondRun).toMatchObject({ status: 'success', rowCount: 3, normalizedCount: 2, warningCount: 0, errorCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).all()).toHaveLength(3);
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.listingDailyFacts)
        .all()
        .filter((record) => record.lastImportRunId === secondRun.id),
    ).toEqual([expect.objectContaining({ snapshotDate: '2026-06-08' })]);
  });

  it('reports partial Sellerboard status when some report URLs fail but available reports normalize', async () => {
    const { db, service } = createService('sellerboard');
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'source-1',
      values: {
        config: {
          schedule: { enabled: true, dailyRefreshTime: '00:00', refreshIntervalMinutes: 1440, retryIntervalMinutes: 60 },
          reportUrls: [
            { name: 'Profit Dashboard Data', category: 'profit_dashboard', url: 'https://sellerboard.test/profit-dashboard.csv' },
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

    expect(results.results).toEqual([expect.objectContaining({ status: 'partial' })]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()[0]).toMatchObject({
      status: 'partial',
      rowCount: 1,
      normalizedCount: 3,
      warningCount: 0,
      errorCount: 1,
    });
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
