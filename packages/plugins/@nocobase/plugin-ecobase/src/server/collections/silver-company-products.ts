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
  name: ECOBASE_COLLECTIONS.silverCompanyProducts,
  title: 'Silver company products',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'amazonAccount',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverAmazonAccounts,
      foreignKey: 'amazonAccountId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'companyProductFamily',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
      foreignKey: 'companyProductFamilyId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    {
      name: 'product',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverProducts,
      foreignKey: 'productId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'lifecycleStatus', type: 'string', allowNull: false, defaultValue: 'candidate_new_product' },
    // Task 002 (surgical v1.1): who/what set the lifecycle status, with the
    // previous value for full reversibility (e.g. migration_sweep_2026_07).
    { name: 'lifecycleStatusProvenance', type: 'jsonb' },
    { name: 'listingStatus', type: 'string', allowNull: false, defaultValue: 'not_listed' },
    { name: 'planningExcluded', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'reorderCycleDays', type: 'integer' },
    { name: 'targetCoverDays', type: 'integer' },
    { name: 'excludedReason', type: 'text' },
    { name: 'excludedAt', type: 'datetimeTz' },
    { name: 'excludedByUserId', type: 'bigInt' },
    { name: 'planningOverrideReason', type: 'text' },
    { name: 'planningOverrideAt', type: 'datetimeTz' },
    { name: 'planningOverrideByUserId', type: 'bigInt' },
  ],
  indexes: [
    {
      unique: true,
      fields: ['companyId', 'amazonAccountId', 'productId'],
    },
  ],
});
