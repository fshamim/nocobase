/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import { DASHBOARD_PANE_KEYS, isRunSuperseded, type PaneKey } from '../contract';
import { EcobaseInventoryDashboardService, InventoryDashboardValidationError } from '../inventory-dashboard-service';
import type { DashboardDatabase, DashboardRepository, DashboardRepositoryFindParams } from '../published-gold-reader';
import {
  FIXED_NOW,
  FIXED_TODAY,
  FOLLOW_UP_THRESHOLD_HOURS,
  GOLD_ROWS,
  HISTORY_SILVER_ORDERS,
  LEAD_TIME_FRESHNESS_DAYS,
  PUBLISHED_RUN_ID,
  SILVER_COMPANY_PRODUCTS,
  SILVER_FAMILIES,
  SILVER_ORDER_LINES,
  SILVER_ORDERS,
  SILVER_SUPPLIERS,
  SUPERSEDING_RUN_ID,
} from './fixtures/dashboard-fixtures';

interface FindCall {
  collection: string;
  params: DashboardRepositoryFindParams | undefined;
}

class RecordingRepository implements DashboardRepository {
  rows: Record<string, unknown>[] = [];

  constructor(
    private readonly collection: string,
    private readonly findCalls: FindCall[],
  ) {}

  async find(params?: DashboardRepositoryFindParams) {
    this.findCalls.push({ collection: this.collection, params });
    let rows = this.rows.filter((row) => matches(row, params));
    if (params?.sort?.includes('-publishedAt')) {
      rows = [...rows].sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')));
    }
    return typeof params?.limit === 'number' ? rows.slice(0, params.limit) : rows;
  }

  async findOne(params?: DashboardRepositoryFindParams) {
    this.findCalls.push({ collection: this.collection, params });
    return this.rows.find((row) => matches(row, params)) ?? null;
  }

  async create(params: { values: Record<string, unknown> }) {
    // Mirror the real DB: timestamps are stamped on insert.
    this.rows.push({ createdAt: new Date(FIXED_NOW).toISOString(), ...params.values });
    return params.values;
  }

  async update(params: {
    filterByTk?: string | number;
    filter?: Record<string, unknown>;
    values: Record<string, unknown>;
  }) {
    const rows = this.rows.filter((row) => matches(row, params));
    rows.forEach((row) => Object.assign(row, params.values));
    return rows[0] ?? null;
  }
}

class RecordingDatabase implements DashboardDatabase {
  repositories = new Map<string, RecordingRepository>();
  findCalls: FindCall[] = [];

  getRepository(name: string): RecordingRepository {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new RecordingRepository(name, this.findCalls);
    this.repositories.set(name, repo);
    return repo;
  }
}

function matches(row: Record<string, unknown>, params?: DashboardRepositoryFindParams): boolean {
  if (params?.filterByTk !== undefined && row.id !== params.filterByTk) return false;
  return matchesFilter(row, params?.filter ?? {});
}

function matchesFilter(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or' && Array.isArray(value)) {
      return value.some((branch) =>
        matchesFilter(row, typeof branch === 'object' && branch !== null ? (branch as Record<string, unknown>) : {}),
      );
    }
    if (value && typeof value === 'object' && Array.isArray((value as { $in?: unknown[] }).$in)) {
      return (value as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === value;
  });
}

function seed(db: RecordingDatabase, options: { runId?: string } = {}): void {
  const runId = options.runId ?? PUBLISHED_RUN_ID;
  db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
    id: runId,
    status: 'published',
    calculationDate: FIXED_TODAY,
    publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
  });
  for (const row of GOLD_ROWS) {
    db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).rows.push({ ...row, refreshRunId: runId });
  }
  for (const order of SILVER_ORDERS) {
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push({ ...order });
  }
  for (const order of HISTORY_SILVER_ORDERS) {
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push({ ...order });
  }
  for (const line of SILVER_ORDER_LINES) {
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.push({ ...line });
  }
  for (const supplier of SILVER_SUPPLIERS) {
    db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows.push({ ...supplier });
  }
  for (const companyProduct of SILVER_COMPANY_PRODUCTS) {
    db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows.push({ ...companyProduct });
  }
  for (const family of SILVER_FAMILIES) {
    db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).rows.push({ ...family });
  }
}

function service(db: RecordingDatabase) {
  return new EcobaseInventoryDashboardService(db, {
    now: new Date(FIXED_NOW),
    leadTimeFreshnessDays: LEAD_TIME_FRESHNESS_DAYS,
    followUpThresholdHours: FOLLOW_UP_THRESHOLD_HOURS,
  });
}

async function collectAllPanes(svc: EcobaseInventoryDashboardService) {
  const responses = new Map<PaneKey, Awaited<ReturnType<EcobaseInventoryDashboardService['pane']>>>();
  for (const pane of DASHBOARD_PANE_KEYS) {
    responses.set(pane, await svc.pane({ pane, runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 }));
  }
  return responses;
}

describe('EcobaseInventoryDashboardService (Gate G1)', () => {
  let db: RecordingDatabase;
  beforeEach(() => {
    db = new RecordingDatabase();
    seed(db);
  });

  it('(a) family-grain exactly-once: union of family keys across all panes == published families − adminExcluded', async () => {
    const responses = await collectAllPanes(service(db));
    const served = new Set<string>();
    for (const response of responses.values()) {
      if (isRunSuperseded(response)) throw new Error('unexpected supersede');
      for (const row of response.rows) served.add(row.identity.familyKey);
    }
    const expected = new Set(
      GOLD_ROWS.filter((row) => row.primaryActionPane !== 'adminExcluded').map(
        (row) => row.companyProductFamilyId ?? row.familyTargetCompanyProductId ?? row.id,
      ),
    );
    expect(served).toEqual(expected);
  });

  it('(b) order-grain: P2+P3+P4 == distinct active silver orders; multi-order family spans two panes', async () => {
    const responses = await collectAllPanes(service(db));
    const orderPanes: PaneKey[] = ['activeOrders', 'inPrepMonitoring', 'inboundMonitoring'];
    const orderIds = new Set<string>();
    for (const pane of orderPanes) {
      const response = responses.get(pane);
      if (!response || isRunSuperseded(response)) throw new Error('missing order pane');
      for (const row of response.rows) if (row.order) orderIds.add(row.order.orderId);
    }
    const orderPaneSet = new Set(['activeOrders', 'inPrepMonitoring', 'inboundMonitoring']);
    const expectedOrderIds = new Set(
      GOLD_ROWS.filter(
        (row) =>
          row.primaryActionPane !== 'adminExcluded' &&
          row.supplierOrderId &&
          (orderPaneSet.has(row.primaryActionPane) ||
            (row.supplierOrderOperationalStatus === 'direct-ship-fba' &&
              (row.baselineTier !== null || row.currentProjectedTier !== null || row.lastClosedMonthTier !== null) &&
              !['complete', 'cancelled'].includes(row.supplierOrderWorkflowStage ?? ''))),
      ).map((row) => row.supplierOrderId as string),
    );
    expect(orderIds).toEqual(expectedOrderIds);
    expect(orderIds.size).toBe(12);

    const activeOrders = responses.get('activeOrders');
    const inPrep = responses.get('inPrepMonitoring');
    if (!activeOrders || isRunSuperseded(activeOrders) || !inPrep || isRunSuperseded(inPrep)) throw new Error('bad');
    expect(activeOrders.rows.some((row) => row.order?.orderId === 'order-4a')).toBe(true);
    expect(inPrep.rows.some((row) => row.order?.orderId === 'order-4b')).toBe(true);
  });

  it('(c) adminExcluded is never served; untiered operational row lands in P11 with reason untiered_projected', async () => {
    const responses = await collectAllPanes(service(db));
    for (const response of responses.values()) {
      if (isRunSuperseded(response)) throw new Error('bad');
      expect(response.rows.some((row) => row.identity.asin === 'B0006')).toBe(false);
    }
    const untiered = responses.get('untieredProducts');
    if (!untiered || isRunSuperseded(untiered)) throw new Error('bad');
    const projected = untiered.rows.find((row) => row.identity.asin === 'B0007');
    expect(projected).toBeDefined();
    expect(projected?.reasonCodes).toContain('untiered_projected');
  });

  it('(d) header tile counts, money sums and unknownCounts match the fixture recount', async () => {
    const header = await service(db).header();
    expect(header.publishedRunId).toBe(PUBLISHED_RUN_ID);
    const byKey = new Map(header.tiles.map((tile) => [tile.key, tile]));
    // T-D5: the third (badge) branch adds f-urgent-badge — money unknown by design.
    expect(byKey.get('urgentStockout')).toMatchObject({ count: 3, moneyAtRisk: null, unknownCount: 3 });
    expect(byKey.get('orderedButLate')).toMatchObject({ count: 1, moneyAtRisk: 500, unknownCount: 0 });
    expect(byKey.get('staleLeadTimes')).toMatchObject({ count: 1, moneyAtRisk: 250, unknownCount: 1 });
    expect(byKey.get('needsFollowUp')).toMatchObject({ count: 6, moneyAtRisk: 500, unknownCount: 5 });
    expect(byKey.get('stuckCapital')).toMatchObject({ count: 1, moneyAtRisk: null, unknownCount: 1 });
  });

  it('(e) sorts P1 by latestSafeReorderDate with nulls last, both directions; pagination is stable', async () => {
    const local = new RecordingDatabase();
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    const goldRepo = local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    for (const [id, reorder] of [
      ['s-b', '2026-07-25'],
      ['s-null', null],
      ['s-a', '2026-07-20'],
      ['s-c', '2026-07-30'],
    ] as const) {
      goldRepo.rows.push({
        id,
        naturalKey: id,
        refreshRunId: PUBLISHED_RUN_ID,
        primaryActionPane: 'supplyAction',
        companyProductFamilyId: `family-${id}`,
        baselineTier: 'A',
        currentProjectedTier: 'A',
        latestSafeReorderDate: reorder,
      });
    }
    const svc = service(local);
    const asc = await svc.pane({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 200,
      sort: 'latestSafeReorderDate',
      sortDirection: 'asc',
    });
    const desc = await svc.pane({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 200,
      sort: 'latestSafeReorderDate',
      sortDirection: 'desc',
    });
    if (isRunSuperseded(asc) || isRunSuperseded(desc)) throw new Error('bad');
    expect(asc.rows.map((row) => row.identity.sku ?? row.identity.familyKey.replace('family-', ''))).toBeTruthy();
    expect(asc.rows.map((row) => row.latestSafeReorderDate)).toEqual(['2026-07-20', '2026-07-25', '2026-07-30', null]);
    expect(desc.rows.map((row) => row.latestSafeReorderDate)).toEqual(['2026-07-30', '2026-07-25', '2026-07-20', null]);

    const p1 = await svc.pane({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 2,
      sort: 'latestSafeReorderDate',
      sortDirection: 'asc',
    });
    const p2 = await svc.pane({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      page: 2,
      pageSize: 2,
      sort: 'latestSafeReorderDate',
      sortDirection: 'asc',
    });
    if (isRunSuperseded(p1) || isRunSuperseded(p2)) throw new Error('bad');
    expect(p1.pagination).toMatchObject({ page: 1, pageSize: 2, total: 4 });
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows.map((row) => row.latestSafeReorderDate)).toEqual(['2026-07-30', null]);
  });

  it('(f) every pane response carries the publishedRunId; a stale pinned run yields runSuperseded', async () => {
    const responses = await collectAllPanes(service(db));
    for (const response of responses.values()) {
      if (isRunSuperseded(response)) throw new Error('bad');
      expect(response.publishedRunId).toBe(PUBLISHED_RUN_ID);
    }
    // Republish mid-session: the published run changes; the old pinned runId is superseded.
    db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: SUPERSEDING_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T12:00:00.000Z`,
    });
    const stale = await service(db).pane({ pane: 'supplyAction', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 25 });
    expect(isRunSuperseded(stale)).toBe(true);
    if (isRunSuperseded(stale)) expect(stale.publishedRunId).toBe(SUPERSEDING_RUN_ID);
  });

  it('(g) query budget: gold fetched exactly once, silver join uses $in <= pageSize, no unscoped finds', async () => {
    const svc = service(db);
    db.findCalls.length = 0;
    await svc.pane({ pane: 'inPrepMonitoring', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 3 });
    const goldFinds = db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    expect(goldFinds).toHaveLength(1);
    const silverFinds = db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.silverOrders);
    expect(silverFinds).toHaveLength(1);
    const inClause = (silverFinds[0].params?.filter?.id as { $in?: unknown[] } | undefined)?.$in;
    expect(Array.isArray(inClause)).toBe(true);
    expect((inClause ?? []).length).toBeLessThanOrEqual(3);
    const supplierFinds = db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.silverSuppliers);
    expect(supplierFinds.length).toBeLessThanOrEqual(1);
    if (supplierFinds.length === 1) {
      const supplierIn = (supplierFinds[0].params?.filter?.id as { $in?: unknown[] } | undefined)?.$in;
      expect(Array.isArray(supplierIn)).toBe(true);
      expect((supplierIn ?? []).length).toBeLessThanOrEqual(3);
    }
    // T5: exactly ONE comment query per page; every $or branch page-scoped by $in.
    const commentFinds = db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.silverActivityComments);
    expect(commentFinds).toHaveLength(1);
    const orBranches = (commentFinds[0].params?.filter?.$or as Array<Record<string, unknown>> | undefined) ?? [];
    expect(orBranches.length).toBeGreaterThan(0);
    for (const branch of orBranches) {
      const branchIn = (branch.entityId as { $in?: unknown[] } | undefined)?.$in;
      expect(Array.isArray(branchIn)).toBe(true);
      expect((branchIn ?? []).length).toBeLessThanOrEqual(3);
    }
    // T5: at most one page-scoped users lookup (only when comments matched).
    expect(db.findCalls.filter((call) => call.collection === 'users').length).toBeLessThanOrEqual(1);
    // No find call may omit BOTH filter and limit (unscoped full scan).
    for (const call of db.findCalls) {
      const scoped =
        Boolean(call.params?.filter) || typeof call.params?.limit === 'number' || Boolean(call.params?.filterByTk);
      expect(scoped, `${call.collection} scoped`).toBe(true);
    }
  });

  it('(g) constant gold query count under a 5k-row synthetic fixture', async () => {
    const big = new RecordingDatabase();
    big.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    const goldRepo = big.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    for (let index = 0; index < 5000; index += 1) {
      goldRepo.rows.push({
        id: `syn-${index}`,
        naturalKey: `syn-${index}`,
        refreshRunId: PUBLISHED_RUN_ID,
        primaryActionPane: 'healthyInventory',
        companyProductFamilyId: `family-syn-${index}`,
        baselineTier: 'A',
        currentProjectedTier: 'A',
      });
    }
    big.findCalls.length = 0;
    await service(big).pane({ pane: 'healthyInventory', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 25 });
    expect(
      big.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.goldInventoryPlanningRows),
    ).toHaveLength(1);
  });

  it('(g) T4 widened projection: buckets, velocity provenance, profit stats and supplier lead time served verbatim', async () => {
    const svc = service(db);
    const response = await svc.pane({ pane: 'supplyAction', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(response)) throw new Error('bad');
    const enriched = response.rows.find((row) => row.identity.asin === 'B0011A');
    expect(enriched).toMatchObject({
      stock: {
        currentPlanningStock: 100,
        inventoryPositionStock: 100,
        unitCost: 5,
        sellableStock: 40,
        reservedStock: 5,
        inboundStock: 10,
        prepStock: 0,
        orderedStock: 20,
        awdStock: 0,
        futurePositionStock: 70,
      },
      velocity: { value: 8, basis: 'rolling_30', asOfDate: FIXED_TODAY, evidenceStatus: 'trusted_positive' },
      supplier: {
        id: 'supplier-lead-1',
        name: 'Lead Boundary Supplies',
        leadTimeDays: 30,
        leadTimeFreshness: 'default',
      },
      profit: {
        averageMonthly: 900,
        bestMonthly: 1400,
        worstMonthly: 500,
        lastClosedMonth: 1100,
        projectedMonthly: 1200,
        perUnit: 3.75,
      },
      daysOfCover: 5,
      positionDaysOfCover: 8.75,
      daysUntilSafeReorder: -35.25,
      moneyRiskStatus: 'at_risk',
      moneyRiskUncoveredDays: 28,
    });
    expect(enriched?.positionEstimatedOosDate).toEqual(expect.any(String));
    // Nulls stay null on a row without the widened columns (never coerced to 0).
    const bare = response.rows.find((row) => row.identity.asin === 'B0011B');
    expect(bare?.velocity).toEqual({ value: null, basis: null, asOfDate: null, evidenceStatus: null });
    expect(bare?.stock.sellableStock).toBeNull();
    expect(bare?.stock.futurePositionStock).toBeNull();
    expect(bare?.profit.perUnit).toBeNull();
    expect(bare?.supplier.id).toBeNull();
    expect(bare?.supplier.leadTimeDays).toBeNull();
    expect(bare?.moneyRiskStatus).toBeNull();
    // D3 chart input: drawer evidence now carries per-month profit.
    const drawer = await svc.drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: enriched?.identity.familyKey ?? '',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.performanceEvidence[1]).toMatchObject({ units: 200, profit: 800, trusted: true });
    expect(drawer.performanceEvidence).toHaveLength(6);
  });

  it('(h) rejects unknown panes and sorts, including prototype-pollution probes', async () => {
    const svc = service(db);
    await expect(
      svc.pane({ pane: '__proto__' as PaneKey, runId: PUBLISHED_RUN_ID, page: 1, pageSize: 25 }),
    ).rejects.toBeInstanceOf(InventoryDashboardValidationError);
    await expect(
      svc.pane({ pane: 'notapane' as PaneKey, runId: PUBLISHED_RUN_ID, page: 1, pageSize: 25 }),
    ).rejects.toBeInstanceOf(InventoryDashboardValidationError);
    await expect(
      svc.pane({ pane: 'supplyAction', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 25, sort: 'evidence' }),
    ).rejects.toBeInstanceOf(InventoryDashboardValidationError);
  });

  it('flags staleClassification for gold in_prep vs silver amazon_inbound but keeps the gold pane', async () => {
    const inPrep = await service(db).pane({
      pane: 'inPrepMonitoring',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 200,
    });
    if (isRunSuperseded(inPrep)) throw new Error('bad');
    const stale = inPrep.rows.find((row) => row.order?.orderId === 'order-5');
    expect(stale?.staleClassification).toBe(true);
    // direct-ship-fba must not appear in P3.
    expect(inPrep.rows.some((row) => row.order?.orderId === 'order-3')).toBe(false);
  });

  it('renders daysInStage null (unknown) when workflowStageEnteredAt is null; orphan orders have null lastActivity', async () => {
    const inPrep = await service(db).pane({
      pane: 'inPrepMonitoring',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 200,
    });
    const active = await service(db).pane({ pane: 'activeOrders', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(inPrep) || isRunSuperseded(active)) throw new Error('bad');
    const nullStage = inPrep.rows.find((row) => row.order?.orderId === 'order-12');
    expect(nullStage?.order?.daysInStage).toBeNull();
    const orphan = active.rows.find((row) => row.order?.orderId === 'order-10-orphan');
    expect(orphan?.lastActivity).toBeNull();
  });

  it('derives prepPath via the AD-7 v3.1 precedence (status > supplier shipDestination > unknown)', async () => {
    const svc = service(db);
    const inPrep = await svc.pane({ pane: 'inPrepMonitoring', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    const inbound = await svc.pane({ pane: 'inboundMonitoring', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(inPrep) || isRunSuperseded(inbound)) throw new Error('bad');
    const byOrder = (rows: typeof inPrep.rows, orderId: string) => rows.find((row) => row.order?.orderId === orderId);
    // Branch 2: supplier ships to our prep center.
    expect(byOrder(inPrep.rows, 'order-1a')?.order?.prepPath).toBe('own_prep_center');
    expect(byOrder(inPrep.rows, 'order-1a')?.order?.supplierShipDestination).toBe('prep_center');
    // Branch 3: no signal -> unknown, never guessed.
    expect(byOrder(inPrep.rows, 'order-12')?.order?.prepPath).toBe('unknown');
    // Branch 1: order status direct-ship-fba wins.
    expect(byOrder(inbound.rows, 'order-3')?.order?.prepPath).toBe('direct_fba');
    // Branch 2 on an inbound order: supplier-level direct_fba.
    expect(byOrder(inbound.rows, 'order-2a')?.order?.prepPath).toBe('direct_fba');
  });

  it('excludes completed direct-ship orders from the P4 union (T-3.0c c)', async () => {
    const svc = service(db);
    const inbound = await svc.pane({ pane: 'inboundMonitoring', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    const healthy = await svc.pane({ pane: 'healthyInventory', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(inbound) || isRunSuperseded(healthy)) throw new Error('bad');
    expect(inbound.rows.some((row) => row.order?.orderId === 'order-direct-complete')).toBe(false);
    expect(healthy.rows.some((row) => row.identity.asin === 'B0020')).toBe(true);
  });

  it('projects untiered active direct-ship rows to P11 with untiered_projected, never P4 (G4 audit fix)', async () => {
    const svc = service(db);
    const inbound = await svc.pane({ pane: 'inboundMonitoring', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    const untiered = await svc.pane({ pane: 'untieredProducts', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(inbound) || isRunSuperseded(untiered)) throw new Error('bad');
    expect(inbound.rows.some((row) => row.identity.asin === 'B0021')).toBe(false);
    const projected = untiered.rows.find((row) => row.identity.asin === 'B0021');
    expect(projected).toBeDefined();
    expect(projected?.reasonCodes).toContain('untiered_projected');
  });

  it('surfaces a freshly posted order comment in lastActivity and follow-up immediately (QA item 1)', async () => {
    // order-1a starts with NO activity and >48h in stage -> needsFollowUp true.
    const before = await service(db).pane({
      pane: 'inPrepMonitoring',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 200,
    });
    if (isRunSuperseded(before)) throw new Error('bad');
    const beforeRow = before.rows.find((row) => row.order?.orderId === 'order-1a');
    expect(beforeRow?.lastActivity).toBeNull();
    expect(beforeRow?.order?.needsFollowUp).toBe(true);

    // T5: the author resolves through the page-scoped users lookup.
    db.getRepository('users').rows.push({ id: 4, nickname: 'Ops Anna', email: 'anna@acme.test' });
    // Persist a comment in the exact shape order-planning addComment writes
    // (the action->row persistence itself is proven in drawer-actions.test.ts).
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'comment-fresh-1',
        entityType: 'order',
        entityId: 'order-1a',
        actorType: 'operator',
        actorUserId: 4,
        commentType: 'note',
        body: 'Fresh drawer comment',
        workflowDetectionStatus: 'none',
      },
    });

    // The scoped refetch (same pinned run, NO gold refresh) must show it.
    const after = await service(db).pane({ pane: 'inPrepMonitoring', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(after)) throw new Error('bad');
    const afterRow = after.rows.find((row) => row.order?.orderId === 'order-1a');
    expect(afterRow?.lastActivity?.preview).toBe('Fresh drawer comment');
    // T5: the v1 author-null behavior for fresh comments is gone.
    expect(afterRow?.lastActivity?.author).toBe('Ops Anna');
    // A fresh comment resets the follow-up flag (activity is now recent).
    expect(afterRow?.order?.needsFollowUp).toBe(false);

    // Drawer context shows it too.
    const drawer = await service(db).drawerContext({
      pane: 'inPrepMonitoring',
      runId: PUBLISHED_RUN_ID,
      familyId: afterRow?.identity.familyKey ?? '',
      orderId: 'order-1a',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.primaryRow.lastActivity?.preview).toBe('Fresh drawer comment');

    // Header tile respects the fresh activity as well.
    const header = await service(db).header();
    const tile = header.tiles.find((candidate) => candidate.key === 'needsFollowUp');
    expect(tile?.count).toBe(5); // was 6 before the comment
  });

  it('T5 (F5): an order-less Supply Action row surfaces the newest family comment with a resolved author', async () => {
    db.getRepository('users').rows.push({ id: 7, nickname: 'Planner Pia' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'comment-family-1',
        entityType: 'company_product_family',
        entityId: 'family-f11a-lead-boundary',
        actorType: 'operator',
        actorUserId: 7,
        commentType: 'note',
        body: 'Family-level note for the supply pane',
        occurredAt: new Date(Date.parse(FIXED_NOW) - 2 * 3_600_000).toISOString(),
        workflowDetectionStatus: 'none',
      },
    });

    const response = await service(db).pane({ pane: 'supplyAction', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(response)) throw new Error('bad');
    const row = response.rows.find((candidate) => candidate.identity.asin === 'B0011A');
    expect(row?.order).toBeUndefined();
    expect(row?.lastActivity).toMatchObject({
      preview: 'Family-level note for the supply pane',
      author: 'Planner Pia',
    });
    // Rows without any linked comment stay explicitly null (no invented activity).
    const bare = response.rows.find((candidate) => candidate.identity.asin === 'B0011B');
    expect(bare?.lastActivity).toBeNull();

    // The drawer primary row carries it too.
    const drawer = await service(db).drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: row?.identity.familyKey ?? '',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.primaryRow.lastActivity?.preview).toBe('Family-level note for the supply pane');
  });

  it('T5: a newer supplier comment wins the DISPLAYED activity while needsFollowUp stays order-scoped', async () => {
    db.getRepository('users').rows.push({ id: 9, nickname: 'Buyer Bo' });
    // Stale ORDER comment (72h > 48h threshold) — governs follow-up.
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'comment-order-old',
        entityType: 'order',
        entityId: 'order-1a',
        actorType: 'operator',
        actorUserId: 9,
        commentType: 'note',
        body: 'Old order note',
        occurredAt: new Date(Date.parse(FIXED_NOW) - 72 * 3_600_000).toISOString(),
        workflowDetectionStatus: 'none',
      },
    });
    // Fresh SUPPLIER comment (1h) — newest across the row's linked entities.
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'comment-supplier-new',
        entityType: 'supplier',
        entityId: 'supplier-prep-center',
        actorType: 'operator',
        actorUserId: 9,
        commentType: 'note',
        body: 'Supplier called back with a new ETA',
        occurredAt: new Date(Date.parse(FIXED_NOW) - 1 * 3_600_000).toISOString(),
        workflowDetectionStatus: 'none',
      },
    });

    const response = await service(db).pane({
      pane: 'inPrepMonitoring',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 200,
    });
    if (isRunSuperseded(response)) throw new Error('bad');
    const row = response.rows.find((candidate) => candidate.order?.orderId === 'order-1a');
    expect(row?.lastActivity).toMatchObject({ preview: 'Supplier called back with a new ETA', author: 'Buyer Bo' });
    // Follow-up ignores family/product/supplier chatter: the 72h-old ORDER
    // comment is the effective activity, so the flag stays raised.
    expect(row?.order?.needsFollowUp).toBe(true);
  });

  it('T6 (D5): drawer carries the family order history, per-order aggregated, newest first, with maxEverOrderedQty', async () => {
    const drawer = await service(db).drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-f11a-lead-boundary',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.orderHistory).toEqual([
      { orderDate: '2026-07-01', orderedQty: 120, supplierName: 'Lead Boundary Supplies', status: 'complete' },
      // 200 + 50 member lines of order-h2 aggregate into one entry.
      { orderDate: '2026-05-15', orderedQty: 250, supplierName: 'Lead Boundary Supplies', status: 'complete' },
      { orderDate: '2026-03-10', orderedQty: 80, supplierName: 'Unknown Route Supplier', status: 'hold/cancelled' },
    ]);
    // The unresolved-mapping line (qty 999) never contributes (pipeline parity).
    expect(drawer.maxEverOrderedQty).toBe(250);
  });

  it('T6 (D5): history caps at 12 entries while maxEverOrderedQty spans the FULL history', async () => {
    const local = new RecordingDatabase();
    seed(local);
    const goldRepo = local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    goldRepo.rows.push({
      id: 'syn-hist-row',
      naturalKey: 'syn-hist-row',
      refreshRunId: PUBLISHED_RUN_ID,
      primaryActionPane: 'supplyAction',
      companyProductFamilyId: 'family-syn-hist',
      companyProductId: 'cp-syn-hist',
      baselineTier: 'A',
    });
    const orders = local.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    const lines = local.getRepository(ECOBASE_COLLECTIONS.silverOrderLines);
    for (let index = 1; index <= 14; index += 1) {
      orders.rows.push({
        id: `hist-${index}`,
        orderDate: `2026-05-${String(index).padStart(2, '0')}`,
        operationalStatus: 'complete',
      });
      lines.rows.push({
        id: `hist-line-${index}`,
        orderId: `hist-${index}`,
        companyProductId: 'cp-syn-hist',
        // The OLDEST order (dropped by the cap) carries the all-time max qty.
        orderedQty: index === 1 ? 999 : index,
        productMappingStatus: 'resolved',
      });
    }
    const drawer = await service(local).drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-syn-hist',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.orderHistory).toHaveLength(12);
    expect(drawer.orderHistory[0]).toMatchObject({ orderDate: '2026-05-14', orderedQty: 14 });
    expect(drawer.orderHistory.some((entry) => entry.orderedQty === 999)).toBe(false);
    expect(drawer.maxEverOrderedQty).toBe(999);
  });

  it('T6 (D6): drawer carries the full comment thread, newest first, entity names mapped, authors resolved', async () => {
    db.getRepository('users').rows.push({ id: 7, nickname: 'Planner Pia' });
    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    const at = (hoursBack: number) => new Date(Date.parse(FIXED_NOW) - hoursBack * 3_600_000).toISOString();
    comments.rows.push(
      {
        id: 'thread-family',
        entityType: 'company_product_family',
        entityId: 'family-f11a-lead-boundary',
        actorUserId: 7,
        body: 'Family note',
        occurredAt: at(2),
      },
      {
        id: 'thread-product',
        entityType: 'company_product',
        entityId: 'cp-f11a',
        actorUserId: 7,
        body: 'Product note',
        occurredAt: at(5),
      },
      {
        id: 'thread-supplier',
        entityType: 'supplier',
        entityId: 'supplier-lead-1',
        actorUserId: null,
        body: 'Supplier note',
        occurredAt: at(1),
      },
    );
    const drawer = await service(db).drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-f11a-lead-boundary',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.commentThread).toEqual([
      { entityType: 'supplier', body: 'Supplier note', author: null, at: at(1) },
      { entityType: 'family', body: 'Family note', author: 'Planner Pia', at: at(2) },
      { entityType: 'product', body: 'Product note', author: 'Planner Pia', at: at(5) },
    ]);
    // The newest thread entry doubles as the row-level lastActivity.
    expect(drawer.primaryRow.lastActivity?.preview).toBe('Supplier note');
  });

  it('T6 (D3): a supplyAction drawer carries every chart input — 6 months of profit, best/worst, projected', async () => {
    const drawer = await service(db).drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-f11a-lead-boundary',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.performanceEvidence).toHaveLength(6);
    expect(drawer.performanceEvidence.every((point) => point.profit !== null && point.trusted)).toBe(true);
    expect(drawer.performanceEvidence.map((point) => point.profit)).toEqual([400, 800, 600, 720, 480, 640]);
    expect(drawer.primaryRow.profit).toMatchObject({
      bestMonthly: 1400,
      worstMonthly: 500,
      projectedMonthly: 1200,
      averageMonthly: 900,
      lastClosedMonth: 1100,
    });
  });

  it('(g) T6 drawer budget: history/thread joins $in-scoped; rawGoldRow costs one extra fetch ONLY when requested', async () => {
    const svc = service(db);
    db.findCalls.length = 0;
    const plain = await svc.drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-f11a-lead-boundary',
    });
    if (isRunSuperseded(plain)) throw new Error('bad');
    expect(plain.rawGoldRow).toBeUndefined();
    const goldFinds = db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    expect(goldFinds).toHaveLength(1);
    const lineFinds = db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.silverOrderLines);
    expect(lineFinds).toHaveLength(1);
    const lineIn = (lineFinds[0].params?.filter?.companyProductId as { $in?: unknown[] } | undefined)?.$in;
    expect(lineIn).toEqual(['cp-f11a']);
    expect(db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.silverActivityComments)).toHaveLength(
      1,
    );
    expect(db.findCalls.filter((call) => call.collection === 'users').length).toBeLessThanOrEqual(1);

    db.findCalls.length = 0;
    const withRaw = await svc.drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-f11a-lead-boundary',
      includeRaw: true,
    });
    if (isRunSuperseded(withRaw)) throw new Error('bad');
    expect(
      db.findCalls.filter((call) => call.collection === ECOBASE_COLLECTIONS.goldInventoryPlanningRows),
    ).toHaveLength(2);
    const raw = withRaw.rawGoldRow ?? {};
    // Internal bookkeeping stripped (D1), full column set otherwise — including
    // columns the projection reader never fetches.
    expect(raw.id).toBeUndefined();
    expect(raw.naturalKey).toBeUndefined();
    expect(raw.refreshRunId).toBeUndefined();
    expect('supplierOrderStatus' in raw).toBe(true);
    expect(raw.asin).toBe('B0011A');
  });

  it('T-D5: stockout urgency signal — tiered near-OOS rows OUTSIDE action panes only (pinned clock)', async () => {
    const local = new RecordingDatabase();
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    const goldRepo = local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const push = (id: string, pane: string, overrides: Record<string, unknown>) =>
      goldRepo.rows.push({
        id,
        naturalKey: id,
        refreshRunId: PUBLISHED_RUN_ID,
        primaryActionPane: pane,
        companyProductFamilyId: `family-${id}`,
        baselineTier: 'A',
        currentProjectedTier: 'A',
        ...overrides,
      });
    push('sig-near', 'healthyInventory', { positionEstimatedOosDate: '2026-08-01' }); // +11 d
    push('sig-passed', 'excessInventory', { positionEstimatedOosDate: '2026-07-18' }); // -3 d
    push('sig-far', 'healthyInventory', { positionEstimatedOosDate: '2026-09-30' }); // +71 d -> absent
    push('sig-untiered', 'dataReadiness', {
      baselineTier: null,
      currentProjectedTier: null,
      positionEstimatedOosDate: '2026-07-26',
    }); // tier rule -> absent
    push('sig-action-pane', 'supplyAction', {
      positionEstimatedOosDate: '2026-07-26',
      latestSafeReorderDate: '2026-07-20', // passed -> existing branch A
      estimatedProfitRisk: 100,
    }); // exempt pane -> no badge field
    push('sig-zero', 'zeroStock', { positionEstimatedOosDate: null }); // existing branch B

    const svc = service(local);
    const healthy = await svc.pane({ pane: 'healthyInventory', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(healthy)) throw new Error('bad');
    expect(healthy.rows.find((row) => row.identity.listingRowId === 'sig-near')?.stockoutUrgency).toEqual({
      daysUntil: 11,
    });
    expect(healthy.rows.find((row) => row.identity.listingRowId === 'sig-far')?.stockoutUrgency).toBeUndefined();
    const excess = await svc.pane({ pane: 'excessInventory', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(excess)) throw new Error('bad');
    expect(excess.rows.find((row) => row.identity.listingRowId === 'sig-passed')?.stockoutUrgency).toEqual({
      daysUntil: -3,
    });
    const readiness = await svc.pane({ pane: 'dataReadiness', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(readiness)) throw new Error('bad');
    expect(readiness.rows.find((row) => row.identity.listingRowId === 'sig-untiered')?.stockoutUrgency).toBeUndefined();
    const supply = await svc.pane({ pane: 'supplyAction', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(supply)) throw new Error('bad');
    expect(supply.rows.find((row) => row.identity.listingRowId === 'sig-action-pane')?.stockoutUrgency).toBeUndefined();

    // Tile third branch: union of the three branches, DISTINCT families, and
    // the badge families flow into unknownCount (their money is null by design).
    const header = await svc.header();
    const tile = header.tiles.find((candidate) => candidate.key === 'urgentStockout');
    expect(tile?.count).toBe(4); // supply-passed + zero + near + passed (far/untiered excluded)
    expect(tile?.moneyAtRisk).toBe(100); // only the supplyAction row carries money
    expect(tile?.unknownCount).toBe(3); // zero + the two badge families
    expect(tile?.targetPane).toBe('supplyAction');
  });

  it('T-QA1: rawGoldRow is a PLAIN flat record even when the repository returns a live model instance', async () => {
    const local = new RecordingDatabase();
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    const business = {
      id: 'orm-row',
      naturalKey: 'orm-row',
      refreshRunId: PUBLISHED_RUN_ID,
      primaryActionPane: 'supplyAction',
      companyProductFamilyId: 'family-orm',
      baselineTier: 'A',
      salesVelocity: 1.5,
      targetCoverDays: 45,
      supplierOrderStatus: null,
    };
    // Sequelize-shaped instance: attribute getters work, but the ENUMERABLE
    // keys are ORM internals — exactly what QA saw leak into the Data tab.
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).rows.push({
      ...business,
      dataValues: { ...business },
      _changed: {},
      _previousDataValues: { ...business },
      isNewRecord: false,
      uniqno: 1,
      toJSON() {
        return { ...business };
      },
    });
    const drawer = await service(local).drawerContext({
      pane: 'supplyAction',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-orm',
      includeRaw: true,
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    const raw = drawer.rawGoldRow ?? {};
    // Flat business keys at the TOP level...
    expect(raw.salesVelocity).toBe(1.5);
    expect(raw.targetCoverDays).toBe(45);
    expect('supplierOrderStatus' in raw).toBe(true);
    // ...none of the ORM wrapper keys...
    for (const key of ['dataValues', '_changed', '_previousDataValues', 'isNewRecord', 'uniqno', 'toJSON']) {
      expect(key in raw, `${key} leaked`).toBe(false);
    }
    // ...and the bookkeeping strip still applies.
    expect(raw.id).toBeUndefined();
    expect(raw.naturalKey).toBeUndefined();
    expect(raw.refreshRunId).toBeUndefined();
  });

  it('T-D5 rider: targetCoverDays is served on the row (reader widened)', async () => {
    const response = await service(db).pane({ pane: 'supplyAction', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
    if (isRunSuperseded(response)) throw new Error('bad');
    const enriched = response.rows.find((row) => row.identity.asin === 'B0011A');
    expect(enriched?.targetCoverDays).toBe(45);
    expect(enriched?.recommendedOrderQty).toBe(520);
  });

  it('exposes the family target identity + selection provenance in drawerContext (QA item 2)', async () => {
    const drawer = await service(db).drawerContext({
      pane: 'healthyInventory',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-13',
      listingRowId: 'f13b-split-healthy',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.familyTarget).toEqual({
      companyProductId: 'cp-13a',
      selectionSource: 'automatic',
      selectionRule: 'tiered_first_migration_rule',
    });
    const target = drawer.familyMembers.find((member) => member.isTarget);
    expect(target?.listingRowId).toBe('f13a-split-supply');
    expect(drawer.familyMembers.filter((member) => member.isTarget)).toHaveLength(1);
    // No persisted family record -> familyTarget null, nobody marked.
    const reviewDrawer = await service(db).drawerContext({
      pane: 'dataReadiness',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-f-readiness',
    });
    if (isRunSuperseded(reviewDrawer)) throw new Error('bad');
    expect(reviewDrawer.familyTarget).toBeNull();
    expect(reviewDrawer.familyMembers.some((member) => member.isTarget)).toBe(false);
  });

  it('serves lifecyclePreviousStatus on the drawer primary row (QA item 3)', async () => {
    const drawer = await service(db).drawerContext({
      pane: 'discontinuedPaused',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-disc',
      listingRowId: 'f-disc-a',
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.primaryRow.lifecycleProvenance).toBe('migration_sweep_2026_07');
    expect(drawer.primaryRow.lifecyclePreviousStatus).toBe('candidate_new_product');
  });

  it('uses the clicked listing as the drawer primary row (QA item 7)', async () => {
    const clicked = 'f13b-split-healthy'; // family-13 member that is NOT the supply-action row
    const drawer = await service(db).drawerContext({
      pane: 'healthyInventory',
      runId: PUBLISHED_RUN_ID,
      familyId: 'family-13',
      listingRowId: clicked,
    });
    if (isRunSuperseded(drawer)) throw new Error('bad');
    expect(drawer.primaryRow.identity.listingRowId).toBe(clicked);
    expect(drawer.familyMembers.length).toBe(2);
  });

  it('falls back to primaryActionReasonCode when readinessReasonCodes is empty (QA item 7b)', async () => {
    const local = new RecordingDatabase();
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).rows.push({
      id: 'readiness-empty',
      naturalKey: 'readiness-empty',
      refreshRunId: PUBLISHED_RUN_ID,
      primaryActionPane: 'dataReadiness',
      primaryActionReasonCode: 'missing_or_invalid_baseline_evidence',
      companyProductFamilyId: 'family-readiness-empty',
      baselineTier: 'A',
      readinessReasonCodes: [],
    });
    const response = await service(local).pane({
      pane: 'dataReadiness',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 25,
    });
    if (isRunSuperseded(response)) throw new Error('bad');
    expect(response.rows[0]?.reasonCodes).toEqual(['missing_or_invalid_baseline_evidence']);
  });

  it('reads REAL gold evidence keys (monthStart/monthlyUnits/eligible) for bands and trends', async () => {
    const local = new RecordingDatabase();
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).rows.push({
      id: 'real-evidence-row',
      naturalKey: 'real-evidence-row',
      refreshRunId: PUBLISHED_RUN_ID,
      primaryActionPane: 'performanceReview',
      companyProductFamilyId: 'family-real-evidence',
      baselineTier: 'A',
      // Verbatim key shape from gold-row-samples (tier-A.json).
      monthlyPerformanceEvidence: [
        { monthStart: '2026-01-01', monthEnd: '2026-01-31', eligible: true, monthlyUnits: 100 },
        { monthStart: '2026-02-01', monthEnd: '2026-02-28', eligible: true, monthlyUnits: 200 },
        { monthStart: '2026-03-01', monthEnd: '2026-03-31', eligible: true, monthlyUnits: 150 },
        { monthStart: '2026-04-01', monthEnd: '2026-04-30', eligible: false, monthlyUnits: null },
      ],
      projectedMonthlyUnits: 80,
      lastClosedMonthUnits: 150,
    });
    const response = await service(local).pane({
      pane: 'performanceReview',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 25,
    });
    if (isRunSuperseded(response)) throw new Error('bad');
    const row = response.rows[0];
    expect(row?.performanceBand).toBe('below_band'); // 80 < worst(100), 3 eligible months
    expect(row?.velocityTrend).toBe('down'); // 80 vs 150
  });

  it('handles Postgres Date instances in datetime columns (G4 audit regression)', async () => {
    // Real repositories return Date objects for datetimeTz columns; string-only
    // coercion silently nulled stage-entry/activity/lead-time timestamps.
    const local = new RecordingDatabase();
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).rows.push({
      id: 'date-row',
      naturalKey: 'date-row',
      refreshRunId: PUBLISHED_RUN_ID,
      primaryActionPane: 'inPrepMonitoring',
      companyProductFamilyId: 'family-date-row',
      baselineTier: 'A',
      supplierOrderId: 'order-date',
      supplierOrderOperationalStatus: 'ordered',
      supplierOrderWorkflowStage: 'in_prep',
      latestSupplierOrderActivityAt: new Date(Date.parse(FIXED_NOW) - 96 * 3_600_000),
      latestSupplierOrderActivityNote: 'harvested-shape note',
      leadTimeConfirmedAt: new Date(Date.parse(FIXED_NOW) - 10 * 86_400_000),
    });
    local.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push({
      id: 'order-date',
      workflowStage: 'in_prep',
      workflowStageEnteredAt: new Date(Date.parse(FIXED_NOW) - 120 * 3_600_000),
    });
    const svc = service(local);
    const inPrep = await svc.pane({ pane: 'inPrepMonitoring', runId: PUBLISHED_RUN_ID, page: 1, pageSize: 25 });
    if (isRunSuperseded(inPrep)) throw new Error('bad');
    const row = inPrep.rows[0];
    expect(row.order?.daysInStage).toBe(5);
    expect(row.order?.needsFollowUp).toBe(true); // 96h since activity > 48h
    expect(row.lastActivity?.preview).toBe('harvested-shape note');
    const header = await svc.header();
    const followUp = header.tiles.find((tile) => tile.key === 'needsFollowUp');
    expect(followUp?.count).toBe(1);
  });

  it('serves the Discontinued & Paused pane at family grain with evidence columns (task 002)', async () => {
    const response = await service(db).pane({
      pane: 'discontinuedPaused',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 25,
    });
    if (isRunSuperseded(response)) throw new Error('bad');
    expect(response.pagination.total).toBe(1); // family grain: one family, two listings
    const row = response.rows[0];
    expect(row?.identity.familyKey).toBe('family-disc');
    expect(row?.familyMemberCount).toBe(2);
    expect(row?.supplierName).toBe('Old Supplier Co');
    expect(row?.lastMovementMonth).toBe('2026-03-01');
    expect(row?.lifecycleProvenance).toBe('migration_sweep_2026_07');
    expect(row?.lifecyclePreviousStatus).toBe('candidate_new_product');
  });

  it('excludes discontinued families from every KPI tile (task 002 no-signal guarantee)', async () => {
    // Both disc fixtures carry null lead-time evidence; if the pane were not
    // excluded, staleLeadTimes.unknown would be 3, not 1 (test (d) equality).
    const header = await service(db).header();
    const stale = header.tiles.find((tile) => tile.key === 'staleLeadTimes');
    expect(stale?.unknownCount).toBe(1);
  });

  it('writes a uuid comment id and never strands lifecycle changes when the comment write fails (QA blocker regression)', async () => {
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Postgres-faithful repository: silverActivityComments.id is uuid-typed —
    // reject anything else, exactly like staging did (HTTP 500 on the old
    // reactivate-<familyId>-<epochMs> key).
    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    const originalCreate = comments.create.bind(comments);

    // Ordering guarantee FIRST: if the comment write fails, NOTHING changes
    // (the comment is written before any lifecycle update).
    const statusesBefore = db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
      .rows.map((row) => row.lifecycleStatus);
    comments.create = async () => {
      throw new Error('comment insert failed');
    };
    await expect(
      service(db).reactivateFamily({ familyId: 'family-disc', comment: 'will fail', actorUserId: '4' }),
    ).rejects.toThrow('comment insert failed');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows.map((row) => row.lifecycleStatus)).toEqual(
      statusesBefore,
    );

    // Now the uuid-enforcing repository accepts the fixed implementation.
    comments.create = async (params: { values: Record<string, unknown> }) => {
      if (!UUID_PATTERN.test(String(params.values.id ?? ''))) {
        throw new Error(`invalid input syntax for type uuid: "${String(params.values.id)}"`);
      }
      return originalCreate(params);
    };
    const result = await service(db).reactivateFamily({
      familyId: 'family-disc',
      comment: 'uuid-safe reactivation',
      actorUserId: '4',
    });
    expect(result.reactivatedCount).toBe(2);
    const written = comments.rows.find((row) => row.body === 'uuid-safe reactivation');
    expect(UUID_PATTERN.test(String(written?.id))).toBe(true);
    comments.create = originalCreate;
  });

  it('reactivates a swept family: restores pre-sweep status, stamps provenance, requires a comment', async () => {
    const svc = service(db);
    await expect(svc.reactivateFamily({ familyId: 'family-disc' })).rejects.toThrow('requires a reason comment');
    await expect(svc.reactivateFamily({ familyId: 'nope', comment: 'x' })).rejects.toThrow(
      'no discontinued or paused members',
    );

    const result = await svc.reactivateFamily({
      familyId: 'family-disc',
      comment: 'Supplier back in business',
      actorUserId: '4',
    });
    expect(result).toEqual({ familyId: 'family-disc', reactivatedCount: 2 });
    const products = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows;
    for (const product of products.filter((row) => row.companyProductFamilyId === 'family-disc')) {
      expect(product.lifecycleStatus).toBe('candidate_new_product'); // restored from provenance
      expect(product.lifecycleStatusProvenance).toMatchObject({
        kind: 'operator_reactivation',
        previousStatus: 'discontinued',
      });
    }
    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows;
    expect(
      comments.some(
        (comment) =>
          comment.entityType === 'company_product_family' &&
          comment.entityId === 'family-disc' &&
          comment.body === 'Supplier back in business',
      ),
    ).toBe(true);
  });

  it('sorts tiered families to the top of Data Readiness and reports the attention counter (task 006)', async () => {
    const local = new RecordingDatabase();
    local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).rows.push({
      id: PUBLISHED_RUN_ID,
      status: 'published',
      calculationDate: FIXED_TODAY,
      publishedAt: `${FIXED_TODAY}T00:00:00.000Z`,
    });
    const goldRepo = local.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    for (const [id, tier] of [
      ['dr-untiered-1', null],
      ['dr-tiered-1', 'B'],
      ['dr-untiered-2', null],
      ['dr-tiered-2', 'A'],
    ] as const) {
      goldRepo.rows.push({
        id,
        naturalKey: id,
        refreshRunId: PUBLISHED_RUN_ID,
        primaryActionPane: 'dataReadiness',
        companyProductFamilyId: `family-${id}`,
        baselineTier: tier,
      });
    }
    const response = await service(local).pane({
      pane: 'dataReadiness',
      runId: PUBLISHED_RUN_ID,
      page: 1,
      pageSize: 25,
    });
    if (isRunSuperseded(response)) throw new Error('bad');
    // Tiered families first.
    expect(response.rows.slice(0, 2).every((row) => row.tier.baseline !== null)).toBe(true);
    expect(response.rows.slice(2).every((row) => row.tier.baseline === null)).toBe(true);
    const counter = response.metrics.find((metric) => metric.key === 'tieredNeedingAttention');
    expect(counter?.value).toBe(2);
    expect(counter?.label).toBe('Tiered families needing attention');
  });

  it('(h) emits typed response snapshots for G2 to consume', async () => {
    const svc = service(db);
    const header = await svc.header();
    const outputDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'expected-responses');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'header.json'), `${JSON.stringify(header, null, 2)}\n`);
    for (const pane of DASHBOARD_PANE_KEYS) {
      const response = await svc.pane({ pane, runId: PUBLISHED_RUN_ID, page: 1, pageSize: 200 });
      writeFileSync(join(outputDir, `pane-${pane}.json`), `${JSON.stringify(response, null, 2)}\n`);
      // Drawer-context snapshot for the pane's first row (G3 client mocks).
      if (!isRunSuperseded(response) && response.rows.length > 0) {
        const first = response.rows[0];
        const drawer = await svc.drawerContext({
          pane,
          runId: PUBLISHED_RUN_ID,
          familyId: first.identity.familyKey,
          orderId: first.order?.orderId,
        });
        writeFileSync(join(outputDir, `drawer-${pane}.json`), `${JSON.stringify(drawer, null, 2)}\n`);
      }
    }
    expect(header.tiles).toHaveLength(5);
  });
});
