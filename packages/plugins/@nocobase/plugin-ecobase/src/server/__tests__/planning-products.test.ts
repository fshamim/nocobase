import { describe, expect, it, vi } from 'vitest';
import { amazonOperationsCsvAdapter, createSourceAdapterRegistry, SourceAdapter } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobasePlanningActions } from '../plugin';
import { EcobaseDatabase, EcobaseImportService, EcobaseRepository } from '../services/import-service';
import { EcobasePlanningProductService } from '../services/planning-product-service';

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

const productionDuplicateMasterStockCsv = `Company,ASIN,SKU,Title,FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier SKU
Ecofission LLC,B0DX35PTCL,RM-CLIPS/3-01,"OLFA 35"" x 70"" Connecting Grid Rotary Cutting Mat Set (RM-CLIPS/3-01) - sample duplicate",10,100,1.5,40,12,1,0,5,Amazon.com,60,15,SUP-RM
Ecofission LLC,B0DX35PTCL,FBA1935C9P1P.missing1,"OLFA 35"" x 70"" Connecting Grid Rotary Cutting Mat Set (RM-CLIPS/3-01) - duplicate FBA SKU",6,60,1.1,30,8,0,0,3,Amazon.com,60,15,SUP-FBA`;

const knownDuplicateAdapter: SourceAdapter = {
  metadata: {
    name: 'known-duplicate-fixture',
    title: 'Known duplicate fixture',
    sourceType: 'seller_central_file',
    supportedDomains: ['amazon_operations'],
    version: '1.0.0',
  },
  async *import(input) {
    const rows = [
      {
        rowNumber: 2,
        sku: 'RM-CLIPS/3-01',
        title: 'OLFA 35" x 70" Connecting Grid Rotary Cutting Mat Set (RM-CLIPS/3-01) - sample duplicate',
        stock: 10,
        units: 4,
      },
      {
        rowNumber: 3,
        sku: 'FBA1935C9P1P.missing1',
        title: 'OLFA 35" x 70" Connecting Grid Rotary Cutting Mat Set (RM-CLIPS/3-01) - duplicate FBA SKU',
        stock: 6,
        units: 2,
      },
    ];

    for (const row of rows) {
      const sourceKey = `SampleAM Weekly Report-July2025 - MasterStock.csv:B0DX35PTCL:${row.sku}`;
      yield {
        type: 'record' as const,
        rowNumber: row.rowNumber,
        sourceKey,
        payload: row,
        record: [
          {
            kind: 'raw_listing',
            data: {
              naturalKey: `${input.sourceConnectionId}:raw_listing:B0DX35PTCL:${row.sku}`,
              sourceConnectionId: input.sourceConnectionId,
              company: 'Ecofission LLC',
              asin: 'B0DX35PTCL',
              sku: row.sku,
              title: row.title,
              payload: row,
            },
          },
          {
            kind: 'inventory_snapshot',
            data: {
              naturalKey: `${input.sourceConnectionId}:inventory_snapshot:2025-07-01:B0DX35PTCL:${row.sku}`,
              sourceConnectionId: input.sourceConnectionId,
              snapshotDate: '2025-07-01',
              company: 'Ecofission LLC',
              asin: 'B0DX35PTCL',
              sku: row.sku,
              stock: row.stock,
              payload: row,
            },
          },
          {
            kind: 'listing_daily_fact',
            data: {
              naturalKey: `${input.sourceConnectionId}:listing_daily_fact:2025-07-01:B0DX35PTCL:${row.sku}`,
              sourceConnectionId: input.sourceConnectionId,
              snapshotDate: '2025-07-01',
              company: 'Ecofission LLC',
              asin: 'B0DX35PTCL',
              sku: row.sku,
              units: row.units,
              sourceKey,
              payload: row,
            },
          },
        ],
      };
    }
  },
};

function createImportedFixture() {
  const db = new MemoryDatabase();
  db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: {
      id: 'source-1',
      name: 'SampleAM weekly report',
      sourceType: 'seller_central_file',
      domain: 'amazon_operations',
      config: {},
      active: true,
    },
  });
  const service = new EcobaseImportService(db, createSourceAdapterRegistry([knownDuplicateAdapter]));
  return { db, service, planning: new EcobasePlanningProductService(db) };
}

function createProductionAdapterFixture() {
  const db = new MemoryDatabase();
  db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: {
      id: 'source-1',
      name: 'SampleAM weekly report',
      sourceType: 'seller_central_file',
      domain: 'amazon_operations',
      config: {
        files: [
          {
            name: 'SampleAM Weekly Report-July2025 - MasterStock.csv',
            content: productionDuplicateMasterStockCsv,
            expectedRowCount: 2,
            snapshotDate: '2025-07-01',
          },
        ],
      },
      active: true,
    },
  });
  const service = new EcobaseImportService(db, createSourceAdapterRegistry([amazonOperationsCsvAdapter]));
  return { db, service, planning: new EcobasePlanningProductService(db) };
}

function createActionContext(db: EcobaseDatabase, values: Record<string, unknown> = {}) {
  return {
    action: { params: { values } },
    db,
    state: { currentUser: { id: 'operator-1' } },
    body: undefined,
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

describe('Ecobase planning product identity layer', () => {
  it('preserves duplicate MasterStock listing rows through the production amazon-operations-csv adapter', async () => {
    const { db, service, planning } = createProductionAdapterFixture();

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'amazon-operations-csv',
      sourceIdentifier: 'SampleAM MasterStock known duplicate',
      sourceVersion: '2025-07-01',
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 6, warningCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.rawListings).all()).toEqual([
      expect.objectContaining({ company: 'Ecofission LLC', asin: 'B0DX35PTCL', sku: 'RM-CLIPS/3-01' }),
      expect.objectContaining({ company: 'Ecofission LLC', asin: 'B0DX35PTCL', sku: 'FBA1935C9P1P.missing1' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).all()).toEqual([
      expect.objectContaining({ asin: 'B0DX35PTCL', sku: 'RM-CLIPS/3-01', stock: 10 }),
      expect.objectContaining({ asin: 'B0DX35PTCL', sku: 'FBA1935C9P1P.missing1', stock: 6 }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProducts).all()).toEqual([
      expect.objectContaining({
        company: 'Ecofission LLC',
        canonicalAsin: 'B0DX35PTCL',
        mappingStatus: 'needs_review',
        listingCount: 2,
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).all()).toEqual([
      expect.objectContaining({ sku: 'RM-CLIPS/3-01', mappingStatus: 'needs_review' }),
      expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', mappingStatus: 'needs_review' }),
    ]);

    expect(await planning.listDuplicateMappings()).toEqual([
      expect.objectContaining({
        company: 'Ecofission LLC',
        canonicalAsin: 'B0DX35PTCL',
        mappingStatus: 'needs_review',
        listings: expect.arrayContaining([
          expect.objectContaining({ sku: 'RM-CLIPS/3-01', mappingStatus: 'needs_review' }),
          expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', mappingStatus: 'needs_review' }),
        ]),
      }),
    ]);
  });

  it('creates one planning product per company and canonical ASIN with duplicate listings visible for review', async () => {
    const { db, service, planning } = createImportedFixture();

    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'known-duplicate-fixture',
      sourceIdentifier: 'SampleAM MasterStock known duplicate',
      sourceVersion: '2025-07-01',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.rawListings).all()).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProducts).all()).toEqual([
      expect.objectContaining({
        company: 'Ecofission LLC',
        canonicalAsin: 'B0DX35PTCL',
        mappingStatus: 'needs_review',
        listingCount: 2,
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).all()).toEqual([
      expect.objectContaining({ sku: 'RM-CLIPS/3-01', mappingMode: 'default', mappingStatus: 'needs_review' }),
      expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', mappingMode: 'default', mappingStatus: 'needs_review' }),
    ]);

    const reviewRows = await planning.listDuplicateMappings();
    expect(reviewRows).toEqual([
      expect.objectContaining({
        company: 'Ecofission LLC',
        canonicalAsin: 'B0DX35PTCL',
        mappingStatus: 'needs_review',
        listingCount: 2,
        listings: expect.arrayContaining([
          expect.objectContaining({ sku: 'RM-CLIPS/3-01', sourceConnectionId: 'source-1' }),
          expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', sourceConnectionId: 'source-1' }),
        ]),
      }),
    ]);
  });

  it('confirms duplicate mappings through the public API action and keeps an audit trail', async () => {
    const { db, service } = createImportedFixture();
    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'known-duplicate-fixture',
      sourceIdentifier: 'SampleAM MasterStock known duplicate',
      sourceVersion: '2025-07-01',
    });
    const product = db.getRepository(ECOBASE_COLLECTIONS.planningProducts).all()[0];
    const actions = createEcobasePlanningActions();
    const context = createActionContext(db, { planningProductId: product.id, note: 'Known duplicate confirmed.' });
    const next = vi.fn();

    await actions.confirmMapping(context, next);

    expect(context.body).toEqual({ data: expect.objectContaining({ id: product.id, mappingStatus: 'confirmed' }) });
    expect(next).toHaveBeenCalledOnce();
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).all()).toEqual([
      expect.objectContaining({ mappingStatus: 'confirmed' }),
      expect.objectContaining({ mappingStatus: 'confirmed' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProductMappingAudits).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'default_created',
          rawListingNaturalKey: expect.stringContaining('B0DX35PTCL'),
        }),
        expect.objectContaining({ action: 'confirmed', actorId: 'operator-1', note: 'Known duplicate confirmed.' }),
      ]),
    );
  });

  it('adjusts a mapping manually and preserves the explicit override during later default syncs', async () => {
    const { db, service, planning } = createImportedFixture();
    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'known-duplicate-fixture',
      sourceIdentifier: 'SampleAM MasterStock known duplicate',
      sourceVersion: '2025-07-01',
    });
    const mappingToMove = db
      .getRepository(ECOBASE_COLLECTIONS.planningProductListings)
      .all()
      .find((mapping) => mapping.sku === 'FBA1935C9P1P.missing1');

    const adjusted = await planning.adjustMapping({
      planningProductListingId: mappingToMove?.id as string,
      targetCompany: 'Ecofission LLC',
      targetCanonicalAsin: 'B0DX35PTCL',
      targetTitle: 'Manual split for FBA duplicate SKU',
      actorId: 'operator-1',
      note: 'Split FBA SKU for review.',
    });

    expect(adjusted).toEqual(expect.objectContaining({ mappingMode: 'manual', mappingStatus: 'adjusted' }));
    const manualProductId = adjusted.planningProductId;
    await planning.syncFromRawListings();

    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.planningProductListings)
        .all()
        .find((mapping) => mapping.id === adjusted.id),
    ).toEqual(expect.objectContaining({ planningProductId: manualProductId, mappingMode: 'manual' }));
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProductMappingAudits).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'adjusted',
          actorId: 'operator-1',
          note: 'Split FBA SKU for review.',
          nextPlanningProductId: manualProductId,
        }),
      ]),
    );
  });

  it('rejects invalid manual adjustment targets before mutating mappings or audits', async () => {
    const { db, service, planning } = createImportedFixture();
    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'known-duplicate-fixture',
      sourceIdentifier: 'SampleAM MasterStock known duplicate',
      sourceVersion: '2025-07-01',
    });
    const mappingsBefore = db
      .getRepository(ECOBASE_COLLECTIONS.planningProductListings)
      .all()
      .map((mapping) => ({
        id: mapping.id,
        planningProductId: mapping.planningProductId,
        mappingMode: mapping.mappingMode,
        mappingStatus: mapping.mappingStatus,
      }));
    const productsBefore = db.getRepository(ECOBASE_COLLECTIONS.planningProducts).all().length;
    const auditsBefore = db.getRepository(ECOBASE_COLLECTIONS.planningProductMappingAudits).all().length;

    await expect(
      planning.adjustMapping({
        planningProductListingId: mappingsBefore[0].id as string,
        targetPlanningProductId: 'missing-product',
      }),
    ).rejects.toThrow('target planning product "missing-product" was not found');

    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProducts).all()).toHaveLength(productsBefore);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProductMappingAudits).all()).toHaveLength(auditsBefore);
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).all()).toEqual(
      mappingsBefore.map((mapping) => expect.objectContaining(mapping)),
    );
  });

  it('queries inventory snapshots and historical listing facts by planning product after mapping', async () => {
    const { db, service } = createImportedFixture();
    await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'known-duplicate-fixture',
      sourceIdentifier: 'SampleAM MasterStock known duplicate',
      sourceVersion: '2025-07-01',
    });
    const product = db.getRepository(ECOBASE_COLLECTIONS.planningProducts).all()[0];
    const actions = createEcobasePlanningActions();
    const context = createActionContext(db, { planningProductId: product.id });

    await actions.productData(context, vi.fn());

    expect(context.body).toEqual({
      data: expect.objectContaining({
        product: expect.objectContaining({ id: product.id, canonicalAsin: 'B0DX35PTCL' }),
        listings: expect.arrayContaining([expect.objectContaining({ sku: 'RM-CLIPS/3-01' })]),
        inventorySnapshots: expect.arrayContaining([
          expect.objectContaining({ sku: 'RM-CLIPS/3-01', stock: 10, planningProductId: product.id }),
          expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', stock: 6, planningProductId: product.id }),
        ]),
        listingDailyFacts: expect.arrayContaining([
          expect.objectContaining({ sku: 'RM-CLIPS/3-01', units: 4, planningProductId: product.id }),
          expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', units: 2, planningProductId: product.id }),
        ]),
        mappingAudits: expect.arrayContaining([
          expect.objectContaining({
            action: 'default_created',
            rawListingNaturalKey: expect.stringContaining('B0DX35PTCL'),
          }),
        ]),
      }),
    });
  });
});
