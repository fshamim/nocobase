import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.supplierOrderActivities,
  title: 'Ecobase supplier order activities',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'supplierOrderId', type: 'uuid', autoFill: false, index: true },
    { name: 'supplierId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'company', type: 'string', allowNull: false, index: true },
    { name: 'activityType', type: 'string', allowNull: false, index: true },
    { name: 'occurredAt', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'actor', type: 'string' },
    { name: 'notes', type: 'text' },
    { name: 'nextFollowUpAt', type: 'datetimeTz' },
    { name: 'leadTimeDays', type: 'double' },
    { name: 'source', type: 'string', allowNull: false, defaultValue: 'manual' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
