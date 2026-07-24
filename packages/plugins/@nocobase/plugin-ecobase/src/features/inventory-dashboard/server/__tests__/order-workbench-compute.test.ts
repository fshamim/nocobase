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
  ORDER_LIFECYCLE_STATUSES,
  ORDER_LIFECYCLE_STATUS_METADATA,
} from '../../../order-planning/order-lifecycle-status';
import {
  LIFECYCLE_STATUS_ENGINE_MAP,
  canonicalDateToken,
  computeLineExpectedCost,
  computeLineMargin,
  deriveStatusWrite,
  normalizeOrderRef,
  requireValidOrderRef,
  sumExpectedCost,
  trailingSequenceLetter,
} from '../order-workbench-compute';

// Mirror of the gold engine's supplier-order status buckets (planning-settings-service
// DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS) so a routing-relevant map change fails here.
const PLACED_NOT_PURCHASED = new Set([
  'draft',
  'supplier_contacted',
  'supplier_confirmed',
  'approval_pending',
  'payment_pending',
  'blocked',
]);
const PURCHASED_PIPELINE = new Set(['paid', 'supplier_preparing', 'shipped_inbound']);
const CLOSED = new Set(['completed', 'rejected', 'cancelled']);

describe('order-workbench-compute', () => {
  it('computes gross margin percent from sell price and unit cost', () => {
    expect(computeLineMargin({ expectedSellPrice: 20, unitCost: 15 })).toBe(25);
    expect(computeLineMargin({ expectedSellPrice: 19.95, unitCost: 8.43 })).toBe(57.7);
    expect(computeLineMargin({ expectedSellPrice: 0, unitCost: 5 })).toBeUndefined();
    expect(computeLineMargin({ unitCost: 5 })).toBeUndefined();
    expect(computeLineMargin({ expectedSellPrice: 20 })).toBeUndefined();
  });

  it('computes line and header expected cost', () => {
    expect(computeLineExpectedCost({ orderedQty: 72, unitCost: 8.43 })).toBe(606.96);
    expect(computeLineExpectedCost({ orderedQty: 5 })).toBeUndefined();
    expect(
      sumExpectedCost([
        { orderedQty: 72, unitCost: 8.43 },
        { orderedQty: 36, unitCost: 16.87 },
      ]),
    ).toBe(1214.28);
    expect(sumExpectedCost([{ orderedQty: 5 }])).toBeUndefined();
  });

  it('normalizes and validates order refs', () => {
    expect(normalizeOrderRef('  ef072426a ')).toBe('EF072426A');
    expect(requireValidOrderRef(' ef072426a ')).toBe('EF072426A');
    expect(() => requireValidOrderRef('')).toThrow(/required/);
    expect(() => requireValidOrderRef('X'.repeat(41))).toThrow(/40 characters/);
  });

  it('derives the trailing sequence letter only for canonical refs', () => {
    expect(canonicalDateToken('2026-07-24')).toBe('072426');
    expect(trailingSequenceLetter('EF072426A', 'EF', '2026-07-24')).toBe('A');
    expect(trailingSequenceLetter('EF072426B', 'ef', '2026-07-24')).toBe('B');
    // Operator-edited free-form ref: store the whole ref so the unique index still holds.
    expect(trailingSequenceLetter('CUSTOM-123', 'EF', '2026-07-24')).toBe('CUSTOM-123');
    // Wrong date token → not canonical → whole ref.
    expect(trailingSequenceLetter('EF010125A', 'EF', '2026-07-24')).toBe('EF010125A');
  });

  it('maps every lifecycle status to an engine-recognized canonical status + workflow stage', () => {
    // Completeness: all 11 canonical labels are mapped.
    expect(Object.keys(LIFECYCLE_STATUS_ENGINE_MAP).sort()).toEqual([...ORDER_LIFECYCLE_STATUSES].sort());
    for (const status of ORDER_LIFECYCLE_STATUSES) {
      const { canonicalStatus, workflowStage } = LIFECYCLE_STATUS_ENGINE_MAP[status];
      const known =
        PLACED_NOT_PURCHASED.has(canonicalStatus) ||
        PURCHASED_PIPELINE.has(canonicalStatus) ||
        CLOSED.has(canonicalStatus);
      expect(known, `${status} → ${canonicalStatus} must be a known bucket status`).toBe(true);
      const stage = ORDER_LIFECYCLE_STATUS_METADATA[status].stage;
      if (stage === 'before_ordered') {
        expect(PLACED_NOT_PURCHASED.has(canonicalStatus)).toBe(true);
        expect(workflowStage).toBe('pre_purchase');
      }
      if (stage === 'complete') {
        expect(CLOSED.has(canonicalStatus)).toBe(true);
        expect(workflowStage).toBe('complete');
      }
    }
  });

  it('resolves an operator status pick to the full write set (case/spacing tolerant)', () => {
    expect(deriveStatusWrite('inbound monitoring')).toEqual({
      lifecycleStatus: 'INBOUND MONITORING',
      canonicalStatus: 'shipped_inbound',
      workflowStage: 'amazon_inbound',
    });
    expect(deriveStatusWrite('ORDER ANALYSING').canonicalStatus).toBe('draft');
    expect(() => deriveStatusWrite('not-a-status')).toThrow();
  });
});
