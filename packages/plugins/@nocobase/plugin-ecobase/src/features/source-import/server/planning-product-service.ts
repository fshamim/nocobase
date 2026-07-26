/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase } from './import-service';

export interface SyncPlanningProductsParams {
  importRunId?: string;
}

export interface ConfirmPlanningProductParams {
  planningProductId: string;
  actorId?: string;
  note?: string;
}

export interface AdjustPlanningProductMappingParams {
  planningProductListingId?: string;
  rawListingNaturalKey?: string;
  targetPlanningProductId?: string;
  targetCompany?: string;
  targetCanonicalAsin?: string;
  targetTitle?: string;
  actorId?: string;
  note?: string;
}

export interface PlanningProductDataParams {
  planningProductId: string;
}

type ListingMatch = {
  sourceConnectionId: string;
  company: string;
  canonicalAsin: string;
  asin: string;
  sku?: string;
  title?: string;
  rawListingNaturalKey: string;
  lastImportRunId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value) && typeof value.toJSON === 'function') {
    const json = value.toJSON();
    if (isRecord(json)) {
      return json;
    }
  }
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asDate() {
  return new Date();
}

function canonicalAsin(value: unknown): string | undefined {
  const text = asString(value);
  return text ? text.toUpperCase() : undefined;
}

function planningProductNaturalKey(company: string, asin: string) {
  return `${company}:${asin}`;
}

const LISTING_KEY_MAX_LENGTH = 255;
const LISTING_KEY_HASH_LENGTH = 16;

function compactListingKey(value: string) {
  if (value.length <= LISTING_KEY_MAX_LENGTH) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, LISTING_KEY_HASH_LENGTH);
  return `${value.slice(0, LISTING_KEY_MAX_LENGTH - LISTING_KEY_HASH_LENGTH - 1)}:${hash}`;
}

function rawListingNaturalKey(sourceRecordKey: string) {
  return compactListingKey(`silver-listing:${sourceRecordKey}`);
}

function defaultListingNaturalKey(rawListingKey: string) {
  return compactListingKey(`raw-listing:${rawListingKey}`);
}

function auditEntry(action: string, actorId?: string, note?: string, metadata: Record<string, unknown> = {}) {
  return { action, actorId, note, occurredAt: new Date().toISOString(), metadata };
}

function getAuditTrail(record: unknown) {
  const trail = toPlainRecord(record).auditTrail;
  return Array.isArray(trail) ? trail : [];
}

export class EcobasePlanningProductService {
  constructor(private db: EcobaseDatabase) {}

  async syncFromSilverCompanyProducts(params: SyncPlanningProductsParams = {}) {
    const matches = await this.listingMatchesFromSilverCompanyProducts(params);
    const changedProductIds = new Set<string>();

    for (const match of matches) {
      const product = await this.findOrCreateDefaultProduct(match);
      const productId = asString(toPlainRecord(product).id);
      if (!productId) {
        throw new Error(`Ecobase planning product sync failed: product ${match.company}/${match.asin} has no id.`);
      }

      const listing = await this.findOrCreateDefaultMapping(match, productId);
      const listingProductId = asString(toPlainRecord(listing).planningProductId);
      if (listingProductId) {
        changedProductIds.add(listingProductId);
      }
    }

    const products = await this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).find();
    for (const product of products) {
      const productId = asString(toPlainRecord(product).id);
      if (productId) {
        await this.refreshProductStatus(productId);
      }
    }

    return { data: { processedListings: matches.length, changedProductIds: [...changedProductIds] } };
  }

  private async listingMatchesFromSilverCompanyProducts(params: SyncPlanningProductsParams) {
    const [companyProducts, products, companies, links, bronzeRecords] = await Promise.all([
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).find({ limit: 100000 }),
    ]);
    const productById = new Map(
      products.map((product) => [asString(toPlainRecord(product).id), toPlainRecord(product)]),
    );
    const companyById = new Map(
      companies.map((company) => [asString(toPlainRecord(company).id), toPlainRecord(company)]),
    );
    const bronzeById = new Map(
      bronzeRecords.map((record) => [asString(toPlainRecord(record).id), toPlainRecord(record)]),
    );
    const linkByEntityId = new Map<string, Record<string, unknown>>();
    for (const link of links.map(toPlainRecord)) {
      if (params.importRunId && asString(link.importRunId) !== params.importRunId) continue;
      const entityId = asString(link.silverEntityId);
      if (entityId && !linkByEntityId.has(entityId)) linkByEntityId.set(entityId, link);
    }

    return companyProducts
      .map(toPlainRecord)
      .map((companyProduct): ListingMatch | null => {
        const product = productById.get(asString(companyProduct.productId));
        const company = companyById.get(asString(companyProduct.companyId));
        const companyName = asString(company?.name);
        const asin = canonicalAsin(product?.asin);
        if (!companyName || !asin) return null;
        const evidenceLink =
          linkByEntityId.get(asString(companyProduct.id) ?? '') ?? linkByEntityId.get(asString(product?.id) ?? '');
        if (params.importRunId && !evidenceLink) return null;
        const bronze = bronzeById.get(asString(evidenceLink?.bronzeRecordId) ?? '');
        const sourceRecordKey =
          asString(evidenceLink?.sourceRecordKey) ?? `${companyName}:${asin}:${asString(product?.sku) ?? ''}`;
        return {
          sourceConnectionId:
            asString(bronze?.sourceConnectionId) ?? asString(companyProduct.amazonAccountId) ?? 'medallion',
          company: companyName,
          canonicalAsin: asin,
          asin,
          sku: asString(product?.sku),
          title: asString(product?.title),
          rawListingNaturalKey: rawListingNaturalKey(sourceRecordKey),
          lastImportRunId: asString(evidenceLink?.importRunId),
        };
      })
      .filter((match): match is ListingMatch => Boolean(match))
      .sort((left, right) =>
        [left.company, left.asin, left.sku ?? '']
          .join(':')
          .localeCompare([right.company, right.asin, right.sku ?? ''].join(':')),
      );
  }

  async listDuplicateMappings() {
    const productRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const listingRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings);
    const products = await productRepo.find({ sort: ['company', 'canonicalAsin'] });
    const rows = [];

    for (const product of products) {
      const plainProduct = toPlainRecord(product);
      const productId = asString(plainProduct.id);
      if (!productId) {
        continue;
      }
      const listings = (await listingRepo.find({ filter: { planningProductId: productId }, sort: ['sku'] })).map(
        toPlainRecord,
      );
      const mappingStatus = asString(plainProduct.mappingStatus) ?? 'auto_mapped';
      if (listings.length < 2 && mappingStatus !== 'needs_review') {
        continue;
      }
      rows.push({
        planningProductId: productId,
        naturalKey: plainProduct.naturalKey,
        company: plainProduct.company,
        canonicalAsin: plainProduct.canonicalAsin,
        title: plainProduct.title,
        mappingStatus,
        listingCount: listings.length,
        listings: listings.map((listing) => ({
          planningProductListingId: listing.id,
          rawListingNaturalKey: listing.rawListingNaturalKey,
          sku: listing.sku,
          title: listing.title,
          sourceConnectionId: listing.sourceConnectionId,
          mappingMode: listing.mappingMode,
          mappingStatus: listing.mappingStatus,
          mappedAt: listing.mappedAt,
        })),
      });
    }

    return rows;
  }

  async confirmPlanningProduct(params: ConfirmPlanningProductParams) {
    const productId = asString(params.planningProductId);
    if (!productId) {
      throw new Error('Ecobase planning mapping confirmation failed: planningProductId is required.');
    }

    const productRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const listingRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings);
    const product = await productRepo.findOne({ filterByTk: productId });
    if (!product) {
      throw new Error(`Ecobase planning mapping confirmation failed: planning product "${productId}" was not found.`);
    }

    const now = asDate();
    await productRepo.update({
      filterByTk: productId,
      values: {
        mappingStatus: 'confirmed',
        confirmedAt: now,
        confirmedBy: params.actorId,
        auditSummary: auditEntry('confirmed', params.actorId, params.note),
      },
    });

    const listings = await listingRepo.find({ filter: { planningProductId: productId } });
    for (const listing of listings) {
      const listingId = asString(toPlainRecord(listing).id);
      if (!listingId) {
        throw new Error(`Ecobase planning mapping confirmation failed: listing for product "${productId}" has no id.`);
      }
      const trail = [...getAuditTrail(listing), auditEntry('confirmed', params.actorId, params.note)];
      await listingRepo.update({ filterByTk: listingId, values: { mappingStatus: 'confirmed', auditTrail: trail } });
      await this.createAudit({
        planningProductId: productId,
        planningProductListingId: listingId,
        rawListingNaturalKey: asString(toPlainRecord(listing).rawListingNaturalKey) ?? '(missing raw listing key)',
        action: 'confirmed',
        previousPlanningProductId: productId,
        nextPlanningProductId: productId,
        actorId: params.actorId,
        note: params.note,
      });
    }

    return toPlainRecord((await productRepo.findOne({ filterByTk: productId })) ?? product);
  }

  async adjustMapping(params: AdjustPlanningProductMappingParams) {
    const listing = await this.findMappingForAdjustment(params);
    const listingPlain = toPlainRecord(listing);
    const listingId = asString(listingPlain.id);
    if (!listingId) {
      throw new Error('Ecobase planning mapping adjustment failed: mapping record is missing id.');
    }

    const previousPlanningProductId = asString(listingPlain.planningProductId);
    const targetProduct = await this.findOrCreateAdjustmentTarget(params, listingPlain);
    const targetPlanningProductId = asString(toPlainRecord(targetProduct).id);
    if (!targetPlanningProductId) {
      throw new Error('Ecobase planning mapping adjustment failed: target planning product has no id.');
    }

    const now = asDate();
    const rawListingNaturalKey = asString(listingPlain.rawListingNaturalKey) ?? '(missing raw listing key)';
    const trail = [
      ...getAuditTrail(listing),
      auditEntry('adjusted', params.actorId, params.note, { previousPlanningProductId, targetPlanningProductId }),
    ];
    await this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).update({
      filterByTk: listingId,
      values: {
        planningProductId: targetPlanningProductId,
        mappingMode: 'manual',
        mappingStatus: 'adjusted',
        mappedAt: now,
        mappedBy: params.actorId,
        auditTrail: trail,
      },
    });

    await this.createAudit({
      planningProductId: targetPlanningProductId,
      planningProductListingId: listingId,
      rawListingNaturalKey,
      action: 'adjusted',
      previousPlanningProductId,
      nextPlanningProductId: targetPlanningProductId,
      actorId: params.actorId,
      note: params.note,
    });

    await this.refreshProductStatus(targetPlanningProductId);
    if (previousPlanningProductId && previousPlanningProductId !== targetPlanningProductId) {
      await this.refreshProductStatus(previousPlanningProductId);
    }
    return toPlainRecord(
      (await this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).findOne({ filterByTk: listingId })) ??
        listing,
    );
  }

  async getPlanningProductData(params: PlanningProductDataParams) {
    const planningProductId = asString(params.planningProductId);
    if (!planningProductId) {
      throw new Error('Ecobase planning product data query failed: planningProductId is required.');
    }

    const product = await this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).findOne({
      filterByTk: planningProductId,
    });
    if (!product) {
      throw new Error(
        `Ecobase planning product data query failed: planning product "${planningProductId}" was not found.`,
      );
    }

    const listings = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).find({
        filter: { planningProductId },
        sort: ['sku'],
      })
    ).map(toPlainRecord);
    const silverFacts = await this.silverFactsForPlanningListings(toPlainRecord(product), listings);

    return {
      product: toPlainRecord(product),
      listings,
      inventorySnapshots: silverFacts.inventorySnapshots,
      listingDailyFacts: silverFacts.listingDailyFacts,
      mappingAudits: (
        await this.db.getRepository(ECOBASE_COLLECTIONS.planningProductMappingAudits).find({
          filter: { nextPlanningProductId: planningProductId },
          sort: ['occurredAt'],
        })
      ).map(toPlainRecord),
    };
  }

  private async silverFactsForPlanningListings(product: Record<string, unknown>, listings: Record<string, unknown>[]) {
    const [silverProducts, companyProducts, inventorySnapshots, listingDailyFacts] = await Promise.all([
      this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).find({ limit: 100000 }),
    ]);
    const productByListingKey = new Map(
      silverProducts.map((silverProduct) => {
        const plain = toPlainRecord(silverProduct);
        return [`${canonicalAsin(plain.asin) ?? ''}:${asString(plain.sku) ?? ''}`, plain];
      }),
    );
    const listingByCompanyProductId = new Map<string, Record<string, unknown>>();
    for (const listing of listings) {
      const silverProduct = productByListingKey.get(
        `${canonicalAsin(listing.asin) ?? ''}:${asString(listing.sku) ?? ''}`,
      );
      const silverProductId = asString(silverProduct?.id);
      const companyProduct = companyProducts
        .map(toPlainRecord)
        .find((row) => asString(row.productId) === silverProductId);
      const companyProductId = asString(companyProduct?.id);
      if (companyProductId) listingByCompanyProductId.set(companyProductId, listing);
    }
    return {
      inventorySnapshots: inventorySnapshots
        .map(toPlainRecord)
        .filter((row) => listingByCompanyProductId.has(asString(row.companyProductId) ?? ''))
        .map((row) => {
          const listing = listingByCompanyProductId.get(asString(row.companyProductId) ?? '') ?? {};
          return {
            ...row,
            planningProductId: product.id,
            company: product.company,
            asin: listing.asin,
            sku: listing.sku,
            stock: row.sellableStock,
          };
        }),
      listingDailyFacts: listingDailyFacts
        .map(toPlainRecord)
        .filter((row) => listingByCompanyProductId.has(asString(row.companyProductId) ?? ''))
        .map((row) => {
          const listing = listingByCompanyProductId.get(asString(row.companyProductId) ?? '') ?? {};
          return {
            ...row,
            planningProductId: product.id,
            company: product.company,
            asin: listing.asin,
            sku: listing.sku,
          };
        }),
    };
  }

  private async findOrCreateDefaultProduct(match: ListingMatch) {
    const productRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const naturalKey = planningProductNaturalKey(match.company, match.canonicalAsin);
    const existing = await productRepo.findOne({ filter: { naturalKey } });
    if (existing) {
      const existingId = asString(toPlainRecord(existing).id);
      if (!existingId) {
        throw new Error(`Ecobase planning product sync failed: existing product "${naturalKey}" has no id.`);
      }
      await productRepo.update({
        filterByTk: existingId,
        values: {
          title: asString(toPlainRecord(existing).title) ?? match.title,
          lastImportRunId: match.lastImportRunId,
        },
      });
      return (await productRepo.findOne({ filterByTk: existingId })) ?? existing;
    }

    return productRepo.create({
      values: {
        naturalKey,
        company: match.company,
        canonicalAsin: match.canonicalAsin,
        title: match.title,
        mappingStatus: 'auto_mapped',
        listingCount: 0,
        lastImportRunId: match.lastImportRunId,
        auditSummary: auditEntry('default_created', undefined, undefined, {
          rawListingNaturalKey: match.rawListingNaturalKey,
        }),
      },
    });
  }

  private async findOrCreateDefaultMapping(match: ListingMatch, productId: string) {
    const listingRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings);
    const existing = await listingRepo.findOne({ filter: { rawListingNaturalKey: match.rawListingNaturalKey } });
    if (existing) {
      const existingPlain = toPlainRecord(existing);
      const existingId = asString(existingPlain.id);
      if (!existingId) {
        throw new Error(
          `Ecobase planning product sync failed: existing mapping "${match.rawListingNaturalKey}" has no id.`,
        );
      }
      if (existingPlain.mappingMode === 'manual') {
        return existing;
      }
      await listingRepo.update({
        filterByTk: existingId,
        values: {
          planningProductId: productId,
          company: match.company,
          canonicalAsin: match.canonicalAsin,
          asin: match.asin,
          sku: match.sku,
          title: match.title,
          lastImportRunId: match.lastImportRunId,
        },
      });
      return (await listingRepo.findOne({ filterByTk: existingId })) ?? existing;
    }

    const created = await listingRepo.create({
      values: {
        naturalKey: defaultListingNaturalKey(match.rawListingNaturalKey),
        planningProductId: productId,
        rawListingNaturalKey: match.rawListingNaturalKey,
        sourceConnectionId: match.sourceConnectionId,
        company: match.company,
        canonicalAsin: match.canonicalAsin,
        asin: match.asin,
        sku: match.sku,
        title: match.title,
        mappingMode: 'default',
        mappingStatus: 'auto_mapped',
        mappedAt: asDate(),
        lastImportRunId: match.lastImportRunId,
        auditTrail: [auditEntry('default_created', undefined, undefined, { planningProductId: productId })],
      },
    });
    const createdId = asString(toPlainRecord(created).id);
    if (createdId) {
      await this.createAudit({
        planningProductId: productId,
        planningProductListingId: createdId,
        rawListingNaturalKey: match.rawListingNaturalKey,
        action: 'default_created',
        nextPlanningProductId: productId,
        metadata: { company: match.company, canonicalAsin: match.canonicalAsin, sku: match.sku },
      });
    }
    return created;
  }

  private async findMappingForAdjustment(params: AdjustPlanningProductMappingParams) {
    const listingRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings);
    const planningProductListingId = asString(params.planningProductListingId);
    if (planningProductListingId) {
      const listing = await listingRepo.findOne({ filterByTk: planningProductListingId });
      if (!listing) {
        throw new Error(
          `Ecobase planning mapping adjustment failed: mapping "${planningProductListingId}" was not found.`,
        );
      }
      return listing;
    }

    const rawListingNaturalKey = asString(params.rawListingNaturalKey);
    if (!rawListingNaturalKey) {
      throw new Error(
        'Ecobase planning mapping adjustment failed: planningProductListingId or rawListingNaturalKey is required.',
      );
    }
    const listing = await listingRepo.findOne({ filter: { rawListingNaturalKey } });
    if (!listing) {
      throw new Error(
        `Ecobase planning mapping adjustment failed: mapping for raw listing "${rawListingNaturalKey}" was not found.`,
      );
    }
    return listing;
  }

  private async findOrCreateAdjustmentTarget(
    params: AdjustPlanningProductMappingParams,
    listing: Record<string, unknown>,
  ) {
    const productRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const targetPlanningProductId = asString(params.targetPlanningProductId);
    if (targetPlanningProductId) {
      const target = await productRepo.findOne({ filterByTk: targetPlanningProductId });
      if (!target) {
        throw new Error(
          `Ecobase planning mapping adjustment failed: target planning product "${targetPlanningProductId}" was not found.`,
        );
      }
      return target;
    }

    const company = asString(params.targetCompany) ?? asString(listing.company);
    const asin =
      canonicalAsin(params.targetCanonicalAsin) ?? canonicalAsin(listing.canonicalAsin) ?? canonicalAsin(listing.asin);
    if (!company || !asin) {
      throw new Error(
        'Ecobase planning mapping adjustment failed: targetPlanningProductId or targetCompany plus targetCanonicalAsin is required.',
      );
    }

    return productRepo.create({
      values: {
        naturalKey: `manual:${company}:${asin}:${randomUUID()}`,
        company,
        canonicalAsin: asin,
        title: asString(params.targetTitle) ?? asString(listing.title),
        mappingStatus: 'confirmed',
        listingCount: 0,
        auditSummary: auditEntry('manual_product_created', params.actorId, params.note),
      },
    });
  }

  private async refreshProductStatus(planningProductId: string) {
    const productRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const listingRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings);
    const product = await productRepo.findOne({ filterByTk: planningProductId });
    if (!product) {
      return;
    }

    const productPlain = toPlainRecord(product);
    const listings = await listingRepo.find({ filter: { planningProductId } });
    const productAlreadyConfirmed = productPlain.mappingStatus === 'confirmed';
    const hasManualListings = listings.some((listing) => toPlainRecord(listing).mappingMode === 'manual');
    const mappingStatus =
      productAlreadyConfirmed || hasManualListings ? 'confirmed' : listings.length > 1 ? 'needs_review' : 'auto_mapped';

    await productRepo.update({
      filterByTk: planningProductId,
      values: { listingCount: listings.length, mappingStatus },
    });

    for (const listing of listings) {
      const listingPlain = toPlainRecord(listing);
      const listingId = asString(listingPlain.id);
      if (!listingId || listingPlain.mappingMode === 'manual' || listingPlain.mappingStatus === 'confirmed') {
        continue;
      }
      await listingRepo.update({
        filterByTk: listingId,
        values: { mappingStatus: listings.length > 1 ? 'needs_review' : 'auto_mapped' },
      });
    }
  }

  private async createAudit(values: {
    planningProductId?: string;
    planningProductListingId?: string;
    rawListingNaturalKey: string;
    action: string;
    previousPlanningProductId?: string;
    nextPlanningProductId?: string;
    actorId?: string;
    note?: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.db.getRepository(ECOBASE_COLLECTIONS.planningProductMappingAudits).create({
      values: { ...values, occurredAt: asDate(), metadata: values.metadata ?? {} },
    });
  }
}
