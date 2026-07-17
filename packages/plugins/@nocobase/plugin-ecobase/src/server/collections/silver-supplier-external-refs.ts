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
  name: ECOBASE_COLLECTIONS.silverSupplierExternalRefs,
  title: 'Silver supplier external refs',
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
    { name: 'sourceSystem', type: 'string', allowNull: false },
    { name: 'externalSupplierCode', type: 'string', allowNull: false },
    { name: 'normalizedExternalSupplierCode', type: 'string', allowNull: false },
    { name: 'displayName', type: 'string' },
    { name: 'normalizedName', type: 'string' },
    { name: 'sourceConnectionId', type: 'uuid', autoFill: false },
    { name: 'lastSeenAt', type: 'datetimeTz' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'sourceEvidence', type: 'jsonb', defaultValue: {} },
  ],
  indexes: [
    {
      name: 'silver_supplier_external_refs_source_code_uidx',
      unique: true,
      fields: ['sourceSystem', 'normalizedExternalSupplierCode'],
    },
    {
      name: 'silver_supplier_external_refs_supplier_idx',
      fields: ['supplierId'],
    },
  ],
});
