import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.sourceWarningPolicies,
  title: 'Ecobase source warning policies',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceType', type: 'string', allowNull: false, unique: true, index: true },
    { name: 'required', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'freshnessSlaMinutes', type: 'integer' },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true, index: true },
    { name: 'notes', type: 'text' },
  ],
});
