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
    name: 'receivingBufferDays',
    type: 'integer',
    interface: 'integer',
    allowNull: false,
    defaultValue: 3,
    uiSchema: { title: 'Receiving buffer days' },
  },
  {
    name: 'defaultExpectedArrivalLeadTimeDays',
    type: 'integer',
    interface: 'integer',
    allowNull: false,
    defaultValue: 30,
    uiSchema: { title: 'Default expected-arrival lead time days' },
  },
  {
    name: 'enableCurrentOrderCycleSelection',
    type: 'boolean',
    interface: 'checkbox',
    allowNull: false,
    defaultValue: false,
    uiSchema: { title: 'Enable current order-cycle selection' },
  },
  {
    name: 'allowDefaultExpectedArrival',
    type: 'boolean',
    interface: 'checkbox',
    allowNull: false,
    defaultValue: false,
    uiSchema: { title: 'Allow default expected-arrival derivation' },
  },
] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fields = this.db.getRepository('fields');
    if (!fields) throw new Error('Ecobase inventory stabilization migration failed: fields repository is unavailable.');
    for (const field of FIELDS) {
      const existing = await fields.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.planningSettings, name: field.name },
      });
      if (!existing) {
        await fields.create({ values: { collectionName: ECOBASE_COLLECTIONS.planningSettings, ...field } });
      }
    }
  }
}
