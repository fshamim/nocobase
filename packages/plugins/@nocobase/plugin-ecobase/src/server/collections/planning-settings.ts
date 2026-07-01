import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  loadedFromCollectionManager: true,
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.planningSettings,
  title: 'EcoBase planning settings',
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
    {
      name: 'safetyBufferDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Safety buffer days' },
      allowNull: false,
    },
    {
      name: 'reorderCycleDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Reorder cycle days' },
      allowNull: false,
    },
    {
      name: 'orderSoonWindowDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Order-soon window days' },
      allowNull: false,
    },
    {
      name: 'leadTimeFreshnessDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Lead-time freshness days' },
      allowNull: false,
    },
    {
      name: 'purchasedPipelineGraceDays',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Purchased pipeline grace days' },
      allowNull: false,
    },
    { name: 'updatedBy', type: 'string', interface: 'input', uiSchema: { title: 'Updated By' } },
    { name: 'createdAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Created At' }, index: true },
    { name: 'updatedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Updated At' }, index: true },
  ],
});
