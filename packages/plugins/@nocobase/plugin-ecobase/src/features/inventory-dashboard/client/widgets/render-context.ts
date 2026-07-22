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

import type { PaneKey } from '../../server/contract';

export interface DashboardRequestApi {
  request: (options: { url: string; method: 'post'; data: Record<string, unknown> }) => Promise<unknown>;
}

export interface PaneRenderContext {
  api: DashboardRequestApi;
  runId: string;
  fbaReceivingBufferDays: number | null;
  pendingFamilies: ReadonlySet<string>;
  markPending: (familyKey: string) => void;
  onMutated: (pane: PaneKey) => void;
}
