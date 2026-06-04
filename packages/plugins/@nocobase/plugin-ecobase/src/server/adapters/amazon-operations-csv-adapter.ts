import type { AdapterStreamItem, NormalizedRecord, SourceAdapter, SourceAdapterImportInput } from './types';
import { CsvRowReader, CsvSourceFile, normalizedHeaderSet, normalizeHeader, parseCsv } from './csv-utils';

interface FileConfig {
  files?: CsvSourceFile[];
  expectedRowCounts?: Record<string, number>;
  snapshotDate?: string;
}

type CsvShape =
  | 'master-stock'
  | 'profit-planning'
  | 'profit-tracker'
  | 'top-skus'
  | 'buybox'
  | 'sellerboard-dashboard-goods'
  | 'sellerboard-dashboard-totals'
  | 'sellerboard-stock'
  | 'supplier-ids'
  | 'order-details'
  | 'purchase-orders'
  | 'unknown';

function asFileConfig(config: Record<string, unknown>): FileConfig {
  return config as FileConfig;
}

function getFiles(config: FileConfig): CsvSourceFile[] {
  return Array.isArray(config.files) ? config.files : [];
}

function has(headers: Set<string>, name: string) {
  return headers.has(normalizeHeader(name));
}

function detectShape(headers: string[]): CsvShape {
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
  if (has(normalized, 'SR ID') && has(normalized, 'Supplier Name')) return 'supplier-ids';
  if (has(normalized, 'Order ID') && has(normalized, 'Lead time(day)')) return 'order-details';
  if (has(normalized, 'Timestamp') && has(normalized, 'Order ID') && has(normalized, 'Payment Status'))
    return 'purchase-orders';
  return 'unknown';
}

function getSnapshotDate(file: CsvSourceFile, input: SourceAdapterImportInput, row: CsvRowReader) {
  return file.snapshotDate ?? row.string('Date', 'Month', 'Timestamp') ?? input.sourceVersion;
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
      asin,
      sku,
      supplier: row.string('Supplier', 'Supplier ', 'Supplier Name'),
      supplierId: row.string('SR ID', 'SR ID '),
      cogs: row.number('COGS', 'COG (Incl all costs)', 'Cost of Goods', 'PPU', 'Exp. Cost '),
      profitPerUnit: row.number('Profit Per Unit', 'Per.Unit Profit'),
      targetStockRangeDays: row.number('Target stock range after new order days'),
      leadTimeDays: row.number('Lead time(day)', 'Manuf. time days'),
      payload: row.payload(),
    },
  };
}

function dailyFactRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  snapshotDate: string,
  sourceKey: string,
): NormalizedRecord {
  const asin = canonicalAsin(row) ?? '__TOTAL__';
  const sku = row.string('SKU') ?? asin;
  return {
    kind: 'listing_daily_fact',
    data: {
      naturalKey: naturalKey(input, 'listing_daily_fact', [snapshotDate, ...listingIdentityParts(row, sourceKey)]),
      sourceConnectionId: input.sourceConnectionId,
      snapshotDate,
      company: row.string('Company'),
      asin,
      sku,
      sales: row.number('SalesOrganic', 'Ordered Product Sales', 'Total Sales'),
      units: row.number('UnitsOrganic', 'Units Achieved', 'Units Ordered'),
      refunds: row.number('Refunds', 'Refund Units'),
      refundRate: row.number('% Refund', 'Sellable Returns %'),
      grossProfit: row.number('GrossProfit'),
      netProfit: row.number('NetProfit', 'Profit Achieved'),
      margin: row.number('Margin', 'Margin '),
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
  return {
    kind: 'target_row',
    data: {
      naturalKey: naturalKey(input, 'target_row', [
        period,
        ...listingIdentityParts(row, sourceKey),
        row.string('Order ID'),
      ]),
      sourceConnectionId: input.sourceConnectionId,
      period,
      periodType: period.includes('/') ? 'daily' : 'monthly',
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
    ];
  }
  if (shape === 'profit-planning') {
    const period = row.string('Month') ?? snapshotDate;
    return [planningRecord(input, row, sourceKey), targetRecord(input, row, period, sourceKey)];
  }
  if (shape === 'profit-tracker') {
    const period = row.string('Month') ?? snapshotDate;
    return [
      dailyFactRecord(input, row, snapshotDate, sourceKey),
      inventoryRecord(input, row, snapshotDate, sourceKey),
      targetRecord(input, row, period, sourceKey),
    ];
  }
  if (shape === 'top-skus') return [listingRecord(input, row, sourceKey), planningRecord(input, row, sourceKey)];
  if (shape === 'buybox') return [trafficRecord(input, row, snapshotDate, sourceKey)];
  if (shape === 'sellerboard-dashboard-goods' || shape === 'sellerboard-dashboard-totals') {
    return [dailyFactRecord(input, row, snapshotDate, sourceKey), trafficRecord(input, row, snapshotDate, sourceKey)];
  }
  if (shape === 'supplier-ids') return [planningRecord(input, row, sourceKey)];
  if (shape === 'order-details' || shape === 'purchase-orders') {
    const period = row.string('Timestamp') ?? snapshotDate;
    return [planningRecord(input, row, sourceKey), targetRecord(input, row, period, sourceKey)];
  }
  return [];
}

async function* importCsvFiles(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
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

    const shape = detectShape(parsed.headers);
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

    for (const [index, row] of parsed.rows.entries()) {
      const reader = new CsvRowReader(row);
      const rowNumber = index + 2;
      const sourceKey = `${file.name}:${sourceKeyFor(reader, String(rowNumber))}`;
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
    supportedDomains: ['amazon_operations', 'foundation', 'order_management'],
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
