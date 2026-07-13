/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.repairRuns,
  title: 'Ecobase repair runs',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'repairVersion', type: 'string', allowNull: false },
    { name: 'codeSha', type: 'string', allowNull: false },
    { name: 'decisionDigest', type: 'string', allowNull: false },
    { name: 'actorUserId', type: 'bigInt', autoFill: false },
    { name: 'status', type: 'string', allowNull: false, index: true },
    { name: 'step', type: 'string', allowNull: false },
    { name: 'cursor', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'candidateCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'excludedCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'changedCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'startedAt', type: 'datetimeTz', allowNull: false },
    { name: 'finishedAt', type: 'datetimeTz' },
    { name: 'checkpointJson', type: 'jsonb', allowNull: false, defaultValue: {} },
    { name: 'summary', type: 'jsonb', allowNull: false, defaultValue: {} },
    { name: 'errorMessage', type: 'text' },
  ],
  indexes: [{ unique: true, fields: ['repairVersion', 'codeSha', 'decisionDigest'] }],
});
