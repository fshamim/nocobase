import { describe, expect, it } from 'vitest';
import { resolveOrderLifecycle } from '../services/order-lifecycle';

describe('resolveOrderLifecycle', () => {
  it('maps Google Sheets completed payment to ORDERED with status check instead of COMPLETE', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Completed',
        paymentStatus: 'Completed',
        dateOfPayment: '12/06/2026',
      }),
    ).toMatchObject({
      canonicalStatus: 'ORDERED',
      statusSource: 'payment_evidence',
      statusCheckRequired: true,
    });
  });

  it('treats older Google-Sheet-completed orders as COMPLETE when a later same-product order exists', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Completed',
        paymentStatus: 'Completed',
        hasLaterSameProductOrder: true,
      }),
    ).toMatchObject({ canonicalStatus: 'COMPLETE', statusSource: 'source_history', statusCheckRequired: false });
  });

  it('treats older uploaded invoices as complete even when line status is stale', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Rejected',
        invoiceStatus: 'Uploaded',
        orderDate: '2023-11-21',
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'historical_invoice_evidence',
      statusCheckRequired: false,
    });
  });

  it('treats completed invoice plus a later same-product order as complete', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Rejected',
        invoiceStatus: 'Completed',
        hasLaterSameProductOrder: true,
      }),
    ).toMatchObject({ canonicalStatus: 'COMPLETE', statusSource: 'source_history', statusCheckRequired: false });
  });

  it('closes old rejected fallback rows instead of keeping them at risk', () => {
    expect(resolveOrderLifecycle({ sourceOrderStatus: 'Rejected', orderDate: '2025-09-08' })).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'historical_source_closed',
      statusCheckRequired: false,
    });
  });

  it('closes recent cancelled rows instead of leaving fallback money at risk', () => {
    expect(resolveOrderLifecycle({ sourceOrderStatus: 'Cancelled', orderDate: '2026-06-10' })).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'source_closed',
      statusCheckRequired: false,
    });
  });

  it('closes recent ambiguous rows when a later same-product order exists', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'OOS',
        orderDate: '2026-05-21',
        hasLaterSameProductOrder: true,
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'successor_order_evidence',
      statusCheckRequired: false,
    });
  });

  it('closes old ambiguous rows when a later same-product order exists', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'In Progress',
        orderDate: '2025-11-12',
        hasLaterSameProductOrder: true,
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'historical_successor_evidence',
      statusCheckRequired: false,
    });
  });

  it('lets operator-selected lifecycle status override source evidence', () => {
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'INBOUND MONITORING',
        statusSource: 'operator',
        sourceOrderStatus: 'Completed',
        paymentStatus: 'Completed',
      }),
    ).toMatchObject({ canonicalStatus: 'INBOUND MONITORING', statusSource: 'operator' });
  });

  it('maps inbound stock evidence to INBOUND MONITORING', () => {
    expect(resolveOrderLifecycle({ sourceOrderStatus: 'Completed', inboundStock: 24 })).toMatchObject({
      canonicalStatus: 'INBOUND MONITORING',
      statusSource: 'fulfillment_evidence',
      statusCheckRequired: false,
    });
  });

  it('maps sellable stock evidence to COMPLETE', () => {
    expect(resolveOrderLifecycle({ sourceOrderStatus: 'Completed', sellableStock: 1 })).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'fulfillment_evidence',
      statusCheckRequired: false,
    });
  });
});
