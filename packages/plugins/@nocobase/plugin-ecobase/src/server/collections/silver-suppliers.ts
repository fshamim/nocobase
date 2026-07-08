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
  name: ECOBASE_COLLECTIONS.silverSuppliers,
  title: 'Silver suppliers',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'normalizedName', type: 'string', allowNull: false },
    { name: 'displayName', type: 'string', allowNull: false },
    { name: 'approvalStatus', type: 'string', allowNull: false, defaultValue: 'new' },
    { name: 'analysisStatus', type: 'string' },
    { name: 'accountStatus', type: 'string' },
    { name: 'contactName', type: 'string' },
    { name: 'email', type: 'string' },
    { name: 'phone', type: 'string' },
    { name: 'website', type: 'text' },
    { name: 'preferredContactMethod', type: 'string' },
    { name: 'nextFollowUpAt', type: 'datetimeTz' },
    { name: 'lastContactedAt', type: 'datetimeTz' },
  ],
});
