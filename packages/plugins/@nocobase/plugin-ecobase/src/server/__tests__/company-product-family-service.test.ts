/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EcobaseCompanyProductFamilyService } from '../../features/semantic-model/server/company-product-family-service';
import { EcobaseInventoryPlanningService } from '../../features/inventory-dashboard/server/engine/inventory-planning-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Row = Record<string, any>;

function matches(row: Row, filter: Row = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray((value as { $in?: unknown[] }).$in)) {
      return (value as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === value;
  });
}

class MemoryRepository implements EcobaseRepository {
  updateCallCount = 0;

  constructor(private rows: Row[] = []) {}

  async find(params: any = {}) {
    return this.rows.filter((row) => matches(row, params.filter)).map((row) => ({ ...row }));
  }

  async findOne(params: any = {}) {
    const row = params.filterByTk
      ? this.rows.find((item) => item.id === params.filterByTk)
      : this.rows.find((item) => matches(item, params.filter));
    return row ? { ...row } : null;
  }

  async create(params: any) {
    const row = { ...params.values };
    this.rows.push(row);
    return { ...row };
  }

  async update(params: any) {
    this.updateCallCount += 1;
    const row = this.rows.find((item) => item.id === params.filterByTk);
    if (!row) throw new Error(`MemoryRepository failed: row ${params.filterByTk} was not found.`);
    Object.assign(row, params.values);
    return { ...row };
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private repositories = new Map<string, MemoryRepository>();

  getRepository(name: string) {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryRepository();
      this.repositories.set(name, repository);
    }
    return repository;
  }
}

async function seed(db: MemoryDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
    values: { id: 'company-1', name: 'Ecofission LLC' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).create({
    values: { id: 'account-us', companyId: 'company-1', marketplace: 'Amazon.com' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).create({
    values: { id: 'account-ca', companyId: 'company-1', marketplace: 'Amazon.ca' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).create({
    values: { id: 'account-us-secondary', companyId: 'company-1', marketplace: 'Amazon.com' },
  });
  for (const supplierId of ['supplier-1', 'supplier-2']) {
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: supplierId, displayName: supplierId },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).create({
      values: { id: `${supplierId}-account`, supplierId, companyId: 'company-1', accountName: supplierId },
    });
  }
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: 'product-a', asin: 'B000FAMILY', sku: 'SKU-A' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: 'product-b', asin: 'B000FAMILY', sku: 'SKU-B' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: 'product-other', asin: 'B000OTHER', sku: 'SKU-X' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-a',
      companyId: 'company-1',
      amazonAccountId: 'account-us',
      productId: 'product-a',
      lifecycleStatus: 'active',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-b',
      companyId: 'company-1',
      amazonAccountId: 'account-us',
      productId: 'product-b',
      lifecycleStatus: 'active',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-other-account',
      companyId: 'company-1',
      amazonAccountId: 'account-ca',
      productId: 'product-a',
      lifecycleStatus: 'active',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-other-asin',
      companyId: 'company-1',
      amazonAccountId: 'account-us',
      productId: 'product-other',
      lifecycleStatus: 'active',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
    values: { id: 'supplier-product-a', supplierId: 'supplier-1', productId: 'product-a' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
    values: { id: 'supplier-product-b', supplierId: 'supplier-2', productId: 'product-b' },
  });
}

const identity = {
  companyId: 'company-1',
  amazonAccountId: 'account-us',
  marketplace: 'Amazon.com',
  canonicalAsin: 'b000family',
};

describe('EcobaseCompanyProductFamilyService', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves only exact member identity and never substitutes the family target', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setReplenishmentTarget({
      familyId: String(family.id),
      companyProductId: 'company-product-b',
      source: 'operator',
    });

    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'SKU-A',
        marketplace: 'Amazon.com',
      }),
    ).resolves.toMatchObject({
      companyProductId: 'company-product-a',
      resolution: 'exact',
      sourceSku: 'SKU-A',
    });

    for (const sourceSku of ['DC 50944', 'DC-50944', 'Dampp-Chaser-50944']) {
      await expect(
        service.resolveCompanyProduct({
          companyId: 'company-1',
          asin: 'B000FAMILY',
          sku: sourceSku,
          marketplace: 'Amazon.com',
        }),
      ).resolves.toMatchObject({
        exclusionReason: 'exact_match_missing',
        sourceSku,
        boundary: { amazonAccountId: 'account-us', marketplace: 'amazon.com' },
      });
    }
  });

  it('reports missing, ambiguous, and cross-boundary family identity without target inference', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setReplenishmentTarget({
      familyId: String(family.id),
      companyProductId: 'company-product-b',
      source: 'operator',
    });

    await expect(
      service.resolveCompanyProduct({ companyId: 'company-1', asin: 'B000FAMILY', sku: 'ALIAS' }),
    ).resolves.toMatchObject({ exclusionReason: 'boundary_ambiguous' });
    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'ALIAS',
        marketplace: 'Amazon.mx',
      }),
    ).resolves.toMatchObject({ exclusionReason: 'boundary_missing' });
    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'ALIAS',
        amazonAccountId: 'account-ca',
        marketplace: 'Amazon.com',
      }),
    ).resolves.toMatchObject({ exclusionReason: 'boundary_missing' });
    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'ALIAS',
        marketplace: 'Amazon.ca',
      }),
    ).resolves.toMatchObject({ exclusionReason: 'family_missing' });

    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'ALIAS',
        marketplace: 'Amazon.com',
      }),
    ).resolves.toMatchObject({ exclusionReason: 'exact_match_missing' });
  });

  it('creates one idempotent family per company, account, marketplace, and ASIN', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);

    const first = await service.ensureFamily(identity);
    const second = await service.ensureFamily({
      ...identity,
      marketplace: ' amazon.com ',
      canonicalAsin: 'B000FAMILY',
    });
    const otherMarketplace = await service.ensureFamily({
      ...identity,
      amazonAccountId: 'account-ca',
      marketplace: 'Amazon.ca',
    });
    const otherAccount = await service.ensureFamily({ ...identity, amazonAccountId: 'account-us-secondary' });

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ marketplace: 'amazon.com', canonicalAsin: 'B000FAMILY' });
    expect(otherMarketplace.id).not.toBe(first.id);
    expect(otherAccount.id).not.toBe(first.id);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).find()).toHaveLength(3);
  });

  it('reconciles one family per account and marketplace without crossing boundaries', async () => {
    const db = new MemoryDatabase();
    await seed(db);

    const service = new EcobaseCompanyProductFamilyService(db);
    const result = await service.reconcileAllFamilies();
    const second = await service.reconcileAllFamilies();

    expect(result).toMatchObject({
      familyCount: 3,
      examinedCompanyProductCount: 4,
      createdFamilyCount: 3,
      linkedCompanyProductCount: 4,
    });
    expect(second).toMatchObject({
      familyCount: 3,
      examinedCompanyProductCount: 4,
      createdFamilyCount: 0,
      linkedCompanyProductCount: 0,
    });
    expect(
      (await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find()).every((companyProduct) =>
        Boolean(companyProduct.companyProductFamilyId),
      ),
    ).toBe(true);
    expect(result.families.map((family) => [family.amazonAccountId, family.marketplace, family.canonicalAsin])).toEqual(
      expect.arrayContaining([
        ['account-us', 'amazon.com', 'B000FAMILY'],
        ['account-ca', 'amazon.ca', 'B000FAMILY'],
        ['account-us', 'amazon.com', 'B000OTHER'],
      ]),
    );
  });

  it('blocks protected catalog creation before changing any family identity', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const companyProducts = await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find();

    await expect(service.reconcileAllFamilies(undefined, { preserveCatalog: true })).rejects.toThrow(
      'EcoBase family reconciliation would create protected family',
    );

    expect(await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).find()).toEqual([]);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find()).toEqual(companyProducts);
  });

  it('does not rewrite family evidence or timestamps on an identical reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-16T12:00:00.000Z');
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);

    await service.reconcileAllFamilies();
    const familyRepository = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies);
    const firstFamilies = await familyRepository.find();
    const firstUpdateCallCount = familyRepository.updateCallCount;
    vi.setSystemTime('2026-07-16T12:01:00.000Z');
    const replay = await service.reconcileAllFamilies();

    expect(replay).toMatchObject({ createdFamilyCount: 0, linkedCompanyProductCount: 0 });
    expect(await familyRepository.find()).toEqual(firstFamilies);
    expect(familyRepository.updateCallCount).toBe(firstUpdateCallCount);
  });

  it('does not mutate Silver family prerequisites during a Gold refresh', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-refresh-prerequisite',
        companyProductId: 'company-product-other-asin',
        snapshotDate: '2026-07-01',
        sellableStock: 0,
      },
    });
    const before = structuredClone(
      await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ sort: ['id'] }),
    );

    // The seed leaves catalog listings outside any family, so the builder's catalog-drift
    // guard is the one that refuses (it runs before the cardinality check). Either way the
    // point of this test stands: the refresh aborts BEFORE touching Silver.
    await expect(
      new EcobaseInventoryPlanningService(db).refreshReadModel({ calculationDate: '2026-07-01' }),
    ).rejects.toMatchObject({ code: 'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT' });

    expect(await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ sort: ['id'] })).toEqual(before);
  });

  it('persists an operator target and rejects a listing outside the family boundary', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);

    const selected = await service.setReplenishmentTarget({
      familyId: family.id,
      companyProductId: 'company-product-a',
      source: 'operator',
      actorUserId: '101',
    });
    const preserved = await service.setReplenishmentTarget({
      familyId: family.id,
      companyProductId: 'company-product-b',
      source: 'automatic',
    });

    expect(selected).toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-a',
      targetSelectionSource: 'operator',
      targetSelectedByUserId: '101',
    });
    expect(preserved.replenishmentTargetCompanyProductId).toBe('company-product-a');
    await expect(
      service.setReplenishmentTarget({
        familyId: family.id,
        companyProductId: 'company-product-other-account',
        source: 'operator',
      }),
    ).rejects.toThrow(/does not belong to family/);
  });

  it('selects the highest-stock initial target once and only recommends later changes', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-a-1',
        companyProductId: 'company-product-a',
        snapshotDate: '2026-07-01',
        sellableStock: 8,
        reserved: 2,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-b-1',
        companyProductId: 'company-product-b',
        snapshotDate: '2026-07-01',
        sellableStock: 5,
        inbound: 15,
      },
    });

    const selected = await service.reconcileFamily(family.id as string);
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-a-2',
        companyProductId: 'company-product-a',
        snapshotDate: '2026-07-02',
        sellableStock: 30,
      },
    });
    const preserved = await service.reconcileFamily(family.id as string);

    expect(selected).toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetSelectionSource: 'automatic',
      targetReviewRequired: false,
    });
    expect(preserved).toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetReviewRequired: true,
      targetSelectionEvidenceJson: { recommendedCompanyProductId: 'company-product-a' },
    });
  });

  it('selects a zero-stock singleton when current stock evidence is present', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-ca-zero',
        companyProductId: 'company-product-other-account',
        snapshotDate: '2026-07-01',
        sellableStock: 0,
        reserved: 0,
        inbound: 0,
        ordered: 0,
      },
    });

    const result = await new EcobaseCompanyProductFamilyService(db).reconcileAllFamilies();
    const family = result.families.find((item) => item.amazonAccountId === 'account-ca');

    expect(family).toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-other-account',
      targetReviewRequired: false,
    });
  });

  it('does not turn a missing sellable-stock value into zero-stock evidence', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
      filterByTk: 'company-product-b',
      values: { lifecycleStatus: 'inactive' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-a-missing-stock',
        companyProductId: 'company-product-a',
        snapshotDate: '2026-07-01',
        sellableStock: null,
      },
    });

    const reconciled = await service.reconcileFamily(String(family.id));
    expect(reconciled).toMatchObject({
      targetReviewRequired: true,
      targetSelectionEvidenceJson: { reviewReason: 'missing_current_stock_evidence' },
    });
    expect(reconciled.replenishmentTargetCompanyProductId).toBeUndefined();
  });

  it('excludes inactive listings and sends an exact active-stock tie to review', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
      filterByTk: 'company-product-a',
      values: { lifecycleStatus: 'inactive' },
    });
    for (const [id, companyProductId, stock] of [
      ['snapshot-inactive-high', 'company-product-a', 100],
      ['snapshot-active-low', 'company-product-b', 1],
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
        values: { id, companyProductId, snapshotDate: '2026-07-01', sellableStock: stock },
      });
    }

    await expect(service.reconcileFamily(String(family.id))).resolves.toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetReviewRequired: false,
    });

    const tieDb = new MemoryDatabase();
    await seed(tieDb);
    const tieService = new EcobaseCompanyProductFamilyService(tieDb);
    const tieFamily = await tieService.ensureFamily(identity);
    for (const [id, companyProductId] of [
      ['snapshot-tie-a', 'company-product-a'],
      ['snapshot-tie-b', 'company-product-b'],
    ]) {
      await tieDb.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
        values: { id, companyProductId, snapshotDate: '2026-07-01', sellableStock: 10 },
      });
    }

    const tied = await tieService.reconcileFamily(String(tieFamily.id));
    expect(tied).toMatchObject({
      targetReviewRequired: true,
      targetSelectionEvidenceJson: { reviewReason: 'ambiguous_target_stock_tie' },
    });
    expect(tied.replenishmentTargetCompanyProductId).toBeUndefined();
  });

  it('preserves a valid operator target during automatic reconciliation', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    for (const [id, companyProductId, stock] of [
      ['snapshot-operator-a', 'company-product-a', 1],
      ['snapshot-operator-b', 'company-product-b', 20],
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
        values: { id, companyProductId, snapshotDate: '2026-07-01', sellableStock: stock },
      });
    }
    await service.setReplenishmentTarget({
      familyId: String(family.id),
      companyProductId: 'company-product-a',
      source: 'operator',
      actorUserId: '102',
    });

    await expect(service.reconcileFamily(String(family.id))).resolves.toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-a',
      targetSelectionSource: 'operator',
      targetReviewRequired: false,
    });
  });

  it('keeps the same ASIN in separate accounts on separate family boundaries', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: {
        id: 'company-product-secondary-account',
        companyId: 'company-1',
        amazonAccountId: 'account-us-secondary',
        productId: 'product-a',
        lifecycleStatus: 'active',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-secondary-account',
        companyProductId: 'company-product-secondary-account',
        snapshotDate: '2026-07-01',
        sellableStock: 0,
      },
    });

    const result = await new EcobaseCompanyProductFamilyService(db).reconcileAllFamilies();
    const sameAsinFamilies = result.families.filter((family) => family.canonicalAsin === 'B000FAMILY');

    expect(sameAsinFamilies.map((family) => family.amazonAccountId)).toEqual(
      expect.arrayContaining(['account-us', 'account-ca', 'account-us-secondary']),
    );
  });

  it('selects the latest valid supplier order and preserves source SKU evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-16T12:00:00.000Z');
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setReplenishmentTarget({
      familyId: family.id as string,
      companyProductId: 'company-product-b',
      source: 'automatic',
    });
    for (const order of [
      { id: 'order-old', supplierId: 'supplier-1', orderRef: 'EF1001A', orderDate: '2026-06-01' },
      { id: 'order-new', supplierId: 'supplier-2', orderRef: 'EF1002A', orderDate: '2026-07-01' },
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
        values: {
          ...order,
          companyId: 'company-1',
          canonicalStatus: 'paid',
          authorityStatus: 'clickup_authoritative',
        },
      });
    }
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-old',
        orderId: 'order-old',
        companyProductId: 'company-product-a',
        supplierProductId: 'supplier-product-a',
        orderedQty: 1,
        productMappingStatus: 'resolved',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-new',
        orderId: 'order-new',
        companyProductId: 'company-product-b',
        supplierProductId: 'supplier-product-b',
        sourceAsin: 'B000FAMILY',
        sourceSupplierSku: 'SUPPLIER-SKU-B',
        productMappingStatus: 'resolved',
        orderedQty: 1,
      },
    });

    const reconciled = await service.reconcileFamily(family.id as string);
    const familyRepository = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies);
    const updateCallCount = familyRepository.updateCallCount;
    vi.setSystemTime('2026-07-16T12:01:00.000Z');
    const replay = await service.reconcileFamily(family.id as string);

    expect(reconciled).toMatchObject({
      preferredSupplierId: 'supplier-2',
      preferredSupplierProductId: 'supplier-product-b',
      supplierSelectionSource: 'latest_valid_order',
      supplierReviewRequired: false,
      supplierSelectionEvidenceJson: {
        sourceOrderRef: 'EF1002A',
        sourceAsin: 'B000FAMILY',
        sourceSku: 'SUPPLIER-SKU-B',
        productMappingStatus: 'resolved',
        matchType: 'exact_target_sku',
      },
    });
    expect(replay).toEqual(reconciled);
    expect(familyRepository.updateCallCount).toBe(updateCallCount);
  });

  it('selects purchase-confirmed family-only evidence without inventing a supplier product', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setReplenishmentTarget({
      familyId: String(family.id),
      companyProductId: 'company-product-a',
      source: 'automatic',
    });

    for (const order of [
      { id: 'order-confirmed-line-10', supplierId: 'supplier-1', orderDate: '2026-06-01' },
      { id: 'order-confirmed-line-20', supplierId: 'supplier-2', orderDate: '2026-06-01' },
      { id: 'order-newer-unconfirmed', supplierId: 'supplier-1', orderDate: '2026-07-01' },
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
        values: {
          ...order,
          companyId: 'company-1',
          orderRef: order.id,
          canonicalStatus: 'paid',
          authorityStatus: 'clickup_authoritative',
        },
      });
    }
    for (const line of [
      { id: 'line-confirmed-10', orderId: 'order-confirmed-line-10', sourceEvidenceJson: { sourceRowNumber: 10 } },
      { id: 'line-confirmed-20', orderId: 'order-confirmed-line-20', sourceEvidenceJson: { sourceRowNumber: 20 } },
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
        values: {
          ...line,
          companyProductFamilyId: family.id,
          mappingScope: 'family_only',
          productMappingStatus: 'family_only',
          purchaseEvidenceStatus: 'confirmed',
          sourceLineKey: line.id,
          sourceAsin: 'B000FAMILY',
          orderedQty: 1,
        },
      });
    }
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-newer-unconfirmed',
        orderId: 'order-newer-unconfirmed',
        companyProductId: 'company-product-a',
        supplierProductId: 'supplier-product-a',
        mappingScope: 'exact_member',
        productMappingStatus: 'exact_member',
        purchaseEvidenceStatus: 'unconfirmed_workflow',
        sourceRowNumber: 30,
        orderedQty: 1,
      },
    });

    await expect(service.reconcileFamily(String(family.id))).resolves.toMatchObject({
      preferredSupplierId: 'supplier-2',
      preferredSupplierProductId: undefined,
      supplierSelectionSource: 'latest_valid_order',
      supplierReviewRequired: false,
      supplierSelectionEvidenceJson: {
        sourceLineId: 'line-confirmed-20',
        sourceLineNumber: 20,
        mappingScope: 'family_only',
        purchaseEvidenceStatus: 'confirmed',
        matchType: 'family_only',
        selectionRule: 'purchase_confirmed_then_latest_order_date_then_latest_source_line',
      },
    });
  });

  it('excludes every non-operational preferred-supplier evidence class', async () => {
    const cases = [
      {
        name: 'unresolved mapping',
        line: { productMappingStatus: 'unresolved' },
        reason: 'supplier_order_product_mapping_unresolved',
      },
      { name: 'nonpositive quantity', line: { orderedQty: 0 }, reason: 'supplier_order_quantity_nonpositive' },
      { name: 'company mismatch', order: { companyId: 'company-2' }, reason: 'companyless_supplier_order_evidence' },
      {
        name: 'unresolved authority',
        order: { authorityStatus: 'unresolved' },
        reason: 'supplier_order_authority_unresolved',
      },
      {
        name: 'provisional authority',
        order: { authorityStatus: 'provisional' },
        reason: 'supplier_order_authority_unresolved',
      },
      { name: 'cancelled status', order: { canonicalStatus: 'cancelled' }, reason: 'supplier_order_lifecycle_invalid' },
      { name: 'rejected status', order: { canonicalStatus: 'rejected' }, reason: 'supplier_order_lifecycle_invalid' },
      { name: 'draft status', order: { canonicalStatus: 'draft' }, reason: 'supplier_order_lifecycle_invalid' },
      {
        name: 'analysis-only intent',
        order: { orderIntent: 'analysis-only' },
        reason: 'supplier_order_lifecycle_invalid',
      },
      {
        name: 'missing supplier',
        order: { supplierId: 'supplier-missing' },
        reason: 'supplier_order_supplier_missing',
      },
      {
        name: 'missing supplier product',
        line: { supplierProductId: 'supplier-product-missing' },
        reason: 'supplier_order_supplier_product_missing',
      },
      { name: 'invalid order date', order: { orderDate: 'not-a-date' }, reason: 'supplier_order_date_missing' },
    ];

    for (const testCase of cases) {
      const db = new MemoryDatabase();
      await seed(db);
      const service = new EcobaseCompanyProductFamilyService(db);
      const family = await service.ensureFamily(identity);
      await service.setReplenishmentTarget({
        familyId: String(family.id),
        companyProductId: 'company-product-a',
        source: 'automatic',
      });
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
        values: {
          id: `order-${testCase.name}`,
          companyId: 'company-1',
          supplierId: 'supplier-1',
          orderRef: `REF-${testCase.name}`,
          orderDate: '2026-07-01',
          canonicalStatus: 'paid',
          authorityStatus: 'clickup_authoritative',
          ...testCase.order,
        },
      });
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
        values: {
          id: `line-${testCase.name}`,
          orderId: `order-${testCase.name}`,
          companyProductId: 'company-product-a',
          supplierProductId: 'supplier-product-a',
          orderedQty: 1,
          productMappingStatus: 'resolved',
          ...testCase.line,
        },
      });

      const reconciled = await service.reconcileFamily(String(family.id));
      expect(reconciled.preferredSupplierId, testCase.name).toBeUndefined();
      expect(reconciled, testCase.name).toMatchObject({
        supplierReviewRequired: true,
        supplierSelectionEvidenceJson: { reviewReason: testCase.reason },
      });
    }
  });

  it('preserves an operator supplier and marks conflicting or companyless evidence for review', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setPreferredSupplierOffer({
      familyId: family.id as string,
      supplierId: 'supplier-1',
      supplierProductId: 'supplier-product-a',
      source: 'operator',
      actorUserId: '102',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-companyless',
        supplierId: 'supplier-2',
        orderRef: 'EF1003A',
        orderDate: '2026-07-02',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-companyless',
        orderId: 'order-companyless',
        companyProductId: 'company-product-b',
        supplierProductId: 'supplier-product-b',
      },
    });

    const reconciled = await service.reconcileFamily(family.id as string);

    expect(reconciled).toMatchObject({
      preferredSupplierId: 'supplier-1',
      supplierSelectionSource: 'operator',
      supplierReviewRequired: true,
      supplierSelectionEvidenceJson: {
        reviewReason: 'companyless_supplier_order_evidence',
        sourceOrderRef: 'EF1003A',
        sourceSku: 'SKU-B',
      },
    });
  });

  it('operator supplier assignment writes the target member preferred link for gold (Batch B2)', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setReplenishmentTarget({
      familyId: String(family.id),
      companyProductId: 'company-product-a',
      source: 'operator',
      actorUserId: '102',
      reason: 'freeze target',
    });
    // supplier-2 has no supplier product for product-a: a minimal one must be created.
    await service.setPreferredSupplierOffer({
      familyId: String(family.id),
      supplierId: 'supplier-2',
      source: 'operator',
      actorUserId: '102',
      reason: 'operator pick',
    });

    const createdOffers = await db
      .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
      .find({ filter: { supplierId: 'supplier-2', productId: 'product-a' } });
    expect(createdOffers).toHaveLength(1);
    expect(createdOffers[0]).toMatchObject({ analysisStatus: 'operator_assigned' });
    const links = await db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers)
      .find({ filter: { companyProductId: 'company-product-a', role: 'preferred' } });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      supplierProductId: createdOffers[0].id,
      role: 'preferred',
      sourceEvidence: { source: 'operator_supplier_assignment', reason: 'operator pick', actorUserId: '102' },
    });

    // Re-assigning to a supplier with an existing offer reuses it and updates the link in place.
    await service.setPreferredSupplierOffer({
      familyId: String(family.id),
      supplierId: 'supplier-1',
      supplierProductId: 'supplier-product-a',
      source: 'operator',
      actorUserId: '102',
      reason: 'switch back',
    });
    const updatedLinks = await db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers)
      .find({ filter: { companyProductId: 'company-product-a', role: 'preferred' } });
    expect(updatedLinks).toHaveLength(1);
    expect(updatedLinks[0]).toMatchObject({
      supplierProductId: 'supplier-product-a',
      sourceEvidence: { reason: 'switch back' },
    });
  });

  it('preserves an operator supplier and reviews a different latest valid supplier', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setPreferredSupplierOffer({
      familyId: String(family.id),
      supplierId: 'supplier-1',
      supplierProductId: 'supplier-product-a',
      source: 'operator',
      actorUserId: '102',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-operator-conflict',
        companyId: 'company-1',
        supplierId: 'supplier-2',
        orderRef: 'EF1004A',
        orderDate: '2026-07-03',
        canonicalStatus: 'paid',
        authorityStatus: 'clickup_authoritative',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-operator-conflict',
        orderId: 'order-operator-conflict',
        companyProductId: 'company-product-b',
        supplierProductId: 'supplier-product-b',
        orderedQty: 1,
        productMappingStatus: 'resolved',
      },
    });

    await expect(service.reconcileFamily(String(family.id))).resolves.toMatchObject({
      preferredSupplierId: 'supplier-1',
      supplierSelectionSource: 'operator',
      supplierReviewRequired: true,
      supplierSelectionEvidenceJson: {
        recommendedSupplierId: 'supplier-2',
        reviewReason: 'operator_supplier_differs_from_latest_order',
      },
    });
  });

  it('rejects an operator supplier outside the family company boundary', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-foreign', displayName: 'Foreign supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).create({
      values: { id: 'supplier-foreign-account', supplierId: 'supplier-foreign', companyId: 'company-2' },
    });

    await expect(
      service.setPreferredSupplierOffer({
        familyId: family.id as string,
        supplierId: 'supplier-foreign',
        source: 'operator',
        actorUserId: '102',
        reason: 'Test boundary.',
      }),
    ).rejects.toThrow('does not belong to family company "company-1"');
  });

  it('audits an operator target and prevents automatic reruns from overwriting it', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);

    const selected = await service.setReplenishmentTarget({
      familyId: family.id as string,
      companyProductId: 'company-product-b',
      source: 'operator',
      actorUserId: '102',
      reason: 'Primary replenishment listing confirmed.',
    });
    const preserved = await service.setReplenishmentTarget({
      familyId: family.id as string,
      companyProductId: 'company-product-a',
      source: 'automatic',
    });

    expect(selected).toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetSelectionSource: 'operator',
      targetSelectedByUserId: '102',
      targetSelectedAt: expect.any(String),
      targetSelectionEvidenceJson: {
        reason: 'Primary replenishment listing confirmed.',
        actorUserId: '102',
        selectedAt: expect.any(String),
      },
    });
    expect(preserved).toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetSelectionSource: 'operator',
    });
  });

  it('persists an operator preferred supplier and prevents automatic overwrite', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);

    const selected = await service.setPreferredSupplierOffer({
      familyId: family.id,
      supplierId: 'supplier-1',
      supplierProductId: 'supplier-product-a',
      source: 'operator',
      actorUserId: '102',
      reason: 'Primary supplier confirmed by operator.',
    });
    const preserved = await service.setPreferredSupplierOffer({
      familyId: family.id,
      supplierId: 'supplier-2',
      source: 'latest_valid_order',
    });

    expect(selected).toMatchObject({
      preferredSupplierId: 'supplier-1',
      preferredSupplierProductId: 'supplier-product-a',
      supplierSelectionSource: 'operator',
      supplierSelectedByUserId: '102',
      supplierSelectedAt: expect.any(String),
      supplierSelectionEvidenceJson: {
        reason: 'Primary supplier confirmed by operator.',
        actorUserId: '102',
        selectedAt: expect.any(String),
      },
    });
    expect(preserved).toMatchObject({
      preferredSupplierId: 'supplier-1',
      supplierSelectionSource: 'operator',
      supplierSelectionEvidenceJson: { reason: 'Primary supplier confirmed by operator.' },
    });
  });

  it('preserves family-level historical evidence without a product offer or current order', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setPreferredSupplierOffer({
      familyId: String(family.id),
      supplierId: 'supplier-1',
      source: 'historical_order_evidence',
      evidence: { ruleVersion: 'supplier-evidence-v1', supplierExternalRef: 'SRO-1' },
    });

    const reconciled = await service.reconcileFamily(String(family.id));
    const lowerAuthorityAttempt = await service.setPreferredSupplierOffer({
      familyId: String(family.id),
      supplierId: 'supplier-2',
      source: 'supplier_2026_approved_active',
    });

    expect(reconciled).toMatchObject({
      preferredSupplierId: 'supplier-1',
      preferredSupplierProductId: undefined,
      supplierSelectionSource: 'historical_order_evidence',
      supplierReviewRequired: false,
    });
    expect(lowerAuthorityAttempt).toMatchObject({
      preferredSupplierId: 'supplier-1',
      supplierSelectionSource: 'historical_order_evidence',
    });
  });

  it('allows a valid current order to supersede historical supplier evidence', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setPreferredSupplierOffer({
      familyId: String(family.id),
      supplierId: 'supplier-1',
      source: 'historical_order_evidence',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-current-over-history',
        companyId: 'company-1',
        supplierId: 'supplier-2',
        orderRef: 'EF-CURRENT',
        orderDate: '2026-07-14',
        canonicalStatus: 'paid',
        authorityStatus: 'clickup_authoritative',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-current-over-history',
        orderId: 'order-current-over-history',
        companyProductId: 'company-product-b',
        supplierProductId: 'supplier-product-b',
        orderedQty: 1,
        productMappingStatus: 'resolved',
      },
    });

    await expect(service.reconcileFamily(String(family.id))).resolves.toMatchObject({
      preferredSupplierId: 'supplier-2',
      preferredSupplierProductId: 'supplier-product-b',
      supplierSelectionSource: 'latest_valid_order',
    });
  });

  it('trusts explicit family membership for alternate child ASINs', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
      filterByTk: 'company-product-other-asin',
      values: { companyProductFamilyId: family.id },
    });

    await expect(service.listMembers(String(family.id))).resolves.toEqual([
      expect.objectContaining({ id: 'company-product-other-asin', asin: 'B000OTHER' }),
    ]);
  });

  it('corrects an automatic target to the clear highest current planning stock and then converges', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setReplenishmentTarget({
      familyId: String(family.id),
      companyProductId: 'company-product-a',
      source: 'automatic',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: { id: 'snapshot-a', companyProductId: 'company-product-a', snapshotDate: '2026-07-14', sellableStock: 1 },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snapshot-b',
        companyProductId: 'company-product-b',
        snapshotDate: '2026-07-14',
        sellableStock: 10,
        reserved: 2,
      },
    });

    const preview = await service.previewAutomaticTargetCorrections();
    expect(preview).toMatchObject({ correctionCount: 1, operatorPreservedCount: 0, stagingWrites: 0 });
    await expect(
      service.applyAutomaticTargetCorrections({
        decisionDigest: preview.decisionDigest,
        confirmation: `APPLY_FAMILY_TARGETS_${preview.decisionDigest.slice(0, 12).toUpperCase()}`,
      }),
    ).resolves.toMatchObject({ changedCount: 1, goldRefreshCount: 0 });
    await expect(service.getFamily(String(family.id))).resolves.toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetSelectionSource: 'automatic',
      targetSelectionEvidenceJson: { ruleVersion: 'highest-current-planning-stock-v1' },
    });
    await expect(service.verifyAutomaticTargetCorrections()).resolves.toMatchObject({
      idempotent: true,
      correctionCount: 0,
    });
  });

  it('selects the tiered member over a higher-stock untiered member for target-less families (task 003)', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    // No persisted target. Gold published run: member A untiered with stock,
    // member B tier B with ZERO stock — tiered-first must pick B.
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).create({
      values: { id: 'run-1', status: 'published', publishedAt: '2026-07-22T00:00:00.000Z' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'gold-a',
        refreshRunId: 'run-1',
        companyProductId: 'company-product-a',
        currentProjectedTier: null,
        baselineTier: null,
        currentPlanningStock: 50,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'gold-b',
        refreshRunId: 'run-1',
        companyProductId: 'company-product-b',
        currentProjectedTier: 'B',
        baselineTier: 'C',
        currentPlanningStock: 0,
        currentProjectedTierScore: 120,
      },
    });

    const preview = await service.previewAutomaticTargetCorrections();
    expect(preview.correctionCount).toBeGreaterThanOrEqual(1);
    await service.applyAutomaticTargetCorrections({
      decisionDigest: preview.decisionDigest,
      confirmation: `APPLY_FAMILY_TARGETS_${preview.decisionDigest.slice(0, 12).toUpperCase()}`,
    });
    await expect(service.getFamily(String(family.id))).resolves.toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetSelectionSource: 'automatic',
      targetSelectionEvidenceJson: {
        selectionRule: 'tiered_first_migration_rule',
        ruleVersion: 'tiered-first-migration-v1',
        selectedTier: 'B',
      },
    });
  });

  it('qualifies tier-D members when no A/B/C exists and breaks ties by tier score (task 003 rule 4)', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).create({
      values: { id: 'run-1', status: 'published', publishedAt: '2026-07-22T00:00:00.000Z' },
    });
    // Both members tier D, zero stock everywhere; higher tier score wins.
    for (const [id, companyProductId, score] of [
      ['gold-a', 'company-product-a', 0.4],
      ['gold-b', 'company-product-b', 0.9],
    ] as const) {
      await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
        values: {
          id,
          refreshRunId: 'run-1',
          companyProductId,
          currentProjectedTier: 'D',
          currentPlanningStock: 0,
          currentProjectedTierScore: score,
        },
      });
    }
    const preview = await service.previewAutomaticTargetCorrections();
    await service.applyAutomaticTargetCorrections({
      decisionDigest: preview.decisionDigest,
      confirmation: `APPLY_FAMILY_TARGETS_${preview.decisionDigest.slice(0, 12).toUpperCase()}`,
    });
    await expect(service.getFamily(String(family.id))).resolves.toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      targetSelectionEvidenceJson: { selectionRule: 'tiered_first_migration_rule_tier_d' },
    });
  });

  it('leaves families with no tiered member in review and never touches operator targets (task 003 rule 5)', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await service.setReplenishmentTarget({
      familyId: String(family.id),
      companyProductId: 'company-product-a',
      source: 'operator',
      actorUserId: 'user-1',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).create({
      values: { id: 'run-1', status: 'published', publishedAt: '2026-07-22T00:00:00.000Z' },
    });
    const preview = await service.previewAutomaticTargetCorrections();
    expect(preview.operatorPreservedCount).toBeGreaterThanOrEqual(1);
    // The other family (other-asin) has no tiered member -> review, no correction targeting it.
    const otherFamilyCorrections = preview.corrections.filter(
      (correction) => correction.familyId !== String(family.id),
    );
    expect(otherFamilyCorrections).toHaveLength(0);
    await expect(service.getFamily(String(family.id))).resolves.toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-a',
      targetSelectionSource: 'operator',
    });
  });

  it('re-points the preferred supplier when the target changes, without a reconcile pass (task 004 follows-target)', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const service = new EcobaseCompanyProductFamilyService(db);
    const family = await service.ensureFamily(identity);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-1',
        supplierId: 'supplier-2',
        orderRef: 'EF1002A',
        orderDate: '2026-07-01',
        companyId: 'company-1',
        canonicalStatus: 'paid',
        authorityStatus: 'clickup_authoritative',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-1',
        orderId: 'order-1',
        companyProductId: 'company-product-b',
        supplierProductId: 'supplier-product-b',
        productMappingStatus: 'resolved',
        orderedQty: 1,
      },
    });

    // Setting the target ALONE (the operator flow) must re-point the supplier
    // offer with target-aware evidence — no separate reconcile call.
    const updated = await service.setReplenishmentTarget({
      familyId: family.id as string,
      companyProductId: 'company-product-b',
      source: 'operator',
      actorUserId: 'user-1',
      reason: 'switching target',
    });
    expect(updated).toMatchObject({
      replenishmentTargetCompanyProductId: 'company-product-b',
      preferredSupplierId: 'supplier-2',
      preferredSupplierProductId: 'supplier-product-b',
      supplierSelectionSource: 'latest_valid_order',
      supplierSelectionEvidenceJson: { matchType: 'exact_target_sku' },
    });
  });
});
