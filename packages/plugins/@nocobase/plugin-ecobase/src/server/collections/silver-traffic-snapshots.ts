import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverTrafficSnapshots,
  title: 'Silver traffic snapshots',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'companyProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProducts,
      foreignKey: 'companyProductId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'snapshotDate', type: 'string', allowNull: false },
    { name: 'sessions', type: 'double' },
    { name: 'buyBoxPercentage', type: 'double' },
    { name: 'conversionRate', type: 'double' },
  ],
});
