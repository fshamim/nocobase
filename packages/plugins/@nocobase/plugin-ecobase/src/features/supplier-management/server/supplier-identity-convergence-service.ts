/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';

type PlainRecord = Record<string, unknown>;
type MutableRepository = EcobaseRepository & {
  destroy(params: Record<string, unknown>): Promise<unknown>;
};

type SupplierGroup = {
  normalizedName: string;
  canonicalSupplierId?: string;
  duplicateSupplierIds: string[];
  status: 'eligible' | 'review_required';
  reasons: string[];
};

export type SupplierConvergencePreview = {
  eligible: SupplierGroup[];
  reviewRequired: SupplierGroup[];
};

function plain(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const record = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function text(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function offerSignature(offer: PlainRecord) {
  const number = (value: unknown) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return JSON.stringify([
    text(offer.supplierSku)?.toLowerCase() ?? null,
    number(offer.unitCost),
    number(offer.moq),
    number(offer.supplierPackSize),
    number(offer.leadTimeDays),
    text(offer.prepCapability)?.toLowerCase() ?? null,
    text(offer.analysisStatus)?.toLowerCase() ?? null,
  ]);
}

export class EcobaseSupplierIdentityConvergenceService {
  constructor(private db: EcobaseDatabase) {}

  async preview(transaction?: unknown): Promise<SupplierConvergencePreview> {
    const [suppliers, externalRefs, supplierProducts] = await Promise.all([
      this.rows(ECOBASE_COLLECTIONS.silverSuppliers, undefined, transaction),
      this.rows(ECOBASE_COLLECTIONS.silverSupplierExternalRefs, undefined, transaction),
      this.rows(ECOBASE_COLLECTIONS.silverSupplierProducts, undefined, transaction),
    ]);
    const refsBySupplier = this.groupBy(externalRefs, 'supplierId');
    const offersBySupplier = this.groupBy(supplierProducts, 'supplierId');
    const suppliersByName = this.groupBy(suppliers, 'normalizedName');
    const eligible: SupplierGroup[] = [];
    const reviewRequired: SupplierGroup[] = [];

    for (const [normalizedName, group] of suppliersByName) {
      if (!normalizedName || group.length < 2) continue;
      const authorized = group.filter((supplier) => (refsBySupplier.get(text(supplier.id) ?? '') ?? []).length > 0);
      const canonicalSupplierId = authorized.length === 1 ? text(authorized[0].id) : undefined;
      const duplicateSupplierIds = group
        .map((supplier) => text(supplier.id))
        .filter((id): id is string => Boolean(id && id !== canonicalSupplierId));
      const reasons: string[] = [];
      if (authorized.length === 0) reasons.push('canonical_supplier_not_authorized');
      if (authorized.length > 1) reasons.push('competing_external_authority');
      if (canonicalSupplierId) {
        const canonicalOffers = new Map(
          (offersBySupplier.get(canonicalSupplierId) ?? []).map((offer) => [text(offer.productId), offer]),
        );
        for (const duplicateSupplierId of duplicateSupplierIds) {
          for (const offer of offersBySupplier.get(duplicateSupplierId) ?? []) {
            const canonicalOffer = canonicalOffers.get(text(offer.productId));
            if (canonicalOffer && offerSignature(canonicalOffer) !== offerSignature(offer)) {
              reasons.push(`conflicting_supplier_offer:${text(offer.productId) ?? 'missing_product'}`);
            }
          }
        }
      }
      const candidate: SupplierGroup = {
        normalizedName,
        canonicalSupplierId,
        duplicateSupplierIds,
        status: reasons.length ? 'review_required' : 'eligible',
        reasons: [...new Set(reasons)].sort(),
      };
      (candidate.status === 'eligible' ? eligible : reviewRequired).push(candidate);
    }

    return { eligible, reviewRequired };
  }

  async converge(
    normalizedName: string,
    existingTransaction?: unknown,
    expected?: { canonicalSupplierId: string; duplicateSupplierIds: string[] },
  ) {
    const run = async (transaction?: unknown) => {
      const candidate = (await this.preview(transaction)).eligible.find(
        (group) => group.normalizedName === normalizedName,
      );
      if (!candidate?.canonicalSupplierId) {
        throw new Error(
          `EcoBase supplier convergence refused "${normalizedName}": no collision-safe authorized canonical supplier.`,
        );
      }
      if (
        expected &&
        (candidate.canonicalSupplierId !== expected.canonicalSupplierId ||
          JSON.stringify([...candidate.duplicateSupplierIds].sort()) !==
            JSON.stringify([...expected.duplicateSupplierIds].sort()))
      ) {
        throw new Error(`EcoBase supplier convergence refused stale preview for "${normalizedName}".`);
      }
      return this.applyCandidate(candidate, transaction);
    };
    if (existingTransaction) return run(existingTransaction);
    if (typeof this.db.sequelize?.transaction === 'function') return this.db.sequelize.transaction(run);
    return run();
  }

  private async applyCandidate(candidate: SupplierGroup, transaction?: unknown) {
    const canonicalSupplierId = candidate.canonicalSupplierId as string;
    const offerIdMap = new Map<string, string>();
    let movedOffers = 0;
    let coalescedOffers = 0;

    for (const duplicateSupplierId of candidate.duplicateSupplierIds) {
      const canonicalOffers = await this.rows(
        ECOBASE_COLLECTIONS.silverSupplierProducts,
        { supplierId: canonicalSupplierId },
        transaction,
      );
      const canonicalByProduct = new Map(canonicalOffers.map((offer) => [text(offer.productId), offer]));
      const duplicateOffers = await this.rows(
        ECOBASE_COLLECTIONS.silverSupplierProducts,
        { supplierId: duplicateSupplierId },
        transaction,
      );

      for (const duplicateOffer of duplicateOffers) {
        const duplicateOfferId = text(duplicateOffer.id) as string;
        const canonicalOffer = canonicalByProduct.get(text(duplicateOffer.productId));
        if (canonicalOffer) {
          if (offerSignature(canonicalOffer) !== offerSignature(duplicateOffer)) {
            throw new Error(
              `EcoBase supplier convergence refused "${candidate.normalizedName}": supplier offer ${duplicateOfferId} conflicts with canonical offer.`,
            );
          }
          const canonicalOfferId = text(canonicalOffer.id) as string;
          await this.repointSupplierProduct(duplicateOfferId, canonicalOfferId, transaction);
          await this.destroy(ECOBASE_COLLECTIONS.silverSupplierProducts, duplicateOfferId, transaction);
          offerIdMap.set(duplicateOfferId, canonicalOfferId);
          coalescedOffers += 1;
        } else {
          await this.update(
            ECOBASE_COLLECTIONS.silverSupplierProducts,
            duplicateOfferId,
            { supplierId: canonicalSupplierId },
            transaction,
          );
          offerIdMap.set(duplicateOfferId, duplicateOfferId);
          movedOffers += 1;
        }
      }

      await this.repointByFilter(
        ECOBASE_COLLECTIONS.silverOrders,
        { supplierId: duplicateSupplierId },
        { supplierId: canonicalSupplierId },
        transaction,
      );
      await this.repointByFilter(
        ECOBASE_COLLECTIONS.silverSupplierAccounts,
        { supplierId: duplicateSupplierId },
        { supplierId: canonicalSupplierId },
        transaction,
      );
      await this.repointByFilter(
        ECOBASE_COLLECTIONS.silverSupplierExternalRefs,
        { supplierId: duplicateSupplierId },
        { supplierId: canonicalSupplierId },
        transaction,
      );
      await this.repointByFilter(
        ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
        { preferredSupplierId: duplicateSupplierId },
        { preferredSupplierId: canonicalSupplierId },
        transaction,
      );
      await this.repointByFilter(
        ECOBASE_COLLECTIONS.goldSupplierAttentionRows,
        { supplierId: duplicateSupplierId },
        { supplierId: canonicalSupplierId },
        transaction,
      );
      await this.repointByFilter(
        ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
        { familyPreferredSupplierId: duplicateSupplierId },
        { familyPreferredSupplierId: canonicalSupplierId },
        transaction,
      );
      await this.repointByFilter(
        ECOBASE_COLLECTIONS.goldOrderPlanningRows,
        { supplierId: duplicateSupplierId },
        { supplierId: canonicalSupplierId },
        transaction,
      );
      await this.destroy(ECOBASE_COLLECTIONS.silverSuppliers, duplicateSupplierId, transaction);
    }

    return {
      normalizedName: candidate.normalizedName,
      canonicalSupplierId,
      mergedSupplierCount: candidate.duplicateSupplierIds.length,
      movedOffers,
      coalescedOffers,
      offerIdMap: Object.fromEntries(offerIdMap),
    };
  }

  private async repointSupplierProduct(fromId: string, toId: string, transaction?: unknown) {
    await this.repointByFilter(
      ECOBASE_COLLECTIONS.silverOrderLines,
      { supplierProductId: fromId },
      { supplierProductId: toId },
      transaction,
    );
    const links = await this.rows(
      ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
      { supplierProductId: fromId },
      transaction,
    );
    for (const link of links) {
      const duplicate = await this.repository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).findOne({
        filter: {
          companyProductId: text(link.companyProductId),
          supplierProductId: toId,
          role: text(link.role),
        },
        transaction,
      } as never);
      if (duplicate) {
        await this.destroy(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, text(link.id) as string, transaction);
      } else {
        await this.update(
          ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
          text(link.id) as string,
          { supplierProductId: toId },
          transaction,
        );
      }
    }
    await this.repointByFilter(
      ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
      { preferredSupplierProductId: fromId },
      { preferredSupplierProductId: toId },
      transaction,
    );
    await this.repointByFilter(
      ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
      { familyPreferredSupplierProductId: fromId },
      { familyPreferredSupplierProductId: toId },
      transaction,
    );
  }

  private async repointByFilter(collection: string, filter: PlainRecord, values: PlainRecord, transaction?: unknown) {
    const rows = await this.rows(collection, filter, transaction);
    for (const row of rows) await this.update(collection, text(row.id) as string, values, transaction);
  }

  private async rows(collection: string, filter?: PlainRecord, transaction?: unknown) {
    const rows: PlainRecord[] = [];
    const pageSize = 5000;
    for (let offset = 0; ; offset += pageSize) {
      const page = (
        await this.repository(collection).find({ filter, limit: pageSize, offset, sort: ['id'], transaction } as never)
      ).map(plain);
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  private groupBy(rows: PlainRecord[], field: string) {
    const grouped = new Map<string, PlainRecord[]>();
    for (const row of rows) {
      const key = text(row[field]);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return grouped;
  }

  private repository(collection: string) {
    return this.db.getRepository(collection);
  }

  private update(collection: string, id: string, values: PlainRecord, transaction?: unknown) {
    return this.repository(collection).update({ filterByTk: id, values, transaction } as never);
  }

  private destroy(collection: string, id: string, transaction?: unknown) {
    const repository = this.repository(collection) as MutableRepository;
    if (typeof repository.destroy !== 'function') {
      throw new Error(`EcoBase supplier convergence requires destroy support for ${collection}.`);
    }
    return repository.destroy({ filterByTk: id, transaction });
  }
}
