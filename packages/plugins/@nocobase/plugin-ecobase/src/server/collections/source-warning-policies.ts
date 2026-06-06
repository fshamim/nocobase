import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.sourceWarningPolicies,
  title: 'Ecobase source warning policies',
  fields: [
    {
      name: 'naturalKey',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Natural Key' },
      allowNull: false,
      unique: true,
    },
    {
      name: 'sourceType',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Source Type' },
      allowNull: false,
      unique: true,
      index: true,
    },
    {
      name: 'required',
      type: 'boolean',
      interface: 'checkbox',
      uiSchema: { title: 'Required' },
      allowNull: false,
      defaultValue: false,
    },
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
      index: true,
    },
    { name: 'notes', type: 'text', interface: 'textarea', uiSchema: { title: 'Notes' } },
  ],
});
