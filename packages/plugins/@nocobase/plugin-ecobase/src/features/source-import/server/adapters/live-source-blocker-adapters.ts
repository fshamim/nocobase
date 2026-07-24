/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { AdapterStreamItem, SourceAdapter, SourceAdapterImportInput } from './types';
import { CsvRowReader, type CsvSourceFile, parseDelimitedCsv } from './csv-utils';
import { importCsvFiles, sellerboardIsoDate } from './amazon-operations-csv-adapter';

type SellerboardReportCategory = 'profit_dashboard' | 'stock_daily' | 'profit_by_product_daily';

interface SellerboardReportConfig {
  name: string;
  category: SellerboardReportCategory;
  url: string;
  snapshotDate?: string;
}

// Batch C freshness backstop: Sellerboard reports are month-to-date snapshots and a multi-day
// delivery lag is NORMAL, so the newest downloadable/parseable report is always accepted and
// coverage is stamped from its real data date. The only staleness that can reject a report is a
// deliberately generous ceiling (a broken-feed guard) that a normal 2-3 day lag can never trip.
// A healthy feed's newest row is only ever a few days old; a newest row 45+ days behind almost
// always means a stale or broken CSV URL, not a real Sellerboard delay. The default clears
// legitimate cross-month data (a full prior-month report is ~31 days old) with room to spare.
// Operators may override per source with config.maxReportAgeDays, or set it to null to opt out.
const SELLERBOARD_DEFAULT_MAX_REPORT_AGE_DAYS = 45;

function hasCredential(config: Record<string, unknown>, secretRef: string | undefined, keys: string[]) {
  if (secretRef) {
    return true;
  }
  return keys.some((key) => typeof config[key] === 'string' && String(config[key]).trim().length > 0);
}

function blockerRecord(
  input: SourceAdapterImportInput,
  adapterName: string,
  sourceType: string,
  blockerCode: string,
  message: string,
) {
  const checkedAt = new Date().toISOString();
  return {
    kind: 'source_access_audit',
    data: {
      naturalKey: [input.sourceConnectionId, 'source_access_audit', adapterName, input.sourceVersion].join(':'),
      sourceConnectionId: input.sourceConnectionId,
      sourceType,
      adapterName,
      status: 'blocked',
      blockerCode,
      message,
      checkedAt,
      payload: { sourceIdentifier: input.sourceIdentifier, sourceVersion: input.sourceVersion },
    },
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function readSecretReports(secretRef: string | undefined): SellerboardReportConfig[] {
  if (!secretRef) {
    return [];
  }
  const raw = process.env[secretRef];
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw);
  return readReportConfigs({ reportUrls: parsed });
}

function readReportConfigs(config: Record<string, unknown>): SellerboardReportConfig[] {
  const configured = config.reportUrls ?? config.sellerboardReportUrls ?? config.urls;
  if (Array.isArray(configured)) {
    return configured.flatMap((entry, index): SellerboardReportConfig[] => {
      if (typeof entry === 'string') {
        return [
          {
            name: `sellerboard-report-${index + 1}`,
            category: 'profit_dashboard' as const,
            url: entry,
          },
        ];
      }
      if (typeof entry !== 'object' || entry === null) {
        return [];
      }
      const record = entry as Record<string, unknown>;
      const url = typeof record.url === 'string' ? record.url : undefined;
      if (!url) {
        return [];
      }
      const category = typeof record.category === 'string' ? record.category : 'profit_dashboard';
      if (category !== 'profit_dashboard' && category !== 'stock_daily' && category !== 'profit_by_product_daily') {
        return [];
      }
      return [
        {
          name:
            typeof record.name === 'string' && record.name.length > 0 ? record.name : `sellerboard-report-${index + 1}`,
          category,
          url,
          snapshotDate: typeof record.snapshotDate === 'string' ? record.snapshotDate : undefined,
        },
      ];
    });
  }

  const singleUrl = typeof config.reportUrl === 'string' ? config.reportUrl : undefined;
  if (!singleUrl) {
    return [];
  }
  return [
    {
      name: typeof config.reportName === 'string' ? config.reportName : 'sellerboard-report',
      category:
        typeof config.reportCategory === 'string'
          ? (config.reportCategory as SellerboardReportCategory)
          : 'profit_dashboard',
      url: singleUrl,
      snapshotDate: typeof config.snapshotDate === 'string' ? config.snapshotDate : undefined,
    },
  ];
}

function reportConfigs(input: SourceAdapterImportInput) {
  const secretReports = readSecretReports(input.secretRef);
  const reports = [...secretReports, ...readReportConfigs(input.config)];
  const reportKind = input.config.reportKind;
  return typeof reportKind === 'string' ? reports.filter((report) => report.category === reportKind) : reports;
}

function redactedSourceKey(report: SellerboardReportConfig) {
  return `${report.category}:${report.name}`;
}

function compareIsoDate(left: string, right: string) {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

export type SellerboardDateFormat = 'day-first' | 'month-first';

export function parseSellerboardCsv(content: string) {
  const header = content.split(/\r?\n/, 1)[0] ?? '';
  return parseDelimitedCsv(content, header.split(';').length > header.split(',').length ? ';' : ',');
}

export function detectSellerboardDateFormat(csvContent: string): SellerboardDateFormat {
  const parsed = parseSellerboardCsv(csvContent);
  for (const row of parsed.rows) {
    const value = new CsvRowReader(row).string('Date', 'Month', 'Timestamp', 'Snapshot Date');
    const match = value?.trim().match(/^(\d{1,2})\/(\d{1,2})\/\d{4}$/);
    if (!match) continue;
    if (Number(match[1]) > 12) return 'day-first';
    if (Number(match[2]) > 12) return 'month-first';
  }
  return 'month-first';
}

export function sellerboardReportDate(value: string | undefined, format: SellerboardDateFormat) {
  if (format === 'month-first') return sellerboardIsoDate(value);
  const match = value?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return sellerboardIsoDate(value);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const date = new Date(Date.UTC(Number(match[3]), month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

export function maxReportDate(csvContent: string, format: SellerboardDateFormat) {
  const parsed = parseSellerboardCsv(csvContent);
  let maxDate: string | undefined;
  for (const row of parsed.rows) {
    const reader = new CsvRowReader(row);
    const value = sellerboardReportDate(reader.string('Date', 'Month', 'Timestamp', 'Snapshot Date'), format);
    if (value && (!maxDate || compareIsoDate(value, maxDate) > 0)) {
      maxDate = value;
    }
  }
  return maxDate;
}

// The reference day a report's age is measured against: the run's own as-of (sourceVersion day)
// when it is date-like, else today. Sellerboard delivers historical data, so the report date is
// normally a few days behind this reference — that lag is expected and accepted.
function runAsOfDay(input: SourceAdapterImportInput) {
  const match = input.sourceVersion.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().slice(0, 10);
}

// Resolve the broken-feed staleness ceiling in days. Absent config uses the generous default;
// an explicit null opts out of any ceiling (accept a report of any age).
function reportMaxAgeDays(input: SourceAdapterImportInput) {
  const configured = input.config.maxReportAgeDays;
  if (configured === null) return null;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return SELLERBOARD_DEFAULT_MAX_REPORT_AGE_DAYS;
}

function daysBetweenIso(earlier: string, later: string) {
  const start = new Date(`${earlier}T00:00:00.000Z`).getTime();
  const end = new Date(`${later}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

const SELLERBOARD_FETCH_TIMEOUT_MS = 10 * 60 * 1000;

async function fetchSellerboardCsv(url: string, headers: Record<string, string>) {
  if (typeof fetch !== 'function') {
    throw new Error('Sellerboard live import failed: global fetch is not available in this runtime.');
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(SELLERBOARD_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Sellerboard live import failed: URL returned HTTP ${response.status}.`);
  }
  return response.text();
}

function requestHeaders(input: SourceAdapterImportInput) {
  const headers: Record<string, string> = {};
  const configuredHeaders = input.config.headers;
  if (configuredHeaders && typeof configuredHeaders === 'object' && !Array.isArray(configuredHeaders)) {
    for (const [key, value] of Object.entries(configuredHeaders as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value;
    }
  }
  for (const key of stringArray(input.config.headerEnvRefs)) {
    const value = process.env[key];
    if (value) headers[key] = value;
  }
  return headers;
}

async function* sellerboardApiImport(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
  const reports = reportConfigs(input);
  if (reports.length === 0) {
    const message =
      'Sellerboard live report URLs are not configured. Store automation CSV URLs in a secret reference or reportUrls config before live ingestion.';
    yield {
      type: 'record',
      rowNumber: 1,
      sourceKey: 'sellerboard-api-access',
      payload: { status: 'blocked', blockerCode: 'sellerboard_credentials_missing' },
      record: blockerRecord(input, 'sellerboard-api', 'sellerboard', 'sellerboard_credentials_missing', message),
    };
    yield {
      type: 'status',
      status: 'blocked',
      message,
      payload: { blockerCode: 'sellerboard_credentials_missing' },
    };
    return;
  }

  const headers = requestHeaders(input);
  const files: CsvSourceFile[] = [];
  const asOfDay = runAsOfDay(input);
  const maxAgeDays = reportMaxAgeDays(input);

  for (const report of reports) {
    const sourceKey = redactedSourceKey(report);
    let csvContent: string;
    try {
      csvContent = await fetchSellerboardCsv(report.url, headers);
    } catch (error) {
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'error',
          code: 'sellerboard_live_fetch_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Sellerboard live import failed: fetch returned a non-Error failure.',
          sourceKey,
          payload: { reportName: report.name, category: report.category },
        },
      };
      continue;
    }

    const dateFormat = detectSellerboardDateFormat(csvContent);
    const maxDate = maxReportDate(csvContent, dateFormat);

    // Accept the newest report we could download and parse regardless of its lag. The only
    // staleness that rejects a report is the generous broken-feed ceiling above (default 30
    // days) — a report older than that almost always means a stale/broken URL, not a normal
    // Sellerboard delay. Reports without a parseable date fall through to importCsvFiles, which
    // reports its own shape/row issues, so genuine parse failures still surface.
    if (maxDate && maxAgeDays !== null && daysBetweenIso(maxDate, asOfDay) > maxAgeDays) {
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'error',
          code: 'sellerboard_report_exceeds_max_age',
          message: `Sellerboard report "${report.name}" is unusable: newest data ${maxDate} is more than ${maxAgeDays} days behind ${asOfDay}. Re-copy the Sellerboard CSV link or raise config.maxReportAgeDays.`,
          sourceKey,
          payload: {
            reportName: report.name,
            category: report.category,
            maxReportDate: maxDate,
            maxReportAgeDays: maxAgeDays,
            asOfDate: asOfDay,
          },
        },
      };
      continue;
    }

    files.push({
      name: `${report.category}-${report.name}.csv`,
      content: csvContent,
      snapshotDate: report.snapshotDate ?? (report.category === 'stock_daily' ? maxDate : undefined),
      dateFormat,
    });
  }

  if (files.length > 0) {
    yield* importCsvFiles({ ...input, config: { ...input.config, files } });
  }
}

async function* amazonSpApiImport(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
  if (!hasCredential(input.config, input.secretRef, ['refreshToken', 'lwaClientId', 'roleArn'])) {
    yield {
      type: 'record',
      rowNumber: 1,
      sourceKey: 'amazon-sp-api-access',
      payload: { status: 'blocked', blockerCode: 'amazon_sp_api_access_missing' },
      record: blockerRecord(
        input,
        'amazon-sp-api-access-check',
        'amazon_sp_api',
        'amazon_sp_api_access_missing',
        'Amazon SP-API access is not configured or approved; Sellerboard remains the accepted MVP profit/operations source until access is ready.',
      ),
    };
  }
}

export const sellerboardApiAdapter: SourceAdapter = {
  metadata: {
    name: 'sellerboard-api',
    title: 'Sellerboard API/report URLs',
    sourceType: 'sellerboard',
    supportedDomains: ['amazon_operations', 'foundation'],
    version: '1.0.0',
  },
  import: sellerboardApiImport,
};

export const amazonSpApiAccessCheckAdapter: SourceAdapter = {
  metadata: {
    name: 'amazon-sp-api-access-check',
    title: 'Amazon SP-API access check',
    sourceType: 'amazon_sp_api',
    supportedDomains: ['amazon_operations', 'foundation'],
    version: '1.0.0',
  },
  import: amazonSpApiImport,
};
