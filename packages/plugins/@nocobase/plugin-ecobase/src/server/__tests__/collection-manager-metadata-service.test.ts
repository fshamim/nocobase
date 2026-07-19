/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import goldInventoryPlanningRows from '../collections/gold-inventory-planning-rows';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import {
  ensureEcobaseCollectionManagerMetadata,
  HIDDEN_OPERATOR_COLLECTIONS,
  OPERATOR_DASHBOARD_COLLECTIONS,
} from '../services/collection-manager-metadata-service';

describe('ensureEcobaseCollectionManagerMetadata', () => {
  it('does not expose raw inventory-planning Gold in Collection Manager', () => {
    expect(OPERATOR_DASHBOARD_COLLECTIONS).not.toContain(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    expect(HIDDEN_OPERATOR_COLLECTIONS).toContain(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    expect(goldInventoryPlanningRows).toMatchObject({ hidden: true });
  });

  it('marks existing raw Gold metadata hidden without deleting the collection', async () => {
    const updates: Record<string, unknown>[] = [];
    const collectionsRepository = {
      async findOne(options: { filter: { name: string } }) {
        return options.filter.name === ECOBASE_COLLECTIONS.goldInventoryPlanningRows ? {} : null;
      },
      async find() {
        return [];
      },
      async create() {
        return {};
      },
      async update(options: Record<string, unknown>) {
        updates.push(options);
        return {};
      },
    };
    const fieldsRepository = {
      ...collectionsRepository,
      async find() {
        return [];
      },
    };
    const db = {
      getRepository(name: string) {
        if (name === 'collections') return collectionsRepository;
        if (name === 'fields') return fieldsRepository;
        throw new Error(`Repository ${name} is not registered.`);
      },
      getCollection(name: string) {
        return { name, options: { fields: [] } };
      },
    };

    await ensureEcobaseCollectionManagerMetadata(db as never);

    expect(updates).toEqual([
      {
        filter: { name: ECOBASE_COLLECTIONS.goldInventoryPlanningRows },
        values: { hidden: true },
      },
    ]);
  });

  it('skips metadata sync when collection-manager repositories are not installed', async () => {
    const db = {
      getRepository(name: string) {
        throw new Error(`Repository ${name} is not registered.`);
      },
    };

    await expect(ensureEcobaseCollectionManagerMetadata(db as never)).resolves.toBeUndefined();
  });
});
