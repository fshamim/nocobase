import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.rawListings,
  title: 'Ecobase raw listings',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'asin', type: 'string', index: true },
    { name: 'sku', type: 'string', index: true },
    { name: 'title', type: 'text' },
    { name: 'company', type: 'string', index: true },
    { name: 'brand', type: 'string', index: true },
    { name: 'supplier', type: 'string', index: true },
    { name: 'marketplace', type: 'string' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
