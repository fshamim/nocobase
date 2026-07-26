/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * The pane definitions in REQ-P display order (T-2.4).
 *
 * 063-D1: the seven PRODUCT panes (Supply Action, Healthy, Excess, Stuck,
 * Zero-stock, Untiered, Discontinued & paused) all point at the one shared
 * table in `product-table-columns.tsx` — they have no columns of their own.
 * What remains here are the order panes and the two panes that still use the v1
 * Signals cluster (Data Readiness, Performance Review).
 *
 * REQ-X6: for those v1 panes, repeated categorical values render as badges
 * inside the single "Signals" cell (max one badge cluster per row); center-stage
 * columns are the pane's decision inputs only (answer, money, dates, tier, last
 * activity) — everything else waits for the drawer. Badges come from served
 * fields only.
 */

import { Tag, Typography } from 'antd';
import React from 'react';
import type { BufferStatus, DashboardRow, PaneKey, PerformanceBand, VelocityTrend } from '../server/contract';
import { reasonLabel, TEXT } from './dashboard-text';
import {
  BAND_TAG_COLOR,
  BUFFER_TAG_COLOR,
  DASHBOARD_TAG_COLORS,
  TIER_TAG_COLOR,
  TREND_TAG_COLOR,
} from './dashboard-tokens';
import { formatDate, formatDays, formatNumber, type Translate } from './format';
import { LAST_ACTIVITY_COLUMN, PRODUCT_TABLE_COLUMNS, PRODUCT_TABLE_SORT_OPTIONS } from './product-table-columns';
import { recentTierOf } from './widgets/recent-tier';
import type { PaneRenderContext } from './widgets/render-context';
import { StockoutUrgencyTag } from './widgets/StockoutUrgencyTag';

export interface PaneColumnConfig {
  key: string;
  titleKey: string;
  /** T-R1 (R1-6): optional header hint — static rules live in a tooltip, not in every row. */
  hintKey?: string;
  render: (row: DashboardRow, t: Translate, ctx?: PaneRenderContext) => React.ReactNode;
}

export interface PaneConfig {
  pane: PaneKey;
  titleKey: string;
  columns: PaneColumnConfig[];
  /** Task 002: dedicated search box at the top of this pane's table. */
  showPaneSearch?: boolean;
  /** T-R1 (R1-2): selectable sort scenarios (value undefined = server default). */
  sortOptions?: Array<{ value?: string; labelKey: string }>;
}

function productCell(row: DashboardRow): React.ReactNode {
  const label = row.identity?.sku ?? row.identity?.asin ?? row.identity?.familyKey ?? '';
  return (
    <span>
      <Typography.Text strong>{label}</Typography.Text>
      {row.identity?.title ? (
        <Typography.Text type="secondary" ellipsis style={{ display: 'block', maxWidth: 260 }}>
          {row.identity?.title}
        </Typography.Text>
      ) : null}
    </span>
  );
}

const BUFFER_TEXT: Record<BufferStatus, string> = {
  sufficient: TEXT.bufferSufficient,
  at_risk: TEXT.bufferAtRisk,
  late: TEXT.bufferLate,
  unknown: TEXT.bufferUnknown,
};

const TREND_TEXT: Record<VelocityTrend, string> = {
  up: TEXT.trendUp,
  flat: TEXT.trendFlat,
  down: TEXT.trendDown,
  unknown: TEXT.trendUnknown,
};

const BAND_TEXT: Record<PerformanceBand, string> = {
  above_band: TEXT.bandAbove,
  within_band: TEXT.bandWithin,
  below_band: TEXT.bandBelow,
  insufficient_evidence: TEXT.bandInsufficient,
};

interface SignalOptions {
  buffer?: boolean;
  trend?: boolean;
  band?: boolean;
  prepPath?: boolean;
  clickupStatus?: boolean;
  reasons?: boolean;
}

/**
 * The single badge cluster per row (REQ-X6). Everything categorical lands here:
 * tier, order status, prep path, buffer, follow-up, stale, family split.
 */
function signalsCell(row: DashboardRow, t: Translate, options: SignalOptions = {}): React.ReactNode {
  const tags: React.ReactNode[] = [];
  // T-D5 (approved OPEN-D5): tiered near-stockout families parked outside the
  // action panes wear the urgency badge wherever the signals cluster renders.
  // 063-D3: the shared product table has no Signals column, so the badge itself
  // lives in a widget that FamilyCell renders too.
  if (row.stockoutUrgency) {
    tags.push(<StockoutUrgencyTag key="stockout-urgency" urgency={row.stockoutUrgency} t={t} />);
  }
  // 065: same ONE badge rule as FamilyCell and the drawer header — recent tier
  // only, with a compact "· last mo." when the letter is the last closed month.
  const tier = row.tier ? recentTierOf(row.tier) : null;
  if (tier) {
    const hint = tier.basis === 'last_month' ? ` · ${t(TEXT.tierLastMonthHint)}` : '';
    tags.push(
      <Tag key="tier" color={TIER_TAG_COLOR[tier.tier.toLowerCase()] ?? DASHBOARD_TAG_COLORS.neutral}>
        {`${t(TEXT.tier)} ${tier.tier.toUpperCase()}${hint}`}
      </Tag>,
    );
  }
  if (options.clickupStatus && row.order?.clickupStatus) {
    tags.push(
      <Tag key="status" color={DASHBOARD_TAG_COLORS.info}>
        {row.order.clickupStatus}
      </Tag>,
    );
  }
  if (options.prepPath && row.order?.prepPath) {
    const prepText =
      row.order.prepPath === 'direct_fba'
        ? TEXT.badgeDirectFba
        : row.order.prepPath === 'own_prep_center'
          ? TEXT.badgeOwnPrep
          : TEXT.badgePrepUnknown;
    tags.push(
      <Tag key="prep" color={DASHBOARD_TAG_COLORS.accent}>
        {t(prepText)}
      </Tag>,
    );
  }
  if (options.buffer && row.order?.bufferStatus) {
    tags.push(
      <Tag key="buffer" color={BUFFER_TAG_COLOR[row.order.bufferStatus]}>
        {t(BUFFER_TEXT[row.order.bufferStatus])}
      </Tag>,
    );
  }
  if (options.trend && row.velocityTrend) {
    tags.push(
      <Tag key="trend" color={TREND_TAG_COLOR[row.velocityTrend]}>
        {t(TREND_TEXT[row.velocityTrend])}
      </Tag>,
    );
  }
  if (options.band && row.performanceBand) {
    tags.push(
      <Tag key="band" color={BAND_TAG_COLOR[row.performanceBand]}>
        {t(BAND_TEXT[row.performanceBand])}
      </Tag>,
    );
  }
  if (row.order?.needsFollowUp) {
    tags.push(
      <Tag key="follow-up" color={DASHBOARD_TAG_COLORS.danger}>
        {t(TEXT.tileNeedsFollowUp)}
      </Tag>,
    );
  }
  if (row.staleClassification) {
    tags.push(
      <Tag key="stale" color={DASHBOARD_TAG_COLORS.warning}>
        {t(TEXT.badgeStale)}
      </Tag>,
    );
  }
  if (row.familySplit) {
    tags.push(
      <Tag key="split" color={DASHBOARD_TAG_COLORS.neutral}>
        {t(TEXT.badgeFamilySplit)}
      </Tag>,
    );
  }
  const reasonCodes = Array.isArray(row.reasonCodes) ? row.reasonCodes : [];
  if (reasonCodes.includes('untiered_projected')) {
    tags.push(
      <Tag key="untiered" color={DASHBOARD_TAG_COLORS.neutral}>
        {t(TEXT.badgeUntieredProjected)}
      </Tag>,
    );
  }
  if (options.reasons) {
    for (const reason of reasonCodes.filter((code) => code !== 'untiered_projected').slice(0, 2)) {
      tags.push(
        <Tag key={`reason-${reason}`} color={DASHBOARD_TAG_COLORS.warning}>
          {reasonLabel(reason, t)}
        </Tag>,
      );
    }
  }
  return <span>{tags}</span>;
}

const product: PaneColumnConfig = { key: 'product', titleKey: TEXT.colProduct, render: (row) => productCell(row) };
const orderRef: PaneColumnConfig = {
  key: 'order',
  titleKey: TEXT.colOrder,
  render: (row, t) => row.order?.orderNumber ?? row.order?.orderId ?? t(TEXT.unknown),
};
const daysInStage: PaneColumnConfig = {
  key: 'daysInStage',
  titleKey: TEXT.colDaysInStage,
  render: (row, t) => formatDays(row.order?.daysInStage ?? null, t),
};
const estOos: PaneColumnConfig = {
  key: 'estOos',
  titleKey: TEXT.colEstOos,
  render: (row, t) => formatDate(row.estimatedOosDate, t),
};
const stock: PaneColumnConfig = {
  key: 'stock',
  titleKey: TEXT.colStock,
  render: (row, t) => formatNumber(row.stock?.currentPlanningStock, t),
};
function signals(options: SignalOptions = {}): PaneColumnConfig {
  return { key: 'signals', titleKey: TEXT.colSignals, render: (row, t) => signalsCell(row, t, options) };
}

export const PANE_CONFIGS: PaneConfig[] = [
  {
    // 063-D1: Supply Action's eight mockup columns are now THE product table —
    // the same array instance backs every product pane below.
    pane: 'supplyAction',
    titleKey: TEXT.paneSupplyAction,
    sortOptions: PRODUCT_TABLE_SORT_OPTIONS,
    columns: PRODUCT_TABLE_COLUMNS,
  },
  {
    pane: 'activeOrders',
    titleKey: TEXT.paneActiveOrders,
    columns: [product, orderRef, daysInStage, LAST_ACTIVITY_COLUMN, signals({ clickupStatus: true })],
  },
  {
    pane: 'inPrepMonitoring',
    titleKey: TEXT.paneInPrepMonitoring,
    columns: [product, orderRef, daysInStage, LAST_ACTIVITY_COLUMN, signals({ prepPath: true })],
  },
  {
    pane: 'inboundMonitoring',
    titleKey: TEXT.paneInboundMonitoring,
    columns: [
      product,
      orderRef,
      {
        key: 'eta',
        titleKey: TEXT.colExpectedArrival,
        render: (row, t) => formatDate(row.order?.expectedArrivalDate, t),
      },
      estOos,
      daysInStage,
      LAST_ACTIVITY_COLUMN,
      signals({ buffer: true, prepPath: true }),
    ],
  },
  {
    pane: 'healthyInventory',
    titleKey: TEXT.paneHealthyInventory,
    sortOptions: PRODUCT_TABLE_SORT_OPTIONS,
    columns: PRODUCT_TABLE_COLUMNS,
  },
  {
    pane: 'excessInventory',
    titleKey: TEXT.paneExcessInventory,
    sortOptions: PRODUCT_TABLE_SORT_OPTIONS,
    columns: PRODUCT_TABLE_COLUMNS,
  },
  {
    pane: 'stuckInventory',
    titleKey: TEXT.paneStuckInventory,
    sortOptions: PRODUCT_TABLE_SORT_OPTIONS,
    columns: PRODUCT_TABLE_COLUMNS,
  },
  {
    pane: 'zeroStock',
    titleKey: TEXT.paneZeroStock,
    sortOptions: PRODUCT_TABLE_SORT_OPTIONS,
    columns: PRODUCT_TABLE_COLUMNS,
  },
  { pane: 'dataReadiness', titleKey: TEXT.paneDataReadiness, columns: [product, stock, signals({ reasons: true })] },
  {
    pane: 'performanceReview',
    titleKey: TEXT.panePerformanceReview,
    columns: [product, signals({ band: true, trend: true })],
  },
  {
    pane: 'untieredProducts',
    titleKey: TEXT.paneUntieredProducts,
    sortOptions: PRODUCT_TABLE_SORT_OPTIONS,
    columns: PRODUCT_TABLE_COLUMNS,
  },
  {
    // Task 002: clearly separate, BOTTOM pane — these families feed no signals.
    pane: 'discontinuedPaused',
    titleKey: TEXT.paneDiscontinuedPaused,
    showPaneSearch: true,
    sortOptions: PRODUCT_TABLE_SORT_OPTIONS,
    columns: PRODUCT_TABLE_COLUMNS,
  },
];
