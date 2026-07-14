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
import type { CsvSourceFile } from './adapters/csv-utils';
import { parseDelimitedCsv } from './adapters/csv-utils';
import { FOUR_COMPANY_MIGRATION_PROFILE } from './four-company-migration-profile';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import { projectSourceRecord } from './source-record-projection';
import { resolveMigrationCompany } from './source-scope-policy';

export type SellerboardCostStatus = 'exact' | 'asin_unique' | 'asin_same_cost' | 'ambiguous' | 'missing';

export interface SellerboardCostResolution {
  unitCost?: number;
  unitCostStatus: SellerboardCostStatus;
  unitCostSource?: string;
  estimatedOrderCost?: number;
}

type PlainRecord = Record<string, unknown>;

type CostRecord = {
  company?: string;
  asin?: string;
  sku?: string;
  unitCost?: number;
  sourceFile?: string;
  title?: string;
  costPeriodStartDate?: string;
  marketplace?: string;
};

type CogsFileSummary = {
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  hiddenSkippedCount: number;
  droppedFieldCount: number;
};

const COMPANY_NAME_BY_KEY = Object.fromEntries(
  FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.map((company) => [company.companyKey, company.name]),
) as Record<string, string>;
const COMPANY_BY_FILE_PREFIX = Object.fromEntries(
  Object.entries(FOUR_COMPANY_MIGRATION_PROFILE.sellerboardCompanyFilePrefixes).map(([prefix, companyKey]) => [
    prefix,
    COMPANY_NAME_BY_KEY[companyKey],
  ]),
) as Record<string, string>;

function normalizeAsin(value: unknown) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizeSku(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCompany(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseSellerboardNumber(value: string | undefined) {
  if (!value) return undefined;
  let normalized = value.trim().replace(/[$€£\s]/g, '');
  if (!normalized || normalized === '-' || normalized === '—') return undefined;
  const negative = normalized.startsWith('(') && normalized.endsWith(')');
  normalized = normalized.replace(/[()]/g, '');
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized =
      normalized.lastIndexOf(',') > normalized.lastIndexOf('.')
        ? normalized.replace(/\./g, '').replace(',', '.')
        : normalized.replace(/,/g, '');
  } else if (normalized.includes(',')) {
    const parts = normalized.split(',');
    const lastPart = parts[parts.length - 1] ?? '';
    normalized =
      lastPart.length > 0 && lastPart.length <= 2
        ? `${parts.slice(0, -1).join('')}.${lastPart}`
        : normalized.replace(/,/g, '');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : undefined;
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function parseSellerboardDate(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return trimmed;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) return undefined;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  const day = second > 12 ? second : first;
  const month = second > 12 ? first : second;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function companyFromFileName(name: string, defaultCompany?: string) {
  for (const [prefix, company] of Object.entries(COMPANY_BY_FILE_PREFIX)) {
    if (name.startsWith(`${prefix}_Cost_of_Goods_Sold`)) return company;
  }
  return resolveMigrationCompany(defaultCompany, 'sellerboard')?.name;
}

function naturalKey(company: string, asin: string, sku: string) {
  return `${company}:${asin}:${sku}`;
}

function roundedMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseCogsFiles(params: { files: CsvSourceFile[]; defaultCompany?: string }) {
  const fileSummaries: Record<string, CogsFileSummary> = {};
  const costs: CostRecord[] = [];
  const hiddenCosts: CostRecord[] = [];
  let rowCount = 0;
  let skippedCount = 0;
  let hiddenSkippedCount = 0;
  let droppedFieldCount = 0;

  for (const file of params.files) {
    const company = companyFromFileName(file.name, params.defaultCompany);
    if (!company) {
      throw new Error(`Sellerboard COGS import failed: company could not be inferred from file ${file.name}.`);
    }
    const parsed = parseDelimitedCsv(file.content, ';');
    const summary: CogsFileSummary = {
      rowCount: parsed.rawRowCount,
      importedCount: 0,
      skippedCount: 0,
      hiddenSkippedCount: 0,
      droppedFieldCount: 0,
    };
    fileSummaries[file.name] = summary;
    rowCount += parsed.rawRowCount;

    for (const rawRow of parsed.rows) {
      const projection = projectSourceRecord('sellerboard_cogs', { ...rawRow, Company: company });
      droppedFieldCount += projection.droppedFieldCount;
      summary.droppedFieldCount += projection.droppedFieldCount;
      const asin = normalizeAsin(projection.payload.asin);
      const sku = normalizeSku(projection.payload.listingSku);
      const unitCost = parseSellerboardNumber(normalizeCompany(projection.payload.unitCost));
      if (!asin || !sku || typeof unitCost !== 'number' || unitCost <= 0) {
        skippedCount += 1;
        summary.skippedCount += 1;
        continue;
      }
      const cost: CostRecord = {
        company,
        asin,
        sku,
        title: normalizeCompany(projection.payload.title) || undefined,
        costPeriodStartDate: parseSellerboardDate(normalizeCompany(projection.payload.observedAt) || undefined),
        unitCost: roundedMoney(unitCost),
        marketplace: normalizeCompany(projection.payload.marketplace) || undefined,
        sourceFile: file.name,
      };
      if (operationalValue(projection.payload.hideStatus) === 'yes') {
        hiddenCosts.push(cost);
        hiddenSkippedCount += 1;
        summary.hiddenSkippedCount += 1;
        summary.skippedCount += 1;
        continue;
      }
      costs.push(cost);
      summary.importedCount += 1;
    }
  }
  return { costs, hiddenCosts, rowCount, skippedCount, hiddenSkippedCount, droppedFieldCount, fileSummaries };
}

function operationalValue(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sellerboardCogsConfirmationToken(decisionDigest: string) {
  return `APPLY_SELLERBOARD_COGS_${decisionDigest.slice(0, 12).toUpperCase()}`;
}

export class EcobaseSellerboardCogsService {
  constructor(private db: EcobaseDatabase) {}

  async previewCsvFiles(params: { files: CsvSourceFile[]; defaultCompany?: string }) {
    const parsed = parseCogsFiles(params);
    const companies = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({ limit: 10000 })).map(
      toPlainRecord,
    );
    const products = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: 100000 })).map(
      toPlainRecord,
    );
    const companyProducts = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: 100000 })
    ).map(toPlainRecord);
    const families = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).find({ limit: 100000 })
    ).map(toPlainRecord);
    const companyById = new Map(companies.map((row) => [String(row.id), normalizeCompany(row.name)]));
    const productById = new Map(products.map((row) => [String(row.id), row]));
    const companyProductById = new Map(companyProducts.map((row) => [String(row.id), row]));
    const targets = families.flatMap((family) => {
      const companyProduct = companyProductById.get(String(family.replenishmentTargetCompanyProductId ?? ''));
      const product = productById.get(String(companyProduct?.productId ?? ''));
      const company = companyById.get(String(family.companyId ?? ''));
      return company && product ? [{ company, asin: normalizeAsin(product.asin), sku: normalizeSku(product.sku) }] : [];
    });
    const resolver = new SellerboardCogsResolver(parsed.costs);
    const resolverIncludingHidden = new SellerboardCogsResolver([...parsed.costs, ...parsed.hiddenCosts]);
    const resolutionCounts: Record<SellerboardCostStatus, number> = {
      exact: 0,
      asin_unique: 0,
      asin_same_cost: 0,
      ambiguous: 0,
      missing: 0,
    };
    let hiddenOnlyFallbackCount = 0;
    for (const target of targets) {
      const resolution = resolver.resolve(target);
      resolutionCounts[resolution.unitCostStatus] += 1;
      if (
        resolution.unitCostStatus === 'missing' &&
        resolverIncludingHidden.resolve(target).unitCostStatus !== 'missing'
      ) {
        hiddenOnlyFallbackCount += 1;
      }
    }
    const input = Object.fromEntries(
      params.files
        .map((file) => [
          file.name,
          {
            sha256: createHash('sha256').update(file.content).digest('hex'),
            rowCount: parseDelimitedCsv(file.content, ';').rawRowCount,
          },
        ])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
    const result = {
      mode: 'dry-run',
      input,
      targetCount: targets.length,
      validPositiveCostRows: parsed.costs.length + parsed.hiddenCosts.length,
      importableCostRows: parsed.costs.length,
      hiddenSkippedCount: parsed.hiddenSkippedCount,
      invalidSkippedCount: parsed.skippedCount,
      resolutionCounts,
      hiddenOnlyFallbackCount,
      fileSummaries: parsed.fileSummaries,
      stagingWrites: 0,
    };
    return { ...result, decisionDigest: digest(result) };
  }

  async applyBackfill(params: {
    files: CsvSourceFile[];
    defaultCompany?: string;
    importedAt?: string;
    decisionDigest: string;
    confirmation: string;
  }) {
    const preview = await this.previewCsvFiles(params);
    if (params.decisionDigest !== preview.decisionDigest) {
      throw new Error(
        `Sellerboard COGS apply blocked: decision digest changed (expected ${preview.decisionDigest}, received ${params.decisionDigest}).`,
      );
    }
    const expectedConfirmation = sellerboardCogsConfirmationToken(preview.decisionDigest);
    if (params.confirmation !== expectedConfirmation) {
      throw new Error(`Sellerboard COGS apply blocked: confirmation must equal ${expectedConfirmation}.`);
    }
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.sellerboardProductCosts);
    const beforeCount = (await repository.find({ limit: 100000 })).length;
    const importResult = await this.importCsvFiles(params);
    const afterCount = (await repository.find({ limit: 100000 })).length;
    return {
      decisionDigest: preview.decisionDigest,
      beforeCount,
      afterCount,
      createdCount: afterCount - beforeCount,
      goldRefreshCount: 0,
      ...importResult,
    };
  }

  async verifyBackfillIdempotency(params: {
    files: CsvSourceFile[];
    defaultCompany?: string;
    importedAt?: string;
    decisionDigest: string;
    confirmation: string;
  }) {
    const first = await this.applyBackfill(params);
    const second = await this.applyBackfill(params);
    if (second.createdCount !== 0 || second.afterCount !== first.afterCount) {
      throw new Error(`Sellerboard COGS idempotency failed: second apply changed row count.`);
    }
    return { first, second, idempotent: true };
  }

  async importCsvFiles(params: { files: CsvSourceFile[]; defaultCompany?: string; importedAt?: string }) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.sellerboardProductCosts);
    const importedAt = params.importedAt ?? new Date().toISOString();
    const parsed = parseCogsFiles(params);
    for (const cost of parsed.costs) {
      const values = {
        id: randomUUID(),
        naturalKey: naturalKey(cost.company as string, cost.asin as string, cost.sku as string),
        ...cost,
        importedAt,
      };
      const existing = await repository.findOne({ filter: { naturalKey: values.naturalKey } });
      if (existing) {
        const existingId = toPlainRecord(existing).id;
        await repository.update({
          filterByTk: typeof existingId === 'string' ? existingId : undefined,
          filter: { naturalKey: values.naturalKey },
          values: { ...values, id: existingId ?? values.id },
        });
      } else {
        await repository.create({ values });
      }
    }
    return {
      rowCount: parsed.rowCount,
      importedCount: parsed.costs.length,
      skippedCount: parsed.skippedCount + parsed.hiddenSkippedCount,
      hiddenSkippedCount: parsed.hiddenSkippedCount,
      droppedFieldCount: parsed.droppedFieldCount,
      fileSummaries: parsed.fileSummaries,
      migration: {
        profileVersion: FOUR_COMPANY_MIGRATION_PROFILE.profileVersion,
        asOfDate: importedAt.slice(0, 10),
        acceptedCount: parsed.costs.length,
        discardedCount: parsed.skippedCount + parsed.hiddenSkippedCount,
        reviewCount: 0,
        reasons: {
          ...(parsed.skippedCount ? { missing_identity_or_cost: parsed.skippedCount } : {}),
          ...(parsed.hiddenSkippedCount ? { hidden_source_row: parsed.hiddenSkippedCount } : {}),
        },
      },
    };
  }

  async createResolver(companies?: string[]) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.sellerboardProductCosts);
    const costs = (
      await repository.find({
        filter: companies?.length ? { company: { $in: companies } } : undefined,
        limit: 100000,
      })
    ).map((record) => toPlainRecord(record) as CostRecord);
    return new SellerboardCogsResolver(costs);
  }
}

export class SellerboardCogsResolver {
  private exact = new Map<string, CostRecord>();
  private byAsin = new Map<string, CostRecord[]>();

  constructor(costs: CostRecord[]) {
    costs.forEach((cost) => {
      const company = normalizeCompany(cost.company);
      const asin = normalizeAsin(cost.asin);
      const sku = normalizeSku(cost.sku);
      const unitCost = finiteNumber(cost.unitCost);
      if (!company || !asin || !sku || typeof unitCost !== 'number' || unitCost <= 0) return;
      const normalizedCost = { ...cost, company, asin, sku, unitCost: roundedMoney(unitCost) };
      this.exact.set(`${company}:${asin}:${sku}`, normalizedCost);
      const asinKey = `${company}:${asin}`;
      this.byAsin.set(asinKey, [...(this.byAsin.get(asinKey) ?? []), normalizedCost]);
    });
  }

  resolve(row: PlainRecord): SellerboardCostResolution {
    const company = normalizeCompany(row.company);
    const asin = normalizeAsin(row.asin);
    const sku = normalizeSku(row.sku);
    if (!company || !asin) return { unitCostStatus: 'missing' };
    const exact = this.exact.get(`${company}:${asin}:${sku}`);
    if (exact) return this.withEstimatedOrderCost(row, exact, 'exact');
    const asinCosts = this.byAsin.get(`${company}:${asin}`) ?? [];
    if (asinCosts.length === 1) return this.withEstimatedOrderCost(row, asinCosts[0], 'asin_unique');
    const distinctCosts = [
      ...new Set(asinCosts.map((cost) => cost.unitCost).filter((cost) => typeof cost === 'number')),
    ];
    if (distinctCosts.length === 1 && asinCosts[0])
      return this.withEstimatedOrderCost(row, asinCosts[0], 'asin_same_cost');
    return { unitCostStatus: asinCosts.length > 0 ? 'ambiguous' : 'missing' };
  }

  private withEstimatedOrderCost(
    row: PlainRecord,
    cost: CostRecord,
    status: SellerboardCostStatus,
  ): SellerboardCostResolution {
    const unitCost = finiteNumber(cost.unitCost);
    if (typeof unitCost !== 'number') return { unitCostStatus: 'missing' };
    const suggestedQty = finiteNumber(row.suggestedReorderQty) ?? 0;
    return {
      unitCost,
      unitCostStatus: status,
      unitCostSource: cost.sourceFile,
      estimatedOrderCost: suggestedQty > 0 ? roundedMoney(suggestedQty * unitCost) : undefined,
    };
  }
}
