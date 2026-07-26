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
  aggregateFamilyInventorySnapshots,
  calculateAmazonReceiptEvidence,
  readInboundEntryBaseline,
} from '../../features/inventory-dashboard/server/engine/order-receipt-evidence';

const identity = {
  companyId: 'company-1',
  amazonAccountId: 'account-1',
  marketplace: 'Amazon.com',
  companyProductFamilyId: 'family-1',
  orderLineId: 'line-1',
};

describe('Sellerboard Amazon receipt evidence', () => {
  it('attributes post-baseline Amazon-visible growth plus trusted sales to the mapped line', () => {
    expect(
      calculateAmazonReceiptEvidence({
        identity,
        inboundObservedAt: '2026-07-10T12:00:00.000Z',
        evaluatedAt: '2026-07-12T12:00:00.000Z',
        sellerboardSourceConnectionIds: new Set(['sellerboard-1']),
        // 054 R2 regression pin: a NULL entry baseline must leave this derivation untouched.
        inboundEntryBaseline: null,
        snapshots: [
          {
            ...identity,
            id: 'baseline',
            sourceConnectionId: 'sellerboard-1',
            snapshotDate: '2026-07-10',
            sellableStock: 8,
            reservedStock: 2,
            inboundStock: 0,
          },
          {
            ...identity,
            id: 'current',
            sourceConnectionId: 'sellerboard-1',
            snapshotDate: '2026-07-12',
            sellableStock: 13,
            reservedStock: 2,
            inboundStock: 0,
          },
        ],
        salesFacts: [{ ...identity, snapshotDate: '2026-07-11', unitsSold: 3, trusted: true }],
      }),
    ).toEqual({
      outcome: 'observed',
      status: 'amazon_stock_observed',
      reason: 'positive_attributed_addition',
      confidence: 'high',
      baselineSnapshotId: 'baseline',
      baselineSnapshotDate: '2026-07-10',
      currentSnapshotId: 'current',
      currentSnapshotDate: '2026-07-12',
      baselineAmazonVisibleStock: 10,
      currentAmazonVisibleStock: 15,
      netAmazonIncrease: 5,
      trustedSalesSinceBaseline: 3,
      observedAddition: 8,
      awdIncluded: false,
    });
  });

  it('does not treat existing stock or bucket transfers as receipt evidence', () => {
    const result = calculateAmazonReceiptEvidence({
      identity,
      inboundObservedAt: '2026-07-10T12:00:00.000Z',
      evaluatedAt: '2026-07-12T12:00:00.000Z',
      sellerboardSourceConnectionIds: new Set(['sellerboard-1']),
      snapshots: [
        {
          ...identity,
          id: 'baseline',
          sourceConnectionId: 'sellerboard-1',
          snapshotDate: '2026-07-10',
          sellableStock: 10,
          reservedStock: 0,
          inboundStock: 0,
        },
        {
          ...identity,
          id: 'current',
          sourceConnectionId: 'sellerboard-1',
          snapshotDate: '2026-07-12',
          sellableStock: 5,
          reservedStock: 5,
          inboundStock: 0,
        },
      ],
      salesFacts: [
        { ...identity, snapshotDate: '2026-07-11', unitsSold: 0, trusted: true },
        { ...identity, companyId: 'other-company', snapshotDate: '2026-07-11', unitsSold: 100, trusted: true },
      ],
    });

    expect(result).toMatchObject({
      outcome: 'not_observed',
      status: 'awaiting_amazon_stock',
      reason: 'no_post_baseline_addition',
      netAmazonIncrease: 0,
      observedAddition: 0,
      confidence: 'high',
    });
  });

  it('uses only matching preferred snapshots inside the evidence window', () => {
    const result = calculateAmazonReceiptEvidence({
      identity,
      inboundObservedAt: '2026-07-10T12:00:00.000Z',
      evaluatedAt: '2026-07-12T12:00:00.000Z',
      sellerboardSourceConnectionIds: new Set(['sellerboard-1']),
      snapshots: [
        {
          ...identity,
          id: 'preferred-baseline',
          sourceConnectionId: 'sellerboard-1',
          snapshotDate: '2026-07-09',
          sellableStock: 10,
        },
        {
          ...identity,
          id: 'generic-baseline',
          sourceConnectionId: 'generic-1',
          snapshotDate: '2026-07-10',
          sellableStock: 0,
        },
        {
          ...identity,
          id: 'preferred-current',
          sourceConnectionId: 'sellerboard-1',
          snapshotDate: '2026-07-11',
          sellableStock: 10,
        },
        {
          ...identity,
          id: 'generic-current',
          sourceConnectionId: 'generic-1',
          snapshotDate: '2026-07-12',
          sellableStock: 100,
        },
        {
          ...identity,
          id: 'future',
          sourceConnectionId: 'sellerboard-1',
          snapshotDate: '2026-07-13',
          sellableStock: 100,
        },
        {
          ...identity,
          companyId: 'other-company',
          id: 'cross-company',
          snapshotDate: '2026-07-12',
          sellableStock: 100,
        },
      ],
      salesFacts: [{ ...identity, snapshotDate: '2026-07-11', unitsSold: 0, trusted: true }],
    });

    expect(result).toMatchObject({
      outcome: 'not_observed',
      baselineSnapshotId: 'preferred-baseline',
      currentSnapshotId: 'preferred-current',
      observedAddition: 0,
    });
  });

  it('requires a mapped baseline and only counts AWD for an explicit AWD route', () => {
    expect(
      calculateAmazonReceiptEvidence({
        identity,
        inboundObservedAt: '2026-07-10T12:00:00.000Z',
        evaluatedAt: '2026-07-12T12:00:00.000Z',
        sellerboardSourceConnectionIds: new Set(),
        snapshots: [{ ...identity, companyProductFamilyId: 'other-family', id: 'wrong', snapshotDate: '2026-07-10' }],
      }),
    ).toEqual({
      outcome: 'review_required',
      status: 'review_required',
      reason: 'missing_baseline',
      confidence: 'none',
      awdIncluded: false,
    });

    const snapshots = [
      { ...identity, id: 'baseline', snapshotDate: '2026-07-10', sellableStock: 0, awdStock: 0 },
      { ...identity, id: 'current', snapshotDate: '2026-07-12', sellableStock: 0, awdStock: 5 },
    ];
    expect(
      calculateAmazonReceiptEvidence({
        identity,
        inboundObservedAt: '2026-07-10T12:00:00.000Z',
        evaluatedAt: '2026-07-12T12:00:00.000Z',
        sellerboardSourceConnectionIds: new Set(),
        fulfillmentRoute: 'fba',
        snapshots,
      }),
    ).toMatchObject({ outcome: 'not_observed', observedAddition: 0, awdIncluded: false });
    expect(
      calculateAmazonReceiptEvidence({
        identity,
        inboundObservedAt: '2026-07-10T12:00:00.000Z',
        evaluatedAt: '2026-07-12T12:00:00.000Z',
        sellerboardSourceConnectionIds: new Set(),
        fulfillmentRoute: 'awd',
        snapshots,
      }),
    ).toMatchObject({ outcome: 'observed', observedAddition: 5, awdIncluded: true });
  });

  // ---- 054 R2: the stamped inbound-entry baseline -------------------------

  it('measures the shift against the stamped entry baseline instead of re-deriving one', () => {
    const snapshots = [
      // What the pre-R2 derivation would have picked: a snapshot taken AFTER the units
      // already landed, which hides the arrival by treating it as the starting state.
      {
        ...identity,
        id: 'drifted-baseline',
        sourceConnectionId: 'sellerboard-1',
        snapshotDate: '2026-07-14',
        sellableStock: 40,
        reservedStock: 0,
        inboundStock: 0,
      },
      {
        ...identity,
        id: 'current',
        sourceConnectionId: 'sellerboard-1',
        snapshotDate: '2026-07-16',
        sellableStock: 40,
        reservedStock: 0,
        inboundStock: 0,
      },
    ];
    const input = {
      identity,
      // authorityAsOf drifted forward to the 14th, which is exactly the R2 bug.
      inboundObservedAt: '2026-07-14T12:00:00.000Z',
      evaluatedAt: '2026-07-16T12:00:00.000Z',
      sellerboardSourceConnectionIds: new Set(['sellerboard-1']),
      snapshots,
    };

    expect(calculateAmazonReceiptEvidence(input)).toMatchObject({
      outcome: 'not_observed',
      baselineSnapshotId: 'drifted-baseline',
      netAmazonIncrease: 0,
      observedAddition: 0,
    });

    expect(
      calculateAmazonReceiptEvidence({
        ...input,
        inboundEntryBaseline: {
          snapshotId: 'entry-snapshot',
          asOf: '2026-07-10',
          ordered: 30,
          inbound: 0,
          stock: 6,
          reserved: 2,
          prepStock: 0,
          awdStock: 0,
        },
      }),
    ).toMatchObject({
      outcome: 'observed',
      status: 'amazon_stock_observed',
      reason: 'positive_attributed_addition',
      baselineSnapshotId: 'entry-snapshot',
      baselineSnapshotDate: '2026-07-10',
      // stock 6 + reserved 2 — dropping `reserved` here would inflate the increase to 34.
      baselineAmazonVisibleStock: 8,
      // The 14th is now INSIDE the window, so the newest snapshot in range is the current one.
      currentSnapshotId: 'current',
      currentAmazonVisibleStock: 40,
      netAmazonIncrease: 32,
      observedAddition: 32,
    });
  });

  it('ignores an entry baseline with no usable asOf and falls back to the derivation', () => {
    const input = {
      identity,
      inboundObservedAt: '2026-07-10T12:00:00.000Z',
      evaluatedAt: '2026-07-12T12:00:00.000Z',
      sellerboardSourceConnectionIds: new Set<string>(),
      snapshots: [
        { ...identity, id: 'baseline', snapshotDate: '2026-07-10', sellableStock: 10 },
        { ...identity, id: 'current', snapshotDate: '2026-07-12', sellableStock: 14 },
      ],
    };
    const derived = calculateAmazonReceiptEvidence(input);
    expect(
      calculateAmazonReceiptEvidence({
        ...input,
        inboundEntryBaseline: {
          snapshotId: null,
          asOf: null,
          ordered: null,
          inbound: null,
          stock: null,
          reserved: null,
          prepStock: null,
          awdStock: null,
        },
      }),
    ).toEqual(derived);
    expect(derived).toMatchObject({ baselineSnapshotId: 'baseline', observedAddition: 4 });
  });

  it('reads a stored baseline only when it carries an asOf', () => {
    expect(
      readInboundEntryBaseline({
        snapshotId: 'snap-1',
        asOf: '2026-07-10',
        ordered: 30,
        inbound: 0,
        stock: 6,
        reserved: 2,
        prepStock: 1,
        awdStock: null,
      }),
    ).toEqual({
      snapshotId: 'snap-1',
      asOf: '2026-07-10',
      ordered: 30,
      inbound: 0,
      stock: 6,
      reserved: 2,
      prepStock: 1,
      awdStock: null,
    });
    expect(readInboundEntryBaseline(null)).toBeUndefined();
    expect(readInboundEntryBaseline({})).toBeUndefined();
    expect(readInboundEntryBaseline({ asOf: '   ' })).toBeUndefined();
  });

  it('aggregates a family day only when every member is covered, and sums every bucket', () => {
    const rows = [
      {
        id: 'snap-a1',
        companyProductId: 'member-a',
        sourceConnectionId: 'sellerboard-1',
        snapshotDate: '2026-07-10',
        sellableStock: 8,
        reserved: 2,
        inbound: 1,
        ordered: 5,
        prepStock: 3,
        awdStock: 0,
      },
      {
        id: 'snap-b1',
        companyProductId: 'member-b',
        sourceConnectionId: 'sellerboard-1',
        snapshotDate: '2026-07-10',
        sellableStock: 4,
        reserved: 0,
        inbound: 0,
        ordered: 2,
        prepStock: 1,
        awdStock: 7,
      },
      // A day where only one member reported: a family total from it would read as a drop.
      {
        id: 'snap-a2',
        companyProductId: 'member-a',
        sourceConnectionId: 'sellerboard-1',
        snapshotDate: '2026-07-11',
        sellableStock: 9,
      },
    ];
    const { snapshots, snapshotIdsByAggregateId } = aggregateFamilyInventorySnapshots({
      memberIds: ['member-a', 'member-b'],
      rows,
      identity: {
        companyId: identity.companyId,
        amazonAccountId: identity.amazonAccountId,
        marketplace: identity.marketplace,
        companyProductFamilyId: identity.companyProductFamilyId,
      },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      snapshotDate: '2026-07-10',
      sourceConnectionId: 'sellerboard-1',
      sellableStock: 12,
      reservedStock: 2,
      inboundStock: 1,
      orderedStock: 7,
      prepStock: 4,
      awdStock: 7,
    });
    expect(snapshots[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotIdsByAggregateId.get(snapshots[0].id)).toEqual(['snap-a1', 'snap-b1']);
  });

  it('detects receipt hidden by simultaneous trusted sales', () => {
    expect(
      calculateAmazonReceiptEvidence({
        identity,
        inboundObservedAt: '2026-07-10T12:00:00.000Z',
        evaluatedAt: '2026-07-12T12:00:00.000Z',
        sellerboardSourceConnectionIds: new Set(),
        snapshots: [
          { ...identity, id: 'baseline', snapshotDate: '2026-07-10', sellableStock: 10 },
          { ...identity, id: 'current', snapshotDate: '2026-07-12', sellableStock: 8 },
        ],
        salesFacts: [{ ...identity, snapshotDate: '2026-07-11', unitsSold: 3, trusted: true }],
      }),
    ).toMatchObject({
      outcome: 'observed',
      netAmazonIncrease: -2,
      trustedSalesSinceBaseline: 3,
      observedAddition: 1,
      confidence: 'high',
    });
  });
});
