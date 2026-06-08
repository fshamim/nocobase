import { createHash } from 'node:crypto';
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
  | 'pre-order-sheet'
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
  if (
    has(normalized, 'Order ID') &&
    has(normalized, 'Qty') &&
    !has(normalized, 'Lead time(day)') &&
    !has(normalized, 'Payment Status') &&
    (has(normalized, 'ETA on Amazon') ||
      has(normalized, 'Arrival to Amazon') ||
      has(normalized, 'Expected Sellable Date'))
  )
    return 'pre-order-sheet';
  return 'unknown';
}

function getSnapshotDate(file: CsvSourceFile, input: SourceAdapterImportInput, row: CsvRowReader) {
  return file.snapshotDate ?? row.string('Date', 'Month', 'Timestamp') ?? input.sourceVersion;
}

function defaultCompany(input: SourceAdapterImportInput) {
  const value = input.config.defaultCompany;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function companyOf(input: SourceAdapterImportInput, row: CsvRowReader) {
  return row.string('Company') ?? defaultCompany(input);
}

function isoDate(value: string) {
  const trimmed = value.trim();
  const isoDateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    return `${isoDateOnly[1]}-${isoDateOnly[2]}-${isoDateOnly[3]}`;
  }
  const dayMonthYear = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (dayMonthYear) {
    return `${dayMonthYear[3]}-${dayMonthYear[2].padStart(2, '0')}-${dayMonthYear[1].padStart(2, '0')}`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString().slice(0, 10);
}

function isoDateTime(value: string) {
  const trimmed = value.trim();
  const dayMonthYear = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dayMonthYear) {
    const hour = (dayMonthYear[4] ?? '00').padStart(2, '0');
    const minute = (dayMonthYear[5] ?? '00').padStart(2, '0');
    const second = (dayMonthYear[6] ?? '00').padStart(2, '0');
    return `${dayMonthYear[3]}-${dayMonthYear[2].padStart(2, '0')}-${dayMonthYear[1].padStart(
      2,
      '0',
    )}T${hour}:${minute}:${second}.000Z`;
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
      leadTimeDays: row.number('Lead time(day)', 'Manuf. time days'),
      safetyBufferDays: row.number('Safety Buffer Days', 'safety_buffer_days'),
      payload: row.payload(),
    },
  };
}

function supplierRecords(input: SourceAdapterImportInput, row: CsvRowReader, sourceKey: string): NormalizedRecord[] {
  const supplierName = row.string('Supplier', 'Supplier ', 'Supplier Name');
  const supplierId = row.string('SR ID', 'SR ID ');
  const leadTimeDays = row.number('Lead time(day)', 'Manuf. time days');
  if (!supplierName && !supplierId) {
    return [];
  }
  const company = row.string('Company');
  const supplierKey = supplierId ?? supplierName ?? sourceKey;
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
        naturalKey: naturalKey(input, 'supplier_lead_time', [company, supplierKey]),
        sourceConnectionId: input.sourceConnectionId,
        supplierId,
        supplierName,
        company,
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

function supplierIdentityRecord(input: SourceAdapterImportInput, row: CsvRowReader): NormalizedRecord[] {
  const company = companyOf(input, row) ?? '__global__';
  const supplierName = row.string('Supplier', 'Supplier ', 'Supplier Name');
  const supplierId = supplierExternalCode(row);
  if (!supplierName && !supplierId) {
    return [];
  }

  return [
    {
      kind: 'supplier_identity',
      data: {
        company,
        supplierName,
        externalSupplierCode: supplierId,
        sourceSystem: 'supplier_ids',
        sourceConnectionId: input.sourceConnectionId,
        observedAt: input.sourceVersion,
        leadTimeDays: row.number('Lead time(day)', 'Manuf. time days'),
        payload: row.payload(),
      },
    },
  ];
}

function expectedSellableDate(row: CsvRowReader) {
  if (row.string('Expected Sellable Date')) {
    return {
      date: firstDate(row, 'Expected Sellable Date'),
      source: 'imported_expected_sellable_date',
    };
  }
  if (row.string('ETA on Amazon')) {
    return {
      date: firstDate(row, 'ETA on Amazon'),
      source: 'imported_eta_on_amazon',
    };
  }
  if (row.string('Arrival to Amazon')) {
    return {
      date: firstDate(row, 'Arrival to Amazon'),
      source: 'imported_arrival_to_amazon',
    };
  }
  return { date: undefined, source: undefined };
}

function compactReference(value: string, maxLength = 180) {
  if (value.length <= maxLength) {
    return value;
  }
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${value.slice(0, maxLength - 17)}:${hash}`;
}

function sourceOrderLineRef(row: CsvRowReader, fallback: string) {
  return compactReference([row.string('Order ID'), canonicalAsin(row), row.string('SKU')].filter(Boolean).join(':') || fallback);
}

function purchaseOrderStatus(row: CsvRowReader) {
  const combined = [
    row.string('Status', 'Order Status', 'Approval Status'),
    row.string('Payment Status', 'Payment Status '),
    row.string('Shipping Status'),
    row.string('Blocked Reason'),
    row.string('Tracking ID', 'Tracking #'),
    row.string('Shipping Carrier', 'Carrier'),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();

  if (combined.includes('cancel')) {
    return 'cancelled';
  }
  if (combined.includes('reject')) {
    return 'rejected';
  }
  if (combined.includes('block') || combined.includes('hold')) {
    return 'blocked';
  }
  if (combined.includes('reached fba') || combined.includes('reached amazon')) {
    return 'reached_fba';
  }
  if (
    combined.includes('ship') ||
    combined.includes('inbound') ||
    row.string('Tracking ID', 'Tracking #') ||
    row.string('Shipping Carrier', 'Carrier')
  ) {
    return 'shipped_inbound';
  }
  if (combined.includes('prepar') || combined.includes('production') || combined.includes('manufactur')) {
    return 'supplier_preparing';
  }
  if (combined.includes('paid') || combined.includes('payment completed')) {
    return 'paid';
  }
  if (combined.includes('invoice') || combined.includes('payment')) {
    return 'payment_pending';
  }
  if (combined.includes('confirm')) {
    return 'supplier_confirmed';
  }
  if (combined.includes('approv')) {
    return 'approval_pending';
  }
  return 'supplier_contacted';
}

function orderDetailsRecord(input: SourceAdapterImportInput, row: CsvRowReader, sourceKey: string): NormalizedRecord[] {
  const company = companyOf(input, row);
  const supplierName = row.string('Supplier', 'Supplier ', 'Supplier Name');
  const supplierId = supplierExternalCode(row);
  const orderId = row.string('Order ID');
  if (!company || (!supplierName && !supplierId) || !orderId) {
    return [];
  }

  return [
    {
      kind: 'supplier_order',
      data: {
        company,
        supplierName,
        externalSupplierCode: supplierId,
        sourceSystem: 'order_details',
        sourceConnectionId: input.sourceConnectionId,
        externalOrderRef: orderId,
        sourceStage: 'order_detail',
        status: 'received',
        orderDate: firstDate(row, 'Timestamp'),
        statusUpdatedAt: firstDateTime(row, 'Timestamp'),
        lastMeaningfulUpdateAt: firstDateTime(row, 'Timestamp'),
        payload: row.payload(),
        lines: [
          {
            sourceOrderLineRef: sourceOrderLineRef(row, sourceKey),
            asin: canonicalAsin(row),
            sku: row.string('SKU'),
            brand: row.string('Brand', 'Brand '),
            orderedQty: row.number('Qty') ?? 0,
            receivedQty: row.number('Qty') ?? 0,
            unitCost: row.number('PPU', 'Exp. Cost '),
            leadTimeDays: row.number('Lead time(day)', 'Manuf. time days'),
            observedAt: firstDateTime(row, 'Timestamp'),
            payload: row.payload(),
          },
        ],
      },
    },
  ];
}

function purchaseOrderRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  sourceKey: string,
): NormalizedRecord[] {
  const company = companyOf(input, row);
  const supplierName = row.string('Supplier', 'Supplier ', 'Supplier Name');
  const supplierId = supplierExternalCode(row);
  const orderId = row.string('Order ID');
  if (!company || (!supplierName && !supplierId) || !orderId) {
    return [];
  }

  const lines = [] as Array<Record<string, unknown>>;
  const orderedQty = row.number('Qty', 'Total units');
  if (typeof orderedQty === 'number' && (canonicalAsin(row) || row.string('SKU'))) {
    lines.push({
      sourceOrderLineRef: sourceOrderLineRef(row, sourceKey),
      asin: canonicalAsin(row),
      sku: row.string('SKU'),
      brand: row.string('Brand', 'Brand '),
      orderedQty,
      unitCost: row.number('PPU', 'Exp. Cost '),
      expectedDeliveryDate: firstDate(row, 'Expected Delivery', 'Expected Delivery Date', 'ETA', 'Arrival to Amazon'),
      observedAt: firstDateTime(row, 'Timestamp'),
      payload: row.payload(),
    });
  }

  return [
    {
      kind: 'supplier_order',
      data: {
        company,
        supplierName,
        externalSupplierCode: supplierId,
        sourceSystem: 'purchase_orders',
        sourceConnectionId: input.sourceConnectionId,
        externalOrderRef: orderId,
        sourceStage: 'purchase_order',
        status: purchaseOrderStatus(row),
        approvalStatus: row.string('Approval Status'),
        paymentStatus: row.string('Payment Status', 'Payment Status '),
        shippingCarrier: row.string('Shipping Carrier', 'Carrier'),
        trackingId: row.string('Tracking ID', 'Tracking #'),
        expectedDeliveryDate: firstDate(row, 'Expected Delivery', 'Expected Delivery Date', 'ETA', 'Arrival to Amazon'),
        blockedReason: row.string('Blocked Reason'),
        orderDate: firstDate(row, 'Timestamp', 'Order Date'),
        statusUpdatedAt: firstDateTime(row, 'Timestamp', 'Updated At'),
        lastMeaningfulUpdateAt: firstDateTime(row, 'Timestamp', 'Updated At'),
        payload: row.payload(),
        lines,
      },
    },
  ];
}

function preOrderSheetRecord(
  input: SourceAdapterImportInput,
  row: CsvRowReader,
  sourceKey: string,
): NormalizedRecord[] {
  const company = companyOf(input, row);
  const supplierName = row.string('Supplier', 'Supplier ', 'Supplier Name');
  const supplierId = supplierExternalCode(row);
  const orderId = row.string('Order ID');
  const orderedQty = row.number('Qty');
  if (
    !company ||
    (!supplierName && !supplierId) ||
    !orderId ||
    typeof orderedQty !== 'number' ||
    (!canonicalAsin(row) && !row.string('SKU'))
  ) {
    return [];
  }

  const sellableDate = expectedSellableDate(row);
  return [
    {
      kind: 'supplier_order',
      data: {
        company,
        supplierName,
        externalSupplierCode: supplierId,
        sourceSystem: 'pre_order_sheet',
        sourceConnectionId: input.sourceConnectionId,
        externalOrderRef: orderId,
        sourceStage: 'pre_order',
        status: 'planned',
        expectedDeliveryDate: firstDate(row, 'Expected Delivery', 'Expected Delivery Date', 'ETA', 'Arrival to Amazon'),
        orderDate: firstDate(row, 'Timestamp', 'Order Date') ?? input.sourceVersion,
        statusUpdatedAt: firstDateTime(row, 'Timestamp', 'Order Date') ?? `${input.sourceVersion}T00:00:00.000Z`,
        lastMeaningfulUpdateAt: firstDateTime(row, 'Timestamp', 'Order Date') ?? `${input.sourceVersion}T00:00:00.000Z`,
        payload: row.payload(),
        lines: [
          {
            sourceOrderLineRef: sourceOrderLineRef(row, sourceKey),
            asin: canonicalAsin(row),
            sku: row.string('SKU'),
            brand: row.string('Brand', 'Brand '),
            orderedQty,
            unitCost: row.number('PPU', 'Exp. Cost '),
            expectedDeliveryDate: firstDate(
              row,
              'Expected Delivery',
              'Expected Delivery Date',
              'ETA',
              'Arrival to Amazon',
            ),
            expectedSellableDate: sellableDate.date,
            expectedSellableDateSource: sellableDate.source,
            observedAt: firstDateTime(row, 'Timestamp', 'Order Date') ?? `${input.sourceVersion}T00:00:00.000Z`,
            payload: row.payload(),
          },
        ],
      },
    },
  ];
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
  if (shape === 'supplier-ids') {
    return supplierIdentityRecord(input, row);
  }
  if (shape === 'order-details') {
    return orderDetailsRecord(input, row, sourceKey);
  }
  if (shape === 'purchase-orders') {
    return purchaseOrderRecord(input, row, sourceKey);
  }
  if (shape === 'pre-order-sheet') {
    return preOrderSheetRecord(input, row, sourceKey);
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
