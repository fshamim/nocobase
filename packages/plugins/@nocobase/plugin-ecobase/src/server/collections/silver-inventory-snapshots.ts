import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverInventorySnapshots,
  title: 'Silver inventory snapshots',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'companyProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProducts,
      foreignKey: 'companyProductId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'snapshotDate', type: 'string', allowNull: false },
    { name: 'sellableStock', type: 'double' },
    { name: 'reserved', type: 'double' },
    { name: 'inbound', type: 'double' },
    { name: 'ordered', type: 'double' },
    { name: 'prepStock', type: 'double' },
    { name: 'salesVelocity', type: 'double' },
  ],
});
