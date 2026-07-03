import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { createEcobaseReportActions } from '../../../server/resource-actions';
import { LOGGED_IN, type EcobaseFeatureResourceRegistration } from '../../../server/resource-registration';

export function createDailyOperationsBriefResourceRegistration(app?: {
  pm?: { get?: (name: string) => unknown };
}): EcobaseFeatureResourceRegistration {
  return {
    resources: [{ name: 'ecobaseReports', actions: createEcobaseReportActions(app) }],
    acl: [
      {
        resource: 'ecobaseReports',
        actions: [
          'generatePreview',
          'generateDailyOperationsBriefEvidence',
          'generateDailyOperationsBrief',
          'getDailyManagementSnapshotTrend',
          'backfillManagementKpiFacts',
          'getDailyBriefPromptSettings',
          'saveDailyBriefPromptSettings',
          'resetDailyBriefPromptSettings',
          'markDailyOperationsBriefSent',
          'markDailyOperationsBriefFailed',
        ],
        role: LOGGED_IN,
      },
      { resource: ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.dailyManagementSnapshots, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.dailyBriefPromptSettings, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
