import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.supplierOrders,
  title: 'Ecobase supplier orders',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'company', type: 'string', allowNull: false, index: true },
    { name: 'supplierId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'externalOrderRef', type: 'string', index: true },
    { name: 'sourceStage', type: 'string', allowNull: false, index: true },
    { name: 'status', type: 'string', allowNull: false, index: true },
    { name: 'statusSource', type: 'string', allowNull: false, defaultValue: 'import' },
    { name: 'statusUpdatedAt', type: 'datetimeTz' },
    { name: 'lastMeaningfulUpdateAt', type: 'datetimeTz' },
    { name: 'lastOperatorEditAt', type: 'datetimeTz' },
    { name: 'lastOperatorActor', type: 'string' },
    { name: 'orderDate', type: 'string' },
    { name: 'expectedDeliveryDate', type: 'string' },
    { name: 'expectedDeliveryDateSource', type: 'string', allowNull: false, defaultValue: 'missing' },
    { name: 'approvalStatus', type: 'string' },
    { name: 'paymentStatus', type: 'string' },
    { name: 'shippingCarrier', type: 'string' },
    { name: 'trackingId', type: 'string' },
    { name: 'blockedReason', type: 'text' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
