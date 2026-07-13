/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { EcobaseCompanyProductFamilyService } from '../../features/inventory-planning/server/company-product-family-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Row = Record<string, any>;

function matches(row: Row, filter: Row = {}) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository implements EcobaseRepository {
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
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-b',
      companyId: 'company-1',
      amazonAccountId: 'account-us',
      productId: 'product-b',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-other-account',
      companyId: 'company-1',
      amazonAccountId: 'account-ca',
      productId: 'product-a',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-other-asin',
      companyId: 'company-1',
      amazonAccountId: 'account-us',
      productId: 'product-other',
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
  it('resolves exact SKU before a governed family target and preserves source-SKU evidence', async () => {
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
        companyProductId: 'company-product-b',
        resolution: 'family_target',
        sourceSku,
        boundary: { amazonAccountId: 'account-us', marketplace: 'amazon.com' },
      });
    }
  });

  it('excludes missing, multiple, cross-boundary, review-flagged, missing, and stale targets', async () => {
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

    const familyRepo = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies);
    await familyRepo.update({ filterByTk: String(family.id), values: { targetReviewRequired: true } });
    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'ALIAS',
        marketplace: 'Amazon.com',
      }),
    ).resolves.toMatchObject({ exclusionReason: 'target_review_required' });

    await familyRepo.update({
      filterByTk: String(family.id),
      values: { targetReviewRequired: false, replenishmentTargetCompanyProductId: null },
    });
    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'ALIAS',
        marketplace: 'Amazon.com',
      }),
    ).resolves.toMatchObject({ exclusionReason: 'target_missing' });

    await familyRepo.update({
      filterByTk: String(family.id),
      values: { replenishmentTargetCompanyProductId: 'company-product-other-account' },
    });
    await expect(
      service.resolveCompanyProduct({
        companyId: 'company-1',
        asin: 'B000FAMILY',
        sku: 'ALIAS',
        marketplace: 'Amazon.com',
      }),
    ).resolves.toMatchObject({ exclusionReason: 'target_not_member' });
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

    const result = await new EcobaseCompanyProductFamilyService(db).reconcileAllFamilies();

    expect(result.familyCount).toBe(3);
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

  it('selects the latest valid supplier order and preserves source SKU evidence', async () => {
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
        values: { ...order, companyId: 'company-1' },
      });
    }
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-old',
        orderId: 'order-old',
        companyProductId: 'company-product-a',
        supplierProductId: 'supplier-product-a',
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
      },
    });

    const reconciled = await service.reconcileFamily(family.id as string);

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
});
