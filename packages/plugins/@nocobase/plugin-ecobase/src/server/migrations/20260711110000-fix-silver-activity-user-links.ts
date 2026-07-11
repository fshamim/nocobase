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

const USER_FIELDS = ['actorUserId', 'deletedByUserId'];

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.silverActivityComments);
    if (!collection) {
      throw new Error('Ecobase activity-user migration failed: Silver activity comments collection is missing.');
    }

    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    const quotedTable = queryInterface.queryGenerator.quoteTable(tableName);
    await this.db.sequelize.transaction(async (transaction) => {
      for (const field of USER_FIELDS) {
        const quotedField = queryInterface.queryGenerator.quoteIdentifier(field);
        const [[result]] = await this.db.sequelize.query(
          `SELECT COUNT(*)::int AS count FROM ${quotedTable} WHERE ${quotedField} IS NOT NULL`,
          { transaction },
        );
        if (Number(result.count) > 0) {
          throw new Error(
            `Ecobase activity-user migration failed: ${field} contains legacy UUID values that cannot link NocoBase users.`,
          );
        }
        await this.db.sequelize.query(
          `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} TYPE BIGINT USING CASE WHEN ${quotedField} IS NULL THEN NULL ELSE ${quotedField}::text::bigint END`,
          { transaction },
        );
      }
      await this.db.getRepository('fields').update({
        filter: { collectionName: ECOBASE_COLLECTIONS.silverActivityComments, name: USER_FIELDS },
        values: { type: 'bigInt' },
        transaction,
      });
    });
  }
}
