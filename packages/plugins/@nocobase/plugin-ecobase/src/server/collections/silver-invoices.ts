import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverInvoices,
  title: 'Silver invoices',
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
    { name: 'invoiceNumber', type: 'string', allowNull: false },
    { name: 'invoiceType', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'waiting' },
    { name: 'fileUrl', type: 'string' },
    { name: 'submittedByUserId', type: 'uuid', autoFill: false },
    { name: 'amount', type: 'double' },
    { name: 'paymentMode', type: 'string' },
    { name: 'paidAt', type: 'datetimeTz' },
    { name: 'remarks', type: 'text' },
  ],
});
