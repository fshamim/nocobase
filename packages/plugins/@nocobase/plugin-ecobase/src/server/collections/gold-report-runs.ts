import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldReportRuns,
  title: 'Gold report runs',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'frequency', type: 'string', allowNull: false },
    { name: 'periodStart', type: 'string', allowNull: false },
    { name: 'periodEnd', type: 'string', allowNull: false },
    { name: 'status', type: 'string', allowNull: false },
    { name: 'generatedAt', type: 'datetimeTz' },
  ],
});
