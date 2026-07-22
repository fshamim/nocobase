/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Single source of every user-facing literal on the Inventory Dashboard
 * (AD-8 / T-2.5). Components must reference `TEXT.*` (never inline strings) so
 * the i18n parity test can mechanically assert that every key exists in both
 * `en-US.json` and `zh-CN.json`.
 */

export const TEXT = {
  pageTitle: 'Inventory Dashboard',
  publishedRun: 'Published run',
  searchLabel: 'Search',
  searchPlaceholder: 'Search products or orders',
  companyFilterLabel: 'Company',
  allCompanies: 'All companies',
  refresh: 'Refresh',
  retry: 'Retry',
  loadFailed: 'Failed to load',
  unexpectedResponse: 'Unexpected server response shape',
  empty: 'No rows',
  loading: 'Loading',
  slowLoadHint: 'Still loading — the first request after a restart can take up to a minute',
  unknown: 'unknown',
  days: 'days',
  noActivityYet: 'no activity yet',
  runSupersededNotice: 'Data updated — refresh to load the latest published run',
  paneSupplyAction: 'Supply Action',
  paneActiveOrders: 'Active Orders',
  paneInPrepMonitoring: 'In-Prep Monitoring',
  paneInboundMonitoring: 'Inbound Monitoring',
  paneHealthyInventory: 'Healthy Inventory',
  paneExcessInventory: 'Excess Inventory',
  paneStuckInventory: 'Stuck Inventory',
  paneZeroStock: 'Zero Stock',
  paneDataReadiness: 'Data Readiness',
  panePerformanceReview: 'Performance Review',
  paneUntieredProducts: 'Untiered Products',
  paneDiscontinuedPaused: 'Discontinued & Paused',
  tileUrgentStockout: 'Urgent stockout risk',
  tileOrderedButLate: 'Ordered but late',
  tileStaleLeadTimes: 'Stale lead times',
  tileNeedsFollowUp: 'Needs follow-up',
  tileStuckCapital: 'Stuck capital',
  metricRows: 'Rows',
  metricMoneyAtRisk: 'Money at risk',
  metricUnknownMoney: 'Unknown money inputs',
  colProduct: 'Product',
  colOrder: 'Order',
  colReorderBy: 'Reorder by',
  colEstOos: 'Est. out of stock',
  colDaysOfCover: 'Days of cover',
  colProfitRisk: 'Profit risk',
  colDaysInStage: 'Days in stage',
  colLastActivity: 'Last activity',
  colExpectedArrival: 'Expected arrival',
  colStock: 'Stock',
  colUnitCost: 'Unit cost',
  colSignals: 'Signals',
  colMembers: 'Members',
  colLastMovement: 'Last movement',
  paneSearchPlaceholder: 'Search this pane',
  drawerReactivate: 'Reactivate',
  drawerReactivateReason: 'Reactivation reason (required)',
  tier: 'Tier',
  badgeStale: 'Stale data',
  badgeFamilySplit: 'Family split',
  badgeUntieredProjected: 'Untiered (projected)',
  reasonFrozenFamilyTargetReview: 'Family target review',
  reasonMissingBaselineEvidence: 'Missing baseline evidence',
  reasonFamilyReviewRequired: 'Family review required',
  badgeDirectFba: 'Direct FBA',
  badgeOwnPrep: 'Own prep center',
  badgePrepUnknown: 'Prep path unknown',
  bufferSufficient: 'On time',
  bufferAtRisk: 'At risk',
  bufferLate: 'Late',
  bufferUnknown: 'Arrival unknown',
  trendUp: 'Trending up',
  trendFlat: 'Flat',
  trendDown: 'Trending down',
  trendUnknown: 'Trend unknown',
  bandAbove: 'Above band',
  bandWithin: 'Within band',
  bandBelow: 'Below band',
  bandInsufficient: 'Insufficient evidence',
  drawerStatus: 'Status',
  drawerSupplier: 'Supplier',
  drawerFamilyListings: 'Family listings',
  drawerComment: 'Comment',
  drawerAddComment: 'Add comment',
  drawerChangeStatus: 'Change status',
  drawerPrepDetails: 'Prep details',
  drawerBoxes: 'Boxes',
  drawerCartons: 'Cartons',
  drawerSavePrepDetails: 'Save prep details',
  drawerShipRoute: 'Set supplier ship route',
  drawerShipsDirect: 'Ships direct to FBA',
  drawerShipsPrepCenter: 'Ships to our prep center',
  drawerSave: 'Save',
  drawerAdjustEta: 'Adjust expected delivery',
  drawerReason: 'Reason',
  drawerBufferExplanation: 'Buffer compares expected arrival with the estimated stockout date minus the safety buffer.',
  drawerSuggestedQty: 'Suggested order quantity',
  drawerOpenOrderPlanning: 'Open in Order Planning',
  drawerStuckReasons: 'Stuck reasons',
  drawerReadinessReasons: 'Readiness reasons',
  drawerOpenInventoryPlanning: 'Open Inventory Planning',
  drawerOpenSupplierManagement: 'Open Supplier Management',
  drawerBandTitle: 'Monthly units (last closed months)',
  drawerTierEvidence: 'Tier evidence',
  drawerFollowUpAck: 'Follow-up acknowledged.',
  drawerAcknowledgeFollowUp: 'Acknowledge follow-up',
} as const;

export type DashboardTextKey = keyof typeof TEXT;

/**
 * Known reason-code -> friendly label map (QA polish item 3). Unknown codes
 * fall back to the raw code so nothing ever breaks on new gold vocabulary.
 */
export const REASON_CODE_LABELS: Record<string, string> = {
  frozen_family_target_review: TEXT.reasonFrozenFamilyTargetReview,
  missing_or_invalid_baseline_evidence: TEXT.reasonMissingBaselineEvidence,
  family_review_required: TEXT.reasonFamilyReviewRequired,
  untiered_projected: TEXT.badgeUntieredProjected,
};

export function reasonLabel(code: string, t: (key: string) => string): string {
  const label = REASON_CODE_LABELS[code];
  return label ? t(label) : code;
}

/** Every literal the dashboard renders — the i18n parity test iterates this. */
export const DASHBOARD_I18N_KEYS: string[] = Object.values(TEXT);
