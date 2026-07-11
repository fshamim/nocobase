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
    expect(result.issueCounts).toMatchObject({ order_detail_header_missing: 1 });
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
