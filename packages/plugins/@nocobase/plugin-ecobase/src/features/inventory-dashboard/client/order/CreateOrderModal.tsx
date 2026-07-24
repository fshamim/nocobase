/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Create order modal (Order Create/View UI, T4) — replaces the bare
 * CreateOrderModal. Editable canonical ref with live uniqueness check, server
 * supplier + product typeaheads, an optional payment/shipping panel, a per-line
 * editor with live margin/total, and footer stat tiles. Form state only; the
 * workbench service owns all business logic.
 */

import { App, Button, Collapse, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TEXT } from '../dashboard-text';
import { EM_DASH, formatMoney, type Translate } from '../format';
import { lineMargin, lineTotal, sumLineTotals, sumUnits } from './order-compute';
import {
  createOrderApi,
  type OrderProductOption,
  type OrderRequestClient,
  type OrderSupplierOption,
} from './order-api';

interface EditorLine {
  key: string;
  companyProductId: string | null;
  title?: string;
  asin?: string;
  sku?: string;
  orderedQty: number | null;
  unitCost: number | null;
  supplierPackSize: number | null;
  expectedSellPrice: number | null;
}

export interface CreateOrderModalProps {
  open: boolean;
  api: OrderRequestClient;
  t: Translate;
  planningProductId: string | null;
  familyId?: string;
  familyLabel?: string;
  onClose: () => void;
  onCreated: (orderId: string) => void;
}

let lineSeq = 0;
const nextLineKey = () => `line-${(lineSeq += 1)}`;

const STAT_TILE: React.CSSProperties = {
  border: '1px solid #f0f0f0',
  borderRadius: 10,
  padding: '8px 12px',
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
const NUM_INPUT: React.CSSProperties = { width: '100%' };

export function CreateOrderModal(props: CreateOrderModalProps) {
  const { open, api, t, planningProductId, familyId, familyLabel, onClose, onCreated } = props;
  const orderApi = useMemo(() => createOrderApi(api), [api]);
  const { message } = App.useApp();

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string>('');
  const [orderRef, setOrderRef] = useState('');
  const [refState, setRefState] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [orderDate, setOrderDate] = useState<string>(dayjs().format('YYYY-MM-DD'));
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [supplierOptions, setSupplierOptions] = useState<OrderSupplierOption[]>([]);
  const [marketplace, setMarketplace] = useState<string>('US');
  const [placedBy, setPlacedBy] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [lines, setLines] = useState<EditorLine[]>([]);
  const [productOptions, setProductOptions] = useState<OrderProductOption[]>([]);
  // Optional payment & shipping.
  const [paymentStatus, setPaymentStatus] = useState<string>('');
  const [paymentMode, setPaymentMode] = useState<string>('');
  const [paymentDate, setPaymentDate] = useState<string>('');
  const [invoiceNo, setInvoiceNo] = useState<string>('');
  const [carrier, setCarrier] = useState<string>('');
  const [tracking, setTracking] = useState<string>('');
  const [expectedDelivery, setExpectedDelivery] = useState<string>('');
  const [expectedSellable, setExpectedSellable] = useState<string>('');

  const supplierSeq = useRef(0);
  const productSeq = useRef(0);
  const refSeq = useRef(0);

  // ---- load draft on open ----
  useEffect(() => {
    if (!open || !planningProductId) return;
    let active = true;
    setLoading(true);
    const loadDraft = async () => {
      try {
        const draft = await orderApi.prepareOrderDraft(planningProductId);
        if (!active) return;
        setCompanyId(draft.companyId);
        setCompanyName(draft.companyName ?? '');
        setOrderRef(draft.suggestedOrderRef ?? '');
        setOrderDate(draft.orderDate ?? dayjs().format('YYYY-MM-DD'));
        setSupplierId(draft.supplierDefault?.supplierId ?? null);
        setPlacedBy(draft.placedBy ?? '');
        setSupplierOptions(
          draft.supplierDefault
            ? [{ value: draft.supplierDefault.supplierId, label: draft.supplierDefault.displayName }]
            : [],
        );
        setLines([
          {
            key: nextLineKey(),
            companyProductId: draft.product.companyProductId ?? null,
            title: draft.product.title,
            asin: draft.product.asin,
            sku: draft.product.sku,
            orderedQty: null,
            unitCost: null,
            supplierPackSize: 1,
            expectedSellPrice: null,
          },
        ]);
      } catch {
        if (active) message.error(t(TEXT.unexpectedResponse));
      } finally {
        if (active) setLoading(false);
      }
    };
    loadDraft();
    return () => {
      active = false;
    };
  }, [open, planningProductId, orderApi, message, t]);

  // ---- live ref uniqueness check (debounced) ----
  useEffect(() => {
    if (!open || !companyId || !orderRef.trim()) {
      setRefState('idle');
      return;
    }
    const seq = (refSeq.current += 1);
    setRefState('checking');
    const handle = setTimeout(() => {
      orderApi
        .checkOrderRef(companyId, orderRef)
        .then((result) => {
          if (seq !== refSeq.current) return;
          setRefState(result.available ? 'available' : 'taken');
        })
        .catch(() => {
          if (seq === refSeq.current) setRefState('idle');
        });
    }, 350);
    return () => clearTimeout(handle);
  }, [open, companyId, orderRef, orderApi]);

  const loadSuppliers = useCallback(
    async (search?: string) => {
      const seq = (supplierSeq.current += 1);
      const options = await orderApi.supplierOptions(search, familyId);
      if (seq === supplierSeq.current) setSupplierOptions(options);
    },
    [orderApi, familyId],
  );

  const loadProducts = useCallback(
    async (search?: string) => {
      if (!companyId) return;
      const seq = (productSeq.current += 1);
      const options = await orderApi.productOptions(companyId, search);
      if (seq === productSeq.current) setProductOptions(options);
    },
    [orderApi, companyId],
  );

  const updateLine = useCallback((key: string, patch: Partial<EditorLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }, []);

  const addLine = useCallback(() => {
    setLines((current) => [
      ...current,
      {
        key: nextLineKey(),
        companyProductId: null,
        orderedQty: null,
        unitCost: null,
        supplierPackSize: 1,
        expectedSellPrice: null,
      },
    ]);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((current) => (current.length <= 1 ? current : current.filter((line) => line.key !== key)));
  }, []);

  const validLines = lines.filter((line) => line.companyProductId && (line.orderedQty ?? 0) > 0);
  const totalUnits = sumUnits(validLines);
  const totalCost = sumLineTotals(validLines);
  const canSubmit =
    refState !== 'taken' && Boolean(orderRef.trim()) && Boolean(supplierId) && validLines.length > 0 && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit || !companyId || !supplierId) {
      if (!supplierId) message.warning(t(TEXT.ocNeedSupplier));
      else if (validLines.length === 0) message.warning(t(TEXT.ocNeedLine));
      else if (!orderRef.trim()) message.warning(t(TEXT.ocRefRequired));
      return;
    }
    setSubmitting(true);
    try {
      const detail = await orderApi.createOrder({
        companyId,
        orderRef: orderRef.trim(),
        orderDate,
        supplierId,
        sourceMarketplace: marketplace || undefined,
        paymentStatus: paymentStatus || undefined,
        paymentMode: paymentMode || undefined,
        paymentDate: paymentDate || undefined,
        attachmentReference: invoiceNo || undefined,
        shippingCarrier: carrier || undefined,
        trackingId: tracking || undefined,
        expectedDeliveryDate: expectedDelivery || undefined,
        remarks: notes || undefined,
        lines: validLines.map((line) => ({
          companyProductId: line.companyProductId,
          orderedQty: line.orderedQty,
          unitCost: line.unitCost ?? undefined,
          supplierPackSize: line.supplierPackSize ?? undefined,
          expectedSellPrice: line.expectedSellPrice ?? undefined,
          expectedSellableDate: expectedSellable || undefined,
        })),
      });
      message.success(t(TEXT.toastOrderCreated));
      onCreated(detail.header.id);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t(TEXT.unexpectedResponse));
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    companyId,
    supplierId,
    orderApi,
    orderRef,
    orderDate,
    marketplace,
    paymentStatus,
    paymentMode,
    paymentDate,
    notes,
    invoiceNo,
    carrier,
    tracking,
    expectedDelivery,
    expectedSellable,
    validLines,
    message,
    t,
    onCreated,
    onClose,
  ]);

  const refFeedback =
    refState === 'available' ? (
      <Typography.Text type="success" style={{ fontSize: 12 }}>
        ✓ {t(TEXT.ocRefAvailable)}
      </Typography.Text>
    ) : refState === 'taken' ? (
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        {t(TEXT.ocRefTaken)}
      </Typography.Text>
    ) : null;

  return (
    <Modal
      open={open}
      title={`${t(TEXT.btnCreateOrder)}${familyLabel ? ` — ${familyLabel}` : ''}`}
      width={820}
      onCancel={onClose}
      okText={t(TEXT.ocSubmit)}
      cancelText={t(TEXT.ocCancel)}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      onOk={submit}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Form layout="vertical" component="div" disabled={loading}>
        <Typography.Text style={STAT_LABEL}>{t(TEXT.ocSectionOrder)}</Typography.Text>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 8 }}>
          <Form.Item label={t(TEXT.ocOrderRef)} extra={refFeedback ?? t(TEXT.ocRefHint)} style={{ marginBottom: 8 }}>
            <Input
              value={orderRef}
              aria-label={t(TEXT.ocOrderRef)}
              onChange={(event) => setOrderRef(event.target.value)}
              status={refState === 'taken' ? 'error' : undefined}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.companyFilterLabel)} style={{ marginBottom: 8 }}>
            <Input value={companyName} readOnly aria-label={t(TEXT.companyFilterLabel)} />
          </Form.Item>
          <Form.Item label={t(TEXT.ocOrderDate)} style={{ marginBottom: 8 }}>
            <DatePicker
              value={orderDate ? dayjs(orderDate) : null}
              onChange={(_, dateString) => setOrderDate(Array.isArray(dateString) ? dateString[0] : dateString)}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocOrderDate)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.drawerSupplier)} style={{ marginBottom: 8 }}>
            <Select
              showSearch
              value={supplierId ?? undefined}
              placeholder={t(TEXT.drawerSupplier)}
              aria-label={t(TEXT.drawerSupplier)}
              options={supplierOptions}
              filterOption={false}
              onSearch={(text) => loadSuppliers(text)}
              onDropdownVisibleChange={(visible) => {
                if (visible && supplierOptions.length <= 1) loadSuppliers();
              }}
              onChange={(value: string) => setSupplierId(value)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocMarketplace)} style={{ marginBottom: 8 }}>
            <Select
              value={marketplace}
              onChange={setMarketplace}
              aria-label={t(TEXT.ocMarketplace)}
              options={[
                { value: 'US', label: 'USA' },
                { value: 'UK', label: 'UK' },
              ]}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocPlacedBy)} style={{ marginBottom: 8 }}>
            <Input value={placedBy} readOnly placeholder={t(TEXT.ocPlacedBy)} aria-label={t(TEXT.ocPlacedBy)} />
          </Form.Item>
          <Form.Item label={t(TEXT.notesLabel)} style={{ marginBottom: 8, gridColumn: '1 / -1' }}>
            <Input.TextArea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              aria-label={t(TEXT.notesLabel)}
            />
          </Form.Item>
        </div>

        <Collapse
          ghost
          items={[
            {
              key: 'payment',
              label: t(TEXT.ocPaymentPanel),
              children: (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                  <Form.Item label={t(TEXT.ocPaymentStatus)} style={{ marginBottom: 8 }}>
                    <Input value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} />
                  </Form.Item>
                  <Form.Item label={t(TEXT.ocPaymentMode)} style={{ marginBottom: 8 }}>
                    <Input
                      value={paymentMode}
                      onChange={(e) => setPaymentMode(e.target.value)}
                      placeholder="ACH / CC"
                    />
                  </Form.Item>
                  <Form.Item label={t(TEXT.ocPaymentDate)} style={{ marginBottom: 8 }}>
                    <DatePicker
                      value={paymentDate ? dayjs(paymentDate) : null}
                      onChange={(_, s) => setPaymentDate(Array.isArray(s) ? s[0] : s)}
                      style={{ width: '100%' }}
                      aria-label={t(TEXT.ocPaymentDate)}
                    />
                  </Form.Item>
                  <Form.Item label={t(TEXT.ocInvoiceNo)} style={{ marginBottom: 8 }}>
                    <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
                  </Form.Item>
                  <Form.Item label={t(TEXT.ocCarrier)} style={{ marginBottom: 8 }}>
                    <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} />
                  </Form.Item>
                  <Form.Item label={t(TEXT.ocTracking)} style={{ marginBottom: 8 }}>
                    <Input value={tracking} onChange={(e) => setTracking(e.target.value)} />
                  </Form.Item>
                  <Form.Item label={t(TEXT.ocExpectedDelivery)} style={{ marginBottom: 8 }}>
                    <DatePicker
                      value={expectedDelivery ? dayjs(expectedDelivery) : null}
                      onChange={(_, s) => setExpectedDelivery(Array.isArray(s) ? s[0] : s)}
                      style={{ width: '100%' }}
                      aria-label={t(TEXT.ocExpectedDelivery)}
                    />
                  </Form.Item>
                  <Form.Item label={t(TEXT.ocExpectedSellable)} style={{ marginBottom: 8 }}>
                    <DatePicker
                      value={expectedSellable ? dayjs(expectedSellable) : null}
                      onChange={(_, s) => setExpectedSellable(Array.isArray(s) ? s[0] : s)}
                      style={{ width: '100%' }}
                      aria-label={t(TEXT.ocExpectedSellable)}
                    />
                  </Form.Item>
                </div>
              ),
            },
          ]}
        />

        <Typography.Text style={{ ...STAT_LABEL, display: 'block', marginTop: 12 }}>
          {t(TEXT.ocProductsSection)} · {validLines.length}
        </Typography.Text>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle}>{t(TEXT.colProduct)}</th>
                <th style={thNum}>{t(TEXT.ocColQty)}</th>
                <th style={thNum}>{t(TEXT.ocColUnitCost)}</th>
                <th style={thNum}>{t(TEXT.ocColPack)}</th>
                <th style={thNum}>{t(TEXT.ocColSellPrice)}</th>
                <th style={thNum}>{t(TEXT.ocColMargin)}</th>
                <th style={thNum}>{t(TEXT.ocColTotal)}</th>
                <th style={thStyle} aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const margin = lineMargin(line.expectedSellPrice, line.unitCost);
                const total = lineTotal(line.orderedQty, line.unitCost);
                return (
                  <tr key={line.key}>
                    <td style={{ ...tdStyle, minWidth: 220 }}>
                      {line.companyProductId ? (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <Typography.Text strong style={{ fontSize: 13 }}>
                            {line.title ?? EM_DASH}
                          </Typography.Text>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}
                          >
                            {[line.asin, line.sku].filter(Boolean).join(' · ') || EM_DASH}
                          </Typography.Text>
                        </div>
                      ) : (
                        <Select
                          showSearch
                          placeholder={t(TEXT.ocSearchProduct)}
                          aria-label={t(TEXT.ocSearchProduct)}
                          style={{ width: '100%' }}
                          filterOption={false}
                          onSearch={(text) => loadProducts(text)}
                          onDropdownVisibleChange={(visible) => {
                            if (visible && productOptions.length === 0) loadProducts();
                          }}
                          options={productOptions.map((option) => ({
                            value: option.companyProductId,
                            label: `${option.title ?? ''} · ${[option.asin, option.sku].filter(Boolean).join(' · ')}`,
                          }))}
                          onChange={(value: string) => {
                            const option = productOptions.find((candidate) => candidate.companyProductId === value);
                            updateLine(line.key, {
                              companyProductId: value,
                              title: option?.title,
                              asin: option?.asin,
                              sku: option?.sku,
                              unitCost: line.unitCost ?? option?.unitCost ?? null,
                            });
                          }}
                        />
                      )}
                    </td>
                    <td style={tdNum}>
                      <InputNumber
                        value={line.orderedQty}
                        min={0}
                        aria-label={t(TEXT.qtyLabel)}
                        style={NUM_INPUT}
                        onChange={(value) => updateLine(line.key, { orderedQty: value ?? null })}
                      />
                    </td>
                    <td style={tdNum}>
                      <InputNumber
                        value={line.unitCost}
                        min={0}
                        aria-label={t(TEXT.ocColUnitCost)}
                        style={NUM_INPUT}
                        onChange={(value) => updateLine(line.key, { unitCost: value ?? null })}
                      />
                    </td>
                    <td style={tdNum}>
                      <InputNumber
                        value={line.supplierPackSize}
                        min={1}
                        aria-label={t(TEXT.ocColPack)}
                        style={NUM_INPUT}
                        onChange={(value) => updateLine(line.key, { supplierPackSize: value ?? null })}
                      />
                    </td>
                    <td style={tdNum}>
                      <InputNumber
                        value={line.expectedSellPrice}
                        min={0}
                        aria-label={t(TEXT.ocColSellPrice)}
                        style={NUM_INPUT}
                        onChange={(value) => updateLine(line.key, { expectedSellPrice: value ?? null })}
                      />
                    </td>
                    <td style={{ ...tdNum, color: 'rgba(0,0,0,0.45)' }}>
                      {margin !== undefined ? `${margin}%` : EM_DASH}
                    </td>
                    <td style={tdNum}>
                      <strong>{total !== undefined ? formatMoney(total, t) : EM_DASH}</strong>
                    </td>
                    <td style={tdStyle}>
                      <Button
                        type="text"
                        danger
                        size="small"
                        aria-label={t(TEXT.ocRemoveLine)}
                        disabled={lines.length <= 1}
                        onClick={() => removeLine(line.key)}
                      >
                        ✕
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10 }}>
          <Button size="small" onClick={addLine}>
            ＋ {t(TEXT.ocAddProduct)}
          </Button>
        </div>

        <Space size={10} style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <span style={STAT_TILE}>
            <span style={STAT_LABEL}>{t(TEXT.ocProductsSection)}</span>
            <span style={STAT_VALUE}>{validLines.length}</span>
          </span>
          <span style={STAT_TILE}>
            <span style={STAT_LABEL}>{t(TEXT.ocUnits)}</span>
            <span style={STAT_VALUE}>{totalUnits}</span>
          </span>
          <span style={STAT_TILE}>
            <span style={STAT_LABEL}>{t(TEXT.ocExpectedCost)}</span>
            <span style={STAT_VALUE}>{formatMoney(totalCost, t)}</span>
          </span>
        </Space>
      </Form>
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
const tdStyle: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'middle' };
const tdNum: React.CSSProperties = { ...tdStyle, textAlign: 'right', width: 92 };

export default CreateOrderModal;
