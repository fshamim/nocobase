import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.planningProducts,
  title: 'Ecobase planning products',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'company', type: 'string', allowNull: false, index: true },
    { name: 'canonicalAsin', type: 'string', allowNull: false, index: true },
    { name: 'title', type: 'text' },
    { name: 'mappingStatus', type: 'string', allowNull: false, defaultValue: 'auto_mapped', index: true },
    { name: 'listingCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'lastImportRunId', type: 'uuid', autoFill: false, index: true },
    { name: 'confirmedAt', type: 'datetimeTz' },
    { name: 'confirmedBy', type: 'string' },
    { name: 'auditSummary', type: 'jsonb', defaultValue: {} },
    {
      name: 'listings',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.planningProductListings,
      foreignKey: 'planningProductId',
      onDelete: 'CASCADE',
    },
  ],
});
