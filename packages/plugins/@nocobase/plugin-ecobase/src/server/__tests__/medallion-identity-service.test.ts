import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import {
  EcobaseMedallionIdentityService,
  normalizeCompanyKey,
  normalizeSupplierName,
} from '../services/medallion-identity-service';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { toPlainRecord } from '../services/import-service';

class FakeRepository implements EcobaseRepository {
  rows: Record<string, unknown>[] = [];

  async find(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.filter((row) => matches(row, params));
  }

  async findOne(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.find((row) => matches(row, params)) ?? null;
  }

  async create(params: { values: Record<string, unknown> }) {
    this.rows.push({ ...params.values });
    return this.rows[this.rows.length - 1];
  }

  async update(params: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    this.rows = this.rows.map((row) => (matches(row, params) ? { ...row, ...params.values } : row));
    return this.rows.filter((row) => matches(row, params));
  }
}

class FakeDatabase implements EcobaseDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

function matches(
  row: Record<string, unknown>,
  params?: { filter?: Record<string, unknown>; filterByTk?: string | number },
) {
  if (params?.filterByTk !== undefined && row.id !== params.filterByTk) return false;
  return Object.entries(params?.filter ?? {}).every(([key, value]) => row[key] === value);
}

function idOf(record: unknown) {
  const id = toPlainRecord(record).id;
  if (typeof id !== 'string') throw new Error('Expected fake record to have a string id.');
  return id;
}

describe('EcobaseMedallionIdentityService', () => {
  it('validates company keys', () => {
    expect(normalizeCompanyKey(' sample_1 ')).toBe('SAMPLE_1');
    expect(() => normalizeCompanyKey('bad key')).toThrow(/companyKey/);
  });

  it('keeps product identity unique and locks ASIN/SKU edits after draft', async () => {
    const service = new EcobaseMedallionIdentityService(new FakeDatabase());
    const product = await service.upsertProduct({ asin: 'B001', sku: 'SKU-1', title: 'First' });
    const sameProduct = await service.upsertProduct({ asin: 'B001', sku: 'SKU-1', title: 'Updated' });

    expect(idOf(sameProduct)).toBe(idOf(product));
    expect(toPlainRecord(sameProduct).title).toBe('Updated');

    await service.upsertProduct({ asin: 'B002', sku: 'SKU-2' });
    await expect(
      service.updateDraftProductIdentity({ productId: idOf(product), asin: 'B002', sku: 'SKU-2' }),
    ).rejects.toThrow(/already exists/);

    const active = await service.upsertProduct({ asin: 'B003', sku: 'SKU-3', lifecycleStatus: 'active' });
    await expect(
      service.updateDraftProductIdentity({ productId: idOf(active), asin: 'B004', sku: 'SKU-4' }),
    ).rejects.toThrow(/only be edited while lifecycleStatus is draft/);
  });

  it('upserts default Amazon accounts and company products by identity', async () => {
    const service = new EcobaseMedallionIdentityService(new FakeDatabase());
    const company = await service.upsertCompany({ companyKey: 'SAM', name: 'SampleAM' });
    const product = await service.upsertProduct({ asin: 'B001', sku: 'SKU-1' });
    const account = await service.ensureDefaultAmazonAccount({ companyId: idOf(company), marketplace: 'US' });
    const sameAccount = await service.ensureDefaultAmazonAccount({ companyId: idOf(company), marketplace: 'US' });
    const companyProduct = await service.upsertCompanyProduct({
      companyId: idOf(company),
      amazonAccountId: idOf(account),
      productId: idOf(product),
    });
    const sameCompanyProduct = await service.upsertCompanyProduct({
      companyId: idOf(company),
      amazonAccountId: idOf(account),
      productId: idOf(product),
      lifecycleStatus: 'active_selling',
    });

    expect(idOf(sameAccount)).toBe(idOf(account));
    expect(idOf(sameCompanyProduct)).toBe(idOf(companyProduct));
    expect(toPlainRecord(sameCompanyProduct).lifecycleStatus).toBe('active_selling');
  });

  it('normalizes suppliers and upserts supplier product links by role', async () => {
    const service = new EcobaseMedallionIdentityService(new FakeDatabase());
    const company = await service.upsertCompany({ companyKey: 'SAM', name: 'SampleAM' });
    const product = await service.upsertProduct({ asin: 'B001', sku: 'SKU-1' });
    const account = await service.ensureDefaultAmazonAccount({ companyId: idOf(company), marketplace: 'US' });
    const companyProduct = await service.upsertCompanyProduct({
      companyId: idOf(company),
      amazonAccountId: idOf(account),
      productId: idOf(product),
    });

    expect(normalizeSupplierName(' ACME, Inc. ')).toBe('acme inc');
    expect(() => normalizeSupplierName('!!!')).toThrow(/letters or numbers/);
    const supplier = await service.upsertSupplier({ displayName: 'ACME, Inc.' });
    const sameSupplier = await service.upsertSupplier({ displayName: 'acme inc' });
    const supplierProduct = await service.upsertSupplierProduct({
      supplierId: idOf(supplier),
      productId: idOf(product),
    });
    const preferred = await service.upsertCompanyProductSupplier({
      companyProductId: idOf(companyProduct),
      supplierProductId: idOf(supplierProduct),
      role: 'preferred',
    });
    const samePreferred = await service.upsertCompanyProductSupplier({
      companyProductId: idOf(companyProduct),
      supplierProductId: idOf(supplierProduct),
      role: 'preferred',
    });
    const candidate = await service.upsertCompanyProductSupplier({
      companyProductId: idOf(companyProduct),
      supplierProductId: idOf(supplierProduct),
      role: 'candidate',
    });

    expect(idOf(sameSupplier)).toBe(idOf(supplier));
    expect(idOf(samePreferred)).toBe(idOf(preferred));
    expect(idOf(candidate)).not.toBe(idOf(preferred));
  });

  it('fails clearly when link references are missing', async () => {
    const service = new EcobaseMedallionIdentityService(new FakeDatabase());
    const product = await service.upsertProduct({ asin: 'B001', sku: 'SKU-1' });

    await expect(service.ensureDefaultAmazonAccount({ companyId: 'missing-company' })).rejects.toThrow(
      /company missing-company does not exist/,
    );
    await expect(
      service.upsertCompanyProduct({
        companyId: 'missing-company',
        amazonAccountId: 'missing-account',
        productId: idOf(product),
      }),
    ).rejects.toThrow(/company missing-company does not exist/);
    await expect(
      service.upsertSupplierProduct({ supplierId: 'missing-supplier', productId: idOf(product) }),
    ).rejects.toThrow(/supplier missing-supplier does not exist/);
    await expect(
      service.upsertCompanyProductSupplier({
        companyProductId: 'missing-company-product',
        supplierProductId: 'missing-supplier-product',
        role: 'preferred',
      }),
    ).rejects.toThrow(/company product missing-company-product does not exist/);
  });

  it('uses the new silver collections only', async () => {
    const db = new FakeDatabase();
    const service = new EcobaseMedallionIdentityService(db);
    await service.upsertSupplier({ displayName: 'ACME' });

    expect(db.repositories.has(ECOBASE_COLLECTIONS.silverSuppliers)).toBe(true);
    expect(db.repositories.has(ECOBASE_COLLECTIONS.suppliers)).toBe(false);
  });
});
