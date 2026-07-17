/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const INVENTORY_PLANNING_PANES = [
  'supplyAction',
  'activeOrders',
  'inPrepMonitoring',
  'inboundMonitoring',
  'healthyInventory',
  'excessInventory',
  'stuckInventory',
  'zeroStock',
  'dataReadiness',
  'untieredProducts',
] as const;

export type InventoryPlanningPane = (typeof INVENTORY_PLANNING_PANES)[number];
export type InventoryPane = InventoryPlanningPane | 'adminExcluded';

export interface InventoryFamilyClassificationInput {
  active: boolean;
  excluded: boolean;
  tier?: string;
  workflowStage?: string;
  receiptStatus?: string;
  stockEvidenceTrusted: boolean;
  totalStockAndPipeline?: number;
  currentStock?: number;
  readinessReasonCodes: string[];
  actionStatus?: string;
  stuckClassification?: string;
  supplierResolved: boolean;
  effectiveLeadTimeDays?: number;
}

export interface InventoryPaneDecision {
  pane: InventoryPane;
  reason: string;
}

const RECEIPT_PENDING_STATUSES = new Set(['awaiting_amazon_stock', 'partially_observed', 'review_required']);
const RECEIPT_COMPLETE_STATUSES = new Set(['amazon_stock_observed', 'completed_by_later_inbound']);
const SUPPLY_ACTION_STATUSES = new Set(['overdue', 'order_today', 'order_soon']);
const EXCESS_CLASSIFICATIONS = new Set(['over_60_doc']);
const STUCK_CLASSIFICATIONS = new Set(['no_sell_through_with_stock', 'reserved_stalled', 'pipeline_stalled']);
const ALWAYS_BLOCKING_READINESS_REASONS = new Set([
  'family_missing',
  'family_review_required',
  'inventory_unknown',
  'inventory_invalid_future',
  'inventory_stale',
  'velocity_missing',
  'velocity_fallback',
  'velocity_untrusted',
  'ambiguous_current_order',
  'multiple_active_cycles',
  'order_family_linkage_unresolved',
  'blocking_planning_readiness',
]);

function normalized(value: string | undefined) {
  return value?.trim().toLowerCase();
}

function isTiered(tier: string | undefined) {
  return ['a', 'b', 'c'].includes(normalized(tier) ?? '');
}

function blockingReadinessReason(input: InventoryFamilyClassificationInput) {
  const supplyActionDue = SUPPLY_ACTION_STATUSES.has(normalized(input.actionStatus) ?? '');
  return input.readinessReasonCodes.find(
    (reason) =>
      ALWAYS_BLOCKING_READINESS_REASONS.has(reason) ||
      (supplyActionDue && ['supplier_unavailable', 'lead_time_unavailable'].includes(reason)),
  );
}

export function classifyInventoryFamily(input: InventoryFamilyClassificationInput): InventoryPaneDecision {
  if (!input.active || input.excluded) return { pane: 'adminExcluded', reason: 'inactive_or_excluded' };
  if (!isTiered(input.tier)) return { pane: 'untieredProducts', reason: 'untiered_family' };

  const workflowStage = normalized(input.workflowStage);
  const receiptStatus = normalized(input.receiptStatus);
  if (workflowStage === 'pre_purchase' || workflowStage === 'hold') {
    return { pane: 'activeOrders', reason: `${workflowStage}_workflow` };
  }
  if (workflowStage === 'in_prep') return { pane: 'inPrepMonitoring', reason: 'in_prep_workflow' };
  if (
    workflowStage === 'amazon_inbound' ||
    RECEIPT_PENDING_STATUSES.has(receiptStatus ?? '') ||
    (workflowStage === 'complete' && !RECEIPT_COMPLETE_STATUSES.has(receiptStatus ?? ''))
  ) {
    return { pane: 'inboundMonitoring', reason: 'amazon_inbound_or_receipt_pending' };
  }

  if (input.stockEvidenceTrusted && input.totalStockAndPipeline === 0) {
    return { pane: 'zeroStock', reason: 'zero_trusted_stock_and_pipeline' };
  }

  const readinessReason = blockingReadinessReason(input);
  if (readinessReason) return { pane: 'dataReadiness', reason: readinessReason };

  const stuckClassification = normalized(input.stuckClassification);
  if (EXCESS_CLASSIFICATIONS.has(stuckClassification ?? '')) {
    return { pane: 'excessInventory', reason: stuckClassification as string };
  }
  if (STUCK_CLASSIFICATIONS.has(stuckClassification ?? '')) {
    return { pane: 'stuckInventory', reason: stuckClassification as string };
  }

  if (
    SUPPLY_ACTION_STATUSES.has(normalized(input.actionStatus) ?? '') &&
    (input.currentStock ?? 0) > 0 &&
    input.supplierResolved &&
    typeof input.effectiveLeadTimeDays === 'number'
  ) {
    return { pane: 'supplyAction', reason: 'trusted_reorder_due' };
  }

  return { pane: 'healthyInventory', reason: 'sufficient_or_non_actionable_stock' };
}
