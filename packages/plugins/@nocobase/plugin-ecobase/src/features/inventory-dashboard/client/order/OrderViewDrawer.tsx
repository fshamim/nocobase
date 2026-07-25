/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Order view drawer (Order Create/View UI, T5). Reusable by orderId so any
 * surface can link to an order. Renders the header/pills, stat tiles, KV strip,
 * line table and activity, and hosts the edit-order, set-status, edit-line and
 * add-product popups. All writes go through the workbench service; the drawer
 * refetches getOrderDetail after each mutation and reports success upward.
 */

import { App, Button, Modal, Radio, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TEXT } from '../dashboard-text';
import { EM_DASH, formatDate, formatMoney, type Translate } from '../format';
import { EditLineModal, EditOrderModal, EditPaperworkModal, PrepDetailsSection } from './OrderEditPopups';
import {
  createOrderApi,
  type OrderApi,
  type OrderDetail,
  type OrderRequestClient,
  type OrderStatusOption,
} from './order-api';
import { deriveClientPaperwork } from './order-compute';
import { PaperworkChain } from './order-milestones';
import { AmazonCheckPill, LifecycleStatusPill, ReceiptPill } from './order-pills';

export interface OrderViewDrawerProps {
  open: boolean;
  api: OrderRequestClient;
  t: Translate;
  orderId: string | null;
  onClose: () => void;
  /** Called after any mutation so the parent surface can refresh its own data. */
  onMutated?: () => void;
}

const STAT_TILE: React.CSSProperties = {
  border: '1px solid #f0f0f0',
  borderRadius: 10,
  padding: '10px 12px',
  minWidth: 118,
  display: 'inline-flex',
  flexDirection: 'column',
  gap: 2,
};
const STAT_LABEL: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.45)',
  fontWeight: 600,
};
const STAT_VALUE: React.CSSProperties = { fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' };
const STAT_SUB: React.CSSProperties = { fontSize: 11, color: 'rgba(0,0,0,0.45)' };
const MONO: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 };
const SEC_LABEL: React.CSSProperties = { ...STAT_LABEL, display: 'block', margin: '0 0 8px' };

function StatTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <span style={STAT_TILE}>
      <span style={STAT_LABEL}>{label}</span>
      <span style={STAT_VALUE}>{value}</span>
      {sub ? <span style={STAT_SUB}>{sub}</span> : null}
    </span>
  );
}

function Kv({ label, value }: { label: string; value?: React.ReactNode }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={STAT_LABEL}>{label}</span>
      <span style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}

export function OrderViewDrawer(props: OrderViewDrawerProps) {
  const { open, api, t, orderId, onClose, onMutated } = props;
  const orderApi: OrderApi = useMemo(() => createOrderApi(api), [api]);
  const { message, modal } = App.useApp();

  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [paperworkOpen, setPaperworkOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editLineId, setEditLineId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      setDetail(await orderApi.getOrderDetail(orderId));
    } catch {
      message.error(t(TEXT.unexpectedResponse));
    } finally {
      setLoading(false);
    }
  }, [orderApi, orderId, message, t]);

  useEffect(() => {
    if (open && orderId) load();
    if (!open) setDetail(null);
  }, [open, orderId, load]);

  const afterMutation = useCallback(
    (next: OrderDetail) => {
      setDetail(next);
      onMutated?.();
    },
    [onMutated],
  );

  const header = detail?.header;
  const lines = detail?.lines ?? [];

  const confirmDelete = useCallback(() => {
    if (!header) return;
    modal.confirm({
      title: header.deletable ? t(TEXT.ovDelete) : t(TEXT.ovCancelBtn),
      content: header.deletable ? t(TEXT.ovDeleteConfirmManual) : t(TEXT.ovDeleteConfirmImported),
      okType: 'danger',
      onOk: async () => {
        setBusy(true);
        try {
          const result = await orderApi.deleteOrder(header.id);
          message.success(result.action === 'deleted' ? t(TEXT.ovOrderDeleted) : t(TEXT.ovOrderCancelled));
          onMutated?.();
          if (result.action === 'deleted') onClose();
          else load();
        } catch (error) {
          message.error(error instanceof Error ? error.message : t(TEXT.unexpectedResponse));
        } finally {
          setBusy(false);
        }
      },
    });
  }, [header, modal, orderApi, message, t, onMutated, onClose, load]);

  const deleteLine = useCallback(
    (lineId: string) => {
      modal.confirm({
        title: t(TEXT.ovDeleteLine),
        content: t(TEXT.ovDeleteLineConfirm),
        okType: 'danger',
        onOk: async () => {
          try {
            const next = await orderApi.deleteOrderLine(lineId);
            message.success(t(TEXT.ovLineDeleted));
            afterMutation(next);
          } catch (error) {
            message.error(error instanceof Error ? error.message : t(TEXT.unexpectedResponse));
          }
        },
      });
    },
    [modal, orderApi, message, t, afterMutation],
  );

  const editingLine = lines.find((line) => line.id === editLineId) ?? null;
  const linesTotalCost = lines.reduce((sum, line) => sum + (line.expectedCost ?? 0), 0);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={880}
      destroyOnClose
      footer={null}
      title={header ? header.orderRef ?? EM_DASH : t(TEXT.colOrder)}
      style={{ top: 32 }}
      styles={{ body: { maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' } }}
    >
      <div aria-label={t(TEXT.colOrder)}>
        {loading && !detail ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : !header ? null : (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            {/* header row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ ...MONO, fontSize: 19, fontWeight: 700 }}>{header.orderRef ?? EM_DASH}</span>
                  <LifecycleStatusPill status={header.lifecycleStatus} fallbackLabel={t(TEXT.ovNoStatus)} />
                  {header.paymentStatus ? (
                    <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>
                      {t(TEXT.ocPaymentStatus)} · {header.paymentStatus}
                    </span>
                  ) : null}
                  {header.invoiceStatus ? (
                    <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>
                      {t(TEXT.ovInvoiceLabel)} · {header.invoiceStatus}
                    </span>
                  ) : null}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {[
                    header.companyName,
                    header.supplierName
                      ? header.supplierExternalRef
                        ? `${header.supplierName} (${header.supplierExternalRef})`
                        : header.supplierName
                      : null,
                    header.sourceMarketplace,
                    header.orderDate ? `${t(TEXT.ovOrderedPrefix)} ${formatDate(header.orderDate, t)}` : null,
                    header.placedBy ? `${t(TEXT.ovPlacedByPrefix)} ${header.placedBy}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography.Text>
                {/* T5.2: paperwork milestone chain under the status pill. */}
                <span style={{ marginTop: 2 }}>
                  <PaperworkChain paperwork={deriveClientPaperwork(header)} t={t} />
                </span>
              </div>
              <Space wrap>
                <Button type="primary" size="small" onClick={() => setEditOpen(true)}>
                  {t(TEXT.ovEditOrder)}
                </Button>
                <Button size="small" onClick={() => setStatusOpen(true)}>
                  {t(TEXT.btnSetStatus)}
                </Button>
                <Button size="small" onClick={() => setPaperworkOpen(true)}>
                  {t(TEXT.opEditPaperwork)}
                </Button>
                <Button size="small" danger loading={busy} onClick={confirmDelete}>
                  {header.deletable ? t(TEXT.ovDelete) : t(TEXT.ovCancelBtn)}
                </Button>
              </Space>
            </div>

            {/* stat tiles */}
            <Space size={10} wrap>
              <StatTile label={t(TEXT.ocExpectedCost)} value={formatMoney(header.expectedCost ?? null, t)} />
              <StatTile
                label={t(TEXT.ovActualCost)}
                value={formatMoney(header.actualCost ?? null, t)}
                sub={
                  header.actualCost !== undefined && header.expectedCost !== undefined
                    ? `${formatMoney(header.actualCost - header.expectedCost, t)} ${t(TEXT.ovVsExpected)}`
                    : undefined
                }
              />
              <StatTile
                label={t(TEXT.ocUnits)}
                value={header.orderedUnits}
                sub={`${header.productCount} ${t(TEXT.ovProductsSub)}`}
              />
              <StatTile label={t(TEXT.ovReceivedOnAmazon)} value={`${header.observedUnits} / ${header.orderedUnits}`} />
            </Space>

            {/* KV strip */}
            <Space size={22} wrap>
              <Kv label={t(TEXT.ocPaymentMode)} value={header.paymentMode} />
              <Kv
                label={t(TEXT.ocPaymentDate)}
                value={header.paymentDate ? formatDate(header.paymentDate, t) : undefined}
              />
              <Kv
                label={t(TEXT.ocInvoiceNo)}
                value={header.attachmentReference ? <span style={MONO}>{header.attachmentReference}</span> : undefined}
              />
              <Kv label={t(TEXT.ovCarrier)} value={header.shippingCarrier} />
              <Kv
                label={t(TEXT.ovTrackingShort)}
                value={header.trackingId ? <span style={MONO}>{header.trackingId}</span> : undefined}
              />
              <Kv label={t(TEXT.ovApproval)} value={header.orderApproval} />
            </Space>

            {header.remarks ? (
              <div
                style={{
                  fontSize: 12.5,
                  background: '#fafafa',
                  border: '1px solid #f0f0f0',
                  borderRadius: 10,
                  padding: '7px 11px',
                  width: 'fit-content',
                }}
              >
                {header.remarks}
              </div>
            ) : null}

            {/* T5.1: prep details — auto-expanded when the order is at the prep stage. */}
            <PrepDetailsSection
              orderApi={orderApi}
              t={t}
              header={header}
              defaultExpanded={header.workflowStage === 'in_prep'}
              onSaved={afterMutation}
            />

            {/* lines */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                <span style={SEC_LABEL}>
                  {t(TEXT.ovOrderLines)} · {lines.length}
                </span>
                <Button size="small" onClick={() => setAddOpen(true)}>
                  ＋ {t(TEXT.ocAddProduct)}
                </Button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t(TEXT.colProduct)}</th>
                      <th style={thNum}>{t(TEXT.ocColQty)}</th>
                      <th style={thNum}>{t(TEXT.ocColUnitCost)}</th>
                      <th style={thNum}>{t(TEXT.ocColTotal)}</th>
                      <th style={thNum}>{t(TEXT.ocColSellPrice)}</th>
                      <th style={thNum}>{t(TEXT.ocColMargin)}</th>
                      <th style={thStyle}>{t(TEXT.ovAmazonCheck)}</th>
                      <th style={thStyle}>{t(TEXT.ovReceipt)}</th>
                      <th style={thStyle} aria-label="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td style={{ ...tdStyle, minWidth: 210 }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Typography.Text strong style={{ fontSize: 13 }}>
                              {line.title ?? EM_DASH}
                            </Typography.Text>
                            <span style={{ ...MONO, color: 'rgba(0,0,0,0.45)' }}>
                              {[line.asin, line.sku, line.brand].filter(Boolean).join(' · ') || EM_DASH}
                            </span>
                          </div>
                        </td>
                        <td style={tdNum}>{line.orderedQty}</td>
                        <td style={tdNum}>{formatMoney(line.unitCost ?? null, t)}</td>
                        <td style={tdNum}>{formatMoney(line.expectedCost ?? null, t)}</td>
                        <td style={tdNum}>{formatMoney(line.expectedSellPrice ?? null, t)}</td>
                        <td style={tdNum}>{line.expectedMargin !== undefined ? `${line.expectedMargin}%` : EM_DASH}</td>
                        <td style={tdStyle}>
                          <AmazonCheckPill status={line.amazonCheckStatus} />
                        </td>
                        <td style={tdStyle}>
                          <ReceiptPill
                            status={line.amazonReceiptStatus}
                            observed={line.receivedQty}
                            ordered={line.orderedQty}
                            observedLabel={t(TEXT.ovObserved)}
                            awaitingLabel={t(TEXT.ovAwaitingStock)}
                          />
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                          <Button
                            type="text"
                            size="small"
                            aria-label={t(TEXT.ovEditLine)}
                            onClick={() => setEditLineId(line.id ?? null)}
                          >
                            ✎
                          </Button>
                          <Button
                            type="text"
                            danger
                            size="small"
                            aria-label={t(TEXT.ovDeleteLine)}
                            onClick={() => line.id && deleteLine(line.id)}
                          >
                            ✕
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ ...tdStyle, fontWeight: 700, background: '#fafafa' }}>{t(TEXT.ocColTotal)}</td>
                      <td style={{ ...tdNum, fontWeight: 700, background: '#fafafa' }}>{header.orderedUnits}</td>
                      <td style={{ ...tdNum, background: '#fafafa' }} />
                      <td style={{ ...tdNum, fontWeight: 700, background: '#fafafa' }}>
                        {formatMoney(linesTotalCost, t)}
                      </td>
                      <td colSpan={5} style={{ ...tdStyle, background: '#fafafa' }} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* activity */}
            <div>
              <span style={SEC_LABEL}>{t(TEXT.ovActivity)}</span>
              {detail && detail.activity.length > 0 ? (
                <Space direction="vertical" size={6} style={{ fontSize: 12.5 }}>
                  {detail.activity.map((entry, index) => (
                    <span key={`${entry.kind}-${index}`}>
                      <Typography.Text type="secondary">{entry.at ? formatDate(entry.at, t) : EM_DASH}</Typography.Text>
                      {' — '}
                      {entry.summary}
                    </span>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  {t(TEXT.ovNoActivity)}
                </Typography.Text>
              )}
            </div>
          </Space>
        )}
      </div>

      {header ? (
        <>
          <SetStatusModal
            open={statusOpen}
            orderApi={orderApi}
            t={t}
            orderId={header.id}
            currentStatus={header.lifecycleStatus}
            onClose={() => setStatusOpen(false)}
            onSaved={afterMutation}
          />
          <EditOrderModal
            open={editOpen}
            orderApi={orderApi}
            t={t}
            header={header}
            onClose={() => setEditOpen(false)}
            onSaved={afterMutation}
          />
          <EditPaperworkModal
            open={paperworkOpen}
            orderApi={orderApi}
            t={t}
            header={header}
            onClose={() => setPaperworkOpen(false)}
            onSaved={afterMutation}
          />
          <EditLineModal
            open={Boolean(editingLine)}
            orderApi={orderApi}
            t={t}
            line={editingLine}
            onClose={() => setEditLineId(null)}
            onSaved={afterMutation}
          />
          <EditLineModal
            open={addOpen}
            orderApi={orderApi}
            t={t}
            addToOrderId={header.id}
            companyId={header.companyId}
            onClose={() => setAddOpen(false)}
            onSaved={afterMutation}
          />
        </>
      ) : null}
    </Modal>
  );
}

/** Set-status pick list: the 11 statuses, coloured pills, grouped by stage. */
function SetStatusModal(props: {
  open: boolean;
  orderApi: OrderApi;
  t: Translate;
  orderId: string;
  currentStatus?: string;
  onClose: () => void;
  onSaved: (next: OrderDetail) => void;
}) {
  const { open, orderApi, t, orderId, currentStatus, onClose, onSaved } = props;
  const { message } = App.useApp();
  const [options, setOptions] = useState<OrderStatusOption[]>([]);
  const [selected, setSelected] = useState<string | undefined>(currentStatus);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(currentStatus);
    orderApi
      .orderStatusOptions()
      .then(setOptions)
      .catch(() => setOptions([]));
  }, [open, currentStatus, orderApi]);

  const groups: Array<{ stage: OrderStatusOption['stage']; label: string }> = [
    { stage: 'before_ordered', label: t(TEXT.ovStageBefore) },
    { stage: 'after_ordered', label: t(TEXT.ovStageAfter) },
    { stage: 'complete', label: t(TEXT.ocComplete) },
  ];

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const next = await orderApi.setOrderStatus(orderId, selected);
      message.success(t(TEXT.ovStatusUpdated));
      onSaved(next);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t(TEXT.unexpectedResponse));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t(TEXT.ovSetStatusTitle)}
      okText={t(TEXT.drawerSave)}
      cancelText={t(TEXT.ocCancel)}
      onOk={save}
      okButtonProps={{ disabled: !selected, loading: saving }}
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnClose
    >
      <Radio.Group value={selected} onChange={(event) => setSelected(event.target.value)} style={{ width: '100%' }}>
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {groups.map((group) => {
            const groupOptions = options.filter((option) => option.stage === group.stage);
            if (groupOptions.length === 0) return null;
            return (
              <div key={group.stage}>
                <div style={STAT_LABEL}>{group.label}</div>
                <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
                  {groupOptions.map((option) => (
                    <Radio key={option.value} value={option.value} style={{ width: '100%' }}>
                      <Space>
                        <LifecycleStatusPill status={option.value} />
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {option.description}
                        </Typography.Text>
                      </Space>
                    </Radio>
                  ))}
                </Space>
              </div>
            );
          })}
        </Space>
      </Radio.Group>
    </Modal>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 10.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.45)',
  fontWeight: 600,
  padding: '6px 8px',
  borderBottom: '1px solid #f0f0f0',
  whiteSpace: 'nowrap',
};
const thNum: React.CSSProperties = { ...thStyle, textAlign: 'right' };
const tdStyle: React.CSSProperties = { padding: '8px 8px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' };
const tdNum: React.CSSProperties = { ...tdStyle, textAlign: 'right' };

export default OrderViewDrawer;
