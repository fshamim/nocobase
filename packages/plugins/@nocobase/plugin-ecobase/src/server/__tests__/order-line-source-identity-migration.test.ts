/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import OrderLineSourceIdentityMigration from '../migrations/20260713200000-add-order-line-source-identity';

type FieldRecord = Record<string, unknown> & { collectionName: string; name: string };

describe('Order-line source identity migration', () => {
  it('adds the three fields idempotently', async () => {
    const fields: FieldRecord[] = [];
    const migration = new OrderLineSourceIdentityMigration({
      db: {
        getRepository: () => ({
          findOne: async ({ filter }: { filter: { collectionName: string; name: string } }) =>
            fields.find((field) => field.collectionName === filter.collectionName && field.name === filter.name),
          create: async ({ values }: { values: FieldRecord }) => fields.push(values),
        }),
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();
    await migration.up();

    expect(fields.map((field) => [field.collectionName, field.name])).toEqual([
      [ECOBASE_COLLECTIONS.silverOrderLines, 'sourceAsin'],
      [ECOBASE_COLLECTIONS.silverOrderLines, 'sourceSupplierSku'],
      [ECOBASE_COLLECTIONS.silverOrderLines, 'productMappingStatus'],
    ]);
  });
});
