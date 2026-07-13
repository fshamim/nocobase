/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface GreenfieldOrderFixture {
  id: string;
  explicitCompany: string;
  orderRef: string;
  status: string;
  orderDate: string;
  expectedDisposition: 'accept' | 'discard' | 'review';
  orphan?: boolean;
  coherentEvidence?: boolean;
  hasCurrentClickupEvidence?: boolean;
}

export const greenfieldCompanyCases = [
  { id: 'ecofission', source: 'legacy_csv', value: 'Ecofission LLC', disposition: 'accept' },
  { id: 'retail-heaven', source: 'legacy_csv', value: 'Retail Heaven Inc', disposition: 'accept' },
  { id: 'muxtex', source: 'legacy_csv', value: 'Muxtex INC', disposition: 'accept' },
  { id: 'stop-shop', source: 'legacy_csv', value: 'Stop Shop LLC', disposition: 'accept' },
  { id: 'sellerboard-fissionem', source: 'sellerboard', value: 'Fissionem', disposition: 'accept' },
  { id: 'legacy-stopshop', source: 'legacy_csv', value: 'StopShopLLC', disposition: 'accept' },
  { id: 'legacy-stopshop-spaced', source: 'legacy_csv', value: 'StopShop LLC', disposition: 'accept' },
  {
    id: 'supplier-muxtex-alias',
    source: 'supplier_csv_provenance',
    value: 'Muxtex Inc',
    disposition: 'accept',
  },
  { id: 'other-company', source: 'legacy_csv', value: 'Example Other Company LLC', disposition: 'discard' },
  { id: 'formula-tail', source: 'legacy_csv', value: '   ', disposition: 'discard' },
] as const;

export const greenfieldOrderCases = [
  {
    id: 'EF7225C-company-conflict',
    explicitCompany: 'Retail Heaven Inc',
    orderRef: 'EF7225C',
    status: 'ORDERED',
    orderDate: '2026-07-01',
    expectedDisposition: 'discard',
  },
  {
    id: 'EF71525A-company-conflict',
    explicitCompany: 'Stop Shop LLC',
    orderRef: 'EF71525A',
    status: 'ORDERED',
    orderDate: '2026-07-01',
    expectedDisposition: 'discard',
  },
  {
    id: 'MX122525G-company-conflict',
    explicitCompany: 'Ecofission LLC',
    orderRef: 'MX122525G',
    status: 'ORDERED',
    orderDate: '2026-07-01',
    expectedDisposition: 'discard',
  },
  {
    id: 'USA-SS-BS-012426-01-unsupported-prefix',
    explicitCompany: 'Stop Shop LLC',
    orderRef: 'USA-SS-BS-012426-01',
    status: 'ORDERED',
    orderDate: '2026-07-01',
    expectedDisposition: 'discard',
  },
  {
    id: 'SS42826A-approved-alias',
    explicitCompany: 'StopShopLLC',
    orderRef: 'SS42826A',
    status: 'ORDERED',
    orderDate: '2026-04-28',
    expectedDisposition: 'accept',
  },
  {
    id: 'open-old',
    explicitCompany: 'Ecofission LLC',
    orderRef: 'EF1001A',
    status: 'ORDERED',
    orderDate: '2025-01-01',
    expectedDisposition: 'accept',
  },
  {
    id: 'recent-complete',
    explicitCompany: 'Ecofission LLC',
    orderRef: 'EF1002A',
    status: 'COMPLETE',
    orderDate: '2026-06-20',
    expectedDisposition: 'accept',
  },
  {
    id: 'stale-complete',
    explicitCompany: 'Ecofission LLC',
    orderRef: 'EF1003A',
    status: 'COMPLETE',
    orderDate: '2026-05-01',
    expectedDisposition: 'discard',
  },
  {
    id: 'recent-unknown',
    explicitCompany: 'Muxtex INC',
    orderRef: 'MX1004A',
    status: 'Needs review',
    orderDate: '2026-06-01',
    expectedDisposition: 'review',
  },
  {
    id: 'stale-unknown',
    explicitCompany: 'Muxtex INC',
    orderRef: 'MX1005A',
    status: 'Needs review',
    orderDate: '2025-01-01',
    expectedDisposition: 'discard',
  },
  {
    id: 'current-orphan',
    explicitCompany: 'Retail Heaven Inc',
    orderRef: 'RH1006A',
    status: 'ORDERED',
    orderDate: '2026-06-01',
    orphan: true,
    coherentEvidence: true,
    hasCurrentClickupEvidence: true,
    expectedDisposition: 'review',
  },
  {
    id: 'stale-orphan',
    explicitCompany: 'Retail Heaven Inc',
    orderRef: 'RH1007A',
    status: 'Needs review',
    orderDate: '2025-01-01',
    orphan: true,
    coherentEvidence: true,
    expectedDisposition: 'discard',
  },
] as const satisfies readonly GreenfieldOrderFixture[];

export const greenfieldIdentityCases = {
  supplierRefs: [
    { externalRef: 'SRO-12939', disposition: 'accept', supplierName: 'Delko Tools' },
    { externalRef: 'SRO-1293', disposition: 'reject' },
    { externalRef: 'SRO-12572', disposition: 'accept', supplierName: 'Franklin Machine Products' },
    { externalRef: 'SRO-1257', disposition: 'reject' },
  ],
  sku: { asin: 'B0177E9JPS', amazonListingSku: 'ETC-120A', sourceSupplierSku: 'ETC120A' },
  accountListings: [
    { company: 'Ecofission LLC', account: 'account-a', marketplace: 'US', asin: 'B000000001', sku: 'SKU-A' },
    { company: 'Ecofission LLC', account: 'account-b', marketplace: 'US', asin: 'B000000001', sku: 'SKU-B' },
  ],
  lines: [
    { id: 'exact-duplicate-a', orderRef: 'EF1001A', asin: 'B000000001', sku: 'SUP-1', quantity: 5 },
    { id: 'exact-duplicate-b', orderRef: 'EF1001A', asin: 'B000000001', sku: 'SUP-1', quantity: 5 },
    { id: 'separate-occurrence', orderRef: 'EF1001A', asin: 'B000000001', sku: 'SUP-1', quantity: 8 },
  ],
} as const;

export const greenfieldClickupCases = [
  { id: 'retained-only', taskId: 'task-1', parentId: '', orderRefs: ['EF1001A'] },
  { id: 'mixed', taskId: 'task-2', parentId: '', orderRefs: ['EF1001A', 'MX9999A'] },
  { id: 'unrelated', taskId: 'task-3', parentId: '', orderRefs: [] },
] as const;

export const fakeSensitiveSupplierRow = {
  'SR ID': 'SRO-FAKE-1',
  'Supplier Name': 'Synthetic Supplier',
  'Reached Via': 'Ecofission LLC',
  ASIN: 'B000000001',
  SKU: 'SUP-1',
  MOQ: '12',
  'Lead time(day)': '30',
  Username: 'synthetic-user',
  pass: 'synthetic-secret-do-not-use',
  'PR Portal Link': 'https://invalid.example.test/login?token=synthetic-token',
  'Contact Email': 'operator@example.invalid',
  Remarks: 'Synthetic fixture only',
} as const;
