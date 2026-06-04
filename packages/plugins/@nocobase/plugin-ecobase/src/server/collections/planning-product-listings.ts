import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.planningProductListings,
  title: 'Ecobase planning product listings',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    {
      name: 'planningProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.planningProducts,
      foreignKey: 'planningProductId',
      targetKey: 'id',
      allowNull: false,
      onDelete: 'CASCADE',
    },
    { name: 'rawListingNaturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'company', type: 'string', allowNull: false, index: true },
    { name: 'canonicalAsin', type: 'string', allowNull: false, index: true },
    { name: 'asin', type: 'string', index: true },
    { name: 'sku', type: 'string', index: true },
    { name: 'title', type: 'text' },
    { name: 'mappingMode', type: 'string', allowNull: false, defaultValue: 'default', index: true },
    { name: 'mappingStatus', type: 'string', allowNull: false, defaultValue: 'auto_mapped', index: true },
    { name: 'mappedAt', type: 'datetimeTz', allowNull: false },
    { name: 'mappedBy', type: 'string' },
    { name: 'lastImportRunId', type: 'uuid', autoFill: false, index: true },
    { name: 'auditTrail', type: 'jsonb', defaultValue: [] },
  ],
});
