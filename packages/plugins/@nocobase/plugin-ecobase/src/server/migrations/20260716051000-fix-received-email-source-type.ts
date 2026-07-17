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
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.silverSuppliers);
    const fields = this.db.getRepository('fields');
    if (!collection || !fields) {
      throw new Error('Ecobase received-email migration failed: supplier collection metadata is unavailable.');
    }

    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    await this.db.sequelize.transaction(async (transaction: unknown) => {
      const table = await queryInterface.describeTable(tableName, { transaction });
      if (table.receivedEmail) {
        await queryInterface.changeColumn(tableName, 'receivedEmail', { type: DataTypes.TEXT }, { transaction });
      }
      await fields.update({
        filter: { collectionName: ECOBASE_COLLECTIONS.silverSuppliers, name: 'receivedEmail' },
        values: { type: 'text', interface: 'textarea' },
        transaction,
      });
    });
  }
}
