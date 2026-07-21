/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * VENDORED COPY (AD-1 full encapsulation).
 *
 * Origin: src/<feature dir>/order-planning/order-operational-status.ts
 *   - CLICKUP_ORDER_OPERATIONAL_STATUSES
 *   - OPERATIONAL_STATUS_METADATA[*].workflowStage
 *   - isPrePurchaseStage / isPrepStage / isInboundStage
 *
 * The Inventory Dashboard feature must not import from other `features/*`
 * directories, so the status -> workflowStage mapping is copied here. Parity
 * with the origin is asserted by workflow-stage.parity.test.ts against a
 * captured reference of the origin's fixtures (the test also cannot import the
 * origin without violating the import-boundary guard). Keep this table in sync
 * with the origin whenever ClickUp statuses change.
 */

export const DASHBOARD_CLICKUP_OPERATIONAL_STATUSES = [
  'complete',
  'to do',
  'inbound-monitoring',
  'hold/cancelled',
  'direct-ship-fba',
  'prep-in-progress',
  'ordered',
  'in progress',
  'approved-to-order',
  'order analysing',
  'in transit to prep',
  'hold',
] as const;

export type DashboardClickupOperationalStatus = (typeof DASHBOARD_CLICKUP_OPERATIONAL_STATUSES)[number];

export type DashboardWorkflowStage = 'pre_purchase' | 'hold' | 'in_prep' | 'amazon_inbound' | 'cancelled' | 'complete';

const WORKFLOW_STAGE_BY_STATUS: Record<DashboardClickupOperationalStatus, DashboardWorkflowStage> = {
  complete: 'complete',
  'to do': 'pre_purchase',
  'inbound-monitoring': 'amazon_inbound',
  'hold/cancelled': 'cancelled',
  'direct-ship-fba': 'amazon_inbound',
  'prep-in-progress': 'in_prep',
  ordered: 'in_prep',
  'in progress': 'pre_purchase',
  'approved-to-order': 'pre_purchase',
  'order analysing': 'pre_purchase',
  'in transit to prep': 'in_prep',
  hold: 'hold',
};

export function normalizeDashboardOperationalStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function dashboardClickupOperationalStatus(value: unknown): DashboardClickupOperationalStatus | undefined {
  const normalized = normalizeDashboardOperationalStatus(value);
  return DASHBOARD_CLICKUP_OPERATIONAL_STATUSES.find((status) => status === normalized);
}

export function dashboardWorkflowStageForStatus(value: unknown): DashboardWorkflowStage | undefined {
  const status = dashboardClickupOperationalStatus(value);
  return status ? WORKFLOW_STAGE_BY_STATUS[status] : undefined;
}

/** `direct-ship-fba` orders always route to inbound (P4), regardless of prep sub-status (AD-2 #3). */
export function isDirectShipFba(value: unknown): boolean {
  return dashboardClickupOperationalStatus(value) === 'direct-ship-fba';
}

export function isPrePurchaseStage(stage: unknown): boolean {
  return stage === 'pre_purchase' || stage === 'hold';
}

export function isPrepStage(stage: unknown): boolean {
  return stage === 'in_prep';
}

export function isInboundStage(stage: unknown): boolean {
  return stage === 'amazon_inbound';
}
