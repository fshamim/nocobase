import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.supplierLeadTimes,
  title: 'Ecobase supplier lead times',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true },
    { name: 'supplierId', type: 'string', index: true },
    { name: 'supplierName', type: 'string', allowNull: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'leadTimeDays', type: 'double', allowNull: false },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
