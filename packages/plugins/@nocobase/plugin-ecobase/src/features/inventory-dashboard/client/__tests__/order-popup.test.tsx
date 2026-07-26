/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 053 fidelity fixes, client side. Each block below red-proofs one surface
 * against the approved prototypes (`docs/order-management-ui/prototypes/`):
 * the Active-orders lifecycle pill colour (item 1), the In-prep sub-line copy
 * (item 2), and the order popup's single header ref / receipt tile sub-line /
 * fixed six-field key-value strip / short activity dates (items 4, 6, 7, 9).
 */

import { App } from 'antd';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatShortDate } from '../format';
import type { OrderDetail, OrderPrepNoteKind } from '../order/order-api';
import { prepNoteText } from '../order/order-milestones';
import { LifecycleStatusPill } from '../order/order-pills';
import { OrderViewDrawer } from '../order/OrderViewDrawer';

const t = (value: string) => value;

/** The popup renders `at` values as `Mon DD` only inside the current year. */
const THIS_YEAR = new Date().getFullYear();
const LOGGED_AT = `${THIS_YEAR}-07-22T12:00:00.000Z`;

/**
 * MX91624A as QA sampled it on staging (qa-fidelity-2 item 7): an invoice number,
 * a tracking id and an approval, but no payment mode, no payment date and no
 * carrier — the exact order shape the old "populated fields only" strip collapsed.
 */
const DETAIL: OrderDetail = {
  header: {
    id: 'order-1',
    orderRef: 'MX91624A',
    companyName: 'Ecofission LLC',
    supplierName: 'allied piano and finish',
    sourceMarketplace: 'USA',
    orderDate: `${THIS_YEAR}-06-17`,
    deletable: false,
    lifecycleStatus: 'ORDER ANALYSING',
    workflowStage: 'pre_purchase',
    attachmentReference: '1578600',
    trackingId: '1Z12W3490373429169',
    orderApproval: 'Approved',
    expectedCost: 1460.4,
    orderedUnits: 1050,
    observedUnits: 300,
    productCount: 5,
  },
  lines: [],
  comments: [{ author: 'Admin', at: LOGGED_AT, body: 'QA re-verify note' }],
  activity: [{ at: LOGGED_AT, kind: 'receipt', summary: '300 of 1050 units observed' }],
};

function respond(data: unknown) {
  return Promise.resolve({ status: 200, data: { data: { data } } });
}

async function openPopup(detail: OrderDetail = DETAIL) {
  const request = vi.fn((args: { url: string }) =>
    args.url === 'ecobaseInventoryDashboard:getOrderDetail' ? respond(detail) : respond({}),
  );
  render(
    <App>
      <OrderViewDrawer open api={{ request } as never} t={t} orderId={detail.header.id} onClose={() => undefined} />
    </App>,
  );
  // The ref is deliberately in the DOM twice — the visible heading and the
  // screen-reader-only dialog title — so this waits on all matches, not one.
  await screen.findAllByText(detail.header.orderRef as string);
  return document.querySelector('.ant-modal-content') as HTMLElement;
}

afterEach(cleanup);

describe('issue 053 item 1: Active-orders lifecycle pill colour', () => {
  it('paints ORDER ANALYSING blue (prototype `.pill.blue`), never the metadata purple', () => {
    render(<LifecycleStatusPill status="ORDER ANALYSING" />);
    const pill = screen.getByText('ORDER ANALYSING');
    expect(pill.className).toContain('ant-tag-blue');
    expect(pill.className).not.toContain('ant-tag-purple');
  });

  it('leaves every other status on its shared lifecycle colour', () => {
    // The prototype paints INBOUND MONITORING blue on one row and orange on
    // another, so it is not a colour spec beyond the status QA flagged: the
    // status → colour encoding must survive this fix.
    render(<LifecycleStatusPill status="INBOUND MONITORING" />);
    expect(screen.getByText('INBOUND MONITORING').className).toContain('ant-tag-green');
    cleanup();
    render(<LifecycleStatusPill status="APPROVED TO ORDER" />);
    expect(screen.getByText('APPROVED TO ORDER').className).toContain('ant-tag-cyan');
  });
});

describe('issue 053 item 2: the In-prep sub-line under the prep chain', () => {
  const note = (kind: OrderPrepNoteKind, recorded = 0) => ({ kind, recorded, total: 4 });

  it('states measured progress, waiting-on-supplier and every state in between', () => {
    expect(prepNoteText(note('measuring', 2), t)).toBe('2 of 4 prep measurements');
    expect(prepNoteText(note('measured', 4), t)).toBe('measured');
    expect(prepNoteText(note('awaiting_measurement'), t)).toBe('waiting for prep to measure and weigh');
    expect(prepNoteText(note('awaiting_supplier'), t)).toBe('waiting for carton details + labels from supplier');
    expect(prepNoteText(note('awaiting_arrival'), t)).toBe('labels received · waiting for goods at prep');
    expect(prepNoteText(note('ready', 4), t)).toBe('ready to ship');
  });

  it('never falls back to the literal every row used to share', () => {
    const kinds: OrderPrepNoteKind[] = [
      'ready',
      'measured',
      'measuring',
      'awaiting_measurement',
      'awaiting_arrival',
      'awaiting_supplier',
    ];
    const rendered = kinds.map((kind) => prepNoteText(note(kind, 2), t));
    expect(rendered).not.toContain('not measured');
    expect(new Set(rendered).size).toBe(kinds.length);
  });
});

describe('issue 053 item 9: the short activity date', () => {
  const now = new Date('2026-07-26T00:00:00.000Z');

  it('prints `Mon DD` inside the current year and adds the year outside it', () => {
    expect(formatShortDate('2026-07-22T09:14:00.000Z', now)).toBe('Jul 22');
    expect(formatShortDate('2025-07-22T09:14:00.000Z', now)).toBe('Jul 22, 2025');
  });

  it('zero-pads the day and accepts a date-only value without slipping a day', () => {
    expect(formatShortDate('2026-05-02', now)).toBe('May 02');
    expect(formatShortDate('2026-05-02T23:30:00', now)).toBe('May 02');
  });

  it('renders an em-dash rather than inventing a date', () => {
    expect(formatShortDate(undefined, now)).toBe('—');
    expect(formatShortDate('', now)).toBe('—');
    expect(formatShortDate('not a date', now)).toBe('—');
  });
});

describe('the order popup (issue 053 items 4, 6, 7, 9)', () => {
  it('item 4: shows the order ref once — the dialog title is screen-reader-only', async () => {
    await openPopup();
    const header = document.querySelector('.ant-modal-header') as HTMLElement;
    // The row survives only to keep antd's close button off the action buttons.
    expect(header.style.height).toBe('24px');
    const title = header.querySelector('.ant-modal-title > span') as HTMLElement;
    expect(title).not.toBeNull();
    expect(title.style.position).toBe('absolute');
    expect(title.style.clip).toMatch(/^rect\(0/);
    // The visible ref is the large in-content heading, and there is exactly one.
    const visible = screen.getAllByText('MX91624A').filter((element) => !element.closest('.ant-modal-title'));
    expect(visible).toHaveLength(1);
  });

  it('item 4: the dialog keeps its accessible name after losing the visible title', async () => {
    await openPopup();
    expect(screen.getByRole('dialog', { name: 'MX91624A' })).toBeTruthy();
  });

  it('item 6: the Received-on-Amazon tile carries its state sub-line', async () => {
    const popup = await openPopup();
    expect(within(popup).getByText('Received on Amazon')).toBeTruthy();
    expect(within(popup).getByText('300 / 1050')).toBeTruthy();
    expect(within(popup).getByText('partially observed')).toBeTruthy();
  });

  it('item 6: the sub-line follows the receipt counts', async () => {
    const none = { ...DETAIL, header: { ...DETAIL.header, observedUnits: 0 } };
    await openPopup(none);
    expect(screen.getByText('not observed yet')).toBeTruthy();
    cleanup();
    const all = { ...DETAIL, header: { ...DETAIL.header, observedUnits: 1050 } };
    await openPopup(all);
    expect(screen.getByText('fully observed')).toBeTruthy();
  });

  it('item 7: renders all six key-value fields with em-dash placeholders for the empty ones', async () => {
    const popup = await openPopup();
    const labels = ['Payment mode', 'Payment date', 'Invoice no', 'Carrier', 'Tracking', 'Approval'];
    for (const label of labels) {
      expect(within(popup).getByText(label), `missing "${label}"`).toBeTruthy();
    }
    // Payment mode / Payment date / Carrier are unset on this order: three placeholders.
    const cells = labels.map((label) => within(popup).getByText(label).parentElement as HTMLElement);
    expect(cells.filter((cell) => cell.textContent?.includes('—'))).toHaveLength(3);
    expect(cells[2].textContent).toContain('1578600');
    expect(cells[5].textContent).toContain('Approved');
  });

  it('item 9: activity and comment logs both read `Mon DD`, not a relative age', async () => {
    const popup = await openPopup();
    expect(within(popup).getByText(/300 of 1050 units observed/)).toBeTruthy();
    expect(within(popup).getAllByText('Jul 22').length).toBeGreaterThan(0);
    expect(popup.textContent).not.toContain(`${THIS_YEAR}-07-22`);
    expect(popup.textContent).not.toMatch(/\d+ d ago/);

    // The Comments tab shares the formatter.
    const tab = within(popup).getByRole('tab', { name: /Comments/ });
    tab.click();
    const body = await within(popup).findByText('QA re-verify note');
    // Author and date are separate nodes in the same byline.
    const byline = body.parentElement?.firstElementChild as HTMLElement;
    expect(byline.textContent).toBe('Admin · Jul 22');
  });
});
