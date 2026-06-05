import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.okrs,
  title: 'Ecobase OKRs',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', autoFill: false, index: true },
    { name: 'externalOkrId', type: 'string', index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'owner', type: 'string', index: true },
    { name: 'operationalArea', type: 'string', index: true },
    { name: 'period', type: 'string', index: true },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'active', index: true },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
