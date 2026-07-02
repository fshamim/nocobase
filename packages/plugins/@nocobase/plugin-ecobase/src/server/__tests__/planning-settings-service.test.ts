import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseInventoryPlanningService } from '../services/inventory-planning-service';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
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

describe('EcobasePlanningSettingsService', () => {
  it('returns operator-visible planning defaults when no settings row exists', async () => {
    const result = await new EcobasePlanningSettingsService(new MemoryDatabase()).getActiveSettings();

    expect(result.settings).toMatchObject(DEFAULT_PLANNING_SETTINGS);
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
    });

    expect(saved).toMatchObject({
      safetyBufferDays: 10,
      reorderCycleDays: 45,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 10,
      supplierOrderPurchasedPipelineStatuses: ['paid', 'custom_paid'],
    });
    await expect(service.saveSettings({ safetyBufferDays: -1 })).rejects.toThrow(
      'EcoBase planning settings require Safety buffer days to be a zero-or-positive whole number.',
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
      orderSoonWindowDays: 5,
      leadTimeFreshnessDays: 30,
      purchasedPipelineGraceDays: 1,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 0,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-settings',
      naturalKey: 'Ecofission LLC:B000SETTINGS',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000SETTINGS',
      title: 'Settings product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-settings',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-settings',
      snapshotDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000SETTINGS',
      sku: 'SETTINGS-SKU',
      stock: 10,
      salesVelocity: 2,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-settings',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-settings',
      company: 'Ecofission LLC',
      asin: 'B000SETTINGS',
      sku: 'SETTINGS-SKU',
      profitPerUnit: 20,
      leadTimeDays: 4,
      payload: { recommendedBestQty: 20, productStatus: 'Active' },
    });

    const [row] = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(row).toMatchObject({
      safetyBufferDays: 10,
      reorderCycleDays: 40,
      orderSoonWindowDays: 5,
      leadTimeFreshnessDays: 30,
      purchasedPipelineGraceDays: 1,
      tier: 'B',
      suggestedReorderQty: 98,
    });
  });

  it('lets operators add a purchased-pipeline status for open-order coverage', async () => {
    const db = new MemoryDatabase();
    await new EcobasePlanningSettingsService(db).saveSettings({
      supplierOrderPurchasedPipelineStatuses: ['paid', 'supplier_paid_wire'],
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningProducts, {
      id: 'planning-product-custom-status',
      naturalKey: 'Ecofission LLC:B000STATUS',
      company: 'Ecofission LLC',
      canonicalAsin: 'B000STATUS',
      title: 'Custom status product',
      mappingStatus: 'confirmed',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.inventorySnapshots, {
      naturalKey: 'inventory-custom-status',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-custom-status',
      snapshotDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000STATUS',
      sku: 'STATUS-SKU',
      stock: 10,
      salesVelocity: 2,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.planningParameters, {
      naturalKey: 'params-custom-status',
      sourceConnectionId: 'source-1',
      planningProductId: 'planning-product-custom-status',
      company: 'Ecofission LLC',
      asin: 'B000STATUS',
      sku: 'STATUS-SKU',
      profitPerUnit: 20,
      leadTimeDays: 4,
      payload: { recommendedBestQty: 20, productStatus: 'Active' },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrders, {
      id: 'order-custom-status',
      naturalKey: 'supplier-order:Ecofission LLC:CUSTOM-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      externalOrderRef: 'CUSTOM-1',
      status: 'supplier_paid_wire',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.supplierOrderLines, {
      id: 'line-custom-status',
      naturalKey: 'supplier-order-line:CUSTOM-1',
      sourceConnectionId: 'source-1',
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
      suggestedReorderQty: 52,
    });
  });
});
