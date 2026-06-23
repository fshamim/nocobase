import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { EcobaseMedallionNormalizationService } from '../services/medallion-normalization-service';

class FakeRepository implements EcobaseRepository {
  rows: Record<string, unknown>[] = [];

  async find(params?: { filter?: Record<string, unknown>; filterByTk?: string | number; limit?: number }) {
    const rows = this.rows.filter((row) => matches(row, params));
    return rows.slice(0, params?.limit ?? rows.length);
  }

  async findOne(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.find((row) => matches(row, params)) ?? null;
  }

  async create(params: { values: Record<string, unknown> }) {
    this.rows.push({ ...params.values });
    return this.rows[this.rows.length - 1];
  }

  async update(params: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    this.rows = this.rows.map((row) => (matches(row, params) ? { ...row, ...params.values } : row));
    return this.rows.filter((row) => matches(row, params));
  }
}

class FakeDatabase implements EcobaseDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

function matches(
  row: Record<string, unknown>,
  params?: { filter?: Record<string, unknown>; filterByTk?: string | number },
) {
  if (params?.filterByTk !== undefined && row.id !== params.filterByTk) return false;
  return Object.entries(params?.filter ?? {}).every(([key, value]) => row[key] === value);
}

async function seedBronze(db: FakeDatabase, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
    values: {
      id: `bronze-${db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows.length + 1}`,
      sourceConnectionId: 'source-1',
      importRunId: 'import-1',
      sourceType: 'google_sheets',
      sourceDataset: 'MasterStock.csv',
      sourceRecordKey: `MasterStock.csv:${payload.ASIN ?? payload['Order ID'] ?? 'row'}`,
      rowHash: `hash-${JSON.stringify(payload).length}`,
      payload,
      normalizationStatus: 'pending',
      ...overrides,
    },
  });
}

describe('EcobaseMedallionNormalizationService', () => {
  it('normalizes product inventory rows into silver identity and fact tables', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00PUSNY5A',
      SKU: 'W101',
      Title: 'Lesson Plan',
      Marketplace: 'Amazon.com',
      'FBA/FBM Stock': '386',
      Reserved: '13',
      Ordered: '500',
      'Estimated Sales Velocity': '9.79',
    });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result).toMatchObject({ normalized: 1, ignored: 0, failed: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).rows[0]).toMatchObject({
      sellableStock: 386,
      reserved: 13,
      ordered: 500,
      salesVelocity: 9.79,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[0].normalizationStatus).toBe('normalized');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows.length).toBeGreaterThan(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows[0].relation).toBe('created_from');
  });

  it('normalizes order detail rows into silver orders and lines', async () => {
    const db = new FakeDatabase();
    await seedBronze(
      db,
      {
        'Order ID': 'OD-NEW',
        Timestamp: '10/07/2023 08:00:00',
        Company: 'Ecofission LLC',
        Supplier: 'Beta Supply',
        ASIN: 'B0057XUD02',
        SKU: 'V-651-A',
        Qty: '60',
        PPU: '1.25',
        'Order type': 'New',
        'Lead time(day)': '12',
        'T.Profit': '240',
      },
      { sourceDataset: 'OrderDetails.csv' },
    );

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      orderRef: 'OD-NEW',
      orderDate: '2023-07-10',
      lifecyclePhase: 'imported',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows[0]).toMatchObject({
      orderedQty: 60,
      unitCost: 1.25,
      expectedProfit: 240,
    });
  });

  it('is idempotent when the same bronze row is normalized again', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, {
      Company: 'Ecofission LLC',
      ASIN: 'B00PUSNY5A',
      SKU: 'W101',
      Supplier: 'Alpha Supply',
      'FBA/FBM Stock': '10',
    });
    const service = new EcobaseMedallionNormalizationService(db);
    await service.normalizePending();
    const firstLinkCount = db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows.length;
    await db
      .getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords)
      .update({ filterByTk: 'bronze-1', values: { normalizationStatus: 'pending' } });

    const result = await service.normalizePending();

    expect(result).toMatchObject({ normalized: 1, failed: 0, links: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).rows).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows).toHaveLength(firstLinkCount);
  });

  it('marks mapper failures clearly without stopping the batch', async () => {
    const db = new FakeDatabase();
    await seedBronze(db, { Company: '!!!', ASIN: 'B001', SKU: 'SKU-1' });
    await seedBronze(db, { Company: 'Ecofission LLC', ASIN: 'B002', SKU: 'SKU-2' });

    const result = await new EcobaseMedallionNormalizationService(db).normalizePending();

    expect(result.failed).toBe(1);
    expect(result.normalized).toBe(1);
    expect(result.errors[0]).toMatch(/companyKey/);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows[0].normalizationStatus).toBe('failed');
  });
});
