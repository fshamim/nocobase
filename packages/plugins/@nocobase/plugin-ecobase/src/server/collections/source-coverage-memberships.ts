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
  name: ECOBASE_COLLECTIONS.sourceCoverageMemberships,
  title: 'EcoBase source coverage memberships',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'naturalKey', type: 'string', allowNull: false, unique: true },
    { name: 'coverageIntervalId', type: 'uuid', allowNull: false, index: true, autoFill: false },
    { name: 'companyProductId', type: 'uuid', allowNull: false, index: true, autoFill: false },
    { name: 'monthStart', type: 'dateOnly', allowNull: false, index: true },
    { name: 'membershipStatus', type: 'string', allowNull: false, index: true },
    { name: 'scopeEvidenceKinds', type: 'jsonb', allowNull: false, defaultValue: [] },
    { name: 'scopeEvidenceDigest', type: 'string', allowNull: false },
    { name: 'sourceMetricRowCount', type: 'integer', allowNull: false },
    { name: 'normalizedFactLinkCount', type: 'integer', allowNull: false },
    { name: 'metricReconciliationStatus', type: 'string', allowNull: false, index: true },
    { name: 'metricEvidenceDigest', type: 'string', allowNull: false },
  ],
  indexes: [
    { unique: true, fields: ['coverageIntervalId', 'companyProductId', 'monthStart'] },
    { unique: false, fields: ['companyProductId', 'monthStart', 'membershipStatus'] },
  ],
});
