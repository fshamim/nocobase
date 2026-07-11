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
  calculateInventoryMoneyRisk,
  EcobaseInventoryPlanningService,
} from '../../features/inventory-planning/server/inventory-planning-service';
import { profitTierMovement } from '../../features/inventory-planning/server/profit-tier';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  readonly findCalls: FindParams[] = [];

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    this.findCalls.push(params);
    const filtered = this.filterRecords(params);
    return this.sortRecords(filtered, params.sort).slice(0, params.limit ?? filtered.length);
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    const record = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(record);
    return record;
  }

  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error('MemoryRepository update failed: matching record was not found.');
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  all() {
    return this.records;
  }

  private filterRecords(params: FindParams) {
    if (params.filterByTk) {
      return this.records.filter((record) => record.id === params.filterByTk);
    }
    const filter = params.filter ?? {};
    return this.records.filter((record) =>
      Object.entries(filter).every(([key, expected]) => {
        if (typeof expected === 'object' && expected !== null && Array.isArray((expected as { $in?: unknown[] }).$in)) {
          return (expected as { $in: unknown[] }).$in.includes(record[key]);
        }
        return record[key] === expected;
      }),
    );
  }

  private sortRecords(records: Record<string, unknown>[], sort: string[] = []) {
    const [firstSort] = sort;
    if (!firstSort) {
      return records;
    }
    const descending = firstSort.startsWith('-');
    const key = descending ? firstSort.slice(1) : firstSort;
    return [...records].sort((left, right) => {
      const leftValue = String(left[key] ?? '');
      const rightValue = String(right[key] ?? '');
      if (leftValue === rightValue) return 0;
      const result = leftValue > rightValue ? 1 : -1;
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor() {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository()));
    this.repositories.set('users', new MemoryRepository());
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) {
      throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    }
    return repository;
  }
}

async function createRecord(db: MemoryDatabase, collection: string, values: Record<string, unknown>) {
  await db.getRepository(collection).create({ values });
}

async function createSilverOrderRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  const company = String(values.company ?? '');
  const companyId = `silver-company:${company}`;
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
  if (values.supplierId) {
    await upsertRecord(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: values.supplierId,
      companyId,
      displayName: values.supplierName,
    });
  }
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverOrders, {
    id: values.id,
    companyId,
    supplierId: values.supplierId,
    orderRef: values.externalOrderRef ?? values.id,
    orderDate: values.orderDate ?? '2025-01-01',
    dailySequenceLetter: 'A',
    orderIntent: values.sourceStage ?? 'imported',
    canonicalStatus: values.status,
    lifecycleStatus: values.status,
    statusSource: values.statusSource,
    authorityStatus: values.authorityStatus,
    authoritySource: values.authoritySource,
    authorityTaskRef: values.authorityTaskRef,
    authorityAsOf: values.authorityAsOf,
    authorityEvidenceJson: values.authorityEvidenceJson,
    paymentStatus: values.paymentStatus,
    approvalStatus: values.approvalStatus,
    expectedDeliveryDate: values.expectedDeliveryDate,
    shippingCarrier: values.shippingCarrier,
    trackingId: values.trackingId,
    updatedAt: values.lastMeaningfulUpdateAt ?? values.statusUpdatedAt,
  });
}

async function createSilverOrderLineRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  const company = String(values.company ?? '');
  const companyId = `silver-company:${company}`;
  const asin = String(values.asin ?? '');
  const sku = String(values.sku ?? '');
  const productId = `silver-product:${asin}:${sku}`;
  const companyProductId = values.companyProductId ?? `silver-company-product:${company}:${asin}:${sku}`;
  const supplierProductId =
    values.supplierProductId ?? `silver-supplier-product:${values.supplierId ?? ''}:${asin}:${sku}`;
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
    id: productId,
    asin,
    sku,
    title: values.title,
    brand: values.brand,
  });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
    id: companyProductId,
    companyId,
    productId,
    lifecycleStatus: 'active',
  });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
    id: supplierProductId,
    supplierId: values.supplierId,
    productId,
    supplierSku: sku,
    unitCost: values.unitCost,
    leadTimeDays: values.leadTimeDays ?? 30,
  });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverOrderLines, {
    id: values.id,
    orderId: values.supplierOrderId,
    companyProductId,
    supplierProductId,
    orderedQty: values.orderedQty,
    confirmedQty: values.receivedQty,
    unitCost: values.unitCost,
    expectedDeliveryDate: values.expectedDeliveryDate,
    expectedSellableDate: values.expectedSellableDate,
  });
}

async function createSilverActivityCommentRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  await createRecord(db, ECOBASE_COLLECTIONS.silverActivityComments, {
    id: values.id,
    entityType: 'supplier_order',
    entityId: values.supplierOrderId,
    actorType: values.actorUserId ? 'user' : 'operator',
    actorUserId: values.actorUserId,
    commentType: values.activityType ?? 'note',
    body: values.notes ?? values.activityType ?? 'note',
    occurredAt: values.occurredAt,
    deletedAt: values.deletedAt,
    contextSnapshotJson: {
      supplierOrderId: values.supplierOrderId,
      occurredAt: values.occurredAt,
      actor: values.actor,
      source: values.source,
    },
    createdAt: values.occurredAt,
    updatedAt: values.editedAt ?? values.occurredAt,
  });
}

async function upsertRecord(db: MemoryDatabase, collection: string, values: Record<string, unknown>) {
  const repo = db.getRepository(collection);
  const id = values.id;
  if (id && repo.all().some((record) => record.id === id)) {
    await repo.update({ filterByTk: id as string | number, values });
    return;
  }
  await repo.create({ values });
}

describe('EcobaseInventoryPlanningService', () => {
  it('classifies explicit tier transitions', () => {
    expect(profitTierMovement('B', 'A')).toBe('down');
    expect(profitTierMovement('C', 'B')).toBe('down');
    expect(profitTierMovement('A', 'B')).toBe('up');
    expect(profitTierMovement(undefined, 'C')).toBe('lost_tier');
    expect(profitTierMovement('C', undefined)).toBe('new');
  });

  it('calculates uncovered-stockout money risk without replacing unknown inputs with zero', () => {
    const base = {
      salesVelocity: 2,
      profitPerUnit: 5,
      daysOfCover: 10,
      targetCoverDays: 40,
      openOrderCoverageQty: 0,
      supplierOrderState: 'no_open_order',
      estimatedOosDate: '2026-07-20',
    };

    expect(calculateInventoryMoneyRisk(base)).toMatchObject({
      estimatedProfitRisk: 300,
      moneyRiskStatus: 'resolved_positive',
      moneyRiskUncoveredDays: 30,
    });
    expect(
      calculateInventoryMoneyRisk({
        ...base,
        supplierOrderState: 'purchased_pipeline',
        expectedArrivalDate: '2026-07-15',
        expectedArrivalStatus: 'imported',
        openOrderCoverageQty: 60,
      }),
    ).toMatchObject({ estimatedProfitRisk: 0, moneyRiskStatus: 'resolved_zero', moneyRiskUncoveredDays: 0 });
    expect(
      calculateInventoryMoneyRisk({
        ...base,
        supplierOrderState: 'purchased_pipeline',
        expectedArrivalDate: '2026-07-25',
        expectedArrivalStatus: 'imported',
        openOrderCoverageQty: 60,
      }),
    ).toMatchObject({ estimatedProfitRisk: 50, moneyRiskStatus: 'resolved_positive', moneyRiskUncoveredDays: 5 });
    expect(
      calculateInventoryMoneyRisk({
        ...base,
        supplierOrderState: 'purchased_pipeline',
        expectedArrivalStatus: 'unknown',
      }),
    ).toMatchObject({ estimatedProfitRisk: undefined, moneyRiskStatus: 'unknown_arrival' });
    expect(calculateInventoryMoneyRisk({ ...base, profitPerUnit: undefined })).toMatchObject({
      estimatedProfitRisk: undefined,
      moneyRiskStatus: 'unknown_missing_inputs',
    });
    expect(calculateInventoryMoneyRisk({ ...base, profitPerUnit: -5 })).toMatchObject({
      estimatedProfitRisk: 0,
      moneyRiskStatus: 'resolved_zero',
    });
    expect(calculateInventoryMoneyRisk({ ...base, daysOfCover: 0, targetCoverDays: 30 })).toMatchObject({
      estimatedProfitRisk: 300,
      moneyRiskUncoveredDays: 30,
    });
    expect(calculateInventoryMoneyRisk({ ...base, openOrderCoverageQty: 20 })).toMatchObject({
      estimatedProfitRisk: 200,
      moneyRiskUncoveredDays: 20,
    });
  });

  it('materializes exclusive target supply, active-order, stuck, member, and watch boundaries', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      finalizeGoldContract: (row: Record<string, unknown>, calculationDate: string) => Record<string, unknown>;
    };
    const materialize = (values: Record<string, unknown>) =>
      service.finalizeGoldContract(
        {
          productStatus: 'Active',
          familyRole: 'target',
          actionStatus: 'order_soon',
          tier: 'A',
          salesVelocity: 1,
          salesVelocityBasis: 'historical_rolling_30_days',
          salesVelocityStatus: 'trusted_positive',
          currentPlanningStock: 30,
          daysOfCover: 30,
          targetCoverDays: 45,
          supplierOrderState: 'no_open_order',
          estimatedOosDate: '2026-08-09',
          inventoryAsOfDate: '2026-07-10',
          supplierAvailability: 'resolved_silver_link',
          leadTimeAvailability: 'resolved_silver_link',
          unitCostAvailability: 'resolved_cogs',
          profitAvailability: 'resolved_history',
          profitPerUnit: 5,
          openOrderCoverageQty: 0,
          ...values,
        },
        '2026-07-10',
      );

    expect(materialize({})).toMatchObject({
      commandCenterPane: 'supplyAction',
      sourceFreshnessStatus: 'fresh',
    });
    expect(materialize({ unitCostAvailability: 'unavailable_no_evidence', unitCost: undefined })).toMatchObject({
      commandCenterPane: 'supplyAction',
      dataQualityStatus: 'partial',
    });
    expect(materialize({ daysOfCover: 30.01 }).commandCenterPane).toBe('watch');
    expect(materialize({ daysOfCover: 30.01 }).stuckClassification).toBe('over_30_doc_watch');
    expect(materialize({ daysOfCover: 60, lastMonthQty: 5, sixMonthAverageQty: 10 }).stuckClassification).toBe(
      'declining_velocity_watch',
    );
    expect(
      materialize({ daysOfCover: 60.01, familyStuckAction: true, familyStuckClassification: 'over_60_doc' }),
    ).toMatchObject({ commandCenterPane: 'stuckInventory', stuckClassification: 'over_60_doc' });
    expect(materialize({ currentPlanningStock: 0, daysOfCover: 0 }).stuck).toBe(false);
    expect(
      materialize({
        salesVelocity: 0,
        salesVelocityStatus: 'trusted_zero',
        daysOfCover: undefined,
        familyStuckAction: true,
        familyStuckClassification: 'no_sell_through_with_stock',
      }),
    ).toMatchObject({
      commandCenterPane: 'stuckInventory',
      stuckClassification: 'no_sell_through_with_stock',
    });
    expect(
      materialize({
        salesVelocity: 0,
        salesVelocityStatus: 'trusted_zero',
        daysOfCover: undefined,
        pipelineStock: 10,
      }),
    ).toMatchObject({ commandCenterPane: 'watch', stuckClassification: 'no_sell_through_with_stock' });
    expect(
      materialize({ salesVelocity: undefined, salesVelocityStatus: 'missing', daysOfCover: undefined }),
    ).toMatchObject({ commandCenterPane: 'watch', stuckClassification: 'insufficient_velocity_data' });
    expect(materialize({ familyRole: 'member', actionStatus: 'family_member_no_reorder' }).commandCenterPane).toBe(
      'watch',
    );
    expect(materialize({ productStatus: 'Inactive' }).commandCenterPane).toBe('watch');
    expect(
      materialize({
        daysOfCover: 90,
        supplierOrderState: 'purchased_pipeline',
        expectedArrivalDate: '2026-07-01',
        expectedArrivalStatus: 'imported',
        pipelineStock: 10,
        familyStuckAction: true,
        familyStuckClassification: 'pipeline_stalled',
      }),
    ).toMatchObject({
      commandCenterPane: 'stuckInventory',
      stuck: true,
      stuckClassification: 'pipeline_stalled',
      supplierOrderState: 'purchased_pipeline',
    });
  });

  it('keeps missing inventory values unknown through gold and API projection', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-missing-stock', name: 'ACME' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-missing-stock',
      asin: 'B000NOSTOCK',
      sku: 'NO-STOCK',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: 'company-product-missing-stock',
      companyId: 'company-missing-stock',
      productId: 'product-missing-stock',
      lifecycleStatus: 'active',
    });

    const service = new EcobaseInventoryPlanningService(db);
    await service.refreshReadModel({ company: 'ACME', calculationDate: '2026-07-10' });
    const commandCenter = await service.commandCenter({ company: 'ACME', calculationDate: '2026-07-10' });
    const [goldRow] = await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({});

    expect(goldRow).toMatchObject({
      actionStatus: 'missing_inventory',
      currentPlanningStock: null,
      daysOfCover: null,
      estimatedProfitRisk: null,
      moneyRiskStatus: 'unknown_missing_inputs',
      commandCenterPane: 'watch',
    });
    expect(commandCenter.panes.supplyAction.total).toBe(0);
    expect(commandCenter.summaryCards.find((card) => card.key === 'moneyAtRisk')).toMatchObject({ unknownCount: 1 });
  });

  it('requires a positive optimizer budget', async () => {
    await expect(
      new EcobaseInventoryPlanningService(new MemoryDatabase()).optimizeBudget({ budget: 0 }),
    ).rejects.toThrow('Ecobase budget optimizer requires a budget greater than zero.');
  });

  it('reads only the latest materialized gold refresh cohort', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'stale-gold-row',
      calculationDate: '2026-06-26',
      company: 'Ecofission LLC',
      asin: 'B000STALE',
      sku: 'STALE-SKU',
      tier: 'A',
      estimatedProfitRisk: 999,
      lastRefreshedAt: '2026-06-26T00:00:00.000Z',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'current-gold-row',
      calculationDate: '2026-06-26',
      company: 'Ecofission LLC',
      asin: 'B000CURRENT',
      sku: 'CURRENT-SKU',
      tier: 'A',
      estimatedProfitRisk: 1,
      lastRefreshedAt: '2026-06-27T00:00:00.000Z',
    });

    const rows = await new EcobaseInventoryPlanningService(db).listRows({ calculationDate: '2026-06-26' });

    expect(rows.map((row) => row.asin)).toEqual(['B000CURRENT']);
  });

  it('serves inventory planning from gold rows ordered by actionable money at risk', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'low-risk',
      naturalKey: 'low-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'LOW',
      actionStatus: 'overdue',
      tier: 'A',
      estimatedProfitRisk: 50,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'high-risk',
      naturalKey: 'high-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'HIGH',
      actionStatus: 'order_soon',
      tier: 'B',
      estimatedProfitRisk: 500,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'excluded-risk',
      naturalKey: 'excluded-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'EXCLUDED',
      actionStatus: 'excluded',
      tier: 'A',
      estimatedProfitRisk: 5000,
    });

    const rows = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });
    const limitedRows = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
      limit: 2,
    });

    expect(rows.map((row) => row.id)).toEqual(['high-risk', 'low-risk', 'excluded-risk']);
    expect(limitedRows.map((row) => row.id)).toEqual(['high-risk', 'low-risk']);
  });

  it('serves filters, rows, and digest through one inventory workspace interface', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'workspace-row',
      naturalKey: 'workspace-row',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000WORK',
      sku: 'WORK-SKU',
      title: 'Workspace product',
      actionStatus: 'order_today',
      tier: 'A',
      estimatedProfitRisk: 250,
      supplierOrderState: 'no_open_order',
      leadTimeFreshness: 'fresh',
      lastRefreshedAt: '2026-06-07T10:00:00.000Z',
    });

    const workspace = await new EcobaseInventoryPlanningService(db).workspace({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
      limit: 10,
    });

    expect(workspace.filters.companies).toContain('Ecofission LLC');
    expect(workspace.rows).toHaveLength(1);
    expect(workspace.rows[0]).toMatchObject({ asin: 'B000WORK', actionStatus: 'order_today' });
    expect(workspace.digest.summary).toMatchObject({ orderToday: 1, atRisk: 1 });
    expect(workspace.digest.sections.orderNow[0]).toMatchObject({ asin: 'B000WORK' });
  });

  it('projects persisted Sellerboard COGS evidence without request-time cost guessing', async () => {
    const db = new MemoryDatabase();
    for (const row of [
      {
        id: 'exact',
        asin: 'B000EXACT',
        sku: 'SKU-EXACT',
        qty: 10,
        risk: 300,
        unitCost: 4.5,
        unitCostAvailability: 'resolved_cogs',
        estimatedOrderCost: 45,
      },
      {
        id: 'safe',
        asin: 'B000SAFE',
        sku: 'amzn.gr.safe',
        qty: 4,
        risk: 200,
        unitCost: 7,
        unitCostAvailability: 'resolved_cogs',
        estimatedOrderCost: 28,
      },
      {
        id: 'ambiguous',
        asin: 'B000AMBIG',
        sku: 'amzn.gr.ambig',
        qty: 3,
        risk: 100,
        unitCost: undefined,
        unitCostAvailability: 'unavailable_ambiguous',
        estimatedOrderCost: undefined,
      },
    ]) {
      await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
        id: row.id,
        naturalKey: row.id,
        calculationDate: '2026-06-07',
        company: 'Ecofission LLC',
        asin: row.asin,
        sku: row.sku,
        title: row.id,
        actionStatus: 'order_today',
        tier: 'A',
        estimatedProfitRisk: row.risk,
        suggestedReorderQty: row.qty,
        unitCost: row.unitCost,
        unitCostAvailability: row.unitCostAvailability,
        estimatedOrderCost: row.estimatedOrderCost,
        supplierOrderState: 'no_open_order',
        supplierAvailability: 'resolved_silver_link',
        commandCenterPane: 'supplyAction',
      });
    }
    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-06-07',
      pane: 'supplyAction',
      pageSize: 10,
    });
    const rows = commandCenter.panes.supplyAction.rows;
    const row = (asin: string) => rows.find((item) => item.asin === asin);

    expect(row('B000EXACT')).toMatchObject({
      unitCost: 4.5,
      unitCostAvailability: 'resolved_cogs',
      estimatedOrderCost: 45,
    });
    expect(row('B000SAFE')).toMatchObject({
      unitCost: 7,
      unitCostAvailability: 'resolved_cogs',
      estimatedOrderCost: 28,
    });
    expect(row('B000AMBIG')).toMatchObject({
      unitCostAvailability: 'unavailable_ambiguous',
      estimatedOrderCost: undefined,
    });
  });

  it('limits no-active-order pane to stockout-soon rows', async () => {
    const db = new MemoryDatabase();
    const baseRow = {
      calculationDate: '2026-07-10',
      lastRefreshedAt: '2026-07-10T00:00:00.000Z',
      company: 'Ecofission LLC',
      asin: 'B000PANE',
      title: 'Pane row',
      tier: 'A',
      productStatus: 'active',
      supplierOrderState: 'no_open_order',
      supplierAvailability: 'resolved_silver_link',
      leadTimeFreshness: 'missing',
      actionStatus: 'missing_lead_time',
      targetCoverDays: 45,
      salesVelocity: 1,
      estimatedProfitRisk: 10,
    };
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-soon-missing-lead-time',
      naturalKey: 'pane-soon-missing-lead-time',
      sku: 'SOON-MISSING-LT',
      daysOfCover: 0,
      currentPlanningStock: 0,
      commandCenterPane: 'supplyAction',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-far-missing-lead-time',
      naturalKey: 'pane-far-missing-lead-time',
      sku: 'FAR-MISSING-LT',
      daysOfCover: 120,
      currentPlanningStock: 120,
      commandCenterPane: 'none',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-known-soon',
      naturalKey: 'pane-known-soon',
      sku: 'KNOWN-SOON',
      leadTimeFreshness: 'fresh',
      actionStatus: 'order_soon',
      leadTimeDays: 14,
      daysOfCover: 20,
      currentPlanningStock: 20,
      commandCenterPane: 'supplyAction',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-missing-supplier',
      naturalKey: 'pane-missing-supplier',
      sku: 'MISSING-SUPPLIER',
      supplierAvailability: 'unavailable_no_evidence',
      daysOfCover: 0,
      currentPlanningStock: 0,
      commandCenterPane: 'supplyAction',
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-07-10',
      pane: 'supplyAction',
      pageSize: 10,
    });

    const skus = commandCenter.panes.supplyAction.rows.map((row) => row.sku);
    expect(skus).toEqual(expect.arrayContaining(['SOON-MISSING-LT', 'KNOWN-SOON']));
    expect(skus).not.toContain('FAR-MISSING-LT');
    expect(skus).not.toContain('MISSING-SUPPLIER');
    expect(commandCenter.panes.missingSupplier.rows.map((row) => row.sku)).toEqual(['MISSING-SUPPLIER']);
  });

  it('tiers only products with at least four units in the latest rolling 30-day sales window', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    const companyId = `silver-company:${company}`;
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });

    for (const product of [
      { asin: 'B00RECENT4', sku: 'RECENT-FOUR', recentUnits: 4, stock: 0 },
      { asin: 'B00RECENT2', sku: 'RECENT-TWO', recentUnits: 2, stock: 20 },
      { asin: 'B00RECENT0', sku: 'RECENT-ZERO', recentUnits: 0, stock: 20 },
    ]) {
      const productId = `silver-product:${product.asin}:${product.sku}`;
      const companyProductId = `silver-company-product:${company}:${product.asin}:${product.sku}`;
      await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
        id: productId,
        asin: product.asin,
        sku: product.sku,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
        id: companyProductId,
        companyId,
        productId,
        lifecycleStatus: 'active',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-${product.sku}`,
        companyProductId,
        snapshotDate: '2026-06-06',
        sellableStock: product.stock,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `historical-profit-${product.sku}`,
        companyProductId,
        snapshotDate: '2026-01-15',
        units: 10,
        sales: 1200,
        profit: 1000,
      });
      if (product.recentUnits > 0) {
        await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
          id: `recent-sales-${product.sku}`,
          companyProductId,
          snapshotDate: '2026-06-06',
          units: product.recentUnits,
          sales: product.recentUnits * 120,
          profit: product.recentUnits * 100,
        });
      }
    }

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company,
      calculationDate: '2026-06-07',
    });

    const rows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(rows.find((row) => row.sku === 'RECENT-FOUR')).toMatchObject({
      recentUnits30: 4,
      salesVelocity: 4 / 30,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityWindowStart: '2026-05-08',
      salesVelocityWindowEnd: '2026-06-06',
      tier: 'A',
      tierScore: 400,
      tierEligibilityReason: 'eligible_recent_demand',
      tierRuleVersion: 'rolling_30d_min_4_v1',
    });
    expect(rows.find((row) => row.sku === 'RECENT-TWO')).toMatchObject({
      recentUnits30: 2,
      salesVelocity: 2 / 30,
      tier: null,
      tierScore: 200,
      tierEligibilityReason: 'low_recent_demand',
      commandCenterPane: 'stuckInventory',
    });
    expect(rows.find((row) => row.sku === 'RECENT-ZERO')).toMatchObject({
      recentUnits30: 0,
      salesVelocity: 0,
      tier: null,
      tierScore: 0,
      tierEligibilityReason: 'low_recent_demand',
      actionStatus: 'no_sell_through',
    });
  });

  it('does not tier snapshot velocity without rolling-30-day sales evidence', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-no-history', name: 'No History Inc' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-no-history',
      asin: 'B00NOHISTORY',
      sku: 'NO-HISTORY',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: 'company-product-no-history',
      companyId: 'company-no-history',
      productId: 'product-no-history',
      lifecycleStatus: 'active',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-no-history',
      companyProductId: 'company-product-no-history',
      snapshotDate: '2026-06-06',
      sellableStock: 10,
      salesVelocity: 5,
    });

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company: 'No History Inc',
      calculationDate: '2026-06-07',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all()[0]).toMatchObject({
      recentUnits30: null,
      salesVelocity: 5,
      salesVelocityBasis: 'inventory_snapshot_fallback',
      tier: null,
      tierEligibilityReason: 'missing_recent_sales_evidence',
      tierRuleVersion: 'rolling_30d_min_4_v1',
    });
  });

  it('baselines rule changes and emits a lost tier only on the immediate transition', async () => {
    const db = new MemoryDatabase();
    const companyProductId = 'company-product-tier-movement';
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-tier-movement', name: 'ACME' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-tier-movement',
      asin: 'B00TIERMOVE',
      sku: 'TIER-MOVE',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: companyProductId,
      companyId: 'company-tier-movement',
      productId: 'product-tier-movement',
      lifecycleStatus: 'active',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-tier-movement',
      companyProductId,
      snapshotDate: '2026-06-06',
      sellableStock: 0,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
      id: 'historical-tier-movement',
      companyProductId,
      snapshotDate: '2026-01-15',
      units: 10,
      sales: 600,
      profit: 500,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
      id: 'recent-tier-movement',
      companyProductId,
      snapshotDate: '2026-06-06',
      units: 4,
      sales: 240,
      profit: 200,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'legacy-tier-row',
      naturalKey: `2026-06-06:ACME:${companyProductId}`,
      planningProductId: companyProductId,
      company: 'ACME',
      calculationDate: '2026-06-06',
      actionStatus: 'watch',
      tier: 'A',
      tierRuleVersion: 'legacy_best_month_v1',
    });

    const service = new EcobaseInventoryPlanningService(db);
    await service.refreshReadModel({ company: 'ACME', calculationDate: '2026-06-07' });
    await service.refreshReadModel({ company: 'ACME', calculationDate: '2026-06-07' });
    await service.refreshReadModel({ company: 'ACME', calculationDate: '2026-06-08' });
    await db
      .getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts)
      .update({ filterByTk: 'recent-tier-movement', values: { units: 2 } });
    await service.refreshReadModel({ company: 'ACME', calculationDate: '2026-06-09' });
    await service.refreshReadModel({ company: 'ACME', calculationDate: '2026-06-10' });

    const rows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(rows.filter((row) => row.calculationDate === '2026-06-07')).toHaveLength(1);
    expect(rows.find((row) => row.calculationDate === '2026-06-07')).toMatchObject({
      tier: 'B',
      previousTier: null,
      tierMovement: null,
    });
    expect(rows.find((row) => row.calculationDate === '2026-06-08')).toMatchObject({
      tier: 'B',
      previousTier: 'B',
      tierMovement: 'same',
    });
    expect(rows.find((row) => row.calculationDate === '2026-06-09')).toMatchObject({
      tier: null,
      previousTier: 'B',
      tierMovement: 'lost_tier',
    });
    expect(rows.find((row) => row.calculationDate === '2026-06-10')).toMatchObject({
      tier: null,
      previousTier: null,
      tierMovement: null,
    });
  });

  it('uses rolling-30-day velocity and treats covered products without recent sales as trusted zero', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    const companyId = `silver-company:${company}`;
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });

    for (const product of [
      { asin: 'B00HISTORYPOS', sku: 'HISTORY-POS', stock: 0, snapshotVelocity: 0, monthlyUnits: 300 },
      { asin: 'B00HISTORYZERO', sku: 'HISTORY-ZERO', stock: 20, snapshotVelocity: 99, monthlyUnits: 0 },
      { asin: 'B00SNAPSHOT', sku: 'SNAPSHOT-FALLBACK', stock: 20, snapshotVelocity: 2 },
      { asin: 'B00MISSINGVEL', sku: 'MISSING-VELOCITY', stock: 20, snapshotVelocity: 0 },
    ]) {
      const productId = `silver-product:${product.asin}:${product.sku}`;
      const companyProductId = `silver-company-product:${company}:${product.asin}:${product.sku}`;
      await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
        id: productId,
        asin: product.asin,
        sku: product.sku,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
        id: companyProductId,
        companyId,
        productId,
        lifecycleStatus: 'active',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-${product.sku}`,
        companyProductId,
        snapshotDate: '2026-06-06',
        sellableStock: product.stock,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: product.snapshotVelocity,
      });
      if (typeof product.monthlyUnits === 'number') {
        for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
          await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
            id: `fact-${product.sku}-${month}`,
            companyProductId,
            snapshotDate: `${month}-15`,
            units: product.monthlyUnits,
            sales: product.monthlyUnits * 10,
            profit: product.monthlyUnits * 3,
          });
        }
      }
    }

    await createRecord(db, ECOBASE_COLLECTIONS.sellerboardProductCosts, {
      id: 'cogs-history-positive',
      naturalKey: `${company}:B00HISTORYPOS:HISTORY-POS`,
      company,
      asin: 'B00HISTORYPOS',
      sku: 'HISTORY-POS',
      unitCost: 4.5,
      sourceFile: 'Ecofission_Cost_of_Goods_Sold.csv',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sellerboardProductCosts, {
      id: 'cogs-wrong-company',
      naturalKey: 'Muxtex INC:B00HISTORYPOS:HISTORY-POS',
      company: 'Muxtex INC',
      asin: 'B00HISTORYPOS',
      sku: 'HISTORY-POS',
      unitCost: 999,
      sourceFile: 'Muxtex_Cost_of_Goods_Sold.csv',
    });

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company,
      calculationDate: '2026-06-07',
    });

    const rows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(rows.find((row) => row.sku === 'HISTORY-POS')).toMatchObject({
      salesVelocity: 10,
      recentUnits30: 300,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityStatus: 'trusted_positive',
      salesVelocityWindowStart: '2026-04-16',
      salesVelocityWindowEnd: '2026-05-15',
      salesVelocityAsOfDate: '2026-05-15',
      daysOfCover: 0,
      estimatedOosDate: '2026-06-07',
      actionStatus: 'overdue',
      supplierAvailability: 'unavailable_no_evidence',
      leadTimeDays: 30,
      leadTimeFreshness: 'default',
      leadTimeAvailability: 'resolved_default_30d',
      unitCost: 4.5,
      unitCostAvailability: 'resolved_cogs',
      profitAvailability: 'resolved_history',
      evidence: { leadTime: { days: 30, source: 'system_default_30d' } },
    });
    expect(rows.find((row) => row.sku === 'HISTORY-ZERO')).toMatchObject({
      salesVelocity: 0,
      recentUnits30: 0,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityStatus: 'trusted_zero',
      actionStatus: 'no_sell_through',
      profitAvailability: 'unavailable_no_sales',
      digestPriority: expect.any(Number),
    });
    expect(Number.isFinite(Number(rows.find((row) => row.sku === 'HISTORY-ZERO')?.digestPriority))).toBe(true);
    expect(rows.find((row) => row.sku === 'SNAPSHOT-FALLBACK')).toMatchObject({
      recentUnits30: 0,
      salesVelocity: 0,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityStatus: 'trusted_zero',
      actionStatus: 'no_sell_through',
      tierEligibilityReason: 'low_recent_demand',
    });
    expect(rows.find((row) => row.sku === 'MISSING-VELOCITY')).toMatchObject({
      recentUnits30: 0,
      salesVelocity: 0,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityStatus: 'trusted_zero',
      actionStatus: 'no_sell_through',
      tierEligibilityReason: 'low_recent_demand',
      unitCostAvailability: 'unavailable_no_evidence',
      profitAvailability: 'unavailable_no_history',
    });
  });

  it('rolls same-family listings into one persisted replenishment target without duplicate heuristics', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    const asin = 'B08CD4SHB4';
    const primarySku = 'B-101 Aramith';
    const duplicateSku = 'B-101';
    const primaryCompanyProductId = `silver-company-product:${company}:${asin}:${primarySku}`;
    const duplicateCompanyProductId = `silver-company-product:${company}:${asin}:${duplicateSku}`;
    const companyId = `silver-company:${company}`;
    const accountId = 'amazon-account-family-test';
    const familyId = 'company-product-family-test';

    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
    await createRecord(db, ECOBASE_COLLECTIONS.silverAmazonAccounts, {
      id: accountId,
      companyId,
      name: 'Ecofission US',
      marketplace: 'amazon.com',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: `silver-product:${asin}:${primarySku}`,
      asin,
      sku: primarySku,
      title: 'Aramith stock alias',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: primaryCompanyProductId,
      companyId,
      amazonAccountId: accountId,
      companyProductFamilyId: familyId,
      productId: `silver-product:${asin}:${primarySku}`,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-primary-duplicate-group',
      companyProductId: primaryCompanyProductId,
      snapshotDate: '2026-07-09',
      sellableStock: 6,
      reserved: 0,
      inbound: 7,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 1,
    });
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-primary-duplicate-${month}`,
        companyProductId: primaryCompanyProductId,
        snapshotDate: `${month}-15`,
        units: 30,
        sales: 300,
        profit: 90,
      });
    }
    await createSilverOrderRecord(db, {
      id: 'order-duplicate-sku',
      company,
      supplierId: 'supplier-ws',
      supplierName: 'ws billiard supply',
      externalOrderRef: 'EF91125A',
      status: 'paid',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-duplicate-sku',
      company,
      supplierOrderId: 'order-duplicate-sku',
      supplierId: 'supplier-ws',
      asin,
      sku: duplicateSku,
      orderedQty: 7,
      receivedQty: 0,
      unitCost: 322,
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).update({
      filterByTk: `silver-supplier-product:supplier-ws:${asin}:${duplicateSku}`,
      values: { leadTimeDays: null },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, {
      id: 'link-duplicate-sku-supplier',
      companyProductId: duplicateCompanyProductId,
      supplierProductId: `silver-supplier-product:supplier-ws:${asin}:${duplicateSku}`,
      role: 'latest_used',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-secondary-duplicate-group',
      companyProductId: duplicateCompanyProductId,
      snapshotDate: '2026-07-09',
      sellableStock: 5,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 0,
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
      filterByTk: duplicateCompanyProductId,
      values: { amazonAccountId: accountId, companyProductFamilyId: familyId },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductFamilies, {
      id: familyId,
      companyId,
      amazonAccountId: accountId,
      marketplace: 'amazon.com',
      canonicalAsin: asin,
      replenishmentTargetCompanyProductId: primaryCompanyProductId,
      targetSelectionSource: 'automatic',
      preferredSupplierId: 'supplier-ws',
      preferredSupplierProductId: `silver-supplier-product:supplier-ws:${asin}:${duplicateSku}`,
      supplierSelectionSource: 'latest_valid_order',
      supplierSelectionEvidenceJson: {
        sourceCompanyProductId: duplicateCompanyProductId,
        sourceSku: duplicateSku,
        sourceOrderRef: 'EF91125A',
        matchType: 'family_projected',
      },
    });
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-secondary-family-${month}`,
        companyProductId: duplicateCompanyProductId,
        snapshotDate: `${month}-15`,
        units: 30,
        sales: 300,
        profit: 90,
      });
    }

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company,
      calculationDate: '2026-07-09',
    });

    const materializedRows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(materializedRows.find((row) => row.sku === primarySku)).toMatchObject({
      productStatus: 'Active',
      companyProductFamilyId: familyId,
      familyRole: 'target',
      familyMemberCount: 2,
      familyCurrentPlanningStock: 18,
      familySellableStock: 11,
      familyPipelineStock: 7,
      familySalesVelocity: 2,
      familyDaysOfCover: 9,
      familyEstimatedOosDate: '2026-07-18',
      familyOpenOrderCoverageQty: 0,
      familySuggestedReorderQty: 72,
      supplierName: 'ws billiard supply',
      supplierAvailability: 'resolved_family_preferred_supplier',
      leadTimeDays: 30,
      leadTimeFreshness: 'default',
      leadTimeAvailability: 'resolved_default_30d',
      supplierSource: 'family_preferred_supplier',
      supplierOrderRef: 'EF91125A',
      supplierOrderOpenQty: 7,
      supplierOrderReferenceOpenQty: 7,
      openOrderCoverageQty: 0,
      unitCost: 322,
      estimatedOrderCost: 23184,
      actionStatus: 'overdue',
      evidence: {
        familyRollup: expect.objectContaining({
          sourceSku: duplicateSku,
          sourceOrderRef: 'EF91125A',
          supplierOrderCoverageTreatment: 'pipeline_netting',
        }),
      },
    });
    expect(materializedRows.find((row) => row.sku === duplicateSku)).toMatchObject({
      productStatus: 'active',
      companyProductFamilyId: familyId,
      familyRole: 'member',
      familyCurrentPlanningStock: 18,
      familySalesVelocity: 2,
      actionStatus: 'family_member_no_reorder',
      supplierName: 'ws billiard supply',
      unitCost: 322,
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      company,
      calculationDate: '2026-07-09',
      pane: 'activeOrders',
    });

    expect(commandCenter.panes.duplicateProducts.total).toBe(0);
    expect(commandCenter.panes.activeOrders.rows).toEqual([
      expect.objectContaining({
        sku: primarySku,
        familyRole: 'target',
        supplierOrderRef: 'EF91125A',
        familyMembers: expect.arrayContaining([
          expect.objectContaining({ sku: primarySku, familyRole: 'target' }),
          expect.objectContaining({ sku: duplicateSku, familyRole: 'member' }),
        ]),
      }),
    ]);
    expect(commandCenter.panes.supplyAction.rows.some((row) => row.sku === duplicateSku)).toBe(false);
  });

  it('rolls listing-level stuck evidence into one family action without hiding active-order context', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      applyFamilyRollups: (rows: Record<string, unknown>[], calculationDate: string) => Record<string, unknown>[];
      finalizeGoldContract: (row: Record<string, unknown>, calculationDate: string) => Record<string, unknown>;
    };
    const base = {
      companyProductFamilyId: 'family-stuck',
      replenishmentTargetCompanyProductId: 'target-product',
      familyPreferredSupplierName: 'Preferred Supplier',
      productStatus: 'Active',
      targetCoverDays: 45,
      orderSoonWindowDays: 14,
      safetyBufferDays: 15,
      salesVelocityBasis: 'historical_rolling_30_days',
      inventoryAsOfDate: '2026-07-10',
      supplierAvailability: 'resolved_silver_link',
      leadTimeAvailability: 'resolved_silver_link',
      unitCostAvailability: 'resolved_supplier_product',
      profitAvailability: 'resolved_history',
      tier: 'A',
    };
    const rows = service.applyFamilyRollups(
      [
        {
          ...base,
          companyProductId: 'target-product',
          sku: 'TARGET',
          currentPlanningStock: 61,
          sellableStock: 61,
          salesVelocity: 1,
          salesVelocityStatus: 'trusted_positive',
          daysOfCover: 61,
          unitCost: 2,
          supplierOrderState: 'purchased_pipeline',
          supplierOrderRef: 'EF-STUCK',
          openOrderCoverageQty: 5,
          expectedArrivalDate: '2026-07-20',
        },
        {
          ...base,
          companyProductId: 'member-product',
          sku: 'MEMBER',
          currentPlanningStock: 10,
          reservedStock: 10,
          salesVelocity: 0,
          salesVelocityStatus: 'trusted_zero',
          unitCost: 3,
          supplierOrderState: 'no_open_order',
          openOrderCoverageQty: 0,
        },
      ],
      '2026-07-10',
    );
    const materialized = rows.map((row) => service.finalizeGoldContract(row, '2026-07-10'));

    expect(materialized.filter((row) => row.commandCenterPane === 'stuckInventory')).toEqual([
      expect.objectContaining({
        companyProductId: 'target-product',
        familyStuckAction: true,
        familyStuckAffectedMemberCount: 2,
        familyStuckAffectedUnits: 71,
        familyStuckAffectedValue: 152,
        familyStuckActiveOrderCount: 1,
        supplierOrderState: 'purchased_pipeline',
        recommendedEscalation: 'review_stuck_inventory',
      }),
    ]);
    expect(materialized.find((row) => row.companyProductId === 'member-product')).toMatchObject({
      familyStuck: true,
      familyStuckAction: false,
      commandCenterPane: 'watch',
      stuckClassification: 'no_sell_through_with_stock',
    });
  });

  it('routes raw imported order statuses into the active-orders command pane', async () => {
    const db = new MemoryDatabase();
    const orderId = '11111111-1111-4111-8111-111111111111';
    const company = 'Ecofission LLC';
    const asin = 'B000ACTIVE';
    const sku = 'ACTIVE-SKU';
    const companyProductId = `silver-company-product:${company}:${asin}:${sku}`;
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-active-status',
      company,
      supplierId: 'supplier-active',
      supplierName: 'Active Supplier',
      externalOrderRef: 'PO-ACTIVE',
      status: 'ORDERED',
      expectedDeliveryDate: '2026-07-15',
    });
    await createSilverOrderLineRecord(db, {
      id: '22222222-2222-4222-8222-222222222222',
      naturalKey: 'line-active-status',
      company,
      supplierOrderId: orderId,
      supplierId: 'supplier-active',
      asin,
      sku,
      orderedQty: 100,
      receivedQty: 0,
      unitCost: 4,
      expectedSellableDate: '2026-07-20',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-active-status',
      companyProductId,
      snapshotDate: '2026-06-07',
      sellableStock: 0,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 5,
    });
    for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-active-status-${month}`,
        companyProductId,
        snapshotDate: `${month}-15`,
        units: 300,
        sales: 3000,
        netProfit: 900,
      });
    }

    const service = new EcobaseInventoryPlanningService(db);
    await service.refreshReadModel({ calculationDate: '2026-06-07' });
    const commandCenter = await service.commandCenter({
      calculationDate: '2026-06-07',
      pane: 'activeOrders',
      pageSize: 10,
    });
    const goldRows = await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({});
    expect(goldRows).toHaveLength(1);
    expect(goldRows[0]).toMatchObject({
      commandCenterPane: 'activeOrders',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderStatus: 'paid',
      openOrderCoverageQty: 100,
    });

    expect(commandCenter.panes.activeOrders.total).toBe(1);
    expect(commandCenter.panes.activeOrders.rows[0]).toMatchObject({
      asin,
      supplierOrderRef: 'PO-ACTIVE',
      supplierOrderStatus: 'paid',
      supplierOrderState: 'purchased_pipeline',
      openOrderCoverageQty: 100,
      expectedArrivalDate: '2026-07-20',
      expectedArrivalStatus: 'imported',
      expectedArrivalSource: 'silver_order_line.expectedSellableDate',
      expectedArrivalConfidence: 'authoritative',
      expectedArrivalFreshness: 'fresh',
    });
  });

  it('classifies derived, unknown, invalid, and stale active-order arrival evidence', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    for (const order of [
      {
        id: '51111111-1111-4111-8111-111111111111',
        asin: 'B00DERIVED',
        sku: 'DERIVED-ETA',
        orderDate: '2026-06-01',
        leadTimeDays: 30,
      },
      {
        id: '52222222-2222-4222-8222-222222222222',
        asin: 'B00UNKNOWN',
        sku: 'UNKNOWN-ETA',
        orderDate: '2026-06-01',
        expectedSellableDate: 'not-a-date',
      },
      {
        id: '53333333-3333-4333-8333-333333333333',
        asin: 'B00STALEETA',
        sku: 'STALE-ETA',
        orderDate: '2026-05-01',
        leadTimeDays: 30,
        expectedSellableDate: '2026-06-01',
      },
    ]) {
      const supplierId = `supplier-${order.sku}`;
      const companyProductId = `silver-company-product:${company}:${order.asin}:${order.sku}`;
      const supplierProductId = `silver-supplier-product:${supplierId}:${order.asin}:${order.sku}`;
      await createSilverOrderRecord(db, {
        id: order.id,
        company,
        supplierId,
        supplierName: `${order.sku} Supplier`,
        externalOrderRef: `PO-${order.sku}`,
        status: 'ORDERED',
        orderDate: order.orderDate,
        authorityStatus: order.sku === 'DERIVED-ETA' ? 'clickup_authoritative' : 'alternate_authoritative',
        authoritySource: order.sku === 'DERIVED-ETA' ? 'clickup_csv' : 'silver_status_evidence',
        authorityTaskRef: order.sku === 'DERIVED-ETA' ? 'task-derived-eta' : undefined,
        authorityAsOf: `${order.orderDate}T00:00:00.000Z`,
        authorityEvidenceJson: { orderRef: `PO-${order.sku}` },
      });
      await createSilverOrderLineRecord(db, {
        id: `line-${order.id}`,
        company,
        supplierOrderId: order.id,
        supplierId,
        supplierProductId,
        asin: order.asin,
        sku: order.sku,
        orderedQty: 10,
        receivedQty: 0,
        leadTimeDays: order.leadTimeDays,
        expectedSellableDate: order.expectedSellableDate,
      });
      if (order.sku === 'UNKNOWN-ETA') {
        await db
          .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
          .update({ filterByTk: supplierProductId, values: { leadTimeDays: undefined } });
      }
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-${order.sku}`,
        companyProductId,
        snapshotDate: '2026-06-07',
        sellableStock: 400,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: 1,
      });
      for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
        await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
          id: `fact-${order.sku}-${month}`,
          companyProductId,
          snapshotDate: `${month}-15`,
          units: 300,
          sales: 3000,
          netProfit: order.sku === 'UNKNOWN-ETA' ? 0 : 900,
        });
      }
    }

    await createRecord(db, 'users', {
      id: 202,
      email: 'clickup-user@example.com',
      nickname: 'ClickUp User',
    });
    await createSilverActivityCommentRecord(db, {
      id: 'activity-derived-eta',
      supplierOrderId: '51111111-1111-4111-8111-111111111111',
      activityType: 'status_update',
      actor: 'clickup-user@example.com',
      actorUserId: '202',
      notes: 'Supplier confirmed dispatch.',
      occurredAt: '2026-06-06T12:00:00.000Z',
      source: 'clickup_csv',
    });
    await createSilverActivityCommentRecord(db, {
      id: 'activity-derived-eta-older-imported-last',
      supplierOrderId: '51111111-1111-4111-8111-111111111111',
      activityType: 'note',
      actor: 'clickup-user@example.com',
      actorUserId: '202',
      notes: 'Older activity imported after the latest comment.',
      occurredAt: '2026-06-05T12:00:00.000Z',
      source: 'clickup_csv',
    });
    const service = new EcobaseInventoryPlanningService(db);
    await service.refreshReadModel({ company, calculationDate: '2026-06-07' });
    const commandCenter = await service.commandCenter({
      company,
      calculationDate: '2026-06-07',
      pane: 'activeOrders',
      pageSize: 10,
    });
    const row = (sku: string) => commandCenter.panes.activeOrders.rows.find((item) => item.sku === sku);
    expect(row('DERIVED-ETA')).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      expectedArrivalDate: '2026-07-04',
      expectedArrivalStatus: 'derived',
      expectedArrivalConfidence: 'estimated',
      expectedArrivalFreshness: 'fresh',
      pipelineHealthStatus: 'on_track',
      commandCenterPane: 'activeOrders',
      planningEligibilityStatus: 'eligible',
      dataQualityStatus: 'partial',
      supplierOrderAuthorityStatus: 'clickup_authoritative',
      supplierOrderAuthoritySource: 'clickup_csv',
      supplierOrderAuthorityTaskRef: 'task-derived-eta',
      latestSupplierOrderActivityAt: '2026-06-06T12:00:00.000Z',
      latestSupplierOrderActivityNote: 'Supplier confirmed dispatch.',
      latestSupplierOrderActivityActor: 'clickup-user@example.com',
      latestSupplierOrderActivityActorUserId: '202',
      latestSupplierOrderActivityActorDisplayName: 'ClickUp User',
      latestSupplierOrderActivityActorEmail: 'clickup-user@example.com',
      recommendedEscalation: 'recover_supplier',
    });
    expect(row('UNKNOWN-ETA')).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      tier: undefined,
      expectedArrivalStatus: 'unknown',
      expectedArrivalConfidence: 'none',
      expectedArrivalFreshness: 'unknown',
      pipelineHealthStatus: 'unknown_timing',
      commandCenterPane: 'activeOrders',
      dataQualityStatus: 'partial',
    });
    expect(row('STALE-ETA')).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      expectedArrivalDate: '2026-06-01',
      expectedArrivalStatus: 'imported',
      expectedArrivalFreshness: 'stale',
      pipelineHealthStatus: 'late',
      commandCenterPane: 'activeOrders',
    });
  });

  it('does not count completed order history as open coverage', async () => {
    const db = new MemoryDatabase();
    const orderId = '33333333-3333-4333-8333-333333333333';
    const company = 'Ecofission LLC';
    const asin = 'B000CLOSED';
    const sku = 'CLOSED-SKU';
    const companyProductId = `silver-company-product:${company}:${asin}:${sku}`;
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-closed-status',
      company,
      supplierId: 'supplier-closed',
      supplierName: 'Closed Supplier',
      externalOrderRef: 'PO-CLOSED',
      status: 'COMPLETE',
    });
    await createSilverOrderLineRecord(db, {
      id: '44444444-4444-4444-8444-444444444444',
      naturalKey: 'line-closed-status',
      company,
      supplierOrderId: orderId,
      supplierId: 'supplier-closed',
      asin,
      sku,
      orderedQty: 100,
      receivedQty: 0,
      unitCost: 4,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-closed-status',
      companyProductId,
      snapshotDate: '2026-06-07',
      sellableStock: 0,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 5,
    });
    for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-closed-status-${month}`,
        companyProductId,
        snapshotDate: `${month}-15`,
        units: 300,
        sales: 3000,
        netProfit: 900,
      });
    }

    await new EcobaseInventoryPlanningService(db).refreshReadModel({ calculationDate: '2026-06-07' });
    const row = db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .all()
      .find((item) => item.asin === asin);

    expect(row).toMatchObject({
      supplierOrderRef: 'PO-CLOSED',
      supplierOrderStatus: 'completed',
      supplierOrderState: 'closed_history',
      supplierOrderOpenQty: 0,
      openOrderCoverageQty: 0,
    });
  });

  it('projects persisted latest active-order activity without request-time reclassification', async () => {
    const db = new MemoryDatabase();
    const orderId = '11111111-1111-4111-8111-111111111111';
    await createRecord(db, 'users', {
      id: 201,
      email: 'nauman.ecofission@gmail.com',
      nickname: 'Ahmed Nauman',
    });
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-author',
      company: 'Ecofission LLC',
      externalOrderRef: 'ORD-AUTHOR',
      status: 'approval_pending',
    });
    await createSilverActivityCommentRecord(db, {
      id: '55555555-5555-4555-8555-555555555555',
      naturalKey: 'activity-author',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      activityType: 'note',
      actor: 'nauman.ecofission@gmail.com',
      actorUserId: '201',
      notes: 'Will proceed with the order on Monday.',
      occurredAt: '2026-06-07T14:00:00.000Z',
      source: 'clickup',
    });
    await createSilverActivityCommentRecord(db, {
      id: '66666666-6666-4666-8666-666666666666',
      naturalKey: 'activity-author-deleted',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      activityType: 'note',
      actor: 'operator',
      notes: 'Deleted comment should not drive table preview.',
      occurredAt: '2026-06-07T15:00:00.000Z',
      deletedAt: '2026-06-07T16:00:00.000Z',
      source: 'manual',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'active-author',
      naturalKey: 'active-author',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000AUTHOR',
      sku: 'SKU-AUTHOR',
      title: 'Author row',
      actionStatus: 'already_ordered',
      tier: 'A',
      estimatedProfitRisk: 120,
      supplierOrderState: 'purchased_pipeline',
      supplierOrderRef: 'ORD-AUTHOR',
      commandCenterPane: 'activeOrders',
      latestSupplierOrderActivityAt: new Date('2026-06-07T14:00:00.000Z'),
      latestSupplierOrderActivityActor: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityActorUserId: '201',
      latestSupplierOrderActivityActorDisplayName: 'Ahmed Nauman',
      latestSupplierOrderActivityActorEmail: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityNote: 'Will proceed with the order on Monday.',
      latestSupplierOrderActivitySource: 'clickup',
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-06-07',
      pane: 'activeOrders',
      pageSize: 10,
    });

    expect(commandCenter.panes.activeOrders.rows[0]).toMatchObject({
      latestSupplierOrderActivityAt: '2026-06-07T14:00:00.000Z',
      latestSupplierOrderActivityActor: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityActorUserId: '201',
      latestSupplierOrderActivityActorDisplayName: 'Ahmed Nauman',
      latestSupplierOrderActivityActorEmail: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityNote: 'Will proceed with the order on Monday.',
      latestSupplierOrderActivitySource: 'clickup',
    });
  });

  it('returns drawer order history for a primary SKU when the order used a duplicate alias SKU', async () => {
    const db = new MemoryDatabase();
    const supplierId = '77777777-7777-4777-8777-777777777777';
    const orderId = '88888888-8888-4888-8888-888888888888';
    await createSilverOrderRecord(db, {
      id: orderId,
      company: 'Ecofission LLC',
      supplierId,
      supplierName: 'Alias Supplier',
      externalOrderRef: 'ALIAS-ORDER-1',
      status: 'approval_pending',
    });
    await createSilverOrderLineRecord(db, {
      id: '99999999-9999-4999-8999-999999999999',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      asin: 'B000ALIAS',
      sku: 'ALIAS-SKU',
      orderedQty: 5,
    });

    const workspace = await new EcobaseInventoryPlanningService(db).rowWorkspace({
      company: 'Ecofission LLC',
      asin: 'B000ALIAS',
      sku: 'PRIMARY-SKU',
      supplierId,
    });

    expect(workspace.orderLineHistory).toEqual([
      expect.objectContaining({
        asin: 'B000ALIAS',
        sku: 'ALIAS-SKU',
        order: expect.objectContaining({ externalOrderRef: 'ALIAS-ORDER-1' }),
      }),
    ]);
  });

  it('shapes row drawer supplier/order history behind the inventory workspace interface', async () => {
    const db = new MemoryDatabase();
    const supplierId = '33333333-3333-4333-8333-333333333333';
    const orderId = '11111111-1111-4111-8111-111111111111';
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-drawer',
      company: 'Ecofission LLC',
      supplierId,
      supplierName: 'Drawer Supplier',
      externalOrderRef: 'DRAWER-1',
      status: 'approval_pending',
      lastMeaningfulUpdateAt: '2026-06-07T12:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: '44444444-4444-4444-8444-444444444444',
      naturalKey: 'line-drawer',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      asin: 'B000DRAWER',
      sku: 'DRAWER-SKU',
      orderedQty: 12,
      receivedQty: 0,
      observedAt: '2026-06-07T13:00:00.000Z',
    });
    await createRecord(db, 'users', {
      id: 201,
      email: 'nauman.ecofission@gmail.com',
      nickname: 'Ahmed Nauman',
    });
    await createSilverActivityCommentRecord(db, {
      id: '55555555-5555-4555-8555-555555555555',
      naturalKey: 'activity-drawer',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      activityType: 'status_update',
      actor: 'nauman.ecofission@gmail.com',
      actorUserId: '201',
      notes: 'Waiting on payment.',
      occurredAt: new Date('2026-06-07T14:00:00.000Z'),
    });
    await createSilverActivityCommentRecord(db, {
      id: '66666666-6666-4666-8666-666666666666',
      naturalKey: 'activity-drawer-deleted',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      activityType: 'note',
      actor: 'operator',
      notes: 'Deleted but retained.',
      occurredAt: '2026-06-07T15:00:00.000Z',
      deletedAt: '2026-06-07T16:00:00.000Z',
      deletedById: '201',
      source: 'manual',
    });

    const workspace = await new EcobaseInventoryPlanningService(db).rowWorkspace({
      company: 'Ecofission LLC',
      asin: 'B000DRAWER',
      sku: 'DRAWER-SKU',
      supplierId,
    });

    expect(workspace.suppliers).toHaveLength(1);
    expect(workspace.orderLineHistory[0]).toMatchObject({
      asin: 'B000DRAWER',
      order: { externalOrderRef: 'DRAWER-1' },
    });
    expect(workspace.orderActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorDisplayName: 'Ahmed Nauman',
          actorEmail: 'nauman.ecofission@gmail.com',
          occurredAt: '2026-06-07T14:00:00.000Z',
          notes: 'Waiting on payment.',
        }),
        expect.objectContaining({
          id: '66666666-6666-4666-8666-666666666666',
          deletedAt: '2026-06-07T16:00:00.000Z',
          notes: 'Deleted but retained.',
        }),
      ]),
    );
    expect(workspace.initialOrderEdit).toMatchObject({ supplierOrderId: orderId, status: 'approval_pending' });
    expect(workspace.actionDefaults).toMatchObject({
      draftSupplierId: supplierId,
      leadSupplierId: supplierId,
      addSupplierOrderId: orderId,
    });
  });

  it('keeps the daily digest bounded to order-now risk and supplier contact priorities', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'gold-risk-1',
      calculationDate: '2026-06-07',
      planningProductId: 'planning-product-1',
      company: 'Ecofission LLC',
      asin: 'B000RISK',
      sku: 'SKU-RISK',
      tier: 'A',
      actionStatus: 'order_today',
      supplierName: 'Digest Supplier',
      supplierOrderState: 'placed_not_purchased',
      supplierOrderStatus: 'approval_pending',
      supplierOrderRef: 'ORD-1',
      leadTimeFreshness: 'fresh',
      digestPriority: 1,
    });
    await createSilverOrderRecord(db, {
      id: '11111111-1111-4111-8111-111111111111',
      naturalKey: 'order-1',
      sourceConnectionId: '22222222-2222-4222-8222-222222222222',
      company: 'Ecofission LLC',
      supplierId: '33333333-3333-4333-8333-333333333333',
      externalOrderRef: 'ORD-1',
      sourceStage: 'manual',
      status: 'approval_pending',
      statusSource: 'manual',
      orderDate: '2026-06-07',
    });
    await createSilverOrderLineRecord(db, {
      id: '44444444-4444-4444-8444-444444444444',
      naturalKey: 'order-line-1',
      supplierOrderId: '11111111-1111-4111-8111-111111111111',
      company: 'Ecofission LLC',
      supplierId: '33333333-3333-4333-8333-333333333333',
      planningProductId: 'planning-product-1',
      asin: 'B000RISK',
      sku: 'SKU-RISK',
      orderedQty: 5,
      receivedQty: 0,
      sourceOrderLineRef: 'ORD-1:B000RISK',
      sourceStage: 'manual',
    });
    await createSilverActivityCommentRecord(db, {
      id: '55555555-5555-4555-8555-555555555555',
      naturalKey: 'activity-1',
      supplierOrderId: '11111111-1111-4111-8111-111111111111',
      supplierId: '33333333-3333-4333-8333-333333333333',
      company: 'Ecofission LLC',
      activityType: 'status_update',
      occurredAt: '2026-06-07T12:00:00.000Z',
      notes: 'Invoice received, payment still pending.',
      source: 'manual',
    });

    const digest = await new EcobaseInventoryPlanningService(db).digestPreview({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(digest.summary).toMatchObject({ orderToday: 1, atRisk: 1, suppliersToContact: 0 });
    expect(digest.sections.orderNow).toHaveLength(1);
    expect(digest.sections.orderNow[0]).toMatchObject({
      supplierOrderRef: 'ORD-1',
      latestSupplierOrderActivityNote: 'Invoice received, payment still pending.',
    });
    expect(digest.sections.supplierActionItems).toEqual([]);
    expect(digest.sections.suppliersToContactFirst).toEqual([]);
  });

  it('puts no-order digest rows before placed-but-not-purchased rows and excludes purchased pipeline rows', async () => {
    const db = new MemoryDatabase();
    const digestRows = [
      {
        id: 'no-order',
        actionStatus: 'overdue',
        supplierOrderState: 'no_open_order',
        leadTimeFreshness: 'fresh',
        digestPriority: 1,
      },
      {
        id: 'payment-pending',
        actionStatus: 'order_today',
        supplierOrderState: 'placed_not_purchased',
        supplierOrderStatus: 'payment_pending',
        supplierOrderRef: 'PP-1',
        leadTimeFreshness: 'stale',
        digestPriority: 2,
      },
      {
        id: 'approval-soon',
        actionStatus: 'order_soon',
        supplierOrderState: 'placed_not_purchased',
        supplierOrderStatus: 'approval_pending',
        supplierOrderRef: 'APP-1',
        leadTimeFreshness: 'fresh',
        digestPriority: 3,
      },
      {
        id: 'paid-pipeline',
        actionStatus: 'order_today',
        supplierOrderState: 'purchased_pipeline',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PAID-1',
        leadTimeFreshness: 'fresh',
        digestPriority: 4,
      },
      {
        id: 'paid-evidence',
        actionStatus: 'order_today',
        supplierOrderState: 'purchased_pipeline',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PAID-EVIDENCE-1',
        leadTimeFreshness: 'fresh',
        digestPriority: 5,
      },
    ];
    for (const row of digestRows) {
      await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
        id: `gold-${row.id}`,
        calculationDate: '2026-06-07',
        planningProductId: row.id,
        company: 'Ecofission LLC',
        asin: `ASIN-${row.id}`,
        sku: `SKU-${row.id}`,
        tier: 'A',
        supplierName: 'Digest Supplier',
        openOrderCoverageQty: 0,
        ...row,
      });
    }

    await createSilverOrderRecord(db, {
      id: 'order-payment-pending',
      naturalKey: 'supplier-order:Ecofission LLC:PP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'PP-1',
      sourceStage: 'manual',
      status: 'payment_pending',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-payment-pending',
      naturalKey: 'supplier-order-line:PP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-payment-pending',
      planningProductId: 'payment-pending',
      asin: 'ASIN-payment-pending',
      sku: 'SKU-payment-pending',
      orderedQty: 20,
      receivedQty: 0,
    });
    await createSilverOrderRecord(db, {
      id: 'order-old-paid',
      naturalKey: 'supplier-order:Ecofission LLC:OLD-PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'OLD-PAID-1',
      sourceStage: 'purchase_order',
      status: 'paid',
      lastMeaningfulUpdateAt: '2026-06-01T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-old-paid',
      naturalKey: 'supplier-order-line:OLD-PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-old-paid',
      planningProductId: 'payment-pending',
      asin: 'ASIN-payment-pending',
      sku: 'SKU-payment-pending',
      orderedQty: 90,
      receivedQty: 0,
      expectedSellableDate: '2026-06-20',
    });
    await createSilverOrderRecord(db, {
      id: 'order-approval-soon',
      naturalKey: 'supplier-order:Ecofission LLC:APP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'APP-1',
      sourceStage: 'manual',
      status: 'approval_pending',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-approval-soon',
      naturalKey: 'supplier-order-line:APP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-approval-soon',
      planningProductId: 'approval-soon',
      asin: 'ASIN-approval-soon',
      sku: 'SKU-approval-soon',
      orderedQty: 20,
      receivedQty: 0,
    });
    await createSilverOrderRecord(db, {
      id: 'order-paid-pipeline',
      naturalKey: 'supplier-order:Ecofission LLC:PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'PAID-1',
      sourceStage: 'manual',
      status: 'paid',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-paid-pipeline',
      naturalKey: 'supplier-order-line:PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-paid-pipeline',
      planningProductId: 'paid-pipeline',
      asin: 'ASIN-paid-pipeline',
      sku: 'SKU-paid-pipeline',
      orderedQty: 20,
      receivedQty: 0,
    });
    await createSilverOrderRecord(db, {
      id: 'order-paid-evidence',
      naturalKey: 'supplier-order:Ecofission LLC:PAID-EVIDENCE-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'PAID-EVIDENCE-1',
      sourceStage: 'purchase_order',
      status: 'approval_pending',
      paymentStatus: 'Completed',
      approvalStatus: 'Approved',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-paid-evidence',
      naturalKey: 'supplier-order-line:PAID-EVIDENCE-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-paid-evidence',
      planningProductId: 'paid-evidence',
      asin: 'ASIN-paid-evidence',
      sku: 'SKU-paid-evidence',
      orderedQty: 20,
      receivedQty: 0,
    });

    const digest = await new EcobaseInventoryPlanningService(db).digestPreview({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
      limit: 1,
    });

    expect(digest.summary).toMatchObject({ noSupplierOrder: 1, placedNotPurchased: 2, purchasedPipelineExcluded: 2 });
    expect(digest.sections.orderNow.map((row) => row.planningProductId)).toEqual([
      'no-order',
      'payment-pending',
      'approval-soon',
    ]);
    expect(digest.sections.orderNow[0]).toMatchObject({ supplierOrderState: 'no_open_order' });
    expect(digest.sections.noOrderProducts.map((row) => row.planningProductId)).toEqual(['no-order']);
    expect(digest.sections.orderNow[1]).toMatchObject({
      supplierOrderState: 'placed_not_purchased',
      supplierOrderStatus: 'payment_pending',
      supplierOrderRef: 'PP-1',
      openOrderCoverageQty: 0,
    });
    expect(digest.sections.orderNow[2]).toMatchObject({
      actionStatus: 'order_soon',
      supplierOrderState: 'placed_not_purchased',
      supplierOrderStatus: 'approval_pending',
      supplierOrderRef: 'APP-1',
      openOrderCoverageQty: 0,
    });
    expect(digest.sections.supplierActionItems.map((row) => row.planningProductId)).toEqual(['payment-pending']);
    expect(digest.sections.suppliersToContactFirst).toEqual([
      expect.objectContaining({ supplierName: 'Digest Supplier', urgentCount: 1 }),
    ]);
  });
});
