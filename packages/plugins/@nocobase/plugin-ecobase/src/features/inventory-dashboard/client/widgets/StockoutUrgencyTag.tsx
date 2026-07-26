/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T-D5 (approved OPEN-D5) badge, extracted for 063-D3: tiered near-stockout
 * families parked OUTSIDE the action panes wear this danger tag. It used to be
 * inlined in the Signals cluster; the shared product table has no Signals
 * column, so FamilyCell carries it there while the panes that keep the cluster
 * (Data Readiness, Performance Review) render the very same tag.
 */

import { Tag } from 'antd';
import React from 'react';
import type { DashboardRow } from '../../server/contract';
import { TEXT } from '../dashboard-text';
import { DASHBOARD_TAG_COLORS } from '../dashboard-tokens';
import type { Translate } from '../format';

export function StockoutUrgencyTag({ urgency, t }: { urgency: DashboardRow['stockoutUrgency']; t: Translate }) {
  if (!urgency) return null;
  const { daysUntil } = urgency;
  return (
    <Tag color={DASHBOARD_TAG_COLORS.danger}>
      {daysUntil <= 0 ? t(TEXT.urgentStockoutNow) : `${t(TEXT.urgentStockoutWithin)} ${daysUntil} ${t(TEXT.dSuffix)}`}
    </Tag>
  );
}
