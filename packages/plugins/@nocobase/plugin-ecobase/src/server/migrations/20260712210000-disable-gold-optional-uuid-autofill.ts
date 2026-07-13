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

const OPTIONAL_UUID_FIELDS = {
  familyPreferredSupplierId: 'Family Supplier',
  familyPreferredSupplierProductId: 'Family Supplier Product',
} as const;

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const repository = this.db.getRepository('fields');
    for (const [name, title] of Object.entries(OPTIONAL_UUID_FIELDS)) {
      const field = await repository.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name },
      });
      if (!field) continue;
      const record = typeof field.toJSON === 'function' ? field.toJSON() : field;
      const options = (typeof field.get === 'function' ? field.get('options') : record.options) ?? {};
      await repository.update({
        filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name },
        values: {
          options: {
            ...options,
            autoFill: false,
            uiSchema: { ...(options.uiSchema ?? {}), title },
          },
        },
      });
    }
  }
}
