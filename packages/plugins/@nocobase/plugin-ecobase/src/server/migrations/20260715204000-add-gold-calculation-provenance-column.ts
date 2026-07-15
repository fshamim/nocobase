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
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

import { Migration } from '@nocobase/server';
import { DataTypes } from 'sequelize';
import { ECOBASE_COLLECTIONS } from '../collections/names';

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    if (!collection) {
      throw new Error('Ecobase calculation-provenance migration failed: Gold collection is unavailable.');
    }
    const tableName = collection.getTableNameWithSchema();
    const queryInterface = this.db.sequelize.getQueryInterface();
    const columns = await queryInterface.describeTable(tableName);
    if (!columns.calculationProvenanceJson) {
      await queryInterface.addColumn(tableName, 'calculationProvenanceJson', {
        type: DataTypes.JSONB,
        allowNull: true,
      });
    }
  }
}
