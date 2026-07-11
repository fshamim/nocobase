/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const FIELD = 'unitCostStatus';

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    if (!collection) return;

    collection.removeField(FIELD);
    await this.db.getRepository('fields').destroy({
      filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name: FIELD },
    });
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    const columns = await queryInterface.describeTable(tableName);
    if (columns[FIELD]) await queryInterface.removeColumn(tableName, FIELD);
  }
}
