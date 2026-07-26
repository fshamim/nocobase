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
  type OrderLifecycleStatus,
} from '../../../order-planning/order-lifecycle-status';

const PILL_STYLE: React.CSSProperties = { borderRadius: 999, marginInlineEnd: 0 };
const TINY_PILL_STYLE: React.CSSProperties = { ...PILL_STYLE, fontSize: 11, paddingInline: 7 };

/**
 * Dashboard-local pill colours (issue 053 item 1). The Active-orders prototype
 * renders ORDER ANALYSING as `.pill.blue`, not the lifecycle metadata's purple.
 * The override lives here rather than in `ORDER_LIFECYCLE_STATUS_METADATA` because
 * that map is shared with the order-planning feature, which this feature does not
 * get to restyle.
 *
 * Only ORDER ANALYSING is overridden: the prototype paints the same status two
 * different colours in different rows (INBOUND MONITORING is blue on one row and
 * orange on another), so beyond the status QA flagged it is not a colour spec.
 */
const PILL_COLOR_OVERRIDES: Partial<Record<OrderLifecycleStatus, string>> = {
  'ORDER ANALYSING': 'blue',
};

/** Lifecycle status pill using the order-lifecycle metadata colour. */
export function LifecycleStatusPill({ status, fallbackLabel }: { status?: string | null; fallbackLabel?: string }) {
  const canonical = canonicalOrderLifecycleStatus(status);
  if (!canonical) {
    // Imported orders can carry a blank lifecycle status; the layout still needs
    // a pill (QA order-panes round 1), so render the raw value or the fallback.
    const text = status ?? fallbackLabel;
    return text ? <Tag style={PILL_STYLE}>{text}</Tag> : null;
  }
  const meta = ORDER_LIFECYCLE_STATUS_METADATA[canonical];
  return (
    <Tag color={PILL_COLOR_OVERRIDES[canonical] ?? meta.color} style={PILL_STYLE}>
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
