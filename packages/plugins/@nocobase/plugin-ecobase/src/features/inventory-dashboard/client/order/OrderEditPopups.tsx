/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Order edit popups (Order Create/View UI, T5): the edit-order-header modal and
 * the edit-line / add-product modal. Form state only; the workbench service
 * validates and recomputes on save.
 */

import { App, DatePicker, Form, Input, InputNumber, Modal, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TEXT } from '../dashboard-text';
import { type Translate } from '../format';
import type { OrderApi, OrderHeaderDetail, OrderLineDetail, OrderProductOption } from './order-api';

type OrderDetailResult = Awaited<ReturnType<OrderApi['getOrderDetail']>>;

function dateValue(value?: string) {
  return value ? dayjs(value) : null;
}
function dateString(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

/** Edit order header — mirrors updateOrderHeader's whitelist, with live ref check. */
export function EditOrderModal(props: {
  open: boolean;
  orderApi: OrderApi;
  t: Translate;
  header: OrderHeaderDetail;
  onClose: () => void;
  onSaved: (next: OrderDetailResult) => void;
}) {
  const { open, orderApi, t, header, onClose, onSaved } = props;
  const { message } = App.useApp();
  const [orderRef, setOrderRef] = useState(header.orderRef ?? '');
  const [refState, setRefState] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [orderDate, setOrderDate] = useState(header.orderDate ?? '');
  const [supplierId, setSupplierId] = useState<string | undefined>(header.supplierId ?? undefined);
  const [supplierOptions, setSupplierOptions] = useState<Array<{ value: string; label: string }>>(
    header.supplierId && header.supplierName ? [{ value: header.supplierId, label: header.supplierName }] : [],
  );
  const [marketplace, setMarketplace] = useState(header.sourceMarketplace ?? '');
  const [paymentStatus, setPaymentStatus] = useState(header.paymentStatus ?? '');
  const [paymentMode, setPaymentMode] = useState(header.paymentMode ?? '');
  const [paymentDate, setPaymentDate] = useState(header.paymentDate ?? '');
  const [invoiceNo, setInvoiceNo] = useState(header.attachmentReference ?? '');
  const [carrier, setCarrier] = useState(header.shippingCarrier ?? '');
  const [tracking, setTracking] = useState(header.trackingId ?? '');
  const [expectedDelivery, setExpectedDelivery] = useState(header.expectedDeliveryDate ?? '');
  const [remarks, setRemarks] = useState(header.remarks ?? '');
  const [saving, setSaving] = useState(false);
  const refSeq = useRef(0);
  const supplierSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setOrderRef(header.orderRef ?? '');
    setRefState('idle');
  }, [open, header.orderRef]);

  useEffect(() => {
    const companyId = header.companyId;
    if (!open || !companyId || !orderRef.trim() || orderRef.trim() === (header.orderRef ?? '')) {
      setRefState('idle');
      return;
    }
    const seq = (refSeq.current += 1);
    setRefState('checking');
    const handle = setTimeout(() => {
      orderApi
        .checkOrderRef(companyId, orderRef, header.id)
        .then((result) => {
          if (seq === refSeq.current) setRefState(result.available ? 'available' : 'taken');
        })
        .catch(() => {
          if (seq === refSeq.current) setRefState('idle');
        });
    }, 350);
    return () => clearTimeout(handle);
  }, [open, header.companyId, header.orderRef, header.id, orderRef, orderApi]);

  const loadSuppliers = async (search?: string) => {
    const seq = (supplierSeq.current += 1);
    const options = await orderApi.supplierOptions(search);
    if (seq === supplierSeq.current) setSupplierOptions(options);
  };

  const save = async () => {
    if (refState === 'taken') return;
    setSaving(true);
    try {
      const next = await orderApi.updateOrderHeader({
        orderId: header.id,
        orderRef: orderRef.trim(),
        orderDate: orderDate || undefined,
        supplierId,
        sourceMarketplace: marketplace,
        paymentStatus,
        paymentMode,
        paymentDate: paymentDate || null,
        attachmentReference: invoiceNo,
        shippingCarrier: carrier,
        trackingId: tracking,
        expectedDeliveryDate: expectedDelivery || null,
        remarks,
      });
      message.success(t(TEXT.ovOrderUpdated));
      onSaved(next);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t(TEXT.unexpectedResponse));
    } finally {
      setSaving(false);
    }
  };

  const refExtra =
    refState === 'available' ? (
      <Typography.Text type="success" style={{ fontSize: 12 }}>
        ✓ {t(TEXT.ocRefAvailable)}
      </Typography.Text>
    ) : refState === 'taken' ? (
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        {t(TEXT.ocRefTaken)}
      </Typography.Text>
    ) : undefined;

  return (
    <Modal
      open={open}
      title={t(TEXT.ovEditOrderTitle)}
      okText={t(TEXT.drawerSave)}
      cancelText={t(TEXT.ocCancel)}
      onOk={save}
      onCancel={onClose}
      okButtonProps={{ disabled: refState === 'taken' || !orderRef.trim(), loading: saving }}
      confirmLoading={saving}
      width={620}
      destroyOnClose
    >
      <Form layout="vertical" component="div">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item label={t(TEXT.ocOrderRef)} extra={refExtra} style={{ marginBottom: 8 }}>
            <Input
              value={orderRef}
              aria-label={t(TEXT.ocOrderRef)}
              status={refState === 'taken' ? 'error' : undefined}
              onChange={(event) => setOrderRef(event.target.value)}
              style={{ fontFamily: 'ui-monospace, monospace' }}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocOrderDate)} style={{ marginBottom: 8 }}>
            <DatePicker
              value={dateValue(orderDate)}
              onChange={(_, s) => setOrderDate(dateString(s))}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocOrderDate)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.drawerSupplier)} style={{ marginBottom: 8 }}>
            <Select
              showSearch
              value={supplierId}
              options={supplierOptions}
              filterOption={false}
              aria-label={t(TEXT.drawerSupplier)}
              onSearch={(text) => loadSuppliers(text)}
              onDropdownVisibleChange={(visible) => {
                if (visible && supplierOptions.length <= 1) loadSuppliers();
              }}
              onChange={setSupplierId}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocMarketplace)} style={{ marginBottom: 8 }}>
            <Select
              value={marketplace || undefined}
              onChange={setMarketplace}
              aria-label={t(TEXT.ocMarketplace)}
              options={[
                { value: 'US', label: 'USA' },
                { value: 'UK', label: 'UK' },
              ]}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocPaymentStatus)} style={{ marginBottom: 8 }}>
            <Input value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} />
          </Form.Item>
          <Form.Item label={t(TEXT.ocPaymentMode)} style={{ marginBottom: 8 }}>
            <Input value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)} />
          </Form.Item>
          <Form.Item label={t(TEXT.ocPaymentDate)} style={{ marginBottom: 8 }}>
            <DatePicker
              value={dateValue(paymentDate)}
              onChange={(_, s) => setPaymentDate(dateString(s))}
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
              value={dateValue(expectedDelivery)}
              onChange={(_, s) => setExpectedDelivery(dateString(s))}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocExpectedDelivery)}
            />
          </Form.Item>
        </div>
        <Form.Item label={t(TEXT.notesLabel)} style={{ marginBottom: 0 }}>
          <Input.TextArea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * Edit an existing line OR add a new product (when addToOrderId is set). Shares
 * one form since the field set is nearly identical.
 */
export function EditLineModal(props: {
  open: boolean;
  orderApi: OrderApi;
  t: Translate;
  line?: OrderLineDetail | null;
  addToOrderId?: string;
  companyId?: string;
  onClose: () => void;
  onSaved: (next: OrderDetailResult) => void;
}) {
  const { open, orderApi, t, line, addToOrderId, companyId, onClose, onSaved } = props;
  const { message } = App.useApp();
  const isAdd = Boolean(addToOrderId);
  const [companyProductId, setCompanyProductId] = useState<string | undefined>();
  const [productOptions, setProductOptions] = useState<OrderProductOption[]>([]);
  const [orderedQty, setOrderedQty] = useState<number | null>(null);
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [pack, setPack] = useState<number | null>(1);
  const [sellPrice, setSellPrice] = useState<number | null>(null);
  const [priority, setPriority] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [expectedSellable, setExpectedSellable] = useState('');
  const [saving, setSaving] = useState(false);
  const productSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setCompanyProductId(undefined);
    setProductOptions([]);
    setOrderedQty(line?.orderedQty ?? null);
    setUnitCost(line?.unitCost ?? null);
    setPack(line?.supplierPackSize ?? 1);
    setSellPrice(line?.expectedSellPrice ?? null);
    setPriority(line?.priority ?? '');
    setExpectedDelivery(line?.expectedDeliveryDate ?? '');
    setExpectedSellable(line?.expectedSellableDate ?? '');
  }, [open, line]);

  const loadProducts = async (search?: string) => {
    if (!companyId) return;
    const seq = (productSeq.current += 1);
    const options = await orderApi.productOptions(companyId, search);
    if (seq === productSeq.current) setProductOptions(options);
  };

  const canSave = isAdd ? Boolean(companyProductId) && (orderedQty ?? 0) > 0 : (orderedQty ?? 0) > 0;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      let next: OrderDetailResult;
      if (isAdd && addToOrderId && companyProductId) {
        next = await orderApi.addOrderLine(addToOrderId, {
          companyProductId,
          orderedQty,
          unitCost: unitCost ?? undefined,
          supplierPackSize: pack ?? undefined,
          expectedSellPrice: sellPrice ?? undefined,
          expectedDeliveryDate: expectedDelivery || undefined,
          expectedSellableDate: expectedSellable || undefined,
          priority: priority || undefined,
        });
        message.success(t(TEXT.ovLineAdded));
      } else if (line?.id) {
        next = await orderApi.updateOrderLine({
          orderLineId: line.id,
          orderedQty,
          unitCost: unitCost ?? undefined,
          supplierPackSize: pack ?? undefined,
          expectedSellPrice: sellPrice ?? undefined,
          expectedDeliveryDate: expectedDelivery || null,
          expectedSellableDate: expectedSellable || null,
          priority: priority || null,
        });
        message.success(t(TEXT.ovLineUpdated));
      } else {
        return;
      }
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
      title={isAdd ? t(TEXT.ocAddProduct) : t(TEXT.ovEditLine)}
      okText={t(TEXT.drawerSave)}
      cancelText={t(TEXT.ocCancel)}
      onOk={save}
      onCancel={onClose}
      okButtonProps={{ disabled: !canSave, loading: saving }}
      confirmLoading={saving}
      destroyOnClose
    >
      <Form layout="vertical" component="div">
        {isAdd ? (
          <Form.Item label={t(TEXT.colProduct)} style={{ marginBottom: 8 }}>
            <Select
              showSearch
              value={companyProductId}
              placeholder={t(TEXT.ocSearchProduct)}
              aria-label={t(TEXT.ocSearchProduct)}
              filterOption={false}
              options={productOptions.map((option) => ({
                value: option.companyProductId,
                label: `${option.title ?? ''} · ${[option.asin, option.sku].filter(Boolean).join(' · ')}`,
              }))}
              onSearch={(text) => loadProducts(text)}
              onDropdownVisibleChange={(visible) => {
                if (visible && productOptions.length === 0) loadProducts();
              }}
              onChange={(value: string) => {
                const option = productOptions.find((candidate) => candidate.companyProductId === value);
                setCompanyProductId(value);
                if (option?.unitCost !== undefined && unitCost === null) setUnitCost(option.unitCost);
              }}
            />
          </Form.Item>
        ) : (
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            <Typography.Text strong>{line?.title}</Typography.Text>
          </Typography.Paragraph>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item label={t(TEXT.qtyLabel)} style={{ marginBottom: 8 }}>
            <InputNumber
              value={orderedQty}
              min={0}
              onChange={(v) => setOrderedQty(v ?? null)}
              style={{ width: '100%' }}
              aria-label={t(TEXT.qtyLabel)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocColUnitCost)} style={{ marginBottom: 8 }}>
            <InputNumber
              value={unitCost}
              min={0}
              onChange={(v) => setUnitCost(v ?? null)}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocColUnitCost)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocColPack)} style={{ marginBottom: 8 }}>
            <InputNumber
              value={pack}
              min={1}
              onChange={(v) => setPack(v ?? null)}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocColPack)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocColSellPrice)} style={{ marginBottom: 8 }}>
            <InputNumber
              value={sellPrice}
              min={0}
              onChange={(v) => setSellPrice(v ?? null)}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocColSellPrice)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocExpectedDelivery)} style={{ marginBottom: 8 }}>
            <DatePicker
              value={dateValue(expectedDelivery)}
              onChange={(_, s) => setExpectedDelivery(dateString(s))}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocExpectedDelivery)}
            />
          </Form.Item>
          <Form.Item label={t(TEXT.ocExpectedSellable)} style={{ marginBottom: 8 }}>
            <DatePicker
              value={dateValue(expectedSellable)}
              onChange={(_, s) => setExpectedSellable(dateString(s))}
              style={{ width: '100%' }}
              aria-label={t(TEXT.ocExpectedSellable)}
            />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
