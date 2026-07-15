/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobasePlanningActions } from '../plugin';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { EcobasePlanningCalculationService } from '../../features/inventory-planning/server/planning-calculation-service';

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
    return this.records.filter((record) =>
      Object.entries(params.filter ?? {}).every(([key, expected]) => record[key] === expected),
    );
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

function createActionContext(db: EcobaseDatabase) {
  return {
    action: { params: { values: {} } },
    db,
    body: undefined,
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

async function seedCurrentPlanningData(db: MemoryDatabase) {
  const planningProductId = 'planning-product-1';
  const productId = 'silver-product-1';
  const companyProductId = 'company-product-1';
  await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: { id: 'source-1', sourceType: 'sellerboard', active: true },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
    values: { id: 'company-1', companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: productId, asin: 'B000TEST', sku: 'SKU-1' },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: { id: companyProductId, companyId: 'company-1', productId },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
    values: {
      id: planningProductId,
      company: 'Ecofission LLC',
      canonicalAsin: 'B000TEST',
      mappingStatus: 'confirmed',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).create({
    values: {
      id: 'planning-listing-1',
      planningProductId,
      canonicalAsin: 'B000TEST',
      asin: 'B000TEST',
      sku: 'SKU-1',
      mappingStatus: 'confirmed',
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).create({
    values: {
      id: 'inventory-1',
      sourceConnectionId: 'source-1',
      companyProductId,
      snapshotDate: '2026-07-13',
      sellableStock: 100,
      reserved: 100,
      inbound: 50,
      salesVelocity: 2,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
    values: {
      id: 'supplier-product-1',
      supplierId: 'supplier-1',
      productId,
      leadTimeDays: 10,
      profitPerUnit: 5,
      recommendedBestQty: 60,
    },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
    values: {
      id: 'target-1',
      company: 'Ecofission LLC',
      period: '2026-07',
      periodType: 'monthly',
      targetValue: 620,
    },
  });
  for (const [index, units] of [10, 20, 30, 40, 50, 60].entries()) {
    const month = String(index + 1).padStart(2, '0');
    await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
      values: {
        id: `fact-${month}`,
        companyProductId,
        snapshotDate: `2026-${month}-15`,
        units,
        sales: units * 10,
        profit: units * 5,
      },
    });
  }
  await db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).create({
    values: {
      id: 'fact-current-month',
      companyProductId,
      snapshotDate: '2026-07-13',
      units: 14,
      sales: 140,
      profit: 70,
    },
  });
  return planningProductId;
}

describe('Ecobase Silver-backed planning calculations', () => {
  it('uses six complete prior months while retaining current-month facts for operational calculations', async () => {
    const db = new MemoryDatabase();
    const planningProductId = await seedCurrentPlanningData(db);

    const result = await new EcobasePlanningCalculationService(db).calculatePlanningProduct({
      planningProductId,
      calculationDate: '2026-07-13',
    });

    expect(result).toMatchObject({
      tier: 'A',
      lastMonthQty: 60,
      sixMonthAverageQty: 35,
      sixMonthWorstQty: 10,
      sixMonthBestQty: 60,
      sixMonthMargin: 50,
      leadTimeDays: 10,
      profitPerUnit: 5,
      currentStockParity: 250,
      onHandSellableStock: 100,
      reservedStock: 100,
      amazonPipelineStock: 50,
      supplierPipelineStock: 0,
      inventoryPositionStock: 150,
      calculationStatus: 'calculated',
      dataCompleteness: 'complete',
      evidence: {
        factRowCount: 7,
        historicalMetrics: {
          windowStartDate: '2026-01-01',
          windowEndDate: '2026-06-30',
          availableMonthCount: 6,
        },
      },
    });
    expect(result.daysOfCover).toBeCloseTo(100 / (74 / 30));
    expect(result.positionDaysOfCover).toBeCloseTo(150 / (74 / 30));
  });

  it('exposes benchmark validation rows through the public planning action', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobasePlanningActions();
    const context = createActionContext(db);
    const next = vi.fn();

    await actions.validationReport(context, next);

    expect(context.body).toEqual({
      data: {
        status: 'pass',
        rows: expect.arrayContaining([
          expect.objectContaining({ key: 'tier-a', status: 'pass' }),
          expect.objectContaining({ key: 'stock-parity', status: 'pass' }),
          expect.objectContaining({ key: 'inventory-position', status: 'pass' }),
          expect.objectContaining({ key: 'position-days-of-cover', status: 'pass' }),
          expect.objectContaining({ key: 'restock-deadline-parity', status: 'pass' }),
          expect.objectContaining({ key: 'off-track', status: 'pass' }),
        ]),
      },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
