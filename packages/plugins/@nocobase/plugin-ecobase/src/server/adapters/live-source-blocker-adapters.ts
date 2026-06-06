import type { AdapterStreamItem, SourceAdapter, SourceAdapterImportInput } from './types';
import { CsvRowReader, parseCsv } from './csv-utils';
import { importCsvFiles } from './amazon-operations-csv-adapter';

type SellerboardReportCategory = 'profit_dashboard' | 'stock_daily' | 'profit_by_product_daily';

interface SellerboardReportConfig {
  name: string;
  category: SellerboardReportCategory;
  url: string;
  snapshotDate?: string;
  expectedFreshDate?: string;
}

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

function accessAuditRecord(
  input: SourceAdapterImportInput,
  adapterName: string,
  status: string,
  blockerCode: string,
  message: string,
  payload: Record<string, unknown> = {},
) {
  const checkedAt = new Date().toISOString();
  return {
    kind: 'source_access_audit',
    data: {
      naturalKey: [input.sourceConnectionId, 'source_access_audit', adapterName, input.sourceVersion, blockerCode].join(':'),
      sourceConnectionId: input.sourceConnectionId,
      sourceType: 'sellerboard',
      adapterName,
      status,
      blockerCode,
      message,
      checkedAt,
      payload: { sourceIdentifier: input.sourceIdentifier, sourceVersion: input.sourceVersion, ...payload },
    },
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
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
          name: typeof record.name === 'string' && record.name.length > 0 ? record.name : `sellerboard-report-${index + 1}`,
          category,
          url,
          snapshotDate: typeof record.snapshotDate === 'string' ? record.snapshotDate : undefined,
          expectedFreshDate: typeof record.expectedFreshDate === 'string' ? record.expectedFreshDate : undefined,
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
      category: typeof config.reportCategory === 'string' ? (config.reportCategory as SellerboardReportCategory) : 'profit_dashboard',
      url: singleUrl,
      snapshotDate: typeof config.snapshotDate === 'string' ? config.snapshotDate : undefined,
      expectedFreshDate: typeof config.expectedFreshDate === 'string' ? config.expectedFreshDate : undefined,
    },
  ];
}

function reportConfigs(input: SourceAdapterImportInput) {
  const secretReports = readSecretReports(input.secretRef);
  return [...secretReports, ...readReportConfigs(input.config)];
}

function redactedSourceKey(report: SellerboardReportConfig) {
  return `${report.category}:${report.name}`;
}

function isoDate(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const dayMonthYear = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dayMonthYear) {
    return `${dayMonthYear[3]}-${dayMonthYear[2].padStart(2, '0')}-${dayMonthYear[1].padStart(2, '0')}`;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function compareIsoDate(left: string, right: string) {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function maxReportDate(csvContent: string) {
  const parsed = parseCsv(csvContent);
  let maxDate: string | undefined;
  for (const row of parsed.rows) {
    const reader = new CsvRowReader(row);
    const value = isoDate(reader.string('Date', 'Month', 'Timestamp', 'Snapshot Date'));
    if (value && (!maxDate || compareIsoDate(value, maxDate) > 0)) {
      maxDate = value;
    }
  }
  return maxDate;
}

function expectedFreshDate(input: SourceAdapterImportInput, report: SellerboardReportConfig) {
  if (report.expectedFreshDate) return report.expectedFreshDate;
  if (typeof input.config.expectedFreshDate === 'string') return input.config.expectedFreshDate;
  if (typeof input.config.expectedReportDate === 'string') return input.config.expectedReportDate;
  return /^\d{4}-\d{2}-\d{2}/.test(input.sourceVersion) ? input.sourceVersion.slice(0, 10) : undefined;
}

function shouldRequireFreshData(input: SourceAdapterImportInput) {
  return input.config.requireFreshData === true || input.sourceIdentifier === 'sellerboard-scheduled';
}

async function fetchSellerboardCsv(url: string, headers: Record<string, string>) {
  if (typeof fetch !== 'function') {
    throw new Error('Sellerboard live import failed: global fetch is not available in this runtime.');
  }
  const response = await fetch(url, { headers });
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
  const files = [] as Array<{ name: string; content: string; snapshotDate?: string; expectedRowCount?: number }>;
  const staleReports: Array<Record<string, unknown>> = [];

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
          message: error instanceof Error ? error.message : 'Sellerboard live import failed: fetch returned a non-Error failure.',
          sourceKey,
          payload: { reportName: report.name, category: report.category },
        },
      };
      continue;
    }

    const expected = expectedFreshDate(input, report);
    const maxDate = maxReportDate(csvContent);
    if (shouldRequireFreshData(input) && expected && (!maxDate || compareIsoDate(maxDate, expected) < 0)) {
      staleReports.push({ reportName: report.name, category: report.category, expectedFreshDate: expected, maxReportDate: maxDate });
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'warning',
          code: 'sellerboard_data_not_fresh',
          message: `Sellerboard report "${report.name}" is not fresh enough: expected at least ${expected}, got ${maxDate ?? 'no date'}.`,
          sourceKey,
          payload: { reportName: report.name, category: report.category, expectedFreshDate: expected, maxReportDate: maxDate },
        },
      };
      continue;
    }

    files.push({ name: `${report.category}-${report.name}.csv`, content: csvContent, snapshotDate: report.snapshotDate ?? maxDate });
  }

  if (staleReports.length > 0) {
    yield {
      type: 'record',
      rowNumber: 0,
      sourceKey: 'sellerboard-api-freshness',
      payload: { status: 'stale', staleReports },
      record: accessAuditRecord(
        input,
        'sellerboard-api',
        'stale',
        'sellerboard_data_not_fresh',
        files.length === 0
          ? 'Sellerboard live import fetched data but no configured report was fresh enough for the expected report date.'
          : 'Sellerboard live import normalized fresh reports but at least one required report was stale; scheduled import must retry.',
        { staleReports, freshReportCount: files.length },
      ),
    };
  }

  if (files.length > 0) {
    yield* importCsvFiles({ ...input, config: { ...input.config, files } });
  }

  if (staleReports.length > 0) {
    yield {
      type: 'status',
      status: 'stale',
      message:
        files.length === 0
          ? 'Sellerboard live import fetched data but no configured report was fresh enough for the expected report date.'
          : 'Sellerboard live import normalized fresh reports but at least one required report was stale; scheduled import must retry.',
      payload: { staleReports, freshReportCount: files.length },
    };
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
