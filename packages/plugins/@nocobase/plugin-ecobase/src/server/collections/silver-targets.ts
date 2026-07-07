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
  name: ECOBASE_COLLECTIONS.silverTargets,
  title: 'Silver targets',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', unique: true },
    { name: 'sourceConnectionId', type: 'uuid', autoFill: false, index: true },
    { name: 'recordKind', type: 'string', allowNull: false, defaultValue: 'target', index: true },
    { name: 'entityType', type: 'string', allowNull: false },
    { name: 'entityId', type: 'uuid', autoFill: false },
    { name: 'metric', type: 'string', allowNull: false },
    { name: 'periodType', type: 'string', allowNull: false },
    { name: 'periodStart', type: 'string' },
    { name: 'periodEnd', type: 'string' },
    { name: 'targetValue', type: 'double' },
    { name: 'currentValue', type: 'double' },
    { name: 'progressPercent', type: 'double', index: true },
    { name: 'snapshotDate', type: 'string', index: true },
    { name: 'sourceTargetRef', type: 'string', index: true },
    { name: 'parentTargetId', type: 'uuid', autoFill: false, index: true },
    { name: 'metricName', type: 'string' },
    { name: 'company', type: 'string', index: true },
    { name: 'title', type: 'string' },
    { name: 'owner', type: 'string', index: true },
    { name: 'operationalArea', type: 'string', index: true },
    { name: 'period', type: 'string', index: true },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'active' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
