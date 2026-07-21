/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * The 11 pane definitions in REQ-P display order (T-2.4).
 *
 * REQ-X6: repeated categorical values render as badges inside the single
 * "Signals" cell (max one badge cluster per row); center-stage columns are the
 * pane's decision inputs only (answer, money, dates, tier, last activity) —
 * everything else waits for the drawer. Badges come from served fields only.
 */

import { Tag, Tooltip, Typography } from 'antd';
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
import { formatDate, formatDays, formatMoney, formatNumber, type Translate } from './format';

export interface PaneColumnConfig {
  key: string;
  titleKey: string;
  render: (row: DashboardRow, t: Translate) => React.ReactNode;
}

export interface PaneConfig {
  pane: PaneKey;
  titleKey: string;
  columns: PaneColumnConfig[];
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
  const tier = row.tier?.current ?? row.tier?.baseline;
  if (tier) {
    tags.push(
      <Tag key="tier" color={TIER_TAG_COLOR[tier.toLowerCase()] ?? DASHBOARD_TAG_COLORS.neutral}>
        {`${t(TEXT.tier)} ${tier.toUpperCase()}`}
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
const lastActivity: PaneColumnConfig = {
  key: 'lastActivity',
  titleKey: TEXT.colLastActivity,
  render: (row, t) => lastActivityCell(row, t),
};
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
const daysOfCover: PaneColumnConfig = {
  key: 'daysOfCover',
  titleKey: TEXT.colDaysOfCover,
  render: (row, t) => formatDays(row.daysOfCover, t),
};
const profitRisk: PaneColumnConfig = {
  key: 'profitRisk',
  titleKey: TEXT.colProfitRisk,
  render: (row, t) => formatMoney(row.estimatedProfitRisk, t),
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
    pane: 'supplyAction',
    titleKey: TEXT.paneSupplyAction,
    columns: [
      product,
      { key: 'reorderBy', titleKey: TEXT.colReorderBy, render: (row, t) => formatDate(row.latestSafeReorderDate, t) },
      estOos,
      daysOfCover,
      profitRisk,
      signals(),
    ],
  },
  {
    pane: 'activeOrders',
    titleKey: TEXT.paneActiveOrders,
    columns: [product, orderRef, daysInStage, lastActivity, signals({ clickupStatus: true })],
  },
  {
    pane: 'inPrepMonitoring',
    titleKey: TEXT.paneInPrepMonitoring,
    columns: [product, orderRef, daysInStage, lastActivity, signals({ prepPath: true })],
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
      lastActivity,
      signals({ buffer: true, prepPath: true }),
    ],
  },
  {
    pane: 'healthyInventory',
    titleKey: TEXT.paneHealthyInventory,
    columns: [product, daysOfCover, estOos, signals({ trend: true })],
  },
  {
    pane: 'excessInventory',
    titleKey: TEXT.paneExcessInventory,
    columns: [product, daysOfCover, stock, signals({ trend: true })],
  },
  {
    pane: 'stuckInventory',
    titleKey: TEXT.paneStuckInventory,
    columns: [
      product,
      stock,
      { key: 'unitCost', titleKey: TEXT.colUnitCost, render: (row, t) => formatMoney(row.stock?.unitCost, t) },
      signals(),
    ],
  },
  { pane: 'zeroStock', titleKey: TEXT.paneZeroStock, columns: [product, estOos, signals()] },
  { pane: 'dataReadiness', titleKey: TEXT.paneDataReadiness, columns: [product, stock, signals({ reasons: true })] },
  {
    pane: 'performanceReview',
    titleKey: TEXT.panePerformanceReview,
    columns: [product, signals({ band: true, trend: true })],
  },
  { pane: 'untieredProducts', titleKey: TEXT.paneUntieredProducts, columns: [product, stock, signals()] },
];
