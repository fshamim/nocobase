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

import { Alert, App, Button, Divider, Drawer, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { DashboardRow, DrawerContextResponse, PaneKey } from '../server/contract';
import { isRunSuperseded, PRODUCT_TABLE_PANES } from '../server/contract';
import { paneTitle, TEXT } from './dashboard-text';
import {
  AssignSupplierForm,
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
import { type Translate } from './format';
import { SupplyActionDrawerBody } from './SupplyActionDrawerBody';
import { recentTierOf } from './widgets/recent-tier';

/** QA item 4: mutations that confirm success with a toast. */
const MUTATION_SUCCESS_TEXT: Record<string, string> = {
  'ecobaseInventoryDashboard:reactivateFamily': TEXT.toastFamilyReactivated,
  'ecobaseInventoryDashboard:setFamilyPreferredSupplier': TEXT.toastSupplierAssigned,
  // T8b: the supplyAction drawer's action bar.
  'ecobaseInventoryDashboard:createPlannedOrder': TEXT.toastOrderCreated,
  'ecobaseInventoryDashboard:setFamilyTarget': TEXT.toastTargetChanged,
  'ecobaseInventoryDashboard:updateSupplierLeadTime': TEXT.toastLeadTimeUpdated,
  'ecobaseInventoryDashboard:updateProductPlanningFields': TEXT.toastStatusSaved,
  'ecobaseInventoryDashboard:addComment': TEXT.toastCommentPosted,
  'ecobaseInventoryDashboard:addProductComment': TEXT.toastCommentPosted,
};

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
  /** T8b (W5): successful mutations mark the family in the sync registry. */
  markPending?: (familyKey: string) => void;
  pendingFamilies?: ReadonlySet<string>;
}

type DrawerState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; context: DrawerContextResponse }
  | { status: 'error'; message: string };

function primaryOrderRow(context: DrawerContextResponse, orderId?: string): DashboardRow | undefined {
  // QA blocker (item 1): only an explicit order click selects an order row —
  // family-grain clicks must always render the API's primaryRow identity,
  // never a sibling's order row.
  return orderId ? context.orderRows.find((row) => row.order?.orderId === orderId) : undefined;
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
  markPending,
  pendingFamilies,
}) => {
  const [state, setState] = useState<DrawerState>({ status: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);
  const { message } = App.useApp();
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

  // T-QA1 fix: after an in-session comment post the OPEN drawer's thread must
  // update in place. Same pinned-run request as load(), but the 'loaded' state
  // is only REPLACED on success — no loading flash, so the v2 body keeps its
  // tab + composer state (no remount).
  const refreshContext = useCallback(async () => {
    if (!target) return;
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
      if (!isDrawerContextPayload(data) || isRunSuperseded(data)) return;
      setState({ status: 'loaded', context: data });
    } catch {
      // Background refresh only — the posted comment already succeeded; the
      // stale thread heals on the next open if this refetch fails.
    }
  }, [api, target, runId]);

  // Task 006 + Batch B3: server-driven typeahead — the search text and the drawer's
  // family run in the DB query (suppliers beyond the first slice stay findable; suppliers
  // with order history for this family rank first).
  const loadSupplierOptions = useCallback(
    async (search?: string): Promise<Array<{ label: string; value: string }>> => {
      const data = unwrapEnvelope(
        await api.request({
          url: 'ecobaseSupplierManagement:supplierOptions',
          method: 'post',
          data: { limit: 50, search: search?.trim() || undefined, familyId: target?.familyId },
        }),
      );
      if (!Array.isArray(data)) return [];
      return data.flatMap((entry) => {
        const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
        const value = typeof record.value === 'string' ? record.value : null;
        const label = typeof record.label === 'string' ? record.label : value;
        return value ? [{ value, label: label ?? value }] : [];
      });
    },
    [api, target],
  );

  const runMutation: RunDrawerMutation = useCallback(
    async (url, data) => {
      if (submitting || !target) return false;
      setSubmitting(true);
      setMutationError(null);
      try {
        await api.request({ url, method: 'post', data });
        markPending?.(target.familyId); // W5: pending until the next publish lands
        onMutated(target.pane); // scoped refresh: affected pane + header only
        // T-QA1: comment posts refresh the open drawer's thread in place.
        if (url === 'ecobaseInventoryDashboard:addProductComment' || url === 'ecobaseInventoryDashboard:addComment') {
          await refreshContext();
        }
        const successText = MUTATION_SUCCESS_TEXT[url];
        if (successText) message.success(t(successText));
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
    [api, submitting, target, onMutated, message, t, refreshContext, markPending],
  );

  const context = state.status === 'loaded' ? state.context : null;
  const orderRow = context && target ? primaryOrderRow(context, target.orderId) : undefined;
  const row = orderRow ?? context?.primaryRow;

  // T8b (D7): the Data tab's on-demand full record — one extra fetch, first open only.
  const fetchRaw = useCallback(async (): Promise<Record<string, unknown> | null> => {
    if (!target) return null;
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
          includeRaw: true,
        },
      }),
    );
    if (!isDrawerContextPayload(data) || isRunSuperseded(data)) return null;
    return data.rawGoldRow ?? null;
  }, [api, target, runId]);

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
          PRODUCT_TABLE_PANES.has(target.pane) ? (
            // 063 D5: every product pane opens the same rich drawer; the order
            // panes, Data Readiness and Performance Review keep their v1 bodies.
            <SupplyActionDrawerBody
              row={row}
              context={context}
              familyId={target.familyId}
              orderId={target.orderId}
              pendingSync={Boolean(pendingFamilies?.has(target.familyId))}
              run={runMutation}
              submitting={submitting}
              t={t}
              loadSupplierOptions={loadSupplierOptions}
              fetchRaw={fetchRaw}
              api={api}
              onOrderMutated={() => onMutated(target.pane)}
            />
          ) : (
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
                loadSupplierOptions={loadSupplierOptions}
              />
              <FamilyContext context={context} t={t} />
            </Space>
          )
        ) : null}
      </div>
    </Drawer>
  );
};

interface DrawerBodyProps {
  pane: PaneKey;
  row: DashboardRow;
  context: DrawerContextResponse;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
  navigate?: (path: string) => void;
  loadSupplierOptions: (search?: string) => Promise<Array<{ label: string; value: string }>>;
}

function DrawerBody({ pane, row, context, run, submitting, t, navigate, loadSupplierOptions }: DrawerBodyProps) {
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
    case 'dataReadiness':
      return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <ReasonList title={t(TEXT.drawerReadinessReasons)} reasons={row.reasonCodes} t={t} />
          <TargetProvenance context={context} t={t} />
          {/* 065: membership tests read the RECENT tier — baseline never gates. */}
          {recentTierOf(row.tier) ? (
            <AssignSupplierForm
              familyId={row.identity.familyKey}
              loadSupplierOptions={loadSupplierOptions}
              run={run}
              submitting={submitting}
              t={t}
            />
          ) : null}
          <Space wrap>
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
      return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <TargetProvenance context={context} t={t} />
          <BandVisual points={context.performanceEvidence} t={t} />
        </Space>
      );
    default:
      // 063 D5: every product pane routes to the rich body before it reaches here.
      return null;
  }
}

/** QA item 2: which member is the family target, and how it was selected. */
function TargetProvenance({ context, t }: { context: DrawerContextResponse; t: Translate }) {
  const target = context.familyTarget;
  const targetMember = context.familyMembers.find((member) => member.isTarget);
  return (
    <Typography.Text>
      {`${t(TEXT.drawerFamilyTarget)}: ${
        targetMember
          ? targetMember.sku ?? targetMember.asin ?? targetMember.listingRowId
          : t(TEXT.drawerNoTargetInReview)
      }`}
      {target?.selectionRule || target?.selectionSource ? (
        <Typography.Text type="secondary">{` — ${target?.selectionRule ?? target?.selectionSource}`}</Typography.Text>
      ) : null}
    </Typography.Text>
  );
}

export default PaneDrawer;
