import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverTargets,
  title: 'Silver targets',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'entityType', type: 'string', allowNull: false },
    { name: 'entityId', type: 'uuid', allowNull: false, autoFill: false },
    { name: 'metric', type: 'string', allowNull: false },
    { name: 'periodType', type: 'string', allowNull: false },
    { name: 'periodStart', type: 'string', allowNull: false },
    { name: 'periodEnd', type: 'string', allowNull: false },
    { name: 'targetValue', type: 'double', allowNull: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'active' },
  ],
});
