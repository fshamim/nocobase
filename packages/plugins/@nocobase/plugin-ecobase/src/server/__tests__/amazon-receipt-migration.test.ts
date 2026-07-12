/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import AmazonReceiptMigration from '../migrations/20260712160000-add-amazon-receipt-state';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type FieldRecord = Record<string, unknown> & { collectionName: string; name: string };

describe('Amazon receipt-state migration', () => {
  it('adds nullable receipt fields once without changing existing status fields', async () => {
    const fields: FieldRecord[] = [
      {
        collectionName: ECOBASE_COLLECTIONS.silverOrders,
        name: 'canonicalStatus',
        type: 'string',
      },
    ];
    const fieldRepo = {
      findOne: async ({ filter }: { filter: { collectionName: string; name: string } }) =>
        fields.find((field) => field.collectionName === filter.collectionName && field.name === filter.name),
      create: async ({ values }: { values: FieldRecord }) => {
        fields.push(values);
        return values;
      },
    };
    const migration = new AmazonReceiptMigration({
      db: { getRepository: (name: string) => (name === 'fields' ? fieldRepo : undefined) },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();
    await migration.up();

    expect(fields.filter((field) => field.name.startsWith('amazonReceipt'))).toHaveLength(15);
    expect(fields).toContainEqual({
      collectionName: ECOBASE_COLLECTIONS.silverOrderLines,
      name: 'amazonReceiptStatus',
      type: 'string',
      interface: 'input',
      allowNull: true,
      index: true,
      uiSchema: { title: 'Amazon Receipt Status' },
    });
    expect(fields).toContainEqual({
      collectionName: ECOBASE_COLLECTIONS.silverOrders,
      name: 'amazonReceiptStatus',
      type: 'string',
      interface: 'input',
      allowNull: true,
      index: true,
      uiSchema: { title: 'Amazon Receipt Status' },
    });
    expect(fields.find((field) => field.name === 'canonicalStatus')).toEqual({
      collectionName: ECOBASE_COLLECTIONS.silverOrders,
      name: 'canonicalStatus',
      type: 'string',
    });
  });

  it('fails explicitly when collection metadata is unavailable', async () => {
    const migration = new AmazonReceiptMigration({
      db: { getRepository: () => undefined },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await expect(migration.up()).rejects.toThrow(
      'Ecobase Amazon receipt-state migration failed: fields repository is unavailable.',
    );
  });
});
