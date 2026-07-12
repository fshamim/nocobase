/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import GoldReceiptEvidenceMigration from '../migrations/20260712170000-add-gold-receipt-evidence';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type FieldRecord = Record<string, unknown> & { collectionName: string; name: string };

describe('Gold receipt-evidence migration', () => {
  it('adds receipt fields idempotently', async () => {
    const fields: FieldRecord[] = [];
    const migration = new GoldReceiptEvidenceMigration({
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

    expect(fields).toHaveLength(4);
    expect(fields.map((field) => [field.collectionName, field.name])).toEqual([
      [ECOBASE_COLLECTIONS.goldInventoryPlanningRows, 'amazonReceiptStatus'],
      [ECOBASE_COLLECTIONS.goldInventoryPlanningRows, 'amazonReceiptObservedAt'],
      [ECOBASE_COLLECTIONS.goldInventoryPlanningRows, 'amazonReceiptCompletionReason'],
      [ECOBASE_COLLECTIONS.goldInventoryPlanningRows, 'amazonReceiptEvidenceJson'],
    ]);
  });
});
