/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  loadedFromCollectionManager: true,
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.sellerboardProductCosts,
  title: 'Sellerboard product costs',
  fields: [
    { name: 'id', type: 'uuid', interface: 'input', uiSchema: { title: 'ID' }, primaryKey: true },
    {
      name: 'naturalKey',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Natural Key' },
      allowNull: false,
      unique: true,
    },
    {
      name: 'company',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Company' },
      allowNull: false,
      index: true,
    },
    { name: 'asin', type: 'string', interface: 'input', uiSchema: { title: 'ASIN' }, allowNull: false, index: true },
    { name: 'sku', type: 'string', interface: 'input', uiSchema: { title: 'SKU' }, allowNull: false, index: true },
    { name: 'title', type: 'text', interface: 'textarea', uiSchema: { title: 'Title' } },
    { name: 'costPeriodStartDate', type: 'dateOnly', interface: 'date', uiSchema: { title: 'Cost Period Start' } },
    { name: 'unitCost', type: 'double', interface: 'number', uiSchema: { title: 'Unit Cost' }, allowNull: false },
    { name: 'marketplace', type: 'string', interface: 'input', uiSchema: { title: 'Marketplace' } },
    { name: 'sourceFile', type: 'string', interface: 'input', uiSchema: { title: 'Source File' } },
    { name: 'importedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Imported At' } },
    { name: 'rawPayload', type: 'jsonb', interface: 'json', uiSchema: { title: 'Raw Payload' }, defaultValue: {} },
  ],
});
