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
  name: ECOBASE_COLLECTIONS.silverSupplierProducts,
  title: 'Silver supplier products',
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
      name: 'product',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverProducts,
      foreignKey: 'productId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'supplierSku', type: 'string' },
    { name: 'unitCost', type: 'double' },
    { name: 'moq', type: 'double' },
    { name: 'supplierPackSize', type: 'double' },
    { name: 'leadTimeDays', type: 'double' },
    { name: 'prepCapability', type: 'string' },
    { name: 'analysisStatus', type: 'string', allowNull: false, defaultValue: 'not_analyzed' },
    { name: 'lastPriceUpdateDate', type: 'dateOnly' },
    { name: 'mapPrice', type: 'double' },
    { name: 'sourceEvidence', type: 'jsonb', defaultValue: {} },
  ],
  indexes: [
    {
      unique: true,
      fields: ['supplierId', 'productId'],
    },
  ],
});
