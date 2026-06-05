import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.ruleVersions,
  title: 'Ecobase rule versions',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'name', type: 'string', allowNull: false, index: true },
    { name: 'ruleType', type: 'string', allowNull: false, index: true },
    { name: 'config', type: 'jsonb', defaultValue: {} },
    { name: 'activeFrom', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true, index: true },
  ],
});
