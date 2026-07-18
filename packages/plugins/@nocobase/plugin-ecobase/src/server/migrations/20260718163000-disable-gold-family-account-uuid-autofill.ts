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
    const repository = this.db.getRepository('fields');
    const filter = {
      collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
      name: 'familyAmazonAccountId',
    };
    const field = await repository.findOne({ filter });
    if (!field) return;
    const record = typeof field.toJSON === 'function' ? field.toJSON() : field;
    const options = (typeof field.get === 'function' ? field.get('options') : record.options) ?? {};
    await repository.update({
      filter,
      values: {
        options: {
          ...options,
          autoFill: false,
          uiSchema: { ...(options.uiSchema ?? {}), title: 'Family Amazon Account' },
        },
      },
    });
  }
}
