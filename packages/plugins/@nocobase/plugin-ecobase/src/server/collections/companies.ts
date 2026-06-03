import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.companies,
  title: 'Ecobase companies',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'name', type: 'string', allowNull: false, unique: true },
    { name: 'timezone', type: 'string', allowNull: false, defaultValue: 'Asia/Karachi' },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    {
      name: 'amazonAccounts',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.amazonAccounts,
      foreignKey: 'companyId',
      onDelete: 'CASCADE',
    },
    {
      name: 'sourceConnections',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.sourceConnections,
      foreignKey: 'companyId',
      onDelete: 'SET NULL',
    },
  ],
});
