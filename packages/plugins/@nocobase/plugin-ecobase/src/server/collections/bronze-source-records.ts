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
  name: ECOBASE_COLLECTIONS.bronzeSourceRecords,
  title: 'Bronze source records',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'sourceConnection',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.sourceConnections,
      foreignKey: 'sourceConnectionId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'importRun',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.importRuns,
      foreignKey: 'importRunId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'sourceType', type: 'string', allowNull: false },
    { name: 'sourceDataset', type: 'string', allowNull: false },
    { name: 'sourceRecordKey', type: 'string', allowNull: false },
    { name: 'sourceKey', type: 'string' },
    { name: 'rowNumber', type: 'integer' },
    { name: 'observedAt', type: 'datetimeTz' },
    { name: 'payload', type: 'jsonb', defaultValue: {} },
    { name: 'rowHash', type: 'string', allowNull: false },
    { name: 'normalizationStatus', type: 'string', allowNull: false, defaultValue: 'pending' },
    { name: 'normalizedError', type: 'text' },
    { name: 'issueSeverity', type: 'string' },
    { name: 'issueCode', type: 'string' },
    { name: 'normalizedAt', type: 'datetimeTz' },
    { name: 'retentionUntil', type: 'datetimeTz' },
  ],
  indexes: [
    {
      unique: true,
      fields: ['sourceConnectionId', 'sourceDataset', 'sourceRecordKey', 'rowHash'],
    },
  ],
});
