/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  EcobaseSupplierEvidenceApplyService,
  supplierEvidenceConfirmationToken,
} from '../../features/supplier-management/server/supplier-evidence-apply-service';
import type { SupplierEvidenceFiles } from '../../features/supplier-management/server/supplier-evidence-backfill-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Row = Record<string, any>;

function matches(row: Row, filter: Row = {}) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository implements EcobaseRepository {
  constructor(readonly rows: Row[] = []) {}

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
    this.rows.push({ ...params.values });
    return { ...params.values };
  }

  async update(params: any) {
    const row = this.rows.find((item) => item.id === params.filterByTk);
    if (!row) throw new Error(`Missing row ${params.filterByTk}`);
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

  rows(name: string) {
    return this.getRepository(name).rows;
  }
}

const files: SupplierEvidenceFiles = {
  supplierTracker: {
    name: 'Supplier Analysis Tracker.csv',
    content: [
      'SR ID,Supplier Name,ASIN,Status,Active Status,Username,pass,PR Portal Link',
      'SRO-12939,Display Name Old,B000000001,Completed,Yes,user,secret,https://private.invalid',
    ].join('\n'),
  },
  supplier2026: {
    name: 'Supplier 2026.csv',
    content: [
      'SR ID,Supplier Name,ASIN,Current Status,Status,Username,pass,PR Portal Link',
      'SRO-12939,Display Name Current,B000000001,Active,Approved,user,secret,https://private.invalid',
    ].join('\n'),
  },
  purchaseOrders: {
    name: 'Purchase Orders.csv',
    content: [
      'Timestamp,Order ID,SR ID ,Supplier,Company,PO approval,Order status,Payment Status ',
      '01/07/2026 10:00:00,PO-1,SRO-12939,Ignored Name,Ecofission LLC,Approved,Completed,Completed',
    ].join('\n'),
  },
  orderDetails: {
    name: 'OrderDetails.csv',
    content: [
      'Order ID,Timestamp,Company,SR ID,Supplier,ASIN,SKU,Qty,PPU,AM Status,COO status,PO Status,Shipment',
      'PO-1,01/07/2026 10:00:00,Ecofission LLC,SRO-12939,Different Name,B000000001,SKU-1,10,4,Cleared,,,Yes',
    ].join('\n'),
  },
};

async function seededDatabase() {
  const db = new MemoryDatabase();
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
    values: { id: 'company-1', name: 'Ecofission LLC' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: 'product-1', asin: 'B000000001', sku: 'SKU-1' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: {
      id: 'company-product-1',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      productId: 'product-1',
      companyProductFamilyId: 'family-1',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).create({
    values: {
      id: 'family-1',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      marketplace: 'amazon.com',
      canonicalAsin: 'B000000001',
      supplierReviewRequired: true,
    },
  });
  return db;
}

describe('supplier evidence apply service', () => {
  it('keeps preview read-only and blocks stale digests and missing confirmations', async () => {
    const db = await seededDatabase();
    const service = new EcobaseSupplierEvidenceApplyService(db);
    const preview = await service.preview(files);

    expect(db.rows(ECOBASE_COLLECTIONS.silverSuppliers)).toHaveLength(0);
    await expect(service.apply({ files, decisionDigest: 'stale', confirmation: 'wrong' })).rejects.toThrow(
      'decision digest changed',
    );
    await expect(
      service.apply({ files, decisionDigest: preview.decisionDigest, confirmation: 'wrong' }),
    ).rejects.toThrow('confirmation must equal');
    expect(db.rows(ECOBASE_COLLECTIONS.silverSuppliers)).toHaveLength(0);
  });

  it('applies exact-ref family evidence without fabricating offers and is idempotent', async () => {
    const db = await seededDatabase();
    const service = new EcobaseSupplierEvidenceApplyService(db);
    const preview = await service.preview(files);
    const params = {
      files,
      decisionDigest: preview.decisionDigest,
      confirmation: supplierEvidenceConfirmationToken(preview.decisionDigest),
    };

    const first = await service.apply(params);
    const second = await service.apply(params);
    const family = db.rows(ECOBASE_COLLECTIONS.silverCompanyProductFamilies)[0];
    const supplier = db.rows(ECOBASE_COLLECTIONS.silverSuppliers)[0];
    const reference = db.rows(ECOBASE_COLLECTIONS.silverSupplierExternalRefs)[0];

    expect(first).toMatchObject({
      selectedFamilyCount: 1,
      changedFamilyCount: 1,
      createdSupplierCount: 1,
      createdExternalRefCount: 1,
      createdSupplierAccountCount: 1,
      candidateLinkSkippedNoOfferCount: 1,
      fabricatedSupplierProductCount: 0,
      goldRefreshCount: 0,
    });
    expect(second).toMatchObject({
      changedFamilyCount: 0,
      unchangedFamilyCount: 1,
      createdSupplierCount: 0,
      createdExternalRefCount: 0,
      createdSupplierAccountCount: 0,
      createdCandidateLinkCount: 0,
    });
    expect(supplier).toMatchObject({ displayName: 'Display Name Current' });
    expect(reference).toMatchObject({
      supplierId: supplier.id,
      normalizedExternalSupplierCode: 'SRO-12939',
    });
    expect(family).toMatchObject({
      preferredSupplierId: supplier.id,
      preferredSupplierProductId: null,
      supplierSelectionSource: 'historical_order_evidence',
      supplierReviewRequired: false,
      supplierSelectionEvidenceJson: {
        ruleVersion: 'supplier-evidence-v1',
        supplierExternalRef: 'SRO-12939',
        sourceRowNumber: 2,
        headerRowNumber: 2,
        matchType: 'exact_member_sku',
      },
    });
    expect(JSON.stringify(family)).not.toContain('private.invalid');
    expect(db.rows(ECOBASE_COLLECTIONS.silverSupplierProducts)).toHaveLength(0);
    expect(db.rows(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers)).toHaveLength(0);
  });
});
