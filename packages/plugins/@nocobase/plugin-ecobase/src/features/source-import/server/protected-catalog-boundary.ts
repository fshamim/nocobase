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
  amazonAccounts: 6,
  companyProducts: 2136,
  productFamilies: 1780,
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
  companyProductKeys: Set<string>;
};

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

function plain(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const record = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function text(value: unknown) {
  const result = String(value ?? '').trim();
  return result || undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as PlainRecord)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
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
      .sort((left, right) => canonical(left).localeCompare(canonical(right)));
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

  async assertExistingSellerboardIdentity(payload: PlainRecord) {
    const companyName = text(payload.company);
    const marketplace = text(payload.marketplace) ?? text(payload.account);
    const asin = text(payload.asin)?.toUpperCase();
    const sku = text(payload.listingSku);
    if (!companyName || !marketplace || !asin || !sku) return;

    const index = await this.index();
    const canonicalCompany = requireCanonicalCompany(companyName);
    const companyId = index.companyIdByKey.get(canonicalCompany.companyKey);
    const productId = index.productIdByAsinSku.get(`${asin}::${sku.toLowerCase()}`);
    const accountId = companyId
      ? index.accountIdByCompanyMarketplace.get(`${companyId}::${marketplace.toLowerCase()}`)
      : undefined;
    const companyProduct =
      companyId && accountId && productId
        ? index.companyProductKeys.has(`${companyId}::${accountId}::${productId}`)
        : false;
    if (!companyId || !productId || !accountId || !companyProduct) {
      const missing = [
        !companyId && 'company',
        !accountId && 'amazon account',
        !productId && 'product',
        !companyProduct && 'company product',
      ].filter(Boolean);
      throw new Error(
        `Ecobase Sellerboard refresh preflight failed: ${
          canonicalCompany.name
        }/${marketplace}/${asin}/${sku} would create protected ${missing.join(
          ', ',
        )} identity. Run an explicit canonical rebuild instead.`,
      );
    }
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
