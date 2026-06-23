import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverOrderLines,
  title: 'Silver order lines',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'order',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverOrders,
      foreignKey: 'orderId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'companyProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProducts,
      foreignKey: 'companyProductId',
      targetKey: 'id',
      onDelete: 'RESTRICT',
    },
    {
      name: 'supplierProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSupplierProducts,
      foreignKey: 'supplierProductId',
      targetKey: 'id',
      onDelete: 'RESTRICT',
    },
    { name: 'orderedQty', type: 'double', allowNull: false },
    { name: 'confirmedQty', type: 'double' },
    { name: 'unitCost', type: 'double' },
    { name: 'expectedSellPrice', type: 'double' },
    { name: 'expectedMargin', type: 'double' },
    { name: 'expectedProfit', type: 'double' },
    { name: 'supplierPackSize', type: 'double' },
    { name: 'fbaExpectedPackSize', type: 'double' },
    { name: 'prepInstruction', type: 'text' },
    { name: 'expectedDeliveryDate', type: 'string' },
    { name: 'expectedSellableDate', type: 'string' },
    { name: 'upc', type: 'string' },
    { name: 'mapPrice', type: 'double' },
    { name: 'productAnalysisStatus', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'priority', type: 'string' },
  ],
  indexes: [
    {
      unique: true,
      fields: ['orderId', 'companyProductId', 'supplierProductId'],
    },
  ],
});
