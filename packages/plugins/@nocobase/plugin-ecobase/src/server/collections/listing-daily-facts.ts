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
  name: ECOBASE_COLLECTIONS.listingDailyFacts,
  title: 'Ecobase listing daily facts',
  fields: [
    {
      name: 'naturalKey',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Natural Key' },
      allowNull: false,
      unique: true,
    },
    {
      name: 'sourceConnectionId',
      type: 'uuid',
      interface: 'input',
      uiSchema: { title: 'Source Connection ID' },
      allowNull: false,
      autoFill: false,
      index: true,
    },
    {
      name: 'planningProductId',
      type: 'uuid',
      interface: 'input',
      uiSchema: { title: 'Planning Product ID' },
      autoFill: false,
      index: true,
    },
    {
      name: 'snapshotDate',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Snapshot Date' },
      allowNull: false,
      index: true,
    },
    { name: 'company', type: 'string', interface: 'input', uiSchema: { title: 'Company' }, index: true },
    { name: 'asin', type: 'string', interface: 'input', uiSchema: { title: 'ASIN' }, index: true },
    { name: 'sku', type: 'string', interface: 'input', uiSchema: { title: 'SKU' }, index: true },
    { name: 'sales', type: 'double', interface: 'number', uiSchema: { title: 'Sales' } },
    { name: 'units', type: 'double', interface: 'number', uiSchema: { title: 'Units' } },
    { name: 'refunds', type: 'double', interface: 'number', uiSchema: { title: 'Refunds' } },
    { name: 'refundRate', type: 'double', interface: 'number', uiSchema: { title: 'Refund Rate' } },
    { name: 'grossProfit', type: 'double', interface: 'number', uiSchema: { title: 'Gross Profit' } },
    { name: 'netProfit', type: 'double', interface: 'number', uiSchema: { title: 'Net Profit' } },
    { name: 'margin', type: 'double', interface: 'number', uiSchema: { title: 'Margin' } },
    { name: 'profitPerUnit', type: 'double', interface: 'number', uiSchema: { title: 'Profit Per Unit' } },
    { name: 'sessions', type: 'double', interface: 'number', uiSchema: { title: 'Sessions' } },
    {
      name: 'unitSessionPercentage',
      type: 'double',
      interface: 'number',
      uiSchema: { title: 'Unit Session Percentage' },
    },
    { name: 'sourceKey', type: 'string', interface: 'input', uiSchema: { title: 'Source Key' } },
    { name: 'payload', type: 'jsonb', interface: 'json', uiSchema: { title: 'Payload' }, defaultValue: {} },
    {
      name: 'lastImportRunId',
      type: 'uuid',
      interface: 'input',
      uiSchema: { title: 'Last Import Run ID' },
      autoFill: false,
      index: true,
    },
  ],
});
