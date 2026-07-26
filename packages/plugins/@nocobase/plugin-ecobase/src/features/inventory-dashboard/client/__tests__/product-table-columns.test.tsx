/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 063 T1: the shared product table.
 *
 * D1 — all seven product panes must reference the SAME column and sort arrays
 * (identity, not deep equality: two panes that merely LOOK alike would drift).
 * D2 — outside Supply Action the action column may only voice evidence-driven
 * verdicts; the ordering commands become an em-dash.
 */

import { App } from 'antd';
import React from 'react';
import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DashboardRow, PaneKey } from '../../server/contract';
import paneSupplyAction from '../../server/__tests__/fixtures/expected-responses/pane-supplyAction.json';
import { EM_DASH } from '../format';
import { PANE_CONFIGS } from '../pane-configs';
import { PRODUCT_TABLE_COLUMNS, PRODUCT_TABLE_SORT_OPTIONS } from '../product-table-columns';
import { actionPillFor, type ActionPillVerdict } from '../widgets/ActionPill';

const t = (value: string) => value;

const ENRICHED = (paneSupplyAction as { rows: DashboardRow[] }).rows.find(
  (row) => row.identity.asin === 'B0011A',
) as DashboardRow;

function rowWith(overrides: Partial<DashboardRow>): DashboardRow {
  return { ...ENRICHED, ...overrides } as DashboardRow;
}

const PRODUCT_PANES: PaneKey[] = [
  'supplyAction',
  'healthyInventory',
  'excessInventory',
  'stuckInventory',
  'zeroStock',
  'untieredProducts',
  'discontinuedPaused',
];

describe('063-D1: one product-table column set', () => {
  it('all seven product panes share the EXACT column and sort arrays', () => {
    for (const pane of PRODUCT_PANES) {
      const config = PANE_CONFIGS.find((candidate) => candidate.pane === pane);
      expect(config, `missing ${pane} config`).toBeDefined();
      expect(config?.columns, `${pane} must reuse the product columns`).toBe(PRODUCT_TABLE_COLUMNS);
      expect(config?.sortOptions, `${pane} must reuse the product sort options`).toBe(PRODUCT_TABLE_SORT_OPTIONS);
    }
  });

  it('is the eight Supply Action columns in mockup reading order', () => {
    expect(PRODUCT_TABLE_COLUMNS.map((column) => column.key)).toEqual([
      'family',
      'stock',
      'velocity',
      'orderBy',
      'orderQty',
      'moneyAtRisk',
      'lastActivity',
      'action',
    ]);
    expect(PRODUCT_TABLE_SORT_OPTIONS).toHaveLength(5);
    // The server default stays the unlabelled first option (no fake 'tier' key).
    expect(PRODUCT_TABLE_SORT_OPTIONS[0].value).toBeUndefined();
  });

  it('leaves the non-product panes alone', () => {
    // Discontinued & paused keeps its own search box (task 002).
    expect(PANE_CONFIGS.find((config) => config.pane === 'discontinuedPaused')?.showPaneSearch).toBe(true);
    // Order panes + the last v1 signal pane keep their own tables.
    // 066-D2: dataReadiness left this list — it has its own workbench table
    // (own columns, `issues` cluster instead of `signals`), asserted in
    // data-issues-workbench.test.tsx.
    for (const pane of ['activeOrders', 'inPrepMonitoring', 'inboundMonitoring', 'performanceReview'] as PaneKey[]) {
      const config = PANE_CONFIGS.find((candidate) => candidate.pane === pane);
      expect(config?.columns, `${pane} must keep its own columns`).not.toBe(PRODUCT_TABLE_COLUMNS);
      expect(config?.columns.some((column) => column.key === 'signals'), `${pane} keeps its signals cluster`).toBe(
        true,
      );
    }
    const dataIssues = PANE_CONFIGS.find((candidate) => candidate.pane === 'dataReadiness');
    expect(dataIssues?.columns, 'dataReadiness must keep its own columns').not.toBe(PRODUCT_TABLE_COLUMNS);
  });
});

describe('063-D2: the action column speaks only where it is truthful', () => {
  const actionColumn = PRODUCT_TABLE_COLUMNS.find((column) => column.key === 'action');
  if (!actionColumn) throw new Error('missing action column');

  const fresh = { ...ENRICHED.supplier, leadTimeFreshness: 'fresh' as const };
  const trusted = { ...ENRICHED.velocity, basis: 'rolling_30' };
  // One row per verdict, mirroring the ActionPill precedence table.
  const VERDICT_ROWS: Array<{ key: ActionPillVerdict['key']; evidence: boolean; overrides: Partial<DashboardRow> }> = [
    { key: 'overdue', evidence: true, overrides: { daysUntilSafeReorder: -3, supplier: fresh, velocity: trusted } },
    {
      key: 'refresh_lead_time',
      evidence: true,
      overrides: {
        daysUntilSafeReorder: 20,
        supplier: { ...ENRICHED.supplier, leadTimeFreshness: 'stale' },
        velocity: trusted,
      },
    },
    {
      key: 'verify_velocity',
      evidence: true,
      overrides: {
        daysUntilSafeReorder: 20,
        supplier: fresh,
        velocity: { ...ENRICHED.velocity, basis: 'baseline_average' },
      },
    },
    {
      key: 'order_this_week',
      evidence: false,
      overrides: { daysUntilSafeReorder: 6.5, supplier: fresh, velocity: trusted },
    },
    { key: 'order_soon', evidence: false, overrides: { daysUntilSafeReorder: 20, supplier: fresh, velocity: trusted } },
  ];

  for (const { key, evidence, overrides } of VERDICT_ROWS) {
    it(`${key}: pill on Supply Action, ${evidence ? 'pill' : 'em-dash'} on a parked pane`, () => {
      const supply = rowWith({ ...overrides, pane: 'supplyAction' });
      expect(actionPillFor(supply).key, 'fixture row must produce the verdict under test').toBe(key);
      const pillText = actionPillFor(supply).textKey;

      // Supply Action is unchanged: every verdict still speaks.
      const onSupplyAction = render(<App>{actionColumn.render(supply, t)}</App>);
      expect(within(onSupplyAction.container).getByText(pillText)).toBeTruthy();
      expect(within(onSupplyAction.container).queryByText(EM_DASH)).toBeNull();

      // Excess inventory: an ordering COMMAND would be a wrong recommendation.
      const parked = render(<App>{actionColumn.render(rowWith({ ...overrides, pane: 'excessInventory' }), t)}</App>);
      if (evidence) {
        expect(within(parked.container).getByText(pillText)).toBeTruthy();
        expect(within(parked.container).queryByText(EM_DASH)).toBeNull();
      } else {
        expect(within(parked.container).getByText(EM_DASH)).toBeTruthy();
        expect(within(parked.container).queryByText(pillText)).toBeNull();
      }
    });
  }
});
