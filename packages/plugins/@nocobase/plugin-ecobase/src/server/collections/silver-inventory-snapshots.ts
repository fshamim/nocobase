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
  name: ECOBASE_COLLECTIONS.silverInventorySnapshots,
  title: 'Silver inventory snapshots',
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
    { name: 'snapshotDate', type: 'string', allowNull: false },
    { name: 'sourceConnectionId', type: 'uuid', index: true },
    { name: 'sellableStock', type: 'double' },
    { name: 'reserved', type: 'double' },
    { name: 'inbound', type: 'double' },
    { name: 'ordered', type: 'double' },
    { name: 'prepStock', type: 'double' },
    { name: 'awdStock', type: 'double' },
    { name: 'salesVelocity', type: 'double' },
  ],
});
