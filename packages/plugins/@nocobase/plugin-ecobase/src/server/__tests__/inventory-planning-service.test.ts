import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseInventoryPlanningService } from '../services/inventory-planning-service';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';

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

describe('EcobaseInventoryPlanningService', () => {
  it('selects highest-profit approval candidates under an explicit budget', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.suppliers, {
      id: 'supplier-a',
      naturalKey: 'supplier-a',
      company: 'Ecofission LLC',
      name: 'Profit Supplier',
      active: true,
    });
    for (const product of [
      {
        id: 'product-high',
        asin: 'B000HIGH',
        sku: 'HIGH-SKU',
        profitPerUnit: 50,
        bestQty: 20,
        stock: 0,
        salesVelocity: 3,
        orderId: 'order-high',
        orderRef: 'PO-HIGH',
        qty: 10,
        unitCost: 10,
      },
      {
        id: 'product-low',
        asin: 'B000LOW',
        sku: 'LOW-SKU',
        profitPerUnit: 10,
        bestQty: 10,
        stock: 0,
        salesVelocity: 2,
        orderId: 'order-low',
        orderRef: 'PO-LOW',
        qty: 10,
        unitCost: 10,
      },
    ]) {
      await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
        id: product.id,
        naturalKey: `Ecofission LLC:${product.asin}`,
        company: 'Ecofission LLC',
        canonicalAsin: product.asin,
        title: product.sku,
        mappingStatus: 'confirmed',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
        naturalKey: `inventory-${product.id}`,
        sourceConnectionId: 'source-1',
        planningProductId: product.id,
        snapshotDate: '2026-06-09',
        company: 'Ecofission LLC',
        asin: product.asin,
        sku: product.sku,
        stock: product.stock,
        salesVelocity: product.salesVelocity,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
        naturalKey: `params-${product.id}`,
        sourceConnectionId: 'source-1',
        planningProductId: product.id,
        company: 'Ecofission LLC',
        asin: product.asin,
        sku: product.sku,
        supplier: 'Profit Supplier',
        supplierId: 'SRO-A',
        profitPerUnit: product.profitPerUnit,
        leadTimeDays: 1,
        payload: { recommendedBestQty: product.bestQty, productStatus: 'Active' },
      });
      await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
        id: product.orderId,
        naturalKey: `supplier-order:Ecofission LLC:${product.orderRef}`,
        company: 'Ecofission LLC',
        supplierId: 'supplier-a',
        externalOrderRef: product.orderRef,
        status: 'approval_pending',
        sourceStage: 'order_detail',
        lastMeaningfulUpdateAt: '2026-06-09T00:00:00.000Z',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
        id: `line-${product.id}`,
        naturalKey: `supplier-order-line:${product.orderRef}:1`,
        supplierOrderId: product.orderId,
        company: 'Ecofission LLC',
        supplierId: 'supplier-a',
        planningProductId: product.id,
        asin: product.asin,
        sku: product.sku,
        orderedQty: product.qty,
        receivedQty: 0,
        unitCost: product.unitCost,
        sourceOrderLineRef: `${product.orderRef}:1`,
        sourceStage: 'order_detail',
        observedAt: '2026-06-09T00:00:00.000Z',
      });
    }

    const result = await new EcobaseInventoryPlanningService(db).optimizeBudget({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-09',
      budget: 100,
    });

    expect(result).toMatchObject({
      mode: 'budget_optimizer',
      budget: 100,
      selectedSpend: 100,
      remainingBudget: 0,
      selectedCount: 1,
    });
    expect(result.recommendations[0]).toMatchObject({
      candidateType: 'supplier_order',
      supplierOrderRef: 'PO-HIGH',
      recommendedAction: 'approve',
      spend: 100,
    });
    expect(result.skipped.some((candidate: Record<string, unknown>) => candidate.supplierOrderRef === 'PO-LOW')).toBe(
      true,
    );
  });

  it('shows missing-cost candidates as skipped instead of selecting them silently', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'product-no-cost',
      naturalKey: 'Ecofission LLC:B000NOCOST',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000NOCOST',
      title: 'No cost product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-no-cost',
      sourceConnectionId: 'source-1',
      planningProductId: 'product-no-cost',
      snapshotDate: '2026-06-09',
      company: 'Ecofission LLC',
      asin: 'B000NOCOST',
      sku: 'NO-COST',
      stock: 0,
      salesVelocity: 2,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-no-cost',
      sourceConnectionId: 'source-1',
      planningProductId: 'product-no-cost',
      company: 'Ecofission LLC',
      asin: 'B000NOCOST',
      sku: 'NO-COST',
      profitPerUnit: 25,
      leadTimeDays: 1,
      payload: { recommendedBestQty: 10, productStatus: 'Active' },
    });

    const result = await new EcobaseInventoryPlanningService(db).optimizeBudget({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-09',
      budget: 100,
    });

    expect(result.selectedCount).toBe(0);
    expect(result.skipped[0]).toMatchObject({
      candidateType: 'planning_product',
      skipReason: 'missing_unit_cost',
      reasonCodes: expect.arrayContaining(['missing_unit_cost']),
    });
  });

  it('requires a positive optimizer budget', async () => {
    await expect(
      new EcobaseInventoryPlanningService(new MemoryDatabase()).optimizeBudget({ budget: 0 }),
    ).rejects.toThrow('Ecobase budget optimizer requires a budget greater than zero.');
  });

  it('prioritizes order-today tier rows with supplier, lead-time freshness, stock buckets, and velocity-based reorder quantity', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-1',
      naturalKey: 'Ecofission LLC:B000RISK',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000RISK',
      title: 'Tier A risk product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-1',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-1',
      snapshotDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000RISK',
      sku: 'RISK-SKU',
      stock: 21,
      reserved: 2,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 3,
      payload: { 'AWD Stock': 0 },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-1',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-1',
      company: 'Ecofission LLC',
      asin: 'B000RISK',
      sku: 'RISK-SKU',
      supplier: 'Fresh Supplier',
      supplierId: 'supplier-code-1',
      profitPerUnit: 10,
      leadTimeDays: 0,
      safetyBufferDays: 7,
      payload: { recommendedBestQty: 30, productStatus: 'Active' },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.suppliers, {
      id: 'supplier-ref-1',
      naturalKey: 'Ecofission LLC:Fresh Supplier',
      sourceConnectionId: 'source-1',
      supplierId: 'supplier-code-1',
      name: 'Fresh Supplier',
      company: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierProductLinks, {
      naturalKey: 'link-1',
      company: 'Ecofission LLC',
      planningProductId: 'planning-product-1',
      supplierId: 'supplier-ref-1',
      role: 'latest_history',
      source: 'order_details',
      confidence: 'high',
      latestBrand: 'Risk Brand',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierLeadTimes, {
      naturalKey: 'leadtime-1',
      sourceConnectionId: 'source-1',
      supplierId: 'supplier-code-1',
      supplierRefId: 'supplier-ref-1',
      supplierName: 'Fresh Supplier',
      company: 'Ecofission LLC',
      leadTimeDays: 0,
      confirmedAt: '2026-05-20T00:00:00.000Z',
      source: 'backend_sheet',
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
      reorderCycleDays: 30,
    });

    expect(row).toMatchObject({
      planningProductId: 'planning-product-1',
      tier: 'A',
      tierScore: 300,
      actionStatus: 'order_today',
      supplierName: 'Fresh Supplier',
      supplierSource: 'order_details',
      leadTimeFreshness: 'fresh',
      currentPlanningStock: 23,
      stuck: true,
      suggestedReorderQty: 88,
    });
  });

  it('uses OrderDetails history to recover supplier and lead time when planning rows have no supplier mapping', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-history',
      naturalKey: 'Ecofission LLC:B000HISTORY',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000HISTORY',
      title: 'OrderDetails supplier product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-history',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-history',
      snapshotDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000HISTORY',
      sku: 'HISTORY-SKU',
      stock: 10,
      reserved: 0,
      salesVelocity: 2,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-history',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-history',
      company: 'Ecofission LLC',
      asin: 'B000HISTORY',
      sku: 'HISTORY-SKU',
      profitPerUnit: 20,
      payload: { recommendedBestQty: 20 },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.suppliers, {
      id: 'supplier-ref-history',
      naturalKey: 'Ecofission LLC:History Supplier',
      sourceConnectionId: 'source-1',
      supplierId: 'SRO-HISTORY',
      name: 'History Supplier',
      company: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierLeadTimes, {
      naturalKey: 'leadtime-history',
      sourceConnectionId: 'source-1',
      supplierId: 'SRO-HISTORY',
      supplierRefId: 'supplier-ref-history',
      supplierName: 'History Supplier',
      company: 'Ecofission LLC',
      leadTimeDays: 4,
      confirmedAt: '2026-06-01T00:00:00.000Z',
      source: 'order_details',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
      id: 'order-history',
      naturalKey: 'supplier-order:Ecofission LLC:OD-HISTORY',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-ref-history',
      externalOrderRef: 'OD-HISTORY',
      sourceStage: 'order_details',
      status: 'received',
      lastMeaningfulUpdateAt: '2026-05-20T00:00:00.000Z',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
      naturalKey: 'line-history',
      supplierOrderId: 'order-history',
      company: 'Ecofission LLC',
      supplierId: 'supplier-ref-history',
      asin: 'B000HISTORY',
      sku: 'HISTORY-SKU',
      orderedQty: 10,
      receivedQty: 10,
      observedAt: '2026-05-20T00:00:00.000Z',
      sourceOrderLineRef: 'OD-HISTORY:1',
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(row).toMatchObject({
      supplierName: 'History Supplier',
      supplierSource: 'order_details_history',
      leadTimeDays: 4,
      leadTimeFreshness: 'fresh',
      latestSafeReorderDate: '2026-06-01',
      actionStatus: 'overdue',
      supplierOrderState: 'closed_history',
      supplierOrderRef: 'OD-HISTORY',
      supplierOrderOpenQty: 0,
    });
  });

  it('uses product-scoped supplier lead time rows even when they only match by supplier name and ASIN', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-masterstock',
      naturalKey: 'Muxtex INC:B003WH3SIE',
      company: 'Muxtex INC',
      canonicalAsin: 'B003WH3SIE',
      title: 'Black Patina',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-masterstock',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-masterstock',
      snapshotDate: '2026-06-07',
      company: 'Muxtex INC',
      asin: 'B003WH3SIE',
      sku: 'Black Patina 8 Oz',
      stock: 10,
      reserved: 0,
      salesVelocity: 2,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-masterstock',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-masterstock',
      company: 'Muxtex INC',
      supplier: 'edhoy',
      profitPerUnit: 20,
      payload: { recommendedBestQty: 20 },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierLeadTimes, {
      naturalKey: 'leadtime-masterstock',
      sourceConnectionId: 'source-1',
      supplierName: 'edhoy',
      company: 'Muxtex INC',
      asin: 'B003WH3SIE',
      sku: 'Black Patina 8 Oz',
      scope: 'product',
      leadTimeDays: 24,
      confirmedAt: '2026-06-01T00:00:00.000Z',
      source: 'masterstock-july2025-lead-time',
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Muxtex INC',
      calculationDate: '2026-06-07',
    });

    expect(row).toMatchObject({
      supplierName: 'edhoy',
      leadTimeDays: 24,
      leadTimeFreshness: 'fresh',
    });
  });

  it('derives missing lead time from past order expected sellable dates', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-derived-history',
      naturalKey: 'Muxtex INC:B0CHPW5VC6',
      company: 'Muxtex INC',
      canonicalAsin: 'B0CHPW5VC6',
      title: 'Derived history product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-derived-history',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-derived-history',
      snapshotDate: '2026-06-07',
      company: 'Muxtex INC',
      asin: 'B0CHPW5VC6',
      sku: '2823018110',
      stock: 10,
      reserved: 0,
      salesVelocity: 2,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-derived-history',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-derived-history',
      company: 'Muxtex INC',
      supplier: 'Franklin Electric',
      profitPerUnit: 20,
      payload: { recommendedBestQty: 20 },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
      id: 'order-derived-history',
      naturalKey: 'supplier-order:Muxtex INC:MX32426C',
      sourceConnectionId: 'source-1',
      company: 'Muxtex INC',
      supplierId: 'supplier-ref-derived-history',
      externalOrderRef: 'MX32426C',
      sourceStage: 'order_details',
      status: 'received',
      orderDate: '2026-03-24',
      lastMeaningfulUpdateAt: '2026-03-24T00:00:00.000Z',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
      naturalKey: 'line-derived-history',
      supplierOrderId: 'order-derived-history',
      company: 'Muxtex INC',
      supplierId: 'supplier-ref-derived-history',
      planningProductId: 'planning-product-derived-history',
      asin: 'B0CHPW5VC6',
      sku: '2823018110',
      orderedQty: 10,
      receivedQty: 10,
      expectedSellableDate: '2026-04-17',
      observedAt: '2026-03-24T00:00:00.000Z',
      sourceOrderLineRef: 'MX32426C:B0CHPW5VC6:2823018110',
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Muxtex INC',
      calculationDate: '2026-06-07',
    });

    expect(row).toMatchObject({
      leadTimeDays: 24,
      leadTimeFreshness: 'stale',
    });
  });

  it('excludes BackendSheet hold/not-selling style statuses from the primary planning queue', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-hold',
      naturalKey: 'Ecofission LLC:B000HOLD',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000HOLD',
      title: 'Hold product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-hold',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-hold',
      snapshotDate: '2026-06-07',
      company: 'Ecofission LLC',
      stock: 1,
      reserved: 0,
      salesVelocity: 1,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-hold',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-hold',
      company: 'Ecofission LLC',
      supplier: 'Hold Supplier',
      profitPerUnit: 10,
      leadTimeDays: 1,
      payload: { recommendedBestQty: 30, 'Product Status': 'Hold' },
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(row).toMatchObject({
      productStatus: 'Hold',
      planningExcluded: true,
      actionStatus: 'excluded',
    });
  });

  it('derives fallback row company from the source connection company and classifies every tier', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-ecofission',
      name: 'Smoke CSV Source 1',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-fallback',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-07',
      asin: 'B000FALLBACK',
      sku: 'FALLBACK-SKU',
      stock: 10,
      reserved: 1,
      salesVelocity: 2,
      recommendedReorderQuantity: 50,
      payload: {
        'Profit forecast (30 days)': 208.89,
        'FBA prep. stock Prep center 1 stock': 5,
        'MTD Revenue ': 1200,
        'MTD Unit Sold': 24,
        'MTD Profit ': 180,
      },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-fallback',
      sourceConnectionId: 'source-ecofission',
      asin: 'B000FALLBACK',
      sku: 'FALLBACK-SKU',
      leadTimeDays: 3,
      profitPerUnit: 4,
      payload: { 'Product Status': 'Active' },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
      id: 'fallback-order-1',
      naturalKey: 'supplier-order:Ecofission LLC:FB-100',
      sourceConnectionId: 'source-ecofission',
      company: 'Ecofission LLC',
      supplierId: 'supplier-ref-1',
      externalOrderRef: 'FB-100',
      sourceStage: 'manual',
      status: 'shipped_inbound',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
      id: 'fallback-line-1',
      naturalKey: 'supplier-order-line:FB-100:1',
      sourceConnectionId: 'source-ecofission',
      company: 'Ecofission LLC',
      supplierOrderId: 'fallback-order-1',
      asin: 'B000FALLBACK',
      sku: 'FALLBACK-SKU',
      orderedQty: 20,
      receivedQty: 5,
    });

    const service = new EcobaseInventoryPlanningService(db);
    const filters = await service.filterOptions();
    const [row] = await service.listRows({ company: 'Ecofission LLC', calculationDate: '2026-06-07' });

    expect(filters.companies).toContain('Ecofission LLC');
    expect(filters.companies).not.toContain('Smoke CSV Source 1');
    expect(row).toMatchObject({
      company: 'Ecofission LLC',
      tier: 'B',
      tierScore: 200,
      currentPlanningStock: 16,
      pipelineStock: 5,
      openOrderCoverageQty: 15,
      monthToDateRevenue: 1200,
      monthToDateUnitsSold: 24,
      monthToDateProfit: 180,
    });
  });

  it('ignores inactive source-connection records in fallback planning', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-active',
      name: 'Active Sellerboard',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-inactive',
      name: 'Inactive Smoke Source',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
      active: false,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-active-source',
      sourceConnectionId: 'source-active',
      snapshotDate: '2026-06-26',
      asin: 'B000ACTIVE',
      sku: 'ACTIVE-SKU',
      stock: 10,
      salesVelocity: 1,
      recommendedReorderQuantity: 10,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-inactive-source',
      sourceConnectionId: 'source-inactive',
      snapshotDate: '2026-06-26',
      asin: 'B000INACTIVE',
      sku: 'INACTIVE-SKU',
      stock: 10,
      salesVelocity: 1,
      recommendedReorderQuantity: 10,
    });

    const rows = await new EcobaseInventoryPlanningService(db).listRows({ calculationDate: '2026-06-26' });

    expect(rows.map((row) => row.asin)).toEqual(['B000ACTIVE']);
  });

  it('ignores invalid fallback snapshot dates instead of treating source versions as newest stock', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-active',
      name: 'Active Sellerboard',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
      active: true,
    });
    for (let index = 0; index < 5; index += 1) {
      await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
        naturalKey: `inventory-invalid-source-version-date-${index}`,
        sourceConnectionId: 'source-active',
        snapshotDate: `qa-sellerboard-20260622T23195${index}Z`,
        asin: `B000INVALID${index}`,
        sku: `INVALID-SKU-${index}`,
        stock: 10,
        salesVelocity: 1,
        recommendedReorderQuantity: 10,
      });
    }
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-valid-date',
      sourceConnectionId: 'source-active',
      snapshotDate: '2026-06-26',
      asin: 'B000VALID',
      sku: 'VALID-SKU',
      stock: 10,
      salesVelocity: 1,
      recommendedReorderQuantity: 10,
    });

    const rows = await new EcobaseInventoryPlanningService(db).listRows({ calculationDate: '2026-06-26', limit: 1 });

    expect(rows.map((row) => row.asin)).toEqual(['B000VALID']);
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

  it('derives fallback profit and tier from Sellerboard daily facts', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-ecofission',
      name: 'Sellerboard - Ecofission LLC',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-sellerboard-profit',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-26',
      asin: 'B000SELLERBOARD',
      sku: 'SB-SKU',
      stock: 10,
      salesVelocity: 2,
      recommendedReorderQuantity: 50,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-sellerboard-profit',
      sourceConnectionId: 'source-ecofission',
      asin: 'B000SELLERBOARD',
      sku: 'SB-SKU',
      leadTimeDays: 3,
      payload: { 'Product Status': 'Active' },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.listingDailyFacts, {
      naturalKey: 'daily-fact-sellerboard-profit',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-20',
      asin: 'B000SELLERBOARD',
      sku: 'SB-SKU',
      sales: 240,
      units: 12,
      netProfit: 120,
      refunds: 1,
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-26',
    });

    expect(row).toMatchObject({
      profitPerUnit: 10,
      tier: 'A',
      tierScore: 500,
      monthToDateRevenue: 240,
      monthToDateUnitsSold: 12,
      monthToDateProfit: 120,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).findCalls).toContainEqual(
      expect.objectContaining({ limit: 100000 }),
    );
  });

  it('uses latest prior profit month when current month has no Sellerboard facts', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-ecofission',
      name: 'Sellerboard - Ecofission LLC',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-sellerboard-month-boundary',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-07-01',
      asin: 'B000MONTHBOUNDARY',
      sku: 'MB-SKU',
      stock: 10,
      salesVelocity: 2,
      recommendedReorderQuantity: 50,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-sellerboard-month-boundary',
      sourceConnectionId: 'source-ecofission',
      asin: 'B000MONTHBOUNDARY',
      sku: 'MB-SKU',
      leadTimeDays: 3,
      payload: { 'Product Status': 'Active' },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.listingDailyFacts, {
      naturalKey: 'daily-fact-sellerboard-month-boundary',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-29',
      asin: 'B000MONTHBOUNDARY',
      sku: 'MB-SKU',
      sales: 240,
      units: 12,
      netProfit: 120,
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-07-01',
    });

    expect(row).toMatchObject({
      profitPerUnit: 10,
      tier: 'A',
      tierScore: 500,
      monthToDateRevenue: 240,
      monthToDateUnitsSold: 12,
      monthToDateProfit: 120,
    });
  });

  it('does not assign tier C when Sellerboard profit score is missing or zero', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-ecofission',
      name: 'Sellerboard - Ecofission LLC',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-zero-profit',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-26',
      asin: 'B000ZEROPROFIT',
      sku: 'ZERO-SKU',
      stock: 10,
      salesVelocity: 2,
      recommendedReorderQuantity: 50,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-zero-profit',
      sourceConnectionId: 'source-ecofission',
      asin: 'B000ZEROPROFIT',
      sku: 'ZERO-SKU',
      leadTimeDays: 3,
      payload: { 'Product Status': 'Active' },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.listingDailyFacts, {
      naturalKey: 'daily-fact-zero-profit',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-20',
      asin: 'B000ZEROPROFIT',
      sku: 'ZERO-SKU',
      sales: 120,
      units: 12,
      netProfit: 0,
    });

    const service = new EcobaseInventoryPlanningService(db);
    const [row] = await service.listRows({ company: 'Ecofission LLC', calculationDate: '2026-06-26' });

    expect(row.profitPerUnit).toBe(0);
    expect(row.tierScore).toBe(0);
    expect(row.tier).toBeUndefined();

    const naturalKey = '2026-06-26:Ecofission LLC:fallback:Ecofission LLC:B000ZEROPROFIT:ZERO-SKU';
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'stale-zero-profit-gold-row',
      naturalKey,
      calculationDate: '2026-06-26',
      actionStatus: 'watch',
      tier: 'C',
    });

    await service.refreshReadModel({ company: 'Ecofission LLC', calculationDate: '2026-06-26' });
    const refreshed = (await db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .findOne({ filter: { naturalKey } })) as Record<string, unknown>;
    expect(refreshed.tier).toBeNull();
    expect(refreshed.tierScore).toBe(0);
  });

  it('keeps untiered no-order products out of active money risk and digest', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-ecofission',
      name: 'Sellerboard - Ecofission LLC',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-untiered-risk',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-26',
      asin: 'B000UNTIERED',
      sku: 'NO-TIER-SKU',
      stock: 0,
      salesVelocity: 2,
      recommendedReorderQuantity: 0,
      payload: { 'Profit forecast (30 days)': 999 },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-untiered-risk',
      sourceConnectionId: 'source-ecofission',
      asin: 'B000UNTIERED',
      sku: 'NO-TIER-SKU',
      leadTimeDays: 3,
      payload: { 'Product Status': 'Active' },
    });

    const service = new EcobaseInventoryPlanningService(db);
    const [row] = await service.listRows({ company: 'Ecofission LLC', calculationDate: '2026-06-26' });
    const digest = await service.digestPreview({ company: 'Ecofission LLC', calculationDate: '2026-06-26' });

    expect(row).toMatchObject({ tier: undefined, estimatedProfitRisk: 0 });
    expect(row.estimatedProfitRiskBasis).toBe('not_tiered_profit_inputs_missing');
    expect(digest.summary).toMatchObject({ atRisk: 0, noSupplierOrder: 0, suppliersToContact: 0 });
    expect(digest.sections.orderNow).toEqual([]);
    expect(digest.sections.noOrderProducts).toEqual([]);
    expect(digest.sections.supplierActionItems).toEqual([]);
    expect(digest.sections.suppliersToContactFirst).toEqual([]);
  });

  it('tracks tier movement when imported profit changes', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-ecofission',
      name: 'Sellerboard - Ecofission LLC',
      companyId: 'company-ecofission',
      sourceType: 'sellerboard',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-tier-drop',
      sourceConnectionId: 'source-ecofission',
      snapshotDate: '2026-06-26',
      asin: 'B000TIERDROP',
      sku: 'TIER-DROP-SKU',
      stock: 10,
      salesVelocity: 2,
      recommendedReorderQuantity: 50,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-tier-drop',
      sourceConnectionId: 'source-ecofission',
      asin: 'B000TIERDROP',
      sku: 'TIER-DROP-SKU',
      leadTimeDays: 3,
      profitPerUnit: 4,
      payload: { 'Product Status': 'Active' },
    });
    const planningProductId = 'fallback:Ecofission LLC:B000TIERDROP:TIER-DROP-SKU';
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'previous-tier-row',
      naturalKey: `2026-06-25:Ecofission LLC:${planningProductId}`,
      planningProductId,
      calculationDate: '2026-06-25',
      company: 'Ecofission LLC',
      tier: 'A',
    });

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-26',
    });
    const current = await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).findOne({
      filter: { naturalKey: `2026-06-26:Ecofission LLC:${planningProductId}` },
    });

    expect(current).toMatchObject({ tier: 'B', previousTier: 'A', tierMovement: 'down' });
  });

  it('does not expose unassigned source connection names as company filter options', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.companies, {
      id: 'company-ecofission',
      name: 'Ecofission LLC',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-ecofission',
      name: 'Smoke CSV Source 2',
      companyId: 'company-ecofission',
      sourceType: 'google_sheets',
      domain: 'order_management',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-all-companies-order-management',
      name: 'All Companies Order Management Smoke',
      sourceType: 'google_sheets',
      domain: 'order_management',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'source-order-management-qa',
      name: 'Order Management Google Sheets QA',
      sourceType: 'google_sheets',
      domain: 'order_management',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-unscoped-source',
      sourceConnectionId: 'source-all-companies-order-management',
      snapshotDate: '2026-06-07',
      asin: 'B000UNSCOPED',
      sku: 'UNSCOPED-SKU',
      stock: 3,
      salesVelocity: 1,
    });

    const service = new EcobaseInventoryPlanningService(db);
    const filters = await service.filterOptions();
    const rows = await service.listRows({ calculationDate: '2026-06-07' });

    expect(filters.companies).toEqual(['Ecofission LLC']);
    expect(rows).toEqual([]);
  });

  it('materializes inventory planning rows into the gold layer', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-1',
      naturalKey: 'product-1',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000EDITABLE',
      title: 'Editable block product',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-1',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-1',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000EDITABLE',
      snapshotDate: '2026-06-07',
      stock: 2,
      fbaAvailable: 2,
      reserved: 0,
      salesVelocity: 1,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-1',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-1',
      company: 'Ecofission LLC',
      supplier: 'Editable Supplier',
      profitPerUnit: 15,
      leadTimeDays: 5,
      payload: { recommendedBestQty: 25 },
    });

    const result = await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    const materializedRows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(result).toMatchObject({ calculationDate: '2026-06-07', rowCount: 1, created: 1, updated: 0 });
    expect(materializedRows[0]).toMatchObject({
      naturalKey: '2026-06-07:Ecofission LLC:planning-product-1',
      company: 'Ecofission LLC',
      asin: 'B000EDITABLE',
      supplierName: 'Editable Supplier',
      calculationDate: '2026-06-07',
    });
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

  it('keeps the daily digest bounded to order-now risk and supplier contact priorities', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-1',
      naturalKey: 'Ecofission LLC:B000RISK',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000RISK',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-1',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-1',
      snapshotDate: '2026-06-07',
      company: 'Ecofission LLC',
      stock: 21,
      reserved: 0,
      salesVelocity: 3,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-1',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-1',
      company: 'Ecofission LLC',
      supplier: 'Digest Supplier',
      profitPerUnit: 10,
      leadTimeDays: 0,
      payload: { recommendedBestQty: 30 },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierLeadTimes, {
      naturalKey: 'leadtime-1',
      sourceConnectionId: 'source-1',
      supplierName: 'Digest Supplier',
      company: 'Ecofission LLC',
      leadTimeDays: 0,
      confirmedAt: '2026-06-01T00:00:00.000Z',
      source: 'backend_sheet',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderActivities, {
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
    for (const id of ['no-order', 'payment-pending', 'approval-soon', 'paid-pipeline', 'paid-evidence']) {
      await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
        id,
        naturalKey: `Ecofission LLC:${id}`,
        company: 'Ecofission LLC',
        canonicalAsin: `ASIN-${id}`,
        mappingStatus: 'confirmed',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
        naturalKey: `inventory-${id}`,
        sourceConnectionId: 'source-1',
        planningProductId: id,
        snapshotDate: '2026-06-07',
        company: 'Ecofission LLC',
        asin: `ASIN-${id}`,
        sku: `SKU-${id}`,
        stock: id === 'approval-soon' ? 30 : 1,
        reserved: 0,
        salesVelocity: 3,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
        naturalKey: `params-${id}`,
        sourceConnectionId: 'source-1',
        planningProductId: id,
        company: 'Ecofission LLC',
        supplier: 'Digest Supplier',
        profitPerUnit: 10,
        leadTimeDays: 0,
        payload: { recommendedBestQty: 30 },
      });
      await createRecord(db, ECOBASE_COLLECTIONS.supplierLeadTimes, {
        naturalKey: `leadtime-${id}`,
        sourceConnectionId: 'source-1',
        supplierName: 'Digest Supplier',
        company: 'Ecofission LLC',
        leadTimeDays: 0,
        confirmedAt: '2026-06-01T00:00:00.000Z',
        source: 'backend_sheet',
      });
    }

    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
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
    expect(digest.sections.supplierActionItems).toEqual([]);
    expect(digest.sections.suppliersToContactFirst).toEqual([]);
  });
});
