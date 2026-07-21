/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Generic, memoized pane section (T-2.3 / AD-5). Config-driven columns, lazy
 * fetch on visibility via an injectable observer (jsdom-stubbable), per-pane
 * loading/empty/error states, server pagination. Renders served values
 * verbatim — membership and statuses all come from the API.
 */

import { Alert, Button, Space, Spin, Table, Typography } from 'antd';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DashboardRow, PaneResponse, PaneResult } from '../server/contract';
import { isRunSuperseded } from '../server/contract';
import { TEXT } from './dashboard-text';
import { DASHBOARD_TOKENS } from './dashboard-tokens';
import type { PaneConfig } from './pane-configs';
import type { Translate } from './format';

export type ObserveVisibility = (element: Element, onVisible: () => void) => () => void;

export const defaultObserveVisibility: ObserveVisibility = (element, onVisible) => {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible();
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible();
        observer.disconnect();
      }
    },
    { rootMargin: '200px' },
  );
  observer.observe(element);
  return () => observer.disconnect();
};

export interface PaneFetchRequest {
  pane: PaneConfig['pane'];
  runId: string;
  companyId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface PaneSectionHandle {
  /** Tile deep-link (REQ-H6): trigger this pane's fetch if unloaded and move focus to its heading. */
  focusAndLoad: () => void;
}

export interface PaneSectionProps {
  config: PaneConfig;
  runId: string;
  companyId?: string;
  search: string;
  pageSize?: number;
  frozen: boolean;
  fetchPane: (request: PaneFetchRequest) => Promise<PaneResult>;
  onSuperseded: (publishedRunId: string) => void;
  onRowsLoaded?: (rows: DashboardRow[]) => void;
  observeVisibility: ObserveVisibility;
  t: Translate;
}

type PaneLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; response: PaneResponse }
  | { status: 'error'; message: string };

function PaneSectionInner(props: PaneSectionProps, ref: React.Ref<PaneSectionHandle>) {
  const { config, runId, companyId, search, frozen, fetchPane, onSuperseded, onRowsLoaded, observeVisibility, t } =
    props;
  const pageSize = props.pageSize ?? 25;
  const [visible, setVisible] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<PaneLoadState>({ status: 'idle' });
  const containerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const headingId = `inventory-dashboard-pane-${config.pane}`;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || visible) return undefined;
    return observeVisibility(element, () => setVisible(true));
  }, [observeVisibility, visible]);

  const load = useCallback(
    async (targetPage: number) => {
      setState({ status: 'loading' });
      try {
        const result = await fetchPane({ pane: config.pane, runId, companyId, search, page: targetPage, pageSize });
        if (isRunSuperseded(result)) {
          onSuperseded(result.publishedRunId);
          setState({ status: 'idle' });
          return;
        }
        setState({ status: 'loaded', response: result });
        onRowsLoaded?.(Array.isArray(result.rows) ? result.rows : []);
      } catch (error) {
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    },
    [fetchPane, config.pane, runId, companyId, search, pageSize, onSuperseded, onRowsLoaded],
  );

  useEffect(() => {
    if (visible && runId && !frozen) {
      load(page);
    }
  }, [visible, runId, frozen, page, load]);

  useImperativeHandle(
    ref,
    () => ({
      focusAndLoad: () => {
        setVisible(true);
        const heading = headingRef.current;
        heading?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        heading?.focus();
      },
    }),
    [],
  );

  const response = state.status === 'loaded' ? state.response : undefined;
  const columns = config.columns.map((column) => ({
    key: column.key,
    title: t(column.titleKey),
    render: (_: unknown, row: DashboardRow) => column.render(row, t),
  }));

  return (
    <section
      ref={containerRef}
      aria-labelledby={headingId}
      style={{ marginBottom: DASHBOARD_TOKENS.sectionGap }}
      data-pane={config.pane}
    >
      <Space align="baseline" size="middle" style={{ marginBottom: DASHBOARD_TOKENS.paneHeaderGap }}>
        <Typography.Title level={3} id={headingId} tabIndex={-1} ref={headingRef} style={{ margin: 0, fontSize: 18 }}>
          {t(config.titleKey)}
        </Typography.Title>
        {response ? (
          <Typography.Text type="secondary">{`${t(TEXT.metricRows)}: ${
            response.pagination?.total ?? 0
          }`}</Typography.Text>
        ) : null}
      </Space>
      {state.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message={`${t(TEXT.loadFailed)}: ${state.message}`}
          action={
            <Button size="small" onClick={() => load(page)}>
              {t(TEXT.retry)}
            </Button>
          }
        />
      ) : state.status === 'loading' || state.status === 'idle' ? (
        <Spin aria-label={`${t(config.titleKey)} ${t(TEXT.loading)}`} />
      ) : (
        <Table<DashboardRow>
          size="small"
          rowKey={(row) => `${row.identity.listingRowId}:${row.order?.orderId ?? ''}`}
          columns={columns}
          dataSource={Array.isArray(response?.rows) ? response.rows : []}
          locale={{ emptyText: t(TEXT.empty) }}
          pagination={{
            current: response?.pagination?.page ?? page,
            pageSize: response?.pagination?.pageSize ?? pageSize,
            total: response?.pagination?.total ?? 0,
            hideOnSinglePage: true,
            onChange: (nextPage) => setPage(nextPage),
          }}
          scroll={{ x: true }}
        />
      )}
    </section>
  );
}

const PaneSection = React.memo(forwardRef<PaneSectionHandle, PaneSectionProps>(PaneSectionInner));
PaneSection.displayName = 'InventoryDashboardPaneSection';

export default PaneSection;
