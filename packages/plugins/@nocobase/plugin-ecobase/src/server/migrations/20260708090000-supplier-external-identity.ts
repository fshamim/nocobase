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

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.silverSuppliers);
    if (!collection) return;

    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    const indexes = await queryInterface.showIndex(tableName);

    for (const index of indexes) {
      const fields = (index.fields ?? []).map(
        (field: { attribute?: string; name?: string }) => field.attribute ?? field.name,
      );
      if (index.unique === true && fields.length === 1 && fields[0] === 'normalizedName') {
        await queryInterface.removeIndex(tableName, index.name);
      }
    }

    await this.db.getRepository('fields').update({
      filter: { collectionName: ECOBASE_COLLECTIONS.silverSuppliers, name: 'normalizedName' },
      values: { unique: false },
    });
  }
}
