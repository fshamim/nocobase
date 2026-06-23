import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldSupplierAttentionRows,
  title: 'Gold supplier attention rows',
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
      name: 'companyProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProducts,
      foreignKey: 'companyProductId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    {
      name: 'order',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverOrders,
      foreignKey: 'orderId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'priority', type: 'string', allowNull: false },
    { name: 'moneyAtRisk', type: 'double' },
    { name: 'recommendedAction', type: 'text', allowNull: false },
  ],
});
