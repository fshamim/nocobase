/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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

  it('keeps ambiguous Google-Sheet-completed orders in review without trusted terminal evidence', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Completed',
        paymentStatus: 'Completed',
      }),
    ).toMatchObject({ canonicalStatus: 'ORDERED', statusSource: 'payment_evidence', statusCheckRequired: true });
  });

  it('treats explicit rejected source status as complete even when invoice status is stale', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Rejected',
        invoiceStatus: 'Uploaded',
        orderDate: '2023-11-21',
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'source_closed',
      statusCheckRequired: false,
    });
  });

  it('does not treat a recent completed invoice as terminal receipt evidence', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Completed',
        invoiceStatus: 'Completed',
      }),
    ).toMatchObject({ canonicalStatus: 'ORDERED', statusSource: 'source_status_review', statusCheckRequired: true });
  });

  it('closes rejected source rows without runtime-clock classification', () => {
    expect(resolveOrderLifecycle({ sourceOrderStatus: 'Rejected', orderDate: '2025-09-08' })).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'source_closed',
      statusCheckRequired: false,
    });
  });

  it('closes recent cancelled rows instead of leaving fallback money at risk', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'Cancelled',
        orderDate: '2026-06-10',
        amazonReceiptStatus: 'amazon_stock_observed',
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'source_closed',
      statusCheckRequired: false,
    });
  });

  it('preserves an explicit canonical COMPLETE state', () => {
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'COMPLETE',
        lifecycleStatus: 'Completed',
        statusSource: 'stored',
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'stored',
      statusCheckRequired: false,
    });
  });

  it('keeps ambiguous rows in review without trusted terminal evidence', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'OOS',
        orderDate: '2026-05-21',
      }),
    ).toMatchObject({
      canonicalStatus: 'IN-PROGRESS',
      statusSource: 'fallback',
      statusCheckRequired: true,
    });
  });

  it('uses the supplied calculation date for deterministic historical aging', () => {
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'In Progress',
        orderDate: '2026-05-01',
        calculationDate: '2026-05-15',
      }),
    ).toMatchObject({ canonicalStatus: 'IN-PROGRESS', statusSource: 'fallback' });
    expect(
      resolveOrderLifecycle({
        sourceOrderStatus: 'In Progress',
        orderDate: '2026-05-01',
        calculationDate: '2026-09-01',
      }),
    ).toMatchObject({ canonicalStatus: 'COMPLETE', statusSource: 'historical_age_evidence' });
  });

  it('does not apply age-based completion without an explicit calculation date', () => {
    expect(resolveOrderLifecycle({ sourceOrderStatus: 'In Progress', orderDate: '2015-01-01' })).toMatchObject({
      canonicalStatus: 'IN-PROGRESS',
      statusSource: 'fallback',
    });
  });

  it('lets operator-selected lifecycle status override source evidence', () => {
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'INBOUND MONITORING',
        statusSource: 'operator',
        sourceOrderStatus: 'Completed',
        paymentStatus: 'Completed',
        amazonReceiptStatus: 'amazon_stock_observed',
      }),
    ).toMatchObject({ canonicalStatus: 'INBOUND MONITORING', statusSource: 'operator' });
  });

  it('resolves import-alias canonical statuses on operator-stamped orders instead of throwing', () => {
    // Order workbench / supplier order creation stamps statusSource 'operator' with the
    // raw alias vocabulary in both columns; the read-model rebuild must not abort on it.
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'draft',
        lifecycleStatus: 'draft',
        statusSource: 'operator',
      }),
    ).toMatchObject({ canonicalStatus: 'ORDER ANALYSING', statusSource: 'operator' });
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'paid',
        statusSource: 'operator',
      }),
    ).toMatchObject({ canonicalStatus: 'ORDERED', statusSource: 'operator' });
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'cancelled',
        lifecycleStatus: 'cancelled',
        operatorStatusOverrideAt: '2026-07-25T10:00:00.000Z',
      }),
    ).toMatchObject({ canonicalStatus: 'COMPLETE', statusSource: 'operator' });
  });

  it('keeps the exact operator lifecycle pick when canonicalStatus holds a coarser alias', () => {
    // setOrderStatus writes the operator pick to lifecycleStatus and a lossy engine alias
    // to canonicalStatus ('paid' covers four statuses, 'shipped_inbound' covers three).
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'shipped_inbound',
        lifecycleStatus: 'DIRECT SHIP FBA',
        statusSource: 'operator',
      }),
    ).toMatchObject({ canonicalStatus: 'DIRECT SHIP FBA', statusSource: 'operator' });
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'paid',
        lifecycleStatus: 'AT PREP NOT STARTED',
        statusSource: 'operator',
      }),
    ).toMatchObject({ canonicalStatus: 'AT PREP NOT STARTED', statusSource: 'operator' });
  });

  it('still rejects a genuinely unknown operator status', () => {
    expect(() =>
      resolveOrderLifecycle({
        canonicalStatus: 'nonsense',
        lifecycleStatus: 'nonsense',
        statusSource: 'operator',
      }),
    ).toThrow(/Ecobase order lifecycle operator override failed: status must be one of/);
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
        orderDate: '2024-01-01',
        calculationDate: '2026-07-14',
        sellableStock: 1,
      }),
    ).toMatchObject({ canonicalStatus: 'SHIPPED TO FBA', statusSource: 'clickup_csv', statusCheckRequired: false });
  });

  it('does not treat non-inbound not-applicable receipt state as completion evidence', () => {
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'supplier_preparing',
        lifecycleStatus: 'supplier-preparing',
        statusSource: 'clickup_csv',
        amazonReceiptStatus: 'not_applicable',
      }),
    ).toMatchObject({
      canonicalStatus: 'PREP IN-PROGRESS',
      statusSource: 'clickup_csv',
      statusCheckRequired: false,
    });
  });

  it('lets terminal Amazon receipt evidence close a current ClickUp inbound workflow', () => {
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'shipped_inbound',
        lifecycleStatus: 'inbound-monitoring',
        statusSource: 'clickup_csv',
        amazonReceiptStatus: 'amazon_stock_observed',
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'amazon_receipt',
      statusCheckRequired: false,
    });
  });

  it('lets trusted successor receipt evidence close a current ClickUp workflow', () => {
    expect(
      resolveOrderLifecycle({
        canonicalStatus: 'shipped_inbound',
        lifecycleStatus: 'inbound-monitoring',
        statusSource: 'clickup_csv',
        amazonReceiptStatus: 'completed_by_later_inbound',
        orderDate: '2026-05-01',
        calculationDate: '2026-07-14',
      }),
    ).toMatchObject({
      canonicalStatus: 'COMPLETE',
      statusSource: 'successor_receipt_evidence',
      statusCheckRequired: false,
    });
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
