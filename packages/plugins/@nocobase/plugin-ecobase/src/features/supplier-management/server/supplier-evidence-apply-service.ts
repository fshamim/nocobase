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

import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { normalizeSupplierName } from '../../semantic-model/server/medallion-identity-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import {
  buildSupplierEvidenceBackfillPlan,
  type SupplierEvidenceFiles,
  type SupplierEvidenceMaster,
  type SupplierEvidenceSelection,
  type SupplierEvidenceSnapshot,
} from './supplier-evidence-backfill-service';

type PlainRecord = Record<string, unknown>;
type MutableRepository = EcobaseRepository & { destroy?(params: Record<string, unknown>): Promise<unknown> };

function plain(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const record = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function text(value: unknown) {
  const result = String(value ?? '').trim();
  return result || undefined;
}

function repositoryParams(values: PlainRecord, transaction?: unknown) {
  return transaction ? ({ ...values, transaction } as never) : (values as never);
}

function sameSelection(family: PlainRecord, supplierId: string, selection: SupplierEvidenceSelection) {
  const evidence = plain(family.supplierSelectionEvidenceJson);
  return (
    text(family.preferredSupplierId) === supplierId &&
    text(family.supplierSelectionSource) === selection.source &&
    text(evidence.ruleVersion) === selection.evidence.ruleVersion &&
    text(evidence.supplierExternalRef) === selection.supplierRef &&
    Number(evidence.sourceRowNumber) === selection.evidence.sourceRowNumber
  );
}

export function supplierEvidenceConfirmationToken(decisionDigest: string) {
  return `APPLY_SUPPLIER_EVIDENCE_${decisionDigest.slice(0, 12).toUpperCase()}`;
}

export class EcobaseSupplierEvidenceApplyService {
  constructor(private db: EcobaseDatabase) {}

  async preview(files: SupplierEvidenceFiles) {
    return buildSupplierEvidenceBackfillPlan({ snapshot: await this.snapshot(), files }).preview;
  }

  async apply(params: { files: SupplierEvidenceFiles; decisionDigest: string; confirmation: string }) {
    const snapshot = await this.snapshot();
    const plan = buildSupplierEvidenceBackfillPlan({ snapshot, files: params.files });
    const expectedDigest = plan.preview.decisionDigest;
    if (params.decisionDigest !== expectedDigest) {
      throw new Error(
        `Supplier evidence apply blocked: decision digest changed (expected ${expectedDigest}, received ${params.decisionDigest}).`,
      );
    }
    const expectedConfirmation = supplierEvidenceConfirmationToken(expectedDigest);
    if (params.confirmation !== expectedConfirmation) {
      throw new Error(`Supplier evidence apply blocked: confirmation must equal ${expectedConfirmation}.`);
    }

    const execute = async (transaction?: unknown) => {
      const result = {
        decisionDigest: expectedDigest,
        selectedFamilyCount: plan.selections.length,
        changedFamilyCount: 0,
        unchangedFamilyCount: 0,
        createdSupplierCount: 0,
        createdExternalRefCount: 0,
        createdSupplierAccountCount: 0,
        createdCandidateLinkCount: 0,
        candidateLinkSkippedNoOfferCount: 0,
        fabricatedSupplierProductCount: 0,
        goldRefreshCount: 0,
      };
      const supplierByRef = new Map<string, string>();
      for (const selection of plan.selections) {
        let supplierId = supplierByRef.get(selection.supplierRef);
        if (!supplierId) {
          const resolved = await this.ensureSupplier(
            selection.supplierRef,
            plan.masterByRef.get(selection.supplierRef),
            transaction,
          );
          supplierId = resolved.supplierId;
          result.createdSupplierCount += resolved.createdSupplier ? 1 : 0;
          result.createdExternalRefCount += resolved.createdExternalRef ? 1 : 0;
          supplierByRef.set(selection.supplierRef, supplierId);
        }
        const family = plain(
          await this.repo(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).findOne(
            repositoryParams({ filterByTk: selection.familyId }, transaction),
          ),
        );
        if (!text(family.id)) {
          throw new Error(`Supplier evidence apply failed: family ${selection.familyId} no longer exists.`);
        }
        if (text(family.companyId) !== selection.companyId) {
          throw new Error(`Supplier evidence apply failed: family ${selection.familyId} changed company boundary.`);
        }
        if (['operator', 'latest_valid_order'].includes(text(family.supplierSelectionSource) ?? '')) {
          throw new Error(
            `Supplier evidence apply failed: family ${selection.familyId} gained higher-authority evidence.`,
          );
        }
        const accountCreated = await this.ensureSupplierAccount(
          supplierId,
          selection.companyId,
          plan.masterByRef.get(selection.supplierRef)?.displayName,
          transaction,
        );
        result.createdSupplierAccountCount += accountCreated ? 1 : 0;

        if (sameSelection(family, supplierId, selection)) {
          result.unchangedFamilyCount += 1;
        } else {
          await this.repo(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).update(
            repositoryParams(
              {
                filterByTk: selection.familyId,
                values: {
                  preferredSupplierId: supplierId,
                  preferredSupplierProductId: null,
                  supplierSelectionSource: selection.source,
                  supplierSelectedAt: new Date().toISOString(),
                  supplierSelectedByUserId: null,
                  supplierReviewRequired: false,
                  supplierSelectionEvidenceJson: {
                    ...selection.evidence,
                    selectionSource: selection.source,
                    decisionDigest: expectedDigest,
                  },
                },
              },
              transaction,
            ),
          );
          result.changedFamilyCount += 1;
        }

        const links = await this.ensureCandidateLinks(selection.familyId, supplierId, transaction);
        result.createdCandidateLinkCount += links.created;
        result.candidateLinkSkippedNoOfferCount += links.skippedNoOffer;
      }
      return result;
    };

    return this.db.sequelize?.transaction
      ? this.db.sequelize.transaction((transaction: unknown) => execute(transaction))
      : execute();
  }

  async verifyIdempotency(params: { files: SupplierEvidenceFiles; decisionDigest: string; confirmation: string }) {
    const first = await this.apply(params);
    const second = await this.apply(params);
    if (
      second.changedFamilyCount !== 0 ||
      second.createdSupplierCount !== 0 ||
      second.createdExternalRefCount !== 0 ||
      second.createdSupplierAccountCount !== 0 ||
      second.createdCandidateLinkCount !== 0
    ) {
      throw new Error(`Supplier evidence idempotency failed: second apply changed ${JSON.stringify(second)}.`);
    }
    return { first, second, idempotent: true };
  }

  private async snapshot(): Promise<SupplierEvidenceSnapshot> {
    const rows = async (collection: string) => (await this.repo(collection).find({ limit: 100000 })).map(plain);
    const [companies, products, companyProducts, families, supplierExternalRefs] = await Promise.all([
      rows(ECOBASE_COLLECTIONS.silverCompanies),
      rows(ECOBASE_COLLECTIONS.silverProducts),
      rows(ECOBASE_COLLECTIONS.silverCompanyProducts),
      rows(ECOBASE_COLLECTIONS.silverCompanyProductFamilies),
      rows(ECOBASE_COLLECTIONS.silverSupplierExternalRefs),
    ]);
    return {
      companies: companies.map((row) => ({ id: text(row.id) as string, name: text(row.name) as string })),
      products: products.map((row) => ({ id: text(row.id) as string, asin: text(row.asin), sku: text(row.sku) })),
      companyProducts: companyProducts.map((row) => ({
        id: text(row.id) as string,
        companyId: text(row.companyId) as string,
        amazonAccountId: text(row.amazonAccountId) as string,
        productId: text(row.productId) as string,
        familyId: text(row.companyProductFamilyId),
      })),
      families: families.map((row) => ({
        id: text(row.id) as string,
        companyId: text(row.companyId) as string,
        amazonAccountId: text(row.amazonAccountId) as string,
        marketplace: text(row.marketplace) as string,
        asin: text(row.canonicalAsin) as string,
        preferredSupplierId: text(row.preferredSupplierId),
        supplierSelectionSource: text(row.supplierSelectionSource),
      })),
      supplierExternalRefs: supplierExternalRefs.map((row) => ({
        supplierId: text(row.supplierId) as string,
        sourceSystem: text(row.sourceSystem) as string,
        normalizedExternalSupplierCode: text(row.normalizedExternalSupplierCode) as string,
      })),
    };
  }

  private async ensureSupplier(supplierRef: string, master: SupplierEvidenceMaster | undefined, transaction?: unknown) {
    const refRepository = this.repo(ECOBASE_COLLECTIONS.silverSupplierExternalRefs);
    const existingRef = plain(
      await refRepository.findOne(
        repositoryParams(
          { filter: { sourceSystem: 'supplier_ids', normalizedExternalSupplierCode: supplierRef } },
          transaction,
        ),
      ),
    );
    const existingSupplierId = text(existingRef.supplierId);
    if (existingSupplierId) {
      const supplier = await this.repo(ECOBASE_COLLECTIONS.silverSuppliers).findOne(
        repositoryParams({ filterByTk: existingSupplierId }, transaction),
      );
      if (!supplier) throw new Error(`Supplier evidence apply failed: ${supplierRef} points to a missing supplier.`);
      return { supplierId: existingSupplierId, createdSupplier: false, createdExternalRef: false };
    }
    const displayName = text(master?.displayName);
    if (!displayName || !master) {
      throw new Error(`Supplier evidence apply failed: ${supplierRef} has no safe supplier-master display name.`);
    }
    const supplierId = randomUUID();
    await this.repo(ECOBASE_COLLECTIONS.silverSuppliers).create(
      repositoryParams(
        {
          values: {
            id: supplierId,
            normalizedName: normalizeSupplierName(displayName),
            displayName,
            approvalStatus: 'evidence_backfilled',
            analysisStatus: 'historical_order_evidence',
          },
        },
        transaction,
      ),
    );
    await refRepository.create(
      repositoryParams(
        {
          values: {
            id: randomUUID(),
            supplierId,
            sourceSystem: 'supplier_ids',
            externalSupplierCode: supplierRef,
            normalizedExternalSupplierCode: supplierRef,
            displayName,
            normalizedName: normalizeSupplierName(displayName),
            lastSeenAt: new Date().toISOString(),
            payload: {
              ruleVersion: 'supplier-evidence-v1',
              sourceFileSha256: master.sourceFileSha256,
              sourceRowNumber: master.sourceRowNumber,
            },
          },
        },
        transaction,
      ),
    );
    return { supplierId, createdSupplier: true, createdExternalRef: true };
  }

  private async ensureSupplierAccount(
    supplierId: string,
    companyId: string,
    displayName: string | undefined,
    transaction?: unknown,
  ) {
    const repository = this.repo(ECOBASE_COLLECTIONS.silverSupplierAccounts);
    const existing = await repository.findOne(repositoryParams({ filter: { supplierId, companyId } }, transaction));
    if (existing) return false;
    await repository.create(
      repositoryParams(
        {
          values: {
            id: randomUUID(),
            supplierId,
            companyId,
            accountName: displayName ?? supplierId,
            orderingMethod: 'email',
            status: 'active',
          },
        },
        transaction,
      ),
    );
    return true;
  }

  private async ensureCandidateLinks(familyId: string, supplierId: string, transaction?: unknown) {
    const companyProducts = await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).find(
      repositoryParams({ filter: { companyProductFamilyId: familyId }, limit: 10000 }, transaction),
    );
    let created = 0;
    let skippedNoOffer = 0;
    for (const value of companyProducts) {
      const companyProduct = plain(value);
      const companyProductId = text(companyProduct.id);
      const productId = text(companyProduct.productId);
      if (!companyProductId || !productId) continue;
      const supplierProduct = plain(
        await this.repo(ECOBASE_COLLECTIONS.silverSupplierProducts).findOne(
          repositoryParams({ filter: { supplierId, productId } }, transaction),
        ),
      );
      const supplierProductId = text(supplierProduct.id);
      if (!supplierProductId) {
        skippedNoOffer += 1;
        continue;
      }
      const repository = this.repo(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers);
      const filter = { companyProductId, supplierProductId, role: 'candidate' };
      if (await repository.findOne(repositoryParams({ filter }, transaction))) continue;
      await repository.create(repositoryParams({ values: { id: randomUUID(), ...filter } }, transaction));
      created += 1;
    }
    return { created, skippedNoOffer };
  }

  private repo(collection: string) {
    return this.db.getRepository(collection) as MutableRepository;
  }
}
