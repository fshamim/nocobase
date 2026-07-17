#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCanonicalCompany } from '../src/server/company-identity';
import { CsvRowReader, type CsvSourceFile } from '../src/features/source-import/server/adapters/csv-utils';
import {
  detectSellerboardDateFormat,
  parseSellerboardCsv,
  sellerboardReportDate,
} from '../src/features/source-import/server/adapters/live-source-blocker-adapters';
import { FOUR_COMPANY_MIGRATION_PROFILE } from '../src/features/source-import/server/four-company-migration-profile';
import {
  preflightImportFiles,
  type SellerboardSourceCoverage,
} from '../src/features/source-import/server/import-preflight';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const NOCOBASE_ROOT = path.resolve(PLUGIN_ROOT, '../../../..');
const PROJECT_ROOT = path.resolve(process.env.ECOBASE_GREENFIELD_PROJECT_ROOT ?? path.dirname(NOCOBASE_ROOT));
const SEED_PROFILE = process.env.ECOBASE_SEED_PROFILE ?? 'complete';
const BUNDLE_PATH = process.env.ECOBASE_GREENFIELD_BUNDLE_PATH;
const DEFAULT_OUTPUT = path.join(NOCOBASE_ROOT, '.local', 'live-gate-bootstrap', 'import-preflight.json');
const STAGING_FAST_FILES_BY_GROUP = new Map([
  ['clickup-order-status', ['data/clickup/Order Management Clickup Data 06-07-2026.csv']],
  [
    'order-management',
    [
      'data/order-managment-sheets/Ecofission-Order Management - Purchase Orders.csv',
      'data/order-managment-sheets/Ecofission-Order Management - OrderDetails.csv',
    ],
  ],
  [
    'supplier-management',
    [
      'data/dataforimport/Ecofission-Order Management - Supplier IDs.csv',
      'data/supplier-management-sheets/Supplier Analysis Tracker - Supplier 2026.csv',
    ],
  ],
]);
const STAGING_FAST_GROUPS = new Set(STAGING_FAST_FILES_BY_GROUP.keys());

function requiredFile(filePath: string) {
  if (!existsSync(filePath)) throw new Error(`Ecobase import preflight failed: required file is missing: ${filePath}`);
  return filePath;
}

function csvFilesIn(directory: string) {
  if (!existsSync(directory)) throw new Error(`Ecobase import preflight failed: directory is missing: ${directory}`);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.csv'))
    .sort()
    .map((name) => path.join(directory, name));
}

function stagingFastSourceFiles() {
  if (!BUNDLE_PATH) {
    throw new Error('Ecobase import preflight requires ECOBASE_GREENFIELD_BUNDLE_PATH for staging-fast-clickup.');
  }
  const manifest = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8')) as {
    profile?: string;
    groups?: Array<{ id?: string; files?: Array<{ path?: string }> }>;
  };
  if (manifest.profile !== 'staging-fast-clickup') {
    throw new Error('Ecobase import preflight rejected a staging-fast-clickup bundle with the wrong profile.');
  }
  const groups = manifest.groups ?? [];
  if (
    groups.length !== STAGING_FAST_GROUPS.size ||
    groups.some((group) => !group.id || !STAGING_FAST_GROUPS.has(group.id))
  ) {
    throw new Error('Ecobase import preflight rejected unexpected staging-fast-clickup bundle groups.');
  }
  return groups.flatMap((group) => {
    const expectedPaths = [...(STAGING_FAST_FILES_BY_GROUP.get(group.id ?? '') ?? [])].sort();
    const actualPaths = (group.files ?? []).map((file) => file.path ?? '').sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error(`Ecobase import preflight rejected unapproved staging-fast-clickup paths for ${group.id}.`);
    }
    return (group.files ?? []).map((file) => {
      const relativePath = file.path!;
      const resolved = path.resolve(PROJECT_ROOT, relativePath);
      if (resolved !== PROJECT_ROOT && !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
        throw new Error(`Ecobase import preflight rejected a path outside project root: ${relativePath}.`);
      }
      return requiredFile(resolved);
    });
  });
}

function sourceFiles() {
  if (SEED_PROFILE === 'staging-fast-clickup') return stagingFastSourceFiles();
  const canonicalImportDir = path.join(PROJECT_ROOT, 'data', 'dataforimport');
  return [
    ...csvFilesIn(path.join(PROJECT_ROOT, 'data', 'history')),
    requiredFile(path.join(canonicalImportDir, 'Ecofission-Order Management - Supplier IDs.csv')),
    requiredFile(path.join(canonicalImportDir, 'Ecofission-Order Management - Purchase Orders.csv')),
    requiredFile(path.join(canonicalImportDir, 'Ecofission-Order Management - OrderDetails.csv')),
    requiredFile(
      path.join(PROJECT_ROOT, 'data', 'supplier-management-sheets', 'Supplier Analysis Tracker - Supplier 2026.csv'),
    ),
    requiredFile(path.join(canonicalImportDir, 'Order Management Clickup Data 06-07-2026.csv')),
  ];
}

type ExportedSellerboardSource = {
  id: string;
  companyName: string;
  sourceType: string;
  domain: string;
  config?: { marketplace?: string; reportUrls?: Array<{ category?: string; url?: string }> };
};

function dateRange(content: string) {
  const format = detectSellerboardDateFormat(content);
  const dates = parseSellerboardCsv(content)
    .rows.map((row) =>
      sellerboardReportDate(new CsvRowReader(row).string('Date', 'Month', 'Timestamp', 'Snapshot Date'), format),
    )
    .filter((value): value is string => Boolean(value))
    .sort();
  return { start: dates[0], end: dates.at(-1) };
}

async function fetchSellerboardReport(source: ExportedSellerboardSource, category: string) {
  const reports = source.config?.reportUrls ?? [];
  const matching = reports.filter((report) => report.category === category && report.url);
  if (matching.length !== 1) {
    throw new Error(`Ecobase import preflight requires one ${category} report for ${source.companyName}.`);
  }
  const response = await fetch(matching[0].url as string);
  if (!response.ok) {
    throw new Error(
      `Ecobase import preflight could not read ${category} for ${source.companyName}: HTTP ${response.status}.`,
    );
  }
  const content = await response.text();
  if (parseSellerboardCsv(content).rows.length === 0) {
    throw new Error(`Ecobase import preflight received an empty ${category} report for ${source.companyName}.`);
  }
  return content;
}

async function sellerboardOptions(files: CsvSourceFile[]) {
  const asOfDate = process.env.ECOBASE_PREFLIGHT_AS_OF_DATE;
  const sourceExportPath = process.env.ECOBASE_PREFLIGHT_SOURCE_EXPORT;
  if (!asOfDate || !sourceExportPath) {
    throw new Error('Ecobase import preflight requires an exported source bundle and an as-of date.');
  }
  const exportData = JSON.parse(readFileSync(sourceExportPath, 'utf8')) as { sources?: ExportedSellerboardSource[] };
  const sources = (exportData.sources ?? []).filter(
    (source) => source.sourceType === 'sellerboard' && source.domain === 'amazon_operations',
  );
  const sellerboardCoverage: SellerboardSourceCoverage[] = [];
  for (const source of sources) {
    const company = resolveCanonicalCompany(source.companyName);
    if (!company) throw new Error(`Ecobase import preflight rejected Sellerboard company ${source.companyName}.`);
    const historyPrefix = Object.entries(FOUR_COMPANY_MIGRATION_PROFILE.sellerboardCompanyFilePrefixes).find(
      ([, companyKey]) => companyKey === company.companyKey,
    )?.[0];
    const localHistory = files.find(
      (file) => historyPrefix && file.name.includes(`${historyPrefix}_Dashboard_by_product_`),
    );
    if (SEED_PROFILE !== 'staging-fast-clickup' && !localHistory) {
      throw new Error(`Ecobase import preflight requires Sellerboard history for ${source.companyName}.`);
    }
    const [stockContent, dailyContent] = await Promise.all([
      fetchSellerboardReport(source, 'stock_daily'),
      fetchSellerboardReport(source, 'profit_by_product_daily'),
      fetchSellerboardReport(source, 'profit_dashboard'),
    ]);
    const stockRange = dateRange(stockContent);
    const localHistoryRange = localHistory ? dateRange(localHistory.content) : { start: undefined, end: undefined };
    const dailyRange = dateRange(dailyContent);
    sellerboardCoverage.push({
      companyKey: company.companyKey,
      account: source.id,
      marketplace: source.config?.marketplace?.trim() || 'amazon.com',
      complete: true,
      currentSnapshotAt: stockRange.end ?? asOfDate,
      historyStartDate: localHistoryRange.start ?? '',
      historyEndDate: dailyRange.end ?? localHistoryRange.end ?? '',
    });
  }
  return {
    asOfDate,
    sellerboardCoverage,
    requireSellerboardHistory: SEED_PROFILE !== 'staging-fast-clickup',
  };
}

function outputPath() {
  const argument = process.argv.find((value) => value.startsWith('--json='));
  return argument ? path.resolve(argument.slice('--json='.length)) : DEFAULT_OUTPUT;
}

async function main() {
  try {
    const files = sourceFiles().map((filePath) => ({
      name: path.relative(PROJECT_ROOT, filePath),
      content: readFileSync(filePath, 'utf8'),
    }));
    const options = await sellerboardOptions(files);
    const result = preflightImportFiles(files, options);
    for (const coverage of options.sellerboardCoverage) {
      console.log(
        SEED_PROFILE === 'staging-fast-clickup'
          ? `Sellerboard coverage ${coverage.companyKey}: current=${coverage.currentSnapshotAt} history=deferred`
          : `Sellerboard coverage ${coverage.companyKey}: current=${coverage.currentSnapshotAt} history=${coverage.historyStartDate}..${coverage.historyEndDate}`,
      );
    }
    const reportPath = outputPath();
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

    console.log(
      `Ecobase import preflight: files=${result.fileCount} rows=${result.rowCount} errors=${result.errorCount} warnings=${result.warningCount}`,
    );
    for (const [code, count] of Object.entries(result.issueCounts)) console.log(`  ${code}: ${count}`);
    console.log(`Report: ${reportPath}`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
