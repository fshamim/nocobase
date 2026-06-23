import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldReportItems,
  title: 'Gold report items',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'reportRun',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.goldReportRuns,
      foreignKey: 'reportRunId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'severity', type: 'string', allowNull: false },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'body', type: 'text', allowNull: false },
    { name: 'evidenceJson', type: 'jsonb' },
  ],
});
