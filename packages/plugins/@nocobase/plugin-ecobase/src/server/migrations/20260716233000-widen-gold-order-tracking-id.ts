/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';
import { DataTypes } from 'sequelize';
import { ECOBASE_COLLECTIONS } from '../collections/names';

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.goldOrderPlanningRows);
    if (!collection) {
      throw new Error('Ecobase Gold tracking-ID migration failed: Gold order planning rows collection is missing.');
    }
    const queryInterface = this.db.sequelize.getQueryInterface();
    await this.db.sequelize.transaction(async (transaction) => {
      await queryInterface.changeColumn(
        collection.getTableNameWithSchema(),
        'trackingId',
        { type: DataTypes.TEXT },
        { transaction },
      );
      await this.db.getRepository('fields').update({
        filter: { collectionName: ECOBASE_COLLECTIONS.goldOrderPlanningRows, name: 'trackingId' },
        values: { type: 'text', length: null },
        transaction,
      });
    });
  }
}
