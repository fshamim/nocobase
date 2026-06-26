import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverActivityComments,
  title: 'Silver activity comments',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'entityType', type: 'string', allowNull: false },
    { name: 'entityId', type: 'uuid', allowNull: false, autoFill: false },
    { name: 'actorType', type: 'string', allowNull: false },
    { name: 'actorUserId', type: 'uuid', autoFill: false },
    { name: 'actorAiEmployeeId', type: 'uuid', autoFill: false },
    { name: 'commentType', type: 'string', allowNull: false },
    { name: 'body', type: 'text', allowNull: false },
    { name: 'followUpAt', type: 'datetimeTz' },
    { name: 'deletedAt', type: 'datetimeTz' },
    { name: 'deletedByUserId', type: 'uuid', autoFill: false },
    { name: 'contextSnapshotJson', type: 'jsonb' },
    { name: 'workflowDetectionStatus', type: 'string', allowNull: false, defaultValue: 'none' },
  ],
});
