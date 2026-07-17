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
  name: ECOBASE_COLLECTIONS.planningSettings,
  title: 'EcoBase planning settings',
  fields: [
    { name: 'id', type: 'uuid', interface: 'input', uiSchema: { title: 'ID' }, primaryKey: true },
    { name: 'name', type: 'string', interface: 'input', uiSchema: { title: 'Name' }, allowNull: false, index: true },
    {
      name: 'isActive',
      type: 'boolean',
      interface: 'checkbox',
      uiSchema: { title: 'Active' },
      defaultValue: true,
      index: true,
    },
    {
      name: 'safetyBufferDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Safety buffer days' },
      allowNull: false,
    },
    {
      name: 'reorderCycleDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Reorder cycle days' },
      allowNull: false,
    },
    {
      name: 'targetCoverDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Target cover days' },
      allowNull: false,
      defaultValue: 45,
    },
    {
      name: 'orderSoonWindowDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Order-soon window days' },
      allowNull: false,
    },
    {
      name: 'leadTimeFreshnessDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Lead-time freshness days' },
      allowNull: false,
    },
    {
      name: 'purchasedPipelineGraceDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Purchased pipeline grace days' },
      allowNull: false,
    },
    {
      name: 'defaultSupplierLeadTimeDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Default supplier lead time days' },
      allowNull: false,
      defaultValue: 30,
    },
    {
      name: 'fbaReceivingBufferDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'FBA receiving buffer days' },
      allowNull: false,
      defaultValue: 7,
    },
    {
      name: 'enableCurrentOrderCycleSelection',
      type: 'boolean',
      interface: 'checkbox',
      uiSchema: { title: 'Enable current order-cycle selection' },
      allowNull: false,
      defaultValue: false,
    },
    {
      name: 'profitTierAThreshold',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Profit tier A threshold' },
      allowNull: false,
    },
    {
      name: 'profitTierBThreshold',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Profit tier B threshold' },
      allowNull: false,
    },
    {
      name: 'profitTierCThreshold',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Profit tier C threshold' },
      allowNull: false,
    },
    {
      name: 'supplierOrderPlacedNotPurchasedStatuses',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Supplier order placed-not-purchased statuses' },
      defaultValue: [],
    },
    {
      name: 'supplierOrderPurchasedPipelineStatuses',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Supplier order purchased-pipeline statuses' },
      defaultValue: [],
    },
    {
      name: 'supplierOrderClosedStatuses',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Supplier order closed statuses' },
      defaultValue: [],
    },
    { name: 'updatedBy', type: 'string', interface: 'input', uiSchema: { title: 'Updated By' } },
    { name: 'createdAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Created At' }, index: true },
    { name: 'updatedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Updated At' }, index: true },
  ],
});
