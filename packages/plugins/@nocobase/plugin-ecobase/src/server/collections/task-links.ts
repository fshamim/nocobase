import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.taskLinks,
  title: 'Ecobase task links',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'externalTaskId', type: 'string', allowNull: false, index: true },
    { name: 'clickupTaskSnapshotId', type: 'uuid', autoFill: false, index: true },
    { name: 'targetType', type: 'string', allowNull: false, index: true },
    { name: 'planningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'supplierOrderId', type: 'uuid', autoFill: false, index: true },
    { name: 'okrId', type: 'uuid', autoFill: false, index: true },
    { name: 'generalCategory', type: 'string', index: true },
    { name: 'confidence', type: 'double', allowNull: false, defaultValue: 1 },
    { name: 'evidence', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
