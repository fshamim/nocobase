/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Shared order-pane table (Order panes T4). One decision-first table reused by
 * Active orders, In-prep monitoring and Inbound monitoring. It mirrors the generic
 * PaneSection's shell (collapse, visibility-gated lazy fetch, server pagination,
 * run-superseded freeze, and the imperative focusAndLoad/refresh handle the KPI
 * deep-links + scoped refresh rely on) but fetches the richer order-grain
 * `paneOrders` read and renders the per-pane cell anatomy from the approved
 * prototype. Row click opens the existing OrderViewDrawer by orderId.
 */

import { InfoCircleOutlined } from '@ant-design/icons';
import { Alert, App, Button, Collapse, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { TEXT } from '../dashboard-text';
import { DASHBOARD_TOKENS } from '../dashboard-tokens';
import { EM_DASH, formatMoney, relativeTime, type Translate } from '../format';
import type { ObserveVisibility, PaneSectionHandle } from '../PaneSection';
import {
  createOrderApi,
  isOrderPaneRunSuperseded,
  type OrderApi,
  type OrderAttentionReason,
  type OrderPaneKey,
  type OrderPaneResponse,
  type OrderPaneRow,
  type OrderRequestClient,
} from './order-api';
import { PaperworkChain, PrepChain, SupplierShipPill } from './order-milestones';
import { LifecycleStatusPill } from './order-pills';
import { OrderViewDrawer } from './OrderViewDrawer';

const RED = '#cf1322';
const GREEN = '#389e0d';
const MUTED = 'rgba(0,0,0,0.45)';
const MONO: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };

export interface OrderPaneTableProps {
  pane: OrderPaneKey;
  titleKey: string;
  runId: string;
  companyId?: string;
  search: string;
  frozen: boolean;
  api: OrderRequestClient;
  t: Translate;
  observeVisibility: ObserveVisibility;
  onSuperseded: (publishedRunId: string) => void;
  onRender?: (pane: OrderPaneKey) => void;
  /** Scoped refresh after a mutation (reloads the header + this pane via the page's ref map). */
  onMutated?: (pane: OrderPaneKey) => void;
  defaultExpanded?: boolean;
  pageSize?: number;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; response: OrderPaneResponse }
  | { status: 'error'; message: string };

function reasonLabel(reason: OrderAttentionReason, t: Translate): string {
  switch (reason) {
    case 'follow_up':
      return t(TEXT.opReasonFollowUp);
    case 'prep_idle':
      return t(TEXT.opReasonPrepIdle);
    case 'inbound_overdue':
      return t(TEXT.opReasonInboundOverdue);
    case 'payment_blocked':
      return t(TEXT.opReasonPaymentBlocked);
    default:
      return '';
  }
}

function OrderPaneTableInner(props: OrderPaneTableProps, ref: React.Ref<PaneSectionHandle>) {
  const {
    pane,
    titleKey,
    runId,
    companyId,
    search,
    frozen,
    api,
    t,
    observeVisibility,
    onSuperseded,
    onRender,
    onMutated,
  } = props;
  onRender?.(pane);
  const pageSize = props.pageSize ?? 25;
  const { message, modal } = App.useApp();
  const orderApi: OrderApi = useMemo(() => createOrderApi(api), [api]);

  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [drawerOrderId, setDrawerOrderId] = useState<string | null>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const headingId = `inventory-dashboard-pane-${pane}`;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || visible) return undefined;
    return observeVisibility(element, () => setVisible(true));
  }, [observeVisibility, visible]);

  const load = useCallback(
    async (targetPage: number) => {
      setState({ status: 'loading' });
      try {
        const result = await orderApi.paneOrders({ pane, runId, companyId, search, page: targetPage, pageSize });
        if (isOrderPaneRunSuperseded(result)) {
          onSuperseded(result.publishedRunId);
          setState({ status: 'idle' });
          return;
        }
        setState({ status: 'loaded', response: result });
      } catch (error) {
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    },
    [orderApi, pane, runId, companyId, search, pageSize, onSuperseded],
  );

  useEffect(() => {
    if (visible && expanded && runId && !frozen) load(page);
  }, [visible, expanded, runId, frozen, page, load]);

  const notifyMutated = useCallback(() => {
    if (onMutated) onMutated(pane);
    else load(page);
  }, [onMutated, pane, load, page]);

  useImperativeHandle(
    ref,
    () => ({
      focusAndLoad: () => {
        setVisible(true);
        setExpanded(true);
        headingRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        headingRef.current?.focus();
      },
      refresh: () => {
        setVisible(true);
        setExpanded(true);
        load(page);
      },
    }),
    [load, page],
  );

  const openOrder = useCallback((orderId: string, trigger: HTMLElement | null) => {
    drawerTriggerRef.current = trigger;
    setDrawerOrderId(orderId);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOrderId(null);
    drawerTriggerRef.current?.focus();
  }, []);

  const confirmInbound = useCallback(
    (orderId: string) => {
      modal.confirm({
        title: t(TEXT.opConfirmInboundTitle),
        content: t(TEXT.opConfirmInboundBody),
        okText: t(TEXT.opConfirm),
        cancelText: t(TEXT.ocCancel),
        onOk: async () => {
          try {
            await orderApi.confirmInboundCompletion(orderId);
            message.success(t(TEXT.opInboundConfirmed));
            notifyMutated();
          } catch (error) {
            message.error(error instanceof Error ? error.message : t(TEXT.unexpectedResponse));
          }
        },
      });
    },
    [modal, orderApi, message, t, notifyMutated],
  );

  const now = Date.now();
  const response = state.status === 'loaded' ? state.response : undefined;

  const columns = useMemo(
    () => buildColumns({ pane, t, now, openOrder, confirmInbound }),
    [pane, t, now, openOrder, confirmInbound],
  );

  return (
    <section
      ref={containerRef}
      aria-labelledby={headingId}
      data-pane={pane}
      style={{
        marginBottom: DASHBOARD_TOKENS.sectionGap,
        minHeight: state.status === 'loaded' || !expanded ? undefined : DASHBOARD_TOKENS.paneMinHeight,
      }}
    >
      <Collapse
        activeKey={expanded ? [pane] : []}
        onChange={(keys) => setExpanded(Array.isArray(keys) ? keys.includes(pane) : keys === pane)}
        items={[
          {
            key: pane,
            label: (
              <Typography.Title
                level={3}
                id={headingId}
                tabIndex={-1}
                ref={headingRef}
                style={{ margin: 0, fontSize: 18, display: 'inline' }}
              >
                {t(titleKey)}
              </Typography.Title>
            ),
            extra: response ? (
              <span role="presentation" onClick={(event) => event.stopPropagation()}>
                <Typography.Text type="secondary">{`${t(TEXT.metricRows)}: ${
                  response.pagination?.total ?? 0
                }`}</Typography.Text>
              </span>
            ) : null,
            children:
              state.status === 'error' ? (
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
                <Spin aria-label={`${t(titleKey)} ${t(TEXT.loading)}`} />
              ) : (
                <Table<OrderPaneRow>
                  size="small"
                  rowKey={(row) => row.orderId}
                  columns={columns}
                  dataSource={Array.isArray(response?.rows) ? response.rows : []}
                  locale={{ emptyText: t(TEXT.empty) }}
                  onRow={(row) => ({
                    onClick: (event) => openOrder(row.orderId, event.currentTarget as HTMLElement),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openOrder(row.orderId, event.currentTarget as HTMLElement);
                      }
                    },
                    tabIndex: 0,
                    role: 'button',
                    'aria-label': `${t(TEXT.opRowLabel)}: ${row.orderRef ?? row.orderId}`,
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
              ),
          },
        ]}
      />
      <OrderViewDrawer
        open={drawerOrderId !== null}
        api={api}
        t={t}
        orderId={drawerOrderId}
        onClose={closeDrawer}
        onMutated={notifyMutated}
      />
    </section>
  );
}

// ---- cell renderers -------------------------------------------------------

interface CellContext {
  pane: OrderPaneKey;
  t: Translate;
  now: number;
  openOrder: (orderId: string, trigger: HTMLElement | null) => void;
  confirmInbound: (orderId: string) => void;
}

function actionChip(
  label: string,
  onActivate: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void,
  tone: 'danger' | 'success',
): React.ReactNode {
  const color = tone === 'success' ? GREEN : RED;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onActivate(event);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        border: `1px dashed ${color}`,
        color,
        background: 'none',
        borderRadius: 999,
        padding: '0 8px',
        fontSize: 10.5,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {tone === 'success' ? '✓ ' : '⚠ '}
      {label}
    </button>
  );
}

function orderCell(row: OrderPaneRow, ctx: CellContext): React.ReactNode {
  const reason = reasonLabel(row.attention.reason, ctx.t);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 190 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {row.attention.flagged ? (
          <span
            role="img"
            title={reason}
            aria-label={reason}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: RED,
              flex: 'none',
              boxShadow: '0 0 0 3px #fff1f0',
            }}
          />
        ) : null}
        <span style={{ ...MONO, fontWeight: 700, fontSize: 15 }}>{row.orderRef ?? EM_DASH}</span>
      </span>
      <span style={{ fontSize: 12, color: MUTED }}>
        {[row.companyName, row.sourceMarketplace].filter(Boolean).join(' · ') || EM_DASH}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        {row.supplierName ?? EM_DASH}
        <SupplierShipPill shipDestination={row.supplierShipDestination} t={ctx.t} />
      </span>
    </div>
  );
}

function inboundStatusCell(row: OrderPaneRow, ctx: CellContext): React.ReactNode {
  const { t } = ctx;
  const buckets = row.inbound;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 210 }}>
      <span>
        <LifecycleStatusPill status={row.lifecycleStatus} fallbackLabel={ctx.t(TEXT.ovNoStatus)} />
      </span>
      <span style={{ fontSize: 13 }}>
        {t(TEXT.opSellerboard)} {t(TEXT.ovOrderedPrefix)} <strong style={NUM}>{buckets.orderedUnits}</strong>{' '}
        {t(TEXT.opUnitAbbrev)} · {t(TEXT.opInboundWord)} <strong style={NUM}>{buckets.arrivedUnits}</strong>{' '}
        {t(TEXT.opUnitAbbrev)}{' '}
        {buckets.arrivalDetected ? (
          <Tag color="green" style={{ borderRadius: 999, fontSize: 11, paddingInline: 7 }}>
            ✓ {t(TEXT.opArrived)}
          </Tag>
        ) : null}
      </span>
      {buckets.alreadyConfirmed ? (
        <span style={{ fontSize: 12, color: MUTED }}>{t(TEXT.opCompleted)}</span>
      ) : buckets.arrivalDetected ? (
        actionChip(t(TEXT.opConfirmInboundChip), () => ctx.confirmInbound(row.orderId), 'success')
      ) : (
        <span style={{ fontSize: 12, color: MUTED }}>{t(TEXT.opNothingMoved)}</span>
      )}
    </div>
  );
}

function statusCell(row: OrderPaneRow, ctx: CellContext): React.ReactNode {
  if (ctx.pane === 'inboundMonitoring') return inboundStatusCell(row, ctx);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 210 }}>
      <span>
        <LifecycleStatusPill status={row.lifecycleStatus} fallbackLabel={ctx.t(TEXT.ovNoStatus)} />
      </span>
      {ctx.pane === 'inPrepMonitoring' ? (
        <PrepChain prep={row.prep} t={ctx.t} />
      ) : (
        <PaperworkChain paperwork={row.paperwork} t={ctx.t} />
      )}
    </div>
  );
}

function costCell(row: OrderPaneRow, ctx: CellContext): React.ReactNode {
  const { t } = ctx;
  const { expectedCost, actualCost } = row;
  let delta: React.ReactNode = null;
  if (typeof actualCost === 'number' && typeof expectedCost === 'number') {
    const diff = Math.round((actualCost - expectedCost) * 100) / 100;
    const text = diff > 0 ? `+${formatMoney(diff, t)}` : diff < 0 ? formatMoney(diff, t) : `±${formatMoney(0, t)}`;
    delta = <span style={{ fontSize: 12, color: diff > 0 ? RED : GREEN }}>{text}</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 110, alignItems: 'flex-end' }}>
      <span style={NUM}>{typeof expectedCost === 'number' ? formatMoney(expectedCost, t) : EM_DASH}</span>
      {typeof actualCost === 'number' ? (
        <span style={{ ...NUM, fontWeight: 700 }}>{formatMoney(actualCost, t)}</span>
      ) : (
        <span style={{ ...NUM, color: MUTED }}>{EM_DASH}</span>
      )}
      {delta}
    </div>
  );
}

function inStatusCell(row: OrderPaneRow, ctx: CellContext): React.ReactNode {
  const { t } = ctx;
  const days = ctx.pane === 'inboundMonitoring' ? row.daysInPane : row.daysInStatus;
  const reason = reasonLabel(row.attention.reason, t);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ ...NUM, fontSize: 15 }}>
        {days === null ? (
          t(TEXT.unknown)
        ) : row.attention.flagged ? (
          <strong>
            {days} {t(TEXT.dSuffix)}
          </strong>
        ) : (
          `${days} ${t(TEXT.dSuffix)}`
        )}
      </span>
      {row.attention.flagged ? actionChip(reason, () => ctx.openOrder(row.orderId, null), 'danger') : null}
    </div>
  );
}

function lastActivityCell(row: OrderPaneRow, ctx: CellContext): React.ReactNode {
  if (!row.lastActivity) {
    return <span style={{ color: MUTED, fontSize: 12 }}>{ctx.t(TEXT.noActivityYet)}</span>;
  }
  const rel = relativeTime(row.lastActivity.at, ctx.now, ctx.t);
  const firstLine = row.lastActivity.body.split('\n')[0];
  return (
    <span style={{ fontSize: 13 }}>
      <span style={{ color: MUTED }}>{rel}</span>
      {' — '}
      {firstLine}
    </span>
  );
}

function moneyCell(row: OrderPaneRow, ctx: CellContext): React.ReactNode {
  const { t: translate } = ctx;
  if (row.moneyAtRisk === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
        <span style={NUM}>{EM_DASH}</span>
        <span style={{ fontSize: 12, color: MUTED }}>{translate(TEXT.opStockCoversEta)}</span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
      <span style={{ ...NUM, fontWeight: 700, color: row.moneyAtRiskPastSafe ? RED : undefined }}>
        {formatMoney(row.moneyAtRisk, translate)}
      </span>
      <span style={{ fontSize: 12, color: MUTED }}>
        {row.atRiskProductCount} {translate(TEXT.opOf)} {row.productCount} {translate(TEXT.opProductsAtRisk)}
      </span>
    </div>
  );
}

function buildColumns(ctx: CellContext) {
  const { t: translate } = ctx;
  const numHeader = (label: string) => ({ title: label, align: 'right' as const });
  return [
    { key: 'order', title: translate(TEXT.colOrder), render: (_: unknown, row: OrderPaneRow) => orderCell(row, ctx) },
    {
      key: 'status',
      title: translate(TEXT.drawerStatus),
      render: (_: unknown, row: OrderPaneRow) => statusCell(row, ctx),
    },
    {
      key: 'cost',
      ...numHeader(translate(TEXT.opColCost)),
      render: (_: unknown, row: OrderPaneRow) => costCell(row, ctx),
    },
    {
      key: 'units',
      ...numHeader(translate(TEXT.ocUnits)),
      render: (_: unknown, row: OrderPaneRow) => <span style={NUM}>{row.units}</span>,
    },
    {
      key: 'inStatus',
      title: (
        <span>
          {translate(TEXT.opColInStatus)}{' '}
          <Tooltip title={translate(TEXT.opColInStatus)}>
            <InfoCircleOutlined aria-label={translate(TEXT.opColInStatus)} style={{ color: MUTED }} />
          </Tooltip>
        </span>
      ),
      render: (_: unknown, row: OrderPaneRow) => inStatusCell(row, ctx),
    },
    {
      key: 'lastActivity',
      title: translate(TEXT.colLastActivity),
      render: (_: unknown, row: OrderPaneRow) => lastActivityCell(row, ctx),
    },
    {
      key: 'money',
      ...numHeader(translate(TEXT.metricMoneyAtRisk)),
      render: (_: unknown, row: OrderPaneRow) => moneyCell(row, ctx),
    },
  ];
}

const OrderPaneTable = forwardRef<PaneSectionHandle, OrderPaneTableProps>(OrderPaneTableInner);
OrderPaneTable.displayName = 'InventoryDashboardOrderPaneTable';

export default OrderPaneTable;
