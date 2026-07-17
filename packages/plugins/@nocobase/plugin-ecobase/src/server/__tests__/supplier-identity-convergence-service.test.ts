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
import { EcobaseSupplierIdentityConvergenceService } from '../../features/supplier-management/server/supplier-identity-convergence-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';

type Row = Record<string, unknown>;

function matches(row: Row, filter: Row | undefined) {
  return !filter || Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository implements EcobaseRepository {
  constructor(readonly records: Row[] = []) {}

  async find(params: { filter?: Row; limit?: number; offset?: number } = {}) {
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
    this.records.push({ ...params.values });
    return params.values;
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

  getRepository(name: string) {
    if (!this.repositories.has(name)) this.repositories.set(name, new MemoryRepository());
    return this.repositories.get(name) as MemoryRepository;
  }
}

async function create(db: MemoryDatabase, collection: string, values: Row) {
  await db.getRepository(collection).create({ values });
}

async function seedCollisionSafeGroup(db: MemoryDatabase) {
  await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
    id: 'supplier-canonical',
    normalizedName: 'allied piano',
    displayName: 'Allied Piano',
  });
  await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
    id: 'supplier-duplicate',
    normalizedName: 'allied piano',
    displayName: 'Allied Piano & Finish',
  });
  await create(db, ECOBASE_COLLECTIONS.silverSupplierExternalRefs, {
    id: 'supplier-ref',
    supplierId: 'supplier-canonical',
    sourceSystem: 'supplier_ids',
    normalizedExternalSupplierCode: 'ALLIED-PIANO',
  });
  await create(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
    id: 'offer-canonical',
    supplierId: 'supplier-canonical',
    productId: 'product-1',
    supplierSku: 'AP-1',
    unitCost: 10,
    moq: 1,
    supplierPackSize: 1,
    leadTimeDays: 30,
  });
  await create(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
    id: 'offer-duplicate-identical',
    supplierId: 'supplier-duplicate',
    productId: 'product-1',
    supplierSku: 'AP-1',
    unitCost: 10,
    moq: 1,
    supplierPackSize: 1,
    leadTimeDays: 30,
  });
  await create(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
    id: 'offer-duplicate-move',
    supplierId: 'supplier-duplicate',
    productId: 'product-2',
    supplierSku: 'AP-2',
    unitCost: 20,
    moq: 2,
    supplierPackSize: 2,
    leadTimeDays: 20,
  });
  await create(db, ECOBASE_COLLECTIONS.silverOrders, {
    id: 'order-1',
    supplierId: 'supplier-duplicate',
  });
  await create(db, ECOBASE_COLLECTIONS.silverOrderLines, {
    id: 'line-1',
    orderId: 'order-1',
    supplierProductId: 'offer-duplicate-identical',
  });
  await create(db, ECOBASE_COLLECTIONS.silverSupplierAccounts, {
    id: 'account-1',
    supplierId: 'supplier-duplicate',
    companyId: 'company-1',
  });
  await create(db, ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, {
    id: 'product-link-1',
    companyProductId: 'company-product-1',
    supplierProductId: 'offer-duplicate-identical',
    role: 'latest_used',
  });
  await create(db, ECOBASE_COLLECTIONS.silverCompanyProductFamilies, {
    id: 'family-1',
    preferredSupplierId: 'supplier-duplicate',
    preferredSupplierProductId: 'offer-duplicate-identical',
  });
  await create(db, ECOBASE_COLLECTIONS.goldSupplierAttentionRows, {
    id: 'gold-supplier-1',
    supplierId: 'supplier-duplicate',
  });
  await create(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
    id: 'gold-inventory-1',
    familyPreferredSupplierId: 'supplier-duplicate',
    familyPreferredSupplierProductId: 'offer-duplicate-identical',
  });
  await create(db, ECOBASE_COLLECTIONS.goldOrderPlanningRows, {
    id: 'gold-order-1',
    supplierId: 'supplier-duplicate',
  });
}

describe('EcobaseSupplierIdentityConvergenceService', () => {
  it('previews and converges one externally authorized collision-safe supplier group', async () => {
    const db = new MemoryDatabase();
    await seedCollisionSafeGroup(db);
    const service = new EcobaseSupplierIdentityConvergenceService(db);

    expect(await service.preview()).toMatchObject({
      eligible: [
        {
          normalizedName: 'allied piano',
          canonicalSupplierId: 'supplier-canonical',
          duplicateSupplierIds: ['supplier-duplicate'],
          reasons: [],
        },
      ],
      reviewRequired: [],
    });

    await expect(service.converge('allied piano')).resolves.toMatchObject({
      canonicalSupplierId: 'supplier-canonical',
      mergedSupplierCount: 1,
      coalescedOffers: 1,
      movedOffers: 1,
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).records).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'offer-canonical', supplierId: 'supplier-canonical' }),
        expect.objectContaining({ id: 'offer-duplicate-move', supplierId: 'supplier-canonical' }),
      ]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records[0]).toMatchObject({
      supplierProductId: 'offer-canonical',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records[0]).toMatchObject({
      supplierId: 'supplier-canonical',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).records[0]).toMatchObject({
      preferredSupplierId: 'supplier-canonical',
      preferredSupplierProductId: 'offer-canonical',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).records[0]).toMatchObject({
      familyPreferredSupplierId: 'supplier-canonical',
      familyPreferredSupplierProductId: 'offer-canonical',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).records[0]).toMatchObject({
      supplierId: 'supplier-canonical',
    });
    expect((await service.preview()).eligible).toEqual([]);
  });

  it('paginates external authority reads beyond one repository page', async () => {
    const db = new MemoryDatabase();
    await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: 'supplier-canonical',
      normalizedName: 'paged supplier',
    });
    await create(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: 'supplier-duplicate',
      normalizedName: 'paged supplier',
    });
    for (let index = 0; index < 5000; index += 1) {
      await create(db, ECOBASE_COLLECTIONS.silverSupplierExternalRefs, {
        id: `unrelated-${index}`,
        supplierId: `other-${index}`,
      });
    }
    await create(db, ECOBASE_COLLECTIONS.silverSupplierExternalRefs, {
      id: 'canonical-ref',
      supplierId: 'supplier-canonical',
    });

    await expect(new EcobaseSupplierIdentityConvergenceService(db).preview()).resolves.toMatchObject({
      eligible: [{ canonicalSupplierId: 'supplier-canonical' }],
    });
  });

  it('keeps null-versus-zero and analysis-status offer differences in review', async () => {
    const db = new MemoryDatabase();
    await seedCollisionSafeGroup(db);
    const offers = db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).records;
    const canonical = offers.find((row) => row.id === 'offer-canonical')!;
    const duplicate = offers.find((row) => row.id === 'offer-duplicate-identical')!;
    canonical.unitCost = null;
    duplicate.unitCost = 0;

    let preview = await new EcobaseSupplierIdentityConvergenceService(db).preview();
    expect(preview.reviewRequired[0].reasons).toContain('conflicting_supplier_offer:product-1');

    canonical.unitCost = 0;
    canonical.analysisStatus = 'approved';
    duplicate.analysisStatus = 'not_analyzed';
    preview = await new EcobaseSupplierIdentityConvergenceService(db).preview();
    expect(preview.reviewRequired[0].reasons).toContain('conflicting_supplier_offer:product-1');
  });

  it('keeps competing external authority and conflicting offers in review', async () => {
    const db = new MemoryDatabase();
    await seedCollisionSafeGroup(db);
    await create(db, ECOBASE_COLLECTIONS.silverSupplierExternalRefs, {
      id: 'supplier-ref-competing',
      supplierId: 'supplier-duplicate',
      sourceSystem: 'supplier_tracker',
      normalizedExternalSupplierCode: 'allied-piano-2',
    });

    const competing = await new EcobaseSupplierIdentityConvergenceService(db).preview();
    expect(competing.reviewRequired[0]).toMatchObject({ reasons: ['competing_external_authority'] });

    db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).records.pop();
    db
      .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
      .records.find((row) => row.id === 'offer-duplicate-identical')!.unitCost = 11;
    const conflicting = await new EcobaseSupplierIdentityConvergenceService(db).preview();
    expect(conflicting.reviewRequired[0]).toMatchObject({
      reasons: ['conflicting_supplier_offer:product-1'],
    });
    await expect(new EcobaseSupplierIdentityConvergenceService(db).converge('allied piano')).rejects.toThrow(
      'no collision-safe authorized canonical supplier',
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).records).toHaveLength(2);
  });
});
