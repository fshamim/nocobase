import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.rawListings,
  title: 'Ecobase raw listings',
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
    { name: 'asin', type: 'string', interface: 'input', uiSchema: { title: 'ASIN' }, index: true },
    { name: 'sku', type: 'string', interface: 'input', uiSchema: { title: 'SKU' }, index: true },
    { name: 'title', type: 'text', interface: 'textarea', uiSchema: { title: 'Title' } },
    { name: 'company', type: 'string', interface: 'input', uiSchema: { title: 'Company' }, index: true },
    { name: 'brand', type: 'string', interface: 'input', uiSchema: { title: 'Brand' }, index: true },
    { name: 'supplier', type: 'string', interface: 'input', uiSchema: { title: 'Supplier' }, index: true },
    { name: 'marketplace', type: 'string', interface: 'input', uiSchema: { title: 'Marketplace' } },
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
