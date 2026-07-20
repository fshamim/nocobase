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
  calculateMonthlyPaceStatus,
  type MonthlyPaceStatusInput,
} from '../../features/inventory-planning/server/monthly-performance';

function fact(date: string, units: unknown, netProfit: unknown) {
  return { date, units, netProfit };
}

function month(monthStart: string, units: unknown, profit: unknown) {
  return {
    monthStart,
    coverageReason: 'eligible_complete_month' as const,
    facts: [fact(monthStart, units, profit)],
  };
}

function paceInput(
  params: {
    currentUnits?: unknown;
    currentProfit?: unknown;
    coveredThroughDate?: string;
    minimumProjectionCoveredDays?: number;
    paceTolerancePercent?: unknown;
    months?: MonthlyPaceStatusInput['months'];
  } = {},
): MonthlyPaceStatusInput {
  const coveredThroughDate = params.coveredThroughDate ?? '2026-03-10';
  return {
    asOfDate: '2026-03-18',
    months: params.months ?? [month('2026-01-01', 10, 100), month('2026-02-01', 20, 300)],
    currentMonth: {
      coverageReason: 'eligible_complete_month',
      coveredThroughDate,
      facts: [fact(coveredThroughDate, params.currentUnits ?? 5, params.currentProfit ?? '64.516129032258064516')],
    },
    thresholds: {
      profitTierAThreshold: 250,
      profitTierBThreshold: 100,
      profitTierCThreshold: 0,
    },
    minimumProjectionCoveredDays: params.minimumProjectionCoveredDays ?? 10,
    currentProjectionGateMode: 'informational',
    paceTolerancePercent: params.paceTolerancePercent ?? 0,
  };
}

describe('monthly average/best/worst pace status', () => {
  it('prorates independent exact quantity and profit targets by dynamic covered/month days', () => {
    const result = calculateMonthlyPaceStatus(paceInput());

    expect(result).toMatchObject({
      currentCoveredDays: 10,
      expectedAverageUnitsMtd: '4.83870968',
      expectedBestUnitsMtd: '6.45161290',
      expectedWorstUnitsMtd: '3.22580645',
      expectedAverageProfitMtd: '64.51612903',
      expectedBestProfitMtd: '96.77419355',
      expectedWorstProfitMtd: '32.25806452',
    });
  });

  it.each([
    ['3', 'below_worst'],
    ['4', 'below_average'],
    ['5', 'on_average'],
    ['6.451612903225806451612903225806451613', 'on_best'],
    ['7', 'above_best'],
  ] as const)('classifies quantity %s as %s against exact targets', (currentUnits, expectedStatus) => {
    const result = calculateMonthlyPaceStatus(paceInput({ currentUnits }));

    expect(result.quantityPaceStatus).toBe(expectedStatus);
    expect(result.profitPaceStatus).toBe('on_average');
  });

  it('uses the sign-safe absolute tolerance lower bound for negative profit targets', () => {
    const withinHistoricalRange = calculateMonthlyPaceStatus(
      paceInput({
        currentProfit: '-100',
        paceTolerancePercent: 10,
        months: [month('2026-01-01', 10, -300), month('2026-02-01', 20, -100)],
      }),
    );
    expect(withinHistoricalRange).toMatchObject({
      expectedWorstProfitMtd: '-96.77419355',
      expectedAverageProfitMtd: '-64.51612903',
      expectedBestProfitMtd: '-32.25806452',
      profitPaceStatus: 'below_average',
    });
    expect(withinHistoricalRange.paceEvidence.profit.worst.lowerBound).toBe('-106.45161290');

    const belowWorst = calculateMonthlyPaceStatus(
      paceInput({
        currentProfit: '-110',
        paceTolerancePercent: 10,
        months: [month('2026-01-01', 10, -300), month('2026-02-01', 20, -100)],
      }),
    );
    expect(belowWorst.profitPaceStatus).toBe('below_worst');
  });

  it('selects the more adverse dimension and assigns quantity, profit, both, or none cause exactly', () => {
    expect(calculateMonthlyPaceStatus(paceInput({ currentUnits: 3 })).aggregatePaceStatus).toBe('below_worst');
    expect(calculateMonthlyPaceStatus(paceInput({ currentUnits: 3 })).paceCause).toBe('quantity');

    const profitWorse = calculateMonthlyPaceStatus(paceInput({ currentUnits: 5, currentProfit: 20 }));
    expect(profitWorse).toMatchObject({
      quantityPaceStatus: 'on_average',
      profitPaceStatus: 'below_worst',
      aggregatePaceStatus: 'below_worst',
      paceCause: 'profit',
    });

    const both = calculateMonthlyPaceStatus(paceInput({ currentUnits: 4, currentProfit: 40 }));
    expect(both).toMatchObject({
      quantityPaceStatus: 'below_average',
      profitPaceStatus: 'below_average',
      aggregatePaceStatus: 'below_average',
      paceCause: 'both',
    });

    const unavailable = calculateMonthlyPaceStatus(
      paceInput({ coveredThroughDate: '2026-03-09', minimumProjectionCoveredDays: 10 }),
    );
    expect(unavailable).toMatchObject({
      quantityPaceStatus: 'insufficient_evidence',
      profitPaceStatus: 'insufficient_evidence',
      aggregatePaceStatus: 'insufficient_evidence',
      paceCause: 'none',
    });
  });

  it('uses the minimum 0.00000001 tolerance without changing exact tier or target evidence', () => {
    const withinEpsilon = calculateMonthlyPaceStatus(
      paceInput({ currentUnits: '6.451612908225806451612903225806451613' }),
    );
    expect(withinEpsilon.quantityPaceStatus).toBe('on_best');

    const beyondEpsilon = calculateMonthlyPaceStatus(
      paceInput({ currentUnits: '6.451612923225806451612903225806451613' }),
    );
    expect(beyondEpsilon.quantityPaceStatus).toBe('above_best');
  });

  it('recomputes corrected best/worst month identity and targets without retaining stale evidence', () => {
    const original = calculateMonthlyPaceStatus(paceInput());
    const corrected = calculateMonthlyPaceStatus(
      paceInput({ months: [month('2026-01-01', 30, 50), month('2026-02-01', 20, 300)] }),
    );

    expect(original).toMatchObject({ bestUnitsMonth: '2026-02-01', worstUnitsMonth: '2026-01-01' });
    expect(corrected).toMatchObject({
      bestUnitsMonth: '2026-01-01',
      worstUnitsMonth: '2026-02-01',
      expectedBestUnitsMtd: '9.67741935',
      expectedWorstUnitsMtd: '6.45161290',
    });
    expect(corrected.evidenceDigest).not.toBe(original.evidenceDigest);
  });

  it('rejects a non-finite or out-of-range pace tolerance', () => {
    expect(() => calculateMonthlyPaceStatus(paceInput({ paceTolerancePercent: -1 }))).toThrow('from 0 through 100');
    expect(() => calculateMonthlyPaceStatus(paceInput({ paceTolerancePercent: Number.NaN }))).toThrow(
      'from 0 through 100',
    );
    expect(() => calculateMonthlyPaceStatus(paceInput({ paceTolerancePercent: 101 }))).toThrow('from 0 through 100');
  });
});
