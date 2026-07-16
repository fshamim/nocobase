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
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverSupplierAccounts,
  title: 'Silver supplier accounts',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'supplier',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSuppliers,
      foreignKey: 'supplierId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'accountName', type: 'string', allowNull: false },
    { name: 'orderingMethod', type: 'string', allowNull: false, defaultValue: 'email' },
    { name: 'portalUrl', type: 'text' },
    { name: 'username', type: 'string' },
    { name: 'secretRef', type: 'string' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'active' },
    { name: 'accountType', type: 'string' },
    { name: 'market', type: 'string' },
    { name: 'loginUsername', type: 'string' },
    { name: 'loginSecretRef', type: 'string' },
    { name: 'contactName', type: 'string' },
    { name: 'email', type: 'string' },
    { name: 'phone', type: 'string' },
    { name: 'preferredContactMethod', type: 'string' },
    { name: 'metadata', type: 'jsonb', defaultValue: {} },
  ],
});
