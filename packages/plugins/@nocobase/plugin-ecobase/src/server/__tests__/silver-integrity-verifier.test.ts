/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { EcobaseSilverIntegrityVerifier } from '../../features/inventory-planning/server/silver-integrity-verifier';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Row = Record<string, unknown>;

class MemoryRepository implements EcobaseRepository {
  constructor(private rows: Row[]) {}

  async find() {
    return this.rows;
  }

  async findOne({ filterByTk, filter = {} }: { filterByTk?: string | number; filter?: Row } = {}) {
    return (
      this.rows.find(
        (row) =>
          (filterByTk === undefined || row.id === filterByTk) &&
          Object.entries(filter).every(([key, value]) => row[key] === value),
      ) ?? null
    );
  }

  async create({ values }: { values: Row }) {
    this.rows.push(values);
    return values;
  }

  async update() {
    throw new Error('Silver integrity verifier tests are read-only.');
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private repositories = new Map<string, MemoryRepository>();

  constructor(rows: Record<string, Row[]>) {
    for (const collection of [...Object.values(ECOBASE_COLLECTIONS), 'users']) {
      this.repositories.set(collection, new MemoryRepository(rows[collection] ?? []));
    }
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Missing test repository ${name}.`);
    return repository;
  }
}

function fixture(): Record<string, Row[]> {
  return {
    [ECOBASE_COLLECTIONS.silverCompanies]: [
      { id: 'company-eco', companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' },
      { id: 'company-muxtex', companyKey: 'MUXTEX_INC', name: 'Muxtex INC' },
      { id: 'company-retail', companyKey: 'RETAIL_HEAVEN_INC', name: 'Retail Heaven Inc' },
      { id: 'company-stop', companyKey: 'STOP_SHOP_LLC', name: 'Stop Shop LLC' },
    ],
    [ECOBASE_COLLECTIONS.silverAmazonAccounts]: [
      { id: 'account-stop-us', companyId: 'company-stop', marketplace: 'amazon.com' },
    ],
    [ECOBASE_COLLECTIONS.silverProducts]: [{ id: 'product-etc', asin: 'B0177E9JPS', sku: 'ETC-120A' }],
    [ECOBASE_COLLECTIONS.silverCompanyProducts]: [
      {
        id: 'company-product-etc',
        companyId: 'company-stop',
        amazonAccountId: 'account-stop-us',
        productId: 'product-etc',
        companyProductFamilyId: 'family-etc',
        lifecycleStatus: 'active',
      },
    ],
    [ECOBASE_COLLECTIONS.silverCompanyProductFamilies]: [
      {
        id: 'family-etc',
        companyId: 'company-stop',
        amazonAccountId: 'account-stop-us',
        marketplace: 'amazon.com',
        canonicalAsin: 'B0177E9JPS',
        replenishmentTargetCompanyProductId: 'company-product-etc',
        targetReviewRequired: false,
      },
    ],
    [ECOBASE_COLLECTIONS.silverInventorySnapshots]: [
      { id: 'snapshot-etc', companyProductId: 'company-product-etc', snapshotDate: '2026-07-13', sellableStock: 0 },
    ],
    [ECOBASE_COLLECTIONS.silverSuppliers]: [
      { id: 'supplier-delko', displayName: 'Delko Tools' },
      { id: 'supplier-franklin', displayName: 'Franklin Machine Products' },
    ],
    [ECOBASE_COLLECTIONS.silverSupplierProducts]: [
      {
        id: 'supplier-product-etc',
        supplierId: 'supplier-delko',
        productId: 'product-etc',
        supplierSku: 'ETC120A',
      },
    ],
    [ECOBASE_COLLECTIONS.silverCompanyProductSuppliers]: [
      {
        id: 'company-product-supplier-etc',
        companyProductId: 'company-product-etc',
        supplierProductId: 'supplier-product-etc',
        role: 'candidate',
      },
    ],
    [ECOBASE_COLLECTIONS.silverSupplierExternalRefs]: [
      {
        id: 'supplier-ref-delko',
        supplierId: 'supplier-delko',
        normalizedExternalSupplierCode: 'SRO-12939',
      },
      {
        id: 'supplier-ref-franklin',
        supplierId: 'supplier-franklin',
        normalizedExternalSupplierCode: 'SRO-12572',
      },
    ],
    [ECOBASE_COLLECTIONS.silverOrders]: [
      {
        id: 'order-etc',
        companyId: 'company-stop',
        supplierId: 'supplier-delko',
        orderRef: 'SS42826A',
        orderDate: '2026-07-01',
        canonicalStatus: 'paid',
        authorityStatus: 'clickup_authoritative',
        authorityTaskRef: 'clickup-task-etc',
      },
    ],
    [ECOBASE_COLLECTIONS.silverOrderLines]: [
      {
        id: 'line-etc',
        orderId: 'order-etc',
        companyProductId: 'company-product-etc',
        supplierProductId: 'supplier-product-etc',
        sourceAsin: 'B0177E9JPS',
        sourceSupplierSku: 'ETC120A',
        productMappingStatus: 'resolved',
        productMappingEvidenceJson: { method: 'reviewed_alias' },
        orderedQty: 1,
      },
    ],
    [ECOBASE_COLLECTIONS.silverActivityComments]: [
      {
        id: 'comment-etc',
        entityType: 'supplier_order',
        entityId: 'order-etc',
        actorUserId: 'user-clickup',
      },
    ],
    [ECOBASE_COLLECTIONS.silverListingDailyFacts]: [],
    users: [{ id: 'user-clickup', email: 'approved@example.com' }],
  };
}

function technicalCodes(result: Awaited<ReturnType<EcobaseSilverIntegrityVerifier['verify']>>) {
  return result.issues
    .filter((candidate) => candidate.classification === 'technical_blocker')
    .map((candidate) => candidate.code);
}

describe('EcobaseSilverIntegrityVerifier', () => {
  it('passes a current-only four-company fixture with zero technical blockers', async () => {
    const result = await new EcobaseSilverIntegrityVerifier(new MemoryDatabase(fixture())).verify();

    expect(result).toMatchObject({
      ok: true,
      counts: { technical_blocker: 0, business_ambiguity: 0, expected_current_only_gap: 1 },
      examined: { companies: 4, companyProducts: 1, families: 1, orderLines: 1 },
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        classification: 'expected_current_only_gap',
        code: 'sellerboard_history_not_loaded',
      }),
    ]);
  });

  it('keeps an approved named line ambiguity nonblocking', async () => {
    const rows = fixture();
    rows[ECOBASE_COLLECTIONS.silverOrderLines][0] = {
      ...rows[ECOBASE_COLLECTIONS.silverOrderLines][0],
      companyProductId: null,
      supplierProductId: null,
      productMappingStatus: 'unresolved',
      productMappingEvidenceJson: { reason: 'boundary_ambiguous' },
    };

    const result = await new EcobaseSilverIntegrityVerifier(new MemoryDatabase(rows)).verify();

    expect(result.ok).toBe(true);
    expect(result.counts.business_ambiguity).toBe(1);
    expect(technicalCodes(result)).toEqual([]);
  });

  it('reports precise blockers for broken boundaries, relationships, duplicate identity, and ClickUp links', async () => {
    const rows = fixture();
    rows[ECOBASE_COLLECTIONS.silverAmazonAccounts][0].companyId = 'company-eco';
    rows[ECOBASE_COLLECTIONS.silverCompanyProductFamilies][0].replenishmentTargetCompanyProductId = 'missing-target';
    rows[ECOBASE_COLLECTIONS.silverSupplierProducts][0].supplierId = 'supplier-franklin';
    rows[ECOBASE_COLLECTIONS.silverCompanyProductSuppliers] = [];
    rows[ECOBASE_COLLECTIONS.silverProducts].push({ id: 'product-etc-duplicate', asin: 'B0177E9JPS', sku: 'ETC120A' });
    rows[ECOBASE_COLLECTIONS.silverSupplierExternalRefs].pop();
    rows[ECOBASE_COLLECTIONS.silverSupplierExternalRefs].push({
      id: 'supplier-ref-rejected',
      supplierId: 'supplier-delko',
      normalizedExternalSupplierCode: 'SRO-1293',
    });
    rows[ECOBASE_COLLECTIONS.silverActivityComments][0].actorUserId = 'missing-user';

    const result = await new EcobaseSilverIntegrityVerifier(new MemoryDatabase(rows)).verify();

    expect(result.ok).toBe(false);
    expect(technicalCodes(result)).toEqual(
      expect.arrayContaining([
        'company_product_account_company_mismatch',
        'family_membership_boundary_mismatch',
        'replenishment_target_outside_family',
        'resolved_line_company_product_supplier_mismatch',
        'resolved_line_supplier_link_missing',
        'supplier_sku_amazon_product_duplicate',
        'etc_identity_invariant_failed',
        'accepted_supplier_reference_invalid',
        'rejected_supplier_reference_present',
        'activity_comment_user_missing',
      ]),
    );
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'resolved_line_company_product_supplier_mismatch',
          message: 'Resolved order line crosses company, product, or order-header supplier authority.',
        }),
      ]),
    );
  });

  it('does not suppress an unresolved line without an approved named reason', async () => {
    const rows = fixture();
    rows[ECOBASE_COLLECTIONS.silverOrderLines][0] = {
      ...rows[ECOBASE_COLLECTIONS.silverOrderLines][0],
      companyProductId: null,
      supplierProductId: null,
      productMappingStatus: 'unresolved',
      productMappingEvidenceJson: { reason: 'order_context_missing' },
    };

    const result = await new EcobaseSilverIntegrityVerifier(new MemoryDatabase(rows)).verify();

    expect(result.ok).toBe(false);
    expect(technicalCodes(result)).toContain('order_line_resolution_incomplete');
  });
});
