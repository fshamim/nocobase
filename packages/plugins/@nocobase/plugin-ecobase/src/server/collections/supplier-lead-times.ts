import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.supplierLeadTimes,
  title: 'Ecobase supplier lead times',
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
      name: 'sourceConnectionId',
      type: 'uuid',
      interface: 'input',
      uiSchema: { title: 'Source Connection ID' },
      allowNull: false,
      index: true,
    },
    { name: 'supplierId', type: 'string', interface: 'input', uiSchema: { title: 'Supplier ID' }, index: true },
    {
      name: 'supplierRefId',
      type: 'uuid',
      interface: 'input',
      uiSchema: { title: 'Supplier Ref ID' },
      autoFill: false,
      index: true,
    },
    {
      name: 'supplierName',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Supplier Name' },
      allowNull: false,
      index: true,
    },
    { name: 'company', type: 'string', interface: 'input', uiSchema: { title: 'Company' }, index: true },
    {
      name: 'leadTimeDays',
      type: 'double',
      interface: 'number',
      uiSchema: { title: 'Lead Time Days' },
      allowNull: false,
    },
    { name: 'confirmedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Confirmed At' } },
    { name: 'source', type: 'string', interface: 'input', uiSchema: { title: 'Source' }, index: true },
    { name: 'notes', type: 'text', interface: 'textarea', uiSchema: { title: 'Notes' } },
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
