import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.dataQualitySignoffs,
  title: 'Ecobase data quality sign-offs',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'status', type: 'string', allowNull: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'signedOffBy', type: 'string' },
    { name: 'signedOffAt', type: 'datetimeTz' },
    { name: 'checklist', type: 'jsonb', defaultValue: {} },
    { name: 'credentialBlockers', type: 'jsonb', defaultValue: [] },
    { name: 'notes', type: 'text' },
    { name: 'createdAt', type: 'datetimeTz', allowNull: false, index: true },
  ],
});
