/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EcobaseGoldRefreshRunService } from '../../features/inventory-planning/server/gold-refresh-run-service';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseInventoryPlanningActions } from '../resource-actions';

type Row = Record<string, unknown>;
type Query = { filter?: Row; filterByTk?: string | number; sort?: string[]; limit?: number };

class MemoryRepository implements EcobaseRepository {
  constructor(readonly rows: Row[] = []) {}

  async find(params: Query = {}) {
    const matches = this.matches(params);
    const [sort] = params.sort ?? [];
    const sorted = sort
      ? [...matches].sort((left, right) => {
          const descending = sort.startsWith('-');
          const key = descending ? sort.slice(1) : sort;
          const comparison = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
          return descending ? -comparison : comparison;
        })
      : matches;
    return sorted.slice(0, params.limit ?? sorted.length);
  }

  async findOne(params: Query = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Row }) {
    this.rows.push({ ...values });
    return values;
  }

  async update({ filter, filterByTk, values }: { filter?: Row; filterByTk?: string | number; values: Row }) {
    const matches = this.matches({ filter, filterByTk });
    if (matches.length === 0) throw new Error('Memory refresh repository update failed: row was not found.');
    matches.forEach((row) => Object.assign(row, values));
    return matches[0];
  }

  private matches(params: Query) {
    return this.rows.filter((row) => {
      if (params.filterByTk !== undefined && row.id !== params.filterByTk) return false;
      return Object.entries(params.filter ?? {}).every(([key, value]) => row[key] === value);
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly runs = new MemoryRepository();
  readonly gold = new MemoryRepository();

  getRepository(name: string) {
    if (name === ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns) return this.runs;
    if (name === ECOBASE_COLLECTIONS.goldInventoryPlanningRows) return this.gold;
    throw new Error(`Memory refresh database has no repository named ${name}.`);
  }
}

async function buildRun(
  db: MemoryDatabase,
  params: { date: string; key: string; publish?: boolean; rowIds?: string[] },
) {
  return new EcobaseGoldRefreshRunService(db).execute({
    calculationDate: params.date,
    idempotencyKey: params.key,
    publish: params.publish,
    request: { calculationDate: params.date },
    materialize: async ({ runId }) => {
      const rowIds = params.rowIds ?? [params.key];
      for (const rowId of rowIds) {
        await db.gold.create({
          values: {
            id: `${runId}:${rowId}`,
            refreshRunId: runId,
            naturalKey: `${runId}:${rowId}`,
            planningProductId: rowId,
            company: 'ACME',
            asin: rowId,
            calculationDate: params.date,
            actionStatus: 'watch',
          },
        });
      }
      return {
        calculationDate: params.date,
        rowCount: rowIds.length,
        created: rowIds.length,
        updated: 0,
        lastRefreshedAt: `${params.date}T00:00:00.000Z`,
      };
    },
  });
}

describe('Gold refresh publication control', () => {
  it('reads the published run deterministically and ignores a newer unpublished date', async () => {
    const db = new MemoryDatabase();
    const published = await buildRun(db, { date: '2026-07-14', key: 'published' });
    await buildRun(db, { date: '2026-07-15', key: 'newer-unpublished', publish: false });

    const rows = await new EcobaseInventoryPlanningService(db).listRows();
    const unpublishedRows = await new EcobaseInventoryPlanningService(db).listRows({
      calculationDate: '2026-07-15',
    });

    expect(rows.map((row) => row.refreshRunId)).toEqual([String((published.run as Row).id)]);
    expect(unpublishedRows).toEqual([]);
  });

  it('creates one run and one row cohort for concurrent duplicate idempotency keys', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseGoldRefreshRunService(db);
    let materializationCount = 0;
    const execute = () =>
      service.execute({
        calculationDate: '2026-07-15',
        idempotencyKey: 'same-key',
        request: { calculationDate: '2026-07-15' },
        materialize: async ({ runId }) => {
          materializationCount += 1;
          await db.gold.create({
            values: {
              id: `${runId}:row`,
              refreshRunId: runId,
              naturalKey: `${runId}:row`,
              planningProductId: 'row',
              company: 'ACME',
              asin: 'B000ROW',
              calculationDate: '2026-07-15',
            },
          });
          return {
            calculationDate: '2026-07-15',
            rowCount: 1,
            created: 1,
            updated: 0,
            lastRefreshedAt: '2026-07-15T00:00:00.000Z',
          };
        },
      });

    const [first, second] = await Promise.all([execute(), execute()]);

    expect(materializationCount).toBe(1);
    expect(db.runs.rows).toHaveLength(1);
    expect(db.gold.rows).toHaveLength(1);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
  });

  it('keeps the published pointer unchanged when a run fails and rejects failed publication', async () => {
    const db = new MemoryDatabase();
    const published = await buildRun(db, { date: '2026-07-14', key: 'current' });
    await expect(
      new EcobaseGoldRefreshRunService(db).execute({
        calculationDate: '2026-07-15',
        idempotencyKey: 'failed',
        request: { calculationDate: '2026-07-15' },
        materialize: async () => {
          throw new Error('fixture materialization failed');
        },
      }),
    ).rejects.toThrow('fixture materialization failed');

    const failed = db.runs.rows.find((run) => run.idempotencyKey === 'failed');
    expect(db.runs.rows.find((run) => run.status === 'published')?.id).toBe((published.run as Row).id);
    expect(failed).toMatchObject({ status: 'failed', errorJson: { message: 'fixture materialization failed' } });
    await expect(new EcobaseGoldRefreshRunService(db).publish(String(failed?.id))).rejects.toThrow(
      'with status "failed" cannot be published',
    );
  });

  it('switches the published pointer to one verified successful run', async () => {
    const db = new MemoryDatabase();
    const first = await buildRun(db, { date: '2026-07-14', key: 'first' });
    const second = await buildRun(db, { date: '2026-07-15', key: 'second', publish: false });

    const published = await new EcobaseGoldRefreshRunService(db).publish(String((second.run as Row).id));

    expect(db.runs.rows.filter((run) => run.status === 'published')).toHaveLength(1);
    expect(db.runs.rows.find((run) => run.id === (first.run as Row).id)?.status).toBe('succeeded');
    expect((published.run as Row).id).toBe((second.run as Row).id);
  });

  it('stores row-count verification on the run', async () => {
    const db = new MemoryDatabase();
    const result = await buildRun(db, {
      date: '2026-07-15',
      key: 'verified-count',
      publish: false,
      rowIds: ['one', 'two'],
    });

    expect(result.verification).toEqual({
      valid: true,
      expectedRowCount: 2,
      storedRowCount: 2,
      uniqueNaturalKeyCount: 2,
      calculationDate: '2026-07-15',
    });
    await expect(new EcobaseGoldRefreshRunService(db).verify(String((result.run as Row).id))).resolves.toMatchObject({
      storedRowCount: 2,
    });
  });

  it('blocks operator rebuild requests and keeps operator Refresh free of rebuild calls', async () => {
    const action = createEcobaseInventoryPlanningActions().refreshReadModel;
    const next = vi.fn();
    const ctx = {
      state: { currentRoles: ['operator'], currentUser: { id: 1 } },
      action: { params: { values: {} } },
      throw: (status: number, message: string) => {
        throw new Error(`${status}:${message}`);
      },
    };

    await expect(action(ctx as never, next)).rejects.toThrow(
      '403:Ecobase refreshReadModel requires the admin or root role.',
    );
    expect(next).not.toHaveBeenCalled();

    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        'packages/plugins/@nocobase/plugin-ecobase/src/features/inventory-planning/client/InventoryPlanningPage.tsx',
      ),
      'utf8',
    );
    expect(pageSource).not.toContain('ecobaseInventoryPlanning:refreshReadModel');
    expect(pageSource).not.toContain('Rebuild gold inventory');
  });
});
