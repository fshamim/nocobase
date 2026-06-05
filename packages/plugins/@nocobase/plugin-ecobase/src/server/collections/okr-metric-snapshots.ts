import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  name: ECOBASE_COLLECTIONS.okrMetricSnapshots,
  title: 'Ecobase OKR metric snapshots',
  fields: [
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', autoFill: false, index: true },
    { name: 'okrId', type: 'uuid', autoFill: false, index: true },
    { name: 'externalOkrId', type: 'string', index: true },
    { name: 'snapshotDate', type: 'string', allowNull: false, index: true },
    { name: 'metricName', type: 'string', allowNull: false },
    { name: 'targetValue', type: 'double' },
    { name: 'currentValue', type: 'double' },
    { name: 'progressPercent', type: 'double', index: true },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'on_track', index: true },
    { name: 'owner', type: 'string', index: true },
    { name: 'operationalArea', type: 'string', index: true },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'lastImportRunId', type: 'uuid', index: true },
  ],
});
