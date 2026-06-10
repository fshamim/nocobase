import { useAPIClient } from '@nocobase/client';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

type PipelineGroup = 'before_purchase' | 'purchased_pipeline' | 'closed_archive';

interface WorkspaceData {
  reorderCandidates: PlainRecord[];
  supplierOrders: PlainRecord[];
  supplierOrderLines: PlainRecord[];
  supplierProductLinks: PlainRecord[];
  activities: PlainRecord[];
  suppliers: PlainRecord[];
  leadTimes: PlainRecord[];
  rawImportRows: PlainRecord[];
  statusLanes: PlainRecord[];
}

const BEFORE_PURCHASE_STATUSES = ['draft', 'supplier_contacted', 'supplier_confirmed', 'approval_pending', 'payment_pending', 'blocked'];
const PURCHASED_PIPELINE_STATUSES = ['paid', 'supplier_preparing', 'shipped_inbound', 'reached_fba'];
const CLOSED_STATUSES = ['completed', 'rejected', 'cancelled'];
const DEFAULT_HIDDEN_STATUSES = ['completed', 'rejected', 'cancelled', 'reached_fba'];
const DIGEST_LIMIT = 16;

const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  supplier_contacted: 'blue',
  supplier_confirmed: 'cyan',
  approval_pending: 'gold',
  payment_pending: 'orange',
  paid: 'green',
  supplier_preparing: 'lime',
  shipped_inbound: 'geekblue',
  reached_fba: 'purple',
  completed: 'default',
  blocked: 'red',
  rejected: 'volcano',
  cancelled: 'default',
};

function unwrapWorkspace(response: any): WorkspaceData {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || 'reorderCandidates' in data || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return {
    reorderCandidates: Array.isArray(data?.reorderCandidates) ? data.reorderCandidates : [],
    supplierOrders: Array.isArray(data?.supplierOrders) ? data.supplierOrders : [],
    supplierOrderLines: Array.isArray(data?.supplierOrderLines) ? data.supplierOrderLines : [],
    supplierProductLinks: Array.isArray(data?.supplierProductLinks) ? data.supplierProductLinks : [],
    activities: Array.isArray(data?.activities) ? data.activities : [],
    suppliers: Array.isArray(data?.suppliers) ? data.suppliers : [],
    leadTimes: Array.isArray(data?.leadTimes) ? data.leadTimes : [],
    rawImportRows: Array.isArray(data?.rawImportRows) ? data.rawImportRows : [],
    statusLanes: Array.isArray(data?.statusLanes) ? data.statusLanes : [],
  };
}

function normalizeStatus(status: unknown) {
  return typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : 'draft';
}

function pipelineGroupFor(status: unknown): PipelineGroup {
  const normalized = normalizeStatus(status);
  if (PURCHASED_PIPELINE_STATUSES.includes(normalized)) return 'purchased_pipeline';
  if (CLOSED_STATUSES.includes(normalized)) return 'closed_archive';
  return 'before_purchase';
}

function openQty(line: PlainRecord) {
  return Math.max(0, Number(line.orderedQty ?? 0) - Number(line.receivedQty ?? 0));
}

function orderOpenQty(lines: PlainRecord[]) {
  return lines.reduce((total, line) => total + openQty(line), 0);
}

function formatDate(value: unknown) {
  return typeof value === 'string' && value ? value.slice(0, 10) : '—';
}

function formatNumber(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : '—';
}

function ageDays(value: unknown, now = new Date()) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 86_400_000));
}

function isPastDate(value: unknown, now = new Date()) {
  if (typeof value !== 'string' || !value) return false;
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return parsed.getTime() < today.getTime();
}

function compactText(value: unknown) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
}

function orderSearchText(order: PlainRecord, lines: PlainRecord[], supplierName: string) {
  return [
    order.externalOrderRef,
    order.id,
    order.company,
    supplierName,
    order.status,
    order.sourceStage,
    order.approvalStatus,
    order.paymentStatus,
    order.shippingCarrier,
    order.trackingId,
    order.payload?.['Invoice No'],
    order.payload?.invoiceNo,
    ...lines.flatMap((line) => [line.asin, line.sku, line.brand, line.planningProductId, line.payload?.ASIN, line.payload?.SKU]),
  ]
    .map(compactText)
    .join(' ')
    .toLowerCase();
}

function attentionReasons(order: PlainRecord, lines: PlainRecord[], now = new Date()) {
  const reasons: string[] = [];
  const status = normalizeStatus(order.status);
  const lastUpdateAge = ageDays(order.lastMeaningfulUpdateAt ?? order.statusUpdatedAt ?? order.orderDate, now);
  if (status === 'blocked' || compactText(order.blockedReason)) reasons.push('blocked');
  if (status === 'draft') reasons.push('draft order');
  if (status === 'supplier_contacted' || status === 'supplier_confirmed') reasons.push('supplier follow-up');
  if (status === 'approval_pending') reasons.push('approval pending');
  if (status === 'payment_pending') reasons.push('payment pending');
  if (status === 'approval_pending' && (lastUpdateAge ?? 0) >= 2) reasons.push('approval stale');
  if (status === 'payment_pending' && (lastUpdateAge ?? 0) >= 2) reasons.push('payment stale');
  if ((status === 'supplier_contacted' || status === 'supplier_confirmed') && (lastUpdateAge ?? 0) >= 3) reasons.push('follow-up due');
  if (!CLOSED_STATUSES.includes(status) && isPastDate(order.expectedDeliveryDate, now)) reasons.push('delivery overdue');
  if (lines.some((line) => line.unresolvedMapping || compactText(line.mappingWarning))) reasons.push('unmapped line');
  return reasons;
}

function statusLabel(status: string, lanes: PlainRecord[]) {
  return compactText(lanes.find((lane) => lane.key === status)?.title) || status;
}

function supplierLabel(order: PlainRecord, supplierById: Map<string, PlainRecord>) {
  const supplier = supplierById.get(String(order.supplierId ?? ''));
  return compactText(order.supplierName) || compactText(supplier?.name) || compactText(order.payload?.Supplier) || 'Unknown supplier';
}

function fieldEntries(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [] as Array<[string, unknown]>;
  return Object.entries(payload as PlainRecord).filter(([, value]) => value !== undefined && value !== null && compactText(value) !== '');
}

function safeNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function statusAccentColor(status: unknown) {
  const normalized = normalizeStatus(status);
  const accents: Record<string, string> = {
    draft: '#8c8c8c',
    supplier_contacted: '#1677ff',
    supplier_confirmed: '#13c2c2',
    approval_pending: '#d4b106',
    payment_pending: '#fa8c16',
    paid: '#52c41a',
    supplier_preparing: '#a0d911',
    shipped_inbound: '#2f54eb',
    reached_fba: '#722ed1',
    completed: '#8c8c8c',
    blocked: '#ff4d4f',
    rejected: '#fa541c',
    cancelled: '#8c8c8c',
  };
  return accents[normalized] ?? '#d9d9d9';
}

function relativeDayText(value: unknown, now = new Date()) {
  if (typeof value !== 'string' || !value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '—';
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.round((parsed.getTime() - today.getTime()) / 86_400_000);
  const abs = Math.abs(diffDays);
  if (diffDays === 0) return 'today';
  return diffDays > 0 ? `in ${abs}d` : `${abs}d ago`;
}

function etaText(value: unknown, now = new Date()) {
  if (typeof value !== 'string' || !value) return undefined;
  const relative = relativeDayText(value, now);
  if (relative === '—') return undefined;
  return relative.endsWith('ago') ? `ETA overdue ${relative.replace(' ago', '')}` : `ETA ${relative}`;
}

function openedText(order: PlainRecord) {
  const relative = relativeDayText(order.orderDate ?? order.createdAt ?? order.payload?.Date ?? order.payload?.['Order Date']);
  return relative === '—' ? undefined : `opened ${relative}`;
}

function waitingText(order: PlainRecord) {
  const days = ageDays(order.statusUpdatedAt ?? order.lastMeaningfulUpdateAt ?? order.orderDate);
  if (days === undefined) return undefined;
  return days === 0 ? 'waiting today' : `waiting ${days}d`;
}

function riskMoneyText(value: unknown) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(numeric);
}

function oosSummaryText(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined;
  const relative = relativeDayText(value);
  if (relative === '—') return undefined;
  if (relative === 'today' || relative.endsWith('ago')) return 'OOS now';
  return `OOS ${relative}`;
}

function productEssence(line: PlainRecord) {
  const identity = [line.brand, line.asin, line.sku].map(compactText).filter(Boolean).join(' · ');
  const qty = Number(line.orderedQty ?? line.openQty ?? 0);
  return `${identity || compactText(line.planningProductId) || 'Unmapped product'}${Number.isFinite(qty) && qty > 0 ? ` ×${formatNumber(qty)}` : ''}`;
}

function orderCardLines(order: PlainRecord, fallbackLines: PlainRecord[]) {
  return Array.isArray(order.lineSummaries) && order.lineSummaries.length ? order.lineSummaries : fallbackLines;
}

function blockerSummary(order: PlainRecord) {
  return compactText(order.blockerSummary) || compactText(order.blockedReason) || compactText(order.payload?.Remarks) || compactText(order.payload?.['AM Remarks']) || compactText(order.payload?.['COO Remarks']);
}

export default function OrderManagementPage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const [company, setCompany] = useState('');
  const [companyOptions, setCompanyOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sourceStages, setSourceStages] = useState<string[]>([]);
  const [pipelineGroups, setPipelineGroups] = useState<PipelineGroup[]>([]);
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [hideClosed, setHideClosed] = useState(true);
  const [hidePurchased, setHidePurchased] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [sortBy, setSortBy] = useState('attention');
  const [data, setData] = useState<WorkspaceData>(() => unwrapWorkspace({}));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<PlainRecord | null>(null);
  const [orderForm] = Form.useForm();
  const [lineForm] = Form.useForm();
  const [newLineForm] = Form.useForm();

  const loadWorkspace = useCallback(async () => {
    const companyFilter = company.trim();
    if (!companyFilter) {
      setData(unwrapWorkspace({}));
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseSupplierOrders:board',
        method: 'post',
        data: { company: companyFilter, limit: 200 },
      });
      setData(unwrapWorkspace(response));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company]);

  useEffect(() => {
    const loadCompanyOptions = async () => {
      try {
        const response = await api.request({ url: 'ecobaseInventoryPlanning:filters', method: 'post', data: {} });
        let payload: any = response;
        for (let i = 0; i < 4; i += 1) {
          if (!payload || typeof payload !== 'object' || !('data' in payload)) break;
          payload = payload.data;
        }
        const companies = Array.isArray(payload?.companies) ? payload.companies.map(String).filter(Boolean) : [];
        setCompanyOptions(companies.map((value) => ({ label: value, value })));
        if (!company.trim() && companies.length) {
          setCompany(companies[0]);
        }
      } catch (err) {
        setError(err as Error);
      }
    };
    void loadCompanyOptions();
  }, [api, company]);

  useEffect(() => {
    if (company.trim()) void loadWorkspace();
  }, [loadWorkspace]);

  const supplierById = useMemo(() => {
    const map = new Map<string, PlainRecord>();
    data.suppliers.forEach((supplier) => {
      if (supplier.id) map.set(String(supplier.id), supplier);
      if (supplier.supplierId) map.set(String(supplier.supplierId), supplier);
    });
    return map;
  }, [data.suppliers]);

  const linesByOrderId = useMemo(() => {
    const map = new Map<string, PlainRecord[]>();
    data.supplierOrderLines.forEach((line) => {
      const orderId = String(line.supplierOrderId ?? '');
      if (!orderId) return;
      const lines = map.get(orderId) ?? [];
      lines.push(line);
      map.set(orderId, lines);
    });
    return map;
  }, [data.supplierOrderLines]);

  const statusOptions = useMemo(() => {
    const laneOptions = data.statusLanes.map((lane) => ({ label: statusLabel(String(lane.key), data.statusLanes), value: String(lane.key) }));
    const seen = new Set(laneOptions.map((option) => option.value));
    data.supplierOrders.forEach((order) => {
      const status = normalizeStatus(order.status);
      if (!seen.has(status)) {
        seen.add(status);
        laneOptions.push({ label: status, value: status });
      }
    });
    return laneOptions;
  }, [data.statusLanes, data.supplierOrders]);

  const supplierOptions = useMemo(() => data.suppliers.map((supplier) => ({
    label: compactText(supplier.name) || compactText(supplier.supplierId) || 'Unknown supplier',
    value: String(supplier.id ?? supplier.supplierId),
  })).filter((option) => option.value), [data.suppliers]);

  const productOptions = useMemo(() => {
    const options = new Map<string, { label: string; value: string }>();
    const add = (record: PlainRecord) => {
      const id = compactText(record.planningProductId);
      if (!id) return;
      const label = [record.asin ?? record.canonicalAsin, record.sku, record.brand, record.title]
        .map(compactText)
        .filter(Boolean)
        .join(' · ');
      options.set(id, { value: id, label: label || id });
    };
    data.reorderCandidates.forEach(add);
    data.supplierOrderLines.forEach(add);
    return Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [data.reorderCandidates, data.supplierOrderLines]);

  const sourceStageOptions = useMemo(() => Array.from(new Set(data.supplierOrders.map((order) => compactText(order.sourceStage)).filter(Boolean)))
    .map((stage) => ({ label: stage, value: stage })), [data.supplierOrders]);

  const enrichedOrders = useMemo(() => data.supplierOrders.map((order) => {
    const id = String(order.id ?? '');
    const lines = linesByOrderId.get(id) ?? [];
    const cardLines = orderCardLines(order, lines);
    const supplierName = supplierLabel(order, supplierById);
    const reasons = attentionReasons(order, lines);
    return {
      ...order,
      normalizedStatus: normalizeStatus(order.status),
      pipelineGroup: pipelineGroupFor(order.status),
      supplierName,
      lineCount: Number(order.lineCount ?? lines.length),
      openQty: Number(order.openQty ?? orderOpenQty(lines)),
      cardLines,
      attentionReasons: reasons,
      needsAttention: reasons.length > 0,
      searchText: orderSearchText(order, lines, supplierName),
    };
  }), [data.supplierOrders, linesByOrderId, supplierById]);

  const filteredOrders = useMemo(() => {
    const searchValue = search.trim().toLowerCase();
    const selectedStatuses = new Set(statuses);
    const selectedStages = new Set(sourceStages);
    const selectedGroups = new Set(pipelineGroups);
    const selectedSuppliers = new Set(supplierIds);
    const visible = enrichedOrders.filter((order) => {
      if (hideClosed && DEFAULT_HIDDEN_STATUSES.includes(order.normalizedStatus)) return false;
      if (hidePurchased && order.pipelineGroup === 'purchased_pipeline') return false;
      if (attentionOnly && !order.needsAttention) return false;
      if (selectedStatuses.size && !selectedStatuses.has(order.normalizedStatus)) return false;
      if (selectedStages.size && !selectedStages.has(compactText(order.sourceStage))) return false;
      if (selectedGroups.size && !selectedGroups.has(order.pipelineGroup)) return false;
      if (selectedSuppliers.size && !selectedSuppliers.has(String(order.supplierId ?? ''))) return false;
      if (searchValue && !order.searchText.includes(searchValue)) return false;
      return true;
    });
    return visible.sort((a, b) => {
      if (sortBy === 'attention') return Number(b.needsAttention) - Number(a.needsAttention) || (b.attentionReasons.length - a.attentionReasons.length);
      if (sortBy === 'expectedDeliveryDate') return compactText(a.expectedDeliveryDate).localeCompare(compactText(b.expectedDeliveryDate));
      if (sortBy === 'supplier') return compactText(a.supplierName).localeCompare(compactText(b.supplierName));
      if (sortBy === 'order') return compactText(a.externalOrderRef ?? a.id).localeCompare(compactText(b.externalOrderRef ?? b.id));
      if (sortBy === 'openQty') return Number(b.openQty ?? 0) - Number(a.openQty ?? 0);
      return compactText(b.lastMeaningfulUpdateAt ?? b.statusUpdatedAt).localeCompare(compactText(a.lastMeaningfulUpdateAt ?? a.statusUpdatedAt));
    });
  }, [attentionOnly, enrichedOrders, hideClosed, hidePurchased, pipelineGroups, search, sortBy, sourceStages, statuses, supplierIds]);

  const digestOrders = useMemo(() => enrichedOrders.filter((order) => order.needsAttention)
    .sort((a, b) => b.attentionReasons.length - a.attentionReasons.length)
    .slice(0, DIGEST_LIMIT), [enrichedOrders]);

  const boardGroups = useMemo(() => {
    const lanes = statusOptions.map((option) => option.value);
    return [
      { key: 'before_purchase' as PipelineGroup, title: t('Before purchase'), statuses: BEFORE_PURCHASE_STATUSES.filter((status) => lanes.includes(status)) },
      { key: 'purchased_pipeline' as PipelineGroup, title: t('Purchased / fulfillment pipeline'), statuses: PURCHASED_PIPELINE_STATUSES.filter((status) => lanes.includes(status)) },
      { key: 'closed_archive' as PipelineGroup, title: t('Closed / archive'), statuses: CLOSED_STATUSES.filter((status) => lanes.includes(status)) },
    ];
  }, [statusOptions, t]);

  const selectedOrder = useMemo(() => selectedOrderId ? enrichedOrders.find((order) => String(order.id) === selectedOrderId) ?? null : null, [enrichedOrders, selectedOrderId]);
  const selectedOrderLines = useMemo(() => selectedOrder ? linesByOrderId.get(String(selectedOrder.id)) ?? [] : [], [linesByOrderId, selectedOrder]);
  const selectedActivities = useMemo(() => selectedOrder ? data.activities.filter((activity) => String(activity.supplierOrderId ?? '') === String(selectedOrder.id)) : [], [data.activities, selectedOrder]);

  useEffect(() => {
    if (!selectedOrder) return;
    orderForm.setFieldsValue({
      supplierId: selectedOrder.supplierId,
      externalOrderRef: selectedOrder.externalOrderRef,
      orderDate: formatDate(selectedOrder.orderDate) === '—' ? undefined : formatDate(selectedOrder.orderDate),
      status: selectedOrder.normalizedStatus,
      expectedDeliveryDate: selectedOrder.expectedDeliveryDate,
      approvalStatus: selectedOrder.approvalStatus,
      paymentStatus: selectedOrder.paymentStatus,
      shippingCarrier: selectedOrder.shippingCarrier,
      trackingId: selectedOrder.trackingId,
      blockedReason: selectedOrder.blockedReason,
    });
  }, [orderForm, selectedOrder]);

  useEffect(() => {
    if (!selectedLine) return;
    lineForm.setFieldsValue({
      planningProductId: selectedLine.planningProductId,
      externalOrderRef: selectedOrder?.externalOrderRef,
      orderedQty: safeNumber(selectedLine.orderedQty),
      receivedQty: safeNumber(selectedLine.receivedQty),
      unitCost: safeNumber(selectedLine.unitCost),
      expectedDeliveryDate: selectedLine.expectedDeliveryDate,
      expectedSellableDate: selectedLine.expectedSellableDate,
      notes: undefined,
    });
  }, [lineForm, selectedLine, selectedOrder?.externalOrderRef]);

  const openOrder = (order: PlainRecord) => {
    setSelectedOrderId(String(order.id));
    setSelectedLine(null);
    lineForm.resetFields();
    newLineForm.resetFields();
  };

  const refreshAfterMutation = async (success: string) => {
    message.success(success);
    await loadWorkspace();
  };

  const saveOrder = async () => {
    if (!selectedOrder) return;
    const values = await orderForm.validateFields();
    await api.request({
      url: 'ecobaseSupplierOrders:updateOrder',
      method: 'post',
      data: {
        supplierOrderId: selectedOrder.id,
        company: selectedOrder.company,
        supplierId: values.supplierId,
        externalOrderRef: values.externalOrderRef,
        orderDate: values.orderDate,
        status: values.status,
        expectedDeliveryDate: values.expectedDeliveryDate,
        approvalStatus: values.approvalStatus,
        paymentStatus: values.paymentStatus,
        shippingCarrier: values.shippingCarrier,
        trackingId: values.trackingId,
        blockedReason: values.blockedReason,
      },
    });
    await refreshAfterMutation(t('Order updated'));
  };

  const saveLine = async () => {
    if (!selectedLine || !selectedOrder) return;
    const values = await lineForm.validateFields();
    await api.request({
      url: 'ecobaseSupplierOrders:updateLineOperatorFields',
      method: 'post',
      data: {
        supplierOrderLineId: selectedLine.id,
        company: selectedOrder.company,
        planningProductId: values.planningProductId,
        externalOrderRef: values.externalOrderRef,
        orderedQty: values.orderedQty,
        receivedQty: values.receivedQty,
        unitCost: values.unitCost,
        expectedDeliveryDate: values.expectedDeliveryDate,
        expectedSellableDate: values.expectedSellableDate,
        notes: values.notes,
      },
    });
    setSelectedLine(null);
    lineForm.resetFields();
    await refreshAfterMutation(t('Order line updated'));
  };

  const addLine = async () => {
    if (!selectedOrder) return;
    const values = await newLineForm.validateFields();
    await api.request({
      url: 'ecobaseSupplierOrders:createOrderLine',
      method: 'post',
      data: {
        supplierOrderId: selectedOrder.id,
        planningProductId: values.planningProductId,
        orderedQty: values.orderedQty,
        unitCost: values.unitCost,
        expectedDeliveryDate: values.expectedDeliveryDate,
        expectedSellableDate: values.expectedSellableDate,
        notes: values.notes,
      },
    });
    newLineForm.resetFields();
    await refreshAfterMutation(t('Order line added'));
  };

  const deleteLine = async (line: PlainRecord) => {
    if (!selectedOrder) return;
    await api.request({
      url: 'ecobaseSupplierOrders:deleteLineOperatorFields',
      method: 'post',
      data: { supplierOrderLineId: line.id, company: selectedOrder.company },
    });
    await refreshAfterMutation(t('Order line removed'));
  };

  const recordActivity = async (activityType: string) => {
    if (!selectedOrder) return;
    await api.request({
      url: 'ecobaseSupplierOrders:recordActivity',
      method: 'post',
      data: {
        company: selectedOrder.company,
        supplierId: selectedOrder.supplierId,
        supplierOrderId: selectedOrder.id,
        activityType,
        occurredAt: new Date().toISOString(),
        notes: `${activityType} from Order Management drawer.`,
      },
    });
    await refreshAfterMutation(t('Activity recorded'));
  };

  const renderOrderCard = (order: PlainRecord) => {
    const cardLines = order.cardLines ?? [];
    const visibleLines = cardLines.slice(0, 2);
    const extraLineCount = Math.max(0, cardLines.length - visibleLines.length);
    const risk = riskMoneyText(order.productRiskSummary?.maxEstimatedProfitRisk);
    const oos = oosSummaryText(order.productRiskSummary?.earliestOosDate);
    const timing = [openedText(order), waitingText(order), etaText(order.expectedDeliveryDate)].filter(Boolean).join(' · ');
    const blocker = blockerSummary(order);
    return (
      <Card
        key={order.id}
        size="small"
        hoverable
        onClick={() => openOrder(order)}
        style={{ marginBottom: 8, borderLeft: `4px solid ${statusAccentColor(order.normalizedStatus)}` }}
      >
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space style={{ justifyContent: 'space-between', width: '100%' }} align="start">
            <Typography.Text strong>{order.externalOrderRef ?? t('No order ref')}</Typography.Text>
            <Tag color={STATUS_COLORS[order.normalizedStatus] ?? 'default'}>{t(statusLabel(order.normalizedStatus, data.statusLanes))}</Tag>
          </Space>
          <Typography.Text ellipsis type={order.supplierName === 'Unknown supplier' ? 'secondary' : undefined}>{order.supplierName}</Typography.Text>
          {visibleLines.map((line: PlainRecord) => (
            <Typography.Text key={String(line.id ?? `${line.asin}:${line.sku}`)} type="secondary" ellipsis>{productEssence(line)}</Typography.Text>
          ))}
          {extraLineCount > 0 ? <Typography.Text type="secondary">+{extraLineCount} {t('more')}</Typography.Text> : null}
          <Space size={4} wrap>
            <Tag>{formatNumber(order.openQty)} {t('open')}</Tag>
            {risk ? <Tag color="volcano">{risk}</Tag> : null}
            {oos ? <Tag color={oos === 'OOS now' ? 'red' : 'orange'}>{oos}</Tag> : null}
          </Space>
          {timing ? <Typography.Text type="secondary">{timing}</Typography.Text> : null}
          {blocker ? <Typography.Text italic ellipsis>{blocker}</Typography.Text> : null}
          {order.attentionReasons.length ? (
            <Space size={4} wrap>{order.attentionReasons.map((reason: string) => <Tag color={reason === 'blocked' ? 'red' : 'warning'} key={reason}>{t(reason)}</Tag>)}</Space>
          ) : null}
        </Space>
      </Card>
    );
  };

  const renderPayloadTable = (payload: unknown) => {
    const entries = fieldEntries(payload);
    if (!entries.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('No imported payload evidence')} />;
    return (
      <Table
        size="small"
        pagination={false}
        rowKey={(row: { key: string }) => row.key}
        dataSource={entries.map(([key, value]) => ({ key, value: compactText(value) }))}
        columns={[
          { title: t('Field'), dataIndex: 'key', width: 220 },
          { title: t('Imported value'), dataIndex: 'value' },
        ]}
      />
    );
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Title level={3}>{t('Ecobase supplier order management')}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {t('Operate supplier orders from draft through purchase and inbound without editing raw imported sheet rows.')}
          </Typography.Paragraph>
          <Row gutter={[12, 12]}>
            <Col xs={24} md={8} xl={5}>
              <Select
                showSearch
                allowClear
                placeholder={t('Company filter')}
                value={company || undefined}
                onChange={(value) => setCompany(value ?? '')}
                onSearch={(value) => setCompany(value)}
                optionFilterProp="label"
                options={companyOptions}
                style={{ width: '100%' }}
              />
            </Col>
            <Col xs={24} md={16} xl={7}>
              <Input placeholder={t('Search order, supplier, ASIN, SKU, tracking, invoice')} value={search} onChange={(event) => setSearch(event.target.value)} />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Select value={sortBy} onChange={setSortBy} style={{ width: '100%' }} options={[
                { value: 'attention', label: t('Sort by attention') },
                { value: 'lastUpdate', label: t('Sort by last update') },
                { value: 'expectedDeliveryDate', label: t('Sort by ETA') },
                { value: 'supplier', label: t('Sort by supplier') },
                { value: 'order', label: t('Sort by order') },
                { value: 'openQty', label: t('Sort by open qty') },
              ]} />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Button type="primary" onClick={() => void loadWorkspace()} loading={loading} style={{ width: '100%' }}>{t('Refresh workspace')}</Button>
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Button onClick={() => { setHideClosed(false); setHidePurchased(false); setAttentionOnly(false); setStatuses([]); setPipelineGroups([]); }} style={{ width: '100%' }}>{t('Show all statuses')}</Button>
            </Col>
          </Row>
          <Row gutter={[12, 12]}>
            <Col xs={24} md={12} xl={6}>
              <Select mode="multiple" allowClear placeholder={t('Statuses')} value={statuses} onChange={setStatuses} style={{ width: '100%' }} options={statusOptions} />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <Select mode="multiple" allowClear placeholder={t('Suppliers')} value={supplierIds} onChange={setSupplierIds} style={{ width: '100%' }} options={supplierOptions} showSearch optionFilterProp="label" />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <Select mode="multiple" allowClear placeholder={t('Source stage')} value={sourceStages} onChange={setSourceStages} style={{ width: '100%' }} options={sourceStageOptions} />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <Select mode="multiple" allowClear placeholder={t('Pipeline group')} value={pipelineGroups} onChange={setPipelineGroups} style={{ width: '100%' }} options={[
                { value: 'before_purchase', label: t('Before purchase') },
                { value: 'purchased_pipeline', label: t('Purchased / inbound') },
                { value: 'closed_archive', label: t('Closed / archive') },
              ]} />
            </Col>
          </Row>
          <Space wrap>
            <Checkbox checked={hideClosed} onChange={(event) => setHideClosed(event.target.checked)}>{t('Hide closed / reached FBA')}</Checkbox>
            <Checkbox checked={hidePurchased} onChange={(event) => setHidePurchased(event.target.checked)}>{t('Hide purchased pipeline')}</Checkbox>
            <Checkbox checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)}>{t('Show only needs attention')}</Checkbox>
          </Space>
          {!company.trim() ? <Alert type="info" showIcon message={t('Enter a company filter to load company-scoped order data.')} /> : null}
          {error ? <Alert type="error" showIcon message={error.message} /> : null}
        </Space>
      </Card>

      <Card title={t('Critical order digest')}>
        {digestOrders.length ? (
          <Row gutter={[12, 12]}>
            {digestOrders.map((order) => (
              <Col xs={24} md={12} xl={6} key={order.id}>
                {renderOrderCard(order)}
              </Col>
            ))}
          </Row>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('No critical orders in the loaded workspace')} />}
      </Card>

      <Tabs
        defaultActiveKey="board"
        items={[
          {
            key: 'board',
            label: t('Pipeline board'),
            children: (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                {boardGroups.map((group) => {
                  const groupOrders = filteredOrders.filter((order) => order.pipelineGroup === group.key);
                  if (!groupOrders.length && hideClosed && group.key === 'closed_archive') return null;
                  if (!groupOrders.length && hidePurchased && group.key === 'purchased_pipeline') return null;
                  return (
                    <Card key={group.key} title={<Space><span>{group.title}</span><Badge count={groupOrders.length} showZero /></Space>}>
                      <Row gutter={[12, 12]}>
                        {group.statuses.map((status) => {
                          const laneOrders = groupOrders.filter((order) => order.normalizedStatus === status);
                          if (!laneOrders.length && DEFAULT_HIDDEN_STATUSES.includes(status) && hideClosed) return null;
                          if (!laneOrders.length && PURCHASED_PIPELINE_STATUSES.includes(status) && hidePurchased) return null;
                          return (
                            <Col xs={24} md={12} xl={6} xxl={4} key={status}>
                              <Card size="small" title={<Space><Tag color={STATUS_COLORS[status] ?? 'default'}>{t(statusLabel(status, data.statusLanes))}</Tag><Badge count={laneOrders.length} showZero /></Space>} style={{ minHeight: 180 }}>
                                {laneOrders.length ? laneOrders.map(renderOrderCard) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('No orders')} />}
                              </Card>
                            </Col>
                          );
                        })}
                      </Row>
                    </Card>
                  );
                })}
              </Space>
            ),
          },
          {
            key: 'table',
            label: t('Order table'),
            children: (
              <Table<PlainRecord>
                rowKey="id"
                loading={loading}
                dataSource={filteredOrders}
                pagination={{ pageSize: 25 }}
                onRow={(row) => ({ onClick: () => openOrder(row) })}
                columns={[
                  { title: t('Order'), key: 'order', render: (_, row) => row.externalOrderRef ?? row.id },
                  { title: t('Status'), dataIndex: 'normalizedStatus', render: (value: string) => <Tag color={STATUS_COLORS[value] ?? 'default'}>{t(statusLabel(value, data.statusLanes))}</Tag> },
                  { title: t('Pipeline'), dataIndex: 'pipelineGroup', render: (value: string) => t(value) },
                  { title: t('Supplier'), dataIndex: 'supplierName' },
                  { title: t('Source'), dataIndex: 'sourceStage' },
                  { title: t('Approval'), dataIndex: 'approvalStatus', render: (value) => value || '—' },
                  { title: t('Payment'), dataIndex: 'paymentStatus', render: (value) => value || '—' },
                  { title: t('ETA'), dataIndex: 'expectedDeliveryDate', render: formatDate },
                  { title: t('Open qty'), dataIndex: 'openQty', render: formatNumber },
                  { title: t('Lines'), dataIndex: 'lineCount', render: formatNumber },
                  { title: t('Attention'), dataIndex: 'attentionReasons', render: (reasons: string[]) => reasons?.length ? reasons.map((reason) => <Tag color="red" key={reason}>{t(reason)}</Tag>) : '—' },
                ]}
              />
            ),
          },
          {
            key: 'lines',
            label: t('Lines'),
            children: (
              <Table<PlainRecord>
                rowKey="id"
                loading={loading}
                dataSource={data.supplierOrderLines.filter((line) => filteredOrders.some((order) => String(order.id) === String(line.supplierOrderId)))}
                pagination={{ pageSize: 25 }}
                columns={[
                  { title: t('Order ID'), dataIndex: 'supplierOrderId' },
                  { title: t('ASIN'), dataIndex: 'asin' },
                  { title: t('SKU'), dataIndex: 'sku' },
                  { title: t('Brand'), dataIndex: 'brand' },
                  { title: t('Ordered'), dataIndex: 'orderedQty', render: formatNumber },
                  { title: t('Received'), dataIndex: 'receivedQty', render: formatNumber },
                  { title: t('Open'), render: (_, row) => formatNumber(openQty(row)) },
                  { title: t('Unit cost'), dataIndex: 'unitCost', render: formatNumber },
                  { title: t('Expected delivery'), dataIndex: 'expectedDeliveryDate', render: formatDate },
                  { title: t('Expected sellable'), dataIndex: 'expectedSellableDate', render: formatDate },
                  { title: t('Source'), dataIndex: 'sourceStage' },
                ]}
              />
            ),
          },
        ]}
      />

      <Drawer
        open={!!selectedOrder}
        width={980}
        title={selectedOrder ? `${selectedOrder.externalOrderRef ?? selectedOrder.id} · ${selectedOrder.supplierName}` : t('Supplier order')}
        onClose={() => { setSelectedOrderId(null); setSelectedLine(null); }}
        extra={<Button onClick={() => { setSelectedOrderId(null); setSelectedLine(null); }}>{t('Close')}</Button>}
      >
        {selectedOrder ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label={t('Status')}><Tag color={STATUS_COLORS[selectedOrder.normalizedStatus] ?? 'default'}>{t(statusLabel(selectedOrder.normalizedStatus, data.statusLanes))}</Tag></Descriptions.Item>
              <Descriptions.Item label={t('Pipeline group')}>{t(selectedOrder.pipelineGroup)}</Descriptions.Item>
              <Descriptions.Item label={t('Company')}>{selectedOrder.company}</Descriptions.Item>
              <Descriptions.Item label={t('Supplier')}>{selectedOrder.supplierName}</Descriptions.Item>
              <Descriptions.Item label={t('Source stage')}>{selectedOrder.sourceStage ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Opened')}>{openedText(selectedOrder) ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Waiting')}>{waitingText(selectedOrder) ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Expected delivery')}>{etaText(selectedOrder.expectedDeliveryDate) ?? formatDate(selectedOrder.expectedDeliveryDate)}</Descriptions.Item>
              <Descriptions.Item label={t('Attention')}>{selectedOrder.attentionReasons.length ? selectedOrder.attentionReasons.map((reason: string) => <Tag color="red" key={reason}>{t(reason)}</Tag>) : '—'}</Descriptions.Item>
            </Descriptions>

            <Card title={t('Edit order lifecycle')}>
              <Form form={orderForm} layout="vertical">
                <Row gutter={12}>
                  <Col xs={24} md={8}><Form.Item name="externalOrderRef" label={t('Order ref')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="supplierId" label={t('Supplier')} rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={supplierOptions} placeholder={t('Search supplier')} /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="orderDate" label={t('Opened date YYYY-MM-DD')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="status" label={t('Status')} rules={[{ required: true }]}><Select options={statusOptions} /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="expectedDeliveryDate" label={t('Expected delivery YYYY-MM-DD')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="approvalStatus" label={t('Approval status')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="paymentStatus" label={t('Payment status')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="shippingCarrier" label={t('Shipping carrier')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="trackingId" label={t('Tracking ID')}><Input /></Form.Item></Col>
                  <Col xs={24}><Form.Item name="blockedReason" label={t('Blocked reason')}><Input.TextArea rows={2} /></Form.Item></Col>
                </Row>
                <Space wrap>
                  <Button type="primary" onClick={() => void saveOrder()}>{t('Save order')}</Button>
                  <Button onClick={() => void recordActivity('contacted_supplier')}>{t('Contacted supplier')}</Button>
                  <Button onClick={() => void recordActivity('status_update')}>{t('Status update')}</Button>
                  <Button onClick={() => void recordActivity('blocked')}>{t('Mark activity blocked')}</Button>
                  <Button onClick={() => void recordActivity('unblocked')}>{t('Mark activity unblocked')}</Button>
                </Space>
              </Form>
            </Card>

            <Card title={t('Product lines')}>
              <Table<PlainRecord>
                size="small"
                rowKey="id"
                dataSource={selectedOrderLines}
                pagination={false}
                columns={[
                  { title: t('ASIN'), dataIndex: 'asin' },
                  { title: t('SKU'), dataIndex: 'sku' },
                  { title: t('Brand'), dataIndex: 'brand' },
                  { title: t('Ordered'), dataIndex: 'orderedQty', render: formatNumber },
                  { title: t('Received'), dataIndex: 'receivedQty', render: formatNumber },
                  { title: t('Open'), render: (_, row) => formatNumber(openQty(row)) },
                  { title: t('ETA'), dataIndex: 'expectedDeliveryDate', render: formatDate },
                  { title: t('Sellable'), dataIndex: 'expectedSellableDate', render: formatDate },
                  { title: t('Warning'), render: (_, row) => row.unresolvedMapping || row.mappingWarning ? <Tag color="red">{t('Unmapped')}</Tag> : '—' },
                  { title: t('Action'), render: (_, row) => <Space><Button size="small" onClick={() => setSelectedLine(row)}>{t('Edit')}</Button><Popconfirm title={t('Remove this line?')} onConfirm={() => void deleteLine(row)}><Button size="small" danger>{t('Remove')}</Button></Popconfirm></Space> },
                ]}
              />

              {selectedLine ? (
                <>
                  <Divider orientation="left">{t('Edit selected line')}</Divider>
                  <Form form={lineForm} layout="vertical">
                    <Row gutter={12}>
                      <Col xs={24} md={12}><Form.Item name="planningProductId" label={t('Product')}><Select showSearch optionFilterProp="label" options={productOptions} placeholder={t('Search ASIN, SKU, brand')} /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="orderedQty" label={t('Ordered qty')}><InputNumber min={0.0001} style={{ width: '100%' }} /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="receivedQty" label={t('Received qty')}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="unitCost" label={t('Unit cost')}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="expectedDeliveryDate" label={t('Expected delivery')}><Input /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="expectedSellableDate" label={t('Expected sellable')}><Input /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="externalOrderRef" label={t('Order ref')}><Input /></Form.Item></Col>
                      <Col xs={24}><Form.Item name="notes" label={t('Line notes')}><Input.TextArea rows={2} /></Form.Item></Col>
                    </Row>
                    <Space><Button type="primary" onClick={() => void saveLine()}>{t('Save line')}</Button><Button onClick={() => setSelectedLine(null)}>{t('Cancel line edit')}</Button></Space>
                  </Form>
                  <Divider orientation="left">{t('Selected line raw evidence')}</Divider>
                  {renderPayloadTable(selectedLine.payload)}
                </>
              ) : null}

              <Divider orientation="left">{t('Add product line')}</Divider>
              <Form form={newLineForm} layout="vertical">
                <Row gutter={12}>
                  <Col xs={24} md={12}><Form.Item name="planningProductId" label={t('Product')} rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={productOptions} placeholder={t('Search ASIN, SKU, brand')} /></Form.Item></Col>
                  <Col xs={24} md={6}><Form.Item name="orderedQty" label={t('Ordered qty')} rules={[{ required: true }]}><InputNumber min={0.0001} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col xs={24} md={6}><Form.Item name="unitCost" label={t('Unit cost')}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="expectedDeliveryDate" label={t('Expected delivery')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="expectedSellableDate" label={t('Expected sellable')}><Input /></Form.Item></Col>
                  <Col xs={24} md={8}><Form.Item name="notes" label={t('Notes')}><Input /></Form.Item></Col>
                </Row>
                <Button type="primary" onClick={() => void addLine()}>{t('Add line')}</Button>
              </Form>
            </Card>

            <Card title={t('Activity timeline')}>
              <Table<PlainRecord>
                size="small"
                rowKey="id"
                dataSource={selectedActivities}
                pagination={{ pageSize: 5 }}
                columns={[
                  { title: t('Occurred'), dataIndex: 'occurredAt' },
                  { title: t('Type'), dataIndex: 'activityType' },
                  { title: t('Next follow-up'), dataIndex: 'nextFollowUpAt', render: (value) => value || '—' },
                  { title: t('Notes'), dataIndex: 'notes', render: (value) => value || '—' },
                ]}
              />
            </Card>

            <Card title={t('Read-only order sheet evidence')}>
              {renderPayloadTable(selectedOrder.payload)}
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
