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
import type { CsvSourceFile } from './adapters/csv-utils';
import { CsvRowReader, parseDelimitedCsv } from './adapters/csv-utils';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

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
};

const COMPANY_BY_FILE_PREFIX: Record<string, string> = {
  Fissionem: 'Ecofission LLC',
  Muxtex: 'Muxtex INC',
  Retail_Heaven_Inc: 'Retail Heaven Inc',
  Stop_Shop_Llc: 'Stop Shop LLC',
};

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
  return defaultCompany?.trim();
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

export class EcobaseSellerboardCogsService {
  constructor(private db: EcobaseDatabase) {}

  async importCsvFiles(params: { files: CsvSourceFile[]; defaultCompany?: string; importedAt?: string }) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.sellerboardProductCosts);
    const importedAt = params.importedAt ?? new Date().toISOString();
    const fileSummaries: Record<string, { rowCount: number; importedCount: number; skippedCount: number }> = {};
    let rowCount = 0;
    let importedCount = 0;
    let skippedCount = 0;

    for (const file of params.files) {
      const company = companyFromFileName(file.name, params.defaultCompany);
      if (!company) {
        throw new Error(`Sellerboard COGS import failed: company could not be inferred from file ${file.name}.`);
      }
      const parsed = parseDelimitedCsv(file.content, ';');
      const summary = { rowCount: parsed.rows.length, importedCount: 0, skippedCount: 0 };
      fileSummaries[file.name] = summary;
      rowCount += parsed.rows.length;

      for (const rawRow of parsed.rows) {
        const row = new CsvRowReader(rawRow);
        const asin = normalizeAsin(row.string('ASIN'));
        const sku = normalizeSku(row.string('SKU'));
        const unitCost = parseSellerboardNumber(row.string('Cost'));
        if (!asin || !sku || typeof unitCost !== 'number' || unitCost <= 0) {
          skippedCount += 1;
          summary.skippedCount += 1;
          continue;
        }
        const values = {
          id: randomUUID(),
          naturalKey: naturalKey(company, asin, sku),
          company,
          asin,
          sku,
          title: row.string('Title'),
          costPeriodStartDate: parseSellerboardDate(row.string('CostPeriodStartDate')),
          unitCost: roundedMoney(unitCost),
          marketplace: row.string('Marketplace'),
          sourceFile: file.name,
          importedAt,
          rawPayload: row.payload(),
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
        importedCount += 1;
        summary.importedCount += 1;
      }
    }

    return { rowCount, importedCount, skippedCount, fileSummaries };
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
