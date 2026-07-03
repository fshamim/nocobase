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
