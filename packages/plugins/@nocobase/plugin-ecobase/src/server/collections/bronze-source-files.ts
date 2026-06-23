import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.bronzeSourceFiles,
  title: 'Bronze source files',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'sourceConnection',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.sourceConnections,
      foreignKey: 'sourceConnectionId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'importRun',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.importRuns,
      foreignKey: 'importRunId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'fileName', type: 'string', allowNull: false },
    { name: 'fileUrl', type: 'string' },
    { name: 'contentHash', type: 'string', allowNull: false },
    { name: 'uploadedByUserId', type: 'uuid', autoFill: false },
  ],
});
