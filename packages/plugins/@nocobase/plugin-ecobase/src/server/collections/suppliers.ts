import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.suppliers,
  title: 'Ecobase suppliers',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'supplierId', type: 'string', index: true },
    { name: 'name', type: 'string', allowNull: false, index: true },
    { name: 'normalizedName', type: 'string', index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    { name: 'lastSeenAt', type: 'datetimeTz' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
