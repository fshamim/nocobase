import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.clickupTaskSnapshots,
  title: 'Ecobase ClickUp task snapshots',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'snapshotDate', type: 'string', allowNull: false, index: true },
    { name: 'externalTaskId', type: 'string', allowNull: false, index: true },
    { name: 'taskName', type: 'string', allowNull: false },
    { name: 'status', type: 'string', allowNull: false, index: true },
    { name: 'priority', type: 'string', allowNull: false, defaultValue: 'normal', index: true },
    { name: 'assignee', type: 'string', index: true },
    { name: 'assigneeEmail', type: 'string' },
    { name: 'operationalArea', type: 'string', index: true },
    { name: 'dueDate', type: 'string', index: true },
    { name: 'updatedAtSource', type: 'datetimeTz', index: true },
    { name: 'lastMeaningfulUpdateAt', type: 'datetimeTz', index: true },
    { name: 'workspaceId', type: 'string', index: true },
    { name: 'workspaceName', type: 'string' },
    { name: 'listId', type: 'string', index: true },
    { name: 'listName', type: 'string' },
    { name: 'url', type: 'string' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
