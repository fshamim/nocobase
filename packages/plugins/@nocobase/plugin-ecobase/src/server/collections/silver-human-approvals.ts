import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverHumanApprovals,
  title: 'Silver human approvals',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'actionType', type: 'string', allowNull: false },
    { name: 'actionPayloadJson', type: 'jsonb', defaultValue: {} },
    { name: 'proposedByType', type: 'string', allowNull: false },
    { name: 'proposedById', type: 'uuid', autoFill: false },
    { name: 'assignedReviewerId', type: 'uuid', autoFill: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'pending' },
    { name: 'priority', type: 'string' },
    { name: 'dueAt', type: 'datetimeTz' },
    { name: 'contextSummary', type: 'text' },
    { name: 'evidenceJson', type: 'jsonb' },
    { name: 'riskSummary', type: 'text' },
    { name: 'approvedByUserId', type: 'uuid', autoFill: false },
    { name: 'approvedAt', type: 'datetimeTz' },
    { name: 'rejectedReason', type: 'text' },
    { name: 'executedAt', type: 'datetimeTz' },
    { name: 'executionResultJson', type: 'jsonb' },
  ],
});
