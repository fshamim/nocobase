/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  AMAZON_RECEIPT_STATUSES,
  isAmazonReceiptStatus,
  resolveAmazonReceiptState,
} from '../../features/inventory-planning/server/order-receipt-state';

describe('Amazon receipt-state vocabulary', () => {
  it('accepts only the closed assessed-state set', () => {
    expect(AMAZON_RECEIPT_STATUSES).toEqual([
      'not_applicable',
      'awaiting_amazon_stock',
      'partially_observed',
      'amazon_stock_observed',
      'completed_by_later_inbound',
      'review_required',
    ]);
    for (const status of AMAZON_RECEIPT_STATUSES) expect(isAmazonReceiptStatus(status)).toBe(true);
    expect(isAmazonReceiptStatus(undefined)).toBe(false);
    expect(isAmazonReceiptStatus(null)).toBe(false);
    expect(isAmazonReceiptStatus('inbound-monitoring')).toBe(false);
    expect(isAmazonReceiptStatus('received')).toBe(false);
  });

  it('does not reopen Sellerboard-confirmed receipt from a repeated inbound status', () => {
    expect(
      resolveAmazonReceiptState({
        currentStatus: 'amazon_stock_observed',
        sourceOperationalStatus: 'inbound-monitoring',
      }),
    ).toEqual({
      outcome: 'unchanged',
      from: 'amazon_stock_observed',
      to: 'amazon_stock_observed',
      reason: 'terminal_state_preserved',
    });
  });

  it('allows only an explicit reasoned operator override to reopen a terminal state', () => {
    expect(
      resolveAmazonReceiptState({
        currentStatus: 'amazon_stock_observed',
        sourceOperationalStatus: 'inbound-monitoring',
        operatorOverride: { status: 'awaiting_amazon_stock', reason: 'Amazon receipt was linked to the wrong line.' },
      }),
    ).toEqual({
      outcome: 'changed',
      from: 'amazon_stock_observed',
      to: 'awaiting_amazon_stock',
      reason: 'operator_override',
    });

    expect(
      resolveAmazonReceiptState({
        currentStatus: 'amazon_stock_observed',
        operatorOverride: { status: 'awaiting_amazon_stock', reason: ' ' },
      }),
    ).toEqual({
      outcome: 'rejected',
      from: 'amazon_stock_observed',
      error: 'operator_override_reason_required',
    });
  });

  it('applies Sellerboard, later-cycle, and exact-source precedence deterministically', () => {
    expect(
      resolveAmazonReceiptState({
        sourceOperationalStatus: 'inbound-monitoring',
        laterInboundOrderId: 'later-order',
        sellerboardEvidence: { status: 'amazon_stock_observed', reason: 'positive_attributed_addition' },
      }),
    ).toMatchObject({ outcome: 'changed', to: 'amazon_stock_observed', reason: 'sellerboard_evidence' });

    expect(
      resolveAmazonReceiptState({
        sourceOperationalStatus: 'inbound-monitoring',
        laterInboundOrderId: 'later-order',
      }),
    ).toMatchObject({ outcome: 'changed', to: 'completed_by_later_inbound', reason: 'later_inbound_cycle' });

    expect(resolveAmazonReceiptState({ sourceOperationalStatus: ' INBOUND MONITORING ' })).toMatchObject({
      outcome: 'changed',
      to: 'awaiting_amazon_stock',
      reason: 'source_inbound_monitoring',
    });
    expect(resolveAmazonReceiptState({ sourceOperationalStatus: 'DIRECT-SHIP-FBA' })).toMatchObject({
      outcome: 'changed',
      to: 'awaiting_amazon_stock',
      reason: 'source_direct_ship_fba',
    });
    expect(resolveAmazonReceiptState({ sourceOperationalStatus: 'ordered' })).toMatchObject({
      outcome: 'changed',
      to: 'not_applicable',
      reason: 'source_not_inbound_monitoring',
    });
    expect(resolveAmazonReceiptState({})).toMatchObject({
      outcome: 'changed',
      to: 'review_required',
      reason: 'source_status_missing',
    });
  });

  it('preserves partial or awaiting progress when later source data is less conclusive', () => {
    expect(
      resolveAmazonReceiptState({
        currentStatus: 'partially_observed',
        sourceOperationalStatus: 'inbound-monitoring',
      }),
    ).toEqual({
      outcome: 'unchanged',
      from: 'partially_observed',
      to: 'partially_observed',
      reason: 'progress_state_preserved',
    });
    expect(
      resolveAmazonReceiptState({
        currentStatus: 'awaiting_amazon_stock',
        sourceOperationalStatus: 'complete',
      }),
    ).toEqual({
      outcome: 'unchanged',
      from: 'awaiting_amazon_stock',
      to: 'awaiting_amazon_stock',
      reason: 'progress_state_preserved',
    });
  });
});
