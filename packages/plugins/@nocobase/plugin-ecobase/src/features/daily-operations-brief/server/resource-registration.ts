/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { createEcobaseReportActions } from '../../../server/resource-actions';
import {
  ADMIN,
  LOGGED_IN,
  OPERATOR,
  type EcobaseFeatureResourceRegistration,
} from '../../../server/resource-registration';

export function createDailyOperationsBriefResourceRegistration(app?: {
  pm?: { get?: (name: string) => unknown };
}): EcobaseFeatureResourceRegistration {
  return {
    resources: [{ name: 'ecobaseReports', actions: createEcobaseReportActions(app) }],
    acl: [
      {
        resource: 'ecobaseReports',
        actions: ['getDailyManagementSnapshotTrend', 'getDailyBriefPromptSettings'],
        role: LOGGED_IN,
      },
      {
        resource: 'ecobaseReports',
        actions: ['generatePreview', 'generateDailyOperationsBriefEvidence', 'generateDailyOperationsBrief'],
        role: OPERATOR,
      },
      {
        resource: 'ecobaseReports',
        actions: [
          'backfillManagementKpiFacts',
          'saveDailyBriefPromptSettings',
          'resetDailyBriefPromptSettings',
          'markDailyOperationsBriefSent',
          'markDailyOperationsBriefFailed',
        ],
        role: ADMIN,
      },
      { resource: ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.dailyManagementSnapshots, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.dailyBriefPromptSettings, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
