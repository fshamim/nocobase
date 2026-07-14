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
 * Copyright (c) 2020-2024 NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeSupplierEvidenceRef,
  previewSupplierEvidenceBackfill,
  type SupplierEvidenceSnapshot,
} from '../../features/supplier-management/server/supplier-evidence-backfill-service';

const purchaseHeader = 'Timestamp,Order ID,SR ID ,Supplier,Company,PO approval,Order status,Payment Status ';
const detailHeader =
  'Order ID,Timestamp,Company,SR ID,Supplier,ASIN,SKU,Qty,PPU,AM Status,COO status,PO Status,Shipment';
const trackerHeader = 'SR ID,Supplier Name,ASIN,Status,Active Status,Username,pass,PR Portal Link';
const currentHeader = 'SR ID,Supplier Name,ASIN,Current Status,Status,Username,pass,PR Portal Link';
const supplierIdsHeader = 'SR ID,Supplier Name';

function snapshot(): SupplierEvidenceSnapshot {
  return {
    companies: [{ id: 'company-1', name: 'Ecofission LLC' }],
    products: [
      { id: 'product-1', asin: 'B000000001', sku: 'SKU-1' },
      { id: 'product-2a', asin: 'B000000002', sku: 'SKU-2A' },
      { id: 'product-2b', asin: 'B000000002', sku: 'SKU-2B' },
      { id: 'product-3', asin: 'B000000003', sku: 'SKU-3' },
    ],
    companyProducts: [
      {
        id: 'company-product-1',
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        productId: 'product-1',
        familyId: 'family-1',
      },
      {
        id: 'company-product-2a',
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        productId: 'product-2a',
        familyId: 'family-2a',
      },
      {
        id: 'company-product-2b',
        companyId: 'company-1',
        amazonAccountId: 'account-2',
        productId: 'product-2b',
        familyId: 'family-2b',
      },
      {
        id: 'company-product-3',
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        productId: 'product-3',
        familyId: 'family-3',
      },
    ],
    families: [
      {
        id: 'family-1',
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        marketplace: 'amazon.com',
        asin: 'B000000001',
      },
      {
        id: 'family-2a',
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        marketplace: 'amazon.com',
        asin: 'B000000002',
      },
      {
        id: 'family-2b',
        companyId: 'company-1',
        amazonAccountId: 'account-2',
        marketplace: 'amazon.com',
        asin: 'B000000002',
      },
      {
        id: 'family-3',
        companyId: 'company-1',
        amazonAccountId: 'account-1',
        marketplace: 'amazon.com',
        asin: 'B000000003',
        preferredSupplierId: 'supplier-current',
        supplierSelectionSource: 'latest_valid_order',
      },
    ],
  };
}

function preview(overrides: { purchaseOrders?: string[]; orderDetails?: string[]; supplierIds?: string[] } = {}) {
  return previewSupplierEvidenceBackfill({
    snapshot: snapshot(),
    files: {
      supplierIds: {
        name: 'Supplier IDs.csv',
        content: [supplierIdsHeader, ...(overrides.supplierIds ?? [])].join('\n'),
      },
      supplierTracker: {
        name: 'Supplier Analysis Tracker.csv',
        content: [
          trackerHeader,
          'SRO-12939,Delko Tools,B000000001,Completed,Yes,private-user,super-secret,https://private.invalid',
          'SRO-1257,Rejected Supplier,B000000003,Completed,Yes,private-user,super-secret,https://private.invalid',
        ].join('\n'),
      },
      supplier2026: {
        name: 'Supplier 2026.csv',
        content: [
          currentHeader,
          'SRO-12939,Delko Tools Inc.,B000000001,Active,Approved,private-user,super-secret,https://private.invalid',
          'SRO-12572,Franklin Machine Products,B000000003,Active,Approved,private-user,super-secret,https://private.invalid',
        ].join('\n'),
      },
      purchaseOrders: {
        name: 'Purchase Orders.csv',
        content: [
          purchaseHeader,
          ...(overrides.purchaseOrders ?? [
            '01/07/2026 10:00:00,PO-1,SRO-12939,Delko Tools,Ecofission LLC,Approved,Completed,Completed',
            '02/07/2026 10:00:00,PO-2,SRO-12572,Franklin Machine Products,Ecofission LLC,Approved,Completed,Completed',
            '03/07/2026 10:00:00,PO-3,SRO-12939,Delko Tools,Ecofission LLC,Approved,Completed,Completed',
            '04/07/2026 10:00:00,PO-4,SRO-1257,Rejected Supplier,Ecofission LLC,Approved,Completed,Completed',
          ]),
        ].join('\n'),
      },
      orderDetails: {
        name: 'OrderDetails.csv',
        content: [
          detailHeader,
          ...(overrides.orderDetails ?? [
            'PO-1,01/07/2026 10:00:00,Ecofission LLC,SRO-12939,Delko Tools,B000000001,SKU-1,10,4,Cleared,,,Yes',
            'PO-2,02/07/2026 10:00:00,Ecofission LLC,SRO-12939,Wrong Supplier,B000000003,SKU-3,10,4,Cleared,,,Yes',
            'PO-3,03/07/2026 10:00:00,Ecofission LLC,SRO-12939,Delko Tools,B000000002,,10,4,Cleared,,,Yes',
            'PO-3,03/07/2026 10:00:00,Ecofission LLC,SRO-12939,Delko Tools,B000000002,SKU-2B,10,4,Cleared,,,Yes',
            'PO-4,04/07/2026 10:00:00,Ecofission LLC,SRO-1257,Rejected Supplier,B000000003,SKU-3,10,4,Cleared,,,Yes',
          ]),
        ].join('\n'),
      },
    },
  });
}

describe('supplier evidence backfill dry-run', () => {
  it('uses exact SR IDs, excludes confirmed rejects and header/detail mismatches, and disambiguates account families by exact SKU', () => {
    const result = preview();

    expect(normalizeSupplierEvidenceRef(' sro 12939 ')).toBe('SRO-12939');
    expect(normalizeSupplierEvidenceRef('SRO-1293')).toBe('SRO-1293');
    expect(result.historicalEvidence).toMatchObject({
      acceptedDetailRows: 2,
      candidateFamilies: 2,
      headerDetailSupplierMismatches: 1,
      multiBoundaryAmbiguousRows: 1,
      confirmedRejectedRows: 1,
    });
    expect(result.selectedSourceDistribution).toMatchObject({
      latest_valid_order: 1,
      historical_order_evidence: 2,
      unresolved: 1,
    });
    expect(result.familySelectionProjection).toMatchObject({
      historicalIncrementalCandidates: 2,
      historicalIncrementalAutoApplicable: 2,
      projectedPreferredFamilies: 3,
      projectedUnresolvedFamilies: 1,
    });
    expect(result.sroAssertions['SRO-12939'].selected).toBe(true);
    expect(result.sroAssertions['SRO-1293'].selected).toBe(false);
    expect(result.sroAssertions['SRO-12572'].selected).toBe(false);
    expect(result.sroAssertions['SRO-1257'].selected).toBe(false);
  });

  it('keeps supplier names as display-only evidence and emits no prohibited or raw source material', () => {
    const result = preview();
    const serialized = JSON.stringify(result);

    expect(result.security).toMatchObject({ prohibitedFieldCount: 0, rawRowsPersisted: false });
    expect(serialized).not.toContain('private-user');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('private.invalid');
    expect(result.candidateSupplierRefCount).toBe(1);
  });

  it('uses an unambiguous Supplier IDs row to establish an otherwise missing exact SR ID', () => {
    const result = preview({
      supplierIds: ['SRO-404,Missing Supplier'],
      purchaseOrders: ['01/07/2026 10:00:00,PO-1,SRO-404,Missing Supplier,Ecofission LLC,Approved,Completed,Completed'],
      orderDetails: [
        'PO-1,01/07/2026 10:00:00,Ecofission LLC,SRO-404,Missing Supplier,B000000001,SKU-1,10,4,Cleared,,,Yes',
      ],
    });

    expect(result.historicalEvidence).toMatchObject({ masterResolvedFamilies: 1, masterMissingFamilies: 0 });
    expect(result.supplierIdentityEvidence).toMatchObject({
      usableRefCount: 1,
      conflictingRefCount: 0,
      historicalFamiliesResolvedBySupplierIds: 1,
    });
    expect(result.selectedSourceDistribution).toMatchObject({ historical_order_evidence: 1 });
  });

  it('does not establish a Supplier ID with conflicting normalized names', () => {
    const result = preview({
      supplierIds: ['SRO-404,First Supplier', 'SRO-404,Different Supplier'],
      purchaseOrders: ['01/07/2026 10:00:00,PO-1,SRO-404,First Supplier,Ecofission LLC,Approved,Completed,Completed'],
      orderDetails: [
        'PO-1,01/07/2026 10:00:00,Ecofission LLC,SRO-404,First Supplier,B000000002,SKU-2A,10,4,Cleared,,,Yes',
      ],
    });

    expect(result.historicalEvidence).toMatchObject({ masterResolvedFamilies: 0, masterMissingFamilies: 1 });
    expect(result.supplierIdentityEvidence).toMatchObject({ usableRefCount: 0, conflictingRefCount: 1 });
    expect(result.unresolvedReasonDistribution).toMatchObject({ supplier_ids_name_conflict: 1 });
  });

  it('is deterministic and does not merge different exact SR IDs with similar supplier names', () => {
    const first = preview({
      purchaseOrders: [
        '01/07/2026 10:00:00,PO-1,SRO-12939,Same Supplier,Ecofission LLC,Approved,Completed,Completed',
        '02/07/2026 10:00:00,PO-2,SRO-12572,Same Supplier,Ecofission LLC,Approved,Completed,Completed',
      ],
      orderDetails: [
        'PO-1,01/07/2026 10:00:00,Ecofission LLC,SRO-12939,Same Supplier,B000000001,SKU-1,10,4,Cleared,,,Yes',
        'PO-2,02/07/2026 10:00:00,Ecofission LLC,SRO-12572,Same Supplier,B000000001,SKU-1,10,4,Cleared,,,Yes',
      ],
    });
    const second = preview({
      purchaseOrders: [
        '01/07/2026 10:00:00,PO-1,SRO-12939,Same Supplier,Ecofission LLC,Approved,Completed,Completed',
        '02/07/2026 10:00:00,PO-2,SRO-12572,Same Supplier,Ecofission LLC,Approved,Completed,Completed',
      ],
      orderDetails: [
        'PO-1,01/07/2026 10:00:00,Ecofission LLC,SRO-12939,Same Supplier,B000000001,SKU-1,10,4,Cleared,,,Yes',
        'PO-2,02/07/2026 10:00:00,Ecofission LLC,SRO-12572,Same Supplier,B000000001,SKU-1,10,4,Cleared,,,Yes',
      ],
    });

    expect(first.candidateSupplierRefCount).toBe(2);
    expect(first.historicalEvidence.multiSupplierFamilies).toBe(1);
    expect(first.decisionDigest).toBe(second.decisionDigest);
  });
});
