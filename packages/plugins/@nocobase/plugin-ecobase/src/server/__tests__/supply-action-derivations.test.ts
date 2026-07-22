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
  type CorrectedOperationalListingSnapshot,
  type MoneyRiskInput,
  type ReorderTimingInput,
} from '../../features/inventory-planning/server/corrected-candidate-builder';

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
    baselineWeightedProfitPerUnit: 5,
    daysUntilOos: 10,
    positionEstimatedOosDate: '2026-08-02',
    leadTimeDays: LEAD_TIME_DAYS,
    fbaReceivingBufferDays: FBA_BUFFER_DAYS,
    ...overrides,
  };
}

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
      trustedReorderDue: false,
    });
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

  it('parity: trustedReorderDue ⇔ daysUntilSafeReorder <= 0 under trusted velocity (integer and fractional cover)', () => {
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
      const result = deriveReorderTiming(timing(testCase));
      expect(result.daysUntilSafeReorder).not.toBeNull();
      expect(result.trustedReorderDue).toBe((result.daysUntilSafeReorder as number) <= 0);
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
    expect(result.moneyRiskInputs).toMatchObject({ uncoveredDays: 27, missingInputs: [] });
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
