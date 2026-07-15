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
    if (!fields)
      throw new Error('Ecobase product-planning overrides migration failed: fields repository is unavailable.');
    for (const field of [
      { name: 'planningExcluded', type: 'boolean', interface: 'checkbox', allowNull: false, defaultValue: false },
      { name: 'reorderCycleDays', type: 'integer', interface: 'integer' },
      { name: 'targetCoverDays', type: 'integer', interface: 'integer' },
      { name: 'excludedReason', type: 'text', interface: 'textarea' },
      { name: 'excludedAt', type: 'datetimeTz', interface: 'datetime' },
      { name: 'excludedByUserId', type: 'bigInt', interface: 'integer' },
      { name: 'planningOverrideReason', type: 'text', interface: 'textarea' },
      { name: 'planningOverrideAt', type: 'datetimeTz', interface: 'datetime' },
      { name: 'planningOverrideByUserId', type: 'bigInt', interface: 'integer' },
    ]) {
      const existing = await fields.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.silverCompanyProducts, name: field.name },
      });
      if (!existing) {
        await fields.create({ values: { collectionName: ECOBASE_COLLECTIONS.silverCompanyProducts, ...field } });
      }
    }
  }
}
