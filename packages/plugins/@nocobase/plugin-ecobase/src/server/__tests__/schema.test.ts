import { describe, expect, it } from 'vitest';
import alertEvaluations from '../collections/alert-evaluations';
import alerts from '../collections/alerts';
import amazonAccounts from '../collections/amazon-accounts';
import clickupTaskSnapshots from '../collections/clickup-task-snapshots';
import companies from '../collections/companies';
import importRuns from '../collections/import-runs';
import inventorySnapshots from '../collections/inventory-snapshots';
import listingDailyFacts from '../collections/listing-daily-facts';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import okrMetricSnapshots from '../collections/okr-metric-snapshots';
import okrs from '../collections/okrs';
import planningCalculationSnapshots from '../collections/planning-calculation-snapshots';
import planningProductMappingAudits from '../collections/planning-product-mapping-audits';
import planningProductListings from '../collections/planning-product-listings';
import planningProducts from '../collections/planning-products';
import planningParameters from '../collections/planning-parameters';
import rawImportRows from '../collections/raw-import-rows';
import rawListings from '../collections/raw-listings';
import ruleVersions from '../collections/rule-versions';
import sourceAccessAudits from '../collections/source-access-audits';
import sourceConnections from '../collections/source-connections';
import sourceWarningPolicies from '../collections/source-warning-policies';
import supplierExternalIdentities from '../collections/supplier-external-identities';
import supplierLeadTimes from '../collections/supplier-lead-times';
import supplierOrderActivities from '../collections/supplier-order-activities';
import supplierOrderLines from '../collections/supplier-order-lines';
import supplierOrderSettings from '../collections/supplier-order-settings';
import supplierOrders from '../collections/supplier-orders';
import supplierProductLinks from '../collections/supplier-product-links';
import suppliers from '../collections/suppliers';
import targetRows from '../collections/target-rows';
import taskLinks from '../collections/task-links';
import trafficSnapshots from '../collections/traffic-snapshots';

interface FieldOptions {
  name: string;
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  autoFill?: boolean;
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
    expect(planningProducts.name).toBe(ECOBASE_COLLECTIONS.planningProducts);
    expect(planningProductListings.name).toBe(ECOBASE_COLLECTIONS.planningProductListings);
    expect(planningProductMappingAudits.name).toBe(ECOBASE_COLLECTIONS.planningProductMappingAudits);
    expect(listingDailyFacts.name).toBe(ECOBASE_COLLECTIONS.listingDailyFacts);
    expect(inventorySnapshots.name).toBe(ECOBASE_COLLECTIONS.inventorySnapshots);
    expect(trafficSnapshots.name).toBe(ECOBASE_COLLECTIONS.trafficSnapshots);
    expect(planningParameters.name).toBe(ECOBASE_COLLECTIONS.planningParameters);
    expect(suppliers.name).toBe(ECOBASE_COLLECTIONS.suppliers);
    expect(supplierLeadTimes.name).toBe(ECOBASE_COLLECTIONS.supplierLeadTimes);
    expect(supplierExternalIdentities.name).toBe(ECOBASE_COLLECTIONS.supplierExternalIdentities);
    expect(supplierProductLinks.name).toBe(ECOBASE_COLLECTIONS.supplierProductLinks);
    expect(supplierOrders.name).toBe(ECOBASE_COLLECTIONS.supplierOrders);
    expect(supplierOrderLines.name).toBe(ECOBASE_COLLECTIONS.supplierOrderLines);
    expect(supplierOrderActivities.name).toBe(ECOBASE_COLLECTIONS.supplierOrderActivities);
    expect(supplierOrderSettings.name).toBe(ECOBASE_COLLECTIONS.supplierOrderSettings);
    expect(targetRows.name).toBe(ECOBASE_COLLECTIONS.targetRows);
    expect(planningCalculationSnapshots.name).toBe(ECOBASE_COLLECTIONS.planningCalculationSnapshots);
    expect(ruleVersions.name).toBe(ECOBASE_COLLECTIONS.ruleVersions);
    expect(alertEvaluations.name).toBe(ECOBASE_COLLECTIONS.alertEvaluations);
    expect(alerts.name).toBe(ECOBASE_COLLECTIONS.alerts);
    expect(clickupTaskSnapshots.name).toBe(ECOBASE_COLLECTIONS.clickupTaskSnapshots);
    expect(taskLinks.name).toBe(ECOBASE_COLLECTIONS.taskLinks);
    expect(okrs.name).toBe(ECOBASE_COLLECTIONS.okrs);
    expect(okrMetricSnapshots.name).toBe(ECOBASE_COLLECTIONS.okrMetricSnapshots);
    expect(sourceAccessAudits.name).toBe(ECOBASE_COLLECTIONS.sourceAccessAudits);
    expect(sourceWarningPolicies.name).toBe(ECOBASE_COLLECTIONS.sourceWarningPolicies);

    [
      companies,
      amazonAccounts,
      sourceConnections,
      importRuns,
      rawImportRows,
      planningProducts,
      planningProductListings,
      planningProductMappingAudits,
      suppliers,
      supplierOrders,
      supplierOrderLines,
      supplierOrderActivities,
      ruleVersions,
      alertEvaluations,
      alerts,
    ].forEach((collection) => {
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
    expect(field(planningProducts, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(planningProducts, 'canonicalAsin')).toMatchObject({ type: 'string' });
    expect(field(planningProducts, 'listings')).toMatchObject({
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.planningProductListings,
      foreignKey: 'planningProductId',
    });
    expect(field(planningProductListings, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(planningProductListings, 'planningProduct')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.planningProducts,
      foreignKey: 'planningProductId',
    });
    expect(field(planningProductMappingAudits, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(planningProductMappingAudits, 'planningProduct')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.planningProducts,
      foreignKey: 'planningProductId',
    });
    expect(field(planningProductMappingAudits, 'previousPlanningProductId')).toMatchObject({
      type: 'uuid',
      autoFill: false,
    });
    expect(field(planningProductMappingAudits, 'nextPlanningProductId')).toMatchObject({
      type: 'uuid',
      autoFill: false,
    });
    expect(field(planningProductMappingAudits, 'action')).toMatchObject({ type: 'string' });
    expect(field(listingDailyFacts, 'planningProductId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(listingDailyFacts, 'refunds')).toMatchObject({ type: 'double' });
    expect(field(inventorySnapshots, 'planningProductId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(inventorySnapshots, 'stock')).toMatchObject({ type: 'double' });
    expect(field(trafficSnapshots, 'buyBoxPercentage')).toMatchObject({ type: 'double' });
    expect(field(planningParameters, 'planningProductId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(planningParameters, 'leadTimeDays')).toMatchObject({ type: 'double' });
    expect(field(planningParameters, 'safetyBufferDays')).toMatchObject({ type: 'double' });
    expect(field(suppliers, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(suppliers, 'naturalKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(supplierLeadTimes, 'leadTimeDays')).toMatchObject({ type: 'double' });
    expect(field(supplierExternalIdentities, 'supplierId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(supplierProductLinks, 'planningProductId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(supplierOrders, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(supplierOrders, 'status')).toMatchObject({ type: 'string' });
    expect(field(supplierOrders, 'lastOperatorActor')).toMatchObject({ type: 'string' });
    expect(field(supplierOrderLines, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(supplierOrderLines, 'receivedQty')).toMatchObject({ type: 'double' });
    expect(field(supplierOrderLines, 'lastOperatorEditAt')).toMatchObject({ type: 'datetimeTz' });
    expect(field(supplierOrderLines, 'lastOperatorActor')).toMatchObject({ type: 'string' });
    expect(field(supplierOrderActivities, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(supplierOrderActivities, 'occurredAt')).toMatchObject({ type: 'datetimeTz' });
    expect(field(supplierOrderSettings, 'numberValue')).toMatchObject({ type: 'double' });
    expect(field(targetRows, 'planningProductId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(targetRows, 'targetScope')).toMatchObject({ type: 'string' });
    expect(field(targetRows, 'periodType')).toMatchObject({ type: 'string' });
    expect(field(planningCalculationSnapshots, 'ruleVersion')).toMatchObject({ type: 'string' });
    expect(field(planningCalculationSnapshots, 'currentStockParity')).toMatchObject({ type: 'double' });
    expect(field(planningCalculationSnapshots, 'dataCompleteness')).toMatchObject({ type: 'string' });
    expect(field(ruleVersions, 'config')).toMatchObject({ type: 'jsonb' });
    expect(field(alertEvaluations, 'rootCauses')).toMatchObject({ type: 'jsonb' });
    expect(field(alertEvaluations, 'estimatedProfitRisk')).toMatchObject({ type: 'double' });
    expect(field(alerts, 'dedupeKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(alerts, 'primaryRootCauseCode')).toMatchObject({ type: 'string' });
    expect(field(alerts, 'actionRequired')).toMatchObject({ type: 'text' });
    expect(field(clickupTaskSnapshots, 'externalTaskId')).toMatchObject({ type: 'string' });
    expect(field(clickupTaskSnapshots, 'lastMeaningfulUpdateAt')).toMatchObject({ type: 'datetimeTz' });
    expect(field(taskLinks, 'targetType')).toMatchObject({ type: 'string' });
    expect(field(taskLinks, 'confidence')).toMatchObject({ type: 'double' });
    expect(field(okrs, 'owner')).toMatchObject({ type: 'string' });
    expect(field(okrs, 'operationalArea')).toMatchObject({ type: 'string' });
    expect(field(okrMetricSnapshots, 'progressPercent')).toMatchObject({ type: 'double' });
    expect(field(sourceAccessAudits, 'blockerCode')).toMatchObject({ type: 'string' });
    expect(field(sourceWarningPolicies, 'sourceType')).toMatchObject({ type: 'string', unique: true });
    expect(field(sourceWarningPolicies, 'freshnessSlaMinutes')).toMatchObject({ type: 'integer' });
  });
});
