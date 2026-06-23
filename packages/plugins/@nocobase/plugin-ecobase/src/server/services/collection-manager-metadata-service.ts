import type Database from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const OPERATOR_DASHBOARD_COLLECTIONS = [
  ECOBASE_COLLECTIONS.bronzeSourceFiles,
  ECOBASE_COLLECTIONS.bronzeSourceRecords,
  ECOBASE_COLLECTIONS.silverCompanies,
  ECOBASE_COLLECTIONS.silverAmazonAccounts,
  ECOBASE_COLLECTIONS.silverProducts,
  ECOBASE_COLLECTIONS.silverCompanyProducts,
  ECOBASE_COLLECTIONS.silverSuppliers,
  ECOBASE_COLLECTIONS.silverSupplierAccounts,
  ECOBASE_COLLECTIONS.silverSupplierProducts,
  ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
  ECOBASE_COLLECTIONS.silverOrders,
  ECOBASE_COLLECTIONS.silverOrderLines,
  ECOBASE_COLLECTIONS.silverInvoices,
  ECOBASE_COLLECTIONS.silverActivityComments,
  ECOBASE_COLLECTIONS.silverTasks,
  ECOBASE_COLLECTIONS.silverTaskLinks,
  ECOBASE_COLLECTIONS.silverHumanApprovals,
  ECOBASE_COLLECTIONS.silverHumanApprovalLinks,
  ECOBASE_COLLECTIONS.silverWorkflowActionPolicies,
  ECOBASE_COLLECTIONS.silverTargets,
  ECOBASE_COLLECTIONS.silverInventorySnapshots,
  ECOBASE_COLLECTIONS.silverListingDailyFacts,
  ECOBASE_COLLECTIONS.silverTrafficSnapshots,
  ECOBASE_COLLECTIONS.silverNormalizationLinks,
  ECOBASE_COLLECTIONS.sourceConnections,
  ECOBASE_COLLECTIONS.importRuns,
  ECOBASE_COLLECTIONS.rawImportRows,
  ECOBASE_COLLECTIONS.rawListings,
  ECOBASE_COLLECTIONS.listingDailyFacts,
  ECOBASE_COLLECTIONS.planningProducts,
  ECOBASE_COLLECTIONS.inventorySnapshots,
  ECOBASE_COLLECTIONS.inventoryPlanningRows,
  ECOBASE_COLLECTIONS.planningCalculationSnapshots,
  ECOBASE_COLLECTIONS.alerts,
  ECOBASE_COLLECTIONS.suppliers,
  ECOBASE_COLLECTIONS.supplierAttentionRows,
  ECOBASE_COLLECTIONS.supplierProductLinks,
  ECOBASE_COLLECTIONS.supplierOrders,
  ECOBASE_COLLECTIONS.supplierOrderLines,
  ECOBASE_COLLECTIONS.supplierOrderActivities,
  ECOBASE_COLLECTIONS.supplierLeadTimes,
];

type Repository = {
  findOne(
    options: Record<string, unknown>,
  ): Promise<{ load?: (options?: Record<string, unknown>) => Promise<unknown> } | null>;
  find(options: Record<string, unknown>): Promise<Array<{ get?: (key: string) => unknown; name?: string }>>;
  create(options: Record<string, unknown>): Promise<unknown>;
};

function clonePlain<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) => (typeof nestedValue === 'function' ? undefined : nestedValue)),
  );
}

function readFields(collection: { options?: Record<string, unknown> }) {
  const rawFields = collection.options?.fields;
  if (!Array.isArray(rawFields)) {
    return [];
  }
  return clonePlain(rawFields).filter((field) => {
    return typeof field?.name === 'string' && typeof field?.type === 'string';
  });
}

function buildCollectionValues(collection: { name: string; options?: Record<string, unknown> }) {
  const { fields: _fields, ...options } = clonePlain(collection.options || {});
  return {
    ...options,
    name: collection.name,
    origin: '@nocobase/plugin-ecobase',
    from: 'dbsync',
    fields: readFields(collection),
  };
}

export async function ensureEcobaseCollectionManagerMetadata(db: Database) {
  const collectionsRepository = getOptionalRepository(db, 'collections');
  const fieldsRepository = getOptionalRepository(db, 'fields');
  if (!collectionsRepository || !fieldsRepository) {
    return;
  }

  for (const collectionName of OPERATOR_DASHBOARD_COLLECTIONS) {
    const collection = db.getCollection(collectionName) as
      | { name: string; options?: Record<string, unknown> }
      | undefined;
    if (!collection) {
      throw new Error(`Ecobase collection manager metadata sync failed: missing collection ${collectionName}.`);
    }

    const existingCollection = await collectionsRepository.findOne({ filter: { name: collectionName } });
    const fields = readFields(collection);
    if (!existingCollection) {
      await collectionsRepository.create({ values: buildCollectionValues(collection) });
      continue;
    }

    const existingFields = await fieldsRepository.find({ filter: { collectionName }, fields: ['name'] });
    const existingFieldNames = new Set(
      existingFields.map((field) => String(typeof field.get === 'function' ? field.get('name') : field.name)),
    );
    for (const field of fields) {
      if (existingFieldNames.has(field.name)) {
        continue;
      }
      await fieldsRepository.create({ values: { ...field, collectionName } });
    }
    await existingCollection.load?.({ skipExist: false });
  }
}

function getOptionalRepository(db: Database, name: string) {
  try {
    return db.getRepository(name) as unknown as Repository | undefined;
  } catch {
    return undefined;
  }
}
