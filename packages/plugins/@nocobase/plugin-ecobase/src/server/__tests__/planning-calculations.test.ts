import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobasePlanningActions } from '../plugin';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobasePlanningCalculationService } from '../services/planning-calculation-service';

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

function createActionContext(db: EcobaseDatabase, values: Record<string, unknown> = {}) {
  return {
    action: { params: { values } },
    db,
    body: undefined,
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

async function seedPlanningProduct(db: MemoryDatabase, id = 'planning-product-1') {
  await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
    values: {
      id,
      naturalKey: `Ecofission LLC:B000TEST:${id}`,
      company: 'Ecofission LLC',
      canonicalAsin: 'B000TEST',
      title: 'Benchmark product',
      mappingStatus: 'confirmed',
      listingCount: 1,
    },
  });
  return id;
}

describe('Ecobase spreadsheet-parity planning calculations', () => {
  it('calculates and stores versioned tier, stock, restock, off-track, and risk outputs', async () => {
    const db = new MemoryDatabase();
    const planningProductId = await seedPlanningProduct(db);
    await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
      values: {
        naturalKey: 'inventory-1',
        sourceConnectionId: 'source-1',
        planningProductId,
        snapshotDate: '2025-07-01',
        company: 'Ecofission LLC',
        asin: 'B000TEST',
        sku: 'SKU-1',
        stock: 10,
        reserved: 2,
        inbound: 3,
        ordered: 4,
        prepStock: 1,
        salesVelocity: 2,
        recommendedReorderQuantity: 20,
        lastImportRunId: 'import-1',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningParameters).create({
      values: {
        naturalKey: 'parameter-1',
        sourceConnectionId: 'source-1',
        planningProductId,
        company: 'Ecofission LLC',
        asin: 'B000TEST',
        sku: 'SKU-1',
        supplier: 'Supplier A',
        supplierId: 'SUP-A',
        profitPerUnit: 5,
        leadTimeDays: 10,
        lastImportRunId: 'import-1',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
      values: {
        naturalKey: 'fact-1',
        sourceConnectionId: 'source-1',
        planningProductId,
        snapshotDate: '2025-07-05',
        company: 'Ecofission LLC',
        asin: 'B000TEST',
        sku: 'SKU-1',
        netProfit: 100,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.targetRows).create({
      values: {
        naturalKey: 'target-1',
        sourceConnectionId: 'source-1',
        planningProductId,
        company: 'Ecofission LLC',
        targetScope: 'planning_product',
        period: '2025-07',
        periodType: 'monthly',
        asin: 'B000TEST',
        sku: 'SKU-1',
        profitTarget: 620,
        lastImportRunId: 'import-1',
      },
    });

    const result = await new EcobasePlanningCalculationService(db).calculatePlanningProduct({
      planningProductId,
      calculationDate: '2025-07-10',
    });

    expect(result).toMatchObject({
      ruleVersion: 'spreadsheet_parity_v1',
      tier: 'B',
      tierScore: 100,
      currentStockParity: 20,
      sellableStock: 10,
      pipelineStock: 10,
      salesVelocity: 2,
      daysOfCover: 10,
      oosDate: '2025-07-20',
      leadTimeDays: 10,
      safetyBufferDays: 7,
      restockDeadlineParity: '2025-07-10',
      restockDeadlineImproved: '2025-07-03',
      latestSafeReorderWindowStart: '2025-07-03',
      latestSafeReorderWindowEnd: '2025-07-10',
      daysLeftOrOverdue: 0,
      urgentRestock: true,
      restockNeeded: true,
      estimatedMonthEndQuantity: -22,
      achievedProfitMtd: 100,
      proratedProfitTargetMtd: 200,
      profitGap: 100,
      profitOffTrack: true,
      estimatedProfitRisk: 70,
      dataCompleteness: 'complete',
      calculationStatus: 'calculated',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).all()).toEqual([
      expect.objectContaining({ naturalKey: 'planning-product-1:spreadsheet_parity_v1:2025-07-10' }),
    ]);
  });

  it('uses the zero/negative-velocity sentinel and reports missing lead-time status explicitly', async () => {
    for (const salesVelocity of [0, -1]) {
      const db = new MemoryDatabase();
      const planningProductId = await seedPlanningProduct(db, `planning-product-${salesVelocity}-velocity`);
      await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
        values: {
          naturalKey: `inventory-${salesVelocity}`,
          sourceConnectionId: 'source-1',
          planningProductId,
          snapshotDate: '2025-07-01',
          stock: 5,
          salesVelocity,
          recommendedReorderQuantity: 3,
        },
      });

      const result = await new EcobasePlanningCalculationService(db).calculatePlanningProduct({
        planningProductId,
        calculationDate: '2025-07-10',
      });

      expect(result).toMatchObject({
        daysOfCover: 999,
        calculationStatus: 'missing_lead_time',
        urgentRestock: false,
        restockNeeded: false,
        warningCount: 3,
      });
      expect(result.dataCompleteness).toContain('missing:salesVelocity,leadTimeDays,profitPerUnit');
      expect(result.restockDeadlineParity).toBeUndefined();
      expect(result.warnings.map((warning) => warning.code)).toEqual([
        'missing_lead_time',
        'missing_target',
        'missing_velocity',
      ]);
    }
  });

  it('surfaces unmapped listing warnings on planning calculations', async () => {
    const db = new MemoryDatabase();
    const planningProductId = await seedPlanningProduct(db, 'planning-product-unmapped');
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).update({
      filterByTk: planningProductId,
      values: { mappingStatus: 'needs_review' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).create({
      values: {
        id: 'listing-1',
        naturalKey: 'listing-1',
        planningProductId,
        rawListingNaturalKey: 'raw-listing-1',
        sourceConnectionId: 'source-1',
        company: 'Ecofission LLC',
        canonicalAsin: 'B000TEST',
        asin: 'B000TEST',
        sku: 'SKU-1',
        mappingMode: 'default',
        mappingStatus: 'needs_review',
        mappedAt: '2025-07-01T00:00:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
      values: {
        naturalKey: 'inventory-unmapped',
        sourceConnectionId: 'source-1',
        planningProductId,
        snapshotDate: '2025-07-10',
        stock: 15,
        salesVelocity: 2,
        recommendedReorderQuantity: 8,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningParameters).create({
      values: {
        naturalKey: 'parameter-unmapped',
        sourceConnectionId: 'source-1',
        planningProductId,
        profitPerUnit: 4,
        leadTimeDays: 5,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.targetRows).create({
      values: {
        naturalKey: 'target-unmapped',
        sourceConnectionId: 'source-1',
        planningProductId,
        company: 'Ecofission LLC',
        targetScope: 'planning_product',
        period: '2025-07',
        periodType: 'monthly',
        profitTarget: 500,
      },
    });

    const result = await new EcobasePlanningCalculationService(db).calculatePlanningProduct({
      planningProductId,
      calculationDate: '2025-07-10',
    });

    expect(result.warningCount).toBe(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'unmapped_listing',
        planningProductId,
        planningProductListingId: 'listing-1',
        rawListingNaturalKey: 'raw-listing-1',
      }),
    ]);
  });

  it('aggregates multi-listing stock, velocity, quantity, and profit inputs at planning-product level', async () => {
    const db = new MemoryDatabase();
    const planningProductId = await seedPlanningProduct(db, 'planning-product-aggregate');
    for (const [sku, stock, salesVelocity, recommendedReorderQuantity] of [
      ['SKU-1', 10, 1, 5],
      ['SKU-2', 30, 3, 15],
    ] as const) {
      await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
        values: {
          naturalKey: `inventory-${sku}`,
          sourceConnectionId: 'source-1',
          planningProductId,
          snapshotDate: '2025-07-10',
          stock,
          salesVelocity,
          recommendedReorderQuantity,
          sku,
        },
      });
    }
    for (const [sku, profitPerUnit, recommendedBestQty] of [
      ['SKU-1', 2, 5],
      ['SKU-2', 4, 15],
    ] as const) {
      await db.getRepository(ECOBASE_COLLECTIONS.planningParameters).create({
        values: {
          naturalKey: `parameter-${sku}`,
          sourceConnectionId: 'source-1',
          planningProductId,
          sku,
          profitPerUnit,
          recommendedBestQty,
          leadTimeDays: 5,
        },
      });
    }
    for (let day = 4; day <= 10; day += 1) {
      await db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).create({
        values: {
          naturalKey: `fact-${day}`,
          sourceConnectionId: 'source-1',
          planningProductId,
          snapshotDate: `2025-07-${String(day).padStart(2, '0')}`,
          units: 10,
        },
      });
    }
    for (const [sku, profitTarget] of [
      ['SKU-1', 310],
      ['SKU-2', 310],
    ] as const) {
      await db.getRepository(ECOBASE_COLLECTIONS.targetRows).create({
        values: {
          naturalKey: `target-${sku}`,
          sourceConnectionId: 'source-1',
          planningProductId,
          sku,
          period: '2025-07',
          periodType: 'monthly',
          profitTarget,
        },
      });
    }

    const result = await new EcobasePlanningCalculationService(db).calculatePlanningProduct({
      planningProductId,
      calculationDate: '2025-07-10',
    });

    expect(result).toMatchObject({
      currentStockParity: 40,
      salesVelocity: 10,
      daysOfCover: 4,
      recommendedBestQty: 20,
      profitPerUnit: 3.5,
      tier: 'C',
      tierScore: 70,
      restockDeadlineParity: '2025-07-09',
      restockDeadlineImproved: '2025-07-02',
      proratedProfitTargetMtd: 200,
      profitGap: 200,
      profitOffTrack: true,
    });
  });

  it('uses imported supplier lead-time records when planning parameters only reference a supplier', async () => {
    const db = new MemoryDatabase();
    const planningProductId = await seedPlanningProduct(db, 'planning-product-supplier');
    await db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).create({
      values: {
        naturalKey: 'inventory-supplier',
        sourceConnectionId: 'source-1',
        planningProductId,
        snapshotDate: '2025-07-01',
        stock: 30,
        salesVelocity: 3,
        recommendedReorderQuantity: 15,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.planningParameters).create({
      values: {
        naturalKey: 'parameter-supplier',
        sourceConnectionId: 'source-1',
        planningProductId,
        supplierId: 'SUP-A',
        profitPerUnit: 20,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).create({
      values: {
        naturalKey: 'supplier-lead-time-other-source',
        sourceConnectionId: 'source-2',
        company: 'Other Company',
        supplierId: 'SUP-A',
        supplierName: 'Supplier A',
        asin: 'B000TEST',
        scope: 'product',
        leadTimeDays: 40,
        lastImportRunId: 'import-other',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).create({
      values: {
        naturalKey: 'supplier-lead-time-1',
        sourceConnectionId: 'source-1',
        company: 'Ecofission LLC',
        supplierId: 'SUP-A',
        supplierName: 'Supplier A',
        asin: 'B000TEST',
        scope: 'product',
        leadTimeDays: 6,
        lastImportRunId: 'import-1',
      },
    });

    const result = await new EcobasePlanningCalculationService(db).calculatePlanningProduct({
      planningProductId,
      calculationDate: '2025-07-01',
    });

    expect(result).toMatchObject({
      tier: 'A',
      leadTimeDays: 6,
      restockDeadlineParity: '2025-07-05',
      restockDeadlineImproved: '2025-06-28',
      dataCompleteness: 'complete',
    });
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
          expect.objectContaining({ key: 'restock-deadline-parity', status: 'pass' }),
          expect.objectContaining({ key: 'off-track', status: 'pass' }),
        ]),
      },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
