/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Gate G3: the drawer reuses the existing order-planning actions. This suite
 * invokes those actions with the dashboard drawer's exact payload shapes
 * against a seeded in-memory database and asserts the persisted effects.
 * (Imports come from shared `src/server/` modules only — AD-1 holds.)
 */

import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import { createEcobaseOrderPlanningActions } from '../../../../server/resource-actions';

type PlainRecord = Record<string, unknown>;

class FakeRepository {
  rows: PlainRecord[] = [];

  async find(params?: { filter?: PlainRecord; limit?: number }) {
    const rows = this.rows.filter((row) => matches(row, params?.filter));
    return typeof params?.limit === 'number' ? rows.slice(0, params.limit) : rows;
  }

  async findOne(params?: { filter?: PlainRecord; filterByTk?: string | number }) {
    if (params?.filterByTk !== undefined) return this.rows.find((row) => row.id === params.filterByTk) ?? null;
    return this.rows.find((row) => matches(row, params?.filter)) ?? null;
  }

  async create(params: { values: PlainRecord }) {
    this.rows.push({ ...params.values });
    return params.values;
  }

  async update(params: { filterByTk?: string | number; filter?: PlainRecord; values: PlainRecord }) {
    const rows = this.rows.filter((row) =>
      params.filterByTk !== undefined ? row.id === params.filterByTk : matches(row, params.filter),
    );
    rows.forEach((row) => Object.assign(row, params.values));
    return rows[0] ?? null;
  }
}

function matches(row: PlainRecord, filter?: PlainRecord) {
  return Object.entries(filter ?? {}).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray((value as { $in?: unknown[] }).$in)) {
      return (value as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === value;
  });
}

class FakeDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

function operatorContext(db: FakeDatabase, values: PlainRecord) {
  return {
    action: { params: { values } },
    db,
    state: { currentUser: { id: 4 }, currentRole: 'operator', currentRoles: ['operator'] },
    body: undefined as unknown,
    throw(status: number, message: string): never {
      throw Object.assign(new Error(message), { status });
    },
  };
}

async function seed(db: FakeDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({ values: { id: 'company-1', name: 'Acme' } });
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
    values: {
      id: 'order-1a',
      companyId: 'company-1',
      orderRef: 'PO-1A',
      orderDate: '2026-07-01',
      dailySequenceLetter: 'A',
      lifecycleStatus: 'ordered',
      canonicalStatus: 'paid',
      workflowStage: 'in_prep',
      statusEvidenceJson: {},
    },
  });
}

describe('drawer-reused order-planning actions (Gate G3)', () => {
  it('addComment with the drawer payload persists an order activity comment', async () => {
    const db = new FakeDatabase();
    await seed(db);
    const ctx = operatorContext(db, { orderId: 'order-1a', body: 'Chasing the supplier' });

    await createEcobaseOrderPlanningActions().addComment(ctx as never, vi.fn());

    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      entityType: 'order',
      entityId: 'order-1a',
      body: 'Chasing the supplier',
    });
  });

  it('updateOrder with the drawer status payload applies the operator override and stage stamp', async () => {
    const db = new FakeDatabase();
    await seed(db);
    const ctx = operatorContext(db, { orderId: 'order-1a', fields: { lifecycleStatus: 'inbound-monitoring' } });

    await createEcobaseOrderPlanningActions().updateOrder(ctx as never, vi.fn());

    const order = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    expect(order).toMatchObject({
      lifecycleStatus: 'inbound-monitoring',
      statusSource: 'operator',
      workflowStage: 'amazon_inbound',
    });
    expect(typeof order.workflowStageEnteredAt).toBe('string');
    // The audit comment is appended automatically.
    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows;
    expect(comments.some((comment) => String(comment.body).includes('Status changed'))).toBe(true);
  });

  it('updateOrder with the drawer ETA payload persists the date and the reason comment', async () => {
    const db = new FakeDatabase();
    await seed(db);
    const ctx = operatorContext(db, {
      orderId: 'order-1a',
      fields: { expectedDeliveryDate: '2026-08-15' },
      commentBody: 'Supplier confirmed new delivery window',
    });

    await createEcobaseOrderPlanningActions().updateOrder(ctx as never, vi.fn());

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      expectedDeliveryDate: '2026-08-15',
    });
    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows;
    expect(comments.some((comment) => comment.body === 'Supplier confirmed new delivery window')).toBe(true);
  });
});
