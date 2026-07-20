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
  calculateInventoryDisposition,
  type InventoryDispositionInput,
} from '../../features/inventory-planning/server/inventory-disposition';

function unit(date: string, units: unknown) {
  return { date, units };
}

function input(overrides: Partial<InventoryDispositionInput> = {}): InventoryDispositionInput {
  return {
    asOfDate: '2026-07-18',
    coverageReason: 'eligible_complete_month',
    dailyUnits: [],
    sellableOnHandStock: 10,
    inventorySnapshotDate: '2026-07-18',
    reservedStock: 0,
    pipelineStock: 0,
    orderPipelineStatus: 'none',
    ...overrides,
  };
}

describe('trusted listing sell-through and inventory disposition', () => {
  it('treats no rows as trusted zero only with complete product-scope coverage and positive fresh stock', () => {
    const result = calculateInventoryDisposition(input());

    expect(result).toMatchObject({
      rollingVelocityWindowStartDate: '2026-06-19',
      rollingVelocityWindowEndDate: '2026-07-18',
      rollingVelocityEvidenceStatus: 'trusted_zero',
      rollingUnits30: '0.00000000',
      salesVelocity: '0.00000000',
      daysOfCover: null,
      inventoryFreshnessStatus: 'fresh',
      inventoryDisposition: 'no_sell_through',
      inventoryDispositionReasonCode: 'no_sell_through',
    });
  });

  it.each([
    'coverage_interval_missing',
    'coverage_discontinuous',
    'product_scope_unknown',
    'units_metric_incomplete',
    'metric_normalization_mismatch',
  ] as const)('never converts %s into zero movement', (coverageReason) => {
    const result = calculateInventoryDisposition(input({ coverageReason }));

    expect(result).toMatchObject({
      rollingVelocityEvidenceStatus: 'insufficient_evidence',
      rollingUnits30: null,
      salesVelocity: null,
      daysOfCover: null,
      inventoryDisposition: 'insufficient_velocity_evidence',
      inventoryDispositionReasonCode: 'insufficient_velocity_evidence',
    });
  });

  it('classifies positive velocity and days of cover strictly above 60 as excess', () => {
    const excess = calculateInventoryDisposition(
      input({ dailyUnits: [unit('2026-07-18', 30)], sellableOnHandStock: 61 }),
    );
    expect(excess).toMatchObject({
      rollingVelocityEvidenceStatus: 'trusted_positive',
      rollingUnits30: '30.00000000',
      salesVelocity: '1.00000000',
      daysOfCover: '61.00000000',
      inventoryDisposition: 'over_60_days_cover',
    });

    const boundary = calculateInventoryDisposition(
      input({ dailyUnits: [unit('2026-07-18', 30)], sellableOnHandStock: 60 }),
    );
    expect(boundary).toMatchObject({ daysOfCover: '60.00000000', inventoryDisposition: 'none' });
  });

  it('returns none when fresh sellable stock is zero, without confusing reserved/pipeline stock with sell-through', () => {
    const result = calculateInventoryDisposition(
      input({
        sellableOnHandStock: 0,
        coverageReason: 'coverage_discontinuous',
        reservedStock: 100,
        pipelineStock: 50,
        orderPipelineStatus: 'stalled',
      }),
    );

    expect(result).toMatchObject({
      inventoryDisposition: 'none',
      pipelineCondition: 'stalled',
      reservedStock: '100.00000000',
      pipelineStock: '50.00000000',
    });
  });

  it('fails positive-stock disposition closed for stale, missing, future, or invalid inventory evidence', () => {
    const stale = calculateInventoryDisposition(input({ inventorySnapshotDate: '2026-07-16' }));
    expect(stale).toMatchObject({
      inventoryFreshnessStatus: 'stale',
      inventoryDisposition: 'insufficient_velocity_evidence',
    });

    const missing = calculateInventoryDisposition(input({ inventorySnapshotDate: null }));
    expect(missing).toMatchObject({
      inventoryFreshnessStatus: 'missing',
      inventoryDisposition: 'insufficient_velocity_evidence',
    });

    const future = calculateInventoryDisposition(input({ inventorySnapshotDate: '2026-07-19' }));
    expect(future).toMatchObject({
      inventoryFreshnessStatus: 'invalid_future',
      inventoryDisposition: 'insufficient_velocity_evidence',
    });

    const invalidStock = calculateInventoryDisposition(input({ sellableOnHandStock: Number.NaN }));
    expect(invalidStock).toMatchObject({
      inventoryFreshnessStatus: 'invalid',
      inventoryDisposition: 'insufficient_velocity_evidence',
    });
  });

  it('fails negative or non-finite activity closed instead of producing trusted velocity', () => {
    for (const units of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = calculateInventoryDisposition(input({ dailyUnits: [unit('2026-07-18', units)] }));
      expect(result).toMatchObject({
        rollingVelocityEvidenceStatus: 'insufficient_evidence',
        rollingUnits30: null,
        inventoryDisposition: 'insufficient_velocity_evidence',
      });
    }
  });

  it('derives the exact inclusive rolling window dynamically across a year boundary', () => {
    const result = calculateInventoryDisposition(
      input({
        asOfDate: '2027-01-15',
        inventorySnapshotDate: '2027-01-15',
        dailyUnits: [unit('2026-12-17', 1), unit('2027-01-15', 2)],
      }),
    );

    expect(result).toMatchObject({
      rollingVelocityWindowStartDate: '2026-12-17',
      rollingVelocityWindowEndDate: '2027-01-15',
      rollingUnits30: '3.00000000',
      salesVelocity: '0.10000000',
      daysOfCover: '100.00000000',
      inventoryDisposition: 'over_60_days_cover',
    });
  });

  it('keeps an active order visible without allowing it to rewrite product sell-through', () => {
    const result = calculateInventoryDisposition(
      input({ reservedStock: 5, pipelineStock: 20, orderPipelineStatus: 'active' }),
    );

    expect(result).toMatchObject({
      rollingVelocityEvidenceStatus: 'trusted_zero',
      inventoryDisposition: 'no_sell_through',
      pipelineCondition: 'active',
      reservedStock: '5.00000000',
      pipelineStock: '20.00000000',
    });
  });

  it('rejects invalid dates, duplicate dates, and out-of-window facts', () => {
    expect(() => calculateInventoryDisposition(input({ asOfDate: '2026-02-30' }))).toThrow('valid UTC date-only');
    expect(() =>
      calculateInventoryDisposition(input({ dailyUnits: [unit('2026-07-18', 1), unit('2026-07-18', 2)] })),
    ).toThrow('duplicate daily activity date');
    expect(() => calculateInventoryDisposition(input({ dailyUnits: [unit('2026-06-18', 1)] }))).toThrow(
      'outside rolling window',
    );
  });
});
