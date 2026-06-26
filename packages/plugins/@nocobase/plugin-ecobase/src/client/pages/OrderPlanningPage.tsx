import { useAPIClient } from '@nocobase/client';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
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
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

const DEFAULT_LIMIT = 5000;
const MISSING_DATE_RANK = '9999-12-31';
const ORDER_LIFECYCLE_STATUSES = [
  'IN-PROGRESS',
  'ORDER ANALYSING',
  'APPROVED TO ORDER',
  'ORDERED',
  'IN TRANSIT TO PREP',
  'DIRECT SHIP FBA',
  'AT PREP NOT STARTED',
  'PREP IN-PROGRESS',
  'SHIPPED TO FBA',
  'INBOUND MONITORING',
  'COMPLETE',
];
const ORDER_STATUS_COLORS: Record<string, string> = {
  'IN-PROGRESS': 'default',
  'ORDER ANALYSING': 'purple',
  'APPROVED TO ORDER': 'cyan',
  ORDERED: 'blue',
  'IN TRANSIT TO PREP': 'geekblue',
  'DIRECT SHIP FBA': 'volcano',
  'AT PREP NOT STARTED': 'gold',
  'PREP IN-PROGRESS': 'processing',
  'SHIPPED TO FBA': 'lime',
  'INBOUND MONITORING': 'green',
  COMPLETE: 'success',
};
const INVOICE_STATUS_OPTIONS = ['In Progress', 'Completed', 'waiting', 'imported', 'missing', 'rejected'];
const BEFORE_ORDERED_STATUSES = new Set(['IN-PROGRESS', 'ORDER ANALYSING', 'APPROVED TO ORDER']);
const AFTER_ORDERED_STATUSES = new Set([
  'ORDERED',
  'IN TRANSIT TO PREP',
  'DIRECT SHIP FBA',
  'AT PREP NOT STARTED',
  'PREP IN-PROGRESS',
  'SHIPPED TO FBA',
  'INBOUND MONITORING',
]);
const QUEUE_FILTERS = ['money', 'needs_status_check', 'before_ordered', 'after_ordered', 'complete'];

function unwrapData(response: any): PlainRecord {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = data.data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function numericValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value: unknown) {
  return numericValue(value).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function formatNumber(value: unknown) {
  return numericValue(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDate(value?: string) {
  return value || '—';
}

function dateRank(value?: string) {
  return value || MISSING_DATE_RANK;
}

function daysRank(value: unknown) {
  const days = Number(value);
  return Number.isFinite(days) ? days : Number.MAX_SAFE_INTEGER;
}

function tierRank(value: unknown) {
  const text = String(value || '').toUpperCase();
  const first = text[0];
  return first >= 'A' && first <= 'Z' ? first.charCodeAt(0) - 64 : 999;
}

function bestTier(rows: PlainRecord[]) {
  return rows
    .map((row) => row.tier)
    .filter(Boolean)
    .sort((left, right) => tierRank(left) - tierRank(right))[0];
}

function compareOosDate(left: PlainRecord, right: PlainRecord) {
  return dateRank(left.earliestOosDate).localeCompare(dateRank(right.earliestOosDate));
}

function compareOosTiming(left: PlainRecord, right: PlainRecord) {
  return (
    daysRank(left.daysUntilOos ?? left.earliestDaysUntilOos) -
    daysRank(right.daysUntilOos ?? right.earliestDaysUntilOos)
  );
}

function oosText(row: PlainRecord) {
  if (!row.earliestOosDate) {
    const missing = ['OOS date'];
    if (row.riskSource === 'silver_estimate') missing.push('gold stock model');
    if (row.riskSource === 'missing') missing.push('profit risk');
    return `Missing data: ${missing.join(', ')}`;
  }
  const days = Number(row.daysUntilOos ?? row.earliestDaysUntilOos);
  if (!Number.isFinite(days)) return row.earliestOosDate;
  if (days < 0) return `OOS now · ${Math.abs(days)}d overdue`;
  if (days === 0) return 'OOS today';
  return `${row.earliestOosDate} · in ${days}d`;
}

function statusColor(value?: string) {
  return ORDER_STATUS_COLORS[value ?? ''] ?? 'default';
}

function selectOptions(values: string[], current?: string) {
  return [...new Set([...values, current].filter((value): value is string => Boolean(value)))].map((value) => ({
    label: value,
    value,
  }));
}

function defaultOrderSort(left: PlainRecord, right: PlainRecord) {
  const riskDiff = numericValue(right.moneyAtRisk) - numericValue(left.moneyAtRisk);
  if (riskDiff !== 0) return riskDiff;
  const oosDiff = compareOosTiming(left, right);
  if (oosDiff !== 0) return oosDiff;
  const tierDiff = tierRank(left.tier) - tierRank(right.tier);
  if (tierDiff !== 0) return tierDiff;
  return numericValue(right.daysSinceLastActivity) - numericValue(left.daysSinceLastActivity);
}

function queueRows(rows: PlainRecord[], filter: string) {
  if (filter === 'needs_status_check') return rows.filter((row) => row.statusCheckRequired);
  if (filter === 'before_ordered') return rows.filter((row) => BEFORE_ORDERED_STATUSES.has(row.currentStatus));
  if (filter === 'after_ordered') return rows.filter((row) => AFTER_ORDERED_STATUSES.has(row.currentStatus));
  if (filter === 'complete') return rows.filter((row) => row.currentStatus === 'COMPLETE');
  return rows.filter((row) => numericValue(row.moneyAtRisk) > 0);
}

function groupOrders(rows: PlainRecord[]) {
  const groups = new Map<string, PlainRecord[]>();
  for (const row of rows) {
    const key = String(row.supplierId || row.supplierName || 'unknown_supplier');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()]
    .map(([key, groupRows]) => {
      const orders = [...groupRows].sort(defaultOrderSort);
      const dates = orders
        .map((row) => row.earliestOosDate)
        .filter(Boolean)
        .sort();
      const timing = orders
        .map((row) => Number(row.daysUntilOos))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      return {
        key,
        supplierId: orders[0]?.supplierId,
        supplierName: orders[0]?.supplierName ?? 'Unknown supplier',
        companyNames: [...new Set(orders.map((row) => row.companyName).filter(Boolean))].sort(),
        orderCount: orders.length,
        asinCount: orders.reduce((sum, row) => sum + numericValue(row.asinCount), 0),
        lineCount: orders.reduce((sum, row) => sum + numericValue(row.lineCount), 0),
        totalMoneyAtRisk: orders.reduce((sum, row) => sum + numericValue(row.moneyAtRisk), 0),
        earliestOosDate: dates[0],
        earliestDaysUntilOos: timing,
        maxWaitingDays: Math.max(...orders.map((row) => numericValue(row.daysSinceLastActivity))),
        tier: bestTier(orders),
        needsStatusCheckCount: orders.filter((row) => row.statusCheckRequired).length,
        latestComment: orders.find((row) => row.latestComment)?.latestComment,
        orders,
      };
    })
    .sort((left, right) => {
      const riskDiff = numericValue(right.totalMoneyAtRisk) - numericValue(left.totalMoneyAtRisk);
      if (riskDiff !== 0) return riskDiff;
      const oosDiff = compareOosTiming(left, right);
      if (oosDiff !== 0) return oosDiff;
      const tierDiff = tierRank(left.tier) - tierRank(right.tier);
      if (tierDiff !== 0) return tierDiff;
      return numericValue(right.maxWaitingDays) - numericValue(left.maxWaitingDays);
    });
}

function moneyText(value: unknown) {
  return (
    <Typography.Text strong style={{ background: '#fff1f0', color: '#cf1322', padding: '1px 6px', borderRadius: 4 }}>
      {formatMoney(value)}
    </Typography.Text>
  );
}

function statusTag(value?: string, needsCheck?: boolean) {
  return (
    <Space size={4} wrap>
      <Tag color={statusColor(value)}>{value ?? 'unknown'}</Tag>
      {needsCheck ? <Tag color="orange">needs status check</Tag> : null}
    </Space>
  );
}

function evidenceRows(evidence: PlainRecord | undefined) {
  return Object.entries(evidence ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
}

export default function OrderPlanningPage() {
  const api = useAPIClient();
  const { message } = App.useApp();
  const t = useT();
  const [rows, setRows] = useState<PlainRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlainRecord | null>(null);
  const [selectedLine, setSelectedLine] = useState<PlainRecord | null>(null);
  const [queueFilter, setQueueFilter] = useState('money');
  const [orderForm] = Form.useForm();
  const [lineForm] = Form.useForm();
  const [commentForm] = Form.useForm();

  const visibleRows = useMemo(() => queueRows(rows, queueFilter), [queueFilter, rows]);
  const supplierGroups = useMemo(() => groupOrders(visibleRows), [visibleRows]);
  const criticalGroups = useMemo(() => supplierGroups.slice(0, 10), [supplierGroups]);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = unwrapData(
        await api.request({
          url: 'ecobaseOrderPlanning:list',
          method: 'post',
          data: { limit: DEFAULT_LIMIT },
        }),
      );
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(t('Order planning failed to load.')));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  const refreshGoldRows = useCallback(async () => {
    setLoading(true);
    try {
      await api.request({
        url: 'ecobaseOrderPlanning:refreshReadModel',
        method: 'post',
        data: { limit: DEFAULT_LIMIT },
      });
      await loadWorkspace();
      message.success(t('Order planning rows refreshed'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('Order planning refresh failed.'));
    } finally {
      setLoading(false);
    }
  }, [api, loadWorkspace, message, t]);

  const loadDetail = useCallback(
    async (orderId: string) => {
      setDetailLoading(true);
      try {
        const data = unwrapData(
          await api.request({ url: 'ecobaseOrderPlanning:detail', method: 'post', data: { orderId } }),
        );
        setDetail(data);
      } catch (err) {
        message.error(err instanceof Error ? err.message : t('Order detail failed to load.'));
      } finally {
        setDetailLoading(false);
      }
    },
    [api, message, t],
  );

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (selectedOrderId) void loadDetail(selectedOrderId);
  }, [loadDetail, selectedOrderId]);

  useEffect(() => {
    if (!detail?.order) return;
    orderForm.setFieldsValue({
      lifecycleStatus: detail.order.currentStatus ?? detail.order.canonicalStatus ?? detail.order.lifecycleStatus,
      nextAction: detail.order.nextAction,
      nextActionDueAt: detail.order.nextActionDueAt,
      expectedDeliveryDate: detail.order.expectedDeliveryDate,
      trackingId: detail.order.trackingId,
      remarks: detail.order.remarks,
      commentBody: undefined,
    });
  }, [detail, orderForm]);

  useEffect(() => {
    if (!selectedLine) return;
    lineForm.resetFields();
    lineForm.setFieldsValue({
      orderedQty: selectedLine.orderedQty,
      confirmedQty: selectedLine.confirmedQty,
      unitCost: selectedLine.unitCost,
      expectedSellPrice: selectedLine.expectedSellPrice,
      expectedMargin: selectedLine.expectedMargin,
      expectedProfit: selectedLine.expectedProfit,
      expectedDeliveryDate: selectedLine.expectedDeliveryDate,
      expectedSellableDate: selectedLine.expectedSellableDate,
      priority: selectedLine.priority,
      commentBody: undefined,
    });
  }, [lineForm, selectedLine]);

  const openOrder = (orderId?: string) => {
    if (!orderId) return;
    setSelectedOrderId(orderId);
    setSelectedLine(null);
    setDetail(null);
  };

  const closeDrawer = () => {
    setSelectedOrderId(null);
    setSelectedLine(null);
    setDetail(null);
    orderForm.resetFields();
    lineForm.resetFields();
    commentForm.resetFields();
  };

  const saveOrder = async () => {
    if (!selectedOrderId) return;
    const values = await orderForm.validateFields();
    const { commentBody, ...fields } = values;
    await api.request({
      url: 'ecobaseOrderPlanning:updateOrder',
      method: 'post',
      data: { orderId: selectedOrderId, fields, commentBody },
    });
    message.success(t('Order updated'));
    await loadDetail(selectedOrderId);
    await loadWorkspace();
  };

  const saveLine = async () => {
    if (!selectedLine || !selectedOrderId) return;
    const values = await lineForm.validateFields();
    const { commentBody, ...fields } = values;
    await api.request({
      url: 'ecobaseOrderPlanning:updateLine',
      method: 'post',
      data: { orderLineId: selectedLine.id, fields, commentBody },
    });
    message.success(t('Order line updated'));
    setSelectedLine(null);
    await loadDetail(selectedOrderId);
    await loadWorkspace();
  };

  const addComment = async () => {
    if (!selectedOrderId) return;
    const values = await commentForm.validateFields();
    await api.request({
      url: 'ecobaseOrderPlanning:addComment',
      method: 'post',
      data: { orderId: selectedOrderId, body: values.body },
    });
    message.success(t('Comment added'));
    commentForm.resetFields();
    await loadDetail(selectedOrderId);
    await loadWorkspace();
  };

  const updateInvoiceStatus = async (invoiceId: string, status: string) => {
    if (!selectedOrderId) return;
    await api.request({
      url: 'ecobaseOrderPlanning:updateInvoice',
      method: 'post',
      data: { invoiceId, status },
    });
    message.success(t('Invoice status updated'));
    await loadDetail(selectedOrderId);
    await loadWorkspace();
  };

  const deleteComment = async (commentId: string) => {
    if (!selectedOrderId) return;
    await api.request({
      url: 'ecobaseOrderPlanning:deleteComment',
      method: 'post',
      data: { orderId: selectedOrderId, commentId },
    });
    message.success(t('Comment deleted'));
    await loadDetail(selectedOrderId);
    await loadWorkspace();
  };

  const orderColumns = [
    {
      title: t('Order ID'),
      dataIndex: 'orderRef',
      width: 150,
      render: (value: string, row: PlainRecord) => (
        <Button
          type="link"
          onClick={(event) => {
            event.stopPropagation();
            openOrder(row.id);
          }}
        >
          {value}
        </Button>
      ),
    },
    {
      title: t('Company'),
      dataIndex: 'companyName',
      width: 160,
      render: (value: string) => value || '—',
    },
    {
      title: t('Current status'),
      dataIndex: 'currentStatus',
      width: 220,
      render: (value: string, row: PlainRecord) => statusTag(value, row.statusCheckRequired),
    },
    { title: t('Tier'), dataIndex: 'tier', width: 80, render: (value: string) => value || '—' },
    { title: t('ASINs'), dataIndex: 'asinCount', width: 90, render: formatNumber },
    { title: t('Lines'), dataIndex: 'lineCount', width: 90, render: formatNumber },
    {
      title: t('Money at risk'),
      dataIndex: 'moneyAtRisk',
      width: 145,
      render: moneyText,
      sorter: (left: PlainRecord, right: PlainRecord) =>
        numericValue(left.moneyAtRisk) - numericValue(right.moneyAtRisk),
    },
    {
      title: t('Earliest OOS'),
      dataIndex: 'earliestOosDate',
      width: 135,
      render: formatDate,
      sorter: compareOosDate,
    },
    {
      title: t('OOS timing'),
      key: 'oosTiming',
      width: 165,
      render: (_: unknown, row: PlainRecord) => oosText(row),
      sorter: compareOosTiming,
    },
    {
      title: t('Waiting'),
      dataIndex: 'daysSinceLastActivity',
      width: 110,
      render: (value: number) => (Number.isFinite(Number(value)) ? `${value}d` : '—'),
      sorter: (left: PlainRecord, right: PlainRecord) =>
        numericValue(left.daysSinceLastActivity) - numericValue(right.daysSinceLastActivity),
    },
    {
      title: t('Latest comment / remark'),
      dataIndex: 'latestComment',
      width: 260,
      ellipsis: true,
      render: (value: string) => value || '—',
    },
    { title: t('Expected delivery'), dataIndex: 'expectedDeliveryDate', width: 145, render: formatDate },
    { title: t('Next action'), dataIndex: 'nextAction', width: 170, render: (value: string) => value || '—' },
  ];

  const groupColumns = [
    {
      title: t('Supplier / order group'),
      key: 'supplierGroup',
      width: 320,
      fixed: 'left' as const,
      render: (_: unknown, group: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Space size={4} wrap>
            <Tag color="blue">{t('Supplier')}</Tag>
            <Typography.Text strong>{group.supplierName}</Typography.Text>
          </Space>
          <Space size={4} wrap>
            {(Array.isArray(group.companyNames) ? group.companyNames : []).map((company: string) => (
              <Typography.Text key={company} type="secondary">
                {company}
              </Typography.Text>
            ))}
          </Space>
          <Space size={4} wrap>
            {group.tier ? <Tag color="purple">Tier {group.tier}</Tag> : null}
            {group.needsStatusCheckCount ? <Tag color="orange">{group.needsStatusCheckCount} status checks</Tag> : null}
          </Space>
          {group.latestComment ? (
            <Typography.Text type="secondary" ellipsis style={{ maxWidth: 300 }}>
              {group.latestComment}
            </Typography.Text>
          ) : null}
        </Space>
      ),
      sorter: (left: PlainRecord, right: PlainRecord) =>
        String(left.supplierName).localeCompare(String(right.supplierName)),
    },
    { title: t('Orders'), dataIndex: 'orderCount', width: 95, render: formatNumber },
    { title: t('Tier'), dataIndex: 'tier', width: 80, render: (value: string) => value || '—' },
    { title: t('ASINs'), dataIndex: 'asinCount', width: 95, render: formatNumber },
    { title: t('Lines'), dataIndex: 'lineCount', width: 95, render: formatNumber },
    {
      title: t('Money at risk'),
      dataIndex: 'totalMoneyAtRisk',
      width: 150,
      render: moneyText,
      sorter: (left: PlainRecord, right: PlainRecord) =>
        numericValue(left.totalMoneyAtRisk) - numericValue(right.totalMoneyAtRisk),
    },
    {
      title: t('Earliest OOS'),
      dataIndex: 'earliestOosDate',
      width: 135,
      render: formatDate,
      sorter: compareOosDate,
    },
    {
      title: t('OOS timing'),
      key: 'oosTiming',
      width: 165,
      render: (_: unknown, group: PlainRecord) => oosText(group),
      sorter: compareOosTiming,
    },
    {
      title: t('Longest waiting'),
      dataIndex: 'maxWaitingDays',
      width: 130,
      render: (value: number) => (Number.isFinite(Number(value)) ? `${value}d` : '—'),
      sorter: (left: PlainRecord, right: PlainRecord) =>
        numericValue(left.maxWaitingDays) - numericValue(right.maxWaitingDays),
    },
  ];

  const lineColumns = [
    { title: t('ASIN'), dataIndex: 'asin', width: 110 },
    { title: t('SKU'), dataIndex: 'sku', width: 110 },
    { title: t('Title'), dataIndex: 'title', width: 240, ellipsis: true },
    { title: t('Ordered'), dataIndex: 'orderedQty', width: 100, render: formatNumber },
    { title: t('Confirmed'), dataIndex: 'confirmedQty', width: 110, render: formatNumber },
    { title: t('Unit cost'), dataIndex: 'unitCost', width: 100, render: formatNumber },
    { title: t('Sell price'), dataIndex: 'expectedSellPrice', width: 110, render: formatNumber },
    { title: t('Margin'), dataIndex: 'expectedMargin', width: 100, render: formatNumber },
    { title: t('Profit'), dataIndex: 'expectedProfit', width: 100, render: formatNumber },
    { title: t('Delivery'), dataIndex: 'expectedDeliveryDate', width: 120, render: formatDate },
    { title: t('Sellable'), dataIndex: 'expectedSellableDate', width: 120, render: formatDate },
    { title: t('Priority'), dataIndex: 'priority', width: 100, render: (value: string) => value || '—' },
    {
      title: t('Edit'),
      key: 'edit',
      width: 90,
      render: (_: unknown, row: PlainRecord) => (
        <Button size="small" onClick={() => setSelectedLine(row)}>
          {t('Edit')}
        </Button>
      ),
    },
  ];

  const invoiceColumns = [
    { title: t('Invoice'), dataIndex: 'invoiceNumber', width: 180, render: (value: string) => value || '—' },
    { title: t('Type'), dataIndex: 'invoiceType', width: 110, render: (value: string) => value || '—' },
    {
      title: t('Status'),
      dataIndex: 'status',
      width: 190,
      render: (value: string, row: PlainRecord) => (
        <Select
          size="small"
          value={value}
          style={{ width: 160 }}
          options={selectOptions(INVOICE_STATUS_OPTIONS, value)}
          onChange={(status) => void updateInvoiceStatus(row.id, status)}
        />
      ),
    },
    {
      title: t('Amount'),
      dataIndex: 'amount',
      width: 110,
      render: (value: unknown) => (value == null ? '—' : formatMoney(value)),
    },
    { title: t('Payment mode'), dataIndex: 'paymentMode', width: 130, render: (value: string) => value || '—' },
    { title: t('Paid at'), dataIndex: 'paidAt', width: 140, render: formatDate },
    {
      title: t('File'),
      dataIndex: 'fileUrl',
      width: 100,
      render: (value: string) => (value ? <a href={value}>{t('Open')}</a> : '—'),
    },
    { title: t('Remarks'), dataIndex: 'remarks', width: 220, ellipsis: true, render: (value: string) => value || '—' },
  ];

  const renderGroupedTable = (dataSource: PlainRecord[], pageSize: false | number) => (
    <Table<PlainRecord>
      rowKey="key"
      loading={loading}
      dataSource={dataSource}
      columns={groupColumns}
      pagination={pageSize ? { pageSize } : false}
      scroll={{ x: 1200 }}
      onRow={(group) => ({ onClick: () => openOrder(group.orders?.[0]?.id) })}
      expandable={{
        expandIcon: ({ expanded, onExpand, record }) => (
          <Button
            size="small"
            type="text"
            onClick={(event) => {
              event.stopPropagation();
              onExpand(record, event);
            }}
          >
            {expanded ? '−' : '+'}
          </Button>
        ),
        expandedRowRender: (group) => (
          <Table<PlainRecord>
            size="small"
            rowKey="id"
            dataSource={group.orders}
            columns={orderColumns}
            pagination={false}
            scroll={{ x: 1500 }}
            onRow={(row) => ({ onClick: () => openOrder(row.id) })}
          />
        ),
      }}
    />
  );

  const selectedOrder = detail?.order ?? null;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card>
        <Typography.Title level={3}>{t('Order Planning')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('All companies are included. Gold order-planning rows drive this queue.')}
        </Typography.Paragraph>
        {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 12 }} /> : null}
        <Tabs
          activeKey={queueFilter}
          onChange={setQueueFilter}
          items={QUEUE_FILTERS.map((key) => ({
            key,
            label:
              key === 'money'
                ? t('Money at risk')
                : key === 'needs_status_check'
                  ? t('Needs status check')
                  : key === 'before_ordered'
                    ? t('Before ordered')
                    : key === 'after_ordered'
                      ? t('After ordered')
                      : t('Complete / history'),
          }))}
        />
        <Space size="large" wrap>
          <Typography.Text>
            {t('Showing')} {supplierGroups.length} {t('supplier groups')} / {visibleRows.length} {t('orders')} (
            {rows.length} {t('total')})
          </Typography.Text>
          <Button loading={loading} onClick={() => void loadWorkspace()}>
            {t('Reload')}
          </Button>
          <Button loading={loading} onClick={() => void refreshGoldRows()}>
            {t('Rebuild gold rows')}
          </Button>
        </Space>
      </Card>

      <Card
        title={t('Critical order digest')}
        extra={<Typography.Text type="secondary">{t('Top supplier groups ranked by money at risk.')}</Typography.Text>}
      >
        {renderGroupedTable(criticalGroups, false)}
      </Card>

      <Card
        title={t('Supplier order workflow table')}
        extra={
          <Typography.Text type="secondary">
            {t('Sort by money at risk, earliest OOS, or OOS timing; expand supplier groups to open order rows.')}
          </Typography.Text>
        }
      >
        {renderGroupedTable(supplierGroups, 20)}
      </Card>

      <Drawer
        open={!!selectedOrderId}
        width={1100}
        title={selectedOrder ? `${selectedOrder.orderRef} · ${selectedOrder.supplierName}` : t('Order detail')}
        onClose={closeDrawer}
      >
        {selectedOrder ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label={t('Order ref')}>{selectedOrder.orderRef}</Descriptions.Item>
              <Descriptions.Item label={t('Company')}>{selectedOrder.companyName}</Descriptions.Item>
              <Descriptions.Item label={t('Supplier')}>{selectedOrder.supplierName}</Descriptions.Item>
              <Descriptions.Item label={t('Status')}>
                {statusTag(selectedOrder.currentStatus, selectedOrder.statusCheckRequired)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Status source')}>{selectedOrder.statusSource || '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Tier')}>{selectedOrder.tier || '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Money at risk')}>{formatMoney(selectedOrder.moneyAtRisk)}</Descriptions.Item>
              <Descriptions.Item label={t('Out of stock')}>{oosText(selectedOrder)}</Descriptions.Item>
              <Descriptions.Item label={t('Waiting')}>{selectedOrder.daysSinceLastActivity ?? '—'}d</Descriptions.Item>
              <Descriptions.Item label={t('Expected delivery')}>
                {formatDate(selectedOrder.expectedDeliveryDate)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Next action')}>{selectedOrder.nextAction || '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Latest comment / remark')}>
                {selectedOrder.latestComment || '—'}
              </Descriptions.Item>
            </Descriptions>

            <Collapse defaultActiveKey={['order-product-lines']}>
              <Collapse.Panel header={t('Order product lines')} key="order-product-lines">
                <Table<PlainRecord>
                  rowKey="id"
                  size="small"
                  dataSource={Array.isArray(detail.lines) ? detail.lines : []}
                  columns={lineColumns}
                  pagination={false}
                  scroll={{ x: 1500 }}
                />
                {selectedLine ? (
                  <>
                    <Divider orientation="left">{t('Edit selected line')}</Divider>
                    <Form form={lineForm} layout="vertical">
                      <Row gutter={12}>
                        <Col xs={24} md={6}>
                          <Form.Item name="orderedQty" label={t('Ordered qty')}>
                            <InputNumber min={0} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="confirmedQty" label={t('Confirmed qty')}>
                            <InputNumber min={0} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="unitCost" label={t('Unit cost')}>
                            <InputNumber min={0} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="expectedSellPrice" label={t('Sell price')}>
                            <InputNumber min={0} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="expectedMargin" label={t('Margin')}>
                            <InputNumber style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="expectedProfit" label={t('Profit')}>
                            <InputNumber style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="expectedDeliveryDate" label={t('Expected delivery')}>
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="expectedSellableDate" label={t('Expected sellable')}>
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={6}>
                          <Form.Item name="priority" label={t('Priority')}>
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col xs={24}>
                          <Form.Item name="commentBody" label={t('Edit comment')}>
                            <Input.TextArea rows={2} />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Space>
                        <Button type="primary" loading={detailLoading} onClick={() => void saveLine()}>
                          {t('Save line')}
                        </Button>
                        <Button onClick={() => setSelectedLine(null)}>{t('Cancel')}</Button>
                      </Space>
                    </Form>
                  </>
                ) : null}
              </Collapse.Panel>

              <Collapse.Panel header={t('Invoices')} key="invoices">
                {Array.isArray(detail.invoices) && detail.invoices.length ? (
                  <Table<PlainRecord>
                    rowKey="id"
                    size="small"
                    dataSource={detail.invoices}
                    columns={invoiceColumns}
                    pagination={false}
                    scroll={{ x: 1150 }}
                  />
                ) : (
                  <Typography.Text type="secondary">{t('No invoices linked to this order yet.')}</Typography.Text>
                )}
              </Collapse.Panel>

              <Collapse.Panel header={t('Edit order')} key="edit-order">
                <Form form={orderForm} layout="vertical">
                  <Row gutter={12}>
                    <Col xs={24} md={8}>
                      <Form.Item name="lifecycleStatus" label={t('Order status')}>
                        <Select
                          options={ORDER_LIFECYCLE_STATUSES.map((status) => ({ label: status, value: status }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="nextAction" label={t('Next action')}>
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="nextActionDueAt" label={t('Next action due')}>
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="expectedDeliveryDate" label={t('Expected delivery')}>
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="trackingId" label={t('Tracking ID')}>
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item name="remarks" label={t('Remarks')}>
                        <Input.TextArea rows={2} />
                      </Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item name="commentBody" label={t('Edit comment')}>
                        <Input.TextArea rows={2} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Button type="primary" loading={detailLoading} onClick={() => void saveOrder()}>
                    {t('Save order')}
                  </Button>
                </Form>
              </Collapse.Panel>

              <Collapse.Panel header={t('Comments')} key="comments">
                <Form form={commentForm} layout="vertical">
                  <Form.Item
                    name="body"
                    label={t('New comment')}
                    rules={[{ required: true, message: t('Comment is required') }]}
                  >
                    <Input.TextArea rows={2} />
                  </Form.Item>
                  <Button onClick={() => void addComment()}>{t('Add comment')}</Button>
                </Form>
                <Divider />
                <Table<PlainRecord>
                  size="small"
                  rowKey="id"
                  dataSource={Array.isArray(detail.comments) ? detail.comments : []}
                  pagination={{ pageSize: 5 }}
                  columns={[
                    { title: t('Created'), dataIndex: 'createdAt', width: 180, render: formatDate },
                    { title: t('Type'), dataIndex: 'commentType', width: 120 },
                    { title: t('Comment'), dataIndex: 'body' },
                    {
                      title: t('Actions'),
                      key: 'actions',
                      width: 110,
                      render: (_: unknown, row: PlainRecord) => (
                        <Popconfirm
                          title={t('Delete comment?')}
                          okText={t('Delete')}
                          cancelText={t('Cancel')}
                          onConfirm={() => void deleteComment(row.id)}
                        >
                          <Button size="small" danger>
                            {t('Delete')}
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]}
                />
              </Collapse.Panel>

              <Collapse.Panel header={t('Status evidence')} key="status-evidence">
                {evidenceRows(selectedOrder.statusEvidence).length ? (
                  <Descriptions bordered size="small" column={1}>
                    {evidenceRows(selectedOrder.statusEvidence).map(([key, value]) => (
                      <Descriptions.Item key={key} label={key}>
                        {String(value)}
                      </Descriptions.Item>
                    ))}
                  </Descriptions>
                ) : (
                  <Typography.Text type="secondary">{t('No imported status evidence recorded yet.')}</Typography.Text>
                )}
              </Collapse.Panel>
            </Collapse>
          </Space>
        ) : detailLoading ? (
          <Typography.Text>{t('Loading order detail…')}</Typography.Text>
        ) : null}
      </Drawer>
    </Space>
  );
}
