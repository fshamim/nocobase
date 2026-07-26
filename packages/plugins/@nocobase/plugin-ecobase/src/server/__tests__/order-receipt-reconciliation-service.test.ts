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
  EcobaseOrderReceiptReconciliationService,
  historicalReceiptCandidateOrderIds,
  receiptReconciliationOrderIdsForRefresh,
} from '../../features/inventory-dashboard/server/engine/order-receipt-reconciliation-service';
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
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Receipt fixture repository ${name} was not registered.`);
    return repository;
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
  it('selects only unassessed exact inbound/direct-ship orders for historical backfill', () => {
    expect(
      historicalReceiptCandidateOrderIds([
        { id: 'inbound', statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'inbound-monitoring' } } },
        { id: 'direct', authorityEvidenceJson: { clickupStatusEvidence: { clickupStatus: 'direct-ship-fba' } } },
        {
          id: 'assessed',
          amazonReceiptStatus: 'awaiting_amazon_stock',
          statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'inbound-monitoring' } },
        },
        { id: 'complete', authorityEvidenceJson: { clickupStatusEvidence: { clickupStatus: 'complete' } } },
        { id: 'other', statusEvidenceJson: { clickupStatusImport: { clickupStatus: 'supplier-preparing' } } },
      ]),
    ).toEqual(['complete', 'direct', 'inbound']);
  });

  it('inspects receipt-state coverage without mutating orders or lines', async () => {
    const db = fixture();
    const service = new EcobaseOrderReceiptReconciliationService(db);
    const before = structuredClone({
      orders: db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows,
      lines: db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows,
    });

    await expect(service.inspectCoverage(['missing-order', 'order-1', 'order-1'])).resolves.toEqual({
      requestedOrderCount: 2,
      foundOrderCount: 1,
      missingOrderIds: ['missing-order'],
      orderStatusCounts: { missing: 1 },
      lineCount: 1,
      linesWithoutReceiptStatus: 1,
      ordersWithoutLines: [],
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toEqual(before.orders);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toEqual(before.lines);
  });

  it('previews and applies historical receipt backfill in bounded cursor batches with outcome counts', async () => {
    const db = fixture();
    const service = new EcobaseOrderReceiptReconciliationService(db);

    await expect(service.backfillHistoricalReceipts({ batchSize: 1 })).resolves.toMatchObject({
      dryRun: true,
      totalCandidates: 1,
      batchSize: 1,
      orderIds: ['order-1'],
      nextCursor: 'order-1',
      complete: true,
      outcomeCounts: { pending_evaluation: 1 },
      reconciliation: null,
    });
    await expect(
      service.backfillHistoricalReceipts({
        batchSize: 1,
        dryRun: false,
        evaluatedAt: '2026-07-12T12:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      dryRun: false,
      outcomeCounts: { partially_observed: 1 },
      reconciliation: { processedOrders: 1, errors: [] },
    });
  });

  it('limits automatic refreshes to changed orders and already assessed open receipt states', () => {
    expect(
      receiptReconciliationOrderIdsForRefresh(
        [
          { id: 'awaiting', amazonReceiptStatus: 'awaiting_amazon_stock' },
          { id: 'partial', amazonReceiptStatus: 'partially_observed' },
          { id: 'terminal', amazonReceiptStatus: 'amazon_stock_observed' },
          { id: 'unassessed' },
        ],
        ['changed', 'awaiting'],
      ),
    ).toEqual(['changed', 'awaiting', 'partial']);
  });

  it('passes the isolated positive receipt-transition fixture without changing exact ClickUp status', async () => {
    const db = fixture();
    const service = new EcobaseOrderReceiptReconciliationService(db);

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      lifecycleStatus: 'inbound-monitoring',
      canonicalStatus: 'shipped_inbound',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows).toEqual([
      expect.objectContaining({ snapshotDate: '2026-07-10', sellableStock: 2 }),
      expect.objectContaining({ snapshotDate: '2026-07-12', sellableStock: 7 }),
    ]);

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

  // ---- 054 R2: the stamped inbound-entry baseline reaches the evidence math ----

  /**
   * The drift the stamp exists to stop: every ClickUp import moves `authorityAsOf`
   * forward, so the derived baseline eventually lands ON the snapshot that already
   * contains the arrival and the receipt disappears.
   */
  function driftedFixture() {
    const db = fixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0].authorityAsOf = '2026-07-12T12:00:00.000Z';
    return db;
  }

  it('reconciles against the stamped entry baseline rather than the drifted authority timestamp', async () => {
    const drifted = driftedFixture();
    await new EcobaseOrderReceiptReconciliationService(drifted).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    // Red-proof: with the baseline re-derived from the drifted timestamp the arrival is lost.
    expect(drifted.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptStatus: 'awaiting_amazon_stock',
      amazonReceiptCompletionReason: 'missing_current_snapshot',
    });

    const stamped = driftedFixture();
    stamped.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0].inboundEntryBaseline = {
      snapshotId: 'entry-snapshot',
      asOf: '2026-07-10',
      ordered: 10,
      inbound: 0,
      stock: 2,
      reserved: 0,
      prepStock: 0,
      awdStock: 0,
    };

    await new EcobaseOrderReceiptReconciliationService(stamped).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });

    const line = stamped.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0];
    expect(line).toMatchObject({
      amazonReceiptStatus: 'amazon_stock_observed',
      amazonReceiptObservedQty: 6,
      amazonReceiptCompletionReason: 'positive_attributed_addition',
    });
    // Call-path proof: the persisted evidence names the stamped snapshot as the baseline.
    expect(line.amazonReceiptEvidenceJson).toMatchObject({
      receiptEvidence: {
        baselineSnapshotId: 'entry-snapshot',
        baselineSnapshotDate: '2026-07-10',
        baselineAmazonVisibleStock: 2,
        currentAmazonVisibleStock: 7,
        observedAddition: 6,
      },
    });
    expect(stamped.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      amazonReceiptStatus: 'partially_observed',
    });
  });

  it('accepts the stamped entry baseline as the baseline time when no other timestamp exists', async () => {
    const db = fixture();
    delete db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0].authorityAsOf;

    // Red-proof: with no timestamp at all the line can only go to review.
    await new EcobaseOrderReceiptReconciliationService(db).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptStatus: 'review_required',
      amazonReceiptCompletionReason: 'inbound_baseline_time_missing',
    });

    const stampedDb = fixture();
    delete stampedDb.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0].authorityAsOf;
    stampedDb.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0].inboundEntryBaseline = {
      snapshotId: 'entry-snapshot',
      asOf: '2026-07-10',
      ordered: 10,
      inbound: 0,
      stock: 2,
      reserved: 0,
      prepStock: 0,
      awdStock: 0,
    };
    await new EcobaseOrderReceiptReconciliationService(stampedDb).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });
    expect(stampedDb.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptStatus: 'amazon_stock_observed',
      amazonReceiptBaselineAt: '2026-07-10T00:00:00.000Z',
      amazonReceiptObservedQty: 6,
    });
  });

  it('keeps ClickUp complete visible for receipt review until Amazon stock is observed', async () => {
    const db = fixture();
    const order = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    order.lifecycleStatus = 'complete';
    order.canonicalStatus = 'completed';
    order.authorityEvidenceJson = { clickupStatusEvidence: { clickupStatus: 'complete' } };
    order.statusEvidenceJson = {};
    db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows.pop();

    const result = await new EcobaseOrderReceiptReconciliationService(db).reconcileAffectedOrders({
      orderIds: ['order-1'],
      evaluatedAt: '2026-07-12T12:00:00.000Z',
    });

    expect(result).toMatchObject({ processedOrders: 1, reviewRequired: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptStatus: 'review_required',
      amazonReceiptCompletionReason: 'missing_current_snapshot',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      lifecycleStatus: 'complete',
      canonicalStatus: 'completed',
      amazonReceiptStatus: 'review_required',
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

  it('closes a multi-family order only after every material line has terminal receipt evidence', async () => {
    const db = fixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0].orderedQty = 5;
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.push({
      id: 'line-2',
      orderId: 'order-1',
      companyProductId: 'product-2',
      orderedQty: 5,
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows.push({
      id: 'product-2',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      companyProductFamilyId: 'family-2',
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).rows.push({
      id: 'family-2',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      marketplace: 'Amazon.com',
      replenishmentTargetCompanyProductId: 'product-2',
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows.push(
      {
        id: 'snapshot-3',
        companyProductId: 'product-2',
        sourceConnectionId: 'source-1',
        snapshotDate: '2026-07-10',
        sellableStock: 2,
        reserved: 0,
        inbound: 0,
        awdStock: 0,
      },
      {
        id: 'snapshot-4',
        companyProductId: 'product-2',
        sourceConnectionId: 'source-1',
        snapshotDate: '2026-07-12',
        sellableStock: 2,
        reserved: 0,
        inbound: 0,
        awdStock: 0,
      },
    );
    const service = new EcobaseOrderReceiptReconciliationService(db);

    await service.reconcileAffectedOrders({ orderIds: ['order-1'], evaluatedAt: '2026-07-12T12:00:00.000Z' });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      amazonReceiptStatus: 'partially_observed',
    });

    const latestSnapshot = db
      .getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots)
      .rows.find((row) => row.id === 'snapshot-4');
    if (!latestSnapshot) throw new Error('Receipt fixture snapshot snapshot-4 was not registered.');
    latestSnapshot.sellableStock = 7;
    await service.reconcileAffectedOrders({ orderIds: ['order-1'], evaluatedAt: '2026-07-12T12:00:00.000Z' });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      amazonReceiptStatus: 'amazon_stock_observed',
    });
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

  it('records and clears operator overrides without losing immutable audit history', async () => {
    const db = fixture();
    const service = new EcobaseOrderReceiptReconciliationService(db);

    await service.setOperatorOverride({
      lineId: 'line-1',
      status: 'completed_by_later_inbound',
      reason: 'Operator verified a later inbound cycle.',
      actorUserId: '101',
      evaluatedAt: '2026-07-12T13:00:00.000Z',
    });
    await service.setOperatorOverride({
      lineId: 'line-1',
      reason: 'Clearing after Sellerboard evidence became available.',
      actorUserId: '102',
      clear: true,
      evaluatedAt: '2026-07-12T14:00:00.000Z',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      amazonReceiptOverrideStatus: null,
      amazonReceiptOverrideReason: null,
      amazonReceiptOverrideByUserId: '102',
      amazonReceiptOverrideEvidenceJson: {
        history: [
          { action: 'set', actorUserId: '101', status: 'completed_by_later_inbound' },
          { action: 'cleared', actorUserId: '102' },
        ],
      },
    });
    await expect(
      service.setOperatorOverride({ lineId: 'line-1', status: 'review_required', reason: ' ', actorUserId: '101' }),
    ).rejects.toThrow('requires a reason');
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
