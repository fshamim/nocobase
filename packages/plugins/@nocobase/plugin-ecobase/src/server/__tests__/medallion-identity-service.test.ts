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
import {
  EcobaseMedallionIdentityService,
  normalizeCompanyKey,
  normalizeExternalSupplierCode,
  normalizeSupplierName,
} from '../../features/semantic-model/server/medallion-identity-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { toPlainRecord } from '../../features/source-import/server/import-service';

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
    const sameAsinDifferentSku = await service.upsertProduct({ asin: 'B001', sku: 'SOURCE-SKU', title: 'Alias' });

    expect(idOf(sameProduct)).toBe(idOf(product));
    expect(idOf(sameAsinDifferentSku)).not.toBe(idOf(product));
    expect(toPlainRecord(sameAsinDifferentSku).title).toBe('Alias');
    expect(toPlainRecord(sameAsinDifferentSku).sku).toBe('SOURCE-SKU');

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
    const caAccount = await service.ensureDefaultAmazonAccount({ companyId: idOf(company), marketplace: 'CA' });
    const sameProductOtherAccount = await service.upsertCompanyProduct({
      companyId: idOf(company),
      amazonAccountId: idOf(caAccount),
      productId: idOf(product),
    });
    const sourceSkuProduct = await service.upsertProduct({ asin: 'B001', sku: 'SOURCE-SKU' });
    const sourceSkuCompanyProduct = await service.upsertCompanyProduct({
      companyId: idOf(company),
      amazonAccountId: idOf(account),
      productId: idOf(sourceSkuProduct),
    });
    const otherCompany = await service.upsertCompany({ companyKey: 'SAM2', name: 'SampleAM 2' });
    const otherCompanyAccount = await service.ensureDefaultAmazonAccount({
      companyId: idOf(otherCompany),
      marketplace: 'US',
    });
    const otherCompanyProduct = await service.upsertCompanyProduct({
      companyId: idOf(otherCompany),
      amazonAccountId: idOf(otherCompanyAccount),
      productId: idOf(product),
    });

    expect(idOf(sameAccount)).toBe(idOf(account));
    expect(idOf(sameCompanyProduct)).toBe(idOf(companyProduct));
    expect(idOf(sameProductOtherAccount)).not.toBe(idOf(companyProduct));
    expect(idOf(sourceSkuCompanyProduct)).not.toBe(idOf(companyProduct));
    expect(idOf(otherCompanyProduct)).not.toBe(idOf(companyProduct));
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
      leadTimeDays: 45,
    });
    const supplierProductWithDefaultLeadTime = await service.upsertSupplierProduct({
      supplierId: idOf(supplier),
      productId: idOf(product),
      leadTimeDays: 30,
      leadTimeIsDefault: true,
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
      lastUsedAt: '2026-01-15T00:00:00.000Z',
    });
    await service.upsertCompanyProductSupplier({
      companyProductId: idOf(companyProduct),
      supplierProductId: idOf(supplierProduct),
      role: 'candidate',
      lastUsedAt: '2025-12-01T00:00:00.000Z',
    });
    const latestCandidate = await service.upsertCompanyProductSupplier({
      companyProductId: idOf(companyProduct),
      supplierProductId: idOf(supplierProduct),
      role: 'candidate',
      lastUsedAt: '2026-02-01T00:00:00.000Z',
    });

    expect(idOf(sameSupplier)).toBe(idOf(supplier));
    expect(toPlainRecord(supplierProductWithDefaultLeadTime).leadTimeDays).toBe(45);
    expect(idOf(samePreferred)).toBe(idOf(preferred));
    expect(idOf(candidate)).not.toBe(idOf(preferred));
    expect(idOf(latestCandidate)).toBe(idOf(candidate));
    expect(toPlainRecord(latestCandidate).lastUsedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('uses external supplier refs as import identity', async () => {
    const db = new FakeDatabase();
    const service = new EcobaseMedallionIdentityService(db);

    expect(normalizeExternalSupplierCode(' sro-9095 ')).toBe('SRO-9095');
    expect(normalizeExternalSupplierCode('duplicate')).toBeUndefined();
    await expect(
      service.upsertSupplierExternalRef({
        sourceSystem: 'supplier_ids',
        externalSupplierCode: 'SRO-MISSING',
        displayName: 'Order-only supplier',
        identityAuthority: 'reference',
      }),
    ).rejects.toThrow(/not established by Supplier Management/);

    const supplier = await service.upsertSupplierExternalRef({
      sourceSystem: 'supplier_ids',
      externalSupplierCode: 'SRO-9095',
      displayName: 'Premierwd',
      identityAuthority: 'authoritative',
    });
    const sameSupplier = await service.upsertSupplierExternalRef({
      sourceSystem: 'supplier_ids',
      externalSupplierCode: 'sro-9095',
      displayName: 'Order-row alias',
      identityAuthority: 'reference',
    });
    const differentSupplier = await service.upsertSupplierExternalRef({
      sourceSystem: 'supplier_ids',
      externalSupplierCode: 'SRO-9096',
      displayName: 'Premier WD',
    });

    expect(idOf(sameSupplier)).toBe(idOf(supplier));
    expect(toPlainRecord(sameSupplier).displayName).toBe('Premierwd');
    expect(idOf(differentSupplier)).not.toBe(idOf(supplier));
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ supplierId: idOf(supplier), normalizedExternalSupplierCode: 'SRO-9095' }),
        expect.objectContaining({ supplierId: idOf(differentSupplier), normalizedExternalSupplierCode: 'SRO-9096' }),
      ]),
    );
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
    expect(db.repositories.has('ecobaseSuppliers')).toBe(false);
  });
});
