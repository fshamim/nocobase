/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * W6 ActionPill (T7, R8): ONE recommended next step per row, deterministic
 * precedence: (1) overdue, (2) stale lead time, (3) estimated velocity,
 * (4) due within a week, (5) order soon.
 */

import { Tag } from 'antd';
import React from 'react';
import type { DashboardRow } from '../../server/contract';
import { TEXT } from '../dashboard-text';
import { DASHBOARD_TAG_COLORS, type DashboardTagColor } from '../dashboard-tokens';
import { isFallbackVelocityBasis } from './VelocityCover';
import type { Translate } from '../format';

export interface ActionPillVerdict {
  key: 'overdue' | 'refresh_lead_time' | 'verify_velocity' | 'order_this_week' | 'order_soon';
  textKey: string;
  color: DashboardTagColor;
}

const ORDER_THIS_WEEK_WINDOW_DAYS = 7;

export function actionPillFor(row: DashboardRow): ActionPillVerdict {
  if (row.daysUntilSafeReorder !== null && row.daysUntilSafeReorder <= 0) {
    return { key: 'overdue', textKey: TEXT.actionOverdue, color: DASHBOARD_TAG_COLORS.danger };
  }
  if (row.supplier.leadTimeFreshness !== 'fresh') {
    return { key: 'refresh_lead_time', textKey: TEXT.actionRefreshLeadTime, color: DASHBOARD_TAG_COLORS.warning };
  }
  if (isFallbackVelocityBasis(row.velocity.basis)) {
    return { key: 'verify_velocity', textKey: TEXT.actionVerifyVelocity, color: DASHBOARD_TAG_COLORS.neutral };
  }
  if (row.daysUntilSafeReorder !== null && row.daysUntilSafeReorder <= ORDER_THIS_WEEK_WINDOW_DAYS) {
    return { key: 'order_this_week', textKey: TEXT.actionOrderThisWeek, color: DASHBOARD_TAG_COLORS.warning };
  }
  return { key: 'order_soon', textKey: TEXT.actionOrderSoon, color: DASHBOARD_TAG_COLORS.info };
}

export function ActionPill({ row, t }: { row: DashboardRow; t: Translate }) {
  const verdict = actionPillFor(row);
  return (
    <Tag color={verdict.color} style={{ borderRadius: 999, fontWeight: 600 }}>
      {t(verdict.textKey)}
    </Tag>
  );
}
