import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.sourceConnections,
  title: 'Ecobase source connections',
  fields: [
    { name: 'id', type: 'uuid', interface: 'input', uiSchema: { title: 'ID' }, primaryKey: true },
    { name: 'name', type: 'string', interface: 'input', uiSchema: { title: 'Name' }, allowNull: false },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.companies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    {
      name: 'sourceType',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Source Type' },
      allowNull: false,
      index: true,
    },
    {
      name: 'domain',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Domain' },
      allowNull: false,
      index: true,
    },
    { name: 'config', type: 'jsonb', interface: 'json', uiSchema: { title: 'Config' }, defaultValue: {} },
    { name: 'secretRef', type: 'string', interface: 'input', uiSchema: { title: 'Secret Ref' } },
    {
      name: 'freshnessSlaMinutes',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Freshness Sla Minutes' },
    },
    {
      name: 'active',
      type: 'boolean',
      interface: 'checkbox',
      uiSchema: { title: 'Active' },
      allowNull: false,
      defaultValue: true,
    },
    {
      name: 'importRuns',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.importRuns,
      foreignKey: 'sourceConnectionId',
      onDelete: 'CASCADE',
    },
  ],
});
