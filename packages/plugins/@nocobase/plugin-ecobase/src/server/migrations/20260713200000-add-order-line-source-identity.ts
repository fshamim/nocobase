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

const ORDER_LINE_SOURCE_FIELDS = [
  {
    name: 'sourceAsin',
    type: 'string',
    interface: 'input',
    uiSchema: { title: 'Source ASIN' },
  },
  {
    name: 'sourceSupplierSku',
    type: 'string',
    interface: 'input',
    uiSchema: { title: 'Source supplier SKU' },
  },
  {
    name: 'productMappingStatus',
    type: 'string',
    interface: 'select',
    allowNull: false,
    defaultValue: 'resolved',
    uiSchema: {
      title: 'Product mapping status',
      enum: [
        { label: 'Resolved', value: 'resolved', color: 'green' },
        { label: 'Unresolved', value: 'unresolved', color: 'orange' },
      ],
    },
  },
] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fieldRepo = this.db.getRepository('fields');
    if (!fieldRepo) {
      throw new Error('Ecobase order-line source identity migration failed: fields repository is unavailable.');
    }

    for (const field of ORDER_LINE_SOURCE_FIELDS) {
      const existing = await fieldRepo.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.silverOrderLines, name: field.name },
      });
      if (!existing) {
        await fieldRepo.create({ values: { collectionName: ECOBASE_COLLECTIONS.silverOrderLines, ...field } });
      }
    }
  }
}
