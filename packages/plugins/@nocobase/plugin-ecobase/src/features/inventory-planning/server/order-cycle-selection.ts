/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface FamilyOrderCycleLine {
  lineId: string;
  orderId: string;
  orderRef?: string;
  authorityAsOf?: string;
  orderDate?: string;
  expectedArrivalDate?: string;
  expectedArrivalStatus?: string;
  amazonReceiptStatus?: string;
  openQty: number;
  coverageState: 'purchased_pipeline' | 'placed_not_purchased' | 'closed';
}

export interface FamilyOrderCycleDecision {
  orderId: string;
  orderRef?: string;
  decision: 'review_required';
  reason: string;
}

export interface FamilyOrderCycleSelection {
  selectedOrderId?: string;
  selectedOrderRef?: string;
  selectedLineIds: string[];
  selectedOpenQty: number;
  selectedCoverageState?: 'purchased_pipeline' | 'placed_not_purchased';
  excludedCycles: FamilyOrderCycleDecision[];
  reviewRequired: boolean;
}

const TERMINAL_RECEIPT_STATUSES = new Set(['amazon_stock_observed', 'completed_by_later_inbound']);

function validDate(value: string | undefined) {
  if (!value) return undefined;
  const time = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

export function selectCurrentFamilyOrderCycle(lines: FamilyOrderCycleLine[]): FamilyOrderCycleSelection {
  const activeLines = lines.filter(
    (line) =>
      line.openQty > 0 &&
      line.coverageState !== 'closed' &&
      !TERMINAL_RECEIPT_STATUSES.has(line.amazonReceiptStatus ?? ''),
  );
  const orderIds = [...new Set(activeLines.map((line) => line.orderId))];
  const orderLines = (orderId: string) => activeLines.filter((line) => line.orderId === orderId);
  const cycleSortKey = (orderId: string) => {
    const first = orderLines(orderId)[0];
    return [
      validDate(first?.authorityAsOf) ?? Number.NEGATIVE_INFINITY,
      validDate(first?.orderDate) ?? Number.NEGATIVE_INFINITY,
      first?.orderRef ?? '',
      orderId,
    ] as const;
  };
  const selectedOrderId = orderIds.sort((left, right) => {
    const leftKey = cycleSortKey(left);
    const rightKey = cycleSortKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] === rightKey[index]) continue;
      return leftKey[index] > rightKey[index] ? -1 : 1;
    }
    return 0;
  })[0];
  if (!selectedOrderId) {
    return { selectedLineIds: [], selectedOpenQty: 0, excludedCycles: [], reviewRequired: false };
  }

  const selectedLines = orderLines(selectedOrderId);
  const selected = selectedLines[0];
  const selectedHasCycleDate =
    validDate(selected.authorityAsOf) !== undefined || validDate(selected.orderDate) !== undefined;
  const excludedCycles = orderIds.slice(1).map<FamilyOrderCycleDecision>((orderId) => {
    const older = orderLines(orderId)[0];
    const ambiguousCycleOrder =
      !selectedHasCycleDate ||
      (validDate(older.authorityAsOf) === undefined && validDate(older.orderDate) === undefined);
    return {
      orderId,
      orderRef: older.orderRef,
      decision: 'review_required',
      reason: ambiguousCycleOrder ? 'ambiguous_cycle_order' : 'later_cycle_exists_without_terminal_receipt_evidence',
    };
  });

  return {
    selectedOrderId,
    selectedOrderRef: selected.orderRef,
    selectedLineIds: selectedLines.map((line) => line.lineId).sort(),
    selectedOpenQty: selectedLines.reduce((total, line) => total + line.openQty, 0),
    selectedCoverageState: selected.coverageState,
    excludedCycles,
    reviewRequired: excludedCycles.some((cycle) => cycle.decision === 'review_required'),
  };
}
