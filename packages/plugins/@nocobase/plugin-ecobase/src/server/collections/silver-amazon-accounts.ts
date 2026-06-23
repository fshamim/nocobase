import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverAmazonAccounts,
  title: 'Silver Amazon accounts',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'sellerId', type: 'string' },
    { name: 'marketplace', type: 'string', allowNull: false },
    { name: 'isDefault', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'active' },
  ],
});
