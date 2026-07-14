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
import { DEFAULT_PLANNING_SETTINGS, EcobasePlanningSettingsService } from '../services/planning-settings-service';

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
    if (records.length === 0) throw new Error('MemoryRepository update failed: matching record was not found.');
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  private filterRecords(params: FindParams) {
    if (params.filterByTk) return this.records.filter((record) => record.id === params.filterByTk);
    const filter = params.filter ?? {};
    return this.records.filter((record) => Object.entries(filter).every(([key, expected]) => record[key] === expected));
  }

  private sortRecords(records: Record<string, unknown>[], sort: string[] = []) {
    const [firstSort] = sort;
    if (!firstSort) return records;
    const descending = firstSort.startsWith('-');
    const key = descending ? firstSort.slice(1) : firstSort;
    return [...records].sort((left, right) => {
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

async function createRecord(db: MemoryDatabase, collection: string, values: Record<string, unknown>) {
  await db.getRepository(collection).create({ values });
}

async function createSilverPlanningProductFixture(db: MemoryDatabase, values: Record<string, unknown>) {
  const company = String(values.company ?? '');
  const asin = String(values.asin ?? '');
  const sku = String(values.sku ?? '');
  const companyId = `silver-company:${company}`;
  const productId = `silver-product:${asin}:${sku}`;
  const companyProductId = `silver-company-product:${company}:${asin}:${sku}`;
  const supplierId = `silver-supplier:${company}:${asin}:${sku}`;
  const supplierProductId = `silver-supplier-product:${company}:${asin}:${sku}`;
  await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
  await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, { id: productId, asin, sku, title: values.title });
  await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
    id: companyProductId,
    companyId,
    productId,
    lifecycleStatus: 'active',
  });
  await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
    id: `silver-inventory:${company}:${asin}:${sku}`,
    companyProductId,
    snapshotDate: '2026-06-07',
    sellableStock: values.stock,
    salesVelocity: values.salesVelocity,
  });
  await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
    id: `silver-fact:${company}:${asin}:${sku}`,
    companyProductId,
    snapshotDate: '2026-05-15',
    units: values.units,
    profit: values.profit,
  });
  await createRecord(db, ECOBASE_COLLECTIONS.silverSuppliers, { id: supplierId, displayName: 'Settings Supplier' });
  await createRecord(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
    id: supplierProductId,
    supplierId,
    productId,
    leadTimeDays: values.leadTimeDays,
  });
  await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, {
    id: `silver-company-product-supplier:${company}:${asin}:${sku}`,
    companyProductId,
    supplierProductId,
    role: 'latest_used',
  });
}

async function createSupplierOrderRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  const company = String(values.company ?? '');
  const companyId = `silver-company:${company}`;
  await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
  await createRecord(db, ECOBASE_COLLECTIONS.silverOrders, {
    id: values.id,
    companyId,
    orderRef: values.externalOrderRef ?? values.id,
    orderDate: values.orderDate ?? '2026-06-01',
    dailySequenceLetter: 'A',
    canonicalStatus: values.status,
    lifecycleStatus: values.status,
    updatedAt: values.lastMeaningfulUpdateAt,
  });
}

async function createSupplierOrderLineRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  const company = String(values.company ?? '');
  const companyId = `silver-company:${company}`;
  const productId = `silver-product:${values.asin}:${values.sku}`;
  const companyProductId = `silver-company-product:${company}:${values.asin}:${values.sku}`;
  await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
  await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, { id: productId, asin: values.asin, sku: values.sku });
  await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, { id: companyProductId, companyId, productId });
  await createRecord(db, ECOBASE_COLLECTIONS.silverOrderLines, {
    id: values.id,
    orderId: values.supplierOrderId,
    companyProductId,
    orderedQty: values.orderedQty,
    confirmedQty: values.receivedQty,
  });
}

describe('EcobasePlanningSettingsService', () => {
  it('returns operator-visible planning defaults when no settings row exists', async () => {
    const result = await new EcobasePlanningSettingsService(new MemoryDatabase()).getActiveSettings();

    expect(result.settings).toMatchObject({
      ...DEFAULT_PLANNING_SETTINGS,
      enableCurrentOrderCycleSelection: false,
      allowDefaultExpectedArrival: false,
    });
  });

  it('saves settings and rejects invalid rule values explicitly', async () => {
    const service = new EcobasePlanningSettingsService(new MemoryDatabase());

    const saved = await service.saveSettings({
      safetyBufferDays: 10,
      reorderCycleDays: 45,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 10,
      supplierOrderPurchasedPipelineStatuses: ['paid', 'custom-paid'],
      enableCurrentOrderCycleSelection: true,
      allowDefaultExpectedArrival: true,
    });

    expect(saved).toMatchObject({
      safetyBufferDays: 10,
      reorderCycleDays: 45,
      targetCoverDays: 45,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 10,
      supplierOrderPurchasedPipelineStatuses: ['paid', 'custom_paid'],
      enableCurrentOrderCycleSelection: true,
      allowDefaultExpectedArrival: true,
    });
    await expect(service.saveSettings({ safetyBufferDays: -1 })).rejects.toThrow(
      'EcoBase planning settings require Safety buffer days to be a zero-or-positive whole number.',
    );
    await expect(service.saveSettings({ targetCoverDays: 29 })).rejects.toThrow(
      'EcoBase planning settings require Target cover days to be at least 30 days.',
    );
    await expect(service.saveSettings({ profitTierAThreshold: 100, profitTierBThreshold: 200 })).rejects.toThrow(
      'EcoBase profit tier thresholds must descend: A threshold > B threshold > C threshold.',
    );
    await expect(
      service.saveSettings({
        supplierOrderPlacedNotPurchasedStatuses: ['paid'],
        supplierOrderPurchasedPipelineStatuses: ['paid'],
      }),
    ).rejects.toThrow('EcoBase supplier order status "paid" cannot be in both');
  });

  it('applies saved settings to inventory suggested quantity calculations', async () => {
    const db = new MemoryDatabase();
    await new EcobasePlanningSettingsService(db).saveSettings({
      safetyBufferDays: 10,
      reorderCycleDays: 40,
      targetCoverDays: 30,
      orderSoonWindowDays: 5,
      leadTimeFreshnessDays: 30,
      purchasedPipelineGraceDays: 1,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 0,
    });
    await createSilverPlanningProductFixture(db, {
      company: 'Ecofission LLC',
      asin: 'B000SETTINGS',
      sku: 'SETTINGS-SKU',
      title: 'Settings product',
      stock: 10,
      salesVelocity: 2,
      leadTimeDays: 4,
      units: 20,
      profit: 400,
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(row).toMatchObject({
      targetCoverDays: 30,
      suggestedReorderQty: 50,
    });
  });

  it('lets operators add a purchased-pipeline status for open-order coverage', async () => {
    const db = new MemoryDatabase();
    await new EcobasePlanningSettingsService(db).saveSettings({
      supplierOrderPurchasedPipelineStatuses: ['paid', 'supplier_paid_wire'],
    });
    await createSilverPlanningProductFixture(db, {
      company: 'Ecofission LLC',
      asin: 'B000STATUS',
      sku: 'STATUS-SKU',
      title: 'Custom status product',
      stock: 10,
      salesVelocity: 2,
      leadTimeDays: 4,
      units: 20,
      profit: 400,
    });
    await createSupplierOrderRecord(db, {
      id: 'order-custom-status',
      company: 'Ecofission LLC',
      externalOrderRef: 'CUSTOM-1',
      status: 'supplier_paid_wire',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSupplierOrderLineRecord(db, {
      id: 'line-custom-status',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-custom-status',
      planningProductId: 'planning-product-custom-status',
      asin: 'B000STATUS',
      sku: 'STATUS-SKU',
      orderedQty: 20,
      receivedQty: 0,
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(row).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      supplierOrderStatus: 'supplier_paid_wire',
      openOrderCoverageQty: 20,
      suggestedReorderQty: 60,
    });
  });
});
