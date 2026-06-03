import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.sourceAccessAudits,
  title: 'Ecobase source access audits',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'sourceType', type: 'string', allowNull: false, index: true },
    { name: 'adapterName', type: 'string', allowNull: false, index: true },
    { name: 'status', type: 'string', allowNull: false, index: true },
    { name: 'blockerCode', type: 'string', index: true },
    { name: 'message', type: 'text' },
    { name: 'checkedAt', type: 'datetimeTz', allowNull: false },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
