import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverCompanyProducts,
  title: 'Silver company products',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'amazonAccount',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverAmazonAccounts,
      foreignKey: 'amazonAccountId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'product',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverProducts,
      foreignKey: 'productId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'lifecycleStatus', type: 'string', allowNull: false, defaultValue: 'candidate_new_product' },
    { name: 'listingStatus', type: 'string', allowNull: false, defaultValue: 'not_listed' },
  ],
  indexes: [
    {
      unique: true,
      fields: ['amazonAccountId', 'productId'],
    },
  ],
});
