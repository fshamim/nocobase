/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { OrderLifecycleStatus } from './order-lifecycle-status';

export const CLICKUP_ORDER_OPERATIONAL_STATUSES = [
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

export type ClickupOrderOperationalStatus = (typeof CLICKUP_ORDER_OPERATIONAL_STATUSES)[number];

export type OrderWorkflowStage = 'pre_purchase' | 'hold' | 'in_prep' | 'amazon_inbound' | 'cancelled' | 'complete';

type OperationalStatusMetadata = {
  canonicalStatus: string;
  lifecycleStatus: OrderLifecycleStatus;
  workflowStage: OrderWorkflowStage;
};

const OPERATIONAL_STATUS_METADATA: Record<ClickupOrderOperationalStatus, OperationalStatusMetadata> = {
  complete: { canonicalStatus: 'completed', lifecycleStatus: 'COMPLETE', workflowStage: 'complete' },
  'to do': { canonicalStatus: 'draft', lifecycleStatus: 'ORDER ANALYSING', workflowStage: 'pre_purchase' },
  'inbound-monitoring': {
    canonicalStatus: 'shipped_inbound',
    lifecycleStatus: 'INBOUND MONITORING',
    workflowStage: 'amazon_inbound',
  },
  'hold/cancelled': { canonicalStatus: 'cancelled', lifecycleStatus: 'COMPLETE', workflowStage: 'cancelled' },
  'direct-ship-fba': {
    canonicalStatus: 'shipped_inbound',
    lifecycleStatus: 'DIRECT SHIP FBA',
    workflowStage: 'amazon_inbound',
  },
  'prep-in-progress': { canonicalStatus: 'paid', lifecycleStatus: 'PREP IN-PROGRESS', workflowStage: 'in_prep' },
  ordered: { canonicalStatus: 'paid', lifecycleStatus: 'ORDERED', workflowStage: 'in_prep' },
  'in progress': {
    canonicalStatus: 'supplier_contacted',
    lifecycleStatus: 'IN-PROGRESS',
    workflowStage: 'pre_purchase',
  },
  'approved-to-order': {
    canonicalStatus: 'payment_pending',
    lifecycleStatus: 'APPROVED TO ORDER',
    workflowStage: 'pre_purchase',
  },
  'order analysing': {
    canonicalStatus: 'draft',
    lifecycleStatus: 'ORDER ANALYSING',
    workflowStage: 'pre_purchase',
  },
  'in transit to prep': {
    canonicalStatus: 'paid',
    lifecycleStatus: 'IN TRANSIT TO PREP',
    workflowStage: 'in_prep',
  },
  hold: { canonicalStatus: 'blocked', lifecycleStatus: 'IN-PROGRESS', workflowStage: 'hold' },
};

export const CLICKUP_ORDER_OPERATIONAL_STATUS_OPTIONS = CLICKUP_ORDER_OPERATIONAL_STATUSES.map((status) => ({
  label: status,
  value: status,
}));

export function normalizeOrderOperationalStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

// Raw ClickUp statuses that fold into a canonical operational status. The alias is
// resolution-only: the stored clickupStatus stays source-faithful and the alias is not
// offered as an operator option. User decision (2026-07-24): `at-prep-not started`
// means "at prep, but not started" and belongs to the prep stage.
const CLICKUP_OPERATIONAL_STATUS_ALIASES: Record<string, ClickupOrderOperationalStatus> = {
  'at-prep-not started': 'prep-in-progress',
};

export function clickupOrderOperationalStatus(value: unknown): ClickupOrderOperationalStatus | undefined {
  const normalized = normalizeOrderOperationalStatus(value);
  if (!normalized) return undefined;
  return (
    CLICKUP_ORDER_OPERATIONAL_STATUSES.find((status) => status === normalized) ??
    CLICKUP_OPERATIONAL_STATUS_ALIASES[normalized]
  );
}

export function canonicalOrderStatusForOperationalStatus(value: unknown) {
  const status = clickupOrderOperationalStatus(value);
  return status ? OPERATIONAL_STATUS_METADATA[status].canonicalStatus : undefined;
}

export function lifecycleStatusForOperationalStatus(value: unknown) {
  const status = clickupOrderOperationalStatus(value);
  return status ? OPERATIONAL_STATUS_METADATA[status].lifecycleStatus : undefined;
}

export function workflowStageForOperationalStatus(value: unknown) {
  const status = clickupOrderOperationalStatus(value);
  return status ? OPERATIONAL_STATUS_METADATA[status].workflowStage : undefined;
}

export function isPrePurchaseStage(stage: unknown) {
  return stage === 'pre_purchase' || stage === 'hold';
}

export function isPrepStage(stage: unknown) {
  return stage === 'in_prep';
}

export function isInboundStage(stage: unknown) {
  return stage === 'amazon_inbound';
}

export function isClosedStage(stage: unknown) {
  return stage === 'cancelled' || stage === 'complete';
}

export function providesPurchasedCoverage(stage: unknown) {
  return isPrepStage(stage) || isInboundStage(stage);
}
