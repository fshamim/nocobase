/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type ProfitTier = 'A' | 'B' | 'C';
export type ProfitTierMovement = 'new' | 'up' | 'down' | 'same' | 'lost_tier';

export interface ProfitTierThresholds {
  profitTierAThreshold: number;
  profitTierBThreshold: number;
  profitTierCThreshold: number;
}

export const DEFAULT_PROFIT_TIER_THRESHOLDS: ProfitTierThresholds = {
  profitTierAThreshold: 250,
  profitTierBThreshold: 100,
  profitTierCThreshold: 0,
};

export const PROFIT_TIER_RULE_VERSION = 'rolling_30d_min_4_v1';
export const MINIMUM_PROFIT_TIER_UNITS_30_DAYS = 4;

export type ProfitTierEligibilityReason =
  | 'missing_recent_sales_evidence'
  | 'low_recent_demand'
  | 'stuck_inventory'
  | 'missing_profit_evidence'
  | 'non_positive_profit_score'
  | 'eligible_recent_demand';

export function isProfitTier(value: unknown): value is ProfitTier {
  return value === 'A' || value === 'B' || value === 'C';
}

export function profitTierRank(value: unknown) {
  if (value === 'A') return 0;
  if (value === 'B') return 1;
  if (value === 'C') return 2;
  return 99;
}

export function profitTierFor(
  profitPerUnit?: number,
  quantityBasis?: number,
  thresholds: ProfitTierThresholds = DEFAULT_PROFIT_TIER_THRESHOLDS,
) {
  const tierScore =
    typeof profitPerUnit === 'number' &&
    Number.isFinite(profitPerUnit) &&
    typeof quantityBasis === 'number' &&
    Number.isFinite(quantityBasis)
      ? profitPerUnit * quantityBasis
      : undefined;
  if (typeof tierScore !== 'number' || tierScore <= thresholds.profitTierCThreshold)
    return { tier: undefined, tierScore };
  if (tierScore >= thresholds.profitTierAThreshold) return { tier: 'A' as const, tierScore };
  if (tierScore >= thresholds.profitTierBThreshold) return { tier: 'B' as const, tierScore };
  return { tier: 'C' as const, tierScore };
}

export function rollingDemandProfitTier(params: {
  profitPerUnit?: number;
  recentUnits30?: number;
  stuckInventory?: boolean;
  thresholds?: ProfitTierThresholds;
}) {
  const result = profitTierFor(params.profitPerUnit, params.recentUnits30, params.thresholds);
  const eligibilityReason: ProfitTierEligibilityReason =
    typeof params.recentUnits30 !== 'number'
      ? 'missing_recent_sales_evidence'
      : params.recentUnits30 < MINIMUM_PROFIT_TIER_UNITS_30_DAYS
        ? 'low_recent_demand'
        : params.stuckInventory
          ? 'stuck_inventory'
          : typeof params.profitPerUnit !== 'number'
            ? 'missing_profit_evidence'
            : !result.tier
              ? 'non_positive_profit_score'
              : 'eligible_recent_demand';
  return {
    tier: eligibilityReason === 'eligible_recent_demand' ? result.tier : undefined,
    tierScore: result.tierScore,
    tierEligibilityReason: eligibilityReason,
    tierRuleVersion: PROFIT_TIER_RULE_VERSION,
  };
}

export function profitTierMovement(current: unknown, previous: unknown): ProfitTierMovement | undefined {
  const currentTier = isProfitTier(current) ? current : undefined;
  const previousTier = isProfitTier(previous) ? previous : undefined;
  if (!currentTier && !previousTier) return undefined;
  if (currentTier && !previousTier) return 'new';
  if (!currentTier && previousTier) return 'lost_tier';
  const currentRank = profitTierRank(currentTier);
  const previousRank = profitTierRank(previousTier);
  if (currentRank < previousRank) return 'up';
  if (currentRank > previousRank) return 'down';
  return 'same';
}
