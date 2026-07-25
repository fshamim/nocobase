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
import { EcobaseProtectedCatalogBoundary } from '../../features/source-import/server/protected-catalog-boundary';

class Repository implements EcobaseRepository {
  constructor(public rows: Record<string, unknown>[] = []) {}
  async find(params?: { limit?: number }) {
    return this.rows.slice(0, params?.limit ?? this.rows.length);
  }
  async findOne() {
    return null;
  }
  async create() {
    throw new Error('Protected catalog test repository is read-only.');
  }
  async update() {
    throw new Error('Protected catalog test repository is read-only.');
  }
}

class Database implements EcobaseDatabase {
  repositories = new Map<string, Repository>();
  getRepository(name: string) {
    const repository = this.repositories.get(name) ?? new Repository();
    this.repositories.set(name, repository);
    return repository;
  }
}

function seedCatalog() {
  const db = new Database();
  const companies = [
    { id: 'company-0', companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' },
    { id: 'company-1', companyKey: 'MUXTEX_INC', name: 'Muxtex INC' },
    { id: 'company-2', companyKey: 'RETAIL_HEAVEN_INC', name: 'Retail Heaven Inc' },
    { id: 'company-3', companyKey: 'STOP_SHOP_LLC', name: 'Stop Shop LLC' },
  ];
  const amazonAccounts = Array.from({ length: 10 }, (_, index) => ({
    id: `account-${index}`,
    companyId: `company-${index % 4}`,
    name: `Account ${index}`,
    marketplace: index === 0 ? 'Amazon.com' : `Marketplace ${index}`,
    isDefault: true,
  }));
  const products = Array.from({ length: 2363 }, (_, index) => ({
    id: `product-${index}`,
    asin: index === 0 ? 'B000000001' : `B${String(index).padStart(9, '0')}`,
    sku: `SKU-${index}`,
  }));
  const productFamilies = Array.from({ length: 1919 }, (_, index) => ({
    id: `family-${index}`,
    companyId: `company-${index % 4}`,
    amazonAccountId: `account-${index % 10}`,
    marketplace: index === 0 ? 'Amazon.com' : `Marketplace ${index % 10}`,
    canonicalAsin: products[index].asin,
  }));
  const companyProducts = products.map((product, index) => ({
    id: `company-product-${index}`,
    companyId: `company-${index % 4}`,
    amazonAccountId: `account-${index % 10}`,
    productId: product.id,
    companyProductFamilyId: `family-${index % 1919}`,
  }));
  db.repositories.set(ECOBASE_COLLECTIONS.silverCompanies, new Repository(companies));
  db.repositories.set(ECOBASE_COLLECTIONS.silverAmazonAccounts, new Repository(amazonAccounts));
  db.repositories.set(ECOBASE_COLLECTIONS.silverProducts, new Repository(products));
  db.repositories.set(ECOBASE_COLLECTIONS.silverCompanyProducts, new Repository(companyProducts));
  db.repositories.set(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, new Repository(productFamilies));
  return db;
}

describe('EcobaseProtectedCatalogBoundary', () => {
  it('accepts the protected baseline and reports the exact known drift', async () => {
    const db = seedCatalog();
    const baseline = await new EcobaseProtectedCatalogBoundary(db).assertReadyForRefresh();
    expect(baseline).toMatchObject({
      readyForRefresh: true,
      actualCounts: { companies: 4, amazonAccounts: 10, companyProducts: 2363, productFamilies: 1919 },
      drift: { companies: 0, amazonAccounts: 0, companyProducts: 0, productFamilies: 0 },
    });

    const accounts = db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).rows;
    const companyProducts = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows;
    const families = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).rows;
    accounts.push({ id: 'drift-account' });
    companyProducts.push({ id: 'drift-product' });
    families.push({ id: 'drift-family' });

    const drift = await new EcobaseProtectedCatalogBoundary(db).inspect();
    expect(drift).toMatchObject({
      readyForRefresh: false,
      actualCounts: { companies: 4, amazonAccounts: 11, companyProducts: 2364, productFamilies: 1920 },
      drift: { companies: 0, amazonAccounts: 1, companyProducts: 1, productFamilies: 1 },
    });
  });

  it('passes through a protected Sellerboard identity untouched', async () => {
    const boundary = new EcobaseProtectedCatalogBoundary(seedCatalog());
    await expect(
      boundary.classifySellerboardIdentity({
        company: 'Ecofission LLC',
        marketplace: 'Amazon.com',
        asin: 'B000000001',
        listingSku: 'SKU-0',
      }),
    ).resolves.toEqual({ kind: 'known' });
  });

  it('treats a known company + valid unknown identity as a new listing to auto-add', async () => {
    const boundary = new EcobaseProtectedCatalogBoundary(seedCatalog());
    await expect(
      boundary.classifySellerboardIdentity({
        company: 'Ecofission LLC',
        marketplace: 'Amazon.com',
        asin: 'B999999999',
        listingSku: 'NEW-SKU',
        title: 'Widget Deluxe',
      }),
    ).resolves.toEqual({
      kind: 'new_listing',
      listing: {
        companyId: 'company-0',
        company: 'Ecofission LLC',
        amazonAccountId: 'account-0',
        marketplace: 'Amazon.com',
        asin: 'B999999999',
        listingSku: 'NEW-SKU',
        title: 'Widget Deluxe',
      },
    });
  });

  it('quarantines a genuinely malformed row (invalid ASIN shape / missing SKU)', async () => {
    const boundary = new EcobaseProtectedCatalogBoundary(seedCatalog());
    await expect(
      boundary.classifySellerboardIdentity({
        company: 'Ecofission LLC',
        marketplace: 'Amazon.com',
        asin: 'BADASIN',
        listingSku: 'NEW-SKU',
      }),
    ).resolves.toEqual({
      kind: 'malformed',
      quarantine: {
        company: 'Ecofission LLC',
        marketplace: 'Amazon.com',
        asin: 'BADASIN',
        listingSku: 'NEW-SKU',
        missing: ['product', 'company product'],
        reasonCode: 'protected_company_product_identity',
      },
    });
    await expect(
      boundary.classifySellerboardIdentity({
        company: 'Ecofission LLC',
        marketplace: 'Amazon.com',
        asin: 'B999999999',
      }),
    ).resolves.toMatchObject({ kind: 'malformed', quarantine: { missing: ['product', 'company product'] } });
  });

  it('quarantines a row for a company outside the canonical four instead of throwing', async () => {
    const boundary = new EcobaseProtectedCatalogBoundary(seedCatalog());
    await expect(
      boundary.classifySellerboardIdentity({
        company: 'Not A Real Company',
        marketplace: 'Amazon.com',
        asin: 'B000000001',
        listingSku: 'SKU-0',
      }),
    ).resolves.toEqual({
      kind: 'malformed',
      quarantine: {
        company: 'Not A Real Company',
        marketplace: 'Amazon.com',
        asin: 'B000000001',
        listingSku: 'SKU-0',
        missing: ['company', 'amazon account', 'product', 'company product'],
        reasonCode: 'protected_company_product_identity',
      },
    });
  });
});
