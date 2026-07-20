/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  calculateMonthlyPerformance,
  type MonthlyPerformanceMonthInput,
} from '../../features/inventory-planning/server/monthly-performance';

type CoverageReason = MonthlyPerformanceMonthInput['coverageReason'];

function month(
  monthStart: string,
  facts: MonthlyPerformanceMonthInput['facts'] = [],
  coverageReason: CoverageReason = 'eligible_complete_month',
): MonthlyPerformanceMonthInput {
  return { monthStart, coverageReason, facts };
}

function fact(date: string, units: unknown, netProfit: unknown) {
  return { date, units, netProfit };
}

function monthsThrough(count: number): MonthlyPerformanceMonthInput[] {
  return ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']
    .slice(0, count)
    .map((monthStart) => month(monthStart, [fact(monthStart, 1, 10)]));
}

describe('individual monthly profit performance', () => {
  it('derives six complete UTC calendar months dynamically across year and leap boundaries', () => {
    const result = calculateMonthlyPerformance({
      asOfDate: '2028-03-15',
      months: [
        month('2027-08-01', [fact('2027-08-31', 99, 99)]),
        month('2027-09-01', [fact('2027-09-30', 1, 1)]),
        month('2027-10-01', [fact('2027-10-31', 1, 1)]),
        month('2027-11-01', [fact('2027-11-30', 1, 1)]),
        month('2027-12-01', [fact('2027-12-31', 1, 1)]),
        month('2028-01-01', [fact('2028-01-31', 1, 1)]),
        month('2028-02-01', [fact('2028-02-29', 1, 1)]),
      ],
    });

    expect(result).toMatchObject({
      asOfDate: '2028-03-15',
      baselineWindowStartDate: '2027-09-01',
      baselineWindowEndDate: '2028-02-29',
      currentMonthStartDate: '2028-03-01',
      currentMonthEndDate: '2028-03-31',
      baselineEligibleMonthCount: 6,
      baselineConfidence: 'full',
      baselineTotalUnits: '6.00000000',
    });
    expect(result.monthlyPerformanceEvidence.map((item) => item.monthStart)).toEqual([
      '2027-09-01',
      '2027-10-01',
      '2027-11-01',
      '2027-12-01',
      '2028-01-01',
      '2028-02-01',
    ]);
    expect(result.monthlyPerformanceEvidence.at(-1)?.monthEnd).toBe('2028-02-29');
  });

  it.each([
    [0, 'none'],
    [1, 'low'],
    [2, 'low'],
    [3, 'moderate'],
    [5, 'moderate'],
    [6, 'full'],
  ] as const)('maps %i eligible months to %s confidence without replacing gaps', (count, confidence) => {
    const result = calculateMonthlyPerformance({ asOfDate: '2026-07-18', months: monthsThrough(count) });

    expect(result.baselineEligibleMonthCount).toBe(count);
    expect(result.baselineConfidence).toBe(confidence);
    expect(result.monthlyPerformanceEvidence).toHaveLength(6);
  });

  it('counts a covered no-fact month as trusted zero but never converts a missing month to zero', () => {
    const withCoveredZero = calculateMonthlyPerformance({
      asOfDate: '2026-07-18',
      months: [month('2026-01-01'), month('2026-02-01', [fact('2026-02-01', 2, 20)])],
    });
    expect(withCoveredZero).toMatchObject({
      baselineEligibleMonthCount: 2,
      baselineTotalUnits: '2.00000000',
      baselineTotalProfit: '20.00000000',
      averageMonthlyUnits: '1.00000000',
      averageMonthlyProfit: '10.00000000',
      baselineTierScore: '10.00000000',
    });
    expect(withCoveredZero.monthlyPerformanceEvidence[0]).toMatchObject({
      reasonCode: 'eligible_complete_month',
      monthlyUnits: '0.00000000',
      monthlyProfit: '0.00000000',
    });
    expect(withCoveredZero.monthlyPerformanceEvidence[2]).toMatchObject({
      reasonCode: 'coverage_interval_missing',
      monthlyUnits: null,
      monthlyProfit: null,
    });

    const onlyGap = calculateMonthlyPerformance({ asOfDate: '2026-07-18', months: [] });
    expect(onlyGap).toMatchObject({
      baselineEligibleMonthCount: 0,
      baselineState: 'unclassified',
      baselineTotalUnits: null,
      baselineTotalProfit: null,
    });
  });

  it('keeps numeric zero and negative profit, but fails the whole baseline closed for invalid units or missing profit', () => {
    const numericZero = calculateMonthlyPerformance({
      asOfDate: '2026-07-18',
      months: [month('2026-01-01', [fact('2026-01-01', 2, 0), fact('2026-01-02', 1, -3)])],
    });
    expect(numericZero).toMatchObject({
      baselineState: 'ranked',
      baselineTotalUnits: '3.00000000',
      baselineTotalProfit: '-3.00000000',
      baselineTierScore: '-3.00000000',
    });

    for (const [units, profit, reasonCode] of [
      [-1, 1, 'invalid_units'],
      [Number.POSITIVE_INFINITY, 1, 'invalid_units'],
      [1, null, 'missing_net_profit'],
      [1, Number.NaN, 'missing_net_profit'],
    ] as const) {
      const result = calculateMonthlyPerformance({
        asOfDate: '2026-07-18',
        months: [
          month('2026-01-01', [fact('2026-01-01', 1, 10)]),
          month('2026-02-01', [fact('2026-02-01', units, profit)]),
        ],
      });
      expect(result).toMatchObject({
        baselineState: 'unclassified',
        baselineTotalUnits: null,
        baselineTotalProfit: null,
        baselineWeightedProfitPerUnit: null,
        baselineTierScore: null,
      });
      expect(result.monthlyPerformanceEvidence[1].reasonCode).toBe(reasonCode);
    }
  });

  it('returns no_movement without division when all eligible months have trusted zero units', () => {
    const result = calculateMonthlyPerformance({
      asOfDate: '2026-07-18',
      months: [month('2026-01-01'), month('2026-02-01', [fact('2026-02-02', 0, -5)])],
    });

    expect(result).toMatchObject({
      baselineState: 'no_movement',
      baselineReasonCodes: ['baseline_no_movement'],
      baselineTotalUnits: '0.00000000',
      baselineTotalProfit: '-5.00000000',
      baselineWeightedProfitPerUnit: null,
      averageMonthlyUnits: '0.00000000',
      averageMonthlyProfit: '-2.50000000',
      baselineTierScore: '-2.50000000',
    });
  });

  it('uses weighted PPU, average monthly profit identity, half-even decimal8 values, and a deterministic digest', () => {
    const inputs = [
      month('2026-01-01', [fact('2026-01-01', '1', '0.100000005'), fact('2026-01-02', '2', '0.200000010')]),
      month('2026-02-01', [fact('2026-02-01', '3', '0.300000015')]),
    ];
    const result = calculateMonthlyPerformance({ asOfDate: '2026-07-18', months: inputs });

    expect(result).toMatchObject({
      baselineTotalUnits: '6.00000000',
      baselineTotalProfit: '0.60000003',
      baselineWeightedProfitPerUnit: '0.10000000',
      averageMonthlyUnits: '3.00000000',
      averageMonthlyProfit: '0.30000002',
      baselineTierScore: '0.30000002',
    });
    const weightedIdentity = new Decimal(result.exactValues.baselineWeightedProfitPerUnit as string).mul(
      result.exactValues.averageMonthlyUnits as string,
    );
    expect(weightedIdentity.eq(result.exactValues.baselineTierScore as string)).toBe(true);
    expect(result.evidenceDigest).toBe('c791be8f546929d0356c2ea9fec38d935ea8e59de6870d1dd12d33a21c9177d0');
    expect(
      calculateMonthlyPerformance({
        asOfDate: '2026-07-18',
        months: [...inputs].reverse().map((input) => ({ ...input, facts: [...input.facts].reverse() })),
      }).evidenceDigest,
    ).toBe(result.evidenceDigest);
  });

  it('selects independent best/worst values with the most recent month winning exact ties', () => {
    const result = calculateMonthlyPerformance({
      asOfDate: '2026-07-18',
      months: [
        month('2026-01-01', [fact('2026-01-01', 5, 10)]),
        month('2026-02-01', [fact('2026-02-01', 2, 30)]),
        month('2026-03-01', [fact('2026-03-01', 5, 10)]),
        month('2026-04-01', [fact('2026-04-01', 2, 30)]),
      ],
    });

    expect(result).toMatchObject({
      bestMonthlyUnits: '5.00000000',
      bestUnitsMonth: '2026-03-01',
      worstMonthlyUnits: '2.00000000',
      worstUnitsMonth: '2026-04-01',
      bestMonthlyProfit: '30.00000000',
      bestProfitMonth: '2026-04-01',
      worstMonthlyProfit: '10.00000000',
      worstProfitMonth: '2026-03-01',
    });
  });

  it('marks the exact immediately prior month unknown and never falls back to an older eligible month', () => {
    const result = calculateMonthlyPerformance({
      asOfDate: '2026-07-18',
      months: [month('2026-05-01', [fact('2026-05-01', 4, 40)]), month('2026-06-01', [], 'coverage_discontinuous')],
    });

    expect(result).toMatchObject({
      lastClosedMonth: '2026-06-01',
      lastClosedEvidenceStatus: 'unknown',
      lastClosedReasonCode: 'coverage_discontinuous',
      lastClosedMonthUnits: null,
      lastClosedMonthProfit: null,
    });
  });

  it('rejects invalid date-only inputs and facts outside their declared month', () => {
    expect(() => calculateMonthlyPerformance({ asOfDate: '2026-02-30', months: [] })).toThrow('valid UTC date-only');
    expect(() =>
      calculateMonthlyPerformance({
        asOfDate: '2026-07-18',
        months: [month('2026-01-01', [fact('2026-02-01', 1, 1)])],
      }),
    ).toThrow('outside declared month 2026-01-01');
  });
});
