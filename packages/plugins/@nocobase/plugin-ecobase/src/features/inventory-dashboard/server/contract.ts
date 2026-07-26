/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * EcoBase Inventory Dashboard — server data contract (types only).
 *
 * Fully-encapsulated feature (AD-1): this module and everything under
 * `src/features/inventory-dashboard/` must not import from any other
 * `src/features/*` directory. Vendored copies (workflow-stage tables, the
 * published-gold reader) live inside this feature with origin-pointer comments
 * and parity tests.
 */

export const DASHBOARD_PANE_KEYS = [
  'supplyAction',
  'activeOrders',
  'inPrepMonitoring',
  'inboundMonitoring',
  'healthyInventory',
  'excessInventory',
  'stuckInventory',
  'zeroStock',
  'dataReadiness',
  'performanceReview',
  'untieredProducts',
  'discontinuedPaused',
] as const;

export type PaneKey = (typeof DASHBOARD_PANE_KEYS)[number];

export function isPaneKey(value: unknown): value is PaneKey {
  return typeof value === 'string' && (DASHBOARD_PANE_KEYS as readonly string[]).includes(value);
}

/**
 * Issue 063 (D1/D4): the panes that render the shared PRODUCT table — the same
 * eight columns and the same tier-composite DEFAULT sort, so the client's
 * "Tier" default-sort label is truthful on every one of them. (Row grain is
 * whatever each pane serves; a split family can put several member listings in
 * one pane.) The three order panes (order grain), dataReadiness (tiered-first
 * default) and performanceReview are NOT product tables and are deliberately
 * absent.
 */
export const PRODUCT_TABLE_PANES: ReadonlySet<PaneKey> = new Set<PaneKey>([
  'supplyAction',
  'healthyInventory',
  'excessInventory',
  'stuckInventory',
  'zeroStock',
  'untieredProducts',
  'discontinuedPaused',
]);

export type DataFreshness = 'fresh' | 'stale' | 'unknown';

export type HeaderTileKey = 'urgentStockout' | 'orderedButLate' | 'staleLeadTimes' | 'needsFollowUp' | 'stuckCapital';

export interface DashboardHeaderTile {
  key: HeaderTileKey;
  count: number;
  /** null when every contributing input was null (surfaced via unknownCount). */
  moneyAtRisk: number | null;
  unknownCount: number;
  currency: 'EUR';
  targetPane: PaneKey;
}

export interface DashboardHeader {
  publishedRunId: string;
  calculationDate: string | null;
  dataFreshness: DataFreshness;
  tiles: DashboardHeaderTile[];
  /** T7/R1-6: display-relevant planning settings — the client never hardcodes these. */
  settings: { fbaReceivingBufferDays: number; targetCoverDays: number };
  /**
   * D3 quiet source-freshness surfacing. `salesDataThroughDate` is the OLDEST covered sales
   * day across the (company-scoped) rows — "Sales data through <date>". `salesDataDelayed` is
   * true only when that date is more than 3 days behind the calculation date (the single quiet
   * alert; normal lag shows the date with no warning). Null date ⇒ no covered current-month data.
   */
  salesDataThroughDate: string | null;
  salesDataDelayed: boolean;
}

/** Family/product identity carried by every row (nulls stay null). */
export interface DashboardRowIdentity {
  familyKey: string;
  listingRowId: string;
  company: string | null;
  amazonAccountId: string | null;
  marketplace: string | null;
  asin: string | null;
  sku: string | null;
  title: string | null;
}

/** Baseline + current tier per ADR-012. */
export interface DashboardRowTier {
  baseline: string | null;
  current: string | null;
}

export interface DashboardRowStock {
  currentPlanningStock: number | null;
  inventoryPositionStock: number | null;
  unitCost: number | null;
  /** T4 (R2): per-bucket breakdown, served verbatim from gold; nulls stay null. */
  sellableStock: number | null;
  reservedStock: number | null;
  inboundStock: number | null;
  prepStock: number | null;
  orderedStock: number | null;
  awdStock: number | null;
  futurePositionStock: number | null;
}

/** T4 (R3): effective velocity with F4 ladder provenance, served verbatim. */
export interface DashboardRowVelocity {
  value: number | null;
  /** 'rolling_30' | 'last_closed_month' | 'baseline_average' | 'none' | null (pre-ladder runs). */
  basis: string | null;
  asOfDate: string | null;
  /** Trusted-path authority: 'trusted_positive' | 'trusted_zero' | 'insufficient_evidence'. */
  evidenceStatus: string | null;
  /**
   * F1: 'high' | 'medium' | 'low' | 'none' | null (runs published before the column existed).
   * Only a HIGH-confidence rolling_30 velocity is fully trusted; anything less is an estimate.
   */
  confidence: string | null;
  /** F1: fact-carrying days observed in the trailing-30 window (the sparse-velocity divisor). */
  observedDays: number | null;
}

/** T4 (R4): row-level assigned supplier + lead time (order-specific supplier stays on `order`). */
export interface DashboardRowSupplier {
  id: string | null;
  name: string | null;
  leadTimeDays: number | null;
  leadTimeConfirmedAt: string | null;
  leadTimeFreshness: string | null;
}

/** T4 (D3/D4): monthly profit statistics for the drawer. */
export interface DashboardRowProfit {
  averageMonthly: number | null;
  bestMonthly: number | null;
  worstMonthly: number | null;
  lastClosedMonth: number | null;
  projectedMonthly: number | null;
  perUnit: number | null;
}

/** AD-7 v3.1: collapsed enum — 'supplier' removed; own_prep_center comes from the supplier's shipDestination. */
export type PrepPath = 'direct_fba' | 'own_prep_center' | 'unknown';

export type SupplierShipDestination = 'direct_fba' | 'prep_center';

export type BufferStatus = 'sufficient' | 'at_risk' | 'late' | 'unknown';

export interface DashboardLastActivity {
  preview: string;
  author: string | null;
  at: string;
}

/** Order-specific fields, present only on P2/P3/P4 rows. */
export interface DashboardOrderFields {
  orderId: string;
  orderNumber: string | null;
  clickupStatus: string | null;
  workflowStage: string | null;
  workflowStageEnteredAt: string | null;
  daysInStage: number | null;
  prepPath?: PrepPath;
  supplierId?: string | null;
  supplierName?: string | null;
  supplierShipDestination?: SupplierShipDestination | null;
  expectedArrivalDate?: string | null;
  arrivalProvenance?: string | null;
  bufferStatus?: BufferStatus;
  needsFollowUp: boolean;
}

export interface DashboardRow {
  identity: DashboardRowIdentity;
  pane: PaneKey;
  tier: DashboardRowTier;
  stock: DashboardRowStock;
  velocity: DashboardRowVelocity;
  supplier: DashboardRowSupplier;
  profit: DashboardRowProfit;
  /** Trusted-only sellable cover (disposition authority) — null under fallback velocity. */
  daysOfCover: number | null;
  /** T4: position cover from the effective velocity; display precedence is the client's call (T7). */
  positionDaysOfCover: number | null;
  estimatedOosDate: string | null;
  positionEstimatedOosDate: string | null;
  latestSafeReorderDate: string | null;
  daysUntilSafeReorder: number | null;
  estimatedProfitRisk: number | null;
  moneyRiskStatus: string | null;
  moneyRiskUncoveredDays: number | null;
  recommendedOrderQty: number | null;
  /** T-D5 rider: the resolved coverage horizon behind recommendedOrderQty (override ?? setting). */
  targetCoverDays: number | null;
  /**
   * T-D5 (approved OPEN-D5): present when a TIERED family outside the action/
   * order panes has a position-based stockout estimate within
   * URGENT_STOCKOUT_HORIZON_DAYS of today (daysUntil may be <= 0 when the
   * estimated date has passed). Derived server-side at read time.
   */
  stockoutUrgency?: { daysUntil: number };
  reasonCodes: string[];
  velocityTrend?: VelocityTrend;
  performanceBand?: PerformanceBand;
  /** Gold pane disagrees with fresh silver stage — surfaced, not reclassified. */
  staleClassification?: true;
  /** Family has member listings in >= 2 panes (§4.8). */
  familySplit?: true;
  /** Discontinued & Paused pane only (task 002): evidence columns. */
  supplierName?: string | null;
  familyMemberCount?: number;
  lastMovementMonth?: string | null;
  lifecycleProvenance?: string | null;
  lifecyclePreviousStatus?: string | null;
  order?: DashboardOrderFields;
  lastActivity?: DashboardLastActivity | null;
}

export interface PaneMetric {
  key: string;
  label: string;
  value: number | string | null;
  format?: 'currency' | 'days';
}

export interface PanePagination {
  page: number;
  pageSize: number;
  total: number;
}

export interface PaneResponse {
  pane: PaneKey;
  publishedRunId: string;
  metrics: PaneMetric[];
  rows: DashboardRow[];
  pagination: PanePagination;
}

export type VelocityTrend = 'up' | 'flat' | 'down' | 'unknown';

export type PerformanceBand = 'above_band' | 'within_band' | 'below_band' | 'insufficient_evidence';

/** Emitted whenever a request pins a run that is no longer the published run (AD-3). */
export interface RunSupersededSignal {
  runSuperseded: true;
  publishedRunId: string;
}

export type PaneResult = PaneResponse | RunSupersededSignal;

export function isRunSuperseded(result: PaneResult | DrawerContextResult): result is RunSupersededSignal {
  return (result as RunSupersededSignal).runSuperseded === true;
}

export interface HeaderRequest {
  companyId?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface PaneRequest {
  pane: PaneKey;
  runId: string;
  companyId?: string;
  search?: string;
  sort?: string;
  sortDirection?: SortDirection;
  page: number;
  pageSize: number;
}

export interface DrawerContextRequest {
  pane: PaneKey;
  runId: string;
  familyId: string;
  orderId?: string;
  /** The exact listing the user clicked — becomes the drawer's primary row (QA item 7). */
  listingRowId?: string;
  /** T6 (D7 Data tab): when true, the response carries the primary row's full gold record. */
  includeRaw?: boolean;
}

export interface MonthlyEvidencePoint {
  month?: string;
  units: number | null;
  /** T4 (D3 chart): per-month profit from the evidence blob; null when not persisted. */
  profit: number | null;
  trusted: boolean;
}

/** T6 (D5): one recent supplier order of the family, quantities aggregated per order. */
export interface DrawerOrderHistoryEntry {
  // Order Create/View UI (T5): opaque navigation handle so an order row can open
  // the Order view drawer. Not rendered to the user (D1 stays: no ids on screen).
  orderId: string | null;
  orderDate: string | null;
  orderedQty: number | null;
  supplierName: string | null;
  status: string | null;
}

/** T6 (D6): public entity names for the drawer thread (internal names mapped). */
export type DrawerCommentEntityType = 'product' | 'family' | 'order' | 'supplier';

export interface DrawerCommentEntry {
  entityType: DrawerCommentEntityType;
  body: string;
  author: string | null;
  at: string;
}

export interface DrawerContextResponse {
  pane: PaneKey;
  publishedRunId: string;
  familyKey: string;
  /** P10 band visual input: the primary row's monthly performance evidence. */
  performanceEvidence: MonthlyEvidencePoint[];
  /** All member listings of the family and the pane each currently sits in (§4.8). */
  familyMembers: Array<{
    listingRowId: string;
    /** T7/T8b: mutation payload identity (setFamilyTarget / createPlannedOrder) — never rendered. */
    companyProductId: string | null;
    asin: string | null;
    sku: string | null;
    pane: PaneKey;
    /** QA item 2: marks the family's persisted replenishment target. */
    isTarget: boolean;
  }>;
  /** QA item 2: persisted target identity + selection provenance (null when in review). */
  familyTarget: {
    companyProductId: string | null;
    selectionSource: string | null;
    selectionRule: string | null;
  } | null;
  primaryRow: DashboardRow;
  orderRows: DashboardRow[];
  /** T6 (D5): recent supplier-order history, newest first, capped at 12 entries. */
  orderHistory: DrawerOrderHistoryEntry[];
  /** T6 (R5 reference): max per-order quantity over the FULL history (not just the capped 12). */
  maxEverOrderedQty: number | null;
  /** T6 (D6): full comment thread across family/product/order/supplier, newest first, capped at 50. */
  commentThread: DrawerCommentEntry[];
  /** T6 (D7 Data tab): full gold record of the primary row; present only when requested via includeRaw. */
  rawGoldRow?: Record<string, unknown>;
}

export type DrawerContextResult = DrawerContextResponse | RunSupersededSignal;

export type FixtureProvenance = 'harvested' | 'synthetic';
