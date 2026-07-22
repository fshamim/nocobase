/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Typed fixtures for the Inventory Dashboard (T-0.1 coverage matrix).
 *
 * Provenance: ALL rows below are `synthetic`. The live-gate DB was not
 * reachable from this work block (no running docker/live-gate), so every
 * matrix item is hand-authored. Each row is the *persisted* shape the
 * dashboard reads (gold planning row / silver order), not a response shape.
 */

import type { FixtureProvenance, PaneKey } from '../../contract';

/** Pinned clock for every time-based derivation/test in this feature. */
export const FIXED_NOW = '2026-07-21T12:00:00.000Z';
export const FIXED_TODAY = '2026-07-21';
export const PUBLISHED_RUN_ID = 'run-published-0001';
export const SUPERSEDING_RUN_ID = 'run-published-0002';

export const LEAD_TIME_FRESHNESS_DAYS = 60;
export const FOLLOW_UP_THRESHOLD_HOURS = 48;
export const SAFETY_BUFFER_DAYS = 7;

export interface MonthlyPerformanceEvidenceEntry {
  month: string;
  units: number | null;
  /** T4: optional per-month profit (mirrors gold monthlyProfit). */
  profit?: number | null;
  trusted: boolean;
}

export interface GoldPlanningRowFixture {
  id: string;
  naturalKey: string;
  refreshRunId: string;
  calculationDate: string | null;
  companyProductFamilyId: string | null;
  familyTargetCompanyProductId: string | null;
  companyId: string | null;
  amazonAccountId: string | null;
  marketplace: string | null;
  company: string | null;
  asin: string | null;
  sku: string | null;
  title: string | null;
  primaryActionPane: string;
  primaryActionReasonCode: string | null;
  baselineTier: string | null;
  currentProjectedTier: string | null;
  lastClosedMonthTier: string | null;
  currentPlanningStock: number | null;
  inventoryPositionStock: number | null;
  unitCost: number | null;
  /** T4 widened columns (all default null — enriched per matrix item). */
  sellableStock: number | null;
  reservedStock: number | null;
  inboundStock: number | null;
  prepStock: number | null;
  orderedStock: number | null;
  awdStock: number | null;
  futurePositionStock: number | null;
  salesVelocity: number | null;
  salesVelocityBasis: string | null;
  salesVelocityAsOfDate: string | null;
  rollingVelocityEvidenceStatus: string | null;
  averageMonthlyProfit: number | null;
  bestMonthlyProfit: number | null;
  worstMonthlyProfit: number | null;
  lastClosedMonthProfit: number | null;
  projectedMonthlyProfit: number | null;
  baselineWeightedProfitPerUnit: number | null;
  leadTimeDays: number | null;
  positionDaysOfCover: number | null;
  positionEstimatedOosDate: string | null;
  daysUntilSafeReorder: number | null;
  moneyRiskStatus: string | null;
  moneyRiskUncoveredDays: number | null;
  daysOfCover: number | null;
  estimatedOosDate: string | null;
  latestSafeReorderDate: string | null;
  estimatedProfitRisk: number | null;
  pipelineHealthStatus: string | null;
  leadTimeConfirmedAt: string | null;
  leadTimeFreshness: string | null;
  companyProductId: string | null;
  lastClosedMonth: string | null;
  supplierOrderId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierOrderRef: string | null;
  supplierOrderStatus: string | null;
  supplierOrderOperationalStatus: string | null;
  supplierOrderWorkflowStage: string | null;
  expectedArrivalDate: string | null;
  expectedArrivalSource: string | null;
  safetyBufferDays: number | null;
  latestSupplierOrderActivityNote: string | null;
  latestSupplierOrderActivityActor: string | null;
  latestSupplierOrderActivityActorDisplayName: string | null;
  latestSupplierOrderActivityAt: string | null;
  readinessReasonCodes: string[];
  dataQualityIssues: string[];
  monthlyPerformanceEvidence: MonthlyPerformanceEvidenceEntry[] | null;
  projectedMonthlyUnits: number | null;
  lastClosedMonthUnits: number | null;
  provenance: FixtureProvenance;
}

export interface SilverOrderFixture {
  id: string;
  orderRef: string | null;
  company: string | null;
  operationalStatus: string | null;
  workflowStage: string | null;
  workflowStageEnteredAt: string | null;
  prepBoxes: number | null;
  prepCartons: number | null;
  prepDimensions: Record<string, unknown> | null;
  prepDetailsUpdatedAt: string | null;
  prepDetailsUpdatedByUserId: string | null;
  /** T6 (D5) order-history fields (optional — only history fixtures set them). */
  orderDate?: string | null;
  supplierId?: string | null;
  provenance: FixtureProvenance;
}

/** T6 (D5): silver order line in the persisted shape the history join reads. */
export interface SilverOrderLineFixture {
  id: string;
  orderId: string;
  companyProductId: string;
  orderedQty: number | null;
  productMappingStatus: 'resolved' | 'unresolved';
  provenance: FixtureProvenance;
}

const GOLD_ROW_DEFAULTS: Omit<GoldPlanningRowFixture, 'id' | 'naturalKey' | 'primaryActionPane'> = {
  refreshRunId: PUBLISHED_RUN_ID,
  calculationDate: FIXED_TODAY,
  companyProductFamilyId: null,
  familyTargetCompanyProductId: null,
  companyId: 'company-acme',
  amazonAccountId: 'account-acme-us',
  marketplace: 'Amazon.com',
  company: 'Acme',
  asin: 'B000000000',
  sku: 'SKU-000',
  title: 'Fixture product',
  primaryActionReasonCode: null,
  baselineTier: 'A',
  currentProjectedTier: 'A',
  lastClosedMonthTier: 'A',
  currentPlanningStock: 100,
  inventoryPositionStock: 100,
  unitCost: 5,
  sellableStock: null,
  reservedStock: null,
  inboundStock: null,
  prepStock: null,
  orderedStock: null,
  awdStock: null,
  futurePositionStock: null,
  salesVelocity: null,
  salesVelocityBasis: null,
  salesVelocityAsOfDate: null,
  rollingVelocityEvidenceStatus: null,
  averageMonthlyProfit: null,
  bestMonthlyProfit: null,
  worstMonthlyProfit: null,
  lastClosedMonthProfit: null,
  projectedMonthlyProfit: null,
  baselineWeightedProfitPerUnit: null,
  leadTimeDays: null,
  positionDaysOfCover: null,
  positionEstimatedOosDate: null,
  daysUntilSafeReorder: null,
  moneyRiskStatus: null,
  moneyRiskUncoveredDays: null,
  daysOfCover: 40,
  estimatedOosDate: null,
  latestSafeReorderDate: null,
  estimatedProfitRisk: null,
  pipelineHealthStatus: null,
  leadTimeConfirmedAt: '2026-07-01T00:00:00.000Z',
  leadTimeFreshness: 'fresh',
  companyProductId: null,
  lastClosedMonth: null,
  supplierOrderId: null,
  supplierId: null,
  supplierName: null,
  supplierOrderRef: null,
  supplierOrderStatus: null,
  supplierOrderOperationalStatus: null,
  supplierOrderWorkflowStage: null,
  expectedArrivalDate: null,
  expectedArrivalSource: null,
  safetyBufferDays: SAFETY_BUFFER_DAYS,
  latestSupplierOrderActivityNote: null,
  latestSupplierOrderActivityActor: null,
  latestSupplierOrderActivityActorDisplayName: null,
  latestSupplierOrderActivityAt: null,
  readinessReasonCodes: [],
  dataQualityIssues: [],
  monthlyPerformanceEvidence: null,
  projectedMonthlyUnits: null,
  lastClosedMonthUnits: null,
  provenance: 'synthetic',
};

function goldRow(
  id: string,
  primaryActionPane: PaneKey | 'adminExcluded',
  overrides: Partial<GoldPlanningRowFixture> = {},
): GoldPlanningRowFixture {
  return {
    ...GOLD_ROW_DEFAULTS,
    id,
    naturalKey: `gold:${id}`,
    primaryActionPane,
    companyProductFamilyId: overrides.companyProductFamilyId ?? `family-${id}`,
    sku: overrides.sku ?? `SKU-${id}`,
    title: overrides.title ?? `Fixture product ${id}`,
    ...overrides,
  };
}

function hoursAgo(hours: number): string {
  return new Date(Date.parse(FIXED_NOW) - hours * 3_600_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.parse(FIXED_NOW) - days * 86_400_000).toISOString();
}

function dateOffset(days: number): string {
  return new Date(Date.parse(`${FIXED_TODAY}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 6 closed months of trusted evidence for band derivations (T4: optional per-month profits). */
function monthlyEvidence(
  units: Array<number | null>,
  trusted: boolean[],
  profits?: Array<number | null>,
): MonthlyPerformanceEvidenceEntry[] {
  return units.map((value, index) => ({
    month: `2026-0${index + 1}`,
    units: value,
    profit: profits?.[index] ?? null,
    trusted: trusted[index] ?? true,
  }));
}

/* ------------------------------------------------------------------ *
 * Gold rows — one coherent published run covering all 14 matrix items.
 * ------------------------------------------------------------------ */

export const GOLD_ROWS: GoldPlanningRowFixture[] = [
  // Item 1: in_prep, entered >48h ago, no activity -> needsFollowUp true.
  goldRow('f1a-inprep-followup', 'inPrepMonitoring', {
    asin: 'B0001A',
    sku: 'SKU-1A',
    supplierOrderId: 'order-1a',
    supplierId: 'supplier-prep-center',
    supplierName: 'Prep Center Supplier',
    supplierOrderRef: 'PO-1A',
    supplierOrderOperationalStatus: 'prep-in-progress',
    supplierOrderWorkflowStage: 'in_prep',
    latestSupplierOrderActivityAt: null,
  }),
  // Item 1 twin: last activity exactly 48.0h ago -> needsFollowUp false (strict >).
  goldRow('f1b-inprep-boundary', 'inPrepMonitoring', {
    asin: 'B0001B',
    sku: 'SKU-1B',
    supplierOrderId: 'order-1b',
    supplierOrderRef: 'PO-1B',
    supplierOrderOperationalStatus: 'prep-in-progress',
    supplierOrderWorkflowStage: 'in_prep',
    latestSupplierOrderActivityAt: hoursAgo(48),
    latestSupplierOrderActivityNote: 'Chased supplier for tracking',
    latestSupplierOrderActivityActorDisplayName: 'Kiran M.',
  }),

  // Item 2: inbound buffer boundaries.
  goldRow('f2a-inbound-null-null', 'inboundMonitoring', {
    asin: 'B0002A',
    supplierOrderId: 'order-2a',
    supplierId: 'supplier-direct',
    supplierName: 'Direct FBA Supplier',
    supplierOrderOperationalStatus: 'inbound-monitoring',
    supplierOrderWorkflowStage: 'amazon_inbound',
    expectedArrivalDate: null,
    estimatedOosDate: null,
  }),
  goldRow('f2b-inbound-eta-null', 'inboundMonitoring', {
    asin: 'B0002B',
    supplierOrderId: 'order-2b',
    supplierOrderOperationalStatus: 'inbound-monitoring',
    supplierOrderWorkflowStage: 'amazon_inbound',
    expectedArrivalDate: null,
    estimatedOosDate: dateOffset(20),
  }),
  goldRow('f2c-inbound-sufficient-boundary', 'inboundMonitoring', {
    asin: 'B0002C',
    supplierOrderId: 'order-2c',
    supplierOrderOperationalStatus: 'inbound-monitoring',
    supplierOrderWorkflowStage: 'amazon_inbound',
    // ETA == OOS - safetyBuffer -> boundary resolves to 'sufficient'.
    estimatedOosDate: dateOffset(SAFETY_BUFFER_DAYS + 10),
    expectedArrivalDate: dateOffset(10),
  }),

  // Item 3: direct-ship-fba -> P4, never P3.
  goldRow('f3-direct-ship-fba', 'inboundMonitoring', {
    asin: 'B0003',
    supplierOrderId: 'order-3',
    supplierOrderOperationalStatus: 'direct-ship-fba',
    supplierOrderWorkflowStage: 'amazon_inbound',
    expectedArrivalDate: dateOffset(5),
    estimatedOosDate: dateOffset(30),
  }),

  // Item 4: multi-order family across pre_purchase (P2) and in_prep (P3).
  goldRow('f4a-order-prepurchase', 'activeOrders', {
    companyProductFamilyId: 'family-4',
    asin: 'B0004',
    sku: 'SKU-4A',
    supplierOrderId: 'order-4a',
    supplierOrderOperationalStatus: 'approved-to-order',
    supplierOrderWorkflowStage: 'pre_purchase',
    latestSupplierOrderActivityAt: hoursAgo(10),
    latestSupplierOrderActivityNote: 'Approved to order',
  }),
  goldRow('f4b-order-inprep', 'inPrepMonitoring', {
    companyProductFamilyId: 'family-4',
    asin: 'B0004',
    sku: 'SKU-4B',
    supplierOrderId: 'order-4b',
    supplierOrderOperationalStatus: 'ordered',
    supplierOrderWorkflowStage: 'in_prep',
    latestSupplierOrderActivityAt: hoursAgo(5),
    latestSupplierOrderActivityNote: 'Paid, awaiting prep',
  }),

  // Item 5: gold pane in_prep but silver stage amazon_inbound -> staleClassification, no reclassify.
  goldRow('f5-stale-classification', 'inPrepMonitoring', {
    asin: 'B0005',
    supplierOrderId: 'order-5',
    supplierOrderOperationalStatus: 'prep-in-progress',
    supplierOrderWorkflowStage: 'in_prep',
    latestSupplierOrderActivityAt: hoursAgo(3),
  }),

  // Item 6: adminExcluded -> never served.
  goldRow('f6-admin-excluded', 'adminExcluded', {
    asin: 'B0006',
    primaryActionReasonCode: 'inactive_or_excluded',
  }),

  // Item 7: untiered row in operational pane -> projected to P11.
  goldRow('f7-untiered-in-healthy', 'healthyInventory', {
    asin: 'B0007',
    baselineTier: null,
    currentProjectedTier: null,
    lastClosedMonthTier: null,
  }),

  // Item 8: performance band set.
  goldRow('f8a-band-3-trusted', 'performanceReview', {
    asin: 'B0008A',
    monthlyPerformanceEvidence: monthlyEvidence(
      [100, 200, 150, null, null, null],
      [true, true, true, false, false, false],
    ),
    projectedMonthlyUnits: 50, // < worst(100) -> below_band
    lastClosedMonthUnits: 100,
    lastClosedMonthTier: 'A',
    currentProjectedTier: 'B', // declining
  }),
  goldRow('f8b-band-2-insufficient', 'performanceReview', {
    asin: 'B0008B',
    monthlyPerformanceEvidence: monthlyEvidence(
      [100, 200, null, null, null, null],
      [true, true, false, false, false, false],
    ),
    projectedMonthlyUnits: 120,
    lastClosedMonthUnits: 200,
  }),
  goldRow('f8c-band-v-eq-best', 'performanceReview', {
    asin: 'B0008C',
    monthlyPerformanceEvidence: monthlyEvidence([100, 200, 150, 180, 120, 160], [true, true, true, true, true, true]),
    projectedMonthlyUnits: 200, // == best -> within_band (inclusive)
    lastClosedMonthUnits: 160,
  }),
  goldRow('f8d-band-v-eq-worst', 'performanceReview', {
    asin: 'B0008D',
    monthlyPerformanceEvidence: monthlyEvidence([100, 200, 150, 180, 120, 160], [true, true, true, true, true, true]),
    projectedMonthlyUnits: 100, // == worst -> within_band (inclusive)
    lastClosedMonthUnits: 160,
  }),
  goldRow('f8e-band-below-declining', 'performanceReview', {
    asin: 'B0008E',
    monthlyPerformanceEvidence: monthlyEvidence([100, 200, 150, 180, 120, 160], [true, true, true, true, true, true]),
    projectedMonthlyUnits: 80, // < worst -> below_band + declining
    lastClosedMonthUnits: 160,
    lastClosedMonthTier: 'A',
    currentProjectedTier: 'C',
  }),

  // Item 9: null unitCost stuck row; null estimatedProfitRisk supplyAction row.
  goldRow('f9a-stuck-null-cost', 'stuckInventory', {
    asin: 'B0009A',
    unitCost: null,
    currentPlanningStock: 40,
    inventoryPositionStock: 40,
  }),
  goldRow('f9b-supply-null-risk', 'supplyAction', {
    asin: 'B0009B',
    daysOfCover: 2,
    estimatedOosDate: dateOffset(2),
    estimatedProfitRisk: null,
    latestSafeReorderDate: dateOffset(-2), // overdue -> urgentStockout
    currentPlanningStock: 5,
  }),

  // Item 10: order row with no matching silver order (orphan) -> lastActivity null.
  goldRow('f10-orphan-order', 'activeOrders', {
    asin: 'B0010',
    supplierOrderId: 'order-10-orphan',
    supplierOrderOperationalStatus: 'order analysing',
    supplierOrderWorkflowStage: 'pre_purchase',
    latestSupplierOrderActivityAt: null,
  }),

  // Item 11: lead-time evidence at boundary, over boundary, and null.
  goldRow('f11a-lead-boundary', 'supplyAction', {
    asin: 'B0011A',
    companyProductId: 'cp-f11a', // T6: anchors the order-history line mapping
    daysOfCover: 5,
    estimatedOosDate: dateOffset(5),
    leadTimeConfirmedAt: daysAgo(LEAD_TIME_FRESHNESS_DAYS), // exactly threshold -> not stale (strict >)
    leadTimeFreshness: 'default',
    latestSafeReorderDate: dateOffset(3),
    estimatedProfitRisk: 100,
    // T4 widened-projection exercise row: buckets + velocity provenance +
    // profit stats + supplier lead time + position timing, all non-null.
    sellableStock: 40,
    reservedStock: 5,
    inboundStock: 10,
    prepStock: 0,
    orderedStock: 20,
    awdStock: 0,
    futurePositionStock: 70,
    salesVelocity: 8,
    salesVelocityBasis: 'rolling_30',
    salesVelocityAsOfDate: FIXED_TODAY,
    rollingVelocityEvidenceStatus: 'trusted_positive',
    averageMonthlyProfit: 900,
    bestMonthlyProfit: 1400,
    worstMonthlyProfit: 500,
    lastClosedMonthProfit: 1100,
    projectedMonthlyProfit: 1200,
    baselineWeightedProfitPerUnit: 3.75,
    supplierId: 'supplier-lead-1',
    supplierName: 'Lead Boundary Supplies',
    leadTimeDays: 30,
    positionDaysOfCover: 8.75,
    positionEstimatedOosDate: dateOffset(8),
    daysUntilSafeReorder: -35.25,
    moneyRiskStatus: 'at_risk',
    moneyRiskUncoveredDays: 28,
    // T4 (D3 chart): six trusted months WITH per-month profit.
    monthlyPerformanceEvidence: monthlyEvidence(
      [100, 200, 150, 180, 120, 160],
      [true, true, true, true, true, true],
      [400, 800, 600, 720, 480, 640],
    ),
    projectedMonthlyUnits: 170,
    lastClosedMonthUnits: 160,
  }),
  goldRow('f11b-lead-stale', 'supplyAction', {
    asin: 'B0011B',
    daysOfCover: 8,
    estimatedOosDate: dateOffset(8),
    leadTimeConfirmedAt: daysAgo(LEAD_TIME_FRESHNESS_DAYS + 5), // over threshold -> stale
    leadTimeFreshness: 'stale',
    latestSafeReorderDate: dateOffset(6),
    estimatedProfitRisk: 250,
  }),
  goldRow('f11c-lead-null', 'supplyAction', {
    asin: 'B0011C',
    daysOfCover: 11,
    estimatedOosDate: dateOffset(11),
    leadTimeConfirmedAt: null, // null -> unknownCount, never stale
    leadTimeFreshness: 'missing',
    latestSafeReorderDate: dateOffset(9),
    estimatedProfitRisk: 75,
  }),

  // Item 12: null workflowStageEnteredAt -> daysInStage null (unknown), not 0.
  goldRow('f12-null-stage-entered', 'inPrepMonitoring', {
    asin: 'B0012',
    supplierOrderId: 'order-12',
    supplierId: 'supplier-unknown-route',
    supplierName: 'Unknown Route Supplier',
    supplierOrderOperationalStatus: 'ordered',
    supplierOrderWorkflowStage: 'in_prep',
    latestSupplierOrderActivityAt: hoursAgo(2),
  }),

  // Item 13: family with members in >= 2 inventory panes -> familySplit true.
  goldRow('f13a-split-supply', 'supplyAction', {
    companyProductFamilyId: 'family-13',
    companyProductId: 'cp-13a',
    asin: 'B0013',
    sku: 'SKU-13A',
    daysOfCover: 4,
    estimatedOosDate: dateOffset(4),
    latestSafeReorderDate: dateOffset(1),
    estimatedProfitRisk: 300,
    currentPlanningStock: 8,
  }),
  goldRow('f13b-split-healthy', 'healthyInventory', {
    companyProductFamilyId: 'family-13',
    companyProductId: 'cp-13b',
    asin: 'B0013',
    sku: 'SKU-13B',
  }),

  // Ordered-but-late header tile source (REQ-H2 / pipelineHealthStatus = 'late').
  goldRow('f-ordered-late', 'inboundMonitoring', {
    asin: 'B0014',
    supplierOrderId: 'order-late',
    supplierOrderOperationalStatus: 'inbound-monitoring',
    supplierOrderWorkflowStage: 'amazon_inbound',
    pipelineHealthStatus: 'late',
    estimatedProfitRisk: 500,
    expectedArrivalDate: dateOffset(20),
    estimatedOosDate: dateOffset(10),
  }),

  // T-3.0c(c): COMPLETED direct-ship order — must NOT leak into P4; stays in
  // its persisted gold pane (healthy).
  goldRow('f-direct-complete', 'healthyInventory', {
    asin: 'B0020',
    supplierOrderId: 'order-direct-complete',
    supplierOrderOperationalStatus: 'direct-ship-fba',
    supplierOrderWorkflowStage: 'complete',
  }),

  // G4 truth-audit case: UNTIERED family with an ACTIVE direct-ship order
  // parked in a non-operational pane — X5 wins: P11, never P4.
  goldRow('f-direct-untiered', 'dataReadiness', {
    asin: 'B0021',
    baselineTier: null,
    currentProjectedTier: null,
    lastClosedMonthTier: null,
    supplierOrderId: 'order-direct-untiered',
    supplierOrderOperationalStatus: 'direct-ship-fba',
    supplierOrderWorkflowStage: 'amazon_inbound',
  }),

  // Zero stock (P8) and excess (P6) so every pane is represented.
  goldRow('f-zero-stock', 'zeroStock', { asin: 'B0015', currentPlanningStock: 0, inventoryPositionStock: 0 }),
  goldRow('f-excess', 'excessInventory', { asin: 'B0016', daysOfCover: 120 }),
  goldRow('f-readiness', 'dataReadiness', {
    asin: 'B0017',
    readinessReasonCodes: ['family_review_required'],
    dataQualityIssues: ['missing_supplier'],
  }),
  goldRow('f-healthy', 'healthyInventory', {
    asin: 'B0018',
    projectedMonthlyUnits: 120,
    lastClosedMonthUnits: 100, // +20% -> velocityTrend up
  }),
  // Task 002: Discontinued & Paused pane — one family, two dead listings.
  goldRow('f-disc-a', 'discontinuedPaused', {
    companyProductFamilyId: 'family-disc',
    companyProductId: 'cp-disc-a',
    asin: 'B0030A',
    baselineTier: null,
    currentProjectedTier: null,
    lastClosedMonthTier: null,
    currentPlanningStock: 0,
    inventoryPositionStock: 0,
    supplierName: 'Old Supplier Co',
    lastClosedMonth: '2026-03-01',
    // Null evidence that WOULD count into staleLeadTimes.unknown if the pane
    // were not excluded from every KPI tile (asserted via tile equality).
    leadTimeConfirmedAt: null,
  }),
  goldRow('f-disc-b', 'discontinuedPaused', {
    companyProductFamilyId: 'family-disc',
    companyProductId: 'cp-disc-b',
    asin: 'B0030B',
    baselineTier: null,
    currentProjectedTier: null,
    lastClosedMonthTier: null,
    currentPlanningStock: 0,
    inventoryPositionStock: 0,
    supplierName: 'Old Supplier Co',
    lastClosedMonth: null,
    leadTimeConfirmedAt: null,
  }),

  goldRow('f-untiered-native', 'untieredProducts', {
    asin: 'B0019',
    baselineTier: null,
    currentProjectedTier: null,
    lastClosedMonthTier: null,
  }),
];

/* ------------------------------------------------------------------ *
 * Silver orders — one row per referenced supplier order (except the orphan).
 * ------------------------------------------------------------------ */

export const SILVER_ORDERS: SilverOrderFixture[] = [
  silverOrder('order-1a', 'in_prep', { workflowStageEnteredAt: hoursAgo(72), operationalStatus: 'prep-in-progress' }),
  silverOrder('order-1b', 'in_prep', { workflowStageEnteredAt: hoursAgo(72), operationalStatus: 'prep-in-progress' }),
  silverOrder('order-2a', 'amazon_inbound', { workflowStageEnteredAt: hoursAgo(96) }),
  silverOrder('order-2b', 'amazon_inbound', { workflowStageEnteredAt: hoursAgo(96) }),
  silverOrder('order-2c', 'amazon_inbound', { workflowStageEnteredAt: hoursAgo(96) }),
  silverOrder('order-3', 'amazon_inbound', {
    operationalStatus: 'direct-ship-fba',
    workflowStageEnteredAt: hoursAgo(50),
  }),
  silverOrder('order-4a', 'pre_purchase', {
    workflowStageEnteredAt: hoursAgo(30),
    operationalStatus: 'approved-to-order',
  }),
  silverOrder('order-4b', 'in_prep', { workflowStageEnteredAt: hoursAgo(20), operationalStatus: 'ordered' }),
  // Item 5: silver has moved to amazon_inbound while gold pane still says in_prep.
  silverOrder('order-5', 'amazon_inbound', {
    workflowStageEnteredAt: hoursAgo(12),
    operationalStatus: 'inbound-monitoring',
  }),
  silverOrder('order-10-orphan-DECOY', 'pre_purchase', {}), // deliberately NOT order-10-orphan.
  // Item 12: null workflowStageEnteredAt.
  silverOrder('order-12', 'in_prep', { workflowStageEnteredAt: null, operationalStatus: 'ordered' }),
  silverOrder('order-late', 'amazon_inbound', { workflowStageEnteredAt: hoursAgo(240) }),
];

function silverOrder(
  id: string,
  workflowStage: string,
  overrides: Partial<SilverOrderFixture> = {},
): SilverOrderFixture {
  return {
    id,
    orderRef: `PO-${id}`,
    company: 'Acme',
    operationalStatus: null,
    workflowStage,
    workflowStageEnteredAt: hoursAgo(24),
    prepBoxes: null,
    prepCartons: null,
    prepDimensions: null,
    prepDetailsUpdatedAt: null,
    prepDetailsUpdatedByUserId: null,
    provenance: 'synthetic',
    ...overrides,
  };
}

export interface SilverSupplierFixture {
  id: string;
  displayName: string;
  shipDestination: 'direct_fba' | 'prep_center' | null;
  provenance: FixtureProvenance;
}

export interface SilverFamilyFixture {
  id: string;
  replenishmentTargetCompanyProductId: string | null;
  targetSelectionSource: string | null;
  targetSelectionEvidenceJson: Record<string, unknown> | null;
  provenance: FixtureProvenance;
}

/** QA item 2 fixture: persisted family target with tiered-first provenance. */
export const SILVER_FAMILIES: SilverFamilyFixture[] = [
  {
    id: 'family-13',
    replenishmentTargetCompanyProductId: 'cp-13a',
    targetSelectionSource: 'automatic',
    targetSelectionEvidenceJson: {
      selectionRule: 'tiered_first_migration_rule',
      ruleVersion: 'tiered-first-migration-v1',
    },
    provenance: 'synthetic',
  },
];

export interface SilverCompanyProductFixture {
  id: string;
  companyProductFamilyId: string;
  lifecycleStatus: string;
  lifecycleStatusProvenance: Record<string, unknown> | null;
  provenance: FixtureProvenance;
}

/** Task 002 fixtures: swept company products with reversible provenance. */
export const SILVER_COMPANY_PRODUCTS: SilverCompanyProductFixture[] = [
  {
    id: 'cp-disc-a',
    companyProductFamilyId: 'family-disc',
    lifecycleStatus: 'discontinued',
    lifecycleStatusProvenance: { kind: 'migration_sweep_2026_07', previousStatus: 'candidate_new_product' },
    provenance: 'synthetic',
  },
  {
    id: 'cp-disc-b',
    companyProductFamilyId: 'family-disc',
    lifecycleStatus: 'discontinued',
    lifecycleStatusProvenance: { kind: 'migration_sweep_2026_07', previousStatus: 'candidate_new_product' },
    provenance: 'synthetic',
  },
];

/** AD-7 v3.1 fixtures: one supplier per derivation branch. */
export const SILVER_SUPPLIERS: SilverSupplierFixture[] = [
  {
    id: 'supplier-prep-center',
    displayName: 'Prep Center Supplier',
    shipDestination: 'prep_center',
    provenance: 'synthetic',
  },
  { id: 'supplier-direct', displayName: 'Direct FBA Supplier', shipDestination: 'direct_fba', provenance: 'synthetic' },
  {
    id: 'supplier-unknown-route',
    displayName: 'Unknown Route Supplier',
    shipDestination: null,
    provenance: 'synthetic',
  },
  // T6: assigned supplier of the enriched supplyAction row + its order history.
  {
    id: 'supplier-lead-1',
    displayName: 'Lead Boundary Supplies',
    shipDestination: 'prep_center',
    provenance: 'synthetic',
  },
];

const HISTORY_ORDER_DEFAULTS = {
  company: 'Acme',
  workflowStageEnteredAt: null,
  prepBoxes: null,
  prepCartons: null,
  prepDimensions: null,
  prepDetailsUpdatedAt: null,
  prepDetailsUpdatedByUserId: null,
  provenance: 'synthetic' as const,
};

/**
 * T6 (D5): supplier-order history of the enriched supplyAction family
 * (family-f11a-lead-boundary / cp-f11a). order-h2 carries TWO member lines to
 * prove per-order aggregation (200 + 50 = 250, the max-ever reference).
 */
export const HISTORY_SILVER_ORDERS: SilverOrderFixture[] = [
  {
    ...HISTORY_ORDER_DEFAULTS,
    id: 'order-h1',
    orderRef: 'PO-H1',
    operationalStatus: 'complete',
    workflowStage: 'complete',
    orderDate: '2026-07-01',
    supplierId: 'supplier-lead-1',
  },
  {
    ...HISTORY_ORDER_DEFAULTS,
    id: 'order-h2',
    orderRef: 'PO-H2',
    operationalStatus: 'complete',
    workflowStage: 'complete',
    orderDate: '2026-05-15',
    supplierId: 'supplier-lead-1',
  },
  {
    ...HISTORY_ORDER_DEFAULTS,
    id: 'order-h3',
    orderRef: 'PO-H3',
    operationalStatus: 'hold/cancelled',
    workflowStage: 'cancelled',
    orderDate: '2026-03-10',
    supplierId: 'supplier-unknown-route',
  },
];

export const SILVER_ORDER_LINES: SilverOrderLineFixture[] = [
  {
    id: 'line-h1',
    orderId: 'order-h1',
    companyProductId: 'cp-f11a',
    orderedQty: 120,
    productMappingStatus: 'resolved',
    provenance: 'synthetic',
  },
  {
    id: 'line-h2a',
    orderId: 'order-h2',
    companyProductId: 'cp-f11a',
    orderedQty: 200,
    productMappingStatus: 'resolved',
    provenance: 'synthetic',
  },
  {
    id: 'line-h2b',
    orderId: 'order-h2',
    companyProductId: 'cp-f11a',
    orderedQty: 50,
    productMappingStatus: 'resolved',
    provenance: 'synthetic',
  },
  {
    id: 'line-h3',
    orderId: 'order-h3',
    companyProductId: 'cp-f11a',
    orderedQty: 80,
    productMappingStatus: 'resolved',
    provenance: 'synthetic',
  },
  // Unresolved mapping never reaches the history (pipeline parity).
  {
    id: 'line-x',
    orderId: 'order-h1',
    companyProductId: 'cp-f11a',
    orderedQty: 999,
    productMappingStatus: 'unresolved',
    provenance: 'synthetic',
  },
];

/**
 * The 14-item T-0.1 coverage matrix — every item pinned to the fixture ids that
 * exercise it, so the contract test can assert coverage mechanically.
 */
export interface CoverageMatrixItem {
  item: number;
  description: string;
  goldRowIds: string[];
  silverOrderIds: string[];
  provenance: FixtureProvenance;
  note?: string;
}

export const COVERAGE_MATRIX: CoverageMatrixItem[] = [
  {
    item: 1,
    description: 'in_prep >48h no activity (followUp true) + twin at exactly 48.0h (false)',
    goldRowIds: ['f1a-inprep-followup', 'f1b-inprep-boundary'],
    silverOrderIds: ['order-1a', 'order-1b'],
    provenance: 'synthetic',
  },
  {
    item: 2,
    description: 'null ETA+null OOS; null ETA + OOS; ETA==OOS-buffer (sufficient boundary)',
    goldRowIds: ['f2a-inbound-null-null', 'f2b-inbound-eta-null', 'f2c-inbound-sufficient-boundary'],
    silverOrderIds: ['order-2a', 'order-2b', 'order-2c'],
    provenance: 'synthetic',
  },
  {
    item: 3,
    description: 'direct-ship-fba absent from P3, present in P4',
    goldRowIds: ['f3-direct-ship-fba'],
    silverOrderIds: ['order-3'],
    provenance: 'synthetic',
  },
  {
    item: 4,
    description: 'multi-order family: pre_purchase + in_prep (grain)',
    goldRowIds: ['f4a-order-prepurchase', 'f4b-order-inprep'],
    silverOrderIds: ['order-4a', 'order-4b'],
    provenance: 'synthetic',
  },
  {
    item: 5,
    description: 'gold inPrep vs silver amazon_inbound (staleClassification, no reclassify)',
    goldRowIds: ['f5-stale-classification'],
    silverOrderIds: ['order-5'],
    provenance: 'synthetic',
  },
  {
    item: 6,
    description: 'adminExcluded row never served',
    goldRowIds: ['f6-admin-excluded'],
    silverOrderIds: [],
    provenance: 'synthetic',
  },
  {
    item: 7,
    description: 'untiered family in gold operational pane -> untiered_projected',
    goldRowIds: ['f7-untiered-in-healthy'],
    silverOrderIds: [],
    provenance: 'synthetic',
  },
  {
    item: 8,
    description: 'band set: 3 trusted; 2 (insufficient); v==best; v==worst; v<worst+declining',
    goldRowIds: [
      'f8a-band-3-trusted',
      'f8b-band-2-insufficient',
      'f8c-band-v-eq-best',
      'f8d-band-v-eq-worst',
      'f8e-band-below-declining',
    ],
    silverOrderIds: [],
    provenance: 'synthetic',
  },
  {
    item: 9,
    description: 'null unitCost stuck row; null estimatedProfitRisk supplyAction row',
    goldRowIds: ['f9a-stuck-null-cost', 'f9b-supply-null-risk'],
    silverOrderIds: [],
    provenance: 'synthetic',
  },
  {
    item: 10,
    description: 'gold order row with no matching silver order (orphan -> lastActivity null)',
    goldRowIds: ['f10-orphan-order'],
    silverOrderIds: [],
    provenance: 'synthetic',
  },
  {
    item: 11,
    description: 'lead-time evidence at/over boundary + null evidence',
    goldRowIds: ['f11a-lead-boundary', 'f11b-lead-stale', 'f11c-lead-null'],
    silverOrderIds: [],
    provenance: 'synthetic',
  },
  {
    item: 12,
    description: 'null workflowStageEnteredAt -> daysInStage null (unknown, not 0)',
    goldRowIds: ['f12-null-stage-entered'],
    silverOrderIds: ['order-12'],
    provenance: 'synthetic',
  },
  {
    item: 13,
    description: 'family with members in >= 2 panes (familySplit)',
    goldRowIds: ['f13a-split-supply', 'f13b-split-healthy'],
    silverOrderIds: [],
    provenance: 'synthetic',
  },
  {
    item: 14,
    description:
      'paid/ordered order taxonomy — N/A: every paid/ordered status maps to in_prep (OPEN-4); covered by f4b/f12 (ordered -> P3)',
    goldRowIds: ['f4b-order-inprep', 'f12-null-stage-entered'],
    silverOrderIds: ['order-4b', 'order-12'],
    provenance: 'synthetic',
    note: 'No distinct paid-not-yet-in_prep source case exists in order-operational-status.ts; taxonomy-confirmed.',
  },
];
