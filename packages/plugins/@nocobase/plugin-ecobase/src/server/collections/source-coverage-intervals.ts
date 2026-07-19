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
  name: ECOBASE_COLLECTIONS.sourceCoverageIntervals,
  title: 'EcoBase source coverage intervals',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'sourceConnectionId', type: 'uuid', allowNull: false, index: true, autoFill: false },
    { name: 'companyId', type: 'uuid', allowNull: false, index: true, autoFill: false },
    { name: 'amazonAccountId', type: 'uuid', allowNull: false, index: true, autoFill: false },
    { name: 'marketplace', type: 'string', allowNull: false, index: true },
    { name: 'metricSet', type: 'string', allowNull: false, index: true },
    { name: 'coveredStartDate', type: 'dateOnly', allowNull: false, index: true },
    { name: 'coveredEndDate', type: 'dateOnly', allowNull: false, index: true },
    { name: 'continuousCoverage', type: 'boolean', allowNull: false },
    { name: 'sourceAsOfDate', type: 'dateOnly', allowNull: false, index: true },
    { name: 'sourceVersion', type: 'string', allowNull: false },
    { name: 'importRunId', type: 'uuid', allowNull: false, index: true, autoFill: false },
    { name: 'inputDigest', type: 'string', allowNull: false },
    { name: 'scopeDigest', type: 'string', allowNull: false },
    { name: 'productScopeEvidenceVersion', type: 'string', allowNull: false },
    { name: 'coverageStatus', type: 'string', allowNull: false, index: true },
    { name: 'supersedesCoverageIntervalId', type: 'uuid', index: true, autoFill: false },
    { name: 'evidenceJson', type: 'jsonb', allowNull: false, defaultValue: {} },
  ],
  indexes: [
    {
      unique: false,
      fields: ['sourceConnectionId', 'companyId', 'amazonAccountId', 'marketplace', 'metricSet', 'coverageStatus'],
    },
    { unique: false, fields: ['coveredStartDate', 'coveredEndDate'] },
  ],
});
