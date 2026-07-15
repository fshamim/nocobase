/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import Migration from '../migrations/20260715141000-add-gold-refresh-publication';

describe('Gold refresh publication migration', () => {
  it('adds one partial unique index for the published pointer', async () => {
    const addIndex = vi.fn(async () => undefined);
    const migration = new Migration({
      db: {
        getCollection: () => ({ getTableNameWithSchema: () => 'goldInventoryPlanningRefreshRuns' }),
        sequelize: { getQueryInterface: () => ({ addIndex }) },
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    expect(addIndex).toHaveBeenCalledWith('goldInventoryPlanningRefreshRuns', ['status'], {
      name: 'gold_inventory_planning_one_published_run_uidx',
      unique: true,
      where: { status: 'published' },
    });
  });
});
