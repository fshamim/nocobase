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
  { name: 'expectedDateOverrideReason', type: 'text', interface: 'textarea' },
  { name: 'expectedDateOverrideAt', type: 'datetimeTz', interface: 'datetime' },
  { name: 'expectedDateOverrideByUserId', type: 'bigInt', interface: 'integer', autoFill: false },
] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fields = this.db.getRepository('fields');
    if (!fields) throw new Error('Ecobase order-date override migration failed: fields repository is unavailable.');
    for (const field of FIELDS) {
      const existing = await fields.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.silverOrderLines, name: field.name },
      });
      if (!existing) {
        await fields.create({ values: { collectionName: ECOBASE_COLLECTIONS.silverOrderLines, ...field } });
      }
    }
  }
}
