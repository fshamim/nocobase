/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  EcobaseSellerboardCogsService,
  sellerboardCogsConfirmationToken,
} from '../../features/source-import/server/sellerboard-cogs-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Row = Record<string, any>;

function matches(row: Row, filter: Row = {}) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository implements EcobaseRepository {
  constructor(readonly rows: Row[] = []) {}
  async find(params: any = {}) {
    return this.rows.filter((row) => matches(row, params.filter)).map((row) => ({ ...row }));
  }
  async findOne(params: any = {}) {
    const row = params.filterByTk
      ? this.rows.find((item) => item.id === params.filterByTk)
      : this.rows.find((item) => matches(item, params.filter));
    return row ? { ...row } : null;
  }
  async create(params: any) {
    this.rows.push({ ...params.values });
    return { ...params.values };
  }
  async update(params: any) {
    const row = this.rows.find((item) => item.id === params.filterByTk || matches(item, params.filter));
    if (!row) throw new Error('Missing COGS row');
    Object.assign(row, params.values);
    return { ...row };
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private repositories = new Map<string, MemoryRepository>();
  getRepository(name: string) {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryRepository();
      this.repositories.set(name, repository);
    }
    return repository;
  }
  rows(name: string) {
    return this.getRepository(name).rows;
  }
}

async function seedTarget(db: MemoryDatabase, id: string, asin: string, sku: string) {
  await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
    values: { id: `product-${id}`, asin, sku },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
    values: { id: `company-product-${id}`, companyId: 'company-1', productId: `product-${id}` },
  });
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).create({
    values: {
      id: `family-${id}`,
      companyId: 'company-1',
      replenishmentTargetCompanyProductId: `company-product-${id}`,
    },
  });
}

const file = {
  name: 'Fissionem_Cost_of_Goods_Sold_(2026_07_04).csv',
  content: [
    'ASIN;SKU;Title;CostPeriodStartDate;Cost;Marketplace;Hide',
    'B000000001;SKU-1;Exact;01/07/2026;4.25;Amazon.com;',
    'B000000002;OTHER;Unique;01/07/2026;5.50;Amazon.com;',
    'B000000003;OTHER;Hidden;01/07/2026;6.75;Amazon.com;YES',
    'B000000004;A;Ambiguous A;01/07/2026;7.00;Amazon.com;',
    'B000000004;B;Ambiguous B;01/07/2026;8.00;Amazon.com;',
  ].join('\n'),
};

describe('Sellerboard COGS maintenance', () => {
  it('previews target resolution without writes and excludes hidden rows from import', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Ecofission LLC' },
    });
    await seedTarget(db, '1', 'B000000001', 'SKU-1');
    await seedTarget(db, '2', 'B000000002', 'SKU-2');
    await seedTarget(db, '3', 'B000000003', 'SKU-3');
    await seedTarget(db, '4', 'B000000004', 'SKU-4');
    const service = new EcobaseSellerboardCogsService(db);

    const preview = await service.previewCsvFiles({ files: [file] });
    expect(preview).toMatchObject({
      targetCount: 4,
      validPositiveCostRows: 5,
      importableCostRows: 4,
      hiddenSkippedCount: 1,
      resolutionCounts: { exact: 1, asin_unique: 1, ambiguous: 1, missing: 1 },
      hiddenOnlyFallbackCount: 1,
      stagingWrites: 0,
    });
    expect(db.rows(ECOBASE_COLLECTIONS.sellerboardProductCosts)).toHaveLength(0);

    const params = {
      files: [file],
      importedAt: '2026-07-14T00:00:00.000Z',
      decisionDigest: preview.decisionDigest,
      confirmation: sellerboardCogsConfirmationToken(preview.decisionDigest),
    };
    const first = await service.applyBackfill(params);
    const second = await service.applyBackfill(params);
    expect(first).toMatchObject({ importedCount: 4, hiddenSkippedCount: 1, createdCount: 4 });
    expect(second).toMatchObject({ importedCount: 4, hiddenSkippedCount: 1, createdCount: 0 });
    expect(db.rows(ECOBASE_COLLECTIONS.sellerboardProductCosts)).toHaveLength(4);
    expect(db.rows(ECOBASE_COLLECTIONS.sellerboardProductCosts).some((row) => row.asin === 'B000000003')).toBe(false);
  });
});
