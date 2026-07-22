/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * W2 StockBuckets (T7, R2): total prominent + one pill per bucket. Pills are
 * colored when > 0 and gray/outline when 0 or null; the AWD pill appears only
 * when > 0. Compact labels (<= 3 letters) in table cells, full words in drawers.
 */

import { Tag, Typography } from 'antd';
import React from 'react';
import type { DashboardRowStock } from '../../server/contract';
import { TEXT } from '../dashboard-text';
import { DASHBOARD_TAG_COLORS } from '../dashboard-tokens';
import { formatNumber, type Translate } from '../format';

interface BucketSpec {
  key: string;
  compactLabel: string;
  fullLabel: string;
  value: number | null;
  /** AWD only renders when positive. */
  hideWhenEmpty?: boolean;
}

function buckets(stock: DashboardRowStock): BucketSpec[] {
  return [
    { key: 'fba', compactLabel: TEXT.bucketFba, fullLabel: TEXT.bucketFba, value: stock.sellableStock },
    { key: 'rsv', compactLabel: TEXT.bucketRsv, fullLabel: TEXT.bucketReserved, value: stock.reservedStock },
    { key: 'inb', compactLabel: TEXT.bucketInb, fullLabel: TEXT.bucketInbound, value: stock.inboundStock },
    { key: 'prep', compactLabel: TEXT.bucketPrep, fullLabel: TEXT.bucketPrep, value: stock.prepStock },
    { key: 'ord', compactLabel: TEXT.bucketOrd, fullLabel: TEXT.bucketOrdered, value: stock.orderedStock },
    { key: 'awd', compactLabel: TEXT.bucketAwd, fullLabel: TEXT.bucketAwd, value: stock.awdStock, hideWhenEmpty: true },
  ];
}

export function StockBuckets({
  stock,
  t,
  variant = 'compact',
}: {
  stock: DashboardRowStock;
  t: Translate;
  variant?: 'compact' | 'full';
}) {
  const visible = buckets(stock).filter((bucket) => !bucket.hideWhenEmpty || (bucket.value ?? 0) > 0);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <Typography.Text strong style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>
        {formatNumber(stock.currentPlanningStock, t)}
        <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
          {t(TEXT.unitsSuffix)}
        </Typography.Text>
      </Typography.Text>
      <span
        style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 2, maxWidth: variant === 'compact' ? 200 : undefined }}
      >
        {visible.map((bucket) => {
          const positive = (bucket.value ?? 0) > 0;
          return (
            <Tag
              key={bucket.key}
              color={positive ? DASHBOARD_TAG_COLORS.info : DASHBOARD_TAG_COLORS.neutral}
              bordered
              style={{ marginInlineEnd: 2, borderRadius: 999, fontSize: 10.5, lineHeight: '16px' }}
            >
              {`${t(variant === 'compact' ? bucket.compactLabel : bucket.fullLabel)} `}
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{bucket.value ?? 0}</b>
            </Tag>
          );
        })}
      </span>
    </span>
  );
}
