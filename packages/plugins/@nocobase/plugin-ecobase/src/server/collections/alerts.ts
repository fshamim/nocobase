import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.alerts,
  title: 'Ecobase alerts',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'dedupeKey', type: 'string', allowNull: false, unique: true },
    { name: 'planningProductId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'company', type: 'string', index: true },
    { name: 'canonicalAsin', type: 'string', index: true },
    { name: 'title', type: 'string' },
    { name: 'alertEvaluationId', type: 'uuid', allowNull: false, autoFill: false, index: true },
    { name: 'alertType', type: 'string', allowNull: false, index: true },
    { name: 'severity', type: 'string', allowNull: false, index: true },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'open', index: true },
    { name: 'subjectRef', type: 'string', allowNull: false, index: true },
    { name: 'primaryRootCauseCode', type: 'string', allowNull: false, index: true },
    { name: 'actionRequired', type: 'text', allowNull: false },
    { name: 'rootCauses', type: 'jsonb', defaultValue: [] },
    { name: 'dataWarnings', type: 'jsonb', defaultValue: [] },
    { name: 'evidence', type: 'jsonb', defaultValue: {} },
    { name: 'openedAt', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'lastSeenAt', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'resolvedAt', type: 'datetimeTz', index: true },
  ],
});
