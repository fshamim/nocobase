/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import type { AdapterStreamItem, NormalizedRecord, SourceAdapter, SourceAdapterImportInput } from './types';
import { CsvRowReader, CsvSourceFile, normalizedHeaderSet, normalizeHeader, parseDelimitedCsv } from './csv-utils';
import { sellerboardMetricValues } from './sellerboard-metrics';

interface FileConfig {
  files?: CsvSourceFile[];
  expectedRowCounts?: Record<string, number>;
}

const HISTORY_DASHBOARD_SHAPE = 'sellerboard-history-dashboard-goods' as const;

function asFileConfig(config: Record<string, unknown>): FileConfig {
  return config as FileConfig;
}

function has(headers: Set<string>, name: string) {
  return headers.has(normalizeHeader(name));
}

function isHistoryDashboardHeaders(headers: string[]) {
  const normalized = normalizedHeaderSet(headers);
  return has(normalized, 'Date') && has(normalized, 'SalesOrganic') && has(normalized, 'ASIN');
}

export function analyzeSellerboardHistoryCsvFile(file: CsvSourceFile) {
  const parsed = parseDelimitedCsv(file.content ?? '', ';');
  return {
    rowCount: parsed.rows.length,
    detectedShape: isHistoryDashboardHeaders(parsed.headers) ? HISTORY_DASHBOARD_SHAPE : undefined,
  };
}

type DateFormat = 'day-first' | 'month-first';

function dateParts(value: string | undefined) {
  const match = value?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  return { left: Number(match[1]), right: Number(match[2]), year: Number(match[3]) };
}

function detectDateFormat(rows: Array<Record<string, string | undefined>>): DateFormat {
  for (const row of rows) {
    const parts = dateParts(new CsvRowReader(row).string('Date'));
    if (!parts) continue;
    if (parts.right > 12) return 'month-first';
    if (parts.left > 12) return 'day-first';
  }
  return 'day-first';
}

function sellerboardDate(value: string | undefined, format: DateFormat) {
  const parts = dateParts(value);
  if (!parts) return undefined;
  const day = format === 'month-first' ? parts.right : parts.left;
  const month = format === 'month-first' ? parts.left : parts.right;
  const date = new Date(Date.UTC(parts.year, month - 1, day));
  if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return `${String(parts.year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sourceDateUpperBound(sourceVersion: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(sourceVersion) ? sourceVersion : undefined;
}

function defaultCompany(input: SourceAdapterImportInput) {
  const value = input.config.defaultCompany;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function companyFromFileName(fileName: string) {
  const [prefix] = fileName.split('_Dashboard_by_product_');
  return prefix && prefix !== fileName ? prefix.replace(/_/g, ' ') : undefined;
}

function companyOf(input: SourceAdapterImportInput, file: CsvSourceFile, row: CsvRowReader) {
  return row.string('Company') ?? defaultCompany(input) ?? companyFromFileName(file.name);
}

function compactReference(value: string, maxLength = 180) {
  if (value.length <= maxLength) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${value.slice(0, maxLength - 17)}:${hash}`;
}

function naturalKey(input: SourceAdapterImportInput, kind: string, parts: Array<string | number | undefined>) {
  return [input.sourceConnectionId, kind, ...parts.map((part) => String(part ?? ''))].join(':');
}

function canonicalAsin(row: CsvRowReader) {
  return row.string('ASIN', 'ASIN ')?.toUpperCase();
}

function sourceKeyFor(file: CsvSourceFile, row: CsvRowReader, rowNumber: number) {
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  return compactReference(`${file.name}:${asin ?? ''}:${sku ?? ''}:${rowNumber}`);
}

function listingIdentityParts(company: string, row: CsvRowReader, sourceKey: string) {
  const marketplace = row.string('Marketplace', 'Market ');
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  return [company, marketplace, asin ?? sourceKey, sku ?? sourceKey];
}

function dailyFactRecord(
  input: SourceAdapterImportInput,
  file: CsvSourceFile,
  row: CsvRowReader,
  snapshotDate: string,
  sourceKey: string,
): NormalizedRecord | undefined {
  const company = companyOf(input, file, row);
  if (!company) return undefined;
  const asin = canonicalAsin(row);
  const sku = row.string('SKU') ?? asin;
  const sellerboardMetrics = sellerboardMetricValues(row);
  return {
    kind: 'listing_daily_fact',
    data: {
      naturalKey: naturalKey(input, 'listing_daily_fact', [
        snapshotDate,
        ...listingIdentityParts(company, row, sourceKey),
      ]),
      sourceConnectionId: input.sourceConnectionId,
      snapshotDate,
      company,
      asin,
      sku,
      sales: sellerboardMetrics.sales,
      units: sellerboardMetrics.units,
      refunds: row.number('Refunds', 'Refund Units'),
      refundRate: row.number('% Refund', 'Sellable Returns %'),
      grossProfit: sellerboardMetrics.grossProfit,
      netProfit: sellerboardMetrics.netProfit,
      margin: sellerboardMetrics.margin,
      profitPerUnit: sellerboardMetrics.profitPerUnit,
      sessions: row.number('Sessions', 'Sessions - Total'),
      unitSessionPercentage: row.number('Unit Session Percentage'),
      sourceKey,
      payload: row.payload(),
    },
  };
}

export async function* importSellerboardHistoryCsvFiles(
  input: SourceAdapterImportInput,
): AsyncIterable<AdapterStreamItem> {
  const files = Array.isArray(asFileConfig(input.config).files) ? asFileConfig(input.config).files ?? [] : [];
  if (files.length === 0) {
    yield {
      type: 'rowIssue',
      issue: {
        rowNumber: 0,
        severity: 'error',
        code: 'sellerboard_history_files_missing',
        message: 'Sellerboard history import requires inline semicolon CSV files in config.files.',
      },
    };
    return;
  }

  for (const file of files) {
    // ponytail: one-time Sellerboard history backfill parser; ongoing Sellerboard API imports must keep using sellerboard-api/sellerboard-csv.
    const parsed = parseDelimitedCsv(file.content ?? '', ';');
    const dateFormat = detectDateFormat(parsed.rows);
    const latestAllowedDate = sourceDateUpperBound(input.sourceVersion);
    const expectedRowCount = file.expectedRowCount ?? asFileConfig(input.config).expectedRowCounts?.[file.name];
    if (typeof expectedRowCount === 'number' && expectedRowCount !== parsed.rows.length) {
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'warning',
          code: 'sellerboard_history_row_count_mismatch',
          message: `Sellerboard history import expected ${expectedRowCount} rows for ${file.name} but parsed ${parsed.rows.length}.`,
          sourceKey: file.name,
          payload: { expectedRowCount, actualRowCount: parsed.rows.length },
        },
      };
    }

    if (!isHistoryDashboardHeaders(parsed.headers)) {
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'error',
          code: 'sellerboard_history_shape_unknown',
          message: `Sellerboard history import only accepts Dashboard by Product exports; ${file.name} did not match that shape.`,
          sourceKey: file.name,
          payload: { fileName: file.name, headerCount: parsed.headers.length },
        },
      };
      continue;
    }

    for (const [index, row] of parsed.rows.entries()) {
      const reader = new CsvRowReader(row);
      const rowNumber = index + 2;
      const sourceKey = sourceKeyFor(file, reader, rowNumber);
      const snapshotDate = sellerboardDate(reader.string('Date'), dateFormat);
      if (!snapshotDate) {
        yield {
          type: 'rowIssue',
          issue: {
            rowNumber,
            severity: 'error',
            code: 'sellerboard_history_date_invalid',
            message: `Sellerboard history import requires slash dates in D/M/YYYY or M/D/YYYY format; row ${rowNumber} in ${
              file.name
            } has "${reader.string('Date') ?? ''}".`,
            sourceKey,
            payload: row,
          },
        };
        continue;
      }
      if (latestAllowedDate && snapshotDate > latestAllowedDate) {
        yield {
          type: 'rowIssue',
          issue: {
            rowNumber,
            severity: 'error',
            code: 'sellerboard_history_date_future',
            message: `Sellerboard history import rejected row ${rowNumber} in ${file.name} because ${snapshotDate} is after source version ${latestAllowedDate}.`,
            sourceKey,
            payload: row,
          },
        };
        continue;
      }
      if (!canonicalAsin(reader) && !reader.string('SKU')) {
        yield {
          type: 'rowIssue',
          issue: {
            rowNumber,
            severity: 'warning',
            code: 'sellerboard_history_identity_missing',
            message: `Sellerboard history import skipped row ${rowNumber} in ${file.name} because no ASIN or SKU was present.`,
            sourceKey,
            payload: row,
          },
        };
        continue;
      }
      if (!companyOf(input, file, reader)) {
        yield {
          type: 'rowIssue',
          issue: {
            rowNumber,
            severity: 'error',
            code: 'sellerboard_history_company_missing',
            message: `Sellerboard history import skipped row ${rowNumber} in ${file.name} because company context was missing.`,
            sourceKey,
            payload: row,
          },
        };
        continue;
      }

      const record = dailyFactRecord(input, file, reader, snapshotDate, sourceKey);
      if (record) {
        yield { type: 'record', rowNumber, sourceKey, payload: row, record };
      }
    }
  }
}

export const sellerboardHistoryCsvAdapter: SourceAdapter = {
  metadata: {
    name: 'sellerboard-history-csv',
    title: 'Sellerboard history CSV',
    sourceType: 'sellerboard',
    supportedDomains: ['amazon_operations', 'foundation'],
    version: '1.0.0',
  },
  import: importSellerboardHistoryCsvFiles,
};
