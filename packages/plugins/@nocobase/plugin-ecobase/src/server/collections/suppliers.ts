import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.suppliers,
  title: 'Ecobase suppliers',
  fields: [
    { name: 'id', type: 'uuid', interface: 'input', uiSchema: { title: 'ID' }, primaryKey: true },
    {
      name: 'naturalKey',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Natural Key' },
      allowNull: false,
      unique: true,
    },
    {
      name: 'sourceConnectionId',
      type: 'uuid',
      interface: 'input',
      uiSchema: { title: 'Source Connection ID' },
      allowNull: false,
      index: true,
    },
    { name: 'supplierId', type: 'string', interface: 'input', uiSchema: { title: 'Supplier ID' }, index: true },
    { name: 'name', type: 'string', interface: 'input', uiSchema: { title: 'Name' }, index: true },
    { name: 'normalizedName', type: 'string', interface: 'input', uiSchema: { title: 'Normalized Name' }, index: true },
    { name: 'company', type: 'string', interface: 'input', uiSchema: { title: 'Company' }, index: true },
    {
      name: 'active',
      type: 'boolean',
      interface: 'checkbox',
      uiSchema: { title: 'Active' },
      allowNull: false,
      defaultValue: true,
    },
    { name: 'lastSeenAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Last Seen At' } },
    { name: 'payload', type: 'jsonb', interface: 'json', uiSchema: { title: 'Payload' }, defaultValue: {} },
    {
      name: 'lastImportRunId',
      type: 'uuid',
      interface: 'input',
      uiSchema: { title: 'Last Import Run ID' },
      index: true,
    },
  ],
});
