/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { SourceAdapterRegistry } from './adapters';
import type { SellerboardCommittedUnitHandler } from './import-service';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { createEcobaseImportActions } from '../../../server/resource-actions';
import { ADMIN, LOGGED_IN, type EcobaseFeatureResourceRegistration } from '../../../server/resource-registration';

export function createSourceImportResourceRegistration(
  registry: SourceAdapterRegistry,
  onSellerboardCommitted?: SellerboardCommittedUnitHandler,
  // 070: a committed ClickUp apply schedules the same debounced publish an operator write does.
  onGoldRefreshRequired?: () => void,
): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      {
        name: 'ecobaseImport',
        actions: createEcobaseImportActions(registry, onSellerboardCommitted, onGoldRefreshRequired),
      },
    ],
    acl: [
      {
        resource: 'ecobaseImport',
        actions: ['status', 'adapters', 'listSellerboardSources', 'sellerboardReportUnits', 'protectedCatalogDrift'],
        role: LOGGED_IN,
      },
      {
        resource: 'ecobaseImport',
        actions: [
          'run',
          'runDailySnapshot',
          'forceRefresh',
          'runSellerboardReportUnit',
          'runScheduledSellerboard',
          'runNoop',
          'normalizeBronzeToSilver',
          'runMedallionPipeline',
          'verifySemanticLinks',
          'verifyOrderDetailsRelationships',
          'deactivateMigrationSources',
          'purgeExpiredBronze',
          'refreshGoldReadModels',
          'analyzeCsvBundle',
          'runCsvBundle',
          'bootstrapSourceCoverage',
          'previewSellerboardHistoryBackfill',
          'applySellerboardHistoryBackfill',
          'verifySellerboardHistoryBackfillIdempotency',
          'previewSellerboardCogs',
          'applySellerboardCogsBackfill',
          'verifySellerboardCogsBackfillIdempotency',
          'importSellerboardCogs',
          'previewSupplierOrderImport',
          'applySupplierOrderImportPreflight',
          'ensureClickupAttributionUsers',
          'importClickupOrderStatuses',
          'saveCsvSourceConnection',
          'saveSellerboardSource',
          'deleteSellerboardSource',
        ],
        role: ADMIN,
      },
      { resource: ECOBASE_COLLECTIONS.silverCompanies, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.silverAmazonAccounts, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.sourceConnections, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.importRuns, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
