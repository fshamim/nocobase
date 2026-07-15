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
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fields = this.db.getRepository('fields');
    if (!fields) throw new Error('Ecobase supplier-order stale migration failed: fields repository is unavailable.');
    const existing = await fields.findOne({
      filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name: 'supplierOrderStale' },
    });
    if (!existing) {
      await fields.create({
        values: {
          collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
          name: 'supplierOrderStale',
          type: 'boolean',
          interface: 'checkbox',
          defaultValue: false,
          index: true,
          uiSchema: { title: 'Supplier Order Stale' },
        },
      });
    }
  }
}
