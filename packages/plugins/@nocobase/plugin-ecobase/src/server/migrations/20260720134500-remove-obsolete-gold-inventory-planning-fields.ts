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

import { Migration } from '@nocobase/server';
import { OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS } from '../../features/inventory-dashboard/server/engine/gold-schema-contract';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const PUBLICATION_CAPABLE_STATUSES = ['requested', 'running', 'materialized', 'verified', 'published'] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const rows = this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const runs = this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns);
    const fields = this.db.getRepository('fields');
    const sequelize = this.db.sequelize;
    if (!collection || !rows || !runs || !fields || !sequelize?.transaction) {
      throw new Error('EcoBase obsolete Gold-field cleanup requires its collection, repositories, and transaction.');
    }

    const queryInterface = sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    await sequelize.transaction(async (transaction: unknown) => {
      const rowCount = await rows.count({ transaction });
      if (rowCount !== 0) {
        throw new Error(`EcoBase obsolete Gold-field cleanup requires zero Gold rows; found ${rowCount}.`);
      }
      const publicationCapableRunCount = await runs.count({
        filter: { status: { $in: [...PUBLICATION_CAPABLE_STATUSES] } },
        transaction,
      });
      if (publicationCapableRunCount !== 0) {
        throw new Error(
          `EcoBase obsolete Gold-field cleanup requires zero publication-capable runs; found ${publicationCapableRunCount}.`,
        );
      }

      await fields.destroy({
        filter: {
          collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
          name: { $in: [...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS] },
        },
        transaction,
      });
      const columns = await queryInterface.describeTable(tableName, { transaction });
      for (const name of OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS) {
        if (columns[name]) await queryInterface.removeColumn(tableName, name, { transaction });
      }
    });

    for (const name of OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS) collection.removeField(name);
  }
}
