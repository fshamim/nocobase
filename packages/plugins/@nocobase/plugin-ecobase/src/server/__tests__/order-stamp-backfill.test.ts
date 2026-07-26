/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 054 R4 — historical order stamp sweep.
 *
 * The sweep writes to production Silver orders, so the properties that make that safe are
 * the ones asserted here: it fills NULL stamps only (pre-stamped rows come out byte-identical
 * under structuredClone), it fills them from the same fallback chain the panes already read
 * in the same priority order, its dry run reports what a real run would do without touching a
 * row, and a second real run does no work at all.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createGoldEngineMaintenanceResourceRegistration } from '../../features/inventory-dashboard/server/engine/maintenance-resource-registration';
import {
  EcobaseOrderStampBackfillService,
  resolveOrderStampFallback,
} from '../../features/inventory-dashboard/server/engine/order-stamp-backfill';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { createEcobaseInventoryPlanningActions } from '../resource-actions';
import { ADMIN, LOGGED_IN, OPERATOR } from '../resource-registration';

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
  async find(params?: { filter?: Record<string, unknown>; limit?: number }) {
    const rows = this.rows.filter((row) => matches(row, params?.filter));
    return typeof params?.limit === 'number' ? rows.slice(0, params.limit) : rows;
  }
  async findOne(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    if (params?.filterByTk !== undefined) return this.rows.find((row) => row.id === params.filterByTk) ?? null;
    return this.rows.find((row) => matches(row, params?.filter)) ?? null;
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
    const targets = this.rows.filter((row) =>
      filterByTk !== undefined && filterByTk !== null ? row.id === filterByTk : matches(row, filter),
    );
    targets.forEach((row) => Object.assign(row, values));
    return targets[0] ?? null;
  }
}

class Db implements EcobaseDatabase {
  repositories = new Map<string, Repo>();
  getRepository(name: string) {
    if (!this.repositories.has(name)) this.repositories.set(name, new Repo());
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Order stamp fixture repository ${name} was not registered.`);
    return repository;
  }
  seed(name: string, rows: Row[]) {
    this.repositories.set(name, new Repo(rows));
  }
  rows(name: string) {
    return this.getRepository(name).rows;
  }
}

const STAMPED_BASELINE = {
  snapshotId: 'baseline-from-true-entry',
  asOf: '2026-06-30',
  ordered: 1,
  inbound: 2,
  stock: 3,
  reserved: 0,
  prepStock: 0,
  awdStock: 0,
};

/**
 * Five orders that between them exercise every branch: an already-stamped order (must not
 * move), one order per fallback source, one with no evidence at all, plus an order sitting in
 * `amazon_inbound` with one baselined and one un-baselined line.
 */
function fixture() {
  const db = new Db();
  db.seed(ECOBASE_COLLECTIONS.silverOrders, [
    {
      id: 'pre-stamped',
      workflowStage: 'in_prep',
      statusChangedAt: '2026-07-15T09:00:00.000Z',
      workflowStageEnteredAt: '2026-07-14T09:00:00.000Z',
      operatorStatusOverrideAt: '2026-07-02T08:00:00.000Z',
      authorityAsOf: '2026-07-03T08:00:00.000Z',
      orderDate: '2026-06-01',
    },
    {
      id: 'all-three-sources',
      workflowStage: 'in_prep',
      statusChangedAt: null,
      workflowStageEnteredAt: null,
      operatorStatusOverrideAt: '2026-07-02T08:00:00.000Z',
      authorityAsOf: '2026-07-03T08:00:00.000Z',
      orderDate: '2026-06-01',
    },
    {
      id: 'authority-only',
      workflowStage: 'in_prep',
      statusChangedAt: null,
      workflowStageEnteredAt: null,
      operatorStatusOverrideAt: null,
      authorityAsOf: new Date('2026-07-04T10:30:00.000Z'),
      orderDate: '2026-06-02',
    },
    {
      id: 'order-date-only',
      workflowStage: 'pre_purchase',
      statusChangedAt: null,
      workflowStageEnteredAt: null,
      orderDate: '2026-06-03',
    },
    {
      id: 'no-evidence',
      workflowStage: 'pre_purchase',
      statusChangedAt: null,
      workflowStageEnteredAt: null,
      operatorStatusOverrideAt: null,
      authorityAsOf: null,
      orderDate: null,
    },
    {
      id: 'inbound-old',
      workflowStage: 'amazon_inbound',
      statusChangedAt: null,
      workflowStageEnteredAt: null,
      operatorStatusOverrideAt: null,
      authorityAsOf: '2026-07-05T00:00:00.000Z',
      orderDate: '2026-06-04',
    },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverOrderLines, [
    { id: 'inbound-line-missing', orderId: 'inbound-old', companyProductId: 'cp-1', inboundEntryBaseline: null },
    {
      id: 'inbound-line-stamped',
      orderId: 'inbound-old',
      companyProductId: 'cp-2',
      inboundEntryBaseline: STAMPED_BASELINE,
    },
    // Same NULL baseline, but its order is not inbound — the sweep must leave it alone.
    { id: 'prep-line-missing', orderId: 'all-three-sources', companyProductId: 'cp-1', inboundEntryBaseline: null },
  ]);
  db.seed(ECOBASE_COLLECTIONS.sourceConnections, [{ id: 'sellerboard-1', sourceType: 'sellerboard', active: true }]);
  // One listing per family keeps every snapshot group fully covered.
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, [
    { id: 'family-1', companyId: 'company-1', amazonAccountId: 'account-1', marketplace: 'Amazon.com' },
    { id: 'family-2', companyId: 'company-1', amazonAccountId: 'account-1', marketplace: 'Amazon.com' },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProducts, [
    { id: 'cp-1', companyId: 'company-1', amazonAccountId: 'account-1', companyProductFamilyId: 'family-1' },
    { id: 'cp-2', companyId: 'company-1', amazonAccountId: 'account-1', companyProductFamilyId: 'family-2' },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverInventorySnapshots, [
    {
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
    {
      id: 'snap-2',
      companyProductId: 'cp-2',
      sourceConnectionId: 'sellerboard-1',
      snapshotDate: '2026-07-20',
      sellableStock: 40,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      awdStock: 0,
    },
  ]);
  return db;
}

function orderById(db: Db, id: string) {
  const order = db.rows(ECOBASE_COLLECTIONS.silverOrders).find((row) => row.id === id);
  if (!order) throw new Error(`Fixture order ${id} is missing.`);
  return order;
}

function lineById(db: Db, id: string) {
  const line = db.rows(ECOBASE_COLLECTIONS.silverOrderLines).find((row) => row.id === id);
  if (!line) throw new Error(`Fixture line ${id} is missing.`);
  return line;
}

function actionContext(values: Record<string, unknown> = {}, currentRoles: string[] = ['admin'], authenticated = true) {
  return {
    action: { params: { values } },
    db: fixture(),
    state: {
      currentUser: authenticated ? { id: 1 } : undefined,
      currentRoles,
    },
    body: undefined as unknown,
    throw(status: number, message: string): never {
      throw Object.assign(new Error(message), { status });
    },
  };
}

describe('order stamp backfill fallback resolution (054 R4)', () => {
  it('prefers operatorStatusOverrideAt, then authorityAsOf, then orderDate, and reports none', () => {
    expect(
      resolveOrderStampFallback({
        operatorStatusOverrideAt: '2026-07-02T08:00:00.000Z',
        authorityAsOf: '2026-07-03T08:00:00.000Z',
        orderDate: '2026-06-01',
      }),
    ).toEqual({ at: '2026-07-02T08:00:00.000Z', source: 'operatorStatusOverrideAt' });
    expect(
      resolveOrderStampFallback({
        operatorStatusOverrideAt: null,
        authorityAsOf: new Date('2026-07-03T08:00:00.000Z'),
        orderDate: '2026-06-01',
      }),
    ).toEqual({ at: '2026-07-03T08:00:00.000Z', source: 'authorityAsOf' });
    // A date-only `orderDate` becomes the exact instant `parseDateMs` already reads it as.
    expect(resolveOrderStampFallback({ orderDate: '2026-06-01' })).toEqual({
      at: '2026-06-01T00:00:00.000Z',
      source: 'orderDate',
    });
    expect(
      resolveOrderStampFallback({ operatorStatusOverrideAt: null, authorityAsOf: null, orderDate: '' }),
    ).toBeNull();
  });
});

describe('EcobaseOrderStampBackfillService (054 R4)', () => {
  it('fills NULL stamps from the fallback chain and leaves stamped orders byte-identical', async () => {
    const db = fixture();
    const preStamped = structuredClone(orderById(db, 'pre-stamped'));

    const result = await new EcobaseOrderStampBackfillService(db).backfillOrderStamps({ dryRun: false });

    expect(orderById(db, 'pre-stamped')).toEqual(preStamped);
    expect(orderById(db, 'all-three-sources')).toMatchObject({
      statusChangedAt: '2026-07-02T08:00:00.000Z',
      workflowStageEnteredAt: '2026-07-02T08:00:00.000Z',
    });
    expect(orderById(db, 'authority-only')).toMatchObject({
      statusChangedAt: '2026-07-04T10:30:00.000Z',
      workflowStageEnteredAt: '2026-07-04T10:30:00.000Z',
    });
    expect(orderById(db, 'order-date-only')).toMatchObject({
      statusChangedAt: '2026-06-03T00:00:00.000Z',
      workflowStageEnteredAt: '2026-06-03T00:00:00.000Z',
    });
    expect(orderById(db, 'no-evidence')).toMatchObject({ statusChangedAt: null, workflowStageEnteredAt: null });

    expect(result).toMatchObject({
      dryRun: false,
      ordersScanned: 6,
      ordersUpdated: 4,
      statusChangedAtFilled: 4,
      workflowStageEnteredAtFilled: 4,
      statusChangedAtSources: { operatorStatusOverrideAt: 1, authorityAsOf: 2, orderDate: 1 },
      workflowStageEnteredAtSources: { operatorStatusOverrideAt: 1, authorityAsOf: 2, orderDate: 1 },
      ordersWithoutFallbackEvidence: 1,
    });
  });

  it('fills each stamp independently — one NULL stamp beside one already set', async () => {
    const db = fixture();
    Object.assign(orderById(db, 'all-three-sources'), { statusChangedAt: '2026-07-19T06:00:00.000Z' });

    const result = await new EcobaseOrderStampBackfillService(db).backfillOrderStamps({ dryRun: false });

    expect(orderById(db, 'all-three-sources')).toMatchObject({
      statusChangedAt: '2026-07-19T06:00:00.000Z',
      workflowStageEnteredAt: '2026-07-02T08:00:00.000Z',
    });
    expect(result).toMatchObject({
      statusChangedAtFilled: 3,
      workflowStageEnteredAtFilled: 4,
      statusChangedAtSources: { operatorStatusOverrideAt: 0, authorityAsOf: 2, orderDate: 1 },
      workflowStageEnteredAtSources: { operatorStatusOverrideAt: 1, authorityAsOf: 2, orderDate: 1 },
    });
  });

  it('stamps sweep-time baselines only on inbound lines that have none', async () => {
    const db = fixture();
    const alreadyBaselined = structuredClone(lineById(db, 'inbound-line-stamped'));
    const notInbound = structuredClone(lineById(db, 'prep-line-missing'));

    const result = await new EcobaseOrderStampBackfillService(db).backfillOrderStamps({ dryRun: false });

    expect(lineById(db, 'inbound-line-missing').inboundEntryBaseline).toEqual({
      snapshotId: expect.any(String),
      asOf: '2026-07-20',
      ordered: 5,
      inbound: 1,
      stock: 8,
      reserved: 2,
      prepStock: 3,
      awdStock: 0,
    });
    expect(lineById(db, 'inbound-line-stamped')).toEqual(alreadyBaselined);
    expect(lineById(db, 'prep-line-missing')).toEqual(notInbound);
    expect(result).toMatchObject({
      inboundOrdersScanned: 1,
      inboundBaselineOrdersStamped: 1,
      inboundBaselineLinesStamped: 1,
      inboundBaselineLinesUnresolved: 0,
      baselineProvenance: 'sweep_time_snapshot',
    });
  });

  it('counts an inbound line whose listing has no usable snapshot without writing it', async () => {
    const db = fixture();
    db.seed(ECOBASE_COLLECTIONS.silverInventorySnapshots, []);

    const result = await new EcobaseOrderStampBackfillService(db).backfillOrderStamps({ dryRun: false });

    expect(lineById(db, 'inbound-line-missing').inboundEntryBaseline).toBeNull();
    expect(result).toMatchObject({
      inboundBaselineOrdersStamped: 0,
      inboundBaselineLinesStamped: 0,
      inboundBaselineLinesUnresolved: 1,
    });
  });

  it('dry-runs by default: writes nothing, reports exactly what the real run does', async () => {
    const previewDb = fixture();
    const ordersBefore = structuredClone(previewDb.rows(ECOBASE_COLLECTIONS.silverOrders));
    const linesBefore = structuredClone(previewDb.rows(ECOBASE_COLLECTIONS.silverOrderLines));

    const defaulted = await new EcobaseOrderStampBackfillService(previewDb).backfillOrderStamps();
    const explicit = await new EcobaseOrderStampBackfillService(previewDb).backfillOrderStamps({ dryRun: true });

    expect(defaulted.dryRun).toBe(true);
    expect(defaulted).toEqual(explicit);
    expect(previewDb.rows(ECOBASE_COLLECTIONS.silverOrders)).toEqual(ordersBefore);
    expect(previewDb.rows(ECOBASE_COLLECTIONS.silverOrderLines)).toEqual(linesBefore);

    const applied = await new EcobaseOrderStampBackfillService(fixture()).backfillOrderStamps({ dryRun: false });
    expect({ ...defaulted, dryRun: false }).toEqual(applied);
  });

  it('is idempotent: the second real run does no work', async () => {
    const db = fixture();
    const first = await new EcobaseOrderStampBackfillService(db).backfillOrderStamps({ dryRun: false });
    const ordersAfterFirst = structuredClone(db.rows(ECOBASE_COLLECTIONS.silverOrders));
    const linesAfterFirst = structuredClone(db.rows(ECOBASE_COLLECTIONS.silverOrderLines));

    const second = await new EcobaseOrderStampBackfillService(db).backfillOrderStamps({ dryRun: false });

    expect(first.ordersUpdated).toBeGreaterThan(0);
    expect(first.inboundBaselineLinesStamped).toBeGreaterThan(0);
    expect(second).toEqual({
      dryRun: false,
      ordersScanned: 6,
      inboundOrdersScanned: 1,
      ordersUpdated: 0,
      statusChangedAtFilled: 0,
      workflowStageEnteredAtFilled: 0,
      statusChangedAtSources: { operatorStatusOverrideAt: 0, authorityAsOf: 0, orderDate: 0 },
      workflowStageEnteredAtSources: { operatorStatusOverrideAt: 0, authorityAsOf: 0, orderDate: 0 },
      inboundBaselineOrdersStamped: 0,
      inboundBaselineLinesStamped: 0,
      // `no-evidence` still has nothing to fill; it is reported every run, never written.
      ordersWithoutFallbackEvidence: 1,
      inboundBaselineLinesUnresolved: 0,
      baselineProvenance: 'sweep_time_snapshot',
    });
    expect(db.rows(ECOBASE_COLLECTIONS.silverOrders)).toEqual(ordersAfterFirst);
    expect(db.rows(ECOBASE_COLLECTIONS.silverOrderLines)).toEqual(linesAfterFirst);
  });

  it('logs the run with the same counts it returns', async () => {
    const entries: unknown[][] = [];
    const result = await new EcobaseOrderStampBackfillService(fixture(), {
      info: (...args: unknown[]) => entries.push(args),
    }).backfillOrderStamps({ dryRun: false });

    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe('Ecobase order stamp backfill completed.');
    expect(entries[0][1]).toEqual(result);
  });
});

describe('backfillOrderStamps admin action (054 R4)', () => {
  it('rejects operators and unauthenticated callers, and admins get a dry run by default', async () => {
    const actions = createEcobaseInventoryPlanningActions();
    const next = async () => {};

    await expect(actions.backfillOrderStamps(actionContext({}, ['operator']), next)).rejects.toThrow(
      'Ecobase backfillOrderStamps requires the admin or root role.',
    );
    await expect(actions.backfillOrderStamps(actionContext({}, ['viewer']), next)).rejects.toThrow(
      'Ecobase backfillOrderStamps requires the admin or root role.',
    );
    await expect(actions.backfillOrderStamps(actionContext({}, ['admin'], false), next)).rejects.toThrow(
      'Ecobase backfillOrderStamps requires an authenticated user.',
    );

    const preview = actionContext({});
    await actions.backfillOrderStamps(preview, next);
    expect(preview.body).toMatchObject({ data: { dryRun: true, ordersScanned: 6, ordersUpdated: 4 } });
    expect(preview.db.rows(ECOBASE_COLLECTIONS.silverOrders).find((row) => row.id === 'order-date-only')).toMatchObject(
      {
        statusChangedAt: null,
      },
    );

    // Only a real boolean `false` opts into writing; a stray string still previews.
    const stringy = actionContext({ dryRun: 'false' });
    await actions.backfillOrderStamps(stringy, next);
    expect(stringy.body).toMatchObject({ data: { dryRun: true } });

    const applied = actionContext({ dryRun: false });
    await actions.backfillOrderStamps(applied, next);
    expect(applied.body).toMatchObject({ data: { dryRun: false, ordersUpdated: 4 } });
    expect(applied.db.rows(ECOBASE_COLLECTIONS.silverOrders).find((row) => row.id === 'order-date-only')).toMatchObject(
      {
        statusChangedAt: '2026-06-03T00:00:00.000Z',
      },
    );
  });

  it('is granted to the admin role only', () => {
    const grants = createGoldEngineMaintenanceResourceRegistration().acl.filter(
      (grant) => grant.resource === 'ecobaseInventoryPlanning',
    );
    const actionsFor = (role: unknown) =>
      grants.filter((grant) => grant.role === role).flatMap((grant) => grant.actions);

    expect(actionsFor(ADMIN)).toContain('backfillOrderStamps');
    expect(actionsFor(OPERATOR)).not.toContain('backfillOrderStamps');
    expect(actionsFor(LOGGED_IN)).not.toContain('backfillOrderStamps');
  });
});
