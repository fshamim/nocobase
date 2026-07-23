/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T7 widget units: FamilyCell (tier pill / target picker / sync dot),
 * StockBuckets (zero-gray, AWD only when > 0), VelocityCover (fallback pill,
 * null basis invents nothing), SupplierLeadTime (settings-driven buffer),
 * ActionPill (deterministic precedence), SyncState registry (mark /
 * clear-on-new-run), and the Supply Action pane rendered against the
 * regenerated staging-shaped snapshot.
 */

import { App } from 'antd';
import React, { useEffect } from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardRow, PaneResult } from '../../server/contract';
import paneSupplyAction from '../../server/__tests__/fixtures/expected-responses/pane-supplyAction.json';
import drawerSupplyAction from '../../server/__tests__/fixtures/expected-responses/drawer-supplyAction.json';
import { TEXT } from '../dashboard-text';
import PaneSection from '../PaneSection';
import { PANE_CONFIGS } from '../pane-configs';
import { actionPillFor } from '../widgets/ActionPill';
import { FamilyCell } from '../widgets/FamilyCell';
import type { PaneRenderContext } from '../widgets/render-context';
import { StockBuckets } from '../widgets/StockBuckets';
import { SupplierLeadTime } from '../widgets/SupplierLeadTime';
import { SyncStateProvider, useSyncState } from '../widgets/SyncState';
import { VelocityCover } from '../widgets/VelocityCover';

const t = (value: string) => value;

const SUPPLY_ROWS = (paneSupplyAction as { rows: DashboardRow[] }).rows;
const ENRICHED = SUPPLY_ROWS.find((row) => row.identity.asin === 'B0011A') as DashboardRow;
const BARE = SUPPLY_ROWS.find((row) => row.identity.asin === 'B0011B') as DashboardRow;

function rowWith(overrides: Partial<DashboardRow>): DashboardRow {
  return { ...ENRICHED, ...overrides } as DashboardRow;
}

function makeContext(overrides: Partial<PaneRenderContext> = {}): PaneRenderContext {
  return {
    api: { request: vi.fn().mockResolvedValue({ data: { data: {} } }) },
    runId: 'run-published-0001',
    fbaReceivingBufferDays: 7,
    targetCoverDaysDefault: 45,
    pendingFamilies: new Set<string>(),
    markPending: vi.fn(),
    onMutated: vi.fn(),
    ...overrides,
  };
}

describe('T7 widgets', () => {
  it('ActionPill: deterministic precedence table', () => {
    const base = rowWith({
      daysUntilSafeReorder: 20,
      supplier: { ...ENRICHED.supplier, leadTimeFreshness: 'fresh' },
      velocity: { ...ENRICHED.velocity, basis: 'rolling_30' },
    });
    // (1) overdue beats everything.
    expect(
      actionPillFor(
        rowWith({
          daysUntilSafeReorder: -3,
          supplier: { ...ENRICHED.supplier, leadTimeFreshness: 'stale' },
          velocity: { ...ENRICHED.velocity, basis: 'last_closed_month' },
        }),
      ).key,
    ).toBe('overdue');
    // (2) stale lead time beats estimated velocity and windows.
    expect(
      actionPillFor(
        rowWith({
          daysUntilSafeReorder: 3,
          supplier: { ...ENRICHED.supplier, leadTimeFreshness: 'stale' },
          velocity: { ...ENRICHED.velocity, basis: 'last_closed_month' },
        }),
      ).key,
    ).toBe('refresh_lead_time');
    // (3) fallback velocity basis.
    expect(actionPillFor(rowWith({ ...base, velocity: { ...ENRICHED.velocity, basis: 'baseline_average' } })).key).toBe(
      'verify_velocity',
    );
    // (4) due within a week.
    expect(actionPillFor(rowWith({ ...base, daysUntilSafeReorder: 6.5 })).key).toBe('order_this_week');
    // (5) everything calm -> order soon (also when the scalar is null).
    expect(actionPillFor(base).key).toBe('order_soon');
    expect(actionPillFor(rowWith({ ...base, daysUntilSafeReorder: null })).key).toBe('order_soon');
  });

  it('StockBuckets: zero/null pills gray, positive pills colored, AWD only when > 0, total prominent', () => {
    const view = render(<StockBuckets stock={ENRICHED.stock} t={t} />);
    expect(view.getByText('100')).toBeTruthy(); // currentPlanningStock total
    expect(view.getByText(TEXT.unitsSuffix)).toBeTruthy();
    expect(view.queryByText(TEXT.bucketAwd)).toBeNull(); // awd 0 -> hidden
    const positive = view.getByText(TEXT.bucketFba).closest('.ant-tag') as HTMLElement;
    const zero = view.getByText(TEXT.bucketPrep).closest('.ant-tag') as HTMLElement;
    expect(positive.className).toContain('ant-tag-blue');
    expect(zero.className).not.toContain('ant-tag-blue');
    // Full variant spells the words out.
    const full = render(<StockBuckets stock={ENRICHED.stock} t={t} variant="full" />);
    expect(full.getByText(TEXT.bucketReserved)).toBeTruthy();
    expect(full.getByText(TEXT.bucketOrdered)).toBeTruthy();
  });

  it('VelocityCover: fallback basis wears the estimate pill; null basis renders an em-dash and invents nothing', () => {
    const fallback = render(
      <VelocityCover
        row={rowWith({
          velocity: {
            value: 0.4,
            basis: 'last_closed_month',
            asOfDate: '2026-05-31',
            evidenceStatus: 'insufficient_evidence',
          },
        })}
        t={t}
      />,
    );
    expect(fallback.getByText(`${TEXT.estimateFromPrefix} May`)).toBeTruthy();
    const none = render(
      <VelocityCover
        row={rowWith({ velocity: { value: null, basis: null, asOfDate: null, evidenceStatus: null } })}
        t={t}
      />,
    );
    expect(within(none.container).getByText('—')).toBeTruthy();
    expect(within(none.container).queryByText(TEXT.perDay)).toBeNull();
    // Trusted basis: no estimate pill.
    const trusted = render(<VelocityCover row={ENRICHED} t={t} />);
    expect(within(trusted.container).queryByText(new RegExp(TEXT.estimateFromPrefix))).toBeNull();
    expect(within(trusted.container).getByText('8.0')).toBeTruthy();
  });

  it('SupplierLeadTime: settings-driven buffer, freshness dot, ghost age pill only when not fresh', () => {
    const stale = render(
      <SupplierLeadTime
        supplier={{
          id: 's1',
          name: 'Qingdao Naturals',
          leadTimeDays: 30,
          leadTimeConfirmedAt: new Date(Date.now() - 214 * 86_400_000).toISOString(),
          leadTimeFreshness: 'default',
        }}
        fbaReceivingBufferDays={7}
        t={t}
      />,
    );
    expect(stale.getByText(/30 \+ 7 d/)).toBeTruthy();
    expect(stale.getByText(`214 ${TEXT.dOldSuffix}`)).toBeTruthy();
    // T-QA1 a11y: the freshness dot now carries an accessible label.
    expect(within(stale.container).getByLabelText(`${TEXT.leadTimeStaleLabel} 214 ${TEXT.dOldSuffix}`)).toBeTruthy();
    const fresh = render(
      <SupplierLeadTime
        supplier={{ ...ENRICHED.supplier, leadTimeFreshness: 'fresh' }}
        fbaReceivingBufferDays={7}
        t={t}
      />,
    );
    expect(within(fresh.container).queryByText(new RegExp(TEXT.dOldSuffix))).toBeNull();
    expect(within(fresh.container).getByLabelText(TEXT.leadTimeFreshLabel)).toBeTruthy();
  });

  it('SyncState registry: marks families and clears WHOLESALE when the published run changes', async () => {
    const probe: { value?: ReturnType<typeof useSyncState> } = {};
    function Probe({ runId }: { runId: string }) {
      const sync = useSyncState();
      probe.value = sync;
      const { onRunChanged } = sync;
      useEffect(() => {
        onRunChanged(runId);
      }, [onRunChanged, runId]);
      return <span data-testid="pending-count">{sync.pendingFamilies.size}</span>;
    }
    const view = render(
      <SyncStateProvider>
        <Probe runId="run-1" />
      </SyncStateProvider>,
    );
    act(() => probe.value?.markPending('family-a'));
    act(() => probe.value?.markPending('family-b'));
    expect(view.getByTestId('pending-count').textContent).toBe('2');
    // Same run id -> nothing clears.
    view.rerender(
      <SyncStateProvider>
        <Probe runId="run-1" />
      </SyncStateProvider>,
    );
    expect(view.getByTestId('pending-count').textContent).toBe('2');
    // NEW published run -> wholesale clear.
    view.rerender(
      <SyncStateProvider>
        <Probe runId="run-2" />
      </SyncStateProvider>,
    );
    await waitFor(() => expect(view.getByTestId('pending-count').textContent).toBe('0'));
  });

  it('FamilyCell: tier letter only (D neutral), sync dot when pending, muted context line', () => {
    const pendingCtx = makeContext({ pendingFamilies: new Set([ENRICHED.identity.familyKey]) });
    const view = render(
      <App>
        <FamilyCell row={rowWith({ tier: { baseline: 'D', current: null } })} t={t} ctx={pendingCtx} />
      </App>,
    );
    expect(view.getByText('D')).toBeTruthy();
    expect(view.queryByText(/Tier D/)).toBeNull(); // letter only, no "Tier" word
    expect(view.getByText(TEXT.syncing)).toBeTruthy();
    expect(view.getByText(/Acme · Amazon\.com/)).toBeTruthy();
  });

  it('FamilyCell target picker: lazy-fetches members on open, requires a reason, submits setFamilyTarget', async () => {
    const request = vi.fn().mockImplementation((args: { url: string }) => {
      if (args.url === 'ecobaseInventoryDashboard:drawerContext') {
        return Promise.resolve({
          data: {
            data: {
              ...(drawerSupplyAction as Record<string, unknown>),
              familyMembers: [
                {
                  listingRowId: 'g1',
                  companyProductId: 'cp-1',
                  asin: 'A1',
                  sku: 'SKU-1',
                  pane: 'supplyAction',
                  isTarget: true,
                },
                {
                  listingRowId: 'g2',
                  companyProductId: 'cp-2',
                  asin: 'A2',
                  sku: 'SKU-2',
                  pane: 'supplyAction',
                  isTarget: false,
                },
              ],
            },
          },
        });
      }
      return Promise.resolve({ data: { data: { ok: true } } });
    });
    const markPending = vi.fn();
    const onMutated = vi.fn();
    const ctx = makeContext({ api: { request }, markPending, onMutated });
    const view = render(
      <App>
        <FamilyCell row={rowWith({ familyMemberCount: 2 })} t={t} ctx={ctx} />
      </App>,
    );
    // No fetch before the operator opens the control (lazy).
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: new RegExp(TEXT.btnChangeTarget) }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: 'ecobaseInventoryDashboard:drawerContext' })),
    );
    const dialog = await within(document.body).findByRole('dialog');
    // OK stays disabled until a member AND a reason are provided.
    const ok = within(dialog).getByRole('button', { name: TEXT.drawerSave });
    expect(ok).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /SKU-2/ }));
    expect(ok).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'better runner' } });
    await waitFor(() => expect(ok).toHaveProperty('disabled', false));
    fireEvent.click(ok);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        url: 'ecobaseInventoryDashboard:setFamilyTarget',
        method: 'post',
        data: { familyId: ENRICHED.identity.familyKey, companyProductId: 'cp-2', reason: 'better runner' },
      }),
    );
    await waitFor(() => expect(markPending).toHaveBeenCalledWith(ENRICHED.identity.familyKey));
    expect(onMutated).toHaveBeenCalledWith('supplyAction');
  });

  it('Supply Action pane renders the 8 mockup columns from the regenerated snapshot', async () => {
    const config = PANE_CONFIGS.find((candidate) => candidate.pane === 'supplyAction');
    if (!config) throw new Error('missing supplyAction config');
    const fetchPane = vi.fn().mockResolvedValue(paneSupplyAction as unknown as PaneResult);
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
          renderContext={makeContext()}
        />
      </App>,
    );
    await waitFor(() => expect(view.getByText('B0011A')).toBeTruthy());
    // Header pills from the SERVER metrics (all pane rows, not the page).
    expect(view.getByText(new RegExp(`\\d+ ${TEXT.metricNeedOrdering}`))).toBeTruthy();
    expect(view.getAllByText(new RegExp(TEXT.metricAtRiskSuffix)).length).toBeGreaterThan(0);
    // Column headers in mockup reading order.
    for (const title of [
      TEXT.colProduct,
      TEXT.colStock,
      TEXT.colVelocityCover,
      TEXT.colOrderBy,
      TEXT.colOrderQty,
      TEXT.metricMoneyAtRisk,
      TEXT.colLastActivity,
      TEXT.colAction,
    ]) {
      expect(view.getByText(title)).toBeTruthy();
    }
    // The enriched row: velocity cluster, supplier line, action pill.
    expect(view.getByText('8.0')).toBeTruthy();
    expect(view.getAllByText(/Lead Boundary Supplies/).length).toBeGreaterThan(0);
    expect(view.getAllByText(TEXT.actionOverdue).length).toBeGreaterThan(0);
    // The bare row's empty money cell renders an em-dash, never zero.
    expect(view.getAllByText('—').length).toBeGreaterThan(0);
    expect(BARE.estimatedProfitRisk).not.toBeNull(); // fixture sanity: f11b has risk 250
    // R1-6: static rules live in header hint tooltips.
    expect(view.getAllByLabelText(TEXT.hintOrderQty).length).toBeGreaterThan(0);
    expect(view.getAllByLabelText(TEXT.hintMoneyAtRisk).length).toBeGreaterThan(0);
  });

  it('R1-1: a collapsed pane never fetches; expanding it fires the fetch', async () => {
    const config = PANE_CONFIGS.find((candidate) => candidate.pane === 'supplyAction');
    if (!config) throw new Error('missing supplyAction config');
    const fetchPane = vi.fn().mockResolvedValue(paneSupplyAction as unknown as PaneResult);
    const view = render(
      <App>
        <PaneSection
          config={config}
          runId="run-published-0001"
          search=""
          frozen={false}
          defaultExpanded={false}
          fetchPane={fetchPane}
          onSuperseded={() => undefined}
          observeVisibility={(_, onVisible) => {
            onVisible();
            return () => undefined;
          }}
          t={t}
          renderContext={makeContext()}
        />
      </App>,
    );
    // Visible but COLLAPSED -> no fetch (R1-1 lazy rule).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchPane).not.toHaveBeenCalled();
    fireEvent.click(view.getByText(TEXT.paneSupplyAction));
    await waitFor(() => expect(fetchPane).toHaveBeenCalledTimes(1));
  });

  it('R1-2: the sort selector refetches server-side with the chosen scenario at page 1', async () => {
    const config = PANE_CONFIGS.find((candidate) => candidate.pane === 'supplyAction');
    if (!config) throw new Error('missing supplyAction config');
    const fetchPane = vi.fn().mockResolvedValue(paneSupplyAction as unknown as PaneResult);
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
          renderContext={makeContext()}
        />
      </App>,
    );
    await waitFor(() => expect(fetchPane).toHaveBeenCalledTimes(1));
    expect(fetchPane.mock.calls[0][0]).toMatchObject({ sort: undefined });
    fireEvent.mouseDown(view.getByRole('combobox', { name: new RegExp(TEXT.sortLabel) }));
    fireEvent.click(await within(document.body).findByText(TEXT.sortMostUrgent));
    await waitFor(() => expect(fetchPane).toHaveBeenCalledTimes(2));
    expect(fetchPane.mock.calls[1][0]).toMatchObject({ sort: 'daysUntilSafeReorder', page: 1 });
    // T-R2: re-selecting "Tier" goes back to the CANONICAL default path — the
    // request carries NO sort key (server composite), never a fake 'tier' key.
    fireEvent.mouseDown(view.getByRole('combobox', { name: new RegExp(TEXT.sortLabel) }));
    fireEvent.click(await within(document.body).findByText(TEXT.tier));
    await waitFor(() => expect(fetchPane).toHaveBeenCalledTimes(3));
    expect(fetchPane.mock.calls[2][0].sort).toBeUndefined();
  });

  it('T-D5: the urgency badge renders both variants in the shared signals cluster', () => {
    const healthy = PANE_CONFIGS.find((config) => config.pane === 'healthyInventory');
    const signalsColumn = healthy?.columns.find((column) => column.key === 'signals');
    if (!signalsColumn) throw new Error('missing signals column');
    const near = render(<App>{signalsColumn.render(rowWith({ stockoutUrgency: { daysUntil: 12 } }), t)}</App>);
    expect(within(near.container).getByText(`${TEXT.urgentStockoutWithin} 12 ${TEXT.dSuffix}`)).toBeTruthy();
    const passed = render(<App>{signalsColumn.render(rowWith({ stockoutUrgency: { daysUntil: 0 } }), t)}</App>);
    expect(within(passed.container).getByText(TEXT.urgentStockoutNow)).toBeTruthy();
    // T-QA1 verify: a NEGATIVE daysUntil (date already passed) is also the imminent variant.
    const negative = render(<App>{signalsColumn.render(rowWith({ stockoutUrgency: { daysUntil: -3 } }), t)}</App>);
    expect(within(negative.container).getByText(TEXT.urgentStockoutNow)).toBeTruthy();
    expect(within(negative.container).queryByText(new RegExp('-3'))).toBeNull();
    // Rows without the served field never invent the badge.
    const absent = render(<App>{signalsColumn.render(rowWith({}), t)}</App>);
    expect(within(absent.container).queryByText(TEXT.urgentStockoutNow)).toBeNull();
    expect(within(absent.container).queryByText(new RegExp('stockout'))).toBeNull();
  });

  it('R1-6: the qty cover note appears ONLY when the row deviates from the default horizon', () => {
    const supply = PANE_CONFIGS.find((config) => config.pane === 'supplyAction');
    const qtyColumn = supply?.columns.find((column) => column.key === 'orderQty');
    if (!qtyColumn) throw new Error('missing orderQty column');
    const ctx = makeContext(); // targetCoverDaysDefault: 45
    // DEFAULT horizon (fixture serves 45 == default): the rule lives in the header hint — no sub-line.
    const standard = render(<App>{qtyColumn.render(ENRICHED, t, ctx)}</App>);
    expect(within(standard.container).getByText('520')).toBeTruthy();
    expect(within(standard.container).queryByText(new RegExp(TEXT.coversPrefix))).toBeNull();
    // OPERATOR OVERRIDE (60 != 45): the deviation is worth a compact note.
    const override = render(<App>{qtyColumn.render({ ...ENRICHED, targetCoverDays: 60 }, t, ctx)}</App>);
    expect(within(override.container).getByText(`${TEXT.coversPrefix} 60 ${TEXT.dSuffix}`)).toBeTruthy();
  });

  it('R1-4: the qty column carries the supplier badge — named tag or the honest "No supplier"', () => {
    const supply = PANE_CONFIGS.find((config) => config.pane === 'supplyAction');
    const qtyColumn = supply?.columns.find((column) => column.key === 'orderQty');
    if (!qtyColumn) throw new Error('missing orderQty column');
    const withSupplier = render(<App>{qtyColumn.render(ENRICHED, t, makeContext())}</App>);
    expect(within(withSupplier.container).getByText('Lead Boundary Supplies')).toBeTruthy();
    expect(within(withSupplier.container).getByText(/30 \+ 7 d/)).toBeTruthy();
    const without = render(
      <App>
        {qtyColumn.render(
          {
            ...ENRICHED,
            supplier: { id: null, name: null, leadTimeDays: null, leadTimeConfirmedAt: null, leadTimeFreshness: null },
          },
          t,
          makeContext(),
        )}
      </App>,
    );
    expect(within(without.container).getByText(TEXT.noSupplier)).toBeTruthy();
  });

  it('R1-6: the money cell is compact dynamic-only (money + days, no static words)', () => {
    const supply = PANE_CONFIGS.find((config) => config.pane === 'supplyAction');
    const moneyColumn = supply?.columns.find((column) => column.key === 'moneyAtRisk');
    if (!moneyColumn) throw new Error('missing money column');
    const view = render(<App>{moneyColumn.render(ENRICHED, t, makeContext())}</App>);
    expect(within(view.container).getByText('€100.00')).toBeTruthy();
    expect(within(view.container).getByText(`· 28 ${TEXT.dSuffix}`)).toBeTruthy();
    expect(within(view.container).queryByText(/stockout gap/)).toBeNull();
  });

  it('T-R2: the FamilyCell tier pill coalesces CURRENT-first — identical to the sort/badge rule', () => {
    // Staging repro: sorted by COALESCE(current, baseline) but the pill showed
    // baseline ?? current — rows with differing tiers looked scattered.
    const promoted = render(
      <App>
        <FamilyCell row={rowWith({ tier: { baseline: 'A', current: 'B' } })} t={t} ctx={makeContext()} />
      </App>,
    );
    expect(within(promoted.container).getByText('B')).toBeTruthy();
    expect(within(promoted.container).queryByText('A')).toBeNull();
    const baselineOnly = render(
      <App>
        <FamilyCell row={rowWith({ tier: { baseline: 'C', current: null } })} t={t} ctx={makeContext()} />
      </App>,
    );
    expect(within(baselineOnly.container).getByText('C')).toBeTruthy();
  });

  it('R1-5: FamilyCell shows the prominent target SKU + member count; picker disabled for singles', () => {
    const ctx = makeContext();
    const single = render(
      <App>
        <FamilyCell row={rowWith({ familyMemberCount: 1 })} t={t} ctx={ctx} />
      </App>,
    );
    expect(within(single.container).getByText('SKU-f11a-lead-boundary')).toBeTruthy();
    expect(within(single.container).getByText(`· 1 ${TEXT.listingsSuffix}`)).toBeTruthy();
    const singleButton = within(single.container).getByRole('button', { name: new RegExp(TEXT.btnChangeTarget) });
    expect(singleButton).toHaveProperty('disabled', true);
    fireEvent.click(singleButton);
    expect(ctx.api.request).not.toHaveBeenCalled(); // no lazy fetch for singles
    const multi = render(
      <App>
        <FamilyCell row={rowWith({ familyMemberCount: 3 })} t={t} ctx={ctx} />
      </App>,
    );
    expect(within(multi.container).getByText(`· 3 ${TEXT.listingsSuffix}`)).toBeTruthy();
    expect(within(multi.container).getByRole('button', { name: new RegExp(TEXT.btnChangeTarget) })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('R1-3: clicking the target control never bubbles into the row click (CellInteractive)', async () => {
    const onRowClick = vi.fn();
    const ctx = makeContext();
    const view = render(
      <App>
        <div role="button" tabIndex={0} aria-label="table row" onClick={onRowClick} onKeyDown={() => undefined}>
          <FamilyCell row={rowWith({ familyMemberCount: 2 })} t={t} ctx={ctx} />
        </div>
      </App>,
    );
    fireEvent.click(within(view.container).getByRole('button', { name: new RegExp(TEXT.btnChangeTarget) }));
    expect(onRowClick).not.toHaveBeenCalled();
    // A click elsewhere in the row still opens the drawer path.
    fireEvent.click(within(view.container).getByText('B0011A'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});
