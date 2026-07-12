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

export function isAmazonReceiptStatus(value: unknown): value is AmazonReceiptStatus {
  return AMAZON_RECEIPT_STATUS_SET.has(value);
}
