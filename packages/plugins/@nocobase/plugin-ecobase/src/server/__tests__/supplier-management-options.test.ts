/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { EcobaseSupplierManagementService } from '../../features/supplier-management/server/supplier-management-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Row = Record<string, unknown>;

function matchesCondition(rowValue: unknown, condition: unknown): boolean {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    const operators = condition as { $in?: unknown[]; $includes?: unknown };
    if (Array.isArray(operators.$in)) return operators.$in.includes(rowValue);
    if (typeof operators.$includes === 'string') {
      // Mirrors the core $includes operator: ILIKE on Postgres = case-insensitive contains.
      return String(rowValue ?? '')
        .toLowerCase()
        .includes(operators.$includes.toLowerCase());
    }
    return false;
  }
  return rowValue === condition;
}

class MemoryRepository implements EcobaseRepository {
  constructor(private rows: Row[] = []) {}

  async find(params: { filter?: Row; limit?: number; sort?: string[] } = {}) {
    let result = this.rows.filter((row) =>
      Object.entries(params.filter ?? {}).every(([key, condition]) => matchesCondition(row[key], condition)),
    );
    for (const sortKey of [...(params.sort ?? [])].reverse()) {
      result = [...result].sort((left, right) =>
        String(left[sortKey] ?? '').localeCompare(String(right[sortKey] ?? '')),
      );
    }
    return result.slice(0, params.limit ?? result.length).map((row) => ({ ...row }));
  }

  async findOne(params: { filter?: Row; filterByTk?: string } = {}) {
    return (
      (await this.find({ filter: params.filterByTk ? { id: params.filterByTk } : params.filter, limit: 1 }))[0] ?? null
    );
  }

  async create(params: { values: Row }) {
    this.rows.push({ ...params.values });
    return { ...params.values };
  }

  async update(params: { filterByTk?: string; values: Row }) {
    const row = this.rows.find((item) => item.id === params.filterByTk);
    if (row) Object.assign(row, params.values);
    return row ? { ...row } : null;
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
}

async function seedSuppliers(db: MemoryDatabase, count: number) {
  const suppliers = db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers);
  for (let index = 1; index <= count; index += 1) {
    await suppliers.create({
      values: {
        id: `supplier-${String(index).padStart(3, '0')}`,
        displayName: `Supplier ${String(index).padStart(3, '0')}`,
      },
    });
  }
}

describe('supplier options picker (Batch B3)', () => {
  it('finds a supplier beyond the first slice via the DB-side case-insensitive search', async () => {
    const db = new MemoryDatabase();
    await seedSuppliers(db, 60);
    // Sorted last by name: unfindable under the old fetch-limit-then-filter behavior.
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-zeta', displayName: 'Zeta Unique Ltd' },
    });
    const service = new EcobaseSupplierManagementService(db);

    const found = await service.supplierOptions({ search: 'ZETA', limit: 5 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ value: 'supplier-zeta', label: 'Zeta Unique Ltd' });

    const unsearched = await service.supplierOptions({ limit: 5 });
    expect(unsearched).toHaveLength(5);
    expect(unsearched.map((option) => option.value)).not.toContain('supplier-zeta');
  });

  it('ranks suppliers with order history for the family first and keeps the response shape', async () => {
    const db = new MemoryDatabase();
    await seedSuppliers(db, 60);
    // Sorted last alphabetically: only the family ranking can lift it to the front.
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-family', displayName: 'Zzz Family History Supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: { id: 'order-1', supplierId: 'supplier-family', orderRef: 'EF1001A' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: { id: 'line-1', orderId: 'order-1', companyProductFamilyId: 'family-1' },
    });
    const service = new EcobaseSupplierManagementService(db);

    const options = await service.supplierOptions({ familyId: 'family-1', limit: 10 });
    expect(options).toHaveLength(10);
    expect(options[0]).toMatchObject({ value: 'supplier-family', label: 'Zzz Family History Supplier' });
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(['label', 'status', 'value']);
    }

    // The family supplier still matches the search path and is not duplicated.
    const searched = await service.supplierOptions({ familyId: 'family-1', search: 'zzz family', limit: 10 });
    expect(searched.map((option) => option.value)).toEqual(['supplier-family']);
  });

  it('returns no family ranking for a family without order history', async () => {
    const db = new MemoryDatabase();
    await seedSuppliers(db, 3);
    const service = new EcobaseSupplierManagementService(db);
    const options = await service.supplierOptions({ familyId: 'family-none', limit: 10 });
    expect(options.map((option) => option.value)).toEqual(['supplier-001', 'supplier-002', 'supplier-003']);
  });
});
