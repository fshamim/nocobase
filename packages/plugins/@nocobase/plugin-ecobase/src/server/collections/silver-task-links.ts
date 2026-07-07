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
  name: ECOBASE_COLLECTIONS.silverTaskLinks,
  title: 'Silver task links',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', unique: true },
    { name: 'sourceConnectionId', type: 'uuid', autoFill: false, index: true },
    { name: 'sourceTaskRef', type: 'string', index: true },
    {
      name: 'task',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverTasks,
      foreignKey: 'taskId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'entityType', type: 'string', allowNull: false },
    { name: 'entityId', type: 'uuid', autoFill: false },
    { name: 'relation', type: 'string', allowNull: false, defaultValue: 'related' },
    { name: 'targetType', type: 'string', index: true },
    { name: 'planningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'supplierOrderId', type: 'uuid', autoFill: false, index: true },
    { name: 'targetId', type: 'uuid', autoFill: false, index: true },
    { name: 'generalCategory', type: 'string', index: true },
    { name: 'confidence', type: 'double', allowNull: false, defaultValue: 1 },
    { name: 'evidence', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
