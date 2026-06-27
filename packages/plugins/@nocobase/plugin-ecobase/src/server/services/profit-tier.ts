export type ProfitTier = 'A' | 'B' | 'C';
export type ProfitTierMovement = 'new' | 'up' | 'down' | 'same' | 'lost_tier';

export function isProfitTier(value: unknown): value is ProfitTier {
  return value === 'A' || value === 'B' || value === 'C';
}

export function profitTierRank(value: unknown) {
  if (value === 'A') return 0;
  if (value === 'B') return 1;
  if (value === 'C') return 2;
  return 99;
}

export function profitTierFor(profitPerUnit?: number, recommendedBestQty?: number) {
  const tierScore =
    typeof profitPerUnit === 'number' &&
    Number.isFinite(profitPerUnit) &&
    typeof recommendedBestQty === 'number' &&
    Number.isFinite(recommendedBestQty)
      ? profitPerUnit * recommendedBestQty
      : undefined;
  if (typeof tierScore !== 'number' || tierScore <= 0) return { tier: undefined, tierScore };
  if (tierScore >= 250) return { tier: 'A' as const, tierScore };
  if (tierScore >= 100) return { tier: 'B' as const, tierScore };
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
