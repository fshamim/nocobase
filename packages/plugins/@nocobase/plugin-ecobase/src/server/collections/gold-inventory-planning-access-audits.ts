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
  loadedFromCollectionManager: true,
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldInventoryPlanningAccessAudits,
  title: 'Gold inventory planning access audits',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'occurredAt', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'actorUserId', type: 'bigInt', autoFill: false, index: true },
    { name: 'runId', type: 'uuid', autoFill: false, index: true },
    { name: 'purpose', type: 'string', allowNull: false, index: true },
    { name: 'outcome', type: 'string', allowNull: false, index: true },
    { name: 'reasonCode', type: 'string', allowNull: false, index: true },
    { name: 'requestId', type: 'string', index: true },
    { name: 'metadataJson', type: 'jsonb', allowNull: false, defaultValue: {} },
  ],
});
