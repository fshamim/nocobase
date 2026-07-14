/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
import { FormulaHelp, type FormulaHelpGroupKey } from '../../../client/formula-help';
import { useT } from '../../../client/locale';

type PlainRecord = Record<string, any>;

function asPlainRecord(value: unknown): PlainRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PlainRecord) : {};
}

const MONEY_AT_RISK_COLOR = '#8b1a1a';
type OrderNowQuickFilter =
  | 'all'
  | 'urgent_today'
  | 'missing_supplier'
  | 'lead_time_issues'
  | 'no_order'
  | 'placed_not_purchased';
type OrderNowSortKey = 'urgency' | 'oos_asc' | 'risk_desc' | 'tier' | 'supplier';
type CommandCenterPaneKey =
  | 'supplyAction'
  | 'missingSupplier'
  | 'activeOrders'
  | 'inboundMonitoring'
  | 'healthyInventory'
  | 'stuckInventory'
  | 'dataReadiness'
  | 'duplicateProducts';

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

interface ActivityCommentEditValues {
  id: string;
  notes: string;
}

const RECEIPT_OVERRIDE_OPTIONS = [
  'awaiting_amazon_stock',
  'partially_observed',
  'amazon_stock_observed',
  'completed_by_later_inbound',
  'review_required',
].map((value) => ({ value, label: value }));

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
    case 'default':
      return 'blue';
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

function finiteNumber(value: any) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function formatNumber(value: any) {
  const number = finiteNumber(value);
  return typeof number === 'number' ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
}

function formatCurrency(value: any) {
  const number = finiteNumber(value);
  return typeof number === 'number'
    ? number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—';
}

function formatPercent(value: any) {
  const number = finiteNumber(value);
  return typeof number === 'number' ? `${number.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—';
}

function formatTier(value: any) {
  return value && value !== 'unclassified' ? String(value) : '—';
}

function formatStatusLabel(value: any) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function formatPipelineHealthLabel(value: any) {
  return value === 'late_with_grace' ? 'Late With Buffer' : formatStatusLabel(value);
}

function formatExpectedArrivalSource(value: any) {
  const source = String(value ?? '');
  if (source.startsWith('planning_settings.default_expected_arrival_lead_time')) {
    return 'Planning default lead time + receiving buffer';
  }
  if (source.startsWith('silver_family.preferred_supplier_product_lead_time')) {
    return 'Preferred supplier lead time + receiving buffer';
  }
  if (source.startsWith('silver_order_line.supplier_product_lead_time')) {
    return 'Order-line supplier lead time + receiving buffer';
  }
  return formatStatusLabel(source || 'insufficient_silver_evidence');
}

function formatTierScore(value: any) {
  const number = finiteNumber(value);
  return typeof number === 'number' ? formatNumber(number) : '—';
}

function formatDate(value: any) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 10) : '—';
}

function formatDateTime(value: any) {
  const date = typeof value === 'string' && value.length > 0 ? dayjs(value) : undefined;
  return date?.isValid() ? date.format('YYYY-MM-DD HH:mm') : formatDate(value);
}

function formatRelativeTime(value: any) {
  const date = typeof value === 'string' && value.length > 0 ? dayjs(value) : undefined;
  if (!date?.isValid()) return '—';
  const seconds = Math.max(0, dayjs().diff(date, 'second'));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 365) return `${weeks}wk ago`;
  return `${Math.floor(days / 365)}yr ago`;
}

function relativeDateLabel(value: any, baseDate: string) {
  if (typeof value !== 'string' || value.length === 0) return { label: '—', detail: undefined };
  const target = dayjs(value.slice(0, 10));
  const base = dayjs(baseDate);
  if (!target.isValid() || !base.isValid()) return { label: '—', detail: undefined };
  const diff = target.diff(base, 'day');
  if (diff < 0) return { label: `${Math.abs(diff)} days overdue`, detail: value.slice(0, 10), color: 'red' };
  if (diff === 0) return { label: 'Today', detail: value.slice(0, 10), color: 'volcano' };
  if (diff === 1) return { label: 'Tomorrow', detail: value.slice(0, 10), color: 'orange' };
  return { label: `In ${diff} days`, detail: value.slice(0, 10), color: diff <= 7 ? 'gold' : 'default' };
}

function canChangeActivityComment(activity: PlainRecord) {
  return (
    !activity.deletedAt &&
    String(activity.source ?? 'manual') === 'manual' &&
    String(activity.activityType ?? '') === 'note'
  );
}

function StockStatus({ row, t }: { row: PlainRecord; t: (key: string) => string }) {
  const reserved = Number(row.reservedStock ?? 0);
  const sellable = Number(row.sellableStock ?? 0);
  const pipeline = Number(row.pipelineStock ?? 0);
  const inbound = Number(row.inboundStock ?? 0);
  const ordered = Number(row.orderedStock ?? 0);
  const prep = Number(row.prepStock ?? 0);
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
        <Tag color={inbound > 0 ? 'geekblue' : 'default'}>
          {t('Inbound')} {formatNumber(inbound)}
        </Tag>
        <Tag color={ordered > 0 ? 'purple' : 'default'}>
          {t('Ordered')} {formatNumber(ordered)}
        </Tag>
        <Tag color={prep > 0 ? 'gold' : 'default'}>
          {t('Prep')} {formatNumber(prep)}
        </Tag>
      </Space>
    </Space>
  );
}

function SkuFamilyReconciliation({ row, t }: { row: PlainRecord; t: (key: string) => string }) {
  const reconciliation = asPlainRecord(asPlainRecord(row.evidence).duplicateSkuSupplierSource);
  const sourceSku = String(reconciliation.sourceSku ?? '');
  if (!sourceSku || sourceSku === String(row.sku ?? '')) return null;
  const sellerboardRepresentsCoverage = reconciliation.coverageTreatment === 'represented_in_sellerboard';
  return (
    <Space direction="vertical" size={4}>
      <Space size={4} wrap>
        <Tag color="green">{t('Auto-linked')}</Tag>
        <Typography.Text>
          {sourceSku} → {String(row.sku ?? '—')}
        </Typography.Text>
        {reconciliation.supplierOrderRef ? <Tag>{String(reconciliation.supplierOrderRef)}</Tag> : null}
      </Space>
      <Typography.Text type="secondary">
        {t('Same company + ASIN')}.{' '}
        {sellerboardRepresentsCoverage
          ? t('Sellerboard pipeline already counts this replenishment; supplier-order quantity was not added again.')
          : t('Sellerboard has no pipeline quantity; reliable supplier-order coverage is used.')}
      </Typography.Text>
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
    return 'Potential profit loss if this product remains uncovered: max(lead time + safety buffer − days of cover, 0) × sales velocity × profit per unit. Profit per unit is dollars/unit, not margin %.';
  }
  if (row.estimatedProfitRiskBasis === 'planning_calculation_estimated_profit_risk') {
    return 'Potential profit loss from the planning calculation service. It uses uncovered days, sales velocity, and profit per unit when those inputs are available. Profit per unit is dollars/unit, not margin %.';
  }
  if (row.estimatedProfitRiskBasis === 'imported_missed_profit_or_30_day_profit_forecast') {
    return 'Imported missed-profit estimate or 30-day profit forecast for a tiered product because uncovered-day math was unavailable.';
  }
  if (row.estimatedProfitRiskBasis === 'not_tiered_profit_inputs_missing') {
    return 'No active money at risk: this product is not in profit tier A, B, or C because profit inputs are missing or zero.';
  }
  return 'Money at risk is unavailable until tierable profit data is imported.';
}

function profitInputText() {
  return 'Profit per unit is dollar profit per sold unit, not profit margin %. When six-month Sellerboard history exists, EcoBase derives it from total net profit ÷ total units; otherwise it falls back to planning sheet profit inputs.';
}

function productStatusText() {
  return 'MasterStock status uses operator BackendSheet status first for Not selling, Hold, or One Time. Otherwise it derives OOS, Inactive, Inbound, or Reserved from sellable, reserved, inbound, ordered, and prep/AWD stock buckets.';
}

function orderCoverageText() {
  return 'Coverage counts only reliable purchased pipeline that can still prevent OOS: paid, supplier preparing, or shipped inbound orders in the current recovery cycle. Draft, approval/payment-pending, cancelled, reached-FBA, and old historical rows do not reduce suggested reorder quantity, so this is often zero.';
}

function tierScoreText() {
  return 'Tier score = profit per unit × actual units sold in the latest rolling 30-day window. A product needs at least 4 units and must not be stuck to qualify for A/B/C; otherwise it is Unclassified. Six-month quantities remain historical context only.';
}

function TierMovementTag({ row, t }: { row: PlainRecord; t: (key: string) => string }) {
  const movement = String(row.tierMovement ?? '');
  if (!['up', 'down', 'new', 'lost_tier'].includes(movement)) return null;
  const previous = formatTier(row.previousTier);
  const current = formatTier(row.tier);
  return (
    <Tag color={movement === 'down' || movement === 'lost_tier' ? 'red' : 'green'}>{t(`${previous}→${current}`)}</Tag>
  );
}

function MarginAlertTag({ row, t }: { row: PlainRecord; t: (key: string) => string }) {
  const margin = finiteNumber(row.sixMonthMargin);
  return typeof margin === 'number' && margin < 8 ? <Tag color="red">{t('Margin < 8%')}</Tag> : null;
}

function HistoricalQuantityTags({ row, t }: { row: PlainRecord; t: (key: string) => string }) {
  return (
    <Space size={4} wrap>
      <Tag>{`${t('Last')} ${formatNumber(row.lastMonthQty)}`}</Tag>
      <Tag>{`${t('Avg')} ${formatNumber(row.sixMonthAverageQty)}`}</Tag>
      <Tag>{`${t('Worst')} ${formatNumber(row.sixMonthWorstQty)}`}</Tag>
      <Tag>{`${t('Best')} ${formatNumber(row.sixMonthBestQty)}`}</Tag>
    </Space>
  );
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
  const [targetCoverDays, setTargetCoverDays] = useState(45);
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
  const [commandCenter, setCommandCenter] = useState<PlainRecord>({});
  const [activeCommandPane, setActiveCommandPane] = useState<CommandCenterPaneKey>('supplyAction');
  const [openCommandPane, setOpenCommandPane] = useState<CommandCenterPaneKey | null>('supplyAction');
  const [commandCenterSearch, setCommandCenterSearch] = useState('');
  const [commandCenterSortBy, setCommandCenterSortBy] = useState('estimatedProfitRisk');
  const [selectedCommandPane, setSelectedCommandPane] = useState<CommandCenterPaneKey | null>(null);
  const [selectedRow, setSelectedRow] = useState<PlainRecord | null>(null);
  const [actionValues, setActionValues] = useState<DrawerActionValues | null>(null);
  const [supplierOptions, setSupplierOptions] = useState<PlainRecord[]>([]);
  const [orderOptions, setOrderOptions] = useState<PlainRecord[]>([]);
  const [orderLineHistory, setOrderLineHistory] = useState<PlainRecord[]>([]);
  const [orderActivities, setOrderActivities] = useState<PlainRecord[]>([]);
  const [productTasks, setProductTasks] = useState<PlainRecord[]>([]);
  const [productTargets, setProductTargets] = useState<PlainRecord[]>([]);
  const [lineEditValues, setLineEditValues] = useState<LineEditValues | null>(null);
  const [receiptOverrideStatus, setReceiptOverrideStatus] = useState('review_required');
  const [receiptOverrideReason, setReceiptOverrideReason] = useState('');
  const [orderEditValues, setOrderEditValues] = useState<OrderEditValues | null>(null);
  const [orderCommentText, setOrderCommentText] = useState('');
  const [activityCommentEdit, setActivityCommentEdit] = useState<ActivityCommentEditValues | null>(null);
  const [managePanels, setManagePanels] = useState<string[]>([]);
  const [budgetAmount, setBudgetAmount] = useState<number | null>(null);
  const [budgetHorizonDays, setBudgetHorizonDays] = useState(30);
  const [budgetResult, setBudgetResult] = useState<PlainRecord | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rebuildingGold, setRebuildingGold] = useState(false);
  const [targetUpdatingFamilyId, setTargetUpdatingFamilyId] = useState<string>();
  const [error, setError] = useState<Error | null>(null);
  const sortedOrderActivities = useMemo(
    () =>
      [...orderActivities].sort(
        (left, right) =>
          (new Date(String(right.occurredAt ?? right.createdAt ?? 0)).getTime() || 0) -
          (new Date(String(left.occurredAt ?? left.createdAt ?? 0)).getTime() || 0),
      ),
    [orderActivities],
  );

  const loadPlanningSettings = useCallback(async () => {
    const response = await api.request({ url: 'ecobasePlanningSettings:get', method: 'post', data: {} });
    const data = unwrapData(response);
    const settings = data.settings ?? {};
    setLeadTimeFreshnessDays(Number(settings.leadTimeFreshnessDays ?? 60));
    setOrderSoonWindowDays(Number(settings.orderSoonWindowDays ?? 14));
    setSafetyBufferDays(Number(settings.safetyBufferDays ?? 7));
    setTargetCoverDays(Number(settings.targetCoverDays ?? 45));
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
        targetCoverDays,
        purchasedPipelineGraceDays,
        limit,
      };
      const [filtersResponse, commandCenterResponse] = await Promise.all([
        api.request({ url: 'ecobaseInventoryPlanning:filters', method: 'post', data: {} }),
        api.request({
          url: 'ecobaseInventoryPlanning:commandCenter',
          method: 'post',
          data: {
            ...payload,
            pane: activeCommandPane,
            pageSize: limit,
            sortBy: commandCenterSortBy,
            sortDirection: 'desc',
            filters: {
              actionStatus,
              tier,
              search: commandCenterSearch.trim() || undefined,
            },
          },
        }),
      ]);
      const center = unwrapData(commandCenterResponse);
      const panes = unwrapData(center.panes);
      setFilterOptions(unwrapData(unwrapData(filtersResponse).filters ?? filtersResponse));
      setCommandCenter(center);
      setRows(
        (
          [
            'supplyAction',
            'missingSupplier',
            'activeOrders',
            'inboundMonitoring',
            'healthyInventory',
            'stuckInventory',
            'dataReadiness',
          ] as CommandCenterPaneKey[]
        ).flatMap((key) => unwrapRows(unwrapData(panes[key]).rows)),
      );
      setDigest(unwrapDigest({}));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [
    actionStatus,
    activeCommandPane,
    api,
    calculationDate,
    commandCenterSearch,
    commandCenterSortBy,
    company,
    leadTimeFreshnessDays,
    limit,
    orderSoonWindowDays,
    purchasedPipelineGraceDays,
    safetyBufferDays,
    targetCoverDays,
    tier,
  ]);

  const updateFamilyTarget = useCallback(
    async (row: PlainRecord, companyProductId: string) => {
      const familyId = String(row.companyProductFamilyId ?? '');
      if (!familyId || !companyProductId || companyProductId === row.replenishmentTargetCompanyProductId) return;
      setTargetUpdatingFamilyId(familyId);
      try {
        await api.request({
          url: 'ecobaseInventoryPlanning:setFamilyTarget',
          method: 'post',
          data: {
            familyId,
            companyProductId,
            company: company.trim() || undefined,
            calculationDate: calculationDate.trim() || undefined,
          },
        });
        message.success(t('Replenishment target updated.'));
        await loadPlanning();
      } catch (err) {
        message.error(err instanceof Error ? err.message : t('Replenishment target could not be updated.'));
      } finally {
        setTargetUpdatingFamilyId(undefined);
      }
    },
    [api, calculationDate, company, loadPlanning, message, t],
  );

  useEffect(() => {
    void loadPlanningSettings().catch((err) => setError(err as Error));
  }, [loadPlanningSettings]);

  useEffect(() => {
    void loadPlanning();
  }, [loadPlanning]);

  const syncEditableRows = useCallback(async () => {
    setLoading(true);
    setRebuildingGold(true);
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
          targetCoverDays,
          purchasedPipelineGraceDays,
        },
      });
      await loadPlanning();
    } catch (err) {
      setError(err as Error);
      setLoading(false);
    } finally {
      setRebuildingGold(false);
    }
  }, [
    api,
    calculationDate,
    company,
    leadTimeFreshnessDays,
    loadPlanning,
    orderSoonWindowDays,
    purchasedPipelineGraceDays,
    safetyBufferDays,
    targetCoverDays,
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
          targetCoverDays,
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
    safetyBufferDays,
    targetCoverDays,
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

  const commandMetadata = unwrapData(commandCenter.metadata);
  const commandHistoryReadiness = unwrapData(commandMetadata.historyReadiness);
  const commandPanes = unwrapData(commandCenter.panes);
  const commandSummaryCards = Array.isArray(commandCenter.summaryCards) ? commandCenter.summaryCards : [];
  const commandMacroRisk = unwrapRows(commandCenter.macroRisk);
  const commandRiskBars = unwrapData(commandCenter.riskBars);
  const commandCalculationDate = String(commandMetadata.calculationDate ?? relativeBaseDate);
  const commandTargetCoverDays = finiteNumber(commandMetadata.targetCoverDays) ?? targetCoverDays;
  const commandPaneTitles: Record<CommandCenterPaneKey, string> = {
    supplyAction: t('Families needing supply action — no active order'),
    missingSupplier: t('Families missing supplier — stockout risk'),
    activeOrders: t('Families with current order cycles — pipeline monitoring'),
    inboundMonitoring: t('Inbound Monitoring — awaiting Amazon stock'),
    healthyInventory: t('Healthy inventory — current coverage sufficient'),
    stuckInventory: t('Stuck & excess inventory'),
    dataReadiness: t('Data readiness — operational inputs needed'),
    duplicateProducts: t('Duplicate SKU review'),
  };
  const commandPaneDescriptions: Record<CommandCenterPaneKey, string> = {
    supplyAction: t(
      'One row per product family. Family stock and velocity drive the reorder; expand a row to inspect each listing.',
    ),
    missingSupplier: t(
      'One row per at-risk family without a verified preferred supplier. Expand the family to inspect listing evidence.',
    ),
    activeOrders: t(
      'One row per family with one current order reference. Older cycles are excluded from coverage and shown as evidence.',
    ),
    inboundMonitoring: t(
      'Exact ClickUp inbound-monitoring families awaiting or partially showing in Sellerboard Amazon stock.',
    ),
    healthyInventory: t(
      'Current sellable stock and trusted velocity show sufficient on-hand coverage; no receipt event is required.',
    ),
    stuckInventory: t(
      'One action row per family. Expand it to see which listings are affected, their stock, sell-through, cost, and active orders.',
    ),
    dataReadiness: t(
      'Current inventory is retained here when velocity, family target, or another required operational input is not ready.',
    ),
    duplicateProducts: t(
      'Same company + ASIN rows with different SKUs. Review and resolve before using them for planning.',
    ),
  };
  const commandPaneSortOptions: Record<CommandCenterPaneKey, { value: string; label: string }[]> = {
    supplyAction: [
      { value: 'estimatedProfitRisk', label: t('Money at risk') },
      { value: 'daysUntilOos', label: t('OOS days left') },
      { value: 'daysUntilSafeReorder', label: t('Order-by urgency') },
      { value: 'tier', label: t('Tier') },
    ],
    missingSupplier: [
      { value: 'estimatedProfitRisk', label: t('Money at risk') },
      { value: 'daysUntilOos', label: t('OOS days left') },
      { value: 'tier', label: t('Tier') },
    ],
    activeOrders: [
      { value: 'stockoutGapDays', label: t('Stockout gap') },
      { value: 'expectedArrivalDate', label: t('Expected arrival') },
      { value: 'estimatedProfitRisk', label: t('Money at risk') },
    ],
    inboundMonitoring: [
      { value: 'stockoutGapDays', label: t('Stockout gap') },
      { value: 'expectedArrivalDate', label: t('Expected arrival') },
      { value: 'estimatedProfitRisk', label: t('Money at risk') },
    ],
    healthyInventory: [
      { value: 'daysOfCover', label: t('Days cover') },
      { value: 'currentPlanningStock', label: t('Current stock') },
      { value: 'amazonReceiptObservedAt', label: t('Receipt observed') },
    ],
    stuckInventory: [
      { value: 'familyStuckAffectedValue', label: t('Affected value') },
      { value: 'familyDaysOfCover', label: t('Family days cover') },
      { value: 'familyCurrentPlanningStock', label: t('Family stock') },
    ],
    dataReadiness: [
      { value: 'company', label: t('Company') },
      { value: 'familyCanonicalAsin', label: t('Family ASIN') },
      { value: 'inventoryAsOfDate', label: t('Inventory date') },
    ],
    duplicateProducts: [
      { value: 'currentPlanningStock', label: t('Planning stock') },
      { value: 'asin', label: t('ASIN') },
      { value: 'duplicatePrimarySku', label: t('Primary SKU') },
    ],
  };
  const commandPaneHelpGroups: Record<CommandCenterPaneKey, FormulaHelpGroupKey> = {
    supplyAction: 'inventorySupplyAction',
    missingSupplier: 'inventorySupplyAction',
    activeOrders: 'inventoryActiveOrders',
    inboundMonitoring: 'inventoryInboundMonitoring',
    healthyInventory: 'inventoryHealthyInventory',
    stuckInventory: 'inventoryStuckInventory',
    dataReadiness: 'inventoryDrawer',
    duplicateProducts: 'inventoryDrawer',
  };
  const renderRiskBars = (items: PlainRecord[]) => (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {items.map((item) => {
        const count = Number(item.count ?? 0);
        const max = Math.max(...items.map((entry) => Number(entry.count ?? 0)), 1);
        return (
          <div key={String(item.key)}>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Typography.Text>{t(formatPipelineHealthLabel(item.key))}</Typography.Text>
              <Typography.Text strong>{count}</Typography.Text>
            </Space>
            <div style={{ height: 8, borderRadius: 999, background: '#f0f0f0', overflow: 'hidden' }}>
              <div style={{ width: `${Math.round((count / max) * 100)}%`, height: 8, background: '#fa8c16' }} />
            </div>
          </div>
        );
      })}
    </Space>
  );
  const coverageColumnTitle = (
    <Tooltip
      title={
        <Space direction="vertical" size={0}>
          <span>{t('Line 1: days until stockout')}</span>
          <span>{t('Line 2: stockout date · daily sales')}</span>
          <span>{t('Line 3: days short of target cover')}</span>
        </Space>
      }
    >
      <span>{t('Coverage')}</span>
    </Tooltip>
  );
  const renderCoverageCell = (_value: any, row: PlainRecord) => {
    const daysLeft = finiteNumber(row.daysUntilOos);
    const daysLeftColor =
      typeof daysLeft !== 'number' ? 'default' : daysLeft <= 0 ? 'red' : daysLeft <= 7 ? 'orange' : 'blue';
    const daysLeftLabel =
      typeof daysLeft === 'number'
        ? daysLeft < 0
          ? `${formatNumber(Math.abs(daysLeft))} ${t('days overdue')}`
          : `${formatNumber(daysLeft)} ${t('days left')}`
        : t('No velocity');
    const salesVelocity = finiteNumber(row.salesVelocity);
    const date = formatDate(row.estimatedOosDate);
    const daysOfCover = finiteNumber(row.daysOfCover);
    const targetCover = finiteNumber(commandTargetCoverDays);
    const shortfall =
      typeof daysOfCover === 'number' && typeof targetCover === 'number' ? targetCover - daysOfCover : undefined;
    const shortfallLabel =
      typeof shortfall === 'number'
        ? shortfall > 0
          ? `${formatNumber(Math.ceil(shortfall))} ${t('days short')}`
          : t('At target')
        : '—';
    return (
      <Space direction="vertical" size={0}>
        <Tag color={daysLeftColor}>{daysLeftLabel}</Tag>
        <Typography.Text type="secondary">
          {date} · {typeof salesVelocity === 'number' ? formatNumber(salesVelocity) : '—'}/{t('day')}
        </Typography.Text>
        <Typography.Text type="secondary">{shortfallLabel}</Typography.Text>
      </Space>
    );
  };
  const renderCommandProductCell = (_value: any, row: PlainRecord) => (
    <Space direction="vertical" size={0} style={{ maxWidth: 180 }}>
      <Typography.Text strong>{row.asin ?? '—'}</Typography.Text>
      <Typography.Text type="secondary" ellipsis style={{ maxWidth: 180 }}>
        {row.sku ?? '—'}
      </Typography.Text>
      <Typography.Text type="secondary" ellipsis style={{ maxWidth: 180 }}>
        {row.company ?? '—'}
      </Typography.Text>
    </Space>
  );
  const renderCommandTierCell = (value: string, row: PlainRecord) => (
    <Space direction="vertical" size={0}>
      <Space size={4} wrap>
        <Tag color={tierColor(value)}>{formatTier(value)}</Tag>
        <TierMovementTag row={row} t={t} />
      </Space>
      <Typography.Text type="secondary">
        {t('30d units')} {formatNumber(row.recentUnits30)} · {t(formatStatusLabel(row.tierEligibilityReason))}
      </Typography.Text>
    </Space>
  );
  const renderDocCell = (_value: any, row: PlainRecord) => (
    <Typography.Text>
      {formatNumber(row.daysOfCover)} {t('days')}
    </Typography.Text>
  );
  const renderStockBucketTag = (label: string, title: string, value: any, color: string) => {
    const number = finiteNumber(value);
    const display = typeof number === 'number' ? formatNumber(number) : '—';
    const tagColor =
      typeof number === 'number' && number < 0 ? 'red' : typeof number === 'number' && number > 0 ? color : 'default';
    return (
      <Tooltip key={label} title={`${t(title)}: ${display}`}>
        <Tag color={tagColor} style={{ marginInlineEnd: 0 }}>
          {label} {display}
        </Tag>
      </Tooltip>
    );
  };
  const renderCurrentStockCell = (_value: any, row: PlainRecord) => (
    <Space direction="vertical" size={4} style={{ minWidth: 210 }}>
      <Space size={4} wrap>
        {renderStockBucketTag('Total', 'Total planning stock', row.currentPlanningStock, 'blue')}
      </Space>
      <Space size={[4, 4]} wrap>
        {renderStockBucketTag('FBA', 'FBA', row.sellableStock, 'green')}
        {renderStockBucketTag('RES', 'Reserved', row.reservedStock, 'gold')}
        {renderStockBucketTag('INB', 'Inbound', row.inboundStock, 'cyan')}
        {renderStockBucketTag('PRP', 'Prep', row.prepStock, 'magenta')}
        {renderStockBucketTag('ORD', 'Ordered', row.orderedStock, 'geekblue')}
      </Space>
    </Space>
  );
  const leadTimeFreshnessText = (row: PlainRecord) => {
    const sourceLeadTime = finiteNumber(row.leadTimeDays);
    const leadTime = sourceLeadTime ?? 30;
    const freshness = String(row.leadTimeFreshness ?? (sourceLeadTime === undefined ? 'default' : '')).trim();
    if (freshness === 'default') return `${formatNumber(leadTime)} ${t('days')} · ${t('Default')}`;
    return freshness
      ? `${formatNumber(leadTime)} ${t('days')} · ${t(freshness)}`
      : `${formatNumber(leadTime)} ${t('days')}`;
  };
  const activeOrderCost = (row: PlainRecord) => {
    const units = finiteNumber(row.openOrderCoverageQty);
    const unitCost = finiteNumber(row.unitCost);
    if (!String(row.unitCostAvailability ?? '').startsWith('resolved_')) return undefined;
    return typeof units === 'number' && typeof unitCost === 'number' ? units * unitCost : undefined;
  };
  const renderOrderByCell = (_value: any, row: PlainRecord) => {
    const label = relativeDateLabel(row.latestSafeReorderDate, commandCalculationDate);
    return (
      <Space direction="vertical" size={0} style={{ minWidth: 180 }}>
        <Tag color={label.color}>{t(label.label)}</Tag>
        <Typography.Text type="secondary">{label.detail ?? formatDate(row.latestSafeReorderDate)}</Typography.Text>
        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 180 }}>
          {row.supplierName ?? t('Supplier missing')}
        </Typography.Text>
        <Tag color={freshnessColor(row.leadTimeFreshness)} style={{ marginInlineEnd: 0 }}>
          {leadTimeFreshnessText(row)}
        </Tag>
      </Space>
    );
  };
  const renderSuggestedQtyCell = (_value: any, row: PlainRecord) => {
    const suggestedQty = finiteNumber(row.suggestedReorderQty);
    const unitCost = finiteNumber(row.unitCost);
    const estimatedOrderCost =
      finiteNumber(row.estimatedOrderCost) ??
      (typeof suggestedQty === 'number' && typeof unitCost === 'number' ? suggestedQty * unitCost : undefined);
    const unitCostAvailability = String(row.unitCostAvailability ?? 'unavailable_no_evidence');
    const costText =
      typeof estimatedOrderCost === 'number'
        ? `${t('Est. COGS')} ${formatCurrency(estimatedOrderCost)}`
        : unitCostAvailability === 'unavailable_ambiguous'
          ? t('COGS ambiguous')
          : t('COGS missing');
    return (
      <Space direction="vertical" size={0}>
        <Typography.Text strong>{formatNumber(row.suggestedReorderQty)}</Typography.Text>
        <Typography.Text type="secondary">{costText}</Typography.Text>
        <Typography.Text type="secondary">
          {t('Margin')} {formatPercent(row.sixMonthMargin)}
        </Typography.Text>
      </Space>
    );
  };
  const renderLatestOrderCommentPreview = (row: PlainRecord) => {
    const latestNote = String(row.latestSupplierOrderActivityNote ?? '').trim();
    if (!latestNote) return null;
    const latestAt = String(row.latestSupplierOrderActivityAt ?? '').trim();
    const previewWords = latestNote.split(/\s+/);
    const previewNote = previewWords.length > 18 ? `${previewWords.slice(0, 18).join(' ')}…` : latestNote;
    const author = String(
      row.latestSupplierOrderActivityActorDisplayName ?? row.latestSupplierOrderActivityActor ?? '',
    ).trim();
    return (
      <Tooltip
        title={
          <Space direction="vertical" size={0}>
            {author ? <Typography.Text style={{ color: 'inherit' }}>{author}</Typography.Text> : null}
            <Typography.Text style={{ color: 'inherit' }}>{latestNote}</Typography.Text>
            {latestAt ? (
              <Typography.Text style={{ color: 'inherit' }}>
                {t('Last activity')} {formatRelativeTime(latestAt)} ({formatDateTime(latestAt)})
              </Typography.Text>
            ) : null}
          </Space>
        }
      >
        <Typography.Text
          style={
            {
              background: '#fff7e6',
              borderLeft: '3px solid #faad14',
              borderRadius: 4,
              color: '#ad6800',
              display: '-webkit-box',
              maxWidth: 240,
              overflow: 'hidden',
              padding: '2px 6px',
              whiteSpace: 'normal',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
            } as React.CSSProperties
          }
        >
          {previewNote}
        </Typography.Text>
      </Tooltip>
    );
  };
  const renderMoneyCell = (value: number) => (
    <Typography.Text strong style={{ color: MONEY_AT_RISK_COLOR, whiteSpace: 'nowrap' }}>
      {formatCurrency(value)}
    </Typography.Text>
  );
  const renderRelativeDateCell = (value: any) => {
    const label = relativeDateLabel(value, commandCalculationDate);
    if (!label.detail) return <Typography.Text>—</Typography.Text>;
    return (
      <Tooltip title={label.detail}>
        <Space direction="vertical" size={0}>
          <Tag color={label.color}>{t(label.label)}</Tag>
          <Typography.Text type="secondary">{label.detail}</Typography.Text>
        </Space>
      </Tooltip>
    );
  };
  const renderPipelineGapCell = (_value: any, row: PlainRecord) => {
    const gap = Number(row.stockoutGapDays);
    if (!Number.isFinite(gap)) return <Typography.Text>—</Typography.Text>;
    const late = gap > 0;
    return (
      <Tooltip
        title={
          late
            ? t('Expected sellable is after OOS. Stock may run out first.')
            : t('Expected sellable is on or before OOS. The order should land first.')
        }
      >
        <Space direction="vertical" size={0}>
          <Tag color={late ? 'red' : 'green'}>
            {late ? `${formatNumber(gap)} ${t('days late')}` : `${formatNumber(Math.abs(gap))} ${t('day buffer')}`}
          </Tag>
          {late ? <Typography.Text type="secondary">{t('Stock may run out first')}</Typography.Text> : null}
        </Space>
      </Tooltip>
    );
  };
  const renderHeldUpAtCell = (_value: any, row: PlainRecord) => {
    const status = formatStatusLabel(row.supplierOrderStatus ?? row.supplierOrderState ?? 'unknown');
    const latestAt = String(row.latestSupplierOrderActivityAt ?? '').trim();
    const authorityEvidence = asPlainRecord(row.supplierOrderAuthorityEvidence);
    const taskEvidence = asPlainRecord(authorityEvidence.clickupStatusEvidence);
    const taskAt = latestAt ? '' : String(taskEvidence.taskOccurredAt ?? '').trim();
    const activityAt = latestAt || taskAt;
    const activityAuthor = String(
      row.latestSupplierOrderActivityActorDisplayName ?? row.latestSupplierOrderActivityActor ?? '',
    ).trim();
    const hasActivityEvidence = Boolean(
      String(row.latestSupplierOrderActivityNote ?? '').trim() ||
        String(row.latestSupplierOrderActivityActor ?? '').trim() ||
        String(row.latestSupplierOrderActivitySource ?? '').trim() ||
        String(row.supplierOrderAuthorityTaskRef ?? '').trim(),
    );
    return (
      <Space direction="vertical" size={0} style={{ maxWidth: 260 }}>
        <Tooltip
          title={activityAt ? `${taskAt ? `${t('ClickUp task date')}: ` : ''}${formatDateTime(activityAt)}` : undefined}
        >
          <Typography.Text strong>
            {latestAt
              ? formatRelativeTime(latestAt)
              : taskAt
                ? `${formatRelativeTime(taskAt)} · ${t('ClickUp task date')}`
                : hasActivityEvidence
                  ? t('Activity date unavailable')
                  : t('No activity evidence')}
          </Typography.Text>
        </Tooltip>
        {activityAuthor ? <Typography.Text type="secondary">{activityAuthor}</Typography.Text> : null}
        {renderLatestOrderCommentPreview(row) ?? <Typography.Text type="secondary">{t(status)}</Typography.Text>}
      </Space>
    );
  };
  const renderActiveRiskCell = (_value: any, row: PlainRecord) => {
    const pipeline = String(row.pipelineHealthStatus ?? 'none');
    const followUpDue = row.recommendedEscalation === 'follow_up_order';
    const label =
      pipeline === 'late'
        ? 'off-track'
        : pipeline === 'placed_not_purchased'
          ? 'placed not purchased'
          : pipeline === 'unknown_timing'
            ? 'timing unknown'
            : followUpDue
              ? 'follow-up due today'
              : 'pipeline monitoring';
    const detail = formatStatusLabel(row.supplierOrderStatus ?? row.supplierOrderState ?? 'active order');
    const color =
      label === 'off-track' || label === 'follow-up due today'
        ? 'red'
        : label === 'placed not purchased' || label === 'timing unknown'
          ? 'orange'
          : 'blue';
    return (
      <Space direction="vertical" size={0}>
        <Tag color={color}>{t(formatStatusLabel(label))}</Tag>
        <Typography.Text type="secondary">
          {t(detail === formatStatusLabel(label) ? 'Pipeline monitoring' : detail)}
        </Typography.Text>
      </Space>
    );
  };
  const renderStuckRiskCell = (_value: any, row: PlainRecord) => {
    const doc = finiteNumber(row.daysOfCover);
    const threshold = typeof doc === 'number' ? (doc >= 60 ? '60+ DOC' : '30+ DOC') : 'DOC unavailable';
    return (
      <Space direction="vertical" size={0}>
        <Tag color={typeof doc === 'number' && doc >= 60 ? 'red' : 'orange'}>{t(threshold)}</Tag>
        <Typography.Text type="secondary">
          {t(formatStatusLabel(row.stuckClassification ?? 'stuck inventory'))}
        </Typography.Text>
      </Space>
    );
  };
  const renderSellThroughEvidenceCell = (_value: any, row: PlainRecord) => (
    <Space direction="vertical" size={0}>
      <Typography.Text>
        {formatNumber(row.salesVelocity)}
        {t('/day')}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t('6M average')} {formatNumber(row.sixMonthAverageQty)}
      </Typography.Text>
    </Space>
  );
  const familyMembers = (row: PlainRecord) => unwrapRows(row.familyMembers);
  const renderFamilyStockCell = (_value: any, row: PlainRecord) =>
    renderCurrentStockCell(undefined, {
      currentPlanningStock: row.familyCurrentPlanningStock,
      sellableStock: row.familySellableStock,
      reservedStock: row.familyReservedStock,
      inboundStock: row.familyInboundStock,
      prepStock: row.familyPrepStock,
      orderedStock: row.familyOrderedStock,
    });
  const renderFamilyIdentityCell = (_value: any, row: PlainRecord) => (
    <Space direction="vertical" size={0} style={{ maxWidth: 180 }}>
      <Typography.Text strong>{row.familyCanonicalAsin ?? row.asin ?? '—'}</Typography.Text>
      <Typography.Text type="secondary">{row.company ?? '—'}</Typography.Text>
      <Typography.Text type="secondary">
        {formatNumber(row.familyMemberCount)} {t('listings')} · {row.familyMarketplace ?? '—'}
      </Typography.Text>
    </Space>
  );
  const renderFamilyTargetCell = (_value: any, row: PlainRecord) => {
    const members = familyMembers(row);
    const familyId = String(row.companyProductFamilyId ?? '');
    return (
      <Space direction="vertical" size={4} onClick={(event) => event.stopPropagation()}>
        <Space size={4}>
          <Tag color="blue">{t('Target')}</Tag>
          <Typography.Text strong>{row.replenishmentTargetSku ?? row.sku ?? '—'}</Typography.Text>
        </Space>
        <Select
          size="small"
          aria-label={t('Change replenishment target')}
          value={row.replenishmentTargetCompanyProductId}
          loading={targetUpdatingFamilyId === familyId}
          disabled={!familyId || members.length < 2 || targetUpdatingFamilyId === familyId}
          onChange={(companyProductId) => void updateFamilyTarget(row, companyProductId)}
          style={{ minWidth: 170 }}
          options={members.map((member) => ({
            value: String(member.companyProductId),
            label: `${member.sku ?? member.asin ?? '—'}${member.familyRole === 'target' ? ` · ${t('Target')}` : ''}`,
          }))}
        />
      </Space>
    );
  };
  const renderFamilySupplierCell = (_value: any, row: PlainRecord) => (
    <Space direction="vertical" size={0} style={{ maxWidth: 180 }}>
      <Typography.Text strong>
        {row.familyPreferredSupplierName ?? row.supplierName ?? t('Supplier missing')}
      </Typography.Text>
      <Typography.Text type="secondary">
        {formatNumber(row.familyLeadTimeDays ?? row.leadTimeDays)} {t('days lead time')}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t('Unit cost')} {formatCurrency(row.familyUnitCost ?? row.unitCost)}
      </Typography.Text>
    </Space>
  );
  const renderFamilyVelocityCell = (_value: any, row: PlainRecord) => (
    <Space direction="vertical" size={0}>
      <Typography.Text strong>
        {formatNumber(row.familySalesVelocity)} {t('/day')}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t('Current')} {formatNumber(row.familyDaysOfCover)} {t('days')} · {t('OOS')}{' '}
        {formatDate(row.familyEstimatedOosDate)}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t('Position')} {formatNumber(row.familyPositionDaysOfCover)} {t('days')} · {t('OOS')}{' '}
        {formatDate(row.familyPositionEstimatedOosDate)}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t('Velocity basis')} {t(formatStatusLabel(row.salesVelocityBasis ?? 'unavailable'))} ·{' '}
        {t(formatStatusLabel(row.salesVelocityStatus ?? 'missing'))}
      </Typography.Text>
    </Space>
  );
  const renderFamilyPriorityCell = (_value: any, row: PlainRecord) => (
    <Space direction="vertical" size={0}>
      <Tag color={tierColor(row.familyTier ?? row.tier)}>{formatTier(row.familyTier ?? row.tier)}</Tag>
      <Typography.Text type="secondary">
        {t(formatStatusLabel(row.actionStatus ?? row.commandCenterPane))}
      </Typography.Text>
      {row.amazonReceiptStatus === 'review_required' ? <Tag color="red">{t('Receipt evidence review')}</Tag> : null}
    </Space>
  );
  const renderFamilyActionCell = (pane: CommandCenterPaneKey, row: PlainRecord) => {
    if (pane === 'stuckInventory') {
      return (
        <Space direction="vertical" size={0}>
          <Tag color="red">{t(formatStatusLabel(row.familyStuckClassification ?? row.stuckClassification))}</Tag>
          <Typography.Text>
            {formatNumber(row.familyStuckAffectedMemberCount)} {t('affected listings')} ·{' '}
            {formatNumber(row.familyStuckAffectedUnits)} {t('units')}
          </Typography.Text>
          <Typography.Text strong style={{ color: MONEY_AT_RISK_COLOR }}>
            {formatCurrency(row.familyStuckAffectedValue)}
          </Typography.Text>
          {finiteNumber(row.familyStuckActiveOrderCount) ? (
            <>
              <Typography.Text type="secondary">
                {formatNumber(row.familyStuckActiveOrderCount)} {t('active order(s)')}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('Current order reference')} {row.supplierOrderRef ?? '—'} ·{' '}
                {formatNumber(row.supplierOrderReferenceOpenQty ?? row.openOrderCoverageQty)} {t('units')}
              </Typography.Text>
            </>
          ) : null}
        </Space>
      );
    }
    if (pane === 'inboundMonitoring') {
      const sourceStatus = asPlainRecord(
        asPlainRecord(row.supplierOrderAuthorityEvidence).clickupStatusEvidence,
      ).clickupStatus;
      return (
        <Space direction="vertical" size={0}>
          <Tag color={row.amazonReceiptStatus === 'partially_observed' ? 'gold' : 'processing'}>
            {t(formatStatusLabel(row.amazonReceiptStatus ?? 'awaiting_amazon_stock'))}
          </Tag>
          <Typography.Text strong>{row.supplierOrderRef ?? '—'}</Typography.Text>
          <Typography.Text type="secondary">
            {t('Source')} {sourceStatus ?? 'inbound-monitoring'} · {t('Expected')} {formatDate(row.expectedArrivalDate)}
          </Typography.Text>
          <Typography.Text>
            {t('Open coverage')} {formatNumber(row.openOrderCoverageQty)} · {t('Observed')}{' '}
            {formatDate(row.amazonReceiptObservedAt)}
          </Typography.Text>
          {row.dataQualityStatus === 'blocked' ? <Tag color="red">{t('Evidence warning')}</Tag> : null}
        </Space>
      );
    }
    if (pane === 'healthyInventory') {
      return (
        <Space direction="vertical" size={0}>
          <Tag color="green">{t('Current coverage sufficient')}</Tag>
          <Typography.Text strong>
            {formatNumber(row.familyOnHandStock ?? row.onHandStock)} {t('units on hand')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('Current')} {formatNumber(row.familyDaysOfCover ?? row.daysOfCover)} {t('days')} · {t('Position')}{' '}
            {formatNumber(row.familyPositionDaysOfCover ?? row.positionDaysOfCover)} {t('days')}
          </Typography.Text>
        </Space>
      );
    }
    if (pane === 'dataReadiness') {
      const issues = Array.isArray(row.dataQualityIssues) ? row.dataQualityIssues : [];
      return (
        <Space direction="vertical" size={0}>
          <Tag color="gold">{t('Needs data readiness')}</Tag>
          <Typography.Text>
            {issues.length ? issues.map(formatStatusLabel).join(', ') : t('Family target review')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('History')} {t(formatStatusLabel(asPlainRecord(row.evidence).historyLoadStatus ?? 'not loaded'))}
          </Typography.Text>
        </Space>
      );
    }
    if (pane === 'activeOrders') {
      const cycle = asPlainRecord(row.supplierOrderCycleSelection);
      const excludedCycles = unwrapRows(cycle.excludedCycles);
      const receiptEvidence = asPlainRecord(asPlainRecord(row.amazonReceiptEvidenceJson).receiptEvidence);
      return (
        <Space direction="vertical" size={0}>
          {renderActiveRiskCell(undefined, row)}
          {row.supplierOrderCycleReviewRequired ? <Tag color="red">{t('Older order cycle review')}</Tag> : null}
          {row.amazonReceiptStatus === 'review_required' ? (
            <Tag color="red">{t('Amazon receipt evidence review')}</Tag>
          ) : null}
          <Typography.Text strong>
            {t('Current order reference')} {row.supplierOrderRef ?? cycle.selectedOrderRef ?? '—'}
          </Typography.Text>
          <Typography.Text type="secondary">
            {formatNumber(row.supplierOrderReferenceOpenQty ?? row.openOrderCoverageQty)} {t('current-cycle units')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('Expected arrival')} {formatDate(row.expectedArrivalDate)} ·{' '}
            {t(formatStatusLabel(row.expectedArrivalFreshness))}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t(formatExpectedArrivalSource(row.expectedArrivalSource))}
          </Typography.Text>
          {excludedCycles.length ? (
            <Typography.Text type="secondary">
              {excludedCycles.length} {t('older cycle(s) excluded from coverage')}
            </Typography.Text>
          ) : null}
          {receiptEvidence.reason ? (
            <Typography.Text type="secondary">
              {t('Receipt evidence')} {t(formatStatusLabel(receiptEvidence.reason))}
            </Typography.Text>
          ) : null}
          {renderPipelineGapCell(undefined, row)}
        </Space>
      );
    }
    return (
      <Space direction="vertical" size={0}>
        <Tag color={pane === 'missingSupplier' ? 'red' : actionColor(row.actionStatus)}>
          {t(pane === 'missingSupplier' ? 'Supplier missing' : formatStatusLabel(row.actionStatus))}
        </Tag>
        <Typography.Text strong>
          {formatNumber(row.familySuggestedReorderQty ?? row.suggestedReorderQty)} {t('units to order')}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t('Est. COGS')} {formatCurrency(row.familyEstimatedOrderCost ?? row.estimatedOrderCost)}
        </Typography.Text>
        <Typography.Text strong style={{ color: MONEY_AT_RISK_COLOR }}>
          {formatCurrency(row.estimatedProfitRisk)}
        </Typography.Text>
      </Space>
    );
  };
  const familyParentColumns = (pane: CommandCenterPaneKey) => [
    { title: String(t('Family / ASIN')), key: 'family', render: renderFamilyIdentityCell },
    { title: String(t('Target SKU')), key: 'target', render: renderFamilyTargetCell },
    { title: String(t('Supplier')), key: 'supplier', render: renderFamilySupplierCell },
    { title: String(t('Family stock')), key: 'stock', render: renderFamilyStockCell },
    { title: String(t('Velocity / DOC')), key: 'velocity', render: renderFamilyVelocityCell },
    { title: String(t('Tier / priority')), key: 'priority', render: renderFamilyPriorityCell },
    {
      title: String(t('Action summary')),
      key: 'action',
      render: (_value: any, row: PlainRecord) => renderFamilyActionCell(pane, row),
    },
  ];
  const familyMemberColumns = [
    {
      title: String(t('SKU')),
      key: 'sku',
      render: (_value: any, row: PlainRecord) => (
        <Space size={4}>
          {row.familyRole === 'target' ? <Tag color="blue">{t('Target')}</Tag> : null}
          <Typography.Text strong>{row.sku ?? '—'}</Typography.Text>
        </Space>
      ),
    },
    {
      title: String(t('Listing status')),
      dataIndex: 'productStatus',
      render: (value: string) => <Tag>{t(formatStatusLabel(value))}</Tag>,
    },
    { title: String(t('Listing stock')), key: 'stock', render: renderCurrentStockCell },
    {
      title: String(t('Listing velocity / DOC')),
      key: 'velocity',
      render: (_value: any, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>
            {formatNumber(row.salesVelocity)} {t('/day')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('Current')} {formatNumber(row.daysOfCover)} {t('days')} · {t('Position')}{' '}
            {formatNumber(row.positionDaysOfCover)} {t('days')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t(formatStatusLabel(row.salesVelocityBasis ?? 'unavailable'))} ·{' '}
            {t(formatStatusLabel(row.salesVelocityStatus ?? 'missing'))}
          </Typography.Text>
        </Space>
      ),
    },
    { title: String(t('Tier movement')), dataIndex: 'tier', render: renderCommandTierCell },
    {
      title: String(t('Current order reference')),
      key: 'order',
      render: (_value: any, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.supplierOrderRef ?? '—'}</Typography.Text>
          <Typography.Text type="secondary">
            {t(formatStatusLabel(row.supplierOrderStatus ?? row.supplierOrderState))}
          </Typography.Text>
        </Space>
      ),
    },
  ];
  const renderFamilyMembers = (row: PlainRecord) => (
    <Table<PlainRecord>
      size="small"
      rowKey={(member) => String(member.companyProductId ?? member.id ?? member.sku)}
      dataSource={familyMembers(row)}
      columns={familyMemberColumns}
      pagination={false}
      onRow={(member) => ({ onClick: () => openRow(member, undefined, activeCommandPane) })}
    />
  );
  const commandPaneColumns = (pane: CommandCenterPaneKey) => {
    if (pane !== 'duplicateProducts') return familyParentColumns(pane);
    if (pane === 'duplicateProducts') {
      return [
        {
          title: String(t('Status')),
          dataIndex: 'productStatus',
          render: (value: string) => <Tag color="purple">{t(formatStatusLabel(value ?? 'duplicate'))}</Tag>,
        },
        { title: String(t('Duplicate SKU')), key: 'product', render: renderCommandProductCell },
        {
          title: String(t('Primary row')),
          key: 'primary',
          render: (_value: any, row: PlainRecord) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{row.duplicatePrimarySku ?? '—'}</Typography.Text>
              <Typography.Text type="secondary">{t('Preferred because it has more stock/evidence')}</Typography.Text>
            </Space>
          ),
        },
        { title: String(t('Current stock')), key: 'currentStock', render: renderCurrentStockCell },
        {
          title: String(t('Order evidence')),
          key: 'orderEvidence',
          render: (_value: any, row: PlainRecord) => (
            <Space direction="vertical" size={0}>
              <Typography.Text>{row.supplierOrderRef ?? '—'}</Typography.Text>
              <Typography.Text type="secondary">{row.supplierName ?? t('Supplier missing')}</Typography.Text>
            </Space>
          ),
        },
      ];
    }
    if (pane === 'activeOrders') {
      return [
        { title: String(t('Risk')), key: 'risk', render: renderActiveRiskCell },
        { title: String(t('Product')), key: 'product', width: 180, render: renderCommandProductCell },
        { title: String(t('Tier')), dataIndex: 'tier', render: renderCommandTierCell },
        {
          title: String(t('Order')),
          key: 'order',
          render: (_value: any, row: PlainRecord) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{row.supplierOrderRef ?? '—'}</Typography.Text>
              <Typography.Text type="secondary">
                {formatNumber(row.supplierOrderReferenceOpenQty ?? row.openOrderCoverageQty)} {t('units')} ·{' '}
                {row.supplierName ?? t('Supplier missing')}
              </Typography.Text>
              <Tag color={freshnessColor(row.leadTimeFreshness)} style={{ marginInlineEnd: 0 }}>
                {leadTimeFreshnessText(row)}
              </Tag>
              <Typography.Text type="secondary">{formatCurrency(activeOrderCost(row))}</Typography.Text>
            </Space>
          ),
        },
        { title: coverageColumnTitle, key: 'coverage', render: renderCoverageCell },
        { title: String(t('Expected arrival')), dataIndex: 'expectedArrivalDate', render: renderRelativeDateCell },
        { title: String(t('Gap')), key: 'gap', render: renderPipelineGapCell },
        {
          title: String(t('Last Activity')),
          key: 'heldUpAt',
          width: 240,
          render: renderHeldUpAtCell,
        },
        { title: String(t('Money at risk')), dataIndex: 'estimatedProfitRisk', render: renderMoneyCell },
      ];
    }
    if (pane === 'stuckInventory') {
      return [
        { title: String(t('Risk')), key: 'risk', render: renderStuckRiskCell },
        { title: String(t('Product')), key: 'product', render: renderCommandProductCell },
        { title: String(t('Tier')), dataIndex: 'tier', render: renderCommandTierCell },
        { title: String(t('DOC')), key: 'doc', render: renderDocCell },
        { title: String(t('Sell-through evidence')), key: 'sellThrough', render: renderSellThroughEvidenceCell },
        {
          title: String(t('Stock')),
          key: 'stock',
          render: renderCurrentStockCell,
        },
        {
          title: String(t('Capital / risk')),
          dataIndex: 'estimatedProfitRisk',
          render: (_value: number, row: PlainRecord) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong style={{ color: MONEY_AT_RISK_COLOR }}>
                {formatCurrency(row.estimatedProfitRisk)}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('Total stock')} {formatNumber(row.currentPlanningStock)}
              </Typography.Text>
            </Space>
          ),
        },
      ];
    }
    return [
      {
        title: String(t('Risk')),
        dataIndex: 'actionStatus',
        render: (value: string) => (
          <Tag color={pane === 'missingSupplier' ? 'red' : actionColor(value)}>
            {t(pane === 'missingSupplier' ? 'Supplier missing' : formatStatusLabel(value ?? 'watch'))}
          </Tag>
        ),
      },
      { title: String(t('Product')), key: 'product', render: renderCommandProductCell },
      {
        title: String(t('Tier')),
        dataIndex: 'tier',
        render: renderCommandTierCell,
      },
      { title: String(t('Current stock')), key: 'currentStock', render: renderCurrentStockCell },
      { title: coverageColumnTitle, key: 'coverage', render: renderCoverageCell },
      { title: String(t('Order by')), key: 'orderBy', render: renderOrderByCell },
      {
        title: `${t('Suggested qty / COGS / margin')} (${formatNumber(commandTargetCoverDays)}d)`,
        key: 'suggestedQty',
        render: renderSuggestedQtyCell,
      },
      { title: String(t('Money at risk')), dataIndex: 'estimatedProfitRisk', render: renderMoneyCell },
    ];
  };
  const renderCommandPane = (pane: CommandCenterPaneKey) => {
    const paneData = unwrapData(commandPanes[pane]);
    const rowsForPane = unwrapRows(paneData.rows);
    return (
      <Collapse
        key={pane}
        activeKey={openCommandPane === pane ? [pane] : []}
        onChange={(keys) => {
          const opening = Array.isArray(keys) ? keys.includes(pane) : keys === pane;
          setOpenCommandPane(opening ? pane : null);
          if (opening) {
            setActiveCommandPane(pane);
            setCommandCenterSortBy(commandPaneSortOptions[pane][0].value);
          }
        }}
        items={[
          {
            key: pane,
            label: (
              <Space size="small" wrap>
                <span>{commandPaneTitles[pane]}</span>
                <FormulaHelp group={commandPaneHelpGroups[pane]} label="Column/status guide" />
              </Space>
            ),
            extra: (
              <Space size="small" wrap onClick={(event) => event.stopPropagation()}>
                <Typography.Text type="secondary">
                  {formatNumber(paneData.total)} {t('rows')}
                </Typography.Text>
                <Select
                  value={
                    activeCommandPane === pane
                      ? commandCenterSortBy
                      : String(paneData.sortBy ?? commandPaneSortOptions[pane][0].value)
                  }
                  onChange={(value) => {
                    setOpenCommandPane(pane);
                    setActiveCommandPane(pane);
                    setCommandCenterSortBy(value);
                  }}
                  style={{ width: 180 }}
                  options={commandPaneSortOptions[pane]}
                />
              </Space>
            ),
            children: (
              <>
                <Typography.Paragraph type="secondary">{commandPaneDescriptions[pane]}</Typography.Paragraph>
                <Table<PlainRecord>
                  size="small"
                  loading={loading}
                  rowKey={(row) => String(row.companyProductFamilyId ?? row.id ?? row.asin ?? row.sku)}
                  dataSource={rowsForPane}
                  columns={commandPaneColumns(pane)}
                  pagination={false}
                  expandable={{
                    expandedRowRender: renderFamilyMembers,
                    rowExpandable: (row) => familyMembers(row).length > 0,
                  }}
                  onRow={(row) => ({ onClick: () => openRow(row, undefined, pane) })}
                />
              </>
            ),
          },
        ]}
      />
    );
  };

  const newActionValues = (row: PlainRecord): DrawerActionValues => {
    const supplierId = isUuid(row.supplierId) ? row.supplierId : '';
    return {
      draftQty: defaultOrderQty(row),
      draftSupplierId: supplierId,
      draftExpectedSellableDate:
        formatDate(row.expectedArrivalDate) === '—' ? undefined : formatDate(row.expectedArrivalDate),
      draftNotes: 'Created from Ecobase inventory planning.',
      addSupplierOrderId: '',
      addQty: defaultOrderQty(row),
      addExpectedSellableDate:
        formatDate(row.expectedArrivalDate) === '—' ? undefined : formatDate(row.expectedArrivalDate),
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
        formatDate(line.expectedArrivalDate) === '—' ? undefined : formatDate(line.expectedArrivalDate),
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
    const workspace = unwrapData(
      await api.request({
        url: 'ecobaseInventoryPlanning:rowWorkspace',
        method: 'post',
        data: {
          company: row.company,
          planningProductId: row.planningProductId,
          companyProductId: row.companyProductId,
          asin: row.asin,
          sku: row.sku,
          supplierId: row.supplierId,
          limit: 500,
        },
      }),
    );
    setSupplierOptions(unwrapRows(workspace.suppliers));
    setOrderOptions(unwrapRows(workspace.supplierOrders));
    setOrderLineHistory(unwrapRows(workspace.orderLineHistory));
    setOrderActivities(unwrapRows(workspace.orderActivities));
    setProductTasks(unwrapRows(workspace.productTasks));
    setProductTargets(unwrapRows(workspace.productTargets));
    setOrderEditValues(workspace.initialOrderEdit ? (workspace.initialOrderEdit as OrderEditValues) : null);
    const actionDefaults = unwrapData(workspace.actionDefaults);
    setActionValues((current) =>
      current
        ? {
            ...current,
            draftSupplierId: current.draftSupplierId || String(actionDefaults.draftSupplierId ?? ''),
            leadSupplierId: current.leadSupplierId || String(actionDefaults.leadSupplierId ?? ''),
            addSupplierOrderId: actionDefaults.addSupplierOrderId
              ? String(actionDefaults.addSupplierOrderId)
              : current.addSupplierOrderId,
          }
        : current,
    );
  };

  const drawerPanelKeysByPane: Record<CommandCenterPaneKey, string[]> = {
    supplyAction: ['history', 'draft', 'add', 'lead-time'],
    missingSupplier: ['history', 'lead-time'],
    activeOrders: ['history', 'order-status', 'edit-line'],
    inboundMonitoring: ['history', 'order-status', 'edit-line'],
    healthyInventory: ['history'],
    stuckInventory: ['product-tasks-targets', 'history'],
    dataReadiness: ['history'],
    duplicateProducts: ['history'],
  };

  const openRow = (row: PlainRecord, initialPanels?: string[], pane?: CommandCenterPaneKey) => {
    setSelectedCommandPane(pane ?? null);
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
    setOrderCommentText('');
    setActivityCommentEdit(null);
    setManagePanels(initialPanels ?? (pane ? drawerPanelKeysByPane[pane] : []));
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

  const saveReceiptOverride = async (clear = false) => {
    if (!selectedRow || !lineEditValues) return;
    if (!receiptOverrideReason.trim()) {
      message.error(t('Receipt override reason is required.'));
      return;
    }
    await api.request({
      url: 'ecobaseInventoryPlanning:setReceiptOverride',
      method: 'post',
      data: {
        lineId: lineEditValues.id,
        status: clear ? undefined : receiptOverrideStatus,
        reason: receiptOverrideReason.trim(),
        clear,
      },
    });
    message.success(t(clear ? 'Receipt override cleared' : 'Receipt override saved'));
    setReceiptOverrideReason('');
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

  const saveOrderComment = async () => {
    if (!selectedRow) return;
    const notes = orderCommentText.trim();
    if (!notes) {
      message.error(t('Enter a comment before saving.'));
      return;
    }
    const supplierOrderId = orderEditValues?.supplierOrderId || String(selectedRow.supplierOrderId ?? '');
    const supplierId = orderEditValues?.supplierId || String(selectedRow.supplierId ?? '');
    if (!isUuid(supplierOrderId)) {
      message.error(t('Select a supplier order before saving a comment.'));
      return;
    }
    if (!isUuid(supplierId)) {
      message.error(t('Select an order with a known supplier before saving a comment.'));
      return;
    }
    await api.request({
      url: 'ecobaseSupplierOrders:recordActivity',
      method: 'post',
      data: {
        company: selectedRow.company,
        supplierId,
        supplierOrderId,
        activityType: 'note',
        notes,
      },
    });
    message.success(t('Order comment saved'));
    setOrderCommentText('');
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const updateActivityComment = async () => {
    if (!selectedRow || !activityCommentEdit) return;
    const notes = activityCommentEdit.notes.trim();
    if (!notes) {
      message.error(t('Enter a comment before saving.'));
      return;
    }
    await api.request({
      url: 'ecobaseSupplierOrders:updateActivityComment',
      method: 'post',
      data: { company: selectedRow.company, activityId: activityCommentEdit.id, notes },
    });
    message.success(t('Order comment updated'));
    setActivityCommentEdit(null);
    await Promise.all([loadPlanning(), loadDrawerEntities(selectedRow)]);
  };

  const deleteActivityComment = async (activity: PlainRecord) => {
    if (!selectedRow) return;
    const activityId = String(activity.id ?? '');
    if (!activityId) return;
    await api.request({
      url: 'ecobaseSupplierOrders:deleteActivityComment',
      method: 'post',
      data: { company: selectedRow.company, activityId },
    });
    message.success(t('Order comment deleted'));
    if (activityCommentEdit?.id === activityId) setActivityCommentEdit(null);
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

  const renderDrawerModeSummary = () => {
    if (!selectedRow || !selectedCommandPane) return null;
    if (selectedCommandPane === 'missingSupplier') {
      return (
        <Card size="small" title={t('Supplier link required')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>
              {t('This product has stockout risk and positive velocity, but no verified supplier link.')}
            </Typography.Text>
            <Button type="primary" onClick={() => setManagePanels(['lead-time'])}>
              {t('Fix supplier / lead time')}
            </Button>
          </Space>
        </Card>
      );
    }
    if (selectedCommandPane === 'inboundMonitoring') {
      return (
        <Card size="small" title={t('Amazon receipt monitoring')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space size={4} wrap>
              <Tag color={selectedRow.amazonReceiptStatus === 'partially_observed' ? 'gold' : 'processing'}>
                {t(formatStatusLabel(selectedRow.amazonReceiptStatus ?? 'awaiting_amazon_stock'))}
              </Tag>
              <Typography.Text>
                {t('Current order reference')} {selectedRow.supplierOrderRef ?? '—'} · {t('Open coverage')}{' '}
                {formatNumber(selectedRow.openOrderCoverageQty)} · {t('Observed')}{' '}
                {formatDate(selectedRow.amazonReceiptObservedAt)}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('Expected arrival')} {formatDate(selectedRow.expectedArrivalDate)} ·{' '}
                {t(formatExpectedArrivalSource(selectedRow.expectedArrivalSource))} ·{' '}
                {t(formatStatusLabel(selectedRow.expectedArrivalFreshness))}
              </Typography.Text>
            </Space>
            <Space size="small" wrap>
              <Button type="primary" onClick={() => setManagePanels(['order-status'])}>
                {t('Update status / comment')}
              </Button>
              <Button onClick={() => setManagePanels(['history'])}>{t('Review receipt evidence')}</Button>
            </Space>
          </Space>
        </Card>
      );
    }
    if (selectedCommandPane === 'healthyInventory') {
      return (
        <Card size="small" title={t('Healthy current coverage')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Tag color="green">{t('Current coverage sufficient')}</Tag>
            <Typography.Text>
              {formatNumber(selectedRow.familyOnHandStock ?? selectedRow.onHandStock)} {t('units on hand')} ·{' '}
              {t('Current')} {formatNumber(selectedRow.familyDaysOfCover ?? selectedRow.daysOfCover)} {t('days')} ·{' '}
              {t('Position')} {formatNumber(selectedRow.familyPositionDaysOfCover ?? selectedRow.positionDaysOfCover)}{' '}
              {t('days')}
            </Typography.Text>
            <Button onClick={() => setManagePanels(['history'])}>{t('Review inventory evidence')}</Button>
          </Space>
        </Card>
      );
    }
    if (selectedCommandPane === 'dataReadiness') {
      return (
        <Card size="small" title={t('Operational data readiness')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Tag color="gold">{t('Needs data readiness')}</Tag>
            <Typography.Text>
              {(Array.isArray(selectedRow.dataQualityIssues) ? selectedRow.dataQualityIssues : [])
                .map(formatStatusLabel)
                .join(', ') || t('Family target review required')}
            </Typography.Text>
            <Button onClick={() => setManagePanels(['history'])}>{t('Review available evidence')}</Button>
          </Space>
        </Card>
      );
    }
    if (selectedCommandPane === 'activeOrders') {
      const expectedArrivalLabel = relativeDateLabel(selectedRow.expectedArrivalDate, commandCalculationDate);
      const cycle = asPlainRecord(selectedRow.supplierOrderCycleSelection);
      const excludedCycles = unwrapRows(cycle.excludedCycles);
      const receiptEvidence = asPlainRecord(asPlainRecord(selectedRow.amazonReceiptEvidenceJson).receiptEvidence);
      return (
        <Card size="small" title={t('Current order-cycle follow-up')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space size={4} wrap>
              <Tag color={supplierOrderStatusColor(selectedRow.supplierOrderStatus)}>
                {t(selectedRow.supplierOrderStatus ?? selectedRow.supplierOrderState ?? 'unknown')}
              </Tag>
              <Tag color={selectedRow.pipelineHealthStatus === 'late' ? 'red' : 'blue'}>
                {t(formatPipelineHealthLabel(selectedRow.pipelineHealthStatus ?? 'none'))}
              </Tag>
              {selectedRow.supplierOrderCycleReviewRequired ? (
                <Tag color="red">{t('Older order cycle review')}</Tag>
              ) : null}
              {selectedRow.amazonReceiptStatus === 'review_required' ? (
                <Tag color="red">{t('Amazon receipt evidence review')}</Tag>
              ) : null}
              <Typography.Text strong>
                {t('Current order reference')} {selectedRow.supplierOrderRef ?? cycle.selectedOrderRef ?? '—'}
              </Typography.Text>
              <Typography.Text>
                {formatNumber(selectedRow.supplierOrderReferenceOpenQty ?? selectedRow.openOrderCoverageQty)}{' '}
                {t('current-cycle units')} · {t('Expected arrival')} {t(expectedArrivalLabel.label)} (
                {formatDate(selectedRow.expectedArrivalDate)}) · {t('Gap')} {formatNumber(selectedRow.stockoutGapDays)}{' '}
                {t('days')}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('Arrival evidence')} {t(formatExpectedArrivalSource(selectedRow.expectedArrivalSource))} ·{' '}
                {t(formatStatusLabel(selectedRow.expectedArrivalFreshness))}
              </Typography.Text>
              {excludedCycles.length ? (
                <Typography.Text type="secondary">
                  {excludedCycles.length} {t('older cycle(s) excluded from current coverage')}
                </Typography.Text>
              ) : null}
              {receiptEvidence.reason ? (
                <Typography.Text type="secondary">
                  {t('Receipt evidence')} {t(formatStatusLabel(receiptEvidence.reason))}
                </Typography.Text>
              ) : null}
            </Space>
            <Space size="small" wrap>
              <Button type="primary" onClick={() => setManagePanels(['order-status'])}>
                {t('Update status / comment')}
              </Button>
              <Button onClick={() => setManagePanels(['history'])}>{t('Review order lines')}</Button>
              <Button onClick={() => setManagePanels(['edit-line'])}>{t('Edit active line')}</Button>
            </Space>
          </Space>
        </Card>
      );
    }
    if (selectedCommandPane === 'stuckInventory') {
      return (
        <Card size="small" title={t('Stuck inventory review')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space direction="vertical" size={4}>
              <Space size={4} wrap>
                <Tag color="purple">{t(selectedRow.stuckClassification ?? 'stuck')}</Tag>
                <Typography.Text>
                  {formatNumber(selectedRow.daysOfCover)} {t('days cover')} · {t('Capital/risk')}{' '}
                  <Typography.Text strong style={{ color: MONEY_AT_RISK_COLOR }}>
                    {formatCurrency(selectedRow.estimatedProfitRisk)}
                  </Typography.Text>
                </Typography.Text>
              </Space>
              <StockStatus row={selectedRow} t={t} />
            </Space>
            <Space size="small" wrap>
              <Button type="primary" onClick={() => setManagePanels(['product-tasks-targets'])}>
                {t('Create review task')}
              </Button>
              <Button onClick={() => setManagePanels(['history'])}>{t('Review sell-through/order history')}</Button>
            </Space>
          </Space>
        </Card>
      );
    }
    return (
      <Card size="small" title={t('Supply action plan')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space size={4} wrap>
            <Tag color={actionColor(selectedRow.actionStatus)}>{t(selectedRow.actionStatus ?? 'action needed')}</Tag>
            <Typography.Text>
              {t('Recommended qty')} {formatNumber(selectedRow.suggestedReorderQty)} · {t('Target cover')}{' '}
              {formatNumber(selectedRow.targetCoverDays)} {t('days')} · {t('Velocity')}{' '}
              {formatNumber(selectedRow.salesVelocity)}
            </Typography.Text>
          </Space>
          <Space size="small" wrap>
            <Button type="primary" onClick={() => setManagePanels(['draft'])}>
              {t('Create PO draft')}
            </Button>
            <Button onClick={() => setManagePanels(['add'])}>{t('Add to existing PO')}</Button>
            <Button onClick={() => setManagePanels(['lead-time'])}>{t('Fix supplier / lead time')}</Button>
          </Space>
        </Space>
      </Card>
    );
  };

  const columns = [
    {
      title: String(t('Review')),
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
      title: columnHelp(t('Tier'), t(tierScoreText())),
      dataIndex: 'tier',
      width: 170,
      render: (value: string, row: PlainRecord) => (
        <Space size={4} wrap>
          <Tag color={tierColor(value)}>{formatTier(value)}</Tag>
          <TierMovementTag row={row} t={t} />
          <MarginAlertTag row={row} t={t} />
        </Space>
      ),
    },
    {
      title: columnHelp(t('6M qty'), t('Last, average, worst, and best month units from the six complete months.')),
      key: 'historicalQuantities',
      width: 230,
      render: (_value: any, row: PlainRecord) => <HistoricalQuantityTags row={row} t={t} />,
    },
    {
      title: columnHelp(t('6M margin'), t('Total six-month net profit ÷ sales. Values below 8% are flagged.')),
      dataIndex: 'sixMonthMargin',
      width: 120,
      render: (value: number) => {
        const margin = finiteNumber(value);
        return typeof margin === 'number' && margin < 8 ? (
          <Tag color="red">{formatPercent(margin)}</Tag>
        ) : (
          formatPercent(value)
        );
      },
    },
    { title: String(t('Company')), dataIndex: 'company', width: 170, render: (value: string) => value || '—' },
    { title: String(t('ASIN')), dataIndex: 'asin', width: 130 },
    { title: String(t('SKU')), dataIndex: 'sku', width: 150 },
    { title: String(t('Status')), dataIndex: 'productStatus', width: 130 },
    {
      title: String(t('Current stock status')),
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
    { title: String(t('Days cover')), dataIndex: 'daysOfCover', width: 115, render: formatNumber },
    {
      title: String(t('Order by')),
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
      title: String(t('OOS date')),
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
      title: columnHelp(
        t('Suggest qty'),
        t('Formula: velocity × target cover days − stock − reliable open-order coverage.'),
      ),
      dataIndex: 'suggestedReorderQty',
      width: 125,
      render: formatNumber,
    },
    { title: String(t('Sellable')), dataIndex: 'sellableStock', width: 105, render: formatNumber },
    { title: String(t('Reserved')), dataIndex: 'reservedStock', width: 105, render: formatNumber },
    {
      title: columnHelp(
        t('Replenishment'),
        t('Inbound + ordered + prep + AWD stock. Reserved is shown separately because it is not new replenishment.'),
      ),
      dataIndex: 'pipelineStock',
      width: 145,
      render: formatNumber,
    },
    { title: String(t('Inbound')), dataIndex: 'inboundStock', width: 105, render: formatNumber },
    { title: String(t('Ordered')), dataIndex: 'orderedStock', width: 105, render: formatNumber },
    { title: String(t('Prep')), dataIndex: 'prepStock', width: 95, render: formatNumber },
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
      title: columnHelp(t('Stuck'), t('Days cover over 60 is stuck inventory and needs operator review.')),
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
        <Typography.Title level={3}>{t('Inventory Risk Command Center')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('First-eye view for stockout risk, active replenishment gaps, follow-ups due today, and stuck capital.')}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} /> : null}
        {planningSettingsWarning ? <Alert type="warning" message={planningSettingsWarning} showIcon /> : null}
        {commandHistoryReadiness.status && commandHistoryReadiness.status !== 'loaded' ? (
          <Alert
            type="warning"
            showIcon
            message={t('Current-only planning is active')}
            description={`${formatNumber(commandHistoryReadiness.affectedRowCount)} ${t(
              'rows are operationally visible; tier, profit, and history fields are not loaded.',
            )}`}
          />
        ) : null}
        <Card>
          <Row gutter={[16, 16]} align="bottom">
            <Col xs={24} md={8} xl={5}>
              <Typography.Text strong>{t('Company')}</Typography.Text>
              <Select
                allowClear
                showSearch
                placeholder={t('All companies')}
                value={company || undefined}
                onChange={(value) => setCompany(value ?? '')}
                style={{ width: '100%', marginTop: 4 }}
                options={(Array.isArray(filterOptions.companies) ? filterOptions.companies : []).map(
                  (value: string) => ({ value, label: value }),
                )}
              />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Typography.Text strong>{t('History window')}</Typography.Text>
              <Select
                disabled
                value="six-months"
                style={{ width: '100%', marginTop: 4 }}
                options={[{ value: 'six-months', label: t('Last 6 months') }]}
              />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Typography.Text strong>{t('Target cover')}</Typography.Text>
              <InputNumber
                addonAfter={t('days')}
                min={30}
                value={targetCoverDays}
                onChange={(value) => setTargetCoverDays(Number(value ?? 45))}
                style={{ width: '100%', marginTop: 4 }}
              />
            </Col>

            <Col xs={24} xl={24}>
              <Space size="middle" wrap>
                <Typography.Text type="secondary">
                  {t('Data as of')} {formatDate(commandMetadata.latestDataAsOf)} · {t('Last 6 months sales history')}
                </Typography.Text>
                <Button href="/admin/ecobase/planning-settings">
                  {t('Rules & thresholds')} · {t('Target cover')} {formatNumber(commandMetadata.targetCoverDays)}{' '}
                  {t('days')}
                </Button>
                <Button
                  type="primary"
                  loading={loading && !rebuildingGold}
                  disabled={rebuildingGold}
                  onClick={loadPlanning}
                >
                  {t('Refresh planning')}
                </Button>
                <Button loading={rebuildingGold} disabled={loading && !rebuildingGold} onClick={syncEditableRows}>
                  {t('Rebuild gold inventory')}
                </Button>
              </Space>
            </Col>
          </Row>
        </Card>

        <Space size="small" wrap>
          <Typography.Text strong>{t('Quick navigation')}</Typography.Text>
          {['A', 'B'].map((category) => (
            <Button
              key={category}
              type={tier === category ? 'primary' : 'default'}
              onClick={() => setTier((current) => (current === category ? undefined : category))}
            >
              {t(`Category ${category}`)}
            </Button>
          ))}
          {(['healthyInventory', 'stuckInventory', 'dataReadiness'] as CommandCenterPaneKey[]).map((pane) => (
            <Button
              key={pane}
              onClick={() => {
                setOpenCommandPane(pane);
                setActiveCommandPane(pane);
                setCommandCenterSortBy(commandPaneSortOptions[pane][0].value);
              }}
            >
              {commandPaneTitles[pane]}
            </Button>
          ))}
        </Space>

        <Row gutter={[16, 16]}>
          {commandSummaryCards.map((card: PlainRecord) => {
            const isCurrency = String(card.format) === 'currency';
            const unknownCount = finiteNumber(card.unknownCount) ?? 0;
            const totalRowCount = finiteNumber(commandHistoryReadiness.totalRowCount) ?? 0;
            const allUnknown = unknownCount > 0 && unknownCount === totalRowCount;
            return (
              <Col xs={24} sm={12} lg={4} key={String(card.key)}>
                <Card>
                  <Statistic
                    title={t(String(card.label ?? card.key))}
                    value={allUnknown ? '—' : Number(card.value ?? 0)}
                    precision={allUnknown ? undefined : isCurrency ? 2 : 0}
                    prefix={isCurrency && !allUnknown ? '$' : undefined}
                    valueStyle={isCurrency ? { color: '#cf1322' } : undefined}
                  />
                  {card.description ? (
                    <Typography.Text type="secondary">{t(String(card.description))}</Typography.Text>
                  ) : null}
                  {unknownCount > 0 ? (
                    <Typography.Text type="warning" style={{ display: 'block' }}>
                      {formatNumber(unknownCount)} {t('rows unknown')}
                    </Typography.Text>
                  ) : null}
                </Card>
              </Col>
            );
          })}
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              title={t('Macro risk assessment')}
              extra={<Typography.Text type="secondary">{t('Shows where the team should look first.')}</Typography.Text>}
            >
              <Row gutter={[12, 12]}>
                {commandMacroRisk.map((item: PlainRecord) => (
                  <Col xs={24} md={12} key={String(item.key)}>
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{t(String(item.label ?? item.key))}</Typography.Text>
                      <Typography.Text>
                        {finiteNumber(item.unknownCount) && finiteNumber(item.value) === 0
                          ? '—'
                          : String(item.format) === 'currency'
                            ? formatCurrency(item.value)
                            : `${formatNumber(item.value)}${item.suffix ? ` ${t(String(item.suffix))}` : ''}`}
                      </Typography.Text>
                      {finiteNumber(item.unknownCount) ? (
                        <Typography.Text type="warning">
                          {formatNumber(item.unknownCount)} {t('rows unknown')}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  </Col>
                ))}
              </Row>
            </Card>
          </Col>
          <Col xs={24} lg={4}>
            <Card title={t('Supply action risk')}>{renderRiskBars(unwrapRows(commandRiskBars.supplyAction))}</Card>
          </Col>
          <Col xs={24} lg={4}>
            <Card title={t('Active order health')}>{renderRiskBars(unwrapRows(commandRiskBars.pipelineHealth))}</Card>
          </Col>
          <Col xs={24} lg={4}>
            <Card title={t('Stuck inventory risk')}>{renderRiskBars(unwrapRows(commandRiskBars.stuckInventory))}</Card>
          </Col>
        </Row>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {(
            [
              'supplyAction',
              'missingSupplier',
              'activeOrders',
              'inboundMonitoring',
              'healthyInventory',
              'stuckInventory',
              'dataReadiness',
            ] as CommandCenterPaneKey[]
          ).map(renderCommandPane)}
        </Space>
      </Space>
      <Drawer
        open={!!selectedRow}
        title={
          selectedRow
            ? `${selectedCommandPane ? `${commandPaneTitles[selectedCommandPane]} · ` : ''}${
                selectedRow.asin ?? selectedRow.sku ?? t('Inventory row')
              } · ${selectedRow.company ?? t('No company')}`
            : t('Inventory row')
        }
        width={920}
        onClose={() => {
          setSelectedCommandPane(null);
          setSelectedRow(null);
          setActionValues(null);
          setOrderLineHistory([]);
          setOrderActivities([]);
          setProductTasks([]);
          setProductTargets([]);
          setLineEditValues(null);
          setOrderEditValues(null);
          setActivityCommentEdit(null);
        }}
        extra={
          selectedRow ? (
            <Space size="small">
              <FormulaHelp group="inventoryDrawer" />
              <Button
                onClick={() => {
                  setSelectedCommandPane(null);
                  setSelectedRow(null);
                  setActionValues(null);
                  setOrderLineHistory([]);
                  setOrderActivities([]);
                  setProductTasks([]);
                  setProductTargets([]);
                  setLineEditValues(null);
                  setOrderEditValues(null);
                  setActivityCommentEdit(null);
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
            {renderDrawerModeSummary()}
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label={t('Action')}>
                <Tag color={actionColor(selectedRow.actionStatus)}>{t(selectedRow.actionStatus ?? 'unknown')}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Product status'), t(productStatusText()))}>
                <Tag>{selectedRow.productStatus ?? '—'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Tier'), t(tierScoreText()))}>
                <Space direction="vertical" size={4}>
                  <Space size={4} wrap>
                    <Tag color={tierColor(selectedRow.tier)}>{formatTier(selectedRow.tier)}</Tag>
                    <span>
                      {t('Score')} {formatTierScore(selectedRow.tierScore)}
                    </span>
                    <TierMovementTag row={selectedRow} t={t} />
                    <MarginAlertTag row={selectedRow} t={t} />
                  </Space>
                  <Typography.Text type="secondary">
                    {t('30d units')} {formatNumber(selectedRow.recentUnits30)} ·{' '}
                    {t(formatStatusLabel(selectedRow.tierEligibilityReason))}
                  </Typography.Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('Six-month history')}>
                <Space direction="vertical" size={4}>
                  <HistoricalQuantityTags row={selectedRow} t={t} />
                  <Tag color={(finiteNumber(selectedRow.sixMonthMargin) ?? 99) < 8 ? 'red' : 'blue'}>
                    {t('6M margin')} {formatPercent(selectedRow.sixMonthMargin)}
                  </Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Profit inputs'), t(profitInputText()))}>
                <Space size={4} wrap>
                  <Tag color="green">
                    {t('Profit/unit')} {formatCurrency(selectedRow.profitPerUnit)}
                  </Tag>
                  <Tag color="purple">
                    {t('30d units')} {formatNumber(selectedRow.recentUnits30)}
                  </Tag>
                  <Tag color="orange">
                    {t('Current score')} {formatTierScore(selectedRow.tierScore)}
                  </Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('Company')}>{selectedRow.company ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('ASIN / SKU')}>
                {selectedRow.asin ?? '—'} / {selectedRow.sku ?? '—'}
              </Descriptions.Item>
              {selectedRow.supplierSource === 'duplicate_sku_order_history' ? (
                <Descriptions.Item label={t('SKU reconciliation')}>
                  <SkuFamilyReconciliation row={selectedRow} t={t} />
                </Descriptions.Item>
              ) : null}
              <Descriptions.Item label={t('Inventory source')}>
                {formatStatusLabel(selectedRow.sourceFreshnessStatus ?? 'unknown')} ·{' '}
                {formatDate(selectedRow.inventoryAsOfDate)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Supplier')}>
                {selectedRow.supplierName ?? '—'} · {formatStatusLabel(selectedRow.supplierAvailability ?? 'unknown')} ·{' '}
                {selectedRow.supplierSource ?? '—'}
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
                  t('Formula: velocity × target cover days − stock − reliable open-order coverage.'),
                )}
              >
                {formatNumber(selectedRow.suggestedReorderQty)}
              </Descriptions.Item>
              <Descriptions.Item label={columnHelp(t('Money at risk'), t(monetaryRiskText(selectedRow)))}>
                <Typography.Text
                  strong
                  style={{ background: '#fff1f0', color: MONEY_AT_RISK_COLOR, padding: '2px 8px', borderRadius: 4 }}
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
              <Descriptions.Item label={columnHelp(t('Current order-cycle coverage'), t(orderCoverageText()))}>
                {formatNumber(selectedRow.openOrderCoverageQty)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Current order reference')}>
                {selectedRow.supplierOrderRef ?? '—'} ·{' '}
                {formatNumber(selectedRow.supplierOrderReferenceOpenQty ?? selectedRow.openOrderCoverageQty)}{' '}
                {t('units')}
              </Descriptions.Item>
              <Descriptions.Item label={t('Expected-arrival evidence')}>
                {formatDate(selectedRow.expectedArrivalDate)} ·{' '}
                {t(formatExpectedArrivalSource(selectedRow.expectedArrivalSource))} ·{' '}
                {t(formatStatusLabel(selectedRow.expectedArrivalFreshness))}
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
                                title: String(t('Status')),
                                key: 'status',
                                render: (_value: any, line: PlainRecord) => {
                                  const cycleSelection = asPlainRecord(selectedRow.supplierOrderCycleSelection);
                                  const selectedLineIds = Array.isArray(cycleSelection.selectedLineIds)
                                    ? cycleSelection.selectedLineIds.map(String)
                                    : [];
                                  const currentCycle = selectedLineIds.includes(String(line.id));
                                  return (
                                    <Space direction="vertical" size={0}>
                                      <Tag color={supplierOrderStatusColor(line.order?.status)}>
                                        {t(line.order?.status ?? 'unknown')}
                                      </Tag>
                                      <Tag color={currentCycle ? 'blue' : 'default'}>
                                        {t(currentCycle ? 'Current cycle' : 'Older cycle — excluded from coverage')}
                                      </Tag>
                                    </Space>
                                  );
                                },
                              },
                              {
                                title: String(t('Order reference')),
                                key: 'order',
                                render: (_value: any, line: PlainRecord) =>
                                  line.order?.externalOrderRef ?? line.supplierOrderId ?? '—',
                              },
                              {
                                title: String(t('Line product')),
                                key: 'lineProduct',
                                render: (_value: any, line: PlainRecord) => (
                                  <Space direction="vertical" size={0}>
                                    <Typography.Text>{line.asin ?? '—'}</Typography.Text>
                                    <Typography.Text type="secondary">{line.sku ?? '—'}</Typography.Text>
                                  </Space>
                                ),
                              },
                              { title: String(t('Ordered')), dataIndex: 'orderedQty', render: formatNumber },
                              { title: String(t('Received')), dataIndex: 'receivedQty', render: formatNumber },
                              {
                                title: String(t('Expected delivery')),
                                dataIndex: 'expectedDeliveryDate',
                                render: formatDate,
                              },
                              {
                                title: String(t('Expected sellable')),
                                dataIndex: 'expectedArrivalDate',
                                render: formatDate,
                              },
                              { title: String(t('Observed')), dataIndex: 'observedAt', render: formatDate },
                              {
                                title: String(t('Source')),
                                dataIndex: 'sourceStage',
                                render: (value: string) => value || '—',
                              },
                              {
                                title: String(t('Actions')),
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
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            <Typography.Text strong>{t('Recent order comments')}</Typography.Text>
                            {sortedOrderActivities.length > 0 ? (
                              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                {sortedOrderActivities.slice(0, 8).map((activity, index) => {
                                  const activityId = String(activity.id ?? activity.naturalKey ?? index);
                                  const author = String(
                                    activity.actorDisplayName ?? activity.actor ?? t('Unknown user'),
                                  );
                                  const deleted = Boolean(activity.deletedAt);
                                  const editable = canChangeActivityComment(activity);
                                  const editing = activityCommentEdit?.id === activityId;
                                  return (
                                    <div
                                      key={activityId}
                                      style={{
                                        background: deleted ? '#fafafa' : undefined,
                                        borderBottom: '1px solid #f0f0f0',
                                        paddingBottom: 8,
                                      }}
                                    >
                                      <Space size={8} wrap>
                                        <Typography.Text strong type={deleted ? 'secondary' : undefined}>
                                          {deleted ? t('Comment deleted') : author}
                                        </Typography.Text>
                                        <Tooltip
                                          title={formatDateTime(deleted ? activity.deletedAt : activity.occurredAt)}
                                        >
                                          <Typography.Text type="secondary">
                                            {formatRelativeTime(deleted ? activity.deletedAt : activity.occurredAt)}
                                          </Typography.Text>
                                        </Tooltip>
                                        {!deleted && activity.editedAt ? (
                                          <Tooltip title={formatDateTime(activity.editedAt)}>
                                            <Typography.Text type="secondary">{t('edited')}</Typography.Text>
                                          </Tooltip>
                                        ) : null}
                                        {editable && !editing ? (
                                          <>
                                            <Button
                                              size="small"
                                              type="link"
                                              onClick={() =>
                                                setActivityCommentEdit({
                                                  id: activityId,
                                                  notes: String(activity.notes ?? ''),
                                                })
                                              }
                                            >
                                              {t('Edit')}
                                            </Button>
                                            <Popconfirm
                                              title={t('Delete this comment?')}
                                              okText={t('Delete')}
                                              cancelText={t('Cancel')}
                                              onConfirm={() => void deleteActivityComment(activity)}
                                            >
                                              <Button size="small" type="link" danger>
                                                {t('Delete')}
                                              </Button>
                                            </Popconfirm>
                                          </>
                                        ) : null}
                                      </Space>
                                      {deleted ? (
                                        <Typography.Text type="secondary" italic>
                                          {t('This comment was deleted and kept for audit history.')}
                                        </Typography.Text>
                                      ) : editing ? (
                                        <Space direction="vertical" size={8} style={{ marginTop: 4, width: '100%' }}>
                                          <Input.TextArea
                                            autoSize={{ minRows: 2, maxRows: 5 }}
                                            value={activityCommentEdit.notes}
                                            onChange={(event) =>
                                              setActivityCommentEdit({ id: activityId, notes: event.target.value })
                                            }
                                          />
                                          <Space size={8}>
                                            <Button
                                              size="small"
                                              type="primary"
                                              onClick={() => void updateActivityComment()}
                                            >
                                              {t('Save')}
                                            </Button>
                                            <Button size="small" onClick={() => setActivityCommentEdit(null)}>
                                              {t('Cancel')}
                                            </Button>
                                          </Space>
                                        </Space>
                                      ) : (
                                        <Typography.Paragraph
                                          style={{ marginBottom: 0, marginTop: 4, whiteSpace: 'pre-wrap' }}
                                        >
                                          {String(activity.notes ?? '—')}
                                        </Typography.Paragraph>
                                      )}
                                    </div>
                                  );
                                })}
                              </Space>
                            ) : (
                              <Typography.Text type="secondary">
                                {t('No comments recorded yet. ClickUp imports and operator notes will appear here.')}
                              </Typography.Text>
                            )}
                          </Space>
                          {selectedCommandPane && ['supplyAction', 'missingSupplier'].includes(selectedCommandPane) ? (
                            <Button type="primary" onClick={() => void draftOrder()}>
                              {t('Draft new order for this product')}
                            </Button>
                          ) : null}
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
                          <Col xs={24}>
                            <Card size="small" title={t('Amazon receipt exception')}>
                              <Space direction="vertical" style={{ width: '100%' }}>
                                <Alert
                                  type="warning"
                                  showIcon
                                  message={t(
                                    'Operator/admin only. Sellerboard evidence remains visible and the override is audited.',
                                  )}
                                />
                                <Select
                                  value={receiptOverrideStatus}
                                  onChange={setReceiptOverrideStatus}
                                  options={RECEIPT_OVERRIDE_OPTIONS.map((option) => ({
                                    ...option,
                                    label: t(formatStatusLabel(option.label)),
                                  }))}
                                  style={{ width: '100%' }}
                                />
                                <Input.TextArea
                                  rows={2}
                                  value={receiptOverrideReason}
                                  onChange={(event) => setReceiptOverrideReason(event.target.value)}
                                  placeholder={t('Required reason and supporting evidence')}
                                />
                                <Space>
                                  <Button danger onClick={() => void saveReceiptOverride()}>
                                    {t('Apply receipt override')}
                                  </Button>
                                  <Button onClick={() => void saveReceiptOverride(true)}>{t('Clear override')}</Button>
                                </Space>
                              </Space>
                            </Card>
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
                                setOrderCommentText('');
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
                          <Col xs={24}>
                            <Divider style={{ margin: '4px 0' }} />
                            <Typography.Text strong>{t('Add comment only')}</Typography.Text>
                            <Input.TextArea
                              rows={3}
                              value={orderCommentText}
                              onChange={(event) => setOrderCommentText(event.target.value)}
                              placeholder={t('Example: ClickUp says supplier is waiting on payment confirmation')}
                            />
                            <Typography.Text type="secondary">
                              {t('Saves a note to this supplier order without changing status.')}
                            </Typography.Text>
                          </Col>
                          <Col xs={24}>
                            <Button onClick={() => void saveOrderComment()}>{t('Save comment')}</Button>
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
                              { title: String(t('Task')), dataIndex: 'title' },
                              {
                                title: String(t('Status')),
                                dataIndex: 'status',
                                render: (value: string) => value || '—',
                              },
                              {
                                title: String(t('Priority')),
                                dataIndex: 'priority',
                                render: (value: string) => value || '—',
                              },
                              { title: String(t('Due')), dataIndex: 'dueAt', render: formatDate },
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
                              { title: String(t('Metric')), dataIndex: 'metric' },
                              {
                                title: String(t('Period')),
                                dataIndex: 'periodType',
                                render: (value: string) => value || '—',
                              },
                              { title: String(t('Target')), dataIndex: 'targetValue', render: formatNumber },
                              {
                                title: String(t('Status')),
                                dataIndex: 'status',
                                render: (value: string) => value || '—',
                              },
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
                  ].filter((item) =>
                    selectedCommandPane ? drawerPanelKeysByPane[selectedCommandPane].includes(String(item.key)) : true,
                  )}
                />
              </>
            ) : null}
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
