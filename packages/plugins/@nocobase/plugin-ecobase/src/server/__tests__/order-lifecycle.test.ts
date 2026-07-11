import { describe, expect, it } from 'vitest';
import { resolveOrderLifecycle } from '../../features/order-planning/server/order-lifecycle';
import {
  AFTER_ORDERED_STATUSES,
  BEFORE_ORDERED_STATUSES,
  COMPLETED_ORDER_LIFECYCLE_STATUSES,
  ORDER_LIFECYCLE_STATUS_METADATA,
  orderLifecycleStatusColor,
  isCompleteLifecycleStatus,
} from '../../features/order-planning/order-lifecycle-status';

describe('resolveOrderLifecycle', () => {
  it('keeps canonical lifecycle metadata as the source for groups and display colors', () => {
    expect(BEFORE_ORDERED_STATUSES).toEqual(['IN-PROGRESS', 'ORDER ANALYSING', 'APPROVED TO ORDER']);
    expect(AFTER_ORDERED_STATUSES).toEqual([
      'ORDERED',
      'IN TRANSIT TO PREP',
      'DIRECT SHIP FBA',
      'AT PREP NOT STARTED',
      'PREP IN-PROGRESS',
      'SHIPPED TO FBA',
      'INBOUND MONITORING',
    ]);
    expect(COMPLETED_ORDER_LIFECYCLE_STATUSES).toEqual(['COMPLETE']);
    expect(ORDER_LIFECYCLE_STATUS_METADATA['APPROVED TO ORDER']).toMatchObject({
      color: 'cyan',
      supplierColor: 'orange',
    });
    expect(orderLifecycleStatusColor('complete')).toBe('success');
    expect(orderLifecycleStatusColor('COMPLETE', 'supplier')).toBe('green');
    expect(isCompleteLifecycleStatus('complete')).toBe(true);
  });

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

  it('keeps ClickUp status authoritative over historical source evidence', () => {
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'completed',
        statusSource: 'clickup_csv',
        sourceOrderStatus: 'Completed',
        orderDate: '2024-01-01',
      }),
    ).toMatchObject({ canonicalStatus: 'COMPLETE', statusSource: 'clickup_csv', statusCheckRequired: false });
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'shipped_inbound',
        statusSource: 'clickup_csv',
        sourceOrderStatus: 'Completed',
        sellableStock: 1,
      }),
    ).toMatchObject({ canonicalStatus: 'SHIPPED TO FBA', statusSource: 'clickup_csv', statusCheckRequired: false });
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
