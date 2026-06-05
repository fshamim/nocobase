import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseAlertEvaluationService } from '../services/alert-evaluation-service';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
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

  async update({ filter, filterByTk, values }: { filter?: Record<string, unknown>; filterByTk?: string | number; values: Record<string, unknown> }) {
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
    return this.records.filter((record) => Object.entries(filter).every(([key, expected]) => record[key] === expected));
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
      if (leftValue === rightValue) {
        return 0;
      }
      const result = leftValue > rightValue ? 1 : -1;
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
    if (!repository) {
      throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    }
    return repository;
  }
}

async function seedPlanningProduct(db: MemoryDatabase, overrides: Record<string, unknown> = {}) {
  const product = {
    id: overrides.id ?? 'product-1',
    naturalKey: overrides.naturalKey ?? `planning-product:QA:${overrides.asin ?? 'B010ALERT'}`,
    company: overrides.company ?? 'QA Alerts Co',
    canonicalAsin: overrides.asin ?? 'B010ALERT',
    title: overrides.title ?? 'Alert QA product',
    mappingStatus: overrides.mappingStatus ?? 'confirmed',
  };
  await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({ values: product });
  return product;
}

async function seedPlanningRows(db: MemoryDatabase, product: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const planningProductId = String(product.id);
  const company = String(product.company);
  const asin = String(product.canonicalAsin);
  await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
    values: {
      naturalKey: `inventory:${planningProductId}:2025-07-10`,
      sourceConnectionId: 'source-1',
      planningProductId,
      snapshotDate: '2025-07-10',
      company,
      asin,
      stock: overrides.stock ?? 0,
      reserved: overrides.reserved ?? 0,
      inbound: overrides.inbound ?? 0,
      ordered: overrides.ordered ?? 0,
      prepStock: overrides.prepStock ?? 0,
      salesVelocity: overrides.salesVelocity ?? 5,
      recommendedReorderQuantity: overrides.recommendedReorderQuantity ?? 20,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.planningParameters).create({
    values: {
      naturalKey: `parameter:${planningProductId}`,
      sourceConnectionId: 'source-1',
      planningProductId,
      company,
      asin,
      leadTimeDays: overrides.leadTimeDays ?? 10,
      safetyBufferDays: overrides.safetyBufferDays ?? 7,
      profitPerUnit: overrides.profitPerUnit ?? 4,
      recommendedBestQty: overrides.recommendedBestQty ?? 50,
      payload: { baselineVelocity: overrides.baselineVelocity ?? 10 },
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.targetRows).create({
    values: {
      naturalKey: `target:${planningProductId}:2025-07`,
      sourceConnectionId: 'source-1',
      planningProductId,
      company,
      periodType: 'monthly',
      period: '2025-07',
      targetScope: 'planning_product',
      profitTarget: overrides.profitTarget ?? 500,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
    values: {
      naturalKey: `fact:${planningProductId}:2025-07-10`,
      sourceConnectionId: 'source-1',
      planningProductId,
      snapshotDate: '2025-07-10',
      company,
      asin,
      units: overrides.units ?? 1,
      netProfit: overrides.netProfit ?? 10,
      margin: overrides.margin ?? 30,
      refundRate: overrides.refundRate ?? 0,
      payload: { buyBoxPercentage: overrides.buyBoxPercentage ?? 100 },
    },
  });
}

async function seedOrderCoverage(db: MemoryDatabase, product: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const supplierId = String(overrides.supplierId ?? 'supplier-1');
  const orderId = String(overrides.orderId ?? 'order-1');
  const lineId = String(overrides.lineId ?? 'line-1');
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).create({
    values: {
      id: orderId,
      naturalKey: `supplier-order:${orderId}`,
      company: product.company,
      supplierId,
      status: overrides.status ?? 'confirmed',
      expectedDeliveryDate: overrides.expectedDeliveryDate ?? '2025-07-18',
      externalOrderRef: overrides.externalOrderRef ?? `PO-${orderId}`,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).create({
    values: {
      id: lineId,
      naturalKey: `supplier-order-line:${lineId}`,
      company: product.company,
      supplierOrderId: orderId,
      supplierId,
      planningProductId: product.id,
      orderedQty: overrides.orderedQty ?? 20,
      receivedQty: overrides.receivedQty ?? 0,
      expectedSellableDate: overrides.expectedSellableDate,
      unitCost: overrides.unitCost ?? 3,
    },
  });
  if (overrides.contactedAt) {
    await db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities).create({
      values: {
        id: `activity-${lineId}`,
        naturalKey: `activity:${lineId}`,
        company: product.company,
        supplierId,
        supplierOrderId: orderId,
        activityType: 'contacted_supplier',
        occurredAt: overrides.contactedAt,
        source: 'manual',
      },
    });
  }
  return { orderId, lineId, supplierId };
}

describe('Ecobase deterministic alert evaluation service', () => {
  it('installs default rule config, creates rule/evaluation/alert records, orders OOS root causes, and dedupes repeated runs', async () => {
    const db = new MemoryDatabase();
    const product = await seedPlanningProduct(db);
    await seedPlanningRows(db, product, { stock: 0, inbound: 5, salesVelocity: 5, recommendedReorderQuantity: 30 });

    const service = new EcobaseAlertEvaluationService(db);
    const firstRun = await service.evaluatePlanningProducts({ planningProductId: String(product.id), calculationDate: '2025-07-10' });
    const secondRun = await service.evaluatePlanningProducts({ planningProductId: String(product.id), calculationDate: '2025-07-10' });

    expect(firstRun.productCount).toBe(1);
    expect(firstRun.ruleVersion.config).toMatchObject({
      buyBoxRiskThresholdPercent: 80,
      buyBoxHighRiskThresholdPercent: 70,
      marginGapPercent: 15,
      velocityBaselineThresholdPercent: 80,
      leadTimeStaleDays: 30,
      safetyBufferDays: 7,
      prepBufferDays: 0,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.alertEvaluations).all()).toHaveLength(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.alerts).all().filter((alert) => alert.status === 'open')).toHaveLength(4);
    expect(secondRun.summaries[0].rootCauseCodes).toEqual([
      'current_oos',
      'reorder_needed',
      'replenishment_at_risk',
      'no_supplier_order_placed',
      'pipeline_only_inventory',
      'slow_sales',
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.alerts).all().map((alert) => alert.actionRequired)).toContain(
      'Restore sellable Amazon stock immediately or confirm an active recovery order.',
    );
  });

  it('resolves open alerts when stock and deterministic conditions clear', async () => {
    const db = new MemoryDatabase();
    const product = await seedPlanningProduct(db);
    await seedPlanningRows(db, product, { stock: 0, salesVelocity: 5, recommendedReorderQuantity: 30 });
    const service = new EcobaseAlertEvaluationService(db);
    await service.evaluatePlanningProducts({ planningProductId: String(product.id), calculationDate: '2025-07-10' });

    await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
      values: {
        naturalKey: 'inventory:resolved:2025-07-11',
        sourceConnectionId: 'source-1',
        planningProductId: product.id,
        snapshotDate: '2025-07-11',
        company: product.company,
        asin: product.canonicalAsin,
        stock: 300,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: 10,
        recommendedReorderQuantity: 20,
      },
    });
    await service.evaluatePlanningProducts({ planningProductId: String(product.id), calculationDate: '2025-07-11' });

    expect(db.getRepository(ECOBASE_COLLECTIONS.alerts).all().every((alert) => alert.status === 'resolved')).toBe(true);
  });

  it('distinguishes already-ordered recovery states without double-counting raw pipeline inventory', async () => {
    const beforeDb = new MemoryDatabase();
    const beforeProduct = await seedPlanningProduct(beforeDb, { id: 'before-product', asin: 'B010BEFORE' });
    await seedPlanningRows(beforeDb, beforeProduct, { stock: 3, salesVelocity: 1, recommendedReorderQuantity: 30 });
    await seedOrderCoverage(beforeDb, beforeProduct, { lineId: 'before-line', expectedSellableDate: '2025-07-12', contactedAt: '2025-07-09T00:00:00.000Z' });
    const beforeRun = await new EcobaseAlertEvaluationService(beforeDb).evaluatePlanningProducts({ planningProductId: String(beforeProduct.id), calculationDate: '2025-07-10' });
    expect(beforeRun.summaries[0].rootCauseCodes).not.toContain('no_supplier_order_placed');
    expect(beforeRun.summaries[0].rootCauseCodes).not.toContain('already_ordered_expected_sellable_late');

    const lateDb = new MemoryDatabase();
    const lateProduct = await seedPlanningProduct(lateDb, { id: 'late-product', asin: 'B010LATE' });
    await seedPlanningRows(lateDb, lateProduct, { stock: 3, inbound: 50, salesVelocity: 10, recommendedReorderQuantity: 30 });
    await seedOrderCoverage(lateDb, lateProduct, { lineId: 'late-line', expectedSellableDate: '2025-07-25', contactedAt: '2025-07-01T00:00:00.000Z' });
    const lateRun = await new EcobaseAlertEvaluationService(lateDb).evaluatePlanningProducts({ planningProductId: String(lateProduct.id), calculationDate: '2025-07-10' });
    expect(lateRun.summaries[0].rootCauseCodes).toContain('already_ordered_expected_sellable_late');
    expect(lateRun.summaries[0].rootCauseCodes).toContain('near_oos_delayed_inbound_or_supplier_order');
    expect(lateRun.summaries[0].rootCauseCodes).toContain('supplier_not_recently_contacted');
    expect(Number(lateRun.summaries[0].openAlerts.find((alert: Record<string, unknown>) => alert.alertType === 'supplier_delay')?.evidence.estimatedProfitRisk)).toBeGreaterThan(0);

    const blockedDb = new MemoryDatabase();
    const blockedProduct = await seedPlanningProduct(blockedDb, { id: 'blocked-product', asin: 'B010BLOCK' });
    await seedPlanningRows(blockedDb, blockedProduct, { stock: 0, salesVelocity: 2, recommendedReorderQuantity: 20 });
    await seedOrderCoverage(blockedDb, blockedProduct, { lineId: 'blocked-line', status: 'blocked', expectedSellableDate: '2025-07-12' });
    const blockedRun = await new EcobaseAlertEvaluationService(blockedDb).evaluatePlanningProducts({ planningProductId: String(blockedProduct.id), calculationDate: '2025-07-10' });
    expect(blockedRun.summaries[0].rootCauseCodes).toContain('blocked_unreliable_open_order');

    const incompleteDb = new MemoryDatabase();
    const incompleteProduct = await seedPlanningProduct(incompleteDb, { id: 'incomplete-product', asin: 'B010MISS' });
    await seedPlanningRows(incompleteDb, incompleteProduct, { stock: 0, salesVelocity: 2, recommendedReorderQuantity: 20 });
    await seedOrderCoverage(incompleteDb, incompleteProduct, { lineId: 'incomplete-line' });
    const incompleteRun = await new EcobaseAlertEvaluationService(incompleteDb).evaluatePlanningProducts({ planningProductId: String(incompleteProduct.id), calculationDate: '2025-07-10' });
    expect(incompleteRun.summaries[0].rootCauseCodes).toContain('supplier_order_missing_update');
    expect(incompleteRun.summaries[0].rootCauseCodes).toContain('data_warning');
  });

  it('emits profit, Buy Box, refund, velocity, stale lead-time, and manual-review root causes from deterministic facts', async () => {
    const db = new MemoryDatabase();
    const product = await seedPlanningProduct(db, { id: 'profit-product', asin: 'B010PROFIT' });
    await seedPlanningRows(db, product, {
      stock: 200,
      salesVelocity: 1,
      units: 1,
      buyBoxPercentage: 65,
      margin: 10,
      refundRate: 12,
      profitPerUnit: -1,
      recommendedBestQty: 50,
      baselineVelocity: 10,
      profitTarget: 1000,
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).create({
      values: {
        naturalKey: 'supplier-lead-time:stale',
        sourceConnectionId: 'source-1',
        supplierId: 'supplier-1',
        company: product.company,
        leadTimeDays: 10,
        confirmedAt: '2025-05-01T00:00:00.000Z',
      },
    });
    const run = await new EcobaseAlertEvaluationService(db).evaluatePlanningProducts({ planningProductId: String(product.id), calculationDate: '2025-07-10' });

    expect(run.summaries[0].rootCauseCodes).toContain('low_buy_box');
    expect(run.summaries[0].rootCauseCodes).toContain('price_margin_issue');
    expect(run.summaries[0].rootCauseCodes).toContain('high_refund_rate');
    expect(run.summaries[0].rootCauseCodes).toContain('slow_sales');
    expect(run.summaries[0].rootCauseCodes).toContain('stale_lead_time');

    const manualDb = new MemoryDatabase();
    const manualProduct = await seedPlanningProduct(manualDb, { id: 'manual-product', asin: 'B010MANUAL' });
    await new EcobaseAlertEvaluationService(manualDb).evaluatePlanningProducts({ planningProductId: String(manualProduct.id), calculationDate: '2025-07-10' });
    expect(manualDb.getRepository(ECOBASE_COLLECTIONS.alertEvaluations).all()[0].rootCauses).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unknown_manual_review' })]),
    );
  });
});
