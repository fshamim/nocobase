/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { SourceAdapterRegistry } from './adapters';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { createEcobaseImportActions } from '../../../server/resource-actions';
import { LOGGED_IN, type EcobaseFeatureResourceRegistration } from '../../../server/resource-registration';

export function createSourceImportResourceRegistration(
  registry: SourceAdapterRegistry,
): EcobaseFeatureResourceRegistration {
  return {
    resources: [{ name: 'ecobaseImport', actions: createEcobaseImportActions(registry) }],
    acl: [
      {
        resource: 'ecobaseImport',
        actions: [
          'run',
          'runDailySnapshot',
          'forceRefresh',
          'runScheduledSellerboard',
          'runNoop',
          'status',
          'adapters',
          'normalizeBronzeToSilver',
          'runMedallionPipeline',
          'analyzeCsvBundle',
          'runCsvBundle',
          'importSellerboardCogs',
          'importClickupOrderStatuses',
          'saveCsvSourceConnection',
          'listSellerboardSources',
          'saveSellerboardSource',
          'deleteSellerboardSource',
        ],
        role: LOGGED_IN,
      },
      { resource: ECOBASE_COLLECTIONS.companies, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.amazonAccounts, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.sourceConnections, actions: ['list', 'get'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.importRuns, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
