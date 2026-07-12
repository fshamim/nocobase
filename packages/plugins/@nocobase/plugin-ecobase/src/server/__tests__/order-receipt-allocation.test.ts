/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { allocateReceiptAdditionFifo } from '../../features/inventory-planning/server/order-receipt-allocation';

describe('Amazon receipt FIFO allocation', () => {
  it('allocates observed additions to the oldest compatible open lines without exceeding ordered quantity', () => {
    expect(
      allocateReceiptAdditionFifo({
        observedAddition: 15,
        lines: [
          {
            orderLineId: 'line-b',
            familyId: 'family-1',
            cycleAt: '2026-07-11T00:00:00.000Z',
            orderedQty: 10,
            observedQty: 0,
          },
          {
            orderLineId: 'line-a',
            familyId: 'family-1',
            cycleAt: '2026-07-10T00:00:00.000Z',
            orderedQty: 10,
            observedQty: 0,
          },
        ],
      }),
    ).toEqual({
      allocatedQty: 15,
      unallocatedQty: 0,
      allocations: [
        { orderLineId: 'line-a', allocatedQty: 10, totalObservedQty: 10, remainingQty: 0 },
        { orderLineId: 'line-b', allocatedQty: 5, totalObservedQty: 5, remainingQty: 5 },
      ],
    });
  });

  it('keeps prior allocation idempotent and leaves excess stock unallocated', () => {
    expect(
      allocateReceiptAdditionFifo({
        observedAddition: 16,
        lines: [
          {
            orderLineId: 'line-a',
            familyId: 'family-1',
            cycleAt: '2026-07-10T00:00:00.000Z',
            orderedQty: 10,
            observedQty: 8,
          },
          {
            orderLineId: 'line-b',
            familyId: 'family-1',
            cycleAt: '2026-07-11T00:00:00.000Z',
            orderedQty: 3,
            observedQty: 0,
          },
        ],
      }),
    ).toEqual({
      allocatedQty: 5,
      unallocatedQty: 3,
      allocations: [
        { orderLineId: 'line-a', allocatedQty: 2, totalObservedQty: 10, remainingQty: 0 },
        { orderLineId: 'line-b', allocatedQty: 3, totalObservedQty: 3, remainingQty: 0 },
      ],
    });
  });

  it('rejects invalid quantities explicitly', () => {
    expect(() =>
      allocateReceiptAdditionFifo({
        observedAddition: -1,
        lines: [],
      }),
    ).toThrow('Amazon receipt FIFO allocation requires a non-negative observed addition.');
  });
});
