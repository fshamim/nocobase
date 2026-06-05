import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.reportItems,
  title: 'Ecobase report items',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'reportRunId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    {
      name: 'reportRun',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.reportRuns,
      foreignKey: 'reportRunId',
      onDelete: 'CASCADE',
    },
    { name: 'itemType', type: 'string', allowNull: false, index: true },
    { name: 'severity', type: 'string', allowNull: false, defaultValue: 'info', index: true },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'body', type: 'text', allowNull: false },
    { name: 'evidenceRefType', type: 'string', index: true },
    { name: 'evidenceRefId', type: 'string', index: true },
    { name: 'evidence', type: 'jsonb', defaultValue: {} },
    { name: 'sortOrder', type: 'integer', allowNull: false, defaultValue: 0 },
  ],
});
