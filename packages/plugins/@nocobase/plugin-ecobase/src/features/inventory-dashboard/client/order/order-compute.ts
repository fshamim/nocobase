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
