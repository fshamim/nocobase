import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.alertEvaluations,
  title: 'Ecobase alert evaluations',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'planningProductId', type: 'uuid', autoFill: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'canonicalAsin', type: 'string', index: true },
    { name: 'evaluatedAt', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'ruleVersionId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'tier', type: 'string', defaultValue: 'unclassified', index: true },
    { name: 'sellableStock', type: 'double' },
    { name: 'pipelineStock', type: 'double' },
    { name: 'salesVelocity', type: 'double' },
    { name: 'daysOfCover', type: 'double' },
    { name: 'oosDate', type: 'string' },
    { name: 'restockDeadline', type: 'string' },
    { name: 'daysLeftOrOverdue', type: 'double' },
    { name: 'profitGap', type: 'double' },
    { name: 'estimatedProfitRisk', type: 'double' },
    { name: 'rootCauses', type: 'jsonb', defaultValue: [] },
    { name: 'dataWarnings', type: 'jsonb', defaultValue: [] },
    { name: 'evidence', type: 'jsonb', defaultValue: {} },
  ],
});
