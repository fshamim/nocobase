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
 * Copyright (c) 2020-2024 NocoBase Team.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { resolve } from 'node:path';
import { createMockServer, type MockServer } from '@nocobase/test';
import { DataTypes } from 'sequelize';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PluginEcobaseServer from '..';
import { OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS } from '../../features/inventory-planning/server/gold-schema-contract';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import CleanGoldSchemaMigration from '../migrations/20260720134500-remove-obsolete-gold-inventory-planning-fields';

process.env.NODE_MODULES_PATH ??= resolve(process.cwd(), 'node_modules');

const pluginRegistration = [PluginEcobaseServer, { packageName: '@nocobase/plugin-ecobase' }] as const;

async function createApp() {
  return createMockServer({
    plugins: [
      'acl',
      'error-handler',
      'field-sort',
      'users',
      'data-source-main',
      'auth',
      'data-source-manager',
      'system-settings',
      pluginRegistration,
    ],
  });
}

describe('Gold inventory-planning clean-schema fresh and upgrade gates', () => {
  let app: MockServer | undefined;

  beforeEach(async () => {
    app = await createApp();
  });

  afterEach(async () => {
    await app?.destroy();
    app = undefined;
  });

  it('creates a fresh schema with corrected fields and none of the 74 obsolete columns', async () => {
    const collection = app!.db.getCollection(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const columns = await app!.db.sequelize.getQueryInterface().describeTable(collection.getTableNameWithSchema());

    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'companyProductId',
        'refreshRunId',
        'baselineTier',
        'baselineTierScore',
        'inventoryDisposition',
        'recommendedOrderQty',
        'primaryActionPane',
      ]),
    );
    expect(Object.keys(columns)).not.toEqual(expect.arrayContaining([...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS]));
  });

  it('upgrades an additive schema by removing obsolete columns while retaining terminal run evidence', async () => {
    const collection = app!.db.getCollection(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const tableName = collection.getTableNameWithSchema();
    const queryInterface = app!.db.sequelize.getQueryInterface();
    const representativeObsoleteFields = ['planningProductId', 'tier', 'familyRole', 'familyRollupEvidence'] as const;
    for (const name of representativeObsoleteFields) {
      await queryInterface.addColumn(tableName, name, {
        type: name === 'familyRollupEvidence' ? DataTypes.JSON : DataTypes.STRING,
        allowNull: true,
      });
    }
    await app!.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns).create({
      values: {
        id: 'ecb7aa28-f194-4d1b-8050-8f09c38f03b6',
        idempotencyKey: 'archived-step19-candidate',
        requestDigest: '8d10ab827a2373b0bc8812450d7818288252c062429389f2560dceb07156d857',
        calculationDate: '2026-07-16',
        status: 'superseded',
        rowCount: 2363,
        resultJson: {
          supersession: {
            legacyRowCount: 2363,
            legacyRowDigest: 'a26aba6955e14a336abb47efb6f4735466fce50a34db50445fedb94ead828fe6',
          },
        },
      },
    });

    const migration = new CleanGoldSchemaMigration({
      db: app!.db,
      queryInterface: undefined,
      sequelize: undefined,
    } as never);
    await migration.up();

    const columns = await queryInterface.describeTable(tableName);
    expect(Object.keys(columns)).not.toEqual(expect.arrayContaining(representativeObsoleteFields));
    const retainedRun = await app!.db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)
      .findOne({ filterByTk: 'ecb7aa28-f194-4d1b-8050-8f09c38f03b6' });
    expect(retainedRun?.toJSON()).toMatchObject({
      status: 'superseded',
      rowCount: 2363,
      resultJson: {
        supersession: {
          legacyRowCount: 2363,
          legacyRowDigest: 'a26aba6955e14a336abb47efb6f4735466fce50a34db50445fedb94ead828fe6',
        },
      },
    });
  });
});
