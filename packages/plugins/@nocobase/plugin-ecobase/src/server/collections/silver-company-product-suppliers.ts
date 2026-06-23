import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
  title: 'Silver company product suppliers',
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
    {
      name: 'supplierProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSupplierProducts,
      foreignKey: 'supplierProductId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'role', type: 'string', allowNull: false },
  ],
  indexes: [
    {
      unique: true,
      fields: ['companyProductId', 'supplierProductId', 'role'],
    },
  ],
});
