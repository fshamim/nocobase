/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * W5 SyncState (T7): a client-side pending-publish registry. Every successful
 * dashboard mutation marks its familyKey; the set clears WHOLESALE when the
 * header's publishedRunId changes (the edit has landed in gold). Rendered as a
 * quiet pulsing dot in the family cell and as a ghost chip in the drawer head.
 */

import { Tooltip } from 'antd';
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { TEXT } from '../dashboard-text';
import type { Translate } from '../format';

export interface SyncStateValue {
  pendingFamilies: ReadonlySet<string>;
  markPending: (familyKey: string) => void;
  /** Called by the page whenever the published run id changes — clears everything. */
  onRunChanged: (publishedRunId: string) => void;
}

const SyncStateContext = createContext<SyncStateValue | null>(null);

export function SyncStateProvider({ children }: { children: React.ReactNode }) {
  const [pendingFamilies, setPendingFamilies] = useState<ReadonlySet<string>>(new Set());
  const lastRunId = useRef<string>('');

  const markPending = useCallback((familyKey: string) => {
    if (!familyKey) return;
    setPendingFamilies((existing) => {
      if (existing.has(familyKey)) return existing;
      const next = new Set(existing);
      next.add(familyKey);
      return next;
    });
  }, []);

  const onRunChanged = useCallback((publishedRunId: string) => {
    if (!publishedRunId || lastRunId.current === publishedRunId) return;
    const isFirstRun = lastRunId.current === '';
    lastRunId.current = publishedRunId;
    if (!isFirstRun) setPendingFamilies(new Set());
  }, []);

  const value = useMemo(
    () => ({ pendingFamilies, markPending, onRunChanged }),
    [pendingFamilies, markPending, onRunChanged],
  );
  return <SyncStateContext.Provider value={value}>{children}</SyncStateContext.Provider>;
}

const NOOP_SYNC_STATE: SyncStateValue = {
  pendingFamilies: new Set(),
  markPending: () => undefined,
  onRunChanged: () => undefined,
};

export function useSyncState(): SyncStateValue {
  return useContext(SyncStateContext) ?? NOOP_SYNC_STATE;
}

/** The quiet pulsing dot + "syncing" microcopy (mockup `.sync`). */
export function SyncDot({ t }: { t: Translate }) {
  return (
    <Tooltip title={t(TEXT.syncTooltip)}>
      <span
        aria-label={t(TEXT.syncTooltip)}
        style={{ color: '#d46b08', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3 }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#d46b08',
            animation: 'ecobaseSyncPulse 1.6s ease-in-out infinite',
          }}
        />
        {t(TEXT.syncing)}
        <style>{`@keyframes ecobaseSyncPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { [aria-label] > span { animation: none !important; } }`}</style>
      </span>
    </Tooltip>
  );
}
