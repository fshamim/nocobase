import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldAlerts,
  title: 'Gold alerts',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'entityType', type: 'string', allowNull: false },
    { name: 'entityId', type: 'uuid', allowNull: false, autoFill: false },
    { name: 'alertType', type: 'string', allowNull: false },
    { name: 'severity', type: 'string', allowNull: false },
    { name: 'status', type: 'string', allowNull: false },
    { name: 'evidenceJson', type: 'jsonb' },
  ],
});
