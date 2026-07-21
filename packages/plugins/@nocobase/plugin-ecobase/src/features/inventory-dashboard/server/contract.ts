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
] as const;

export type PaneKey = (typeof DASHBOARD_PANE_KEYS)[number];

export function isPaneKey(value: unknown): value is PaneKey {
  return typeof value === 'string' && (DASHBOARD_PANE_KEYS as readonly string[]).includes(value);
}

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
  daysOfCover: number | null;
  estimatedOosDate: string | null;
  latestSafeReorderDate: string | null;
  estimatedProfitRisk: number | null;
  recommendedOrderQty: number | null;
  reasonCodes: string[];
  velocityTrend?: VelocityTrend;
  performanceBand?: PerformanceBand;
  /** Gold pane disagrees with fresh silver stage — surfaced, not reclassified. */
  staleClassification?: true;
  /** Family has member listings in >= 2 panes (§4.8). */
  familySplit?: true;
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
}

export interface MonthlyEvidencePoint {
  month?: string;
  units: number | null;
  trusted: boolean;
}

export interface DrawerContextResponse {
  pane: PaneKey;
  publishedRunId: string;
  familyKey: string;
  /** P10 band visual input: the primary row's monthly performance evidence. */
  performanceEvidence: MonthlyEvidencePoint[];
  /** All member listings of the family and the pane each currently sits in (§4.8). */
  familyMembers: Array<{ listingRowId: string; asin: string | null; sku: string | null; pane: PaneKey }>;
  primaryRow: DashboardRow;
  orderRows: DashboardRow[];
}

export type DrawerContextResult = DrawerContextResponse | RunSupersededSignal;

export type FixtureProvenance = 'harvested' | 'synthetic';
