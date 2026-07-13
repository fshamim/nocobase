/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import Migration from '../migrations/20260712210000-disable-gold-optional-uuid-autofill';
import { ECOBASE_COLLECTIONS } from '../collections/names';

describe('Gold optional UUID auto-fill migration', () => {
  it('preserves field options and disables UUID generation for nullable supplier references', async () => {
    const update = vi.fn();
    const findOne = vi.fn(async ({ filter }) => ({
      name: filter.name,
      options: { uiSchema: { title: filter.name } },
    }));
    const migration = new Migration({
      db: { getRepository: () => ({ findOne, update }) },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      filter: {
        collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
        name: 'familyPreferredSupplierId',
      },
      values: {
        options: {
          uiSchema: { title: 'Family Supplier' },
          autoFill: false,
        },
      },
    });
  });
});
