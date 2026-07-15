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

const FIELDS = [
  {
    name: 'supplierOrderCycleSelection',
    type: 'jsonb',
    interface: 'json',
    defaultValue: {},
    uiSchema: { title: 'Supplier Order Cycle Selection' },
  },
  {
    name: 'supplierOrderCycleReviewRequired',
    type: 'boolean',
    interface: 'checkbox',
    defaultValue: false,
    index: true,
    uiSchema: { title: 'Supplier Order Cycle Review Required' },
  },
] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fields = this.db.getRepository('fields');
    if (!fields) throw new Error('Ecobase order-cycle migration failed: fields repository is unavailable.');
    for (const field of FIELDS) {
      const existing = await fields.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name: field.name },
      });
      if (!existing) {
        await fields.create({
          values: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, ...field },
        });
      }
    }
  }
}
