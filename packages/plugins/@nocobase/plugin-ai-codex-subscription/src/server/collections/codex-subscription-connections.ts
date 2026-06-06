import { defineCollection } from '@nocobase/database';
import { CODEX_SUBSCRIPTION_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: CODEX_SUBSCRIPTION_COLLECTIONS.connections,
  title: 'Codex subscription connections',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'llmServiceName', type: 'string', allowNull: false, unique: true },
    { name: 'accountId', type: 'string', allowNull: false },
    { name: 'accessTokenEncrypted', type: 'text', allowNull: false },
    { name: 'refreshTokenEncrypted', type: 'text', allowNull: false },
    { name: 'expiresAt', type: 'date', allowNull: false },
    { name: 'connectedAt', type: 'date', allowNull: false },
    { name: 'lastVerifiedAt', type: 'date', allowNull: false },
    { name: 'lastError', type: 'text' },
  ],
});
