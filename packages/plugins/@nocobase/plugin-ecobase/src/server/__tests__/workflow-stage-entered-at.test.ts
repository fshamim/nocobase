/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T-3.0 (Inventory Dashboard): workflowStageEnteredAt write path.
 * - operator updateOrder stamps on stage transition, preserves within a stage;
 * - the one-time backfill migration derives from best evidence with provenance,
 *   leaves evidence-less orders null, and never touches closed stages.
 * (The ClickUp import writer stamp is asserted inside api.test.ts.)
 *
 * Issue 054 R2 rides the same seam: this editor writes workflowStage WITHOUT going
 * through the workbench's deriveStatusWrite, so its inbound-entry baseline stamp is
 * asserted here too.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseOrderPlanningService } from '../../features/order-planning/server/order-planning-service';
import BackfillWorkflowStageEnteredAt from '../migrations/20260722090000-backfill-workflow-stage-entered-at';

type PlainRecord = Record<string, unknown>;

class FakeRepository {
  rows: PlainRecord[] = [];

  async find(params?: { filter?: PlainRecord; limit?: number }) {
    const rows = this.rows.filter((row) => matches(row, params?.filter));
    return typeof params?.limit === 'number' ? rows.slice(0, params.limit) : rows;
  }

  async findOne(params?: { filter?: PlainRecord; filterByTk?: string | number }) {
    if (params?.filterByTk !== undefined) return this.rows.find((row) => row.id === params.filterByTk) ?? null;
    return this.rows.find((row) => matches(row, params?.filter)) ?? null;
  }

  async create(params: { values: PlainRecord }) {
    this.rows.push({ ...params.values });
    return params.values;
  }

  async update(params: { filterByTk?: string | number; filter?: PlainRecord; values: PlainRecord }) {
    const rows = this.rows.filter((row) =>
      params.filterByTk !== undefined ? row.id === params.filterByTk : matches(row, params.filter),
    );
    rows.forEach((row) => Object.assign(row, params.values));
    return rows[0] ?? null;
  }
}

function matches(row: PlainRecord, filter?: PlainRecord) {
  return Object.entries(filter ?? {}).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray((value as { $in?: unknown[] }).$in)) {
      return (value as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === value;
  });
}

class FakeDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

async function seedOrder(db: FakeDatabase, overrides: PlainRecord = {}) {
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
    values: { id: 'company-1', name: 'Acme' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
    values: {
      id: 'order-1',
      companyId: 'company-1',
      orderRef: 'PO-1',
      orderDate: '2026-07-01',
      dailySequenceLetter: 'A',
      lifecycleStatus: 'in progress',
      canonicalStatus: 'supplier_contacted',
      workflowStage: 'pre_purchase',
      statusEvidenceJson: {},
      ...overrides,
    },
  });
}

describe('updateOrder stage-entry stamping (T-3.0)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps on transition, preserves within a stage, restamps on the next transition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T10:00:00.000Z'));
    const db = new FakeDatabase();
    await seedOrder(db);
    const service = new EcobaseOrderPlanningService(db as never);
    const orderRow = () => db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];

    // pre_purchase -> in_prep ("ordered"): stamped at the transition time.
    await service.updateOrder({ orderId: 'order-1', values: { lifecycleStatus: 'ordered' }, actorUserId: 'user-1' });
    expect(orderRow()).toMatchObject({
      workflowStage: 'in_prep',
      workflowStageEnteredAt: '2026-07-22T10:00:00.000Z',
    });

    // in_prep -> in_prep ("prep-in-progress"): status changed, stage did not — preserved.
    vi.setSystemTime(new Date('2026-07-22T11:00:00.000Z'));
    await service.updateOrder({
      orderId: 'order-1',
      values: { lifecycleStatus: 'prep-in-progress' },
      actorUserId: 'user-1',
    });
    expect(orderRow()).toMatchObject({
      workflowStage: 'in_prep',
      workflowStageEnteredAt: '2026-07-22T10:00:00.000Z',
    });

    // in_prep -> amazon_inbound ("inbound-monitoring"): restamped.
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
    await service.updateOrder({
      orderId: 'order-1',
      values: { lifecycleStatus: 'inbound-monitoring' },
      actorUserId: 'user-1',
    });
    expect(orderRow()).toMatchObject({
      workflowStage: 'amazon_inbound',
      workflowStageEnteredAt: '2026-07-22T12:00:00.000Z',
    });
  });
});

describe('updateOrder inbound-entry baseline stamping (054 R2)', () => {
  /** One listing, one family, one sellerboard day — the smallest world with a baseline. */
  async function seedListingWorld(db: FakeDatabase) {
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: 'sellerboard-1', sourceType: 'sellerboard', active: true },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).create({
      values: { id: 'family-1', companyId: 'company-1', amazonAccountId: 'account-1', marketplace: 'Amazon.com' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: {
        id: 'cp-1',
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        companyProductFamilyId: 'family-1',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: { id: 'line-1', orderId: 'order-1', companyProductId: 'cp-1', orderedQty: 12 },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
      values: {
        id: 'snap-1',
        companyProductId: 'cp-1',
        sourceConnectionId: 'sellerboard-1',
        snapshotDate: '2026-07-20',
        sellableStock: 8,
        reserved: 2,
        inbound: 1,
        ordered: 5,
        prepStock: 3,
        awdStock: 0,
      },
    });
  }

  it('stamps the entry baseline when the legacy editor moves an order into inbound monitoring', async () => {
    const db = new FakeDatabase();
    await seedOrder(db);
    await seedListingWorld(db);
    const service = new EcobaseOrderPlanningService(db as never);
    const line = () => db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0];

    // Into in_prep first: a stage change that is not an inbound entry stamps nothing.
    await service.updateOrder({ orderId: 'order-1', values: { lifecycleStatus: 'ordered' }, actorUserId: 'user-1' });
    expect(line().inboundEntryBaseline).toBeUndefined();

    await service.updateOrder({
      orderId: 'order-1',
      values: { lifecycleStatus: 'inbound-monitoring' },
      actorUserId: 'user-1',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0].workflowStage).toBe('amazon_inbound');
    expect(line().inboundEntryBaseline).toMatchObject({
      asOf: '2026-07-20',
      stock: 8,
      reserved: 2,
      inbound: 1,
      ordered: 5,
      prepStock: 3,
      awdStock: 0,
    });

    // A further edit inside the stage must not move it.
    const stamped = structuredClone(line().inboundEntryBaseline);
    await service.updateOrder({
      orderId: 'order-1',
      values: { lifecycleStatus: 'direct-ship-fba' },
      actorUserId: 'user-1',
    });
    expect(line().inboundEntryBaseline).toEqual(stamped);
  });
});

describe('workflowStageEnteredAt backfill migration (T-3.0)', () => {
  it('derives from best evidence with provenance, leaves evidence-less null, skips closed stages', async () => {
    const db = new FakeDatabase();
    const orders = db.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    orders.rows.push(
      {
        id: 'with-override',
        workflowStage: 'in_prep',
        workflowStageEnteredAt: null,
        operatorStatusOverrideAt: '2026-07-10T08:00:00.000Z',
        authorityAsOf: '2026-07-01T00:00:00.000Z',
        statusEvidenceJson: { existing: true },
      },
      {
        id: 'with-authority',
        workflowStage: 'amazon_inbound',
        workflowStageEnteredAt: null,
        authorityAsOf: '2026-07-05T00:00:00.000Z',
      },
      { id: 'no-evidence', workflowStage: 'in_prep', workflowStageEnteredAt: null },
      {
        id: 'already-stamped',
        workflowStage: 'in_prep',
        workflowStageEnteredAt: '2026-07-02T00:00:00.000Z',
        authorityAsOf: '2026-07-09T00:00:00.000Z',
      },
      { id: 'completed', workflowStage: 'complete', authorityAsOf: '2026-07-01T00:00:00.000Z' },
    );

    const migration = new BackfillWorkflowStageEnteredAt({ db } as never);
    await migration.up();

    const byId = new Map(orders.rows.map((row) => [row.id, row]));
    expect(byId.get('with-override')).toMatchObject({
      workflowStageEnteredAt: '2026-07-10T08:00:00.000Z',
      statusEvidenceJson: {
        existing: true,
        workflowStageEnteredAtProvenance: { kind: 'derived', source: 'operatorStatusOverrideAt' },
      },
    });
    expect(byId.get('with-authority')).toMatchObject({
      workflowStageEnteredAt: '2026-07-05T00:00:00.000Z',
      statusEvidenceJson: {
        workflowStageEnteredAtProvenance: { kind: 'derived', source: 'authorityAsOf' },
      },
    });
    expect(byId.get('no-evidence')?.workflowStageEnteredAt ?? null).toBeNull();
    expect(byId.get('already-stamped')).toMatchObject({ workflowStageEnteredAt: '2026-07-02T00:00:00.000Z' });
    expect(byId.get('completed')?.workflowStageEnteredAt ?? null).toBeNull();
  });
});
