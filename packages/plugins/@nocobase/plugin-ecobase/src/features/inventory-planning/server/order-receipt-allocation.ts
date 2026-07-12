/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface ReceiptAllocationLine {
  orderLineId: string;
  familyId: string;
  cycleAt: string;
  orderedQty: number;
  observedQty: number;
}

export interface ReceiptAllocation {
  orderLineId: string;
  allocatedQty: number;
  totalObservedQty: number;
  remainingQty: number;
}

export function allocateReceiptAdditionFifo(input: { observedAddition: number; lines: ReceiptAllocationLine[] }) {
  if (!Number.isFinite(input.observedAddition) || input.observedAddition < 0) {
    throw new Error('Amazon receipt FIFO allocation requires a non-negative observed addition.');
  }

  for (const line of input.lines) {
    if (!line.orderLineId || !line.familyId || !Number.isFinite(new Date(line.cycleAt).getTime())) {
      throw new Error(
        `Amazon receipt FIFO allocation received invalid identity or cycle date for line ${line.orderLineId}.`,
      );
    }
    if (
      !Number.isFinite(line.orderedQty) ||
      line.orderedQty < 0 ||
      !Number.isFinite(line.observedQty) ||
      line.observedQty < 0 ||
      line.observedQty > line.orderedQty
    ) {
      throw new Error(`Amazon receipt FIFO allocation received invalid quantities for line ${line.orderLineId}.`);
    }
  }

  let available = Math.max(
    0,
    input.observedAddition - input.lines.reduce((total, line) => total + line.observedQty, 0),
  );
  const allocations: ReceiptAllocation[] = [];
  for (const line of [...input.lines].sort(
    (left, right) => left.cycleAt.localeCompare(right.cycleAt) || left.orderLineId.localeCompare(right.orderLineId),
  )) {
    const allocatedQty = Math.min(available, line.orderedQty - line.observedQty);
    if (allocatedQty <= 0) continue;
    const totalObservedQty = line.observedQty + allocatedQty;
    allocations.push({
      orderLineId: line.orderLineId,
      allocatedQty,
      totalObservedQty,
      remainingQty: line.orderedQty - totalObservedQty,
    });
    available -= allocatedQty;
  }

  return {
    allocatedQty: allocations.reduce((total, allocation) => total + allocation.allocatedQty, 0),
    unallocatedQty: available,
    allocations,
  };
}
