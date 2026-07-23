/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { parseDelimitedCsv } from '../../src/features/source-import/server/adapters/csv-utils';
import { EXPECTED_SOURCE_HEADERS } from '../../src/features/source-import/server/supplier-order-import/supplier-order-import-plan';
import {
  assignRoles,
  buildCompanyResolver,
  classifyCorruptedOrderId,
  cleanBundle,
  cleanOrderDetails,
  cleanPurchaseOrders,
  cleanSupplierIds,
  windowCutoff,
  type CleanFileReport,
} from '../clean-order-management-exports';

function csv(headers: string[], rows: string[][]): string {
  return (
    [headers, ...rows]
      .map((row) => row.map((value) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(','))
      .join('\n') + '\n'
  );
}

function parse(headers: string[], rows: string[][]) {
  return parseDelimitedCsv(csv(headers, rows), ',');
}

function integrityHolds(report: CleanFileReport): boolean {
  const dropped = Object.values(report.droppedByReason).reduce((sum, count) => sum + count, 0);
  return report.keptRows + dropped === report.inputRows;
}

const PO_HEADERS = ['Timestamp', 'Order ID', 'SR ID ', 'Supplier', 'Company'];
const OD_HEADERS = ['Order ID', 'Timestamp', 'Company', 'SR ID', 'ASIN', 'SKU', 'Qty', 'Remarks'];

describe('clean-order-management-exports pure helpers', () => {
  it('computes a rolling six-month cutoff', () => {
    expect(windowCutoff('2026-07-24', 6)).toBe('2026-01-24');
    expect(windowCutoff('2026-03-15', 6)).toBe('2025-09-15');
  });

  it('classifies corrupted order-id format classes', () => {
    expect(classifyCorruptedOrderId('OD-1')).toBe('legacy_od');
    expect(classifyCorruptedOrderId('OD-12345')).toBe('legacy_od');
    expect(classifyCorruptedOrderId('USA-SS-BS-012426-01')).toBe('long_form');
    expect(classifyCorruptedOrderId('USA-MX-BS-012326-01')).toBe('long_form');
    expect(classifyCorruptedOrderId('Test Order')).toBe('free_text');
  });

  it('normalizes company aliases and misspellings to canonical names', () => {
    const resolver = buildCompanyResolver();
    expect(resolver('Ecofission LLC')).toEqual({ status: 'ok', name: 'Ecofission LLC' });
    expect(resolver('StopShop LLC')).toEqual({ status: 'ok', name: 'Stop Shop LLC' });
    expect(resolver('StopShopLLC')).toEqual({ status: 'ok', name: 'Stop Shop LLC' });
    expect(resolver('Muxtex Inc')).toEqual({ status: 'ok', name: 'Muxtex INC' });
    expect(resolver('Gigi USA INC')).toEqual({ status: 'out_of_scope', value: 'Gigi USA INC' });
    expect(resolver('')).toEqual({ status: 'blank' });
  });
});

describe('cleanPurchaseOrders', () => {
  const resolver = buildCompanyResolver();
  const report = cleanPurchaseOrders(
    'po.csv',
    parse(PO_HEADERS, [
      ['24/01/2026 10:00:00', 'EF2526B', 'SRO-1', 'Grabo', 'Ecofission LLC'],
      ['30/01/2026 23:08:39', 'Test Order', 'SRO-2', 'edhoy', 'Muxtex INC'],
      ['25/01/2026 09:00:00', 'SS12345A', 'SRO-3', 'x', 'Gigi USA INC'],
      ['not a date', 'SS999A', 'SRO-4', 'x', 'Stop Shop LLC'],
      ['17/06/2023 03:46:51', 'OD-1', 'badri', '', 'Ecofission LLC'],
      ['24/01/2026 08:00:00', 'SS13126A', 'SRO-5', 'x', 'Stop Shop LLC'],
      ['26/01/2026 08:00:00', 'SS13126A', 'SRO-6', 'x', 'StopShop LLC'],
    ]),
    resolver,
    '2026-01-24',
  );

  it('keeps only recent, in-scope, canonical, de-duplicated orders', () => {
    // EF2526B + one SS13126A (latest of the dup pair) survive.
    expect(report.keptRows).toBe(2);
    expect(report.keptOrderIds).toEqual(['EF2526B', 'SS13126A']);
  });

  it('counts every drop rule and reconciles kept + dropped = input', () => {
    expect(report.droppedByReason).toMatchObject({
      corrupted_order_id: 1,
      company_not_in_scope: 1,
      junk_unparseable_date: 1,
      outside_6_month_window: 1,
      duplicate_order_id: 1,
    });
    expect(report.corruptedOrderIdClasses).toEqual({ free_text: 1 });
    expect(integrityHolds(report)).toBe(true);
  });

  it('converts the Timestamp to ISO and canonicalizes the company', () => {
    const timestampIndex = report.outputHeaders.indexOf('Timestamp');
    const companyIndex = report.outputHeaders.indexOf('Company');
    const orderIndex = report.outputHeaders.indexOf('Order ID');
    const dupRow = report.outputRows.find((row) => row[orderIndex] === 'SS13126A');
    expect(dupRow?.[timestampIndex]).toBe('2026-01-26'); // latest of the duplicate pair
    expect(dupRow?.[companyIndex]).toBe('Stop Shop LLC'); // misspelling normalized
    expect(report.outputHeaders).toEqual(EXPECTED_SOURCE_HEADERS.purchase_orders);
  });

  it('records the duplicate collision', () => {
    expect(report.duplicateOrderIds).toEqual([{ orderId: 'SS13126A', keptDate: '2026-01-26', droppedCount: 1 }]);
  });
});

describe('cleanOrderDetails', () => {
  const resolver = buildCompanyResolver();
  const report = cleanOrderDetails(
    'od.csv',
    parse(OD_HEADERS, [
      ['EF2526B', '24/01/2026', 'Ecofission LLC', 'SRO-1', 'B012345678', 'SKU-1', '4', 'ok'],
      ['EF2526B', '24/01/2026', 'Ecofission LLC', 'SRO-1', 'B022345678', '', '2', '#REF!'],
      ['USA-SS-BS-012426-01', '24/01/2026', 'Stop Shop LLC', 'SRO-2', 'B032345678', 'SKU-3', '1', 'ok'],
      ['MX111A', '24/01/2026', 'Muxtex INC', 'SRO-3', '#REF!', 'SKU-4', '1', 'ok'],
      ['MX222A', '24/01/2026', 'Muxtex INC', 'SRO-3', 'B042345678', 'SKU-5', '#REF!', 'ok'],
      ['SS333A', '24/01/2026', 'StopShop LLC', 'SRO-4', 'B052345678', 'SKU-6', '3', 'ok'],
      ['EF999A', '01/01/2020', 'Ecofission LLC', 'SRO-5', 'B062345678', 'SKU-7', '1', 'ok'],
    ]),
    resolver,
    '2026-01-24',
  );

  it('keeps valid lines including empty SKUs, drops broken required fields and corrupted ids', () => {
    expect(report.keptRows).toBe(3); // two EF2526B lines + the misspelled-company SS333A line
    expect(report.droppedByReason).toMatchObject({
      corrupted_order_id: 1,
      asin_invalid: 1,
      qty_invalid: 1,
      outside_6_month_window: 1,
    });
    expect(report.corruptedOrderIdClasses).toEqual({ long_form: 1 });
    expect(integrityHolds(report)).toBe(true);
  });

  it('keeps the empty-SKU row and blanks a #REF! optional cell', () => {
    const skuIndex = report.outputHeaders.indexOf('SKU');
    const remarksIndex = report.outputHeaders.indexOf('Remarks');
    const asinIndex = report.outputHeaders.indexOf('ASIN');
    const emptySkuRow = report.outputRows.find((row) => row[asinIndex] === 'B022345678');
    expect(emptySkuRow?.[skuIndex]).toBe('');
    expect(emptySkuRow?.[remarksIndex]).toBe(''); // #REF! blanked, row kept
    expect(report.outputHeaders).toEqual(EXPECTED_SOURCE_HEADERS.order_details);
  });
});

describe('cleanSupplierIds', () => {
  const report = cleanSupplierIds(
    'suppliers.csv',
    parse(
      ['SR ID', 'Supplier Name'],
      [
        ['SRO-1', 'Alpha'],
        ['SRO-1', 'Alpha'],
        ['SRO-1', 'Beta'],
        ['Duplicate', 'harkersonline'],
        ['', 'Orphan'],
        ['SRO-2', 'Gamma'],
      ],
    ),
  );

  it('dedupes first-seen-wins, drops placeholder + blank ids, and records conflicts', () => {
    expect(report.keptRows).toBe(2);
    expect(report.outputRows.map((row) => row[0])).toEqual(['SRO-1', 'SRO-2']);
    expect(report.droppedByReason).toMatchObject({
      duplicate_sr_id: 2,
      sr_id_placeholder_duplicate: 1,
      sr_id_blank: 1,
    });
    expect(report.supplierNameConflicts).toEqual([{ srId: 'SRO-1', keptName: 'Alpha', conflictingNames: ['Beta'] }]);
    expect(integrityHolds(report)).toBe(true);
  });
});

describe('assignRoles / cleanBundle header validation', () => {
  const validPo = { sourceName: 'po.csv', parsed: parse([...EXPECTED_SOURCE_HEADERS.purchase_orders], []) };
  const validSuppliers = { sourceName: 'suppliers.csv', parsed: parse(['SR ID', 'Supplier Name'], []) };
  const validClickup = {
    sourceName: 'clickup.csv',
    parsed: parse(
      [
        'Task ID',
        'Task Link',
        'Task Type',
        'Task Name',
        'Task Content',
        'Status',
        'Date Created',
        'Date Created Text',
        'Parent ID',
        'List Name',
        'Comments',
      ],
      [],
    ),
  };

  it('fails loudly on a regressed `can ` OrderDetails header (no rename, no positional fallback)', () => {
    const brokenOrderDetails = {
      sourceName: 'od.csv',
      parsed: parse(
        ['can ', ...EXPECTED_SOURCE_HEADERS.order_details.slice(1).filter((header) => header.trim().length)],
        [],
      ),
    };
    const assignment = assignRoles([validPo, validSuppliers, validClickup, brokenOrderDetails]);
    expect(assignment.headerFailures).toHaveLength(1);
    const failure = assignment.headerFailures[0];
    expect(failure.role).toBe('order_details'); // recognized as its intended role despite the bad header
    expect(failure.sourceName).toBe('od.csv');
    expect(failure.missing).toContain('Order ID');
    expect(failure.expectedRequired).toContain('Order ID');
    expect(assignment.missingRoles).toEqual([]); // the file was still routed to order_details
  });

  it('accepts a fully valid four-file bundle', () => {
    const validOrderDetails = { sourceName: 'od.csv', parsed: parse([...EXPECTED_SOURCE_HEADERS.order_details], []) };
    const result = cleanBundle([validPo, validSuppliers, validClickup, validOrderDetails], '2026-07-24', 6);
    expect(result.ok).toBe(true);
    expect(result.headerFailures).toEqual([]);
    expect(result.missingRoles).toEqual([]);
    expect(result.reports.map((report) => report.role).sort()).toEqual([
      'clickup',
      'order_details',
      'purchase_orders',
      'supplier_ids',
    ]);
  });
});
