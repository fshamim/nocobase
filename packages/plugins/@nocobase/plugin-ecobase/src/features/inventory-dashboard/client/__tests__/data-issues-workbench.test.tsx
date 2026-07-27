/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * 066 — the "Data issues" workbench.
 *
 * T1 (below, first describe) fixed the five columns and their inert companions.
 * T3 (second describe on) is the pane's BEHAVIORAL contract: the resolvable
 * codes are real buttons, the badge label tells the truth about a family that
 * already has a target, badge clicks never reach the row's drawer, and each
 * popup submits an EXISTING mutation with an exact payload.
 *
 * Row fixtures come from the server-emitted snapshots; only the fields under
 * test are overridden, because the live pane carries reason vocabulary this
 * fixture set predates (F1: `frozen_family_target_review` +
 * `missing_or_invalid_baseline_evidence` are the only live codes).
 */

import { App } from 'antd';
import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardRow, DrawerContextResponse, PaneMetric, PaneResult } from '../../server/contract';
import paneDataReadiness from '../../server/__tests__/fixtures/expected-responses/pane-dataReadiness.json';
import paneSupplyAction from '../../server/__tests__/fixtures/expected-responses/pane-supplyAction.json';
import { TEXT } from '../dashboard-text';
import { DATA_ISSUES_COLUMNS } from '../data-issues-columns';
import PaneSection from '../PaneSection';
import { PANE_CONFIGS, type PaneColumnConfig } from '../pane-configs';
import { PRODUCT_TABLE_COLUMNS } from '../product-table-columns';
import type { PaneRenderContext } from '../widgets/render-context';

const t = (value: string) => value;

const TARGET_CODE = 'frozen_family_target_review';
const EVIDENCE_CODE = 'missing_or_invalid_baseline_evidence';

/** The enriched Supply Action row is the only fixture with full stock buckets. */
const ENRICHED = (paneSupplyAction as { rows: DashboardRow[] }).rows.find(
  (row) => row.identity.asin === 'B0011A',
) as DashboardRow;

const READINESS_ROW = (paneDataReadiness as { rows: DashboardRow[] }).rows[0];

type FamilyMember = DrawerContextResponse['familyMembers'][number];

function rowWith(overrides: Partial<DashboardRow>): DashboardRow {
  return { ...ENRICHED, ...overrides } as DashboardRow;
}

/** A pane row of the workbench: same product, parked in dataReadiness. */
function issueRow(overrides: Partial<DashboardRow>): DashboardRow {
  return rowWith({ pane: 'dataReadiness', familySplit: undefined, ...overrides });
}

const NEEDS_TARGET_ROW = issueRow({ reasonCodes: [TARGET_CODE], familyTargetAssigned: false });
const SECONDARY_ROW = issueRow({ reasonCodes: [TARGET_CODE], familyTargetAssigned: true });
const EVIDENCE_ROW = issueRow({ reasonCodes: [EVIDENCE_CODE], familyTargetAssigned: false });

const SKU = ENRICHED.identity.sku ?? '';
const FAMILY_KEY = ENRICHED.identity.familyKey;
const LISTING_ROW_ID = ENRICHED.identity.listingRowId;

/** The composed accessible name of a badge button: "Resolve <issue> — <sku>". */
function badgeName(label: string): string {
  return `${TEXT.issueResolveAriaPrefix} ${label} — ${SKU}`;
}

function member(overrides: Partial<FamilyMember>): FamilyMember {
  return {
    listingRowId: 'listing-1',
    companyProductId: 'cp-1',
    asin: 'B0011A',
    sku: 'SKU-1',
    pane: 'performanceReview',
    isTarget: false,
    ...overrides,
  };
}

function drawerContextPayload(overrides: Partial<DrawerContextResponse> = {}): DrawerContextResponse {
  return {
    pane: 'dataReadiness',
    publishedRunId: 'run-published-0001',
    familyKey: FAMILY_KEY,
    performanceEvidence: [],
    familyMembers: [],
    familyTarget: null,
    primaryRow: NEEDS_TARGET_ROW,
    orderRows: [],
    orderHistory: [],
    maxEverOrderedQty: null,
    commentThread: [],
    ...overrides,
  };
}

interface ApiRequestOptions {
  url: string;
  method: 'post';
  data: Record<string, unknown>;
}

/**
 * The real transport double-wraps payloads (`{data:{data:…}}`); mutations get a
 * generic envelope unless the test wants them to fail.
 */
function makeRequest(options: { context?: Partial<DrawerContextResponse>; mutationError?: string } = {}) {
  return vi.fn(async (request: ApiRequestOptions) => {
    if (request.url === 'ecobaseInventoryDashboard:drawerContext') {
      return { data: { data: drawerContextPayload(options.context) } };
    }
    if (options.mutationError) throw new Error(options.mutationError);
    return { data: { data: { goldRefreshRequired: true } } };
  });
}

function makeContext(overrides: Partial<PaneRenderContext> = {}): PaneRenderContext {
  return {
    api: { request: makeRequest() },
    runId: 'run-published-0001',
    fbaReceivingBufferDays: 7,
    targetCoverDaysDefault: 45,
    pendingFamilies: new Set<string>(),
    markPending: vi.fn(),
    onMutated: vi.fn(),
    ...overrides,
  };
}

function columnByKey(key: string): PaneColumnConfig {
  const column = DATA_ISSUES_COLUMNS.find((candidate) => candidate.key === key);
  if (!column) throw new Error(`missing ${key} column`);
  return column;
}

function renderColumn(key: string, row: DashboardRow, ctx: PaneRenderContext = makeContext()) {
  return render(<App>{columnByKey(key).render(row, t, ctx)}</App>);
}

/** Any tag whose text names a tier — the workbench must not render one itself. */
function tierishTags(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.ant-tag'))
    .map((tag) => (tag.textContent ?? '').trim())
    .filter((text) => /^[A-D]$/.test(text) || text.startsWith(TEXT.tier));
}

function tagTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.ant-tag')).map((tag) => (tag.textContent ?? '').trim());
}

function paneResult(rows: DashboardRow[], metrics: PaneMetric[] = []): PaneResult {
  return {
    pane: 'dataReadiness',
    publishedRunId: 'run-published-0001',
    metrics,
    rows,
    pagination: { page: 1, pageSize: 25, total: rows.length },
  };
}

/** The pane exactly as the page mounts it — the only honest place to test the row gate. */
async function renderPane(options: {
  rows: DashboardRow[];
  metrics?: PaneMetric[];
  ctx?: PaneRenderContext;
  onRowClick?: (row: DashboardRow, trigger: HTMLElement | null) => void;
}) {
  const config = PANE_CONFIGS.find((candidate) => candidate.pane === 'dataReadiness');
  if (!config) throw new Error('missing dataReadiness config');
  const fetchPane = vi.fn().mockResolvedValue(paneResult(options.rows, options.metrics ?? []));
  const view = render(
    <App>
      <PaneSection
        config={config}
        runId="run-published-0001"
        search=""
        frozen={false}
        fetchPane={fetchPane}
        onSuperseded={() => undefined}
        observeVisibility={(_, onVisible) => {
          onVisible();
          return () => undefined;
        }}
        t={t}
        onRowClick={options.onRowClick}
        renderContext={options.ctx ?? makeContext()}
      />
    </App>,
  );
  await waitFor(() => expect(fetchPane).toHaveBeenCalled());
  return view;
}

/** Opens the badge's popup and returns the dialog element. */
async function openBadge(view: ReturnType<typeof render>, label: string) {
  fireEvent.click(await view.findByRole('button', { name: badgeName(label) }));
  return within(document.body).findByRole('dialog');
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

  it('issues cell: the resolvable code is a button, the family-split corroboration stays an inert tag', () => {
    const view = renderColumn('issues', issueRow({ reasonCodes: [TARGET_CODE], familySplit: true }));
    expect(within(view.container).getByRole('button', { name: badgeName(TEXT.issueNeedsTarget) })).toBeTruthy();
    // familySplit renders LAST and never becomes clickable (§2 non-issue signals).
    expect(tagTexts(view.container)).toEqual([TEXT.badgeFamilySplit]);
    expect(view.container.querySelectorAll('button')).toHaveLength(1);
  });

  it('issues cell: no 2-cap — every code the row carries gets its own badge', () => {
    const view = renderColumn(
      'issues',
      issueRow({
        reasonCodes: [TARGET_CODE, EVIDENCE_CODE, 'family_review_required'],
        familyTargetAssigned: false,
      }),
    );
    // Two resolvable codes -> two buttons; the legacy code stays an inert tag.
    expect(view.container.querySelectorAll('button')).toHaveLength(2);
    expect(within(view.container).getByRole('button', { name: badgeName(TEXT.issueNeedsTarget) })).toBeTruthy();
    expect(
      within(view.container).getByRole('button', { name: badgeName(TEXT.reasonMissingBaselineEvidence) }),
    ).toBeTruthy();
    expect(tagTexts(view.container)).toEqual([TEXT.reasonFamilyReviewRequired]);
  });

  it('issues cell: an unknown code degrades to an inert raw label instead of crashing', () => {
    const view = renderColumn('issues', issueRow({ reasonCodes: ['velocity_missing'] }));
    expect(within(view.container).getByText('velocity_missing')).toBeTruthy();
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
  });

  it('065: the issues cell never re-renders a tier — FamilyCell owns the one badge rule', () => {
    const row = issueRow({
      tier: { baseline: 'A', current: 'B', lastClosedMonth: 'C' },
      reasonCodes: [TARGET_CODE],
      familySplit: true,
    });
    const issues = renderColumn('issues', row);
    expect(tierishTags(issues.container)).toEqual([]);
    // ...while the family cell still wears it, exactly once.
    const family = renderColumn('family', row);
    expect(tierishTags(family.container)).toEqual(['B']);
  });
});

describe('066 D3: the badge cluster is interactive', () => {
  it('splits the target-review label on familyTargetAssigned — a targeted family is never told it needs one', () => {
    const needs = renderColumn('issues', NEEDS_TARGET_ROW);
    expect(within(needs.container).getByRole('button', { name: badgeName(TEXT.issueNeedsTarget) }).textContent).toBe(
      TEXT.issueNeedsTarget,
    );
    expect(within(needs.container).queryByText(TEXT.issueSecondaryListing)).toBeNull();

    const secondary = renderColumn('issues', SECONDARY_ROW);
    expect(
      within(secondary.container).getByRole('button', { name: badgeName(TEXT.issueSecondaryListing) }).textContent,
    ).toBe(TEXT.issueSecondaryListing);
    expect(within(secondary.container).queryByText(TEXT.issueNeedsTarget)).toBeNull();
  });

  it('every badge is a real button with dialog semantics (native Enter + Space come free)', () => {
    const view = renderColumn('issues', EVIDENCE_ROW);
    const badge = within(view.container).getByRole('button', { name: badgeName(TEXT.reasonMissingBaselineEvidence) });
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.getAttribute('type')).toBe('button');
    expect(badge.getAttribute('aria-haspopup')).toBe('dialog');
    expect(badge.getAttribute('aria-label')).toBe(badgeName(TEXT.reasonMissingBaselineEvidence));
    expect(badge).toHaveProperty('disabled', false);
  });

  it('D8: a family awaiting its publish has disabled ghost badges (no double submits)', async () => {
    const ctx = makeContext({ pendingFamilies: new Set([FAMILY_KEY]) });
    const view = renderColumn('issues', NEEDS_TARGET_ROW, ctx);
    const badge = within(view.container).getByRole('button', { name: badgeName(TEXT.issueNeedsTarget) });
    expect(badge).toHaveProperty('disabled', true);
    fireEvent.click(badge);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(within(document.body).queryByRole('dialog')).toBeNull();
    expect(ctx.api.request).not.toHaveBeenCalled();
  });

  it('the pane gate: a badge click/keypress never reaches the row, a row click still opens the drawer', async () => {
    const onRowClick = vi.fn();
    const view = await renderPane({ rows: [NEEDS_TARGET_ROW], onRowClick });
    // The row itself opens the standard product drawer (D4 routing).
    fireEvent.click(await view.findByText(ENRICHED.identity.asin ?? ''));
    expect(onRowClick).toHaveBeenCalledTimes(1);

    const badge = view.getByRole('button', { name: badgeName(TEXT.issueNeedsTarget) });
    fireEvent.click(badge);
    // Badge click opened the popup and did NOT bubble into the row handler.
    expect(await within(document.body).findByRole('dialog')).toBeTruthy();
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(badge, { key: 'Enter' });
    fireEvent.keyDown(badge, { key: ' ' });
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('D9: the pane header carries the new families-needing-a-target metric', async () => {
    const view = await renderPane({
      rows: [NEEDS_TARGET_ROW],
      metrics: [
        { key: 'tieredNeedingAttention', label: TEXT.metricTieredNeedingAttention, value: 7 },
        { key: 'familiesNeedingTarget', label: TEXT.metricFamiliesNeedingTarget, value: 51 },
      ],
    });
    expect(await view.findByText(`${TEXT.metricFamiliesNeedingTarget}: 51`)).toBeTruthy();
    expect(view.getByText(`${TEXT.metricTieredNeedingAttention}: 7`)).toBeTruthy();
  });
});

describe('066 D6: the family-target popup', () => {
  it('no target + multiple members: picks a member, requires a reason, submits setFamilyTarget', async () => {
    const request = makeRequest({
      context: {
        familyMembers: [
          member({ listingRowId: LISTING_ROW_ID, companyProductId: 'cp-1', sku: 'SKU-1', pane: 'untieredProducts' }),
          member({ listingRowId: 'listing-2', companyProductId: 'cp-2', sku: 'SKU-2', pane: 'performanceReview' }),
        ],
      },
    });
    const ctx = makeContext({ api: { request } });
    const view = renderColumn('issues', NEEDS_TARGET_ROW, ctx);
    // Lazy: nothing is fetched until the operator opens the badge.
    expect(request).not.toHaveBeenCalled();
    const dialog = await openBadge(view, TEXT.issueNeedsTarget);
    expect(request).toHaveBeenCalledWith({
      url: 'ecobaseInventoryDashboard:drawerContext',
      method: 'post',
      data: {
        pane: 'dataReadiness',
        runId: 'run-published-0001',
        familyId: FAMILY_KEY,
        listingRowId: LISTING_ROW_ID,
      },
    });
    // Each option names the listing AND the pane it actually lives in.
    expect(await within(dialog).findByRole('radio', { name: /SKU-2/ })).toBeTruthy();
    expect(within(dialog).getByText(/SKU-2.*Performance Review/)).toBeTruthy();

    const save = within(dialog).getByRole('button', { name: TEXT.drawerSave });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /SKU-2/ }));
    expect(save).toHaveProperty('disabled', true); // still no reason
    fireEvent.change(within(dialog).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'sells better' } });
    await waitFor(() => expect(save).toHaveProperty('disabled', false));
    fireEvent.click(save);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        url: 'ecobaseInventoryDashboard:setFamilyTarget',
        method: 'post',
        data: { familyId: FAMILY_KEY, companyProductId: 'cp-2', reason: 'sells better' },
      }),
    );
    // D5/D8 success contract: pending mark, scoped refresh, modal closes.
    await waitFor(() => expect(ctx.markPending).toHaveBeenCalledWith(FAMILY_KEY));
    expect(ctx.onMutated).toHaveBeenCalledWith('dataReadiness');
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
  });

  it('F6 — no target + a single member: the one listing is pre-selected and confirmable in one click', async () => {
    const request = makeRequest({
      context: {
        familyMembers: [
          member({ listingRowId: LISTING_ROW_ID, companyProductId: 'cp-only', sku: 'SKU-ONLY', pane: 'zeroStock' }),
        ],
      },
    });
    const ctx = makeContext({ api: { request } });
    const view = renderColumn('issues', NEEDS_TARGET_ROW, ctx);
    const dialog = await openBadge(view, TEXT.issueNeedsTarget);
    expect(await within(dialog).findByText(TEXT.targetConfirmOnlyMember)).toBeTruthy();
    expect(within(dialog).getByText(/SKU-ONLY/)).toBeTruthy();
    // No radio group to choose from — the member is already the selection.
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);

    const save = within(dialog).getByRole('button', { name: TEXT.drawerSave });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'only listing' } });
    await waitFor(() => expect(save).toHaveProperty('disabled', false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        url: 'ecobaseInventoryDashboard:setFamilyTarget',
        method: 'post',
        data: { familyId: FAMILY_KEY, companyProductId: 'cp-only', reason: 'only listing' },
      }),
    );
  });

  it('D6.3 — an already-targeted family gets the state panel, and submit only after Change target', async () => {
    const request = makeRequest({
      context: {
        familyTarget: { companyProductId: 'cp-1', selectionSource: 'operator', selectionRule: 'highest_velocity' },
        familyMembers: [
          member({
            listingRowId: 'listing-1',
            companyProductId: 'cp-1',
            sku: 'SKU-1',
            pane: 'supplyAction',
            isTarget: true,
          }),
          member({ listingRowId: LISTING_ROW_ID, companyProductId: 'cp-2', sku: 'SKU-2', pane: 'dataReadiness' }),
        ],
      },
    });
    const ctx = makeContext({ api: { request } });
    const view = renderColumn('issues', SECONDARY_ROW, ctx);
    const dialog = await openBadge(view, TEXT.issueSecondaryListing);

    expect(await within(dialog).findByText(TEXT.targetAssignedElsewhere)).toBeTruthy();
    expect(within(dialog).getByText(TEXT.targetSecondaryExplain)).toBeTruthy();
    // Who the target is, which pane it lives in, and how it was chosen.
    expect(within(dialog).getByText(/SKU-1.*Supply Action/)).toBeTruthy();
    expect(within(dialog).getByText('highest_velocity')).toBeTruthy();
    // Nothing pretends to resolve: no submit until the operator asks to change.
    expect(within(dialog).queryByRole('button', { name: TEXT.drawerSave })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnChangeTarget }));
    const save = await within(dialog).findByRole('button', { name: TEXT.drawerSave });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /SKU-2/ }));
    fireEvent.change(within(dialog).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'switch' } });
    await waitFor(() => expect(save).toHaveProperty('disabled', false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        url: 'ecobaseInventoryDashboard:setFamilyTarget',
        method: 'post',
        data: { familyId: FAMILY_KEY, companyProductId: 'cp-2', reason: 'switch' },
      }),
    );
  });

  it('renders by the FETCHED state, not the badge label: a "Needs target" row with a target shows the panel', async () => {
    const request = makeRequest({
      context: {
        familyTarget: { companyProductId: 'cp-1', selectionSource: 'import', selectionRule: null },
        familyMembers: [member({ companyProductId: 'cp-1', isTarget: true })],
      },
    });
    const view = renderColumn('issues', NEEDS_TARGET_ROW, makeContext({ api: { request } }));
    const dialog = await openBadge(view, TEXT.issueNeedsTarget);
    expect(await within(dialog).findByText(TEXT.targetAssignedElsewhere)).toBeTruthy();
    expect(within(dialog).queryByText(TEXT.targetConfirmOnlyMember)).toBeNull();
  });

  it('a failed mutation keeps the popup open with the error and refreshes nothing', async () => {
    const request = makeRequest({
      context: { familyMembers: [member({ listingRowId: LISTING_ROW_ID, companyProductId: 'cp-only' })] },
      mutationError: 'target write rejected',
    });
    const ctx = makeContext({ api: { request } });
    const view = renderColumn('issues', NEEDS_TARGET_ROW, ctx);
    const dialog = await openBadge(view, TEXT.issueNeedsTarget);
    await within(dialog).findByText(TEXT.targetConfirmOnlyMember);
    fireEvent.change(within(dialog).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'try' } });
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.drawerSave }));

    expect(await within(document.body).findByText('target write rejected')).toBeTruthy();
    expect(within(document.body).getByRole('dialog')).toBeTruthy();
    expect(ctx.markPending).not.toHaveBeenCalled();
    expect(ctx.onMutated).not.toHaveBeenCalled();
    // The typed reason survives the failure.
    expect(within(dialog).getByLabelText(TEXT.reasonRequiredLabel)).toHaveProperty('value', 'try');
  });

  it('a failed context fetch shows an in-modal retry that refetches', async () => {
    const request = vi.fn(async (options: ApiRequestOptions) => {
      if (request.mock.calls.length === 1) throw new Error('context down');
      return { data: { data: drawerContextPayload({ familyMembers: [member({})] }) } };
    });
    const view = renderColumn('issues', NEEDS_TARGET_ROW, makeContext({ api: { request } }));
    const dialog = await openBadge(view, TEXT.issueNeedsTarget);
    expect(await within(dialog).findByText(/context down/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.retry }));
    expect(await within(dialog).findByText(TEXT.targetConfirmOnlyMember)).toBeTruthy();
  });
});

describe('066 D7: the no-usable-sales-history explainer', () => {
  const EVIDENCE_VELOCITY = {
    value: 0.5,
    basis: 'rolling_30',
    asOfDate: '2026-07-20',
    evidenceStatus: 'insufficient_evidence',
    confidence: 'low',
    observedDays: 3,
  };

  function evidenceRow(): DashboardRow {
    return issueRow({ reasonCodes: [EVIDENCE_CODE], velocity: EVIDENCE_VELOCITY });
  }

  it('states what the engine sees from the served row, plus the closed-month strip and the causes', async () => {
    const request = makeRequest({
      context: {
        performanceEvidence: [
          { month: '2026-05', units: 0, profit: null, trusted: false },
          { month: '2026-06', units: 4, profit: null, trusted: true },
        ],
      },
    });
    const view = renderColumn('issues', evidenceRow(), makeContext({ api: { request } }));
    const dialog = await openBadge(view, TEXT.reasonMissingBaselineEvidence);

    expect(within(dialog).getByText(TEXT.evidenceIntro)).toBeTruthy();
    expect(within(dialog).getByText(TEXT.evidenceStateHeading)).toBeTruthy();
    // Velocity provenance straight off the row — no second fetch invents it.
    expect(within(dialog).getByText('rolling_30')).toBeTruthy();
    expect(within(dialog).getByText('low')).toBeTruthy();
    expect(within(dialog).getByText('insufficient_evidence')).toBeTruthy();
    expect(within(dialog).getByText(`3 ${TEXT.observedOf30DaysSuffix}`)).toBeTruthy();
    expect(within(dialog).getByText(TEXT.reasonMissingBaselineEvidence)).toBeTruthy();
    // The 6-month strip is textual, with per-month trust.
    expect(await within(dialog).findByText(new RegExp(`2026-06 · 4 ${TEXT.unitsSuffix}`))).toBeTruthy();
    expect(within(dialog).getByText(TEXT.evidenceTrusted)).toBeTruthy();
    expect(within(dialog).getByText(TEXT.evidenceUntrusted)).toBeTruthy();
    // Causes, and no fake fix button.
    expect(within(dialog).getByText(TEXT.evidenceCauseNewProduct)).toBeTruthy();
    expect(within(dialog).getByText(TEXT.evidenceCauseNoImport)).toBeTruthy();
    expect(within(dialog).getByText(TEXT.evidenceCauseRollover)).toBeTruthy();
  });

  it('an empty evidence blob says so instead of rendering a blank strip', async () => {
    const view = renderColumn('issues', evidenceRow(), makeContext({ api: { request: makeRequest() } }));
    const dialog = await openBadge(view, TEXT.reasonMissingBaselineEvidence);
    expect(await within(dialog).findByText(TEXT.evidenceNoMonths)).toBeTruthy();
  });

  it('logs the investigation as a product comment, resolved to the clicked listing', async () => {
    const request = makeRequest({
      context: {
        familyMembers: [
          member({ listingRowId: LISTING_ROW_ID, companyProductId: 'cp-primary' }),
          member({ listingRowId: 'listing-other', companyProductId: 'cp-other' }),
        ],
      },
    });
    const view = renderColumn('issues', evidenceRow(), makeContext({ api: { request } }));
    const dialog = await openBadge(view, TEXT.reasonMissingBaselineEvidence);
    await within(dialog).findByText(TEXT.evidenceCausesHeading);
    fireEvent.change(within(dialog).getByLabelText(TEXT.drawerAddComment), {
      target: { value: 'checked the import — feed missing' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnPost }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        url: 'ecobaseInventoryDashboard:addProductComment',
        method: 'post',
        data: { companyProductId: 'cp-primary', body: 'checked the import — feed missing' },
      }),
    );
    expect(await within(document.body).findByText(TEXT.toastCommentPosted)).toBeTruthy();
  });

  it('falls back to the family thread when no companyProductId resolves', async () => {
    const request = makeRequest({ context: { familyMembers: [member({ companyProductId: null })] } });
    const view = renderColumn('issues', evidenceRow(), makeContext({ api: { request } }));
    const dialog = await openBadge(view, TEXT.reasonMissingBaselineEvidence);
    await within(dialog).findByText(TEXT.evidenceCausesHeading);
    fireEvent.change(within(dialog).getByLabelText(TEXT.drawerAddComment), { target: { value: 'no product id' } });
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnPost }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        url: 'ecobaseInventoryDashboard:addProductComment',
        method: 'post',
        data: { familyId: FAMILY_KEY, body: 'no product id' },
      }),
    );
  });

  it('hands the operator to the standard product drawer with the row', async () => {
    const openDrawer = vi.fn();
    const row = evidenceRow();
    const view = renderColumn('issues', row, makeContext({ api: { request: makeRequest() }, openDrawer }));
    const dialog = await openBadge(view, TEXT.reasonMissingBaselineEvidence);
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.evidenceOpenDrawer }));
    expect(openDrawer).toHaveBeenCalledWith(row);
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
  });
});
