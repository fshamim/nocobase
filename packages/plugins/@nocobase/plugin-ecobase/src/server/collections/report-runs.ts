import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.reportRuns,
  title: 'Ecobase report runs',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'company', type: 'string', index: true },
    { name: 'frequency', type: 'string', allowNull: false, index: true },
    { name: 'periodStart', type: 'string', allowNull: false, index: true },
    { name: 'periodEnd', type: 'string', allowNull: false, index: true },
    { name: 'status', type: 'string', allowNull: false, index: true },
    { name: 'emailStatus', type: 'string', allowNull: false, index: true },
    { name: 'emailEnabled', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'emailRecipient', type: 'string' },
    { name: 'generatedAt', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'executiveSummary', type: 'text' },
    { name: 'summary', type: 'jsonb', defaultValue: {} },
    { name: 'warnings', type: 'jsonb', defaultValue: [] },
    {
      name: 'items',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.reportItems,
      foreignKey: 'reportRunId',
      onDelete: 'CASCADE',
    },
  ],
});
