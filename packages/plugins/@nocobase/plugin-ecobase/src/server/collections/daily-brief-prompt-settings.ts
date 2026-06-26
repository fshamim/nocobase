import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  loadedFromCollectionManager: true,
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.dailyBriefPromptSettings,
  title: 'Daily brief prompt settings',
  fields: [
    { name: 'id', type: 'uuid', interface: 'input', uiSchema: { title: 'ID' }, primaryKey: true },
    { name: 'name', type: 'string', interface: 'input', uiSchema: { title: 'Name' }, allowNull: false, index: true },
    {
      name: 'isActive',
      type: 'boolean',
      interface: 'checkbox',
      uiSchema: { title: 'Active' },
      defaultValue: true,
      index: true,
    },
    { name: 'company', type: 'string', interface: 'input', uiSchema: { title: 'Company' }, index: true },
    { name: 'audience', type: 'string', interface: 'input', uiSchema: { title: 'Audience' } },
    { name: 'tone', type: 'string', interface: 'input', uiSchema: { title: 'Tone' } },
    { name: 'directorInstructions', type: 'text', interface: 'textarea', uiSchema: { title: 'Director Instructions' } },
    { name: 'mustInclude', type: 'jsonb', interface: 'json', uiSchema: { title: 'Must Include' }, defaultValue: [] },
    { name: 'mustAvoid', type: 'jsonb', interface: 'json', uiSchema: { title: 'Must Avoid' }, defaultValue: [] },
    { name: 'kpiPriority', type: 'jsonb', interface: 'json', uiSchema: { title: 'KPI Priority' }, defaultValue: [] },
    { name: 'llmService', type: 'string', interface: 'input', uiSchema: { title: 'LLM Service' } },
    { name: 'model', type: 'string', interface: 'input', uiSchema: { title: 'Model' } },
    { name: 'updatedBy', type: 'string', interface: 'input', uiSchema: { title: 'Updated By' } },
    { name: 'createdAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Created At' }, index: true },
    { name: 'updatedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Updated At' }, index: true },
  ],
});
