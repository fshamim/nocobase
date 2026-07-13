/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { importCsvFiles } from '../../features/source-import/server/adapters/amazon-operations-csv-adapter';
import type { AdapterStreamItem } from '../../features/source-import/server/adapters/types';

async function importFiles(files: Array<{ name: string; content: string }>) {
  const items: AdapterStreamItem[] = [];
  for await (const item of importCsvFiles({
    sourceConnectionId: 'source-1',
    sourceIdentifier: 'test-source',
    sourceVersion: '2026-07-10',
    idempotencyKey: 'test-import',
    config: { files },
  })) {
    items.push(item);
  }
  return items;
}

describe('order import source policy', () => {
  it('keeps only the most recent complete supported OrderDetails row', async () => {
    const items = await importFiles([
      {
        name: 'Purchase Orders.csv',
        content: [
          'Timestamp,Order ID,Company,SR ID,Supplier,Order status,Payment Status',
          '03/01/2026 09:00:00,EF1001A,Ecofission LLC,SRO-1,Supplier,In Progress,Paid',
        ].join('\n'),
      },
      {
        name: 'OrderDetails.csv',
        content: [
          'Timestamp,Order ID,Company,SR ID,Supplier,ASIN,SKU,Qty,Lead time(day)',
          '01/01/2026 10:00:00,EF1001A,Ecofission LLC,SRO-1,Supplier,B000000001,SKU-1,4',
          '03/01/2026 10:00:00,EF1001A,Ecofission LLC,SRO-1,Supplier,B000000001,SKU-1,9',
          '04/01/2026 10:00:00,,Ecofission LLC,SRO-1,Supplier,B000000002,SKU-2,3',
          '05/01/2026 10:00:00,USA-OTHER-1,Ecofission LLC,SRO-1,Supplier,B000000003,SKU-3,2',
        ].join('\n'),
      },
    ]);

    const records = items.filter((item) => item.type === 'record');
    const detailRecords = records.filter((item) => item.payload.ASIN);
    const issues = items.filter((item) => item.type === 'rowIssue').map((item) => item.issue);
    expect(records).toHaveLength(2);
    expect(detailRecords).toHaveLength(1);
    expect(detailRecords[0]).toMatchObject({ rowNumber: 3, payload: { Qty: '9' } });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowNumber: 0,
          code: 'discarded_order_detail_superseded',
          payload: expect.objectContaining({ discardedCount: 1 }),
        }),
        expect.objectContaining({
          rowNumber: 0,
          code: 'discarded_order_missing_order_ref',
          payload: expect.objectContaining({ discardedCount: 1 }),
        }),
        expect.objectContaining({
          rowNumber: 0,
          code: 'discarded_order_unsupported_order_ref',
          payload: expect.objectContaining({ discardedCount: 1 }),
        }),
      ]),
    );
  });

  it('admits details from retained headers and aggregates policy discards', async () => {
    const items = await importFiles([
      {
        name: 'OrderDetails.csv',
        content: [
          'Timestamp,Order ID,Company,SR ID,Supplier,ASIN,SKU,Qty,Lead time(day)',
          '03/01/2020 10:00:00,EF1001A,Ecofission LLC,SRO-1,Open Supplier,B000000001,SKU-1,4,10',
          '03/01/2020 10:00:00,EF1001A,Ecofission LLC,SRO-9,Wrong Supplier,B000000009,SKU-9,1,10',
          '26/06/2026 10:00:00,MX1002A,Muxtex INC,SRO-2,Recent Supplier,B000000002,SKU-2,5,10',
          '02/01/2025 10:00:00,RH1003A,Retail Heaven Inc,SRO-9,Wrong Supplier,B000000003,SKU-3,2,10',
          '02/07/2026 10:00:00,SS1004A,Stop Shop LLC,SRO-4,Cancelled Supplier,B000000004,SKU-4,2,10',
          '02/07/2026 10:00:00,EF1005A,Ecofission LLC,SRO-5,Draft Supplier,B000000005,SKU-5,2,10',
        ].join('\n'),
      },
      {
        name: 'Purchase Orders.csv',
        content: [
          'Timestamp,Order ID,Company,SR ID,Supplier,Order status,Payment Status',
          '03/01/2020 09:00:00,EF1001A,Ecofission LLC,SRO-1,Open Supplier,In Progress,Paid',
          '25/06/2026 09:00:00,MX1002A,Muxtex INC,SRO-2,Recent Supplier,Completed,Completed',
          '01/01/2025 09:00:00,RH1003A,Retail Heaven Inc,SRO-3,Old Supplier,Completed,Completed',
          '01/07/2026 09:00:00,SS1004A,Stop Shop LLC,SRO-4,Cancelled Supplier,Cancelled,',
          '01/07/2026 09:00:00,EF1005A,Ecofission LLC,SRO-5,Draft Supplier,Draft,',
        ].join('\n'),
      },
    ]);

    const records = items.filter((item) => item.type === 'record');
    expect(records.map((item) => item.payload['Order ID'])).toEqual(['EF1001A', 'MX1002A', 'EF1001A', 'MX1002A']);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'rowIssue',
          issue: expect.objectContaining({
            rowNumber: 0,
            code: 'discarded_order_stale_complete_order',
            payload: expect.objectContaining({ discardedCount: 1 }),
          }),
        }),
        expect.objectContaining({
          type: 'rowIssue',
          issue: expect.objectContaining({
            rowNumber: 0,
            code: 'discarded_order_cancelled_or_rejected_order',
            payload: expect.objectContaining({ discardedCount: 1 }),
          }),
        }),
        expect.objectContaining({
          type: 'rowIssue',
          issue: expect.objectContaining({
            rowNumber: 0,
            code: 'discarded_order_draft_or_analysis_order',
            payload: expect.objectContaining({ discardedCount: 1 }),
          }),
        }),
        expect.objectContaining({
          type: 'rowIssue',
          issue: expect.objectContaining({
            rowNumber: 0,
            code: 'discarded_order_detail_supplier_mismatch',
            payload: expect.objectContaining({ discardedCount: 1 }),
          }),
        }),
        expect.objectContaining({
          type: 'rowIssue',
          issue: expect.objectContaining({
            rowNumber: 0,
            code: 'retained_order_detail_supplier_mismatch',
            payload: expect.objectContaining({ discardedCount: 1 }),
          }),
        }),
      ]),
    );
  });

  it('registers supplier SR IDs without company and excludes the Call & Email row', async () => {
    const items = await importFiles([
      {
        name: 'Supplier Analysis Tracker.csv',
        content: [
          'SR ID,Supplier Name,Reached Via,ASIN,Wholesale Price List',
          'SRO-1,Global Supplier,,B000000001',
          'SRO-2,Invalid Supplier,Call & Email,B000000002',
        ].join('\n'),
      },
    ]);

    const records = items.filter((item) => item.type === 'record');
    const issues = items.filter((item) => item.type === 'rowIssue').map((item) => item.issue);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      rowNumber: 2,
      record: [expect.objectContaining({ kind: 'supplier', data: expect.objectContaining({ supplierId: 'SRO-1' }) })],
    });
    expect(issues).toEqual([expect.objectContaining({ rowNumber: 3, code: 'supplier_row_excluded_invalid_company' })]);
  });
});
