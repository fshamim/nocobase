import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.rawImportRows,
  title: 'Ecobase raw import rows',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'importRun',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.importRuns,
      foreignKey: 'importRunId',
      targetKey: 'id',
      allowNull: false,
      onDelete: 'CASCADE',
    },
    { name: 'rowNumber', type: 'integer', allowNull: false },
    { name: 'sourceKey', type: 'string' },
    { name: 'payload', type: 'jsonb', allowNull: false, defaultValue: {} },
    { name: 'normalizedStatus', type: 'string', allowNull: false, defaultValue: 'pending' },
    { name: 'normalizedError', type: 'text' },
    { name: 'issueSeverity', type: 'string' },
    { name: 'issueCode', type: 'string' },
  ],
});
