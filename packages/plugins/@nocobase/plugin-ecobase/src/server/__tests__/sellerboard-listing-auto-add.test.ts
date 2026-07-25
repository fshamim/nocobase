/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import {
  EcobaseSellerboardListingAutoAdd,
  SELLERBOARD_AUTO_ADD_PROVENANCE_KIND,
} from '../../features/source-import/server/sellerboard-listing-auto-add';
import type { NewSellerboardListing } from '../../features/source-import/server/protected-catalog-boundary';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type PlainRecord = Record<string, unknown>;

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private readonly records: PlainRecord[] = []) {}

  async find(params: { filter?: PlainRecord; filterByTk?: string | number; limit?: number } = {}) {
    return this.match(params).slice(0, params.limit ?? Infinity);
  }

  async findOne(params: { filter?: PlainRecord; filterByTk?: string | number } = {}) {
    return this.match(params)[0] ?? null;
  }

  async create({ values }: { values: PlainRecord }) {
    const created = { ...values, id: values.id ?? `record-${this.sequence++}` };
    this.records.push(created);
    return created;
  }

  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: PlainRecord;
    filterByTk?: string | number;
    values: PlainRecord;
  }) {
    const matches = this.match({ filter, filterByTk });
    matches.forEach((item) => Object.assign(item, values));
    return matches[0] ?? null;
  }

  all() {
    return this.records;
  }

  private match(params: { filter?: PlainRecord; filterByTk?: string | number }) {
    if (params.filterByTk !== undefined) return this.records.filter((item) => item.id === params.filterByTk);
    return this.records.filter((item) =>
      Object.entries(params.filter ?? {}).every(([key, value]) => item[key] === value),
    );
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor(seeds: Record<string, PlainRecord[]> = {}) {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) =>
      this.repositories.set(name, new MemoryRepository(seeds[name] ?? [])),
    );
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Missing memory repository ${name}.`);
    return repository;
  }
}

function seededDatabase(seeds: Record<string, PlainRecord[]> = {}) {
  return new MemoryDatabase({
    [ECOBASE_COLLECTIONS.silverCompanies]: [{ id: 'company-0', companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' }],
    [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
      { id: 'account-0', companyId: 'company-0', marketplace: 'Amazon.com', isDefault: true },
    ],
    ...seeds,
  });
}

const listing: NewSellerboardListing = {
  companyId: 'company-0',
  company: 'Ecofission LLC',
  amazonAccountId: 'account-0',
  marketplace: 'Amazon.com',
  asin: 'B999999999',
  listingSku: 'NEW-SKU',
  title: 'Widget Deluxe',
};

const counts = (db: MemoryDatabase) => ({
  products: (db.getRepository(ECOBASE_COLLECTIONS.silverProducts) as MemoryRepository).all().length,
  companyProducts: (db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts) as MemoryRepository).all().length,
  families: (db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies) as MemoryRepository).all().length,
});

describe('EcobaseSellerboardListingAutoAdd', () => {
  it('creates the product, company product, single-member family, and family link for a new listing', async () => {
    const db = seededDatabase();
    const added = await new EcobaseSellerboardListingAutoAdd(db).addListing(listing);

    expect(added).toEqual({
      company: 'Ecofission LLC',
      asin: 'B999999999',
      sku: 'NEW-SKU',
      marketplace: 'Amazon.com',
      title: 'Widget Deluxe',
    });
    expect(counts(db)).toEqual({ products: 1, companyProducts: 1, families: 1 });

    const product = (db.getRepository(ECOBASE_COLLECTIONS.silverProducts) as MemoryRepository).all()[0];
    expect(product).toMatchObject({ asin: 'B999999999', sku: 'NEW-SKU', title: 'Widget Deluxe' });

    const family = (db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies) as MemoryRepository).all()[0];
    expect(family).toMatchObject({
      companyId: 'company-0',
      amazonAccountId: 'account-0',
      marketplace: 'amazon.com',
      canonicalAsin: 'B999999999',
    });

    const companyProduct = (db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts) as MemoryRepository).all()[0];
    expect(companyProduct).toMatchObject({
      companyId: 'company-0',
      amazonAccountId: 'account-0',
      productId: product.id,
      companyProductFamilyId: family.id,
      lifecycleStatus: 'active',
      listingStatus: 'listed',
      lifecycleStatusProvenance: { kind: SELLERBOARD_AUTO_ADD_PROVENANCE_KIND },
    });
  });

  it('is idempotent: adding the same listing twice creates exactly one record set', async () => {
    const db = seededDatabase();
    const autoAdd = new EcobaseSellerboardListingAutoAdd(db);
    await autoAdd.addListing(listing);
    await autoAdd.addListing(listing);
    expect(counts(db)).toEqual({ products: 1, companyProducts: 1, families: 1 });
  });

  it('reuses an existing product for the same ASIN/SKU instead of creating a duplicate', async () => {
    const db = seededDatabase({
      [ECOBASE_COLLECTIONS.silverProducts]: [{ id: 'prod-existing', asin: 'B999999999', sku: 'NEW-SKU' }],
    });
    await new EcobaseSellerboardListingAutoAdd(db).addListing(listing);
    expect(counts(db)).toEqual({ products: 1, companyProducts: 1, families: 1 });
    const companyProduct = (db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts) as MemoryRepository).all()[0];
    expect(companyProduct.productId).toBe('prod-existing');
  });

  it('attaches to the company existing family for that ASIN instead of creating a new one', async () => {
    const db = seededDatabase({
      [ECOBASE_COLLECTIONS.silverCompanyProductFamilies]: [
        {
          id: 'fam-existing',
          companyId: 'company-0',
          amazonAccountId: 'account-0',
          marketplace: 'amazon.com',
          canonicalAsin: 'B999999999',
        },
      ],
    });
    await new EcobaseSellerboardListingAutoAdd(db).addListing(listing);
    expect(counts(db)).toEqual({ products: 1, companyProducts: 1, families: 1 });
    const companyProduct = (db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts) as MemoryRepository).all()[0];
    expect(companyProduct.companyProductFamilyId).toBe('fam-existing');
  });
});
