import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.inventorySnapshots,
  title: 'Ecobase inventory snapshots',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'planningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'snapshotDate', type: 'string', allowNull: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'asin', type: 'string', index: true },
    { name: 'sku', type: 'string', index: true },
    { name: 'stock', type: 'double' },
    { name: 'reserved', type: 'double' },
    { name: 'inbound', type: 'double' },
    { name: 'ordered', type: 'double' },
    { name: 'daysOfStockLeft', type: 'double' },
    { name: 'recommendedReorderQuantity', type: 'double' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', autoFill: false, index: true },
  ],
});
