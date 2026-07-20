/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { Button, Divider, Modal, Space, Tag, Typography } from 'antd';
import {
  BEFORE_ORDERED_STATUSES,
  ORDER_LIFECYCLE_STATUSES,
  ORDER_LIFECYCLE_STATUS_METADATA,
} from '../features/order-planning/order-lifecycle-status';
import { useT } from './locale';

type FormulaSource = 'sellerboard' | 'csv' | 'eco_calc' | 'eco_derived' | 'operator';
type FormulaToken = string | { text: string; source: FormulaSource };

interface FormulaDefinition {
  label: string;
  source: FormulaSource;
  equation: FormulaToken[];
  note?: string;
}

interface HelpEntry {
  label: string;
  description: string;
  source?: FormulaSource;
  tagColor?: string;
}

type FormulaKey =
  | 'stockParity'
  | 'pipelineStock'
  | 'salesVelocity'
  | 'daysOfCover'
  | 'estimatedOosDate'
  | 'latestSafeReorderDate'
  | 'openOrderCoverage'
  | 'suggestedReorderQty'
  | 'tierScore'
  | 'profitTier'
  | 'riskDays'
  | 'inventoryMoneyAtRisk'
  | 'trendChange'
  | 'kpiMargin'
  | 'refundRate'
  | 'weightedTrafficRate'
  | 'orderLifecycle'
  | 'orderMoneyAtRisk'
  | 'waitingDays'
  | 'supplierMoneyAtRisk'
  | 'supplierPriorityScore';

export type FormulaHelpGroupKey =
  | 'managementKpiTrend'
  | 'dailyDecisionQueue'
  | 'dailyOosOverview'
  | 'dailyOrderOverview'
  | 'inventoryDigest'
  | 'inventoryQueue'
  | 'inventorySupplyAction'
  | 'inventoryActiveOrders'
  | 'inventoryInboundMonitoring'
  | 'inventoryHealthyInventory'
  | 'inventoryStuckInventory'
  | 'inventoryPerformanceReview'
  | 'inventoryDrawer'
  | 'orderPlanning'
  | 'orderDrawer'
  | 'supplierDigest'
  | 'supplierRisk';

interface HelpGroup {
  title: string;
  formulas: FormulaKey[];
  fields: HelpEntry[];
  tags?: HelpEntry[];
  notes?: string[];
}

const SOURCE_LABELS: Record<FormulaSource, string> = {
  sellerboard: 'Sellerboard',
  csv: 'CSV / sheet',
  eco_calc: 'EcoBase calculated',
  eco_derived: 'EcoBase derived',
  operator: 'Operator-entered',
};

const SOURCE_COLORS: Record<FormulaSource, string> = {
  sellerboard: 'blue',
  csv: 'purple',
  eco_calc: 'green',
  eco_derived: 'orange',
  operator: 'default',
};

// Add every user-visible EcoBase calculated field here before exposing it in page help.
const FORMULAS: Record<FormulaKey, FormulaDefinition> = {
  stockParity: {
    label: 'Inventory position',
    source: 'eco_calc',
    equation: [
      { text: 'onHandSellableStock', source: 'sellerboard' },
      ' + ',
      { text: 'amazonPipelineStock', source: 'eco_calc' },
      ' + ',
      { text: 'supplierPipelineStock', source: 'eco_calc' },
    ],
    note: 'Reserved stock is unavailable and excluded. Supplier pipeline is net of units already represented in Amazon inbound, ordered, prep, or AWD buckets.',
  },
  pipelineStock: {
    label: 'Amazon pipeline stock',
    source: 'eco_calc',
    equation: [
      { text: 'inbound', source: 'sellerboard' },
      ' + ',
      { text: 'ordered', source: 'sellerboard' },
      ' + ',
      { text: 'prep', source: 'csv' },
      ' + ',
      { text: 'AWD', source: 'csv' },
    ],
    note: 'Amazon-side pipeline is unavailable until sellable. Supplier pipeline is shown separately and netted to prevent double counting.',
  },
  salesVelocity: {
    label: 'Trusted rolling velocity',
    source: 'eco_calc',
    equation: [{ text: 'Sellerboard units in the exact inclusive 30-day window', source: 'sellerboard' }, ' / 30'],
    note: 'The window must have continuous product scope and reconciled unit evidence. A complete no-row window is trusted zero; missing, discontinuous, or mismatched coverage remains insufficient and never falls back to snapshot velocity.',
  },
  daysOfCover: {
    label: 'Current days of cover',
    source: 'eco_derived',
    equation: [
      { text: 'onHandSellableStock', source: 'sellerboard' },
      ' / ',
      { text: 'trustedSalesVelocity', source: 'eco_calc' },
    ],
    note: 'Current OOS timing uses sellable stock only. Future-position cover uses inventoryPositionStock / trustedSalesVelocity; reserved stock never increases either measure.',
  },
  estimatedOosDate: {
    label: 'Estimated OOS date',
    source: 'eco_derived',
    equation: [{ text: 'calculationDate', source: 'eco_calc' }, ' + ', { text: 'daysOfCover', source: 'eco_derived' }],
    note: 'Projected stock-out date based on the current calculation date and days of cover.',
  },
  latestSafeReorderDate: {
    label: 'Order by',
    source: 'eco_derived',
    equation: [
      { text: 'estimatedOosDate', source: 'eco_derived' },
      ' - ',
      { text: 'leadTimeDays', source: 'csv' },
      ' - ',
      { text: 'safetyBuffer', source: 'eco_calc' },
    ],
    note: 'Inputs: estimatedOosDate comes from days of cover, leadTimeDays comes from supplier evidence, safetyBuffer comes from Planning Settings. Example: OOS Jul 20 − 10-day lead time − 7-day buffer = order by Jul 3.',
  },
  openOrderCoverage: {
    label: 'Supplier pipeline stock',
    source: 'eco_calc',
    equation: [
      'sum(',
      { text: 'openQty', source: 'csv' },
      ' where ',
      { text: 'status is paid/preparing/shipped', source: 'eco_calc' },
      ' and ',
      { text: 'expectedSellableDate is inside pipeline grace', source: 'operator' },
      ')',
    ],
    note: 'Purchased open quantity is reduced by Amazon pipeline already represented in inbound, ordered, prep, or AWD buckets. Placed-not-purchased and stale orders do not count.',
  },
  suggestedReorderQty: {
    label: 'Suggested quantity',
    source: 'eco_derived',
    equation: [
      'max(ceil(',
      { text: 'trustedSalesVelocity', source: 'eco_calc' },
      ' × ',
      { text: 'targetCoverDays', source: 'operator' },
      ' - ',
      { text: 'onHandSellableStock', source: 'sellerboard' },
      ' - ',
      { text: 'amazonPipelineStock', source: 'eco_calc' },
      ' - ',
      { text: 'supplierPipelineStock', source: 'eco_calc' },
      '), 0)',
    ],
    note: 'Reserved stock is excluded. Supplier pipeline counts only reliable purchased quantity not already represented in Amazon pipeline.',
  },
  tierScore: {
    label: 'Individual monthly profit tier score',
    source: 'eco_derived',
    equation: [
      'sum(',
      { text: 'eligible complete-month NetProfit', source: 'sellerboard' },
      ') / ',
      { text: 'eligible complete-month count in the dynamic six-closed-month window', source: 'eco_calc' },
    ],
    note: 'Each listing is calculated independently. Missing scope, discontinuous coverage, invalid units, or missing NetProfit excludes that month and lowers confidence; it never becomes zero. Family member profit is never aggregated into another listing.',
  },
  profitTier: {
    label: 'Individual profit tier',
    source: 'eco_derived',
    equation: [
      { text: 'unrounded average monthly NetProfit compared with Planning Settings thresholds', source: 'eco_calc' },
    ],
    note: 'A ≥ 250, B ≥ 100, C ≥ 0, and otherwise D. Trusted zero movement is no-movement rather than D. Only full six-month baseline confidence may enable a new replenishment action; current-month projection is informational for the replacement candidate.',
  },
  riskDays: {
    label: 'Uncovered stockout days',
    source: 'eco_derived',
    equation: [
      'max(0, ',
      { text: 'targetCoverDays', source: 'eco_calc' },
      ' - ',
      { text: 'daysOfCover', source: 'eco_derived' },
      ' - ',
      { text: '(amazonPipelineStock + supplierPipelineStock) / trustedSalesVelocity', source: 'eco_derived' },
      ')',
    ],
    note: 'Reserved stock is excluded. Missing target cover, current cover, velocity, or profit inputs leave Money at Risk unknown; active-order timing gaps still use expected arrival versus current OOS.',
  },
  inventoryMoneyAtRisk: {
    label: 'Money at risk',
    source: 'eco_derived',
    equation: [
      { text: 'riskDays', source: 'eco_derived' },
      ' × ',
      { text: 'salesVelocity', source: 'eco_calc' },
      ' × ',
      { text: 'profitPerUnit', source: 'eco_calc' },
    ],
    note: 'Example: 5 uncovered days × 4 units/day × $8 profit/unit = $160. Missing required inputs remain unknown; resolved negative profit is clamped to zero. Daily totals exclude duplicate-product rows so unresolved identities are not double-counted.',
  },
  trendChange: {
    label: 'Trend change %',
    source: 'eco_calc',
    equation: [
      '(',
      { text: 'currentWindow', source: 'eco_calc' },
      ' - ',
      { text: 'previousWindow', source: 'eco_calc' },
      ') / abs(',
      { text: 'previousWindow', source: 'eco_calc' },
      ') × 100',
    ],
    note: 'Compares the selected window with the previous same-length window; incomplete previous windows show insufficient history.',
  },
  kpiMargin: {
    label: 'Margin',
    source: 'eco_derived',
    equation: [{ text: 'profit', source: 'sellerboard' }, ' / ', { text: 'sales', source: 'sellerboard' }, ' × 100'],
    note: 'Profit share of sales for the KPI window, using Sellerboard sales and profit facts.',
  },
  refundRate: {
    label: 'Refund rate',
    source: 'eco_derived',
    equation: [{ text: 'refunds', source: 'sellerboard' }, ' / ', { text: 'units', source: 'sellerboard' }, ' × 100'],
    note: 'Refunded units as a share of sold units for the KPI window.',
  },
  weightedTrafficRate: {
    label: 'Buy Box / conversion',
    source: 'eco_derived',
    equation: [
      'sum(',
      { text: 'rate', source: 'csv' },
      ' × ',
      { text: 'sessions', source: 'sellerboard' },
      ') / sum(',
      { text: 'sessions', source: 'sellerboard' },
      ')',
    ],
    note: 'Session-weighted rate so high-traffic listings influence the KPI more than low-traffic listings.',
  },
  orderLifecycle: {
    label: 'Order status',
    source: 'eco_calc',
    equation: [
      { text: 'operator override', source: 'operator' },
      ' → ',
      { text: 'invoice/payment/shipping evidence', source: 'csv' },
      ' → ',
      { text: 'fallback review', source: 'eco_calc' },
    ],
    note: 'EcoBase resolves the visible order state from operator edits first, then imported order evidence.',
  },
  orderMoneyAtRisk: {
    label: 'Order money at risk',
    source: 'eco_derived',
    equation: [
      { text: 'gold inventory risk', source: 'eco_derived' },
      ' else ',
      { text: 'line expected profit', source: 'csv' },
    ],
    note: 'Uses inventory risk when linked; otherwise falls back to order-line expected profit. Complete or untiered orders show zero risk.',
  },
  waitingDays: {
    label: 'Waiting days',
    source: 'eco_calc',
    equation: [{ text: 'today', source: 'eco_calc' }, ' - ', { text: 'last meaningful activity', source: 'csv' }],
    note: 'Age of the order or follow-up since the last imported or operator-visible activity date.',
  },
  supplierMoneyAtRisk: {
    label: 'Supplier money at risk',
    source: 'eco_derived',
    equation: [
      { text: 'inventory money at risk', source: 'eco_derived' },
      ' + ',
      { text: 'active order money at risk', source: 'eco_derived' },
    ],
    note: 'Supplier-level exposure by combining inventory shortage risk and active order risk for that supplier.',
  },
  supplierPriorityScore: {
    label: 'Supplier priority',
    source: 'eco_derived',
    equation: [
      { text: 'moneyAtRisk', source: 'eco_derived' },
      ' + ',
      { text: 'follow-up weight', source: 'eco_calc' },
      ' + ',
      { text: 'stale order weight', source: 'eco_calc' },
      ' + ',
      { text: 'lead-time weight', source: 'eco_calc' },
    ],
    note: 'Ranking score for which suppliers need attention first; money risk is boosted by stale follow-up signals.',
  },
};

const MANAGEMENT_TREND_FIELDS: HelpEntry[] = [
  {
    label: 'Metric',
    description: 'The KPI being compared, such as sales, profit, margin, refund rate, or Buy Box rate.',
  },
  { label: 'Current window', description: 'The latest reporting period selected for the daily management snapshot.' },
  { label: 'Previous window', description: 'The same-length period immediately before the current window.' },
  {
    label: 'Change',
    description:
      'Percent movement from previous window to current window. Missing history is shown when there is not enough prior data.',
    source: 'eco_calc',
  },
  { label: 'What it means', description: 'Plain-language explanation of the KPI movement for management review.' },
];

const DAILY_DECISION_FIELDS: HelpEntry[] = [
  {
    label: 'Area',
    description: 'Which queue produced the decision item: Inventory, Order, Supplier, or another risk area.',
  },
  {
    label: 'What management should look at',
    description: 'The subject and short detail that needs review before the next operating decision.',
  },
  { label: 'Signal', description: 'The rule or risk signal that placed this item in the decision queue.' },
  { label: 'Action', description: 'Recommended management action for the row.' },
  { label: 'Owner / supplier', description: 'The person, supplier, or company context responsible for the next step.' },
  { label: 'Due / OOS', description: 'The due date or stock-out date driving urgency.' },
  { label: 'Risk', description: 'Estimated money at risk for prioritizing high-impact work.', source: 'eco_derived' },
];

const INVENTORY_FIELDS: HelpEntry[] = [
  {
    label: 'Action',
    description: 'The operator action EcoBase recommends for this product right now.',
    source: 'eco_calc',
  },
  {
    label: 'Tier',
    description:
      'Official current tier. With history it uses last complete month units × profit per unit; unclassified rows have missing or zero profit inputs.',
    source: 'eco_derived',
  },
  {
    label: '6M tiers',
    description: 'Current, average, and best tier variants from the six complete Sellerboard history months.',
    source: 'eco_derived',
  },
  {
    label: '6M qty',
    description: 'Last month, six-month average, worst month, and best month units used for tier context.',
    source: 'sellerboard',
  },
  {
    label: '6M margin',
    description: 'Total six-month net profit divided by sales. Values below 8% are flagged for review.',
    source: 'eco_derived',
  },
  {
    label: 'Company / ASIN / SKU',
    description:
      'Company scope plus Amazon and seller identifiers used to merge Sellerboard, stock, and planning inputs.',
  },
  {
    label: 'Status',
    description: 'Product status from operator BackendSheet status when present, otherwise derived from stock buckets.',
  },
  {
    label: 'Inventory position',
    description: 'Sellable on hand + Amazon pipeline + net supplier pipeline. Reserved stock is excluded.',
    source: 'eco_calc',
  },
  {
    label: 'On hand',
    description: 'Sellable units available now. This is the only stock basis for current DOC and OOS timing.',
    source: 'sellerboard',
  },
  {
    label: 'Sellable',
    description: 'Units currently available to sell, primarily from Sellerboard stock data.',
    source: 'sellerboard',
  },
  {
    label: 'Reserved',
    description: 'Unavailable units shown as a risk bucket. Reserved never increases DOC or reduces reorder quantity.',
    source: 'sellerboard',
  },
  {
    label: 'Amazon pipeline',
    description: 'Inbound + ordered + prep/AWD stock. It is unavailable until sellable.',
    source: 'eco_calc',
  },
  {
    label: 'Supplier pipeline',
    description: 'Reliable purchased quantity net of units already represented in Amazon pipeline.',
    source: 'eco_calc',
  },
  {
    label: 'Inbound',
    description: 'Units already inbound to Amazon/FBA from Sellerboard or stock import evidence.',
    source: 'sellerboard',
  },
  {
    label: 'Ordered',
    description: 'Units ordered in stock evidence but not yet counted as sellable.',
    source: 'sellerboard',
  },
  {
    label: 'Prep',
    description: 'Units at prep center or prep/AWD buckets from stock/planning imports.',
    source: 'csv',
  },
  {
    label: 'Supplier',
    description:
      'Confirmed product supplier first, then latest OrderDetails history when confirmed mapping is missing.',
  },
  {
    label: 'Lead time',
    description: 'Product-specific supplier lead time when available; otherwise EcoBase uses a 30-day default.',
    source: 'csv',
  },
  {
    label: 'Lead-time source',
    description: 'Fresh or stale source evidence, or Default when EcoBase is using the 30-day fallback.',
    source: 'eco_calc',
  },
  {
    label: 'Days cover',
    description:
      'Current cover is on-hand sellable / trusted velocity; future cover uses inventory position / velocity.',
    source: 'eco_derived',
  },
  {
    label: 'Order by',
    description: 'Latest safe reorder date before stock-out risk after lead time and safety buffer.',
    source: 'eco_derived',
  },
  {
    label: 'OOS date',
    description: 'Projected out-of-stock date from calculation date plus days of cover.',
    source: 'eco_derived',
  },
  {
    label: 'Suggested qty',
    description:
      'max(ceil(trusted velocity × target cover − on-hand sellable − Amazon pipeline − supplier pipeline), 0).',
    source: 'eco_derived',
  },
  {
    label: 'Supplier pipeline',
    description:
      'Reliable purchased open quantity net of Amazon pipeline already represented in stock evidence. Placed-not-purchased orders do not reduce Suggested qty.',
    source: 'eco_calc',
  },
  {
    label: 'Stuck',
    description: 'Check flag for stuck inventory: days of cover greater than 60.',
    source: 'eco_calc',
  },
  {
    label: 'Profit risk',
    description: 'Estimated missed profit if the product remains uncovered during the projected stockout window.',
    source: 'eco_derived',
  },
];

const INVENTORY_DETAIL_FIELDS: HelpEntry[] = [
  ...INVENTORY_FIELDS,
  {
    label: 'Supplier source / confidence',
    description:
      'Shows whether the supplier came from confirmed mapping, import data, or order history, plus confidence level.',
  },
  {
    label: 'Profit per unit',
    description:
      'Dollar profit per unit, not profit margin %. With history it is Sellerboard net profit divided by units across the six complete months; otherwise planning sheet profit inputs are used.',
    source: 'eco_calc',
  },
  {
    label: 'Recommended best qty',
    description: 'Six-month best-month quantity when history exists; sheet Rec. Best Qty is only a fallback.',
    source: 'sellerboard',
  },
  {
    label: 'Projected sellable',
    description:
      'Earliest expected sellable date from matching supplier order lines. Imported from Expected Sellable Date, otherwise ETA on Amazon or Arrival to Amazon; operators can edit it on the order line.',
    source: 'eco_calc',
  },
  {
    label: 'Risk basis',
    description:
      'Explains whether money at risk came from calculated uncovered days, imported missed profit, or missing tier inputs.',
  },
  {
    label: 'Product status logic',
    description:
      'Not selling, Hold, and One Time come from operator status first; otherwise EcoBase derives OOS, Inactive, Inbound, or Reserved from stock buckets.',
    source: 'eco_calc',
  },
];

const INVENTORY_TAGS: HelpEntry[] = [
  {
    label: 'overdue',
    tagColor: 'red',
    description: 'The latest safe reorder date has already passed. This needs immediate review.',
  },
  { label: 'order_today', tagColor: 'volcano', description: 'The latest safe reorder date is today.' },
  {
    label: 'order_soon',
    tagColor: 'orange',
    description: 'The row is approaching the order window but is not yet overdue.',
  },
  {
    label: 'default_lead_time',
    tagColor: 'blue',
    description: 'Source lead time is unavailable, so EcoBase is using the 30-day default.',
  },
  {
    label: 'stale_lead_time',
    tagColor: 'orange',
    description: 'Lead time exists but is older than the configured freshness window.',
  },
  {
    label: 'already_ordered',
    tagColor: 'blue',
    description:
      'Reliable open-order coverage exists, so the operator should monitor the order instead of duplicating it.',
  },
  { label: 'watch', tagColor: 'cyan', description: 'No immediate action, but keep the product under observation.' },
  {
    label: 'sufficient_stock',
    tagColor: 'green',
    description: 'Sellable stock and inventory-position coverage are enough for now.',
  },
  {
    label: 'excluded',
    description:
      'Planning is excluded because product status indicates inactive, discontinued, do not reorder, not selling, hold, or one-time handling.',
  },
  {
    label: 'STUCK',
    tagColor: 'purple',
    description: 'Manual check needed because days of cover is greater than 60.',
  },
  {
    label: 'Margin < 8%',
    tagColor: 'red',
    description: 'Six-month margin is below the operator warning threshold.',
  },
  {
    label: 'Tier movement A→B / B→C / A→Unclassified',
    tagColor: 'red',
    description:
      'Current tier is lower than the immediately preceding snapshot calculated with the same tier-rule version.',
  },
  {
    label: 'Tier movement C→B / B→A / Unclassified→C',
    tagColor: 'green',
    description:
      'Current tier improved from the immediately preceding snapshot calculated with the same tier-rule version.',
  },
  { label: 'fresh', tagColor: 'green', description: 'Lead-time evidence is recent enough for planning.' },
  { label: 'stale', tagColor: 'orange', description: 'Lead-time evidence exists but should be reconfirmed.' },
  { label: 'missing', tagColor: 'red', description: 'Required lead-time evidence is missing.' },
  {
    label: 'No order history',
    tagColor: 'red',
    description: 'EcoBase found no supplier order evidence for this product.',
  },
  {
    label: 'Order placed, not purchased',
    tagColor: 'orange',
    description: 'An order exists but is not yet reliable coverage because purchase/payment evidence is missing.',
  },
  {
    label: 'Purchased / pipeline',
    tagColor: 'blue',
    description: 'A supplier order is reliable pipeline coverage and can reduce reorder quantity.',
  },
  {
    label: 'No open order',
    description: 'Only closed historical order evidence exists; it does not cover the current risk.',
  },
];

const INVENTORY_SUPPLY_ACTION_FIELDS: HelpEntry[] = [
  {
    label: 'Risk',
    description: 'Immediate supply-action status: overdue, order today, order soon, or lead-time issue.',
    source: 'eco_calc',
  },
  {
    label: 'Product',
    description: 'ASIN, SKU, and company. Long product title is kept out of the pane to keep scanning fast.',
  },
  { label: 'Tier', description: 'Profitability tier used to prioritize A/B/C products first.', source: 'eco_derived' },
  {
    label: 'Inventory position',
    description: 'On-hand sellable + Amazon pipeline + net supplier pipeline. Reserved is shown separately.',
    source: 'eco_calc',
  },
  {
    label: 'On hand',
    description: 'FBA/sellable units available now; the current DOC and OOS basis.',
    source: 'sellerboard',
  },
  { label: 'FBA', description: 'FBA/sellable units currently available to sell.', source: 'sellerboard' },
  { label: 'RES', description: 'Reserved units held by Amazon or operations.', source: 'sellerboard' },
  { label: 'INB', description: 'Inbound units already moving toward Amazon/FBA.', source: 'sellerboard' },
  { label: 'PRP', description: 'Units in prep center or prep/AWD buckets.', source: 'csv' },
  { label: 'ORD', description: 'Ordered units not yet counted as sellable.', source: 'sellerboard' },
  {
    label: 'Coverage',
    description: 'Three lines: days until stockout, stockout date with daily sales, and days short of target cover.',
    source: 'eco_derived',
  },
  {
    label: 'Order by',
    description: 'Latest safe reorder date, supplier name, lead-time days, and lead-time freshness.',
    source: 'eco_derived',
  },
  {
    label: 'Suggested qty (45d)',
    description:
      'Recommended reorder quantity. The column header shows the current target-cover days, for example “Suggested qty (45d)”.',
    source: 'eco_derived',
  },
  {
    label: 'Money at risk',
    description: 'Estimated missed profit if the stockout risk is not covered.',
    source: 'eco_derived',
  },
];

const INVENTORY_SUPPLY_ACTION_TAGS: HelpEntry[] = [
  { label: 'Overdue', tagColor: 'red', description: 'The latest safe reorder date has passed.' },
  { label: 'Order Today', tagColor: 'volcano', description: 'The latest safe reorder date is today.' },
  {
    label: 'Order Soon',
    tagColor: 'orange',
    description: 'The latest safe reorder date is inside the configured soon window.',
  },
  {
    label: 'Default Lead Time',
    tagColor: 'blue',
    description: 'Supplier lead time is unavailable, so the order-by date uses the 30-day default.',
  },
  {
    label: 'Stale Lead Time',
    tagColor: 'orange',
    description: 'Lead time exists but is older than the freshness setting.',
  },
];

const INVENTORY_ACTIVE_ORDER_FIELDS: HelpEntry[] = [
  {
    label: 'Risk',
    description: 'Why this active order needs eyes: late, in buffer, not bought, needs a note, or just watch it.',
    source: 'eco_calc',
  },
  { label: 'Product', description: 'ASIN, SKU, and company for the product on the order.' },
  {
    label: 'Order',
    description: 'Order ID, open units, supplier, lead-time freshness, and product order cost.',
  },
  {
    label: 'Coverage',
    description: 'Three lines: days until stockout, stockout date with daily sales, and days short of target cover.',
    source: 'eco_derived',
  },
  {
    label: 'Expected sellable',
    description: 'The first sellable date on the product order lines. You can edit it in the row drawer.',
    source: 'eco_calc',
  },
  {
    label: 'Gap',
    description:
      'Expected sellable minus OOS. Late means stock may run out first. Buffer means the order should land first.',
    source: 'eco_derived',
  },
  {
    label: 'Last Activity',
    description: 'Relative activity time plus the latest order comment, capped and wrapped to two lines.',
    source: 'eco_calc',
  },
  {
    label: 'Money at risk',
    description: 'Profit we may miss if the order is not sellable before stock runs out.',
    source: 'eco_derived',
  },
];

const INVENTORY_ACTIVE_ORDER_TAGS: HelpEntry[] = [
  { label: 'Off-Track', tagColor: 'red', description: 'Expected sellable is after OOS. Stock may run out first.' },
  {
    label: 'Late With Buffer',
    tagColor: 'orange',
    description: 'Expected sellable is already past, but it is still inside the buffer days setting.',
  },
  {
    label: 'Placed Not Purchased',
    tagColor: 'orange',
    description: 'An order was started, but it is not paid or bought yet. It does not count as safe cover.',
  },
  {
    label: 'Follow-Up Due Today',
    tagColor: 'red',
    description: 'The row has a bought order. Add a status note today. Last Activity shows the last activity age.',
  },
  {
    label: 'Pipeline Monitoring',
    tagColor: 'blue',
    description: 'A bought order is open and not late. Watch it so the team does not make a duplicate order.',
  },
];

const INVENTORY_STUCK_FIELDS: HelpEntry[] = [
  {
    label: 'Risk',
    description: 'Stuck signal: 30+ DOC, 60+ DOC, or a stock-bucket issue that needs review.',
    source: 'eco_calc',
  },
  { label: 'Product', description: 'ASIN, SKU, and company for the slow-moving product.' },
  {
    label: 'DOC',
    description: 'Days of cover; high values indicate capital tied up in inventory.',
    source: 'eco_derived',
  },
  {
    label: 'Sell-through evidence',
    description: 'Recent sales velocity and six-month average proving the row is slow-moving, not merely stocked out.',
    source: 'eco_derived',
  },
  {
    label: 'Inventory position',
    description:
      'Sellable on hand, Amazon pipeline, supplier pipeline, and reserved/unavailable risk are shown separately.',
    source: 'eco_calc',
  },
  {
    label: 'Capital / risk',
    description:
      'Estimated tied-up capital uses sellable affected units only; reserved units remain a separate risk signal.',
    source: 'eco_derived',
  },
];

const INVENTORY_STUCK_TAGS: HelpEntry[] = [
  {
    label: '30+ DOC',
    tagColor: 'orange',
    description: 'More than 30 days of cover; review if capital should be freed.',
  },
  {
    label: '60+ DOC',
    tagColor: 'red',
    description: 'More than 60 days of cover; high-priority stuck inventory review.',
  },
  {
    label: 'High Cover Slow Sales',
    tagColor: 'purple',
    description: 'Current cover is high while recent sell-through remains low.',
  },
  {
    label: 'Reserved Not Selling',
    tagColor: 'purple',
    description: 'Reserved or unavailable stock is not converting into sales.',
  },
  {
    label: 'Pipeline Stalled',
    tagColor: 'purple',
    description: 'Pipeline/prep stock exists but is not becoming sellable fast enough.',
  },
  {
    label: 'False Positives Filtered',
    tagColor: 'green',
    description: 'Rows without sell-through because they were stocked out are excluded from stuck inventory.',
  },
];

const ORDER_FIELDS: HelpEntry[] = [
  {
    label: 'Supplier / order group',
    description: 'Orders grouped by supplier so operators can coordinate follow-up supplier-by-supplier.',
  },
  {
    label: 'Order ID',
    description: 'Imported or generated order reference; click it to open the order detail drawer.',
  },
  {
    label: 'Current status',
    description:
      'Resolved order lifecycle status from operator override first, then invoice/payment/shipping evidence, then fallback review.',
    source: 'eco_calc',
  },
  {
    label: 'Status source',
    description:
      'Where the current status came from: operator edit, source order data, invoice/payment evidence, or EcoBase fallback.',
  },
  {
    label: 'Status checks',
    description: 'Supplier group count of orders where EcoBase thinks the current status needs operator verification.',
    source: 'eco_calc',
  },
  {
    label: 'Tier',
    description: 'Best profit tier among the products affected by the order. A is highest priority.',
    source: 'eco_derived',
  },
  { label: 'ASINs', description: 'Number of distinct ASINs in the order.' },
  { label: 'Lines', description: 'Number of order lines in the order.' },
  {
    label: 'Money at risk',
    description:
      'For tiered active orders, EcoBase uses linked gold inventory risk; if missing, it falls back to order-line expected profit.',
    source: 'eco_derived',
  },
  {
    label: 'Earliest OOS',
    description:
      'Earliest estimated OOS date among gold inventory rows linked to the order products. Supplier groups show the earliest date across their orders.',
    source: 'eco_derived',
  },
  {
    label: 'OOS timing',
    description:
      'Human timing label from earliest OOS date: OOS now, OOS today, or in N days. Missing data names the missing source.',
  },
  {
    label: 'Waiting / Longest waiting',
    description:
      'Days since last meaningful activity: latest comment/update/order date. Supplier groups show the longest waiting order.',
    source: 'eco_calc',
  },
  { label: 'Latest comment / remark', description: 'Most recent operator comment or imported order remark.' },
  { label: 'Expected delivery', description: 'Expected delivery date from order or line evidence.' },
  { label: 'Next action', description: 'Operator-entered next action for the order follow-up.', source: 'operator' },
  { label: 'Next action due', description: 'Due date for the operator-entered next action.', source: 'operator' },
  {
    label: 'Ordered / Confirmed / Received',
    description: 'Order-line quantities from imported order evidence and operator updates.',
    source: 'csv',
  },
  {
    label: 'Unit cost / Sell price / Margin / Profit',
    description: 'Line economics used as fallback risk when gold inventory risk is not available.',
    source: 'csv',
  },
  {
    label: 'Delivery / Sellable',
    description: 'Expected line delivery date and expected sellable date after receiving/prep.',
  },
  { label: 'Invoice status', description: 'Invoice state used as evidence for payment/order lifecycle resolution.' },
];

const ORDER_TAGS: HelpEntry[] = [
  ...ORDER_LIFECYCLE_STATUSES.map((status) => {
    const metadata = ORDER_LIFECYCLE_STATUS_METADATA[status];
    return {
      label: metadata.label,
      tagColor: metadata.color === 'default' ? undefined : metadata.color,
      description: metadata.description,
    };
  }),
  {
    label: 'needs status check',
    tagColor: 'red',
    description: 'EcoBase found stale or conflicting evidence; an operator should confirm the lifecycle status.',
  },
  { label: 'Money at risk tab', description: 'Shows active tiered orders with non-zero money at risk.' },
  {
    label: 'Before ordered tab',
    description: `Shows orders still before the ORDERED stage: ${BEFORE_ORDERED_STATUSES.join(', ')}.`,
  },
  { label: 'After ordered tab', description: 'Shows orders already ordered but not complete.' },
];

const SUPPLIER_FIELDS: HelpEntry[] = [
  {
    label: 'Supplier',
    description:
      'Supplier display name plus company scope. All companies means the supplier is not limited to one company.',
  },
  {
    label: 'Lifecycle',
    description: 'Current supplier lifecycle: new, contacting, product review, payment review, approved, or rejected.',
    source: 'operator',
  },
  {
    label: 'Follow-up',
    description: 'Follow-up state and next follow-up date for supplier communication.',
    source: 'operator',
  },
  {
    label: 'Risk',
    description: 'Supplier money at risk: inventory shortage risk plus active order risk.',
    source: 'eco_derived',
  },
  {
    label: 'Risk split',
    description: 'Breakdown of supplier risk into inventory risk and order risk.',
    source: 'eco_derived',
  },
  {
    label: 'Stale orders',
    description: 'Count of active supplier orders that have waited too long without meaningful progress.',
    source: 'eco_calc',
  },
  {
    label: 'Lead-time issues',
    description: 'Count of supplier products with missing or stale lead-time evidence.',
    source: 'eco_calc',
  },
  { label: 'Products', description: 'Approved product count and candidate/review product count for the supplier.' },
  {
    label: 'Recommended action',
    description: 'Plain-language next action generated from risk, follow-up state, stale orders, and lead-time issues.',
    source: 'eco_derived',
  },
  { label: 'Last comment', description: 'Most recent supplier comment or follow-up note.' },
  { label: 'Contact', description: 'Supplier contact name, email, phone, or website when available.' },
  {
    label: 'Supplier products',
    description: 'Products linked to this supplier, including analysis status and lead time.',
  },
  {
    label: 'Inventory / lead-time risk',
    description: 'Product risks for this supplier from inventory shortage and lead-time freshness.',
  },
  {
    label: 'Active stalled orders',
    description: 'Open orders linked to this supplier that are waiting or financially risky.',
  },
  { label: 'Comments / follow-ups', description: 'Operator log of supplier communication and future follow-up dates.' },
];

const SUPPLIER_TAGS: HelpEntry[] = [
  { label: 'new', description: 'Supplier exists but has not moved into active outreach.' },
  { label: 'contacting', tagColor: 'orange', description: 'Supplier outreach is active.' },
  { label: 'product_review', tagColor: 'purple', description: 'Supplier products are being reviewed before approval.' },
  { label: 'payment_review', tagColor: 'blue', description: 'Payment/account terms need review.' },
  { label: 'approved', tagColor: 'green', description: 'Supplier or product is approved for use.' },
  { label: 'rejected', tagColor: 'red', description: 'Supplier or product should not be used.' },
  { label: 'missing_follow_up', description: 'No next follow-up date exists; operator should schedule one.' },
  { label: 'overdue', tagColor: 'red', description: 'Supplier follow-up date has passed.' },
  { label: 'due_today', tagColor: 'volcano', description: 'Supplier follow-up is due today.' },
  { label: 'scheduled', tagColor: 'blue', description: 'Supplier follow-up is scheduled for a future date.' },
  { label: 'not_analyzed', description: 'Supplier product has not been reviewed yet.' },
  { label: 'candidate', description: 'Supplier product is a candidate pending approval.' },
];

const DAILY_OOS_FIELDS: HelpEntry[] = [
  { label: 'Product', description: 'ASIN/SKU and title/company for the inventory risk row.' },
  { label: 'Supplier', description: 'Supplier connected to the risky product when known.' },
  { label: 'OOS date', description: 'Projected out-of-stock date from inventory planning.', source: 'eco_derived' },
  {
    label: 'Latest safe order',
    description: 'Last date to order before OOS risk after lead time and safety buffer.',
    source: 'eco_derived',
  },
  {
    label: 'Coverage',
    description: 'Current supplier order state plus reliable open-order coverage units.',
    source: 'eco_calc',
  },
  {
    label: 'Action',
    description: 'Inventory action status that explains what the operator should do now.',
    source: 'eco_calc',
  },
  {
    label: 'Money at risk',
    description: 'Estimated profit risk from the inventory planning row.',
    source: 'eco_derived',
  },
];

const DAILY_ORDER_FIELDS: HelpEntry[] = [
  { label: 'Order', description: 'Order reference plus latest comment/remark.' },
  { label: 'Supplier', description: 'Supplier attached to the order.' },
  {
    label: 'Status',
    description: 'Resolved lifecycle status; red means the order needs status confirmation.',
    source: 'eco_calc',
  },
  { label: 'Next action', description: 'Operator next action for the order.' },
  { label: 'Due', description: 'Next-action due date.' },
  {
    label: 'Earliest OOS',
    description: 'Earliest linked inventory OOS date among products affected by the order.',
    source: 'eco_derived',
  },
  { label: 'Waiting', description: 'Days since latest meaningful order activity.', source: 'eco_calc' },
  {
    label: 'Money at risk',
    description: 'Active order risk used to prioritize management attention.',
    source: 'eco_derived',
  },
];

const GROUPS: Record<FormulaHelpGroupKey, HelpGroup> = {
  managementKpiTrend: {
    title: 'Management KPI trend',
    formulas: ['trendChange', 'kpiMargin', 'refundRate', 'weightedTrafficRate'],
    fields: MANAGEMENT_TREND_FIELDS,
    notes: ['Trends appear after enough Gold KPI facts exist for both current and previous comparison windows.'],
  },
  dailyDecisionQueue: {
    title: "Today's decision queue",
    formulas: ['inventoryMoneyAtRisk', 'orderMoneyAtRisk', 'supplierPriorityScore'],
    fields: DAILY_DECISION_FIELDS,
    tags: [...INVENTORY_TAGS.slice(0, 9), ...ORDER_TAGS.slice(11, 12), ...SUPPLIER_TAGS.slice(6, 10)],
    notes: [
      'The decision queue mixes Inventory, Order, and Supplier signals so management can review the highest-impact items first.',
    ],
  },
  dailyOosOverview: {
    title: 'Out-of-stock overview',
    formulas: ['estimatedOosDate', 'latestSafeReorderDate', 'daysOfCover', 'inventoryMoneyAtRisk'],
    fields: DAILY_OOS_FIELDS,
    tags: INVENTORY_TAGS,
  },
  dailyOrderOverview: {
    title: 'Order planning overview',
    formulas: ['orderLifecycle', 'orderMoneyAtRisk', 'waitingDays'],
    fields: DAILY_ORDER_FIELDS,
    tags: ORDER_TAGS,
  },
  inventoryDigest: {
    title: 'Inventory daily digest',
    formulas: ['latestSafeReorderDate', 'inventoryMoneyAtRisk', 'profitTier'],
    fields: INVENTORY_FIELDS.filter((entry) =>
      ['Action', 'Tier', 'Supplier', 'Lead time', 'Days cover', 'Order by', 'OOS date', 'Profit risk'].includes(
        entry.label,
      ),
    ),
    tags: INVENTORY_TAGS,
  },
  inventoryQueue: {
    title: 'Inventory planning queue',
    formulas: [
      'stockParity',
      'pipelineStock',
      'salesVelocity',
      'daysOfCover',
      'estimatedOosDate',
      'latestSafeReorderDate',
      'openOrderCoverage',
      'suggestedReorderQty',
      'tierScore',
      'profitTier',
    ],
    fields: INVENTORY_FIELDS,
    tags: INVENTORY_TAGS,
    notes: [
      'Rows are sorted by action urgency, OOS timing, profit tier, and supplier context so operators can work top-down.',
      'Planning Settings controls target cover, safety buffer, reorder cycle, lead-time freshness, order-soon window, and purchased-pipeline grace. Suggested qty uses target cover; Order by uses lead time plus safety buffer.',
    ],
  },
  inventorySupplyAction: {
    title: 'Families needing supply action',
    formulas: [
      'stockParity',
      'pipelineStock',
      'daysOfCover',
      'estimatedOosDate',
      'latestSafeReorderDate',
      'openOrderCoverage',
      'suggestedReorderQty',
      'inventoryMoneyAtRisk',
      'tierScore',
      'profitTier',
    ],
    fields: INVENTORY_SUPPLY_ACTION_FIELDS,
    tags: INVENTORY_SUPPLY_ACTION_TAGS,
    notes: [
      'This pane answers: which product families need a new or updated purchase order because no reliable active pipeline exists?',
      'Suggested qty uses the Target cover control. Lead time and safety buffer decide the Order by date; they no longer increase the quantity directly.',
      'Family stock and family velocity sum the listings inside the exact company + Amazon account + marketplace + ASIN boundary. Expand a family to see listing-level evidence.',
      'The Target badge marks the only SKU allowed to receive the family reorder action. Operators can change and persist that target from the family row.',
    ],
  },
  inventoryActiveOrders: {
    title: 'Families with active orders',
    formulas: ['daysOfCover', 'estimatedOosDate', 'openOrderCoverage', 'orderLifecycle', 'inventoryMoneyAtRisk'],
    fields: INVENTORY_ACTIVE_ORDER_FIELDS,
    tags: INVENTORY_ACTIVE_ORDER_TAGS,
    notes: [
      'This pane answers: which product families already have an order, and will that order be sellable before family stock runs out?',
      'Open order cover only counts bought pipeline units. Placed-not-purchased rows do not reduce Suggested qty.',
      'Follow-up due today is not based on a fixed no-activity-days rule. It means the row has a bought order and needs a fresh status note today.',
    ],
  },
  inventoryInboundMonitoring: {
    title: 'Inbound Monitoring',
    formulas: ['daysOfCover', 'estimatedOosDate', 'openOrderCoverage', 'orderLifecycle', 'inventoryMoneyAtRisk'],
    fields: INVENTORY_ACTIVE_ORDER_FIELDS,
    tags: INVENTORY_ACTIVE_ORDER_TAGS,
    notes: [
      'This pane contains only exact ClickUp inbound-monitoring families whose persisted Amazon receipt state is awaiting or partially observed.',
      'Sellerboard Amazon-visible stock is the receipt authority. A source status alone never proves receipt, and direct-ship-fba remains in Active Orders until the receipt rule confirms stock.',
      'Partially observed means some ordered quantity is visible on Amazon while an open quantity remains. The evidence date and warning tags show whether operator review is needed.',
    ],
  },
  inventoryHealthyInventory: {
    title: 'Healthy inventory',
    formulas: ['stockParity', 'daysOfCover', 'openOrderCoverage', 'orderLifecycle'],
    fields: INVENTORY_FIELDS,
    tags: INVENTORY_TAGS,
    notes: [
      'This pane contains families with a persisted Sellerboard-confirmed Amazon receipt and positive current inventory.',
      'Healthy does not rewrite the ClickUp operational status. A newer independent stockout or stuck condition can route the family back to an action pane.',
      'Receipt evidence remains visible through the observed date, completion reason, source snapshot lineage, and order history.',
    ],
  },
  inventoryStuckInventory: {
    title: 'Stuck inventory',
    formulas: [
      'stockParity',
      'pipelineStock',
      'salesVelocity',
      'daysOfCover',
      'inventoryMoneyAtRisk',
      'tierScore',
      'profitTier',
    ],
    fields: INVENTORY_STUCK_FIELDS,
    tags: INVENTORY_STUCK_TAGS,
    notes: [
      'This pane has one action row per family and identifies the affected listings, units, value, reason, and active-order context.',
      'A listing is stuck only for trusted rolling-30 zero sell-through with fresh positive sellable stock. Trusted cover strictly above 60 days is routed separately to Excess Inventory.',
      'Missing or discontinuous velocity evidence is a data-readiness warning, never inferred zero sell-through.',
      'Active orders do not hide stuck stock. Expand the family to inspect each listing and its latest order evidence.',
    ],
  },
  inventoryPerformanceReview: {
    title: 'Performance Review',
    formulas: ['tierScore', 'profitTier', 'salesVelocity', 'daysOfCover'],
    fields: INVENTORY_DETAIL_FIELDS,
    tags: INVENTORY_TAGS,
    notes: [
      'This is a non-action listing review surface for Tier D, no movement, closed/current decline, stuck, excess, and data-readiness evidence.',
      'Listing filters never create or duplicate a family action. The frozen family target remains the sole action owner.',
      'Baseline and exact last-closed tiers are separate from the informational current-month projection and show independent confidence and movement.',
    ],
  },
  inventoryDrawer: {
    title: 'Inventory row detail',
    formulas: [
      'tierScore',
      'profitTier',
      'riskDays',
      'inventoryMoneyAtRisk',
      'openOrderCoverage',
      'suggestedReorderQty',
    ],
    fields: INVENTORY_DETAIL_FIELDS,
    tags: INVENTORY_TAGS,
  },
  orderPlanning: {
    title: 'Order planning',
    formulas: ['orderLifecycle', 'orderMoneyAtRisk', 'waitingDays'],
    fields: ORDER_FIELDS,
    tags: ORDER_TAGS,
    notes: [
      'Supplier groups aggregate order count, ASIN count, line count, risk, earliest OOS, and longest waiting across their child orders.',
    ],
  },
  orderDrawer: {
    title: 'Order detail',
    formulas: ['orderLifecycle', 'orderMoneyAtRisk', 'waitingDays'],
    fields: ORDER_FIELDS,
    tags: ORDER_TAGS,
    notes: [
      'Earliest OOS is not read from the order itself; it is the minimum estimated OOS date from linked gold inventory rows for the order lines.',
    ],
  },
  supplierDigest: {
    title: 'Supplier daily digest',
    formulas: ['supplierMoneyAtRisk', 'supplierPriorityScore', 'waitingDays'],
    fields: SUPPLIER_FIELDS,
    tags: SUPPLIER_TAGS,
  },
  supplierRisk: {
    title: 'Supplier risk drivers',
    formulas: ['supplierMoneyAtRisk', 'supplierPriorityScore', 'inventoryMoneyAtRisk', 'orderMoneyAtRisk'],
    fields: SUPPLIER_FIELDS,
    tags: [...SUPPLIER_TAGS, ...INVENTORY_TAGS.slice(10, 13), ...ORDER_TAGS],
  },
};

function sourceTag(source: FormulaSource, t: (value: string) => string) {
  return (
    <Tag color={SOURCE_COLORS[source]} style={{ marginInlineEnd: 0 }}>
      {t(SOURCE_LABELS[source])}
    </Tag>
  );
}

function formulaToken(token: FormulaToken, index: number, t: (value: string) => string) {
  if (typeof token === 'string') return <React.Fragment key={index}>{token}</React.Fragment>;
  return (
    <Typography.Text key={index} code style={{ color: tokenColor(token.source), fontWeight: 600 }}>
      {t(token.text)}
    </Typography.Text>
  );
}

function tokenColor(source: FormulaSource) {
  return {
    sellerboard: '#1677ff',
    csv: '#722ed1',
    eco_calc: '#389e0d',
    eco_derived: '#d46b08',
    operator: '#595959',
  }[source];
}

function sectionTitle(title: string, t: (value: string) => string) {
  return <Typography.Title level={5}>{t(title)}</Typography.Title>;
}

function helpEntry(entry: HelpEntry, t: (value: string) => string) {
  return (
    <Space key={`${entry.label}:${entry.description}`} direction="vertical" size={2} style={{ width: '100%' }}>
      <Space size="small" wrap>
        {entry.tagColor ? (
          <Tag color={entry.tagColor}>{t(entry.label)}</Tag>
        ) : (
          <Typography.Text strong>{t(entry.label)}</Typography.Text>
        )}
        {entry.source ? sourceTag(entry.source, t) : null}
      </Space>
      <Typography.Text type="secondary">{t(entry.description)}</Typography.Text>
    </Space>
  );
}

function helpSection(title: string, entries: HelpEntry[] | undefined, t: (value: string) => string) {
  if (!entries?.length) return null;
  return (
    <>
      <Divider style={{ margin: '12px 0' }} />
      {sectionTitle(title, t)}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {entries.map((entry) => helpEntry(entry, t))}
      </Space>
    </>
  );
}

export function FormulaHelp({ group, label = 'How does this work?' }: { group: FormulaHelpGroupKey; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const definition = GROUPS[group];
  const formulas = definition.formulas.map((key) => FORMULAS[key]);
  return (
    <>
      <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setOpen(true)}>
        {t(label)}
      </Button>
      <Modal open={open} title={t(definition.title)} footer={null} width={900} onCancel={() => setOpen(false)}>
        <Space direction="vertical" size="small" style={{ width: '100%', maxHeight: '70vh', overflow: 'auto' }}>
          <Space size={[4, 4]} wrap>
            {(Object.keys(SOURCE_LABELS) as FormulaSource[]).map((source) => (
              <span key={source}>{sourceTag(source, t)}</span>
            ))}
          </Space>
          <Typography.Text type="secondary">
            {t(
              'EcoBase calculated means EcoBase computes the value directly from source fields. EcoBase derived means EcoBase computes it from other calculated values.',
            )}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t(
              'Green values are first-level EcoBase calculations from source data. Orange values are second-level or higher calculations built from calculated values.',
            )}
          </Typography.Text>
          {formulas.length ? (
            <>
              <Divider style={{ margin: '12px 0' }} />
              {sectionTitle('Key formulas', t)}
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {formulas.map((formula) => (
                  <Space key={formula.label} direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space size="small" wrap>
                      <Typography.Text strong>{t(formula.label)}</Typography.Text>
                      {sourceTag(formula.source, t)}
                    </Space>
                    <Typography.Text style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {formula.equation.map((token, index) => formulaToken(token, index, t))}
                    </Typography.Text>
                    {formula.note ? <Typography.Text type="secondary">{t(formula.note)}</Typography.Text> : null}
                  </Space>
                ))}
              </Space>
            </>
          ) : null}
          {helpSection('Columns and fields', definition.fields, t)}
          {helpSection('Action and status tags', definition.tags, t)}
          {definition.notes?.length ? (
            <>
              <Divider style={{ margin: '12px 0' }} />
              {sectionTitle('Notes', t)}
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                {definition.notes.map((note) => (
                  <Typography.Text key={note} type="secondary">
                    {t(note)}
                  </Typography.Text>
                ))}
              </Space>
            </>
          ) : null}
        </Space>
      </Modal>
    </>
  );
}
