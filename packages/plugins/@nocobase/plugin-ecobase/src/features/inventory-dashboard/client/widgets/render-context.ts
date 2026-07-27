/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T7: extra context the Supply Action v2 cell renderers need beyond (row, t) —
 * the api client for operator-initiated lazy fetches/mutations, the pinned run,
 * the W5 sync registry, header settings, and the scoped-refresh callback.
 */

import type { DashboardRow, PaneKey } from '../../server/contract';

export interface DashboardRequestApi {
  request: (options: { url: string; method: 'post'; data: Record<string, unknown> }) => Promise<unknown>;
}

export interface PaneRenderContext {
  api: DashboardRequestApi;
  runId: string;
  fbaReceivingBufferDays: number | null;
  /** R1-6: rows only annotate coverage horizons that DIFFER from this default. */
  targetCoverDaysDefault: number | null;
  pendingFamilies: ReadonlySet<string>;
  markPending: (familyKey: string) => void;
  onMutated: (pane: PaneKey) => void;
  /**
   * 066 T3 (D7): open the row's standard product drawer — the evidence modal's
   * "Open product drawer" action, wired from the page's own row-click handler.
   * Optional so every existing consumer (and every test fixture) stays valid;
   * a cell that does not get it simply omits the action.
   */
  openDrawer?: (row: DashboardRow) => void;
}
