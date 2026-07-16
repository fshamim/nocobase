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
  name: ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
  title: 'Silver company product suppliers',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'companyProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProducts,
      foreignKey: 'companyProductId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'supplierProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSupplierProducts,
      foreignKey: 'supplierProductId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'role', type: 'string', allowNull: false },
    { name: 'lastUsedAt', type: 'datetimeTz' },
    { name: 'lastSeenAt', type: 'datetimeTz' },
    { name: 'sourceEvidence', type: 'jsonb', defaultValue: {} },
  ],
  indexes: [
    {
      unique: true,
      fields: ['companyProductId', 'supplierProductId', 'role'],
    },
  ],
});
