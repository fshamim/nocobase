import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverSuppliers,
  title: 'Silver suppliers',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'normalizedName', type: 'string', allowNull: false, unique: true },
    { name: 'displayName', type: 'string', allowNull: false },
    { name: 'approvalStatus', type: 'string', allowNull: false, defaultValue: 'analyzing' },
    { name: 'analysisStatus', type: 'string' },
    { name: 'accountStatus', type: 'string' },
    { name: 'nextFollowUpAt', type: 'datetimeTz' },
    { name: 'lastContactedAt', type: 'datetimeTz' },
  ],
});
