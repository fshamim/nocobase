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
  computeOrderMoneyAtRisk,
  deriveOrderAttention,
  deriveOrderPaperworkMilestones,
  deriveOrderPrepMilestones,
  deriveStatusWrite,
  normalizeOrderRef,
  orderArrivalDetected,
  requireValidOrderRef,
  resolveDaysSince,
  sumExpectedCost,
  trailingSequenceLetter,
} from '../order-workbench-compute';

const THRESHOLDS = { activeOrderFollowUpDays: 2, prepIdleDays: 7, inboundOverdueDays: 40 };

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

describe('orderArrivalDetected (T2.4 / T2.5 shared predicate)', () => {
  it('fires on an arrival receipt status at the order or a line', () => {
    expect(orderArrivalDetected({ orderReceiptStatus: 'amazon_stock_observed', lines: [] })).toBe(true);
    expect(
      orderArrivalDetected({
        lines: [{ amazonReceiptStatus: 'completed_by_later_inbound', orderedQty: 10, amazonReceiptObservedQty: 0 }],
      }),
    ).toBe(true);
  });

  it('fires when summed observed reaches summed ordered, and not before', () => {
    expect(
      orderArrivalDetected({
        lines: [
          { orderedQty: 100, amazonReceiptObservedQty: 60 },
          { orderedQty: 50, amazonReceiptObservedQty: 90 },
        ],
      }),
    ).toBe(true); // 150 observed ≥ 150 ordered
    expect(
      orderArrivalDetected({
        lines: [
          { orderedQty: 100, amazonReceiptObservedQty: 60 },
          { orderedQty: 50, amazonReceiptObservedQty: 20 },
        ],
      }),
    ).toBe(false);
  });

  it('never reports a vacuous arrival when nothing was ordered', () => {
    expect(orderArrivalDetected({ lines: [] })).toBe(false);
    expect(orderArrivalDetected({ lines: [{ orderedQty: 0, amazonReceiptObservedQty: 0 }] })).toBe(false);
  });
});

describe('deriveOrderPaperworkMilestones (T2.5)', () => {
  it('marks approval/order/payment/invoice done per the documented rules', () => {
    const chain = deriveOrderPaperworkMilestones({
      orderApproval: 'Approved',
      canonicalStatus: 'paid',
      paymentStatus: 'Completed',
      paymentMode: 'ACH',
      invoiceStatus: 'Uploaded',
    });
    expect(chain.approval.state).toBe('done');
    expect(chain.order.state).toBe('done'); // paid is past payment_pending
    expect(chain.payment.state).toBe('done');
    expect(chain.payment.paymentMode).toBe('ACH');
    expect(chain.invoice.state).toBe('done');
  });

  it('picks the first non-done as current and renders a blocked payment as blocked', () => {
    const chain = deriveOrderPaperworkMilestones({
      orderApproval: 'approved',
      canonicalStatus: 'payment_pending',
      sourceOrderStatus: 'completed',
      paymentStatus: 'on hold',
      invoiceStatus: '',
    });
    expect(chain.approval.state).toBe('done');
    expect(chain.order.state).toBe('done'); // sourceOrderStatus completed
    expect(chain.payment.state).toBe('blocked'); // "on hold" → blocked wins over current
    expect(chain.invoice.state).toBe('pending');
  });

  it('marks the first pending milestone current when nothing later is done', () => {
    const chain = deriveOrderPaperworkMilestones({ orderApproval: '', canonicalStatus: 'draft' });
    expect(chain.approval.state).toBe('current');
    expect(chain.order.state).toBe('pending');
    expect(chain.payment.state).toBe('pending');
  });
});

describe('deriveOrderPrepMilestones (T2.5)', () => {
  it('advances the TRANSIT → AT PREP → PREP → READY ladder by lifecycle status', () => {
    expect(deriveOrderPrepMilestones({ lifecycleStatus: 'IN TRANSIT TO PREP' })).toMatchObject({
      transit: 'current',
      atPrep: 'pending',
      prep: 'pending',
      ready: 'pending',
    });
    expect(deriveOrderPrepMilestones({ lifecycleStatus: 'AT PREP NOT STARTED' })).toMatchObject({
      transit: 'done',
      atPrep: 'current',
    });
    expect(deriveOrderPrepMilestones({ lifecycleStatus: 'PREP IN-PROGRESS' })).toMatchObject({
      transit: 'done',
      atPrep: 'done',
      prep: 'current',
      ready: 'pending',
    });
  });

  it('READY is done only once prepStatus is Completed, and measured needs dims + weight', () => {
    const ready = deriveOrderPrepMilestones({
      lifecycleStatus: 'PREP IN-PROGRESS',
      prepStatus: 'Completed',
      prepDimensions: { length: 21, breadth: 13, height: 7 },
      prepWeightValue: 25,
    });
    expect(ready.prep).toBe('done');
    expect(ready.ready).toBe('done');
    expect(ready.prepMeasured).toBe(true);
    expect(
      deriveOrderPrepMilestones({ lifecycleStatus: 'PREP IN-PROGRESS', prepDimensions: { length: 21, breadth: 13 } })
        .prepMeasured,
    ).toBe(false);
  });
});

describe('computeOrderMoneyAtRisk (T2.5)', () => {
  const now = new Date('2026-07-25T00:00:00.000Z');

  it('sums only products whose OOS date falls before the ETA', () => {
    const result = computeOrderMoneyAtRisk({
      etaDate: '2026-08-15',
      now,
      products: [
        { companyProductId: 'a', estimatedProfitRisk: 100, estimatedOosDate: '2026-08-01' }, // before ETA → at risk
        { companyProductId: 'b', estimatedProfitRisk: 250, estimatedOosDate: '2026-09-01' }, // after ETA → safe
      ],
    });
    expect(result).toMatchObject({ moneyAtRisk: 100, atRiskProductCount: 1, productCount: 2 });
  });

  it('RED-PROOF: a null ETA makes every product pessimistically at risk', () => {
    const result = computeOrderMoneyAtRisk({
      etaDate: null,
      now,
      products: [
        { companyProductId: 'a', estimatedProfitRisk: 100, estimatedOosDate: '2027-01-01' },
        { companyProductId: 'b', estimatedProfitRisk: 250, estimatedOosDate: null },
      ],
    });
    expect(result.atRiskProductCount).toBe(2);
    expect(result.moneyAtRisk).toBe(350);
  });

  it('dedupes products appearing on multiple lines and flags past-safe dates', () => {
    const result = computeOrderMoneyAtRisk({
      etaDate: '2026-08-15',
      now,
      products: [
        { companyProductId: 'a', estimatedProfitRisk: 100, estimatedOosDate: '2026-07-01' }, // already past
        { companyProductId: 'a', estimatedProfitRisk: 100, estimatedOosDate: '2026-07-01' }, // duplicate line
      ],
    });
    expect(result.productCount).toBe(1);
    expect(result.moneyAtRisk).toBe(100);
    expect(result.pastSafeDate).toBe(true);
  });
});

describe('resolveDaysSince (T2.5 age fallbacks)', () => {
  const now = new Date('2026-07-25T00:00:00.000Z');
  it('uses the first parseable timestamp in the fallback chain', () => {
    expect(resolveDaysSince([undefined, null, '2026-07-19'], now)).toBe(6);
    expect(resolveDaysSince(['2026-07-24T00:00:00.000Z'], now)).toBe(1);
  });
  it('returns null when nothing parses and never goes negative', () => {
    expect(resolveDaysSince([undefined, ''], now)).toBeNull();
    expect(resolveDaysSince(['2026-08-01'], now)).toBe(0);
  });
});

describe('deriveOrderAttention (T3 thresholds, boundary red-proof)', () => {
  const now = new Date('2026-07-25T00:00:00.000Z');

  it('BOUNDARY: exactly at the prep-idle threshold is NOT flagged; over is flagged', () => {
    expect(
      deriveOrderAttention({
        pane: 'inPrepMonitoring',
        daysInStatus: 7,
        daysInPane: 7,
        paymentBlocked: false,
        now,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ flagged: false, reason: null });
    expect(
      deriveOrderAttention({
        pane: 'inPrepMonitoring',
        daysInStatus: 8,
        daysInPane: 8,
        paymentBlocked: false,
        now,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ flagged: true, reason: 'prep_idle' });
  });

  it('BOUNDARY: inbound-overdue triggers strictly over the day threshold', () => {
    expect(
      deriveOrderAttention({
        pane: 'inboundMonitoring',
        daysInStatus: null,
        daysInPane: 40,
        paymentBlocked: false,
        now,
        thresholds: THRESHOLDS,
      }).flagged,
    ).toBe(false);
    expect(
      deriveOrderAttention({
        pane: 'inboundMonitoring',
        daysInStatus: null,
        daysInPane: 41,
        paymentBlocked: false,
        now,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ flagged: true, reason: 'inbound_overdue' });
  });

  it('follow_up fires on activeOrders when hours since last activity exceed the threshold', () => {
    expect(
      deriveOrderAttention({
        pane: 'activeOrders',
        daysInStatus: 6,
        daysInPane: 6,
        lastActivityAt: '2026-07-22T00:00:00.000Z', // 3 days ago > 2 days
        paymentBlocked: false,
        now,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ flagged: true, reason: 'follow_up' });
  });

  it('precedence: payment_blocked outranks the time-based reasons (approved prototype behavior)', () => {
    // Active + stale + payment blocked → payment_blocked wins: it is the specific,
    // immediately actionable problem (prototype row SS072226A shows "payment overdue").
    expect(
      deriveOrderAttention({
        pane: 'activeOrders',
        daysInStatus: 6,
        daysInPane: 6,
        lastActivityAt: '2026-07-22T00:00:00.000Z',
        paymentBlocked: true,
        now,
        thresholds: THRESHOLDS,
      }).reason,
    ).toBe('payment_blocked');
    // Fresh active order + payment blocked → payment_blocked is the reason.
    expect(
      deriveOrderAttention({
        pane: 'activeOrders',
        daysInStatus: 0,
        daysInPane: 0,
        lastActivityAt: '2026-07-25T00:00:00.000Z',
        paymentBlocked: true,
        now,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ flagged: true, reason: 'payment_blocked' });
  });
});
