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
import { EcobaseOrderReceiptReconciliationService } from '../../features/inventory-planning/server/order-receipt-reconciliation-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, filter: Record<string, unknown> = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return (expected.$in as unknown[]).includes(row[key]);
    }
    return row[key] === expected;
  });
}

class Repo implements EcobaseRepository {
  constructor(public rows: Row[] = []) {}
  async find(params?: { filter?: Record<string, unknown> }) {
    return this.rows.filter((row) => matches(row, params?.filter));
  }
  async findOne(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return (
      this.rows.find((row) =>
        params?.filterByTk === undefined ? matches(row, params?.filter) : row.id === params.filterByTk,
      ) ?? null
    );
  }
  async create({ values }: { values: Record<string, unknown> }) {
    const row = values as Row;
    this.rows.push(row);
    return row;
  }
  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number | null;
    values: Record<string, unknown>;
  }) {
    this.rows = this.rows.map((row) =>
      (filterByTk !== undefined && filterByTk !== null ? row.id === filterByTk : matches(row, filter))
        ? { ...row, ...values }
        : row,
    );
    return this.rows;
  }
}

class Db implements EcobaseDatabase {
  repositories = new Map<string, Repo>();
  getRepository(name: string) {
    if (!this.repositories.has(name)) this.repositories.set(name, new Repo());
    return this.repositories.get(name)!;
  }
  seed(name: string, rows: Row[]) {
    this.repositories.set(name, new Repo(rows));
  }
}

function fixture() {
  const db = new Db();
  db.seed(ECOBASE_COLLECTIONS.sourceConnections, [{ id: 'source-1', sourceType: 'sellerboard', active: true }]);
  db.seed(ECOBASE_COLLECTIONS.silverOrders, [
    {
      id: 'order-1',
      companyId: 'company-1',
      orderRef: 'EF-1',
      lifecycleStatus: 'inbound-monitoring',
      canonicalStatus: 'shipped_inbound',
      authorityAsOf: '2026-07-10T12:00:00.000Z',
      fulfillmentRoute: 'unknown',
      statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'inbound-monitoring' } },
    },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverOrderLines, [
    { id: 'line-1', orderId: 'order-1', companyProductId: 'product-1', orderedQty: 10 },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProducts, [
    {
      id: 'product-1',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      companyProductFamilyId: 'family-1',
    },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, [
    {
      id: 'family-1',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      marketplace: 'Amazon.com',
      replenishmentTargetCompanyProductId: 'product-1',
    },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverInventorySnapshots, [
    {
      id: 'snapshot-1',
      companyProductId: 'product-1',
      sourceConnectionId: 'source-1',
      snapshotDate: '2026-07-10',
      sellableStock: 2,
      reserved: 0,
      inbound: 0,
      awdStock: 0,
    },
    {
      id: 'snapshot-2',
      companyProductId: 'product-1',
      sourceConnectionId: 'source-1',
      snapshotDate: '2026-07-12',
      sellableStock: 7,
      reserved: 0,
      inbound: 0,
      awdStock: 0,
    },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverListingDailyFacts, [
    { id: 'fact-1', companyProductId: 'product-1', snapshotDate: '2026-07-11', units: 1 },
  ]);
  return db;
}

describe('EcobaseOrderReceiptReconciliationService', () => {
  it('persists one idempotent receipt transition without changing exact ClickUp status', async () => {
    const db = fixture();
    const service = new EcobaseOrderReceiptReconciliationService(db);

    const first = await service.reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    const second = await service.reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });

    expect(first).toMatchObject({
      processedOrders: 1,
      updatedOrders: 1,
      updatedLines: 1,
      reviewRequired: 0,
      affectedFamilyIds: ['family-1'],
    });
    expect(second).toMatchObject({ processedOrders: 1, updatedOrders: 0, updatedLines: 0, unchangedLines: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptStatus: 'amazon_stock_observed',
      amazonReceiptObservedQty: 6,
      amazonReceiptBaselineAt: '2026-07-10T12:00:00.000Z',
      amazonReceiptObservedAt: '2026-07-12T00:00:00.000Z',
      amazonReceiptCompletionReason: 'positive_attributed_addition',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      lifecycleStatus: 'inbound-monitoring',
      canonicalStatus: 'shipped_inbound',
      amazonReceiptStatus: 'partially_observed',
    });
  });

  it('allocates one family increase across same-family lines in FIFO order', async () => {
    const db = fixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0].orderedQty = 4;
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.push({
      id: 'line-2',
      orderId: 'order-1',
      companyProductId: 'product-1',
      orderedQty: 5,
    });
    const service = new EcobaseOrderReceiptReconciliationService(db);

    await service.reconcileAffectedOrders({ orderIds: ['order-1'], evaluatedAt: '2026-07-12T12:00:00.000Z' });
    const second = await service.reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toEqual([
      expect.objectContaining({
        id: 'line-1',
        amazonReceiptStatus: 'amazon_stock_observed',
        amazonReceiptObservedQty: 4,
      }),
      expect.objectContaining({
        id: 'line-2',
        amazonReceiptStatus: 'amazon_stock_observed',
        amazonReceiptObservedQty: 2,
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      amazonReceiptStatus: 'partially_observed',
    });
    expect(second).toMatchObject({ updatedOrders: 0, updatedLines: 0, unchangedLines: 2 });
  });

  it('completes only an older cycle after a later cycle has trusted Sellerboard arrival evidence', async () => {
    const db = fixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push({
      id: 'order-0',
      companyId: 'company-1',
      orderRef: 'EF-0',
      lifecycleStatus: 'shipped_inbound',
      canonicalStatus: 'shipped_inbound',
      authorityAsOf: '2026-07-09T12:00:00.000Z',
      statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'inbound-monitoring' } },
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.push({
      id: 'line-0',
      orderId: 'order-0',
      companyProductId: 'product-1',
      orderedQty: 10,
    });
    const service = new EcobaseOrderReceiptReconciliationService(db);

    const first = await service.reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    const second = await service.reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[1]).toMatchObject({
      id: 'line-0',
      amazonReceiptStatus: 'completed_by_later_inbound',
      amazonReceiptCompletionReason: 'later_inbound_cycle',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[1]).toMatchObject({
      id: 'order-0',
      amazonReceiptStatus: 'completed_by_later_inbound',
    });
    expect(first).toMatchObject({ updatedLines: 2, updatedOrders: 2 });
    expect(second).toMatchObject({ updatedLines: 0, updatedOrders: 0 });
  });

  it('does not close an older cycle from later-order existence alone or a newer cycle from older evidence', async () => {
    const db = fixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push(
      {
        id: 'order-0',
        companyId: 'company-1',
        authorityAsOf: '2026-07-09T00:00:00.000Z',
        statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'inbound-monitoring' } },
      },
      {
        id: 'order-2',
        companyId: 'company-1',
        authorityAsOf: '2026-07-13T00:00:00.000Z',
        statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'inbound-monitoring' } },
      },
    );
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.push(
      { id: 'line-0', orderId: 'order-0', companyProductId: 'product-1', orderedQty: 10 },
      { id: 'line-2', orderId: 'order-2', companyProductId: 'product-1', orderedQty: 10 },
    );

    await new EcobaseOrderReceiptReconciliationService(db).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[2].amazonReceiptStatus).toBeUndefined();

    const noEvidenceDb = fixture();
    noEvidenceDb.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows.pop();
    noEvidenceDb.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push({
      id: 'order-0',
      companyId: 'company-1',
      authorityAsOf: '2026-07-09T00:00:00.000Z',
      statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'inbound-monitoring' } },
    });
    noEvidenceDb.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.push({
      id: 'line-0',
      orderId: 'order-0',
      companyProductId: 'product-1',
      orderedQty: 10,
    });
    await new EcobaseOrderReceiptReconciliationService(noEvidenceDb).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    expect(
      noEvidenceDb.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[1].amazonReceiptStatus,
    ).toBeUndefined();
  });

  it('fails explicitly for an empty scope and reports missing orders without partial writes', async () => {
    const db = fixture();
    const service = new EcobaseOrderReceiptReconciliationService(db);

    await expect(service.reconcileAffectedOrders({ orderIds: [] })).rejects.toThrow(
      'Ecobase receipt reconciliation requires at least one order ID.',
    );
    await expect(service.reconcileAffectedOrders({ orderIds: ['order-1'], evaluatedAt: 'not-a-date' })).rejects.toThrow(
      'Ecobase receipt reconciliation received invalid evaluatedAt: not-a-date.',
    );
    await expect(service.reconcileAffectedOrders({ orderIds: ['missing-order'] })).resolves.toMatchObject({
      processedOrders: 0,
      updatedOrders: 0,
      updatedLines: 0,
      errors: [
        {
          orderId: 'missing-order',
          code: 'order_not_found',
          message: 'Ecobase receipt reconciliation could not find Silver order missing-order.',
        },
      ],
    });
  });

  it('does not infer receipt from incomplete family snapshot coverage', async () => {
    const db = fixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows.push({
      id: 'product-2',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      companyProductFamilyId: 'family-1',
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows.push({
      id: 'snapshot-3',
      companyProductId: 'product-2',
      sourceConnectionId: 'source-1',
      snapshotDate: '2026-07-12',
      sellableStock: 5,
    });

    await new EcobaseOrderReceiptReconciliationService(db).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptStatus: 'review_required',
      amazonReceiptCompletionReason: 'missing_baseline',
    });
  });

  it('marks unmapped material lines for review instead of guessing a family', async () => {
    const db = fixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0].companyProductId = null;

    const result = await new EcobaseOrderReceiptReconciliationService(db).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });

    expect(result).toMatchObject({ processedOrders: 1, reviewRequired: 1, affectedFamilyIds: [] });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptStatus: 'review_required',
      amazonReceiptCompletionReason: 'company_product_mapping_missing',
    });
  });
});
