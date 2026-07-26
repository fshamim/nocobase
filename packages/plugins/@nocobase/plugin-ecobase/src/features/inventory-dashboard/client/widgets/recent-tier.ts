/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * 065 — the ONE badge rule. `recentTier = current ?? lastClosedMonth`: a
 * product wears the tier it earned in the last two months, and nothing else.
 * `baseline` is HISTORY — it never reaches a badge (table cell, signals tag or
 * drawer identity header); the drawer's Overview tab is its only home.
 *
 * Every render site calls this helper so the coalesce cannot drift apart again
 * (T-R2 was exactly that drift, with `current` and `baseline` swapped).
 */

import type { DashboardRowTier } from '../../server/contract';

export interface RecentTier {
  /** The tier letter as served (trimmed); callers uppercase it for display. */
  tier: string;
  /** Which month the letter came from — `last_month` earns the muted hint. */
  basis: 'current' | 'last_month';
}

export function recentTierOf(tier: DashboardRowTier): RecentTier | null {
  const current = (tier?.current ?? '').trim();
  if (current) return { tier: current, basis: 'current' };
  const lastClosedMonth = (tier?.lastClosedMonth ?? '').trim();
  if (lastClosedMonth) return { tier: lastClosedMonth, basis: 'last_month' };
  return null;
}
