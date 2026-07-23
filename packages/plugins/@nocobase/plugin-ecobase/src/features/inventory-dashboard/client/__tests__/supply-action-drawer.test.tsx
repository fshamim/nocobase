/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T8b: the Supply Action drawer v2 — identity header without database ids,
 * the action bar wired to the T8a `ecobaseInventoryDashboard:*` actions with
 * mandatory-reason modals, the four tabs (chart structure, order history,
 * comment thread + post box, LAZY Data tab), and the W5 pending chip.
 */

import { App } from 'antd';
import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRow, DrawerContextResponse } from '../../server/contract';
import paneSupplyAction from '../../server/__tests__/fixtures/expected-responses/pane-supplyAction.json';
import drawerFixture from '../../server/__tests__/fixtures/expected-responses/drawer-supplyAction.json';
import { TEXT } from '../dashboard-text';
import PaneDrawer from '../PaneDrawer';

const ENRICHED = (paneSupplyAction as { rows: DashboardRow[] }).rows.find(
  (row) => row.identity.asin === 'B0011A',
) as DashboardRow;

const PRIMARY: DashboardRow = { ...ENRICHED, recommendedOrderQty: 520 };

function drawerContext(): DrawerContextResponse {
  return {
    ...(drawerFixture as unknown as DrawerContextResponse),
    familyKey: 'family-f11a-lead-boundary',
    primaryRow: PRIMARY,
    orderRows: [],
    familyMembers: [
      {
        listingRowId: ENRICHED.identity.listingRowId,
        companyProductId: 'cp-f11a',
        asin: 'B0011A',
        sku: 'SKU-f11a-lead-boundary',
        pane: 'supplyAction',
        isTarget: true,
      },
      {
        listingRowId: 'gold:f11x',
        companyProductId: 'cp-f11x',
        asin: 'B0011X',
        sku: 'SKU-f11x-sibling',
        pane: 'healthyInventory',
        isTarget: false,
      },
    ],
    familyTarget: { companyProductId: 'cp-f11a', selectionSource: 'operator', selectionRule: null },
    orderHistory: [
      { orderDate: '2026-07-01', orderedQty: 120, supplierName: 'Lead Boundary Supplies', status: 'complete' },
      { orderDate: '2026-05-15', orderedQty: 250, supplierName: 'Lead Boundary Supplies', status: 'complete' },
    ],
    maxEverOrderedQty: 250,
    commentThread: [
      { entityType: 'family', body: 'Family note', author: 'Planner Pia', at: '2026-07-21T10:00:00.000Z' },
      { entityType: 'supplier', body: 'Supplier note', author: null, at: '2026-07-20T10:00:00.000Z' },
    ],
  };
}

const request = vi.fn();
const supplierOptions = [{ label: 'Other Supplier', value: 'supplier-other' }];

function mockApi(context: DrawerContextResponse) {
  request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
    if (args.url === 'ecobaseInventoryDashboard:drawerContext') {
      if (args.data.includeRaw === true) {
        return Promise.resolve({
          data: { data: { ...context, rawGoldRow: { salesVelocityBasis: 'rolling_30', supplierOrderStatus: null } } },
        });
      }
      return Promise.resolve({ data: { data: context } });
    }
    if (args.url === 'ecobaseSupplierManagement:supplierOptions') {
      return Promise.resolve({ data: { data: supplierOptions } });
    }
    return Promise.resolve({ data: { data: { ok: true } } });
  });
}

function calls(url: string) {
  return request.mock.calls.filter(([args]) => (args as { url: string }).url === url);
}

async function openDrawer(markPending = vi.fn(), pendingFamilies: ReadonlySet<string> = new Set()) {
  const view = render(
    <App>
      <PaneDrawer
        target={{ pane: 'supplyAction', familyId: 'family-f11a-lead-boundary' }}
        runId="run-published-0001"
        api={{ request }}
        t={(value: string) => value}
        onClose={() => undefined}
        onMutated={() => undefined}
        onSuperseded={() => undefined}
        markPending={markPending}
        pendingFamilies={pendingFamilies}
      />
    </App>,
  );
  const dialog = await within(document.body).findByRole('dialog');
  await waitFor(() => expect(within(dialog).getAllByText('B0011A').length).toBeGreaterThan(0));
  return { view, dialog, markPending };
}

describe('Supply Action drawer v2 (T8b)', () => {
  beforeEach(() => {
    request.mockReset();
    mockApi(drawerContext());
    document.body.innerHTML = '';
  });

  it('renders the identity header with NO database ids and the pending chip when the family is syncing', async () => {
    const { dialog } = await openDrawer(vi.fn(), new Set(['family-f11a-lead-boundary']));
    expect(within(dialog).getAllByText(TEXT.actionOverdue).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(TEXT.syncChip)).toBeTruthy();
    const text = dialog.textContent ?? '';
    expect(text).not.toContain('family-f11a-lead-boundary'); // familyKey never rendered
    expect(text).not.toContain('cp-f11a'); // companyProductId never rendered
    // (The gold row id itself is a substring of the fixture SKU, so a raw
    // substring check would false-positive; the id-bearing fields above are
    // the ones the design forbids.)
    // A11y: the action bar is a labelled toolbar.
    expect(within(dialog).getByRole('toolbar', { name: TEXT.paneSupplyAction })).toBeTruthy();
  });

  it('Overview: chart structure matches the mockup (guides, dots, hollow projection) + key numbers + full buckets', async () => {
    const { dialog } = await openDrawer();
    const chart = within(dialog).getByTestId('profit-range-chart');
    // Six solid month dots: best + worst + last + 3 plain.
    expect(within(dialog).getAllByTestId('chart-dot').length).toBe(3);
    expect(within(dialog).getByTestId('chart-dot-best')).toBeTruthy();
    expect(within(dialog).getByTestId('chart-dot-worst')).toBeTruthy();
    expect(within(dialog).getByTestId('chart-dot-last')).toBeTruthy();
    expect(within(dialog).getByTestId('chart-dot-projected')).toBeTruthy();
    // Best/worst dots sit exactly ON their guide lines (same y as the dashed guides).
    const best = within(dialog).getByTestId('chart-dot-best');
    const worst = within(dialog).getByTestId('chart-dot-worst');
    expect(best.getAttribute('cy')).toBe('28');
    expect(worst.getAttribute('cy')).toBe('132');
    expect(chart.querySelectorAll('line[stroke-dasharray="5 4"]').length).toBe(2);
    // Key numbers + full bucket words.
    expect(within(dialog).getByText(TEXT.statProfitPerUnit)).toBeTruthy();
    expect(within(dialog).getByText(TEXT.bucketReserved)).toBeTruthy();
  });

  it('Create order: qty prefilled from recommendedOrderQty, submits createPlannedOrder with the member identity', async () => {
    const { dialog, markPending } = await openDrawer();
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnCreateOrder }));
    const modal = await within(document.body).findByLabelText(TEXT.qtyLabel);
    expect((modal as HTMLInputElement).value).toBe('520'); // prefilled from recommendedOrderQty
    const modalDialog = modal.closest('.ant-modal') as HTMLElement;
    fireEvent.click(within(modalDialog).getByRole('button', { name: TEXT.btnCreateOrder }));
    await waitFor(() =>
      expect(calls('ecobaseInventoryDashboard:createPlannedOrder')[0][0]).toMatchObject({
        data: {
          company: ENRICHED.identity.company,
          planningProductId: 'cp-f11a',
          orderedQty: 520,
          supplierId: ENRICHED.supplier.id,
        },
      }),
    );
    await waitFor(() => expect(markPending).toHaveBeenCalledWith('family-f11a-lead-boundary'));
  });

  it('Change target: OK disabled until member + reason; submits setFamilyTarget', async () => {
    const { dialog } = await openDrawer();
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnChangeTarget }));
    const modal = (await within(document.body).findAllByRole('dialog')).find(
      (candidate) => candidate.textContent?.includes('SKU-f11x-sibling'),
    ) as HTMLElement;
    const ok = within(modal).getByRole('button', { name: TEXT.drawerSave });
    expect(ok).toHaveProperty('disabled', true);
    fireEvent.click(within(modal).getByRole('radio', { name: /SKU-f11x-sibling/ }));
    expect(ok).toHaveProperty('disabled', true); // reason still missing
    fireEvent.change(within(modal).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'sibling sells' } });
    await waitFor(() => expect(ok).toHaveProperty('disabled', false));
    fireEvent.click(ok);
    await waitFor(() =>
      expect(calls('ecobaseInventoryDashboard:setFamilyTarget')[0][0]).toMatchObject({
        data: { familyId: 'family-f11a-lead-boundary', companyProductId: 'cp-f11x', reason: 'sibling sells' },
      }),
    );
  });

  it('Change supplier + Update lead time + Set status wire their payloads with mandatory reasons', async () => {
    const { dialog } = await openDrawer();
    // Change supplier.
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnChangeSupplier }));
    let modal = (await within(document.body).findAllByLabelText(TEXT.drawerAssignSupplier))[0].closest(
      '.ant-modal',
    ) as HTMLElement;
    fireEvent.mouseDown(within(modal).getByRole('combobox'));
    fireEvent.click(await within(document.body).findByText('Other Supplier'));
    fireEvent.change(within(modal).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'cheaper' } });
    fireEvent.click(within(modal).getByRole('button', { name: TEXT.drawerSave }));
    await waitFor(() =>
      expect(calls('ecobaseInventoryDashboard:setFamilyPreferredSupplier')[0][0]).toMatchObject({
        data: { familyId: 'family-f11a-lead-boundary', supplierId: 'supplier-other', reason: 'cheaper' },
      }),
    );
    // Update lead time (prefilled from the row's supplier lead).
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnUpdateLeadTime }));
    const lead = await within(document.body).findByLabelText(TEXT.leadTimeDaysLabel);
    fireEvent.change(lead, { target: { value: '25' } });
    modal = lead.closest('.ant-modal') as HTMLElement;
    fireEvent.click(within(modal).getByRole('button', { name: TEXT.drawerSave }));
    await waitFor(() =>
      expect(calls('ecobaseInventoryDashboard:updateSupplierLeadTime')[0][0]).toMatchObject({
        data: { company: ENRICHED.identity.company, supplierId: ENRICHED.supplier.id, leadTimeDays: 25 },
      }),
    );
    // Set status: reason mandatory.
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnSetStatus }));
    const cover = await within(document.body).findByLabelText(TEXT.targetCoverLabel);
    fireEvent.change(cover, { target: { value: '60' } });
    modal = cover.closest('.ant-modal') as HTMLElement;
    const ok = within(modal).getByRole('button', { name: TEXT.drawerSave });
    expect(ok).toHaveProperty('disabled', true);
    fireEvent.change(within(modal).getByLabelText(TEXT.reasonRequiredLabel), { target: { value: 'longer runway' } });
    await waitFor(() => expect(ok).toHaveProperty('disabled', false));
    fireEvent.click(ok);
    await waitFor(() =>
      expect(calls('ecobaseInventoryDashboard:updateProductPlanningFields')[0][0]).toMatchObject({
        data: { companyProductId: 'cp-f11a', targetCoverDays: 60, reason: 'longer runway' },
      }),
    );
  });

  it('Orders tab lists the history with max-ever; Comments tab shows the thread and posts to the family', async () => {
    const { dialog } = await openDrawer();
    fireEvent.click(within(dialog).getByRole('tab', { name: new RegExp(TEXT.tabOrders) }));
    expect(await within(dialog).findByText('120 u')).toBeTruthy();
    expect(within(dialog).getByText(`${TEXT.maxEverPrefix} 250`)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('tab', { name: new RegExp(TEXT.tabComments) }));
    expect(await within(dialog).findByText('Family note')).toBeTruthy();
    expect(within(dialog).getByText('Planner Pia')).toBeTruthy();
    expect(within(dialog).getByText(TEXT.entitySupplier)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(TEXT.commentPlaceholder), { target: { value: 'ordering today' } });
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnPost }));
    await waitFor(() =>
      expect(calls('ecobaseInventoryDashboard:addProductComment')[0][0]).toMatchObject({
        data: { familyId: 'family-f11a-lead-boundary', body: 'ordering today' },
      }),
    );
  });

  it('T-QA1: posting a comment refreshes the OPEN drawer thread + tab count in place', async () => {
    let context = drawerContext(); // 2 thread entries
    request.mockReset();
    request.mockImplementation((args: { url: string; data: Record<string, unknown> }) => {
      if (args.url === 'ecobaseInventoryDashboard:drawerContext') {
        return Promise.resolve({ data: { data: context } });
      }
      if (args.url === 'ecobaseInventoryDashboard:addProductComment') {
        // The next context fetch sees the new comment (server round-trip).
        context = {
          ...context,
          commentThread: [
            { entityType: 'family', body: 'ordering today', author: 'Ops Anna', at: '2026-07-21T11:00:00.000Z' },
            ...context.commentThread,
          ],
        };
        return Promise.resolve({ data: { data: { ok: true } } });
      }
      return Promise.resolve({ data: { data: { ok: true } } });
    });
    const { dialog } = await openDrawer();
    fireEvent.click(within(dialog).getByRole('tab', { name: new RegExp(TEXT.tabComments) }));
    expect(within(dialog).getByRole('tab', { name: `${TEXT.tabComments} · 2` })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(TEXT.commentPlaceholder), { target: { value: 'ordering today' } });
    fireEvent.click(within(dialog).getByRole('button', { name: TEXT.btnPost }));
    // The thread gains the entry and the tab count increments WITHOUT closing the drawer.
    expect(await within(dialog).findByText('ordering today')).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: `${TEXT.tabComments} · 3` })).toBeTruthy());
    // The composer cleared after the successful post.
    expect((within(dialog).getByLabelText(TEXT.commentPlaceholder) as HTMLInputElement).value).toBe('');
  });

  it('Data tab is LAZY: no includeRaw request until first open; then renders the filterable raw record', async () => {
    const { dialog } = await openDrawer();
    const includeRawCalls = () =>
      calls('ecobaseInventoryDashboard:drawerContext').filter(
        ([args]) => (args as { data: Record<string, unknown> }).data.includeRaw === true,
      );
    expect(includeRawCalls()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('tab', { name: TEXT.tabData }));
    await waitFor(() => expect(includeRawCalls()).toHaveLength(1));
    expect(await within(dialog).findByText('salesVelocityBasis')).toBeTruthy();
    // Client-side filter narrows the key list.
    fireEvent.change(within(dialog).getByLabelText(TEXT.dataSearchPlaceholder), { target: { value: 'supplierOrder' } });
    await waitFor(() => expect(within(dialog).queryByText('salesVelocityBasis')).toBeNull());
    expect(within(dialog).getByText('supplierOrderStatus')).toBeTruthy();
    // Switching back and forth issues NO second raw fetch.
    fireEvent.click(within(dialog).getByRole('tab', { name: TEXT.tabOverview }));
    fireEvent.click(within(dialog).getByRole('tab', { name: TEXT.tabData }));
    expect(includeRawCalls()).toHaveLength(1);
  });
});
