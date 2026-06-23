import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
  title: 'Gold inventory planning rows',
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
    { name: 'calculationDate', type: 'string', allowNull: false },
    { name: 'estimatedOosDate', type: 'string' },
    { name: 'latestSafeReorderDate', type: 'string' },
    { name: 'riskLevel', type: 'string' },
    { name: 'recommendedAction', type: 'text' },
  ],
});
