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
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
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
    const supplier = db
      .getRepository(ECOBASE_COLLECTIONS.suppliers)
      .all()
      .find((record) => record.id === values.supplierId);
    await upsertRecord(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: values.supplierId,
      companyId,
      displayName: values.supplierName ?? supplier?.name,
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
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, { id: companyProductId, companyId, productId });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
    id: supplierProductId,
    supplierId: values.supplierId,
    productId,
    supplierSku: sku,
    unitCost: values.unitCost,
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
      await createSilverOrderRecord(db, {
        id: product.orderId,
        naturalKey: `supplier-order:Ecofission LLC:${product.orderRef}`,
        company: 'Ecofission LLC',
        supplierId: 'supplier-a',
        externalOrderRef: product.orderRef,
        status: 'approval_pending',
        sourceStage: 'order_detail',
        lastMeaningfulUpdateAt: '2026-06-09T00:00:00.000Z',
      });
      await createSilverOrderLineRecord(db, {
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
      targetCoverDays: 30,
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
      stuck: false,
      suggestedReorderQty: 67,
    });
  });

  it('prefers Sellerboard stock snapshots over manual CSV inventory buckets', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'manual-source',
      name: 'Manual Amazon Operations CSV',
      sourceType: 'seller_central_file',
      domain: 'amazon_operations',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sourceConnections, {
      id: 'sellerboard-source',
      name: 'Sellerboard Stock Daily',
      sourceType: 'sellerboard',
      domain: 'amazon_operations',
      active: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-sellerboard-stock',
      naturalKey: 'Ecofission LLC:B000SELLERBOARD',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000SELLERBOARD',
      title: 'Sellerboard stock product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'manual-inventory-sellerboard-stock',
      sourceConnectionId: 'manual-source',
      planningProductId: 'planning-product-sellerboard-stock',
      snapshotDate: '2026-06-10',
      company: 'Ecofission LLC',
      asin: 'B000SELLERBOARD',
      sku: 'SB-SKU',
      stock: 999,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 99,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'sellerboard-inventory-sellerboard-stock',
      sourceConnectionId: 'sellerboard-source',
      planningProductId: 'planning-product-sellerboard-stock',
      snapshotDate: '2026-06-09',
      company: 'Ecofission LLC',
      asin: 'B000SELLERBOARD',
      sku: 'SB-SKU',
      stock: 12,
      reserved: 3,
      inbound: 4,
      ordered: 5,
      prepStock: 6,
      salesVelocity: 2,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-sellerboard-stock',
      sourceConnectionId: 'manual-source',
      planningProductId: 'planning-product-sellerboard-stock',
      company: 'Ecofission LLC',
      asin: 'B000SELLERBOARD',
      sku: 'SB-SKU',
      supplier: 'Stock Supplier',
      supplierId: 'STOCK-SUPPLIER',
      leadTimeDays: 5,
      payload: { productStatus: 'Active' },
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-11',
    });

    expect(row).toMatchObject({
      planningProductId: 'planning-product-sellerboard-stock',
      sellableStock: 12,
      reservedStock: 3,
      inboundStock: 4,
      orderedStock: 5,
      prepStock: 6,
      currentPlanningStock: 30,
      salesVelocity: 2,
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
    await createSilverOrderRecord(db, {
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
    await createSilverOrderLineRecord(db, {
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
    await createSilverOrderRecord(db, {
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
    await createSilverOrderLineRecord(db, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createSilverOrderRecord(db, {
      id: 'fallback-order-1',
      naturalKey: 'supplier-order:Ecofission LLC:FB-100',
      sourceConnectionId: 'source-ecofission',
      company: 'Ecofission LLC',
      supplierId: 'supplier-ref-1',
      externalOrderRef: 'FB-100',
      sourceStage: 'manual',
      status: 'shipped_inbound',
    });
    await createSilverOrderLineRecord(db, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
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

  it('materializes expected sellable from the selected supplier order line', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-linked-order-date',
      naturalKey: 'Muxtex INC:B000LINKED',
      company: 'Muxtex INC',
      canonicalAsin: 'B000LINKED',
      title: 'Linked order date product',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-linked-order-date',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-linked-order-date',
      company: 'Muxtex INC',
      asin: 'B000LINKED',
      sku: 'SKU-LINKED',
      snapshotDate: '2026-07-07',
      stock: 1,
      reserved: 0,
      salesVelocity: 1,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-linked-order-date',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-linked-order-date',
      company: 'Muxtex INC',
      asin: 'B000LINKED',
      sku: 'SKU-LINKED',
      supplier: 'Discount Pond Supply',
      profitPerUnit: 10,
      leadTimeDays: 30,
      payload: { recommendedBestQty: 30 },
    });
    await createSilverOrderRecord(db, {
      id: 'old-order-linked-date',
      naturalKey: 'supplier-order:Muxtex INC:OLD-LINKED',
      sourceConnectionId: 'source-1',
      company: 'Muxtex INC',
      externalOrderRef: 'OLD-LINKED',
      status: 'completed',
      lastMeaningfulUpdateAt: '2025-11-01T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'old-line-linked-date',
      naturalKey: 'supplier-order-line:OLD-LINKED',
      sourceConnectionId: 'source-1',
      company: 'Muxtex INC',
      supplierOrderId: 'old-order-linked-date',
      asin: 'B000LINKED',
      sku: 'SKU-LINKED',
      orderedQty: 5,
      receivedQty: 5,
      expectedSellableDate: '2025-11-10',
    });
    await createSilverOrderRecord(db, {
      id: 'selected-order-linked-date',
      naturalKey: 'supplier-order:Muxtex INC:MX2626C',
      sourceConnectionId: 'source-1',
      company: 'Muxtex INC',
      externalOrderRef: 'MX2626C',
      status: 'approval_pending',
      lastMeaningfulUpdateAt: '2026-02-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'selected-line-linked-date',
      naturalKey: 'supplier-order-line:MX2626C',
      sourceConnectionId: 'source-1',
      company: 'Muxtex INC',
      supplierOrderId: 'selected-order-linked-date',
      asin: 'B000LINKED',
      sku: 'SKU-LINKED',
      orderedQty: 10,
      receivedQty: 0,
      expectedSellableDate: '2026-03-02',
    });

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company: 'Muxtex INC',
      calculationDate: '2026-07-07',
    });

    const materializedRows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(materializedRows[0]).toMatchObject({
      supplierOrderRef: 'MX2626C',
      supplierOrderState: 'placed_not_purchased',
      expectedSellableDate: '2026-03-02',
    });
  });

  it('does not link supplier orders by SKU when the order line belongs to a different ASIN', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-sku-cross-link',
      naturalKey: 'Muxtex INC:B000TARGET',
      company: 'Muxtex INC',
      canonicalAsin: 'B000TARGET',
      title: 'SKU cross-link product',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-sku-cross-link',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-sku-cross-link',
      company: 'Muxtex INC',
      asin: 'B000TARGET',
      sku: 'SHARED-SKU',
      snapshotDate: '2026-07-07',
      stock: 1,
      reserved: 0,
      salesVelocity: 1,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-sku-cross-link',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-sku-cross-link',
      company: 'Muxtex INC',
      asin: 'B000TARGET',
      sku: 'SHARED-SKU',
      supplier: 'Supplier',
      profitPerUnit: 10,
      leadTimeDays: 30,
      payload: { recommendedBestQty: 30 },
    });
    await createSilverOrderRecord(db, {
      id: 'different-asin-order',
      naturalKey: 'supplier-order:Muxtex INC:OTHER-ASIN-ORDER',
      sourceConnectionId: 'source-1',
      company: 'Muxtex INC',
      externalOrderRef: 'OTHER-ASIN-ORDER',
      status: 'approval_pending',
      lastMeaningfulUpdateAt: '2026-02-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'different-asin-line',
      naturalKey: 'supplier-order-line:OTHER-ASIN-ORDER',
      sourceConnectionId: 'source-1',
      company: 'Muxtex INC',
      supplierOrderId: 'different-asin-order',
      asin: 'B000OTHER',
      sku: 'SHARED-SKU',
      orderedQty: 10,
      receivedQty: 0,
      expectedSellableDate: '2026-03-02',
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Muxtex INC',
      calculationDate: '2026-07-07',
    });

    expect(row).toMatchObject({
      supplierOrderState: 'no_open_order',
    });
    expect(row.supplierOrderRef).toBeUndefined();
    expect(row.expectedSellableDate).toBeUndefined();
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

  it('exposes Sellerboard COGS cost on command-center rows without guessing ambiguous ASIN costs', async () => {
    const db = new MemoryDatabase();
    for (const row of [
      { id: 'exact', asin: 'B000EXACT', sku: 'SKU-EXACT', qty: 10, risk: 300 },
      { id: 'safe', asin: 'B000SAFE', sku: 'amzn.gr.safe', qty: 4, risk: 200 },
      { id: 'ambiguous', asin: 'B000AMBIG', sku: 'amzn.gr.ambig', qty: 3, risk: 100 },
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
        supplierOrderState: 'no_open_order',
      });
    }
    for (const cost of [
      { asin: 'B000EXACT', sku: 'SKU-EXACT', unitCost: 4.5 },
      { asin: 'B000SAFE', sku: 'SAFE-1', unitCost: 7 },
      { asin: 'B000SAFE', sku: 'SAFE-2', unitCost: 7 },
      { asin: 'B000AMBIG', sku: 'AMBIG-1', unitCost: 11 },
      { asin: 'B000AMBIG', sku: 'AMBIG-2', unitCost: 12 },
    ]) {
      await createRecord(db, ECOBASE_COLLECTIONS.sellerboardProductCosts, {
        id: `cost-${cost.sku}`,
        naturalKey: `Ecofission LLC:${cost.asin}:${cost.sku}`,
        company: 'Ecofission LLC',
        sourceFile: 'cogs.csv',
        ...cost,
      });
    }

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-06-07',
      pane: 'supplyAction',
      pageSize: 10,
    });
    const rows = commandCenter.panes.supplyAction.rows;
    const row = (asin: string) => rows.find((item) => item.asin === asin);

    expect(row('B000EXACT')).toMatchObject({ unitCost: 4.5, unitCostStatus: 'exact', estimatedOrderCost: 45 });
    expect(row('B000SAFE')).toMatchObject({ unitCost: 7, unitCostStatus: 'asin_same_cost', estimatedOrderCost: 28 });
    expect(row('B000AMBIG')).toMatchObject({ unitCostStatus: 'ambiguous', estimatedOrderCost: undefined });
  });

  it('resolves latest active-order comment authors for command-center rows', async () => {
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
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-06-07',
      pane: 'activeOrders',
      pageSize: 10,
    });

    expect(commandCenter.panes.activeOrders.rows[0]).toMatchObject({
      latestSupplierOrderActivityActor: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityActorDisplayName: 'Ahmed Nauman',
      latestSupplierOrderActivityActorEmail: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityNote: 'Will proceed with the order on Monday.',
      latestSupplierOrderActivitySource: 'clickup',
    });
  });

  it('shapes row drawer supplier/order history behind the inventory workspace interface', async () => {
    const db = new MemoryDatabase();
    const supplierId = '33333333-3333-4333-8333-333333333333';
    const orderId = '11111111-1111-4111-8111-111111111111';
    await createRecord(db, ECOBASE_COLLECTIONS.suppliers, {
      id: supplierId,
      naturalKey: 'supplier-drawer',
      company: 'Ecofission LLC',
      name: 'Drawer Supplier',
      active: true,
    });
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-drawer',
      company: 'Ecofission LLC',
      supplierId,
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
      occurredAt: '2026-06-07T14:00:00.000Z',
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
          actor: 'nauman.ecofission@gmail.com',
          actorDisplayName: 'Ahmed Nauman',
          actorEmail: 'nauman.ecofission@gmail.com',
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
