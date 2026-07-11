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
  evaluateSemanticLinkSnapshot,
  type SemanticLinkSnapshot,
} from '../../features/semantic-model/server/semantic-link-verifier';

function baseline(): SemanticLinkSnapshot {
  return {
    bronze: [],
    companies: [{ id: 'company-1', companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' }],
    suppliers: [{ id: 'supplier-1' }],
    products: [{ id: 'product-1', asin: 'B000SEMANTIC', sku: 'SKU-1' }],
    companyProducts: [{ id: 'company-product-1', companyId: 'company-1', productId: 'product-1' }],
    supplierProducts: [{ id: 'supplier-product-1', supplierId: 'supplier-1', productId: 'product-1' }],
    companyProductSuppliers: [
      {
        id: 'relationship-1',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        role: 'candidate',
      },
    ],
    orders: [
      {
        id: 'order-1',
        companyId: 'company-1',
        supplierId: 'supplier-1',
        orderRef: 'EF1001A',
        canonicalStatus: 'paid',
        lifecycleStatus: 'paid',
        statusSource: 'clickup_csv',
      },
    ],
    orderLines: [
      {
        id: 'line-1',
        orderId: 'order-1',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
      },
    ],
    taskLinks: [
      {
        id: 'task-link-1',
        sourceTaskRef: 'task-1',
        supplierOrderId: 'order-1',
        entityId: 'order-1',
        relation: 'status_authority',
      },
    ],
    importRuns: [
      {
        id: 'order-run',
        sourceIdentifier: 'order-management-bundle',
        adapterName: 'google-sheets-migration-csv',
        startedAt: '2026-07-10T00:00:00.000Z',
        status: 'success',
      },
      {
        id: 'clickup-run',
        sourceIdentifier: 'clickup-order-status-bootstrap',
        adapterName: 'clickup-order-status-csv',
        startedAt: '2026-07-10T01:00:00.000Z',
        status: 'success',
        summary: {
          clickup: {
            unmatchedRefCount: 0,
            unmappedStatusCount: 0,
            conflictingMainTaskCount: 0,
            companyConflictCount: 0,
            ambiguousOrderCount: 0,
            blockingIssueCount: 0,
            missingMainTaskCount: 0,
          },
        },
      },
    ],
    goldOrders: [
      {
        id: 'gold-order-1',
        orderId: 'order-1',
        canonicalStatus: 'paid',
        lifecycleStatus: 'paid',
        statusSource: 'clickup_csv',
      },
    ],
    goldInventory: [
      {
        id: 'gold-inventory-1',
        calculationDate: '2026-07-10',
        company: 'Ecofission LLC',
        companyProductId: 'company-product-1',
        supplierId: 'supplier-1',
        supplierOrderRef: 'EF1001A',
        supplierOrderStatus: 'paid',
        supplierOrderState: 'purchased_pipeline',
      },
    ],
  };
}

function issueCodes(snapshot: SemanticLinkSnapshot) {
  return evaluateSemanticLinkSnapshot(snapshot).issues.map((issue) => issue.code);
}

describe('semantic link verification', () => {
  it('passes a complete status-current relationship graph', () => {
    expect(evaluateSemanticLinkSnapshot(baseline())).toMatchObject({ ok: true, errorCount: 0, warningCount: 0 });
  });

  const cases: Array<[string, (snapshot: SemanticLinkSnapshot) => void, string]> = [
    [
      'canonical company aliases',
      (snapshot) =>
        snapshot.companies.push({ id: 'company-alias', companyKey: 'ECOFISSION_ALIAS', name: 'ECOFISSION LLC' }),
      'canonical_company_alias_duplicate',
    ],
    [
      'prefixed order/company disagreement',
      (snapshot) => (snapshot.orders[0].orderRef = 'SS1001A'),
      'order_prefix_company_mismatch',
    ],
    [
      'duplicate company/order reference',
      (snapshot) => snapshot.orders.push({ ...snapshot.orders[0], id: 'order-duplicate' }),
      'duplicate_company_order_ref',
    ],
    [
      'missing order supplier',
      (snapshot) => (snapshot.orders[0].supplierId = 'missing-supplier'),
      'order_supplier_missing',
    ],
    [
      'order supplier belongs to another company',
      (snapshot) => (snapshot.suppliers[0].companyId = 'another-company'),
      'order_supplier_company_mismatch',
    ],
    [
      'missing line product links',
      (snapshot) => (snapshot.orderLines[0].companyProductId = 'missing-company-product'),
      'order_line_product_missing',
    ],
    [
      'line/order supplier mismatch',
      (snapshot) => {
        snapshot.suppliers.push({ id: 'supplier-2' });
        snapshot.supplierProducts.push({ id: 'supplier-product-2', supplierId: 'supplier-2', productId: 'product-1' });
        snapshot.orderLines[0].supplierProductId = 'supplier-product-2';
      },
      'order_line_supplier_mismatch',
    ],
    [
      'line/order company mismatch',
      (snapshot) => {
        snapshot.companies.push({ id: 'company-2', companyKey: 'MUXTEX_INC', name: 'Muxtex INC' });
        snapshot.companyProducts[0].companyId = 'company-2';
      },
      'order_line_company_mismatch',
    ],
    [
      'company/supplier product mismatch',
      (snapshot) => {
        snapshot.products.push({ id: 'product-2' });
        snapshot.supplierProducts[0].productId = 'product-2';
      },
      'order_line_product_mismatch',
    ],
    [
      'missing line supplier relationship',
      (snapshot) => (snapshot.companyProductSuppliers = []),
      'order_line_supplier_link_missing',
    ],
    [
      'multiple latest-used suppliers',
      (snapshot) => {
        snapshot.companyProductSuppliers[0].role = 'latest_used';
        snapshot.companyProductSuppliers.push({
          id: 'relationship-2',
          companyProductId: 'company-product-1',
          supplierProductId: 'supplier-product-1',
          role: 'latest_used',
        });
      },
      'multiple_latest_used_supplier_links',
    ],
    [
      'ClickUp task targets multiple orders',
      (snapshot) => {
        snapshot.orders.push({ ...snapshot.orders[0], id: 'order-2', orderRef: 'EF1002A' });
        snapshot.taskLinks.push({
          ...snapshot.taskLinks[0],
          id: 'task-link-2',
          supplierOrderId: 'order-2',
          entityId: 'order-2',
        });
      },
      'clickup_task_multi_order_target',
    ],
    [
      'ClickUp run is missing',
      (snapshot) => (snapshot.importRuns = snapshot.importRuns.filter((run) => run.id !== 'clickup-run')),
      'clickup_import_run_missing',
    ],
    [
      'ClickUp runs before Order Management',
      (snapshot) => (snapshot.importRuns[1].startedAt = '2026-07-09T23:00:00.000Z'),
      'clickup_import_not_after_orders',
    ],
    [
      'ClickUp unmapped status remains',
      (snapshot) => ((snapshot.importRuns[1].summary as any).clickup.unmappedStatusCount = 1),
      'clickup_unmapped_statuses',
    ],
    [
      'ClickUp-matched silver status source is stale',
      (snapshot) => (snapshot.orders[0].statusSource = 'google_sheets'),
      'clickup_matched_order_status_source_mismatch',
    ],
    [
      'gold order status is stale',
      (snapshot) => (snapshot.goldOrders[0].canonicalStatus = 'draft'),
      'gold_order_status_stale',
    ],
    [
      'gold inventory status is stale',
      (snapshot) => (snapshot.goldInventory[0].supplierOrderStatus = 'draft'),
      'gold_inventory_order_status_stale',
    ],
    [
      'gold inventory state is stale',
      (snapshot) => (snapshot.goldInventory[0].supplierOrderState = 'no_open_order'),
      'gold_inventory_pipeline_state_mismatch',
    ],
    [
      'current gold supplier product is unresolved',
      (snapshot) => (snapshot.supplierProducts = []),
      'gold_inventory_supplier_product_unresolved',
    ],
  ];

  it.each(cases)('fails seeded corruption: %s', (_name, mutate, expectedCode) => {
    const snapshot = structuredClone(baseline());
    mutate(snapshot);
    expect(issueCodes(snapshot)).toContain(expectedCode);
    expect(evaluateSemanticLinkSnapshot(snapshot).ok).toBe(false);
  });

  it('keeps ClickUp refs without accepted Purchase Orders headers as warnings', () => {
    const snapshot = baseline();
    (snapshot.importRuns[1].summary as any).clickup.unmatchedRefCount = 1;
    const result = evaluateSemanticLinkSnapshot(snapshot);
    expect(result).toMatchObject({ ok: true, errorCount: 0, warningCount: 1 });
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'clickup_unmatched_refs' })]),
    );
  });

  it('accepts canonical inventory status aliases', () => {
    const snapshot = baseline();
    snapshot.orders[0].canonicalStatus = 'SHIPPED TO FBA';
    snapshot.orders[0].lifecycleStatus = 'SHIPPED TO FBA';
    snapshot.goldOrders[0].canonicalStatus = 'SHIPPED TO FBA';
    snapshot.goldOrders[0].lifecycleStatus = 'SHIPPED TO FBA';
    snapshot.goldInventory[0].supplierOrderStatus = 'shipped_inbound';
    expect(evaluateSemanticLinkSnapshot(snapshot)).toMatchObject({ ok: true, errorCount: 0 });
  });

  it('accepts supplier evidence inherited from a duplicate-SKU company product', () => {
    const snapshot = baseline();
    snapshot.products.push({ id: 'product-2', asin: 'B000SEMANTIC', sku: 'SKU-2' });
    snapshot.companyProducts.push({ id: 'company-product-2', companyId: 'company-1', productId: 'product-2' });
    snapshot.goldInventory[0].companyProductId = 'company-product-2';
    snapshot.goldInventory[0].evidence = {
      duplicateSkuSupplierSource: { sourceCompanyProductId: 'company-product-1' },
    };
    expect(evaluateSemanticLinkSnapshot(snapshot)).toMatchObject({ ok: true, errorCount: 0 });
  });

  it('accepts persisted family supplier evidence projected from another listing member', () => {
    const snapshot = baseline();
    snapshot.products.push({ id: 'product-2', asin: 'B000SEMANTIC', sku: 'SKU-2' });
    snapshot.companyProducts.push({ id: 'company-product-2', companyId: 'company-1', productId: 'product-2' });
    snapshot.goldInventory[0] = {
      ...snapshot.goldInventory[0],
      companyProductId: 'company-product-2',
      companyProductFamilyId: 'family-1',
      familyPreferredSupplierId: 'supplier-1',
      familyPreferredSupplierProductId: 'supplier-product-1',
      supplierSource: 'family_preferred_supplier',
    };
    snapshot.goldInventory.push({
      id: 'gold-inventory-family-member',
      calculationDate: '2026-07-10',
      company: 'Ecofission LLC',
      companyProductId: 'company-product-1',
      companyProductFamilyId: 'family-1',
    });

    expect(evaluateSemanticLinkSnapshot(snapshot)).toMatchObject({ ok: true, errorCount: 0 });
  });

  it('does not treat post-ClickUp product reconciliation as a new order source import', () => {
    const snapshot = baseline();
    snapshot.importRuns.push({
      id: 'order-product-reconciliation',
      sourceIdentifier: 'order-management-product-reconciliation-v3',
      adapterName: 'google-sheets-migration-csv',
      status: 'success',
      startedAt: '2026-07-01T00:02:00.000Z',
    });
    expect(evaluateSemanticLinkSnapshot(snapshot)).toMatchObject({ ok: true, errorCount: 0 });
  });

  it('keeps recency-resolved ClickUp status conflicts as warnings', () => {
    const snapshot = baseline();
    (snapshot.importRuns[1].summary as any).clickup.conflictingMainTaskCount = 1;
    const result = evaluateSemanticLinkSnapshot(snapshot);
    expect(result).toMatchObject({ ok: true, errorCount: 0, warningCount: 1 });
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'clickup_status_conflicts_resolved_by_recency' })]),
    );
  });

  it('keeps broad historical unresolved supplier products as warnings', () => {
    const snapshot = baseline();
    snapshot.bronze.push({ id: 'bronze-warning', issueCode: 'supplier_product_unresolved' });
    expect(evaluateSemanticLinkSnapshot(snapshot)).toMatchObject({ ok: true, errorCount: 0, warningCount: 1 });
  });

  it('keeps explicitly unmapped order-line products as warnings', () => {
    const snapshot = baseline();
    snapshot.orderLines[0] = {
      ...snapshot.orderLines[0],
      companyProductId: undefined,
      supplierProductId: undefined,
      productAnalysisStatus: 'mapping_missing',
    };
    const result = evaluateSemanticLinkSnapshot(snapshot);
    expect(result).toMatchObject({ ok: true, errorCount: 0, warningCount: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'order_line_product_missing' }));
  });
});
