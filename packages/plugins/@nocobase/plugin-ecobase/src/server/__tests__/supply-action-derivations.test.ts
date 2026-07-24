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
  deriveMoneyRisk,
  deriveReorderTiming,
  independentRecommendedOrderQty,
  resolveEffectiveVelocity,
  type CorrectedOperationalListingSnapshot,
  type EffectiveVelocityInput,
  type MoneyRiskInput,
  type ReorderTimingInput,
} from '../../features/inventory-planning/server/corrected-candidate-builder';
import type { MonthlyPerformanceEvidence } from '../../features/inventory-planning/server/monthly-performance';

const CALC_DATE = '2026-07-23';
// Settings snapshot defaults exercised throughout: lead time 30 (default supplier lead time when
// no supplier is assigned), fbaReceivingBufferDays 7, safetyBufferDays 7 → reorder horizon 44.
const LEAD_TIME_DAYS = 30;
const FBA_BUFFER_DAYS = 7;
const SAFETY_BUFFER_DAYS = 7;

function timing(overrides: Partial<ReorderTimingInput> = {}): ReorderTimingInput {
  return {
    calculationDate: CALC_DATE,
    salesVelocity: 2,
    salesVelocityBasis: 'rolling_30',
    salesVelocityConfidence: 'high',
    daysOfCover: 10,
    futurePositionStock: 60,
    leadTimeDays: LEAD_TIME_DAYS,
    fbaReceivingBufferDays: FBA_BUFFER_DAYS,
    safetyBufferDays: SAFETY_BUFFER_DAYS,
    ...overrides,
  };
}

function moneyRisk(overrides: Partial<MoneyRiskInput> = {}): MoneyRiskInput {
  return {
    calculationDate: CALC_DATE,
    applicable: true,
    salesVelocity: 2,
    salesVelocityBasis: 'rolling_30',
    baselineWeightedProfitPerUnit: 5,
    daysUntilOos: 10,
    positionEstimatedOosDate: '2026-08-02',
    leadTimeDays: LEAD_TIME_DAYS,
    fbaReceivingBufferDays: FBA_BUFFER_DAYS,
    ...overrides,
  };
}

function evidenceMonth(params: {
  monthStart: string;
  monthEnd: string;
  monthlyUnits: string | null;
  eligible: boolean;
}): MonthlyPerformanceEvidence {
  return {
    monthStart: params.monthStart,
    monthEnd: params.monthEnd,
    eligible: params.eligible,
    reasonCode: params.eligible ? 'eligible_complete_month' : 'coverage_interval_missing',
    sourceFactCount: params.eligible ? 1 : 0,
    monthlyUnits: params.monthlyUnits,
    monthlyProfit: null,
    monthlyProfitPerUnit: null,
    monthlyTierScore: null,
  };
}

function velocityInput(overrides: Partial<EffectiveVelocityInput> = {}): EffectiveVelocityInput {
  return {
    calculationDate: CALC_DATE,
    rollingSalesVelocity: null,
    rollingVelocityWindowEndDate: CALC_DATE,
    rollingVelocityConfidence: 'high',
    monthlyPerformanceEvidence: [],
    averageMonthlyUnits: null,
    sourceAsOfDate: '2026-07-16',
    ...overrides,
  };
}

describe('resolveEffectiveVelocity (F4 fallback ladder)', () => {
  it('rung 1: trusted rolling velocity always wins and keeps its exact value + window end', () => {
    const result = resolveEffectiveVelocity(
      velocityInput({
        rollingSalesVelocity: '2.00000000',
        rollingVelocityWindowEndDate: '2026-07-23',
        monthlyPerformanceEvidence: [
          evidenceMonth({ monthStart: '2026-06-01', monthEnd: '2026-06-30', monthlyUnits: '300', eligible: true }),
        ],
        averageMonthlyUnits: '900.00000000',
      }),
    );
    expect(result).toEqual({
      salesVelocity: '2.00000000',
      salesVelocityBasis: 'rolling_30',
      salesVelocityAsOfDate: '2026-07-23',
      salesVelocityConfidence: 'high',
      velocity: 2,
    });
  });

  it('rung 1: trusted zero stays zero — real no-sales evidence is never replaced by an estimate', () => {
    const result = resolveEffectiveVelocity(
      velocityInput({
        rollingSalesVelocity: '0.00000000',
        monthlyPerformanceEvidence: [
          evidenceMonth({ monthStart: '2026-06-01', monthEnd: '2026-06-30', monthlyUnits: '300', eligible: true }),
        ],
      }),
    );
    expect(result.salesVelocityBasis).toBe('rolling_30');
    expect(result.velocity).toBe(0);
  });

  it('rung 2: picks the MOST RECENT closed eligible month and divides by that month’s real length', () => {
    const result = resolveEffectiveVelocity(
      velocityInput({
        monthlyPerformanceEvidence: [
          evidenceMonth({ monthStart: '2026-05-01', monthEnd: '2026-05-31', monthlyUnits: '310', eligible: true }),
          evidenceMonth({ monthStart: '2026-06-01', monthEnd: '2026-06-30', monthlyUnits: '60', eligible: true }),
          // Ineligible or unit-less months never win, even when newer.
          evidenceMonth({ monthStart: '2026-07-01', monthEnd: '2026-07-31', monthlyUnits: null, eligible: false }),
        ],
        averageMonthlyUnits: '900.00000000',
      }),
    );
    expect(result).toEqual({
      salesVelocity: '2.00000000', // 60 units / 30 days in June
      salesVelocityBasis: 'last_closed_month',
      salesVelocityAsOfDate: '2026-06-30',
      salesVelocityConfidence: 'medium',
      velocity: 2,
    });
  });

  it('rung 2: uses real month lengths (28 units over February 2026 = 1/day)', () => {
    const result = resolveEffectiveVelocity(
      velocityInput({
        monthlyPerformanceEvidence: [
          evidenceMonth({ monthStart: '2026-02-01', monthEnd: '2026-02-28', monthlyUnits: '28', eligible: true }),
        ],
      }),
    );
    expect(result.salesVelocity).toBe('1.00000000');
    expect(result.salesVelocityAsOfDate).toBe('2026-02-28');
  });

  it('rung 3: falls back to the baseline average over 30 days, as-of source date then calc date', () => {
    const withSource = resolveEffectiveVelocity(velocityInput({ averageMonthlyUnits: '45.00000000' }));
    expect(withSource).toEqual({
      salesVelocity: '1.50000000',
      salesVelocityBasis: 'baseline_average',
      salesVelocityAsOfDate: '2026-07-16',
      salesVelocityConfidence: 'low',
      velocity: 1.5,
    });
    const withoutSource = resolveEffectiveVelocity(
      velocityInput({ averageMonthlyUnits: '45.00000000', sourceAsOfDate: null }),
    );
    expect(withoutSource.salesVelocityAsOfDate).toBe(CALC_DATE);
  });

  it('rung 4: no rung applies → basis none, velocity null', () => {
    expect(resolveEffectiveVelocity(velocityInput())).toEqual({
      salesVelocity: null,
      salesVelocityBasis: 'none',
      salesVelocityAsOfDate: null,
      salesVelocityConfidence: 'none',
      velocity: null,
    });
  });
});

describe('deriveReorderTiming (F1 stockout dates, F2 order-by, V1 horizon)', () => {
  it('derives sellable and position stockout dates plus the order-by date under trusted velocity', () => {
    // sellable runway = daysOfCover 10 → OOS 2026-08-02; position runway = 60/2 = 30 days →
    // position OOS 2026-08-22; order-by = position OOS − 44-day horizon = 2026-07-09.
    expect(deriveReorderTiming(timing())).toEqual({
      estimatedOosDate: '2026-08-02',
      positionDaysOfCover: 30,
      positionEstimatedOosDate: '2026-08-22',
      daysUntilOos: 30,
      latestSafeReorderDate: '2026-07-09',
      daysUntilSafeReorder: -14,
      reorderDueKind: 'trusted',
      trustedReorderDue: true,
    });
  });

  it('returns all-null timing when velocity evidence is missing (null velocity ⇒ null daysOfCover)', () => {
    expect(deriveReorderTiming(timing({ salesVelocity: null, daysOfCover: null }))).toEqual({
      estimatedOosDate: null,
      positionDaysOfCover: null,
      positionEstimatedOosDate: null,
      daysUntilOos: null,
      latestSafeReorderDate: null,
      daysUntilSafeReorder: null,
      reorderDueKind: null,
      trustedReorderDue: false,
    });
  });

  it('computes identical timing math under a fallback basis but marks due-ness as estimated, never trusted', () => {
    const estimated = deriveReorderTiming(timing({ salesVelocityBasis: 'last_closed_month' }));
    expect(estimated).toEqual({
      estimatedOosDate: '2026-08-02',
      positionDaysOfCover: 30,
      positionEstimatedOosDate: '2026-08-22',
      daysUntilOos: 30,
      latestSafeReorderDate: '2026-07-09',
      daysUntilSafeReorder: -14,
      reorderDueKind: 'estimated',
      trustedReorderDue: false,
    });
    const notDue = deriveReorderTiming(timing({ salesVelocityBasis: 'baseline_average', futurePositionStock: 200 }));
    expect(notDue.reorderDueKind).toBeNull();
    expect(notDue.trustedReorderDue).toBe(false);
    expect(notDue.daysUntilSafeReorder).toBe(56);
  });

  it('marks a due reorder under a sparse (non-high-confidence) rolling basis as estimated, not trusted', () => {
    for (const salesVelocityConfidence of ['medium', 'low'] as const) {
      const sparse = deriveReorderTiming(timing({ salesVelocityConfidence }));
      expect(sparse.reorderDueKind).toBe('estimated');
      expect(sparse.trustedReorderDue).toBe(false);
    }
    // Only a HIGH-confidence rolling basis stays trusted.
    expect(deriveReorderTiming(timing({ salesVelocityConfidence: 'high' })).reorderDueKind).toBe('trusted');
  });

  it('emits no position runway for trusted-zero velocity (velocity must be > 0)', () => {
    const result = deriveReorderTiming(timing({ salesVelocity: 0, daysOfCover: null }));
    expect(result.positionEstimatedOosDate).toBeNull();
    expect(result.daysUntilSafeReorder).toBeNull();
    expect(result.trustedReorderDue).toBe(false);
  });

  it('suppresses only the sellable OOS date when inventory is stale (daysOfCover null) but keeps position runway', () => {
    // Stale/zero-sellable rows carry no daysOfCover, yet inbound pipeline still yields a position OOS.
    const result = deriveReorderTiming(timing({ daysOfCover: null, futurePositionStock: 20 }));
    expect(result.estimatedOosDate).toBeNull();
    expect(result.positionEstimatedOosDate).toBe('2026-08-02'); // 20/2 = 10 days
    expect(result.daysUntilOos).toBe(10);
  });

  it('does not flag a well-stocked family as reorder-due', () => {
    const result = deriveReorderTiming(timing({ futurePositionStock: 200 })); // 100 days cover
    expect(result.trustedReorderDue).toBe(false);
    expect(result.daysUntilSafeReorder).toBe(56); // 100 − 44
    expect(result.latestSafeReorderDate).toBe('2026-09-17'); // calcDate + (100 − 44)
  });

  it('V1: the Amazon receiving buffer is inside the horizon (a 40-day cover is due at 44, not at 37)', () => {
    const withBuffer = deriveReorderTiming(timing({ salesVelocity: 1, futurePositionStock: 40 }));
    expect(withBuffer.daysUntilSafeReorder).toBe(-4); // 40 − (30+7+7)
    expect(withBuffer.trustedReorderDue).toBe(true);

    const withoutBuffer = deriveReorderTiming(
      timing({ salesVelocity: 1, futurePositionStock: 40, fbaReceivingBufferDays: 0 }),
    );
    expect(withoutBuffer.daysUntilSafeReorder).toBe(3); // 40 − (30+0+7)
    expect(withoutBuffer.trustedReorderDue).toBe(false);
  });

  it('parity: due-kind ⇔ daysUntilSafeReorder <= 0 for trusted AND estimated bases (integer and fractional cover)', () => {
    const cases: Array<{ salesVelocity: number; futurePositionStock: number }> = [
      { salesVelocity: 1, futurePositionStock: 43 },
      { salesVelocity: 1, futurePositionStock: 44 },
      { salesVelocity: 1, futurePositionStock: 45 },
      { salesVelocity: 3, futurePositionStock: 131 }, // 43.67
      { salesVelocity: 3, futurePositionStock: 132 }, // 44.00
      { salesVelocity: 3, futurePositionStock: 133 }, // 44.33
      { salesVelocity: 7, futurePositionStock: 1 }, // 0.14
    ];
    for (const testCase of cases) {
      const trusted = deriveReorderTiming(timing(testCase));
      const due = (trusted.daysUntilSafeReorder as number) <= 0;
      expect(trusted.daysUntilSafeReorder).not.toBeNull();
      expect(trusted.trustedReorderDue).toBe(due);
      expect(trusted.reorderDueKind).toBe(due ? 'trusted' : null);

      const estimated = deriveReorderTiming(timing({ ...testCase, salesVelocityBasis: 'baseline_average' }));
      expect(estimated.daysUntilSafeReorder).toBe(trusted.daysUntilSafeReorder);
      expect(estimated.reorderDueKind).toBe(due ? 'estimated' : null);
      expect(estimated.trustedReorderDue).toBe(false);
    }
  });
});

describe('deriveMoneyRisk (F3 money at risk)', () => {
  it('returns all-null when the family is not reorder-due/overdue', () => {
    expect(deriveMoneyRisk(moneyRisk({ applicable: false }))).toEqual({
      estimatedProfitRisk: null,
      estimatedProfitRiskBasis: null,
      moneyRiskStatus: null,
      moneyRiskUncoveredDays: null,
      moneyRiskInputs: null,
    });
  });

  it('quantifies an overdue gap (ordering today still leaves a stockout window)', () => {
    // arrival offset = 30 + 7 = 37; position OOS in 10 days → 27 uncovered days × 2/day × €5 = €270.
    const result = deriveMoneyRisk(moneyRisk({ daysUntilOos: 10 }));
    expect(result.moneyRiskStatus).toBe('at_risk');
    expect(result.moneyRiskUncoveredDays).toBe(27);
    expect(result.estimatedProfitRisk).toBe(270);
    expect(result.estimatedProfitRiskBasis).toBe('uncovered_days_x_velocity_x_profit_per_unit');
    expect(result.moneyRiskInputs).toMatchObject({
      uncoveredDays: 27,
      missingInputs: [],
      salesVelocityBasis: 'rolling_30',
    });
  });

  it('computes money for estimated-velocity rows and carries the basis in moneyRiskInputs', () => {
    const result = deriveMoneyRisk(moneyRisk({ salesVelocityBasis: 'last_closed_month' }));
    expect(result.moneyRiskStatus).toBe('at_risk');
    expect(result.estimatedProfitRisk).toBe(270);
    expect(result.moneyRiskInputs).toMatchObject({ salesVelocityBasis: 'last_closed_month' });
  });

  it('reports a covered family (arrival lands before stockout) as zero risk', () => {
    const result = deriveMoneyRisk(moneyRisk({ daysUntilOos: 50, positionEstimatedOosDate: '2026-09-11' }));
    expect(result.moneyRiskStatus).toBe('covered');
    expect(result.moneyRiskUncoveredDays).toBe(0);
    expect(result.estimatedProfitRisk).toBe(0);
  });

  it('is unknown when velocity is missing', () => {
    const result = deriveMoneyRisk(moneyRisk({ salesVelocity: null }));
    expect(result.moneyRiskStatus).toBe('unknown');
    expect(result.estimatedProfitRisk).toBeNull();
    expect(result.moneyRiskInputs).toMatchObject({ missingInputs: ['sales_velocity'] });
  });

  it('is unknown when per-unit profit is missing', () => {
    const result = deriveMoneyRisk(moneyRisk({ baselineWeightedProfitPerUnit: null }));
    expect(result.moneyRiskStatus).toBe('unknown');
    expect(result.estimatedProfitRisk).toBeNull();
    expect(result.moneyRiskInputs).toMatchObject({ missingInputs: ['profit_per_unit'] });
  });

  it('is unknown when the position OOS runway is unavailable', () => {
    const result = deriveMoneyRisk(moneyRisk({ daysUntilOos: null, positionEstimatedOosDate: null }));
    expect(result.moneyRiskStatus).toBe('unknown');
    expect(result.estimatedProfitRisk).toBeNull();
    expect(result.moneyRiskInputs).toMatchObject({ missingInputs: ['position_oos'] });
  });
});

function listingSnapshot(overrides: {
  futurePositionStock: number | null;
  targetCoverDays: number;
}): CorrectedOperationalListingSnapshot {
  return {
    identity: {
      companyProductId: 'cp-1',
      companyProductFamilyId: 'family-1',
      companyId: 'company-1',
      amazonAccountId: 'account-1',
      marketplace: 'US',
      asin: 'ASIN0000001',
      sku: 'sku-1',
      company: 'Acme',
      title: 'Widget',
      brand: null,
      productStatus: 'active',
    },
    planning: {
      planningExcluded: false,
      safetyBufferDays: SAFETY_BUFFER_DAYS,
      reorderCycleDays: 30,
      targetCoverDays: overrides.targetCoverDays,
      orderSoonWindowDays: 14,
      leadTimeFreshnessDays: 60,
      purchasedPipelineGraceDays: 3,
      leadTimeDays: LEAD_TIME_DAYS,
    },
    inventory: {
      inventoryAsOfDate: CALC_DATE,
      currentPlanningStock: 20,
      onHandSellableStock: 20,
      amazonPipelineStock: 0,
      supplierPipelineStock: 0,
      inventoryPositionStock: overrides.futurePositionStock,
      futurePositionStock: overrides.futurePositionStock,
      sellableStock: 20,
      reservedStock: 0,
      pipelineStock: 0,
      inboundStock: 0,
      orderedStock: 0,
      prepStock: 0,
      awdStock: 0,
    },
    order: {
      state: null,
      stale: false,
      workflowStage: null,
      operationalStatus: null,
      orderId: null,
      status: null,
      reference: null,
      openQty: null,
      purchasedOpenQty: null,
      placedNotPurchasedOpenQty: null,
      pipelineHealthStatus: null,
      expectedArrivalDate: null,
      expectedArrivalStatus: null,
      authorityStatus: null,
      authoritySource: null,
      authorityTaskRef: null,
      authorityAsOf: null,
      authorityEvidence: null,
      receiptStatus: null,
      receiptObservedAt: null,
      receiptCompletionReason: null,
      receiptEvidence: null,
    },
    supplier: {
      supplierId: null,
      supplierName: null,
      supplierSource: null,
      supplierRole: null,
      supplierConfidence: null,
      unitCost: null,
      unitCostSource: null,
      supplierAvailability: null,
      leadTimeAvailability: null,
      unitCostAvailability: null,
      leadTimeConfirmedAt: null,
      leadTimeFreshness: null,
    },
    sourceEvidence: null,
  };
}

describe('independentRecommendedOrderQty (T2: per-product targetCoverDays override reaches the qty)', () => {
  // The planning snapshot resolves targetCoverDays as `companyProduct.targetCoverDays ??
  // settings.targetCoverDays` (inventory-planning-service.ts) so whatever lands on
  // listing.planning.targetCoverDays — operator override or the 45-day default — drives the formula.
  it('scales the recommendation by the resolved targetCoverDays (default 45 vs operator override 60)', () => {
    const velocity = '2';
    // ceil(2 × 45 − 10) = 80
    expect(
      independentRecommendedOrderQty(listingSnapshot({ futurePositionStock: 10, targetCoverDays: 45 }), velocity, true),
    ).toBe(80);
    // ceil(2 × 60 − 10) = 110 — proves the override, not a hardcoded 45, is honored
    expect(
      independentRecommendedOrderQty(listingSnapshot({ futurePositionStock: 10, targetCoverDays: 60 }), velocity, true),
    ).toBe(110);
  });

  it('returns null when the row is not actionable, velocity is non-positive, or future position is unknown', () => {
    expect(
      independentRecommendedOrderQty(listingSnapshot({ futurePositionStock: 10, targetCoverDays: 45 }), '2', false),
    ).toBeNull();
    expect(
      independentRecommendedOrderQty(listingSnapshot({ futurePositionStock: 10, targetCoverDays: 45 }), '0', true),
    ).toBeNull();
    expect(
      independentRecommendedOrderQty(listingSnapshot({ futurePositionStock: null, targetCoverDays: 45 }), '2', true),
    ).toBeNull();
  });
});
