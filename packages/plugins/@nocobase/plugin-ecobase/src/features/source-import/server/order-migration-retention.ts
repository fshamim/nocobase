/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { canonicalOrderLifecycleStatus, isCompleteLifecycleStatus } from '../../order-planning/order-lifecycle-status';
import { FOUR_COMPANY_MIGRATION_PROFILE, type FourCompanyKey } from './four-company-migration-profile';
import type { MigrationDecision } from './source-scope-policy';

export interface OrderMigrationRetentionInput {
  companyKey: FourCompanyKey;
  status?: string;
  orderDate?: string | Date;
  asOfDate: string | Date;
  expectedDeliveryDate?: string | Date;
  orphan?: boolean;
  coherentEvidence?: boolean;
  hasCurrentClickupEvidence?: boolean;
  approvedOperationalException?: boolean;
}

const CANCELLED_OR_REJECTED_STATUSES = new Set([
  'CANCELLED',
  'CANCELED',
  'REJECTED',
  'HOLD CANCELLED',
  'HOLD CANCELED',
  'NOT ADDED TO PO',
]);
const COMPLETED_SOURCE_STATUSES = new Set(['COMPLETED', 'RECEIVED']);
const NON_TERMINAL_SOURCE_STATUSES = new Set([
  'DRAFT',
  'PLANNED',
  'PO PLACED',
  'CONFIRMED',
  'PREPARING',
  'SHIPPED',
  'SUPPLIER CONTACTED',
  'SUPPLIER CONFIRMED',
  'APPROVAL PENDING',
  'PAYMENT PENDING',
  'PAID',
  'SUPPLIER PREPARING',
  'SHIPPED INBOUND',
  'REACHED FBA',
  'BLOCKED',
]);

function statusKey(value: string | undefined) {
  return value
    ?.normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function dateValue(value: string | Date | undefined) {
  if (!value) return undefined;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function startOfUtcDay(value: Date) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function ageInDays(orderDate: Date, asOfDate: Date) {
  return Math.max(0, Math.floor((startOfUtcDay(asOfDate) - startOfUtcDay(orderDate)) / 86_400_000));
}

function orderStatusClass(status: string | undefined) {
  const normalized = statusKey(status);
  if (normalized && CANCELLED_OR_REJECTED_STATUSES.has(normalized)) return 'cancelled_or_rejected' as const;
  const canonical = canonicalOrderLifecycleStatus(status);
  if (canonical) return isCompleteLifecycleStatus(canonical) ? ('complete' as const) : ('non_terminal' as const);
  if (normalized && COMPLETED_SOURCE_STATUSES.has(normalized)) return 'complete' as const;
  if (normalized && NON_TERMINAL_SOURCE_STATUSES.has(normalized)) return 'non_terminal' as const;
  return 'unknown' as const;
}

function review(companyKey: FourCompanyKey, reasonCode: string): MigrationDecision {
  return { disposition: 'review', companyKey, reasonCode };
}

function accept(companyKey: FourCompanyKey, reasonCode: string): MigrationDecision {
  return { disposition: 'accept', companyKey, reasonCode };
}

export function decideOrderMigrationRetention(input: OrderMigrationRetentionInput): MigrationDecision {
  const asOfDate = dateValue(input.asOfDate);
  if (!asOfDate) throw new Error('Ecobase order migration retention failed: asOfDate must be a valid date.');

  const statusClass = orderStatusClass(input.status);
  if (statusClass === 'cancelled_or_rejected') {
    return { disposition: 'discard', reasonCode: 'cancelled_or_rejected_order' };
  }

  const orderDate = dateValue(input.orderDate);
  const expectedDeliveryDate = dateValue(input.expectedDeliveryDate);
  const hasFutureDelivery = Boolean(
    expectedDeliveryDate && startOfUtcDay(expectedDeliveryDate) > startOfUtcDay(asOfDate),
  );
  const hasOperationalException = Boolean(
    input.hasCurrentClickupEvidence || hasFutureDelivery || input.approvedOperationalException,
  );

  if (input.orphan) {
    if (!input.coherentEvidence) return { disposition: 'discard', reasonCode: 'orphan_evidence_incoherent' };
    if (!hasOperationalException) return { disposition: 'discard', reasonCode: 'orphan_without_operational_evidence' };
    return review(input.companyKey, 'current_orphan_requires_review');
  }

  if (statusClass === 'non_terminal') {
    return orderDate
      ? accept(input.companyKey, 'non_terminal_order')
      : review(input.companyKey, 'non_terminal_order_date_missing');
  }

  if (statusClass === 'complete') {
    if (!orderDate) return { disposition: 'discard', reasonCode: 'complete_order_date_missing' };
    return ageInDays(orderDate, asOfDate) <= FOUR_COMPANY_MIGRATION_PROFILE.completedOrderLookbackDays
      ? accept(input.companyKey, 'recent_complete_order')
      : { disposition: 'discard', reasonCode: 'stale_complete_order' };
  }

  if (hasOperationalException) return review(input.companyKey, 'unknown_order_with_operational_evidence');
  if (!orderDate) return { disposition: 'discard', reasonCode: 'unknown_order_date_missing' };
  return ageInDays(orderDate, asOfDate) <= FOUR_COMPANY_MIGRATION_PROFILE.unknownOrderLookbackDays
    ? review(input.companyKey, 'recent_unknown_order')
    : { disposition: 'discard', reasonCode: 'stale_unknown_order' };
}
