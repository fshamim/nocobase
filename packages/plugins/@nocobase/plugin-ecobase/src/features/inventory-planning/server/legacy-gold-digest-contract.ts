/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

const LEGACY_FIELDS = `actionStatus
amazonPipelineStock
amazonReceiptCompletionReason
amazonReceiptEvidenceJson
amazonReceiptObservedAt
amazonReceiptStatus
asin
averageTier
averageTierScore
awdStock
bestTier
bestTierScore
brand
calculationDate
calculationProvenanceJson
commandCenterPane
commandCenterPaneReason
company
companyProductFamilyId
companyProductId
currentPlanningStock
currentTier
currentTierScore
dataQualityIssues
dataQualityStatus
daysOfCover
daysUntilOos
daysUntilSafeReorder
digestPriority
estimatedOosDate
estimatedOrderCost
estimatedProfitRisk
estimatedProfitRiskBasis
evidence
expectedArrivalAsOf
expectedArrivalConfidence
expectedArrivalDate
expectedArrivalFreshness
expectedArrivalSource
expectedArrivalStatus
familyAmazonAccountId
familyAmazonPipelineStock
familyAwdStock
familyCanonicalAsin
familyCurrentPlanningStock
familyDaysOfCover
familyEstimatedOosDate
familyEstimatedOrderCost
familyFuturePositionStock
familyInboundStock
familyInventoryPositionStock
familyLeadTimeDays
familyMarketplace
familyMemberCount
familyOnHandSellableStock
familyOnHandStock
familyOpenOrderCoverageQty
familyOrderedStock
familyPipelineStock
familyPositionDaysOfCover
familyPositionEstimatedOosDate
familyPreferredSupplierId
familyPreferredSupplierName
familyPreferredSupplierProductId
familyPrepStock
familyReservedStock
familyRole
familyRollupEvidence
familySalesVelocity
familySellableStock
familyStuck
familyStuckAction
familyStuckActiveOrderCount
familyStuckAffectedMemberCount
familyStuckAffectedUnits
familyStuckAffectedValue
familyStuckClassification
familyStuckEvidence
familySuggestedReorderQty
familySupplierPipelineStock
familyTier
familyTierScore
familyTrustedSupplierOrderCoverageQty
familyUnitCost
futurePositionStock
id
inboundStock
inventoryAsOfDate
inventoryPositionStock
lastMonthQty
latestSafeReorderDate
latestSupplierOrderActivityActor
latestSupplierOrderActivityActorDisplayName
latestSupplierOrderActivityActorEmail
latestSupplierOrderActivityActorUserId
latestSupplierOrderActivityAt
latestSupplierOrderActivityNote
latestSupplierOrderActivitySource
latestSupplierOrderActivityType
leadTimeAvailability
leadTimeConfirmedAt
leadTimeDays
leadTimeFreshness
leadTimeFreshnessDays
moneyRiskInputs
moneyRiskStatus
moneyRiskUncoveredDays
naturalKey
onHandSellableStock
onHandStock
openOrderCoverageQty
operationalIssues
orderSoonWindowDays
orderedStock
pipelineHealthStatus
pipelineStock
planningEligibilityReason
planningEligibilityStatus
planningExcluded
planningProductId
positionDaysOfCover
positionEstimatedOosDate
prepStock
previousTier
productStatus
profitAvailability
profitPerUnit
purchasedPipelineGraceDays
readinessDomains
readinessReasonCodes
recentUnits30
recommendedBestQty
recommendedEscalation
refreshRunId
reorderCycleDays
replenishmentTargetCompanyProductId
replenishmentTargetSku
reservedStock
safetyBufferDays
salesVelocity
salesVelocityAsOfDate
salesVelocityBasis
salesVelocityStatus
salesVelocityWindowEnd
salesVelocityWindowStart
sellableStock
sixMonthAverageQty
sixMonthBestQty
sixMonthMargin
sixMonthWorstQty
sku
sourceFreshnessStatus
stockoutGapDays
stuck
stuckClassification
suggestedReorderQty
supplierAvailability
supplierConfidence
supplierId
supplierName
supplierOrderAuthorityAsOf
supplierOrderAuthorityEvidence
supplierOrderAuthoritySource
supplierOrderAuthorityStatus
supplierOrderAuthorityTaskRef
supplierOrderCycleReviewRequired
supplierOrderCycleSelection
supplierOrderId
supplierOrderLineMappingScope
supplierOrderOpenQty
supplierOrderOperationalStatus
supplierOrderPlacedNotPurchasedOpenQty
supplierOrderPurchasedOpenQty
supplierOrderRef
supplierOrderReferenceOpenQty
supplierOrderSourceMemberSku
supplierOrderStale
supplierOrderState
supplierOrderStatus
supplierOrderWorkflowStage
supplierPipelineStock
supplierRole
supplierSource
targetCoverDays
tier
tierEligibilityReason
tierMovement
tierRuleVersion
tierScore
title
trustedSupplierOrderCoverageQty
unitCost
unitCostAvailability
unitCostSource`.split('\n');

export const LEGACY_STEP19_GOLD_DIGEST_CONTRACT = Object.freeze({
  rowCount: 2363,
  bytes: 28176081,
  sha256: 'a26aba6955e14a336abb47efb6f4735466fce50a34db50445fedb94ead828fe6',
  serializerVersion: 'step19_v1:postgres-copy-text(to_jsonb(row)-createdAt-updatedAt-lastRefreshedAt),ordered-by-id',
  fields: Object.freeze(LEGACY_FIELDS),
});

export function projectLegacyStep19GoldRow(row: Record<string, unknown>) {
  return Object.fromEntries(LEGACY_STEP19_GOLD_DIGEST_CONTRACT.fields.map((name) => [name, row[name]]));
}

export function legacyStep19GoldProjectionSql(rowAlias = 'legacy_row') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rowAlias)) {
    throw new Error(`EcoBase legacy Gold digest projection rejected invalid SQL row alias "${rowAlias}".`);
  }
  const fields = LEGACY_STEP19_GOLD_DIGEST_CONTRACT.fields.map((name) => `'${name}'`).join(', ');
  return `(select jsonb_object_agg(entry.key, entry.value) from jsonb_each(to_jsonb(${rowAlias})) entry where entry.key = any(array[${fields}]::text[]))`;
}
