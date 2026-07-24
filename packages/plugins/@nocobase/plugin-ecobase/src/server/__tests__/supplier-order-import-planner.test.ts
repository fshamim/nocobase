/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSupplierOrderImportPlan,
  EXPECTED_SOURCE_HEADERS,
  type SupplierOrderSourceRole,
} from '../../features/source-import/server/supplier-order-import/supplier-order-import-plan';
import type { SupplierOrderImportOverrides } from '../../features/source-import/server/supplier-order-import/supplier-order-import-overrides';

const fileNames: Record<SupplierOrderSourceRole, string> = {
  supplier_ids: 'Ecofission-Order Management - Supplier IDs.csv',
  supplier_tracker: 'Supplier Analysis Tracker - Supplier 2026.csv',
  purchase_orders: 'Ecofission-Order Management - Purchase Orders.csv',
  order_details: 'Ecofission-Order Management - OrderDetails.csv',
};

function escape(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(role: SupplierOrderSourceRole, rows: Array<Record<string, unknown>>) {
  const headers = EXPECTED_SOURCE_HEADERS[role];
  return [
    headers.map(escape).join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n');
}

const overrides: SupplierOrderImportOverrides = {
  version: 1,
  supplierIds: { 'SRO-1293': { acceptedCode: 'SRO-12939', reason: 'fixture alias' } },
  supplierNames: {},
  purchaseOrders: {},
  orderLines: {},
  excludedOrderDetailRows: {},
  clickupTasks: {},
};

function source(role: SupplierOrderSourceRole, rows: Array<Record<string, unknown>>) {
  return {
    name: fileNames[role],
    role,
    content: csv(role, rows),
    dateFormat: role === 'supplier_tracker' ? ('month-first' as const) : ('day-first' as const),
  };
}

function buildPlan() {
  return buildSupplierOrderImportPlan({
    asOfDate: '2026-07-16',
    overrides,
    files: [
      source('supplier_ids', [
        { 'SR ID': 'SRO-12939', 'Supplier Name': 'Delko Tools' },
        { 'SR ID': 'SRO-1293', 'Supplier Name': 'Delko Tools' },
        { 'SR ID': 'SRO-200', 'Supplier Name': 'Alpha Supply' },
        { 'SR ID': 'SRO-200', 'Supplier Name': 'Beta Supply' },
        { 'SR ID': 'SRO-300', 'Supplier Name': 'Good Supply' },
      ]),
      source('supplier_tracker', [
        {
          Timestamp: '07/15/2026',
          'SR ID': 'SRO-300',
          'Supplier Name': 'Good Supply LLC',
          'PR Portal Link': 'https://supplier.example.test',
          Username: 'buyer@example.test',
          pass: 'fixture-secret',
          'Contact Person': 'Pat Buyer',
          'Reached Via': 'Ecofission LLC',
          'Recieved Email': 'orders@example.test',
          Status: 'Approved',
          'Current Status': 'Active',
          'Supplier Type': 'Brand Approved',
          'Presence on Amazon': 'Good',
          'Date of Update': '07/15/2026',
        },
      ]),
      source('purchase_orders', [
        {
          Timestamp: '16/07/2026',
          'Order ID': 'EF71626A',
          'SR ID ': 'SRO-300',
          Supplier: 'Good Supply',
          Company: 'Ecofission LLC',
          'Market ': 'USA',
          'Exp. Cost ': '$10.00',
          'PO approval': 'Approved',
          'Order status': 'In Progress',
          'Payment Status ': 'In Progress',
          'Invoice Status': 'Waiting',
          'Act. Cost': '$11.00',
          'Exp. Delivery Date ': '20/07/2026',
        },
      ]),
      source('order_details', [
        {
          'Order ID': 'EF71626A',
          Timestamp: '16/07/2026',
          Company: 'Ecofission LLC',
          'SR ID': 'SRO-300',
          Supplier: 'Good Supply',
          ASIN: 'B012345678',
          UPC: '123456789012',
          SKU: 'SKU-1',
          Qty: '4',
          PPU: '$2.50',
          'Pack size': '2',
          MAP: '$9.99',
          'Order type': 'Restock',
          'PO Status': 'Added to PO',
        },
      ]),
    ],
  });
}

function buildLineRevisionPlan(rows: Array<Record<string, unknown>>, orderLines: Record<string, unknown> = {}) {
  return buildSupplierOrderImportPlan({
    asOfDate: '2026-07-16',
    overrides: { ...overrides, orderLines } as never,
    files: [
      source('supplier_ids', [{ 'SR ID': 'SRO-300', 'Supplier Name': 'Good Supply' }]),
      source('purchase_orders', [
        {
          Timestamp: '16/07/2026',
          'Order ID': 'EF71626A',
          'SR ID ': 'SRO-300',
          Company: 'Ecofission LLC',
          'PO approval': 'Approved',
          'Order status': 'Completed',
        },
      ]),
      source('order_details', rows),
    ],
  });
}

describe('supplier/order import planner', () => {
  it('parses current supplier profile fields and canonical order facts', () => {
    const plan = buildPlan();

    expect(plan.suppliers.map((supplier) => supplier.externalSupplierCode)).toEqual([
      'SRO-12939',
      'SRO-200',
      'SRO-300',
    ]);
    expect(plan.supplierCodeOverrides).toEqual([
      { rejectedCode: 'SRO-1293', acceptedCode: 'SRO-12939', normalizedName: 'delkotools' },
    ]);
    expect(plan.suppliers.find((supplier) => supplier.externalSupplierCode === 'SRO-300')).toMatchObject({
      displayName: 'Good Supply LLC',
      contactName: 'Pat Buyer',
      primaryEmail: 'orders@example.test',
      activeStatus: 'Active',
      supplierType: 'Brand Approved',
      amazonPresence: 'Good',
    });
    expect(plan.supplierAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalSupplierCode: 'SRO-300',
          companyKey: 'ECOFISSION_LLC',
          portalUrl: 'https://supplier.example.test',
          loginUsername: 'buyer@example.test',
          loginSecret: 'fixture-secret',
        }),
      ]),
    );
    expect(plan.orders).toEqual([
      expect.objectContaining({
        externalOrderId: 'EF71626A',
        orderDate: '2026-07-16',
        companyKey: 'ECOFISSION_LLC',
        externalSupplierCode: 'SRO-300',
        sourceMarketplace: 'US',
        recordType: 'purchase_order',
        purchaseEvidenceStatus: 'confirmed',
        expectedCost: 10,
        actualCost: 11,
      }),
    ]);
    expect(plan.orders[0].operationalStatus).toBeUndefined();
    expect(plan.orderLines).toEqual([
      expect.objectContaining({
        externalOrderId: 'EF71626A',
        lineOrdinal: 1,
        orderQty: 4,
        expectedCost: undefined,
        sourceMarketplace: 'US',
        sourceEvidence: expect.objectContaining({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      }),
    ]);
    expect(plan.reconciliation).toMatchObject({
      matchedOrderCount: 1,
      detailsOnlyOrderCount: 0,
      purchaseOnlyOrderCount: 0,
      retainedOrderCount: 1,
      retainedOrderLineCount: 1,
    });
    expect(plan.hasBlockingIssues).toBe(false);
  });

  it('maps the previously-ignored PO header and order-detail line columns (T2)', () => {
    const plan = buildSupplierOrderImportPlan({
      asOfDate: '2026-07-16',
      overrides,
      files: [
        source('supplier_ids', [{ 'SR ID': 'SRO-300', 'Supplier Name': 'Good Supply' }]),
        source('purchase_orders', [
          {
            Timestamp: '16/07/2026',
            'Order ID': 'EF71626A',
            'SR ID ': 'SRO-300',
            Company: 'Ecofission LLC',
            'PO approval': 'Approved',
            'Order status': 'In Progress',
            'Payment Mode': 'ACH',
            'Date of Payment': '17/07/2026',
            'Placed By': 'Farhan Shamim',
          },
        ]),
        source('order_details', [
          {
            'Order ID': 'EF71626A',
            Company: 'Ecofission LLC',
            'SR ID': 'SRO-300',
            ASIN: 'B012345678',
            SKU: 'SKU-1',
            Qty: '72',
            PPU: '$8.43',
            'S.Price': '$19.95',
            'Exp. Margin': '12.2%',
            'T.Profit': '$120.50',
            'AM Status': 'Cleared',
            Shipment: 'Yes',
            'Priority ': 'High',
          },
        ]),
      ],
    });

    expect(plan.orders[0]).toMatchObject({
      paymentMode: 'ACH',
      paymentDate: '2026-07-17',
      placedBy: 'Farhan Shamim',
    });
    expect(plan.orderLines[0]).toMatchObject({
      expectedSellPrice: 19.95,
      expectedMargin: 12.2,
      expectedProfit: 120.5,
      amazonCheckStatus: 'Cleared',
      shipmentFlag: 'Yes',
      priority: 'High',
    });
    expect(plan.hasBlockingIssues).toBe(false);
  });

  it('uses runtime-independent code-point ordering for source evidence hashes', () => {
    expect(buildPlan().orderLines[0].sourceEvidence.hash).toBe(
      '0c3b291d8d3a1997388d30b1941c34e8d6f3913efbd766417c67fa275ddc7b38',
    );
  });

  it('excludes rows with missing supplier IDs without blocking the import', () => {
    const plan = buildSupplierOrderImportPlan({
      asOfDate: '2026-07-16',
      overrides,
      files: [
        source('supplier_ids', [{ 'SR ID': 'SRO-300', 'Supplier Name': 'Good Supply' }]),
        source('purchase_orders', [
          { 'Order ID': 'EF71626B', Company: 'Ecofission LLC', 'SR ID ': '', 'PO approval': 'Approved' },
        ]),
        source('order_details', [
          { 'Order ID': 'EF71626B', Company: 'Ecofission LLC', 'SR ID': '', ASIN: 'B012345678', Qty: '2' },
        ]),
      ],
    });

    expect(plan.orders).toEqual([]);
    expect(plan.orderLines).toEqual([]);
    expect(plan.hasBlockingIssues).toBe(false);
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'purchase_order_supplier_id_missing', disposition: 'excluded' }),
        expect.objectContaining({ reason: 'order_detail_supplier_id_missing', disposition: 'excluded' }),
      ]),
    );
  });

  it('keeps headerless details as explicit exceptions until ClickUp draft preflight', () => {
    const plan = buildSupplierOrderImportPlan({
      asOfDate: '2026-07-16',
      overrides,
      files: [
        source('supplier_ids', [{ 'SR ID': 'SRO-300', 'Supplier Name': 'Good Supply' }]),
        source('supplier_tracker', []),
        source('purchase_orders', []),
        source('order_details', [
          {
            'Order ID': 'EF71626B',
            Timestamp: '16/07/2026',
            Company: 'Ecofission LLC',
            'SR ID': 'SRO-300',
            Supplier: 'Good Supply',
            ASIN: 'B012345678',
            SKU: 'SKU-1',
            Qty: '2',
          },
        ]),
      ],
    });

    expect(plan.orders).toEqual([]);
    expect(plan.headerlessOrderOutcomes).toEqual([
      { externalOrderId: 'EF71626B', disposition: 'exception', reason: 'purchase_order_header_missing' },
    ]);
  });

  it('preserves non-equivalent repeated lines by default and supports explicit revision selection across row reordering', () => {
    const detailRows = [
      {
        'Order ID': 'EF71626A',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-300',
        ASIN: 'B012345678',
        SKU: ' SKU-1 ',
        Qty: '4',
        PPU: '2.50',
      },
      {
        'Order ID': 'EF71626A',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-300',
        ASIN: 'b012345678',
        SKU: 'sku-1',
        Qty: '6',
        PPU: '2.50',
      },
    ];
    const blocked = buildLineRevisionPlan(detailRows);
    const duplicate = blocked.duplicateOrderLines[0] as unknown as {
      identity: string;
      sourceHashes: string[];
      disposition: string;
    };
    expect(duplicate).toMatchObject({
      identity: 'ECOFISSION_LLC:EF71626A:B012345678:SKU:SKU-1',
      disposition: 'preserved_repeat',
    });
    expect(duplicate.sourceHashes).toHaveLength(2);
    expect(blocked.orderLines).toHaveLength(2);
    expect(blocked.hasBlockingIssues).toBe(false);

    const decision = {
      [duplicate.identity]: {
        disposition: 'select',
        selectedSourceHash: duplicate.sourceHashes[1],
        reason: 'The six-unit row is the authoritative revision.',
      },
    };
    const selected = buildLineRevisionPlan(detailRows, decision);
    const reordered = buildLineRevisionPlan([...detailRows].reverse(), decision);

    expect(selected.orderLines).toEqual([
      expect.objectContaining({ sourceLineKey: duplicate.identity, orderQty: 6, supplierSku: 'sku-1' }),
    ]);
    expect(reordered.orderLines).toEqual([
      expect.objectContaining({ sourceLineKey: duplicate.identity, orderQty: 6, supplierSku: 'sku-1' }),
    ]);
    expect(selected.orderLines[0].sourceEvidence.hash).toBe(reordered.orderLines[0].sourceEvidence.hash);
    expect(selected.orderLines[0].sourceEvidence.rows.map((row) => row.hash).sort()).toEqual(
      reordered.orderLines[0].sourceEvidence.rows.map((row) => row.hash).sort(),
    );
  });

  it('assigns explicit stable suffixes to proven repeated canonical lines', () => {
    const rows = [
      {
        'Order ID': 'EF71626A',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-300',
        ASIN: 'B012345678',
        SKU: 'SKU-1',
        Qty: '4',
      },
      {
        'Order ID': 'EF71626A',
        Company: 'Ecofission LLC',
        'SR ID': 'SRO-300',
        ASIN: 'B012345678',
        SKU: 'SKU-1',
        Qty: '6',
      },
    ];
    const blocked = buildLineRevisionPlan(rows);
    const duplicate = blocked.duplicateOrderLines[0] as unknown as { identity: string; sourceHashes: string[] };
    const decision = {
      [duplicate.identity]: {
        disposition: 'repeat',
        reason: 'Both source records are genuine ordered line items.',
        occurrences: [
          { sourceHash: duplicate.sourceHashes[0], suffix: 'first' },
          { sourceHash: duplicate.sourceHashes[1], suffix: 'second' },
        ],
      },
    };

    const first = buildLineRevisionPlan(rows, decision);
    const reordered = buildLineRevisionPlan([...rows].reverse(), decision);

    expect(first.orderLines.map((line) => line.sourceLineKey).sort()).toEqual([
      `${duplicate.identity}#first`,
      `${duplicate.identity}#second`,
    ]);
    expect(reordered.orderLines.map((line) => line.sourceLineKey).sort()).toEqual(
      first.orderLines.map((line) => line.sourceLineKey).sort(),
    );
    expect(first.hasBlockingIssues).toBe(false);
  });

  it('classifies insufficient purchase evidence as unknown instead of confirmed', () => {
    const plan = buildSupplierOrderImportPlan({
      asOfDate: '2026-07-16',
      files: [
        source('supplier_ids', [{ 'SR ID': 'SRO-300', 'Supplier Name': 'Good Supply' }]),
        source('purchase_orders', [
          {
            Timestamp: '16/07/2026',
            'Order ID': 'EF71626A',
            'SR ID ': 'SRO-300',
            Company: 'Ecofission LLC',
            'PO approval': '',
            'Order status': '',
          },
        ]),
        source('order_details', []),
      ],
    });

    expect(plan.orders[0].purchaseEvidenceStatus).toBe('unknown');
  });

  it('accepts role-labelled required inputs with arbitrary filenames, extra columns, and no enrichment files', () => {
    const plan = buildSupplierOrderImportPlan({
      asOfDate: '2026-07-16',
      files: [
        {
          name: '/imports/current-suppliers.csv',
          role: 'supplier_ids',
          content: 'SR ID,Supplier Name,Ignored\nSRO-300,Good Supply,value\n',
        },
        {
          name: '/imports/current-orders.csv',
          role: 'purchase_orders',
          dateFormat: 'day-first',
          content:
            'Timestamp,Order ID,SR ID,Company,PO approval,Order status,Ignored\n' +
            '16/07/2026,EF71626A,SRO-300,Ecofission LLC,Approved,Completed,value\n',
        },
        {
          name: '/imports/current-lines.csv',
          role: 'order_details',
          content:
            'Order ID,Company,SR ID,ASIN,SKU,UPC,Qty,Ignored\n' +
            'EF71626A,Ecofission LLC,SRO-300,B012345678,SKU-1,123456789012,4,value\n',
        },
      ],
    });

    expect(plan.sourceFiles.map((file) => file.role)).toEqual(['order_details', 'purchase_orders', 'supplier_ids']);
    expect(plan.orders).toHaveLength(1);
    expect(plan.orderLines).toHaveLength(1);
  });

  it('returns a stable digest for the same source bytes', () => {
    const first = buildPlan();
    const second = buildPlan();

    expect(second.digest).toBe(first.digest);
    expect(second).toEqual(first);
  });

  it('keeps the digest independent of caller paths and modification times', () => {
    const files = [
      source('supplier_ids', [{ 'SR ID': 'SRO-300', 'Supplier Name': 'Good Supply' }]),
      source('purchase_orders', [
        {
          'Order ID': 'EF71626A',
          'SR ID ': 'SRO-300',
          Company: 'Ecofission LLC',
          'PO approval': 'Approved',
          'Order status': 'Completed',
        },
      ]),
      source('order_details', [
        {
          'Order ID': 'EF71626A',
          Company: 'Ecofission LLC',
          'SR ID': 'SRO-300',
          ASIN: 'B012345678',
          SKU: 'SKU-1',
          Qty: '4',
        },
      ]),
    ];
    const build = (prefix: string, modifiedAt: string) =>
      buildSupplierOrderImportPlan({
        asOfDate: '2026-07-16',
        overrides,
        files: files.map((file) => ({ ...file, name: `${prefix}/${file.role}.csv`, modifiedAt })),
      });

    const first = build('/first', '2026-07-16T00:00:00.000Z');
    const second = build('/renamed', '2026-07-17T00:00:00.000Z');

    expect(second.digest).toBe(first.digest);
    expect(first.orderLines[0].sourceEvidence.file).toBe('order_details');
  });
});
