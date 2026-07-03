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
  recommendedBestQty?: number,
  thresholds: ProfitTierThresholds = DEFAULT_PROFIT_TIER_THRESHOLDS,
) {
  const tierScore =
    typeof profitPerUnit === 'number' &&
    Number.isFinite(profitPerUnit) &&
    typeof recommendedBestQty === 'number' &&
    Number.isFinite(recommendedBestQty)
      ? profitPerUnit * recommendedBestQty
      : undefined;
  if (typeof tierScore !== 'number' || tierScore <= thresholds.profitTierCThreshold)
    return { tier: undefined, tierScore };
  if (tierScore >= thresholds.profitTierAThreshold) return { tier: 'A' as const, tierScore };
  if (tierScore >= thresholds.profitTierBThreshold) return { tier: 'B' as const, tierScore };
  return { tier: 'C' as const, tierScore };
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
