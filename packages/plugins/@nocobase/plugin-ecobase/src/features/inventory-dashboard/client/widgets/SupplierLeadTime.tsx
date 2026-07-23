/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * W4 SupplierLeadTime (T7, R4): supplier name + `<lead> + <buffer> d` + a
 * freshness dot (green when 'fresh', red otherwise) + a ghost "N d old" pill
 * when the lead time was last confirmed long ago. The buffer number comes from
 * the header settings (never hardcoded on the client).
 */

import { Tag, Tooltip, Typography } from 'antd';
import React from 'react';
import type { DashboardRowSupplier } from '../../server/contract';
import { TEXT } from '../dashboard-text';
import { EM_DASH, type Translate } from '../format';

const MS_PER_DAY = 86_400_000;

export function SupplierLeadTime({
  supplier,
  fbaReceivingBufferDays,
  t,
  now,
}: {
  supplier: DashboardRowSupplier;
  fbaReceivingBufferDays: number | null;
  t: Translate;
  now?: Date;
}) {
  if (!supplier.name && supplier.leadTimeDays === null) {
    return <Typography.Text type="secondary">{EM_DASH}</Typography.Text>;
  }
  const fresh = supplier.leadTimeFreshness === 'fresh';
  const confirmedMs = supplier.leadTimeConfirmedAt ? Date.parse(supplier.leadTimeConfirmedAt) : NaN;
  const ageDays = Number.isNaN(confirmedMs)
    ? null
    : Math.max(0, Math.floor(((now ?? new Date()).getTime() - confirmedMs) / MS_PER_DAY));
  // T-QA1 a11y: the dot now carries a tooltip + aria-label, worded like the ghost pill.
  const freshnessLabel = fresh
    ? t(TEXT.leadTimeFreshLabel)
    : ageDays !== null
      ? `${t(TEXT.leadTimeStaleLabel)} ${ageDays} ${t(TEXT.dOldSuffix)}`
      : `${t(TEXT.leadTimeStaleLabel)} ${supplier.leadTimeFreshness ?? t(TEXT.unknown)}`;
  const leadText =
    supplier.leadTimeDays !== null
      ? fbaReceivingBufferDays !== null
        ? `${supplier.leadTimeDays} + ${fbaReceivingBufferDays} ${t(TEXT.dSuffix)}`
        : `${supplier.leadTimeDays} ${t(TEXT.dSuffix)}`
      : EM_DASH;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
      <Tooltip title={freshnessLabel}>
        <span
          role="img"
          aria-label={freshnessLabel}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flex: 'none',
            background: fresh ? '#389e0d' : '#cf1322',
          }}
        />
      </Tooltip>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {supplier.name ? `${supplier.name} · ${leadText}` : leadText}
      </Typography.Text>
      {!fresh && ageDays !== null ? (
        <Tag bordered style={{ borderRadius: 999, borderStyle: 'dashed', fontSize: 10.5, color: 'rgba(0,0,0,0.45)' }}>
          {`${ageDays} ${t(TEXT.dOldSuffix)}`}
        </Tag>
      ) : null}
    </span>
  );
}
