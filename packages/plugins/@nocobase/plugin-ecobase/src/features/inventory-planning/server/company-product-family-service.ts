/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { FOUR_COMPANY_MIGRATION_PROFILE } from '../../source-import/server/four-company-migration-profile';
import type { EcobaseDatabase } from '../../source-import/server/import-service';

type PlainRecord = Record<string, unknown>;

export type FamilyIdentity = {
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  canonicalAsin: string;
};

export type FamilySelectionSource = 'automatic' | 'operator';
export type SupplierSelectionSource = 'latest_valid_order' | 'operator';

export type CompanyProductResolution = {
  companyProductId?: string;
  resolution?: 'exact' | 'reviewed_alias' | 'family_target';
  sourceSku?: string;
  boundary?: FamilyIdentity;
  exclusionReason?:
    | 'company_not_found'
    | 'product_not_found'
    | 'exact_match_ambiguous'
    | 'boundary_missing'
    | 'boundary_ambiguous'
    | 'family_missing'
    | 'target_missing'
    | 'target_review_required'
    | 'target_not_member';
};

function toPlainRecord(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const row = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof row.toJSON === 'function' ? row.toJSON() : row;
}

function requiredString(value: unknown, field: string) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`EcoBase company product family requires ${field}.`);
  return normalized;
}

function idOf(row: PlainRecord, field: string) {
  const value = row[field];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function presentNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function recordValue(value: unknown): PlainRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PlainRecord) : {};
}

function dateSortValue(value: unknown) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeIdentity(identity: FamilyIdentity): FamilyIdentity {
  return {
    companyId: requiredString(identity.companyId, 'companyId'),
    amazonAccountId: requiredString(identity.amazonAccountId, 'amazonAccountId'),
    marketplace: requiredString(identity.marketplace, 'marketplace').toLowerCase(),
    canonicalAsin: requiredString(identity.canonicalAsin, 'canonicalAsin').toUpperCase(),
  };
}

function operationalValue(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

const ACCEPTED_ORDER_AUTHORITIES = new Set(['clickup_authoritative', 'alternate_authoritative']);
const ACCEPTED_SUPPLIER_ORDER_STATUSES = new Set([
  'supplier_contacted',
  'supplier_confirmed',
  'approval_pending',
  'payment_pending',
  'paid',
  'supplier_preparing',
  'shipped_inbound',
  'reached_fba',
  'completed',
  'blocked',
]);
const INVALID_ORDER_INTENTS = new Set(['draft', 'analysis', 'analysis_only']);

export class EcobaseCompanyProductFamilyService {
  constructor(private db: EcobaseDatabase) {}

  async findFamily(identity: FamilyIdentity) {
    const filter = normalizeIdentity(identity);
    const row = await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).findOne({ filter });
    return row ? toPlainRecord(row) : undefined;
  }

  async resolveCompanyProduct(params: {
    companyId: string;
    asin?: string;
    sku?: string;
    amazonAccountId?: string;
    marketplace?: string;
  }): Promise<CompanyProductResolution> {
    const companyId = requiredString(params.companyId, 'companyId');
    const asin = params.asin?.trim().toUpperCase();
    const sourceSku = params.sku?.trim();
    if (!asin) return { sourceSku, exclusionReason: 'product_not_found' };

    const [company, products, companyProducts, accounts] = await Promise.all([
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).findOne({ filterByTk: companyId }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ filter: { asin }, limit: 10000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ filter: { companyId }, limit: 10000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).find({ filter: { companyId }, limit: 10000 }),
    ]);
    if (!company) return { sourceSku, exclusionReason: 'company_not_found' };

    const productsById = new Map(
      products.map((value) => {
        const product = toPlainRecord(value);
        return [idOf(product, 'id'), product];
      }),
    );
    const asinRelations = companyProducts
      .map(toPlainRecord)
      .filter((relation) => productsById.has(idOf(relation, 'productId')));
    if (!asinRelations.length) return { sourceSku, exclusionReason: 'product_not_found' };

    if (sourceSku) {
      const exactRelations = asinRelations.filter((relation) => {
        const product = productsById.get(idOf(relation, 'productId'));
        return (
          String(product?.sku ?? '')
            .trim()
            .toLowerCase() === sourceSku.toLowerCase()
        );
      });
      const scopedExactRelations = this.scopeRelations(exactRelations, accounts.map(toPlainRecord), params);
      if (scopedExactRelations.length === 1) {
        return { companyProductId: idOf(scopedExactRelations[0], 'id'), resolution: 'exact', sourceSku };
      }
      if (exactRelations.length > 0) return { sourceSku, exclusionReason: 'exact_match_ambiguous' };

      const reviewedAlias = FOUR_COMPANY_MIGRATION_PROFILE.listingSkuAliasDecisions.find(
        (decision) => decision.asin === asin && decision.sourceSupplierSku.toLowerCase() === sourceSku.toLowerCase(),
      );
      if (reviewedAlias) {
        const aliasRelations = asinRelations.filter((relation) => {
          const product = productsById.get(idOf(relation, 'productId'));
          return (
            String(product?.sku ?? '')
              .trim()
              .toLowerCase() === reviewedAlias.amazonListingSku.toLowerCase()
          );
        });
        const scopedAliasRelations = this.scopeRelations(aliasRelations, accounts.map(toPlainRecord), params);
        if (scopedAliasRelations.length === 1) {
          return {
            companyProductId: idOf(scopedAliasRelations[0], 'id'),
            resolution: 'reviewed_alias',
            sourceSku,
          };
        }
        if (aliasRelations.length > 0) return { sourceSku, exclusionReason: 'exact_match_ambiguous' };
      }
    }

    const scopedRelations = this.scopeRelations(asinRelations, accounts.map(toPlainRecord), params);
    const boundaries = new Map<string, FamilyIdentity>();
    const accountById = new Map(accounts.map(toPlainRecord).map((account) => [idOf(account, 'id'), account]));
    for (const relation of scopedRelations) {
      const account = accountById.get(idOf(relation, 'amazonAccountId'));
      if (idOf(account ?? {}, 'companyId') !== companyId) continue;
      const amazonAccountId = idOf(account ?? {}, 'id');
      const marketplace = String(account?.marketplace ?? '').trim();
      if (!amazonAccountId || !marketplace || marketplace.toLowerCase() === 'default') continue;
      const boundary = normalizeIdentity({ companyId, amazonAccountId, marketplace, canonicalAsin: asin });
      boundaries.set(
        [boundary.companyId, boundary.amazonAccountId, boundary.marketplace, boundary.canonicalAsin].join('::'),
        boundary,
      );
    }
    if (boundaries.size === 0) return { sourceSku, exclusionReason: 'boundary_missing' };
    if (boundaries.size !== 1) return { sourceSku, exclusionReason: 'boundary_ambiguous' };

    const boundary = [...boundaries.values()][0];
    const family = await this.findFamily(boundary);
    if (!family) return { sourceSku, boundary, exclusionReason: 'family_missing' };
    if (family.targetReviewRequired === true) {
      return { sourceSku, boundary, exclusionReason: 'target_review_required' };
    }
    const targetId = idOf(family, 'replenishmentTargetCompanyProductId');
    if (!targetId) return { sourceSku, boundary, exclusionReason: 'target_missing' };
    const members = await this.listMembers(idOf(family, 'id') as string);
    if (!members.some((member) => idOf(member, 'id') === targetId)) {
      return { sourceSku, boundary, exclusionReason: 'target_not_member' };
    }
    return { companyProductId: targetId, resolution: 'family_target', sourceSku, boundary };
  }

  private scopeRelations(
    relations: PlainRecord[],
    accounts: PlainRecord[],
    evidence: { amazonAccountId?: string; marketplace?: string },
  ) {
    const marketplace = evidence.marketplace?.trim().toLowerCase();
    const accountById = new Map(accounts.map((account) => [idOf(account, 'id'), account]));
    return relations.filter((relation) => {
      if (evidence.amazonAccountId && idOf(relation, 'amazonAccountId') !== evidence.amazonAccountId) return false;
      if (!marketplace) return true;
      const account = accountById.get(idOf(relation, 'amazonAccountId'));
      return (
        String(account?.marketplace ?? '')
          .trim()
          .toLowerCase() === marketplace
      );
    });
  }

  async getFamily(familyId: string) {
    const id = requiredString(familyId, 'familyId');
    const row = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies)
      .findOne({ filterByTk: id });
    if (!row) throw new Error(`EcoBase company product family "${id}" was not found.`);
    return toPlainRecord(row);
  }

  async ensureFamily(identity: FamilyIdentity) {
    const values = normalizeIdentity(identity);
    await this.validateAccountBoundary(values);
    const existing = await this.findFamily(values);
    if (existing) return existing;
    return toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).create({
        values: {
          id: randomUUID(),
          ...values,
          targetReviewRequired: false,
          supplierReviewRequired: false,
        },
      }),
    );
  }

  async listMembers(familyId: string) {
    const family = await this.getFamily(familyId);
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts);
    const linkedCompanyProducts = await repository.find({ filter: { companyProductFamilyId: familyId }, limit: 10000 });
    const companyProducts = linkedCompanyProducts.length
      ? linkedCompanyProducts
      : await repository.find({
          filter: {
            companyId: idOf(family, 'companyId'),
            amazonAccountId: idOf(family, 'amazonAccountId'),
          },
          limit: 10000,
        });
    const members: PlainRecord[] = [];
    for (const companyProductValue of companyProducts) {
      const companyProduct = toPlainRecord(companyProductValue);
      const productId = idOf(companyProduct, 'productId');
      if (!productId) continue;
      const productValue = await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverProducts)
        .findOne({ filterByTk: productId });
      const product = toPlainRecord(productValue);
      if (requiredString(product.asin, 'product.asin').toUpperCase() !== family.canonicalAsin) continue;
      members.push({ ...companyProduct, asin: product.asin, sku: product.sku });
    }
    return members;
  }

  async setReplenishmentTarget(params: {
    familyId: string;
    companyProductId: string;
    source: FamilySelectionSource;
    actorUserId?: string;
    reason?: string;
    evidence?: PlainRecord;
  }) {
    const family = await this.getFamily(params.familyId);
    if (params.source === 'automatic' && idOf(family, 'replenishmentTargetCompanyProductId')) return family;
    const companyProductId = requiredString(params.companyProductId, 'companyProductId');
    const members = await this.listMembers(params.familyId);
    if (!members.some((member) => idOf(member, 'id') === companyProductId)) {
      throw new Error(`EcoBase company product "${companyProductId}" does not belong to family "${params.familyId}".`);
    }
    const targetSelectedAt = new Date().toISOString();
    await this.updateFamily(params.familyId, {
      replenishmentTargetCompanyProductId: companyProductId,
      targetSelectionSource: params.source,
      targetSelectedAt,
      targetSelectedByUserId: params.actorUserId,
      targetReviewRequired: false,
      targetSelectionEvidenceJson: {
        ...(params.evidence ?? {}),
        ...(params.source === 'operator'
          ? { reason: params.reason, actorUserId: params.actorUserId, selectedAt: targetSelectedAt }
          : {}),
      },
    });
    return this.getFamily(params.familyId);
  }

  async setPreferredSupplierOffer(params: {
    familyId: string;
    supplierId: string;
    supplierProductId?: string;
    source: SupplierSelectionSource;
    actorUserId?: string;
    reason?: string;
    evidence?: PlainRecord;
  }) {
    const family = await this.getFamily(params.familyId);
    if (params.source === 'latest_valid_order' && family.supplierSelectionSource === 'operator') return family;
    const supplierId = requiredString(params.supplierId, 'supplierId');
    const supplierProductId = params.supplierProductId
      ? requiredString(params.supplierProductId, 'supplierProductId')
      : undefined;
    if (params.source === 'operator') await this.validateSupplier(params.familyId, supplierId);
    if (supplierProductId) await this.validateSupplierProduct(params.familyId, supplierId, supplierProductId);
    const supplierSelectedAt = new Date().toISOString();
    await this.updateFamily(params.familyId, {
      preferredSupplierId: supplierId,
      preferredSupplierProductId: supplierProductId,
      supplierSelectionSource: params.source,
      supplierSelectedAt,
      supplierSelectedByUserId: params.actorUserId,
      supplierReviewRequired: false,
      supplierSelectionEvidenceJson: {
        ...(params.evidence ?? {}),
        ...(params.source === 'operator'
          ? { reason: params.reason, actorUserId: params.actorUserId, selectedAt: supplierSelectedAt }
          : {}),
      },
    });
    return this.getFamily(params.familyId);
  }

  async reconcileAllFamilies(companyId?: string) {
    const companyProducts = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({
        ...(companyId ? { filter: { companyId: requiredString(companyId, 'companyId') } } : {}),
        limit: 100000,
      })
    ).map(toPlainRecord);
    const products = new Map(
      (await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: 100000 })).map((value) => {
        const product = toPlainRecord(value);
        return [idOf(product, 'id'), product];
      }),
    );
    const accounts = new Map(
      (await this.db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).find({ limit: 100000 })).map((value) => {
        const account = toPlainRecord(value);
        return [idOf(account, 'id'), account];
      }),
    );
    const identities = new Map<string, FamilyIdentity>();
    const companyProductsByIdentity = new Map<string, PlainRecord[]>();
    for (const companyProduct of companyProducts) {
      const account = accounts.get(idOf(companyProduct, 'amazonAccountId'));
      const product = products.get(idOf(companyProduct, 'productId'));
      const accountCompanyId = idOf(account ?? {}, 'companyId');
      if (!accountCompanyId || accountCompanyId !== idOf(companyProduct, 'companyId') || !product?.asin) continue;
      const identity = normalizeIdentity({
        companyId: accountCompanyId,
        amazonAccountId: idOf(account ?? {}, 'id') as string,
        marketplace: requiredString(account?.marketplace, 'amazonAccount.marketplace'),
        canonicalAsin: requiredString(product.asin, 'product.asin'),
      });
      const key = [identity.companyId, identity.amazonAccountId, identity.marketplace, identity.canonicalAsin].join(
        '::',
      );
      identities.set(key, identity);
      companyProductsByIdentity.set(key, [...(companyProductsByIdentity.get(key) ?? []), companyProduct]);
    }
    const familyRepository = this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies);
    const existingFamilies = new Map(
      (await familyRepository.find({ limit: 100000 })).map((value) => {
        const family = toPlainRecord(value);
        return [
          [family.companyId, family.amazonAccountId, family.marketplace, family.canonicalAsin].join('::'),
          family,
        ];
      }),
    );
    const families: PlainRecord[] = [];
    let createdFamilyCount = 0;
    let linkedCompanyProductCount = 0;
    for (const [key, identity] of identities) {
      let family = existingFamilies.get(key);
      if (!family) {
        family = toPlainRecord(
          await familyRepository.create({
            values: {
              id: randomUUID(),
              ...identity,
              targetReviewRequired: false,
              supplierReviewRequired: false,
            },
          }),
        );
        createdFamilyCount += 1;
      }
      const familyId = idOf(family, 'id') as string;
      for (const companyProduct of companyProductsByIdentity.get(key) ?? []) {
        if (idOf(companyProduct, 'companyProductFamilyId') === familyId) continue;
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
          filterByTk: idOf(companyProduct, 'id') as string,
          values: { companyProductFamilyId: familyId },
        });
        linkedCompanyProductCount += 1;
      }
      families.push(await this.reconcileFamily(familyId));
    }
    return {
      examinedCompanyProductCount: companyProducts.length,
      familyCount: families.length,
      createdFamilyCount,
      linkedCompanyProductCount,
      targetSelectedCount: families.filter((family) => idOf(family, 'replenishmentTargetCompanyProductId')).length,
      targetReviewCount: families.filter((family) => family.targetReviewRequired === true).length,
      supplierReviewCount: families.filter((family) => family.supplierReviewRequired === true).length,
      families,
    };
  }

  async reconcileFamily(familyId: string) {
    let family = await this.getFamily(familyId);
    const members = await this.listMembers(familyId);
    if (!members.length) {
      await this.updateFamily(familyId, {
        targetReviewRequired: true,
        supplierReviewRequired: true,
        targetSelectionEvidenceJson: { reviewReason: 'family_has_no_company_products' },
        supplierSelectionEvidenceJson: { reviewReason: 'family_has_no_company_products' },
      });
      return this.getFamily(familyId);
    }

    const target = await this.targetRecommendation(members);
    const persistedTargetId = idOf(family, 'replenishmentTargetCompanyProductId');
    const validOperatorTarget =
      family.targetSelectionSource === 'operator' &&
      Boolean(persistedTargetId && target.candidateIds.includes(persistedTargetId));
    if (validOperatorTarget) {
      if (family.targetReviewRequired === true) {
        await this.updateFamily(familyId, { targetReviewRequired: false });
        family = await this.getFamily(familyId);
      }
    } else if (!persistedTargetId && target.recommended) {
      family = await this.setReplenishmentTarget({
        familyId,
        companyProductId: idOf(target.recommended, 'companyProductId') as string,
        source: 'automatic',
        evidence: target.evidence,
      });
    } else if (!target.recommended || idOf(target.recommended, 'companyProductId') !== persistedTargetId) {
      await this.updateFamily(familyId, {
        targetReviewRequired: true,
        targetSelectionEvidenceJson: {
          ...recordValue(family.targetSelectionEvidenceJson),
          ...target.evidence,
          recommendedCompanyProductId: idOf(target.recommended ?? {}, 'companyProductId'),
          reviewReason: target.reviewReason ?? 'higher_stock_listing_detected',
          reconciledAt: new Date().toISOString(),
        },
      });
      family = await this.getFamily(familyId);
    } else if (family.targetReviewRequired === true) {
      await this.updateFamily(familyId, { targetReviewRequired: false });
      family = await this.getFamily(familyId);
    }

    await this.reconcilePreferredSupplier(family, members);
    return this.getFamily(familyId);
  }

  async setReviewRequired(familyId: string, review: { target?: boolean; supplier?: boolean }) {
    await this.getFamily(familyId);
    await this.updateFamily(familyId, {
      ...(typeof review.target === 'boolean' ? { targetReviewRequired: review.target } : {}),
      ...(typeof review.supplier === 'boolean' ? { supplierReviewRequired: review.supplier } : {}),
    });
    return this.getFamily(familyId);
  }

  private async targetRecommendation(members: PlainRecord[]) {
    const scores: PlainRecord[] = [];
    let eligibleListingCount = 0;
    for (const member of members) {
      const companyProductId = idOf(member, 'id');
      const lifecycleStatus = String(member.lifecycleStatus ?? '')
        .trim()
        .toLowerCase();
      if (!companyProductId || !['active', 'live'].includes(lifecycleStatus)) continue;
      eligibleListingCount += 1;
      const snapshots = (
        await this.db
          .getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots)
          .find({ filter: { companyProductId }, limit: 10000 })
      )
        .map(toPlainRecord)
        .filter((snapshot) => String(snapshot.snapshotDate ?? '').trim().length > 0)
        .sort((left, right) => String(right.snapshotDate).localeCompare(String(left.snapshotDate)));
      const snapshot = snapshots[0];
      const sellableStock = presentNumber(snapshot?.sellableStock);
      if (!snapshot || sellableStock === undefined) continue;
      const planningStock =
        sellableStock +
        numberValue(snapshot.reserved) +
        numberValue(snapshot.inbound) +
        numberValue(snapshot.ordered) +
        numberValue(snapshot.prepStock) +
        numberValue(snapshot.awdStock);
      scores.push({
        companyProductId,
        sku: member.sku,
        snapshotDate: snapshot.snapshotDate,
        planningStock,
        sellableStock,
      });
    }
    scores.sort(
      (left, right) =>
        numberValue(right.planningStock) - numberValue(left.planningStock) ||
        numberValue(right.sellableStock) - numberValue(left.sellableStock) ||
        String(left.sku ?? '').localeCompare(String(right.sku ?? '')),
    );
    const first = scores[0];
    const second = scores[1];
    const tied = Boolean(
      first &&
        second &&
        numberValue(first.planningStock) === numberValue(second.planningStock) &&
        numberValue(first.sellableStock) === numberValue(second.sellableStock),
    );
    const recommended = first && !tied ? first : undefined;
    return {
      recommended,
      candidateIds: scores.map((candidate) => idOf(candidate, 'companyProductId') as string),
      reviewReason: !scores.length
        ? eligibleListingCount > 0
          ? 'missing_current_stock_evidence'
          : 'no_eligible_current_listing'
        : tied
          ? 'ambiguous_target_stock_tie'
          : undefined,
      evidence: {
        selectionRule: 'highest_planning_stock_then_sellable',
        candidates: scores,
        selectedPlanningStock: recommended?.planningStock,
        selectedSellableStock: recommended?.sellableStock,
        selectedSnapshotDate: recommended?.snapshotDate,
      },
    };
  }

  private async reconcilePreferredSupplier(family: PlainRecord, members: PlainRecord[]) {
    const familyId = idOf(family, 'id') as string;
    const companyId = idOf(family, 'companyId');
    const targetId = idOf(family, 'replenishmentTargetCompanyProductId');
    const memberById = new Map(members.map((member) => [idOf(member, 'id'), member]));
    const validEvidence: PlainRecord[] = [];
    const reviewEvidence: PlainRecord[] = [];

    for (const member of members) {
      const companyProductId = idOf(member, 'id');
      if (!companyProductId) continue;
      const lines = await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverOrderLines)
        .find({ filter: { companyProductId }, limit: 10000 });
      for (const lineValue of lines) {
        const line = toPlainRecord(lineValue);
        const orderId = idOf(line, 'orderId');
        if (!orderId) continue;
        const order = toPlainRecord(
          await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).findOne({ filterByTk: orderId }),
        );
        const supplierId = idOf(order, 'supplierId');
        if (!supplierId) continue;
        const evidence: PlainRecord = {
          sourceOrderId: orderId,
          sourceOrderRef: order.orderRef,
          sourceOrderDate: order.orderDate,
          sourceCompanyProductId: companyProductId,
          sourceSupplierProductId: idOf(line, 'supplierProductId'),
          sourceAsin: line.sourceAsin,
          sourceSku: line.sourceSupplierSku ?? memberById.get(companyProductId)?.sku,
          productMappingStatus: line.productMappingStatus ?? 'resolved',
          supplierId,
          matchType: companyProductId === targetId ? 'exact_target_sku' : 'family_projected',
        };
        let reviewReason: string | undefined;
        if (idOf(order, 'companyId') !== companyId) {
          reviewReason = 'companyless_supplier_order_evidence';
        } else if (!ACCEPTED_ORDER_AUTHORITIES.has(operationalValue(order.authorityStatus))) {
          reviewReason = 'supplier_order_authority_unresolved';
        } else if (
          INVALID_ORDER_INTENTS.has(operationalValue(order.orderIntent)) ||
          !ACCEPTED_SUPPLIER_ORDER_STATUSES.has(operationalValue(order.canonicalStatus ?? order.lifecycleStatus))
        ) {
          reviewReason = 'supplier_order_lifecycle_invalid';
        } else if (!dateSortValue(order.orderDate)) {
          reviewReason = 'supplier_order_date_missing';
        } else if (line.productMappingStatus !== 'resolved') {
          reviewReason = 'supplier_order_product_mapping_unresolved';
        } else if (numberValue(line.orderedQty) <= 0) {
          reviewReason = 'supplier_order_quantity_nonpositive';
        } else {
          const supplier = await this.db
            .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
            .findOne({ filterByTk: supplierId });
          if (!supplier) {
            reviewReason = 'supplier_order_supplier_missing';
          } else {
            const supplierProductId = idOf(line, 'supplierProductId');
            const supplierProduct = supplierProductId
              ? toPlainRecord(
                  await this.db
                    .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
                    .findOne({ filterByTk: supplierProductId }),
                )
              : {};
            if (!idOf(supplierProduct, 'id')) {
              reviewReason = 'supplier_order_supplier_product_missing';
            } else if (
              idOf(supplierProduct, 'supplierId') !== supplierId ||
              idOf(supplierProduct, 'productId') !== idOf(memberById.get(companyProductId) ?? {}, 'productId')
            ) {
              reviewReason = 'supplier_order_supplier_product_mismatch';
            }
          }
        }
        if (reviewReason) reviewEvidence.push({ ...evidence, reviewReason });
        else validEvidence.push(evidence);
      }
    }

    const sortLatest = (left: PlainRecord, right: PlainRecord) =>
      dateSortValue(right.sourceOrderDate) - dateSortValue(left.sourceOrderDate) ||
      (right.matchType === 'exact_target_sku' ? 1 : 0) - (left.matchType === 'exact_target_sku' ? 1 : 0) ||
      String(right.sourceOrderRef ?? '').localeCompare(String(left.sourceOrderRef ?? ''));
    validEvidence.sort(sortLatest);
    reviewEvidence.sort(sortLatest);
    const latest = validEvidence[0];
    const latestReview = reviewEvidence[0];
    const operatorSelected = family.supplierSelectionSource === 'operator';
    const selectedSupplierId = idOf(family, 'preferredSupplierId');

    let currentFamily = family;
    if (latest && !operatorSelected) {
      currentFamily = await this.setPreferredSupplierOffer({
        familyId,
        supplierId: idOf(latest, 'supplierId') as string,
        supplierProductId: idOf(latest, 'sourceSupplierProductId'),
        source: 'latest_valid_order',
        evidence: { ...latest, selectionRule: 'latest_valid_source_order_date' },
      });
    }

    const supplierConflict = Boolean(operatorSelected && latest && idOf(latest, 'supplierId') !== selectedSupplierId);
    const invalidAutomaticSelection = Boolean(!operatorSelected && !latest && selectedSupplierId);
    if (invalidAutomaticSelection) {
      await this.updateFamily(familyId, {
        preferredSupplierId: null,
        preferredSupplierProductId: null,
        supplierSelectionSource: null,
      });
      currentFamily = await this.getFamily(familyId);
    }
    const invalidEvidenceWithoutValidEvidence = Boolean(!latest && latestReview);
    if (
      invalidEvidenceWithoutValidEvidence ||
      supplierConflict ||
      invalidAutomaticSelection ||
      (!latest && !selectedSupplierId)
    ) {
      await this.updateFamily(familyId, {
        supplierReviewRequired: true,
        supplierSelectionEvidenceJson: {
          ...recordValue(currentFamily.supplierSelectionEvidenceJson),
          ...(latest ?? latestReview ?? {}),
          recommendedSupplierId: idOf(latest ?? {}, 'supplierId'),
          reviewReason: supplierConflict
            ? 'operator_supplier_differs_from_latest_order'
            : latestReview?.reviewReason ?? 'missing_valid_supplier_order',
          reconciledAt: new Date().toISOString(),
        },
      });
    } else if (currentFamily.supplierReviewRequired === true) {
      await this.updateFamily(familyId, { supplierReviewRequired: false });
    }
  }

  private async validateAccountBoundary(identity: FamilyIdentity) {
    const accountValue = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts)
      .findOne({ filterByTk: identity.amazonAccountId });
    const account = toPlainRecord(accountValue);
    if (!idOf(account, 'id')) {
      throw new Error(`EcoBase Amazon account "${identity.amazonAccountId}" was not found.`);
    }
    if (idOf(account, 'companyId') !== identity.companyId) {
      throw new Error(
        `EcoBase Amazon account "${identity.amazonAccountId}" does not belong to company "${identity.companyId}".`,
      );
    }
    const marketplace = requiredString(account.marketplace, 'amazonAccount.marketplace').toLowerCase();
    if (marketplace !== identity.marketplace) {
      throw new Error(
        `EcoBase Amazon account "${identity.amazonAccountId}" belongs to marketplace "${marketplace}", not "${identity.marketplace}".`,
      );
    }
  }

  private async validateSupplier(familyId: string, supplierId: string) {
    const family = await this.getFamily(familyId);
    const supplier = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
      .findOne({ filterByTk: supplierId });
    if (!supplier) throw new Error(`EcoBase supplier "${supplierId}" was not found.`);
    const account = await this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).findOne({
      filter: { supplierId, companyId: idOf(family, 'companyId') },
    });
    if (!account) {
      throw new Error(`EcoBase supplier "${supplierId}" does not belong to family company "${family.companyId}".`);
    }
  }

  private async validateSupplierProduct(familyId: string, supplierId: string, supplierProductId: string) {
    const supplierProductValue = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
      .findOne({ filterByTk: supplierProductId });
    const supplierProduct = toPlainRecord(supplierProductValue);
    if (!idOf(supplierProduct, 'id')) {
      throw new Error(`EcoBase supplier product "${supplierProductId}" was not found.`);
    }
    if (idOf(supplierProduct, 'supplierId') !== supplierId) {
      throw new Error(`EcoBase supplier product "${supplierProductId}" does not belong to supplier "${supplierId}".`);
    }
    const productIds = new Set((await this.listMembers(familyId)).map((member) => idOf(member, 'productId')));
    if (!productIds.has(idOf(supplierProduct, 'productId'))) {
      throw new Error(`EcoBase supplier product "${supplierProductId}" does not belong to family "${familyId}".`);
    }
  }

  private async updateFamily(familyId: string, values: PlainRecord) {
    await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies)
      .update({ filterByTk: familyId, values });
  }
}
