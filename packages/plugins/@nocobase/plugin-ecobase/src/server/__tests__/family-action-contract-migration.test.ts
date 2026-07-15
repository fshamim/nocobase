/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import Migration from '../migrations/20260715143000-add-family-action-contract';

describe('family action contract migration', () => {
  it('adds the persisted family account, marketplace, ASIN, and calculation provenance fields', async () => {
    const create = vi.fn(async () => undefined);
    const migration = new Migration({
      db: {
        getRepository: () => ({ findOne: vi.fn(async () => null), create }),
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    expect(create.mock.calls.map(([params]) => params.values.name)).toEqual([
      'familyAmazonAccountId',
      'familyMarketplace',
      'familyCanonicalAsin',
      'calculationProvenanceJson',
    ]);
  });
});
