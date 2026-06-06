import { defineCollection } from '@nocobase/database';
import { CODEX_SUBSCRIPTION_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: CODEX_SUBSCRIPTION_COLLECTIONS.authSessions,
  title: 'Codex subscription auth sessions',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'llmServiceName', type: 'string', allowNull: false, index: true },
    { name: 'state', type: 'string', allowNull: false, unique: true },
    { name: 'verifierEncrypted', type: 'text', allowNull: false },
    { name: 'userCode', type: 'string' },
    { name: 'verificationUri', type: 'text' },
    { name: 'intervalSeconds', type: 'integer', defaultValue: 5 },
    { name: 'expiresAt', type: 'date' },
    { name: 'redirectUri', type: 'text', allowNull: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'pending' },
    { name: 'errorMessage', type: 'text' },
    { name: 'createdAt', type: 'date', allowNull: false },
    { name: 'completedAt', type: 'date' },
  ],
});
