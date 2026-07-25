/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { requireCanonicalCompany } from '../../../server/company-identity';
import type { EcobaseDatabase } from './import-service';

interface ProtectedCatalogCounts {
  companies: number;
  amazonAccounts: number;
  companyProducts: number;
  productFamilies: number;
}

const EXPECTED_COUNTS: ProtectedCatalogCounts = {
  companies: 4,
  amazonAccounts: 10,
  companyProducts: 2363,
  productFamilies: 1919,
};

type PlainRecord = Record<string, unknown>;

type ProtectedCatalogRows = {
  companies: PlainRecord[];
  amazonAccounts: PlainRecord[];
  products: PlainRecord[];
  companyProducts: PlainRecord[];
  productFamilies: PlainRecord[];
};

type ProtectedCatalogIndex = {
  companyIdByKey: Map<string, string>;
  productIdByAsinSku: Map<string, string>;
  accountIdByCompanyMarketplace: Map<string, string>;
  accountMarketplaceById: Map<string, string>;
  companyProductKeys: Set<string>;
};

// Amazon ASINs are 10-character uppercase alphanumerics. A row whose ASIN does not match this
// shape is treated as malformed rather than turned into a new catalog record.
const WELL_FORMED_ASIN = /^[A-Z0-9]{10}$/;

export interface ProtectedCatalogReport {
  fingerprint: string;
  readyForRefresh: boolean;
  expectedCounts: ProtectedCatalogCounts;
  actualCounts: ProtectedCatalogCounts;
  drift: {
    companies: number;
    amazonAccounts: number;
    companyProducts: number;
    productFamilies: number;
  };
  companyProductsWithoutFamily: number;
  companyProductsWithMissingFamily: number;
}

/**
 * A Sellerboard listing whose identity is not yet part of the protected catalog. Batch C
 * quarantines these rows (skip + report) instead of aborting the company refresh: the row is
 * left out of the import and surfaced for review, while everything else imports normally. Adding
 * the identity for real still goes through an explicit canonical rebuild.
 */
export interface QuarantinedListingIdentity {
  company: string;
  marketplace: string;
  asin: string;
  listingSku: string;
  missing: string[];
  reasonCode: 'protected_company_product_identity';
}

/**
 * A Sellerboard row for a known company + resolvable default account + well-formed ASIN + SKU that
 * has no catalog record yet. This is a WELCOME new listing, not a problem: the caller creates it
 * through the canonical catalog machinery and then imports its sales data in the same run.
 */
export interface NewSellerboardListing {
  companyId: string;
  company: string;
  amazonAccountId: string;
  marketplace: string;
  asin: string;
  listingSku: string;
  title?: string;
  existingProductId?: string;
}

/**
 * Three-way verdict for a Sellerboard listing row:
 * - `known`: already in the protected catalog (or carries no listing identity) — import untouched.
 * - `new_listing`: valid identity with no catalog record — auto-create, then import its rows.
 * - `malformed`: genuinely unusable (unknown company, invalid ASIN shape, missing SKU, or an
 *   unresolved company/account scaffold) — quarantine for review, never abort the refresh.
 */
export type SellerboardIdentityDisposition =
  | { kind: 'known' }
  | { kind: 'new_listing'; listing: NewSellerboardListing }
  | { kind: 'malformed'; quarantine: QuarantinedListingIdentity };

function plain(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const record = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function text(value: unknown) {
  const result = String(value ?? '').trim();
  return result || undefined;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as PlainRecord)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function identityRows(rows: ProtectedCatalogRows) {
  const sorted = (values: PlainRecord[], fields: string[]) =>
    values
      .map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
      .sort((left, right) => compareText(canonical(left), canonical(right)));
  return {
    companies: sorted(rows.companies, ['id', 'companyKey', 'name']),
    amazonAccounts: sorted(rows.amazonAccounts, ['id', 'companyId', 'name', 'sellerId', 'marketplace', 'isDefault']),
    products: sorted(rows.products, ['id', 'asin', 'sku']),
    companyProducts: sorted(rows.companyProducts, [
      'id',
      'companyId',
      'amazonAccountId',
      'productId',
      'companyProductFamilyId',
    ]),
    productFamilies: sorted(rows.productFamilies, [
      'id',
      'companyId',
      'amazonAccountId',
      'marketplace',
      'canonicalAsin',
    ]),
  };
}

export class EcobaseProtectedCatalogBoundary {
  private rows?: ProtectedCatalogRows;
  private catalogIndex?: ProtectedCatalogIndex;

  constructor(private db: EcobaseDatabase) {}

  async inspect(): Promise<ProtectedCatalogReport> {
    const rows = await this.load();
    const actualCounts = {
      companies: rows.companies.length,
      amazonAccounts: rows.amazonAccounts.length,
      companyProducts: rows.companyProducts.length,
      productFamilies: rows.productFamilies.length,
    };
    const familyIds = new Set(rows.productFamilies.map((row) => text(row.id)).filter(Boolean));
    const companyProductsWithoutFamily = rows.companyProducts.filter((row) => !text(row.companyProductFamilyId)).length;
    const companyProductsWithMissingFamily = rows.companyProducts.filter(
      (row) => text(row.companyProductFamilyId) && !familyIds.has(text(row.companyProductFamilyId)),
    ).length;
    const drift = {
      companies: actualCounts.companies - EXPECTED_COUNTS.companies,
      amazonAccounts: actualCounts.amazonAccounts - EXPECTED_COUNTS.amazonAccounts,
      companyProducts: actualCounts.companyProducts - EXPECTED_COUNTS.companyProducts,
      productFamilies: actualCounts.productFamilies - EXPECTED_COUNTS.productFamilies,
    };
    return {
      fingerprint: digest(identityRows(rows)),
      readyForRefresh:
        Object.values(drift).every((value) => value === 0) &&
        companyProductsWithoutFamily === 0 &&
        companyProductsWithMissingFamily === 0,
      expectedCounts: EXPECTED_COUNTS,
      actualCounts,
      drift,
      companyProductsWithoutFamily,
      companyProductsWithMissingFamily,
    };
  }

  async assertReadyForRefresh() {
    const report = await this.inspect();
    if (!report.readyForRefresh) {
      throw new Error(
        `Ecobase protected catalog preflight failed: companies=${report.actualCounts.companies}/${report.expectedCounts.companies}, amazonAccounts=${report.actualCounts.amazonAccounts}/${report.expectedCounts.amazonAccounts}, companyProducts=${report.actualCounts.companyProducts}/${report.expectedCounts.companyProducts}, productFamilies=${report.actualCounts.productFamilies}/${report.expectedCounts.productFamilies}, companyProductsWithoutFamily=${report.companyProductsWithoutFamily}, companyProductsWithMissingFamily=${report.companyProductsWithMissingFamily}.`,
      );
    }
    return report;
  }

  /**
   * Classify a Sellerboard listing row against the protected catalog without ever throwing. A
   * known identity imports untouched; a valid identity with no catalog record is a new listing the
   * caller auto-creates; a genuinely malformed row (unknown company, invalid ASIN shape, missing
   * SKU, or an unresolved company/account scaffold) is quarantined so the rest of the refresh
   * proceeds.
   */
  async classifySellerboardIdentity(payload: PlainRecord): Promise<SellerboardIdentityDisposition> {
    const companyName = text(payload.company);
    const marketplace = text(payload.marketplace) ?? text(payload.account);
    const asin = text(payload.asin)?.toUpperCase();
    const sku = text(payload.listingSku);
    const title = text(payload.title);

    // A row that carries no listing identity at all is not ours to reshape; pass it through.
    if (!companyName && !marketplace && !asin && !sku) return { kind: 'known' };

    let canonicalName: string;
    let companyKey: string;
    try {
      const canonicalCompany = requireCanonicalCompany(companyName ?? '');
      canonicalName = canonicalCompany.name;
      companyKey = canonicalCompany.companyKey;
    } catch {
      // Unknown company: the whole identity is unresolved -> malformed.
      return this.quarantine(companyName ?? '', marketplace, asin, sku, [
        'company',
        'amazon account',
        'product',
        'company product',
      ]);
    }

    const index = await this.index();
    const companyId = index.companyIdByKey.get(companyKey);
    const productId = asin && sku ? index.productIdByAsinSku.get(`${asin}::${sku.toLowerCase()}`) : undefined;
    const accountId =
      companyId && marketplace
        ? index.accountIdByCompanyMarketplace.get(`${companyId}::${marketplace.toLowerCase()}`)
        : undefined;
    const companyProductExists =
      companyId && accountId && productId
        ? index.companyProductKeys.has(`${companyId}::${accountId}::${productId}`)
        : false;
    if (companyId && accountId && productId && companyProductExists) return { kind: 'known' };

    // A well-formed listing for a known company + resolvable default account, with a well-formed
    // ASIN and a SKU, is a WELCOME new listing -> auto-create through the canonical machinery.
    if (companyId && accountId && sku && asin && WELL_FORMED_ASIN.test(asin)) {
      return {
        kind: 'new_listing',
        listing: {
          companyId,
          company: canonicalName,
          amazonAccountId: accountId,
          marketplace: index.accountMarketplaceById.get(accountId) ?? marketplace ?? '',
          asin,
          listingSku: sku,
          ...(title ? { title } : {}),
          ...(productId ? { existingProductId: productId } : {}),
        },
      };
    }

    // Invalid ASIN shape, missing SKU, or an unresolved company/account scaffold -> quarantine.
    return this.quarantine(
      canonicalName,
      marketplace,
      asin,
      sku,
      [
        !companyId && 'company',
        !accountId && 'amazon account',
        !productId && 'product',
        !companyProductExists && 'company product',
      ].filter((value): value is string => Boolean(value)),
    );
  }

  private quarantine(
    company: string,
    marketplace: string | undefined,
    asin: string | undefined,
    listingSku: string | undefined,
    missing: string[],
  ): { kind: 'malformed'; quarantine: QuarantinedListingIdentity } {
    return {
      kind: 'malformed',
      quarantine: {
        company,
        marketplace: marketplace ?? '',
        asin: asin ?? '',
        listingSku: listingSku ?? '',
        missing,
        reasonCode: 'protected_company_product_identity',
      },
    };
  }

  private async index(): Promise<ProtectedCatalogIndex> {
    if (this.catalogIndex) return this.catalogIndex;
    const rows = await this.load();
    this.catalogIndex = {
      companyIdByKey: new Map(
        rows.companies.flatMap<[string, string]>((row) => {
          const companyKey = text(row.companyKey);
          const id = text(row.id);
          return companyKey && id ? [[companyKey, id]] : [];
        }),
      ),
      productIdByAsinSku: new Map(
        rows.products.flatMap<[string, string]>((row) => {
          const asin = text(row.asin)?.toUpperCase();
          const sku = text(row.sku)?.toLowerCase();
          const id = text(row.id);
          return asin && sku && id ? [[`${asin}::${sku}`, id]] : [];
        }),
      ),
      accountIdByCompanyMarketplace: new Map(
        rows.amazonAccounts.flatMap<[string, string]>((row) => {
          const companyId = text(row.companyId);
          const marketplace = text(row.marketplace)?.toLowerCase();
          const id = text(row.id);
          return companyId && marketplace && id && row.isDefault === true ? [[`${companyId}::${marketplace}`, id]] : [];
        }),
      ),
      accountMarketplaceById: new Map(
        rows.amazonAccounts.flatMap<[string, string]>((row) => {
          const id = text(row.id);
          const marketplace = text(row.marketplace);
          return id && marketplace ? [[id, marketplace]] : [];
        }),
      ),
      companyProductKeys: new Set(
        rows.companyProducts.flatMap((row) => {
          const companyId = text(row.companyId);
          const accountId = text(row.amazonAccountId);
          const productId = text(row.productId);
          return companyId && accountId && productId ? [`${companyId}::${accountId}::${productId}`] : [];
        }),
      ),
    };
    return this.catalogIndex;
  }

  private async load(): Promise<ProtectedCatalogRows> {
    if (this.rows) return this.rows;
    const all = async (collection: string) =>
      (await this.db.getRepository(collection).find({ limit: 100000 })).map(plain);
    const [companies, amazonAccounts, products, companyProducts, productFamilies] = await Promise.all([
      all(ECOBASE_COLLECTIONS.silverCompanies),
      all(ECOBASE_COLLECTIONS.silverAmazonAccounts),
      all(ECOBASE_COLLECTIONS.silverProducts),
      all(ECOBASE_COLLECTIONS.silverCompanyProducts),
      all(ECOBASE_COLLECTIONS.silverCompanyProductFamilies),
    ]);
    this.rows = { companies, amazonAccounts, products, companyProducts, productFamilies };
    return this.rows;
  }
}
