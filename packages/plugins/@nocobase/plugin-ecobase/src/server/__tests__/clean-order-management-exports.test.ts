/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { parseDelimitedCsv } from '../../features/source-import/server/adapters/csv-utils';
import { EXPECTED_SOURCE_HEADERS } from '../../features/source-import/server/supplier-order-import/supplier-order-import-plan';
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
} from '../../../scripts/clean-order-management-exports';

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
  // Order date governs line items; the map carries each kept PO's authoritative company.
  const keptPos = new Map([
    ['EF2526B', 'Ecofission LLC'],
    ['MX111A', 'Muxtex INC'],
    ['MX222A', 'Muxtex INC'],
    ['SS333A', 'Stop Shop LLC'],
    ['MX444A', 'Muxtex INC'],
    ['SS555B', 'Stop Shop LLC'],
  ]);
  const report = cleanOrderDetails(
    'od.csv',
    parse(OD_HEADERS, [
      ['EF2526B', '24/01/2026', 'Ecofission LLC', 'SRO-1', 'B012345678', 'SKU-1', '4', 'ok'],
      ['EF2526B', '24/01/2026', 'Ecofission LLC', 'SRO-1', 'B022345678', '', '2', '#REF!'],
      ['EF2526B', 'not a date', 'Ecofission LLC', 'SRO-1', 'B072345678', 'SKU-8', '5', 'ok'],
      ['EF2526B', '01/01/2020', 'Ecofission LLC', 'SRO-1', 'B082345678', 'SKU-9', '6', 'ok'],
      ['EF2526B', 'not a date', 'Gigi USA INC', 'SRO-7', 'B102345678', 'SKU-11', '1', 'ok'],
      ['USA-SS-BS-012426-01', '24/01/2026', 'Stop Shop LLC', 'SRO-2', 'B032345678', 'SKU-3', '1', 'ok'],
      ['MX111A', '24/01/2026', 'Muxtex INC', 'SRO-3', '#REF!', 'SKU-4', '1', 'ok'],
      ['MX222A', '24/01/2026', 'Muxtex INC', 'SRO-3', 'B042345678', 'SKU-5', '#REF!', 'ok'],
      ['SS333A', '24/01/2026', 'StopShop LLC', 'SRO-4', 'B052345678', 'SKU-6', '3', 'ok'],
      ['EF999A', '01/01/2020', 'Ecofission LLC', 'SRO-5', 'B062345678', 'SKU-7', '1', 'ok'],
      ['EF888A', 'not a date', 'Ecofission LLC', 'SRO-6', 'B092345678', 'SKU-10', '1', 'ok'],
      ['MX444A', '24/01/2026', 'Ecofission LLC', 'SRO-9', 'B112345678', 'SKU-12', '2', 'ok'],
      ['SS555B', '24/01/2026', 'Stop Shop LLC', 'SR-283', 'B122345678', 'SKU-13', '2', 'ok'],
      ['SS555B', '24/01/2026', 'Stop Shop LLC', 'not a code, just prose', 'B132345678', 'SKU-14', '1', 'ok'],
      ['MX444A', '24/01/2026', 'Muxtex INC', 'SRO-9', 'B142345678', 'SKU-15', '0', 'ok'],
      ['MX444A', '24/01/2026', 'Muxtex INC', 'SRO-9', 'B152345678', 'SKU-16', '-2', 'ok'],
      ['MX666C', '24/01/2026', 'Ecofission LLC', 'SRO-10', 'B162345678', 'SKU-17', '3', 'ok'],
      ['EF777A', '24/01/2026', 'Ecofission LLC', 'SRO-11', 'B172345678', 'SKU-18', '2', 'ok'],
    ]),
    resolver,
    '2026-01-24',
    keptPos,
  );

  it('keeps valid lines including empty SKUs, drops broken required fields and corrupted ids', () => {
    // Two normal + two rescued EF2526B lines, SS333A, aligned MX444A, two SS555B lines,
    // prefix-aligned orphan MX666C, and untouched orphan EF777A.
    expect(report.keptRows).toBe(10);
    expect(report.droppedByReason).toMatchObject({
      corrupted_order_id: 1,
      asin_invalid: 1,
      qty_invalid: 3,
      outside_6_month_window: 1,
      junk_unparseable_date: 1,
      company_not_in_scope: 1,
    });
    expect(report.corruptedOrderIdClasses).toEqual({ long_form: 1 });
    expect(integrityHolds(report)).toBe(true);
  });

  it('passes valid SR-283-style supplier codes through and blanks invalid ones while keeping the line', () => {
    const asinIndex = report.outputHeaders.indexOf('ASIN');
    const srIdIndex = report.outputHeaders.indexOf('SR ID');
    const validCodeRow = report.outputRows.find((row) => row[asinIndex] === 'B122345678');
    const blankedRow = report.outputRows.find((row) => row[asinIndex] === 'B132345678');
    expect(validCodeRow?.[srIdIndex]).toBe('SR-283'); // valid to the importer, passes through untouched
    expect(blankedRow).toBeDefined(); // the line survives
    expect(blankedRow?.[srIdIndex]).toBe(''); // the invalid prose cell is blanked, not repaired
    expect(report.blankedInvalidLineSupplierIds).toBe(1);
  });

  it('drops non-positive quantities under the required-field rule', () => {
    const asinIndex = report.outputHeaders.indexOf('ASIN');
    expect(report.outputRows.find((row) => row[asinIndex] === 'B142345678')).toBeUndefined(); // Qty 0
    expect(report.outputRows.find((row) => row[asinIndex] === 'B152345678')).toBeUndefined(); // Qty -2
  });

  it('aligns a mismatched line company to its kept parent PO company', () => {
    const asinIndex = report.outputHeaders.indexOf('ASIN');
    const companyIndex = report.outputHeaders.indexOf('Company');
    const alignedRow = report.outputRows.find((row) => row[asinIndex] === 'B112345678');
    expect(alignedRow?.[companyIndex]).toBe('Muxtex INC'); // line said Ecofission LLC; kept PO wins
    expect(report.companyAlignedToParentPo).toBe(1);
    expect(report.companyBreakdown?.['Muxtex INC']).toBe(2); // breakdown counts aligned companies (MX444A + MX666C)
  });

  it('aligns an orphan line company to its order-id prefix when no kept parent PO exists', () => {
    const asinIndex = report.outputHeaders.indexOf('ASIN');
    const companyIndex = report.outputHeaders.indexOf('Company');
    // MX666C has no kept PO; its MX prefix is company evidence the importer enforces.
    const prefixAlignedRow = report.outputRows.find((row) => row[asinIndex] === 'B162345678');
    expect(prefixAlignedRow?.[companyIndex]).toBe('Muxtex INC'); // line said Ecofission LLC; prefix wins
    expect(report.companyAlignedToOrderPrefix).toBe(1);
    // An orphan whose company already matches its prefix passes through untouched.
    const untouchedOrphan = report.outputRows.find((row) => row[asinIndex] === 'B172345678');
    expect(untouchedOrphan?.[companyIndex]).toBe('Ecofission LLC');
  });

  it('keeps lines under a kept PO despite their own junk or out-of-window timestamp', () => {
    expect(report.keptViaParentPo).toBe(2);
    const asinIndex = report.outputHeaders.indexOf('ASIN');
    const timestampIndex = report.outputHeaders.indexOf('Timestamp');
    const junkTimestampRow = report.outputRows.find((row) => row[asinIndex] === 'B072345678');
    const oldTimestampRow = report.outputRows.find((row) => row[asinIndex] === 'B082345678');
    expect(junkTimestampRow).toBeDefined(); // junk timestamp under kept PO -> kept
    expect(junkTimestampRow?.[timestampIndex]).toBe(''); // unparseable timestamp emitted empty, not garbage
    expect(oldTimestampRow).toBeDefined(); // out-of-window timestamp under kept PO -> kept
    expect(oldTimestampRow?.[timestampIndex]).toBe('2020-01-01'); // real date preserved as ISO
  });

  it('still applies own-window and validity rules to lines not under a kept PO', () => {
    const asinIndex = report.outputHeaders.indexOf('ASIN');
    // EF999A (out-of-window) and EF888A (junk timestamp) are not kept POs -> dropped.
    expect(report.outputRows.find((row) => row[asinIndex] === 'B062345678')).toBeUndefined();
    expect(report.outputRows.find((row) => row[asinIndex] === 'B092345678')).toBeUndefined();
    // Required-field validity and company scope still apply even under a kept PO.
    expect(report.outputRows.find((row) => row[asinIndex] === 'B042345678')).toBeUndefined(); // qty #REF!
    expect(report.outputRows.find((row) => row[asinIndex] === 'B102345678')).toBeUndefined(); // out-of-scope company
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

  it('falls back to pure own-window behavior when the kept-PO set is empty', () => {
    const fallback = cleanOrderDetails(
      'od.csv',
      parse(OD_HEADERS, [
        ['EF2526B', '24/01/2026', 'Ecofission LLC', 'SRO-1', 'B012345678', 'SKU-1', '4', 'ok'],
        ['EF2526B', '01/01/2020', 'Ecofission LLC', 'SRO-1', 'B082345678', 'SKU-9', '6', 'ok'],
      ]),
      resolver,
      '2026-01-24',
      new Map<string, string>(),
    );
    expect(fallback.keptRows).toBe(1);
    expect(fallback.keptViaParentPo).toBe(0);
    expect(fallback.droppedByReason).toMatchObject({ outside_6_month_window: 1 });
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
