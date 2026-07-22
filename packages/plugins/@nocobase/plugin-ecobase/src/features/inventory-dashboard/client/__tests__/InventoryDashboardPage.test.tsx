/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Gate G2 client suite. The ONLY API mocks are the typed response snapshots
 * emitted by the G1 server suite (expected-responses/*.json) — no hand-written
 * payloads (except the runSuperseded signal, which is a contract shape the
 * server emits only mid-republication).
 */

import { App } from 'antd';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import paneDiscontinued from '../../server/__tests__/fixtures/expected-responses/pane-discontinuedPaused.json';

const request = vi.fn();
const api = { request };

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => api,
}));

vi.mock('../../../../client/locale', () => ({
  useT: () => (value: string) => value,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
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

/**
 * REAL transport envelope, captured from staging 2026-07-22 (image
 * staging-83737af): the HTTP body is `{"data":{"data":<payload>}}` — the
 * action middleware wraps the action's own `{ data: payload }` — and the axios
 * client exposes the body as `response.data`, so the resolved value carries
 * THREE `data` levels. The staging G2 crash (header.tiles undefined -> .map
 * TypeError) came from mocking only two levels; this mock must stay at the
 * real depth so that bug class cannot be reintroduced.
 */
function respond(data: unknown) {
  return Promise.resolve({ status: 200, data: { data: { data } } });
}

interface MockApiOptions {
  failPanes?: Set<string>;
  supersedePanes?: Set<string>;
  headerPayload?: unknown;
}

function mockApi(options: MockApiOptions = {}) {
  request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
    if (args.url === 'ecobaseInventoryDashboard:header') {
      return respond('headerPayload' in options ? options.headerPayload : headerFixture);
    }
    if (args.url === 'ecobaseInventoryDashboard:pane') {
      const pane = String(args.data.pane);
      if (options.failPanes?.has(pane)) return Promise.reject(new Error('boom'));
      if (options.supersedePanes?.has(pane)) {
        return respond({ runSuperseded: true, publishedRunId: 'run-published-0002' });
      }
      return respond(PANE_FIXTURES[pane]);
    }
    return Promise.reject(new Error(`Unexpected dashboard request: ${args.url}`));
  });
}

const observeAll: ObserveVisibility = (_element, onVisible) => {
  onVisible();
  return () => undefined;
};

const observeNever: ObserveVisibility = () => () => undefined;

function observeOnly(...panes: string[]): ObserveVisibility {
  return (element, onVisible) => {
    const pane = element instanceof HTMLElement ? element.dataset.pane : undefined;
    if (pane && panes.includes(pane)) onVisible();
    return () => undefined;
  };
}

function paneRequests(pane?: string) {
  return request.mock.calls.filter(
    ([args]: [{ url: string; data: Record<string, unknown> }]) =>
      args.url === 'ecobaseInventoryDashboard:pane' && (pane === undefined || args.data.pane === pane),
  );
}

function renderPage(observeVisibility: ObserveVisibility) {
  return render(
    <App>
      <InventoryDashboardPage observeVisibility={observeVisibility} />
    </App>,
  );
}

describe('InventoryDashboardPage (Gate G2)', () => {
  beforeEach(() => {
    request.mockReset();
    mockApi();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders KPI tiles verbatim from the G1 header snapshot with an accessible group and zero disabled controls', async () => {
    renderPage(observeNever);
    const group = await screen.findByRole('group', { name: 'Inventory Dashboard' });
    const urgent = within(group).getByRole('button', { name: 'Urgent stockout risk' });
    expect(urgent).toHaveTextContent('2');
    expect(within(group).getByRole('button', { name: 'Needs follow-up' })).toHaveTextContent('6');
    expect(within(group).getByRole('button', { name: 'Ordered but late' })).toHaveTextContent('€500.00');
    expect(screen.getByText(`Published run: ${headerFixture.publishedRunId}`)).toBeTruthy();
    // Lazy: nothing visible yet -> zero pane fetches (REQ-H6 fetch happens on demand).
    expect(paneRequests()).toHaveLength(0);
    // REQ-X3: zero disabled controls without handlers.
    expect(document.querySelectorAll('button[disabled]')).toHaveLength(0);
    // Search + company filter are labelled (a11y).
    expect(screen.getByLabelText('Search')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Company' })).toBeTruthy();
  });

  it('lazily fetches only panes that become visible, pinning the published runId', async () => {
    renderPage(observeOnly('supplyAction'));
    await waitFor(() => expect(paneRequests('supplyAction')).toHaveLength(1));
    expect(paneRequests()).toHaveLength(1);
    const [args] = paneRequests('supplyAction')[0];
    expect(args.data.runId).toBe(headerFixture.publishedRunId);
    expect(await screen.findByText('SKU-f9b-supply-null-risk')).toBeTruthy();
  });

  it('deep-links a KPI tile to its un-fetched pane and focuses the pane heading (REQ-H6)', async () => {
    renderPage(observeNever);
    const tile = await screen.findByRole('button', { name: 'Needs follow-up' });
    expect(paneRequests('inPrepMonitoring')).toHaveLength(0);
    fireEvent.click(tile);
    await waitFor(() => expect(paneRequests('inPrepMonitoring')).toHaveLength(1));
    const heading = document.getElementById('inventory-dashboard-pane-inPrepMonitoring');
    expect(heading).not.toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it('debounces search at 300ms: 5 keystrokes produce exactly 1 pane request', async () => {
    renderPage(observeOnly('supplyAction'));
    await waitFor(() => expect(paneRequests('supplyAction')).toHaveLength(1));

    vi.useFakeTimers();
    const input = screen.getByLabelText('Search');
    for (const value of ['B', 'B0', 'B00', 'B001', 'B0011']) {
      fireEvent.change(input, { target: { value } });
    }
    expect(paneRequests('supplyAction')).toHaveLength(1); // still only the initial fetch
    act(() => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();

    await waitFor(() => expect(paneRequests('supplyAction')).toHaveLength(2));
    const searched = paneRequests('supplyAction').filter(([args]) => args.data.search === 'B0011');
    expect(searched).toHaveLength(1);
  });

  it('shows the run-superseded notice when a pane response reports a newer published run (AD-3)', async () => {
    request.mockReset();
    mockApi({ supersedePanes: new Set(['supplyAction']) });
    renderPage(observeOnly('supplyAction'));
    expect(await screen.findByText('Data updated — refresh to load the latest published run')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('renders a pane error with a working retry handler', async () => {
    request.mockReset();
    mockApi({ failPanes: new Set(['supplyAction']) });
    renderPage(observeOnly('supplyAction'));
    expect(await screen.findByText('Failed to load: boom')).toBeTruthy();
    mockApi(); // subsequent calls succeed
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('SKU-f9b-supply-null-risk')).toBeTruthy();
  });

  it('renders the contradictory (gold in-prep vs silver inbound) row verbatim in its served pane with a stale badge', async () => {
    renderPage(observeOnly('inPrepMonitoring'));
    await waitFor(() => expect(document.querySelector('section[data-pane="inPrepMonitoring"]')).not.toBeNull());
    const section = document.querySelector('section[data-pane="inPrepMonitoring"]') as HTMLElement;
    await waitFor(() => expect(within(section).queryAllByText('order-5').length).toBeGreaterThan(0));
    expect(within(section).getByText('Stale data')).toBeTruthy();
    // direct-ship-fba never leaks into P3 (AD-2 #3).
    expect(within(section).queryByText('order-3')).toBeNull();
  });

  it('REQ-X6: no non-badge literal repeats in >80% of rows; at most one badge cluster per row', async () => {
    renderPage(observeAll);
    const targetPanes = ['supplyAction', 'inPrepMonitoring', 'inboundMonitoring', 'performanceReview'];
    for (const pane of targetPanes) {
      await waitFor(() =>
        expect(
          document.querySelectorAll(`section[data-pane="${pane}"] tbody tr.ant-table-row`).length,
        ).toBeGreaterThanOrEqual(3),
      );
    }
    // Null placeholders are the mandated rendering for null values ("unknown",
    // "no activity yet") — they are data states, not liftable categorical text.
    const allowedPlaceholders = new Set(['unknown', 'no activity yet']);
    for (const pane of targetPanes) {
      const section = document.querySelector(`section[data-pane="${pane}"]`) as HTMLElement;
      const rows = Array.from(section.querySelectorAll('tbody tr.ant-table-row'));
      const literalCounts = new Map<string, number>();
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        const badgeCells = cells.filter((cell) => cell.querySelector('.ant-tag'));
        expect(badgeCells.length, `${pane}: max one badge cluster per row`).toBeLessThanOrEqual(1);
        const literals = new Set(
          cells
            .filter((cell) => !cell.querySelector('.ant-tag'))
            .map((cell) => cell.textContent?.trim() ?? '')
            .filter((text) => text.length > 0),
        );
        for (const literal of literals) literalCounts.set(literal, (literalCounts.get(literal) ?? 0) + 1);
      }
      for (const [literal, count] of literalCounts) {
        if (count / rows.length > 0.8) {
          expect(
            allowedPlaceholders.has(literal),
            `${pane}: literal "${literal}" repeats in ${count}/${rows.length} rows`,
          ).toBe(true);
        }
      }
    }
  });

  it('T-3.0c(a): shows a progress hint when the header is still loading after 10s', async () => {
    request.mockReset();
    request.mockImplementation((args: { url: string }) => {
      if (args.url === 'ecobaseInventoryDashboard:header') return new Promise(() => undefined); // never resolves
      return Promise.reject(new Error('unexpected'));
    });
    vi.useFakeTimers();
    renderPage(observeNever);
    expect(screen.queryByText(/Still loading/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText(/Still loading/)).toBeTruthy();
    vi.useRealTimers();
  });

  it('T-3.0c(b): with a real IntersectionObserver present, panes stay un-fetched until their section intersects', async () => {
    // Browser-realistic wiring test: define IntersectionObserver in jsdom and
    // use the DEFAULT observer (no injection). The old fetch-immediately
    // fallback (all 11 panes eager) fails this test.
    type IoCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
    const instances: Array<{ callback: IoCallback; elements: Element[] }> = [];
    class FakeIntersectionObserver {
      callback: IoCallback;
      elements: Element[] = [];
      constructor(callback: IoCallback) {
        this.callback = callback;
        instances.push({ callback, elements: this.elements });
      }
      observe(element: Element) {
        this.elements.push(element);
      }
      disconnect() {
        this.elements.length = 0;
      }
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    try {
      render(
        <App>
          <InventoryDashboardPage />
        </App>,
      );
      await screen.findByRole('group', { name: 'Inventory Dashboard' });
      await waitFor(() => expect(instances.length).toBeGreaterThan(0));
      // No section has intersected -> zero pane fetches.
      expect(paneRequests()).toHaveLength(0);
      // Simulate the first pane's section entering the viewport.
      const supplyEntry = instances.find((instance) =>
        instance.elements.some((element) => element instanceof HTMLElement && element.dataset.pane === 'supplyAction'),
      );
      expect(supplyEntry).toBeDefined();
      act(() => {
        supplyEntry?.callback([{ isIntersecting: true }]);
      });
      await waitFor(() => expect(paneRequests('supplyAction')).toHaveLength(1));
      expect(paneRequests()).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('task 002: renders Discontinued & Paused as the LAST pane with its own debounced search box', async () => {
    renderPage(observeOnly('discontinuedPaused'));
    await waitFor(() => expect(paneRequests('discontinuedPaused')).toHaveLength(1));
    const sections = Array.from(document.querySelectorAll('section[data-pane]'));
    expect((sections.at(-1) as HTMLElement).dataset.pane).toBe('discontinuedPaused');
    expect(await screen.findByText('Old Supplier Co')).toBeTruthy();

    vi.useFakeTimers();
    const paneSearch = screen.getByLabelText('Discontinued & Paused Search');
    for (const value of ['o', 'ol', 'old']) {
      fireEvent.change(paneSearch, { target: { value } });
    }
    expect(paneRequests('discontinuedPaused')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(paneRequests('discontinuedPaused')).toHaveLength(2));
    expect(paneRequests('discontinuedPaused').at(-1)?.[0].data.search).toBe('old');
  });

  it('regression: renders against the exact staging-captured response envelope and proceeds to pane fetches', async () => {
    // Verbatim structure of the staging HTTP body: {"data":{"data":<payload>}},
    // surfaced through the axios client as response.data.
    request.mockReset();
    request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
      const payload =
        args.url === 'ecobaseInventoryDashboard:header' ? headerFixture : PANE_FIXTURES[String(args.data.pane)];
      return Promise.resolve({ status: 200, data: { data: { data: payload } } });
    });
    renderPage(observeOnly('supplyAction'));
    const group = await screen.findByRole('group', { name: 'Inventory Dashboard' });
    expect(within(group).getByRole('button', { name: 'Urgent stockout risk' })).toHaveTextContent('2');
    // The G2 staging defect died between header resolution and the first pane
    // render: assert the flow now continues into a pinned pane fetch.
    await waitFor(() => expect(paneRequests('supplyAction')).toHaveLength(1));
    expect(paneRequests('supplyAction')[0][0].data.runId).toBe(headerFixture.publishedRunId);
    expect(await screen.findByText('SKU-f9b-supply-null-risk')).toBeTruthy();
  });

  it('regression: malformed header payload becomes a retryable error state, never a crash', async () => {
    request.mockReset();
    mockApi({ headerPayload: { nothing: 'useful' } });
    renderPage(observeAll);
    expect(await screen.findByText('Failed to load: Unexpected server response shape')).toBeTruthy();
    mockApi();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Inventory Dashboard' })).toBeTruthy();
  });
});
