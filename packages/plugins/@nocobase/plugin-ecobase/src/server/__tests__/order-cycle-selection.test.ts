/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { selectCurrentFamilyOrderCycle } from '../../features/inventory-planning/server/order-cycle-selection';

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
      selectCurrentFamilyOrderCycle(
        [cycle('old', '2026-05-01T00:00:00.000Z'), cycle('new', '2026-06-01T00:00:00.000Z')],
        '2026-07-14',
      ),
    ).toMatchObject({
      selectedOrderId: 'new',
      selectedLineIds: ['line-new'],
      selectedOpenQty: 10,
      excludedCycles: [{ orderId: 'old', decision: 'review_required' }],
      reviewRequired: true,
    });
  });

  it('closes an older cycle only when the later cycle has trusted arrival evidence', () => {
    expect(
      selectCurrentFamilyOrderCycle(
        [
          cycle('old', '2026-05-01T00:00:00.000Z'),
          cycle('new', '2026-06-01T00:00:00.000Z', {
            expectedArrivalDate: '2026-07-20',
            expectedArrivalStatus: 'imported',
          }),
        ],
        '2026-07-14',
      ).excludedCycles,
    ).toEqual([
      expect.objectContaining({
        orderId: 'old',
        decision: 'completed_by_later_inbound',
        reason: 'later_cycle_has_trusted_arrival_evidence',
      }),
    ]);
  });

  it('excludes terminal receipt cycles from current coverage', () => {
    expect(
      selectCurrentFamilyOrderCycle(
        [
          cycle('old', '2026-06-10T00:00:00.000Z', { amazonReceiptStatus: 'amazon_stock_observed' }),
          cycle('new', '2026-06-01T00:00:00.000Z'),
        ],
        '2026-07-14',
      ),
    ).toMatchObject({ selectedOrderId: 'new', selectedOpenQty: 10, reviewRequired: false });
  });

  it('keeps all lines from the selected current order and sums only their open quantity', () => {
    expect(
      selectCurrentFamilyOrderCycle(
        [
          cycle('old', '2026-05-01T00:00:00.000Z'),
          cycle('new', '2026-06-01T00:00:00.000Z'),
          { ...cycle('new', '2026-06-01T00:00:00.000Z'), lineId: 'line-new-2', openQty: 7 },
        ],
        '2026-07-14',
      ),
    ).toMatchObject({ selectedOrderId: 'new', selectedLineIds: ['line-new', 'line-new-2'], selectedOpenQty: 17 });
  });

  it('lets a newer placed-not-purchased recovery cycle replace an older purchased cycle', () => {
    expect(
      selectCurrentFamilyOrderCycle(
        [
          cycle('purchased', '2026-05-01T00:00:00.000Z'),
          cycle('recovery', '2026-06-01T00:00:00.000Z', { coverageState: 'placed_not_purchased' }),
        ],
        '2026-07-14',
      ),
    ).toMatchObject({ selectedOrderId: 'recovery', selectedCoverageState: 'placed_not_purchased' });
  });

  it('flags invalid cycle dates for explicit review while keeping a deterministic order-ref tie-break', () => {
    expect(
      selectCurrentFamilyOrderCycle(
        [
          cycle('a', 'invalid', { authorityAsOf: 'invalid', orderDate: 'invalid', orderRef: 'PO-A' }),
          cycle('b', 'invalid', { authorityAsOf: 'invalid', orderDate: 'invalid', orderRef: 'PO-B' }),
        ],
        '2026-07-14',
      ),
    ).toMatchObject({
      selectedOrderId: 'b',
      excludedCycles: [{ orderId: 'a', decision: 'review_required', reason: 'ambiguous_cycle_order' }],
      reviewRequired: true,
    });
  });
});
