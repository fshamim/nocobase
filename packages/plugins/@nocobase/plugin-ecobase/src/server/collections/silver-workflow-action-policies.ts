import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverWorkflowActionPolicies,
  title: 'Silver workflow action policies',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'actionType', type: 'string', allowNull: false, unique: true },
    { name: 'requiresHumanApproval', type: 'boolean', allowNull: false, defaultValue: true },
    { name: 'autoExecutable', type: 'boolean', allowNull: false, defaultValue: false },
  ],
});
