import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.listingDailyFacts,
  title: 'Ecobase listing daily facts',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'planningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'snapshotDate', type: 'string', allowNull: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'asin', type: 'string', index: true },
    { name: 'sku', type: 'string', index: true },
    { name: 'sales', type: 'double' },
    { name: 'units', type: 'double' },
    { name: 'refunds', type: 'double' },
    { name: 'refundRate', type: 'double' },
    { name: 'grossProfit', type: 'double' },
    { name: 'netProfit', type: 'double' },
    { name: 'margin', type: 'double' },
    { name: 'sessions', type: 'double' },
    { name: 'unitSessionPercentage', type: 'double' },
    { name: 'sourceKey', type: 'string' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', autoFill: false, index: true },
  ],
});
