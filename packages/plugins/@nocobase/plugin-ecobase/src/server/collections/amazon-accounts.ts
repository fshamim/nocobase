import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.amazonAccounts,
  title: 'Ecobase Amazon accounts',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.companies,
      foreignKey: 'companyId',
      targetKey: 'id',
      allowNull: false,
      onDelete: 'CASCADE',
    },
    { name: 'accountName', type: 'string', allowNull: false },
    { name: 'marketplace', type: 'string', allowNull: false },
    { name: 'sellerId', type: 'string' },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
  ],
});
