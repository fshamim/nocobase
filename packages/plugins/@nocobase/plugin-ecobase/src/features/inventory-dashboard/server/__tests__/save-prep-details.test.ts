/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import { EcobaseInventoryDashboardService, InventoryDashboardValidationError } from '../inventory-dashboard-service';
import type { DashboardDatabase, DashboardRepository, DashboardRepositoryFindParams } from '../published-gold-reader';
import { FIXED_NOW } from './fixtures/dashboard-fixtures';

class FakeRepository implements DashboardRepository {
  rows: Record<string, unknown>[] = [];

  async find(_params?: DashboardRepositoryFindParams) {
    return this.rows;
  }

  async findOne(_params?: DashboardRepositoryFindParams) {
    return this.rows[0] ?? null;
  }

  async create(params: { values: Record<string, unknown> }) {
    this.rows.push({ ...params.values });
    return params.values;
  }

  async update(params: {
    filterByTk?: string | number;
    filter?: Record<string, unknown>;
    values: Record<string, unknown>;
  }) {
    const row = this.rows.find((candidate) => candidate.id === params.filterByTk);
    if (row) Object.assign(row, params.values);
    return row ?? null;
  }
}

class FakeDatabase implements DashboardDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string): FakeRepository {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

function serviceWithOrder() {
  const db = new FakeDatabase();
  db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push({ id: 'order-1', workflowStage: 'in_prep' });
  const service = new EcobaseInventoryDashboardService(db, { now: new Date(FIXED_NOW) });
  return { db, service };
}

describe('savePrepDetails (T-1.4)', () => {
  it('persists structured prep details with audit stamps', async () => {
    const { db, service } = serviceWithOrder();
    const result = await service.savePrepDetails({
      orderId: 'order-1',
      prepBoxes: 4,
      prepCartons: 2,
      prepDimensions: { unit: 'cm', length: 60, width: 40, height: 40 },
      actorUserId: '4',
    });
    expect(result).toEqual({ orderId: 'order-1', updated: true });
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    expect(row).toMatchObject({
      prepBoxes: 4,
      prepCartons: 2,
      prepDimensions: { unit: 'cm', length: 60, width: 40, height: 40 },
      prepDetailsUpdatedAt: FIXED_NOW,
      prepDetailsUpdatedByUserId: '4',
    });
  });

  it('rejects a missing orderId', async () => {
    const { service } = serviceWithOrder();
    await expect(service.savePrepDetails({ prepBoxes: 1 })).rejects.toBeInstanceOf(InventoryDashboardValidationError);
  });

  it('rejects negative counts', async () => {
    const { service } = serviceWithOrder();
    await expect(service.savePrepDetails({ orderId: 'order-1', prepBoxes: -1 })).rejects.toThrow(
      'prepBoxes must be a zero-or-positive whole number.',
    );
    await expect(service.savePrepDetails({ orderId: 'order-1', prepCartons: 1.5 })).rejects.toThrow(
      'prepCartons must be a zero-or-positive whole number.',
    );
  });

  it('rejects malformed dimensions', async () => {
    const { service } = serviceWithOrder();
    await expect(service.savePrepDetails({ orderId: 'order-1', prepDimensions: 'big box' })).rejects.toThrow(
      'prepDimensions must be a structured object.',
    );
    await expect(service.savePrepDetails({ orderId: 'order-1', prepDimensions: [1, 2, 3] })).rejects.toThrow(
      'prepDimensions must be a structured object.',
    );
  });

  it('persists and validates supplier ship destination (T-3.0b)', async () => {
    const { db, service } = serviceWithOrder();
    db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows.push({ id: 'supplier-1', displayName: 'Acme Supply' });
    const result = await service.saveSupplierShipDestination({
      supplierId: 'supplier-1',
      shipDestination: 'prep_center',
      actorUserId: '4',
    });
    expect(result).toEqual({ supplierId: 'supplier-1', shipDestination: 'prep_center', updated: true });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows[0]).toMatchObject({
      shipDestination: 'prep_center',
    });
    await expect(service.saveSupplierShipDestination({ shipDestination: 'prep_center' })).rejects.toThrow(
      'requires a supplierId',
    );
    await expect(
      service.saveSupplierShipDestination({ supplierId: 'supplier-1', shipDestination: 'warehouse' }),
    ).rejects.toThrow('direct_fba or prep_center');
  });

  it('rejects an oversized payload', async () => {
    const { service } = serviceWithOrder();
    await expect(
      service.savePrepDetails({ orderId: 'order-1', prepDimensions: { note: 'x'.repeat(5000) } }),
    ).rejects.toThrow('prepDimensions payload is too large.');
  });
});
