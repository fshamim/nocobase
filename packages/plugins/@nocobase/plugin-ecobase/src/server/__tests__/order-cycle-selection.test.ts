/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { selectCurrentFamilyOrderCycle } from '../../features/inventory-dashboard/server/engine/order-cycle-selection';

const cycle = (orderId: string, authorityAsOf: string, values: Record<string, unknown> = {}) => ({
  lineId: `line-${orderId}`,
  orderId,
  orderRef: orderId.toUpperCase(),
  authorityAsOf,
  orderDate: authorityAsOf.slice(0, 10),
  openQty: 10,
  coverageState: 'purchased_pipeline' as const,
  ...values,
});

describe('selectCurrentFamilyOrderCycle', () => {
  it('selects only the latest valid purchased cycle', () => {
    expect(
      selectCurrentFamilyOrderCycle([
        cycle('old', '2026-05-01T00:00:00.000Z'),
        cycle('new', '2026-06-01T00:00:00.000Z'),
      ]),
    ).toMatchObject({
      selectedOrderId: 'new',
      selectedOrderRef: 'NEW',
      selectedLineIds: ['line-new'],
      selectedOpenQty: 10,
      excludedCycles: [{ orderId: 'old', decision: 'review_required' }],
      reviewRequired: true,
    });
  });

  it('never closes an older cycle from a later ETA or elapsed time alone', () => {
    expect(
      selectCurrentFamilyOrderCycle([
        cycle('old', '2026-05-01T00:00:00.000Z', {
          expectedArrivalDate: '2020-01-01',
          expectedArrivalStatus: 'imported',
        }),
        cycle('new', '2026-06-01T00:00:00.000Z', {
          expectedArrivalDate: '2026-07-20',
          expectedArrivalStatus: 'imported',
        }),
      ]).excludedCycles,
    ).toEqual([
      expect.objectContaining({
        orderId: 'old',
        decision: 'review_required',
        reason: 'later_cycle_exists_without_terminal_receipt_evidence',
      }),
    ]);
  });

  it('excludes terminal receipt cycles from current coverage', () => {
    expect(
      selectCurrentFamilyOrderCycle([
        cycle('old', '2026-06-10T00:00:00.000Z', { amazonReceiptStatus: 'amazon_stock_observed' }),
        cycle('new', '2026-06-01T00:00:00.000Z'),
      ]),
    ).toMatchObject({ selectedOrderId: 'new', selectedOpenQty: 10, reviewRequired: false });
  });

  it('keeps a non-inbound not-applicable cycle in current order coverage', () => {
    expect(
      selectCurrentFamilyOrderCycle([
        cycle('ordered', '2026-06-10T00:00:00.000Z', { amazonReceiptStatus: 'not_applicable' }),
      ]),
    ).toMatchObject({ selectedOrderId: 'ordered', selectedOpenQty: 10, reviewRequired: false });
  });

  it('keeps all lines from the selected current order and sums only their open quantity', () => {
    expect(
      selectCurrentFamilyOrderCycle([
        cycle('old', '2026-05-01T00:00:00.000Z'),
        cycle('new', '2026-06-01T00:00:00.000Z'),
        { ...cycle('new', '2026-06-01T00:00:00.000Z'), lineId: 'line-new-2', openQty: 7 },
      ]),
    ).toMatchObject({ selectedOrderId: 'new', selectedLineIds: ['line-new', 'line-new-2'], selectedOpenQty: 17 });
  });

  it('lets a newer placed-not-purchased recovery cycle replace an older purchased cycle', () => {
    expect(
      selectCurrentFamilyOrderCycle([
        cycle('purchased', '2026-05-01T00:00:00.000Z'),
        cycle('recovery', '2026-06-01T00:00:00.000Z', { coverageState: 'placed_not_purchased' }),
      ]),
    ).toMatchObject({ selectedOrderId: 'recovery', selectedCoverageState: 'placed_not_purchased' });
  });

  it('flags invalid cycle dates for explicit review while keeping a deterministic order-ref tie-break', () => {
    expect(
      selectCurrentFamilyOrderCycle([
        cycle('a', 'invalid', { authorityAsOf: 'invalid', orderDate: 'invalid', orderRef: 'PO-A' }),
        cycle('b', 'invalid', { authorityAsOf: 'invalid', orderDate: 'invalid', orderRef: 'PO-B' }),
      ]),
    ).toMatchObject({
      selectedOrderId: 'b',
      excludedCycles: [{ orderId: 'a', decision: 'review_required', reason: 'ambiguous_cycle_order' }],
      reviewRequired: true,
    });
  });
});
