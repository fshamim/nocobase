/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { preflightSupplierOrderImport } from '../../features/source-import/server/supplier-order-import/supplier-order-import-preflight';
import type { SupplierOrderImportPlan } from '../../features/source-import/server/supplier-order-import/supplier-order-import-types';

const evidence = { file: 'OrderDetails.csv', sheet: 'OrderDetails', row: 2, hash: 'a'.repeat(64) };

function sourcePlan(): SupplierOrderImportPlan {
  return {
    planVersion: 'supplier-order-import-plan-v1',
    asOfDate: '2026-07-16',
    digest: 'b'.repeat(64),
    sourceFiles: [],
    suppliers: [
      {
        sourceSystem: 'supplier_ids',
        externalSupplierCode: 'SRO-1',
        normalizedExternalSupplierCode: 'SRO-1',
        displayName: 'Supplier',
        normalizedName: 'supplier',
        aliases: [],
        additionalEmails: [],
        additionalPhones: [],
        sourceEvidence: { rows: [evidence] },
      },
    ],
    supplierAccounts: [],
    supplierProducts: [],
    purchaseOrderSourceSupplierCodes: ['SRO-1'],
    orders: [
      {
        externalOrderId: 'EF1A',
        companyKey: 'ECOFISSION_LLC',
        externalSupplierCode: 'SRO-1',
        recordType: 'purchase_order',
        purchaseEvidenceStatus: 'confirmed',
        sourceEvidence: { purchaseOrders: [evidence] },
      },
    ],
    orderLines: [
      {
        externalOrderId: 'EF1A',
        companyKey: 'ECOFISSION_LLC',
        lineOrdinal: 1,
        sourceLineKey: 'line-1',
        externalSupplierCode: 'SRO-1',
        asin: 'B012345678',
        sourceMarketplace: 'US',
        supplierSku: 'LISTING-1',
        orderQty: 2,
        sourceEvidence: { ...evidence, rows: [evidence] },
      },
      {
        externalOrderId: 'EF1A',
        companyKey: 'ECOFISSION_LLC',
        lineOrdinal: 2,
        sourceLineKey: 'line-2',
        externalSupplierCode: 'SRO-1',
        asin: 'B012345678',
        sourceMarketplace: 'US',
        supplierSku: 'SUPPLIER-ONLY',
        orderQty: 3,
        sourceEvidence: { ...evidence, row: 3, rows: [{ ...evidence, row: 3 }] },
      },
    ],
    supplierCodeOverrides: [],
    supplierNameOverrides: [],
    duplicateSupplierNames: [],
    duplicatePurchaseOrders: [],
    duplicateOrderLines: [],
    blockedSupplierCodes: [],
    blockedOrderIds: [],
    headerlessOrderOutcomes: [],
    reconciliation: {
      matchedOrderCount: 1,
      detailsOnlyOrderCount: 0,
      purchaseOnlyOrderCount: 0,
      supplierMismatchCount: 0,
      companyMismatchCount: 0,
      retainedOrderCount: 1,
      retainedOrderLineCount: 2,
      bySource: [],
    },
    hasBlockingIssues: false,
    issues: [],
  };
}

const catalog = {
  database: 'fixture',
  companies: [{ id: 'company-1', companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' }],
  families: [
    {
      id: 'family-1',
      companyId: 'company-1',
      marketplace: 'amazon.com',
      canonicalAsin: 'B012345678',
    },
  ],
  companyProducts: [
    {
      id: 'company-product-1',
      companyId: 'company-1',
      companyProductFamilyId: 'family-1',
      productId: 'product-1',
    },
  ],
  products: [{ id: 'product-1', asin: 'B012345678', sku: 'LISTING-1' }],
};

describe('supplier/order import preflight', () => {
  it('binds the explicit execution mode into the preflight digest', () => {
    const rebuild = preflightSupplierOrderImport(sourcePlan(), catalog, 'canonical-rebuild');
    const refresh = preflightSupplierOrderImport(sourcePlan(), catalog, 'refresh');

    expect(rebuild.importMode).toBe('canonical-rebuild');
    expect(refresh.importMode).toBe('refresh');
    expect(rebuild.preflightDigest).not.toBe(refresh.preflightDigest);
  });

  it('links exact listing members and keeps unmatched source SKUs family-only', () => {
    const result = preflightSupplierOrderImport(sourcePlan(), catalog, 'canonical-rebuild');

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.mappingExceptions).toEqual([]);
    expect(result.counts).toMatchObject({
      structuralBlockers: 0,
      purchaseEvidence: { confirmed: 1, cancelled: 0, rejected: 0, unknown: 0 },
      poSourceSupplierIds: 1,
      poCanonicalSupplierIds: 1,
      missingPoSupplierIds: 0,
      lines: 2,
      exactMemberLines: 1,
      familyOnlyLines: 1,
      unresolvedLines: 0,
      mappingExceptions: 0,
      blockedLines: 0,
    });
    expect(result.plan.orderLines[0]).toMatchObject({
      companyProductFamilyId: 'family-1',
      companyProductId: 'company-product-1',
      supplierProductId: null,
      mappingScope: 'exact_member',
      sourceSkuType: 'listing_sku',
    });
    expect(result.plan.orderLines[1]).toMatchObject({
      companyProductFamilyId: 'family-1',
      companyProductId: null,
      supplierProductId: null,
      mappingScope: 'family_only',
      sourceSkuType: 'supplier_sku',
    });
  });

  it('uses the approved listing SKU alias when resolving an exact member', () => {
    const plan = sourcePlan();
    plan.orderLines = [
      {
        ...plan.orderLines[0],
        asin: 'B0177E9JPS',
        supplierSku: 'ETC120A',
      },
    ];
    const result = preflightSupplierOrderImport(
      plan,
      {
        ...catalog,
        families: [{ ...catalog.families[0], canonicalAsin: 'B0177E9JPS' }],
        products: [{ id: 'product-1', asin: 'B0177E9JPS', sku: 'ETC-120A' }],
      },
      'canonical-rebuild',
    );

    expect(result.plan.orderLines[0]).toMatchObject({
      companyProductId: 'company-product-1',
      mappingScope: 'exact_member',
      sourceSkuType: 'listing_sku',
    });
  });

  it('classifies unresolved marketplace evidence without guessing a family', () => {
    const result = preflightSupplierOrderImport(
      sourcePlan(),
      {
        ...catalog,
        families: [
          { ...catalog.families[0], id: 'family-uk', marketplace: 'amazon.co.uk' },
          { ...catalog.families[0], id: 'family-ca', marketplace: 'amazon.ca' },
        ],
      },
      'canonical-rebuild',
    );

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.mappingExceptions).toEqual([
      expect.objectContaining({ sourceLineKey: 'line-1', reason: 'family_marketplace_unresolved' }),
      expect.objectContaining({ sourceLineKey: 'line-2', reason: 'family_marketplace_unresolved' }),
    ]);
    expect(result.plan.orderLines).toEqual([
      expect.objectContaining({ sourceLineKey: 'line-1', mappingScope: 'unresolved', companyProductFamilyId: null }),
      expect.objectContaining({ sourceLineKey: 'line-2', mappingScope: 'unresolved', companyProductFamilyId: null }),
    ]);
  });

  it('carries source-plan structural failures into the preflight blocker ledger', () => {
    const plan = sourcePlan();
    plan.hasBlockingIssues = true;
    plan.issues = [
      {
        severity: 'blocked',
        sourceFile: 'purchase_orders',
        sourceRow: 2,
        reason: 'purchase_order_supplier_id_invalid_or_missing',
        disposition: 'blocked',
      },
    ];

    const result = preflightSupplierOrderImport(plan, catalog, 'canonical-rebuild');

    expect(result.ready).toBe(false);
    expect(result.counts.structuralBlockers).toBe(1);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        reason: 'source_plan_blocked',
        sourceIssueReason: 'purchase_order_supplier_id_invalid_or_missing',
      }),
    );
  });

  it('classifies a missing family as unresolved without creating a product', () => {
    const result = preflightSupplierOrderImport(sourcePlan(), { ...catalog, families: [] }, 'canonical-rebuild');

    expect(result.ready).toBe(true);
    expect(result.counts).toMatchObject({ unresolvedLines: 2, mappingExceptions: 2, blockedLines: 0 });
    expect(result.blockers).toEqual([]);
    expect(result.mappingExceptions).toEqual([
      expect.objectContaining({ sourceLineKey: 'line-1', reason: 'family_not_found' }),
      expect.objectContaining({ sourceLineKey: 'line-2', reason: 'family_not_found' }),
    ]);
    expect(result.plan.orderLines).toEqual([
      expect.objectContaining({ sourceLineKey: 'line-1', mappingScope: 'unresolved', companyProductFamilyId: null }),
      expect.objectContaining({ sourceLineKey: 'line-2', mappingScope: 'unresolved', companyProductFamilyId: null }),
    ]);
  });
});
