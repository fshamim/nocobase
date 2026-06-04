import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.importRuns,
  title: 'Ecobase import runs',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'sourceConnection',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.sourceConnections,
      foreignKey: 'sourceConnectionId',
      targetKey: 'id',
      allowNull: false,
      onDelete: 'CASCADE',
    },
    { name: 'adapterName', type: 'string', allowNull: false, index: true },
    { name: 'sourceIdentifier', type: 'string', allowNull: false },
    { name: 'sourceVersion', type: 'string', allowNull: false },
    { name: 'idempotencyKey', type: 'string', allowNull: false, unique: true },
    { name: 'startedAt', type: 'datetimeTz', allowNull: false },
    { name: 'finishedAt', type: 'datetimeTz' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'pending', index: true },
    { name: 'rowCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'normalizedCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'warningCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'errorCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'errorMessage', type: 'text' },
    { name: 'summary', type: 'jsonb', defaultValue: {} },
    {
      name: 'rawImportRows',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.rawImportRows,
      foreignKey: 'importRunId',
      onDelete: 'CASCADE',
    },
  ],
});
