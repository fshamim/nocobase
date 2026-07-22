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

async function openDrawer(pane: string, onPaneRender?: (pane: string) => void) {
  render(
    <App>
      <InventoryDashboardPage observeVisibility={observeOnly(pane)} onPaneRender={onPaneRender as never} />
    </App>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll(`section[data-pane="${pane}"] tbody tr.ant-table-row`).length).toBeGreaterThan(0),
  );
  const firstRow = document.querySelector(`section[data-pane="${pane}"] tbody tr.ant-table-row`) as HTMLElement;
  fireEvent.click(firstRow);
  await waitFor(() => expect(requests('ecobaseInventoryDashboard:drawerContext')).toHaveLength(1));
  const dialog = await waitFor(() => {
    const found = document.querySelector('.ant-drawer-content');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  return dialog;
}

describe('PaneDrawer (Gate G3)', () => {
  beforeEach(() => {
    request.mockReset();
    navigateSpy.mockReset();
    mockApi();
  });

  it('resolves a drawer body for all 11 panes with pane-specific content', async () => {
    const markers: Record<string, string | null> = {
      supplyAction: 'Open in Order Planning',
      activeOrders: 'Change status',
      inPrepMonitoring: 'Prep details',
      inboundMonitoring: 'Adjust expected delivery',
      healthyInventory: null, // read-only evidence
      excessInventory: null,
      stuckInventory: 'Stuck reasons',
      zeroStock: null,
      dataReadiness: 'Readiness reasons',
      performanceReview: 'Monthly units (last closed months)',
      untieredProducts: 'Tier evidence',
      discontinuedPaused: 'Reactivate',
    };
    for (const [pane, marker] of Object.entries(markers)) {
      request.mockReset();
      mockApi();
      const dialog = await openDrawer(pane);
      // Common sections always render (a11y: drawer is a dialog with content).
      expect(within(dialog).getAllByText('SKU').length).toBeGreaterThan(0);
      if (marker) {
        expect(within(dialog).getAllByText(marker).length).toBeGreaterThan(0);
      }
      cleanup();
    }
  });

  it('sends dashboard-shaped mutation payloads and refreshes only the affected pane + header', async () => {
    const dialog = await openDrawer('inPrepMonitoring');
    const headerCallsBefore = requests('ecobaseInventoryDashboard:header').length;
    const paneCallsBefore = paneRequests('inPrepMonitoring').length;

    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Chasing the supplier' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    await waitFor(() => expect(requests('ecobaseOrderPlanning:addComment')).toHaveLength(1));
    const [args] = requests('ecobaseOrderPlanning:addComment')[0];
    expect(args.data).toMatchObject({ orderId: expect.any(String), body: 'Chasing the supplier' });

    // Scoped refresh: exactly one more header call + one more fetch of THIS pane, no others.
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:header').length).toBe(headerCallsBefore + 1));
    await waitFor(() => expect(paneRequests('inPrepMonitoring').length).toBe(paneCallsBefore + 1));
    expect(paneRequests().length).toBe(paneRequests('inPrepMonitoring').length);

    // savePrepDetails payload from the prep form.
    fireEvent.change(within(dialog).getByLabelText('Boxes'), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save prep details' }));
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:savePrepDetails')).toHaveLength(1));
    expect(requests('ecobaseInventoryDashboard:savePrepDetails')[0][0].data).toMatchObject({
      orderId: expect.any(String),
      prepBoxes: 4,
    });

    // Supplier ship route (T-3.0b) — action present with labelled control.
    expect(within(dialog).getAllByText('Set supplier ship route').length).toBeGreaterThan(0);
  });

  it('keeps the drawer open with buffers intact and no refetch when a mutation fails', async () => {
    request.mockReset();
    mockApi({ 'ecobaseOrderPlanning:addComment': { fail: true } });
    const dialog = await openDrawer('inPrepMonitoring');
    const drawerContextCalls = requests('ecobaseInventoryDashboard:drawerContext').length;
    const paneCalls = paneRequests().length;

    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'important note' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    expect(await within(dialog).findByText('mutation boom')).toBeTruthy();
    // Drawer still open, buffer preserved, no refetch of pane or context.
    expect(document.querySelector('.ant-drawer-content')).not.toBeNull();
    expect((within(dialog).getByLabelText('Comment') as HTMLTextAreaElement).value).toBe('important note');
    expect(requests('ecobaseInventoryDashboard:drawerContext')).toHaveLength(drawerContextCalls);
    expect(paneRequests()).toHaveLength(paneCalls);
  });

  it('ignores a second submit while a mutation is pending (double-submit guard)', async () => {
    let release: (value: unknown) => void = () => undefined;
    request.mockReset();
    mockApi({
      'ecobaseOrderPlanning:addComment': {
        delayed: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    const dialog = await openDrawer('inPrepMonitoring');
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'once only' } });
    const button = within(dialog).getByRole('button', { name: 'Add comment' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(requests('ecobaseOrderPlanning:addComment')).toHaveLength(1);
    act(() => {
      release({ status: 200, data: { data: { data: { ok: true } } } });
    });
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:header').length).toBeGreaterThan(1));
  });

  it('does not re-render pane sections while typing in the drawer (render isolation)', async () => {
    const renderSpy = vi.fn();
    const dialog = await openDrawer('inPrepMonitoring', renderSpy);
    renderSpy.mockClear();
    const input = within(dialog).getByLabelText('Comment');
    for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      fireEvent.change(input, { target: { value } });
    }
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('deep-links Supply Action to Order Planning instead of in-drawer creation (T-3.3)', async () => {
    const dialog = await openDrawer('supplyAction');
    expect(within(dialog).getAllByText(/Suggested order quantity/).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open in Order Planning' }));
    const call = navigateSpy.mock.calls.at(-1)?.[0] as string;
    expect(call).toContain('/admin/ecobase/order-planning?search=');
    // QA item 6: the param must actually carry a value.
    expect(call.split('?search=')[1]?.length).toBeGreaterThan(0);
  });

  it('QA item 6: data-readiness deep links carry non-empty search params', async () => {
    const dialog = await openDrawer('dataReadiness');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Inventory Planning' }));
    const inv = navigateSpy.mock.calls.at(-1)?.[0] as string;
    expect(inv).toContain('/admin/ecobase/inventory-planning?search=');
    expect(inv.split('?search=')[1]?.length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Supplier Management' }));
    const sup = navigateSpy.mock.calls.at(-1)?.[0] as string;
    expect(sup).toContain('/admin/ecobase/supplier-management?search=');
  });

  it('QA item 4: focus moves into the drawer on open and returns to the trigger row on close', async () => {
    const dialog = await openDrawer('inPrepMonitoring');
    const triggerRow = document.querySelector(
      'section[data-pane="inPrepMonitoring"] tbody tr.ant-table-row',
    ) as HTMLElement;
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    fireEvent.click(dialog.querySelector('.ant-drawer-close') as HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(triggerRow));
  });

  it('polish item 2: focus stays inside the drawer after a mutation-driven scoped refresh', async () => {
    const dialog = await openDrawer('inPrepMonitoring');
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'focus check' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(requests('ecobaseOrderPlanning:addComment')).toHaveLength(1));
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
        <InventoryDashboardPage observeVisibility={observeOnly('inPrepMonitoring')} />
      </App>,
    );
    await waitFor(() =>
      expect(
        document.querySelectorAll('section[data-pane="inPrepMonitoring"] tbody tr.ant-table-row').length,
      ).toBeGreaterThan(0),
    );
    // Fake timers BEFORE opening so the 10s hint timer is armed under them.
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(
        document.querySelector('section[data-pane="inPrepMonitoring"] tbody tr.ant-table-row') as HTMLElement,
      );
    });
    expect(requests('ecobaseInventoryDashboard:drawerContext')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Still loading');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    vi.useRealTimers();
    expect(document.body.textContent).toContain('Still loading');
  });

  it('polish item 1: renders the last activity from the drawer snapshot in the order summary', async () => {
    // drawer-activeOrders.json primary row (order-4a) carries lastActivity
    // "Approved to order" emitted by the G1 suite.
    const dialog = await openDrawer('activeOrders');
    expect(within(dialog).getAllByText('Last activity').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('Approved to order').length).toBeGreaterThan(0);
  });

  it('polish item 3: reason badges render friendly labels with raw-code fallback', async () => {
    const dialog = await openDrawer('dataReadiness');
    // drawer-dataReadiness.json primary row reasonCodes = ['family_review_required'].
    expect(within(dialog).getAllByText('Family review required').length).toBeGreaterThan(0);
    expect(within(dialog).queryByText('family_review_required')).toBeNull();
  });

  it('task 002: the Discontinued & Paused drawer reactivates with a required reason', async () => {
    const dialog = await openDrawer('discontinuedPaused');
    const button = within(dialog).getByRole('button', { name: 'Reactivate' });
    // Without a reason nothing is sent.
    fireEvent.click(button);
    expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Reactivation reason (required)'), {
      target: { value: 'Back in stock soon' },
    });
    fireEvent.click(button);
    await waitFor(() => expect(requests('ecobaseInventoryDashboard:reactivateFamily')).toHaveLength(1));
    expect(requests('ecobaseInventoryDashboard:reactivateFamily')[0][0].data).toMatchObject({
      familyId: 'family-disc',
      comment: 'Back in stock soon',
    });
  });

  it('QA item 7: the drawerContext request carries the clicked listing id', async () => {
    await openDrawer('healthyInventory');
    const [args] = requests('ecobaseInventoryDashboard:drawerContext')[0];
    expect(typeof args.data.listingRowId).toBe('string');
    expect((args.data.listingRowId as string).length).toBeGreaterThan(0);
  });
});
