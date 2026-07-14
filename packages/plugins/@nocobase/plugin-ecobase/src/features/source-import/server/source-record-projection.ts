/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const SOURCE_RECORD_PROJECTION_VERSION = '2026-07-13.1';

export type MigrationDataset =
  | 'sellerboard_current'
  | 'sellerboard_daily_facts'
  | 'amazon_listing_inventory'
  | 'sellerboard_cogs'
  | 'source_access_audit'
  | 'source_issue'
  | 'purchase_orders'
  | 'order_details'
  | 'supplier_tracker'
  | 'supplier_2026'
  | 'clickup_order_evidence';

export interface SourceRecordProjection {
  payload: Record<string, unknown>;
  droppedFieldCount: number;
  projectionVersion: string;
}

export interface ProjectionContext {
  retainedOrderRef?: string;
}

type FieldProjection = Record<string, readonly string[]>;

const FIELD_PROJECTIONS: Record<Exclude<MigrationDataset, 'clickup_order_evidence'>, FieldProjection> = {
  sellerboard_current: {
    company: ['Company'],
    account: ['Account', 'Amazon Account'],
    marketplace: ['Marketplace', 'Market '],
    observedAt: ['Date', 'Timestamp'],
    asin: ['ASIN', 'ASIN '],
    listingSku: ['SKU'],
    title: ['Title', 'Name'],
    brand: ['Brand', 'Brand '],
    listingStatus: ['Listing Status', 'Status', 'Active'],
    fbaStock: ['FBA', 'FBA Stock', 'Sellable'],
    reservedStock: ['Reserved'],
    inboundStock: ['Inbound'],
    orderedStock: ['Ordered'],
    prepStock: ['Prep'],
    awdStock: ['AWD'],
  },
  sellerboard_daily_facts: {
    company: ['Company'],
    account: ['Account', 'Amazon Account'],
    marketplace: ['Marketplace', 'Market '],
    period: ['Date', 'Month', 'Timestamp'],
    asin: ['ASIN', 'ASIN '],
    listingSku: ['SKU'],
    sales: ['Total Sales', 'Sales', 'Ordered Product Sales', 'Revenue'],
    salesOrganic: ['SalesOrganic'],
    salesPpc: ['SalesPPC'],
    salesSponsoredProducts: ['SalesSponsoredProducts'],
    salesSponsoredBrands: ['SalesSponsoredBrands'],
    salesSponsoredDisplay: ['SalesSponsoredDisplay'],
    units: ['Total Units', 'Units', 'Units Achieved', 'Units Ordered', 'Units Sold', 'Qty'],
    unitsOrganic: ['UnitsOrganic'],
    unitsPpc: ['UnitsPPC'],
    unitsSponsoredProducts: ['UnitsSponsoredProducts'],
    unitsSponsoredBrands: ['UnitsSponsoredBrands'],
    unitsSponsoredDisplay: ['UnitsSponsoredDisplay'],
    grossProfit: ['GrossProfit'],
    netProfit: ['NetProfit', 'Profit Achieved', 'Profit', 'Net Profit'],
    margin: ['Margin', 'Margin '],
    refunds: ['Refunds', 'Refund Units'],
    refundRate: ['% Refund', 'Sellable Returns %'],
    orders: ['Orders'],
    sessions: ['Sessions', 'Sessions - Total'],
    pageViews: ['Page Views', 'PageViews'],
    unitSessionPercentage: ['Unit Session Percentage'],
  },
  amazon_listing_inventory: {
    company: ['Company'],
    account: ['Account', 'Amazon Account'],
    marketplace: ['Marketplace', 'Market '],
    period: ['Timestamp', 'Date', 'Month'],
    asin: ['ASIN', 'ASIN '],
    listingSku: ['SKU'],
    title: ['Title', 'Name'],
    brand: ['Brand', 'Brand '],
    sellableStock: ['FBA/FBM Stock', 'Current Stock', 'FBA'],
    reservedStock: ['Reserved', 'Rerv.'],
    inboundStock: ['Inbound', 'Sent  to FBA'],
    orderedStock: ['Ordered'],
    awdStock: ['AWD Stock'],
    salesVelocity: ['Estimated Sales Velocity', 'Est. Sales Velocity', 'Exp Sales Vel'],
    targetCoverDays: ['Target stock range after new order days'],
    recommendedQuantity: ['Recommended quantity for  reordering', 'Rec.Best Qty'],
    supplierExternalRef: ['SR ID', 'SR ID '],
    supplierName: ['Supplier', 'Supplier ', 'Supplier Name'],
    sourceSupplierSku: ['Supplier SKU'],
    leadTimeDays: ['Lead time(day)', 'Lead Time', 'Manuf. time days'],
    unitCost: ['COGS', 'PPU', 'Exp. Cost '],
    roi: ['ROI, %'],
    sessions: ['Sessions', 'Sessions - Total'],
    pageViews: ['Page Views', 'Page Views - Total'],
    buyBoxPercentage: ['Featured Offer (Buy Box) Percentage', 'BB %'],
    unitSessionPercentage: ['Unit Session Percentage'],
  },
  source_access_audit: {
    sourceType: ['sourceType'],
    domain: ['domain'],
    accessStatus: ['accessStatus', 'status'],
    checkedAt: ['checkedAt', 'observedAt'],
    message: ['message'],
  },
  source_issue: {
    fileName: ['fileName'],
    adapterName: ['adapterName'],
    expectedRowCount: ['expectedRowCount'],
    actualRowCount: ['actualRowCount', 'rowCount'],
    headerCount: ['headerCount'],
    sourceKey: ['sourceKey'],
  },
  sellerboard_cogs: {
    company: ['Company'],
    account: ['Account', 'Amazon Account'],
    marketplace: ['Marketplace', 'Market '],
    observedAt: ['CostPeriodStartDate', 'Date', 'Timestamp'],
    asin: ['ASIN', 'ASIN '],
    listingSku: ['SKU'],
    title: ['Title'],
    unitCost: ['COGS', 'Cost', 'Unit Cost'],
    currency: ['Currency'],
    hideStatus: ['Hide'],
  },
  purchase_orders: {
    occurredAt: ['Timestamp'],
    orderRef: ['Order ID', 'externalOrderRef'],
    company: ['Company'],
    supplierExternalRef: ['SR ID', 'SR ID ', 'externalSupplierCode'],
    supplierName: ['Supplier', 'Supplier ', 'Supplier Name'],
    orderDate: ['Order Date', 'Timestamp'],
    expectedDeliveryDate: ['Expected Sellable Date', 'ETA on Amazon', 'Arrival to Amazon'],
    status: ['Order status', 'Order Status', 'Status'],
    approvalStatus: ['PO approval', 'Approval Status', 'PO Approval'],
    paymentStatus: ['Payment Status', 'Payment Status '],
  },
  order_details: {
    occurredAt: ['Timestamp'],
    orderRef: ['Order ID', 'externalOrderRef'],
    company: ['Company'],
    supplierExternalRef: ['SR ID', 'SR ID ', 'externalSupplierCode'],
    supplierName: ['Supplier', 'Supplier ', 'Supplier Name'],
    sourceAsin: ['ASIN', 'ASIN '],
    sourceSupplierSku: ['SKU', 'UPC'],
    quantity: ['Qty', 'Ordered'],
    unitCost: ['PPU', 'COGS', 'Exp. Cost '],
    leadTimeDays: ['Lead time(day)', 'Lead Time', 'Lead Time Days'],
    expectedDeliveryDate: ['Expected Sellable Date', 'ETA on Amazon', 'Arrival to Amazon'],
    status: ['Order status', 'Order Status', 'Status'],
    amazonStatus: ['AM Status'],
    cooStatus: ['COO status'],
  },
  supplier_tracker: {
    supplierExternalRef: ['SR ID', 'SR ID '],
    supplierName: ['Supplier', 'Supplier ', 'Supplier Name'],
    companyProvenance: ['Reached Via'],
    sourceAsin: ['ASIN', 'ASIN '],
    sourceSupplierSku: ['SKU', 'UPC'],
    unitCost: ['PPU', 'COGS', 'Cost'],
    currency: ['Currency'],
    leadTimeDays: ['Lead time(day)', 'Lead Time', 'Lead Time Days'],
    minimumOrderQuantity: ['MOQ'],
    packSize: ['Pack Size', 'Case Pack'],
    workflowStatus: ['Status'],
    activeStatus: ['Active Status'],
  },
  supplier_2026: {
    supplierExternalRef: ['SR ID', 'SR ID '],
    supplierName: ['Supplier', 'Supplier ', 'Supplier Name'],
    companyProvenance: ['Reached Via'],
    sourceAsin: ['ASIN', 'ASIN '],
    sourceSupplierSku: ['SKU', 'UPC'],
    unitCost: ['PPU', 'COGS', 'Cost'],
    currency: ['Currency'],
    leadTimeDays: ['Lead time(day)', 'Lead Time', 'Lead Time Days'],
    minimumOrderQuantity: ['MOQ'],
    packSize: ['Pack Size', 'Case Pack'],
    approvalStatus: ['Status'],
    currentStatus: ['Current Status'],
  },
};

const CLICKUP_FIELD_PROJECTION: FieldProjection = {
  taskId: ['taskId', 'Task ID'],
  parentId: ['parentId', 'Parent ID'],
  orderRef: ['orderRef', 'Order ID'],
  status: ['status', 'Status'],
  statusUpdatedAt: ['statusUpdatedAt', 'Date Updated', 'Date Created Text', 'Date Created'],
  commentId: ['commentId', 'Comment ID'],
  commentOccurredAt: ['commentOccurredAt', 'Comment Date'],
  commentBody: ['commentBody'],
};

const FORBIDDEN_KEY = /(?:^|_)(?:pass(?:word)?|username|user_name|email|url|link|token|session|attachment|raw)(?:$|_)/i;
const FORBIDDEN_VALUE = /(?:https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|[?&](?:token|session|key)=)/i;
const FORBIDDEN_CREDENTIAL_TEXT =
  /\b(?:password|passcode|user\s*name|username|credentials?|client\s*secret|api\s*(?:key|token)|access\s*(?:key|token)|secret\s*key)\b/i;

function isForbiddenKey(key: string) {
  return FORBIDDEN_KEY.test(
    key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, ''),
  );
}

function safeScalar(value: unknown): value is string | number | boolean {
  return (
    (typeof value === 'string' && !FORBIDDEN_VALUE.test(value) && !FORBIDDEN_CREDENTIAL_TEXT.test(value)) ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}

function projectFields(source: Record<string, unknown>, fields: FieldProjection) {
  const payload: Record<string, unknown> = {};
  const selectedInputKeys = new Set<string>();
  for (const [outputKey, inputKeys] of Object.entries(fields)) {
    const inputKey = inputKeys.find((key) => {
      const value = source[key];
      return value !== undefined && value !== null && value !== '' && safeScalar(value);
    });
    if (inputKey) {
      selectedInputKeys.add(inputKey);
      payload[outputKey] = source[inputKey];
    }
  }
  return {
    payload,
    droppedFieldCount: Object.keys(source).filter((key) => !selectedInputKeys.has(key)).length,
  };
}

function safeCommentBody(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const body = value.trim();
  if (!body || FORBIDDEN_VALUE.test(body) || FORBIDDEN_CREDENTIAL_TEXT.test(body)) return undefined;
  return body;
}

export function projectSourceRecord(
  dataset: MigrationDataset,
  source: Record<string, unknown>,
  context: ProjectionContext = {},
): SourceRecordProjection {
  const fields = dataset === 'clickup_order_evidence' ? CLICKUP_FIELD_PROJECTION : FIELD_PROJECTIONS[dataset];
  const projected = projectFields(source, fields);
  if (dataset === 'clickup_order_evidence') {
    const selectedCommentBody = Object.hasOwn(projected.payload, 'commentBody');
    const orderRef = typeof projected.payload.orderRef === 'string' ? projected.payload.orderRef.trim() : undefined;
    if (!context.retainedOrderRef || orderRef !== context.retainedOrderRef.trim()) {
      delete projected.payload.commentBody;
    } else {
      const body = safeCommentBody(projected.payload.commentBody);
      if (body) projected.payload.commentBody = body;
      else delete projected.payload.commentBody;
    }
    if (selectedCommentBody && !Object.hasOwn(projected.payload, 'commentBody')) projected.droppedFieldCount += 1;
  }
  return { ...projected, projectionVersion: SOURCE_RECORD_PROJECTION_VERSION };
}

export function projectNormalizedRecordData(source: Record<string, unknown>): SourceRecordProjection {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!isForbiddenKey(key) && safeScalar(value)) payload[key] = value;
  }
  return {
    payload,
    droppedFieldCount: Object.keys(source).length - Object.keys(payload).length,
    projectionVersion: SOURCE_RECORD_PROJECTION_VERSION,
  };
}

export function findForbiddenSourceMaterial(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenSourceMaterial(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
      const fieldPath = `${path}.${key}`;
      return [...(isForbiddenKey(key) ? [fieldPath] : []), ...findForbiddenSourceMaterial(nested, fieldPath)];
    });
  }
  return typeof value === 'string' && (FORBIDDEN_VALUE.test(value) || FORBIDDEN_CREDENTIAL_TEXT.test(value))
    ? [path]
    : [];
}
