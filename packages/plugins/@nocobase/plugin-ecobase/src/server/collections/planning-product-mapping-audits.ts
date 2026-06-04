import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.planningProductMappingAudits,
  title: 'Ecobase planning product mapping audits',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'planningProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.planningProducts,
      foreignKey: 'planningProductId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    {
      name: 'planningProductListing',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.planningProductListings,
      foreignKey: 'planningProductListingId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'rawListingNaturalKey', type: 'string', allowNull: false, index: true },
    { name: 'action', type: 'string', allowNull: false, index: true },
    { name: 'previousPlanningProductId', type: 'uuid', autoFill: false },
    { name: 'nextPlanningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'actorId', type: 'string' },
    { name: 'note', type: 'text' },
    { name: 'occurredAt', type: 'datetimeTz', allowNull: false },
    { name: 'metadata', type: 'jsonb', defaultValue: {} },
  ],
});
