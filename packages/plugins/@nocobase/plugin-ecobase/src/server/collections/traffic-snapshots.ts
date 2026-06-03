import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.trafficSnapshots,
  title: 'Ecobase traffic snapshots',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'snapshotDate', type: 'string', allowNull: false, index: true },
    { name: 'asin', type: 'string', index: true },
    { name: 'sku', type: 'string', index: true },
    { name: 'sessions', type: 'double' },
    { name: 'pageViews', type: 'double' },
    { name: 'buyBoxPercentage', type: 'double' },
    { name: 'unitsOrdered', type: 'double' },
    { name: 'orderedProductSales', type: 'double' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
