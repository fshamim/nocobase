/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 054 R1 — receipt reconciliation inside the scheduled Gold promotion.
 * - a committed Sellerboard unit reconciles the selected orders BEFORE publishing;
 * - reconciliation failures are logged and counted, never blocking the publish;
 * - reconciling the same snapshot twice leaves byte-identical stamps;
 * - operator-write promotions never reconcile;
 * - units committed inside one debounce window accumulate into one reconcile.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseGoldPromotions } from '../plugin';
import { EcobaseInventoryPlanningService } from '../../features/inventory-dashboard/server/engine/inventory-planning-service';
import { EcobaseOrderReceiptReconciliationService } from '../../features/inventory-dashboard/server/engine/order-receipt-reconciliation-service';
import { reconcileReceiptsForScheduledRefresh } from '../../features/inventory-dashboard/server/engine/scheduled-receipt-reconciliation';
import type {
  EcobaseDatabase,
  EcobaseRepository,
  SellerboardCommittedUnit,
} from '../../features/source-import/server/import-service';
import { EcobasePlanningSettingsService } from '../services/planning-settings-service';

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
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Scheduled receipt fixture repository ${name} was not registered.`);
    return repository;
  }
  seed(name: string, rows: Row[]) {
    this.repositories.set(name, new Repo(rows));
  }
}

/** Orders across three companies; only two of them commit a Sellerboard unit. */
function scopedOrdersDatabase() {
  const db = new Db();
  db.seed(ECOBASE_COLLECTIONS.silverOrders, [
    { id: 'order-alpha', companyId: 'company-alpha', amazonReceiptStatus: 'awaiting_amazon_stock' },
    { id: 'order-beta', companyId: 'company-beta', amazonReceiptStatus: 'partially_observed' },
    { id: 'order-gamma', companyId: 'company-gamma', amazonReceiptStatus: 'awaiting_amazon_stock' },
    { id: 'order-terminal', companyId: 'company-alpha', amazonReceiptStatus: 'amazon_stock_observed' },
    { id: 'order-unassessed', companyId: 'company-alpha' },
  ]);
  return db;
}

/**
 * The isolated positive receipt-transition fixture: a Sellerboard sellable jump
 * from 2 to 7 with one unit sold gives a 6-unit attributed addition against a
 * 10-unit order line.
 */
function arrivalEvidenceDatabase() {
  const db = new Db();
  db.seed(ECOBASE_COLLECTIONS.sourceConnections, [
    { id: 'source-1', sourceType: 'sellerboard', active: true, companyId: 'company-1' },
  ]);
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
      // Already assessed as open, so the refresh selector picks it up.
      amazonReceiptStatus: 'awaiting_amazon_stock',
    },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverOrderLines, [
    { id: 'line-1', orderId: 'order-1', companyProductId: 'product-1', orderedQty: 10 },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProducts, [
    { id: 'product-1', companyId: 'company-1', amazonAccountId: 'account-1', companyProductFamilyId: 'family-1' },
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

function persistedState(db: Db) {
  return structuredClone({
    orders: db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows,
    lines: db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows,
  });
}

function committedUnit(companyId?: string): SellerboardCommittedUnit {
  return {
    sourceConnectionId: `source-${companyId ?? 'unscoped'}`,
    sourceName: 'Sellerboard',
    sourceActive: true,
    scheduleEnabled: true,
    reportKind: 'stock_daily',
    reportName: 'Stock daily',
    importRunId: `run-${companyId ?? 'unscoped'}`,
    companyId,
  };
}

async function flushMicrotasks(times = 3) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function logger() {
  return { info: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduled Gold promotion receipt reconciliation (054 R1)', () => {
  it('reconciles the selected candidate orders before publishing Gold', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const reconcile = vi
      .spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'reconcileAffectedOrders')
      .mockImplementation(async () => {
        order.push('reconcile');
        return {
          processedOrders: 1,
          updatedOrders: 1,
          updatedLines: 1,
          unchangedLines: 0,
          reviewRequired: 0,
          affectedFamilyIds: [],
          errors: [],
        };
      });
    const publish = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshAndPublish')
      .mockImplementation(async () => {
        order.push('publish');
        return { status: 'published' } as never;
      });
    const log = logger();
    const promotions = createEcobaseGoldPromotions({ db: scopedOrdersDatabase(), logger: log });

    await promotions.onSellerboardCommittedUnit(committedUnit('company-alpha'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(order).toEqual(['reconcile', 'publish']);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0].orderIds).toEqual(['order-alpha']);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    promotions.stop();
  });

  it('falls back to every reconciliation-eligible open order when the unit carries no company scope', async () => {
    vi.useFakeTimers();
    const reconcile = vi
      .spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'reconcileAffectedOrders')
      .mockResolvedValue({
        processedOrders: 3,
        updatedOrders: 0,
        updatedLines: 0,
        unchangedLines: 3,
        reviewRequired: 0,
        affectedFamilyIds: [],
        errors: [],
      });
    const publish = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshAndPublish')
      .mockResolvedValue({ status: 'published' } as never);
    const promotions = createEcobaseGoldPromotions({ db: scopedOrdersDatabase(), logger: logger() });

    await promotions.onSellerboardCommittedUnit(committedUnit(undefined));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconcile.mock.calls[0][0].orderIds).toEqual(['order-alpha', 'order-beta', 'order-gamma']);
    expect(publish).toHaveBeenCalledTimes(1);
    promotions.stop();
  });

  it('accumulates the scope of every unit committed inside one debounce window into one reconcile', async () => {
    vi.useFakeTimers();
    const reconcile = vi
      .spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'reconcileAffectedOrders')
      .mockResolvedValue({
        processedOrders: 2,
        updatedOrders: 0,
        updatedLines: 0,
        unchangedLines: 2,
        reviewRequired: 0,
        affectedFamilyIds: [],
        errors: [],
      });
    const publish = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshAndPublish')
      .mockResolvedValue({ status: 'published' } as never);
    const promotions = createEcobaseGoldPromotions({ db: scopedOrdersDatabase(), logger: logger() });

    await promotions.onSellerboardCommittedUnit(committedUnit('company-alpha'));
    await promotions.onSellerboardCommittedUnit(committedUnit('company-beta'));
    await promotions.onSellerboardCommittedUnit(committedUnit('company-alpha'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconcile).toHaveBeenCalledTimes(1);
    // company-gamma never committed, so its open order stays out of scope.
    expect(reconcile.mock.calls[0][0].orderIds).toEqual(['order-alpha', 'order-beta']);
    expect(publish).toHaveBeenCalledTimes(1);

    // The accumulated scope resets: the next window only carries the new unit.
    await promotions.onSellerboardCommittedUnit(committedUnit('company-gamma'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls[1][0].orderIds).toEqual(['order-gamma']);
    promotions.stop();
  });

  it('publishes Gold anyway when reconciliation throws, logging and counting the failure', async () => {
    vi.useFakeTimers();
    const reconcile = vi
      .spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'reconcileAffectedOrders')
      .mockRejectedValue(new Error('receipt reconciliation exploded'));
    const publish = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshAndPublish')
      .mockResolvedValue({ status: 'published' } as never);
    const log = logger();
    const promotions = createEcobaseGoldPromotions({ db: scopedOrdersDatabase(), logger: log });

    await promotions.onSellerboardCommittedUnit(committedUnit('company-alpha'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(promotions.receiptReconciler.failures).toBe(1);
    expect(promotions.receiptReconciler.lastFailureMessage).toBe('receipt reconciliation exploded');
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toBe(
      'Ecobase scheduled receipt reconciliation failed; Gold publication proceeds.',
    );
    expect(log.error.mock.calls[0][1]).toMatchObject({
      scopedCompanyIds: ['company-alpha'],
      failureCount: 1,
      lastError: 'receipt reconciliation exploded',
    });
    promotions.stop();
  });

  it('never reconciles on the operator-write promotion path', async () => {
    vi.useFakeTimers();
    vi.spyOn(EcobasePlanningSettingsService.prototype, 'getResolvedSettings').mockResolvedValue({
      operatorWritePublishDebounceSeconds: 45,
    } as never);
    const reconcile = vi.spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'reconcileAffectedOrders');
    const publish = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshAndPublish')
      .mockResolvedValue({ status: 'published' } as never);
    const promotions = createEcobaseGoldPromotions({ db: scopedOrdersDatabase(), logger: logger() });

    promotions.operatorWrite.schedule();
    promotions.operatorWrite.schedule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(promotions.receiptReconciler.failures).toBe(0);
    promotions.stop();
  });

  it('leaves byte-identical stamps when the same Sellerboard snapshot is reconciled twice', async () => {
    const db = arrivalEvidenceDatabase();

    const first = await reconcileReceiptsForScheduledRefresh(db, {
      companyIds: ['company-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    const afterFirst = persistedState(db);
    const second = await reconcileReceiptsForScheduledRefresh(db, {
      companyIds: ['company-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    const afterSecond = persistedState(db);

    expect(first.candidateOrderIds).toEqual(['order-1']);
    expect(first.reconciliation).toMatchObject({ processedOrders: 1, updatedOrders: 1, updatedLines: 1, errors: [] });
    expect(afterFirst.lines[0]).toMatchObject({
      amazonReceiptStatus: 'amazon_stock_observed',
      amazonReceiptObservedQty: 6,
      amazonReceiptObservedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(afterFirst.orders[0]).toMatchObject({ amazonReceiptStatus: 'partially_observed' });

    // The order stays reconciliation-eligible, so the second pass really runs...
    expect(second.candidateOrderIds).toEqual(['order-1']);
    expect(second.reconciliation).toMatchObject({ processedOrders: 1, updatedOrders: 0, updatedLines: 0 });
    // ...and writes nothing: every stamp, evidence key and timestamp is identical.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('reconciles nothing when the scoped companies have no reconciliation-eligible open orders', async () => {
    const db = scopedOrdersDatabase();
    const reconcile = vi.spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'reconcileAffectedOrders');

    await expect(reconcileReceiptsForScheduledRefresh(db, { companyIds: ['company-without-orders'] })).resolves.toEqual(
      {
        scopedCompanyIds: ['company-without-orders'],
        candidateOrderIds: [],
        reconciliation: null,
      },
    );
    expect(reconcile).not.toHaveBeenCalled();
  });
});
