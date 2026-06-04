import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.supplierProductLinks,
  title: 'Ecobase supplier product links',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'company', type: 'string', allowNull: false, index: true },
    { name: 'planningProductId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'supplierId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'role', type: 'string', allowNull: false, index: true },
    { name: 'source', type: 'string', allowNull: false, index: true },
    { name: 'confidence', type: 'string', allowNull: false, defaultValue: 'medium' },
    { name: 'firstOrderedAt', type: 'datetimeTz' },
    { name: 'lastOrderedAt', type: 'datetimeTz' },
    { name: 'orderCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'lastUnitCost', type: 'double' },
    { name: 'latestBrand', type: 'string' },
    { name: 'manuallyConfirmedAt', type: 'datetimeTz' },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    { name: 'evidence', type: 'jsonb', defaultValue: {} },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
