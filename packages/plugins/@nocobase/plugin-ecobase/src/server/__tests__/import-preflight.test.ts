/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

import { describe, expect, it } from 'vitest';
import { requireCanonicalCompany, resolveCanonicalCompany } from '../company-identity';
import { preflightImportFiles } from '../../features/source-import/server/import-preflight';

const purchaseOrders = {
  name: 'Purchase Orders.csv',
  content: [
    'Timestamp,Order ID,SR ID ,Supplier,Company,Payment Status ',
    '2026-01-01,EF1001A,SRO-1,Primary Supplier,Ecofission LLC,Pending',
  ].join('\n'),
};

const orderDetails = {
  name: 'OrderDetails.csv',
  content: [
    'Order ID,Company,SR ID,Supplier,ASIN,SKU,Qty,Lead time(day)',
    'EF1001A,Ecofission LLC,SRO-1,Primary Supplier,B000000001,SKU-1,4,30',
    'EF1001A,Ecofission LLC,SRO-1,Primary Supplier,B000000001,SKU-1,4,30',
    'EF1001A,Muxtex INC,SRO-1,Primary Supplier,B000000002,SKU-2,2,30',
  ].join('\n'),
};

const supplierTracker = {
  name: 'Supplier Analysis Tracker.csv',
  content: [
    'SR ID,Supplier Name,Wholesale Price List,Reached Via',
    'SRO-3,Invalid Supplier,https://example.test,Call & Email',
  ].join('\n'),
};

describe('Ecobase import preflight', () => {
  it('canonicalizes approved company aliases and rejects unknown values', () => {
    expect(resolveCanonicalCompany('StopShopLLC')).toEqual({
      companyKey: 'STOP_SHOP_LLC',
      name: 'Stop Shop LLC',
    });
    expect(resolveCanonicalCompany('KK & Sons Ltd')).toEqual({
      companyKey: 'KK_AND_SONS_LTD',
      name: 'KK and Sons Ltd',
    });
    expect(requireCanonicalCompany('Muxtex Inc')).toEqual({ companyKey: 'MUXTEX_INC', name: 'Muxtex INC' });
    expect(() => requireCanonicalCompany('Call & Email')).toThrow(/unrecognized company/);
  });

  it('excludes superseded, prefix-conflicting, and invalid supplier rows deterministically', () => {
    const first = preflightImportFiles([orderDetails, supplierTracker, purchaseOrders]);
    const second = preflightImportFiles([purchaseOrders, orderDetails, supplierTracker]);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.issueCounts).toMatchObject({
      order_detail_superseded: 1,
      order_row_excluded: 1,
      supplier_row_excluded_invalid_company: 1,
    });
    expect(first.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'order_company_conflict' })]),
    );
  });

  it('excludes incomplete order rows and registers SR IDs without company linkage', () => {
    const result = preflightImportFiles([
      {
        name: 'OrderDetails.csv',
        content: [
          'Order ID,Company,SR ID,Supplier,ASIN,SKU,Qty,Lead time(day)',
          ',Ecofission LLC,SRO-1,Supplier,B000000001,SKU-1,4',
          'EF1001A,Ecofission LLC,,Supplier,B000000001,SKU-1,4',
          'EF1001A,,SRO-1,Supplier,B000000001,SKU-1,4',
          'EF1001A,Ecofission LLC,SRO-1,Supplier,B000000001,SKU-1,',
          'USA-OTHER-1,Ecofission LLC,SRO-1,Supplier,B000000001,SKU-1,4',
        ].join('\n'),
      },
      {
        name: 'Supplier Analysis Tracker.csv',
        content: ['SR ID,Supplier Name,Reached Via', 'SRO-2,Global Supplier,'].join('\n'),
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.issueCounts).toMatchObject({
      order_row_excluded: 5,
      supplier_registered_without_company: 1,
    });
    expect(result.errorCount).toBe(0);
  });

  it('explicitly excludes a supported OrderDetails row without a Purchase Orders header', () => {
    const result = preflightImportFiles([
      {
        name: 'OrderDetails.csv',
        content: [
          'Order ID,Company,SR ID,Supplier,ASIN,SKU,Qty,Lead time(day)',
          'RH1001A,Retail Heaven Inc,SRO-1,Supplier,B000000001,SKU-1,4,30',
        ].join('\n'),
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.issueCounts).toMatchObject({ discarded_order_detail_parent_missing: 1 });
  });

  it('blocks a retained order whose only detail rows conflict with the header supplier', () => {
    const result = preflightImportFiles([
      {
        name: 'Purchase Orders.csv',
        content: [
          'Timestamp,Order ID,Company,SR ID,Supplier,Order status,Payment Status',
          '2026-07-01,EF1001A,Ecofission LLC,SRO-H,Header Supplier,In Progress,Pending',
        ].join('\n'),
      },
      {
        name: 'OrderDetails.csv',
        content: [
          'Order ID,Company,SR ID,Supplier,ASIN,SKU,Qty,Lead time(day)',
          'EF1001A,Ecofission LLC,SRO-D,Detail Supplier,B000000001,SKU-1,4,30',
        ].join('\n'),
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.issueCounts).toMatchObject({ retained_order_has_no_usable_lines: 1 });
  });

  it('requires complete, fresh, aligned Sellerboard coverage for all four companies', () => {
    const healthy = preflightImportFiles([], {
      asOfDate: '2026-07-13',
      sellerboardCoverage: ['ECOFISSION_LLC', 'RETAIL_HEAVEN_INC', 'MUXTEX_INC', 'STOP_SHOP_LLC'].map((companyKey) => ({
        companyKey: companyKey as 'ECOFISSION_LLC' | 'RETAIL_HEAVEN_INC' | 'MUXTEX_INC' | 'STOP_SHOP_LLC',
        account: `${companyKey}-account`,
        marketplace: 'Amazon.com',
        complete: true,
        currentSnapshotAt: '2026-07-13T12:00:00.000Z',
        historyStartDate: '2026-01-01',
        historyEndDate: '2026-07-12',
      })),
    });

    expect(healthy.ok).toBe(true);
    expect(healthy.sellerboardCompleteness).toMatchObject({ ok: true, sourceCount: 4, companyCount: 4 });

    const blocked = preflightImportFiles([], {
      asOfDate: '2026-07-13',
      sellerboardCoverage: [
        {
          companyKey: 'ECOFISSION_LLC',
          account: 'eco',
          marketplace: 'Amazon.com',
          complete: false,
          currentSnapshotAt: '2026-07-10T00:00:00.000Z',
          historyStartDate: '2026-01-01',
          historyEndDate: '2026-07-10',
        },
        {
          companyKey: 'RETAIL_HEAVEN_INC',
          account: 'retail',
          marketplace: '',
          complete: true,
          currentSnapshotAt: '2026-07-13T12:00:00.000Z',
          historyStartDate: '2026-02-01',
          historyEndDate: '2026-07-13',
        },
        {
          companyKey: 'MUXTEX_INC',
          account: 'muxtex',
          marketplace: 'Amazon.com',
          complete: true,
          currentSnapshotAt: '2026-07-13T12:00:00.000Z',
          historyStartDate: '2026-01-01',
          historyEndDate: '2026-07-13',
        },
      ],
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.sellerboardCompleteness?.ok).toBe(false);
    expect(blocked.issueCounts).toMatchObject({
      sellerboard_company_missing: 1,
      sellerboard_context_missing: 1,
      sellerboard_snapshot_partial: 1,
      sellerboard_snapshot_stale: 1,
      sellerboard_history_incomplete: 2,
      sellerboard_snapshot_skew: 1,
    });
  });

  it('resolves conflicting authoritative ClickUp statuses by newest task', () => {
    const result = preflightImportFiles([
      {
        name: 'Order Management Clickup Data.csv',
        content: [
          'Task ID,Task Name,Status,Date Created',
          'task-one,New Order EF3926D Ecofission,hold/cancelled,1782921599420',
          'task-two,Restock Order EF3926D Ecofission,inbound-monitoring,1782921599421',
        ].join('\n'),
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.issueCounts).toMatchObject({ clickup_authoritative_status_resolved_by_recency: 1 });
    expect(result.issues[0]).toMatchObject({
      severity: 'warning',
      code: 'clickup_authoritative_status_resolved_by_recency',
      row: 3,
    });
  });
});
