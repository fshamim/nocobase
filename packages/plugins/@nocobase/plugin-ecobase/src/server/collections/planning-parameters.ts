import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.planningParameters,
  title: 'Ecobase planning parameters',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'planningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'asin', type: 'string', index: true },
    { name: 'sku', type: 'string', index: true },
    { name: 'supplier', type: 'string', index: true },
    { name: 'supplierId', type: 'string', index: true },
    { name: 'cogs', type: 'double' },
    { name: 'profitPerUnit', type: 'double' },
    { name: 'targetStockRangeDays', type: 'double' },
    { name: 'leadTimeDays', type: 'double' },
    { name: 'safetyBufferDays', type: 'double', defaultValue: 7 },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
