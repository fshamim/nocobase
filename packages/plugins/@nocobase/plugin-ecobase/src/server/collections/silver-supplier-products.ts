import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverSupplierProducts,
  title: 'Silver supplier products',
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
      name: 'product',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverProducts,
      foreignKey: 'productId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'supplierSku', type: 'string' },
    { name: 'unitCost', type: 'double' },
    { name: 'moq', type: 'double' },
    { name: 'supplierPackSize', type: 'double' },
    { name: 'leadTimeDays', type: 'double' },
    { name: 'prepCapability', type: 'string' },
    { name: 'analysisStatus', type: 'string', allowNull: false, defaultValue: 'not_analyzed' },
  ],
  indexes: [
    {
      unique: true,
      fields: ['supplierId', 'productId'],
    },
  ],
});
