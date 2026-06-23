import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverProducts,
  title: 'Silver products',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'asin', type: 'string', allowNull: false },
    { name: 'sku', type: 'string', allowNull: false },
    { name: 'title', type: 'text' },
    { name: 'brand', type: 'string' },
    { name: 'lifecycleStatus', type: 'string', allowNull: false, defaultValue: 'draft' },
    { name: 'mappingStatus', type: 'string', allowNull: false, defaultValue: 'draft' },
  ],
  indexes: [
    {
      unique: true,
      fields: ['asin', 'sku'],
    },
  ],
});
