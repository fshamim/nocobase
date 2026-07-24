/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Tag } from 'antd';
import React from 'react';
import {
  ORDER_LIFECYCLE_STATUS_METADATA,
  canonicalOrderLifecycleStatus,
} from '../../../order-planning/order-lifecycle-status';

const PILL_STYLE: React.CSSProperties = { borderRadius: 999, marginInlineEnd: 0 };
const TINY_PILL_STYLE: React.CSSProperties = { ...PILL_STYLE, fontSize: 11, paddingInline: 7 };

/** Lifecycle status pill using the order-lifecycle metadata colour. */
export function LifecycleStatusPill({ status }: { status?: string | null }) {
  const canonical = canonicalOrderLifecycleStatus(status);
  if (!canonical) {
    return status ? <Tag style={PILL_STYLE}>{status}</Tag> : null;
  }
  const meta = ORDER_LIFECYCLE_STATUS_METADATA[canonical];
  return (
    <Tag color={meta.color} style={PILL_STYLE}>
      {canonical}
    </Tag>
  );
}

function normalize(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

/** Amazon-check pill (sheet "AM Status"): Cleared=green, OOS=orange, Rejected=red, In Progress=blue. */
export function AmazonCheckPill({ status }: { status?: string | null }) {
  const key = normalize(status);
  if (!key) return null;
  let color: string | undefined;
  if (key.includes('clear')) color = 'green';
  else if (key.includes('oos') || key.includes('out of stock')) color = 'orange';
  else if (key.includes('reject')) color = 'red';
  else if (key.includes('progress')) color = 'blue';
  return (
    <Tag color={color} style={TINY_PILL_STYLE}>
      {status}
    </Tag>
  );
}

/** Amazon receipt pill (silver amazonReceiptStatus). */
export function ReceiptPill({
  status,
  observed,
  ordered,
  observedLabel,
  awaitingLabel,
}: {
  status?: string | null;
  observed: number;
  ordered: number;
  observedLabel: string;
  awaitingLabel: string;
}) {
  const key = normalize(status);
  if (key === 'amazon_stock_observed' || key === 'partially_observed' || key === 'completed_by_later_inbound') {
    return (
      <Tag color="blue" style={TINY_PILL_STYLE}>
        {observedLabel} {observed}/{ordered}
      </Tag>
    );
  }
  if (observed > 0) {
    return (
      <Tag color="blue" style={TINY_PILL_STYLE}>
        {observedLabel} {observed}/{ordered}
      </Tag>
    );
  }
  return <Tag style={TINY_PILL_STYLE}>{awaitingLabel}</Tag>;
}
