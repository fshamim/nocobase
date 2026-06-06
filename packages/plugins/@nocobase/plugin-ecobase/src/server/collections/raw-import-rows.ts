import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.rawImportRows,
  title: 'Ecobase raw import rows',
  fields: [
    { name: 'id', type: 'uuid', interface: 'input', uiSchema: { title: 'ID' }, primaryKey: true },
    {
      name: 'importRun',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.importRuns,
      foreignKey: 'importRunId',
      targetKey: 'id',
      allowNull: false,
      onDelete: 'CASCADE',
    },
    { name: 'rowNumber', type: 'integer', interface: 'integer', uiSchema: { title: 'Row Number' }, allowNull: false },
    { name: 'sourceKey', type: 'string', interface: 'input', uiSchema: { title: 'Source Key' } },
    {
      name: 'payload',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Payload' },
      allowNull: false,
      defaultValue: {},
    },
    {
      name: 'normalizedStatus',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Normalized Status' },
      allowNull: false,
      defaultValue: 'pending',
    },
    { name: 'normalizedError', type: 'text', interface: 'textarea', uiSchema: { title: 'Normalized Error' } },
    { name: 'issueSeverity', type: 'string', interface: 'input', uiSchema: { title: 'Issue Severity' } },
    { name: 'issueCode', type: 'string', interface: 'input', uiSchema: { title: 'Issue Code' } },
  ],
});
