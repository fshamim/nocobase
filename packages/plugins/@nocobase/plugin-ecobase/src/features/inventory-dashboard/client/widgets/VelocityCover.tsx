/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * W3 VelocityCover (T7, R3): rate + cover days + OOS date in one cluster.
 * A fallback velocity basis (anything other than 'rolling_30') wears the ghost
 * "estimate — from <MMM>" pill; a null basis renders an em-dash and invents
 * NOTHING. The OOS date turns danger-red when it is 14 days away or less.
 */

import { Tag, Typography } from 'antd';
import React from 'react';
import type { DashboardRow } from '../../server/contract';
import { TEXT } from '../dashboard-text';
import { daysFromNow, EM_DASH, formatMonth, formatMonthDay, type Translate } from '../format';

const OOS_DANGER_WINDOW_DAYS = 14;

export function isFallbackVelocityBasis(basis: string | null): boolean {
  return basis !== null && basis !== 'rolling_30' && basis !== 'none';
}

export function VelocityCover({ row, t, now }: { row: DashboardRow; t: Translate; now?: Date }) {
  const velocity = row.velocity;
  if (velocity.value === null || velocity.basis === null || velocity.basis === 'none') {
    return <Typography.Text type="secondary">{EM_DASH}</Typography.Text>;
  }
  const coverDays = row.daysOfCover ?? row.positionDaysOfCover;
  const oosDate = row.estimatedOosDate ?? row.positionEstimatedOosDate;
  const oosIn = daysFromNow(oosDate, now);
  const oosHot = oosIn !== null && oosIn <= OOS_DANGER_WINDOW_DAYS;
  const fallback = isFallbackVelocityBasis(velocity.basis);
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      <Typography.Text strong>{velocity.value.toFixed(1)}</Typography.Text>
      <Typography.Text type="secondary">{t(TEXT.perDay)}</Typography.Text>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        {coverDays !== null ? (
          <>
            <Typography.Text strong style={{ fontSize: 12 }}>
              {`${Math.round(coverDays)} ${t(TEXT.dSuffix)}`}
            </Typography.Text>
            {` ${t(TEXT.coverWord)}`}
          </>
        ) : (
          EM_DASH
        )}
        {oosDate ? (
          <>
            {' · '}
            <Typography.Text strong={oosHot} type={oosHot ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
              {`${t(TEXT.oosPrefix)} ${formatMonthDay(oosDate)}`}
            </Typography.Text>
          </>
        ) : null}
      </Typography.Text>
      {fallback ? (
        <Tag
          bordered
          style={{ marginTop: 2, borderRadius: 999, borderStyle: 'dashed', fontSize: 10.5, color: 'rgba(0,0,0,0.45)' }}
        >
          {`${t(TEXT.estimateFromPrefix)} ${formatMonth(velocity.asOfDate)}`}
        </Tag>
      ) : null}
    </span>
  );
}
