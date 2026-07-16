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
    { name: 'primaryEmail', type: 'string' },
    { name: 'additionalEmails', type: 'jsonb', defaultValue: [] },
    { name: 'primaryPhone', type: 'string' },
    { name: 'additionalPhones', type: 'jsonb', defaultValue: [] },
    { name: 'contactNotes', type: 'text' },
    { name: 'supplierUrl', type: 'text' },
    { name: 'country', type: 'string' },
    { name: 'market', type: 'string' },
    { name: 'currency', type: 'string' },
    { name: 'activeStatus', type: 'string' },
    { name: 'supplierType', type: 'string' },
    { name: 'reachedVia', type: 'string' },
    { name: 'receivedEmail', type: 'text' },
    { name: 'designation', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'amazonAllowed', type: 'boolean' },
    { name: 'lastAnalysedBy', type: 'string' },
    { name: 'trackingStatus', type: 'string' },
    { name: 'dateOfUpdate', type: 'dateOnly' },
    { name: 'analysisProgress', type: 'string' },
    { name: 'remarksAnalysed', type: 'text' },
    { name: 'sourceEvidence', type: 'jsonb', defaultValue: {} },
  ],
});
