/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import InventoryReceiptEvidenceMigration from '../migrations/20260712163000-add-inventory-receipt-evidence';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type FieldRecord = Record<string, unknown> & { collectionName: string; name: string };

describe('Inventory receipt-evidence migration', () => {
  it('adds source identity and AWD stock fields idempotently', async () => {
    const fields: FieldRecord[] = [];
    const fieldRepo = {
      findOne: async ({ filter }: { filter: { collectionName: string; name: string } }) =>
        fields.find((field) => field.collectionName === filter.collectionName && field.name === filter.name),
      create: async ({ values }: { values: FieldRecord }) => {
        fields.push(values);
        return values;
      },
    };
    const migration = new InventoryReceiptEvidenceMigration({
      db: { getRepository: (name: string) => (name === 'fields' ? fieldRepo : undefined) },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();
    await migration.up();

    expect(fields).toEqual([
      {
        collectionName: ECOBASE_COLLECTIONS.silverInventorySnapshots,
        name: 'sourceConnectionId',
        type: 'uuid',
        interface: 'input',
        index: true,
        uiSchema: { title: 'Source Connection ID' },
      },
      {
        collectionName: ECOBASE_COLLECTIONS.silverInventorySnapshots,
        name: 'awdStock',
        type: 'double',
        interface: 'number',
        uiSchema: { title: 'AWD Stock' },
      },
    ]);
  });
});
