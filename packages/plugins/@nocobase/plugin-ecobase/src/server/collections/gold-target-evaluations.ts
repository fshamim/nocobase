import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldTargetEvaluations,
  title: 'Gold target evaluations',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'target',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverTargets,
      foreignKey: 'targetId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'evaluatedAt', type: 'datetimeTz', allowNull: false },
    { name: 'actualValue', type: 'double' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'evidenceJson', type: 'jsonb' },
  ],
});
