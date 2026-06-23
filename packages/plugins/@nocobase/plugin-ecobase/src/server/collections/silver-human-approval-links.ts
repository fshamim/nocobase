import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverHumanApprovalLinks,
  title: 'Silver human approval links',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'humanApproval',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverHumanApprovals,
      foreignKey: 'humanApprovalId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'entityType', type: 'string', allowNull: false },
    { name: 'entityId', type: 'uuid', allowNull: false, autoFill: false },
    { name: 'relation', type: 'string', allowNull: false, defaultValue: 'evidence' },
  ],
});
