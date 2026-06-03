import { describe, expect, it } from 'vitest';
import amazonAccounts from '../collections/amazon-accounts';
import companies from '../collections/companies';
import importRuns from '../collections/import-runs';
import inventorySnapshots from '../collections/inventory-snapshots';
import listingDailyFacts from '../collections/listing-daily-facts';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import planningParameters from '../collections/planning-parameters';
import rawImportRows from '../collections/raw-import-rows';
import rawListings from '../collections/raw-listings';
import sourceAccessAudits from '../collections/source-access-audits';
import sourceConnections from '../collections/source-connections';
import targetRows from '../collections/target-rows';
import trafficSnapshots from '../collections/traffic-snapshots';

interface FieldOptions {
  name: string;
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  target?: string;
  foreignKey?: string;
}

interface CollectionOptions {
  name: string;
  autoGenId?: boolean;
  fields?: FieldOptions[];
}

function field(collection: CollectionOptions, name: string) {
  const match = collection.fields?.find((item) => item.name === name);
  if (!match) {
    throw new Error(`Expected collection ${collection.name} to define field ${name}.`);
  }
  return match;
}

describe('Ecobase plugin-owned schema', () => {
  it('defines company, account, source connection, import run, and raw row collections', () => {
    expect(companies.name).toBe(ECOBASE_COLLECTIONS.companies);
    expect(amazonAccounts.name).toBe(ECOBASE_COLLECTIONS.amazonAccounts);
    expect(sourceConnections.name).toBe(ECOBASE_COLLECTIONS.sourceConnections);
    expect(importRuns.name).toBe(ECOBASE_COLLECTIONS.importRuns);
    expect(rawImportRows.name).toBe(ECOBASE_COLLECTIONS.rawImportRows);
    expect(rawListings.name).toBe(ECOBASE_COLLECTIONS.rawListings);
    expect(listingDailyFacts.name).toBe(ECOBASE_COLLECTIONS.listingDailyFacts);
    expect(inventorySnapshots.name).toBe(ECOBASE_COLLECTIONS.inventorySnapshots);
    expect(trafficSnapshots.name).toBe(ECOBASE_COLLECTIONS.trafficSnapshots);
    expect(planningParameters.name).toBe(ECOBASE_COLLECTIONS.planningParameters);
    expect(targetRows.name).toBe(ECOBASE_COLLECTIONS.targetRows);
    expect(sourceAccessAudits.name).toBe(ECOBASE_COLLECTIONS.sourceAccessAudits);

    [companies, amazonAccounts, sourceConnections, importRuns, rawImportRows].forEach((collection) => {
      expect(collection.autoGenId).toBe(false);
      expect(field(collection, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    });
  });

  it('keeps source ingestion responsibilities on plugin-owned tables', () => {
    expect(field(companies, 'timezone')).toMatchObject({ type: 'string' });
    expect(field(amazonAccounts, 'company')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.companies,
      foreignKey: 'companyId',
    });
    expect(field(sourceConnections, 'sourceType')).toMatchObject({ type: 'string' });
    expect(field(sourceConnections, 'config')).toMatchObject({ type: 'jsonb' });
    expect(field(importRuns, 'idempotencyKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(importRuns, 'rowCount')).toMatchObject({ type: 'integer' });
    expect(field(rawImportRows, 'payload')).toMatchObject({ type: 'jsonb' });
    expect(field(rawImportRows, 'normalizedError')).toMatchObject({ type: 'text' });
    expect(field(rawListings, 'naturalKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(listingDailyFacts, 'refunds')).toMatchObject({ type: 'double' });
    expect(field(inventorySnapshots, 'stock')).toMatchObject({ type: 'double' });
    expect(field(trafficSnapshots, 'buyBoxPercentage')).toMatchObject({ type: 'double' });
    expect(field(planningParameters, 'leadTimeDays')).toMatchObject({ type: 'double' });
    expect(field(targetRows, 'periodType')).toMatchObject({ type: 'string' });
    expect(field(sourceAccessAudits, 'blockerCode')).toMatchObject({ type: 'string' });
  });
});
