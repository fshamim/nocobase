/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { DASHBOARD_PANE_KEYS, isPaneKey } from '../contract';
import { COVERAGE_MATRIX, GOLD_ROWS, SILVER_ORDERS } from './fixtures/dashboard-fixtures';

describe('Inventory Dashboard contract + G0 fixture matrix', () => {
  const goldById = new Map(GOLD_ROWS.map((row) => [row.id, row]));
  const silverById = new Map(SILVER_ORDERS.map((order) => [order.id, order]));

  it('covers all 14 matrix items with existing, provenance-tagged fixtures', () => {
    expect(COVERAGE_MATRIX.map((entry) => entry.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    for (const entry of COVERAGE_MATRIX) {
      expect(entry.goldRowIds.length, `item ${entry.item} references gold rows`).toBeGreaterThan(0);
      for (const id of entry.goldRowIds) {
        expect(goldById.has(id), `item ${entry.item} gold row ${id} exists`).toBe(true);
      }
      for (const id of entry.silverOrderIds) {
        expect(silverById.has(id), `item ${entry.item} silver order ${id} exists`).toBe(true);
      }
      expect(['harvested', 'synthetic']).toContain(entry.provenance);
    }
  });

  it('tags every fixture row with a valid provenance', () => {
    for (const row of GOLD_ROWS) expect(['harvested', 'synthetic']).toContain(row.provenance);
    for (const order of SILVER_ORDERS) expect(['harvested', 'synthetic']).toContain(order.provenance);
  });

  it('uses only valid pane keys (plus the never-served adminExcluded)', () => {
    for (const row of GOLD_ROWS) {
      expect(isPaneKey(row.primaryActionPane) || row.primaryActionPane === 'adminExcluded').toBe(true);
    }
  });

  it('represents every one of the 11 dashboard panes in the published run', () => {
    const served = new Set(GOLD_ROWS.map((row) => row.primaryActionPane).filter(isPaneKey));
    for (const pane of DASHBOARD_PANE_KEYS) {
      expect(served.has(pane), `pane ${pane} represented`).toBe(true);
    }
  });

  it('includes the structural edge cases the service layer depends on (G0)', () => {
    // Item 6: an adminExcluded row exists and must be filtered out downstream.
    expect(GOLD_ROWS.some((row) => row.primaryActionPane === 'adminExcluded')).toBe(true);
    // Item 7: an untiered row parked in an operational pane (untiered_projected source).
    expect(
      GOLD_ROWS.some(
        (row) =>
          row.primaryActionPane === 'healthyInventory' &&
          !row.baselineTier &&
          !row.currentProjectedTier &&
          !row.lastClosedMonthTier,
      ),
    ).toBe(true);
    // Item 10: an order row whose supplierOrderId has no silver order.
    const orphan = goldById.get('f10-orphan-order');
    expect(orphan?.supplierOrderId).toBeTruthy();
    expect(silverById.has(orphan?.supplierOrderId ?? '')).toBe(false);
    // Item 12: null stage-entered timestamp.
    expect(silverById.get('order-12')?.workflowStageEnteredAt).toBeNull();
    // Item 13: a family split across >= 2 panes.
    const family13 = GOLD_ROWS.filter((row) => row.companyProductFamilyId === 'family-13');
    expect(new Set(family13.map((row) => row.primaryActionPane)).size).toBeGreaterThanOrEqual(2);
  });
});
