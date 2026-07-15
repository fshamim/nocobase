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
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

import { describe, expect, it, vi } from 'vitest';
import Migration from '../migrations/20260715204000-add-gold-calculation-provenance-column';

describe('gold calculation provenance migration', () => {
  it('creates the physical JSON column required by the registered field', async () => {
    const addColumn = vi.fn(async () => undefined);
    const migration = new Migration({
      db: {
        getCollection: () => ({ getTableNameWithSchema: () => 'goldInventoryPlanningRows' }),
        sequelize: {
          getQueryInterface: () => ({ describeTable: vi.fn(async () => ({})), addColumn }),
        },
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    expect(addColumn).toHaveBeenCalledWith(
      'goldInventoryPlanningRows',
      'calculationProvenanceJson',
      expect.objectContaining({ allowNull: true, type: expect.anything() }),
    );
  });

  it('leaves an existing physical column unchanged', async () => {
    const addColumn = vi.fn(async () => undefined);
    const migration = new Migration({
      db: {
        getCollection: () => ({ getTableNameWithSchema: () => 'goldInventoryPlanningRows' }),
        sequelize: {
          getQueryInterface: () => ({
            describeTable: vi.fn(async () => ({ calculationProvenanceJson: { type: 'JSONB' } })),
            addColumn,
          }),
        },
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    expect(addColumn).not.toHaveBeenCalled();
  });
});
