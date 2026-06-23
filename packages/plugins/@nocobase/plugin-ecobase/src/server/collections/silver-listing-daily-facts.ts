import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverListingDailyFacts,
  title: 'Silver listing daily facts',
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
    { name: 'sales', type: 'double' },
    { name: 'units', type: 'double' },
    { name: 'profit', type: 'double' },
    { name: 'margin', type: 'double' },
    { name: 'refunds', type: 'double' },
  ],
});
