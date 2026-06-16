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
      { id: 'product-high', asin: 'B000HIGH', sku: 'HIGH-SKU', profitPerUnit: 50, bestQty: 20, stock: 0, salesVelocity: 3, orderId: 'order-high', orderRef: 'PO-HIGH', qty: 10, unitCost: 10 },
      { id: 'product-low', asin: 'B000LOW', sku: 'LOW-SKU', profitPerUnit: 10, bestQty: 10, stock: 0, salesVelocity: 2, orderId: 'order-low', orderRef: 'PO-LOW', qty: 10, unitCost: 10 },
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
    expect(result.skipped.some((candidate: Record<string, unknown>) => candidate.supplierOrderRef === 'PO-LOW')).toBe(true);
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
    await expect(new EcobaseInventoryPlanningService(new MemoryDatabase()).optimizeBudget({ budget: 0 })).rejects.toThrow(
      'Ecobase budget optimizer requires a budget greater than zero.',
    );
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
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
      naturalKey: 'line-history',
      supplierOrderId: 'order-history',
      company: 'Ecofission LLC',
      supplierId: 'supplier-ref-history',
      planningProductId: 'planning-product-history',
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
      payload: { 'Profit forecast (30 days)': 208.89, 'FBA prep. stock Prep center 1 stock': 5, 'MTD Revenue ': 1200, 'MTD Unit Sold': 24, 'MTD Profit ': 180 },
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

  it('materializes inventory planning rows for NocoBase editable collection blocks', async () => {
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

    const materializedRows = db.getRepository(ECOBASE_COLLECTIONS.inventoryPlanningRows).all();
    expect(result).toMatchObject({ calculationDate: '2026-06-07', rowCount: 1, created: 1, updated: 0 });
    expect(materializedRows[0]).toMatchObject({
      naturalKey: '2026-06-07:Ecofission LLC:planning-product-1',
      company: 'Ecofission LLC',
      asin: 'B000EDITABLE',
      supplierName: 'Editable Supplier',
      calculationDate: '2026-06-07',
    });
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

    const digest = await new EcobaseInventoryPlanningService(db).digestPreview({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(digest.summary).toMatchObject({ orderToday: 1, atRisk: 1, suppliersToContact: 1 });
    expect(digest.sections.orderNow).toHaveLength(1);
    expect(digest.sections.suppliersToContactFirst[0]).toMatchObject({ supplierName: 'Digest Supplier', urgentCount: 1 });
  });

  it('puts no-order digest rows before placed-but-not-purchased rows and excludes purchased pipeline rows', async () => {
    const db = new MemoryDatabase();
    for (const id of ['no-order', 'payment-pending', 'approval-soon', 'paid-pipeline']) {
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

    const digest = await new EcobaseInventoryPlanningService(db).digestPreview({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(digest.summary).toMatchObject({ noSupplierOrder: 1, placedNotPurchased: 2, purchasedPipelineExcluded: 1 });
    expect(digest.sections.orderNow.map((row) => row.planningProductId)).toEqual(['no-order', 'payment-pending', 'approval-soon']);
    expect(digest.sections.orderNow[0]).toMatchObject({ supplierOrderState: 'no_open_order' });
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
  });
});
