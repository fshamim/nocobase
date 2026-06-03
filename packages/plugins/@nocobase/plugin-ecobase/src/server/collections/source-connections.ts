import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.sourceConnections,
  title: 'Ecobase source connections',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'name', type: 'string', allowNull: false },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.companies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'sourceType', type: 'string', allowNull: false, index: true },
    { name: 'domain', type: 'string', allowNull: false, index: true },
    { name: 'config', type: 'jsonb', defaultValue: {} },
    { name: 'secretRef', type: 'string' },
    { name: 'freshnessSlaMinutes', type: 'integer' },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    {
      name: 'importRuns',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.importRuns,
      foreignKey: 'sourceConnectionId',
      onDelete: 'CASCADE',
    },
  ],
});
