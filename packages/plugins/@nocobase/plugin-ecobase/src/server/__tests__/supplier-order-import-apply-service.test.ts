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
import { EcobaseSupplierOrderImportApplyService } from '../../features/source-import/server/supplier-order-import-apply-service';
import { buildSupplierOrderImportPlan } from '../../features/source-import/server/supplier-order-import/supplier-order-import-plan';
import {
  preflightSupplierOrderImport,
  type SupplierOrderCatalogSnapshot,
} from '../../features/source-import/server/supplier-order-import/supplier-order-import-preflight';

type Row = Record<string, unknown>;

class MemoryRepository {
  records: Row[] = [];

  private matches(row: Row, filter: Row) {
    return Object.entries(filter).every(([key, value]) => row[key] === value);
  }

  async findOne(params: { filter?: Row; filterByTk?: string } = {}) {
    return this.records.find((row) =>
      params.filterByTk ? row.id === params.filterByTk : this.matches(row, params.filter ?? {}),
    );
  }

  async find(params: { filter?: Row } = {}) {
    return this.records.filter((row) => this.matches(row, params.filter ?? {}));
  }

  async create({ values }: { values: Row }) {
    const row = structuredClone(values);
    this.records.push(row);
    return row;
  }

  async update(params: { filter?: Row; filterByTk?: string; values: Row }) {
    const row = await this.findOne(params);
    if (row) Object.assign(row, structuredClone(params.values));
    return row;
  }

  async destroy(params: { filter?: Row; filterByTk?: string }) {
    const before = this.records.length;
    this.records = this.records.filter((row) =>
      params.filterByTk ? row.id !== params.filterByTk : !this.matches(row, params.filter ?? {}),
    );
    return before - this.records.length;
  }
}

class MemoryDatabase {
  repositories = new Map<string, MemoryRepository>();
  transactions = 0;
  sequelize = {
    transaction: async <T>(run: (transaction: object) => Promise<T>) => {
      this.transactions += 1;
      const snapshot = new Map(
        [...this.repositories].map(([name, repository]) => [name, structuredClone(repository.records)]),
      );
      try {
        return await run({ id: this.transactions });
      } catch (error) {
        for (const [name, records] of snapshot) this.getRepository(name).records = records;
        for (const name of [...this.repositories.keys()]) {
          if (!snapshot.has(name)) this.repositories.delete(name);
        }
        throw error;
      }
    },
  };

  getRepository(name: string) {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryRepository();
      this.repositories.set(name, repository);
    }
    return repository;
  }
}

function seedCatalog(db: MemoryDatabase) {
  db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).records.push({
    id: 'company-1',
    companyKey: 'ECOFISSION_LLC',
    name: 'Ecofission LLC',
  });
  db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).records.push(
    {
      id: 'family-1',
      companyId: 'company-1',
      canonicalAsin: 'B012345678',
      marketplace: 'amazon.com',
      preferredSupplierId: 'legacy-supplier',
      preferredSupplierProductId: 'legacy-supplier-product',
      supplierSelectionSource: 'legacy_import',
      supplierReviewRequired: true,
      supplierSelectionEvidenceJson: { source: 'legacy' },
    },
    {
      id: 'family-2',
      companyId: 'company-1',
      canonicalAsin: 'B022345678',
      marketplace: 'amazon.com',
    },
  );
  db.getRepository(ECOBASE_COLLECTIONS.silverProducts).records.push({
    id: 'product-1',
    asin: 'B012345678',
    sku: 'SKU-1',
  });
  db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).records.push({
    id: 'company-product-1',
    companyId: 'company-1',
    companyProductFamilyId: 'family-1',
    productId: 'product-1',
  });
  db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).records.push({
    id: 'legacy-supplier',
    normalizedName: 'legacy supplier',
    displayName: 'Legacy Supplier',
  });
  db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).records.push({
    id: 'legacy-supplier-product',
    supplierId: 'legacy-supplier',
    productId: 'product-1',
    supplierSku: 'LEGACY-SKU',
  });
}

function catalog(db: MemoryDatabase): SupplierOrderCatalogSnapshot {
  return {
    database: 'memory',
    companies: db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).records as never,
    families: db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).records as never,
    companyProducts: db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).records as never,
    products: db.getRepository(ECOBASE_COLLECTIONS.silverProducts).records as never,
  };
}

function sourcePlan(orderStatus = 'Completed') {
  return buildSupplierOrderImportPlan({
    asOfDate: '2026-07-16',
    files: [
      {
        name: 'suppliers.csv',
        role: 'supplier_ids',
        content: 'SR ID,Supplier Name\nSRO-300,Good Supply\n',
      },
      {
        name: 'orders.csv',
        role: 'purchase_orders',
        dateFormat: 'day-first',
        content:
          'Timestamp,Order ID,SR ID,Company,Market,PO approval,Order status,Act. Cost\n' +
          `16/07/2026,EF71626A,SRO-300,Ecofission LLC,USA,Approved,${orderStatus},11\n`,
      },
      {
        name: 'lines.csv',
        role: 'order_details',
        content:
          'Order ID,Company,SR ID,ASIN,SKU,Qty,PPU\n' +
          'EF71626A,Ecofission LLC,SRO-300,B012345678,SKU-1,4,2.50\n' +
          'EF71626A,Ecofission LLC,SRO-300,B022345678,SUPPLIER-SKU,2,3.50\n' +
          'EF71626A,Ecofission LLC,SRO-300,B032345678,UNKNOWN-SKU,1,4.50\n',
      },
    ],
  });
}

function readyPreflight(
  db: MemoryDatabase,
  orderStatus = 'Completed',
  importMode: 'canonical-rebuild' | 'refresh' = 'canonical-rebuild',
) {
  return preflightSupplierOrderImport(sourcePlan(orderStatus), catalog(db), importMode);
}

describe('supplier/order import apply service', () => {
  it('applies only a ready canonical preflight and makes the second apply a no-op', async () => {
    const db = new MemoryDatabase();
    seedCatalog(db);
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records.push({
      id: 'existing-order',
      companyId: 'company-1',
      orderRef: ' ef 71626a ',
      recordType: 'purchase_order',
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records.push({
      id: 'legacy-line',
      orderId: 'existing-order',
      sourceLineKey: 'legacy-line',
      sourceEvidence: { source: 'google_sheets' },
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).records.push({
      id: 'comment-1',
      entityType: 'supplier_order',
      entityId: 'existing-order',
      actorType: 'user',
      actorUserId: 7,
      commentType: 'note',
      body: 'Preserve exactly',
      sourceCommentKey: 'comment-source-1',
      deletedAt: null,
    });
    const preflight = readyPreflight(db);
    const service = new EcobaseSupplierOrderImportApplyService(db as never);

    const first = await service.apply(preflight);
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records[0].orderDate = new Date(2026, 6, 16);
    const second = await service.apply(preflight);

    expect(preflight).toMatchObject({ ready: true, counts: { structuralBlockers: 0, lines: 3 } });
    expect(first).toMatchObject({ noOp: false, mappingExceptions: 1 });
    expect(second).toMatchObject({ totalWrites: 0, noOp: true, mappingExceptions: 1 });
    expect(db.transactions).toBe(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).records).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).records[0]).toMatchObject({
      preferredSupplierId: 'legacy-supplier',
      preferredSupplierProductId: 'legacy-supplier-product',
      supplierSelectionSource: 'legacy_import',
      supplierReviewRequired: true,
      supplierSelectionEvidenceJson: { source: 'legacy' },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'legacy-supplier-product', supplierSku: 'LEGACY-SKU' }),
        expect.objectContaining({ productId: 'product-1', supplierSku: 'SKU-1' }),
      ]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).records).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).records).toEqual([
      expect.objectContaining({ companyProductId: 'company-product-1', role: 'historical_purchase' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records).not.toContainEqual(
      expect.objectContaining({ id: 'legacy-line' }),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mappingScope: 'exact_member',
          companyProductFamilyId: 'family-1',
          companyProductId: 'company-product-1',
          supplierProductId: expect.any(String),
        }),
        expect.objectContaining({
          mappingScope: 'family_only',
          companyProductFamilyId: 'family-2',
          companyProductId: null,
          supplierProductId: null,
        }),
        expect.objectContaining({
          mappingScope: 'unresolved',
          companyProductFamilyId: null,
          companyProductId: null,
          supplierProductId: null,
        }),
      ]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).records).toEqual([
      expect.objectContaining({
        id: 'comment-1',
        entityId: expect.not.stringMatching('existing-order'),
        body: 'Preserve exactly',
      }),
    ]);
  });

  it('keeps downstream ClickUp authority and workflow drafts on an identical canonical replay', async () => {
    const db = new MemoryDatabase();
    seedCatalog(db);
    const preflight = readyPreflight(db);
    const service = new EcobaseSupplierOrderImportApplyService(db as never);
    await service.apply(preflight);

    Object.assign(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records[0], {
      canonicalStatus: 'shipped_inbound',
      lifecycleStatus: 'in_transit',
      operationalStatus: 'inbound-monitoring',
      workflowStage: 'inbound',
      statusSource: 'clickup_csv',
      statusEvidenceJson: { source: 'clickup_csv' },
      authorityStatus: 'clickup_authoritative',
      authoritySource: 'clickup_csv',
      authorityTaskRef: 'task-1',
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records.push({
      id: 'workflow-draft',
      companyId: 'company-1',
      orderRef: 'EF71726A',
      recordType: 'workflow_draft',
      statusSource: 'clickup_csv',
      sourceEvidence: { source: 'clickup_csv' },
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records.push({
      id: 'workflow-draft-line',
      orderId: 'workflow-draft',
      sourceLineKey: 'clickup:task-2:1',
      sourceEvidence: { source: 'clickup_csv' },
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).records.push({
      id: 'clickup-comment',
      entityType: 'supplier_order',
      entityId: 'workflow-draft',
      actorType: 'external',
      actorUserId: null,
      sourceCommentKey: 'clickup-comment-1',
    });

    const replay = await service.apply(preflight);

    expect(replay).toMatchObject({ noOp: true, totalWrites: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderRef: 'EF71626A',
          canonicalStatus: 'shipped_inbound',
          authoritySource: 'clickup_csv',
        }),
        expect.objectContaining({ id: 'workflow-draft' }),
      ]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'workflow-draft-line' })]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).records).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'clickup-comment', entityId: 'workflow-draft' })]),
    );
  });

  it('does not derive supplier-product evidence from cancelled purchases', async () => {
    const db = new MemoryDatabase();
    seedCatalog(db);

    await new EcobaseSupplierOrderImportApplyService(db as never).apply(readyPreflight(db, 'Cancelled'));

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).records).toEqual([
      expect.objectContaining({ id: 'legacy-supplier-product', supplierSku: 'LEGACY-SKU' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).records).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records).toEqual(
      expect.arrayContaining([expect.objectContaining({ mappingScope: 'exact_member', supplierProductId: null })]),
    );
  });

  it('rejects a tampered preflight before opening a transaction', async () => {
    const db = new MemoryDatabase();
    seedCatalog(db);
    const preflight = readyPreflight(db);
    preflight.plan.orders[0].remarks = 'tampered after preflight';

    await expect(new EcobaseSupplierOrderImportApplyService(db as never).apply(preflight)).rejects.toThrow(
      'source plan digest does not match its payload',
    );
    expect(db.transactions).toBe(0);
  });

  it('rolls back importer writes when a preflighted catalog link changed', async () => {
    const db = new MemoryDatabase();
    seedCatalog(db);
    const preflight = readyPreflight(db);
    db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).records = [];

    await expect(new EcobaseSupplierOrderImportApplyService(db as never).apply(preflight)).rejects.toThrow(
      'family link changed',
    );

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).records).toEqual([
      expect.objectContaining({ id: 'legacy-supplier' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records).toEqual([]);
  });

  it('preserves importer-owned history absent from a refresh snapshot', async () => {
    const db = new MemoryDatabase();
    seedCatalog(db);
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records.push({
      id: 'historical-order',
      companyId: 'company-1',
      orderRef: 'EF11111A',
      statusSource: 'supplier_order_import',
      sourceEvidence: { preflightDigest: 'older-run' },
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records.push({
      id: 'historical-line',
      orderId: 'historical-order',
      sourceLineKey: 'older-run:line-1',
      sourceEvidence: { preflightDigest: 'older-run' },
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).records.push({
      id: 'historical-comment',
      entityType: 'supplier_order',
      entityId: 'historical-order',
      body: 'Preserve with history',
    });

    const result = await new EcobaseSupplierOrderImportApplyService(db as never).apply(
      readyPreflight(db, 'Completed', 'refresh'),
    );

    expect(result).toMatchObject({ importMode: 'refresh', deleted: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'historical-order' })]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).records).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'historical-line' })]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).records).toEqual([
      expect.objectContaining({ id: 'historical-comment', entityId: 'historical-order' }),
    ]);
  });

  it('blocks deletion when an operator comment has no target in the canonical plan', async () => {
    const db = new MemoryDatabase();
    seedCatalog(db);
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records.push({
      id: 'stale-order',
      companyId: 'company-1',
      orderRef: 'EF11111A',
      statusSource: 'supplier_order_import',
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).records.push({
      id: 'comment-1',
      entityType: 'supplier_order',
      entityId: 'stale-order',
      actorType: 'user',
      actorUserId: 7,
      commentType: 'note',
      body: 'Must not disappear',
      sourceCommentKey: 'comment-source-1',
      deletedAt: null,
    });

    await expect(new EcobaseSupplierOrderImportApplyService(db as never).apply(readyPreflight(db))).rejects.toThrow(
      'operator comments cannot be relinked',
    );

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).records).toEqual([
      expect.objectContaining({ id: 'stale-order' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).records).toEqual([
      expect.objectContaining({ id: 'legacy-supplier' }),
    ]);
  });
});
