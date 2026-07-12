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
});
