import { describe, expect, it } from 'vitest';
import {
  amazonOperationsCsvAdapter,
  amazonSpApiAccessCheckAdapter,
  createSourceAdapterRegistry,
  googleSheetsMigrationCsvAdapter,
  sellerboardApiAdapter,
} from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseDatabase, EcobaseImportService, EcobaseRepository } from '../services/import-service';

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

const supplierIdsCsv = `SR ID,Supplier Name
SRO-36,3Dmatsusa`;

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
    expectedCollection: ECOBASE_COLLECTIONS.targetRows,
    sourceType: 'google_sheets',
    domain: 'order_management',
    adapterName: 'google-sheets-migration-csv',
  },
  {
    name: 'Purchase Orders.csv',
    content:
      'Timestamp,Order ID,SR ID ,Supplier,Company,Exp. Cost ,Payment Status ,Total units\n17/06/2023 03:46:51,OD-1,SRO-1,Supplier,Ecofission LLC,190,Paid,200',
    expectedCollection: ECOBASE_COLLECTIONS.targetRows,
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

      expect(run, sample.name).toMatchObject({ status: 'success', rowCount: 1, warningCount: 0 });
      expect(db.getRepository(sample.expectedCollection).all(), sample.name).toHaveLength(1);
      expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all(), sample.name).toHaveLength(1);
    }
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

    expect(run).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toEqual([
      expect.objectContaining({ normalizedStatus: 'success' }),
      expect.objectContaining({ normalizedStatus: 'pending', issueCode: 'csv_row_identity_missing' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.targetRows).all()).toHaveLength(1);
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

    expect(run).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawImportRows).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningParameters).all()).toEqual([
      expect.objectContaining({ supplierId: 'SRO-36', supplier: '3Dmatsusa' }),
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

    expect(sellerboardRun).toMatchObject({ status: 'success', normalizedCount: 1 });
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
