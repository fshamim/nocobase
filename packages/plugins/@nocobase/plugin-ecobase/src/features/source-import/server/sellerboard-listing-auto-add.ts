/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { EcobaseCompanyProductFamilyService } from '../../semantic-model/server/company-product-family-service';
import { EcobaseMedallionIdentityService } from '../../semantic-model/server/medallion-identity-service';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import type { NewSellerboardListing } from './protected-catalog-boundary';

// A new Sellerboard listing turned into catalog records this run. Surfaced on the run summary so
// the sources page can show an informational "N new listing(s) added" note.
export interface NewlyAddedListing {
  company: string;
  asin: string;
  sku: string;
  marketplace: string;
  title?: string;
}

// Provenance marker written to silverCompanyProducts.lifecycleStatusProvenance so an auto-added
// listing is distinguishable from a canonical-rebuild one.
export const SELLERBOARD_AUTO_ADD_PROVENANCE_KIND = 'sellerboard_auto_add';

/**
 * Creates a catalog record set for a Sellerboard row that carries a valid identity but has no
 * catalog record yet, mirroring exactly the machinery a legitimate catalog import uses
 * (EcobaseMedallionIdentityService for the product + company product, and
 * EcobaseCompanyProductFamilyService for the family). The company product is linked to its family
 * immediately so the refresh's preserve-catalog reconciliation stays a no-op instead of refusing
 * to touch a "protected" family mid-run. Idempotent: the same listing yields exactly one record
 * set because every create goes through an upsert / ensure keyed on the listing's identity.
 */
export class EcobaseSellerboardListingAutoAdd {
  private readonly identity: EcobaseMedallionIdentityService;
  private readonly families: EcobaseCompanyProductFamilyService;

  constructor(private readonly db: EcobaseDatabase) {
    this.identity = new EcobaseMedallionIdentityService(db);
    this.families = new EcobaseCompanyProductFamilyService(db);
  }

  async addListing(listing: NewSellerboardListing): Promise<NewlyAddedListing> {
    // Product: create when the ASIN/SKU is new (title from the report's Name column), else reuse.
    const product = toPlainRecord(
      await this.identity.upsertProduct({
        asin: listing.asin,
        sku: listing.listingSku,
        ...(listing.title ? { title: listing.title } : {}),
      }),
    );

    // Company product: company + account + product, marked active/listed like a normal import.
    const companyProduct = toPlainRecord(
      await this.identity.upsertCompanyProduct({
        companyId: listing.companyId,
        amazonAccountId: listing.amazonAccountId,
        productId: String(product.id),
        lifecycleStatus: 'active',
        listingStatus: 'listed',
      }),
    );

    // Family: attach to the company's existing family for this ASIN, else create a single-member
    // one, then link the company product to it now.
    const family = toPlainRecord(
      await this.families.ensureFamily({
        companyId: listing.companyId,
        amazonAccountId: listing.amazonAccountId,
        marketplace: listing.marketplace,
        canonicalAsin: listing.asin,
      }),
    );
    const familyId = String(family.id);
    if (String(companyProduct.companyProductFamilyId ?? '') !== familyId) {
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
        filterByTk: String(companyProduct.id),
        values: {
          companyProductFamilyId: familyId,
          lifecycleStatusProvenance: {
            kind: SELLERBOARD_AUTO_ADD_PROVENANCE_KIND,
            at: new Date().toISOString(),
          },
        },
      });
    }

    return {
      company: listing.company,
      asin: listing.asin,
      sku: listing.listingSku,
      marketplace: listing.marketplace,
      ...(listing.title ? { title: listing.title } : {}),
    };
  }
}
