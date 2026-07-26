/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const AMAZON_RECEIPT_STATUSES = [
  'not_applicable',
  'awaiting_amazon_stock',
  'partially_observed',
  'amazon_stock_observed',
  'completed_by_later_inbound',
  'review_required',
] as const;

export type AmazonReceiptStatus = (typeof AMAZON_RECEIPT_STATUSES)[number];

const AMAZON_RECEIPT_STATUS_SET = new Set<unknown>(AMAZON_RECEIPT_STATUSES);
const AMAZON_RECEIPT_APPLICABLE_SOURCE_STATUSES = new Set(['inbound-monitoring', 'direct-ship-fba']);
const SOURCE_COMPLETE_STATUSES = new Set(['complete', 'completed']);

export function isAmazonReceiptStatus(value: unknown): value is AmazonReceiptStatus {
  return AMAZON_RECEIPT_STATUS_SET.has(value);
}

export interface ResolveAmazonReceiptStateInput {
  currentStatus?: AmazonReceiptStatus | null;
  sourceOperationalStatus?: string | null;
  operatorOverride?: { status: AmazonReceiptStatus; reason: string } | null;
  sellerboardEvidence?: {
    status: 'partially_observed' | 'amazon_stock_observed' | 'review_required';
    reason: string;
  } | null;
  laterInboundOrderId?: string | null;
}

export type AmazonReceiptTransitionReason =
  | 'operator_override'
  | 'terminal_state_preserved'
  | 'sellerboard_evidence'
  | 'later_inbound_cycle'
  | 'source_status_missing'
  | 'source_inbound_monitoring'
  | 'source_direct_ship_fba'
  | 'source_complete_receipt_review_required'
  | 'source_not_inbound_monitoring'
  | 'progress_state_preserved';

export type AmazonReceiptTransition =
  | {
      outcome: 'changed' | 'unchanged';
      from: AmazonReceiptStatus | null;
      to: AmazonReceiptStatus;
      reason: AmazonReceiptTransitionReason;
    }
  | {
      outcome: 'rejected';
      from: AmazonReceiptStatus | null;
      error: 'operator_override_reason_required';
    };

export function resolveAmazonReceiptState(input: ResolveAmazonReceiptStateInput): AmazonReceiptTransition {
  const currentStatus = input.currentStatus ?? null;
  if (input.operatorOverride) {
    if (!input.operatorOverride.reason.trim()) {
      return { outcome: 'rejected', from: currentStatus, error: 'operator_override_reason_required' };
    }
    return {
      outcome: currentStatus === input.operatorOverride.status ? 'unchanged' : 'changed',
      from: currentStatus,
      to: input.operatorOverride.status,
      reason: 'operator_override',
    };
  }

  if (currentStatus === 'amazon_stock_observed' || currentStatus === 'completed_by_later_inbound') {
    return {
      outcome: 'unchanged',
      from: currentStatus,
      to: currentStatus,
      reason: 'terminal_state_preserved',
    };
  }

  const normalizedSourceStatus = input.sourceOperationalStatus?.trim().toLowerCase().replace(/\s+/g, '-');
  let to: AmazonReceiptStatus;
  let reason: AmazonReceiptTransitionReason;
  let sourceOnly = false;
  if (input.sellerboardEvidence) {
    to = input.sellerboardEvidence.status;
    reason = 'sellerboard_evidence';
  } else if (input.laterInboundOrderId?.trim()) {
    to = 'completed_by_later_inbound';
    reason = 'later_inbound_cycle';
  } else if (!input.sourceOperationalStatus?.trim()) {
    to = 'review_required';
    reason = 'source_status_missing';
    sourceOnly = true;
  } else if (normalizedSourceStatus && AMAZON_RECEIPT_APPLICABLE_SOURCE_STATUSES.has(normalizedSourceStatus)) {
    to = 'awaiting_amazon_stock';
    reason = normalizedSourceStatus === 'direct-ship-fba' ? 'source_direct_ship_fba' : 'source_inbound_monitoring';
    sourceOnly = true;
  } else if (normalizedSourceStatus && SOURCE_COMPLETE_STATUSES.has(normalizedSourceStatus)) {
    to = 'review_required';
    reason = 'source_complete_receipt_review_required';
    sourceOnly = true;
  } else {
    to = 'not_applicable';
    reason = 'source_not_inbound_monitoring';
    sourceOnly = true;
  }

  if (
    sourceOnly &&
    (currentStatus === 'partially_observed' ||
      (currentStatus === 'awaiting_amazon_stock' &&
        to !== 'partially_observed' &&
        to !== 'amazon_stock_observed' &&
        to !== 'review_required'))
  ) {
    return {
      outcome: 'unchanged',
      from: currentStatus,
      to: currentStatus,
      reason: 'progress_state_preserved',
    };
  }

  return {
    outcome: currentStatus === to ? 'unchanged' : 'changed',
    from: currentStatus,
    to,
    reason,
  };
}
