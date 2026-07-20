/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import {
  EcobaseSupplierOrderService,
  normalizeSupplierOrderStatus,
} from '../../supplier-management/server/supplier-order-service';
import {
  amazonReceivedQty,
  silverOrderStatus,
  silverSupplierOrderReadModel,
} from '../../supplier-management/server/silver-supplier-order-read-model';
import { toPlainRecord } from '../../source-import/server/import-service';
import { EcobaseSellerboardCogsService } from '../../source-import/server/sellerboard-cogs-service';
import { EcobaseSilverDataService } from '../../semantic-model/server/silver-data-service';
import { addDays, diffDays, isoDate, optionalIsoDate } from './planning-date';
import {
  DEFAULT_PLANNING_SETTINGS,
  EcobasePlanningSettingsService,
  type EcobasePlanningSettings,
  type SupplierOrderStatusBuckets,
} from '../../../server/services/planning-settings-service';
import {
  isProfitTier,
  profitTierFor,
  profitTierMovement,
  rollingDemandProfitTier,
  profitTierRank,
  type ProfitTierThresholds,
} from './profit-tier';
import { summarizeHistoricalProductFacts } from './historical-product-metrics';
import { latestPreferredInventorySnapshot } from './order-receipt-evidence';
import { selectCurrentFamilyOrderCycle, type FamilyOrderCycleSelection } from './order-cycle-selection';
import { evaluatePlanningReadiness } from './planning-readiness';
import { workflowStageForOperationalStatus } from '../../order-planning/order-operational-status';
import { canonicalJson, EcobaseGoldRefreshRunService } from './gold-refresh-run-service';
import {
  buildCorrectedInventoryPlanningCandidate,
  CORRECTED_CANDIDATE_FAMILY_COUNT,
  CORRECTED_CANDIDATE_LISTING_COUNT,
  CorrectedCandidateBuilderError,
  type CorrectedCandidateCoverageInterval,
  type CorrectedCandidateCoverageMembership,
  type CorrectedCandidateFamilySnapshot,
  type CorrectedCandidateSettings,
  type CorrectedCandidateSourceFact,
  type CorrectedOperationalListingSnapshot,
} from './corrected-candidate-builder';
import { EcobaseInventoryPlanningGoldAccess } from './inventory-planning-gold-access';
import { withGoldInventoryPlanningWriteAuthority } from './gold-write-guard';
import { OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS } from './gold-schema-contract';
import {
  CORRECTED_ALGORITHM_CONTRACT_VERSION,
  CORRECTED_CANONICAL_SERIALIZER_VERSION,
  CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
  CORRECTED_LISTING_ROW_DIGEST_VERSION,
  CORRECTED_TIER_RULE_VERSION,
  deriveListingReviewCategories,
  filterListingPerformanceReview,
  listingMemberPerformanceEvidence,
  type CorrectedFamilyActionProjection,
  type CorrectedListingPerformanceRow,
  type ListingReviewCategory,
} from './listing-family-projection';
import {
  classifyInventoryFamily,
  INVENTORY_PLANNING_PANES,
  type InventoryPlanningPane,
} from './inventory-planning-pane-classifier';

const GOLD_SOURCE_RECORD_LIMIT = 100000;
const CORRECTED_CANDIDATE_PROTECTED_COLLECTIONS = [
  ECOBASE_COLLECTIONS.silverCompanies,
  ECOBASE_COLLECTIONS.silverAmazonAccounts,
  ECOBASE_COLLECTIONS.silverProducts,
  ECOBASE_COLLECTIONS.silverCompanyProducts,
  ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
  ECOBASE_COLLECTIONS.silverInventorySnapshots,
  ECOBASE_COLLECTIONS.silverListingDailyFacts,
  ECOBASE_COLLECTIONS.silverTrafficSnapshots,
  ECOBASE_COLLECTIONS.sellerboardProductCosts,
] as const;
export type InventoryPlanningActionStatus =
  | 'excluded'
  | 'missing_inventory'
  | 'missing_velocity'
  | 'no_sell_through'
  | 'missing_lead_time'
  | 'stale_lead_time'
  | 'overdue'
  | 'order_today'
  | 'order_soon'
  | 'already_ordered'
  | 'watch'
  | 'sufficient_stock';

export interface InventoryPlanningQuery {
  company?: string;
  calculationDate?: string;
  leadTimeFreshnessDays?: number;
  safetyBufferDays?: number;
  orderSoonWindowDays?: number;
  reorderCycleDays?: number;
  targetCoverDays?: number;
  purchasedPipelineGraceDays?: number;
  defaultSupplierLeadTimeDays?: number;
  limit?: number;
}

export interface InventoryPlanningRefreshQuery extends InventoryPlanningQuery {
  idempotencyKey?: string;
  requestedByUserId?: string;
  publish?: boolean;
}

export interface InventoryPlanningRowWorkspaceQuery {
  company?: string;
  familyId?: string;
  currentOrderId?: string;
  planningProductId?: string;
  companyProductId?: string;
  asin?: string;
  sku?: string;
  supplierId?: string;
  limit?: number;
}

export interface InventoryBudgetOptimizationQuery extends InventoryPlanningQuery {
  budget: number;
  horizonDays?: number;
}

export interface UpdateProductPlanningFieldsParams {
  companyProductId: string;
  planningExcluded?: boolean;
  reorderCycleDays?: number;
  targetCoverDays?: number;
  reason?: string;
  actorUserId?: string;
}

export type InventoryCommandCenterPane = InventoryPlanningPane;

export interface InventoryPlanningListingReviewQuery extends InventoryPlanningQuery {
  categories?: ListingReviewCategory[];
}

export interface InventoryPlanningCommandCenterQuery extends InventoryPlanningQuery {
  pane?: InventoryCommandCenterPane;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  filters?: Record<string, unknown>;
  selectedRowId?: string;
  planningProductId?: string;
  companyProductId?: string;
  asin?: string;
  sku?: string;
}

type PlainRecord = Record<string, unknown>;
type CorrectedFamilyActionReadRow = CorrectedListingPerformanceRow & CorrectedFamilyActionProjection;

type PublishedInventoryPlanningReadModel = {
  listingRows: CorrectedListingPerformanceRow[];
  familyActions: CorrectedFamilyActionReadRow[];
  evidenceRowsByFamily: Map<string, CorrectedListingPerformanceRow[]>;
  metadata: {
    scope: 'family_action';
    rowUnit: 'family';
    calculationDate: string | null;
    publishedRunId: string | null;
    denominatorCount: number;
    hiddenEvidenceRowCount: number;
    averageMonthlyProfitDenominatorCount: number;
    baselineTierCounts: Record<'A' | 'B' | 'C' | 'D', number>;
    baselineStateCounts: Record<string, number>;
    dataReadinessCount: number;
    nullAverageMonthlyProfitCount: number;
    actionDecisionCounts: {
      newReplenishment: number;
      existingOrderFollowUp: number;
      mutualExclusivityViolations: number;
    };
  };
};
type GoldTransactionRepository = {
  find(params: { filter: PlainRecord; limit?: number; transaction?: unknown }): Promise<unknown[]>;
  create(params: { values: PlainRecord; transaction?: unknown }): Promise<unknown>;
};

const COMMAND_CENTER_PANES: InventoryCommandCenterPane[] = [...INVENTORY_PLANNING_PANES];

const COMMAND_CENTER_SORT_KEYS = new Set([
  'amazonReceiptObservedAt',
  'asin',
  'averageMonthlyProfit',
  'baselineTier',
  'closedTierMovement',
  'company',
  'currentPlanningStock',
  'daysOfCover',
  'daysUntilOos',
  'daysUntilSafeReorder',
  'expectedArrivalDate',
  'inventoryAsOfDate',
  'inventoryPositionStock',
  'primaryActionPane',
  'projectedTierMovement',
  'recommendedOrderQty',
  'sku',
  'stockoutGapDays',
  'supplierName',
  'title',
]);

export type SupplierOrderStatusRules = {
  placedNotPurchased: Set<string>;
  purchasedPipeline: Set<string>;
  closed: Set<string>;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecordIdString(value: unknown): string | undefined {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim().length > 0
    ? String(value).trim()
    : undefined;
}

function asRecordIdFilterValue(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : value;
}

function displayNameForUser(user: PlainRecord) {
  return asString(user.nickname) ?? asString(user.name) ?? asString(user.email) ?? asString(user.username);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function publishedReadModelValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return value === undefined ? null : value;
}

function sanitizePublishedCalculationEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePublishedCalculationEvidence);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as PlainRecord)
      .filter(([field]) => !LEGACY_PUBLIC_INVENTORY_PLANNING_FIELDS.has(field))
      .map(([field, nested]) => [field, sanitizePublishedCalculationEvidence(nested)]),
  );
}

function publishedReadModelFieldValue(field: string, value: unknown) {
  return field === 'calculationEvidence' ? sanitizePublishedCalculationEvidence(value) : publishedReadModelValue(value);
}

function correctedTierRank(value: unknown) {
  const rank = { A: 0, B: 1, C: 2, D: 3 }[asString(value) ?? ''];
  return rank ?? 4;
}

function familyActionKey(row: PlainRecord) {
  return (
    asString(row.companyProductFamilyId) ??
    [row.company, row.amazonAccountId, row.marketplace, row.asin, row.id].map((value) => String(value ?? '')).join(':')
  );
}

export function projectCorrectedInventoryPlanningListingRow(row: PlainRecord) {
  return {
    ...Object.fromEntries(
      PUBLISHED_INVENTORY_PLANNING_ROW_FIELDS.map((field) => [field, publishedReadModelFieldValue(field, row[field])]),
    ),
    id: publishedReadModelValue(row.id),
    naturalKey: publishedReadModelValue(row.naturalKey),
    refreshRunId: publishedReadModelValue(row.refreshRunId),
  };
}

export function projectCorrectedInventoryPlanningListingRows(rows: PlainRecord[]) {
  return rows.map(projectCorrectedInventoryPlanningListingRow);
}

const FAMILY_ACTION_CONSUMER_FIELDS = [
  'runId',
  'generatedAt',
  'naturalKey',
  'familyKey',
  'companyProductFamilyId',
  'companyId',
  'amazonAccountId',
  'marketplace',
  'canonicalAsin',
  'targetSelectionState',
  'targetCompanyProductId',
  'representativeCompanyProductId',
  'actionSourceCompanyProductId',
  'memberCount',
  'primaryActionPane',
  'primaryActionReasonCode',
  'replenishmentEligibility',
  'replenishmentBlockReasonCode',
  'newReplenishmentActionable',
  'oosAlertActionable',
  'supplyActionable',
  'existingOrderFollowUp',
  'existingOrderFollowUpAction',
  'recommendedOrderQty',
  'alternateRecommendationCompanyProductIds',
  'targetSelectionEvidence',
  'linkedMemberEvidence',
  'listing',
  'memberPerformanceEvidence',
] as const;

/**
 * TD-19 family-action consumer mapping:
 * 1. One immutable action is exposed per derived family.
 * 2. Frozen targets own action identity and decisions.
 * 3. Review-family representatives provide display evidence only.
 * 4. Pane, eligibility, actionability, and quantity stay digest-bound.
 * 5. Member order/receipt and disposition evidence stays nested and cannot override the action.
 * 6. Member stock and velocity stay listing-scoped and are never aggregated or recomputed here.
 * 7. Linked listings remain evidence and never create duplicate family actions.
 */
export function projectCorrectedInventoryPlanningFamilyAction(
  action: PlainRecord,
  publishedMembers: CorrectedListingPerformanceRow[],
) {
  const sortedMembers = [...publishedMembers].sort((left, right) =>
    String(left.companyProductId).localeCompare(String(right.companyProductId)),
  );
  const target = sortedMembers.find((row) => row.companyProductId === action.actionSourceCompanyProductId);
  const representative =
    target ?? sortedMembers.find((row) => row.companyProductId === action.representativeCompanyProductId);
  if (!representative) {
    throw new Error(
      `EcoBase family-action read projection is missing representative listing "${String(
        action.representativeCompanyProductId ?? '',
      )}" for family "${String(action.companyProductFamilyId ?? '')}".`,
    );
  }
  if (action.targetSelectionState === 'frozen_target' && !target) {
    throw new Error(
      `EcoBase family-action read projection is missing frozen action source "${String(
        action.actionSourceCompanyProductId ?? '',
      )}" for family "${String(action.companyProductFamilyId ?? '')}".`,
    );
  }
  return {
    ...projectCorrectedInventoryPlanningListingRow(representative),
    ...Object.fromEntries(
      FAMILY_ACTION_CONSUMER_FIELDS.map((field) => [field, sanitizePublishedCalculationEvidence(action[field])]),
    ),
    id: publishedReadModelValue(representative?.id),
    refreshRunId: publishedReadModelValue(action.runId),
    listing: target ? projectCorrectedInventoryPlanningListingRow(target) : null,
    memberPerformanceEvidence: sortedMembers.map(listingMemberPerformanceEvidence),
  } as unknown as CorrectedFamilyActionReadRow;
}

export function projectCorrectedInventoryPlanningFamilyActions(actions: PlainRecord[], listingRows: PlainRecord[]) {
  const publishedListings = projectCorrectedInventoryPlanningListingRows(listingRows).map(
    (row) => row as unknown as CorrectedListingPerformanceRow,
  );
  const membersByFamily = new Map<string, CorrectedListingPerformanceRow[]>();
  for (const listing of publishedListings) {
    const key = familyActionKey(listing);
    membersByFamily.set(key, [...(membersByFamily.get(key) ?? []), listing]);
  }
  return actions.map((action) =>
    projectCorrectedInventoryPlanningFamilyAction(action, membersByFamily.get(familyActionKey(action)) ?? []),
  );
}

function buildPublishedInventoryPlanningReadModel(
  listingRows: PlainRecord[],
  familyActions: PlainRecord[],
  publishedRun: PlainRecord | null,
): PublishedInventoryPlanningReadModel {
  const correctedListingRows = projectCorrectedInventoryPlanningListingRows(listingRows)
    .map((listing) => listing as unknown as CorrectedListingPerformanceRow)
    .sort((left, right) => String(left.companyProductId).localeCompare(String(right.companyProductId)));
  const evidenceRowsByFamily = new Map<string, CorrectedListingPerformanceRow[]>();
  for (const listing of correctedListingRows) {
    const key = familyActionKey(listing);
    evidenceRowsByFamily.set(key, [...(evidenceRowsByFamily.get(key) ?? []), listing]);
  }
  const correctedFamilyActions = projectCorrectedInventoryPlanningFamilyActions(familyActions, correctedListingRows)
    .filter((row) => row.primaryActionPane !== 'adminExcluded')
    .sort((left, right) => String(left.companyProductFamilyId).localeCompare(String(right.companyProductFamilyId)));
  return {
    listingRows: correctedListingRows,
    familyActions: correctedFamilyActions,
    evidenceRowsByFamily,
    metadata: {
      scope: 'family_action',
      rowUnit: 'family',
      calculationDate: asString(publishedRun?.calculationDate) ?? null,
      publishedRunId: asString(publishedRun?.id) ?? null,
      denominatorCount: correctedFamilyActions.length,
      hiddenEvidenceRowCount: Math.max(correctedListingRows.length - correctedFamilyActions.length, 0),
      averageMonthlyProfitDenominatorCount: correctedFamilyActions.filter((row) =>
        ['supplyAction', 'activeOrders', 'inPrepMonitoring', 'inboundMonitoring'].includes(
          asString(row.primaryActionPane) ?? '',
        ),
      ).length,
      baselineTierCounts: Object.fromEntries(
        ['A', 'B', 'C', 'D'].map((tier) => [
          tier,
          correctedFamilyActions.filter((row) => row.baselineTier === tier).length,
        ]),
      ) as Record<'A' | 'B' | 'C' | 'D', number>,
      baselineStateCounts: correctedFamilyActions.reduce<Record<string, number>>((counts, row) => {
        const state = asString(row.baselineState) ?? 'unknown';
        counts[state] = (counts[state] ?? 0) + 1;
        return counts;
      }, {}),
      dataReadinessCount: correctedFamilyActions.filter((row) => row.primaryActionPane === 'dataReadiness').length,
      nullAverageMonthlyProfitCount: correctedFamilyActions.filter((row) => row.averageMonthlyProfit == null).length,
      actionDecisionCounts: {
        newReplenishment: correctedFamilyActions.filter((row) => row.newReplenishmentActionable === true).length,
        existingOrderFollowUp: correctedFamilyActions.filter((row) => row.existingOrderFollowUp === true).length,
        mutualExclusivityViolations: correctedFamilyActions.filter(
          (row) => row.newReplenishmentActionable === true && row.existingOrderFollowUp === true,
        ).length,
      },
    },
  };
}

function familyActionAverageMonthlyProfit(rows: PlainRecord[]) {
  const denominatorRows = rows.filter((row) =>
    ['supplyAction', 'activeOrders', 'inPrepMonitoring', 'inboundMonitoring'].includes(
      asString(row.primaryActionPane) ?? '',
    ),
  );
  const knownValues = denominatorRows
    .map((row) => asNumber(row.averageMonthlyProfit))
    .filter((value): value is number => typeof value === 'number');
  return {
    value: Math.round(knownValues.reduce((total, value) => total + value, 0) * 100) / 100,
    unknownCount: denominatorRows.length - knownValues.length,
    denominatorCount: denominatorRows.length,
    knownCount: knownValues.length,
  };
}

function asPositiveInteger(value: unknown, fallback: number, max: number) {
  const parsed = asNumber(value);
  if (typeof parsed !== 'number') return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function commandCenterPane(value: unknown): InventoryCommandCenterPane | undefined {
  return COMMAND_CENTER_PANES.includes(value as InventoryCommandCenterPane)
    ? (value as InventoryCommandCenterPane)
    : undefined;
}

function daysUntilDate(date: unknown, calculationDate: string) {
  const value = optionalIsoDate(asString(date) ?? '');
  return value ? diffDays(value, calculationDate) : undefined;
}

function operationalDaysOfCover(row: PlainRecord) {
  return asString(row.familyRole) === 'target'
    ? asNumber(row.familyDaysOfCover) ?? asNumber(row.daysOfCover)
    : asNumber(row.daysOfCover);
}

function operationalEstimatedOosDate(row: PlainRecord) {
  return asString(row.familyRole) === 'target'
    ? optionalIsoDate(asString(row.familyEstimatedOosDate) ?? '') ??
        optionalIsoDate(asString(row.estimatedOosDate) ?? '')
    : optionalIsoDate(asString(row.estimatedOosDate) ?? '');
}

function stockoutGapDays(row: PlainRecord) {
  const estimatedOosDate = operationalEstimatedOosDate(row);
  const expectedArrivalDate = optionalIsoDate(asString(row.expectedArrivalDate) ?? '');
  return estimatedOosDate && expectedArrivalDate ? diffDays(expectedArrivalDate, estimatedOosDate) : undefined;
}

function inboundMonitoringEvidence(row: PlainRecord) {
  const authorityEvidence = toPlainRecord(row.supplierOrderAuthorityEvidence);
  const statusEvidence = asString(toPlainRecord(authorityEvidence.clickupStatusEvidence).clickupStatus);
  if (statusEvidence !== 'inbound-monitoring') return {};
  return {
    matchState: statusEvidence === 'inbound-monitoring' ? 'exact_order_reference' : 'review_required',
    matchedOrderReference: asString(row.supplierOrderRef),
    statusEvidence,
    statusAsOf: asString(row.supplierOrderAuthorityAsOf),
    dateEvidence: asString(row.expectedArrivalDate),
    dateConfidence: asString(row.expectedArrivalConfidence),
    stockEvidence: {
      onHandSellableStock:
        asNumber(row.onHandSellableStock) ?? asNumber(row.onHandStock) ?? asNumber(row.sellableStock),
      amazonPipelineStock: asNumber(row.amazonPipelineStock) ?? asNumber(row.pipelineStock),
      inventoryAsOfDate: asString(row.inventoryAsOfDate),
      receiptStatus: asString(row.amazonReceiptStatus),
      receiptObservedAt: asString(row.amazonReceiptObservedAt),
    },
    reviewState: asString(row.dataQualityStatus) ?? 'unknown',
  };
}

export function calculateInventoryMoneyRisk(row: PlainRecord) {
  const salesVelocity = asNumber(row.salesVelocity);
  const profitPerUnit = asNumber(row.profitPerUnit);
  const daysOfCover = operationalDaysOfCover(row);
  const targetCoverDays = asNumber(row.targetCoverDays);
  const missingInputs = [
    !(typeof salesVelocity === 'number' && salesVelocity > 0) ? 'trusted_velocity' : undefined,
    typeof profitPerUnit !== 'number' ? 'profit_per_unit' : undefined,
    typeof daysOfCover !== 'number' ? 'days_of_cover' : undefined,
    typeof targetCoverDays !== 'number' ? 'target_cover_days' : undefined,
  ].filter((value): value is string => Boolean(value));
  const inputs = {
    salesVelocity,
    profitPerUnit,
    daysOfCover,
    targetCoverDays,
    onHandSellableStock: asNumber(row.onHandSellableStock) ?? asNumber(row.onHandStock) ?? asNumber(row.sellableStock),
    amazonPipelineStock: asNumber(row.amazonPipelineStock) ?? asNumber(row.pipelineStock) ?? 0,
    supplierPipelineStock:
      asNumber(row.supplierPipelineStock) ??
      asNumber(row.trustedSupplierOrderCoverageQty) ??
      asNumber(row.openOrderCoverageQty) ??
      0,
    stockoutGapDays: stockoutGapDays(row),
  };
  if (missingInputs.length > 0) {
    return {
      estimatedProfitRisk: undefined,
      estimatedProfitRiskBasis: 'uncovered_stockout_days_x_trusted_daily_velocity_x_profit_per_unit',
      moneyRiskStatus: 'unknown_missing_inputs',
      moneyRiskUncoveredDays: undefined,
      moneyRiskInputs: { ...inputs, missingInputs },
    };
  }

  const activeOrder = ['purchased_pipeline', 'placed_not_purchased'].includes(asString(row.supplierOrderState) ?? '');
  if (activeOrder && (!asString(row.expectedArrivalDate) || asString(row.expectedArrivalStatus) === 'unknown')) {
    return {
      estimatedProfitRisk: undefined,
      estimatedProfitRiskBasis: 'uncovered_stockout_days_x_trusted_daily_velocity_x_profit_per_unit',
      moneyRiskStatus: 'unknown_arrival',
      moneyRiskUncoveredDays: undefined,
      moneyRiskInputs: { ...inputs, missingInputs: ['expected_arrival'] },
    };
  }

  const coverageDays =
    ((asNumber(row.amazonPipelineStock) ?? asNumber(row.pipelineStock) ?? 0) +
      (asNumber(row.supplierPipelineStock) ??
        asNumber(row.trustedSupplierOrderCoverageQty) ??
        asNumber(row.openOrderCoverageQty) ??
        0)) /
    (salesVelocity as number);
  const coverageShortfallDays = Math.max((targetCoverDays as number) - (daysOfCover as number) - coverageDays, 0);
  const timingGapDays = activeOrder ? Math.max(stockoutGapDays(row) ?? 0, 0) : 0;
  const uncoveredDays = Math.max(coverageShortfallDays, timingGapDays);
  const rawProfitRisk = uncoveredDays * (salesVelocity as number) * Math.max(profitPerUnit as number, 0);
  const estimatedProfitRisk = Math.round((rawProfitRisk + Math.sign(rawProfitRisk) * 1e-9) * 100) / 100;
  return {
    estimatedProfitRisk,
    estimatedProfitRiskBasis: 'uncovered_stockout_days_x_trusted_daily_velocity_x_profit_per_unit',
    moneyRiskStatus: estimatedProfitRisk > 0 ? 'resolved_positive' : 'resolved_zero',
    moneyRiskUncoveredDays: uncoveredDays,
    moneyRiskInputs: { ...inputs, coverageShortfallDays, timingGapDays, missingInputs: [] },
  };
}

function pipelineHealthStatus(row: PlainRecord, calculationDate: string) {
  const state = asString(row.supplierOrderState);
  if (state === 'placed_not_purchased') return 'placed_not_purchased';
  if (state !== 'purchased_pipeline') return 'none';
  if (asString(row.expectedArrivalStatus) === 'unknown') return 'unknown_timing';
  const gap = stockoutGapDays(row);
  if (typeof gap === 'number' && gap > 0) return 'late';
  const daysUntilExpectedArrival = daysUntilDate(row.expectedArrivalDate, calculationDate);
  if (typeof daysUntilExpectedArrival === 'number' && daysUntilExpectedArrival < 0) return 'late';
  return typeof daysUntilExpectedArrival === 'number' ? 'on_track' : 'unknown_timing';
}

function exactWorkflowStatus(row: PlainRecord) {
  const evidence = toPlainRecord(row.supplierOrderAuthorityEvidence);
  return (
    asString(toPlainRecord(evidence.clickupStatusEvidence).clickupStatus) ??
    asString(row.supplierOrderOperationalStatus) ??
    asString(row.supplierOrderWorkflowStage)
  )
    ?.trim()
    .toLowerCase();
}

function inventoryWorkflowStage(row: PlainRecord) {
  const persistedStage = asString(row.supplierOrderWorkflowStage)?.toLowerCase();
  return persistedStage ?? workflowStageForOperationalStatus(exactWorkflowStatus(row));
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function familyStockValues(row: PlainRecord) {
  return [
    asNumber(row.familySellableStock) ?? asNumber(row.sellableStock),
    asNumber(row.familyReservedStock) ?? asNumber(row.reservedStock),
    asNumber(row.familyOrderedStock) ?? asNumber(row.orderedStock),
    asNumber(row.familyPrepStock) ?? asNumber(row.prepStock),
    asNumber(row.familyInboundStock) ?? asNumber(row.inboundStock),
    asNumber(row.familyAwdStock) ?? asNumber(row.awdStock),
    asNumber(row.familySupplierPipelineStock) ?? asNumber(row.supplierPipelineStock),
  ];
}

export function commandCenterPaneForRow(row: PlainRecord, _calculationDate: string) {
  const productStatus = asString(row.productStatus)?.toLowerCase();
  const actionStatus = asString(row.actionStatus);
  const readinessReasonCodes = [
    ...new Set([
      ...stringList(row.readinessReasonCodes),
      ...stringList(row.dataQualityIssues),
      ...(asString(row.planningReadinessStatus) === 'blocked' &&
      stringList(row.readinessReasonCodes).length === 0 &&
      stringList(row.dataQualityIssues).length === 0
        ? ['blocking_planning_readiness']
        : []),
    ]),
  ];
  const workflowStage = inventoryWorkflowStage(row);
  if (
    !workflowStage &&
    ['purchased_pipeline', 'placed_not_purchased'].includes(asString(row.supplierOrderState) ?? '')
  ) {
    readinessReasonCodes.push('ambiguous_current_order');
  }
  const stockValues = familyStockValues(row);
  const inventoryUntrusted = readinessReasonCodes.some((reason) =>
    ['inventory_unknown', 'inventory_invalid_future', 'inventory_stale'].includes(reason),
  );
  const supplierAvailability = asString(row.supplierAvailability);
  const supplierResolved = Boolean(
    supplierAvailability?.startsWith('resolved_') || asString(row.supplierId) || asString(row.supplierName),
  );
  return classifyInventoryFamily({
    active: ['active', 'live'].includes(productStatus ?? ''),
    excluded:
      actionStatus === 'excluded' || asBoolean(row.planningExcluded) === true || asString(row.familyRole) === 'member',
    tier: asString(row.tier),
    workflowStage,
    receiptStatus: asString(row.amazonReceiptStatus),
    stockEvidenceTrusted: !inventoryUntrusted && stockValues.every((value) => typeof value === 'number'),
    totalStockAndPipeline: stockValues.every((value) => typeof value === 'number')
      ? stockValues.reduce<number>((total, value) => total + (value ?? 0), 0)
      : undefined,
    currentStock:
      asNumber(row.familyOnHandSellableStock) ??
      asNumber(row.familyOnHandStock) ??
      asNumber(row.onHandSellableStock) ??
      asNumber(row.onHandStock) ??
      asNumber(row.sellableStock),
    readinessReasonCodes,
    actionStatus,
    stuckClassification: asString(row.familyStuckClassification) ?? asString(row.stuckClassification),
    supplierResolved,
    effectiveLeadTimeDays:
      asNumber(row.familyEffectiveLeadTimeDays) ?? asNumber(row.effectiveLeadTimeDays) ?? asNumber(row.leadTimeDays),
  });
}

function stuckClassification(row: PlainRecord, calculationDate?: string) {
  const onHandSellableStock =
    asNumber(row.onHandSellableStock) ?? asNumber(row.onHandStock) ?? asNumber(row.sellableStock) ?? 0;
  const live = ['active', 'live'].includes(asString(row.productStatus)?.toLowerCase() ?? '');
  const excluded = asString(row.actionStatus) === 'excluded' || asBoolean(row.planningExcluded) === true;
  if (!live || excluded) return 'none';
  const velocityStatus = asString(row.salesVelocityStatus);
  if (velocityStatus === 'missing') return 'insufficient_velocity_data';
  const trustedRollingVelocity = asString(row.salesVelocityBasis) === 'historical_rolling_30_days';
  const salesVelocity = asNumber(row.salesVelocity) ?? 0;
  const referenceDate = calculationDate ? isoDate(calculationDate) : undefined;
  const expectedArrivalDate = optionalIsoDate(asString(row.expectedArrivalDate) ?? '');
  const latestActivityAt = optionalIsoDate(asString(row.latestSupplierOrderActivityAt) ?? '');
  const graceDays = asNumber(row.purchasedPipelineGraceDays) ?? 30;
  const stalled = Boolean(
    referenceDate &&
      ((expectedArrivalDate && diffDays(referenceDate, expectedArrivalDate) > 0) ||
        (latestActivityAt && diffDays(referenceDate, latestActivityAt) > graceDays)),
  );
  if ((asNumber(row.reservedStock) ?? 0) > 0 && stalled) return 'reserved_stalled';
  if ((asNumber(row.pipelineStock) ?? 0) > 0 && stalled) return 'pipeline_stalled';
  if (onHandSellableStock <= 0) return 'none';
  if (velocityStatus === 'trusted_zero' && trustedRollingVelocity && salesVelocity <= 0) {
    return 'no_sell_through_with_stock';
  }
  if (velocityStatus !== 'trusted_positive' || !trustedRollingVelocity || salesVelocity <= 0) {
    return 'untrusted_velocity_data';
  }
  const daysOfCover = asNumber(row.daysOfCover) ?? 0;
  if (daysOfCover > 60) return 'over_60_doc';
  if (daysOfCover > 30) {
    const lastMonthQty = asNumber(row.lastMonthQty);
    const averageQty = asNumber(row.sixMonthAverageQty);
    return typeof lastMonthQty === 'number' && typeof averageQty === 'number' && lastMonthQty < averageQty
      ? 'declining_velocity_watch'
      : 'over_30_doc_watch';
  }
  return 'none';
}

function leadTimeNeedsReview(value: unknown) {
  return ['missing', 'stale'].includes(asString(value) ?? '');
}

function recommendedInventoryAction(row: PlainRecord) {
  const actionStatus = asString(row.actionStatus);
  if (asBoolean(row.familyStuckAction) === true) return 'review_stuck_inventory';
  if (!asString(row.supplierName)) return 'recover_supplier';
  if (leadTimeNeedsReview(row.leadTimeFreshness)) return 'confirm_lead_time';
  if (row.supplierOrderState === 'placed_not_purchased') return 'purchase_order';
  if (row.supplierOrderState === 'purchased_pipeline') return 'follow_up_order';
  if (['overdue', 'order_today', 'order_soon'].includes(String(actionStatus))) return 'create_order';
  if (asString(row.stuckClassification) !== 'none') return 'review_stuck_inventory';
  return 'watch';
}

function payload(record: PlainRecord): PlainRecord {
  const value = record.payload;
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function payloadString(record: PlainRecord, keys: string[]): string | undefined {
  const values = payload(record);
  for (const key of keys) {
    const direct = asString(record[key]);
    if (direct) return direct;
    const nested = asString(values[key]);
    if (nested) return nested;
  }
  return undefined;
}

function configString(record: PlainRecord, keys: string[]): string | undefined {
  const config = toPlainRecord(record.config);
  for (const key of keys) {
    const nested = asString(config[key]);
    if (nested) return nested;
  }
  return undefined;
}

function payloadNumber(record: PlainRecord, keys: string[]): number | undefined {
  const values = payload(record);
  for (const key of keys) {
    const direct = asNumber(record[key]);
    if (typeof direct === 'number') return direct;
    const nested = values[key];
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
    if (typeof nested === 'string' && nested.trim().length > 0) {
      const parsed = Number(nested.replace(/[$,%\s]/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function daysSince(date: string | undefined, today: string) {
  return date ? diffDays(today, isoDate(date)) : undefined;
}

function isPlanningExcluded(status: string | undefined) {
  const normalized = status?.trim().toLowerCase();
  return (
    normalized === 'not selling' ||
    normalized === 'hold' ||
    normalized === 'one time' ||
    normalized === 'inactive' ||
    normalized === 'discontinued' ||
    normalized === 'do not reorder'
  );
}

function derivedProductStatus(importedStatus: string | undefined, stockBuckets: PlainRecord) {
  if (importedStatus) return importedStatus;
  const sellable = asNumber(stockBuckets.sellableStock) ?? 0;
  const reserved = asNumber(stockBuckets.reservedStock) ?? 0;
  const inbound = asNumber(stockBuckets.inboundStock) ?? 0;
  const ordered = asNumber(stockBuckets.orderedStock) ?? 0;
  const prepOrAwd = (asNumber(stockBuckets.prepStock) ?? 0) + (asNumber(stockBuckets.awdStock) ?? 0);
  if (sellable === 0 && reserved > 0) return 'Reserved';
  if (sellable === 0 && reserved === 0 && (inbound > 0 || ordered > 0 || prepOrAwd > 0)) return 'OOS';
  if (sellable === 0 && reserved === 0) return 'Inactive';
  return 'Active';
}

function includesStatusText(value: unknown, terms: string[]) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function supplierOrderStatusRules(buckets: SupplierOrderStatusBuckets): SupplierOrderStatusRules {
  return {
    placedNotPurchased: new Set(buckets.supplierOrderPlacedNotPurchasedStatuses.map(normalizeSupplierOrderStatus)),
    purchasedPipeline: new Set(buckets.supplierOrderPurchasedPipelineStatuses.map(normalizeSupplierOrderStatus)),
    closed: new Set(buckets.supplierOrderClosedStatuses.map(normalizeSupplierOrderStatus)),
  };
}

export function supplierCoverageStatus(order: PlainRecord, rules: SupplierOrderStatusRules) {
  const status = normalizeSupplierOrderStatus(asString(order.status));
  const statusSource = asString(order.statusSource);
  if (
    statusSource === 'operator' ||
    (statusSource === 'manual' && (asString(order.operatorStatusOverrideAt) || asString(order.lastOperatorEditAt)))
  ) {
    return status;
  }
  if (rules.closed.has(status)) return status;
  if (includesStatusText(order.paymentStatus, ['completed', 'complete', 'paid'])) return 'paid';
  if (status === 'approval_pending' && includesStatusText(order.approvalStatus, ['approved'])) return 'payment_pending';
  return status;
}

function isPlacedNotPurchasedSupplierOrderStatus(status: string | undefined, rules: SupplierOrderStatusRules) {
  return status ? rules.placedNotPurchased.has(status) : false;
}

function isActivePurchasedPipelineStatus(status: string | undefined, rules: SupplierOrderStatusRules) {
  return status ? rules.purchasedPipeline.has(status) : false;
}

function actionRank(status: InventoryPlanningActionStatus) {
  return {
    overdue: 0,
    order_today: 1,
    missing_lead_time: 2,
    stale_lead_time: 2,
    order_soon: 3,
    already_ordered: 4,
    watch: 5,
    sufficient_stock: 6,
    no_sell_through: 7,
    missing_inventory: 8,
    missing_velocity: 9,
    excluded: 10,
  }[status];
}

function riskQueueRank(status: unknown) {
  if (
    status === 'overdue' ||
    status === 'order_today' ||
    status === 'missing_lead_time' ||
    status === 'stale_lead_time' ||
    status === 'order_soon'
  ) {
    return 0;
  }
  if (status === 'already_ordered') return 1;
  if (status === 'watch' || status === 'missing_velocity' || status === 'no_sell_through') return 2;
  if (status === 'sufficient_stock') return 3;
  if (status === 'excluded') return 4;
  return 5;
}

async function findRecords(db: EcobaseDatabase, collection: string, filter: PlainRecord) {
  return (await db.getRepository(collection).find({ filter })).map(toPlainRecord);
}

function latestByDate(records: PlainRecord[], field: string) {
  return [...records].sort((left, right) => String(right[field] ?? '').localeCompare(String(left[field] ?? '')))[0];
}

function sortableDateValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function supplierOrderSortValue(line: PlainRecord, order: PlainRecord) {
  return sortableDateValue(
    order.lastMeaningfulUpdateAt ?? order.statusUpdatedAt ?? line.observedAt ?? order.orderDate ?? '',
  );
}

function validExpectedDate(value: unknown) {
  const date = asString(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}

export function expectedArrivalEvidence(
  line: PlainRecord,
  order: PlainRecord,
  calculationDate: string | undefined,
  fbaReceivingBufferDays: number,
) {
  const operatorOverrideAt = asString(line.expectedDateOverrideAt);
  const operatorDateOverride = Boolean(
    operatorOverrideAt || asString(line.prepInstruction)?.startsWith('manual_expected_date:'),
  );
  const operatorSellableDate = operatorDateOverride ? validExpectedDate(line.expectedSellableDate) : undefined;
  const operatorDeliveryDate = operatorDateOverride ? validExpectedDate(line.expectedDeliveryDate) : undefined;
  const operatorDate =
    operatorSellableDate ?? (operatorDeliveryDate ? addDays(operatorDeliveryDate, fbaReceivingBufferDays) : undefined);
  if (operatorDate) {
    return {
      expectedArrivalDate: operatorDate,
      expectedArrivalStatus: 'operator',
      expectedArrivalSource: operatorSellableDate
        ? 'operator.expected_sellable_date'
        : 'operator.expected_delivery_date+planning_settings.fba_receiving_buffer',
      expectedArrivalAsOf: validExpectedDate(operatorOverrideAt?.slice(0, 10)) ?? calculationDate,
      expectedArrivalConfidence: 'authoritative',
      expectedArrivalFreshness:
        calculationDate && operatorDate < calculationDate ? 'stale' : calculationDate ? 'fresh' : 'unknown',
    };
  }
  const imported = [
    { date: line.expectedSellableDate, source: 'silver_order_line.expectedSellableDate', addReceivingBuffer: false },
    { date: line.expectedArrivalDate, source: line.expectedArrivalSource, addReceivingBuffer: false },
    { date: order.expectedArrivalDate, source: order.expectedArrivalSource, addReceivingBuffer: false },
    { date: line.expectedDeliveryDate, source: 'silver_order_line.expectedDeliveryDate', addReceivingBuffer: true },
    { date: order.expectedDeliveryDate, source: 'silver_order.expectedDeliveryDate', addReceivingBuffer: true },
  ].find((candidate) => validExpectedDate(candidate.date));
  const importedRawDate = validExpectedDate(imported?.date);
  const importedDate =
    importedRawDate && imported?.addReceivingBuffer
      ? addDays(importedRawDate, fbaReceivingBufferDays)
      : importedRawDate;
  if (importedDate) {
    return {
      expectedArrivalDate: importedDate,
      expectedArrivalStatus: 'imported',
      expectedArrivalSource: `${asString(imported?.source) ?? 'silver_order'}${
        imported?.addReceivingBuffer ? '+planning_settings.fba_receiving_buffer' : ''
      }`,
      expectedArrivalAsOf:
        validExpectedDate(line.expectedArrivalAsOf) ??
        validExpectedDate(order.expectedArrivalAsOf) ??
        validExpectedDate(order.orderDate),
      expectedArrivalConfidence: 'authoritative',
      expectedArrivalFreshness:
        calculationDate && importedDate < calculationDate ? 'stale' : calculationDate ? 'fresh' : 'unknown',
    };
  }
  const orderDate = validExpectedDate(order.orderDate);
  const leadTimeDays = asNumber(line.leadTimeDays);
  if (orderDate && typeof leadTimeDays === 'number' && leadTimeDays >= 0) {
    const expectedArrivalDate = addDays(orderDate, leadTimeDays + fbaReceivingBufferDays);
    return {
      expectedArrivalDate,
      expectedArrivalStatus: 'derived',
      expectedArrivalSource: `${
        asString(line.leadTimeSource) ?? 'silver_order_line.lead_time'
      }+silver_order.order_date+planning_settings.fba_receiving_buffer`,
      expectedArrivalAsOf: calculationDate,
      expectedArrivalConfidence: 'estimated',
      expectedArrivalFreshness:
        calculationDate && expectedArrivalDate < calculationDate ? 'stale' : calculationDate ? 'fresh' : 'unknown',
    };
  }
  return {
    expectedArrivalStatus: 'unknown',
    expectedArrivalSource: 'insufficient_silver_evidence',
    expectedArrivalAsOf: calculationDate,
    expectedArrivalConfidence: 'none',
    expectedArrivalFreshness: 'unknown',
  };
}

function summarizeSupplierOrderState(
  lines: PlainRecord[],
  supplierOrderById: Map<string, PlainRecord>,
  calculationDate: string | undefined,
  fbaReceivingBufferDays: number,
  rules: SupplierOrderStatusRules,
) {
  let purchasedOpenQty = 0;
  let placedNotPurchasedOpenQty = 0;
  let latestPlaced: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;
  let latestPurchased: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;
  let historySelected: { line: PlainRecord; order: PlainRecord; sortValue: string } | undefined;
  const resolvedLines = lines.map((line) => {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    return order ? { ...line, ...expectedArrivalEvidence(line, order, calculationDate, fbaReceivingBufferDays) } : line;
  });

  for (const line of resolvedLines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order, rules);
    const openQty = Math.max((asNumber(line.orderedQty) ?? 0) - (asNumber(line.receivedQty) ?? 0), 0);
    const sortValue = supplierOrderSortValue(line, order);
    if (!historySelected || sortValue > historySelected.sortValue) historySelected = { line, order, sortValue };
    const receiptStatus = asString(order.amazonReceiptStatus) ?? asString(line.amazonReceiptStatus);
    if (
      openQty <= 0 ||
      ['amazon_stock_observed', 'completed_by_later_inbound'].includes(receiptStatus ?? '') ||
      !isPlacedNotPurchasedSupplierOrderStatus(status, rules)
    ) {
      continue;
    }
    placedNotPurchasedOpenQty += openQty;
    if (!latestPlaced || sortValue > latestPlaced.sortValue) latestPlaced = { line, order, sortValue };
  }

  for (const line of resolvedLines) {
    const order = supplierOrderById.get(asString(line.supplierOrderId) ?? '');
    if (!order) continue;
    const status = supplierCoverageStatus(order, rules);
    const openQty = Math.max((asNumber(line.orderedQty) ?? 0) - (asNumber(line.receivedQty) ?? 0), 0);
    const receiptStatus = asString(order.amazonReceiptStatus) ?? asString(line.amazonReceiptStatus);
    if (
      openQty <= 0 ||
      ['amazon_stock_observed', 'completed_by_later_inbound'].includes(receiptStatus ?? '') ||
      !isActivePurchasedPipelineStatus(status, rules)
    ) {
      continue;
    }
    const sortValue = supplierOrderSortValue(line, order);
    const newerRecoveryCycleStarted = latestPlaced && latestPlaced.sortValue > sortValue;
    if (newerRecoveryCycleStarted) continue;
    purchasedOpenQty += openQty;
    if (!latestPurchased || sortValue > latestPurchased.sortValue) latestPurchased = { line, order, sortValue };
  }

  const state =
    purchasedOpenQty > 0
      ? 'purchased_pipeline'
      : placedNotPurchasedOpenQty > 0
        ? 'placed_not_purchased'
        : historySelected
          ? 'closed_history'
          : 'no_open_order';
  const reference =
    state === 'purchased_pipeline'
      ? latestPurchased
      : state === 'placed_not_purchased'
        ? latestPlaced
        : historySelected;
  const currentOpenQty = purchasedOpenQty > 0 ? purchasedOpenQty : placedNotPurchasedOpenQty;
  const referenceOpenQty = reference
    ? Math.max((asNumber(reference.line.orderedQty) ?? 0) - (asNumber(reference.line.receivedQty) ?? 0), 0)
    : 0;
  return {
    supplierOrderState: state,
    supplierOrderId: asString(reference?.order.id),
    supplierOrderStatus: reference?.order ? supplierCoverageStatus(reference.order, rules) : undefined,
    supplierOrderOperationalStatus: asString(reference?.order.operationalStatus),
    supplierOrderWorkflowStage: asString(reference?.order.workflowStage),
    supplierOrderSourceMemberSku: asString(reference?.line.sourceSupplierSku),
    supplierOrderLineMappingScope: asString(reference?.line.mappingScope),
    supplierOrderRef: asString(reference?.order.externalOrderRef) ?? asString(reference?.order.id),
    supplierOrderAuthorityStatus: asString(reference?.order.authorityStatus),
    supplierOrderAuthoritySource: asString(reference?.order.authoritySource) ?? asString(reference?.order.statusSource),
    supplierOrderAuthorityTaskRef: asString(reference?.order.authorityTaskRef),
    supplierOrderAuthorityAsOf: asString(reference?.order.authorityAsOf) ?? asString(reference?.order.updatedAt),
    supplierOrderAuthorityEvidence: toPlainRecord(reference?.order.authorityEvidenceJson),
    amazonReceiptStatus:
      asString(reference?.order.amazonReceiptStatus) ?? asString(reference?.line.amazonReceiptStatus),
    amazonReceiptObservedAt:
      asString(reference?.order.amazonReceiptObservedAt) ?? asString(reference?.line.amazonReceiptObservedAt),
    amazonReceiptCompletionReason:
      asString(reference?.order.amazonReceiptCompletionReason) ??
      asString(reference?.line.amazonReceiptCompletionReason),
    amazonReceiptEvidenceJson: asString(toPlainRecord(reference?.order.amazonReceiptEvidenceJson).evidenceKey)
      ? toPlainRecord(reference?.order.amazonReceiptEvidenceJson)
      : toPlainRecord(reference?.line.amazonReceiptEvidenceJson),
    supplierOrderSortValue: reference?.sortValue,
    expectedArrivalDate: asString(reference?.line.expectedArrivalDate),
    expectedArrivalStatus: asString(reference?.line.expectedArrivalStatus) ?? 'unknown',
    expectedArrivalSource: asString(reference?.line.expectedArrivalSource) ?? 'insufficient_silver_evidence',
    expectedArrivalAsOf: asString(reference?.line.expectedArrivalAsOf),
    expectedArrivalConfidence: asString(reference?.line.expectedArrivalConfidence) ?? 'none',
    expectedArrivalFreshness: asString(reference?.line.expectedArrivalFreshness) ?? 'unknown',
    supplierOrderOpenQty: currentOpenQty,
    supplierOrderReferenceOpenQty: referenceOpenQty,
    supplierOrderPurchasedOpenQty: purchasedOpenQty,
    supplierOrderPlacedNotPurchasedOpenQty: placedNotPurchasedOpenQty,
  };
}

function isDigestCandidateRow(row: PlainRecord) {
  return ['A', 'B', 'C', 'D'].includes(asString(row.baselineTier) ?? '');
}

function isUrgentDigestRow(row: PlainRecord) {
  return (
    row.newReplenishmentActionable === true &&
    row.primaryActionPane === 'supplyAction' &&
    row.existingOrderFollowUp !== true &&
    isDigestCandidateRow(row)
  );
}

function needsSupplierAction(row: PlainRecord) {
  return !asString(row.supplierName) || leadTimeNeedsReview(row.leadTimeFreshness);
}

function plainArray(value: unknown): PlainRecord[] {
  return Array.isArray(value) ? value.map(toPlainRecord) : [];
}

function isUuidValue(value: unknown) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function inventoryRowMatchesLine(query: InventoryPlanningRowWorkspaceQuery, line: PlainRecord) {
  if (asString(query.familyId)) return true;
  const rowPlanningProductId = asString(query.planningProductId);
  const linePlanningProductId = asString(line.planningProductId);
  const rowAsin = asString(query.asin)?.toUpperCase();
  const lineAsin = asString(line.asin)?.toUpperCase();
  const rowSku = asString(query.sku);
  const lineSku = asString(line.sku);
  return (
    (isUuidValue(rowPlanningProductId) && rowPlanningProductId === linePlanningProductId) ||
    Boolean(rowAsin && rowAsin === lineAsin) ||
    Boolean(rowSku && rowSku === lineSku)
  );
}

function companyNameFromRelation(value: unknown) {
  const relation = toPlainRecord(value);
  return asString(relation.name);
}

function companyLabelFromSourceConnection(connection: PlainRecord, companyNamesById: Map<string, string>) {
  const relationName = companyNameFromRelation(connection.company);
  if (relationName) return relationName;

  const companyId = asString(connection.companyId);
  if (companyId) return companyNamesById.get(companyId);

  return configString(connection, ['company', 'Company', 'defaultCompany']);
}

function sha256Canonical(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function stableUuid(value: string) {
  const hex = createHash('sha1').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(
    (parseInt(hex.slice(16, 18), 16) & 0x3f) |
    0x80
  )
    .toString(16)
    .padStart(2, '0')}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function productIdentity(row: PlainRecord) {
  return (
    asString(row.planningProductId) ??
    `${asString(row.company) ?? ''}:${asString(row.asin) ?? ''}:${asString(row.sku) ?? ''}`
  );
}

function lineMatchesRow(line: PlainRecord, row: PlainRecord) {
  const rowPlanningProductId = asString(row.planningProductId);
  const linePlanningProductId = asString(line.planningProductId);
  const rowAsin = asString(row.asin)?.toUpperCase();
  const lineAsin = asString(line.asin)?.toUpperCase();
  const rowSku = asString(row.sku);
  const lineSku = asString(line.sku);
  return Boolean(
    (rowPlanningProductId && linePlanningProductId && rowPlanningProductId === linePlanningProductId) ||
      (rowAsin && lineAsin && rowAsin === lineAsin) ||
      (rowSku && lineSku && rowSku === lineSku),
  );
}

function openQty(line: PlainRecord) {
  return Math.max((asNumber(line.orderedQty) ?? 0) - (asNumber(line.receivedQty) ?? 0), 0);
}

function urgencyWeight(row: PlainRecord) {
  const status = asString(row.actionStatus);
  const tier = asString(row.tier);
  return (
    (status === 'overdue' ? 50 : 0) +
    (status === 'order_today' ? 35 : 0) +
    (status === 'order_soon' ? 15 : 0) +
    (status === 'missing_lead_time' || status === 'stale_lead_time' ? 5 : 0) +
    (tier === 'A' ? 20 : tier === 'B' ? 10 : tier === 'C' ? 3 : 0)
  );
}

function recommendedActionForStatus(status: unknown) {
  const normalized = asString(status);
  if (normalized === 'payment_pending') return 'pay';
  if (normalized === 'blocked') return 'review_blocker';
  if (['draft', 'supplier_contacted', 'supplier_confirmed', 'approval_pending'].includes(normalized ?? ''))
    return 'approve';
  return 'review';
}

export const INVENTORY_PLANNING_ROW_FIELDS = [
  'companyProductId',
  'companyProductFamilyId',
  'companyId',
  'amazonAccountId',
  'marketplace',
  'ruleVersion',
  'algorithmContractVersion',
  'currentProjectionGateMode',
  'resolvedPlanningSettingsDigest',
  'sourceCoverageDigest',
  'sourceInputDigest',
  'protectedSilverFingerprint',
  'candidateInputDigest',
  'productCoverageDigest',
  'sourceAsOfDate',
  'baselineWindowStartDate',
  'baselineWindowEndDate',
  'baselineEligibleMonthCount',
  'baselineConfidence',
  'monthlyPerformanceEvidence',
  'baselineTotalUnits',
  'baselineTotalProfit',
  'baselineWeightedProfitPerUnit',
  'averageMonthlyUnits',
  'averageMonthlyProfit',
  'baselineTierScore',
  'baselineTier',
  'baselineState',
  'baselineReasonCodes',
  'bestMonthlyUnits',
  'bestUnitsMonth',
  'bestMonthlyProfit',
  'bestProfitMonth',
  'worstMonthlyUnits',
  'worstUnitsMonth',
  'worstMonthlyProfit',
  'worstProfitMonth',
  'lastClosedMonth',
  'lastClosedMonthUnits',
  'lastClosedMonthProfit',
  'lastClosedMonthTierScore',
  'lastClosedMonthTier',
  'lastClosedMonthState',
  'lastClosedMonthReasonCodes',
  'currentMonthStartDate',
  'currentCoverageEndDate',
  'currentCoveredDays',
  'currentMonthUnits',
  'currentMonthProfit',
  'projectedMonthlyUnits',
  'projectedMonthlyProfit',
  'currentProjectedTierScore',
  'currentProjectedTier',
  'currentProjectedState',
  'currentProjectionConfidence',
  'currentProjectionReasonCodes',
  'closedTierMovement',
  'projectedTierMovement',
  'trendReasonCodes',
  'expectedAverageUnitsMtd',
  'expectedBestUnitsMtd',
  'expectedWorstUnitsMtd',
  'expectedAverageProfitMtd',
  'expectedBestProfitMtd',
  'expectedWorstProfitMtd',
  'quantityPaceStatus',
  'profitPaceStatus',
  'aggregatePaceStatus',
  'paceCause',
  'paceEvidence',
  'rollingUnits30',
  'rollingVelocityWindowStartDate',
  'rollingVelocityWindowEndDate',
  'rollingVelocityEvidenceStatus',
  'inventoryDisposition',
  'inventoryDispositionReasonCode',
  'replenishmentEligibility',
  'replenishmentBlockReasonCode',
  'newReplenishmentActionable',
  'oosAlertActionable',
  'supplyActionable',
  'recommendedOrderQty',
  'existingOrderFollowUp',
  'existingOrderFollowUpAction',
  'primaryActionPane',
  'primaryActionReasonCode',
  'isFrozenFamilyTarget',
  'familyTargetCompanyProductId',
  'listingReviewCategories',
  'calculationEvidence',
  'calculationProvenanceJson',
  'calculationDate',
  'company',
  'asin',
  'sku',
  'title',
  'brand',
  'productStatus',
  'planningExcluded',
  'actionStatus',
  'estimatedProfitRisk',
  'estimatedProfitRiskBasis',
  'moneyRiskStatus',
  'moneyRiskUncoveredDays',
  'moneyRiskInputs',
  'unitCost',
  'unitCostSource',
  'supplierAvailability',
  'leadTimeAvailability',
  'unitCostAvailability',
  'profitAvailability',
  'estimatedOrderCost',
  'salesVelocity',
  'salesVelocityBasis',
  'salesVelocityStatus',
  'salesVelocityWindowStart',
  'salesVelocityWindowEnd',
  'salesVelocityAsOfDate',
  'safetyBufferDays',
  'reorderCycleDays',
  'targetCoverDays',
  'orderSoonWindowDays',
  'leadTimeFreshnessDays',
  'purchasedPipelineGraceDays',
  'currentPlanningStock',
  'onHandStock',
  'onHandSellableStock',
  'amazonPipelineStock',
  'supplierPipelineStock',
  'inventoryPositionStock',
  'futurePositionStock',
  'sellableStock',
  'reservedStock',
  'pipelineStock',
  'inboundStock',
  'orderedStock',
  'prepStock',
  'awdStock',
  'openOrderCoverageQty',
  'trustedSupplierOrderCoverageQty',
  'supplierOrderState',
  'supplierOrderStale',
  'supplierOrderId',
  'supplierOrderStatus',
  'supplierOrderOperationalStatus',
  'supplierOrderWorkflowStage',
  'supplierOrderSourceMemberSku',
  'supplierOrderLineMappingScope',
  'supplierOrderRef',
  'supplierOrderAuthorityStatus',
  'supplierOrderAuthoritySource',
  'supplierOrderAuthorityTaskRef',
  'supplierOrderAuthorityAsOf',
  'supplierOrderAuthorityEvidence',
  'amazonReceiptStatus',
  'amazonReceiptObservedAt',
  'amazonReceiptCompletionReason',
  'amazonReceiptEvidenceJson',
  'supplierOrderOpenQty',
  'supplierOrderReferenceOpenQty',
  'supplierOrderCycleSelection',
  'supplierOrderCycleReviewRequired',
  'supplierOrderPurchasedOpenQty',
  'supplierOrderPlacedNotPurchasedOpenQty',
  'pipelineHealthStatus',
  'stockoutGapDays',
  'dataQualityStatus',
  'dataQualityIssues',
  'readinessDomains',
  'readinessReasonCodes',
  'operationalIssues',
  'inventoryAsOfDate',
  'sourceFreshnessStatus',
  'latestSupplierOrderActivityType',
  'latestSupplierOrderActivityAt',
  'latestSupplierOrderActivityNote',
  'latestSupplierOrderActivityActor',
  'latestSupplierOrderActivityActorUserId',
  'latestSupplierOrderActivityActorDisplayName',
  'latestSupplierOrderActivityActorEmail',
  'latestSupplierOrderActivitySource',
  'recommendedEscalation',
  'daysOfCover',
  'estimatedOosDate',
  'daysUntilOos',
  'positionDaysOfCover',
  'positionEstimatedOosDate',
  'latestSafeReorderDate',
  'daysUntilSafeReorder',
  'supplierId',
  'supplierName',
  'supplierSource',
  'supplierRole',
  'supplierConfidence',
  'leadTimeDays',
  'leadTimeConfirmedAt',
  'leadTimeFreshness',
  'expectedArrivalDate',
  'expectedArrivalStatus',
  'expectedArrivalSource',
  'expectedArrivalAsOf',
  'expectedArrivalConfidence',
  'expectedArrivalFreshness',
  'digestPriority',
  'evidence',
] as const;

const LEGACY_PUBLIC_INVENTORY_PLANNING_FIELDS = new Set<string>([
  ...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS,
  'actionStatus',
  'calculationProvenanceJson',
  'digestPriority',
  'evidence',
  'estimatedProfitRisk',
  'estimatedProfitRiskBasis',
  'moneyRiskInputs',
  'moneyRiskStatus',
  'moneyRiskUncoveredDays',
  'recommendedBestQty',
  'recommendedEscalation',
  'salesVelocity',
  'salesVelocityAsOfDate',
  'salesVelocityBasis',
  'salesVelocityStatus',
  'salesVelocityWindowEnd',
  'salesVelocityWindowStart',
]);

const PUBLISHED_INVENTORY_PLANNING_ROW_FIELDS = INVENTORY_PLANNING_ROW_FIELDS.filter(
  (field) => !LEGACY_PUBLIC_INVENTORY_PLANNING_FIELDS.has(field),
);

export class EcobaseInventoryPlanningService {
  constructor(private db: EcobaseDatabase) {}

  async updateProductPlanningFields(params: UpdateProductPlanningFieldsParams) {
    const companyProductId = asString(params.companyProductId);
    const reason = asString(params.reason);
    if (!companyProductId) throw new Error('Ecobase product planning update failed: companyProductId is required.');
    if (
      params.planningExcluded === undefined &&
      params.reorderCycleDays === undefined &&
      params.targetCoverDays === undefined
    ) {
      throw new Error('Ecobase product planning update failed: at least one planning field is required.');
    }
    if (!reason) throw new Error('Ecobase product planning update failed: reason is required.');
    for (const [name, value] of [
      ['reorderCycleDays', params.reorderCycleDays],
      ['targetCoverDays', params.targetCoverDays],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new Error(`Ecobase product planning update failed: ${name} must be a positive integer.`);
      }
    }
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts);
    const existing = await repository.findOne({ filterByTk: companyProductId });
    if (!existing)
      throw new Error(`Ecobase product planning update failed: company product "${companyProductId}" was not found.`);
    const now = new Date().toISOString();
    const values: PlainRecord = {
      planningOverrideReason: reason,
      planningOverrideAt: now,
      planningOverrideByUserId: params.actorUserId,
    };
    if (params.planningExcluded !== undefined) {
      values.planningExcluded = params.planningExcluded;
      values.excludedReason = params.planningExcluded ? reason : null;
      values.excludedAt = params.planningExcluded ? now : null;
      values.excludedByUserId = params.planningExcluded ? params.actorUserId : null;
    }
    if (params.reorderCycleDays !== undefined) values.reorderCycleDays = params.reorderCycleDays;
    if (params.targetCoverDays !== undefined) values.targetCoverDays = params.targetCoverDays;
    await repository.update({ filterByTk: companyProductId, values });
    return { ...toPlainRecord(existing), ...values };
  }

  async listRows(query: InventoryPlanningQuery = {}) {
    return this.readGoldRows(query);
  }

  async listingPerformanceReview(query: InventoryPlanningListingReviewQuery = {}) {
    const readModel = await this.readPublishedPlanningModel(query);
    const normalizedRows = readModel.listingRows.map((row) => ({
      ...row,
      listingReviewCategories: Array.isArray(row.listingReviewCategories)
        ? [...new Set(row.listingReviewCategories.map(String))].sort()
        : deriveListingReviewCategories(row),
    })) as CorrectedListingPerformanceRow[];
    const membersByFamily = new Map<string, CorrectedListingPerformanceRow[]>();
    for (const row of normalizedRows) {
      const familyKey = asString(row.companyProductFamilyId) ?? asString(row.companyProductId);
      if (!familyKey) continue;
      membersByFamily.set(familyKey, [...(membersByFamily.get(familyKey) ?? []), row]);
    }
    const rowsWithMemberEvidence = normalizedRows.map((row) => {
      const familyKey = asString(row.companyProductFamilyId) ?? asString(row.companyProductId);
      const members = familyKey ? membersByFamily.get(familyKey) ?? [] : [];
      return {
        ...row,
        memberPerformanceEvidence: [...members]
          .sort((left, right) => String(left.companyProductId).localeCompare(String(right.companyProductId)))
          .map(listingMemberPerformanceEvidence),
      };
    });
    return filterListingPerformanceReview(rowsWithMemberEvidence, query.categories ?? []);
  }

  async workspace(query: InventoryPlanningQuery = {}) {
    const readModel = await this.readPublishedPlanningModel(query);
    return {
      filters: this.filterOptionsFromReadModel(readModel),
      rows: readModel.listingRows.slice(0, query.limit ?? readModel.listingRows.length),
      digest: await this.digestFromReadModel(readModel, query),
    };
  }

  async commandCenter(query: InventoryPlanningCommandCenterQuery = {}) {
    if (query.pane && !commandCenterPane(query.pane)) {
      throw new Error(`Ecobase inventory command center pane must be one of ${COMMAND_CENTER_PANES.join(', ')}.`);
    }
    if (query.sortBy && !COMMAND_CENTER_SORT_KEYS.has(query.sortBy)) {
      throw new Error(
        `Ecobase inventory command center sortBy must be one of ${[...COMMAND_CENTER_SORT_KEYS].sort().join(', ')}.`,
      );
    }

    const projection = await this.readPublishedPlanningModel(query);
    const allRows = projection.listingRows;
    const rows = projection.familyActions;
    const calculationDate = projection.metadata.calculationDate ?? isoDate(query.calculationDate ?? new Date());
    const targetCoverDays = asNumber(rows[0]?.targetCoverDays);
    const incompleteBaselineCount = rows.filter((row) => row.baselineConfidence !== 'full').length;
    const baselineReadinessStatus =
      rows.length === 0
        ? 'unknown'
        : incompleteBaselineCount === rows.length
          ? 'not_ready'
          : incompleteBaselineCount > 0
            ? 'partial'
            : 'ready';
    const selectedEvidenceRow = this.findCommandCenterSelectedRow(allRows, query);
    const selectedRow =
      this.findCommandCenterSelectedRow(rows, query) ??
      (selectedEvidenceRow
        ? rows.find((row) => familyActionKey(row) === familyActionKey(selectedEvidenceRow))
        : undefined);
    return {
      generatedAt: new Date().toISOString(),
      metadata: {
        ...projection.metadata,
        company: query.company ?? null,
        calculationDate,
        latestDataAsOf: this.latestCommandCenterTimestamp(rows),
        planningMode: 'corrected_monthly_performance',
        historyReadiness: {
          status: baselineReadinessStatus,
          affectedRowCount: incompleteBaselineCount,
          totalRowCount: rows.length,
          fields: [
            'baselineTier',
            'baselineWeightedProfitPerUnit',
            'averageMonthlyProfit',
            'averageMonthlyUnits',
            'lastClosedMonthProfit',
            'lastClosedMonthUnits',
            'bestMonthlyProfit',
            'bestMonthlyUnits',
            'worstMonthlyProfit',
            'worstMonthlyUnits',
          ],
        },
        historyWindow: {
          label: 'dynamic baseline window',
          fields: ['baselineWindowStartDate', 'baselineWindowEndDate', 'monthlyPerformanceEvidence'],
        },
        targetCoverDays,
      },
      summaryCards: this.commandCenterSummaryCards(rows),
      macroRisk: this.commandCenterMacroRisk(rows),
      riskBars: this.commandCenterRiskBars(rows),
      panes: {
        supplyAction: this.commandCenterPanePayload('supplyAction', rows, projection.evidenceRowsByFamily, query),
        activeOrders: this.commandCenterPanePayload('activeOrders', rows, projection.evidenceRowsByFamily, query),
        inPrepMonitoring: this.commandCenterPanePayload(
          'inPrepMonitoring',
          rows,
          projection.evidenceRowsByFamily,
          query,
        ),
        inboundMonitoring: this.commandCenterPanePayload(
          'inboundMonitoring',
          rows,
          projection.evidenceRowsByFamily,
          query,
        ),
        healthyInventory: this.commandCenterPanePayload(
          'healthyInventory',
          rows,
          projection.evidenceRowsByFamily,
          query,
        ),
        excessInventory: this.commandCenterPanePayload('excessInventory', rows, projection.evidenceRowsByFamily, query),
        stuckInventory: this.commandCenterPanePayload('stuckInventory', rows, projection.evidenceRowsByFamily, query),
        zeroStock: this.commandCenterPanePayload('zeroStock', rows, projection.evidenceRowsByFamily, query),
        dataReadiness: this.commandCenterPanePayload('dataReadiness', rows, projection.evidenceRowsByFamily, query),
        performanceReview: this.commandCenterPanePayload(
          'performanceReview',
          rows,
          projection.evidenceRowsByFamily,
          query,
        ),
        untieredProducts: this.commandCenterPanePayload(
          'untieredProducts',
          rows,
          projection.evidenceRowsByFamily,
          query,
        ),
      },
      selectedRow: selectedRow
        ? {
            row: this.commandCenterDrawerRow(selectedRow),
            workspace: await this.rowWorkspace({
              company: asString(selectedRow.company),
              familyId: asString(selectedRow.companyProductFamilyId),
              currentOrderId: asString(selectedRow.supplierOrderId),
              planningProductId: asString(selectedRow.planningProductId),
              companyProductId: asString(selectedRow.companyProductId),
              asin: asString(selectedRow.asin),
              sku: asString(selectedRow.sku),
              supplierId: asString(selectedRow.supplierId),
              limit: 50,
            }),
          }
        : null,
    };
  }

  async rowWorkspace(query: InventoryPlanningRowWorkspaceQuery) {
    const empty = {
      suppliers: [],
      supplierOrders: [],
      currentOrder: null,
      orderLineHistory: [],
      orderActivities: [],
      productTasks: [],
      productTargets: [],
      initialOrderEdit: null,
      actionDefaults: {},
    };
    if (!query.company) return empty;

    const [company] = (
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
        .find({ filter: { name: query.company }, limit: 1 })
    ).map(toPlainRecord);
    const companyId = asString(company?.id);
    const companyOrderRows = companyId
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverOrders)
            .find({ filter: { companyId }, sort: ['-orderDate'], limit: 5000 })
        ).map(toPlainRecord)
      : [];
    const currentOrder = query.currentOrderId
      ? companyOrderRows.find((order) => asString(order.id) === query.currentOrderId)
      : undefined;
    const supplierAccountRows = companyId
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts)
            .find({ filter: { companyId }, limit: 5000 })
        ).map(toPlainRecord)
      : [];
    const scopedSupplierIds = [
      ...new Set(
        [
          ...companyOrderRows.map((order) => asString(order.supplierId)),
          ...supplierAccountRows.map((account) => asString(account.supplierId)),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const suppliers = scopedSupplierIds.length
      ? (
          await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).find({
            filter: { id: { $in: scopedSupplierIds.map(asRecordIdFilterValue) } },
            sort: ['displayName'],
            limit: scopedSupplierIds.length,
          })
        )
          .map(toPlainRecord)
          .filter((supplier) => isUuidValue(supplier.id))
          .map((supplier) => ({
            ...supplier,
            name: asString(supplier.displayName) ?? asString(supplier.name),
            company: query.company,
          }))
      : [];
    const supplierOrders = [
      ...(await this.supplierOrdersByLine(companyOrderRows.map((order) => ({ orderId: order.id })))).values(),
    ].sort((left, right) =>
      String(right.lastMeaningfulUpdateAt ?? '').localeCompare(String(left.lastMeaningfulUpdateAt ?? '')),
    );
    const productOrderLines = await this.findOrderLinesByProduct(query);
    const productOrdersById = await this.supplierOrdersByLine(productOrderLines);
    const orderLineHistory = productOrderLines
      .filter((line) => inventoryRowMatchesLine(query, line))
      .map((line): PlainRecord & { order: PlainRecord } => ({
        ...line,
        order: productOrdersById.get(String(line.supplierOrderId)) ?? {},
      }))
      .sort((left, right) => {
        const leftDate = new Date(
          asString(left.observedAt) ??
            asString(left.order?.lastMeaningfulUpdateAt) ??
            asString(left.order?.createdAt) ??
            0,
        ).getTime();
        const rightDate = new Date(
          asString(right.observedAt) ??
            asString(right.order?.lastMeaningfulUpdateAt) ??
            asString(right.order?.createdAt) ??
            0,
        ).getTime();
        return rightDate - leftDate;
      });
    const currentSupplierOrder = query.currentOrderId
      ? supplierOrders.find((order) => asString(order.id) === query.currentOrderId)
      : undefined;
    const firstProductOrder = toPlainRecord(
      currentSupplierOrder ?? currentOrder ?? toPlainRecord(orderLineHistory[0]?.order),
    );
    const productOrderIds = new Set(orderLineHistory.map((line) => String(line.supplierOrderId)));
    if (query.currentOrderId) productOrderIds.add(query.currentOrderId);
    const activities = await this.withActivityAuthors(
      productOrderIds.size > 0
        ? (
            await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).find({
              filter: {
                entityType: 'supplier_order',
                entityId: { $in: [...productOrderIds].map(asRecordIdFilterValue) },
              },
              limit: 500,
            })
          )
            .map(toPlainRecord)
            .map((comment) => ({
              ...comment,
              company: query.company,
              supplierOrderId: asString(comment.entityId),
              activityType: asString(comment.commentType),
              notes: asString(comment.body),
              occurredAt: sortableDateValue(comment.occurredAt ?? comment.createdAt ?? comment.updatedAt) || undefined,
            }))
        : [],
    );
    const supplierId = isUuidValue(query.supplierId) ? query.supplierId : undefined;
    const actionableStatuses = new Set([
      'draft',
      'supplier_contacted',
      'supplier_confirmed',
      'approval_pending',
      'payment_pending',
      'paid',
      'supplier_preparing',
    ]);
    const matchingOrder = supplierId
      ? supplierOrders.find(
          (order) => asString(order.supplierId) === supplierId && actionableStatuses.has(String(order.status)),
        )
      : undefined;
    const silverContext = query.companyProductId
      ? await new EcobaseSilverDataService(this.db)
          .context({ focus: { type: 'companyProduct', id: query.companyProductId }, pageSize: 10 })
          .catch(() => ({ sections: [] }))
      : { sections: [] };
    const sections = plainArray(silverContext.sections);

    return {
      suppliers,
      supplierOrders,
      currentOrder: currentSupplierOrder ?? currentOrder ?? null,
      orderLineHistory,
      orderActivities: activities.filter(
        (activity) =>
          productOrderIds.has(String(activity.supplierOrderId)) ||
          (!activity.supplierOrderId && asString(activity.supplierId) === supplierId),
      ),
      productTasks: plainArray(sections.find((section) => section.key === 'tasks')?.rows),
      productTargets: plainArray(sections.find((section) => section.key === 'targets')?.rows),
      initialOrderEdit: firstProductOrder.id
        ? {
            supplierOrderId: String(firstProductOrder.id),
            supplierId: String(firstProductOrder.supplierId ?? ''),
            status: String(firstProductOrder.status ?? 'draft'),
            notes: '',
          }
        : null,
      actionDefaults: {
        draftSupplierId: supplierId ?? '',
        leadSupplierId: supplierId ?? '',
        addSupplierOrderId: matchingOrder?.id ? String(matchingOrder.id) : '',
      },
    };
  }
  private async repoRows(collectionName: string, limit = GOLD_SOURCE_RECORD_LIMIT) {
    return (await this.db.getRepository(collectionName).find({ limit })).map(toPlainRecord);
  }

  private groupBy(rows: PlainRecord[], field: string) {
    const grouped = new Map<string, PlainRecord[]>();
    for (const row of rows) {
      const key = asString(row[field]);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return grouped;
  }

  private async readPublishedPlanningModel(
    query: InventoryPlanningQuery = {},
  ): Promise<PublishedInventoryPlanningReadModel> {
    const access = new EcobaseInventoryPlanningGoldAccess(this.db);
    const filter = query.company ? { company: query.company } : undefined;
    const [listingResult, familyResult] = await Promise.all([
      access.readPublishedListingPerformance({ filter }),
      access.readPublishedFamilyActions({ filter }),
    ]);
    if (!listingResult.published && !familyResult.published) {
      return buildPublishedInventoryPlanningReadModel([], [], null);
    }
    const listingRunId = asString(listingResult.run?.id);
    const familyRunId = asString(familyResult.run?.id);
    if (!listingResult.published || !familyResult.published || !listingRunId || listingRunId !== familyRunId) {
      throw new Error(
        `EcoBase published inventory-planning read model mismatch: listing run ${
          listingRunId ?? 'none'
        }, family-action run ${familyRunId ?? 'none'}.`,
      );
    }
    const requestedDate = query.calculationDate ? isoDate(query.calculationDate) : undefined;
    if (requestedDate && requestedDate !== asString(listingResult.run?.calculationDate)) {
      return buildPublishedInventoryPlanningReadModel([], [], null);
    }
    return buildPublishedInventoryPlanningReadModel(listingResult.rows, familyResult.rows, listingResult.run);
  }

  private async readGoldRows(query: InventoryPlanningQuery = {}) {
    const readModel = await this.readPublishedPlanningModel(query);
    return this.sortPlanningRows(readModel.listingRows).slice(0, query.limit ?? readModel.listingRows.length);
  }

  private sortPlanningRows(rows: PlainRecord[]) {
    return [...rows].sort((left, right) => {
      const actionable =
        Number(right.newReplenishmentActionable === true) - Number(left.newReplenishmentActionable === true);
      if (actionable !== 0) return actionable;
      const profit = (asNumber(right.averageMonthlyProfit) ?? 0) - (asNumber(left.averageMonthlyProfit) ?? 0);
      if (profit !== 0) return profit;
      const tier = correctedTierRank(left.baselineTier) - correctedTierRank(right.baselineTier);
      if (tier !== 0) return tier;
      return (asNumber(right.recommendedOrderQty) ?? 0) - (asNumber(left.recommendedOrderQty) ?? 0);
    });
  }

  private latestCommandCenterTimestamp(rows: PlainRecord[]) {
    return (
      rows
        .map((row) => asString(row.lastRefreshedAt) ?? asString(row.calculationDate))
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    );
  }

  private commandCenterSummaryCards(rows: PlainRecord[]) {
    const averageMonthlyProfit = familyActionAverageMonthlyProfit(rows);
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const orderRows = [
      ...this.commandCenterRowsForPane('activeOrders', rows),
      ...this.commandCenterRowsForPane('inPrepMonitoring', rows),
      ...this.commandCenterRowsForPane('inboundMonitoring', rows),
    ];
    const offTrackRows = orderRows.filter((row) => asString(row.pipelineHealthStatus) === 'late');
    const urgentRows = supplyRows.filter((row) => row.newReplenishmentActionable === true);
    const followUpRows = orderRows.filter((row) => row.existingOrderFollowUp === true);
    return [
      {
        key: 'urgentStockoutRisk',
        label: 'Urgent stockout risk',
        description: 'Tiered families requiring supply action now',
        value: urgentRows.length,
      },
      {
        key: 'averageMonthlyProfit',
        label: 'Average monthly profit',
        description: 'Applicable family-action baseline average monthly profit',
        value: averageMonthlyProfit.value,
        unknownCount: averageMonthlyProfit.unknownCount,
        denominatorCount: averageMonthlyProfit.denominatorCount,
        knownCount: averageMonthlyProfit.knownCount,
        format: 'currency',
      },
      {
        key: 'supplyActionNeeded',
        label: 'Supply action needed',
        description: 'Tiered families with no active recovery order',
        value: supplyRows.length,
      },
      {
        key: 'activeOrdersOffTrack',
        label: 'Active orders off-track',
        description: 'Active, prep, or inbound orders expected after stockout',
        value: offTrackRows.length,
      },
      {
        key: 'followUpsDueToday',
        label: 'Follow-ups due today',
        description: 'Tiered order comments or status updates needed',
        value: followUpRows.length,
      },
      {
        key: 'stuckInventory',
        label: 'Stuck inventory',
        description: 'Tiered family stock needs operational review',
        value: this.commandCenterRowsForPane('stuckInventory', rows).length,
      },
    ];
  }

  private commandCenterMacroRisk(rows: PlainRecord[]) {
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const activeRows = this.commandCenterRowsForPane('activeOrders', rows);
    const prepRows = this.commandCenterRowsForPane('inPrepMonitoring', rows);
    const inboundRows = this.commandCenterRowsForPane('inboundMonitoring', rows);
    const orderRows = [...activeRows, ...prepRows, ...inboundRows];
    const stuckRows = this.commandCenterRowsForPane('stuckInventory', rows);
    const averageProfit = (items: PlainRecord[]) => familyActionAverageMonthlyProfit(items);
    const followUpRows = orderRows.filter((row) => row.existingOrderFollowUp === true);
    const leadTimeGapRows = rows.filter(
      (row) => asString(row.primaryActionPane) !== 'untieredProducts' && leadTimeNeedsReview(row.leadTimeFreshness),
    );
    return [
      {
        key: 'supplyActionAverageMonthlyProfit',
        label: 'Supply action average monthly profit',
        ...averageProfit(supplyRows),
        format: 'currency',
      },
      {
        key: 'activeOrderAverageMonthlyProfit',
        label: 'Active order average monthly profit',
        ...averageProfit(orderRows),
        format: 'currency',
      },
      { key: 'followUpsToday', label: 'Follow-ups today', value: followUpRows.length, suffix: 'orders' },
      {
        key: 'stuckCurrentStock',
        label: 'Stuck current stock',
        value: stuckRows.reduce((total, row) => total + (asNumber(row.currentPlanningStock) ?? 0), 0),
        suffix: 'sellable units',
      },
      { key: 'leadTimeGaps', label: 'Lead-time gaps', value: leadTimeGapRows.length, suffix: 'rows' },
    ];
  }

  private commandCenterRiskBars(rows: PlainRecord[]) {
    const supplyRows = this.commandCenterRowsForPane('supplyAction', rows);
    const activeRows = this.commandCenterRowsForPane('activeOrders', rows);
    const prepRows = this.commandCenterRowsForPane('inPrepMonitoring', rows);
    const inboundRows = this.commandCenterRowsForPane('inboundMonitoring', rows);
    return {
      supplyAction: [
        { key: 'actionable', count: supplyRows.filter((row) => row.newReplenishmentActionable === true).length },
        { key: 'follow_up', count: supplyRows.filter((row) => row.existingOrderFollowUp === true).length },
        {
          key: 'review',
          count: supplyRows.filter(
            (row) => row.newReplenishmentActionable !== true && row.existingOrderFollowUp !== true,
          ).length,
        },
      ],
      orderStages: [
        { key: 'activeOrders', count: activeRows.length },
        { key: 'inPrepMonitoring', count: prepRows.length },
        { key: 'inboundMonitoring', count: inboundRows.length },
      ],
      pipelineHealth: ['on_track', 'late', 'unknown_timing', 'placed_not_purchased', 'none'].map((value) => ({
        key: value,
        count: [...activeRows, ...prepRows, ...inboundRows].filter(
          (row) => asString(row.pipelineHealthStatus) === value,
        ).length,
      })),
      inventoryHealth: ['healthyInventory', 'excessInventory', 'stuckInventory', 'zeroStock', 'dataReadiness'].map(
        (value) => ({
          key: value,
          count: rows.filter((row) => asString(row.primaryActionPane) === value).length,
        }),
      ),
    };
  }

  private commandCenterPanePayload(
    pane: InventoryCommandCenterPane,
    rows: PlainRecord[],
    evidenceRowsByFamily: Map<string, PlainRecord[]>,
    query: InventoryPlanningCommandCenterQuery,
  ) {
    const page = asPositiveInteger(query.pane === pane ? query.page : undefined, 1, 10000);
    const pageSize = asPositiveInteger(query.pane === pane ? query.pageSize : undefined, 50, 100);
    const sortBy = query.pane === pane ? query.sortBy : undefined;
    const sortDirection = query.pane === pane ? query.sortDirection ?? 'desc' : 'desc';
    const filteredRows = this.sortCommandCenterRows(
      this.commandCenterRowsForPane(pane, rows).filter((row) => this.matchesCommandCenterFilters(row, query.filters)),
      sortBy ?? this.defaultCommandCenterSort(pane),
      sortDirection,
    );
    const start = (page - 1) * pageSize;
    const visibleRows = filteredRows.slice(start, start + pageSize);
    return {
      pane,
      page,
      pageSize,
      total: filteredRows.length,
      metrics: this.commandCenterPaneMetrics(filteredRows),
      sortBy: sortBy ?? this.defaultCommandCenterSort(pane),
      sortDirection,
      rows: visibleRows.map((row) => ({
        ...this.compactCommandCenterRow(row),
        familyMembers: (evidenceRowsByFamily.get(familyActionKey(row)) ?? []).map((member) =>
          this.compactCommandCenterRow(member),
        ),
      })),
    };
  }

  private commandCenterPaneMetrics(rows: PlainRecord[]) {
    const sumTile = (label: string, field: string, format = 'number') => {
      const values = rows.map((row) => asNumber(row[field]));
      const known = values.filter((item): item is number => typeof item === 'number');
      return {
        label,
        value: known.length > 0 || rows.length === 0 ? known.reduce((total, item) => total + item, 0) : null,
        unknownCount: values.length - known.length,
        format,
      };
    };
    const stockoutDays = rows.map((row) => asNumber(row.daysUntilOos));
    const knownStockoutDays = stockoutDays.filter((item): item is number => typeof item === 'number');
    return [
      { label: 'Product count', value: rows.length, unknownCount: 0, format: 'number' },
      sumTile('Current Sellable', 'onHandSellableStock'),
      sumTile('Amazon Pipeline', 'amazonPipelineStock'),
      sumTile('Supplier Pipeline', 'supplierPipelineStock'),
      sumTile('Inventory Position', 'inventoryPositionStock'),
      sumTile('Recommended Order', 'recommendedOrderQty'),
      sumTile('Average Monthly Profit', 'averageMonthlyProfit', 'currency'),
      {
        label: 'Days until Stockout',
        value: knownStockoutDays.length > 0 ? Math.min(...knownStockoutDays) : null,
        unknownCount: stockoutDays.length - knownStockoutDays.length,
        format: 'days',
      },
    ];
  }

  private commandCenterRowsForPane(pane: InventoryCommandCenterPane, rows: PlainRecord[]) {
    return rows.filter((row) => asString(row.primaryActionPane) === pane);
  }

  private matchesCommandCenterFilters(row: PlainRecord, filters: Record<string, unknown> | undefined) {
    if (!filters) return true;
    const matchesList = (field: string, value: unknown) => {
      const expected = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      return expected.length === 0 || expected.includes(row[field]);
    };
    if (!matchesList('baselineTier', filters.baselineTier)) return false;
    if (!matchesList('primaryActionPane', filters.primaryActionPane)) return false;
    if (!matchesList('supplierOrderState', filters.supplierOrderState)) return false;
    if (!matchesList('leadTimeFreshness', filters.leadTimeFreshness)) return false;
    if (typeof filters.minAverageMonthlyProfit === 'number') {
      const profit = asNumber(row.averageMonthlyProfit);
      if (typeof profit !== 'number' || profit < filters.minAverageMonthlyProfit) return false;
    }
    if (typeof filters.maxDaysUntilOos === 'number') {
      const daysUntilOos = asNumber(row.daysUntilOos);
      if (typeof daysUntilOos !== 'number' || daysUntilOos > filters.maxDaysUntilOos) return false;
    }
    const search = asString(filters.search)?.toLowerCase();
    if (search) {
      const cycleEvidence = toPlainRecord(toPlainRecord(row.evidence).orderCycle);
      const text = [
        row.company,
        row.asin,
        row.familyCanonicalAsin,
        row.sku,
        row.title,
        row.supplierName,
        row.supplierOrderRef,
        row.supplierOrderId,
        row.supplierOrderAuthorityTaskRef,
        cycleEvidence.selectedOrderRef,
        cycleEvidence.orderRef,
      ]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      if (!text.includes(search)) return false;
    }
    return true;
  }

  private defaultCommandCenterSort(pane: InventoryCommandCenterPane) {
    if (['activeOrders', 'inPrepMonitoring', 'inboundMonitoring'].includes(pane)) return 'stockoutGapDays';
    if (['healthyInventory', 'excessInventory', 'stuckInventory', 'untieredProducts'].includes(pane)) {
      return 'daysOfCover';
    }
    return 'averageMonthlyProfit';
  }

  private sortCommandCenterRows(rows: PlainRecord[], sortBy: string, direction: 'asc' | 'desc') {
    return [...rows].sort((left, right) => {
      const leftValue = this.commandCenterSortValue(left, sortBy);
      const rightValue = this.commandCenterSortValue(right, sortBy);
      if (leftValue === rightValue) return 0;
      if (leftValue === undefined || leftValue === null) return 1;
      if (rightValue === undefined || rightValue === null) return -1;
      const result = leftValue > rightValue ? 1 : -1;
      return direction === 'desc' ? -result : result;
    });
  }

  private commandCenterSortValue(row: PlainRecord, sortBy: string): string | number | undefined {
    if (sortBy === 'daysUntilOos') return asNumber(row.daysUntilOos);
    if (sortBy === 'stockoutGapDays') return asNumber(row.stockoutGapDays);
    if (sortBy === 'baselineTier') return correctedTierRank(row.baselineTier);
    if (sortBy === 'primaryActionPane') return asString(row.primaryActionPane);
    if (
      [
        'averageMonthlyProfit',
        'recommendedOrderQty',
        'daysUntilSafeReorder',
        'daysOfCover',
        'currentPlanningStock',
        'inventoryPositionStock',
      ].includes(sortBy)
    ) {
      return asNumber(row[sortBy]);
    }
    return asString(row[sortBy]);
  }

  private compactCommandCenterRow(row: PlainRecord) {
    return {
      ...projectCorrectedInventoryPlanningListingRow(row),
      ...Object.fromEntries(FAMILY_ACTION_CONSUMER_FIELDS.map((field) => [field, publishedReadModelValue(row[field])])),
    };
  }

  private commandCenterDrawerRow(row: PlainRecord) {
    return {
      ...this.compactCommandCenterRow(row),
      stockBuckets: {
        sellableStock: asNumber(row.sellableStock),
        reservedStock: asNumber(row.reservedStock),
        pipelineStock: asNumber(row.pipelineStock),
        inboundStock: asNumber(row.inboundStock),
        orderedStock: asNumber(row.orderedStock),
        prepStock: asNumber(row.prepStock),
        awdStock: asNumber(row.awdStock),
      },
      performanceEvidence: {
        baselineTier: asString(row.baselineTier),
        baselineState: asString(row.baselineState),
        baselineConfidence: asString(row.baselineConfidence),
        baselineWeightedProfitPerUnit: row.baselineWeightedProfitPerUnit ?? null,
        averageMonthlyUnits: row.averageMonthlyUnits ?? null,
        averageMonthlyProfit: row.averageMonthlyProfit ?? null,
        lastClosedMonthUnits: row.lastClosedMonthUnits ?? null,
        lastClosedMonthProfit: row.lastClosedMonthProfit ?? null,
        bestMonthlyUnits: row.bestMonthlyUnits ?? null,
        bestMonthlyProfit: row.bestMonthlyProfit ?? null,
        worstMonthlyUnits: row.worstMonthlyUnits ?? null,
        worstMonthlyProfit: row.worstMonthlyProfit ?? null,
        monthlyPerformanceEvidence: Array.isArray(row.monthlyPerformanceEvidence) ? row.monthlyPerformanceEvidence : [],
      },
    };
  }

  private findCommandCenterSelectedRow(rows: PlainRecord[], query: InventoryPlanningCommandCenterQuery) {
    return rows.find((row) => {
      if (query.selectedRowId) {
        const rowId = asString(row.id) ?? asString(row.naturalKey);
        if (rowId === query.selectedRowId) return true;
      }
      if (query.planningProductId && row.planningProductId === query.planningProductId) return true;
      if (query.companyProductId && row.companyProductId === query.companyProductId) return true;
      if (query.asin && String(row.asin).toUpperCase() === query.asin.toUpperCase()) return true;
      return Boolean(query.sku && row.sku === query.sku);
    });
  }

  async digestPreview(query: InventoryPlanningQuery = {}) {
    return this.digestFromReadModel(await this.readPublishedPlanningModel(query), query);
  }

  private async digestFromReadModel(projection: PublishedInventoryPlanningReadModel, query: InventoryPlanningQuery) {
    const rows = projection.familyActions;
    const averageMonthlyProfit = familyActionAverageMonthlyProfit(rows);
    const digestRows = rows.filter(isDigestCandidateRow);
    const urgentRows = await this.withLatestSupplierOrderActivity(
      this.sortDigestRows(digestRows.filter(isUrgentDigestRow)),
    );
    const supplierActionItems = this.sortDigestRows(urgentRows.filter(needsSupplierAction));
    const supplierContactRows = supplierActionItems.filter((row) => asString(row.supplierName));
    return {
      generatedAt: new Date().toISOString(),
      company: query.company ?? null,
      metadata: projection.metadata,
      summary: {
        actionable: digestRows.filter((row) => row.newReplenishmentActionable === true).length,
        existingOrderFollowUp: digestRows.filter((row) => row.existingOrderFollowUp === true).length,
        reviewRequired: digestRows.filter(
          (row) => row.newReplenishmentActionable !== true && row.existingOrderFollowUp !== true,
        ).length,
        atRisk: urgentRows.length,
        staleOrMissingLeadTime: digestRows.filter((row) => leadTimeNeedsReview(row.leadTimeFreshness)).length,
        suppliersToContact: new Set(supplierContactRows.map((row) => row.supplierName).filter(Boolean)).size,
        noSupplierOrder: urgentRows.filter((row) => row.supplierOrderState === 'no_open_order').length,
        closedOrderHistoryOnly: urgentRows.filter((row) => row.supplierOrderState === 'closed_history').length,
        placedNotPurchased: urgentRows.filter((row) => row.supplierOrderState === 'placed_not_purchased').length,
        purchasedPipelineExcluded: digestRows.filter((row) => row.supplierOrderState === 'purchased_pipeline').length,
        averageMonthlyProfitKnownTotal: averageMonthlyProfit.value,
        averageMonthlyProfitKnownCount: averageMonthlyProfit.knownCount,
        averageMonthlyProfitUnknownCount: averageMonthlyProfit.unknownCount,
        averageMonthlyProfitDenominatorCount: averageMonthlyProfit.denominatorCount,
      },
      sections: {
        orderNow: urgentRows,
        noOrderProducts: urgentRows.filter((row) => row.supplierOrderState === 'no_open_order'),
        suppliersToContactFirst: this.rankSuppliers(supplierContactRows).slice(0, 10),
        supplierActionItems: supplierActionItems.slice(0, 25),
        staleLeadTimes: urgentRows.filter((row) => leadTimeNeedsReview(row.leadTimeFreshness)).slice(0, 25),
      },
    };
  }

  async optimizeBudget(query: InventoryBudgetOptimizationQuery) {
    const budget = asNumber(query.budget);
    if (typeof budget !== 'number' || budget <= 0) {
      throw new Error('Ecobase budget optimizer requires a budget greater than zero.');
    }
    throw Object.assign(
      new Error(
        'EcoBase corrected budget optimization is unavailable until an explicit corrected scoring contract is published.',
      ),
      { code: 'ECOBASE_CORRECTED_BUDGET_OPTIMIZER_UNAVAILABLE' },
    );
  }

  async filterOptions() {
    return this.filterOptionsFromReadModel(await this.readPublishedPlanningModel());
  }

  private filterOptionsFromReadModel(readModel: PublishedInventoryPlanningReadModel) {
    const rows = readModel.listingRows;
    const companies = [...new Set(rows.map((row) => asString(row.company)).filter(Boolean))].sort();
    const productStatuses = [...new Set(rows.map((row) => asString(row.productStatus)).filter(Boolean))].sort();
    return {
      companies,
      productStatuses,
      baselineTiers: ['A', 'B', 'C', 'D'],
      baselineConfidence: ['full', 'moderate', 'low'],
      primaryActionPanes: [...INVENTORY_PLANNING_PANES],
      replenishmentEligibility: [
        ...new Set(rows.map((row) => asString(row.replenishmentEligibility)).filter(Boolean)),
      ].sort(),
      leadTimeFreshness: ['fresh', 'default', 'stale', 'missing'],
    };
  }

  async refreshReadModel(query: InventoryPlanningRefreshQuery = {}) {
    const scopedInputs = [
      ['company', query.company],
      ['limit', query.limit],
    ].filter(([, value]) => value !== undefined);
    if (scopedInputs.length) {
      throw new CorrectedCandidateBuilderError(
        'ECOBASE_CORRECTED_CANDIDATE_CARDINALITY_MISMATCH',
        'EcoBase corrected candidate refresh is full-catalog only; company and limit scopes are forbidden.',
        { scopedInputs: scopedInputs.map(([field]) => field) },
      );
    }
    const calculationDate = isoDate(query.calculationDate ?? new Date());
    const [
      resolvedSettings,
      companies,
      accounts,
      products,
      companyProducts,
      familyRows,
      sourceConnections,
      inventorySnapshots,
      suppliers,
      supplierProducts,
      productSuppliers,
      orders,
      orderLines,
      sourceFacts,
      coverageIntervals,
      coverageMemberships,
      protectedSilverFingerprint,
    ] = await Promise.all([
      new EcobasePlanningSettingsService(this.db).getResolvedSettings(),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanies),
      this.repoRows(ECOBASE_COLLECTIONS.silverAmazonAccounts),
      this.repoRows(ECOBASE_COLLECTIONS.silverProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProductFamilies),
      this.repoRows(ECOBASE_COLLECTIONS.sourceConnections),
      this.repoRows(ECOBASE_COLLECTIONS.silverInventorySnapshots),
      this.repoRows(ECOBASE_COLLECTIONS.silverSuppliers),
      this.repoRows(ECOBASE_COLLECTIONS.silverSupplierProducts),
      this.repoRows(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers),
      this.repoRows(ECOBASE_COLLECTIONS.silverOrders),
      this.repoRows(ECOBASE_COLLECTIONS.silverOrderLines),
      this.repoRows(ECOBASE_COLLECTIONS.silverListingDailyFacts),
      this.repoRows(ECOBASE_COLLECTIONS.sourceCoverageIntervals),
      this.repoRows(ECOBASE_COLLECTIONS.sourceCoverageMemberships),
      this.correctedCandidateProtectedSilverFingerprint(),
    ]);
    if (companyProducts.length !== CORRECTED_CANDIDATE_LISTING_COUNT) {
      throw this.correctedCandidateCardinalityError(companyProducts.length, undefined);
    }
    const settings = this.correctedCandidateSettings(resolvedSettings);
    const candidateFamilies = this.correctedCandidateFamilies({
      companyProducts,
      familyRows,
      products,
      accounts,
    });
    if (candidateFamilies.length !== CORRECTED_CANDIDATE_FAMILY_COUNT) {
      throw this.correctedCandidateCardinalityError(companyProducts.length, candidateFamilies.length);
    }

    const operationalRowsByCompanyProductId = this.correctedOperationalRowsFromSilver({
      calculationDate,
      settings: resolvedSettings,
      sourceConnections,
      inventorySnapshots,
      suppliers,
      supplierProducts,
      productSuppliers,
      orders,
      orderLines,
      companyProducts,
    });
    const companiesById = new Map(companies.map((row) => [asString(row.id), row]));
    const accountsById = new Map(accounts.map((row) => [asString(row.id), row]));
    const productsById = new Map(products.map((row) => [asString(row.id), row]));
    const familiesById = new Map(familyRows.map((row) => [asString(row.id), row]));
    const operationalListings = companyProducts
      .map((companyProduct) =>
        this.correctedOperationalListingSnapshot({
          companyProduct,
          company: companiesById.get(asString(companyProduct.companyId)),
          account: accountsById.get(asString(companyProduct.amazonAccountId)),
          product: productsById.get(asString(companyProduct.productId)),
          family: familiesById.get(asString(companyProduct.companyProductFamilyId)),
          operationalRow: operationalRowsByCompanyProductId.get(asString(companyProduct.id) ?? ''),
          settings,
        }),
      )
      .sort((left, right) => left.identity.companyProductId.localeCompare(right.identity.companyProductId));
    const companyProductIds = new Set(operationalListings.map((listing) => listing.identity.companyProductId));
    const candidateFacts: CorrectedCandidateSourceFact[] = sourceFacts
      .filter(
        (fact) =>
          companyProductIds.has(asString(fact.companyProductId) ?? '') &&
          String(fact.snapshotDate ?? '') <= calculationDate,
      )
      .map((fact) => ({
        companyProductId: this.correctedCandidateRequiredText(fact.companyProductId, 'fact.companyProductId'),
        snapshotDate: this.correctedCandidateRequiredText(fact.snapshotDate, 'fact.snapshotDate'),
        units: fact.units,
        netProfit: fact.netProfit ?? fact.profit,
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const activeCoverageIntervals: CorrectedCandidateCoverageInterval[] = coverageIntervals
      .filter((interval) => interval.coverageStatus === 'active')
      .map((interval) => ({
        id: this.correctedCandidateRequiredText(interval.id, 'coverageInterval.id'),
        companyId: this.correctedCandidateRequiredText(interval.companyId, 'coverageInterval.companyId'),
        amazonAccountId: this.correctedCandidateRequiredText(
          interval.amazonAccountId,
          'coverageInterval.amazonAccountId',
        ),
        marketplace: this.correctedCandidateRequiredText(interval.marketplace, 'coverageInterval.marketplace'),
        metricSet: this.correctedCandidateRequiredText(interval.metricSet, 'coverageInterval.metricSet'),
        coveredStartDate: this.correctedCandidateRequiredText(
          interval.coveredStartDate,
          'coverageInterval.coveredStartDate',
        ),
        coveredEndDate: this.correctedCandidateRequiredText(interval.coveredEndDate, 'coverageInterval.coveredEndDate'),
        continuousCoverage: interval.continuousCoverage === true,
        coverageStatus: 'active',
        sourceAsOfDate: this.correctedCandidateRequiredText(interval.sourceAsOfDate, 'coverageInterval.sourceAsOfDate'),
        sourceVersion: this.correctedCandidateRequiredText(interval.sourceVersion, 'coverageInterval.sourceVersion'),
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const activeCoverageIntervalIds = new Set(activeCoverageIntervals.map((interval) => interval.id));
    const candidateCoverageMemberships: CorrectedCandidateCoverageMembership[] = coverageMemberships
      .filter(
        (membership) =>
          activeCoverageIntervalIds.has(String(membership.coverageIntervalId)) &&
          companyProductIds.has(asString(membership.companyProductId) ?? ''),
      )
      .map((membership) => ({
        id: this.correctedCandidateRequiredText(membership.id, 'coverageMembership.id'),
        coverageIntervalId: this.correctedCandidateRequiredText(
          membership.coverageIntervalId,
          'coverageMembership.coverageIntervalId',
        ),
        companyProductId: this.correctedCandidateRequiredText(
          membership.companyProductId,
          'coverageMembership.companyProductId',
        ),
        monthStart: this.correctedCandidateRequiredText(membership.monthStart, 'coverageMembership.monthStart'),
        membershipStatus: this.correctedCandidateRequiredText(
          membership.membershipStatus,
          'coverageMembership.membershipStatus',
        ),
        metricReconciliationStatus: this.correctedCandidateRequiredText(
          membership.metricReconciliationStatus,
          'coverageMembership.metricReconciliationStatus',
        ),
        normalizedFactLinkCount: this.correctedCandidateRequiredNonNegativeInteger(
          membership.normalizedFactLinkCount,
          'coverageMembership.normalizedFactLinkCount',
        ),
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const resolvedPlanningSettingsDigest = sha256Canonical(settings);
    const sourceCoverageDigest = sha256Canonical({
      intervals: activeCoverageIntervals,
      memberships: candidateCoverageMemberships,
    });
    const sourceInputDigest = sha256Canonical({
      listings: operationalListings,
      families: candidateFamilies,
      sourceFacts: candidateFacts,
    });
    const request = {
      calculationDate,
      ruleVersion: CORRECTED_TIER_RULE_VERSION,
      algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
      canonicalSerializerVersion: CORRECTED_CANONICAL_SERIALIZER_VERSION,
      listingRowDigestVersion: CORRECTED_LISTING_ROW_DIGEST_VERSION,
      familyActionProjectionDigestVersion: CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
      currentProjectionGateMode: 'informational',
      resolvedPlanningSettingsDigest,
      sourceCoverageDigest,
      sourceInputDigest,
      protectedSilverFingerprint,
      expectedListingCount: CORRECTED_CANDIDATE_LISTING_COUNT,
      expectedFamilyActionCount: CORRECTED_CANDIDATE_FAMILY_COUNT,
    };

    return new EcobaseGoldRefreshRunService(this.db).execute({
      calculationDate,
      idempotencyKey: query.idempotencyKey,
      requestedByUserId: query.requestedByUserId,
      candidateInputDigests: {
        sourceInputDigest,
        coverageInputDigest: sourceCoverageDigest,
        settingsDigest: resolvedPlanningSettingsDigest,
        algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
      },
      publish: query.publish,
      request,
      materialize: async ({ runId, candidateInputDigest, transaction }) => {
        const refreshedAt = new Date().toISOString();
        const projection = buildCorrectedInventoryPlanningCandidate({
          runId,
          candidateInputDigest,
          calculationDate,
          generatedAt: refreshedAt,
          settings,
          resolvedPlanningSettingsDigest,
          sourceCoverageDigest,
          sourceInputDigest,
          protectedSilverFingerprint,
          listings: operationalListings,
          families: candidateFamilies,
          sourceFacts: candidateFacts,
          coverageIntervals: activeCoverageIntervals,
          coverageMemberships: candidateCoverageMemberships,
        });
        const repository = this.db.getRepository(
          ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
        ) as GoldTransactionRepository;
        for (const row of projection.listingRows) {
          const naturalKey = asString(row.naturalKey);
          if (!naturalKey) throw new Error('EcoBase corrected candidate produced a listing without a natural key.');
          const values: PlainRecord = {
            id: stableUuid(`${runId}:${naturalKey}`),
            naturalKey,
            refreshRunId: runId,
            lastRefreshedAt: refreshedAt,
          };
          for (const field of INVENTORY_PLANNING_ROW_FIELDS) {
            const value = row[field] ?? null;
            if (typeof value === 'number' && !Number.isFinite(value)) {
              throw new Error(`EcoBase corrected candidate requires ${naturalKey}.${field} to be finite.`);
            }
            values[field] = value;
          }
          await withGoldInventoryPlanningWriteAuthority(() => repository.create({ values, transaction }));
        }
        return {
          calculationDate,
          rowCount: projection.listingRows.length,
          created: projection.listingRows.length,
          updated: 0,
          lastRefreshedAt: refreshedAt,
          ...projection.runMetadata,
        };
      },
    });
  }

  async verifyRefreshRun(runId: string) {
    return new EcobaseGoldRefreshRunService(this.db).verify(runId);
  }

  async publishRefreshRun(runId: string) {
    return new EcobaseGoldRefreshRunService(this.db).publish(runId);
  }

  private correctedCandidateCardinalityError(actualListingCount: number, actualFamilyCount?: number) {
    return new CorrectedCandidateBuilderError(
      'ECOBASE_CORRECTED_CANDIDATE_CARDINALITY_MISMATCH',
      `EcoBase corrected candidate requires exactly ${CORRECTED_CANDIDATE_LISTING_COUNT} catalog listings and ${CORRECTED_CANDIDATE_FAMILY_COUNT} catalog families; received ${actualListingCount} and ${
        actualFamilyCount ?? 'unresolved'
      }.`,
      {
        expectedListingCount: CORRECTED_CANDIDATE_LISTING_COUNT,
        actualListingCount,
        expectedFamilyCount: CORRECTED_CANDIDATE_FAMILY_COUNT,
        actualFamilyCount: actualFamilyCount ?? null,
      },
    );
  }

  private correctedCandidateRequiredText(value: unknown, field: string) {
    const normalized = asString(value);
    if (!normalized) {
      throw new CorrectedCandidateBuilderError(
        'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
        `EcoBase corrected candidate requires ${field}.`,
        { field },
      );
    }
    return normalized;
  }

  private correctedCandidateRequiredNonNegativeInteger(value: unknown, field: string) {
    const normalized = asNumber(value);
    if (normalized === undefined || !Number.isInteger(normalized) || normalized < 0) {
      throw new CorrectedCandidateBuilderError(
        'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
        `EcoBase corrected candidate requires ${field} as a non-negative integer.`,
        { field, value },
      );
    }
    return normalized;
  }

  private correctedCandidateSettings(settings: EcobasePlanningSettings): CorrectedCandidateSettings {
    return {
      profitTierAThreshold: asNumber(settings.profitTierAThreshold) ?? 250,
      profitTierBThreshold: asNumber(settings.profitTierBThreshold) ?? 100,
      profitTierCThreshold: asNumber(settings.profitTierCThreshold) ?? 0,
      minimumProjectionCoveredDays: asNumber(settings.minimumProjectionCoveredDays) ?? 14,
      paceTolerancePercent: asNumber(settings.paceTolerancePercent) ?? 0,
      safetyBufferDays: asNumber(settings.safetyBufferDays) ?? DEFAULT_PLANNING_SETTINGS.safetyBufferDays,
      reorderCycleDays: asNumber(settings.reorderCycleDays) ?? DEFAULT_PLANNING_SETTINGS.reorderCycleDays,
      targetCoverDays: asNumber(settings.targetCoverDays) ?? DEFAULT_PLANNING_SETTINGS.targetCoverDays,
      orderSoonWindowDays: asNumber(settings.orderSoonWindowDays) ?? DEFAULT_PLANNING_SETTINGS.orderSoonWindowDays,
      leadTimeFreshnessDays:
        asNumber(settings.leadTimeFreshnessDays) ?? DEFAULT_PLANNING_SETTINGS.leadTimeFreshnessDays,
      purchasedPipelineGraceDays:
        asNumber(settings.purchasedPipelineGraceDays) ?? DEFAULT_PLANNING_SETTINGS.purchasedPipelineGraceDays,
      defaultSupplierLeadTimeDays:
        asNumber(settings.defaultSupplierLeadTimeDays) ?? DEFAULT_PLANNING_SETTINGS.defaultSupplierLeadTimeDays,
    };
  }

  private correctedCandidateFamilies(input: {
    companyProducts: PlainRecord[];
    familyRows: PlainRecord[];
    products: PlainRecord[];
    accounts: PlainRecord[];
  }): CorrectedCandidateFamilySnapshot[] {
    const familiesById = new Map(input.familyRows.map((row) => [asString(row.id), row]));
    const productsById = new Map(input.products.map((row) => [asString(row.id), row]));
    const accountsById = new Map(input.accounts.map((row) => [asString(row.id), row]));
    const membersByFamilyId = new Map<string, PlainRecord[]>();
    for (const companyProduct of input.companyProducts) {
      const familyId = this.correctedCandidateRequiredText(
        companyProduct.companyProductFamilyId,
        'companyProduct.companyProductFamilyId',
      );
      membersByFamilyId.set(familyId, [...(membersByFamilyId.get(familyId) ?? []), companyProduct]);
    }
    return [...membersByFamilyId]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([familyId, members]) => {
        const family = familiesById.get(familyId);
        if (!family) {
          throw new CorrectedCandidateBuilderError(
            'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
            `EcoBase corrected candidate catalog family "${familyId}" is missing.`,
            { familyId },
          );
        }
        const sortedMembers = [...members].sort((left, right) =>
          String(left.id ?? '').localeCompare(String(right.id ?? '')),
        );
        const representative = sortedMembers[0];
        const representativeProduct = productsById.get(asString(representative.productId));
        const amazonAccountId = this.correctedCandidateRequiredText(
          family.amazonAccountId ?? representative.amazonAccountId,
          `family.${familyId}.amazonAccountId`,
        );
        const account = accountsById.get(amazonAccountId);
        const targetCompanyProductId = asString(family.replenishmentTargetCompanyProductId) ?? null;
        return {
          familyKey: familyId,
          companyProductFamilyId: familyId,
          companyId: this.correctedCandidateRequiredText(
            family.companyId ?? representative.companyId,
            `family.${familyId}.companyId`,
          ),
          amazonAccountId,
          marketplace: this.correctedCandidateRequiredText(
            family.marketplace ?? account?.marketplace ?? representativeProduct?.marketplace,
            `family.${familyId}.marketplace`,
          ),
          canonicalAsin: this.correctedCandidateRequiredText(
            family.canonicalAsin ?? representativeProduct?.asin,
            `family.${familyId}.canonicalAsin`,
          ),
          targetCompanyProductId,
          memberCompanyProductIds: sortedMembers.map((member) =>
            this.correctedCandidateRequiredText(member.id, `family.${familyId}.memberCompanyProductId`),
          ),
          targetSelectionEvidence:
            family.targetSelectionEvidenceJson ??
            family.targetSelectionEvidence ??
            family.reconciliationEvidenceJson ??
            {},
        };
      });
  }

  private correctedOperationalRowsFromSilver(input: {
    calculationDate: string;
    settings: EcobasePlanningSettings;
    sourceConnections: PlainRecord[];
    inventorySnapshots: PlainRecord[];
    suppliers: PlainRecord[];
    supplierProducts: PlainRecord[];
    productSuppliers: PlainRecord[];
    orders: PlainRecord[];
    orderLines: PlainRecord[];
    companyProducts: PlainRecord[];
  }) {
    const sellerboardSourceConnectionIds = new Set(
      input.sourceConnections
        .filter(
          (connection) =>
            asBoolean(connection.active) !== false &&
            (asString(connection.sourceType) ?? '').toLowerCase().startsWith('sellerboard'),
        )
        .map((connection) => asString(connection.id))
        .filter((id): id is string => Boolean(id)),
    );
    const inventoryByCompanyProduct = this.groupBy(input.inventorySnapshots, 'companyProductId');
    const suppliersById = new Map(input.suppliers.map((row) => [asString(row.id), row]));
    const supplierProductsById = new Map(input.supplierProducts.map((row) => [asString(row.id), row]));
    const supplierLinksByCompanyProduct = this.groupBy(input.productSuppliers, 'companyProductId');
    const statusRules = supplierOrderStatusRules(input.settings);
    const ordersById = new Map<string | undefined, PlainRecord>(
      input.orders.map((order): [string | undefined, PlainRecord] => {
        const rawStatus = normalizeSupplierOrderStatus(
          asString(order.canonicalStatus) ?? asString(order.lifecycleStatus) ?? asString(order.lifecyclePhase),
        );
        const configuredStatus =
          statusRules.placedNotPurchased.has(rawStatus) ||
          statusRules.purchasedPipeline.has(rawStatus) ||
          statusRules.closed.has(rawStatus);
        return [
          asString(order.id),
          {
            ...order,
            status: configuredStatus ? rawStatus : silverOrderStatus(order),
            externalOrderRef: asString(order.orderRef),
          },
        ];
      }),
    );
    const normalizedLines = input.orderLines
      .filter((line) => asString(line.companyProductId) && asString(line.productMappingStatus) !== 'unresolved')
      .map((line) => {
        const supplierProduct = supplierProductsById.get(asString(line.supplierProductId));
        return {
          ...line,
          supplierOrderId: asString(line.orderId),
          receivedQty: amazonReceivedQty(line),
          leadTimeDays: asNumber(supplierProduct?.leadTimeDays),
          leadTimeSource: supplierProduct ? 'silver_order_line.supplier_product_lead_time' : undefined,
        };
      });
    const linesByCompanyProduct = this.groupBy(normalizedLines, 'companyProductId');
    const fbaReceivingBufferDays =
      asNumber(input.settings.fbaReceivingBufferDays) ?? DEFAULT_PLANNING_SETTINGS.fbaReceivingBufferDays;
    const purchasedPipelineGraceDays =
      asNumber(input.settings.purchasedPipelineGraceDays) ?? DEFAULT_PLANNING_SETTINGS.purchasedPipelineGraceDays;
    const rows = new Map<string, PlainRecord>();

    for (const companyProduct of input.companyProducts) {
      const companyProductId = this.correctedCandidateRequiredText(companyProduct.id, 'companyProduct.id');
      const inventory = latestPreferredInventorySnapshot(
        inventoryByCompanyProduct.get(companyProductId) ?? [],
        sellerboardSourceConnectionIds,
      );
      const stock = inventory
        ? this.stockBuckets(
            {
              stock: asNumber(inventory.sellableStock),
              reserved: asNumber(inventory.reserved),
              inbound: asNumber(inventory.inbound),
              ordered: asNumber(inventory.ordered),
              prepStock: asNumber(inventory.prepStock),
              awdStock: asNumber(inventory.awdStock),
            },
            {},
          )
        : undefined;
      const openOrder = summarizeSupplierOrderState(
        linesByCompanyProduct.get(companyProductId) ?? [],
        ordersById,
        input.calculationDate,
        fbaReceivingBufferDays,
        statusRules,
      );
      const expectedArrivalDate = optionalIsoDate(asString(openOrder.expectedArrivalDate) ?? '');
      const supplierOrderStale = Boolean(
        openOrder.supplierOrderState === 'purchased_pipeline' &&
          expectedArrivalDate &&
          diffDays(input.calculationDate, expectedArrivalDate) > purchasedPipelineGraceDays,
      );
      const supplierPipelineStock = stock
        ? supplierOrderStale
          ? 0
          : Math.max((asNumber(openOrder.supplierOrderPurchasedOpenQty) ?? 0) - stock.amazonPipelineStock, 0)
        : undefined;
      const inventoryPositionStock = stock ? stock.onHandSellableStock + stock.amazonPipelineStock : undefined;
      const futurePositionStock =
        inventoryPositionStock === undefined ? undefined : inventoryPositionStock + (supplierPipelineStock ?? 0);
      const supplierOffer = [...(supplierLinksByCompanyProduct.get(companyProductId) ?? [])]
        .map((link) => {
          const supplierProduct = supplierProductsById.get(asString(link.supplierProductId));
          const supplier = suppliersById.get(asString(supplierProduct?.supplierId));
          return supplierProduct && supplier ? { link, supplierProduct, supplier } : undefined;
        })
        .filter((offer): offer is NonNullable<typeof offer> => Boolean(offer))
        .sort((left, right) => {
          const rank = (role: unknown) =>
            role === 'preferred' ? 0 : role === 'latest_used' ? 1 : role === 'historical_purchase' ? 2 : 3;
          return (
            rank(left.link.role) - rank(right.link.role) ||
            String(left.supplierProduct.id ?? '').localeCompare(String(right.supplierProduct.id ?? ''))
          );
        })[0];
      const supplierProduct = supplierOffer?.supplierProduct;
      const supplier = supplierOffer?.supplier;
      rows.set(companyProductId, {
        inventoryAsOfDate: asString(inventory?.snapshotDate),
        onHandSellableStock: stock?.onHandSellableStock,
        amazonPipelineStock: stock?.amazonPipelineStock,
        supplierPipelineStock,
        inventoryPositionStock,
        futurePositionStock,
        sellableStock: stock?.sellableStock,
        reservedStock: stock?.reservedStock,
        pipelineStock: stock?.pipelineStock,
        inboundStock: stock?.inboundStock,
        orderedStock: stock?.orderedStock,
        prepStock: stock?.prepStock,
        awdStock: stock?.awdStock,
        ...openOrder,
        supplierOrderStale,
        pipelineHealthStatus: supplierOrderStale ? 'late' : openOrder.supplierOrderState,
        supplierId: asString(supplier?.id),
        supplierName: asString(supplier?.name),
        supplierSource: supplier ? 'silver_company_product_supplier' : undefined,
        supplierRole: asString(supplierOffer?.link.role),
        supplierConfidence: supplier ? 'resolved_silver_link' : undefined,
        unitCost: asNumber(supplierProduct?.unitCost),
        unitCostSource: supplierProduct ? 'silver_supplier_product' : undefined,
        supplierAvailability: supplier ? 'resolved_silver_link' : 'unavailable_no_evidence',
        leadTimeAvailability: supplierProduct ? 'resolved_silver_link' : 'resolved_default_supplier_lead_time',
        unitCostAvailability:
          asNumber(supplierProduct?.unitCost) === undefined ? 'unavailable' : 'resolved_silver_link',
        leadTimeDays: asNumber(supplierProduct?.leadTimeDays),
        leadTimeConfirmedAt: asString(supplierProduct?.updatedAt),
        leadTimeFreshness: supplierProduct ? 'fresh' : 'default',
        evidence: {
          inventorySnapshotId: asString(inventory?.id) ?? null,
          supplierProductId: asString(supplierProduct?.id) ?? null,
          supplierOrderId: asString(openOrder.supplierOrderId) ?? null,
        },
      });
    }
    return rows;
  }

  private correctedOperationalListingSnapshot(input: {
    companyProduct: PlainRecord;
    company?: PlainRecord;
    account?: PlainRecord;
    product?: PlainRecord;
    family?: PlainRecord;
    operationalRow?: PlainRecord;
    settings: CorrectedCandidateSettings;
  }): CorrectedOperationalListingSnapshot {
    const { companyProduct, company, account, product, family, operationalRow, settings } = input;
    const companyProductId = this.correctedCandidateRequiredText(companyProduct.id, 'companyProduct.id');
    if (!company || !account || !product || !family || !operationalRow) {
      throw new CorrectedCandidateBuilderError(
        'ECOBASE_CORRECTED_CANDIDATE_CATALOG_DRIFT',
        `EcoBase corrected candidate catalog/operational snapshot is incomplete for "${companyProductId}".`,
        {
          companyProductId,
          companyPresent: Boolean(company),
          accountPresent: Boolean(account),
          productPresent: Boolean(product),
          familyPresent: Boolean(family),
          operationalRowPresent: Boolean(operationalRow),
        },
      );
    }
    const numeric = (value: unknown) => asNumber(value) ?? null;
    return {
      identity: {
        companyProductId,
        companyProductFamilyId: this.correctedCandidateRequiredText(
          companyProduct.companyProductFamilyId,
          `companyProduct.${companyProductId}.companyProductFamilyId`,
        ),
        companyId: this.correctedCandidateRequiredText(
          companyProduct.companyId,
          `companyProduct.${companyProductId}.companyId`,
        ),
        amazonAccountId: this.correctedCandidateRequiredText(
          companyProduct.amazonAccountId,
          `companyProduct.${companyProductId}.amazonAccountId`,
        ),
        marketplace: this.correctedCandidateRequiredText(
          family.marketplace ?? account.marketplace ?? product.marketplace,
          `companyProduct.${companyProductId}.marketplace`,
        ),
        asin: this.correctedCandidateRequiredText(product.asin, `companyProduct.${companyProductId}.asin`),
        sku: this.correctedCandidateRequiredText(product.sku, `companyProduct.${companyProductId}.sku`),
        company: this.correctedCandidateRequiredText(company.name, `companyProduct.${companyProductId}.company`),
        title: asString(product.title) ?? null,
        brand: asString(product.brand) ?? null,
        productStatus: asString(companyProduct.lifecycleStatus) ?? asString(product.lifecycleStatus) ?? null,
      },
      planning: {
        planningExcluded:
          asBoolean(companyProduct.planningExcluded) === true ||
          isPlanningExcluded(asString(companyProduct.lifecycleStatus)),
        safetyBufferDays: settings.safetyBufferDays,
        reorderCycleDays: asNumber(companyProduct.reorderCycleDays) ?? settings.reorderCycleDays,
        targetCoverDays: asNumber(companyProduct.targetCoverDays) ?? settings.targetCoverDays,
        orderSoonWindowDays: settings.orderSoonWindowDays,
        leadTimeFreshnessDays: settings.leadTimeFreshnessDays,
        purchasedPipelineGraceDays: settings.purchasedPipelineGraceDays,
        leadTimeDays: asNumber(operationalRow.leadTimeDays) ?? settings.defaultSupplierLeadTimeDays,
      },
      inventory: {
        inventoryAsOfDate: asString(operationalRow.inventoryAsOfDate) ?? null,
        onHandSellableStock: numeric(operationalRow.onHandSellableStock),
        amazonPipelineStock: numeric(operationalRow.amazonPipelineStock),
        supplierPipelineStock: numeric(operationalRow.supplierPipelineStock),
        inventoryPositionStock: numeric(operationalRow.inventoryPositionStock),
        futurePositionStock: numeric(operationalRow.futurePositionStock),
        sellableStock: numeric(operationalRow.sellableStock),
        reservedStock: numeric(operationalRow.reservedStock),
        pipelineStock: numeric(operationalRow.pipelineStock),
        inboundStock: numeric(operationalRow.inboundStock),
        orderedStock: numeric(operationalRow.orderedStock),
        prepStock: numeric(operationalRow.prepStock),
        awdStock: numeric(operationalRow.awdStock),
      },
      order: {
        state: asString(operationalRow.supplierOrderState) ?? null,
        stale: asBoolean(operationalRow.supplierOrderStale) === true,
        workflowStage: asString(operationalRow.supplierOrderWorkflowStage) ?? null,
        operationalStatus: asString(operationalRow.supplierOrderOperationalStatus) ?? null,
        orderId: asString(operationalRow.supplierOrderId) ?? null,
        status: asString(operationalRow.supplierOrderStatus) ?? null,
        reference: asString(operationalRow.supplierOrderRef) ?? null,
        openQty: numeric(operationalRow.supplierOrderOpenQty),
        purchasedOpenQty: numeric(operationalRow.supplierOrderPurchasedOpenQty),
        placedNotPurchasedOpenQty: numeric(operationalRow.supplierOrderPlacedNotPurchasedOpenQty),
        pipelineHealthStatus: asString(operationalRow.pipelineHealthStatus) ?? null,
        expectedArrivalDate: asString(operationalRow.expectedArrivalDate) ?? null,
        expectedArrivalStatus: asString(operationalRow.expectedArrivalStatus) ?? null,
        authorityStatus: asString(operationalRow.supplierOrderAuthorityStatus) ?? null,
        authoritySource: asString(operationalRow.supplierOrderAuthoritySource) ?? null,
        authorityTaskRef: asString(operationalRow.supplierOrderAuthorityTaskRef) ?? null,
        authorityAsOf: asString(operationalRow.supplierOrderAuthorityAsOf) ?? null,
        authorityEvidence: operationalRow.supplierOrderAuthorityEvidence ?? {},
        receiptStatus: asString(operationalRow.amazonReceiptStatus) ?? null,
        receiptObservedAt: asString(operationalRow.amazonReceiptObservedAt) ?? null,
        receiptCompletionReason: asString(operationalRow.amazonReceiptCompletionReason) ?? null,
        receiptEvidence: operationalRow.amazonReceiptEvidenceJson ?? {},
      },
      supplier: {
        supplierId: asString(operationalRow.supplierId) ?? null,
        supplierName: asString(operationalRow.supplierName) ?? null,
        supplierSource: asString(operationalRow.supplierSource) ?? null,
        supplierRole: asString(operationalRow.supplierRole) ?? null,
        supplierConfidence: asString(operationalRow.supplierConfidence) ?? null,
        unitCost: numeric(operationalRow.unitCost),
        unitCostSource: asString(operationalRow.unitCostSource) ?? null,
        supplierAvailability: asString(operationalRow.supplierAvailability) ?? null,
        leadTimeAvailability: asString(operationalRow.leadTimeAvailability) ?? null,
        unitCostAvailability: asString(operationalRow.unitCostAvailability) ?? null,
        leadTimeConfirmedAt: asString(operationalRow.leadTimeConfirmedAt) ?? null,
        leadTimeFreshness: asString(operationalRow.leadTimeFreshness) ?? null,
      },
      sourceEvidence: operationalRow.evidence ?? {},
    };
  }

  private async correctedCandidateProtectedSilverFingerprint() {
    const fingerprints: Record<string, string> = {};
    for (const collection of CORRECTED_CANDIDATE_PROTECTED_COLLECTIONS) {
      const rows = (await this.repoRows(collection))
        .map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...businessFields }) => businessFields)
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
      fingerprints[collection] = sha256Canonical(rows);
    }
    return sha256Canonical(fingerprints);
  }

  private stockBuckets(inventory: PlainRecord, calculation: PlainRecord) {
    const sellableStock = asNumber(inventory.stock) ?? asNumber(calculation.sellableStock) ?? 0;
    const reservedStock = asNumber(inventory.reserved) ?? 0;
    const inboundStock = asNumber(inventory.inbound) ?? 0;
    const orderedStock = asNumber(inventory.ordered) ?? 0;
    const prepStock =
      asNumber(inventory.prepStock) ??
      payloadNumber(inventory, ['Prep Stock', 'Prep Center Stock', 'FBA prep. stock Prep center 1 stock']) ??
      0;
    const awdStock = payloadNumber(inventory, ['AWD Stock', 'awdStock']) ?? 0;
    const amazonPipelineStock = inboundStock + orderedStock + prepStock + awdStock;
    return {
      sellableStock,
      reservedStock,
      inboundStock,
      orderedStock,
      prepStock,
      awdStock,
      pipelineStock: amazonPipelineStock,
      currentPlanningStock: sellableStock + reservedStock + amazonPipelineStock,
      onHandSellableStock: sellableStock,
      amazonPipelineStock,
    };
  }
  private async supplierOrdersByLine(lines: PlainRecord[]) {
    const orderIds = [
      ...new Set(
        lines
          .map((line) => asString(line.orderId) ?? asString(line.supplierOrderId))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (orderIds.length === 0) return new Map<string, PlainRecord>();

    const orders = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({
        filter: { id: { $in: orderIds.map(asRecordIdFilterValue) } },
        limit: orderIds.length,
      })
    ).map(toPlainRecord);
    const companyIds = [
      ...new Set(orders.map((order) => asString(order.companyId)).filter((id): id is string => Boolean(id))),
    ];
    const supplierIds = [
      ...new Set(orders.map((order) => asString(order.supplierId)).filter((id): id is string => Boolean(id))),
    ];
    const [companies, suppliers] = await Promise.all([
      companyIds.length > 0
        ? this.db
            .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
            .find({ filter: { id: { $in: companyIds.map(asRecordIdFilterValue) } }, limit: companyIds.length })
        : [],
      supplierIds.length > 0
        ? this.db
            .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
            .find({ filter: { id: { $in: supplierIds.map(asRecordIdFilterValue) } }, limit: supplierIds.length })
        : [],
    ]).then((groups) => groups.map((group) => group.map(toPlainRecord)));
    const companyById = new Map(companies.map((company) => [asString(company.id), company]));
    const supplierById = new Map(suppliers.map((supplier) => [asString(supplier.id), supplier]));

    const entries: [string, PlainRecord][] = [];
    for (const order of orders) {
      const orderId = asString(order.id);
      if (!orderId) continue;
      const company = companyById.get(asString(order.companyId));
      const supplier = supplierById.get(asString(order.supplierId));
      const companyName = asString(company?.name) ?? asString(order.company);
      const orderRef = asString(order.orderRef) ?? asString(order.externalOrderRef) ?? orderId;
      const orderDate = asString(order.orderDate);
      const observedAt = orderDate ? `${orderDate}T00:00:00.000Z` : undefined;
      entries.push([
        orderId,
        {
          ...order,
          naturalKey: companyName ? `supplier-order:${companyName}:${orderRef}` : undefined,
          company: companyName,
          externalOrderRef: orderRef,
          status: silverOrderStatus(order),
          statusUpdatedAt: asString(order.updatedAt) ?? asString(order.statusUpdatedAt) ?? observedAt,
          lastMeaningfulUpdateAt:
            asString(order.updatedAt) ??
            asString(order.lastMeaningfulUpdateAt) ??
            asString(order.statusUpdatedAt) ??
            observedAt,
          sourceStage:
            asString(order.orderIntent) ?? asString(order.lifecyclePhase) ?? asString(order.sourceStage) ?? 'imported',
          supplierName: asString(supplier?.displayName) ?? asString(supplier?.name) ?? asString(order.supplierName),
        },
      ]);
    }
    return new Map(entries);
  }

  private async withActivityAuthors(activities: PlainRecord[]) {
    const userIds = [
      ...new Set(activities.map((activity) => asRecordIdString(activity.actorUserId)).filter(Boolean) as string[]),
    ];
    if (userIds.length === 0) return activities;

    let users: PlainRecord[];
    try {
      users = (
        await this.db
          .getRepository('users')
          .find({ filter: { id: { $in: userIds.map(asRecordIdFilterValue) } }, limit: userIds.length })
      ).map(toPlainRecord);
    } catch {
      return activities;
    }

    const usersById = new Map(users.map((user) => [asRecordIdString(user.id), user]));
    return activities.map((activity) => {
      const user = usersById.get(asRecordIdString(activity.actorUserId) ?? '');
      const actorDisplayName = user ? displayNameForUser(user) : undefined;
      return actorDisplayName ? { ...activity, actorDisplayName, actorEmail: asString(user?.email) } : activity;
    });
  }

  private async withLatestSupplierOrderActivity(rows: PlainRecord[]) {
    if (rows.length === 0) return rows;

    const activityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    const silverOrders = await silverSupplierOrderReadModel(this.db, { limit: 10000 });
    const orderCache = new Map(
      silverOrders.supplierOrders
        .map((order): [string, PlainRecord] => [
          `${asString(order.company) ?? ''}:${asString(order.externalOrderRef) ?? asString(order.id) ?? ''}`,
          order,
        ])
        .filter(([key]) => !key.endsWith(':')),
    );
    const orderByRow = new Map<PlainRecord, PlainRecord>();
    const supplierOrderIds = new Set<string>();
    for (const row of rows) {
      const company = asString(row.company);
      const ref = asString(row.supplierOrderRef);
      if (!company || !ref) continue;
      const order = orderCache.get(`${company}:${ref}`) ?? {};
      orderByRow.set(row, order);
      const supplierOrderId = asString(order.id);
      if (supplierOrderId) supplierOrderIds.add(supplierOrderId);
    }

    const activitySupplierOrderId = (activity: PlainRecord) =>
      asString(activity.supplierOrderId) ??
      (asString(activity.entityType) === 'supplier_order' ? asString(activity.entityId) : undefined);
    const activityDate = (activity: PlainRecord) =>
      String(
        toPlainRecord(activity.contextSnapshotJson).occurredAt ??
          activity.occurredAt ??
          activity.createdAt ??
          activity.updatedAt ??
          '',
      );
    const latestByOrderId = new Map<string, PlainRecord>();
    const activities = (await activityRepo.find({ limit: 10000 })).map(toPlainRecord);
    for (const activity of activities) {
      if (asString(activity.deletedAt)) continue;
      const supplierOrderId = activitySupplierOrderId(activity);
      if (!supplierOrderId || !supplierOrderIds.has(supplierOrderId)) continue;
      const current = latestByOrderId.get(supplierOrderId);
      if (!current || activityDate(activity).localeCompare(activityDate(current)) > 0) {
        latestByOrderId.set(supplierOrderId, activity);
      }
    }
    const latestActivities = await this.withActivityAuthors([...latestByOrderId.values()]);
    const latestWithAuthorsByOrderId = new Map(
      latestActivities
        .map((activity): [string, PlainRecord] | undefined => {
          const supplierOrderId = activitySupplierOrderId(activity);
          return supplierOrderId ? [supplierOrderId, activity] : undefined;
        })
        .filter((entry): entry is [string, PlainRecord] => Boolean(entry)),
    );

    return rows.map((row) => {
      const order = orderByRow.get(row) ?? {};
      const supplierOrderId = asString(order.id);
      const latestActivity = (supplierOrderId ? latestWithAuthorsByOrderId.get(supplierOrderId) : undefined) ?? {};
      const activityContext = toPlainRecord(latestActivity.contextSnapshotJson);
      const fallbackActivityAt =
        activityContext.occurredAt ??
        latestActivity.occurredAt ??
        latestActivity.createdAt ??
        latestActivity.updatedAt ??
        order.lastMeaningfulUpdateAt ??
        order.statusUpdatedAt ??
        order.orderDate ??
        order.updatedAt;
      const fallbackActivityNote = asString(order.status) ? `Order status ${asString(order.status)}` : undefined;
      return {
        ...row,
        supplierOrderId,
        latestSupplierOrderActivityType:
          asString(latestActivity.commentType) ?? asString(latestActivity.activityType) ?? 'order_status',
        latestSupplierOrderActivityAt: fallbackActivityAt ? sortableDateValue(fallbackActivityAt) : undefined,
        latestSupplierOrderActivityNote:
          asString(latestActivity.body) ?? asString(latestActivity.notes) ?? fallbackActivityNote,
        latestSupplierOrderActivityActor: asString(activityContext.actor) ?? asString(latestActivity.actor),
        latestSupplierOrderActivityActorUserId: asRecordIdString(latestActivity.actorUserId),
        latestSupplierOrderActivityActorDisplayName: asString(latestActivity.actorDisplayName),
        latestSupplierOrderActivityActorEmail: asString(latestActivity.actorEmail),
        latestSupplierOrderActivitySource: asString(activityContext.source),
      };
    });
  }

  private async findOrderLinesByProduct(params: {
    company?: string;
    familyId?: string;
    asin?: string;
    sku?: string;
  }): Promise<PlainRecord[]> {
    const productFilter = params.asin
      ? { asin: params.asin.toUpperCase() }
      : params.sku
        ? { sku: params.sku }
        : undefined;
    if (!params.familyId && !productFilter) return [];

    const [company] = params.company
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
            .find({ filter: { name: params.company }, limit: 1 })
        ).map(toPlainRecord)
      : [];
    const companyId = asString(company?.id);
    let companyProducts: PlainRecord[];
    let products: PlainRecord[];
    if (params.familyId) {
      const companyProductFilter: PlainRecord = { companyProductFamilyId: params.familyId };
      if (companyId) companyProductFilter.companyId = companyId;
      companyProducts = (
        await this.db
          .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
          .find({ filter: companyProductFilter, limit: 10000 })
      ).map(toPlainRecord);
      const productIds = companyProducts
        .map((companyProduct) => asString(companyProduct.productId))
        .filter((id): id is string => Boolean(id));
      products = productIds.length
        ? (
            await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({
              filter: { id: { $in: productIds.map(asRecordIdFilterValue) } },
              limit: productIds.length,
            })
          ).map(toPlainRecord)
        : [];
    } else {
      products = (
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ filter: productFilter, limit: 5000 })
      ).map(toPlainRecord);
      const productIds = products.map((product) => asString(product.id)).filter((id): id is string => Boolean(id));
      if (productIds.length === 0) return [];
      const companyProductFilter: PlainRecord = { productId: { $in: productIds.map(asRecordIdFilterValue) } };
      if (companyId) companyProductFilter.companyId = companyId;
      companyProducts = (
        await this.db
          .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
          .find({ filter: companyProductFilter, limit: 10000 })
      ).map(toPlainRecord);
    }
    const companyProductIds = companyProducts
      .map((companyProduct) => asString(companyProduct.id))
      .filter((id): id is string => Boolean(id));
    if (companyProductIds.length === 0) return [];

    const rawLines = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).find({
        filter: { companyProductId: { $in: companyProductIds.map(asRecordIdFilterValue) } },
        limit: 10000,
      })
    ).map(toPlainRecord);
    if (rawLines.length === 0) return [];

    const orderIds = [
      ...new Set(rawLines.map((line) => asString(line.orderId)).filter((id): id is string => Boolean(id))),
    ];
    const supplierProductIds = [
      ...new Set(rawLines.map((line) => asString(line.supplierProductId)).filter((id): id is string => Boolean(id))),
    ];
    const [orders, supplierProducts] = await Promise.all([
      orderIds.length > 0
        ? this.db
            .getRepository(ECOBASE_COLLECTIONS.silverOrders)
            .find({ filter: { id: { $in: orderIds.map(asRecordIdFilterValue) } }, limit: orderIds.length })
        : [],
      supplierProductIds.length > 0
        ? this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).find({
            filter: { id: { $in: supplierProductIds.map(asRecordIdFilterValue) } },
            limit: supplierProductIds.length,
          })
        : [],
    ]).then((groups) => groups.map((group) => group.map(toPlainRecord)));
    const supplierIds = [
      ...new Set(
        [
          ...orders.map((order) => asString(order.supplierId)),
          ...supplierProducts.map((product) => asString(product.supplierId)),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const suppliers = supplierIds.length
      ? (
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
            .find({ filter: { id: { $in: supplierIds.map(asRecordIdFilterValue) } }, limit: supplierIds.length })
        ).map(toPlainRecord)
      : [];

    const productById = new Map(products.map((product) => [asString(product.id), product]));
    const companyProductById = new Map(
      companyProducts.map((companyProduct) => [asString(companyProduct.id), companyProduct]),
    );
    const supplierProductById = new Map(supplierProducts.map((product) => [asString(product.id), product]));
    const supplierById = new Map(suppliers.map((supplier) => [asString(supplier.id), supplier]));
    const orderById = new Map(orders.map((order) => [asString(order.id), order]));

    return rawLines
      .map((line) => {
        const orderId = asString(line.orderId) ?? asString(line.supplierOrderId);
        const order = orderById.get(orderId);
        const companyProduct = companyProductById.get(asString(line.companyProductId));
        const supplierProduct = supplierProductById.get(asString(line.supplierProductId));
        const product = productById.get(asString(companyProduct?.productId) ?? asString(supplierProduct?.productId));
        const supplierId =
          asString(order?.supplierId) ?? asString(supplierProduct?.supplierId) ?? asString(line.supplierId);
        const supplier = supplierById.get(supplierId);
        const orderDate = asString(order?.orderDate);
        return {
          ...line,
          supplierOrderId: orderId,
          company: params.company,
          supplierId,
          supplierName: asString(supplier?.displayName) ?? asString(supplier?.name) ?? asString(line.supplierName),
          planningProductId: asString(line.companyProductId) ?? asString(line.planningProductId),
          companyProductId: asString(line.companyProductId) ?? asString(line.planningProductId),
          asin: asString(product?.asin)?.toUpperCase() ?? asString(line.asin)?.toUpperCase(),
          sku: asString(product?.sku) ?? asString(supplierProduct?.supplierSku) ?? asString(line.sku),
          title: asString(product?.title) ?? asString(line.title),
          brand: asString(product?.brand) ?? asString(line.brand),
          orderedQty: asNumber(line.orderedQty) ?? 0,
          receivedQty: amazonReceivedQty(line),
          unitCost: asNumber(line.unitCost) ?? asNumber(supplierProduct?.unitCost),
          expectedDeliveryDate: asString(line.expectedDeliveryDate) ?? asString(order?.expectedDeliveryDate),
          expectedArrivalDate: asString(line.expectedArrivalDate) ?? asString(line.expectedSellableDate),
          observedAt: orderDate ? `${orderDate}T00:00:00.000Z` : undefined,
          sourceStage: asString(order?.orderIntent) ?? asString(order?.lifecyclePhase) ?? 'imported',
          sourceOrderLineRef:
            asString(line.sourceOrderLineRef) ??
            [asString(order?.orderRef), asString(product?.asin), asString(product?.sku)].filter(Boolean).join(':'),
        };
      })
      .sort((left, right) => String(right.observedAt ?? '').localeCompare(String(left.observedAt ?? '')));
  }
  private sortDigestRows(rows: PlainRecord[]) {
    return [...rows].sort((left, right) => {
      const actionable =
        Number(right.newReplenishmentActionable === true) - Number(left.newReplenishmentActionable === true);
      if (actionable !== 0) return actionable;
      const tier = correctedTierRank(left.baselineTier) - correctedTierRank(right.baselineTier);
      if (tier !== 0) return tier;
      const profit = (asNumber(right.averageMonthlyProfit) ?? 0) - (asNumber(left.averageMonthlyProfit) ?? 0);
      if (profit !== 0) return profit;
      return (asNumber(right.recommendedOrderQty) ?? 0) - (asNumber(left.recommendedOrderQty) ?? 0);
    });
  }

  private rankSuppliers(rows: PlainRecord[]) {
    const bySupplier = new Map<
      string,
      {
        supplierName: string;
        urgentCount: number;
        baselineTierA: number;
        baselineTierB: number;
        baselineTierC: number;
        baselineTierD: number;
        averageMonthlyProfit: number;
      }
    >();
    for (const row of rows) {
      const supplierName = asString(row.supplierName);
      if (!supplierName) continue;
      const existing = bySupplier.get(supplierName) ?? {
        supplierName,
        urgentCount: 0,
        baselineTierA: 0,
        baselineTierB: 0,
        baselineTierC: 0,
        baselineTierD: 0,
        averageMonthlyProfit: 0,
      };
      existing.urgentCount += 1;
      existing.baselineTierA += row.baselineTier === 'A' ? 1 : 0;
      existing.baselineTierB += row.baselineTier === 'B' ? 1 : 0;
      existing.baselineTierC += row.baselineTier === 'C' ? 1 : 0;
      existing.baselineTierD += row.baselineTier === 'D' ? 1 : 0;
      existing.averageMonthlyProfit += asNumber(row.averageMonthlyProfit) ?? 0;
      bySupplier.set(supplierName, existing);
    }
    return [...bySupplier.values()].sort((left, right) => {
      if (right.averageMonthlyProfit !== left.averageMonthlyProfit)
        return right.averageMonthlyProfit - left.averageMonthlyProfit;
      if (right.baselineTierA !== left.baselineTierA) return right.baselineTierA - left.baselineTierA;
      if (right.baselineTierB !== left.baselineTierB) return right.baselineTierB - left.baselineTierB;
      if (right.baselineTierC !== left.baselineTierC) return right.baselineTierC - left.baselineTierC;
      if (right.baselineTierD !== left.baselineTierD) return right.baselineTierD - left.baselineTierD;
      return right.urgentCount - left.urgentCount;
    });
  }
}
