import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.targetRows,
  title: 'Ecobase target rows',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'planningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'accountKey', type: 'string', index: true },
    { name: 'targetScope', type: 'string', allowNull: false, defaultValue: 'planning_product', index: true },
    { name: 'period', type: 'string', allowNull: false, index: true },
    { name: 'periodType', type: 'string', allowNull: false, index: true },
    { name: 'asin', type: 'string', index: true },
    { name: 'sku', type: 'string', index: true },
    { name: 'unitTarget', type: 'double' },
    { name: 'profitTarget', type: 'double' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
