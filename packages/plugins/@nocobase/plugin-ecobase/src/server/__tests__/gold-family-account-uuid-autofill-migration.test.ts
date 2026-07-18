/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import Migration from '../migrations/20260718163000-disable-gold-family-account-uuid-autofill';
import { ECOBASE_COLLECTIONS } from '../collections/names';

describe('Gold family account UUID auto-fill migration', () => {
  it('preserves field options and disables synthetic family account IDs', async () => {
    const update = vi.fn();
    const findOne = vi.fn(async () => ({
      options: { index: true, uiSchema: { title: 'Family Amazon Account' } },
    }));
    const migration = new Migration({
      db: { getRepository: () => ({ findOne, update }) },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      filter: {
        collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
        name: 'familyAmazonAccountId',
      },
      values: {
        options: {
          index: true,
          uiSchema: { title: 'Family Amazon Account' },
          autoFill: false,
        },
      },
    });
  });
});
