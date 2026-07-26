/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Gate G3 drawer suite. API mocks are the server-emitted expected-response
 * snapshots (pane + drawerContext), wrapped in the staging-captured 3-level
 * envelope. Mutations resolve `{}` unless a test overrides them.
 */

import { App } from 'antd';
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryDashboardPage from '../InventoryDashboardPage';
import type { ObserveVisibility } from '../PaneSection';
import headerFixture from '../../server/__tests__/fixtures/expected-responses/header.json';
import paneSupplyAction from '../../server/__tests__/fixtures/expected-responses/pane-supplyAction.json';
import paneActiveOrders from '../../server/__tests__/fixtures/expected-responses/pane-activeOrders.json';
import paneInPrep from '../../server/__tests__/fixtures/expected-responses/pane-inPrepMonitoring.json';
import paneInbound from '../../server/__tests__/fixtures/expected-responses/pane-inboundMonitoring.json';
import paneHealthy from '../../server/__tests__/fixtures/expected-responses/pane-healthyInventory.json';
import paneExcess from '../../server/__tests__/fixtures/expected-responses/pane-excessInventory.json';
import paneStuck from '../../server/__tests__/fixtures/expected-responses/pane-stuckInventory.json';
import paneZeroStock from '../../server/__tests__/fixtures/expected-responses/pane-zeroStock.json';
import paneDataReadiness from '../../server/__tests__/fixtures/expected-responses/pane-dataReadiness.json';
import panePerformance from '../../server/__tests__/fixtures/expected-responses/pane-performanceReview.json';
import paneUntiered from '../../server/__tests__/fixtures/expected-responses/pane-untieredProducts.json';
import drawerSupplyAction from '../../server/__tests__/fixtures/expected-responses/drawer-supplyAction.json';
import drawerActiveOrders from '../../server/__tests__/fixtures/expected-responses/drawer-activeOrders.json';
import drawerInPrep from '../../server/__tests__/fixtures/expected-responses/drawer-inPrepMonitoring.json';
import drawerInbound from '../../server/__tests__/fixtures/expected-responses/drawer-inboundMonitoring.json';
import drawerHealthy from '../../server/__tests__/fixtures/expected-responses/drawer-healthyInventory.json';
import drawerExcess from '../../server/__tests__/fixtures/expected-responses/drawer-excessInventory.json';
import drawerStuck from '../../server/__tests__/fixtures/expected-responses/drawer-stuckInventory.json';
import drawerZeroStock from '../../server/__tests__/fixtures/expected-responses/drawer-zeroStock.json';
import drawerDataReadiness from '../../server/__tests__/fixtures/expected-responses/drawer-dataReadiness.json';
import drawerPerformance from '../../server/__tests__/fixtures/expected-responses/drawer-performanceReview.json';
import drawerUntiered from '../../server/__tests__/fixtures/expected-responses/drawer-untieredProducts.json';
import paneDiscontinued from '../../server/__tests__/fixtures/expected-responses/pane-discontinuedPaused.json';
import drawerDiscontinued from '../../server/__tests__/fixtures/expected-responses/drawer-discontinuedPaused.json';
// (drawerHealthy + drawerActiveOrders reused directly by the final-round tests.)

const request = vi.fn();
const api = { request };
const navigateSpy = vi.fn();

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => api,
}));

vi.mock('../../../../client/locale', () => ({
  useT: () => (value: string) => value,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}));

const PANE_FIXTURES: Record<string, unknown> = {
  supplyAction: paneSupplyAction,
  activeOrders: paneActiveOrders,
  inPrepMonitoring: paneInPrep,
  inboundMonitoring: paneInbound,
  healthyInventory: paneHealthy,
  excessInventory: paneExcess,
  stuckInventory: paneStuck,
  zeroStock: paneZeroStock,
  dataReadiness: paneDataReadiness,
  performanceReview: panePerformance,
  untieredProducts: paneUntiered,
  discontinuedPaused: paneDiscontinued,
};

const DRAWER_FIXTURES: Record<string, unknown> = {
  supplyAction: drawerSupplyAction,
  activeOrders: drawerActiveOrders,
  inPrepMonitoring: drawerInPrep,
  inboundMonitoring: drawerInbound,
  healthyInventory: drawerHealthy,
  excessInventory: drawerExcess,
  stuckInventory: drawerStuck,
  zeroStock: drawerZeroStock,
  dataReadiness: drawerDataReadiness,
  performanceReview: drawerPerformance,
  untieredProducts: drawerUntiered,
  discontinuedPaused: drawerDiscontinued,
};

function respond(data: unknown) {
  return Promise.resolve({ status: 200, data: { data: { data } } });
}

interface MutationBehavior {
  fail?: boolean;
  delayed?: () => Promise<unknown>;
}

function mockApi(mutations: Record<string, MutationBehavior> = {}) {
  request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
    if (args.url === 'ecobaseInventoryDashboard:header') return respond(headerFixture);
    if (args.url === 'ecobaseInventoryDashboard:pane') return respond(PANE_FIXTURES[String(args.data.pane)]);
    if (args.url === 'ecobaseInventoryDashboard:drawerContext') {
      return respond(DRAWER_FIXTURES[String(args.data.pane)]);
    }
    const behavior = mutations[args.url];
    if (behavior?.fail) return Promise.reject(new Error('mutation boom'));
    if (behavior?.delayed) return behavior.delayed();
    return respond({ ok: true });
  });
}

function observeOnly(...panes: string[]): ObserveVisibility {
  return (element, onVisible) => {
    const pane = element instanceof HTMLElement ? element.dataset.pane : undefined;
    if (pane && panes.includes(pane)) onVisible();
    return () => undefined;
  };
}

function requests(url: string) {
  return request.mock.calls.filter(([args]: [{ url: string }]) => args.url === url);
}

function paneRequests(pane?: string) {
  return requests('ecobaseInventoryDashboard:pane').filter(
    ([args]: [{ data: Record<string, unknown> }]) => pane === undefined || args.data.pane === pane,
  );
}

/**
 * T6 changed the page: every pane except Supply Action now renders COLLAPSED, so a
 * row-level interaction has to open the pane first. Queries take the LAST matching
 * section because tests without an intervening cleanup() leave earlier renders behind.
 */
function latestSection(pane: string): HTMLElement | null {
  const sections = document.querySelectorAll(`section[data-pane="${pane}"]`);
  return sections.length ? (sections[sections.length - 1] as HTMLElement) : null;
}

async function expandPane(pane: string) {
  await waitFor(() => expect(latestSection(pane)).not.toBeNull());
  const section = latestSection(pane) as HTMLElement;
  if (!section.querySelector('.ant-collapse-item-active')) {
    fireEvent.click(section.querySelector('.ant-collapse-header') as HTMLElement);
  }
  await waitFor(() => expect(section.querySelectorAll('tbody tr.ant-table-row').length).toBeGreaterThan(0));
  return section;
}

async function openDrawer(pane: string, onPaneRender?: (pane: string) => void) {
  render(
    <App>
      <InventoryDashboardPage observeVisibility={observeOnly(pane)} onPaneRender={onPaneRender as never} />
    </App>,
  );
  const section = await expandPane(pane);
  const firstRow = section.querySelector('tbody tr.ant-table-row') as HTMLElement;
  fireEvent.click(firstRow);
  await waitFor(() => expect(requests('ecobaseInventoryDashboard:drawerContext')).toHaveLength(1));
  const dialog = await waitFor(() => {
    // Newest drawer wins: without auto-cleanup, earlier tests may leave stale
    // drawer DOM behind.
    const drawers = document.querySelectorAll('.ant-drawer-content');
    expect(drawers.length).toBeGreaterThan(0);
    return drawers[drawers.length - 1] as HTMLElement;
  });
  return dialog;
}

/**
 * 063 D6: the Reactivate action lives in the shared drawer's action bar and
 * opens a mandatory-reason modal (antd portals it to document.body, outside the
 * drawer element). Auto-cleanup is off in this suite, so the LAST match wins.
 */
async function openReactivateModal(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }));
  const inputs = await within(document.body).findAllByLabelText('Reactivation reason (required)');
  const reason = inputs[inputs.length - 1] as HTMLTextAreaElement;
  const modal = reason.closest('.ant-modal') as HTMLElement;
  return { modal, reason, ok: within(modal).getByRole('button', { name: 'Reactivate' }) };
}

/** 063 D5: the panes that share the Supply Action drawer body. */
const PRODUCT_PANES = [
  'healthyInventory',
  'excessInventory',
  'stuckInventory',
  'zeroStock',
  'untieredProducts',
  'discontinuedPaused',
];

describe('PaneDrawer (Gate G3)', () => {
  beforeEach(() => {
    request.mockReset();
    navigateSpy.mockReset();
    mockApi();
  });

  // T4 (order-pane redesign): activeOrders/inPrepMonitoring/inboundMonitoring rows render in
  // OrderPaneTable and open the ORDER popup, not this family-grain drawer. They are covered by
  // the order-workbench suites; every assertion below therefore uses a family-grain pane.
  it('063 D5: every product pane opens the shared rich drawer (four tabs + action bar)', async () => {
    for (const pane of PRODUCT_PANES) {
      request.mockReset();
      mockApi();
      const dialog = await openDrawer(pane);
      expect(within(dialog).getByRole('tab', { name: 'Overview' })).toBeTruthy();
      expect(within(dialog).getByRole('tab', { name: /^Orders/ })).toBeTruthy();
      expect(within(dialog).getByRole('tab', { name: /^Comments/ })).toBeTruthy();
      expect(within(dialog).getByRole('tab', { name: 'Data' })).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Create order' })).toBeTruthy();
      // The v1 body is gone: no Descriptions summary with its "SKU" label row.
      expect(within(dialog).queryByText('SKU')).toBeNull();
      cleanup();
    }
  });

  it('keeps the v1 drawer body for the panes outside the product table', async () => {
    // 066 D4 took Data issues out of this list — Performance Review is the last
    // family-grain pane on the v1 body.
    const markers: Record<string, string> = {
      performanceReview: 'Monthly units (last closed months)',
    };
    for (const [pane, marker] of Object.entries(markers)) {
      request.mockReset();
      mockApi();
      const dialog = await openDrawer(pane);
      // Common sections always render (a11y: drawer is a dialog with content).
      expect(within(dialog).getAllByText('SKU').length).toBeGreaterThan(0);
      expect(within(dialog).getAllByText(marker).length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it('066 D4: a Data issues row opens the SAME rich drawer as Supply Action', async () => {
    const dialog = await openDrawer('dataReadiness');
    // The rich body: four tabs + the action bar.
    expect(within(dialog).getByRole('tab', { name: 'Overview' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: /^Orders/ })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: /^Comments/ })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'Data' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Create order' })).toBeTruthy();
    // 063 D6: the reasons strip names the issue that put the row in this pane.
    expect(within(dialog).getAllByText("Why it's here").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('Family review required').length).toBeGreaterThan(0);
    // The v1 body is gone with every part of it: no Descriptions summary, no
    // inline supplier form, and (issue 042 guard) no deep links out of the page.
    expect(within(dialog).queryByText('SKU')).toBeNull();
    expect(within(dialog).queryByText('Readiness reasons')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Open Supplier Management' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Open Inventory Planning' })).toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('066 D4: the pane title travels into the drawer as the renamed "Data issues"', async () => {
    const dialog = await openDrawer('dataReadiness');
    // paneTitle() feeds the drawer title, the body's aria-label and the rich
    // body's action bar — every one of them must read the new name.
    expect(document.body.textContent).toContain('Data issues');
    expect(document.body.textContent).not.toContain('Data Readiness');
    expect(within(dialog).getAllByLabelText(/Data issues/).length).toBeGreaterThan(0);
  });

  it('sends dashboard-shaped mutation payloads and refreshes only the affected pane + header', async () => {
    const dialog = await openDrawer('discontinuedPaused');
    const headerCallsBefore = requests('ecobaseInventoryDashboard:header').length;
    const paneCallsBefore = paneRequests('discontinuedPaused').length;

    const { reason, ok } = await openReactivateModal(dialog);
    fireEvent.change(reason, { target: { value: 'Chasing the supplier' } });
    fireEvent.click(ok);

    await waitFor(() => expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(1));
    const [args] = requests('ecobaseInventoryDashboard:reactivateFamily')[0];
    expect(args.data).toMatchObject({ familyId: expect.any(String), comment: 'Chasing the supplier' });

    // Scoped refresh: exactly one more header call + one more fetch of THIS pane, no others.
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:header').length).toBe(headerCallsBefore + 1));
    await waitFor(() => expect(paneRequests('discontinuedPaused').length).toBe(paneCallsBefore + 1));
    expect(paneRequests().length).toBe(paneRequests('discontinuedPaused').length);
  });

  it('keeps the drawer open with buffers intact and no refetch when a mutation fails', async () => {
    request.mockReset();
    mockApi({ 'ecobaseInventoryDashboard:reactivateFamily': { fail: true } });
    const dialog = await openDrawer('discontinuedPaused');
    const drawerContextCalls = requests('ecobaseInventoryDashboard:drawerContext').length;
    const paneCalls = paneRequests().length;

    const { reason, ok } = await openReactivateModal(dialog);
    fireEvent.change(reason, { target: { value: 'important note' } });
    fireEvent.click(ok);

    expect(await within(dialog).findByText('mutation boom')).toBeTruthy();
    // Drawer still open, buffer preserved, no refetch of pane or context.
    expect(document.querySelector('.ant-drawer-content')).not.toBeNull();
    expect(reason.value).toBe('important note');
    expect(requests('ecobaseInventoryDashboard:drawerContext')).toHaveLength(drawerContextCalls);
    expect(paneRequests()).toHaveLength(paneCalls);
  });

  it('ignores a second submit while a mutation is pending (double-submit guard)', async () => {
    let release: (value: unknown) => void = () => undefined;
    request.mockReset();
    mockApi({
      'ecobaseInventoryDashboard:reactivateFamily': {
        delayed: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    const dialog = await openDrawer('discontinuedPaused');
    const { reason, ok } = await openReactivateModal(dialog);
    fireEvent.change(reason, { target: { value: 'once only' } });
    fireEvent.click(ok);
    fireEvent.click(ok);
    fireEvent.click(ok);
    expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(1);
    act(() => {
      release({ status: 200, data: { data: { data: { ok: true } } } });
    });
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:header').length).toBeGreaterThan(1));
  });

  it('does not re-render pane sections while typing in the drawer (render isolation)', async () => {
    const renderSpy = vi.fn();
    const dialog = await openDrawer('discontinuedPaused', renderSpy);
    const { reason } = await openReactivateModal(dialog);
    renderSpy.mockClear();
    for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      fireEvent.change(reason, { target: { value } });
    }
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('T8b supersedes T-3.3: Supply Action creates orders IN the drawer (no Order-Planning deep link)', async () => {
    const dialog = await openDrawer('supplyAction');
    // The v2 action bar leads with in-drawer creation...
    expect(within(dialog).getByRole('button', { name: 'Create order' })).toBeTruthy();
    // ...and the old deep-link button is gone.
    expect(within(dialog).queryByRole('button', { name: 'Open in Order Planning' })).toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  /*
   * "QA item 6: data-readiness deep links carry non-empty search params" was
   * deleted here (066 D4): the Supplier-Management deep link was the v1 body's
   * last navigation, and the rich body replaces it with in-drawer context. The
   * surviving guard — no deep-link buttons, `navigate` never called — moved
   * into the D4 routing test above.
   */

  it('QA item 4: focus moves into the drawer on open and returns to the trigger row on close', async () => {
    const dialog = await openDrawer('discontinuedPaused');
    const triggerRow = latestSection('discontinuedPaused')?.querySelector('tbody tr.ant-table-row') as HTMLElement;
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    fireEvent.click(dialog.querySelector('.ant-drawer-close') as HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(triggerRow));
  });

  it('polish item 2: focus stays inside the drawer after a mutation-driven scoped refresh', async () => {
    const dialog = await openDrawer('discontinuedPaused');
    const { reason, ok } = await openReactivateModal(dialog);
    fireEvent.change(reason, { target: { value: 'focus check' } });
    fireEvent.click(ok);
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(1));
    // The scoped refresh re-renders page + drawer; focus must remain usable inside it.
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('QA item 5: shows a progress hint when the drawer context is still loading after 10s', async () => {
    request.mockReset();
    request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
      if (args.url === 'ecobaseInventoryDashboard:header') return respond(headerFixture);
      if (args.url === 'ecobaseInventoryDashboard:pane') return respond(PANE_FIXTURES[String(args.data.pane)]);
      if (args.url === 'ecobaseInventoryDashboard:drawerContext') return new Promise(() => undefined); // hangs
      return respond({ ok: true });
    });
    render(
      <App>
        <InventoryDashboardPage observeVisibility={observeOnly('discontinuedPaused')} />
      </App>,
    );
    const section = await expandPane('discontinuedPaused');
    // Fake timers BEFORE opening so the 10s hint timer is armed under them.
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(section.querySelector('tbody tr.ant-table-row') as HTMLElement);
    });
    expect(requests('ecobaseInventoryDashboard:drawerContext')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Still loading');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    vi.useRealTimers();
    expect(document.body.textContent).toContain('Still loading');
  });

  it('polish item 3: reason badges render friendly labels with raw-code fallback', async () => {
    const dialog = await openDrawer('dataReadiness');
    // drawer-dataReadiness.json primary row reasonCodes = ['family_review_required'].
    expect(within(dialog).getAllByText('Family review required').length).toBeGreaterThan(0);
    expect(within(dialog).queryByText('family_review_required')).toBeNull();
  });

  it('task 002 / 063 D6: Reactivate is discontinuedPaused-only and needs a reason', async () => {
    // Absent on a sibling product pane that shares the very same drawer body...
    const excess = await openDrawer('excessInventory');
    expect(within(excess).queryByRole('button', { name: 'Reactivate' })).toBeNull();
    cleanup();
    request.mockReset();
    mockApi();

    // ...present on Discontinued & Paused, behind a mandatory-reason modal.
    const dialog = await openDrawer('discontinuedPaused');
    const { reason, ok } = await openReactivateModal(dialog);
    // Without a reason nothing is sent.
    expect(ok).toHaveProperty('disabled', true);
    fireEvent.click(ok);
    expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(0);
    fireEvent.change(reason, { target: { value: 'Back in stock soon' } });
    await waitFor(() => expect(ok).toHaveProperty('disabled', false));
    fireEvent.click(ok);
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(1));
    expect(requests('ecobaseInventoryDashboard:reactivateFamily')[0][0].data).toMatchObject({
      familyId: 'family-disc',
      comment: 'Back in stock soon',
    });
  });

  it('063 D6: the reasons strip explains non-Supply-Action panes only', async () => {
    const withReasons = (fixture: unknown, pane: string) => {
      const base = fixture as { primaryRow: Record<string, unknown> };
      return {
        ...(fixture as Record<string, unknown>),
        primaryRow: { ...base.primaryRow, pane, reasonCodes: ['family_review_required'] },
      };
    };
    const mockDrawer = (context: unknown) => {
      request.mockReset();
      request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
        if (args.url === 'ecobaseInventoryDashboard:header') return respond(headerFixture);
        if (args.url === 'ecobaseInventoryDashboard:pane') return respond(PANE_FIXTURES[String(args.data.pane)]);
        if (args.url === 'ecobaseInventoryDashboard:drawerContext') return respond(context);
        return respond({ ok: true });
      });
    };

    // Stuck row: the strip names why the product landed in this pane.
    mockDrawer(withReasons(drawerStuck, 'stuckInventory'));
    const stuck = await openDrawer('stuckInventory');
    expect(within(stuck).getAllByText("Why it's here").length).toBeGreaterThan(0);
    expect(within(stuck).getAllByText('Family review required').length).toBeGreaterThan(0);
    cleanup();

    // Supply Action row with the SAME codes: parity guarantee — nothing renders.
    mockDrawer(withReasons(drawerSupplyAction, 'supplyAction'));
    const supply = await openDrawer('supplyAction');
    expect(within(supply).queryByText("Why it's here")).toBeNull();
    expect(within(supply).queryByText('Family review required')).toBeNull();
  });

  it('063 D6: the previous-status line survives on discontinued rows only', async () => {
    // drawer-discontinuedPaused.json: lifecyclePreviousStatus = candidate_new_product.
    const dialog = await openDrawer('discontinuedPaused');
    expect(within(dialog).getByText('Previous status: candidate_new_product')).toBeTruthy();
    cleanup();
    request.mockReset();
    mockApi();
    // Rows without the field (every other product pane) render no line at all.
    const excess = await openDrawer('excessInventory');
    expect(within(excess).queryByText(/^Previous status:/)).toBeNull();
  });

  it('final item 1: the drawer header renders the primaryRow identity even when orderRows are present', async () => {
    // QA blocker reproduction: family-grain click (NO orderId) on a family
    // that HAS order data — the header must show the clicked/primary listing,
    // never a sibling order row.
    const primary = (drawerHealthy as { primaryRow: { identity: { sku: string } } }).primaryRow;
    const foreignOrderRows = (drawerActiveOrders as { orderRows: unknown[] }).orderRows;
    request.mockReset();
    request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
      if (args.url === 'ecobaseInventoryDashboard:header') return respond(headerFixture);
      if (args.url === 'ecobaseInventoryDashboard:pane') return respond(PANE_FIXTURES[String(args.data.pane)]);
      if (args.url === 'ecobaseInventoryDashboard:drawerContext') {
        return respond({ ...(drawerHealthy as Record<string, unknown>), orderRows: foreignOrderRows });
      }
      return respond({ ok: true });
    });
    const dialog = await openDrawer('healthyInventory');
    const foreignSku = (foreignOrderRows[0] as { identity: { sku: string } }).identity.sku;
    // 063 D5: the shared body's identity header must carry the primary listing,
    // and no sibling order row's identity may leak into it.
    expect(dialog.textContent).toContain(primary.identity.sku);
    expect(dialog.textContent).not.toContain(foreignSku);
  });

  it('final item 2: family target member and selection provenance are visible', async () => {
    // 063 D5: product panes retarget through the shared action bar's modal.
    const dialog = await openDrawer('healthyInventory');
    expect(within(dialog).getByRole('button', { name: 'Change target…' })).toBeTruthy();
    // 066 D4: Data issues reaches the very same retarget affordance now — the
    // v1 "none (target in review)" line went with the v1 body.
    cleanup();
    request.mockReset();
    mockApi();
    const readiness = await openDrawer('dataReadiness');
    expect(within(readiness).getByRole('button', { name: 'Change target…' })).toBeTruthy();
    expect(within(readiness).queryByText(/none \(target in review\)/)).toBeNull();
  });

  it('final item 4: reactivation and supplier assignment confirm success with a toast', async () => {
    const dialog = await openDrawer('discontinuedPaused');
    const { reason, ok } = await openReactivateModal(dialog);
    fireEvent.change(reason, { target: { value: 'Back in business' } });
    fireEvent.click(ok);
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(1));
    expect(
      await within(document.body).findByText(
        'Family reactivated — it returns to normal classification on the next publish',
      ),
    ).toBeTruthy();
  });

  /*
   * "final item 5: the Assign-supplier select is properly labelled" and
   * "T8a (X4 closed): AssignSupplierForm submits through the dashboard
   * resource" were deleted here (066 D4) together with the component they
   * tested. Both live on against the rich body's Change-supplier modal in
   * supply-action-drawer.test.tsx: it finds the modal BY the same
   * `TEXT.drawerAssignSupplier` label and asserts the payload goes to
   * `ecobaseInventoryDashboard:setFamilyPreferredSupplier`.
   */

  it('QA item 7: the drawerContext request carries the clicked listing id', async () => {
    await openDrawer('healthyInventory');
    const [args] = requests('ecobaseInventoryDashboard:drawerContext')[0];
    expect(typeof args.data.listingRowId).toBe('string');
    expect((args.data.listingRowId as string).length).toBeGreaterThan(0);
  });
});

/**
 * 065: the recent-tier window reaches the drawer.
 *
 * The identity header wears the same badge as every table cell — current tier,
 * else the last closed month with a muted hint, else nothing. `baselineTier` is
 * history: banished from the header, it gets one muted line in Overview (Supply
 * Action rows included — the drawer is the agreed home for history). The header
 * pill adopts the table's 063-D2 evidence gate, minus the em-dash.
 */
describe('065: recent tier in the drawer, baseline as history', () => {
  type FixtureContext = { primaryRow: Record<string, unknown> };
  const primaryRowOf = (fixture: unknown) => (fixture as FixtureContext).primaryRow;

  const withPrimaryRow = (fixture: unknown, patch: Record<string, unknown>) => ({
    ...(fixture as Record<string, unknown>),
    primaryRow: { ...primaryRowOf(fixture), ...patch },
  });

  /** Everything calm + fresh lead time + trusted velocity = the `order_soon` command. */
  const orderSoon = (fixture: unknown) => ({
    daysUntilSafeReorder: 20,
    supplier: { ...(primaryRowOf(fixture).supplier as Record<string, unknown>), leadTimeFreshness: 'fresh' },
    velocity: { ...(primaryRowOf(fixture).velocity as Record<string, unknown>), basis: 'rolling_30' },
  });

  const mockDrawer = (context: unknown) => {
    request.mockReset();
    request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
      if (args.url === 'ecobaseInventoryDashboard:header') return respond(headerFixture);
      if (args.url === 'ecobaseInventoryDashboard:pane') return respond(PANE_FIXTURES[String(args.data.pane)]);
      if (args.url === 'ecobaseInventoryDashboard:drawerContext') return respond(context);
      return respond({ ok: true });
    });
  };

  /** The identity badge is the only drawer tag whose text is a bare tier letter. */
  const tierBadges = (scope: HTMLElement) =>
    Array.from(scope.querySelectorAll<HTMLElement>('.ant-tag')).filter((tag) =>
      /^[A-D]$/.test((tag.textContent ?? '').trim()),
    );

  beforeEach(() => {
    cleanup();
    request.mockReset();
    navigateSpy.mockReset();
    mockApi();
  });

  it('badges the last closed month with a hint; a baseline-only row gets a line, never a badge', async () => {
    // Zero-stock is the live case — 5 of its rows are ranked by last month only.
    mockDrawer(withPrimaryRow(drawerZeroStock, { tier: { baseline: null, current: null, lastClosedMonth: 'B' } }));
    const lastMonth = await openDrawer('zeroStock');
    expect(tierBadges(lastMonth).map((tag) => tag.textContent)).toEqual(['B']);
    expect(within(lastMonth).getAllByText('last mo.').length).toBeGreaterThan(0);
    // No baseline on this row -> no historical line invented.
    expect(within(lastMonth).queryByText(/^Baseline tier \(historical\)/)).toBeNull();
    cleanup();

    // Baseline-only, on a SUPPLY ACTION row: the header stays silent about a
    // rank the product has not earned in two months...
    mockDrawer(withPrimaryRow(drawerSupplyAction, { tier: { baseline: 'C', current: null, lastClosedMonth: null } }));
    const baselineOnly = await openDrawer('supplyAction');
    expect(tierBadges(baselineOnly)).toHaveLength(0);
    expect(within(baselineOnly).queryByText('last mo.')).toBeNull();
    // ...while Overview keeps the history, in words, where it cannot mislead.
    expect(within(baselineOnly).getByText('Baseline tier (historical): C')).toBeTruthy();
  });

  it('keeps the current tier plain and unhinted when the product is ranked this month', async () => {
    mockDrawer(withPrimaryRow(drawerStuck, { tier: { baseline: 'A', current: 'B', lastClosedMonth: 'D' } }));
    const dialog = await openDrawer('stuckInventory');
    expect(tierBadges(dialog).map((tag) => tag.textContent)).toEqual(['B']);
    expect(within(dialog).queryByText('last mo.')).toBeNull();
    // Baseline still narrates itself below, without ever colouring a badge.
    expect(within(dialog).getByText('Baseline tier (historical): A')).toBeTruthy();
  });

  it('header pill: ordering COMMANDS stay silent off Supply Action, evidence verdicts still speak', async () => {
    // A stuck product told to "Order soon" would be a wrong recommendation (F7).
    mockDrawer(withPrimaryRow(drawerStuck, { pane: 'stuckInventory', ...orderSoon(drawerStuck) }));
    const command = await openDrawer('stuckInventory');
    expect(within(command).queryByText('Order soon')).toBeNull();
    // The header shows nothing at all — the table's em-dash would be noise here.
    expect(within(command).queryByText('Overdue — order today')).toBeNull();
    cleanup();

    // Evidence-driven verdicts are pane-independent and keep speaking (063-D2).
    mockDrawer(
      withPrimaryRow(drawerStuck, { pane: 'stuckInventory', ...orderSoon(drawerStuck), daysUntilSafeReorder: -3 }),
    );
    const evidence = await openDrawer('stuckInventory');
    expect(within(evidence).getAllByText('Overdue — order today').length).toBeGreaterThan(0);
    cleanup();

    // The SAME command verdict on a Supply Action row still speaks — that pane
    // IS the ordering queue.
    mockDrawer(withPrimaryRow(drawerSupplyAction, { pane: 'supplyAction', ...orderSoon(drawerSupplyAction) }));
    const supply = await openDrawer('supplyAction');
    expect(within(supply).getAllByText('Order soon').length).toBeGreaterThan(0);
  });
});
