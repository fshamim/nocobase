/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Shared, presentational milestone chips (Order panes T4 / drawer T5). The
 * paperwork chain (APPR → ORDER → PAY → INV) and the prep chain
 * (TRANSIT → AT PREP → PREP → READY) are rendered from server- or client-derived
 * tuples; every colour/glyph encodes state (done ✓ green · current blue · pending
 * grey · blocked ⚠ red).
 */

import { Tag } from 'antd';
import React from 'react';
import { TEXT } from '../dashboard-text';
import type { Translate } from '../format';
import type { MilestoneStateValue, OrderMilestone, OrderPaperwork, OrderPrep, PrepMilestoneState } from './order-api';

const MILE_STYLE: React.CSSProperties = {
  borderRadius: 999,
  marginInlineEnd: 0,
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.03em',
  paddingInline: 8,
};
const TINY_PILL_STYLE: React.CSSProperties = { borderRadius: 999, marginInlineEnd: 0, fontSize: 11, paddingInline: 7 };
const CHAIN_STYLE: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' };
const HINT_STYLE: React.CSSProperties = { fontSize: 11, color: 'rgba(0,0,0,0.45)' };

function stateColor(state: MilestoneStateValue | PrepMilestoneState): string | undefined {
  if (state === 'done') return 'green';
  if (state === 'current') return 'blue';
  if (state === 'blocked') return 'red';
  return undefined;
}

function statePrefix(state: MilestoneStateValue | PrepMilestoneState): string {
  if (state === 'done') return '✓ ';
  if (state === 'blocked') return '⚠ ';
  return '';
}

/** One milestone chip; `raw` is exposed as the hover title so the raw sheet value stays discoverable. */
export function MilestonePill({
  label,
  state,
  raw,
  suffix,
}: {
  label: string;
  state: MilestoneStateValue | PrepMilestoneState;
  raw?: string;
  suffix?: string;
}) {
  return (
    <Tag color={stateColor(state)} title={raw} style={MILE_STYLE}>
      {statePrefix(state)}
      {label}
      {suffix ? ` · ${suffix}` : ''}
    </Tag>
  );
}

/** APPR → ORDER → PAY → INV paperwork chain (Active-orders pane + drawer). */
export function PaperworkChain({ paperwork, t }: { paperwork: OrderPaperwork; t: Translate }) {
  const items: Array<{ label: string; milestone: OrderMilestone }> = [
    { label: t(TEXT.opMileAppr), milestone: paperwork.approval },
    { label: t(TEXT.opMileOrder), milestone: paperwork.order },
    { label: t(TEXT.opMilePay), milestone: paperwork.payment },
    { label: t(TEXT.opMileInv), milestone: paperwork.invoice },
  ];
  return (
    <span style={CHAIN_STYLE} aria-label={t(TEXT.drawerStatus)}>
      {items.map(({ label, milestone }) => (
        <MilestonePill
          key={label}
          label={label}
          state={milestone.state}
          raw={milestone.raw}
          suffix={milestone.state === 'done' ? milestone.paymentMode : undefined}
        />
      ))}
    </span>
  );
}

/** TRANSIT → AT PREP → PREP → READY prep chain + measured hint (In-prep pane). */
export function PrepChain({ prep, t }: { prep: OrderPrep; t: Translate }) {
  const items: Array<{ label: string; state: PrepMilestoneState }> = [
    { label: t(TEXT.opMileTransit), state: prep.transit },
    { label: t(TEXT.opMileAtPrep), state: prep.atPrep },
    { label: t(TEXT.opPillPrep), state: prep.prep },
    { label: t(TEXT.opMileReady), state: prep.ready },
  ];
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={CHAIN_STYLE}>
        {items.map(({ label, state }) => (
          <MilestonePill key={label} label={label} state={state} />
        ))}
      </span>
      <span style={HINT_STYLE}>{prep.prepMeasured ? t(TEXT.opMeasured) : t(TEXT.opNotMeasured)}</span>
    </span>
  );
}

/** FBA (blue) / PREP (purple) supplier ship-destination pill; nothing when unknown. */
export function SupplierShipPill({
  shipDestination,
  t,
}: {
  shipDestination: 'direct_fba' | 'prep_center' | null;
  t: Translate;
}) {
  if (shipDestination === 'direct_fba') {
    return (
      <Tag color="blue" style={TINY_PILL_STYLE}>
        {t(TEXT.bucketFba)}
      </Tag>
    );
  }
  if (shipDestination === 'prep_center') {
    return (
      <Tag color="purple" style={TINY_PILL_STYLE}>
        {t(TEXT.opPillPrep)}
      </Tag>
    );
  }
  return null;
}
