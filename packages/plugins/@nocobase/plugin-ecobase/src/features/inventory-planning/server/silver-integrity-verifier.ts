/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { FOUR_COMPANY_MIGRATION_PROFILE } from '../../source-import/server/four-company-migration-profile';
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';

type PlainRecord = Record<string, unknown>;
export type SilverIntegrityClassification = 'technical_blocker' | 'business_ambiguity' | 'expected_current_only_gap';

export type SilverIntegrityIssue = {
  classification: SilverIntegrityClassification;
  code: string;
  entityType: string;
  entityId?: string;
  message: string;
  evidence?: PlainRecord;
};

const APPROVED_BUSINESS_AMBIGUITIES = new Set([
  'boundary_ambiguous',
  'exact_match_ambiguous',
  'target_missing',
  'target_review_required',
  'product_not_found',
]);

function text(value: unknown) {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim()
    ? String(value).trim()
    : undefined;
}

function normalized(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isApprovedOrderLineBusinessAmbiguity(line: PlainRecord) {
  const reason = text(toPlainRecord(line.productMappingEvidenceJson).reason);
  return (
    text(line.productMappingStatus) === 'unresolved' && Boolean(reason && APPROVED_BUSINESS_AMBIGUITIES.has(reason))
  );
}

function byId(rows: PlainRecord[]) {
  return new Map(rows.map((row) => [text(row.id), row]));
}

function issue(
  classification: SilverIntegrityClassification,
  code: string,
  entityType: string,
  entityId: string | undefined,
  message: string,
  evidence?: PlainRecord,
): SilverIntegrityIssue {
  return { classification, code, entityType, entityId, message, evidence };
}

export class EcobaseSilverIntegrityVerifier {
  constructor(private db: EcobaseDatabase) {}

  async verify() {
    const [
      companies,
      accounts,
      products,
      companyProducts,
      families,
      inventorySnapshots,
      suppliers,
      supplierProducts,
      companyProductSuppliers,
      supplierExternalRefs,
      orders,
      lines,
      comments,
      listingFacts,
      users,
    ] = await Promise.all([
      this.all(ECOBASE_COLLECTIONS.silverCompanies),
      this.all(ECOBASE_COLLECTIONS.silverAmazonAccounts),
      this.all(ECOBASE_COLLECTIONS.silverProducts),
      this.all(ECOBASE_COLLECTIONS.silverCompanyProducts),
      this.all(ECOBASE_COLLECTIONS.silverCompanyProductFamilies),
      this.all(ECOBASE_COLLECTIONS.silverInventorySnapshots),
      this.all(ECOBASE_COLLECTIONS.silverSuppliers),
      this.all(ECOBASE_COLLECTIONS.silverSupplierProducts),
      this.all(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers),
      this.all(ECOBASE_COLLECTIONS.silverSupplierExternalRefs),
      this.all(ECOBASE_COLLECTIONS.silverOrders),
      this.all(ECOBASE_COLLECTIONS.silverOrderLines),
      this.all(ECOBASE_COLLECTIONS.silverActivityComments),
      this.all(ECOBASE_COLLECTIONS.silverListingDailyFacts),
      this.all('users'),
    ]);
    const issues: SilverIntegrityIssue[] = [];
    const companyById = byId(companies);
    const accountById = byId(accounts);
    const productById = byId(products);
    const companyProductById = byId(companyProducts);
    const familyById = byId(families);
    const supplierById = byId(suppliers);
    const supplierProductById = byId(supplierProducts);
    const orderById = byId(orders);
    const userById = byId(users);

    const expectedCompanyKeys = new Set<string>(
      FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.map((company) => company.companyKey),
    );
    const actualCompanyKeys = new Set(companies.map((company) => text(company.companyKey)).filter(Boolean));
    for (const companyKey of expectedCompanyKeys) {
      const matches = companies.filter((company) => text(company.companyKey) === companyKey);
      if (matches.length !== 1) {
        issues.push(
          issue(
            'technical_blocker',
            matches.length === 0 ? 'canonical_company_missing' : 'canonical_company_not_unique',
            'silverCompany',
            companyKey,
            `Canonical company ${companyKey} must exist exactly once.`,
            { matchCount: matches.length },
          ),
        );
      }
    }
    for (const company of companies) {
      const companyKey = text(company.companyKey);
      if (!companyKey || !expectedCompanyKeys.has(companyKey)) {
        issues.push(
          issue(
            'technical_blocker',
            'company_outside_four_company_boundary',
            'silverCompany',
            text(company.id),
            `Company ${text(company.name) ?? text(company.id)} is outside the approved four-company boundary.`,
          ),
        );
      }
    }

    const latestInventoryByCompanyProduct = new Set(
      inventorySnapshots.map((snapshot) => text(snapshot.companyProductId)).filter(Boolean),
    );
    for (const companyProduct of companyProducts) {
      const companyProductId = text(companyProduct.id);
      const companyId = text(companyProduct.companyId);
      const accountId = text(companyProduct.amazonAccountId);
      const product = productById.get(text(companyProduct.productId));
      const account = accountById.get(accountId);
      const current = ['active', 'live'].includes(
        normalized(companyProduct.lifecycleStatus ?? companyProduct.listingStatus),
      );
      if (!companyById.has(companyId)) {
        issues.push(
          issue(
            'technical_blocker',
            'company_product_company_missing',
            'silverCompanyProduct',
            companyProductId,
            'Company-product references a missing company.',
          ),
        );
      }
      if (!account || text(account.companyId) !== companyId) {
        issues.push(
          issue(
            'technical_blocker',
            'company_product_account_company_mismatch',
            'silverCompanyProduct',
            companyProductId,
            'Company-product Amazon account is missing or belongs to another company.',
            { companyId, amazonAccountId: accountId, accountCompanyId: text(account?.companyId) },
          ),
        );
      }
      if (!product) {
        issues.push(
          issue(
            'technical_blocker',
            'company_product_product_missing',
            'silverCompanyProduct',
            companyProductId,
            'Company-product references a missing Amazon product.',
          ),
        );
      }
      const familyId = text(companyProduct.companyProductFamilyId);
      const family = familyById.get(familyId);
      if (current && !family) {
        issues.push(
          issue(
            'technical_blocker',
            'eligible_company_product_family_missing',
            'silverCompanyProduct',
            companyProductId,
            'Eligible current company-product is not linked to a family.',
          ),
        );
      }
      if (
        family &&
        (text(family.companyId) !== companyId ||
          text(family.amazonAccountId) !== accountId ||
          text(account?.companyId) !== text(family.companyId) ||
          normalized(family.marketplace) !== normalized(account?.marketplace) ||
          text(family.canonicalAsin)?.toUpperCase() !== text(product?.asin)?.toUpperCase())
      ) {
        issues.push(
          issue(
            'technical_blocker',
            'family_membership_boundary_mismatch',
            'silverCompanyProduct',
            companyProductId,
            'Company-product family crosses company, account, marketplace, or ASIN boundary.',
            { familyId },
          ),
        );
      }
      if (current && !latestInventoryByCompanyProduct.has(companyProductId)) {
        issues.push(
          issue(
            'expected_current_only_gap',
            'current_inventory_snapshot_missing',
            'silverCompanyProduct',
            companyProductId,
            'Current listing has no inventory snapshot in the current-only source set.',
          ),
        );
      }
    }

    for (const family of families) {
      const familyId = text(family.id);
      const familyCompanyId = text(family.companyId);
      const familyAccount = accountById.get(text(family.amazonAccountId));
      if (
        !companyById.has(familyCompanyId) ||
        !familyAccount ||
        text(familyAccount.companyId) !== familyCompanyId ||
        normalized(familyAccount.marketplace) !== normalized(family.marketplace) ||
        !text(family.canonicalAsin)
      ) {
        issues.push(
          issue(
            'technical_blocker',
            'family_boundary_invalid',
            'silverCompanyProductFamily',
            familyId,
            'Family company, account, marketplace, or ASIN boundary is invalid.',
          ),
        );
      }
      const members = companyProducts.filter(
        (companyProduct) => text(companyProduct.companyProductFamilyId) === familyId,
      );
      const eligibleMembers = members.filter((member) =>
        ['active', 'live'].includes(normalized(member.lifecycleStatus ?? member.listingStatus)),
      );
      const targetId = text(family.replenishmentTargetCompanyProductId);
      if (targetId && !members.some((member) => text(member.id) === targetId)) {
        issues.push(
          issue(
            'technical_blocker',
            'replenishment_target_outside_family',
            'silverCompanyProductFamily',
            familyId,
            'Family replenishment target is not a member of the family.',
            { targetCompanyProductId: targetId },
          ),
        );
      } else if (targetId && !eligibleMembers.some((member) => text(member.id) === targetId)) {
        issues.push(
          issue(
            'technical_blocker',
            'replenishment_target_not_eligible',
            'silverCompanyProductFamily',
            familyId,
            'Family replenishment target is not an eligible current listing.',
            { targetCompanyProductId: targetId },
          ),
        );
      }
      if (eligibleMembers.length > 0 && !targetId && family.targetReviewRequired !== true) {
        issues.push(
          issue(
            'technical_blocker',
            'eligible_replenishment_target_classification_missing',
            'silverCompanyProductFamily',
            familyId,
            'Eligible family has neither a replenishment target nor an explicit target review.',
          ),
        );
      }
    }

    const linkKeys = new Set(
      companyProductSuppliers.map(
        (link) => `${text(link.companyProductId) ?? ''}:${text(link.supplierProductId) ?? ''}`,
      ),
    );
    for (const line of lines) {
      const lineId = text(line.id);
      const mappingStatus = text(line.productMappingStatus);
      const evidence = toPlainRecord(line.productMappingEvidenceJson);
      if (!['resolved', 'unresolved'].includes(mappingStatus ?? '')) {
        issues.push(
          issue(
            'technical_blocker',
            'line_resolution_classification_missing',
            'silverOrderLine',
            lineId,
            'Order line must be classified as resolved or unresolved.',
          ),
        );
        continue;
      }
      if (mappingStatus === 'unresolved') {
        const reason = text(evidence.reason);
        if (isApprovedOrderLineBusinessAmbiguity(line)) {
          issues.push(
            issue(
              'business_ambiguity',
              'order_line_business_ambiguity',
              'silverOrderLine',
              lineId,
              `Order line remains unresolved for approved business reason ${reason}.`,
              { reason },
            ),
          );
        } else {
          issues.push(
            issue(
              'technical_blocker',
              'order_line_resolution_incomplete',
              'silverOrderLine',
              lineId,
              'Unresolved order line lacks an approved named business ambiguity.',
              { reason },
            ),
          );
        }
        continue;
      }

      const order = orderById.get(text(line.orderId));
      const companyProduct = companyProductById.get(text(line.companyProductId));
      const supplierProduct = supplierProductById.get(text(line.supplierProductId));
      const supplierId = text(order?.supplierId);
      const companyProductId = text(companyProduct?.id);
      const supplierProductId = text(supplierProduct?.id);
      if (!order || !companyProduct || !supplierProduct) {
        issues.push(
          issue(
            'technical_blocker',
            'resolved_line_relationship_missing',
            'silverOrderLine',
            lineId,
            'Resolved order line is missing its order, company-product, or supplier-product relationship.',
          ),
        );
        continue;
      }
      if (
        text(order.companyId) !== text(companyProduct.companyId) ||
        text(supplierProduct.supplierId) !== supplierId ||
        text(supplierProduct.productId) !== text(companyProduct.productId) ||
        !supplierById.has(supplierId)
      ) {
        issues.push(
          issue(
            'technical_blocker',
            'resolved_line_company_product_supplier_mismatch',
            'silverOrderLine',
            lineId,
            'Resolved order line crosses company, product, or order-header supplier authority.',
          ),
        );
      }
      if (!linkKeys.has(`${companyProductId ?? ''}:${supplierProductId ?? ''}`)) {
        issues.push(
          issue(
            'technical_blocker',
            'resolved_line_supplier_link_missing',
            'silverOrderLine',
            lineId,
            'Resolved order line has no company-product supplier link.',
          ),
        );
      }
      const canonicalProduct = productById.get(text(companyProduct.productId));
      const sourceAsin = text(line.sourceAsin)?.toUpperCase();
      const sourceSupplierSku = text(line.sourceSupplierSku);
      if (sourceAsin && sourceAsin !== text(canonicalProduct?.asin)?.toUpperCase()) {
        issues.push(
          issue(
            'technical_blocker',
            'resolved_line_source_asin_mismatch',
            'silverOrderLine',
            lineId,
            'Resolved line source ASIN differs from its canonical Amazon product.',
          ),
        );
      }
      if (
        sourceAsin &&
        sourceSupplierSku &&
        sourceSupplierSku !== text(canonicalProduct?.sku) &&
        products.some((product) => {
          if (
            text(product.id) === text(canonicalProduct?.id) ||
            text(product.asin)?.toUpperCase() !== sourceAsin ||
            text(product.sku) !== sourceSupplierSku
          ) {
            return false;
          }
          const duplicateListings = companyProducts.filter(
            (candidate) => text(candidate.productId) === text(product.id),
          );
          return (
            duplicateListings.length === 0 ||
            duplicateListings.some((candidate) => text(candidate.companyId) === text(order.companyId))
          );
        })
      ) {
        issues.push(
          issue(
            'technical_blocker',
            'supplier_sku_amazon_product_duplicate',
            'silverOrderLine',
            lineId,
            'Supplier SKU was materialized as a duplicate Amazon product.',
          ),
        );
      }
    }

    this.verifyEtcIdentity(products, companyProducts, lines, productById, issues);
    this.verifySupplierDecisions(supplierExternalRefs, suppliers, issues);
    this.verifyClickupLinks(orders, comments, orderById, supplierById, userById, issues);

    if (listingFacts.length === 0) {
      issues.push(
        issue(
          'expected_current_only_gap',
          'sellerboard_history_not_loaded',
          'silverListingDailyFact',
          undefined,
          'Sellerboard history is intentionally absent from the current-only source state.',
        ),
      );
    }

    const counts = {
      technical_blocker: issues.filter((candidate) => candidate.classification === 'technical_blocker').length,
      business_ambiguity: issues.filter((candidate) => candidate.classification === 'business_ambiguity').length,
      expected_current_only_gap: issues.filter((candidate) => candidate.classification === 'expected_current_only_gap')
        .length,
    };
    return {
      ok: counts.technical_blocker === 0,
      counts,
      examined: {
        companies: companies.length,
        companyProducts: companyProducts.length,
        families: families.length,
        orderLines: lines.length,
      },
      issues,
    };
  }

  private verifyEtcIdentity(
    products: PlainRecord[],
    companyProducts: PlainRecord[],
    lines: PlainRecord[],
    productById: Map<string | undefined, PlainRecord>,
    issues: SilverIntegrityIssue[],
  ) {
    const etcProducts = products.filter((product) => text(product.asin)?.toUpperCase() === 'B0177E9JPS');
    const canonical = etcProducts.filter((product) => text(product.sku) === 'ETC-120A');
    const duplicate = etcProducts.filter((product) => text(product.sku) === 'ETC120A');
    if (canonical.length !== 1 || duplicate.length > 0) {
      issues.push(
        issue(
          'technical_blocker',
          'etc_identity_invariant_failed',
          'silverProduct',
          text(canonical[0]?.id),
          'ETC identity must have one ETC-120A Amazon listing and no ETC120A duplicate listing.',
          { canonicalCount: canonical.length, duplicateCount: duplicate.length },
        ),
      );
    }
    const canonicalIds = new Set(canonical.map((product) => text(product.id)));
    for (const line of lines.filter(
      (candidate) =>
        text(candidate.sourceAsin)?.toUpperCase() === 'B0177E9JPS' && text(candidate.sourceSupplierSku) === 'ETC120A',
    )) {
      const companyProduct = companyProducts.find((candidate) => text(candidate.id) === text(line.companyProductId));
      if (
        line.productMappingStatus === 'resolved' &&
        !canonicalIds.has(text(companyProduct && productById.get(text(companyProduct.productId))?.id))
      ) {
        issues.push(
          issue(
            'technical_blocker',
            'etc_order_line_mapping_failed',
            'silverOrderLine',
            text(line.id),
            'ETC120A supplier line does not resolve to the ETC-120A Amazon listing.',
          ),
        );
      }
    }
  }

  private verifySupplierDecisions(refs: PlainRecord[], suppliers: PlainRecord[], issues: SilverIntegrityIssue[]) {
    for (const decision of FOUR_COMPANY_MIGRATION_PROFILE.supplierExternalRefDecisions) {
      const matches = refs.filter(
        (ref) =>
          (text(ref.normalizedExternalSupplierCode) ?? text(ref.externalSupplierCode))?.toUpperCase() ===
          decision.externalRef,
      );
      if (decision.disposition === 'reject') {
        if (matches.length > 0) {
          issues.push(
            issue(
              'technical_blocker',
              'rejected_supplier_reference_present',
              'silverSupplierExternalRef',
              text(matches[0].id),
              `Rejected supplier reference ${decision.externalRef} is present.`,
            ),
          );
        }
        continue;
      }
      const supplier = suppliers.find((candidate) => text(candidate.id) === text(matches[0]?.supplierId));
      if (matches.length !== 1 || normalized(supplier?.displayName) !== normalized(decision.supplierName)) {
        issues.push(
          issue(
            'technical_blocker',
            'accepted_supplier_reference_invalid',
            'silverSupplierExternalRef',
            text(matches[0]?.id),
            `Accepted supplier reference ${decision.externalRef} is missing, duplicated, or linked to the wrong supplier.`,
            { matchCount: matches.length, expectedSupplierName: decision.supplierName },
          ),
        );
      }
    }
  }

  private verifyClickupLinks(
    orders: PlainRecord[],
    comments: PlainRecord[],
    orderById: Map<string | undefined, PlainRecord>,
    supplierById: Map<string | undefined, PlainRecord>,
    userById: Map<string | undefined, PlainRecord>,
    issues: SilverIntegrityIssue[],
  ) {
    for (const order of orders.filter((candidate) => text(candidate.authorityStatus) === 'clickup_authoritative')) {
      if (!text(order.authorityTaskRef)) {
        issues.push(
          issue(
            'technical_blocker',
            'clickup_authority_task_missing',
            'silverOrder',
            text(order.id),
            'ClickUp-authoritative order is missing its task reference.',
          ),
        );
      }
    }
    for (const comment of comments) {
      const entityType = text(comment.entityType);
      const entityId = text(comment.entityId);
      const actorUserId = text(comment.actorUserId);
      const entityExists =
        (entityType === 'supplier_order' && orderById.has(entityId)) ||
        (entityType === 'supplier' && supplierById.has(entityId));
      if (!entityExists) {
        issues.push(
          issue(
            'technical_blocker',
            'activity_comment_entity_missing',
            'silverActivityComment',
            text(comment.id),
            'Activity comment references a missing order or supplier.',
            { entityType, entityId },
          ),
        );
      }
      if (actorUserId && !userById.has(actorUserId)) {
        issues.push(
          issue(
            'technical_blocker',
            'activity_comment_user_missing',
            'silverActivityComment',
            text(comment.id),
            'Activity comment references a missing attribution user.',
            { actorUserId },
          ),
        );
      }
    }
  }

  private async all(collection: string) {
    return (await this.db.getRepository(collection).find({ limit: 100000 })).map(toPlainRecord);
  }
}
