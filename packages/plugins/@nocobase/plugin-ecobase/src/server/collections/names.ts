export const ECOBASE_COLLECTIONS = {
  companies: 'ecobaseCompanies',
  amazonAccounts: 'ecobaseAmazonAccounts',
  sourceConnections: 'ecobaseSourceConnections',
  importRuns: 'ecobaseImportRuns',
  rawImportRows: 'ecobaseRawImportRows',
} as const;

export type EcobaseCollectionName = (typeof ECOBASE_COLLECTIONS)[keyof typeof ECOBASE_COLLECTIONS];
