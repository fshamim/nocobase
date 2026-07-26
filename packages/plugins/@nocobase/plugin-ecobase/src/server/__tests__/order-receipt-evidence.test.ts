/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { calculateAmazonReceiptEvidence } from '../../features/inventory-dashboard/server/engine/order-receipt-evidence';

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
