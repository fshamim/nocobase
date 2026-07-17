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
import { EcobaseSupplierResolutionRepairService } from '../../features/supplier-management/server/supplier-resolution-repair-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import repairRuns from '../collections/repair-runs';

type Row = Record<string, unknown>;

function matches(row: Row, filter: Row | undefined) {
  return !filter || Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository implements EcobaseRepository {
  readonly findCalls: { filter?: Row; limit?: number; offset?: number; sort?: string[] }[] = [];
  constructor(readonly records: Row[] = []) {}
  async find(params: { filter?: Row; limit?: number; offset?: number; sort?: string[] } = {}) {
    this.findCalls.push(params);
    const offset = params.offset ?? 0;
    return this.records.filter((row) => matches(row, params.filter)).slice(offset, offset + (params.limit ?? Infinity));
  }
  async findOne(params: { filter?: Row; filterByTk?: unknown } = {}) {
    return (
      this.records.find((row) =>
        params.filterByTk !== undefined ? row.id === params.filterByTk : matches(row, params.filter),
      ) ?? null
    );
  }
  async create(params: { values: Row }) {
    const row = { ...params.values };
    this.records.push(row);
    return row;
  }
  async update(params: { filter?: Row; filterByTk?: unknown; values: Row }) {
    for (const row of this.records) {
      if (params.filterByTk !== undefined ? row.id === params.filterByTk : matches(row, params.filter)) {
        Object.assign(row, params.values);
      }
    }
    return params.values;
  }
  async destroy(params: { filterByTk?: unknown; filter?: Row }) {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const row = this.records[index];
      if (params.filterByTk !== undefined ? row.id === params.filterByTk : matches(row, params.filter)) {
        this.records.splice(index, 1);
      }
    }
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private repositories = new Map<string, MemoryRepository>();
  sequelize = {
    transaction: async <T>(run: (transaction: object) => Promise<T>) => {
      const snapshot = new Map(
        [...this.repositories].map(([name, repository]) => [name, structuredClone(repository.records)]),
      );
      try {
        return await run({ id: 'transaction' });
      } catch (error) {
        for (const [name, rows] of snapshot) {
          const repository = this.getRepository(name) as MemoryRepository;
          repository.records.splice(0, repository.records.length, ...rows);
        }
        throw error;
      }
    },
  };
  getRepository(name: string) {
    if (!this.repositories.has(name)) this.repositories.set(name, new MemoryRepository());
    return this.repositories.get(name) as MemoryRepository;
  }
}

async function create(db: MemoryDatabase, collection: string, values: Row) {
  await db.getRepository(collection).create({ values });
}

async function seed(db: MemoryDatabase, lineCount = 1) {
  await create(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-1', name: 'Ecofission LLC' });
  await create(db, ECOBASE_COLLECTIONS.silverAmazonAccounts, {
    id: 'account-1',
    companyId: 'company-1',
    marketplace: 'Amazon.com',
  });
  await create(db, ECOBASE_COLLECTIONS.silverProducts, {
    id: 'product-1',
    asin: 'B007P55HOW',
    sku: 'DC50944 New',
  });
  await create(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
    id: 'company-product-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    productId: 'product-1',
    companyProductFamilyId: 'family-1',
  });
  await create(db, ECOBASE_COLLECTIONS.silverCompanyProductFamilies, {
    id: 'family-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    marketplace: 'amazon.com',
    canonicalAsin: 'B007P55HOW',
    replenishmentTargetCompanyProductId: 'company-product-1',
    targetReviewRequired: false,
  });
  await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
    id: 'supplier-1',
    normalizedName: 'allied piano',
    displayName: 'Allied Piano',
  });
  for (let index = 1; index <= lineCount; index += 1) {
    const orderRef = `EF100${index}A`;
    await create(db, ECOBASE_COLLECTIONS.silverOrders, {
      id: `order-${index}`,
      orderRef,
      companyId: 'company-1',
      supplierId: 'supplier-1',
    });
    await create(db, ECOBASE_COLLECTIONS.silverOrderLines, {
      id: `line-${index}`,
      orderId: `order-${index}`,
      sourceLineKey: `${orderRef}:B007P55HOW:DC50944 New`,
      orderedQty: 2,
      unitCost: 10,
      productAnalysisStatus: 'planning_product_mapping_ambiguous',
    });
    await create(db, ECOBASE_COLLECTIONS.bronzeSourceRecords, {
      id: `bronze-${index}`,
      importRunId: 'import-run-1',
      sourceType: 'amazon_operations_csv',
      sourceDataset: 'OrderDetails.csv',
      sourceRecordKey: `order-detail-${index}`,
      rowHash: `hash-${index}`,
      payload: { 'Order ID': orderRef, ASIN: 'B007P55HOW', SKU: 'DC50944 New' },
      normalizationStatus: 'normalized',
    });
  }
}

describe('EcobaseSupplierResolutionRepairService', () => {
  it('defines durable run identity, checkpoint, count, and actor fields', () => {
    const fields = new Map(repairRuns.fields?.map((field) => [field.name, field]));
    expect(repairRuns.name).toBe(ECOBASE_COLLECTIONS.repairRuns);
    expect(fields.get('actorUserId')).toMatchObject({ type: 'bigInt', autoFill: false });
    expect(fields.get('decisionDigest')).toMatchObject({ type: 'string' });
    expect(fields.get('checkpointJson')).toMatchObject({ type: 'jsonb' });
    expect(fields.get('candidateCount')).toMatchObject({ type: 'integer' });
  });

  it('previews, checkpoints, repairs stable Silver lines, appends lineage, and reruns as a no-op', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1', actorUserId: '7' })) as Row;

    expect(run).toMatchObject({ status: 'previewed', candidateCount: 1, excludedCount: 0, cursor: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).findCalls[0]).toMatchObject({ sort: ['id'] });
    const completed = (await service.apply({
      runId: String(run.id),
      decisionDigest: String(run.decisionDigest),
      codeSha: 'sha-1',
      batchSize: 1,
    })) as Row;

    expect(completed).toMatchObject({ status: 'completed', cursor: 1, changedCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records[0]).toMatchObject({
      companyProductId: 'company-product-1',
      supplierProductId: expect.any(String),
      productAnalysisStatus: 'repair_confirmed',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).records).toEqual([
      expect.objectContaining({
        bronzeRecordId: 'bronze-1',
        silverEntityType: 'silverOrderLine',
        silverEntityId: 'line-1',
        relation: 'confirmed_by',
      }),
    ]);

    await service.apply({
      runId: String(run.id),
      decisionDigest: String(run.decisionDigest),
      codeSha: 'sha-1',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).records).toHaveLength(1);
    const noOp = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;
    expect(noOp).toMatchObject({ candidateCount: 0, changedCount: 0 });
  });

  it('clears only invalid optional Gold supplier references', async () => {
    const db = new MemoryDatabase();
    await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: 'supplier-1',
      normalizedName: 'supplier one',
      displayName: 'Supplier One',
    });
    await create(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: 'company-product-1',
      productId: 'product-1',
      companyProductFamilyId: 'family-1',
    });
    await create(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'gold-1',
      companyProductFamilyId: 'family-1',
      familyPreferredSupplierId: 'missing-supplier',
      familyPreferredSupplierProductId: 'missing-offer',
    });
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;
    expect(run).toMatchObject({ candidateCount: 1 });

    await service.apply({
      runId: String(run.id),
      decisionDigest: String(run.decisionDigest),
      codeSha: 'sha-1',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).records[0]).toMatchObject({
      familyPreferredSupplierId: null,
      familyPreferredSupplierProductId: null,
    });
  });

  it('refuses supplier convergence when the eligible group changes after preview', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    await create(db, ECOBASE_COLLECTIONS.silverSupplierExternalRefs, {
      id: 'supplier-ref-1',
      supplierId: 'supplier-1',
    });
    await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: 'supplier-duplicate-1',
      normalizedName: 'allied piano',
    });
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;
    await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: 'supplier-duplicate-late',
      normalizedName: 'allied piano',
    });

    await expect(
      service.apply({ runId: String(run.id), decisionDigest: String(run.decisionDigest), codeSha: 'sha-1' }),
    ).rejects.toThrow('stale preview');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).records).toHaveLength(3);
  });

  it('does not mutate a valid run when apply credentials mismatch', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;

    await expect(
      service.apply({ runId: String(run.id), decisionDigest: 'wrong-digest', codeSha: 'sha-1' }),
    ).rejects.toThrow('mismatched decision digest');
    expect(db.getRepository(ECOBASE_COLLECTIONS.repairRuns).records[0]).toMatchObject({
      status: 'previewed',
      cursor: 0,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.repairRuns).records[0]).not.toHaveProperty('errorMessage');
  });

  it('refuses to clear Gold supplier authority that changed after preview', async () => {
    const db = new MemoryDatabase();
    await create(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'gold-1',
      familyPreferredSupplierId: 'missing-supplier',
      familyPreferredSupplierProductId: 'missing-offer',
    });
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;
    await create(db, ECOBASE_COLLECTIONS.silverSuppliers, { id: 'valid-supplier' });
    await create(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
      id: 'valid-offer',
      supplierId: 'valid-supplier',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).update({
      filterByTk: 'gold-1',
      values: {
        familyPreferredSupplierId: 'valid-supplier',
        familyPreferredSupplierProductId: 'valid-offer',
      },
    });

    await expect(
      service.apply({
        runId: String(run.id),
        decisionDigest: String(run.decisionDigest),
        codeSha: 'sha-1',
      }),
    ).rejects.toThrow('changed after preview');
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).records[0]).toMatchObject({
      familyPreferredSupplierId: 'valid-supplier',
      familyPreferredSupplierProductId: 'valid-offer',
    });
  });

  it('refuses an unrelated supplier product on a changed order line', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;
    await create(db, ECOBASE_COLLECTIONS.silverSuppliers, { id: 'supplier-wrong' });
    await create(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
      id: 'offer-wrong',
      supplierId: 'supplier-wrong',
      productId: 'product-1',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).update({
      filterByTk: 'line-1',
      values: { companyProductId: 'company-product-1', supplierProductId: 'offer-wrong' },
    });

    await expect(
      service.apply({ runId: String(run.id), decisionDigest: String(run.decisionDigest), codeSha: 'sha-1' }),
    ).rejects.toThrow('refused changed line');
  });

  it('refuses replay when Bronze authority changes after preview', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;
    db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).records[0].rowHash = 'changed-hash';

    await expect(
      service.apply({ runId: String(run.id), decisionDigest: String(run.decisionDigest), codeSha: 'sha-1' }),
    ).rejects.toThrow('changed after preview');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records[0]).not.toHaveProperty('companyProductId');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records[0]).not.toHaveProperty('supplierProductId');
  });

  it('rolls back the current batch and keeps the last committed cursor on failure', async () => {
    const db = new MemoryDatabase();
    await seed(db, 2);
    const service = new EcobaseSupplierResolutionRepairService(db);
    const run = (await service.preview({ repairVersion: 'supplier-v1', codeSha: 'sha-1' })) as Row;

    await expect(
      service.apply({
        runId: String(run.id),
        decisionDigest: String(run.decisionDigest),
        codeSha: 'sha-1',
        batchSize: 2,
        failAfterItemKey: 'order-line:line-1',
      }),
    ).rejects.toThrow('injected failure');

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records).toEqual([
      expect.not.objectContaining({ companyProductId: 'company-product-1' }),
      expect.not.objectContaining({ companyProductId: 'company-product-1' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.repairRuns).records[0]).toMatchObject({
      status: 'failed',
      cursor: 0,
      changedCount: 0,
    });
  });
});
