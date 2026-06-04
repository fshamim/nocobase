import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.supplierExternalIdentities,
  title: 'Ecobase supplier external identities',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'supplierId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'sourceSystem', type: 'string', allowNull: false, index: true },
    { name: 'externalSupplierCode', type: 'string', index: true },
    { name: 'externalSupplierName', type: 'string', allowNull: false, index: true },
    { name: 'normalizedExternalSupplierName', type: 'string', allowNull: false, index: true },
    { name: 'firstSeenAt', type: 'datetimeTz', allowNull: false },
    { name: 'lastSeenAt', type: 'datetimeTz', allowNull: false },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
