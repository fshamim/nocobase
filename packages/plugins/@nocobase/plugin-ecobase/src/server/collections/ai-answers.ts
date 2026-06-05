import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.aiAnswers,
  title: 'Ecobase AI answers',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'question', type: 'text', allowNull: false },
    { name: 'response', type: 'text', allowNull: false },
    { name: 'company', type: 'string', index: true },
    { name: 'provider', type: 'string', allowNull: false },
    { name: 'model', type: 'string', allowNull: false },
    { name: 'confidence', type: 'string', allowNull: false },
    { name: 'dataCompleteness', type: 'string', allowNull: false },
    { name: 'evidenceReferences', type: 'jsonb', defaultValue: [] },
    { name: 'warnings', type: 'jsonb', defaultValue: [] },
    { name: 'coverageGroup', type: 'string', allowNull: false, index: true },
    { name: 'createdAt', type: 'datetimeTz', allowNull: false, index: true },
  ],
});
