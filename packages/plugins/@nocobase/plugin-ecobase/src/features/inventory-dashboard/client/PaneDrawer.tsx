/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Pane-context-sensitive drawer (T-3.1..T-3.4, REQ-X2). One registry maps each
 * pane to its body; state lives entirely inside the drawer so typing never
 * re-renders the page. All requests go through the envelope unwrap + guards;
 * mutation failures keep the drawer open with buffers intact and trigger no
 * refetch. Successful mutations refresh only the affected pane + header.
 */

import { Alert, Button, Divider, Drawer, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { DashboardRow, DrawerContextResponse, PaneKey } from '../server/contract';
import { isRunSuperseded } from '../server/contract';
import { TEXT } from './dashboard-text';
import {
  BandVisual,
  CommentForm,
  EtaForm,
  FamilyContext,
  OrderSummary,
  PrepDetailsForm,
  ProductSummary,
  ReasonList,
  ShipRouteForm,
  StatusForm,
  type RunDrawerMutation,
} from './drawer-sections';
import { isDrawerContextPayload, unwrapEnvelope } from './envelope';
import { formatNumber, type Translate } from './format';

/** Sibling workspace page (kept literal to avoid importing client-routes into the feature). */
const ORDER_PLANNING_PATH = '/admin/ecobase/order-planning';

export interface DashboardRequestClient {
  request: (options: { url: string; method: 'post'; data: Record<string, unknown> }) => Promise<unknown>;
}

export interface DrawerTarget {
  pane: PaneKey;
  familyId: string;
  orderId?: string;
  listingRowId?: string;
}

export interface PaneDrawerProps {
  target: DrawerTarget | null;
  runId: string;
  api: DashboardRequestClient;
  t: Translate;
  onClose: () => void;
  onMutated: (pane: PaneKey) => void;
  onSuperseded: (publishedRunId: string) => void;
  navigate?: (path: string) => void;
}

type DrawerState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; context: DrawerContextResponse }
  | { status: 'error'; message: string };

function primaryOrderRow(context: DrawerContextResponse, orderId?: string): DashboardRow | undefined {
  return orderId ? context.orderRows.find((row) => row.order?.orderId === orderId) : context.orderRows[0];
}

const PaneDrawer: React.FC<PaneDrawerProps> = ({
  target,
  runId,
  api,
  t,
  onClose,
  onMutated,
  onSuperseded,
  navigate,
}) => {
  const [state, setState] = useState<DrawerState>({ status: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  // QA item 4: move focus INTO the drawer on open (jsdom + browser reliable,
  // no dependency on motion end events).
  useEffect(() => {
    if (target) {
      const timer = setTimeout(() => bodyRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [target]);

  // QA item 5: progress hint when the drawer context takes unusually long.
  useEffect(() => {
    if (state.status !== 'loading') {
      setSlowLoad(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlowLoad(true), 10_000);
    return () => clearTimeout(timer);
  }, [state.status]);

  const load = useCallback(async () => {
    if (!target) return;
    setState({ status: 'loading' });
    setMutationError(null);
    try {
      const data = unwrapEnvelope(
        await api.request({
          url: 'ecobaseInventoryDashboard:drawerContext',
          method: 'post',
          data: {
            pane: target.pane,
            runId,
            familyId: target.familyId,
            orderId: target.orderId,
            listingRowId: target.listingRowId,
          },
        }),
      );
      if (!isDrawerContextPayload(data)) throw new Error(t(TEXT.unexpectedResponse));
      if (isRunSuperseded(data)) {
        onSuperseded(data.publishedRunId);
        setState({ status: 'idle' });
        return;
      }
      setState({ status: 'loaded', context: data });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [api, target, runId, t, onSuperseded]);

  useEffect(() => {
    if (target) {
      load();
    } else {
      setState({ status: 'idle' });
      setMutationError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.pane, target?.familyId, target?.orderId, target?.listingRowId, runId]);

  const runMutation: RunDrawerMutation = useCallback(
    async (url, data) => {
      if (submitting || !target) return false;
      setSubmitting(true);
      setMutationError(null);
      try {
        await api.request({ url, method: 'post', data });
        onMutated(target.pane); // scoped refresh: affected pane + header only
        return true;
      } catch (error) {
        // Error path: message shown, drawer stays open, buffers preserved, no refetch.
        setMutationError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setSubmitting(false);
        // QA polish item 2: the scoped refresh re-renders page + drawer; if
        // focus fell out of the drawer (to body), pull it back in so Esc and
        // keyboard flows keep working.
        setTimeout(() => {
          const body = bodyRef.current;
          if (body && !body.contains(document.activeElement)) body.focus();
        }, 0);
      }
    },
    [api, submitting, target, onMutated],
  );

  const context = state.status === 'loaded' ? state.context : null;
  const orderRow = context && target ? primaryOrderRow(context, target.orderId) : undefined;
  const row = orderRow ?? context?.primaryRow;

  return (
    <Drawer
      open={target !== null}
      onClose={onClose}
      width={560}
      title={target ? `${t(paneTitle(target.pane))} — ${row?.identity?.sku ?? row?.identity?.asin ?? ''}` : ''}
      destroyOnClose
    >
      <div ref={bodyRef} tabIndex={-1} aria-label={target ? t(paneTitle(target.pane)) : undefined}>
        {mutationError ? <Alert type="error" showIcon message={mutationError} style={{ marginBottom: 12 }} /> : null}
        {state.status === 'loading' || state.status === 'idle' ? (
          <Space direction="vertical">
            <Spin aria-label={t(TEXT.loading)} />
            {slowLoad ? <Typography.Text type="secondary">{t(TEXT.slowLoadHint)}</Typography.Text> : null}
          </Space>
        ) : state.status === 'error' ? (
          <Alert
            type="error"
            showIcon
            message={`${t(TEXT.loadFailed)}: ${state.message}`}
            action={
              <Button size="small" onClick={() => load()}>
                {t(TEXT.retry)}
              </Button>
            }
          />
        ) : context && row && target ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <ProductSummary row={row} t={t} />
            {row.order ? <OrderSummary row={row} t={t} /> : null}
            <Divider style={{ margin: '4px 0' }} />
            <DrawerBody
              pane={target.pane}
              row={row}
              context={context}
              run={runMutation}
              submitting={submitting}
              t={t}
              navigate={navigate}
            />
            <FamilyContext context={context} t={t} />
          </Space>
        ) : null}
      </div>
    </Drawer>
  );
};

function paneTitle(pane: PaneKey): string {
  const byPane: Record<PaneKey, string> = {
    supplyAction: TEXT.paneSupplyAction,
    activeOrders: TEXT.paneActiveOrders,
    inPrepMonitoring: TEXT.paneInPrepMonitoring,
    inboundMonitoring: TEXT.paneInboundMonitoring,
    healthyInventory: TEXT.paneHealthyInventory,
    excessInventory: TEXT.paneExcessInventory,
    stuckInventory: TEXT.paneStuckInventory,
    zeroStock: TEXT.paneZeroStock,
    dataReadiness: TEXT.paneDataReadiness,
    performanceReview: TEXT.panePerformanceReview,
    untieredProducts: TEXT.paneUntieredProducts,
  };
  return byPane[pane];
}

interface DrawerBodyProps {
  pane: PaneKey;
  row: DashboardRow;
  context: DrawerContextResponse;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
  navigate?: (path: string) => void;
}

function DrawerBody({ pane, row, context, run, submitting, t, navigate }: DrawerBodyProps) {
  const orderId = row.order?.orderId;
  const supplierId = row.order?.supplierId ?? null;
  switch (pane) {
    case 'activeOrders':
      return orderId ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <StatusForm
            orderId={orderId}
            currentStatus={row.order?.clickupStatus ?? null}
            run={run}
            submitting={submitting}
            t={t}
          />
          <EtaForm orderId={orderId} run={run} submitting={submitting} t={t} />
          <CommentForm orderId={orderId} run={run} submitting={submitting} t={t} />
        </Space>
      ) : null;
    case 'inPrepMonitoring':
      return orderId ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <PrepDetailsForm orderId={orderId} run={run} submitting={submitting} t={t} />
          {supplierId ? (
            <ShipRouteForm
              supplierId={supplierId}
              current={row.order?.supplierShipDestination ?? null}
              run={run}
              submitting={submitting}
              t={t}
            />
          ) : null}
          {row.order?.needsFollowUp ? (
            <Button
              size="small"
              disabled={submitting}
              onClick={() => run('ecobaseOrderPlanning:addComment', { orderId, body: t(TEXT.drawerFollowUpAck) })}
            >
              {t(TEXT.drawerAcknowledgeFollowUp)}
            </Button>
          ) : null}
          <CommentForm orderId={orderId} run={run} submitting={submitting} t={t} />
        </Space>
      ) : null;
    case 'inboundMonitoring':
      return orderId ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <EtaForm orderId={orderId} run={run} submitting={submitting} t={t} />
          {supplierId ? (
            <ShipRouteForm
              supplierId={supplierId}
              current={row.order?.supplierShipDestination ?? null}
              run={run}
              submitting={submitting}
              t={t}
            />
          ) : null}
          <CommentForm orderId={orderId} run={run} submitting={submitting} t={t} />
        </Space>
      ) : null;
    case 'supplyAction':
      return (
        <Space direction="vertical" size="middle">
          <Typography.Text>
            {`${t(TEXT.drawerSuggestedQty)}: ${formatNumber(row.recommendedOrderQty, t)}`}
          </Typography.Text>
          <Button
            type="primary"
            onClick={() =>
              navigate?.(
                `${ORDER_PLANNING_PATH}?search=${encodeURIComponent(row.identity?.sku ?? row.identity?.asin ?? '')}`,
              )
            }
          >
            {t(TEXT.drawerOpenOrderPlanning)}
          </Button>
        </Space>
      );
    case 'stuckInventory':
      return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <ReasonList title={t(TEXT.drawerStuckReasons)} reasons={row.reasonCodes} t={t} />
          {orderId ? <CommentForm orderId={orderId} run={run} submitting={submitting} t={t} /> : null}
        </Space>
      );
    case 'dataReadiness':
      return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <ReasonList title={t(TEXT.drawerReadinessReasons)} reasons={row.reasonCodes} t={t} />
          <Space wrap>
            <Button
              size="small"
              onClick={() =>
                navigate?.(
                  `/admin/ecobase/inventory-planning?search=${encodeURIComponent(
                    row.identity?.sku ?? row.identity?.asin ?? '',
                  )}`,
                )
              }
            >
              {t(TEXT.drawerOpenInventoryPlanning)}
            </Button>
            <Button
              size="small"
              onClick={() =>
                navigate?.(
                  `/admin/ecobase/supplier-management?search=${encodeURIComponent(
                    row.order?.supplierName ?? row.identity?.sku ?? '',
                  )}`,
                )
              }
            >
              {t(TEXT.drawerOpenSupplierManagement)}
            </Button>
          </Space>
        </Space>
      );
    case 'performanceReview':
      return <BandVisual points={context.performanceEvidence} t={t} />;
    case 'untieredProducts':
      return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <ReasonList title={t(TEXT.drawerTierEvidence)} reasons={row.reasonCodes} t={t} />
        </Space>
      );
    default:
      // healthyInventory, excessInventory, zeroStock: read-only evidence (+ comment when an order exists).
      return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {orderId ? <CommentForm orderId={orderId} run={run} submitting={submitting} t={t} /> : null}
        </Space>
      );
  }
}

export default PaneDrawer;
