import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
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

export class EcobaseCompanyProductFamilyService {
  constructor(private db: EcobaseDatabase) {}

  async findFamily(identity: FamilyIdentity) {
    const filter = normalizeIdentity(identity);
    const row = await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).findOne({ filter });
    return row ? toPlainRecord(row) : undefined;
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
    evidence?: PlainRecord;
  }) {
    const family = await this.getFamily(params.familyId);
    if (params.source === 'automatic' && idOf(family, 'replenishmentTargetCompanyProductId')) return family;
    const companyProductId = requiredString(params.companyProductId, 'companyProductId');
    const members = await this.listMembers(params.familyId);
    if (!members.some((member) => idOf(member, 'id') === companyProductId)) {
      throw new Error(`EcoBase company product "${companyProductId}" does not belong to family "${params.familyId}".`);
    }
    await this.updateFamily(params.familyId, {
      replenishmentTargetCompanyProductId: companyProductId,
      targetSelectionSource: params.source,
      targetSelectedAt: new Date().toISOString(),
      targetSelectedByUserId: params.actorUserId,
      targetReviewRequired: false,
      targetSelectionEvidenceJson: params.evidence ?? {},
    });
    return this.getFamily(params.familyId);
  }

  async setPreferredSupplierOffer(params: {
    familyId: string;
    supplierId: string;
    supplierProductId?: string;
    source: SupplierSelectionSource;
    actorUserId?: string;
    evidence?: PlainRecord;
  }) {
    const family = await this.getFamily(params.familyId);
    if (params.source === 'latest_valid_order' && family.supplierSelectionSource === 'operator') return family;
    const supplierId = requiredString(params.supplierId, 'supplierId');
    const supplierProductId = params.supplierProductId
      ? requiredString(params.supplierProductId, 'supplierProductId')
      : undefined;
    if (supplierProductId) await this.validateSupplierProduct(params.familyId, supplierId, supplierProductId);
    await this.updateFamily(params.familyId, {
      preferredSupplierId: supplierId,
      preferredSupplierProductId: supplierProductId,
      supplierSelectionSource: params.source,
      supplierSelectedAt: new Date().toISOString(),
      supplierSelectedByUserId: params.actorUserId,
      supplierReviewRequired: false,
      supplierSelectionEvidenceJson: params.evidence ?? {},
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
    for (const [key, identity] of identities) {
      const family =
        existingFamilies.get(key) ??
        toPlainRecord(
          await familyRepository.create({
            values: {
              id: randomUUID(),
              ...identity,
              targetReviewRequired: false,
              supplierReviewRequired: false,
            },
          }),
        );
      const familyId = idOf(family, 'id') as string;
      for (const companyProduct of companyProductsByIdentity.get(key) ?? []) {
        if (idOf(companyProduct, 'companyProductFamilyId') === familyId) continue;
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
          filterByTk: idOf(companyProduct, 'id') as string,
          values: { companyProductFamilyId: familyId },
        });
      }
      families.push(await this.reconcileFamily(familyId));
    }
    return {
      familyCount: families.length,
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
    if (!persistedTargetId && target.recommended) {
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
    for (const member of members) {
      const companyProductId = idOf(member, 'id');
      const lifecycleStatus = String(member.lifecycleStatus ?? '')
        .trim()
        .toLowerCase();
      if (!companyProductId || ['inactive', 'duplicate', 'excluded', 'discontinued'].includes(lifecycleStatus))
        continue;
      const snapshots = (
        await this.db
          .getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots)
          .find({ filter: { companyProductId }, limit: 10000 })
      )
        .map(toPlainRecord)
        .sort((left, right) => String(right.snapshotDate ?? '').localeCompare(String(left.snapshotDate ?? '')));
      const snapshot = snapshots[0];
      if (!snapshot) continue;
      const sellableStock = numberValue(snapshot.sellableStock);
      const planningStock =
        sellableStock +
        numberValue(snapshot.reserved) +
        numberValue(snapshot.inbound) +
        numberValue(snapshot.ordered) +
        numberValue(snapshot.prepStock);
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
    const recommended = first && numberValue(first.planningStock) > 0 && !tied ? first : undefined;
    return {
      recommended,
      reviewReason: !scores.length
        ? 'missing_current_stock_evidence'
        : tied
          ? 'ambiguous_target_stock_tie'
          : recommended
            ? undefined
            : 'no_positive_current_stock',
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
          sourceSku: memberById.get(companyProductId)?.sku,
          supplierId,
          matchType: companyProductId === targetId ? 'exact_target_sku' : 'family_projected',
        };
        if (idOf(order, 'companyId') !== companyId) {
          reviewEvidence.push({ ...evidence, reviewReason: 'companyless_supplier_order_evidence' });
        } else if (!dateSortValue(order.orderDate)) {
          reviewEvidence.push({ ...evidence, reviewReason: 'supplier_order_date_missing' });
        } else {
          validEvidence.push(evidence);
        }
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
    if (latestReview || supplierConflict || (!latest && !selectedSupplierId)) {
      await this.updateFamily(familyId, {
        supplierReviewRequired: true,
        supplierSelectionEvidenceJson: {
          ...recordValue(currentFamily.supplierSelectionEvidenceJson),
          ...(latest ?? latestReview ?? {}),
          ...(latestReview ?? {}),
          recommendedSupplierId: idOf(latest ?? {}, 'supplierId'),
          reviewReason:
            latestReview?.reviewReason ??
            (supplierConflict ? 'operator_supplier_differs_from_latest_order' : 'missing_valid_supplier_order'),
          reconciledAt: new Date().toISOString(),
        },
      });
    } else if (operatorSelected && family.supplierReviewRequired === true) {
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
