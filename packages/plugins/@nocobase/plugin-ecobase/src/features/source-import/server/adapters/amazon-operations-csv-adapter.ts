/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import type {
  AdapterStreamItem,
  EcobaseSourceType,
  NormalizedRecord,
  SourceAdapter,
  SourceAdapterImportInput,
} from './types';
import {
  CsvRowReader,
  CsvSourceFile,
  normalizedHeaderSet,
  normalizeHeader,
  parseCsv,
  parseDelimitedCsv,
} from './csv-utils';
import { sellerboardMetricValues } from './sellerboard-metrics';
import { analyzeSellerboardHistoryCsvFile } from './sellerboard-history-csv-adapter';
import { requireCanonicalCompany } from '../../../../server/company-identity';

interface FileConfig {
  files?: CsvSourceFile[];
  expectedRowCounts?: Record<string, number>;
  snapshotDate?: string;
}

export type CsvShape =
  | 'master-stock'
  | 'profit-planning'
  | 'profit-tracker'
  | 'top-skus'
  | 'buybox'
  | 'sellerboard-dashboard-goods'
  | 'sellerboard-dashboard-totals'
  | 'sellerboard-history-dashboard-goods'
  | 'sellerboard-cogs'
  | 'sellerboard-stock'
  | 'supplier-analysis-tracker'
  | 'supplier-analysis-2026'
  | 'supplier-ids'
  | 'order-details'
  | 'purchase-orders'
  | 'clickup-order-status'
  | 'unknown';

export interface CsvFileAnalysis {
  name: string;
  checksum: string;
  rowCount: number;
  detectedShape: CsvShape;
  adapterName: string | null;
  sourceType: EcobaseSourceType | null;
  domain: string | null;
  importable: boolean;
  warnings: string[];
}

export interface CsvBundleAnalysisGroup {
  adapterName: string;
  sourceType: EcobaseSourceType;
  domain: string;
  files: string[];
}

export interface CsvBundleAnalysis {
  files: CsvFileAnalysis[];
  groups: CsvBundleAnalysisGroup[];
}

function asFileConfig(config: Record<string, unknown>): FileConfig {
  return config as FileConfig;
}

function getFiles(config: FileConfig): CsvSourceFile[] {
  return Array.isArray(config.files) ? config.files : [];
}

function has(headers: Set<string>, name: string) {
  return headers.has(normalizeHeader(name));
}

function analyzeSellerboardCogsCsvFile(file: CsvSourceFile) {
  const parsed = parseDelimitedCsv(file.content ?? '', ';');
  const headers = normalizedHeaderSet(parsed.headers);
  return {
    rowCount: parsed.rows.length,
    detectedShape:
      has(headers, 'ASIN') && has(headers, 'CostPeriodStartDate') && has(headers, 'Cost')
        ? ('sellerboard-cogs' as const)
        : undefined,
  };
}

export function detectCsvShape(headers: string[]): CsvShape {
  const normalized = normalizedHeaderSet(headers);
  if (has(normalized, 'Featured Offer (Buy Box) Percentage')) return 'buybox';
  if (has(normalized, 'Current Week') && has(normalized, 'Refund Units')) return 'profit-tracker';
  if (has(normalized, 'Exp Sales Vel') && has(normalized, 'Month')) return 'profit-planning';
  if (has(normalized, 'Tier') && has(normalized, 'SKU Multiple Listings')) return 'top-skus';
  if (has(normalized, 'Date') && has(normalized, 'SalesOrganic') && has(normalized, 'ASIN'))
    return 'sellerboard-dashboard-goods';
  if (has(normalized, 'Date') && has(normalized, 'Orders') && !has(normalized, 'ASIN'))
    return 'sellerboard-dashboard-totals';
  if (has(normalized, 'FBA/FBM Stock') && has(normalized, 'Company')) return 'master-stock';
  if (has(normalized, 'FBA/FBM Stock') && has(normalized, 'ROI, %')) return 'sellerboard-stock';
  if (has(normalized, 'SR ID') && has(normalized, 'Supplier Name') && has(normalized, 'Wholesale Price List'))
    return 'supplier-analysis-tracker';
  if (has(normalized, 'SR ID') && has(normalized, 'Supplier Name') && has(normalized, 'Supplier Type'))
    return 'supplier-analysis-2026';
  if (has(normalized, 'SR ID') && has(normalized, 'Supplier Name')) return 'supplier-ids';
  if (has(normalized, 'Task ID') && has(normalized, 'Task Name') && has(normalized, 'Status'))
    return 'clickup-order-status';
  if (has(normalized, 'Order ID') && has(normalized, 'Lead time(day)')) return 'order-details';
  if (has(normalized, 'Timestamp') && has(normalized, 'Order ID') && has(normalized, 'Payment Status'))
    return 'purchase-orders';
  return 'unknown';
}

function csvFileChecksum(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export function targetForCsvShape(shape: CsvShape): Omit<CsvBundleAnalysisGroup, 'files'> | null {
  if (shape === 'unknown') {
    return null;
  }
  if (
    shape === 'order-details' ||
    shape === 'purchase-orders' ||
    shape === 'supplier-analysis-tracker' ||
    shape === 'supplier-ids'
  ) {
    // Supplier IDs join the canonical supplier-order group so Analyze -> Run hands the
    // importer all three sources (PO + OrderDetails + Supplier IDs) in one group; it
    // previously landed in google-sheets-migration-csv and the run threw
    // "requires one supplier_ids source; received 0".
    return { adapterName: 'supplier-order-csv', sourceType: 'google_sheets', domain: 'order_management' };
  }
  if (shape === 'supplier-analysis-2026') {
    return { adapterName: 'google-sheets-migration-csv', sourceType: 'google_sheets', domain: 'supplier_management' };
  }
  if (shape === 'clickup-order-status') {
    return { adapterName: 'clickup-order-status-csv', sourceType: 'clickup', domain: 'order_management' };
  }
  if (shape === 'sellerboard-history-dashboard-goods') {
    return { adapterName: 'sellerboard-history-csv', sourceType: 'sellerboard', domain: 'amazon_operations' };
  }
  if (shape === 'sellerboard-cogs') {
    return { adapterName: 'sellerboard-cogs-csv', sourceType: 'sellerboard', domain: 'amazon_operations' };
  }
  if (
    shape === 'sellerboard-dashboard-goods' ||
    shape === 'sellerboard-dashboard-totals' ||
    shape === 'sellerboard-stock'
  ) {
    return { adapterName: 'sellerboard-csv', sourceType: 'sellerboard', domain: 'amazon_operations' };
  }
  return { adapterName: 'amazon-operations-csv', sourceType: 'seller_central_file', domain: 'amazon_operations' };
}

export function analyzeCsvFile(file: CsvSourceFile): CsvFileAnalysis {
  const warnings: string[] = [];
  if (!file.name || file.name.trim().length === 0) {
    warnings.push('CSV file name is required.');
  }
  if (!file.content || file.content.trim().length === 0) {
    warnings.push('CSV file content is empty.');
  }
  const parsed = parseCsv(file.content ?? '');
  let detectedShape = detectCsvShape(parsed.headers);
  let rowCount = parsed.rows.length;
  if (detectedShape === 'unknown') {
    const historyAnalysis = analyzeSellerboardHistoryCsvFile(file);
    if (historyAnalysis.detectedShape) {
      detectedShape = historyAnalysis.detectedShape;
      rowCount = historyAnalysis.rowCount;
    } else {
      const cogsAnalysis = analyzeSellerboardCogsCsvFile(file);
      if (cogsAnalysis.detectedShape) {
        detectedShape = cogsAnalysis.detectedShape;
        rowCount = cogsAnalysis.rowCount;
      }
    }
  }
  const target = targetForCsvShape(detectedShape);
  if (!target) {
    warnings.push(`Ecobase could not identify the CSV shape for ${file.name || '(unnamed file)'}.`);
  }
  if (typeof file.expectedRowCount === 'number' && file.expectedRowCount !== rowCount) {
    warnings.push(`Expected ${file.expectedRowCount} rows but parsed ${rowCount}.`);
  }
  return {
    name: file.name,
    checksum: csvFileChecksum(file.content ?? ''),
    rowCount,
    detectedShape,
    adapterName: target?.adapterName ?? null,
    sourceType: target?.sourceType ?? null,
    domain: target?.domain ?? null,
    importable: Boolean(target) && warnings.every((warning) => !warning.includes('content is empty')),
    warnings,
  };
}

export function analyzeCsvFiles(files: CsvSourceFile[]): CsvBundleAnalysis {
  const analyzedFiles = files.map(analyzeCsvFile);
  const groups = new Map<string, CsvBundleAnalysisGroup>();
  for (const file of analyzedFiles) {
    if (!file.importable || !file.adapterName || !file.sourceType || !file.domain) {
      continue;
    }
    const key = `${file.adapterName}:${file.sourceType}:${file.domain}`;
    const group = groups.get(key) ?? {
      adapterName: file.adapterName,
      sourceType: file.sourceType,
      domain: file.domain,
      files: [],
    };
    group.files.push(file.name);
    groups.set(key, group);
  }
  return { files: analyzedFiles, groups: [...groups.values()] };
}

function getSnapshotDate(file: CsvSourceFile, input: SourceAdapterImportInput, row: CsvRowReader) {
  const value = file.snapshotDate ?? row.string('Date', 'Month', 'Timestamp') ?? input.sourceVersion;
  return (file.dateFormat === 'month-first' ? sellerboardIsoDate(value) : isoDate(value)) ?? value;
}

function canonicalCompanyName(value: string | undefined) {
  return value ? requireCanonicalCompany(value).name : undefined;
}

function defaultCompany(input: SourceAdapterImportInput) {
  const value = input.config.defaultCompany;
  return typeof value === 'string' ? canonicalCompanyName(value) : undefined;
}

function companyOf(input: SourceAdapterImportInput, row: CsvRowReader) {
  return canonicalCompanyName(row.string('Company')) ?? defaultCompany(input);
}

export function sellerboardIsoDate(value: string | undefined) {
  if (!value) return undefined;
  const slashDate = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slashDate) return isoDate(value);
  const month = Number(slashDate[1]);
  const day = Number(slashDate[2]);
  const date = new Date(Date.UTC(Number(slashDate[3]), month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${slashDate[3]}-${slashDate[1].padStart(2, '0')}-${slashDate[2].padStart(2, '0')}`;
}

function isoDate(value: string) {
  const trimmed = value.trim();
  const isoDateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    return `${isoDateOnly[1]}-${isoDateOnly[2]}-${isoDateOnly[3]}`;
  }
  const slashDate = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const day = second > 12 ? slashDate[2] : slashDate[1];
    const month = second > 12 ? slashDate[1] : slashDate[2];
    if (first > 12) {
      return `${slashDate[3]}-${slashDate[2].padStart(2, '0')}-${slashDate[1].padStart(2, '0')}`;
    }
    return `${slashDate[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString().slice(0, 10);
}

function productLeadTimeDays(row: CsvRowReader) {
  return row.number('Lead Time', 'Lead time(day)', 'Manuf. time days');
}

function isoDateTime(value: string) {
  const trimmed = value.trim();
  const slashDate = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const day = second > 12 ? slashDate[2] : slashDate[1];
    const month = second > 12 ? slashDate[1] : slashDate[2];
    const hour = (slashDate[4] ?? '00').padStart(2, '0');
    const minute = (slashDate[5] ?? '00').padStart(2, '0');
    const secondPart = (slashDate[6] ?? '00').padStart(2, '0');
    if (first > 12) {
      return `${slashDate[3]}-${slashDate[2].padStart(2, '0')}-${slashDate[1].padStart(
        2,
        '0',
      )}T${hour}:${minute}:${secondPart}.000Z`;
    }
    return `${slashDate[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour}:${minute}:${secondPart}.000Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function firstDate(row: CsvRowReader, ...headers: string[]) {
  for (const header of headers) {
    const value = row.string(header);
    if (!value) {
      continue;
    }
    const normalized = isoDate(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function firstDateTime(row: CsvRowReader, ...headers: string[]) {
  for (const header of headers) {
    const value = row.string(header);
    if (!value) {
      continue;
    }
    const normalized = isoDateTime(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

const MONTH_INDEX: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

function pad2(value: string) {
  return value.padStart(2, '0');
}

function normalizeTargetPeriod(rawPeriod: string) {
  const period = rawPeriod.trim();
  const monthNameYear = period.match(/^([A-Za-z]+)[\s/,-]+(\d{4})$/);
  if (monthNameYear) {
    const month = MONTH_INDEX[monthNameYear[1].toLowerCase()];
    if (month) return { period: `${monthNameYear[2]}-${month}`, periodType: 'monthly' as const };
  }

  const isoMonthOrDate = period.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (isoMonthOrDate) {
    const normalized = isoMonthOrDate[3]
      ? `${isoMonthOrDate[1]}-${pad2(isoMonthOrDate[2])}-${pad2(isoMonthOrDate[3])}`
      : `${isoMonthOrDate[1]}-${pad2(isoMonthOrDate[2])}`;
    return { period: normalized, periodType: isoMonthOrDate[3] ? ('daily' as const) : ('monthly' as const) };
  }

  const dayMonthYear = period.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dayMonthYear) {
    return {
      period: `${dayMonthYear[3]}-${pad2(dayMonthYear[2])}-${pad2(dayMonthYear[1])}`,
      periodType: 'daily' as const,
    };
  }

  const normalizedLower = period.toLowerCase();
  return { period, periodType: normalizedLower.includes('week') ? ('weekly' as const) : ('monthly' as const) };
}

function sourceKeyFor(row: CsvRowReader, fallback: string) {
  const asin = row.string('ASIN', 'ASIN ');
  const sku = row.string('SKU');
  if (asin && sku) {
    return `${asin}:${sku}`;
  }
  if (sku) {
    return sku;
  }
  if (asin) {
    return `${asin}:${fallback}`;
  }
  return row.string('Order ID', 'SR ID', 'SR ID ') ?? fallback;
}

function naturalKey(input: SourceAdapterImportInput, kind: string, parts: Array<string | number | undefined>) {
  return [input.sourceConnectionId, kind, ...parts.map((part) => String(part ?? ''))].join(':');
}

function canonicalAsin(row: CsvRowReader) {
  return row.string('ASIN', 'ASIN ')?.toUpperCase();
}

function listingIdentityParts(row: CsvRowReader, sourceKey: string) {
  const company = row.string('Company');
  const marketplace = row.string('Marketplace', 'Market ');
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  return [company, marketplace, asin ?? sourceKey, sku ?? sourceKey];
}

function listingRecord(input: SourceAdapterImportInput, row: CsvRowReader, sourceKey: string): NormalizedRecord {
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  return {
    kind: 'raw_listing',
    data: {
      naturalKey: naturalKey(input, 'raw_listing', listingIdentityParts(row, sourceKey)),
      sourceConnectionId: input.sourceConnectionId,
      asin,
      sku,
      title: row.string('Title', 'Name'),
      company: row.string('Company'),
      brand: row.string('Brand', 'Brand '),
      supplier: row.string('Supplier', 'Supplier ', 'Supplier Name'),
      marketplace: row.string('Marketplace', 'Market '),
      payload: row.payload(),
    },
  };
}

function inventoryRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  snapshotDate: string,
  sourceKey: string,
): NormalizedRecord {
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  return {
    kind: 'inventory_snapshot',
    data: {
      naturalKey: naturalKey(input, 'inventory_snapshot', [snapshotDate, ...listingIdentityParts(row, sourceKey)]),
      sourceConnectionId: input.sourceConnectionId,
      snapshotDate,
      company: row.string('Company'),
      asin,
      sku,
      stock: row.number('FBA/FBM Stock', 'Current Stock', 'Stock ', 'FBA', 'Qty'),
      reserved: row.number('Reserved', 'Rerv.', 'Qty in Prep or Reserved'),
      inbound: row.number('Sent  to FBA', 'Inbound'),
      ordered: row.number('Ordered'),
      prepStock: row.number('Prep Stock', 'Prep Center Stock', 'Prep-center stock', 'Prep Center Qty'),
      salesVelocity: row.number('Estimated Sales Velocity', 'Exp Sales Vel', 'Sales Velocity'),
      daysOfStockLeft: row.number('Days  of stock  left', 'Days of Stock Left'),
      recommendedReorderQuantity: row.number('Recommended quantity for  reordering', 'Rec. Best Qty', 'Rec.Best Qty'),
      payload: row.payload(),
    },
  };
}

function planningRecord(input: SourceAdapterImportInput, row: CsvRowReader, sourceKey: string): NormalizedRecord {
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  return {
    kind: 'planning_parameter',
    data: {
      naturalKey: naturalKey(input, 'planning_parameter', [
        ...listingIdentityParts(row, sourceKey),
        row.string('SR ID', 'SR ID '),
      ]),
      sourceConnectionId: input.sourceConnectionId,
      company: row.string('Company'),
      asin,
      sku,
      supplier: row.string('Supplier', 'Supplier ', 'Supplier Name'),
      supplierId: row.string('SR ID', 'SR ID '),
      cogs: row.number('COGS', 'COG (Incl all costs)', 'Cost of Goods', 'PPU', 'Exp. Cost '),
      profitPerUnit: row.number('Profit Per Unit', 'Per.Unit Profit'),
      targetStockRangeDays: row.number('Target stock range after new order days'),
      leadTimeDays: productLeadTimeDays(row),
      safetyBufferDays: row.number('Safety Buffer Days', 'safety_buffer_days'),
      payload: row.payload(),
    },
  };
}

function supplierRecords(input: SourceAdapterImportInput, row: CsvRowReader, sourceKey: string): NormalizedRecord[] {
  const supplierName = row.string('Supplier', 'Supplier ', 'Supplier Name');
  const supplierId = row.string('SR ID', 'SR ID ');
  const leadTimeDays = productLeadTimeDays(row);
  if (!supplierName && !supplierId) {
    return [];
  }
  const company = row.string('Company');
  const supplierKey = supplierId ?? supplierName ?? sourceKey;
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  const productLeadTimeScope = Boolean(asin || sku);
  const records: NormalizedRecord[] = [
    {
      kind: 'supplier',
      data: {
        naturalKey: naturalKey(input, 'supplier', [company, supplierKey]),
        sourceConnectionId: input.sourceConnectionId,
        supplierId,
        name: supplierName,
        company,
        payload: row.payload(),
      },
    },
  ];
  if (typeof leadTimeDays === 'number') {
    records.push({
      kind: 'supplier_lead_time',
      data: {
        naturalKey: naturalKey(input, 'supplier_lead_time', [
          company,
          supplierKey,
          productLeadTimeScope ? 'product' : 'default',
          productLeadTimeScope ? asin ?? sku : undefined,
        ]),
        sourceConnectionId: input.sourceConnectionId,
        supplierId,
        supplierName,
        company,
        asin,
        sku,
        scope: productLeadTimeScope ? 'product' : 'default',
        leadTimeDays,
        payload: row.payload(),
      },
    });
  }
  return records;
}

function supplierExternalCode(row: CsvRowReader) {
  const value = row.string('SR ID', 'SR ID ');
  return value && value.toLowerCase() !== 'duplicate' ? value : undefined;
}

function yesNoBoolean(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'active', 'approved', 'completed'].includes(normalized)) return true;
  if (['no', 'inactive', 'rejected', 'cancelled', 'canceled'].includes(normalized)) return false;
  return undefined;
}

function supplierManagementCompany(input: SourceAdapterImportInput, row: CsvRowReader) {
  return companyOf(input, row) ?? canonicalCompanyName(row.string('Reached Via'));
}

function supplierApprovalStatus(row: CsvRowReader) {
  const status = lower(row.string('Status', 'Current Status'));
  const activeStatus = lower(row.string('Active Status'));
  const emailDone = lower(row.string('Email Done?'));
  const callDone = lower(row.string('Call Done?'));
  const respondedBy = lower(row.string('Responded By'));
  if (hasAny(status, ['approved', 'completed', 'cleared'])) return 'approved';
  if (hasAny(status, ['rejected', 'cancelled', 'canceled', 'inactive'])) return 'rejected';
  if (hasAny(status, ['analysis', 'analysed', 'analyzed']) || respondedBy) return 'analyzing';
  if (
    hasAny(status, ['progress', 'submitted', 'sent']) ||
    activeStatus === 'yes' ||
    emailDone === 'yes' ||
    callDone === 'yes'
  ) {
    return 'contacting';
  }
  return 'new';
}

function supplierAccountStatus(row: CsvRowReader) {
  const status = lower(row.string('Status', 'Current Status'));
  if (hasAny(status, ['approved', 'completed', 'cleared'])) return 'approved';
  if (hasAny(status, ['rejected', 'cancelled', 'canceled'])) return 'rejected';
  if (hasAny(status, ['submitted', 'progress', 'sent'])) return 'submitted';
  return 'not_started';
}

function supplierAnalysisStatus(row: CsvRowReader) {
  if (row.number('TNOP Analysed') || row.number('Prof. Products') || row.string('Remarks SA')) return 'done';
  if (lower(row.string('Responded By')) || lower(row.string('Feedback'))) return 'in_progress';
  return 'not_started';
}

function supplierManagementRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  sourceKey: string,
): NormalizedRecord[] {
  const company = supplierManagementCompany(input, row);
  const supplierName = row.string('Supplier Name');
  const supplierId = supplierExternalCode(row);
  const displayName = supplierName ?? supplierId;
  if (!supplierId || !displayName) {
    return [];
  }
  const statusActive = yesNoBoolean(row.string('Active Status'));
  const currentStatusActive = yesNoBoolean(row.string('Current Status'));
  const active = statusActive ?? currentStatusActive ?? true;
  const contacted = lower(row.string('Email Done?')) === 'yes' || lower(row.string('Call Done?')) === 'yes';
  return [
    {
      kind: 'supplier',
      data: {
        naturalKey: naturalKey(input, 'supplier', [supplierId]),
        sourceConnectionId: input.sourceConnectionId,
        supplierId,
        name: displayName,
        normalizedName: displayName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim(),
        company,
        asin: canonicalAsin(row),
        market: row.string('Market'),
        srBy: row.string('SR by'),
        wholesalePriceList: row.string('Wholesale Price List'),
        productCatalog: row.string('Product Catalog'),
        mapAgreement: row.string('MAP agreement'),
        prPortalLink: row.string('PR Portal Link'),
        portalUsername: row.string('Username'),
        portalPassword: row.string('pass'),
        contactName: row.string('Contact Person'),
        reachedVia: row.string('Reached Via'),
        receivedEmail: row.string('Recieved Email', 'Received Email'),
        remarks: row.string('Remarks'),
        moq: row.string('MOQ'),
        designation: row.string('Designation'),
        category: row.string('Category'),
        amazonAllow: row.string('Amazon Allow'),
        supplierType: row.string('Supplier Type'),
        presenceOnAmazon: row.string('Presence on Amazon'),
        currentStatus: row.string('Current Status'),
        supplierStatus: row.string('Status'),
        activeStatus: row.string('Active Status'),
        emailDone: row.string('Email Done?'),
        callDone: row.string('Call Done?'),
        respondedBy: row.string('Responded By'),
        efSentStatus: row.string('EF Sent Status'),
        ssSentStatus: row.string('SS Sent Status'),
        mxSentStatus: row.string('MX Sent Status'),
        rhSentStatus: row.string('RH Sent Status'),
        feedback: row.string('Feedback'),
        saBy: row.string('SA By'),
        easyMoveSisterCompany: row.string('Easy Move(Sister Company )'),
        bulkUpload: row.string('Bulk Upload'),
        totalNop: row.string('Total NOP'),
        tnopAnalysed: row.string('TNOP Analysed'),
        profitableProducts: row.string('Prof. Products'),
        inventoryMarginPositiveAmount: row.string('Inv. margin >0.00%'),
        inventoryMarginFivePercentAmount: row.string('Inv.margin>4.99%'),
        inventoryMarginNinePercentAmount: row.string('Inv.margin>8.99%'),
        clearedPosAmount: row.string('Cleared POs Amount'),
        sheetLink: row.string('Sheet Link'),
        remarksSa: row.string('Remarks SA'),
        analysisIssueRemarks: row.string('Remarks ( Analysed / facing any issue )'),
        used: row.string('Used ', 'Used'),
        tasksSubmitted: row.string('Tasks Submitted'),
        timestamp: firstDateTime(row, 'Timestamp'),
        dateOfUpdate: firstDate(row, 'Date of Update'),
        approvalStatus: supplierApprovalStatus(row),
        accountStatus: supplierAccountStatus(row),
        analysisStatus: supplierAnalysisStatus(row),
        lastContactedAt: contacted ? firstDateTime(row, 'Timestamp', 'Date of Update') : undefined,
        contactEstablished: contacted,
        approvalNotes: row.string('Remarks SA', 'Feedback', 'Remarks'),
        active,
        lastSeenAt: new Date().toISOString(),
        payload: row.payload(),
      },
    },
  ];
}

function compactReference(value: string, maxLength = 180) {
  if (value.length <= maxLength) {
    return value;
  }
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${value.slice(0, maxLength - 17)}:${hash}`;
}

function lower(value: string | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function hasAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

function dailyFactRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  snapshotDate: string,
  sourceKey: string,
): NormalizedRecord {
  const asin = canonicalAsin(row) ?? '__TOTAL__';
  const sku = row.string('SKU') ?? asin;
  const sellerboardMetrics = sellerboardMetricValues(row);
  return {
    kind: 'listing_daily_fact',
    data: {
      naturalKey: naturalKey(input, 'listing_daily_fact', [snapshotDate, ...listingIdentityParts(row, sourceKey)]),
      sourceConnectionId: input.sourceConnectionId,
      snapshotDate,
      company: row.string('Company'),
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

function trafficRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  snapshotDate: string,
  sourceKey: string,
): NormalizedRecord {
  const asin = canonicalAsin(row);
  const sku = row.string('SKU') ?? asin;
  return {
    kind: 'traffic_snapshot',
    data: {
      naturalKey: naturalKey(input, 'traffic_snapshot', [snapshotDate, ...listingIdentityParts(row, sourceKey)]),
      sourceConnectionId: input.sourceConnectionId,
      snapshotDate,
      asin,
      sku,
      sessions: row.number('Sessions', 'Sessions - Total'),
      pageViews: row.number('Page Views - Total'),
      buyBoxPercentage: row.number('Featured Offer (Buy Box) Percentage', 'BB %'),
      unitsOrdered: row.number('Units Ordered'),
      orderedProductSales: row.number('Ordered Product Sales'),
      payload: row.payload(),
    },
  };
}

function targetRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  period: string,
  sourceKey: string,
): NormalizedRecord {
  const asin = canonicalAsin(row);
  const sku = row.string('SKU');
  const normalizedPeriod = normalizeTargetPeriod(period);
  return {
    kind: 'target_row',
    data: {
      naturalKey: naturalKey(input, 'target_row', [
        normalizedPeriod.period,
        ...listingIdentityParts(row, sourceKey),
        row.string('Order ID'),
      ]),
      sourceConnectionId: input.sourceConnectionId,
      company: row.string('Company'),
      accountKey: row.string('Account', 'Amazon Account', 'Marketplace', 'Market '),
      targetScope: asin ? 'planning_product' : row.string('Account', 'Amazon Account') ? 'account' : 'company',
      period: normalizedPeriod.period,
      periodType: normalizedPeriod.periodType,
      asin,
      sku,
      unitTarget: row.number(
        'Unit Target ',
        'MTD Unit Target',
        'Rec.Best Qty',
        'Rec. Next MnthQty',
        'Qty',
        'Total units',
      ),
      profitTarget: row.number(
        'Profit Target',
        'MTD Profit Target',
        'Rec.Best Profit',
        'Actual Best Profit',
        'T.Profit',
      ),
      payload: row.payload(),
    },
  };
}

function recordsForShape(
  shape: CsvShape,
  input: SourceAdapterImportInput,
  file: CsvSourceFile,
  row: CsvRowReader,
  sourceKey: string,
): NormalizedRecord[] {
  const snapshotDate = getSnapshotDate(file, input, row);
  if (shape === 'master-stock' || shape === 'sellerboard-stock') {
    return [
      listingRecord(input, row, sourceKey),
      inventoryRecord(input, row, snapshotDate, sourceKey),
      planningRecord(input, row, sourceKey),
      ...supplierRecords(input, row, sourceKey),
    ];
  }
  if (shape === 'profit-planning') {
    const period = row.string('Month') ?? snapshotDate;
    return [
      planningRecord(input, row, sourceKey),
      ...supplierRecords(input, row, sourceKey),
      targetRecord(input, row, period, sourceKey),
    ];
  }
  if (shape === 'profit-tracker') {
    const period = row.string('Month') ?? snapshotDate;
    return [
      dailyFactRecord(input, row, snapshotDate, sourceKey),
      inventoryRecord(input, row, snapshotDate, sourceKey),
      targetRecord(input, row, period, sourceKey),
    ];
  }
  if (shape === 'top-skus')
    return [
      listingRecord(input, row, sourceKey),
      planningRecord(input, row, sourceKey),
      ...supplierRecords(input, row, sourceKey),
    ];
  if (shape === 'buybox') return [trafficRecord(input, row, snapshotDate, sourceKey)];
  if (shape === 'sellerboard-dashboard-goods' || shape === 'sellerboard-dashboard-totals') {
    return [dailyFactRecord(input, row, snapshotDate, sourceKey), trafficRecord(input, row, snapshotDate, sourceKey)];
  }
  if (shape === 'supplier-ids' || shape === 'supplier-analysis-2026') {
    return supplierManagementRecord(input, row, sourceKey);
  }
  return [];
}

export async function* importCsvFiles(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
  const files = getFiles(asFileConfig(input.config));
  if (files.length === 0) {
    yield {
      type: 'rowIssue',
      issue: {
        rowNumber: 0,
        severity: 'error',
        code: 'csv_files_missing',
        message: 'Ecobase CSV import requires inline CSV entries in config.files.',
      },
    };
    return;
  }

  for (const file of files) {
    const parsed = parseCsv(file.content);
    const expectedRowCount = file.expectedRowCount ?? asFileConfig(input.config).expectedRowCounts?.[file.name];
    if (typeof expectedRowCount === 'number' && expectedRowCount !== parsed.rows.length) {
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'warning',
          code: 'csv_row_count_mismatch',
          message: `Ecobase CSV import expected ${expectedRowCount} rows for ${file.name} but parsed ${parsed.rows.length}.`,
          sourceKey: file.name,
          payload: { expectedRowCount, actualRowCount: parsed.rows.length },
        },
      };
    }

    const shape = detectCsvShape(parsed.headers);
    if (shape === 'unknown') {
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'error',
          code: 'csv_shape_unknown',
          message: `Ecobase CSV import could not identify the file shape for ${file.name}.`,
          sourceKey: file.name,
          payload: { fileName: file.name, headerCount: parsed.headers.length },
        },
      };
      continue;
    }
    if (shape === 'supplier-analysis-tracker' || shape === 'purchase-orders' || shape === 'order-details') {
      yield {
        type: 'rowIssue',
        issue: {
          rowNumber: 0,
          severity: 'error',
          code: 'canonical_supplier_order_import_required',
          message: `Ecobase CSV import requires the canonical supplier/order importer for ${file.name}.`,
          sourceKey: file.name,
          payload: { fileName: file.name, shape },
        },
      };
      continue;
    }

    for (const [index, row] of parsed.rows.entries()) {
      const reader = new CsvRowReader(row);
      const rowNumber = index + 2;
      const sourceKey = compactReference(`${file.name}:${sourceKeyFor(reader, String(rowNumber))}`);
      if (shape === 'supplier-analysis-2026' && reader.string('Reached Via')?.trim().toLowerCase() === 'call & email') {
        yield {
          type: 'rowIssue',
          issue: {
            rowNumber,
            severity: 'warning',
            code: 'supplier_row_excluded_invalid_company',
            message: `Ecobase CSV import excluded ${file.name} row ${rowNumber} because Reached Via contains a contact method instead of a company.`,
            sourceKey,
            payload: row,
          },
        };
        continue;
      }
      if (
        !reader.string('ASIN', 'ASIN ', 'SKU', 'Order ID', 'SR ID', 'SR ID ') &&
        shape !== 'sellerboard-dashboard-totals'
      ) {
        yield {
          type: 'rowIssue',
          issue: {
            rowNumber,
            severity: 'warning',
            code: 'csv_row_identity_missing',
            message: `Ecobase CSV import skipped row ${rowNumber} in ${file.name} because no ASIN, SKU, order id, or supplier id was present.`,
            sourceKey,
            payload: row,
          },
        };
        continue;
      }

      const records = recordsForShape(shape, input, file, reader, sourceKey);
      if (records.length === 0) {
        yield {
          type: 'rowIssue',
          issue: {
            rowNumber,
            severity: 'warning',
            code: 'csv_row_not_mapped',
            message: `Ecobase CSV import recognized ${shape} but did not create normalized records for row ${rowNumber}.`,
            sourceKey,
            payload: row,
          },
        };
        continue;
      }

      yield {
        type: 'record',
        rowNumber,
        sourceKey,
        payload: row,
        record: records,
      };
    }
  }
}

export const amazonOperationsCsvAdapter: SourceAdapter = {
  metadata: {
    name: 'amazon-operations-csv',
    title: 'Amazon operations CSV',
    sourceType: 'seller_central_file',
    supportedDomains: ['amazon_operations', 'foundation'],
    version: '1.0.0',
  },
  import: importCsvFiles,
};

export const googleSheetsMigrationCsvAdapter: SourceAdapter = {
  metadata: {
    name: 'google-sheets-migration-csv',
    title: 'Google Sheets migration CSV',
    sourceType: 'google_sheets',
    supportedDomains: ['amazon_operations', 'foundation', 'order_management', 'supplier_management'],
    version: '1.0.0',
  },
  import: importCsvFiles,
};

export const sellerboardCsvAdapter: SourceAdapter = {
  metadata: {
    name: 'sellerboard-csv',
    title: 'Sellerboard CSV',
    sourceType: 'sellerboard',
    supportedDomains: ['amazon_operations', 'foundation'],
    version: '1.0.0',
  },
  import: importCsvFiles,
};
