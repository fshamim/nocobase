/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * 066 T1 — the "Data issues" workbench table (display only).
 *
 * Row fixtures come from the server-emitted snapshots; only the fields under
 * test are overridden, because the live pane carries reason vocabulary this
 * fixture set predates (F1: `frozen_family_target_review` +
 * `missing_or_invalid_baseline_evidence` are the only live codes).
 *
 * T3 turns the cluster's resolvable codes into buttons; everything asserted
 * here about columns, order and inertness is the contract it must preserve.
 */

import { App } from 'antd';
import React from 'react';
import { render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardRow } from '../../server/contract';
import paneDataReadiness from '../../server/__tests__/fixtures/expected-responses/pane-dataReadiness.json';
import paneSupplyAction from '../../server/__tests__/fixtures/expected-responses/pane-supplyAction.json';
import { TEXT } from '../dashboard-text';
import { DATA_ISSUES_COLUMNS } from '../data-issues-columns';
import { PANE_CONFIGS, type PaneColumnConfig } from '../pane-configs';
import { PRODUCT_TABLE_COLUMNS } from '../product-table-columns';
import type { PaneRenderContext } from '../widgets/render-context';

const t = (value: string) => value;

/** The enriched Supply Action row is the only fixture with full stock buckets. */
const ENRICHED = (paneSupplyAction as { rows: DashboardRow[] }).rows.find(
  (row) => row.identity.asin === 'B0011A',
) as DashboardRow;

const READINESS_ROW = (paneDataReadiness as { rows: DashboardRow[] }).rows[0];

function rowWith(overrides: Partial<DashboardRow>): DashboardRow {
  return { ...ENRICHED, ...overrides } as DashboardRow;
}

function makeContext(): PaneRenderContext {
  return {
    api: { request: vi.fn().mockResolvedValue({ data: { data: {} } }) },
    runId: 'run-published-0001',
    fbaReceivingBufferDays: 7,
    targetCoverDaysDefault: 45,
    pendingFamilies: new Set<string>(),
    markPending: vi.fn(),
    onMutated: vi.fn(),
  };
}

function columnByKey(key: string): PaneColumnConfig {
  const column = DATA_ISSUES_COLUMNS.find((candidate) => candidate.key === key);
  if (!column) throw new Error(`missing ${key} column`);
  return column;
}

function renderColumn(key: string, row: DashboardRow) {
  return render(<App>{columnByKey(key).render(row, t, makeContext())}</App>);
}

/** Any tag whose text names a tier — the workbench must not render one itself. */
function tierishTags(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.ant-tag'))
    .map((tag) => (tag.textContent ?? '').trim())
    .filter((text) => /^[A-D]$/.test(text) || text.startsWith(TEXT.tier));
}

describe('066 D2: the Data issues workbench columns', () => {
  it('is the five diagnosis columns, in order, and the pane uses exactly them', () => {
    expect(DATA_ISSUES_COLUMNS.map((column) => column.key)).toEqual([
      'family',
      'stock',
      'velocity',
      'lastActivity',
      'issues',
    ]);
    expect(DATA_ISSUES_COLUMNS.map((column) => column.titleKey)).toEqual([
      TEXT.colProduct,
      TEXT.colStock,
      TEXT.colVelocityCover,
      TEXT.colLastActivity,
      TEXT.colIssues,
    ]);
    const config = PANE_CONFIGS.find((candidate) => candidate.pane === 'dataReadiness');
    expect(config?.columns).toBe(DATA_ISSUES_COLUMNS);
    // Not the product table: planning OUTPUT columns are meaningless for rows
    // the ladder blocked BEFORE planning (D2).
    expect(config?.columns).not.toBe(PRODUCT_TABLE_COLUMNS);
    for (const key of ['orderBy', 'orderQty', 'moneyAtRisk', 'action', 'signals']) {
      expect(
        DATA_ISSUES_COLUMNS.some((column) => column.key === key),
        `${key} must stay out`,
      ).toBe(false);
    }
    // D11: the pane is a queue — no sort selector, and no pane search box.
    expect(config?.sortOptions).toBeUndefined();
    expect(config?.showPaneSearch).toBeFalsy();
  });

  it('shares the product table cells for family / stock / velocity (no forked widgets)', () => {
    // lastActivity is literally the same object; the widget cells render the
    // same DOM, so the panes cannot drift apart.
    expect(columnByKey('lastActivity')).toBe(PRODUCT_TABLE_COLUMNS.find((column) => column.key === 'lastActivity'));
    const stock = renderColumn('stock', ENRICHED);
    const productStock = render(
      <App>
        {(PRODUCT_TABLE_COLUMNS.find((column) => column.key === 'stock') as PaneColumnConfig).render(
          ENRICHED,
          t,
          makeContext(),
        )}
      </App>,
    );
    expect(stock.container.textContent).toBe(productStock.container.textContent);
  });

  it('renders the per-bucket stock pills the operator asked for', () => {
    const view = renderColumn('stock', ENRICHED);
    for (const bucket of [TEXT.bucketFba, TEXT.bucketRsv, TEXT.bucketInb, TEXT.bucketPrep, TEXT.bucketOrd]) {
      expect(within(view.container).getAllByText(new RegExp(bucket)).length).toBeGreaterThan(0);
    }
    // Null-safe: the served-null readiness fixture renders without throwing.
    expect(() => renderColumn('stock', READINESS_ROW)).not.toThrow();
  });

  it('issues cell: one warning tag per reason code, then the inert family-split tag', () => {
    const view = renderColumn('issues', rowWith({ reasonCodes: ['frozen_family_target_review'], familySplit: true }));
    expect(within(view.container).getByText(TEXT.reasonFrozenFamilyTargetReview)).toBeTruthy();
    expect(within(view.container).getByText(TEXT.badgeFamilySplit)).toBeTruthy();
    // familySplit renders LAST, after the issue tags (§2 non-issue signals).
    const tags = Array.from(view.container.querySelectorAll('.ant-tag')).map((tag) => tag.textContent?.trim());
    expect(tags).toEqual([TEXT.reasonFrozenFamilyTargetReview, TEXT.badgeFamilySplit]);
    // T1 is display-only: nothing in the cluster is clickable yet.
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
  });

  it('issues cell: no 2-cap — every code the row carries gets its own tag', () => {
    const view = renderColumn(
      'issues',
      rowWith({
        reasonCodes: ['frozen_family_target_review', 'missing_or_invalid_baseline_evidence', 'family_review_required'],
        familySplit: false,
      }),
    );
    expect(view.container.querySelectorAll('.ant-tag')).toHaveLength(3);
    expect(within(view.container).getByText(TEXT.reasonMissingBaselineEvidence)).toBeTruthy();
    expect(within(view.container).getByText(TEXT.reasonFamilyReviewRequired)).toBeTruthy();
  });

  it('issues cell: an unknown code degrades to its raw label instead of crashing', () => {
    const view = renderColumn('issues', rowWith({ reasonCodes: ['velocity_missing'], familySplit: false }));
    expect(within(view.container).getByText('velocity_missing')).toBeTruthy();
  });

  it('065: the issues cell never re-renders a tier — FamilyCell owns the one badge rule', () => {
    const row = rowWith({
      tier: { baseline: 'A', current: 'B', lastClosedMonth: 'C' },
      reasonCodes: ['frozen_family_target_review'],
      familySplit: true,
    });
    const issues = renderColumn('issues', row);
    expect(tierishTags(issues.container)).toEqual([]);
    // ...while the family cell still wears it, exactly once.
    const family = renderColumn('family', row);
    expect(tierishTags(family.container)).toEqual(['B']);
  });
});
