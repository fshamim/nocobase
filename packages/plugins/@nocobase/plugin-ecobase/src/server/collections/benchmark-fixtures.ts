import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.benchmarkFixtures,
  title: 'Ecobase benchmark fixtures',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'company', type: 'string', index: true },
    { name: 'fixtureType', type: 'string', allowNull: false, index: true },
    { name: 'subjectRef', type: 'string', allowNull: false, index: true },
    { name: 'expectedSeverity', type: 'string' },
    { name: 'expectedRootCauses', type: 'jsonb', defaultValue: [] },
    { name: 'expectedAnswerFacts', type: 'jsonb', defaultValue: [] },
    { name: 'requiredEvidenceTypes', type: 'jsonb', defaultValue: [] },
    { name: 'approvedBy', type: 'string' },
    { name: 'approvedAt', type: 'datetimeTz' },
    { name: 'createdAt', type: 'datetimeTz', allowNull: false, index: true },
  ],
});
