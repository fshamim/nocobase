import { useAPIClient } from '@nocobase/client';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FormulaHelp } from '../formula-help';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;
type OrderNowQuickFilter =
  | 'all'
  | 'urgent_today'
  | 'missing_supplier'
  | 'lead_time_issues'
  | 'no_order'
  | 'placed_not_purchased';
type OrderNowSortKey = 'urgency' | 'oos_asc' | 'risk_desc' | 'tier' | 'supplier';

interface DigestPreview {
  summary: PlainRecord;
  sections: {
    orderNow: PlainRecord[];
    noOrderProducts: PlainRecord[];
    suppliersToContactFirst: PlainRecord[];
    supplierActionItems: PlainRecord[];
    staleLeadTimes: PlainRecord[];
  };
}

interface DrawerActionValues {
  draftQty: number;
  draftSupplierId: string;
  draftExpectedDeliveryDate?: string;
  draftExpectedSellableDate?: string;
  draftNotes: string;
  addSupplierOrderId: string;
  addQty: number;
  addExpectedDeliveryDate?: string;
  addExpectedSellableDate?: string;
  addNotes: string;
  leadSupplierId: string;
  leadTimeDays?: number;
  leadNotes: string;
}

interface LineEditValues {
  id: string;
  externalOrderRef: string;
  orderedQty: number;
  receivedQty: number;
  unitCost?: number;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  notes: string;
}

interface OrderEditValues {
  supplierOrderId: string;
  supplierId: string;
  status: string;
  notes: string;
}

const SUPPLIER_ORDER_STATUS_OPTIONS = [
  'draft',
  'supplier_contacted',
  'supplier_confirmed',
  'approval_pending',
  'payment_pending',
  'paid',
  'supplier_preparing',
  'shipped_inbound',
  'reached_fba',
  'completed',
  'blocked',
  'rejected',
  'cancelled',
].map((value) => ({ value, label: value }));

function unwrapRows(response: any): PlainRecord[] {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return Array.isArray(data) ? data : [];
}

function unwrapData(response: any): PlainRecord {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function unwrapDigest(response: any): DigestPreview {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || 'summary' in data || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return {
    summary: data?.summary ?? {},
    sections: {
      orderNow: Array.isArray(data?.sections?.orderNow) ? data.sections.orderNow : [],
      noOrderProducts: Array.isArray(data?.sections?.noOrderProducts) ? data.sections.noOrderProducts : [],
      suppliersToContactFirst: Array.isArray(data?.sections?.suppliersToContactFirst)
        ? data.sections.suppliersToContactFirst
        : [],
      supplierActionItems: Array.isArray(data?.sections?.supplierActionItems) ? data.sections.supplierActionItems : [],
      staleLeadTimes: Array.isArray(data?.sections?.staleLeadTimes) ? data.sections.staleLeadTimes : [],
    },
  };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

const ACTION_PRIORITY: Record<string, number> = {
  overdue: 0,
  order_today: 1,
  missing_lead_time: 2,
  stale_lead_time: 2,
  order_soon: 3,
  already_ordered: 4,
  watch: 5,
  sufficient_stock: 6,
  excluded: 7,
};

const TIER_PRIORITY: Record<string, number> = { A: 0, B: 1, C: 2 };

function actionColor(value?: string) {
  switch (value) {
    case 'overdue':
      return 'red';
    case 'order_today':
      return 'volcano';
    case 'missing_lead_time':
      return 'gold';
    case 'stale_lead_time':
      return 'orange';
    case 'order_soon':
      return 'orange';
    case 'already_ordered':
      return 'blue';
    case 'watch':
      return 'cyan';
    case 'sufficient_stock':
      return 'green';
    case 'excluded':
      return 'default';
    default:
      return 'default';
  }
}

function supplierOrderStateLabel(row: PlainRecord, t: (key: string) => string, onEdit?: () => void) {
  const state = String(row.supplierOrderState ?? 'no_open_order');
  const latestNote = String(row.latestSupplierOrderActivityNote ?? '').trim();
  const latestType = String(row.latestSupplierOrderActivityType ?? '').trim();
  const updateButton = onEdit ? (
    <Button
      size="small"
      type="link"
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
      style={{ padding: 0, height: 'auto' }}
    >
      {t('Update')}
    </Button>
  ) : null;
  const content = (tag: React.ReactNode, statusFallback: string) => (
    <Space direction="vertical" size={0}>
      {tag}
      <Typography.Text type="secondary">
        {String(row.supplierOrderRef ?? '—')} · {t(String(row.supplierOrderStatus ?? statusFallback))}
      </Typography.Text>
      {latestNote ? (
        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 220 }}>
          {latestType ? `${t(latestType)}: ` : ''}
          {latestNote}
        </Typography.Text>
      ) : null}
      {updateButton}
    </Space>
  );
  if (state === 'placed_not_purchased') {
    return content(<Tag color="orange">{t('Order placed, not purchased')}</Tag>, 'unknown');
  }
  if (state === 'closed_history') {
    return content(<Tag color="default">{t('No open order')}</Tag>, 'closed');
  }
  if (state === 'purchased_pipeline') {
    return content(<Tag color="blue">{t('Purchased / pipeline')}</Tag>, 'unknown');
  }
  return <Tag color="red">{t('No order history')}</Tag>;
}

function tierColor(value?: string) {
  switch (value) {
    case 'A':
      return 'green';
    case 'B':
      return 'gold';
    case 'C':
      return 'magenta';
    default:
      return 'default';
  }
}

function freshnessColor(value?: string) {
  switch (value) {
    case 'fresh':
      return 'green';
    case 'stale':
      return 'orange';
    case 'missing':
      return 'red';
    default:
      return 'default';
  }
}

function supplierOrderStatusColor(value?: string) {
  switch (value) {
    case 'draft':
      return 'blue';
    case 'supplier_contacted':
    case 'supplier_confirmed':
      return 'cyan';
    case 'approval_pending':
    case 'payment_pending':
      return 'gold';
    case 'paid':
    case 'supplier_preparing':
    case 'shipped':
    case 'inbound':
      return 'orange';
    case 'completed':
      return 'green';
    case 'cancelled':
      return 'red';
    default:
      return 'default';
  }
}

function formatNumber(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
}

function formatCurrency(value: any) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—';
}

function formatDate(value: any) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 10) : '—';
}

function relativeDateLabel(value: any, baseDate: string) {
  if (typeof value !== 'string' || value.length === 0) return { label: '—', detail: undefined };
  const target = dayjs(value.slice(0, 10));
  const base = dayjs(baseDate);
  const diff = target.diff(base, 'day');
  if (diff < 0) return { label: `${Math.abs(diff)} days overdue`, detail: value.slice(0, 10), color: 'red' };
  if (diff === 0) return { label: 'Today', detail: value.slice(0, 10), color: 'volcano' };
  if (diff === 1) return { label: 'Tomorrow', detail: value.slice(0, 10), color: 'orange' };
  return { label: `In ${diff} days`, detail: value.slice(0, 10), color: diff <= 7 ? 'gold' : 'default' };
}

function StockStatus({ row, t }: { row: PlainRecord; t: (key: string) => string }) {
  const reserved = Number(row.reservedStock ?? 0);
  const sellable = Number(row.sellableStock ?? 0);
  const pipeline = Number(row.pipelineStock ?? 0);
  const reservedColor = reserved > sellable ? 'red' : reserved > 0 ? 'orange' : 'default';
  return (
    <Space direction="vertical" size={4}>
      <Space size={4} wrap>
        <Tag color="blue">
          {t('Total')} {formatNumber(row.currentPlanningStock)}
        </Tag>
        {row.stuck ? <Tag color="purple">{t('STUCK')}</Tag> : null}
      </Space>
      <Space size={4} wrap>
        <Tag color={sellable > 0 ? 'green' : 'red'}>
          {t('Sellable')} {formatNumber(sellable)}
        </Tag>
        <Tag color={reservedColor}>
          {t('Reserved')} {formatNumber(reserved)}
        </Tag>
        <Tag color={pipeline > 0 ? 'cyan' : 'default'}>
          {t('Replenishment')} {formatNumber(pipeline)}
        </Tag>
      </Space>
    </Space>
  );
}

function leadTimeSourceText(row: PlainRecord) {
  if (row.leadTimeSource === 'planning_parameter_without_supplier_mapping') {
    return 'Lead time is coming from the planning-parameter import for this ASIN/company; supplier mapping is still missing.';
  }
  if (row.leadTimeSource === 'supplier_or_planning_parameter') {
    return 'Lead time is coming from supplier data when available, otherwise the imported planning parameter.';
  }
  return 'Lead time source is not yet classified.';
}

function monetaryRiskText(row: PlainRecord) {
  if (row.estimatedProfitRiskBasis === 'uncovered_oos_days × sales_velocity × profit_per_unit') {
    return 'Potential profit loss if this product remains uncovered: max(lead time + safety buffer − days of cover, 0) × sales velocity × profit per unit.';
  }
  if (row.estimatedProfitRiskBasis === 'planning_calculation_estimated_profit_risk') {
    return 'Potential profit loss from the planning calculation service. It uses uncovered days, sales velocity, and profit per unit when those inputs are available.';
  }
  if (row.estimatedProfitRiskBasis === 'imported_missed_profit_or_30_day_profit_forecast') {
    return 'Imported missed-profit estimate or 30-day profit forecast for a tiered product.';
  }
  if (row.estimatedProfitRiskBasis === 'not_tiered_profit_inputs_missing') {
    return 'No active money at risk: this product is not in profit tier A, B, or C because profit inputs are missing or zero.';
  }
  return 'Money at risk is unavailable until tierable profit data is imported.';
}

function productStatusText() {
  return 'MasterStock status uses operator BackendSheet status first for Not selling, Hold, or One Time. Otherwise it derives OOS, Inactive, Inbound, or Reserved from sellable, reserved, inbound, ordered, and prep/AWD stock buckets.';
}

function orderCoverageText() {
  return 'Coverage counts only reliable purchased pipeline that can still prevent OOS: paid, supplier preparing, or shipped inbound orders in the current recovery cycle. Draft, approval/payment-pending, cancelled, reached-FBA, and old historical rows do not reduce suggested reorder quantity, so this is often zero.';
}

function tierScoreText() {
  return "Tier score follows the sheet's Top SKU logic: Profit Per Unit × Rec. Best Qty. It is separate from money at risk; when those profit inputs are missing the score is 0.";
}

function columnHelp(title: string, help: string) {
  return (
    <Tooltip title={help}>
      <span>{title}</span>
    </Tooltip>
  );
}

function isUuid(value: any) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function defaultOrderQty(row: PlainRecord) {
  const qty = Number(row.suggestedReorderQty);
  return Number.isFinite(qty) && qty > 0 ? Math.ceil(qty) : 1;
}

function numericValue(value: any, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function textValue(value: any) {
  return String(value ?? '').toLowerCase();
}

function orderNowMatchesQuickFilter(row: PlainRecord, filter: OrderNowQuickFilter) {
  if (filter === 'urgent_today') {
    return ['overdue', 'order_today'].includes(String(row.actionStatus ?? ''));
  }
  if (filter === 'missing_supplier') {
    return !row.supplierName;
  }
  if (filter === 'lead_time_issues') {
    return (
      row.actionStatus === 'missing_lead_time' || ['missing', 'stale'].includes(String(row.leadTimeFreshness ?? ''))
    );
  }
  if (filter === 'no_order') {
    return ['no_open_order', 'closed_history'].includes(String(row.supplierOrderState ?? ''));
  }
  if (filter === 'placed_not_purchased') {
    return row.supplierOrderState === 'placed_not_purchased';
  }
  return true;
}

function digestOrderStatePriority(row: PlainRecord) {
  const state = String(row.supplierOrderState ?? 'no_open_order');
  if (state === 'no_open_order') return 0;
  if (state === 'placed_not_purchased') return 1;
  if (state === 'closed_history') return 1;
  if (state === 'purchased_pipeline') return 2;
  return 3;
}

function sortOrderNowRows(rows: PlainRecord[], sortKey: OrderNowSortKey, calculationDate: string) {
  return [...rows].sort((left, right) => {
    if (sortKey === 'risk_desc') {
      return numericValue(right.estimatedProfitRisk, -1) - numericValue(left.estimatedProfitRisk, -1);
    }
    if (sortKey === 'oos_asc') {
      return String(left.estimatedOosDate ?? '9999-12-31').localeCompare(
        String(right.estimatedOosDate ?? '9999-12-31'),
      );
    }
    if (sortKey === 'tier') {
      const tierDiff = (TIER_PRIORITY[String(left.tier ?? '')] ?? 99) - (TIER_PRIORITY[String(right.tier ?? '')] ?? 99);
      if (tierDiff !== 0) return tierDiff;
      const actionDiff =
        (ACTION_PRIORITY[String(left.actionStatus ?? '')] ?? 99) -
        (ACTION_PRIORITY[String(right.actionStatus ?? '')] ?? 99);
      if (actionDiff !== 0) return actionDiff;
      return numericValue(right.estimatedProfitRisk, -1) - numericValue(left.estimatedProfitRisk, -1);
    }
    if (sortKey === 'supplier') {
      return String(left.supplierName ?? 'Find supplier from OrderDetails').localeCompare(
        String(right.supplierName ?? 'Find supplier from OrderDetails'),
      );
    }
    const orderStateDiff = digestOrderStatePriority(left) - digestOrderStatePriority(right);
    if (orderStateDiff !== 0) return orderStateDiff;
    const actionDiff =
      (ACTION_PRIORITY[String(left.actionStatus ?? '')] ?? 99) -
      (ACTION_PRIORITY[String(right.actionStatus ?? '')] ?? 99);
    if (actionDiff !== 0) return actionDiff;
    const leftOos = dayjs(left.estimatedOosDate ?? '9999-12-31').diff(dayjs(calculationDate), 'day');
    const rightOos = dayjs(right.estimatedOosDate ?? '9999-12-31').diff(dayjs(calculationDate), 'day');
    if (leftOos !== rightOos) return leftOos - rightOos;
    return numericValue(right.estimatedProfitRisk, -1) - numericValue(left.estimatedProfitRisk, -1);
  });
}

function orderNowGroupKey(row: PlainRecord) {
  const company = String(row.company ?? 'Unknown company');
  const orderRef = String(row.supplierOrderRef ?? '').trim();
  if (orderRef) return `order:${company}:${orderRef}`;
  const supplier = String(row.supplierName ?? '').trim();
  if (supplier) return `supplier:${company}:${supplier}`;
  return `missing-supplier:${company}`;
}

function orderNowGroupType(row: PlainRecord) {
  if (String(row.supplierOrderRef ?? '').trim()) return 'order';
  if (String(row.supplierName ?? '').trim()) return 'supplier';
  return 'missing_supplier';
}

function latestActivity(rows: PlainRecord[]) {
  return [...rows]
    .filter((row) => row.latestSupplierOrderActivityNote)
    .sort((left, right) =>
      String(right.latestSupplierOrderActivityAt ?? '').localeCompare(String(left.latestSupplierOrderActivityAt ?? '')),
    )[0];
}

function tierCounts(rows: PlainRecord[]) {
  return ['A', 'B', 'C']
    .map((tier) => ({ tier, count: rows.filter((row) => row.tier === tier).length }))
    .filter((item) => item.count > 0);
}

function groupOrderNowRows(rows: PlainRecord[], calculationDate: string) {
  const groups = new Map<string, PlainRecord>();
  for (const row of rows) {
    const key = orderNowGroupKey(row);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        key,
        type: orderNowGroupType(row),
        company: row.company,
        supplierName: row.supplierName,
        supplierOrderRef: row.supplierOrderRef,
        supplierOrderStatus: row.supplierOrderStatus,
        supplierOrderState: row.supplierOrderState,
        rows: [row],
      });
      continue;
    }
    group.rows.push(row);
  }

  return Array.from(groups.values()).map((group) => {
    const groupRows = group.rows as PlainRecord[];
    const sortedRows = sortOrderNowRows(groupRows, 'urgency', calculationDate);
    const firstProduct = sortedRows[0] ?? {};
    const latest = latestActivity(groupRows) ?? {};
    return {
      ...group,
      supplierName: group.supplierName ?? firstProduct.supplierName,
      productCount: groupRows.length,
      firstProduct,
      tierCounts: tierCounts(groupRows),
      totalMoneyAtRisk: groupRows.reduce((sum, row) => sum + numericValue(row.estimatedProfitRisk, 0), 0),
      earliestOosDate: groupRows
        .map((row) => String(row.estimatedOosDate ?? ''))
        .filter(Boolean)
        .sort()[0],
      leadTimeIssueCount: groupRows.filter((row) => ['missing', 'stale'].includes(String(row.leadTimeFreshness ?? '')))
        .length,
      topActionStatus: firstProduct.actionStatus,
      latestSupplierOrderActivityNote: latest.latestSupplierOrderActivityNote,
      latestSupplierOrderActivityAt: latest.latestSupplierOrderActivityAt,
    };
  });
}

function productLineMatches(row: PlainRecord, line: PlainRecord) {
  const rowPlanningProductId = String(row.planningProductId ?? '');
  const linePlanningProductId = String(line.planningProductId ?? '');
  const rowAsin = String(row.asin ?? '').toUpperCase();
  const lineAsin = String(line.asin ?? '').toUpperCase();
  const rowSku = String(row.sku ?? '');
  const lineSku = String(line.sku ?? '');
  return (
    (isUuid(rowPlanningProductId) && rowPlanningProductId === linePlanningProductId) ||
    (rowAsin && rowAsin === lineAsin) ||
    (rowSku && rowSku === lineSku)
  );
}

function FilterControl({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <Col xs={24} md={12} xl={6}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Typography.Text strong>{title}</Typography.Text>
        <Typography.Text type="secondary" style={{ minHeight: 44 }}>
          {help}
        </Typography.Text>
        {children}
      </Space>
    </Col>
  );
}

export default function InventoryPlanningPage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const [company, setCompany] = useState('');
  const [calculationDate, setCalculationDate] = useState('');
  const [actionStatus, setActionStatus] = useState<string | undefined>();
  const [tier, setTier] = useState<string | undefined>();
  const [leadTimeFreshnessDays, setLeadTimeFreshnessDays] = useState(60);
  const [orderSoonWindowDays, setOrderSoonWindowDays] = useState(14);
  const [safetyBufferDays, setSafetyBufferDays] = useState(7);
  const [reorderCycleDays, setReorderCycleDays] = useState(30);
  const [purchasedPipelineGraceDays, setPurchasedPipelineGraceDays] = useState(3);
  const [planningSettingsWarning, setPlanningSettingsWarning] = useState<string | undefined>();
  const [limit, setLimit] = useState(150);
  const [orderNowQuickFilter, setOrderNowQuickFilter] = useState<OrderNowQuickFilter>('all');
  const [orderNowTierFilter, setOrderNowTierFilter] = useState<string[]>([]);
  const [orderNowCompanyFilter, setOrderNowCompanyFilter] = useState<string[]>([]);
  const [orderNowSearch, setOrderNowSearch] = useState('');
  const [orderNowSort, setOrderNowSort] = useState<OrderNowSortKey>('tier');
  const [filterOptions, setFilterOptions] = useState<PlainRecord>({});
  const [rows, setRows] = useState<PlainRecord[]>([]);
  const [digest, setDigest] = useState<DigestPreview>(() => unwrapDigest({}));
  const [selectedRow, setSelectedRow] = useState<PlainRecord | null>(null);
  const [actionValues, setActionValues] = useState<DrawerActionValues | null>(null);
  const [supplierOptions, setSupplierOptions] = useState<PlainRecord[]>([]);
  const [orderOptions, setOrderOptions] = useState<PlainRecord[]>([]);
  const [orderLineHistory, setOrderLineHistory] = useState<PlainRecord[]>([]);
  const [orderActivities, setOrderActivities] = useState<PlainRecord[]>([]);
  const [productTasks, setProductTasks] = useState<PlainRecord[]>([]);
  const [productTargets, setProductTargets] = useState<PlainRecord[]>([]);
  const [lineEditValues, setLineEditValues] = useState<LineEditValues | null>(null);
  const [orderEditValues, setOrderEditValues] = useState<OrderEditValues | null>(null);
  const [managePanels, setManagePanels] = useState<string[]>([]);
  const [budgetAmount, setBudgetAmount] = useState<number | null>(null);
  const [budgetHorizonDays, setBudgetHorizonDays] = useState(30);
  const [budgetResult, setBudgetResult] = useState<PlainRecord | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadPlanningSettings = useCallback(async () => {
    const response = await api.request({ url: 'ecobasePlanningSettings:get', method: 'post', data: {} });
    const data = unwrapData(response);
    const settings = data.settings ?? {};
    setLeadTimeFreshnessDays(Number(settings.leadTimeFreshnessDays ?? 60));
    setOrderSoonWindowDays(Number(settings.orderSoonWindowDays ?? 14));
    setSafetyBufferDays(Number(settings.safetyBufferDays ?? 7));
    setReorderCycleDays(Number(settings.reorderCycleDays ?? 30));
    setPurchasedPipelineGraceDays(Number(settings.purchasedPipelineGraceDays ?? 3));
    setPlanningSettingsWarning(typeof data.warning === 'string' ? data.warning : undefined);
  }, [api]);

  const loadPlanning = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        company: company.trim() || undefined,
        calculationDate: calculationDate.trim() || undefined,
        leadTimeFreshnessDays,
        orderSoonWindowDays,
        safetyBufferDays,
        reorderCycleDays,
        purchasedPipelineGraceDays,
        limit,
      };
      const [filtersResponse, rowsResponse, digestResponse] = await Promise.all([
        api.request({ url: 'ecobaseInventoryPlanning:filters', method: 'post', data: {} }),
        api.request({ url: 'ecobaseInventoryPlanning:rows', method: 'post', data: payload }),
        api.request({ url: 'ecobaseInventoryPlanning:digestPreview', method: 'post', data: payload }),
      ]);
      setFilterOptions(unwrapData(filtersResponse));
      setRows(unwrapRows(rowsResponse));
      setDigest(unwrapDigest(digestResponse));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [
    api,
    calculationDate,
    company,
    leadTimeFreshnessDays,
    limit,
    orderSoonWindowDays,
    purchasedPipelineGraceDays,
    reorderCycleDays,
    safetyBufferDays,
  ]);

  useEffect(() => {
    void loadPlanningSettings().catch((err) => setError(err as Error));
  }, [loadPlanningSettings]);

  useEffect(() => {
    void loadPlanning();
  }, [loadPlanning]);

  const syncEditableRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await api.request({
        url: 'ecobaseInventoryPlanning:refreshReadModel',
        method: 'post',
        data: {
          company: company || undefined,
          calculationDate: calculationDate || undefined,
          leadTimeFreshnessDays,
          orderSoonWindowDays,
          safetyBufferDays,
          reorderCycleDays,
          purchasedPipelineGraceDays,
          limit: Math.max(limit, 500),
        },
      });
      await loadPlanning();
    } catch (err) {
      setError(err as Error);
      setLoading(false);
    }
  }, [
    api,
    calculationDate,
    company,
    leadTimeFreshnessDays,
    limit,
    loadPlanning,
    orderSoonWindowDays,
    purchasedPipelineGraceDays,
    reorderCycleDays,
    safetyBufferDays,
  ]);

  const runBudgetOptimizer = useCallback(async () => {
    if (!budgetAmount || budgetAmount <= 0) {
      message.error(t('Enter a budget greater than zero to run the optimizer.'));
      return;
    }
    setBudgetLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseInventoryPlanning:optimizeBudget',
        method: 'post',
        data: {
          company: company || undefined,
          calculationDate: calculationDate || undefined,
          leadTimeFreshnessDays,
          orderSoonWindowDays,
          safetyBufferDays,
          reorderCycleDays,
          purchasedPipelineGraceDays,
          limit,
          budget: budgetAmount,
          horizonDays: budgetHorizonDays,
        },
      });
      setBudgetResult(unwrapData(response));
    } catch (err) {
      setError(err as Error);
    } finally {
      setBudgetLoading(false);
    }
  }, [
    api,
    budgetAmount,
    budgetHorizonDays,
    calculationDate,
    company,
    leadTimeFreshnessDays,
    limit,
    message,
    orderSoonWindowDays,
    purchasedPipelineGraceDays,
    reorderCycleDays,
    safetyBufferDays,
    t,
  ]);

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (actionStatus && row.actionStatus !== actionStatus) return false;
        if (tier && row.tier !== tier) return false;
        return true;
      }),
    [actionStatus, rows, tier],
  );

  const relativeBaseDate = calculationDate || String(rows[0]?.calculationDate ?? todayIsoDate());

  const orderNowCompanies = useMemo(
    () => Array.from(new Set(digest.sections.orderNow.map((row) => String(row.company ?? '')).filter(Boolean))).sort(),
    [digest.sections.orderNow],
  );

  const orderNowTiers = useMemo(
    () => Array.from(new Set(digest.sections.orderNow.map((row) => String(row.tier ?? '')).filter(Boolean))).sort(),
    [digest.sections.orderNow],
  );

  const orderNowRows = useMemo(() => {
    const search = orderNowSearch.trim().toLowerCase();
    const filtered = digest.sections.orderNow.filter((row) => {
      if (!orderNowMatchesQuickFilter(row, orderNowQuickFilter)) return false;
      if (orderNowTierFilter.length > 0 && !orderNowTierFilter.includes(String(row.tier ?? ''))) return false;
      if (orderNowCompanyFilter.length > 0 && !orderNowCompanyFilter.includes(String(row.company ?? ''))) return false;
      if (search) {
        const haystack = [
          row.asin,
          row.sku,
          row.title,
          row.company,
          row.supplierName,
          row.supplierOrderRef,
          row.supplierOrderStatus,
          row.actionStatus,
          row.tier,
        ]
          .map(textValue)
          .join(' ');
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    return sortOrderNowRows(filtered, orderNowSort, relativeBaseDate);
  }, [
    digest.sections.orderNow,
    relativeBaseDate,
    orderNowCompanyFilter,
    orderNowQuickFilter,
    orderNowSearch,
    orderNowSort,
    orderNowTierFilter,
  ]);

  const orderNowGroups = useMemo(
    () => groupOrderNowRows(orderNowRows, relativeBaseDate),
    [orderNowRows, relativeBaseDate],
  );

  const newActionValues = (row: PlainRecord): DrawerActionValues => {
    const supplierId = isUuid(row.supplierId) ? row.supplierId : '';
    return {
      draftQty: defaultOrderQty(row),
      draftSupplierId: supplierId,
      draftExpectedSellableDate:
        formatDate(row.expectedSellableDate) === '—' ? undefined : formatDate(row.expectedSellableDate),
      draftNotes: 'Created from Ecobase inventory planning.',
      addSupplierOrderId: '',
      addQty: defaultOrderQty(row),
      addExpectedSellableDate:
        formatDate(row.expectedSellableDate) === '—' ? undefined : formatDate(row.expectedSellableDate),
      addNotes: 'Added from Ecobase inventory planning.',
      leadSupplierId: supplierId,
      leadTimeDays: Number.isFinite(Number(row.leadTimeDays)) ? Number(row.leadTimeDays) : undefined,
      leadNotes: '',
    };
  };

  const setActionValue = (field: keyof DrawerActionValues, value: string | number | undefined) => {
    setActionValues((current) => (current ? { ...current, [field]: value } : current));
  };

  const setLineEditValue = (field: keyof LineEditValues, value: string | number | undefined) => {
    setLineEditValues((current) => (current ? { ...current, [field]: value } : current));
  };

  const setOrderEditValue = (field: keyof OrderEditValues, value: string) => {
    setOrderEditValues((current) => (current ? { ...current, [field]: value } : current));
  };

  const startEditLine = (line: PlainRecord) => {
    setLineEditValues({
      id: String(line.id),
      externalOrderRef: String(line.order?.externalOrderRef ?? ''),
      orderedQty: Number(line.orderedQty ?? 1),
      receivedQty: Number(line.receivedQty ?? 0),
      unitCost: line.unitCost === undefined || line.unitCost === null ? undefined : Number(line.unitCost),
      expectedDeliveryDate:
        formatDate(line.expectedDeliveryDate) === '—' ? undefined : formatDate(line.expectedDeliveryDate),
      expectedSellableDate:
        formatDate(line.expectedSellableDate) === '—' ? undefined : formatDate(line.expectedSellableDate),
      notes: String(line.payload?.notes ?? ''),
    });
    setManagePanels((current) => Array.from(new Set([...current, 'edit-line'])));
  };

  const startEditOrder = (order: PlainRecord) => {
    setOrderEditValues({
      supplierOrderId: String(order.id ?? ''),
      supplierId: String(order.supplierId ?? ''),
      status: String(order.status ?? 'draft'),
      notes: '',
    });
    setManagePanels((current) => Array.from(new Set([...current, 'order-status'])));
  };

  const loadDrawerEntities = async (row: PlainRecord) => {
    const response = await api.request({
      url: 'ecobaseSupplierOrders:workspace',
      method: 'post',
      data: { company: row.company, limit: 500 },
    });
    const workspace = unwrapData(response);
    const suppliers = (Array.isArray(workspace.suppliers) ? workspace.suppliers : []).filter((supplier: PlainRecord) =>
      isUuid(supplier.id),
    );
    const supplierOrders = Array.isArray(workspace.supplierOrders) ? workspace.supplierOrders : [];
    const supplierOrderLines = Array.isArray(workspace.supplierOrderLines) ? workspace.supplierOrderLines : [];
    const activities = Array.isArray(workspace.activities) ? workspace.activities : [];
    const ordersById = new Map(supplierOrders.map((order: PlainRecord) => [String(order.id), order]));
    setSupplierOptions(suppliers);
    setOrderOptions(supplierOrders);
    const productLines = supplierOrderLines
      .filter((line: PlainRecord) => productLineMatches(row, line))
      .map((line: PlainRecord) => ({ ...line, order: ordersById.get(String(line.supplierOrderId)) ?? {} }));
    setOrderLineHistory(
      productLines.sort((left: PlainRecord, right: PlainRecord) => {
        const leftDate = new Date(
          left.observedAt ?? left.order?.lastMeaningfulUpdateAt ?? left.order?.createdAt ?? 0,
        ).getTime();
        const rightDate = new Date(
          right.observedAt ?? right.order?.lastMeaningfulUpdateAt ?? right.order?.createdAt ?? 0,
        ).getTime();
        return rightDate - leftDate;
      }),
    );
    const firstProductOrder = productLines[0]?.order ?? {};
    setOrderEditValues(
      firstProductOrder.id
        ? {
            supplierOrderId: String(firstProductOrder.id),
            supplierId: String(firstProductOrder.supplierId ?? ''),
            status: String(firstProductOrder.status ?? 'draft'),
            notes: '',
          }
        : null,
    );
    const productOrderIds = new Set(productLines.map((line: PlainRecord) => String(line.supplierOrderId)));
    setOrderActivities(
      activities.filter(
        (activity: PlainRecord) =>
          productOrderIds.has(String(activity.supplierOrderId)) ||
          (!activity.supplierOrderId && String(activity.supplierId) === String(row.supplierId)),
      ),
    );
    if (row.companyProductId) {
      try {
        const contextResponse = await api.request({
          url: 'ecobaseSilverData:context',
          method: 'post',
          data: { focus: { type: 'companyProduct', id: row.companyProductId }, pageSize: 10 },
        });
        const sections = Array.isArray(unwrapData(contextResponse).sections)
          ? unwrapData(contextResponse).sections
          : [];
        setProductTasks(sections.find((section: PlainRecord) => section.key === 'tasks')?.rows ?? []);
        setProductTargets(sections.find((section: PlainRecord) => section.key === 'targets')?.rows ?? []);
      } catch {
        setProductTasks([]);
        setProductTargets([]);
      }
    } else {
      setProductTasks([]);
      setProductTargets([]);
    }
    const actionableStatuses = new Set([
      'draft',
      'supplier_contacted',
      'supplier_confirmed',
      'approval_pending',
      'payment_pending',
      'paid',
      'supplier_preparing',
    ]);
    const supplierId = isUuid(row.supplierId) ? row.supplierId : undefined;
    const matchingOrder = supplierId
      ? supplierOrders.find(
          (order: PlainRecord) => order.supplierId === supplierId && actionableStatuses.has(order.status),
        )
      : undefined;
    setActionValues((current) =>
      current
        ? {
            ...current,
            draftSupplierId: current.draftSupplierId || supplierId || '',
            leadSupplierId: current.leadSupplierId || supplierId || '',
            addSupplierOrderId: matchingOrder?.id ? String(matchingOrder.id) : current.addSupplierOrderId,
          }
        : current,
    );
  };

  const openRow = (row: PlainRecord, initialPanels: string[] = []) => {
    setSelectedRow(row);
    setActionValues(newActionValues(row));
    setSupplierOptions([]);
    setOrderOptions([]);
    setOrderLineHistory([]);
    setOrderActivities([]);
    setProductTasks([]);
    setProductTargets([]);
    setLineEditValues(null);
    setOrderEditValues(null);
    setManagePanels(initialPanels);
    void loadDrawerEntities(row);
  };

  const draftOrder = async () => {
    if (!selectedRow || !actionValues) return;
    if (!Number.isFinite(actionValues.draftQty) || actionValues.draftQty <= 0) {
      message.error(t('Draft order quantity must be greater than zero.'));
      return;
    }
    if (!isUuid(actionValues.draftSupplierId)) {
      message.error(t('Select a supplier from the lookup before creating a draft order.'));
      return;
    }
    await api.request({
      url: 'ecobaseSupplierOrders:createPlannedOrder',
      method: 'post',
      data: {
        company: selectedRow.company,
        planningProductId: selectedRow.planningProductId,
        supplierId: actionValues.draftSupplierId.trim(),
        orderedQty: actionValues.draftQty,
        expectedDeliveryDate: actionValues.draftExpectedDeliveryDate,
        expectedSellableDate: actionValues.draftExpectedSellableDate,
        notes: actionValues.draftNotes.trim() || undefined,
      },
    });
    message.success(t('Draft supplier order created'));
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const addToExistingOrder = async () => {
    if (!selectedRow || !actionValues) return;
    if (!isUuid(actionValues.addSupplierOrderId)) {
      message.error(t('Select a supplier order from the lookup before adding the product.'));
      return;
    }
    if (!Number.isFinite(actionValues.addQty) || actionValues.addQty <= 0) {
      message.error(t('Order-line quantity must be greater than zero.'));
      return;
    }
    await api.request({
      url: 'ecobaseSupplierOrders:createOrderLine',
      method: 'post',
      data: {
        supplierOrderId: actionValues.addSupplierOrderId.trim(),
        planningProductId: selectedRow.planningProductId,
        orderedQty: actionValues.addQty,
        expectedDeliveryDate: actionValues.addExpectedDeliveryDate,
        expectedSellableDate: actionValues.addExpectedSellableDate,
        notes: actionValues.addNotes.trim() || undefined,
      },
    });
    message.success(t('Product added to supplier order'));
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const saveOrderLineEdit = async () => {
    if (!selectedRow || !lineEditValues) return;
    if (!Number.isFinite(lineEditValues.orderedQty) || lineEditValues.orderedQty <= 0) {
      message.error(t('Ordered quantity must be greater than zero.'));
      return;
    }
    if (!Number.isFinite(lineEditValues.receivedQty) || lineEditValues.receivedQty < 0) {
      message.error(t('Received quantity must be zero or greater.'));
      return;
    }
    await api.request({
      url: 'ecobaseSupplierOrders:updateLineOperatorFields',
      method: 'post',
      data: {
        supplierOrderLineId: lineEditValues.id,
        company: selectedRow.company,
        externalOrderRef: lineEditValues.externalOrderRef.trim() || undefined,
        orderedQty: lineEditValues.orderedQty,
        receivedQty: lineEditValues.receivedQty,
        unitCost: lineEditValues.unitCost,
        expectedDeliveryDate: lineEditValues.expectedDeliveryDate,
        expectedSellableDate: lineEditValues.expectedSellableDate,
        notes: lineEditValues.notes.trim() || undefined,
      },
    });
    message.success(t('Order line updated'));
    setLineEditValues(null);
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const saveOrderStatus = async () => {
    if (!selectedRow || !orderEditValues) return;
    if (!orderEditValues.supplierOrderId) {
      message.error(t('Select a supplier order before updating status.'));
      return;
    }
    const supplierId = orderEditValues.supplierId || String(selectedRow.supplierId ?? '');
    if (orderEditValues.notes.trim() && !isUuid(supplierId)) {
      message.error(t('Select an order with a known supplier before saving the status note.'));
      return;
    }
    await api.request({
      url: 'ecobaseSupplierOrders:updateOrderOperatorFields',
      method: 'post',
      data: {
        supplierOrderId: orderEditValues.supplierOrderId,
        company: selectedRow.company,
        status: orderEditValues.status,
      },
    });
    if (orderEditValues.notes.trim()) {
      await api.request({
        url: 'ecobaseSupplierOrders:recordActivity',
        method: 'post',
        data: {
          company: selectedRow.company,
          supplierId,
          supplierOrderId: orderEditValues.supplierOrderId,
          activityType: 'status_update',
          notes: orderEditValues.notes.trim(),
        },
      });
    }
    message.success(t('Supplier order status updated'));
    setOrderEditValues(null);
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const deleteOrderLine = async (line: PlainRecord) => {
    if (!selectedRow) return;
    await api.request({
      url: 'ecobaseSupplierOrders:deleteLineOperatorFields',
      method: 'post',
      data: {
        supplierOrderLineId: line.id,
        company: selectedRow.company,
      },
    });
    message.success(t('Order line deleted'));
    if (lineEditValues?.id === line.id) {
      setLineEditValues(null);
    }
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const updateLeadTime = async () => {
    if (!selectedRow || !actionValues) return;
    if (!isUuid(actionValues.leadSupplierId)) {
      message.error(t('Select a supplier from the lookup before updating lead time.'));
      return;
    }
    if (
      actionValues.leadTimeDays === undefined ||
      !Number.isFinite(actionValues.leadTimeDays) ||
      actionValues.leadTimeDays < 0
    ) {
      message.error(t('Lead time days must be zero or greater.'));
      return;
    }
    await api.request({
      url: 'ecobaseSupplierOrders:updateSupplierLeadTime',
      method: 'post',
      data: {
        company: selectedRow.company,
        supplierId: actionValues.leadSupplierId.trim(),
        planningProductId: selectedRow.planningProductId,
        asin: selectedRow.asin,
        sku: selectedRow.sku,
        leadTimeDays: actionValues.leadTimeDays,
        notes: actionValues.leadNotes.trim() || undefined,
      },
    });
    message.success(t('Product lead time updated'));
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const columns = [
    {
      title: t('Review'),
      key: 'review',
      fixed: 'left' as const,
      width: 95,
      render: (_value: any, row: PlainRecord) => (
        <Button size="small" onClick={() => openRow(row)}>
          {t('Details')}
        </Button>
      ),
    },
    {
      title: columnHelp(
        t('Action'),
        t(
          'Status tells the operator whether to order now, contact the supplier first, watch, or review existing coverage.',
        ),
      ),
      dataIndex: 'actionStatus',
      fixed: 'left' as const,
      width: 155,
      render: (value: string) => <Tag color={actionColor(value)}>{t(value ?? 'unknown')}</Tag>,
    },
    {
      title: t('Tier'),
      dataIndex: 'tier',
      width: 90,
      render: (value: string) => <Tag color={tierColor(value)}>{value ?? '—'}</Tag>,
    },
    { title: t('Company'), dataIndex: 'company', width: 170, render: (value: string) => value || '—' },
    { title: t('ASIN'), dataIndex: 'asin', width: 130 },
    { title: t('SKU'), dataIndex: 'sku', width: 150 },
    { title: t('Status'), dataIndex: 'productStatus', width: 130 },
    {
      title: t('Current stock status'),
      key: 'stockStatus',
      width: 260,
      render: (_value: any, row: PlainRecord) => <StockStatus row={row} t={t} />,
    },
    {
      title: columnHelp(
        t('Supplier'),
        t('Supplier comes from confirmed product links first, then latest OrderDetails history when available.'),
      ),
      dataIndex: 'supplierName',
      width: 210,
      render: (value: string, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <span>{value || '—'}</span>
          <Typography.Text type="secondary">
            {row.supplierSource ?? '—'} · {row.supplierConfidence ?? '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: columnHelp(
        t('Lead time'),
        t(
          'Uses product-specific supplier lead time first, then supplier/default planning data. Update it when a supplier confirms a new value.',
        ),
      ),
      dataIndex: 'leadTimeDays',
      width: 150,
      render: (value: number, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <span>
            {formatNumber(value)} {t('days')}
          </span>
          <Tag color={freshnessColor(row.leadTimeFreshness)}>{t(row.leadTimeFreshness ?? 'unknown')}</Tag>
        </Space>
      ),
    },
    { title: t('Days cover'), dataIndex: 'daysOfCover', width: 115, render: formatNumber },
    {
      title: t('Order by'),
      dataIndex: 'latestSafeReorderDate',
      width: 150,
      render: (value: string) => {
        const relative = relativeDateLabel(value, relativeBaseDate);
        return (
          <Space direction="vertical" size={0}>
            <Tag color={relative.color}>{t(relative.label)}</Tag>
            <Typography.Text type="secondary">{relative.detail ?? '—'}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('OOS date'),
      dataIndex: 'estimatedOosDate',
      width: 150,
      render: (value: string) => {
        const relative = relativeDateLabel(value, relativeBaseDate);
        return (
          <Space direction="vertical" size={0}>
            <span>{t(relative.label)}</span>
            <Typography.Text type="secondary">{relative.detail ?? '—'}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: columnHelp(t('Suggest qty'), t('Formula: velocity × target days − stock − reliable open-order coverage.')),
      dataIndex: 'suggestedReorderQty',
      width: 125,
      render: formatNumber,
    },
    { title: t('Sellable'), dataIndex: 'sellableStock', width: 105, render: formatNumber },
    { title: t('Reserved'), dataIndex: 'reservedStock', width: 105, render: formatNumber },
    {
      title: columnHelp(
        t('Replenishment'),
        t('Inbound + ordered + prep + AWD stock. Reserved is shown separately because it is not new replenishment.'),
      ),
      dataIndex: 'pipelineStock',
      width: 145,
      render: formatNumber,
    },
    { title: t('Inbound'), dataIndex: 'inboundStock', width: 105, render: formatNumber },
    { title: t('Ordered'), dataIndex: 'orderedStock', width: 105, render: formatNumber },
    { title: t('Prep'), dataIndex: 'prepStock', width: 95, render: formatNumber },
    {
      title: columnHelp(
        t('Open order coverage'),
        t('Only reliable order statuses count as coverage; draft/contacted/approval rows remain operator actions.'),
      ),
      dataIndex: 'openOrderCoverageQty',
      width: 170,
      render: formatNumber,
    },
    {
      title: t('Stuck'),
      dataIndex: 'stuck',
      width: 90,
      render: (value: boolean) => (value ? <Tag color="purple">{t('Check')}</Tag> : <Tag>{t('No')}</Tag>),
    },
    {
      title: columnHelp(
        t('Profit risk'),
        t('Estimated missed profit if the product remains uncovered during the projected stockout window.'),
      ),
      dataIndex: 'estimatedProfitRisk',
      width: 125,
      render: formatNumber,
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <style>{`
        .ecobase-inventory-table .ecobase-tier-A > td { background: #f6ffed !important; }
        .ecobase-inventory-table .ecobase-tier-B > td { background: #fffbe6 !important; }
        .ecobase-inventory-table .ecobase-tier-C > td { background: #fff1f0 !important; }
      `}</style>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Inventory planning')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t(
            'One-stop queue for what to order today, what should already have been ordered, and which supplier should be contacted first.',
          )}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} /> : null}
        {planningSettingsWarning ? <Alert type="warning" message={planningSettingsWarning} showIcon /> : null}
        <Collapse
          size="small"
          items={[
            {
              key: 'operator-filters',
              label: t('Operator filters'),
              extra: <Typography.Text type="secondary">{t('Company, date, status, knobs, limits.')}</Typography.Text>,
              children: (
                <Row gutter={[24, 20]} align="bottom">
                  <FilterControl title={t('Company')} help={t('Limit rows to one company.')}>
                    <Select
                      allowClear
                      showSearch
                      placeholder={t('All companies')}
                      value={company || undefined}
                      onChange={(value) => setCompany(value ?? '')}
                      style={{ width: '100%' }}
                      options={(Array.isArray(filterOptions.companies) ? filterOptions.companies : []).map(
                        (value: string) => ({ value, label: value }),
                      )}
                    />
                  </FilterControl>
                  <FilterControl title={t('Planning date')} help={t('Blank uses latest saved planning date.')}>
                    <DatePicker
                      allowClear
                      value={calculationDate ? dayjs(calculationDate) : undefined}
                      onChange={(_date, dateString) =>
                        setCalculationDate(Array.isArray(dateString) ? dateString[0] : dateString)
                      }
                      style={{ width: '100%' }}
                    />
                  </FilterControl>
                  <FilterControl title={t('Action status')} help={t('Filter by action state.')}>
                    <Select
                      allowClear
                      placeholder={t('Any action')}
                      value={actionStatus}
                      onChange={setActionStatus}
                      style={{ width: '100%' }}
                      options={(Array.isArray(filterOptions.actionStatuses) ? filterOptions.actionStatuses : []).map(
                        (value: string) => ({ value, label: t(value) }),
                      )}
                    />
                  </FilterControl>
                  <FilterControl title={t('Profit tier')} help={t('Filter by profit tier.')}>
                    <Select
                      allowClear
                      placeholder={t('Any tier')}
                      value={tier}
                      onChange={setTier}
                      style={{ width: '100%' }}
                      options={(Array.isArray(filterOptions.tiers) ? filterOptions.tiers : ['A', 'B', 'C']).map(
                        (value: string) => ({ value, label: value }),
                      )}
                    />
                  </FilterControl>
                  <FilterControl
                    title={t('Safety buffer')}
                    help={t('Extra cushion before stockout, from Planning Settings.')}
                  >
                    <InputNumber
                      addonAfter={t('days')}
                      min={0}
                      value={safetyBufferDays}
                      onChange={(value) => setSafetyBufferDays(Number(value ?? 7))}
                      style={{ width: '100%' }}
                    />
                  </FilterControl>
                  <FilterControl title={t('Reorder cycle')} help={t('Extra selling days to cover after lead time.')}>
                    <InputNumber
                      addonAfter={t('days')}
                      min={0}
                      value={reorderCycleDays}
                      onChange={(value) => setReorderCycleDays(Number(value ?? 30))}
                      style={{ width: '100%' }}
                    />
                  </FilterControl>
                  <FilterControl title={t('Lead-time stale after')} help={t('When lead time becomes stale.')}>
                    <InputNumber
                      addonAfter={t('days')}
                      min={1}
                      value={leadTimeFreshnessDays}
                      onChange={(value) => setLeadTimeFreshnessDays(Number(value ?? 60))}
                      style={{ width: '100%' }}
                    />
                  </FilterControl>
                  <FilterControl title={t('Soon window')} help={t('Mark due rows order soon.')}>
                    <InputNumber
                      addonAfter={t('days')}
                      min={1}
                      value={orderSoonWindowDays}
                      onChange={(value) => setOrderSoonWindowDays(Number(value ?? 14))}
                      style={{ width: '100%' }}
                    />
                  </FilterControl>
                  <FilterControl
                    title={t('Pipeline grace')}
                    help={t('Days after expected sellable date that purchased pipeline still counts as coverage.')}
                  >
                    <InputNumber
                      addonAfter={t('days')}
                      min={0}
                      value={purchasedPipelineGraceDays}
                      onChange={(value) => setPurchasedPipelineGraceDays(Number(value ?? 3))}
                      style={{ width: '100%' }}
                    />
                  </FilterControl>
                  <FilterControl title={t('Rows to load')} help={t('Cap rows for speed.')}>
                    <InputNumber
                      min={25}
                      max={500}
                      value={limit}
                      onChange={(value) => setLimit(Number(value ?? 150))}
                      style={{ width: '100%' }}
                    />
                  </FilterControl>
                  <Col xs={24} md={12} xl={6}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Button type="primary" block loading={loading} onClick={loadPlanning}>
                        {t('Refresh planning')}
                      </Button>
                      <Button block loading={loading} onClick={syncEditableRows}>
                        {t('Rebuild gold inventory')}
                      </Button>
                      <Typography.Text type="secondary">
                        {t(
                          'Saved Planning Settings load as defaults. Local edits affect this page and rebuild requests.',
                        )}
                      </Typography.Text>
                    </Space>
                  </Col>
                </Row>
              ),
            },
          ]}
        />
        <Collapse
          size="small"
          items={[
            {
              key: 'budget-optimizer',
              label: t('Optional budget optimizer'),
              extra: (
                <Typography.Text type="secondary">{t('Budget-constrained approve/pay/order ranking.')}</Typography.Text>
              ),
              children: (
                <>
                  <Row gutter={[16, 16]} align="bottom">
                    <Col xs={24} md={8} lg={6}>
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Typography.Text strong>{t('Available budget')}</Typography.Text>
                        <InputNumber
                          min={0}
                          precision={2}
                          addonBefore="$"
                          placeholder={t('Optional')}
                          value={budgetAmount ?? undefined}
                          onChange={(value) => setBudgetAmount(typeof value === 'number' ? value : null)}
                          style={{ width: '100%' }}
                        />
                      </Space>
                    </Col>
                    <Col xs={24} md={8} lg={5}>
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Typography.Text strong>{t('Profit horizon')}</Typography.Text>
                        <InputNumber
                          addonAfter={t('days')}
                          min={1}
                          value={budgetHorizonDays}
                          onChange={(value) => setBudgetHorizonDays(Number(value ?? 30))}
                          style={{ width: '100%' }}
                        />
                      </Space>
                    </Col>
                    <Col xs={24} md={8} lg={5}>
                      <Button
                        type="primary"
                        block
                        disabled={!budgetAmount || budgetAmount <= 0}
                        loading={budgetLoading}
                        onClick={runBudgetOptimizer}
                      >
                        {t('Run optimizer')}
                      </Button>
                    </Col>
                    <Col xs={24} lg={8}>
                      <Alert
                        type={budgetAmount && budgetAmount > 0 ? 'info' : 'success'}
                        showIcon
                        message={
                          budgetAmount && budgetAmount > 0
                            ? t('Ranks actions within budget.')
                            : t('Daily digest remains primary.')
                        }
                      />
                    </Col>
                  </Row>
                  {budgetResult ? (
                    <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 16 }}>
                      <Row gutter={[16, 16]}>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t('Selected spend')}
                            value={Number(budgetResult.selectedSpend ?? 0)}
                            precision={2}
                            prefix="$"
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t('Budget')}
                            value={Number(budgetResult.budget ?? 0)}
                            precision={2}
                            prefix="$"
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t('Remaining')}
                            value={Number(budgetResult.remainingBudget ?? 0)}
                            precision={2}
                            prefix="$"
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t('Protected profit')}
                            value={Number(budgetResult.expectedProtectedProfit ?? 0)}
                            precision={2}
                            prefix="$"
                            valueStyle={{ color: '#3f8600' }}
                          />
                        </Col>
                      </Row>
                      <Table<PlainRecord>
                        size="small"
                        rowKey={(row) => String(row.key)}
                        title={() => t('Recommended approvals / payments')}
                        dataSource={Array.isArray(budgetResult.recommendations) ? budgetResult.recommendations : []}
                        pagination={false}
                        columns={[
                          {
                            title: t('Action'),
                            dataIndex: 'recommendedAction',
                            render: (value: string) => (
                              <Tag color={value === 'pay' ? 'red' : value === 'approve' ? 'orange' : 'blue'}>
                                {t(value)}
                              </Tag>
                            ),
                          },
                          {
                            title: t('Order / product'),
                            key: 'target',
                            render: (_value: any, row: PlainRecord) =>
                              row.supplierOrderRef ?? row.asin ?? row.planningProductId,
                          },
                          {
                            title: t('Supplier'),
                            dataIndex: 'supplierName',
                            render: (value: string) => value || <Tag color="red">{t('Missing supplier')}</Tag>,
                          },
                          { title: t('Spend'), dataIndex: 'spend', render: formatCurrency },
                          { title: t('Protected profit'), dataIndex: 'protectedProfit', render: formatCurrency },
                          { title: t('Score'), dataIndex: 'adjustedScore', render: formatNumber },
                          {
                            title: t('Reasons'),
                            dataIndex: 'reasonCodes',
                            render: (values: string[]) => (
                              <Space size={4} wrap>
                                {(Array.isArray(values) ? values : []).map((value) => (
                                  <Tag key={value}>{t(value)}</Tag>
                                ))}
                              </Space>
                            ),
                          },
                        ]}
                      />
                      <Table<PlainRecord>
                        size="small"
                        rowKey={(row) => String(row.key)}
                        title={() => t('Skipped but still important')}
                        dataSource={Array.isArray(budgetResult.skipped) ? budgetResult.skipped : []}
                        pagination={false}
                        columns={[
                          {
                            title: t('Reason'),
                            dataIndex: 'skipReason',
                            render: (value: string) => (
                              <Tag color={value === 'missing_unit_cost' ? 'red' : 'default'}>{t(value)}</Tag>
                            ),
                          },
                          {
                            title: t('Order / product'),
                            key: 'target',
                            render: (_value: any, row: PlainRecord) =>
                              row.supplierOrderRef ?? row.asin ?? row.planningProductId,
                          },
                          {
                            title: t('Supplier'),
                            dataIndex: 'supplierName',
                            render: (value: string) => value || <Tag color="red">{t('Missing supplier')}</Tag>,
                          },
                          { title: t('Spend'), dataIndex: 'spend', render: formatCurrency },
                          { title: t('Protected profit'), dataIndex: 'protectedProfit', render: formatCurrency },
                        ]}
                      />
                      <Alert
                        type="info"
                        showIcon
                        message={t('Optimizer assumptions')}
                        description={(Array.isArray(budgetResult.assumptions) ? budgetResult.assumptions : []).join(
                          ' ',
                        )}
                      />
                    </Space>
                  ) : null}
                </>
              ),
            },
          ]}
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={4}>
            <Card>
              <Statistic title={t('Overdue')} value={digest.summary.overdue ?? 0} valueStyle={{ color: '#cf1322' }} />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Card>
              <Statistic
                title={t('Order today')}
                value={digest.summary.orderToday ?? 0}
                valueStyle={{ color: '#d4380d' }}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Card>
              <Statistic
                title={t('Order soon')}
                value={digest.summary.orderSoon ?? 0}
                valueStyle={{ color: '#fa8c16' }}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Card>
              <Statistic title={t('At risk')} value={digest.summary.atRisk ?? 0} />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Card>
              <Statistic
                title={t('Lead-time issues')}
                value={digest.summary.staleOrMissingLeadTime ?? 0}
                valueStyle={{ color: '#faad14' }}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Card>
              <Statistic title={t('Suppliers')} value={digest.summary.suppliersToContact ?? 0} />
            </Card>
          </Col>
        </Row>
        <Card
          title={t('Daily digest preview')}
          extra={
            <Space size="small" wrap>
              <Typography.Text type="secondary">
                {t('Bounded to urgent action items so operators are not overloaded.')}
              </Typography.Text>
              <FormulaHelp group="inventoryDigest" />
            </Space>
          }
        >
          <Row gutter={[16, 16]}>
            <Col xs={24}>
              <Typography.Title level={5}>{t('Order now')}</Typography.Title>
              <Typography.Paragraph type="secondary">
                {t('Click a row to review the product and manage supplier-order actions in one drawer.')}
              </Typography.Paragraph>
              <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
                <Col xs={24} md={8} xl={5}>
                  <Select<OrderNowQuickFilter>
                    value={orderNowQuickFilter}
                    onChange={setOrderNowQuickFilter}
                    style={{ width: '100%' }}
                    options={[
                      { value: 'all', label: t('All order-now rows') },
                      { value: 'urgent_today', label: t('Overdue / today') },
                      { value: 'missing_supplier', label: t('Missing supplier') },
                      { value: 'lead_time_issues', label: t('Lead-time issues') },
                      { value: 'no_order', label: t('Needs new supplier order') },
                      { value: 'placed_not_purchased', label: t('Placed, not purchased') },
                    ]}
                  />
                </Col>
                <Col xs={24} md={8} xl={5}>
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder={t('Tier')}
                    value={orderNowTierFilter}
                    onChange={setOrderNowTierFilter}
                    style={{ width: '100%' }}
                    options={orderNowTiers.map((value) => ({ value, label: value }))}
                  />
                </Col>
                <Col xs={24} md={8} xl={5}>
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder={t('Company')}
                    value={orderNowCompanyFilter}
                    onChange={setOrderNowCompanyFilter}
                    style={{ width: '100%' }}
                    options={orderNowCompanies.map((value) => ({ value, label: value }))}
                  />
                </Col>
                <Col xs={24} md={8} xl={5}>
                  <Select<OrderNowSortKey>
                    value={orderNowSort}
                    onChange={setOrderNowSort}
                    style={{ width: '100%' }}
                    options={[
                      { value: 'urgency', label: t('Sort by urgency') },
                      { value: 'oos_asc', label: t('Sort by OOS date') },
                      { value: 'risk_desc', label: t('Sort by money at risk') },
                      { value: 'tier', label: t('Sort by tier') },
                      { value: 'supplier', label: t('Sort by supplier') },
                    ]}
                  />
                </Col>
                <Col xs={24} md={8} xl={4}>
                  <Input
                    allowClear
                    placeholder={t('Search ASIN, SKU, supplier')}
                    value={orderNowSearch}
                    onChange={(event) => setOrderNowSearch(event.target.value)}
                  />
                </Col>
              </Row>
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                {t('Showing')} {orderNowGroups.length} {t('groups')} / {orderNowRows.length} {t('products')}
              </Typography.Text>
              <Table<PlainRecord>
                size="small"
                rowKey={(row) => row.key}
                dataSource={orderNowGroups}
                pagination={false}
                onRow={(group) => ({ onClick: () => openRow(group.rows[0], ['history', 'order-status']) })}
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
                      rowKey={(row) => String(row.planningProductId ?? row.asin ?? row.sku)}
                      dataSource={group.rows}
                      pagination={false}
                      onRow={(row) => ({ onClick: () => openRow(row) })}
                      columns={[
                        {
                          title: t('Action'),
                          dataIndex: 'actionStatus',
                          render: (value: string) => <Tag color={actionColor(value)}>{t(value)}</Tag>,
                        },
                        {
                          title: t('Tier'),
                          dataIndex: 'tier',
                          render: (value: string) => <Tag color={tierColor(value)}>{value}</Tag>,
                        },
                        { title: t('ASIN'), dataIndex: 'asin' },
                        { title: t('SKU'), dataIndex: 'sku' },
                        { title: t('Velocity'), dataIndex: 'salesVelocity', render: formatNumber },
                        {
                          title: t('Lead time'),
                          dataIndex: 'leadTimeDays',
                          render: (value: number, row: PlainRecord) => (
                            <Space size={4}>
                              <span>
                                {formatNumber(value)} {t('days')}
                              </span>
                              <Tag color={freshnessColor(row.leadTimeFreshness)}>
                                {t(row.leadTimeFreshness ?? 'unknown')}
                              </Tag>
                            </Space>
                          ),
                        },
                        {
                          title: t('OOS in'),
                          dataIndex: 'estimatedOosDate',
                          render: (value: string) => (
                            <Tag color={relativeDateLabel(value, relativeBaseDate).color}>
                              {t(relativeDateLabel(value, relativeBaseDate).label)}
                            </Tag>
                          ),
                        },
                        {
                          title: t('Projected sellable'),
                          dataIndex: 'expectedSellableDate',
                          render: formatDate,
                        },
                        {
                          title: t('Suggested'),
                          dataIndex: 'suggestedReorderQty',
                          render: formatNumber,
                        },
                        {
                          title: t('Money at risk'),
                          dataIndex: 'estimatedProfitRisk',
                          render: (value: number) => (
                            <Typography.Text
                              strong
                              style={{
                                background: '#fff1f0',
                                color: '#cf1322',
                                padding: '1px 6px',
                                borderRadius: 4,
                              }}
                            >
                              {formatCurrency(value)}
                            </Typography.Text>
                          ),
                        },
                      ]}
                    />
                  ),
                }}
                columns={[
                  {
                    title: t('Order / supplier group'),
                    key: 'group',
                    render: (_value: any, group: PlainRecord) => (
                      <Space direction="vertical" size={0}>
                        <Space size={4} wrap>
                          <Tag color={group.type === 'order' ? 'orange' : group.type === 'supplier' ? 'blue' : 'red'}>
                            {t(
                              group.type === 'order'
                                ? 'Order'
                                : group.type === 'supplier'
                                  ? 'Supplier'
                                  : 'Needs supplier',
                            )}
                          </Tag>
                          <Typography.Text strong>
                            {group.supplierOrderRef ?? group.supplierName ?? t('Find supplier from OrderDetails')}
                          </Typography.Text>
                          {group.supplierOrderStatus ? (
                            <Tag color={supplierOrderStatusColor(String(group.supplierOrderStatus))}>
                              {t(String(group.supplierOrderStatus))}
                            </Tag>
                          ) : null}
                        </Space>
                        <Space size={4} wrap>
                          <Typography.Text type="secondary">{String(group.company ?? '—')}</Typography.Text>
                          {group.supplierName ? <Tag color="blue">{String(group.supplierName)}</Tag> : null}
                        </Space>
                        {group.latestSupplierOrderActivityNote ? (
                          <Typography.Text type="secondary" ellipsis style={{ maxWidth: 320 }}>
                            {String(group.latestSupplierOrderActivityNote)}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    ),
                  },
                  {
                    title: t('Products'),
                    dataIndex: 'productCount',
                    render: (value: number, group: PlainRecord) =>
                      value === 1 ? (
                        <Space direction="vertical" size={0}>
                          <Space size={4} wrap>
                            <Typography.Text>{String(group.firstProduct?.asin ?? '—')}</Typography.Text>
                            {(Array.isArray(group.tierCounts) ? group.tierCounts : []).map((item: any) => (
                              <Tag key={item.tier} color={tierColor(item.tier)}>{`${item.tier}`}</Tag>
                            ))}
                          </Space>
                          <Typography.Text type="secondary" ellipsis style={{ maxWidth: 220 }}>
                            {String(group.firstProduct?.sku ?? group.firstProduct?.title ?? '')}
                          </Typography.Text>
                          {group.leadTimeIssueCount ? <Tag color="orange">{t('Lead-time issue')}</Tag> : null}
                        </Space>
                      ) : (
                        <Space size={4} wrap>
                          <Tag>{formatNumber(value)}</Tag>
                          {(Array.isArray(group.tierCounts) ? group.tierCounts : []).map((item: any) => (
                            <Tag key={item.tier} color={tierColor(item.tier)}>{`${item.tier}:${item.count}`}</Tag>
                          ))}
                          {group.leadTimeIssueCount ? (
                            <Tag color="orange">
                              {t('lead-time')} {group.leadTimeIssueCount}
                            </Tag>
                          ) : null}
                        </Space>
                      ),
                  },
                  {
                    title: t('Earliest OOS'),
                    dataIndex: 'earliestOosDate',
                    render: (value: string) => (
                      <Tag color={relativeDateLabel(value, relativeBaseDate).color}>
                        {t(relativeDateLabel(value, relativeBaseDate).label)}
                      </Tag>
                    ),
                  },
                  {
                    title: t('Money at risk'),
                    dataIndex: 'totalMoneyAtRisk',
                    render: (value: number) => (
                      <Typography.Text
                        strong
                        style={{ background: '#fff1f0', color: '#cf1322', padding: '1px 6px', borderRadius: 4 }}
                      >
                        {formatCurrency(value)}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: t('Top action'),
                    dataIndex: 'topActionStatus',
                    render: (value: string) => <Tag color={actionColor(value)}>{t(value ?? 'unknown')}</Tag>,
                  },
                ]}
              />
            </Col>
            <Col xs={24} lg={10}>
              <Typography.Title level={5}>{t('Supplier contact priority')}</Typography.Title>
              <Typography.Paragraph type="secondary">
                {t('Groups only urgent supplier-action rows that already have a named supplier to contact.')}
              </Typography.Paragraph>
              <Table<PlainRecord>
                size="small"
                rowKey={(row) => row.supplierName}
                dataSource={digest.sections.suppliersToContactFirst}
                pagination={false}
                columns={[
                  {
                    title: t('Supplier / next action'),
                    dataIndex: 'supplierName',
                    render: (value: string) =>
                      value === 'Find supplier from OrderDetails' ? <Tag color="red">{t(value)}</Tag> : value,
                  },
                  { title: t('Urgent'), dataIndex: 'urgentCount' },
                  { title: t('A'), dataIndex: 'tierA' },
                  { title: t('B'), dataIndex: 'tierB' },
                  { title: t('C'), dataIndex: 'tierC' },
                  {
                    title: t('Money at risk'),
                    dataIndex: 'estimatedProfitRisk',
                    render: (value: number) => (
                      <Typography.Text
                        strong
                        style={{ background: '#fff1f0', color: '#cf1322', padding: '1px 6px', borderRadius: 4 }}
                      >
                        {formatCurrency(value)}
                      </Typography.Text>
                    ),
                  },
                ]}
              />
            </Col>
            <Col xs={24} lg={14}>
              <Typography.Title level={5}>{t('Products needing supplier action')}</Typography.Title>
              <Typography.Paragraph type="secondary">
                {t('Product-level list limited to rows with missing supplier or stale/missing lead-time evidence.')}
              </Typography.Paragraph>
              <Table<PlainRecord>
                size="small"
                rowKey={(row) => row.planningProductId}
                dataSource={digest.sections.supplierActionItems}
                pagination={false}
                onRow={(row) => ({ onClick: () => openRow(row) })}
                columns={[
                  {
                    title: t('Tier'),
                    dataIndex: 'tier',
                    render: (value: string) => <Tag color={tierColor(value)}>{value}</Tag>,
                  },
                  { title: t('ASIN'), dataIndex: 'asin' },
                  {
                    title: t('Supplier'),
                    key: 'supplier',
                    render: (_value: any, row: PlainRecord) =>
                      row.supplierName ?? <Tag color="red">{t('Find supplier')}</Tag>,
                  },
                  {
                    title: columnHelp(
                      t('Lead'),
                      t('Uses product-specific supplier lead time first, then supplier/default planning data.'),
                    ),
                    dataIndex: 'leadTimeDays',
                    render: (value: number, row: PlainRecord) => (
                      <Space size={4}>
                        <span>
                          {formatNumber(value)} {t('days')}
                        </span>
                        <Tag color={freshnessColor(row.leadTimeFreshness)}>{t(row.leadTimeFreshness ?? 'unknown')}</Tag>
                      </Space>
                    ),
                  },
                  {
                    title: t('OOS in'),
                    dataIndex: 'estimatedOosDate',
                    render: (value: string) => (
                      <Tag color={relativeDateLabel(value, relativeBaseDate).color}>
                        {t(relativeDateLabel(value, relativeBaseDate).label)}
                      </Tag>
                    ),
                  },
                  {
                    title: columnHelp(t('Money at risk'), t('Potential profit loss if the row remains uncovered.')),
                    dataIndex: 'estimatedProfitRisk',
                    render: (value: number) => (
                      <Typography.Text
                        strong
                        style={{ background: '#fff1f0', color: '#cf1322', padding: '1px 6px', borderRadius: 4 }}
                      >
                        {formatCurrency(value)}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: t('Next'),
                    key: 'next',
                    render: (_value: any, row: PlainRecord) => (
                      <Button
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          openRow(row);
                        }}
                      >
                        {t('Review / edit')}
                      </Button>
                    ),
                  },
                ]}
              />
            </Col>
          </Row>
        </Card>
        <Card title={t('Inventory planning queue')} extra={<FormulaHelp group="inventoryQueue" />}>
          <Table<PlainRecord>
            className="ecobase-inventory-table"
            loading={loading}
            rowKey={(row) => row.planningProductId}
            rowClassName={(row) => `ecobase-tier-${row.tier ?? 'unknown'}`}
            dataSource={filteredRows}
            columns={columns}
            size="small"
            tableLayout="fixed"
            virtual
            scroll={{ x: 2700, y: 720 }}
            pagination={{ pageSize: 25, showSizeChanger: true }}
            onRow={(row) => ({ onDoubleClick: () => openRow(row) })}
          />
        </Card>
      </Space>
      <Drawer
        open={!!selectedRow}
        title={
          selectedRow
            ? `${selectedRow.asin ?? selectedRow.sku ?? t('Inventory row')} · ${selectedRow.company ?? t('No company')}`
            : t('Inventory row')
        }
        width={920}
        onClose={() => {
          setSelectedRow(null);
          setActionValues(null);
          setOrderLineHistory([]);
          setOrderActivities([]);
          setProductTasks([]);
          setProductTargets([]);
          setLineEditValues(null);
          setOrderEditValues(null);
        }}
        extra={
          selectedRow ? (
            <Space size="small">
              <FormulaHelp group="inventoryDrawer" />
              <Button
                onClick={() => {
                  setSelectedRow(null);
                  setActionValues(null);
                  setOrderLineHistory([]);
                  setOrderActivities([]);
                  setProductTasks([]);
                  setProductTargets([]);
                  setLineEditValues(null);
                  setOrderEditValues(null);
                }}
              >
                {t('Close')}
              </Button>
            </Space>
          ) : undefined
        }
      >
        {selectedRow ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label={t('Action')}>
                <Tag color={actionColor(selectedRow.actionStatus)}>{t(selectedRow.actionStatus ?? 'unknown')}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Product status'), t(productStatusText()))}>
                <Tag>{selectedRow.productStatus ?? '—'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Tier'), t(tierScoreText()))}>
                <Tag color={tierColor(selectedRow.tier)}>{selectedRow.tier}</Tag> {t('Score')}{' '}
                {formatNumber(selectedRow.tierScore)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Company')}>{selectedRow.company ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('ASIN / SKU')}>
                {selectedRow.asin ?? '—'} / {selectedRow.sku ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Supplier')}>
                {selectedRow.supplierName ?? '—'} · {selectedRow.supplierSource ?? '—'} ·{' '}
                {selectedRow.supplierConfidence ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Lead time'), t(leadTimeSourceText(selectedRow)))}>
                <span>
                  {formatNumber(selectedRow.leadTimeDays)} {t('days')}{' '}
                  <Tag color={freshnessColor(selectedRow.leadTimeFreshness)}>
                    {t(selectedRow.leadTimeFreshness ?? 'unknown')}
                  </Tag>
                </span>
              </Descriptions.Item>
              <Descriptions.Item label={t('Order by')}>
                {relativeDateLabel(selectedRow.latestSafeReorderDate, relativeBaseDate).label} (
                {formatDate(selectedRow.latestSafeReorderDate)})
              </Descriptions.Item>
              <Descriptions.Item label={t('OOS date')}>
                {relativeDateLabel(selectedRow.estimatedOosDate, relativeBaseDate).label} (
                {formatDate(selectedRow.estimatedOosDate)})
              </Descriptions.Item>
              <Descriptions.Item
                label={columnHelp(
                  t('Suggested quantity'),
                  t('Formula: velocity × target days − stock − reliable open-order coverage.'),
                )}
              >
                {formatNumber(selectedRow.suggestedReorderQty)}
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Money at risk'), t(monetaryRiskText(selectedRow)))}>
                <Typography.Text
                  strong
                  style={{ background: '#fff1f0', color: '#cf1322', padding: '2px 8px', borderRadius: 4 }}
                >
                  {formatCurrency(selectedRow.estimatedProfitRisk)}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('Month to date')}>
                <Space size={4} wrap>
                  <Tag color="blue">
                    {t('Revenue')} {formatCurrency(selectedRow.monthToDateRevenue)}
                  </Tag>
                  <Tag color="cyan">
                    {t('Units sold')} {formatNumber(selectedRow.monthToDateUnitsSold)}
                  </Tag>
                  <Tag color="green">
                    {t('Profit')} {formatCurrency(selectedRow.monthToDateProfit)}
                  </Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('Stock buckets')}>
                <StockStatus row={selectedRow} t={t} />
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Order coverage'), t(orderCoverageText()))}>
                {formatNumber(selectedRow.openOrderCoverageQty)}
              </Descriptions.Item>
            </Descriptions>
            {actionValues ? (
              <>
                <Divider orientation="left">{t('Manage supplier order')}</Divider>
                <Collapse
                  activeKey={managePanels}
                  onChange={(keys) => setManagePanels(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
                  items={[
                    {
                      key: 'history',
                      label: t('Order lines and product order history'),
                      children: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Table<PlainRecord>
                            size="small"
                            rowKey={(line) => line.id}
                            dataSource={orderLineHistory}
                            pagination={{ pageSize: 5, showSizeChanger: false }}
                            columns={[
                              {
                                title: t('Status'),
                                key: 'status',
                                render: (_value: any, line: PlainRecord) => (
                                  <Tag color={supplierOrderStatusColor(line.order?.status)}>
                                    {t(line.order?.status ?? 'unknown')}
                                  </Tag>
                                ),
                              },
                              {
                                title: t('Supplier order'),
                                key: 'order',
                                render: (_value: any, line: PlainRecord) =>
                                  line.order?.externalOrderRef ?? line.supplierOrderId ?? '—',
                              },
                              { title: t('Ordered'), dataIndex: 'orderedQty', render: formatNumber },
                              { title: t('Received'), dataIndex: 'receivedQty', render: formatNumber },
                              { title: t('Expected delivery'), dataIndex: 'expectedDeliveryDate', render: formatDate },
                              { title: t('Expected sellable'), dataIndex: 'expectedSellableDate', render: formatDate },
                              { title: t('Observed'), dataIndex: 'observedAt', render: formatDate },
                              { title: t('Source'), dataIndex: 'sourceStage', render: (value: string) => value || '—' },
                              {
                                title: t('Actions'),
                                key: 'actions',
                                render: (_value: any, line: PlainRecord) => (
                                  <Space size={4}>
                                    <Button size="small" onClick={() => startEditLine(line)}>
                                      {t('Edit line')}
                                    </Button>
                                    <Button size="small" onClick={() => startEditOrder(line.order ?? {})}>
                                      {t('Update order')}
                                    </Button>
                                    <Popconfirm
                                      title={t('Delete this order line?')}
                                      okText={t('Delete')}
                                      cancelText={t('Cancel')}
                                      onConfirm={() => void deleteOrderLine(line)}
                                    >
                                      <Button size="small" danger>
                                        {t('Delete')}
                                      </Button>
                                    </Popconfirm>
                                  </Space>
                                ),
                              },
                            ]}
                          />
                          {orderActivities.length > 0 ? (
                            <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              <Typography.Text strong>{t('Recent order/product notes')}</Typography.Text>
                              {orderActivities.slice(0, 5).map((activity) => (
                                <Alert
                                  key={String(activity.id)}
                                  type="info"
                                  showIcon
                                  message={`${t(String(activity.activityType ?? 'note'))} · ${formatDate(
                                    activity.occurredAt,
                                  )}`}
                                  description={String(activity.notes ?? '—')}
                                />
                              ))}
                            </Space>
                          ) : null}
                          <Button type="primary" onClick={() => void draftOrder()}>
                            {t('Draft new order for this product')}
                          </Button>
                        </Space>
                      ),
                    },
                    {
                      key: 'edit-line',
                      label: lineEditValues ? t('Edit selected order line') : t('Edit order line'),
                      children: lineEditValues ? (
                        <Row gutter={[12, 12]}>
                          <Col xs={24} md={8}>
                            <Typography.Text strong>{t('Supplier order ID')}</Typography.Text>
                            <Input
                              value={lineEditValues.externalOrderRef}
                              onChange={(event) => setLineEditValue('externalOrderRef', event.target.value)}
                            />
                            <Typography.Text type="secondary">
                              {t('Supplier-facing order number. Must be unique per company.')}
                            </Typography.Text>
                          </Col>
                          <Col xs={24} md={8}>
                            <Typography.Text strong>{t('Ordered quantity')}</Typography.Text>
                            <InputNumber
                              min={1}
                              value={lineEditValues.orderedQty}
                              onChange={(value) => setLineEditValue('orderedQty', Number(value ?? 1))}
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={8}>
                            <Typography.Text strong>{t('Received quantity')}</Typography.Text>
                            <InputNumber
                              min={0}
                              value={lineEditValues.receivedQty}
                              onChange={(value) => setLineEditValue('receivedQty', Number(value ?? 0))}
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={8}>
                            <Typography.Text strong>{t('Unit cost')}</Typography.Text>
                            <InputNumber
                              min={0}
                              value={lineEditValues.unitCost}
                              onChange={(value) =>
                                setLineEditValue('unitCost', value === null ? undefined : Number(value))
                              }
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Typography.Text strong>{t('Expected delivery')}</Typography.Text>
                            <DatePicker
                              value={
                                lineEditValues.expectedDeliveryDate
                                  ? dayjs(lineEditValues.expectedDeliveryDate)
                                  : undefined
                              }
                              onChange={(_date, value) =>
                                setLineEditValue(
                                  'expectedDeliveryDate',
                                  Array.isArray(value) ? value[0] : value || undefined,
                                )
                              }
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Typography.Text strong>{t('Expected sellable')}</Typography.Text>
                            <DatePicker
                              value={
                                lineEditValues.expectedSellableDate
                                  ? dayjs(lineEditValues.expectedSellableDate)
                                  : undefined
                              }
                              onChange={(_date, value) =>
                                setLineEditValue(
                                  'expectedSellableDate',
                                  Array.isArray(value) ? value[0] : value || undefined,
                                )
                              }
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24}>
                            <Typography.Text strong>{t('Notes')}</Typography.Text>
                            <Input.TextArea
                              rows={2}
                              value={lineEditValues.notes}
                              onChange={(event) => setLineEditValue('notes', event.target.value)}
                            />
                          </Col>
                          <Col xs={24}>
                            <Space>
                              <Button type="primary" onClick={() => void saveOrderLineEdit()}>
                                {t('Save order line')}
                              </Button>
                              <Button onClick={() => setLineEditValues(null)}>{t('Cancel')}</Button>
                            </Space>
                          </Col>
                        </Row>
                      ) : (
                        <Alert type="info" showIcon message={t('Select an order line from history to edit it.')} />
                      ),
                    },
                    {
                      key: 'order-status',
                      label: t('Update supplier order status / note'),
                      children: orderEditValues ? (
                        <Row gutter={[12, 12]}>
                          <Col xs={24} md={14}>
                            <Typography.Text strong>{t('Supplier order')}</Typography.Text>
                            <Select
                              showSearch
                              value={orderEditValues.supplierOrderId || undefined}
                              onChange={(value) => {
                                const order = orderOptions.find((candidate) => String(candidate.id) === value) ?? {};
                                setOrderEditValues({
                                  supplierOrderId: value,
                                  supplierId: String(order.supplierId ?? ''),
                                  status: String(order.status ?? 'draft'),
                                  notes: orderEditValues.notes,
                                });
                              }}
                              optionFilterProp="label"
                              style={{ width: '100%' }}
                              options={orderOptions.map((order) => ({
                                value: String(order.id),
                                label: `${order.externalOrderRef ?? order.id} · ${order.status ?? 'unknown'}`,
                              }))}
                            />
                          </Col>
                          <Col xs={24} md={10}>
                            <Typography.Text strong>{t('New status')}</Typography.Text>
                            <Select
                              value={orderEditValues.status}
                              onChange={(value) => setOrderEditValue('status', value)}
                              options={SUPPLIER_ORDER_STATUS_OPTIONS.map((option) => ({
                                ...option,
                                label: t(option.label),
                              }))}
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24}>
                            <Typography.Text strong>{t('Supplier update / order comment')}</Typography.Text>
                            <Input.TextArea
                              rows={3}
                              value={orderEditValues.notes}
                              onChange={(event) => setOrderEditValue('notes', event.target.value)}
                              placeholder={t('Example: supplier confirmed payment and will ship Friday')}
                            />
                          </Col>
                          <Col xs={24}>
                            <Space>
                              <Button type="primary" onClick={() => void saveOrderStatus()}>
                                {t('Save order status')}
                              </Button>
                              <Button onClick={() => setOrderEditValues(null)}>{t('Cancel')}</Button>
                            </Space>
                          </Col>
                        </Row>
                      ) : (
                        <Alert type="info" showIcon message={t('No supplier order history found for this product.')} />
                      ),
                    },
                    {
                      key: 'product-tasks-targets',
                      label: t('Product tasks and targets'),
                      children: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Alert
                            type="info"
                            showIcon
                            message={t('Product tasks and targets')}
                            description={t(
                              'This pane is the placeholder for operator tasks and product targets. It shows linked Silver tasks/targets when they exist; target authoring will come later.',
                            )}
                          />
                          <Typography.Text strong>{t('Tasks')}</Typography.Text>
                          <Table<PlainRecord>
                            size="small"
                            rowKey={(task) => String(task.id)}
                            dataSource={productTasks}
                            pagination={false}
                            locale={{ emptyText: t('No linked tasks for this product yet.') }}
                            columns={[
                              { title: t('Task'), dataIndex: 'title' },
                              { title: t('Status'), dataIndex: 'status', render: (value: string) => value || '—' },
                              { title: t('Priority'), dataIndex: 'priority', render: (value: string) => value || '—' },
                              { title: t('Due'), dataIndex: 'dueAt', render: formatDate },
                            ]}
                          />
                          <Typography.Text strong>{t('Targets')}</Typography.Text>
                          <Table<PlainRecord>
                            size="small"
                            rowKey={(target) => String(target.id)}
                            dataSource={productTargets}
                            pagination={false}
                            locale={{ emptyText: t('No linked targets for this product yet.') }}
                            columns={[
                              { title: t('Metric'), dataIndex: 'metric' },
                              { title: t('Period'), dataIndex: 'periodType', render: (value: string) => value || '—' },
                              { title: t('Target'), dataIndex: 'targetValue', render: formatNumber },
                              { title: t('Status'), dataIndex: 'status', render: (value: string) => value || '—' },
                            ]}
                          />
                        </Space>
                      ),
                    },
                    {
                      key: 'draft',
                      label: t('Draft new supplier order'),
                      children: (
                        <Row gutter={[12, 12]}>
                          <Col xs={24} md={8}>
                            <Typography.Text strong>{t('Quantity')}</Typography.Text>
                            <InputNumber
                              min={1}
                              value={actionValues.draftQty}
                              onChange={(value) => setActionValue('draftQty', Number(value ?? 1))}
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={16}>
                            <Typography.Text strong>{t('Supplier')}</Typography.Text>
                            <Select
                              showSearch
                              allowClear
                              placeholder={t('Search supplier by name, code, or company')}
                              value={actionValues.draftSupplierId || undefined}
                              onChange={(value) => setActionValue('draftSupplierId', value ?? '')}
                              optionFilterProp="label"
                              style={{ width: '100%' }}
                              options={supplierOptions.map((supplier) => ({
                                value: supplier.id,
                                label: `${supplier.name ?? supplier.supplierId ?? supplier.id}${
                                  supplier.supplierId ? ` · ${supplier.supplierId}` : ''
                                }`,
                              }))}
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Typography.Text strong>{t('Expected delivery')}</Typography.Text>
                            <DatePicker
                              value={
                                actionValues.draftExpectedDeliveryDate
                                  ? dayjs(actionValues.draftExpectedDeliveryDate)
                                  : undefined
                              }
                              onChange={(_date, value) =>
                                setActionValue(
                                  'draftExpectedDeliveryDate',
                                  Array.isArray(value) ? value[0] : value || undefined,
                                )
                              }
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Typography.Text strong>{t('Expected sellable')}</Typography.Text>
                            <DatePicker
                              value={
                                actionValues.draftExpectedSellableDate
                                  ? dayjs(actionValues.draftExpectedSellableDate)
                                  : undefined
                              }
                              onChange={(_date, value) =>
                                setActionValue(
                                  'draftExpectedSellableDate',
                                  Array.isArray(value) ? value[0] : value || undefined,
                                )
                              }
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24}>
                            <Typography.Text strong>{t('Notes')}</Typography.Text>
                            <Input.TextArea
                              rows={2}
                              value={actionValues.draftNotes}
                              onChange={(event) => setActionValue('draftNotes', event.target.value)}
                            />
                          </Col>
                          <Col xs={24}>
                            <Button type="primary" onClick={() => void draftOrder()}>
                              {t('Create draft order')}
                            </Button>
                          </Col>
                        </Row>
                      ),
                    },
                    {
                      key: 'add',
                      label: t('Add product to an existing supplier order'),
                      children: (
                        <Row gutter={[12, 12]}>
                          <Col xs={24} md={16}>
                            <Typography.Text strong>{t('Supplier order')}</Typography.Text>
                            <Select
                              showSearch
                              allowClear
                              placeholder={t('Search open supplier orders')}
                              value={actionValues.addSupplierOrderId || undefined}
                              onChange={(value) => setActionValue('addSupplierOrderId', value ?? '')}
                              optionFilterProp="label"
                              style={{ width: '100%' }}
                              options={orderOptions.map((order) => ({
                                value: order.id,
                                label: `${order.externalOrderRef ?? order.id} · ${order.status ?? 'unknown'}${
                                  order.supplierId ? ` · ${order.supplierId}` : ''
                                }`,
                              }))}
                            />
                          </Col>
                          <Col xs={24} md={8}>
                            <Typography.Text strong>{t('Quantity')}</Typography.Text>
                            <InputNumber
                              min={1}
                              value={actionValues.addQty}
                              onChange={(value) => setActionValue('addQty', Number(value ?? 1))}
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Typography.Text strong>{t('Expected delivery')}</Typography.Text>
                            <DatePicker
                              value={
                                actionValues.addExpectedDeliveryDate
                                  ? dayjs(actionValues.addExpectedDeliveryDate)
                                  : undefined
                              }
                              onChange={(_date, value) =>
                                setActionValue(
                                  'addExpectedDeliveryDate',
                                  Array.isArray(value) ? value[0] : value || undefined,
                                )
                              }
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Typography.Text strong>{t('Expected sellable')}</Typography.Text>
                            <DatePicker
                              value={
                                actionValues.addExpectedSellableDate
                                  ? dayjs(actionValues.addExpectedSellableDate)
                                  : undefined
                              }
                              onChange={(_date, value) =>
                                setActionValue(
                                  'addExpectedSellableDate',
                                  Array.isArray(value) ? value[0] : value || undefined,
                                )
                              }
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24}>
                            <Typography.Text strong>{t('Notes')}</Typography.Text>
                            <Input.TextArea
                              rows={2}
                              value={actionValues.addNotes}
                              onChange={(event) => setActionValue('addNotes', event.target.value)}
                            />
                          </Col>
                          <Col xs={24}>
                            <Button onClick={() => void addToExistingOrder()}>{t('Add to existing order')}</Button>
                          </Col>
                        </Row>
                      ),
                    },
                    {
                      key: 'lead-time',
                      label: t('Update product-specific lead time'),
                      children: (
                        <Row gutter={[12, 12]}>
                          <Col xs={24} md={16}>
                            <Typography.Text strong>{t('Supplier')}</Typography.Text>
                            <Select
                              showSearch
                              allowClear
                              placeholder={t('Search supplier by name, code, or company')}
                              value={actionValues.leadSupplierId || undefined}
                              onChange={(value) => setActionValue('leadSupplierId', value ?? '')}
                              optionFilterProp="label"
                              style={{ width: '100%' }}
                              options={supplierOptions.map((supplier) => ({
                                value: supplier.id,
                                label: `${supplier.name ?? supplier.supplierId ?? supplier.id}${
                                  supplier.supplierId ? ` · ${supplier.supplierId}` : ''
                                }`,
                              }))}
                            />
                          </Col>
                          <Col xs={24} md={8}>
                            <Typography.Text strong>{t('Lead time days')}</Typography.Text>
                            <InputNumber
                              min={0}
                              value={actionValues.leadTimeDays}
                              onChange={(value) => setActionValue('leadTimeDays', Number(value ?? 0))}
                              style={{ width: '100%' }}
                            />
                          </Col>
                          <Col xs={24}>
                            <Typography.Text strong>{t('Evidence / notes')}</Typography.Text>
                            <Input.TextArea
                              rows={2}
                              value={actionValues.leadNotes}
                              onChange={(event) => setActionValue('leadNotes', event.target.value)}
                              placeholder={t('Example: supplier confirmed by email today')}
                            />
                          </Col>
                          <Col xs={24}>
                            <Button onClick={() => void updateLeadTime()}>{t('Save lead time')}</Button>
                          </Col>
                        </Row>
                      ),
                    },
                  ]}
                />
              </>
            ) : null}
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
