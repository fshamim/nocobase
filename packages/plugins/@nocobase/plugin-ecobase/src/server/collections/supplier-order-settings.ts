import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.supplierOrderSettings,
  title: 'Ecobase supplier order settings',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'company', type: 'string', index: true },
    { name: 'settingKey', type: 'string', allowNull: false, index: true },
    { name: 'numberValue', type: 'double' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
