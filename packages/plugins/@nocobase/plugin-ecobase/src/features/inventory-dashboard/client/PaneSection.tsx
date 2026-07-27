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

import { InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Button, Collapse, Input, Select, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DashboardRow, PaneResponse, PaneResult } from '../server/contract';
import { isRunSuperseded } from '../server/contract';
import { TEXT } from './dashboard-text';
import { DASHBOARD_TAG_COLORS, DASHBOARD_TOKENS } from './dashboard-tokens';
import type { PaneConfig } from './pane-configs';
import { formatMoney, type Translate } from './format';
import type { PaneRenderContext } from './widgets/render-context';

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
    { rootMargin: '100px' },
  );
  observer.observe(element);
  return () => observer.disconnect();
};

export interface PaneFetchRequest {
  pane: PaneConfig['pane'];
  runId: string;
  companyId?: string;
  search?: string;
  /** T-R1 (R1-2): user-selected sort scenario (server-side; default when absent). */
  sort?: string;
  page: number;
  pageSize: number;
}

export interface PaneSectionHandle {
  /** Tile deep-link (REQ-H6): trigger this pane's fetch if unloaded and move focus to its heading. */
  focusAndLoad: () => void;
  /** Scoped refresh after a drawer mutation (G3): re-fetch this pane only. */
  refresh: () => void;
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
  onRowClick?: (row: DashboardRow, trigger: HTMLElement | null) => void;
  /** Test probe (render-isolation assertion): called on every render of this section. */
  onRender?: (pane: PaneConfig['pane']) => void;
  /** T7: extra context for the Supply Action v2 cell renderers (api, sync registry, settings). */
  renderContext?: PaneRenderContext;
  /** T-R1 (R1-1): panes are independently collapsible, default EXPANDED. */
  defaultExpanded?: boolean;
}

type PaneLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; response: PaneResponse }
  | { status: 'error'; message: string };

function PaneSectionInner(props: PaneSectionProps, ref: React.Ref<PaneSectionHandle>) {
  const {
    config,
    runId,
    companyId,
    search,
    frozen,
    fetchPane,
    onSuperseded,
    onRowsLoaded,
    observeVisibility,
    t,
    onRowClick,
    onRender,
    renderContext,
  } = props;
  onRender?.(config.pane);
  const pageSize = props.pageSize ?? 25;
  const [visible, setVisible] = useState(false);
  // T-R1 (R1-1): independent per-pane collapse; collapsed panes never fetch.
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? true);
  // T-R1 (R1-2): the pane's selected sort scenario (undefined = server default).
  const [paneSort, setPaneSort] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<PaneLoadState>({ status: 'idle' });
  // Task 002: dedicated per-pane search (server-side, debounced) for panes that
  // opt in via config.showPaneSearch.
  const [paneSearchInput, setPaneSearchInput] = useState('');
  const [paneSearch, setPaneSearch] = useState('');

  useEffect(() => {
    if (!config.showPaneSearch) return undefined;
    const timer = setTimeout(() => setPaneSearch(paneSearchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [config.showPaneSearch, paneSearchInput]);
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
        const effectiveSearch = config.showPaneSearch && paneSearch ? paneSearch : search;
        const result = await fetchPane({
          pane: config.pane,
          runId,
          companyId,
          search: effectiveSearch,
          sort: paneSort,
          page: targetPage,
          pageSize,
        });
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
    [
      fetchPane,
      config.pane,
      config.showPaneSearch,
      runId,
      companyId,
      search,
      paneSearch,
      paneSort,
      pageSize,
      onSuperseded,
      onRowsLoaded,
    ],
  );

  useEffect(() => {
    // R1-1: a collapsed pane is treated as not-visible — no fetch until opened.
    if (visible && expanded && runId && !frozen) {
      load(page);
    }
  }, [visible, expanded, runId, frozen, page, load]);

  useImperativeHandle(
    ref,
    () => ({
      focusAndLoad: () => {
        setVisible(true);
        setExpanded(true);
        const heading = headingRef.current;
        heading?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        heading?.focus();
      },
      refresh: () => {
        setVisible(true);
        setExpanded(true);
        load(page);
      },
    }),
    [load, page],
  );

  const response = state.status === 'loaded' ? state.response : undefined;
  const columns = config.columns.map((column) => ({
    key: column.key,
    // R1-6: static rules live in a header tooltip, never repeated per row.
    title: column.hintKey ? (
      <span>
        {t(column.titleKey)}{' '}
        <Tooltip title={t(column.hintKey)}>
          <InfoCircleOutlined aria-label={t(column.hintKey)} style={{ color: 'rgba(0,0,0,0.45)' }} />
        </Tooltip>
      </span>
    ) : (
      t(column.titleKey)
    ),
    render: (_: unknown, row: DashboardRow) => column.render(row, t, renderContext),
  }));
  // T7 (mockup header strip): "N need ordering" + "€X at risk" pills.
  const needOrdering =
    config.pane === 'supplyAction'
      ? response?.metrics?.find((metric) => metric.key === 'familiesNeedingOrder')
      : undefined;
  const paneMoney =
    config.pane === 'supplyAction' ? response?.metrics?.find((metric) => metric.key === 'moneyAtRisk') : undefined;

  return (
    <section
      ref={containerRef}
      aria-labelledby={headingId}
      style={{
        marginBottom: DASHBOARD_TOKENS.sectionGap,
        // T-3.0c(b): unloaded EXPANDED sections keep a real height so they do
        // not all sit inside the initial viewport and defeat lazy fetching;
        // collapsed panes are allowed to shrink (that is the point).
        minHeight: state.status === 'loaded' || !expanded ? undefined : DASHBOARD_TOKENS.paneMinHeight,
      }}
      data-pane={config.pane}
    >
      {/* T-R1 (R1-1): independently collapsible pane, default expanded (the old
          page's one-open accordion is deliberately NOT copied). */}
      <Collapse
        activeKey={expanded ? [config.pane] : []}
        onChange={(keys) => setExpanded(Array.isArray(keys) ? keys.includes(config.pane) : keys === config.pane)}
        items={[
          {
            key: config.pane,
            label: (
              <Typography.Title
                level={3}
                id={headingId}
                tabIndex={-1}
                ref={headingRef}
                style={{ margin: 0, fontSize: 18, display: 'inline' }}
              >
                {t(config.titleKey)}
              </Typography.Title>
            ),
            // Controls live in `extra` behind a stopPropagation wrapper so they
            // never toggle the collapse (legacy pattern, re-implemented).
            extra: (
              <span
                role="presentation"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Space size="middle" align="center">
                  {response ? (
                    <Typography.Text type="secondary">{`${t(TEXT.metricRows)}: ${
                      response.pagination?.total ?? 0
                    }`}</Typography.Text>
                  ) : null}
                  {needOrdering && typeof needOrdering.value === 'number' && needOrdering.value > 0 ? (
                    <Tag color={DASHBOARD_TAG_COLORS.danger} style={{ borderRadius: 999, fontWeight: 600 }}>
                      {`${needOrdering.value} ${t(TEXT.metricNeedOrdering)}`}
                    </Tag>
                  ) : null}
                  {paneMoney && typeof paneMoney.value === 'number' && paneMoney.value > 0 ? (
                    <Tag color={DASHBOARD_TAG_COLORS.warning} style={{ borderRadius: 999, fontWeight: 600 }}>
                      {`${formatMoney(paneMoney.value, t)} ${t(TEXT.metricAtRiskSuffix)}`}
                    </Tag>
                  ) : null}
                  {(response?.metrics ?? [])
                    .filter(
                      // 066 D9: the Data-issues pane's true queue length rides
                      // next to the tiered-attention count, same treatment.
                      (metric) =>
                        ['tieredNeedingAttention', 'familiesNeedingTarget'].includes(metric.key) &&
                        metric.value !== null,
                    )
                    .map((metric) => (
                      <Typography.Text key={metric.key} type="warning">
                        {`${t(metric.label)}: ${metric.value}`}
                      </Typography.Text>
                    ))}
                  {config.sortOptions ? (
                    <Select
                      size="small"
                      aria-label={`${t(config.titleKey)} ${t(TEXT.sortLabel)}`}
                      style={{ minWidth: 150 }}
                      value={paneSort ?? ''}
                      options={config.sortOptions.map((option) => ({
                        value: option.value ?? '',
                        label: t(option.labelKey),
                      }))}
                      onChange={(value: string) => {
                        // R1-2: server-side sorting — a scenario change restarts at page 1.
                        setPaneSort(value === '' ? undefined : value);
                        setPage(1);
                      }}
                    />
                  ) : null}
                </Space>
              </span>
            ),
            children: (
              <>
                {config.showPaneSearch ? (
                  <Input.Search
                    allowClear
                    size="small"
                    placeholder={t(TEXT.paneSearchPlaceholder)}
                    aria-label={`${t(config.titleKey)} ${t(TEXT.searchLabel)}`}
                    style={{ maxWidth: 320, marginBottom: 8, display: 'block' }}
                    value={paneSearchInput}
                    onChange={(event) => setPaneSearchInput(event.target.value)}
                  />
                ) : null}
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
                    onRow={(row) => ({
                      onClick: (event) => onRowClick?.(row, event.currentTarget as HTMLElement),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onRowClick?.(row, event.currentTarget as HTMLElement);
                        }
                      },
                      tabIndex: 0,
                      role: 'button',
                      'aria-label': `${t(config.titleKey)}: ${
                        row.identity?.sku ?? row.identity?.asin ?? row.identity?.familyKey
                      }`,
                    })}
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
              </>
            ),
          },
        ]}
      />
    </section>
  );
}

const PaneSection = React.memo(forwardRef<PaneSectionHandle, PaneSectionProps>(PaneSectionInner));
PaneSection.displayName = 'InventoryDashboardPaneSection';

export default PaneSection;
