/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Client mirror of the workbench margin/total math (Order Create/View UI). Kept
 * tiny and dependency-free so the create modal can show live totals without a
 * round-trip; the server recomputes authoritatively on submit.
 */

export function lineMargin(sellPrice?: number | null, unitCost?: number | null): number | undefined {
  if (typeof sellPrice !== 'number' || typeof unitCost !== 'number' || sellPrice <= 0) return undefined;
  return Math.round(((sellPrice - unitCost) / sellPrice) * 1000) / 10;
}

export function lineTotal(qty?: number | null, unitCost?: number | null): number | undefined {
  if (typeof qty !== 'number' || typeof unitCost !== 'number') return undefined;
  return Math.round(qty * unitCost * 100) / 100;
}

export function sumLineTotals(lines: Array<{ orderedQty?: number | null; unitCost?: number | null }>): number {
  return (
    Math.round(lines.reduce((total, line) => total + (lineTotal(line.orderedQty, line.unitCost) ?? 0), 0) * 100) / 100
  );
}

export function sumUnits(lines: Array<{ orderedQty?: number | null }>): number {
  return lines.reduce((total, line) => total + (typeof line.orderedQty === 'number' ? line.orderedQty : 0), 0);
}

// ---- paperwork chain (drawer T5) ------------------------------------------
// getOrderDetail does not return the derived paperwork tuple that paneOrders does,
// so the drawer derives the same APPR → ORDER → PAY → INV chain client-side. These
// rules mirror deriveOrderPaperworkMilestones in order-workbench-compute.ts exactly.

import type { MilestoneStateValue, OrderMilestone, OrderPaperwork } from './order-api';

const CANONICAL_PROGRESSION = [
  'draft',
  'supplier_contacted',
  'supplier_confirmed',
  'approval_pending',
  'payment_pending',
  'paid',
  'supplier_preparing',
  'shipped_inbound',
  'completed',
];

function includesAny(raw: string | undefined | null, needles: string[]): boolean {
  if (typeof raw !== 'string') return false;
  const lower = raw.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function isBlockedRaw(raw?: string | null): boolean {
  return includesAny(raw, ['block', 'reject', 'hold']);
}

export function deriveClientPaperwork(header: {
  orderApproval?: string;
  canonicalStatus?: string;
  lifecycleStatus?: string;
  paymentStatus?: string;
  paymentMode?: string;
  invoiceStatus?: string;
}): OrderPaperwork {
  const approvalRaw = header.orderApproval;
  const orderRaw = header.lifecycleStatus ?? header.canonicalStatus;
  const paymentRaw = header.paymentStatus;
  const invoiceRaw = header.invoiceStatus;
  const canonicalIndex = CANONICAL_PROGRESSION.indexOf((header.canonicalStatus ?? '').toLowerCase());
  const paymentPendingIndex = CANONICAL_PROGRESSION.indexOf('payment_pending');
  const done = [
    includesAny(approvalRaw, ['approved']),
    canonicalIndex !== -1 && canonicalIndex > paymentPendingIndex,
    includesAny(paymentRaw, ['completed', 'complete', 'paid']),
    includesAny(invoiceRaw, ['uploaded', 'received', 'paid']),
  ];
  const raws = [approvalRaw, orderRaw, paymentRaw, invoiceRaw];
  const currentIndex = done.findIndex((value) => !value);
  const build = (index: number): OrderMilestone => {
    const raw = raws[index];
    let state: MilestoneStateValue;
    if (isBlockedRaw(raw)) state = 'blocked';
    else if (done[index]) state = 'done';
    else if (index === currentIndex) state = 'current';
    else state = 'pending';
    const milestone: OrderMilestone = { state };
    if (raw && raw.trim()) milestone.raw = raw;
    if (index === 2 && done[2] && header.paymentMode && header.paymentMode.trim()) {
      milestone.paymentMode = header.paymentMode;
    }
    return milestone;
  };
  return { approval: build(0), order: build(1), payment: build(2), invoice: build(3) };
}
