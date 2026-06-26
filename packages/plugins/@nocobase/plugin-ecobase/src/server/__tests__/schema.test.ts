import { describe, expect, it } from 'vitest';
import accuracyEvaluationRuns from '../collections/accuracy-evaluation-runs';
import aiAnswers from '../collections/ai-answers';
import alertEvaluations from '../collections/alert-evaluations';
import alerts from '../collections/alerts';
import amazonAccounts from '../collections/amazon-accounts';
import benchmarkFixtures from '../collections/benchmark-fixtures';
import clickupTaskSnapshots from '../collections/clickup-task-snapshots';
import companies from '../collections/companies';
import dailyBriefPromptSettings from '../collections/daily-brief-prompt-settings';
import dailyManagementSnapshots from '../collections/daily-management-snapshots';
import dataQualitySignoffs from '../collections/data-quality-signoffs';
import importRuns from '../collections/import-runs';
import inventoryPlanningRows from '../collections/inventory-planning-rows';
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
import reportItems from '../collections/report-items';
import reportRuns from '../collections/report-runs';
import ruleVersions from '../collections/rule-versions';
import sourceAccessAudits from '../collections/source-access-audits';
import sourceConnections from '../collections/source-connections';
import sourceWarningPolicies from '../collections/source-warning-policies';
import silverOrders from '../collections/silver-orders';
import silverProducts from '../collections/silver-products';
import silverSupplierAccounts from '../collections/silver-supplier-accounts';
import supplierAttentionRows from '../collections/supplier-attention-rows';
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
    expect(inventoryPlanningRows.name).toBe(ECOBASE_COLLECTIONS.inventoryPlanningRows);
    expect(trafficSnapshots.name).toBe(ECOBASE_COLLECTIONS.trafficSnapshots);
    expect(planningParameters.name).toBe(ECOBASE_COLLECTIONS.planningParameters);
    expect(suppliers.name).toBe(ECOBASE_COLLECTIONS.suppliers);
    expect(supplierLeadTimes.name).toBe(ECOBASE_COLLECTIONS.supplierLeadTimes);
    expect(supplierAttentionRows.name).toBe(ECOBASE_COLLECTIONS.supplierAttentionRows);
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
    expect(reportRuns.name).toBe(ECOBASE_COLLECTIONS.reportRuns);
    expect(reportItems.name).toBe(ECOBASE_COLLECTIONS.reportItems);
    expect(dailyManagementSnapshots.name).toBe(ECOBASE_COLLECTIONS.dailyManagementSnapshots);
    expect(dailyBriefPromptSettings.name).toBe(ECOBASE_COLLECTIONS.dailyBriefPromptSettings);
    expect(aiAnswers.name).toBe(ECOBASE_COLLECTIONS.aiAnswers);
    expect(dataQualitySignoffs.name).toBe(ECOBASE_COLLECTIONS.dataQualitySignoffs);
    expect(benchmarkFixtures.name).toBe(ECOBASE_COLLECTIONS.benchmarkFixtures);
    expect(accuracyEvaluationRuns.name).toBe(ECOBASE_COLLECTIONS.accuracyEvaluationRuns);

    [
      companies,
      amazonAccounts,
      sourceConnections,
      importRuns,
      rawImportRows,
      inventoryPlanningRows,
      planningProducts,
      planningProductListings,
      planningProductMappingAudits,
      suppliers,
      supplierAttentionRows,
      supplierOrders,
      supplierOrderLines,
      supplierOrderActivities,
      ruleVersions,
      alertEvaluations,
      alerts,
      reportRuns,
      reportItems,
      dailyManagementSnapshots,
      dailyBriefPromptSettings,
      aiAnswers,
      dataQualitySignoffs,
      benchmarkFixtures,
      accuracyEvaluationRuns,
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
    expect(field(inventoryPlanningRows, 'naturalKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(inventoryPlanningRows, 'actionStatus')).toMatchObject({ type: 'string' });
    expect(field(inventoryPlanningRows, 'leadTimeFreshness')).toMatchObject({ type: 'string' });
    expect(field(trafficSnapshots, 'buyBoxPercentage')).toMatchObject({ type: 'double' });
    expect(field(planningParameters, 'planningProductId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(planningParameters, 'leadTimeDays')).toMatchObject({ type: 'double' });
    expect(field(planningParameters, 'safetyBufferDays')).toMatchObject({ type: 'double' });
    expect(field(suppliers, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(suppliers, 'naturalKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(suppliers, 'receivedEmail')).toMatchObject({ type: 'string' });
    expect(field(suppliers, 'prPortalLink')).toMatchObject({ type: 'text' });
    expect(field(suppliers, 'portalUsername')).toMatchObject({ type: 'string' });
    expect(field(suppliers, 'portalPassword')).toMatchObject({ type: 'string' });
    expect(field(suppliers, 'productCatalog')).toMatchObject({ type: 'text' });
    expect(field(suppliers, 'mapAgreement')).toMatchObject({ type: 'text' });
    expect(field(suppliers, 'amazonAllow')).toMatchObject({ type: 'text' });
    expect(field(suppliers, 'respondedBy')).toMatchObject({ type: 'string' });
    expect(field(suppliers, 'totalNop')).toMatchObject({ type: 'string' });
    expect(field(suppliers, 'clearedPosAmount')).toMatchObject({ type: 'string' });
    expect(field(suppliers, 'timestamp')).toMatchObject({ type: 'datetimeTz' });
    expect(field(suppliers, 'approvalStatus')).toMatchObject({ type: 'string', defaultValue: 'new' });
    expect(field(suppliers, 'contactEstablished')).toMatchObject({ type: 'boolean', defaultValue: false });
    expect(field(supplierLeadTimes, 'leadTimeDays')).toMatchObject({ type: 'double' });
    expect(field(supplierAttentionRows, 'naturalKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(supplierAttentionRows, 'supplierId')).toMatchObject({ type: 'uuid', autoFill: false });
    expect(field(supplierAttentionRows, 'totalEstimatedProfitRisk')).toMatchObject({ type: 'double' });
    expect(field(supplierAttentionRows, 'reasonCodes')).toMatchObject({ type: 'jsonb' });
    expect(field(supplierAttentionRows, 'contactSoon')).toMatchObject({ type: 'boolean', defaultValue: false });
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
    expect(field(suppliers, 'wholesalePriceList')).toMatchObject({ type: 'text' });
    expect(field(suppliers, 'productCatalog')).toMatchObject({ type: 'text' });
    expect(field(suppliers, 'prPortalLink')).toMatchObject({ type: 'text' });
    expect(field(suppliers, 'amazonAllow')).toMatchObject({ type: 'text' });
    expect(field(supplierOrders, 'trackingId')).toMatchObject({ type: 'text' });
    expect(field(silverOrders, 'trackingId')).toMatchObject({ type: 'text' });
    expect(field(silverSupplierAccounts, 'portalUrl')).toMatchObject({ type: 'text' });
    expect(field(silverProducts, 'title')).toMatchObject({ type: 'text' });
    expect(field(reportRuns, 'frequency')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'emailStatus')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'briefType')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'idempotencyKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(reportRuns, 'evidencePack')).toMatchObject({ type: 'jsonb' });
    expect(field(reportRuns, 'evidenceHash')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'focus')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'validationStatus')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'deliveryStatus')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'deliveredAt')).toMatchObject({ type: 'datetimeTz' });
    expect(field(reportRuns, 'deliveryProvider')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'deliveryMessageId')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'deliveryError')).toMatchObject({ type: 'text' });
    expect(field(reportRuns, 'subject')).toMatchObject({ type: 'string' });
    expect(field(reportRuns, 'bodyMarkdown')).toMatchObject({ type: 'text' });
    expect(field(reportRuns, 'bodyHtml')).toMatchObject({ type: 'text' });
    expect(field(reportRuns, 'bodyText')).toMatchObject({ type: 'text' });
    expect(field(reportRuns, 'aiPrompt')).toMatchObject({ type: 'jsonb' });
    expect(field(reportRuns, 'aiRawResponse')).toMatchObject({ type: 'text' });
    expect(field(reportRuns, 'aiResponse')).toMatchObject({ type: 'jsonb' });
    expect(field(reportRuns, 'aiMetadata')).toMatchObject({ type: 'jsonb' });
    expect(field(reportRuns, 'validationErrors')).toMatchObject({ type: 'jsonb' });
    expect(field(reportRuns, 'items')).toMatchObject({
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.reportItems,
      foreignKey: 'reportRunId',
    });
    expect(field(reportItems, 'reportRun')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.reportRuns,
      foreignKey: 'reportRunId',
    });
    expect(field(reportItems, 'evidence')).toMatchObject({ type: 'jsonb' });
    expect(field(dailyManagementSnapshots, 'snapshotDate')).toMatchObject({ type: 'dateOnly' });
    expect(field(dailyManagementSnapshots, 'inventoryMoneyAtRisk')).toMatchObject({ type: 'double' });
    expect(field(dailyManagementSnapshots, 'orderMoneyAtRisk')).toMatchObject({ type: 'double' });
    expect(field(dailyManagementSnapshots, 'snapshotPayload')).toMatchObject({ type: 'jsonb' });
    expect(field(dailyBriefPromptSettings, 'directorInstructions')).toMatchObject({ type: 'text' });
    expect(field(dailyBriefPromptSettings, 'mustInclude')).toMatchObject({ type: 'jsonb' });
    expect(field(dailyBriefPromptSettings, 'kpiPriority')).toMatchObject({ type: 'jsonb' });
    expect(field(aiAnswers, 'question')).toMatchObject({ type: 'text' });
    expect(field(aiAnswers, 'evidenceReferences')).toMatchObject({ type: 'jsonb' });
    expect(field(aiAnswers, 'provider')).toMatchObject({ type: 'string' });
    expect(field(dataQualitySignoffs, 'checklist')).toMatchObject({ type: 'jsonb' });
    expect(field(benchmarkFixtures, 'expectedRootCauses')).toMatchObject({ type: 'jsonb' });
    expect(field(accuracyEvaluationRuns, 'criticalDetectionAccuracy')).toMatchObject({ type: 'double' });
  });
});
