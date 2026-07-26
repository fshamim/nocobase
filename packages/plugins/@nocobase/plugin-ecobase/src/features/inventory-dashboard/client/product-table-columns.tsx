/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * 063-D1: the ONE product-table column set.
 *
 * The eight Supply Action columns (which product → stock → velocity → when to
 * order → how much → cost of waiting → what was said → what to do) are the
 * table for EVERY product pane: Supply Action, Healthy, Excess, Stuck,
 * Zero-stock, Untiered and Discontinued & paused. All seven reference the same
 * array instances, so the panes cannot drift apart. The order panes keep their
 * own order-grain table (OrderPaneTable) and are not touched here.
 */

import { Tooltip, Typography } from 'antd';
import React from 'react';
import type { DashboardRow } from '../server/contract';
import { TEXT } from './dashboard-text';
import { EM_DASH, formatMoney, formatMonthDay, type Translate } from './format';
import type { PaneColumnConfig, PaneConfig } from './pane-configs';
import { ActionPill, actionPillFor, type ActionPillVerdict } from './widgets/ActionPill';
import { FamilyCell } from './widgets/FamilyCell';
import type { PaneRenderContext } from './widgets/render-context';
import { StockBuckets } from './widgets/StockBuckets';
import { SupplierBadge } from './widgets/SupplierLeadTime';
import { VelocityCover } from './widgets/VelocityCover';

function lastActivityCell(row: DashboardRow, t: Translate): React.ReactNode {
  if (!row.lastActivity) {
    return <Typography.Text type="secondary">{t(TEXT.noActivityYet)}</Typography.Text>;
  }
  const { preview, author, at } = row.lastActivity;
  const suffix = [author, at ? at.slice(0, 10) : null].filter(Boolean).join(' · ');
  return (
    <Tooltip title={preview}>
      <span>
        <Typography.Text ellipsis style={{ display: 'block', maxWidth: 240 }}>
          {preview || t(TEXT.unknown)}
        </Typography.Text>
        {suffix ? <Typography.Text type="secondary">{suffix}</Typography.Text> : null}
      </span>
    </Tooltip>
  );
}

/** Shared with the order panes, which still show the comment preview column. */
export const LAST_ACTIVITY_COLUMN: PaneColumnConfig = {
  key: 'lastActivity',
  titleKey: TEXT.colLastActivity,
  render: (row, t) => lastActivityCell(row, t),
};

/** T7/R1-4: date + relative urgency ONLY (the supplier badge lives in Order qty now). */
function orderByCell(row: DashboardRow, t: Translate): React.ReactNode {
  const days = row.daysUntilSafeReorder;
  const passed = days !== null && days <= 0;
  const soon = days !== null && days > 0 && days <= 7;
  const relative =
    days === null ? null : passed ? t(TEXT.relPassed) : `${t(TEXT.relInPrefix)} ${Math.ceil(days)} ${t(TEXT.dSuffix)}`;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {row.latestSafeReorderDate ? (
        <Typography.Text strong={passed || soon} type={passed ? 'danger' : soon ? 'warning' : undefined}>
          {formatMonthDay(row.latestSafeReorderDate)}
          {relative ? ` — ${relative}` : ''}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary">{EM_DASH}</Typography.Text>
      )}
    </span>
  );
}

/**
 * T7/R1-3/R1-4 (R5): recommended qty + cover note + the supplier badge (the
 * growth-percent control is REMOVED — parked concept).
 */
function orderQtyCell(row: DashboardRow, t: Translate, ctx?: PaneRenderContext): React.ReactNode {
  const qty = row.recommendedOrderQty;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
      {qty !== null ? (
        <Typography.Text strong style={{ fontSize: 15 }}>
          {qty}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary">{EM_DASH}</Typography.Text>
      )}
      {/* R1-6: the coverage rule lives in the header hint; a row only speaks
          up when its horizon DIFFERS from the default (a real operator override). */}
      {qty !== null &&
      row.targetCoverDays !== null &&
      typeof ctx?.targetCoverDaysDefault === 'number' &&
      row.targetCoverDays !== ctx.targetCoverDaysDefault ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`${t(TEXT.coversPrefix)} ${row.targetCoverDays} ${t(TEXT.dSuffix)}`}
        </Typography.Text>
      ) : null}
      <SupplierBadge supplier={row.supplier} fbaReceivingBufferDays={ctx?.fbaReceivingBufferDays ?? null} t={t} />
    </span>
  );
}

/** T7/R1-6 (R6): compact dynamic-only money cell — the rule lives in the header hint. */
function moneyAtRiskCell(row: DashboardRow, t: Translate): React.ReactNode {
  const risk = row.estimatedProfitRisk;
  if (risk === null || risk === 0) return <Typography.Text type="secondary">{EM_DASH}</Typography.Text>;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      <Typography.Text strong type="danger">
        {formatMoney(risk, t)}
      </Typography.Text>
      {row.moneyRiskUncoveredDays !== null ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {` · ${Math.round(row.moneyRiskUncoveredDays)} ${t(TEXT.dSuffix)}`}
        </Typography.Text>
      ) : null}
    </span>
  );
}

/**
 * 063-D2: outside Supply Action the pill is allowed to speak ONLY when its
 * verdict is evidence-driven and pane-independent. `order_this_week` and
 * `order_soon` are ordering COMMANDS — telling an Excess or Discontinued row to
 * "Order soon" would be a wrong recommendation (F7), so those rows get an
 * em-dash instead.
 */
const EVIDENCE_VERDICT_KEYS: ReadonlySet<ActionPillVerdict['key']> = new Set([
  'overdue',
  'refresh_lead_time',
  'verify_velocity',
]);

function actionCell(row: DashboardRow, t: Translate): React.ReactNode {
  if (row.pane !== 'supplyAction' && !EVIDENCE_VERDICT_KEYS.has(actionPillFor(row).key)) {
    return <Typography.Text type="secondary">{EM_DASH}</Typography.Text>;
  }
  return <ActionPill row={row} t={t} />;
}

export const PRODUCT_TABLE_COLUMNS: PaneColumnConfig[] = [
  { key: 'family', titleKey: TEXT.colProduct, render: (row, t, ctx) => <FamilyCell row={row} t={t} ctx={ctx} /> },
  { key: 'stock', titleKey: TEXT.colStock, render: (row, t) => <StockBuckets stock={row.stock} t={t} /> },
  { key: 'velocity', titleKey: TEXT.colVelocityCover, render: (row, t) => <VelocityCover row={row} t={t} /> },
  { key: 'orderBy', titleKey: TEXT.colOrderBy, render: orderByCell },
  { key: 'orderQty', titleKey: TEXT.colOrderQty, hintKey: TEXT.hintOrderQty, render: orderQtyCell },
  { key: 'moneyAtRisk', titleKey: TEXT.metricMoneyAtRisk, hintKey: TEXT.hintMoneyAtRisk, render: moneyAtRiskCell },
  LAST_ACTIVITY_COLUMN,
  { key: 'action', titleKey: TEXT.colAction, render: actionCell },
];

/** T-R1 (R1-2): visible sort scenarios; Tier (server default) first. */
export const PRODUCT_TABLE_SORT_OPTIONS: NonNullable<PaneConfig['sortOptions']> = [
  { labelKey: TEXT.tier },
  { value: 'daysUntilSafeReorder', labelKey: TEXT.sortMostUrgent },
  { value: 'estimatedProfitRisk', labelKey: TEXT.metricMoneyAtRisk },
  { value: 'daysOfCover', labelKey: TEXT.colDaysOfCover },
  { value: 'currentPlanningStock', labelKey: TEXT.colStock },
];
