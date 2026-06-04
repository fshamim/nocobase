export const ECOBASE_COLLECTIONS = {
  companies: 'ecobaseCompanies',
  amazonAccounts: 'ecobaseAmazonAccounts',
  sourceConnections: 'ecobaseSourceConnections',
  importRuns: 'ecobaseImportRuns',
  rawImportRows: 'ecobaseRawImportRows',
  rawListings: 'ecobaseRawListings',
  planningProducts: 'ecobasePlanningProducts',
  planningProductListings: 'ecobasePlanningProductListings',
  planningProductMappingAudits: 'ecobasePlanningProductMappingAudits',
  listingDailyFacts: 'ecobaseListingDailyFacts',
  inventorySnapshots: 'ecobaseInventorySnapshots',
  trafficSnapshots: 'ecobaseTrafficSnapshots',
  planningParameters: 'ecobasePlanningParameters',
  targetRows: 'ecobaseTargetRows',
  sourceAccessAudits: 'ecobaseSourceAccessAudits',
} as const;

export type EcobaseCollectionName = (typeof ECOBASE_COLLECTIONS)[keyof typeof ECOBASE_COLLECTIONS];
