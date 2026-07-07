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
  name: ECOBASE_COLLECTIONS.silverTasks,
  title: 'Silver tasks',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', unique: true },
    { name: 'sourceConnectionId', type: 'uuid', autoFill: false, index: true },
    { name: 'snapshotDate', type: 'string', index: true },
    { name: 'sourceTaskRef', type: 'string', index: true },
    {
      name: 'parentTask',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverTasks,
      foreignKey: 'parentTaskId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    {
      name: 'sourceComment',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverActivityComments,
      foreignKey: 'sourceCommentId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'taskName', type: 'string' },
    { name: 'description', type: 'text' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'open' },
    { name: 'priority', type: 'string' },
    { name: 'assignee', type: 'string' },
    { name: 'assigneeEmail', type: 'string' },
    { name: 'operationalArea', type: 'string', index: true },
    { name: 'dueDate', type: 'string', index: true },
    { name: 'dueAt', type: 'datetimeTz' },
    { name: 'updatedAtSource', type: 'datetimeTz', index: true },
    { name: 'lastMeaningfulUpdateAt', type: 'datetimeTz', index: true },
    { name: 'workspaceId', type: 'string', index: true },
    { name: 'workspaceName', type: 'string' },
    { name: 'listId', type: 'string', index: true },
    { name: 'listName', type: 'string' },
    { name: 'url', type: 'string' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
    { name: 'assignedToUserId', type: 'uuid', autoFill: false },
    { name: 'assignedToAiEmployeeId', type: 'uuid', autoFill: false },
  ],
});
