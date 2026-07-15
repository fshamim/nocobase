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
    const settings = this.db.getRepository(ECOBASE_COLLECTIONS.planningSettings);
    if (!fields || !settings) {
      throw new Error('Ecobase FBA receiving-buffer migration failed: required repositories are unavailable.');
    }

    const existing = await fields.findOne({
      filter: { collectionName: ECOBASE_COLLECTIONS.planningSettings, name: 'fbaReceivingBufferDays' },
    });
    if (!existing) {
      await fields.create({
        values: {
          collectionName: ECOBASE_COLLECTIONS.planningSettings,
          name: 'fbaReceivingBufferDays',
          type: 'integer',
          interface: 'integer',
          defaultValue: 7,
        },
      });
    }

    for (const record of await settings.find({ limit: 1000 })) {
      const values = record?.toJSON?.() ?? record ?? {};
      if (values.fbaReceivingBufferDays == null && values.receivingBufferDays != null) {
        await settings.update({
          filterByTk: values.id,
          values: { fbaReceivingBufferDays: values.receivingBufferDays },
        });
      }
    }

    for (const name of ['receivingBufferDays', 'defaultExpectedArrivalLeadTimeDays', 'allowDefaultExpectedArrival']) {
      this.db.getCollection(ECOBASE_COLLECTIONS.planningSettings)?.removeField(name);
      await fields.destroy({ filter: { collectionName: ECOBASE_COLLECTIONS.planningSettings, name } });
    }
  }
}
