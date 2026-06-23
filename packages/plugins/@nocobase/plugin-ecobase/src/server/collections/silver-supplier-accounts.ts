import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverSupplierAccounts,
  title: 'Silver supplier accounts',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'supplier',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSuppliers,
      foreignKey: 'supplierId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'accountName', type: 'string', allowNull: false },
    { name: 'orderingMethod', type: 'string', allowNull: false, defaultValue: 'email' },
    { name: 'portalUrl', type: 'text' },
    { name: 'username', type: 'string' },
    { name: 'secretRef', type: 'string' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'active' },
  ],
});
