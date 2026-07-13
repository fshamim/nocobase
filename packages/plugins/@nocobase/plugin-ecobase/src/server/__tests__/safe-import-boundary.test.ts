/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import type { AdapterStreamItem, SourceAdapter } from '../../features/source-import/server/adapters';
import { applySafeImportBoundary } from '../../features/source-import/server/safe-import-boundary';

function adapter(sourceType: SourceAdapter['metadata']['sourceType'], name = 'amazon-operations-csv'): SourceAdapter {
  return {
    metadata: { name, title: name, sourceType, supportedDomains: ['foundation'], version: 'test' },
    async *import() {},
  };
}

function orderItem(company: string | undefined, orderRef = 'EF1001A'): AdapterStreamItem {
  const payload: Record<string, unknown> = {
    Timestamp: '2026-07-01',
    'Order ID': orderRef,
    'SR ID': 'SRO-1',
    Supplier: 'Synthetic Supplier',
    ASIN: 'B000000001',
    SKU: 'SKU-1',
    Qty: '4',
    'Lead time(day)': '30',
    Password: 'synthetic-secret-do-not-use',
  };
  if (company !== undefined) payload.Company = company;
  return {
    type: 'record',
    rowNumber: 2,
    sourceKey: 'OrderDetails.csv:2',
    payload,
    record: {
      kind: 'supplier_order_line',
      data: { ...(company ? { company } : {}), orderRef, asin: 'B000000001', orderedQty: 4 },
    },
  };
}

describe('safe import boundary', () => {
  it('accepts a target-company row only after minimal projection', () => {
    const result = applySafeImportBoundary({ adapter: adapter('seller_central_file') }, orderItem('Ecofission LLC'));
    expect(result).toMatchObject({
      disposition: 'accept',
      companyKey: 'ECOFISSION_LLC',
      sourceDataset: 'order_details',
      reasonCode: 'canonical_company',
      droppedFieldCount: 1,
    });
    if (result.disposition !== 'accept') return;
    expect(result.item).toMatchObject({
      type: 'record',
      payload: {
        occurredAt: '2026-07-01',
        orderRef: 'EF1001A',
        company: 'Ecofission LLC',
        supplierExternalRef: 'SRO-1',
        supplierName: 'Synthetic Supplier',
        sourceAsin: 'B000000001',
        sourceSupplierSku: 'SKU-1',
        quantity: '4',
        leadTimeDays: '30',
      },
    });
    expect(JSON.stringify(result.item)).not.toContain('synthetic-secret-do-not-use');
  });

  it('discards unsupported companies and conflicting order prefixes before Bronze', () => {
    expect(
      applySafeImportBoundary({ adapter: adapter('seller_central_file') }, orderItem('Example Other LLC')),
    ).toEqual({ disposition: 'discard', reasonCode: 'company_out_of_scope', droppedFieldCount: 0 });
    expect(
      applySafeImportBoundary({ adapter: adapter('seller_central_file') }, orderItem('Muxtex INC', 'EF1001A')),
    ).toEqual({ disposition: 'discard', reasonCode: 'company_evidence_conflict', droppedFieldCount: 0 });
    expect(
      applySafeImportBoundary({ adapter: adapter('seller_central_file') }, orderItem('Stop Shop LLC', 'USA-SS-1')),
    ).toEqual({ disposition: 'discard', reasonCode: 'unsupported_order_ref', droppedFieldCount: 0 });
  });

  it('enforces exact supplier-reference accept/reject decisions before Bronze', () => {
    const supplierItem = (externalRef: string): AdapterStreamItem => ({
      type: 'record',
      rowNumber: 2,
      sourceKey: `supplier.csv:${externalRef}`,
      payload: {
        'SR ID': externalRef,
        'Supplier Name': 'Franklin Machine Products',
        'Supplier Type': 'Manufacturer',
        'Reached Via': 'Ecofission LLC',
      },
      record: {
        kind: 'supplier',
        data: { company: 'Ecofission LLC', supplierExternalRef: externalRef },
      },
    });
    expect(applySafeImportBoundary({ adapter: adapter('google_sheets') }, supplierItem('SRO-1257'))).toEqual({
      disposition: 'discard',
      reasonCode: 'supplier_external_ref_rejected',
      droppedFieldCount: 0,
    });
    expect(applySafeImportBoundary({ adapter: adapter('google_sheets') }, supplierItem('SRO-12572'))).toMatchObject({
      disposition: 'accept',
      companyKey: 'ECOFISSION_LLC',
      item: { payload: { supplierExternalRef: 'SRO-12572', supplierName: 'Franklin Machine Products' } },
    });
  });

  it('routes coherent header-derived order company evidence to review', () => {
    const result = applySafeImportBoundary(
      { adapter: adapter('seller_central_file'), defaultCompany: 'Retail Heaven Inc' },
      orderItem(undefined, 'RH1001A'),
    );
    expect(result).toMatchObject({
      disposition: 'review',
      companyKey: 'RETAIL_HEAVEN_INC',
      reasonCode: 'company_from_header_and_order_prefix',
      item: { type: 'rowIssue', issue: { code: 'company_from_header_and_order_prefix' } },
    });
  });

  it('keeps safe source issues and access audits without requiring business-company evidence', () => {
    expect(
      applySafeImportBoundary(
        { adapter: adapter('seller_central_file') },
        {
          type: 'rowIssue',
          issue: {
            severity: 'error',
            code: 'csv_shape_unknown',
            message: 'Synthetic invalid shape.',
            payload: { fileName: 'unknown.csv', headerCount: 2, Password: 'discard-me' },
          },
        },
      ),
    ).toMatchObject({
      disposition: 'accept',
      sourceDataset: 'source_issue',
      item: {
        type: 'rowIssue',
        issue: { severity: 'error', code: 'csv_shape_unknown', payload: { fileName: 'unknown.csv', headerCount: 2 } },
      },
    });

    expect(
      applySafeImportBoundary(
        { adapter: adapter('seller_central_file', 'amazon-sp-api-access-check') },
        {
          type: 'record',
          rowNumber: 1,
          payload: { sourceType: 'seller_central_file', domain: 'amazon_operations', status: 'blocked' },
          record: {
            kind: 'source_access_audit',
            data: { naturalKey: 'synthetic:audit', sourceType: 'seller_central_file', status: 'blocked' },
          },
        },
      ),
    ).toMatchObject({
      disposition: 'accept',
      sourceDataset: 'source_access_audit',
      item: {
        type: 'record',
        payload: { sourceType: 'seller_central_file', domain: 'amazon_operations', accessStatus: 'blocked' },
      },
    });
  });

  it('canonicalizes source-scoped Sellerboard aliases in the safe payload', () => {
    const item: AdapterStreamItem = {
      type: 'record',
      rowNumber: 2,
      sourceKey: 'Fissionem_history.csv:2',
      payload: {
        Company: 'Fissionem',
        Date: '2026-07-01',
        Marketplace: 'Amazon.com',
        ASIN: 'B000000001',
        SKU: 'SKU-1',
        SalesOrganic: '10',
      },
      record: { kind: 'listing_daily_fact', data: { company: 'Ecofission LLC' } },
    };
    const result = applySafeImportBoundary({ adapter: adapter('sellerboard', 'sellerboard-history-csv') }, item);
    expect(result).toMatchObject({
      disposition: 'accept',
      companyKey: 'ECOFISSION_LLC',
      item: { payload: { company: 'Ecofission LLC', salesOrganic: '10' } },
    });
  });
});
