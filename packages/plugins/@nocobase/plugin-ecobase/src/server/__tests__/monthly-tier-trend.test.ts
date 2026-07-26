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
  calculateMonthlyTierTrend,
  type MonthlyTierTrendInput,
} from '../../features/inventory-dashboard/server/engine/monthly-performance';

const thresholds = {
  profitTierAThreshold: '250',
  profitTierBThreshold: '100',
  profitTierCThreshold: '0',
};

function fact(date: string, units: unknown, netProfit: unknown) {
  return { date, units, netProfit };
}

function baselineMonth(monthStart: string, profit: unknown, units: unknown = 1) {
  return {
    monthStart,
    coverageReason: 'eligible_complete_month' as const,
    facts: [fact(monthStart, units, profit)],
  };
}

function input(overrides: Partial<MonthlyTierTrendInput> = {}): MonthlyTierTrendInput {
  return {
    asOfDate: '2026-07-18',
    months: [],
    currentMonth: {
      coverageReason: 'coverage_interval_missing',
      coveredThroughDate: null,
      facts: [],
    },
    thresholds,
    minimumProjectionCoveredDays: 14,
    currentProjectionGateMode: 'informational',
    ...overrides,
  };
}

describe('individual monthly tier and trend domain', () => {
  it.each([
    ['250', 'A'],
    ['249.999999999', 'B'],
    ['100', 'B'],
    ['99.999999999', 'C'],
    ['0.000000001', 'C'],
    ['0', 'D'],
    ['-10', 'D'],
  ] as const)('classifies unrounded monthly-profit score %s as Tier %s without gaps', (profit, tier) => {
    const result = calculateMonthlyTierTrend(input({ months: [baselineMonth('2026-06-01', profit)] }));

    expect(result.baselineTier).toBe(tier);
    expect(result.baselineState).toBe('ranked');
    expect(result.monthlyTierEvidence.at(-1)).toMatchObject({ tier, state: 'ranked' });
  });

  it('keeps trusted zero movement and missing baseline evidence unranked instead of inventing Tier D', () => {
    const noMovement = calculateMonthlyTierTrend(
      input({ months: [{ monthStart: '2026-06-01', coverageReason: 'eligible_complete_month', facts: [] }] }),
    );
    expect(noMovement).toMatchObject({
      baselineTier: null,
      baselineState: 'no_movement',
      baselineReasonCodes: ['baseline_no_movement'],
    });

    const unknown = calculateMonthlyTierTrend(input());
    expect(unknown).toMatchObject({
      baselineTier: null,
      baselineState: 'unclassified',
      baselineReasonCodes: ['baseline_no_eligible_months'],
    });
  });

  it('classifies the exact prior closed month and detects adjacent or non-adjacent ranked decline', () => {
    const adjacent = calculateMonthlyTierTrend(
      input({
        months: [
          baselineMonth('2026-01-01', 150),
          baselineMonth('2026-02-01', 150),
          baselineMonth('2026-03-01', 150),
          baselineMonth('2026-04-01', 150),
          baselineMonth('2026-05-01', 150),
          baselineMonth('2026-06-01', 50),
        ],
      }),
    );
    expect(adjacent).toMatchObject({
      baselineTier: 'B',
      lastClosedMonthTier: 'C',
      closedTierMovement: 'declined',
    });
    expect(adjacent.trendReasonCodes).toContain('closed_tier_declined');

    const nonAdjacent = calculateMonthlyTierTrend(
      input({
        months: [
          baselineMonth('2026-01-01', 300),
          baselineMonth('2026-02-01', 300),
          baselineMonth('2026-03-01', 300),
          baselineMonth('2026-04-01', 300),
          baselineMonth('2026-05-01', 300),
          baselineMonth('2026-06-01', 0),
        ],
      }),
    );
    expect(nonAdjacent).toMatchObject({
      baselineTier: 'A',
      lastClosedMonthTier: 'D',
      closedTierMovement: 'declined',
    });
  });

  it('keeps an unknown exact prior month not comparable and never falls back to May', () => {
    const result = calculateMonthlyTierTrend(
      input({
        months: [
          baselineMonth('2026-05-01', 150),
          { monthStart: '2026-06-01', coverageReason: 'product_scope_unknown', facts: [] },
        ],
      }),
    );

    expect(result).toMatchObject({
      baselineTier: 'B',
      lastClosedMonthTier: null,
      lastClosedMonthState: 'unclassified',
      closedTierMovement: 'not_comparable',
    });
    expect(result.trendReasonCodes).toEqual(
      expect.arrayContaining(['last_closed_period_unknown', 'closed_tier_not_comparable_unknown']),
    );
  });

  it('derives unavailable, early, and trusted current confidence from continuous covered days', () => {
    const baseline = [baselineMonth('2026-06-01', 150)];
    const unavailable = calculateMonthlyTierTrend(
      input({
        months: baseline,
        currentMonth: { coverageReason: 'coverage_discontinuous', coveredThroughDate: null, facts: [] },
      }),
    );
    expect(unavailable).toMatchObject({
      currentProjectionConfidence: 'unavailable',
      currentProjectedTier: null,
      currentProjectedTierScore: null,
    });
    expect(unavailable.trendReasonCodes).toContain('current_projection_unavailable_coverage');

    const early = calculateMonthlyTierTrend(
      input({
        months: baseline,
        currentMonth: {
          coverageReason: 'eligible_complete_month',
          coveredThroughDate: '2026-07-10',
          facts: [fact('2026-07-10', 10, 50)],
        },
      }),
    );
    expect(early).toMatchObject({
      currentCoveredDays: 10,
      currentProjectionConfidence: 'early',
      projectedMonthlyUnits: '31.00000000',
      projectedMonthlyProfit: '155.00000000',
      currentProjectedTierScore: '155.00000000',
      currentProjectedTier: 'B',
    });

    const trusted = calculateMonthlyTierTrend(
      input({
        months: baseline,
        currentMonth: {
          coverageReason: 'eligible_complete_month',
          coveredThroughDate: '2026-07-16',
          facts: [fact('2026-07-16', 16, 80)],
        },
      }),
    );
    expect(trusted).toMatchObject({ currentCoveredDays: 16, currentProjectionConfidence: 'trusted' });
    expect(trusted.trendReasonCodes).toContain('current_projection_trusted');
  });

  it('compares projection with ranked last-closed tier, otherwise with ranked baseline', () => {
    const rankedClosed = calculateMonthlyTierTrend(
      input({
        months: [baselineMonth('2026-05-01', 150), baselineMonth('2026-06-01', 300)],
        currentMonth: {
          coverageReason: 'eligible_complete_month',
          coveredThroughDate: '2026-07-16',
          facts: [fact('2026-07-16', 16, '77.41935483870967741935483870967741935484')],
        },
      }),
    );
    expect(rankedClosed).toMatchObject({
      baselineTier: 'B',
      lastClosedMonthTier: 'A',
      currentProjectedTier: 'B',
      projectedTierMovement: 'declined',
    });

    const unknownClosed = calculateMonthlyTierTrend(
      input({
        months: [
          baselineMonth('2026-05-01', 300),
          { monthStart: '2026-06-01', coverageReason: 'product_scope_unknown', facts: [] },
        ],
        currentMonth: {
          coverageReason: 'eligible_complete_month',
          coveredThroughDate: '2026-07-16',
          facts: [fact('2026-07-16', 16, '25.80645161290322580645161290322580645161')],
        },
      }),
    );
    expect(unknownClosed).toMatchObject({
      baselineTier: 'A',
      lastClosedMonthTier: null,
      currentProjectedTier: 'C',
      projectedTierMovement: 'declined',
      projectedMovementComparisonBasis: 'baseline',
    });
  });

  it('keeps projection informational unless trusted evidence-driven mode explicitly activates its gate', () => {
    const currentMonth = {
      coverageReason: 'eligible_complete_month' as const,
      coveredThroughDate: '2026-07-16',
      facts: [fact('2026-07-16', 16, 80)],
    };
    const informational = calculateMonthlyTierTrend(
      input({ months: [baselineMonth('2026-06-01', 150)], currentMonth }),
    );
    expect(informational).toMatchObject({
      currentProjectionGateMode: 'informational',
      currentProjectionConfidence: 'trusted',
      currentProjectionAffectsEligibility: false,
    });

    const evidenceDriven = calculateMonthlyTierTrend(
      input({
        months: [baselineMonth('2026-06-01', 150)],
        currentMonth,
        currentProjectionGateMode: 'evidence_driven',
      }),
    );
    expect(evidenceDriven).toMatchObject({
      currentProjectionGateMode: 'evidence_driven',
      currentProjectionConfidence: 'trusted',
      currentProjectionAffectsEligibility: true,
    });
  });

  it('keeps covered current zero movement unranked and uses exact unavailable reason codes', () => {
    const zero = calculateMonthlyTierTrend(
      input({
        months: [baselineMonth('2026-06-01', 150)],
        currentMonth: {
          coverageReason: 'eligible_complete_month',
          coveredThroughDate: '2026-07-16',
          facts: [],
        },
      }),
    );
    expect(zero).toMatchObject({
      currentProjectionConfidence: 'trusted',
      currentProjectedState: 'no_movement',
      currentProjectedTier: null,
      projectedMonthlyUnits: '0.00000000',
      projectedMonthlyProfit: '0.00000000',
    });
    expect(zero.trendReasonCodes).toContain('current_projection_no_movement');

    for (const [currentMonth, reasonCode] of [
      [
        { coverageReason: 'product_scope_unknown', coveredThroughDate: null, facts: [] },
        'current_projection_unavailable_scope',
      ],
      [
        { coverageReason: 'units_metric_incomplete', coveredThroughDate: null, facts: [] },
        'current_projection_unavailable_units',
      ],
      [
        { coverageReason: 'net_profit_metric_incomplete', coveredThroughDate: null, facts: [] },
        'current_projection_unavailable_profit',
      ],
      [
        { coverageReason: 'metric_normalization_mismatch', coveredThroughDate: null, facts: [] },
        'current_projection_unavailable_normalization',
      ],
      [
        {
          coverageReason: 'eligible_complete_month',
          coveredThroughDate: '2026-07-16',
          facts: [fact('2026-07-16', -1, 1)],
        },
        'current_projection_unavailable_units',
      ],
      [
        {
          coverageReason: 'eligible_complete_month',
          coveredThroughDate: '2026-07-16',
          facts: [fact('2026-07-16', 1, null)],
        },
        'current_projection_unavailable_profit',
      ],
    ] as const) {
      const result = calculateMonthlyTierTrend(
        input({ currentMonth: { ...currentMonth, facts: [...currentMonth.facts] } }),
      );
      expect(result.trendReasonCodes).toContain(reasonCode);
    }
  });

  it('rejects invalid thresholds, projection settings, and current coverage dates', () => {
    expect(() =>
      calculateMonthlyTierTrend(
        input({ thresholds: { profitTierAThreshold: 100, profitTierBThreshold: 100, profitTierCThreshold: 0 } }),
      ),
    ).toThrow('A > B > C');
    expect(() => calculateMonthlyTierTrend(input({ minimumProjectionCoveredDays: 0 }))).toThrow('from 1 through 31');
    expect(() =>
      calculateMonthlyTierTrend(
        input({
          currentMonth: {
            coverageReason: 'eligible_complete_month',
            coveredThroughDate: '2026-08-01',
            facts: [],
          },
        }),
      ),
    ).toThrow('inside the current month and not later than asOfDate');
  });
});
