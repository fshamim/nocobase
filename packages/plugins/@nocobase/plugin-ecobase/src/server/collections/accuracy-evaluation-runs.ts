import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.accuracyEvaluationRuns,
  title: 'Ecobase accuracy evaluation runs',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'company', type: 'string', index: true },
    { name: 'dataQualitySignoffId', type: 'uuid', autoFill: false, index: true },
    { name: 'status', type: 'string', allowNull: false, index: true },
    { name: 'criticalDetectionAccuracy', type: 'double' },
    { name: 'rootCauseAccuracy', type: 'double' },
    { name: 'aiAnswerAccuracy', type: 'double' },
    { name: 'report', type: 'jsonb', defaultValue: {} },
    { name: 'failureBreakdown', type: 'jsonb', defaultValue: {} },
    { name: 'createdAt', type: 'datetimeTz', allowNull: false, index: true },
  ],
});
