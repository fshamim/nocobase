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
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { EcobaseDailyOperationsBriefService } from '../../features/daily-operations-brief/server/daily-operations-brief-service';

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  constructor(private records: Record<string, unknown>[] = []) {}
  async find(
    params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {},
  ) {
    const rows = this.filterRecords(params);
    return this.sortRows(rows, params.sort).slice(0, params.limit ?? rows.length);
  }
  async findOne(
    params: { filter?: Record<string, unknown>; filterByTk?: string | number; sort?: string[]; limit?: number } = {},
  ) {
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
    const rows = this.filterRecords({ filter, filterByTk });
    if (!rows.length) throw new Error('MemoryRepository update failed: record not found.');
    rows.forEach((row) => Object.assign(row, values));
    return rows[0];
  }
  private filterRecords(params: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    if (params.filterByTk) return this.records.filter((record) => record.id === params.filterByTk);
    const filter = params.filter ?? {};
    return this.records.filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value));
  }
  private sortRows(rows: Record<string, unknown>[], sort: string[] = []) {
    const [first] = sort;
    if (!first) return rows;
    const descending = first.startsWith('-');
    const key = descending ? first.slice(1) : first;
    return [...rows].sort((left, right) => {
      const result = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();
  constructor() {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository()));
  }
  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    return repository;
  }
}

function service(db = new MemoryDatabase()) {
  return { db, brief: new EcobaseDailyOperationsBriefService(db) };
}

async function seedProduct(db: MemoryDatabase, values: Record<string, unknown> = {}) {
  const id = String(values.id ?? 'product-1');
  const company = String(values.company ?? 'ACME');
  const asin = String(values.canonicalAsin ?? 'B00FOCUS');
  const sku = typeof values.sku === 'string' ? values.sku : undefined;
  const title = String(values.title ?? 'Focus product');
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
    values: { id: `company:${company}`, name: company, companyKey: company.toLowerCase() },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: `product:${id}`, asin, sku, title },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: { id, companyId: `company:${company}`, productId: `product:${id}` },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
    values: {
      id: `gold:${id}`,
      naturalKey: `gold:${id}`,
      company,
      planningProductId: id,
      companyProductId: id,
      asin,
      sku,
      title,
      calculationDate: '2026-06-10',
      actionStatus: 'watch',
    },
  });
}

async function seedGoldInventoryRow(db: MemoryDatabase, values: Record<string, unknown>) {
  await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
    values: {
      id: values.id,
      naturalKey: values.naturalKey ?? values.id,
      company: values.company ?? 'ACME',
      planningProductId: values.planningProductId ?? values.id,
      asin: values.asin,
      sku: values.sku,
      title: values.title ?? values.asin,
      tier: values.tier ?? 'A',
      calculationDate: values.calculationDate ?? '2026-06-10',
      lastRefreshedAt: values.lastRefreshedAt ?? '2026-06-10T08:00:00.000Z',
      actionStatus: values.actionStatus ?? 'watch',
      productStatus: values.productStatus ?? 'active',
      commandCenterPane: values.commandCenterPane ?? 'watch',
      commandCenterPaneReason: values.commandCenterPaneReason ?? 'not_in_action_population',
      planningEligibilityStatus: values.planningEligibilityStatus ?? 'watch',
      planningEligibilityReason: values.planningEligibilityReason ?? 'not_in_action_population',
      dataQualityStatus: values.dataQualityStatus ?? 'ready',
      dataQualityIssues: values.dataQualityIssues ?? [],
      supplierName: values.supplierName,
      supplierAvailability: values.supplierAvailability,
      supplierOrderState: values.supplierOrderState ?? 'no_open_order',
      supplierOrderStatus: values.supplierOrderStatus,
      supplierOrderRef: values.supplierOrderRef,
      estimatedProfitRisk: Object.prototype.hasOwnProperty.call(values, 'estimatedProfitRisk')
        ? values.estimatedProfitRisk
        : 0,
      estimatedProfitRiskBasis: values.estimatedProfitRiskBasis ?? 'test_fixture',
      moneyRiskStatus: values.moneyRiskStatus ?? 'resolved_zero',
      moneyRiskInputs: values.moneyRiskInputs ?? {},
      salesVelocity: values.salesVelocity ?? 1,
      leadTimeFreshness: values.leadTimeFreshness ?? 'fresh',
      leadTimeDays: values.leadTimeDays ?? 14,
      suggestedReorderQty: values.suggestedReorderQty ?? 10,
      targetCoverDays: values.targetCoverDays ?? 45,
      currentPlanningStock: values.currentPlanningStock ?? 0,
      sellableStock: values.sellableStock ?? 0,
      reservedStock: values.reservedStock ?? 0,
      pipelineStock: values.pipelineStock ?? 0,
      daysOfCover: values.daysOfCover ?? 0,
      daysUntilSafeReorder: values.daysUntilSafeReorder,
      latestSafeReorderDate: values.latestSafeReorderDate,
      estimatedOosDate: values.estimatedOosDate,
      daysUntilOos: values.daysUntilOos,
      expectedArrivalDate: values.expectedArrivalDate,
      expectedArrivalStatus: values.expectedArrivalStatus,
      pipelineHealthStatus: values.pipelineHealthStatus ?? 'none',
      stuck: values.stuck ?? false,
      stuckClassification: values.stuckClassification ?? 'none',
      recommendedEscalation: values.recommendedEscalation,
      openOrderCoverageQty: values.openOrderCoverageQty ?? 0,
      digestPriority: values.digestPriority ?? 1,
      evidence: {},
    },
  });
}

describe('EcobaseDailyOperationsBriefService broader evidence focus', () => {
  it('reuses inventory command-center buckets for daily decision alerts', async () => {
    const { db, brief } = service();
    await seedGoldInventoryRow(db, {
      id: 'gold-no-order',
      asin: 'B00NOORDER',
      actionStatus: 'overdue',
      supplierOrderState: 'no_open_order',
      supplierName: 'Urgent Supplier',
      supplierAvailability: 'resolved_silver_link',
      leadTimeFreshness: 'missing',
      daysUntilSafeReorder: -2,
      latestSafeReorderDate: '2026-06-08',
      estimatedOosDate: '2026-06-11',
      estimatedProfitRisk: 900,
      commandCenterPane: 'supplyAction',
      commandCenterPaneReason: 'eligible_stockout_no_active_order',
      planningEligibilityStatus: 'eligible',
    });
    await seedGoldInventoryRow(db, {
      id: 'gold-active-late',
      asin: 'B00LATEPO',
      actionStatus: 'already_ordered',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderStatus: 'purchased',
      supplierOrderRef: 'PO-123',
      supplierName: 'Late Supplier',
      expectedArrivalDate: '2026-06-15',
      expectedArrivalStatus: 'imported',
      estimatedOosDate: '2026-06-12',
      estimatedProfitRisk: 600,
      commandCenterPane: 'activeOrders',
      commandCenterPaneReason: 'active_supplier_order',
      planningEligibilityStatus: 'eligible',
      pipelineHealthStatus: 'late',
      recommendedEscalation: 'follow_up_order',
    });
    await seedGoldInventoryRow(db, {
      id: 'gold-stuck',
      asin: 'B00STUCK',
      actionStatus: 'watch',
      supplierName: 'Stock Supplier',
      currentPlanningStock: 200,
      daysOfCover: 120,
      salesVelocity: 1,
      stuck: true,
      stuckClassification: 'over_60_doc',
      commandCenterPane: 'stuckInventory',
      commandCenterPaneReason: 'positive_stock_high_cover',
      planningEligibilityStatus: 'eligible',
      estimatedProfitRisk: 300,
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('inventory_risk');
    expect(evidence.inventoryCommandCenter.alerts.supplyActionNeeded).toEqual([
      expect.objectContaining({ asin: 'B00NOORDER', actionStatus: 'overdue' }),
    ]);
    expect(evidence.inventoryCommandCenter.alerts.activeOrdersOffTrack).toEqual([
      expect.objectContaining({ asin: 'B00LATEPO', pipelineHealthStatus: 'late' }),
    ]);
    expect(evidence.inventoryCommandCenter.alerts.followUpsDueToday).toEqual([
      expect.objectContaining({ asin: 'B00LATEPO', recommendedEscalation: 'follow_up_order' }),
    ]);
    expect(evidence.inventoryCommandCenter.alerts.leadTimeDataGaps).toEqual([
      expect.objectContaining({ asin: 'B00NOORDER' }),
    ]);
    expect(evidence.inventoryCommandCenter.alerts.stuckInventoryReview).toEqual([
      expect.objectContaining({ asin: 'B00STUCK', stuckClassification: 'over_60_doc' }),
    ]);
    expect(evidence.summaryCounts).toMatchObject({
      supplyActionCount: 1,
      activeOrderCount: 1,
      stuckInventoryCount: 1,
      includedCommandCenterAlertItemCount: 5,
      activeOrderOffTrackCount: 1,
      followUpDueTodayCount: 1,
      stuckInventoryReviewCount: 1,
    });
  });

  it('keeps exact paginated Gold totals and separates unknown active-order timing', async () => {
    const { db, brief } = service();
    for (let index = 0; index < 105; index += 1) {
      await seedGoldInventoryRow(db, {
        id: `gold-active-${index}`,
        asin: `B00ACTIVE${index}`,
        actionStatus: 'already_ordered',
        supplierOrderState: 'purchased_pipeline',
        supplierOrderStatus: 'paid',
        supplierOrderRef: `PO-${index}`,
        commandCenterPane: 'activeOrders',
        commandCenterPaneReason: 'active_supplier_order',
        planningEligibilityStatus: 'eligible',
        pipelineHealthStatus: index === 0 ? 'unknown_timing' : 'on_track',
        expectedArrivalStatus: index === 0 ? 'unknown' : 'imported',
        expectedArrivalDate: index === 0 ? undefined : '2026-06-20',
        estimatedProfitRisk: index === 0 ? null : 10,
        moneyRiskStatus: index === 0 ? 'unknown_arrival' : 'resolved_positive',
      });
    }
    for (let index = 0; index < 12; index += 1) {
      await seedGoldInventoryRow(db, {
        id: `gold-supply-${index}`,
        asin: `B00SUPPLY${index}`,
        actionStatus: 'overdue',
        supplierOrderState: 'no_open_order',
        supplierAvailability: 'resolved_silver_link',
        commandCenterPane: 'supplyAction',
        commandCenterPaneReason: 'eligible_stockout_no_active_order',
        planningEligibilityStatus: 'eligible',
        estimatedProfitRisk: 20,
        moneyRiskStatus: 'resolved_positive',
      });
    }
    await seedGoldInventoryRow(db, {
      id: 'gold-duplicate-risk',
      asin: 'B00DUPLICATE',
      actionStatus: 'overdue',
      commandCenterPane: 'duplicateProducts',
      commandCenterPaneReason: 'duplicate_company_asin_sku',
      planningEligibilityStatus: 'ineligible_duplicate',
      estimatedProfitRisk: 999,
      moneyRiskStatus: 'resolved_positive',
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 5,
    });

    expect(evidence.summaryCounts).toMatchObject({
      supplyActionCount: 12,
      includedSupplyActionCount: 5,
      omittedSupplyActionCount: 7,
      activeOrderCount: 105,
      activeOrderOffTrackCount: 0,
      activeOrderUnknownTimingCount: 1,
      moneyAtRiskKnownTotal: 1280,
      moneyAtRiskUnknownCount: 1,
    });
    expect(evidence.inventoryCommandCenter.panes.activeOrders).toMatchObject({ total: 105 });
    expect(evidence.inventoryCommandCenter.alerts.activeOrdersOffTrack).toEqual([]);
    expect(evidence.inventoryCommandCenter.alerts.activeOrdersUnknownTiming).toEqual([
      expect.objectContaining({ asin: 'B00ACTIVE0', expectedArrivalStatus: 'unknown' }),
    ]);
  });

  it('chooses Buy Box focus from a deterministic win-rate drop', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-buybox', canonicalAsin: 'B00BUYBOX' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).create({
      values: {
        id: 'traffic-prior',
        companyProductId: 'product-buybox',
        snapshotDate: '2026-06-09',
        asin: 'B00BUYBOX',
        buyBoxPercentage: 96,
        unitsOrdered: 20,
        orderedProductSales: 400,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).create({
      values: {
        id: 'traffic-current',
        companyProductId: 'product-buybox',
        snapshotDate: '2026-06-10',
        asin: 'B00BUYBOX',
        buyBoxPercentage: 52,
        unitsOrdered: 5,
        orderedProductSales: 100,
      },
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('buybox');
    expect(evidence.buyBoxRisks).toEqual([
      expect.objectContaining({
        asin: 'B00BUYBOX',
        currentBuyBoxWinRate: 52,
        baselineBuyBoxWinRate: 96,
        winRateDropPoints: 44,
      }),
    ]);
  });

  it('chooses velocity focus when units drop and inventory is not urgent', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-velocity', canonicalAsin: 'B00VELO' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        naturalKey: 'fact-prior',
        sourceConnectionId: 'source-1',
        companyProductId: 'product-velocity',
        snapshotDate: '2026-06-09',
        company: 'ACME',
        asin: 'B00VELO',
        units: 20,
        sales: 400,
        profit: 120,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        naturalKey: 'fact-current',
        sourceConnectionId: 'source-1',
        companyProductId: 'product-velocity',
        snapshotDate: '2026-06-10',
        company: 'ACME',
        asin: 'B00VELO',
        units: 5,
        sales: 100,
        profit: 30,
      },
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('velocity');
    expect(evidence.performanceTrends).toEqual([
      expect.objectContaining({ trendType: 'velocity_drop', asin: 'B00VELO', velocityDropPercent: 75 }),
    ]);
  });

  it('chooses profit-gap focus when target profit is missed without a velocity drop', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-profit', canonicalAsin: 'B00PROFIT' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        naturalKey: 'profit-prior',
        sourceConnectionId: 'source-1',
        companyProductId: 'product-profit',
        snapshotDate: '2026-06-09',
        company: 'ACME',
        asin: 'B00PROFIT',
        units: 10,
        sales: 200,
        profit: 40,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        naturalKey: 'profit-current',
        sourceConnectionId: 'source-1',
        companyProductId: 'product-profit',
        snapshotDate: '2026-06-10',
        company: 'ACME',
        asin: 'B00PROFIT',
        units: 10,
        sales: 200,
        profit: 40,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
      values: {
        naturalKey: 'profit-target',
        sourceConnectionId: 'source-1',
        recordKind: 'target',
        entityType: 'company_product',
        entityId: 'product-profit',
        company: 'ACME',
        period: '2026-06',
        periodType: 'monthly',
        targetValue: 100,
      },
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('profit_gap');
    expect(evidence.performanceTrends).toEqual([
      expect.objectContaining({ trendType: 'profit_gap', asin: 'B00PROFIT', profitGap: 60 }),
    ]);
  });

  it('chooses OKR focus for off-track OKR and stale task evidence', async () => {
    const { db, brief } = service();
    await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
      values: {
        id: 'okr-1',
        naturalKey: 'okr-1',
        recordKind: 'target',
        entityType: 'objective',
        sourceTargetRef: 'OKR-1',
        metric: 'okr',
        periodType: '2026-Q2',
        company: 'ACME',
        title: 'Recover Buy Box',
        owner: 'Ops',
        operationalArea: 'Marketplace',
        period: '2026-Q2',
        status: 'active',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
      values: {
        id: 'okr-snapshot-1',
        naturalKey: 'okr-snapshot-1',
        recordKind: 'metric_snapshot',
        entityType: 'objective',
        metric: 'Buy Box recovery',
        periodType: 'snapshot',
        parentTargetId: 'okr-1',
        sourceTargetRef: 'OKR-1',
        snapshotDate: '2026-06-10',
        metricName: 'Buy Box recovery',
        progressPercent: 40,
        status: 'off_track',
        owner: 'Ops',
        operationalArea: 'Marketplace',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTasks).create({
      values: {
        id: 'task-snapshot-1',
        naturalKey: 'task-snapshot-1',
        sourceConnectionId: 'source-1',
        snapshotDate: '2026-06-10',
        sourceTaskRef: 'CU-1',
        taskName: 'Contact marketplace owner',
        title: 'Contact marketplace owner',
        status: 'open',
        priority: 'high',
        assignee: 'Ops',
        dueDate: '2026-06-08',
        lastMeaningfulUpdateAt: '2026-06-05T00:00:00.000Z',
      },
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('okr');
    expect(evidence.okrAccountabilityRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ riskType: 'okr_off_track', targetTitle: 'Recover Buy Box', progressPercent: 40 }),
        expect.objectContaining({ riskType: 'task_overdue', taskId: 'CU-1' }),
      ]),
    );
  });

  it('keeps critical source quality above otherwise valid Buy Box risk', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-source', canonicalAsin: 'B00SOURCE' });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-bad',
        name: 'Sellerboard ACME',
        sourceType: 'sellerboard',
        domain: 'amazon_operations',
        active: true,
        config: { warningPolicy: { required: true } },
        freshnessSlaMinutes: 1440,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-bad',
        sourceConnectionId: 'source-bad',
        status: 'failed',
        errorMessage: 'download failed',
        startedAt: '2026-06-10T07:00:00.000Z',
        finishedAt: '2026-06-10T07:01:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).create({
      values: {
        id: 'source-traffic-prior',
        companyProductId: 'product-source',
        snapshotDate: '2026-06-09',
        asin: 'B00SOURCE',
        buyBoxPercentage: 95,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).create({
      values: {
        id: 'source-traffic-current',
        companyProductId: 'product-source',
        snapshotDate: '2026-06-10',
        asin: 'B00SOURCE',
        buyBoxPercentage: 50,
      },
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('source_quality');
    expect(evidence.dataWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_required_source' }),
        expect.objectContaining({ code: 'failed_latest_run' }),
      ]),
    );
    expect(evidence.buyBoxRisks).toHaveLength(1);
  });

  it('marks new products without baseline as watch-list evidence instead of off-track focus', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-new', canonicalAsin: 'B00NEW' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        naturalKey: 'new-current',
        sourceConnectionId: 'source-1',
        companyProductId: 'product-new',
        snapshotDate: '2026-06-10',
        company: 'ACME',
        asin: 'B00NEW',
        units: 4,
        sales: 80,
        profit: 20,
      },
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('no_major_exception');
    expect(evidence.performanceTrends).toEqual([
      expect.objectContaining({
        asin: 'B00NEW',
        confidence: 'low',
        warnings: [expect.stringContaining('No prior-period')],
      }),
    ]);
  });

  it('uses mixed-domain priority order after inventory and supplier orders', async () => {
    const { db, brief } = service();
    await seedProduct(db, { id: 'product-mixed', canonicalAsin: 'B00MIXED' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).create({
      values: {
        id: 'mixed-traffic-prior',
        companyProductId: 'product-mixed',
        snapshotDate: '2026-06-09',
        asin: 'B00MIXED',
        buyBoxPercentage: 90,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).create({
      values: {
        id: 'mixed-traffic-current',
        companyProductId: 'product-mixed',
        snapshotDate: '2026-06-10',
        asin: 'B00MIXED',
        buyBoxPercentage: 55,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        naturalKey: 'mixed-fact-prior',
        sourceConnectionId: 'source-1',
        companyProductId: 'product-mixed',
        snapshotDate: '2026-06-09',
        company: 'ACME',
        asin: 'B00MIXED',
        units: 20,
        sales: 400,
        profit: 120,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        naturalKey: 'mixed-fact-current',
        sourceConnectionId: 'source-1',
        companyProductId: 'product-mixed',
        snapshotDate: '2026-06-10',
        company: 'ACME',
        asin: 'B00MIXED',
        units: 5,
        sales: 100,
        profit: 30,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
      values: {
        id: 'okr-mixed',
        naturalKey: 'okr-mixed',
        recordKind: 'target',
        entityType: 'objective',
        sourceTargetRef: 'OKR-MIXED',
        metric: 'okr',
        periodType: 'unknown',
        company: 'ACME',
        title: 'Ops hygiene',
        owner: 'Ops',
        status: 'active',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
      values: {
        id: 'mixed-okr',
        naturalKey: 'mixed-okr',
        recordKind: 'metric_snapshot',
        entityType: 'objective',
        metric: 'Ops hygiene',
        periodType: 'snapshot',
        parentTargetId: 'okr-mixed',
        sourceTargetRef: 'OKR-MIXED',
        snapshotDate: '2026-06-10',
        metricName: 'Ops hygiene',
        progressPercent: 30,
        status: 'off_track',
        owner: 'Ops',
      },
    });

    const evidence = await brief.buildEvidencePack({
      company: 'ACME',
      date: '2026-06-10',
      timezone: 'Asia/Karachi',
      maxItems: 10,
    });

    expect(evidence.focus).toBe('buybox');
    expect(evidence.summaryCounts).toMatchObject({
      buyBoxRiskCount: 1,
      performanceTrendCount: 1,
      okrAccountabilityRiskCount: 1,
    });
  });
});
