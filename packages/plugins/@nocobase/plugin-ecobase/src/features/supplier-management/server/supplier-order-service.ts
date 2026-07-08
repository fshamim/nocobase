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
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import { silverSupplierOrderReadModel } from './silver-supplier-order-read-model';

export const SUPPLIER_ORDER_STATUS_HELP = {
  draft: 'Order is being prepared. Supplier has not been contacted yet.',
  supplier_contacted: 'Supplier has been asked for availability, price, or invoice details.',
  supplier_confirmed: 'Supplier confirmed quantity, price, or availability, but the order is not bought yet.',
  approval_pending: 'Supplier confirmed the order and it is waiting for internal approval.',
  payment_pending: 'Order is approved or invoiced, but payment has not been completed yet.',
  paid: 'Order has been paid or bought; supplier is expected to prepare it.',
  supplier_preparing: 'Supplier is preparing, packing, or manufacturing the paid order.',
  shipped_inbound: 'Supplier shipped the order or imported reports show inbound movement.',
  reached_fba: 'Imported reports show the inventory reached FBA or became available.',
  completed: 'Order lifecycle is closed and no longer counts as open reorder coverage.',
  blocked: 'Order has a problem that must be resolved before it can be trusted as coverage.',
  rejected: 'Order was rejected and does not count as reorder coverage.',
  cancelled: 'Order was cancelled and does not count as reorder coverage.',
} as const;

export const SUPPLIER_ORDER_STATUS_LANES = [
  { key: 'draft', title: 'Draft', help: SUPPLIER_ORDER_STATUS_HELP.draft },
  { key: 'supplier_contacted', title: 'Supplier contacted', help: SUPPLIER_ORDER_STATUS_HELP.supplier_contacted },
  { key: 'supplier_confirmed', title: 'Supplier confirmed', help: SUPPLIER_ORDER_STATUS_HELP.supplier_confirmed },
  { key: 'approval_pending', title: 'Awaiting approval', help: SUPPLIER_ORDER_STATUS_HELP.approval_pending },
  { key: 'payment_pending', title: 'Awaiting payment', help: SUPPLIER_ORDER_STATUS_HELP.payment_pending },
  { key: 'paid', title: 'Bought / preparing', help: SUPPLIER_ORDER_STATUS_HELP.paid },
  { key: 'supplier_preparing', title: 'Supplier preparing', help: SUPPLIER_ORDER_STATUS_HELP.supplier_preparing },
  { key: 'shipped_inbound', title: 'Shipped / inbound', help: SUPPLIER_ORDER_STATUS_HELP.shipped_inbound },
  { key: 'reached_fba', title: 'Reached FBA', help: SUPPLIER_ORDER_STATUS_HELP.reached_fba },
  { key: 'completed', title: 'Done', help: SUPPLIER_ORDER_STATUS_HELP.completed },
  { key: 'blocked', title: 'Blocked', help: SUPPLIER_ORDER_STATUS_HELP.blocked },
  { key: 'rejected', title: 'Rejected', help: SUPPLIER_ORDER_STATUS_HELP.rejected },
  { key: 'cancelled', title: 'Cancelled', help: SUPPLIER_ORDER_STATUS_HELP.cancelled },
] as const;

export const OPEN_SUPPLIER_ORDER_STATUSES = [
  'supplier_confirmed',
  'payment_pending',
  'paid',
  'supplier_preparing',
  'shipped_inbound',
  'reached_fba',
  'blocked',
];
export const RELIABLE_SUPPLIER_ORDER_COVERAGE_STATUSES = [
  'paid',
  'supplier_preparing',
  'shipped_inbound',
  'reached_fba',
];
export const CLOSED_SUPPLIER_ORDER_STATUSES = ['completed', 'rejected', 'cancelled'];
const SUPPLIER_ORDER_STATUSES = Object.keys(SUPPLIER_ORDER_STATUS_HELP);
const SUPPLIER_ORDER_STATUS_ALIASES: Record<string, string> = {
  planned: 'draft',
  po_placed: 'payment_pending',
  confirmed: 'supplier_confirmed',
  preparing: 'supplier_preparing',
  shipped: 'shipped_inbound',
  received: 'completed',
};
const SUPPLIER_ORDER_ACTIVITY_TYPES = [
  'contacted_supplier',
  'status_update',
  'lead_time_checked',
  'note',
  'blocked',
  'unblocked',
] as const;
const MAX_SUPPLIER_LEAD_TIME_DAYS = 3650;
const MIN_COMPANY_PRODUCT_EVIDENCE_SCORE = 100;

function isUuid(value: string | undefined) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export interface SupplierOrderImportWarning {
  code: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface SupplierOrderImportResult {
  handled: boolean;
  warnings: SupplierOrderImportWarning[];
  sample?: Record<string, unknown>;
  requiresReconcile?: boolean;
}

export interface SupplierOrderCoverageLine {
  supplierOrderId: string;
  supplierOrderLineId: string;
  supplierId: string;
  openQty: number;
  expectedSellableDate: string | null;
  coverageBucket: 'usable_before_oos' | 'late' | 'blocked' | 'incomplete';
  unreliableCoverage: boolean;
  contactRecency: null | {
    occurredAt: string;
    notes?: string;
    source: 'order' | 'supplier';
    activityId: string;
  };
  evidenceIds: string[];
  warnings: string[];
}

export interface SupplierOrderCoverageView {
  planningProductId: string;
  coverageState:
    | 'no_open_order'
    | 'arrives_before_stockout'
    | 'partial_or_mixed_coverage'
    | 'arrives_late'
    | 'blocked_open_order'
    | 'incomplete_or_stale';
  totalOpenQty: number;
  usableOpenQtyBeforeOos: number;
  lateOpenQty: number;
  blockedOpenQty: number;
  incompleteOpenQty: number;
  nextExpectedSellableDate: string | null;
  nextLateExpectedSellableDate: string | null;
  unreliableCoverage: boolean;
  blockedOpenOrder: boolean;
  dataWarnings: string[];
  contactRecency: null | {
    occurredAt: string;
    notes?: string;
    source: 'order' | 'supplier';
    activityId: string;
  };
  evidenceIds: string[];
  linkedSupplierOrderIds: string[];
  linkedSupplierOrderLineIds: string[];
  coverageLines: SupplierOrderCoverageLine[];
}

export interface RecordSupplierOrderActivityParams {
  company: string;
  supplierId: string;
  supplierOrderId?: string;
  activityType: (typeof SUPPLIER_ORDER_ACTIVITY_TYPES)[number];
  occurredAt?: string;
  actor?: string;
  actorUserId?: string;
  notes?: string;
  nextFollowUpAt?: string;
  leadTimeDays?: number;
  contactEstablished?: boolean;
  source?: string;
}

export interface UpdateSupplierOrderActivityCommentParams {
  company: string;
  activityId: string;
  notes: string;
  actorUserId?: string;
}

export interface DeleteSupplierOrderActivityCommentParams {
  company: string;
  activityId: string;
  actorUserId?: string;
}

export interface CreatePlannedSupplierOrderParams {
  company: string;
  planningProductId: string;
  supplierId?: string;
  orderedQty: number;
  unitCost?: number;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  externalOrderRef?: string;
  notes?: string;
  actor?: string;
}

export interface CreateSupplierOrderLineParams {
  supplierOrderId: string | number;
  planningProductId: string;
  orderedQty: number;
  unitCost?: number;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  notes?: string;
  actor?: string;
}

export interface UpdateSupplierOrderLineOperatorFieldsParams {
  supplierOrderLineId: string | number;
  company: string;
  planningProductId?: string;
  externalOrderRef?: string;
  orderedQty?: number;
  receivedQty?: number;
  unitCost?: number;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  notes?: string;
  actor?: string;
}

export interface DeleteSupplierOrderLineOperatorFieldsParams {
  supplierOrderLineId: string | number;
  company: string;
}

export interface UpdateSupplierOrderOperatorFieldsParams {
  supplierOrderId: string | number;
  company: string;
  supplierId?: string;
  externalOrderRef?: string;
  orderDate?: string;
  status?: string;
  expectedDeliveryDate?: string;
  approvalStatus?: string;
  paymentStatus?: string;
  shippingCarrier?: string;
  trackingId?: string;
  blockedReason?: string;
  actor?: string;
}

export interface UpdateSupplierLeadTimeParams {
  company: string;
  supplierId: string;
  leadTimeDays: number;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  confirmedAt?: string;
  notes?: string;
  actor?: string;
}

export interface SupplierOrderWorkspaceFilters {
  company?: string;
  status?: string;
  stockoutDate?: string;
  limit?: number;
}

type PlainRecord = Record<string, unknown>;
type Filter = Record<string, unknown>;

type SupplierIdentityRecord = {
  company: string;
  supplierName?: string;
  externalSupplierCode?: string;
  sourceSystem: string;
  observedAt: string;
  sourceConnectionId: string;
  payload?: PlainRecord;
  leadTimeDays?: number;
};

type SupplierOrderLineImport = {
  sourceOrderLineRef: string;
  asin?: string;
  sku?: string;
  brand?: string;
  orderedQty: number;
  receivedQty?: number;
  unitCost?: number;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  expectedSellableDateSource?: string;
  leadTimeDays?: number;
  rawStatus?: string;
  observedAt?: string;
  payload?: PlainRecord;
};

type SupplierOrderRecord = {
  company: string;
  supplierName?: string;
  externalSupplierCode?: string;
  sourceSystem: string;
  sourceConnectionId: string;
  externalOrderRef: string;
  sourceStage: 'pre_order' | 'order_detail' | 'purchase_order' | 'manual';
  status: string;
  approvalStatus?: string;
  paymentStatus?: string;
  shippingCarrier?: string;
  trackingId?: string;
  expectedDeliveryDate?: string;
  blockedReason?: string;
  orderDate?: string;
  statusUpdatedAt?: string;
  lastMeaningfulUpdateAt?: string;
  lines: SupplierOrderLineImport[];
  payload?: PlainRecord;
};

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null;
}

function toPlainRecord(value: unknown): PlainRecord {
  if (isRecord(value) && typeof value.toJSON === 'function') {
    const json = value.toJSON();
    if (isRecord(json)) {
      return json;
    }
  }
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isUniqueConstraintError(error: unknown) {
  const record = toPlainRecord(error);
  return record.name === 'SequelizeUniqueConstraintError' || String(record.message ?? '').includes('must be unique');
}

function isMissingRecordError(error: unknown) {
  const message = String(toPlainRecord(error).message ?? '');
  return (
    message.includes('matching record was not found') ||
    message.includes('found no matching record') ||
    message.includes('not found')
  );
}

function compactNaturalKey(prefix: string, rawKey: string) {
  const naturalKey = `${prefix}:${rawKey}`;
  if (naturalKey.length <= 240) {
    return naturalKey;
  }
  return `${prefix}:hash:${createHash('sha256').update(rawKey).digest('hex')}`;
}

function truncateText(value: string | undefined, maxLength = 255) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function supplierOrderLineNaturalKey(orderNaturalKey: string | undefined, sourceOrderLineRef: string) {
  return compactNaturalKey('supplier-order-line', `${orderNaturalKey ?? 'unknown-order'}:${sourceOrderLineRef}`);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecordId(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isoDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const trimmed = value.trim();
  const isoDateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    return `${isoDateOnly[1]}-${isoDateOnly[2]}-${isoDateOnly[3]}`;
  }

  const isoDateTime = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T\s].*$/);
  if (isoDateTime) {
    return `${isoDateTime[1]}-${isoDateTime[2]}-${isoDateTime[3]}`;
  }

  const dayMonthYear = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dayMonthYear) {
    return `${dayMonthYear[3]}-${dayMonthYear[2].padStart(2, '0')}-${dayMonthYear[1].padStart(2, '0')}`;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Ecobase supplier-order service could not parse date "${value}".`);
  }
  return parsed.toISOString().slice(0, 10);
}

function isoDateTime(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

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
    throw new Error(`Ecobase supplier-order service could not parse datetime "${value}".`);
  }
  return parsed.toISOString();
}

function maybeIsoDate(value: unknown): string | undefined {
  const text = asString(value);
  return text ? isoDate(text) : undefined;
}

function safeIsoDate(value: unknown): string | undefined {
  try {
    return maybeIsoDate(value);
  } catch {
    return undefined;
  }
}

function maybeIsoDateTime(value: unknown): string | undefined {
  const text = asString(value);
  return text ? isoDateTime(text) : undefined;
}

function requireIsoDate(value: string, fieldName: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Ecobase supplier-order update failed: ${fieldName} must use YYYY-MM-DD.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const roundTrip = parsed.toISOString().slice(0, 10);
  if (roundTrip !== value) {
    throw new Error(`Ecobase supplier-order update failed: ${fieldName} must be a valid calendar date.`);
  }

  return value;
}

export function validateSupplierOrderActivityType(value: string): RecordSupplierOrderActivityParams['activityType'] {
  if (!SUPPLIER_ORDER_ACTIVITY_TYPES.includes(value as RecordSupplierOrderActivityParams['activityType'])) {
    throw new Error(`Ecobase supplier-order activity failed: activityType "${value}" is not supported.`);
  }
  return value as RecordSupplierOrderActivityParams['activityType'];
}

export function validateSupplierLeadTimeDays(value: number | undefined, context: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_SUPPLIER_LEAD_TIME_DAYS) {
    throw new Error(`${context}: leadTimeDays must be an integer from 0 to ${MAX_SUPPLIER_LEAD_TIME_DAYS}.`);
  }
  return value;
}

export function normalizeSupplierOrderStatus(value: string | undefined) {
  const normalized = value
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : 'draft';
  return SUPPLIER_ORDER_STATUS_ALIASES[normalized] ?? normalized;
}

export function validateSupplierOrderStatus(value: string | undefined) {
  const status = normalizeSupplierOrderStatus(value);
  if (!SUPPLIER_ORDER_STATUSES.includes(status)) {
    throw new Error(`Ecobase supplier-order update failed: status "${value}" is not supported.`);
  }
  return status;
}

export function isReliableSupplierOrderCoverageStatus(value: string | undefined) {
  return RELIABLE_SUPPLIER_ORDER_COVERAGE_STATUSES.includes(normalizeSupplierOrderStatus(value));
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function maxIsoDate(values: Array<string | undefined>) {
  return values.reduce<string | undefined>((latest, current) => {
    if (!current) {
      return latest;
    }
    if (!latest || current > latest) {
      return current;
    }
    return latest;
  }, undefined);
}

function ageInDays(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86_400_000));
}

function stageRank(stage: string | undefined) {
  switch (stage) {
    case 'pre_order':
      return 1;
    case 'order_detail':
      return 2;
    case 'purchase_order':
      return 3;
    case 'manual':
      return 4;
    default:
      return 0;
  }
}

function chooseStage(existingStage: string | undefined, nextStage: string) {
  return stageRank(existingStage) > stageRank(nextStage) ? (existingStage as string) : nextStage;
}

function toImportPayload(record: PlainRecord) {
  const payload = record.payload;
  return isRecord(payload) ? payload : {};
}

function toLineImportRecords(value: unknown): SupplierOrderLineImport[] {
  return asArray(value).map((item) => {
    const plain = toPlainRecord(item);
    const rawLeadTimeDays = asNumber(plain.leadTimeDays);
    let leadTimeDays: number | undefined;
    if (typeof rawLeadTimeDays === 'number') {
      try {
        leadTimeDays = validateSupplierLeadTimeDays(rawLeadTimeDays, 'Ecobase supplier-order import failed');
      } catch {
        leadTimeDays = undefined;
      }
    }
    return {
      sourceOrderLineRef: asString(plain.sourceOrderLineRef) ?? randomUUID(),
      asin: asString(plain.asin)?.toUpperCase(),
      sku: truncateText(asString(plain.sku)),
      brand: truncateText(asString(plain.brand)),
      orderedQty: asNumber(plain.orderedQty) ?? 0,
      receivedQty: asNumber(plain.receivedQty),
      unitCost: asNumber(plain.unitCost),
      expectedDeliveryDate: maybeIsoDate(plain.expectedDeliveryDate),
      expectedSellableDate: maybeIsoDate(plain.expectedSellableDate),
      expectedSellableDateSource: asString(plain.expectedSellableDateSource),
      leadTimeDays,
      rawStatus: truncateText(asString(plain.rawStatus)),
      observedAt: maybeIsoDateTime(plain.observedAt),
      payload: toImportPayload(plain),
    } as SupplierOrderLineImport;
  });
}

export class EcobaseSupplierOrderService {
  constructor(private db: EcobaseDatabase) {}

  async getWorkspace(filters: SupplierOrderWorkspaceFilters = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    if (!filters.company) {
      return {
        filters,
        statusLanes: SUPPLIER_ORDER_STATUS_LANES,
        reorderCandidates: [],
        supplierOrders: [],
        supplierOrderLines: [],
        supplierProductLinks: [],
        activities: [],
        suppliers: [],
        leadTimes: [],
        bronzeSourceRecords: [],
        dataWarnings: ['company_filter_required'],
      };
    }
    const requestedStatus = filters.status ? normalizeSupplierOrderStatus(filters.status) : undefined;
    const companies = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({ limit: 500 })).map(
      toPlainRecord,
    );
    const companyId = asString(companies.find((company) => asString(company.name) === filters.company)?.id);
    const planningProducts: PlainRecord[] = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({
        filter: { company: filters.company },
        sort: ['company', 'asin'],
        limit,
      })
    )
      .map(toPlainRecord)
      .map((row) => ({
        ...row,
        id: asString(row.companyProductId) ?? asString(row.planningProductId) ?? asString(row.id),
        canonicalAsin: asString(row.asin),
      }));
    const silverOrders = await silverSupplierOrderReadModel(this.db, { company: filters.company, limit });
    const supplierOrders: PlainRecord[] = silverOrders.supplierOrders
      .map((order) => ({ ...order, status: normalizeSupplierOrderStatus(asString(order.status)) }))
      .filter((order) => !requestedStatus || asString(order.status) === requestedStatus);
    const supplierOrderLines: PlainRecord[] = silverOrders.supplierOrderLines;
    const [
      supplierAccounts,
      silverSuppliers,
      companyProducts,
      silverProducts,
      supplierProducts,
      companyProductSuppliers,
      activityComments,
    ] = await Promise.all([
      this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).find({ limit: limit * 3 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).find({ limit: limit * 3 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: limit * 4 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: limit * 4 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).find({ limit: limit * 4 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).find({ limit: limit * 4 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).find({ limit }),
    ]).then((groups) => groups.map((group) => group.map(toPlainRecord)));
    const supplierById = new Map(silverSuppliers.map((supplier) => [asString(supplier.id), supplier]));
    const companyProductById = new Map(companyProducts.map((product) => [asString(product.id), product]));
    const productById = new Map(silverProducts.map((product) => [asString(product.id), product]));
    const supplierProductById = new Map(supplierProducts.map((product) => [asString(product.id), product]));
    const supplierProductLinks: PlainRecord[] = companyProductSuppliers
      .map((link) => {
        const companyProduct = companyProductById.get(asString(link.companyProductId));
        if (companyId && asString(companyProduct?.companyId) !== companyId) return undefined;
        const supplierProduct = supplierProductById.get(asString(link.supplierProductId));
        const supplier = supplierById.get(asString(supplierProduct?.supplierId));
        const product = productById.get(asString(companyProduct?.productId) ?? asString(supplierProduct?.productId));
        return {
          ...link,
          company: filters.company,
          planningProductId: asString(link.companyProductId),
          supplierId: asString(supplierProduct?.supplierId),
          supplierName: asString(supplier?.displayName),
          role: asString(link.role),
          active: true,
          asin: asString(product?.asin),
          sku: asString(product?.sku) ?? asString(supplierProduct?.supplierSku),
        };
      })
      .filter(Boolean)
      .map(toPlainRecord);
    const orderIds = new Set(supplierOrders.map((order) => asString(order.id)).filter(Boolean));
    const activities: PlainRecord[] = activityComments
      .filter(
        (comment) =>
          asString(comment.entityType) === 'supplier_order' && orderIds.has(asString(comment.entityId) ?? ''),
      )
      .map((comment) => ({
        ...comment,
        company: filters.company,
        supplierOrderId: asString(comment.entityId),
        activityType: asString(comment.commentType),
        notes: asString(comment.body),
        occurredAt: asString(comment.createdAt) ?? asString(comment.updatedAt),
      }));
    const scopedSupplierIds = new Set(
      [
        ...supplierAccounts
          .filter((account) => !companyId || asString(account.companyId) === companyId)
          .map((account) => asString(account.supplierId)),
        ...supplierOrders.map((order) => asString(order.supplierId)),
        ...supplierProductLinks.map((link) => asString(link.supplierId)),
      ].filter((id): id is string => Boolean(id)),
    );
    const suppliers: PlainRecord[] = silverSuppliers
      .filter((supplier) => scopedSupplierIds.has(asString(supplier.id) ?? ''))
      .map((supplier) => ({ ...supplier, name: asString(supplier.displayName), company: filters.company }));
    const leadTimes: PlainRecord[] = supplierProductLinks
      .map((link) => {
        const supplierProduct = supplierProductById.get(asString(link.supplierProductId));
        return {
          id: asString(supplierProduct?.id),
          company: filters.company,
          supplierRefId: asString(supplierProduct?.supplierId),
          supplierName: asString(link.supplierName),
          planningProductId: asString(link.planningProductId),
          asin: asString(link.asin),
          sku: asString(link.sku),
          scope: 'product',
          leadTimeDays: asNumber(supplierProduct?.leadTimeDays),
          confirmedAt: asString(supplierProduct?.updatedAt) ?? asString(supplierProduct?.createdAt),
        };
      })
      .filter((leadTime) => typeof leadTime.leadTimeDays === 'number');
    let bronzeSourceRecords: PlainRecord[];
    if (filters.company) {
      const sourceConnections = (
        await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({ limit: 500 })
      ).map(toPlainRecord);
      const sourceConnectionIds = new Set(
        sourceConnections
          .filter(
            (source) =>
              asString(source.company) === filters.company || (companyId && asString(source.companyId) === companyId),
          )
          .map((source) => asString(source.id))
          .filter((sourceId): sourceId is string => Boolean(sourceId)),
      );
      const importRuns = (await this.db.getRepository(ECOBASE_COLLECTIONS.importRuns).find({ limit: 500 })).map(
        toPlainRecord,
      );
      const importRunIds = new Set(
        importRuns
          .filter((run) => sourceConnectionIds.has(String(run.sourceConnectionId ?? '')))
          .map((run) => asString(run.id))
          .filter((runId): runId is string => Boolean(runId)),
      );
      bronzeSourceRecords = (
        await this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).find({ sort: ['-rowNumber'], limit: 5000 })
      )
        .map(toPlainRecord)
        .filter((row) => importRunIds.has(String(row.importRunId ?? '')))
        .map((row) => ({ ...row, normalizedStatus: row.normalizationStatus }))
        .slice(0, limit);
    } else {
      bronzeSourceRecords = [];
    }

    const supplierNameById = new Map(
      suppliers
        .map((supplier) => [asString(supplier.id), asString(supplier.name)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const productLeadTimeBySupplierAndProduct = new Map<string, PlainRecord>();
    const productLeadTimeBySupplierNameAndAsin = new Map<string, PlainRecord>();
    const defaultLeadTimeBySupplier = new Map<string, PlainRecord>();
    for (const leadTime of leadTimes) {
      const supplierId = asString(leadTime.supplierRefId);
      const planningProductId = asString(leadTime.planningProductId);
      const supplierName = asString(leadTime.supplierName)?.toLowerCase();
      const company = asString(leadTime.company);
      const asin = asString(leadTime.asin);
      if (supplierId && planningProductId) {
        productLeadTimeBySupplierAndProduct.set(`${supplierId}:${planningProductId}`, leadTime);
      }
      if (supplierId && asString(leadTime.scope) === 'default') {
        defaultLeadTimeBySupplier.set(supplierId, leadTime);
      }
      if (company && supplierName && asin) {
        productLeadTimeBySupplierNameAndAsin.set(`${company}:${supplierName}:${asin}`, leadTime);
      }
    }

    const reorderCandidates = [] as PlainRecord[];
    for (const product of planningProducts) {
      const planningProductId = asString(product.id);
      if (!planningProductId) {
        continue;
      }
      const coverage = await this.getCoverage(planningProductId, filters.stockoutDate);
      const activeLinks = supplierProductLinks.filter(
        (link) => asString(link.planningProductId) === planningProductId && asBoolean(link.active) !== false,
      );
      const preferredLink =
        activeLinks.find((link) => asString(link.role) === 'preferred') ??
        activeLinks.find((link) => asString(link.role) === 'latest_history') ??
        activeLinks.find((link) => asString(link.role) === 'discovered') ??
        activeLinks.find((link) => asString(link.role) === 'candidate');
      const supplierId = asString(preferredLink?.supplierId);
      const supplierName = supplierId ? supplierNameById.get(supplierId)?.toLowerCase() : undefined;
      const canonicalAsin = asString(product.canonicalAsin);
      const leadTime = supplierId
        ? productLeadTimeBySupplierAndProduct.get(`${supplierId}:${planningProductId}`) ??
          (supplierName && canonicalAsin
            ? productLeadTimeBySupplierNameAndAsin.get(`${product.company}:${supplierName}:${canonicalAsin}`)
            : undefined) ??
          defaultLeadTimeBySupplier.get(supplierId)
        : undefined;
      reorderCandidates.push({
        planningProductId,
        company: product.company,
        canonicalAsin: product.canonicalAsin,
        title: product.title,
        preferredSupplierId: supplierId,
        preferredSupplierRole: preferredLink ? asString(preferredLink.role) : undefined,
        coverage,
        openQty: coverage.totalOpenQty,
        leadTimeDays: asNumber(leadTime?.leadTimeDays),
        leadTimeConfirmedAt: asString(leadTime?.confirmedAt),
        leadTimeAgeDays: ageInDays(asString(leadTime?.confirmedAt)),
        latestContactAt: coverage.contactRecency?.occurredAt,
      });
    }

    return {
      filters,
      statusLanes: SUPPLIER_ORDER_STATUS_LANES,
      reorderCandidates,
      supplierOrders,
      supplierOrderLines,
      supplierProductLinks,
      activities,
      suppliers,
      leadTimes,
      bronzeSourceRecords,
    };
  }

  async createPlannedOrder(params: CreatePlannedSupplierOrderParams) {
    if (!params.company) {
      throw new Error('Ecobase planned order failed: company is required.');
    }
    if (!params.planningProductId) {
      throw new Error('Ecobase planned order failed: planningProductId is required.');
    }
    if (!Number.isFinite(params.orderedQty) || params.orderedQty <= 0) {
      throw new Error('Ecobase planned order failed: orderedQty must be greater than zero.');
    }

    const planningProduct = await this.ensurePlanningProduct(
      params.planningProductId,
      params.company,
      'Ecobase planned order failed',
    );

    const planningProductId = asString(planningProduct.id) ?? params.planningProductId;
    const supplierId = params.supplierId;
    if (!supplierId) {
      throw new Error('Ecobase planned order failed: supplier selection is required.');
    }
    if (!isUuid(supplierId)) {
      throw new Error('Ecobase planned order failed: selected supplier must be chosen from the supplier lookup.');
    }
    const supplier = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).findOne({ filterByTk: supplierId }),
    );
    if (!asString(supplier.id)) {
      throw new Error(`Ecobase planned order failed: supplier "${supplierId}" was not found.`);
    }

    const now = new Date().toISOString();
    const externalOrderRef =
      params.externalOrderRef ??
      `planned-${asString(planningProduct.canonicalAsin) ?? params.planningProductId}-${now}`;
    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    let order = toPlainRecord(
      await orderRepo.findOne({
        filter: { companyId: asString(planningProduct.companyId), orderRef: externalOrderRef },
      }),
    );
    if (!asString(order.id)) {
      order = toPlainRecord(
        await orderRepo.create({
          values: {
            id: randomUUID(),
            companyId: asString(planningProduct.companyId),
            supplierId,
            orderRef: externalOrderRef,
            dailySequenceLetter: externalOrderRef,
            orderIntent: 'manual',
            lifecyclePhase: 'manual',
            lifecycleStatus: 'draft',
            canonicalStatus: 'draft',
            statusSource: 'operator',
            operatorStatusOverrideAt: now,
            orderDate: isoDate(now),
            fulfillmentRoute: 'unknown',
            expectedDeliveryDate: params.expectedDeliveryDate
              ? requireIsoDate(params.expectedDeliveryDate, 'expectedDeliveryDate')
              : undefined,
            remarks: params.notes,
          },
        }),
      );
    }

    const line = await this.createOrderLine({
      supplierOrderId: asString(order.id) ?? '',
      planningProductId,
      orderedQty: params.orderedQty,
      unitCost: params.unitCost,
      expectedDeliveryDate: params.expectedDeliveryDate,
      expectedSellableDate: params.expectedSellableDate,
      notes: params.notes,
      actor: params.actor,
    });

    return {
      order,
      line,
      coverage: await this.getCoverage(planningProductId),
    };
  }

  async createOrderLine(params: CreateSupplierOrderLineParams) {
    if (!params.supplierOrderId) {
      throw new Error('Ecobase supplier-order line create failed: supplierOrderId is required.');
    }
    if (!params.planningProductId) {
      throw new Error('Ecobase supplier-order line create failed: planningProductId is required.');
    }
    if (!Number.isFinite(params.orderedQty) || params.orderedQty <= 0) {
      throw new Error('Ecobase supplier-order line create failed: orderedQty must be greater than zero.');
    }

    const order = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).findOne({ filterByTk: params.supplierOrderId }),
    );
    if (order.id === undefined || order.id === null) {
      throw new Error(`Ecobase supplier-order line create failed: order "${params.supplierOrderId}" was not found.`);
    }
    const product = await this.ensurePlanningProduct(
      params.planningProductId,
      undefined,
      'Ecobase supplier-order line create failed',
    );
    const supplierProductRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts);
    let supplierProduct = toPlainRecord(
      await supplierProductRepo.findOne({
        filter: { supplierId: asString(order.supplierId), productId: asString(product.productId) },
      }),
    );
    if (!asString(supplierProduct.id)) {
      supplierProduct = toPlainRecord(
        await supplierProductRepo.create({
          values: {
            id: randomUUID(),
            supplierId: asString(order.supplierId),
            productId: asString(product.productId),
            unitCost: params.unitCost,
            analysisStatus: 'manual',
          },
        }),
      );
    }

    const values: PlainRecord = {
      id: randomUUID(),
      orderId: order.id,
      companyProductId: asString(product.id),
      supplierProductId: asString(supplierProduct.id),
      orderedQty: params.orderedQty,
      confirmedQty: 0,
      unitCost: params.unitCost,
      expectedDeliveryDate: params.expectedDeliveryDate
        ? requireIsoDate(params.expectedDeliveryDate, 'expectedDeliveryDate')
        : undefined,
      expectedSellableDate: params.expectedSellableDate
        ? requireIsoDate(params.expectedSellableDate, 'expectedSellableDate')
        : undefined,
      productAnalysisStatus: 'manual',
    };

    return this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({ values });
  }

  async applyImportRecord(
    record: { kind: string; data: PlainRecord },
    importRunId: string,
  ): Promise<SupplierOrderImportResult> {
    if (record.kind === 'supplier_identity') {
      const identity = this.toSupplierIdentityRecord(record.data);
      const supplier = await this.findOrCreateSupplier(identity, importRunId);
      if (typeof identity.leadTimeDays === 'number') {
        await this.upsertLeadTime({
          supplierId: asString(supplier.id) ?? '',
          company: identity.company,
          supplierName: identity.supplierName,
          externalSupplierCode: identity.externalSupplierCode,
          sourceConnectionId: identity.sourceConnectionId,
          source: identity.sourceSystem,
          leadTimeDays: identity.leadTimeDays,
          confirmedAt: identity.observedAt,
          payload: identity.payload ?? {},
          importRunId,
        });
      }
      return {
        handled: true,
        warnings: [],
        sample: {
          kind: 'supplier_identity',
          supplierId: supplier.id,
          supplierName: supplier.name,
          company: identity.company,
          externalSupplierCode: identity.externalSupplierCode,
        },
      };
    }

    if (record.kind === 'supplier_order') {
      const result = await this.importSupplierOrder(this.toSupplierOrderRecord(record.data), importRunId);
      return {
        handled: true,
        warnings: result.warnings,
        sample: {
          kind: 'supplier_order',
          supplierOrderId: result.order.id,
          externalOrderRef: result.order.externalOrderRef,
          status: result.order.status,
          sourceStage: result.order.sourceStage,
        },
        requiresReconcile: true,
      };
    }

    if (record.kind === 'supplier_order_activity') {
      const activity = await this.recordActivity({
        company: asString(record.data.company) ?? '',
        supplierId: asString(record.data.supplierId) ?? '',
        supplierOrderId: asString(record.data.supplierOrderId),
        activityType: (asString(record.data.activityType) ??
          'note') as RecordSupplierOrderActivityParams['activityType'],
        occurredAt: maybeIsoDateTime(record.data.occurredAt),
        actor: asString(record.data.actor),
        notes: asString(record.data.notes),
        nextFollowUpAt: maybeIsoDateTime(record.data.nextFollowUpAt),
        leadTimeDays: asNumber(record.data.leadTimeDays),
        source: asString(record.data.source),
      });
      return {
        handled: true,
        warnings: [],
        sample: {
          kind: 'supplier_order_activity',
          activityId: activity.id,
          activityType: activity.activityType,
          supplierId: activity.supplierId,
        },
      };
    }

    return { handled: false, warnings: [] };
  }

  async reconcileAfterImport(_importRunId: string) {
    return undefined;
  }

  async updateOrderOperatorFields(params: UpdateSupplierOrderOperatorFieldsParams) {
    if (!params.supplierOrderId) {
      throw new Error('Ecobase supplier-order update failed: supplierOrderId is required.');
    }
    if (!params.company) {
      throw new Error('Ecobase supplier-order update failed: company is required.');
    }
    if (
      params.supplierId === undefined &&
      params.externalOrderRef === undefined &&
      params.orderDate === undefined &&
      !params.status &&
      !params.expectedDeliveryDate &&
      !params.approvalStatus &&
      !params.paymentStatus &&
      !params.shippingCarrier &&
      !params.trackingId &&
      !params.blockedReason
    ) {
      throw new Error(
        'Ecobase supplier-order update failed: supplierId, externalOrderRef, orderDate, status, expectedDeliveryDate, approvalStatus, paymentStatus, shippingCarrier, trackingId, or blockedReason is required.',
      );
    }

    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    const existing = await this.findSupplierOrder(params.supplierOrderId);
    if (!existing) {
      throw new Error(`Ecobase supplier-order update failed: order "${params.supplierOrderId}" was not found.`);
    }
    if (asString(existing.company) !== params.company) {
      throw new Error('Ecobase supplier-order update failed: order belongs to a different company.');
    }
    let supplier: PlainRecord = {};
    if (params.supplierId !== undefined) {
      if (!params.supplierId) {
        throw new Error('Ecobase supplier-order update failed: supplierId cannot be empty.');
      }
      supplier = toPlainRecord(
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).findOne({ filterByTk: params.supplierId }),
      );
      if (!asString(supplier.id)) {
        throw new Error(`Ecobase supplier-order update failed: supplier "${params.supplierId}" was not found.`);
      }
    }

    const editedAt = new Date().toISOString();
    const values: PlainRecord = {
      operatorStatusOverrideAt: editedAt,
    };
    if (params.supplierId !== undefined) {
      values.supplierId = params.supplierId;
    }
    if (params.externalOrderRef !== undefined) {
      values.orderRef = params.externalOrderRef;
    }
    if (params.orderDate !== undefined) {
      values.orderDate = requireIsoDate(params.orderDate, 'orderDate');
    }
    if (params.status) {
      const status = validateSupplierOrderStatus(params.status);
      values.canonicalStatus = status;
      values.lifecycleStatus = status;
      values.statusSource = 'operator';
    }
    if (params.expectedDeliveryDate) {
      values.expectedDeliveryDate = requireIsoDate(params.expectedDeliveryDate, 'expectedDeliveryDate');
    }
    if (params.approvalStatus) {
      values.statusEvidenceJson = {
        ...toPlainRecord(values.statusEvidenceJson),
        approvalStatus: params.approvalStatus,
      };
    }
    if (params.paymentStatus) {
      values.statusEvidenceJson = { ...toPlainRecord(values.statusEvidenceJson), paymentStatus: params.paymentStatus };
    }
    if (params.shippingCarrier) {
      values.shippingCarrier = params.shippingCarrier;
    }
    if (params.trackingId) {
      values.trackingId = params.trackingId;
    }
    if (params.blockedReason) {
      values.remarks = params.blockedReason;
    }

    await orderRepo.update({ filterByTk: params.supplierOrderId, values });
    return this.findSupplierOrder(params.supplierOrderId);
  }

  async updateLineOperatorFields(params: UpdateSupplierOrderLineOperatorFieldsParams) {
    if (!params.supplierOrderLineId) {
      throw new Error('Ecobase supplier-order line update failed: supplierOrderLineId is required.');
    }
    if (!params.company) {
      throw new Error('Ecobase supplier-order line update failed: company is required.');
    }
    if (
      !params.planningProductId &&
      !params.externalOrderRef &&
      params.orderedQty === undefined &&
      params.receivedQty === undefined &&
      params.unitCost === undefined &&
      !params.expectedDeliveryDate &&
      !params.expectedSellableDate &&
      !params.notes
    ) {
      throw new Error(
        'Ecobase supplier-order line update failed: planningProductId, externalOrderRef, orderedQty, receivedQty, unitCost, expectedDeliveryDate, expectedSellableDate, or notes is required.',
      );
    }

    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines);
    const readModel = await silverSupplierOrderReadModel(this.db, { company: params.company, limit: 10000 });
    const existing = readModel.supplierOrderLines.find((line) => asString(line.id) === params.supplierOrderLineId);
    if (!existing) {
      throw new Error(`Ecobase supplier-order line update failed: line "${params.supplierOrderLineId}" was not found.`);
    }
    const order = readModel.supplierOrders.find(
      (candidate) => asString(candidate.id) === asString(existing.supplierOrderId),
    );
    if (!order) {
      throw new Error('Ecobase supplier-order line update failed: parent order was not found.');
    }

    const editedAt = new Date().toISOString();
    if (params.externalOrderRef) {
      const externalOrderRef = asString(params.externalOrderRef);
      if (!externalOrderRef) {
        throw new Error('Ecobase supplier-order line update failed: externalOrderRef must not be empty.');
      }
      const duplicate = readModel.supplierOrders.find(
        (candidate) =>
          asString(candidate.company) === params.company &&
          asString(candidate.externalOrderRef) === externalOrderRef &&
          asString(candidate.id) !== asString(order.id),
      );
      if (duplicate) {
        throw new Error(
          `Ecobase supplier-order line update failed: supplier order "${externalOrderRef}" already exists for ${params.company}.`,
        );
      }
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({
        filterByTk: asString(order.id) as string,
        values: {
          orderRef: externalOrderRef,
          operatorStatusOverrideAt: editedAt,
        },
      });
    }

    const values: PlainRecord = {};
    if (params.planningProductId) {
      const product = await this.ensurePlanningProduct(
        params.planningProductId,
        asString(existing.company),
        'Ecobase supplier-order line update failed',
      );
      values.companyProductId = asString(product.id);
      const supplierProductRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts);
      let supplierProduct = toPlainRecord(
        await supplierProductRepo.findOne({
          filter: { supplierId: asString(order.supplierId), productId: asString(product.productId) },
        }),
      );
      if (!asString(supplierProduct.id)) {
        supplierProduct = toPlainRecord(
          await supplierProductRepo.create({
            values: {
              id: randomUUID(),
              supplierId: asString(order.supplierId),
              productId: asString(product.productId),
              analysisStatus: 'manual',
            },
          }),
        );
      }
      values.supplierProductId = asString(supplierProduct.id);
    }
    if (params.orderedQty !== undefined) {
      if (!Number.isFinite(params.orderedQty) || params.orderedQty <= 0) {
        throw new Error('Ecobase supplier-order line update failed: orderedQty must be greater than zero.');
      }
      values.orderedQty = params.orderedQty;
    }
    if (params.receivedQty !== undefined) {
      if (!Number.isFinite(params.receivedQty) || params.receivedQty < 0) {
        throw new Error('Ecobase supplier-order line update failed: receivedQty must be zero or greater.');
      }
      values.confirmedQty = params.receivedQty;
    }
    if (params.unitCost !== undefined) {
      if (!Number.isFinite(params.unitCost) || params.unitCost < 0) {
        throw new Error('Ecobase supplier-order line update failed: unitCost must be zero or greater.');
      }
      values.unitCost = params.unitCost;
    }
    if (params.expectedDeliveryDate) {
      values.expectedDeliveryDate = requireIsoDate(params.expectedDeliveryDate, 'expectedDeliveryDate');
    }
    if (params.expectedSellableDate) {
      values.expectedSellableDate = requireIsoDate(params.expectedSellableDate, 'expectedSellableDate');
      values.prepInstruction = `manual_expected_sellable:${params.actor ?? 'operator'}`;
    }
    if (params.notes) {
      const currentInstruction = asString(values.prepInstruction);
      values.prepInstruction = currentInstruction ? `${currentInstruction}\n${params.notes}` : params.notes;
    }

    await lineRepo.update({ filterByTk: params.supplierOrderLineId, values });
    return (
      await silverSupplierOrderReadModel(this.db, { company: params.company, limit: 10000 })
    ).supplierOrderLines.find((line) => asString(line.id) === params.supplierOrderLineId);
  }

  async deleteLineOperatorFields(params: DeleteSupplierOrderLineOperatorFieldsParams) {
    if (!params.supplierOrderLineId) {
      throw new Error('Ecobase supplier-order line delete failed: supplierOrderLineId is required.');
    }
    if (!params.company) {
      throw new Error('Ecobase supplier-order line delete failed: company is required.');
    }

    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines);
    const readModel = await silverSupplierOrderReadModel(this.db, { company: params.company, limit: 10000 });
    const existing = readModel.supplierOrderLines.find(
      (line) => asString(line.id) === String(params.supplierOrderLineId),
    );
    if (!existing) {
      throw new Error(`Ecobase supplier-order line delete failed: line "${params.supplierOrderLineId}" was not found.`);
    }

    await (
      lineRepo as EcobaseRepository & {
        destroy(args: { filterByTk: string | number }): Promise<unknown>;
      }
    ).destroy({ filterByTk: params.supplierOrderLineId });
    return existing;
  }

  async recordActivity(params: RecordSupplierOrderActivityParams) {
    if (!params.company) {
      throw new Error('Ecobase supplier-order activity failed: company is required.');
    }
    if (!params.supplierId) {
      throw new Error('Ecobase supplier-order activity failed: supplierId is required.');
    }

    const activityType = validateSupplierOrderActivityType(params.activityType);
    const leadTimeDays = validateSupplierLeadTimeDays(params.leadTimeDays, 'Ecobase supplier-order activity failed');
    if (activityType === 'lead_time_checked' && leadTimeDays === undefined) {
      throw new Error('Ecobase supplier-order activity failed: leadTimeDays is required for lead_time_checked.');
    }
    const supplier = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).findOne({ filterByTk: params.supplierId }),
    );
    if (!asString(supplier.id)) {
      throw new Error(`Ecobase supplier-order activity failed: supplier "${params.supplierId}" was not found.`);
    }
    if (params.supplierOrderId) {
      const order = await this.findSupplierOrder(params.supplierOrderId);
      if (!order) {
        throw new Error(`Ecobase supplier-order activity failed: order "${params.supplierOrderId}" was not found.`);
      }
      if (asString(order.company) !== params.company) {
        throw new Error('Ecobase supplier-order activity failed: order belongs to a different company.');
      }
      if (
        asString(order.supplierId) &&
        asString(order.supplierId) !== params.supplierId &&
        asString(order.supplierName) !== asString(supplier.displayName)
      ) {
        throw new Error('Ecobase supplier-order activity failed: order belongs to a different supplier.');
      }
    }

    const activityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    const occurredAt = maybeIsoDateTime(params.occurredAt) ?? new Date().toISOString();
    const values = {
      id: randomUUID(),
      entityType: params.supplierOrderId ? 'supplier_order' : 'supplier',
      entityId: params.supplierOrderId ?? params.supplierId,
      actorType: params.actorUserId ? 'user' : 'operator',
      actorUserId: params.actorUserId,
      commentType: activityType,
      body: params.notes ?? activityType,
      followUpAt: maybeIsoDateTime(params.nextFollowUpAt),
      contextSnapshotJson: {
        company: params.company,
        supplierId: params.supplierId,
        supplierOrderId: params.supplierOrderId,
        occurredAt,
        leadTimeDays,
        source: params.source ?? 'manual',
        actor: params.actor,
      },
    };

    const record = await activityRepo.create({ values });

    if (activityType === 'contacted_supplier') {
      const supplierValues: Record<string, unknown> = {
        lastContactedAt: occurredAt,
        approvalStatus: 'contacting',
      };
      const nextFollowUpAt = maybeIsoDateTime(params.nextFollowUpAt);
      if (nextFollowUpAt) supplierValues.nextFollowUpAt = nextFollowUpAt;
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
        .update({ filterByTk: params.supplierId, values: supplierValues });
    }

    if (activityType === 'lead_time_checked' && typeof leadTimeDays === 'number') {
      await this.upsertLeadTime({
        supplierId: params.supplierId,
        company: params.company,
        supplierName: asString(supplier.displayName) ?? '(unknown supplier)',
        externalSupplierCode: asString(supplier.normalizedName),
        sourceConnectionId: 'manual',
        source: 'manual',
        leadTimeDays,
        confirmedAt: occurredAt,
        payload: { activityId: asString(toPlainRecord(record).id) },
      });
    }

    return toPlainRecord(record);
  }

  async updateActivityComment(params: UpdateSupplierOrderActivityCommentParams) {
    const activity = await this.editableManualComment(params.activityId, params.company, 'update');
    const notes = params.notes.trim();
    if (!notes) {
      throw new Error('Ecobase supplier-order activity update failed: notes are required.');
    }
    const now = new Date().toISOString();
    const payload = toPlainRecord(activity.payload);
    const editHistory = Array.isArray(payload.editHistory) ? payload.editHistory : [];
    await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).update({
      filterByTk: params.activityId,
      values: {
        body: notes,
        contextSnapshotJson: {
          ...payload,
          editHistory: [
            ...editHistory,
            { notes: asString(activity.body) ?? '', editedAt: now, editedById: params.actorUserId },
          ],
        },
      },
    });
    return toPlainRecord(
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverActivityComments)
        .findOne({ filterByTk: params.activityId }),
    );
  }

  async deleteActivityComment(params: DeleteSupplierOrderActivityCommentParams) {
    await this.editableManualComment(params.activityId, params.company, 'delete');
    await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).update({
      filterByTk: params.activityId,
      values: { deletedAt: new Date().toISOString(), deletedByUserId: params.actorUserId },
    });
    return toPlainRecord(
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverActivityComments)
        .findOne({ filterByTk: params.activityId }),
    );
  }

  async updateSupplierLeadTime(params: UpdateSupplierLeadTimeParams) {
    if (!params.company) {
      throw new Error('Ecobase supplier lead-time update failed: company is required.');
    }
    if (!params.supplierId) {
      throw new Error('Ecobase supplier lead-time update failed: supplierId is required.');
    }
    const leadTimeDays = validateSupplierLeadTimeDays(params.leadTimeDays, 'Ecobase supplier lead-time update failed');
    if (leadTimeDays === undefined) {
      throw new Error('Ecobase supplier lead-time update failed: leadTimeDays is required.');
    }

    const supplier = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).findOne({ filterByTk: params.supplierId }),
    );
    if (!asString(supplier.id)) {
      throw new Error(`Ecobase supplier lead-time update failed: supplier "${params.supplierId}" was not found.`);
    }

    let product: PlainRecord = {};
    if (params.planningProductId) {
      product = await this.ensurePlanningProduct(
        params.planningProductId,
        params.company,
        'Ecobase supplier lead-time update failed',
      );
    }

    const leadTimePlanningProductId = asString(product.id);
    const confirmedAt = params.confirmedAt ? maybeIsoDateTime(params.confirmedAt) : new Date().toISOString();
    await this.upsertLeadTime({
      supplierId: params.supplierId,
      company: params.company,
      supplierName: asString(supplier.displayName),
      externalSupplierCode: asString(supplier.normalizedName),
      sourceConnectionId: 'manual',
      source: 'manual',
      leadTimeDays,
      confirmedAt: confirmedAt ?? new Date().toISOString(),
      planningProductId: leadTimePlanningProductId,
      asin: params.asin ?? asString(product.canonicalAsin),
      sku: params.sku,
      notes: params.notes,
      payload: {
        source: 'operator',
        actor: params.actor,
      },
    });

    return this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).findOne({
      filter: { supplierId: params.supplierId, productId: asString(product.productId) },
    });
  }

  async getCoverage(planningProductId: string, projectedStockoutDate?: string): Promise<SupplierOrderCoverageView> {
    const silverOrders = await silverSupplierOrderReadModel(this.db, { limit: 10000 });
    const ordersById = new Map(silverOrders.supplierOrders.map((order) => [asString(order.id), order]));
    const lines = silverOrders.supplierOrderLines.filter(
      (line) => asString(line.planningProductId) === planningProductId,
    );
    const coverageLines: SupplierOrderCoverageLine[] = [];

    for (const line of lines) {
      const order = ordersById.get(asString(line.supplierOrderId));
      if (!order) {
        continue;
      }
      const status = normalizeSupplierOrderStatus(asString(order.status));
      if (!OPEN_SUPPLIER_ORDER_STATUSES.includes(status)) {
        continue;
      }

      const orderedQty = asNumber(line.orderedQty) ?? 0;
      const receivedQty = asNumber(line.receivedQty) ?? 0;
      const openQty = Math.max(0, orderedQty - receivedQty);
      if (openQty <= 0) {
        continue;
      }

      const expectedSellableDate = asString(line.expectedSellableDate) ?? null;
      const warnings: string[] = [];
      let coverageBucket: SupplierOrderCoverageLine['coverageBucket'] = 'incomplete';
      if (status === 'blocked') {
        coverageBucket = 'blocked';
      } else if (!isReliableSupplierOrderCoverageStatus(status)) {
        coverageBucket = 'incomplete';
        warnings.push('weak_order_status');
      } else if (!expectedSellableDate || !projectedStockoutDate) {
        coverageBucket = 'incomplete';
        if (!expectedSellableDate) {
          warnings.push('missing_expected_sellable_date');
        }
        if (!projectedStockoutDate) {
          warnings.push('missing_projected_stockout_date');
        }
      } else if (expectedSellableDate <= projectedStockoutDate) {
        coverageBucket = 'usable_before_oos';
      } else {
        coverageBucket = 'late';
      }

      coverageLines.push({
        supplierOrderId: asString(order.id) ?? '',
        supplierOrderLineId: asString(line.id) ?? '',
        supplierId: asString(line.supplierId) ?? asString(order.supplierId) ?? '',
        openQty,
        expectedSellableDate,
        coverageBucket,
        unreliableCoverage: coverageBucket === 'blocked' || coverageBucket === 'incomplete',
        contactRecency: await this.resolveContactRecency({
          company: asString(line.company) ?? asString(order.company) ?? '',
          supplierId: asString(line.supplierId) ?? asString(order.supplierId) ?? '',
          supplierOrderId: asString(order.id),
        }),
        evidenceIds: uniqueStrings([
          asString(order.id),
          asString(line.id),
          asString(order.lastImportRunId),
          asString(line.lastImportRunId),
        ]),
        warnings,
      });
    }

    const totalOpenQty = coverageLines.reduce((total, line) => total + line.openQty, 0);
    const usableOpenQtyBeforeOos = coverageLines
      .filter((line) => line.coverageBucket === 'usable_before_oos')
      .reduce((total, line) => total + line.openQty, 0);
    const lateOpenQty = coverageLines
      .filter((line) => line.coverageBucket === 'late')
      .reduce((total, line) => total + line.openQty, 0);
    const blockedOpenQty = coverageLines
      .filter((line) => line.coverageBucket === 'blocked')
      .reduce((total, line) => total + line.openQty, 0);
    const incompleteOpenQty = coverageLines
      .filter((line) => line.coverageBucket === 'incomplete')
      .reduce((total, line) => total + line.openQty, 0);
    const nextExpectedSellableDate =
      coverageLines
        .filter((line) => line.coverageBucket === 'usable_before_oos' && line.expectedSellableDate)
        .map((line) => line.expectedSellableDate as string)
        .sort()[0] ?? null;
    const nextLateExpectedSellableDate =
      coverageLines
        .filter((line) => line.coverageBucket === 'late' && line.expectedSellableDate)
        .map((line) => line.expectedSellableDate as string)
        .sort()[0] ?? null;
    const dataWarnings = uniqueStrings(coverageLines.flatMap((line) => line.warnings));
    const unreliableCoverage = coverageLines.some((line) => line.unreliableCoverage);
    const blockedOpenOrder = blockedOpenQty > 0;
    const contactRecency =
      [...coverageLines]
        .map((line) => line.contactRecency)
        .filter((value): value is NonNullable<SupplierOrderCoverageLine['contactRecency']> => value !== null)
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] ?? null;

    let coverageState: SupplierOrderCoverageView['coverageState'];
    if (totalOpenQty === 0) {
      coverageState = 'no_open_order';
    } else if (incompleteOpenQty === totalOpenQty) {
      coverageState = 'incomplete_or_stale';
    } else if (blockedOpenQty === totalOpenQty) {
      coverageState = 'blocked_open_order';
    } else if (usableOpenQtyBeforeOos === totalOpenQty) {
      coverageState = 'arrives_before_stockout';
    } else if (lateOpenQty + usableOpenQtyBeforeOos === totalOpenQty && lateOpenQty === totalOpenQty) {
      coverageState = 'arrives_late';
    } else {
      coverageState = 'partial_or_mixed_coverage';
    }

    return {
      planningProductId,
      coverageState,
      totalOpenQty,
      usableOpenQtyBeforeOos,
      lateOpenQty,
      blockedOpenQty,
      incompleteOpenQty,
      nextExpectedSellableDate,
      nextLateExpectedSellableDate,
      unreliableCoverage,
      blockedOpenOrder,
      dataWarnings,
      contactRecency,
      evidenceIds: uniqueStrings(coverageLines.flatMap((line) => line.evidenceIds)),
      linkedSupplierOrderIds: uniqueStrings(coverageLines.map((line) => line.supplierOrderId)),
      linkedSupplierOrderLineIds: uniqueStrings(coverageLines.map((line) => line.supplierOrderLineId)),
      coverageLines,
    };
  }

  async getPrepBufferDays(company?: string) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderSettings);
    if (company) {
      const companySetting = await repo.findOne({
        filter: { naturalKey: `supplier-order-setting:${company}:prep_buffer_days` },
      });
      const companyValue = asNumber(toPlainRecord(companySetting).numberValue);
      if (typeof companyValue === 'number') {
        return companyValue;
      }
    }

    const globalSetting = await repo.findOne({
      filter: { naturalKey: 'supplier-order-setting:global:prep_buffer_days' },
    });
    const value = asNumber(toPlainRecord(globalSetting).numberValue);
    return typeof value === 'number' ? value : 0;
  }

  private toSupplierIdentityRecord(data: PlainRecord): SupplierIdentityRecord {
    const company = asString(data.company);
    const supplierName = asString(data.supplierName) ?? asString(data.externalSupplierName);
    const externalSupplierCode = asString(data.externalSupplierCode);
    const sourceSystem = asString(data.sourceSystem);
    const sourceConnectionId = asString(data.sourceConnectionId);
    if (!company || (!supplierName && !externalSupplierCode) || !sourceSystem || !sourceConnectionId) {
      throw new Error(
        'Ecobase supplier identity import failed: company, supplierName or externalSupplierCode, sourceSystem, and sourceConnectionId are required.',
      );
    }
    return {
      company,
      supplierName,
      externalSupplierCode,
      sourceSystem,
      observedAt: maybeIsoDateTime(data.observedAt) ?? new Date().toISOString(),
      sourceConnectionId,
      payload: toImportPayload(data),
      leadTimeDays: validateSupplierLeadTimeDays(
        asNumber(data.leadTimeDays),
        'Ecobase supplier identity import failed',
      ),
    };
  }

  private toSupplierOrderRecord(data: PlainRecord): SupplierOrderRecord {
    const company = asString(data.company);
    const supplierName = asString(data.supplierName);
    const externalSupplierCode = asString(data.externalSupplierCode);
    const sourceSystem = asString(data.sourceSystem);
    const sourceConnectionId = asString(data.sourceConnectionId);
    const externalOrderRef = asString(data.externalOrderRef);
    if (
      !company ||
      (!supplierName && !externalSupplierCode) ||
      !sourceSystem ||
      !sourceConnectionId ||
      !externalOrderRef
    ) {
      throw new Error(
        'Ecobase supplier order import failed: company, supplierName or externalSupplierCode, sourceSystem, sourceConnectionId, and externalOrderRef are required.',
      );
    }
    return {
      company,
      supplierName,
      externalSupplierCode,
      sourceSystem,
      sourceConnectionId,
      externalOrderRef,
      sourceStage: (asString(data.sourceStage) ?? 'purchase_order') as SupplierOrderRecord['sourceStage'],
      status: validateSupplierOrderStatus(asString(data.status)),
      approvalStatus: truncateText(asString(data.approvalStatus)),
      paymentStatus: truncateText(asString(data.paymentStatus)),
      shippingCarrier: truncateText(asString(data.shippingCarrier)),
      trackingId: truncateText(asString(data.trackingId)),
      expectedDeliveryDate: maybeIsoDate(data.expectedDeliveryDate),
      blockedReason: truncateText(asString(data.blockedReason)),
      orderDate: maybeIsoDate(data.orderDate),
      statusUpdatedAt: maybeIsoDateTime(data.statusUpdatedAt),
      lastMeaningfulUpdateAt: maybeIsoDateTime(data.lastMeaningfulUpdateAt),
      lines: toLineImportRecords(data.lines),
      payload: toImportPayload(data),
    };
  }

  private async importSupplierOrder(
    record: SupplierOrderRecord,
    importRunId: string,
  ): Promise<{ order: PlainRecord; warnings: SupplierOrderImportWarning[] }> {
    const supplier = await this.findOrCreateSupplier(
      {
        company: record.company,
        supplierName: record.supplierName,
        externalSupplierCode: record.externalSupplierCode,
        sourceSystem: record.sourceSystem,
        observedAt:
          record.statusUpdatedAt ??
          record.lastMeaningfulUpdateAt ??
          `${record.orderDate ?? isoDate(new Date())}T00:00:00.000Z`,
        sourceConnectionId: record.sourceConnectionId,
        payload: record.payload ?? {},
      },
      importRunId,
    );
    const resolvedSupplierName = asString(supplier.displayName) ?? record.supplierName;
    const supplierId = asString(supplier.id);
    if (!supplierId) {
      return {
        order: {
          externalOrderRef: record.externalOrderRef,
          status: 'skipped',
          sourceStage: record.sourceStage,
        },
        warnings: [
          {
            code: 'supplier_identity_unresolved',
            message: `Ecobase supplier-order import skipped ${record.company}/${
              record.externalOrderRef
            } because supplier code ${
              record.externalSupplierCode ?? 'unknown'
            } is not present in Supplier IDs and no supplier name was provided.`,
            payload: {
              company: record.company,
              externalOrderRef: record.externalOrderRef,
              externalSupplierCode: record.externalSupplierCode,
            },
          },
        ],
      };
    }

    const company = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).findOne({ filter: { name: record.company } }),
    );
    const companyId = asString(company.id);
    if (!companyId) {
      throw new Error(
        `Ecobase supplier order import failed: company "${record.company}" was not found in silverCompanies.`,
      );
    }
    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    const orderNaturalKey = `supplier-order:${record.company}:${record.externalOrderRef}`;
    const existingOrder = toPlainRecord(
      await orderRepo.findOne({ filter: { companyId, orderRef: record.externalOrderRef } }),
    );
    const existingOrderId = asString(existingOrder.id);
    const importedStatusUpdatedAt =
      record.statusUpdatedAt ??
      record.lastMeaningfulUpdateAt ??
      `${record.orderDate ?? isoDate(new Date())}T00:00:00.000Z`;

    const orderValues: PlainRecord = {
      companyId,
      supplierId,
      orderRef: record.externalOrderRef,
      orderDate: record.orderDate ?? isoDate(new Date()),
      dailySequenceLetter: record.externalOrderRef,
      orderIntent: record.sourceStage,
      fulfillmentRoute: 'unknown',
      expectedDeliveryDate: record.expectedDeliveryDate,
      shippingCarrier: record.shippingCarrier,
      trackingId: record.trackingId,
      remarks: record.blockedReason,
      statusEvidenceJson: {
        approvalStatus: record.approvalStatus,
        paymentStatus: record.paymentStatus,
        sourceConnectionId: record.sourceConnectionId,
        sourceStage: chooseStage(asString(existingOrder.orderIntent), record.sourceStage),
        payload: record.payload ?? {},
        lastImportRunId: importRunId,
        lastMeaningfulUpdateAt: maxIsoDate([
          asString(toPlainRecord(existingOrder.statusEvidenceJson).lastMeaningfulUpdateAt),
          record.lastMeaningfulUpdateAt,
          importedStatusUpdatedAt,
        ]),
      },
    };

    if (asString(existingOrder.statusSource) !== 'operator' || !asString(existingOrder.operatorStatusOverrideAt)) {
      orderValues.canonicalStatus = record.status;
      orderValues.lifecycleStatus = record.status;
      orderValues.statusSource = 'import';
    }

    let persistedOrder: unknown;
    if (existingOrderId) {
      await orderRepo.update({ filterByTk: existingOrderId, values: orderValues });
      persistedOrder = await orderRepo.findOne({ filterByTk: existingOrderId });
    } else {
      persistedOrder = await orderRepo.create({
        values: {
          id: randomUUID(),
          ...orderValues,
          canonicalStatus: record.status,
          lifecycleStatus: record.status,
          statusSource: 'import',
        },
      });
    }
    const order: PlainRecord = {
      ...toPlainRecord(persistedOrder),
      naturalKey: orderNaturalKey,
      company: record.company,
      supplierId,
      externalOrderRef: record.externalOrderRef,
      status: record.status,
      sourceStage: record.sourceStage,
    };
    const orderId = asString(order.id);
    if (!orderId) {
      throw new Error(`Ecobase supplier order import failed: order "${orderNaturalKey}" was saved without an id.`);
    }

    const warnings: SupplierOrderImportWarning[] = [];
    for (const line of record.lines) {
      const lineWarnings = await this.upsertOrderLine({
        importRunId,
        order,
        company: record.company,
        supplierId,
        externalSupplierCode: record.externalSupplierCode,
        supplierName: resolvedSupplierName,
        sourceConnectionId: record.sourceConnectionId,
        sourceStage: record.sourceStage,
        line,
      });
      warnings.push(...lineWarnings);
      if (typeof line.leadTimeDays === 'number') {
        try {
          validateSupplierLeadTimeDays(line.leadTimeDays, 'Ecobase supplier-order import failed');
        } catch (error) {
          warnings.push({
            code: 'supplier_lead_time_invalid',
            message:
              error instanceof Error ? error.message : 'Ecobase supplier-order import failed: leadTimeDays is invalid.',
            payload: {
              company: record.company,
              externalOrderRef: record.externalOrderRef,
              externalSupplierCode: record.externalSupplierCode,
              sourceOrderLineRef: line.sourceOrderLineRef,
              leadTimeDays: line.leadTimeDays,
            },
          });
        }
      }
    }

    return { order, warnings };
  }

  private async upsertOrderLine(params: {
    importRunId: string;
    order: PlainRecord;
    company: string;
    supplierId: string;
    externalSupplierCode?: string;
    supplierName?: string;
    sourceConnectionId: string;
    sourceStage: SupplierOrderRecord['sourceStage'];
    line: SupplierOrderLineImport;
  }) {
    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines);
    const resolved = await this.resolvePlanningProduct({
      company: params.company,
      asin: params.line.asin,
      sku: params.line.sku,
    });
    const warnings: SupplierOrderImportWarning[] = [];
    if (resolved.warning) {
      warnings.push(resolved.warning);
    }

    const companyProduct: PlainRecord = resolved.planningProductId
      ? await this.ensurePlanningProduct(
          resolved.planningProductId,
          params.company,
          'Ecobase supplier-order import failed',
        )
      : {};
    const supplierProductRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts);
    let supplierProduct = toPlainRecord(
      await supplierProductRepo.findOne({
        filter: { supplierId: params.supplierId, productId: asString(companyProduct.productId) },
      }),
    );
    if (asString(companyProduct.productId) && !asString(supplierProduct.id)) {
      supplierProduct = toPlainRecord(
        await supplierProductRepo.create({
          values: {
            id: randomUUID(),
            supplierId: params.supplierId,
            productId: asString(companyProduct.productId),
            supplierSku: params.line.sku,
            unitCost: params.line.unitCost,
            leadTimeDays: params.line.leadTimeDays,
            analysisStatus: 'imported',
          },
        }),
      );
    }
    const existing = resolved.planningProductId
      ? await this.findExistingImportedOrderLine({
          orderId: asString(params.order.id),
          planningProductId: resolved.planningProductId,
          asin: params.line.asin,
          sku: params.line.sku,
        })
      : {};
    const lineId = asString(existing.id);
    const baseValues: PlainRecord = {
      orderId: asString(params.order.id),
      companyProductId: resolved.planningProductId,
      supplierProductId: asString(supplierProduct.id),
      orderedQty: params.line.orderedQty,
      confirmedQty: params.line.receivedQty ?? 0,
      expectedDeliveryDate: params.line.expectedDeliveryDate ?? asString(params.order.expectedDeliveryDate),
      expectedSellableDate: params.line.expectedSellableDate,
      unitCost: params.line.unitCost,
      productAnalysisStatus: resolved.planningProductId ? 'imported' : 'mapping_missing',
      priority: params.sourceStage,
      prepInstruction: resolved.warning?.message,
    };

    let persisted: unknown;
    if (lineId) {
      await lineRepo.update({ filterByTk: lineId, values: baseValues });
      persisted = await lineRepo.findOne({ filterByTk: lineId });
    } else {
      persisted = await lineRepo.create({
        values: {
          id: randomUUID(),
          ...baseValues,
        },
      });
    }
    const lineRecord = toPlainRecord(persisted);
    const derived = await this.deriveExpectedSellableDate({
      line: lineRecord,
      order: params.order,
      importedLine: params.line,
    });
    if (Object.keys(derived.values).length > 0) {
      await lineRepo.update({ filterByTk: asString(lineRecord.id), values: derived.values });
    }
    if (derived.warning) {
      warnings.push(derived.warning);
    }
    return warnings;
  }

  private async findExistingImportedOrderLine(params: {
    orderId?: string;
    planningProductId: string;
    asin?: string;
    sku?: string;
  }) {
    if (!params.orderId) return {};

    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines);
    const exact = toPlainRecord(
      await lineRepo.findOne({ filter: { orderId: params.orderId, companyProductId: params.planningProductId } }),
    );
    if (asString(exact.id) || (!params.asin && !params.sku)) return exact;

    const lines = (await lineRepo.find({ filter: { orderId: params.orderId }, limit: 500 })).map(toPlainRecord);
    const defaultIdentityMatches: PlainRecord[] = [];
    for (const line of lines) {
      const lineCompanyProductId = asString(line.companyProductId);
      if (!lineCompanyProductId || lineCompanyProductId === params.planningProductId) continue;
      const companyProduct = toPlainRecord(
        await this.db
          .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
          .findOne({ filterByTk: lineCompanyProductId }),
      );
      const amazonAccountId = asString(companyProduct.amazonAccountId);
      if (!amazonAccountId) continue;
      const account = toPlainRecord(
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).findOne({ filterByTk: amazonAccountId }),
      );
      if (asString(account.marketplace)?.toLowerCase() !== 'default') continue;
      const productId = asString(companyProduct.productId);
      if (!productId) continue;
      const product = toPlainRecord(
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).findOne({ filterByTk: productId }),
      );
      const sameAsin = Boolean(params.asin && asString(product.asin) === params.asin);
      const sameSku = Boolean(params.sku && asString(product.sku) === params.sku);
      if (sameAsin || sameSku) defaultIdentityMatches.push(line);
    }
    return defaultIdentityMatches.length === 1 ? defaultIdentityMatches[0] : {};
  }

  private async deriveExpectedSellableDate(params: {
    line: PlainRecord;
    order: PlainRecord | null;
    importedLine?: SupplierOrderLineImport;
  }) {
    const line = params.line;
    const order = params.order ?? {};
    const company = asString(line.company) ?? asString(order.company);
    const prepBufferDays = await this.getPrepBufferDays(company);
    const existingSource = asString(line.expectedSellableDateSource);
    const existingOperatorEditAt = asString(line.lastOperatorEditAt);
    const prepInstruction = asString(line.prepInstruction);
    if (
      (existingSource === 'manual' && existingOperatorEditAt) ||
      prepInstruction?.startsWith('manual_expected_sellable:')
    ) {
      return { values: {}, warning: undefined };
    }

    const existingExpectedSellableDate = asString(line.expectedSellableDate);
    const importedExpectedSellableDate = params.importedLine?.expectedSellableDate;
    if (existingExpectedSellableDate && existingSource?.startsWith('imported_') && !importedExpectedSellableDate) {
      return { values: {}, warning: undefined };
    }
    if (importedExpectedSellableDate) {
      return {
        values: {
          expectedSellableDate: importedExpectedSellableDate,
        },
        warning: undefined,
      };
    }

    const expectedDeliveryDate = safeIsoDate(line.expectedDeliveryDate) ?? safeIsoDate(order.expectedDeliveryDate);
    if (expectedDeliveryDate) {
      return {
        values: {
          expectedSellableDate: addDays(expectedDeliveryDate, prepBufferDays),
          prepInstruction: `Expected sellable = delivery date + ${prepBufferDays} prep days`,
        },
        warning: undefined,
      };
    }

    let leadTime =
      params.importedLine?.leadTimeDays ??
      (await this.findLeadTime({
        supplierId: asString(line.supplierId) ?? asString(order.supplierId),
        company,
        externalSupplierCode: undefined,
        planningProductId: asString(line.companyProductId) ?? asString(line.planningProductId),
      }));
    if (typeof leadTime === 'number') {
      try {
        leadTime = validateSupplierLeadTimeDays(leadTime, 'Ecobase supplier-order import failed');
      } catch {
        leadTime = undefined;
      }
    }
    const baseDate = safeIsoDate(order.orderDate) ?? safeIsoDate(order.statusUpdatedAt);
    if (typeof leadTime === 'number' && baseDate) {
      return {
        values: {
          expectedSellableDate: addDays(baseDate, leadTime + prepBufferDays),
          prepInstruction: `Expected sellable = order date + ${leadTime} lead-time days + ${prepBufferDays} prep days`,
        },
        warning: undefined,
      };
    }

    return {
      values: {
        expectedSellableDate: null,
        prepInstruction: `Missing expected delivery date and lead time; prep buffer is ${prepBufferDays} days`,
      },
      warning: {
        code: 'missing_expected_sellable_date',
        message:
          'Ecobase supplier-order line could not derive expected sellable date because expected delivery and lead time are missing.',
        payload: {
          supplierOrderId: asString(order.id),
          supplierOrderLineId: asString(line.id),
        },
      },
    };
  }

  private async ensurePlanningProduct(
    planningProductId: string,
    expectedCompany: string | undefined,
    errorPrefix: string,
  ): Promise<PlainRecord> {
    if (planningProductId.startsWith('fallback:')) {
      throw new Error(`${errorPrefix}: planning product must be selected from a persisted planning-product record.`);
    }

    const companyProduct = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).findOne({ filterByTk: planningProductId }),
    );
    if (!asString(companyProduct.id)) {
      throw new Error(`${errorPrefix}: planning product "${planningProductId}" was not found.`);
    }
    const [company, product] = await Promise.all([
      this.db
        .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
        .findOne({ filterByTk: asString(companyProduct.companyId) }),
      this.db
        .getRepository(ECOBASE_COLLECTIONS.silverProducts)
        .findOne({ filterByTk: asString(companyProduct.productId) }),
    ]);
    const companyPlain = toPlainRecord(company);
    const productPlain = toPlainRecord(product);
    if (expectedCompany && asString(companyPlain.name) !== expectedCompany) {
      throw new Error(`${errorPrefix}: planning product belongs to a different company.`);
    }
    return {
      ...companyProduct,
      company: asString(companyPlain.name),
      canonicalAsin: asString(productPlain.asin),
      asin: asString(productPlain.asin),
      sku: asString(productPlain.sku),
      title: asString(productPlain.title),
      brand: asString(productPlain.brand),
    };
  }

  private async refreshSupplierProductLinks(_planningProductId: string) {
    return undefined;
  }

  private async evidenceBackedPlanningProductId(companyProducts: PlainRecord[]) {
    const scored = await Promise.all(
      companyProducts.map(async (companyProduct) => {
        const id = asString(companyProduct.id);
        return id ? { id, score: await this.companyProductEvidenceScore(companyProduct) } : undefined;
      }),
    );
    const ranked = scored
      .filter((candidate): candidate is { id: string; score: number } => Boolean(candidate))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best || best.score < MIN_COMPANY_PRODUCT_EVIDENCE_SCORE) return undefined;
    return ranked.filter((candidate) => candidate.score === best.score).length === 1 ? best.id : undefined;
  }

  private async companyProductEvidenceScore(companyProduct: PlainRecord) {
    const companyProductId = asString(companyProduct.id);
    if (!companyProductId) return 0;
    const amazonAccountId = asString(companyProduct.amazonAccountId);
    if (!amazonAccountId) return 0;
    const account = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts).findOne({ filterByTk: amazonAccountId }),
    );
    const marketplace = asString(account.marketplace);
    if (!marketplace || marketplace.toLowerCase() === 'default') return 0;

    const [inventory, fact, traffic] = await Promise.all([
      this.db.getRepository(ECOBASE_COLLECTIONS.silverInventorySnapshots).findOne({ filter: { companyProductId } }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts).findOne({ filter: { companyProductId } }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverTrafficSnapshots).findOne({ filter: { companyProductId } }),
    ]);
    return (inventory ? 1000 : 0) + (fact ? 500 : 0) + (traffic ? 100 : 0) + (marketplace === 'Amazon.com' ? 5 : 1);
  }

  private async resolvePlanningProduct(params: { company: string; asin?: string; sku?: string }) {
    if (!params.asin && !params.sku) {
      return {
        planningProductId: undefined,
        warning: {
          code: 'planning_product_mapping_missing',
          message:
            'Ecobase supplier-order import could not resolve planning product because both ASIN and SKU are missing.',
          payload: { company: params.company },
        } as SupplierOrderImportWarning,
      };
    }

    const company = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).findOne({ filter: { name: params.company } }),
    );
    const companyId = asString(company.id);
    const companyProducts = companyId
      ? (await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ filter: { companyId } })).map(
          toPlainRecord,
        )
      : [];
    const productsById = new Map(
      (await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: 50000 }))
        .map(toPlainRecord)
        .map((product) => [asString(product.id), product]),
    );
    const matchingCompanyProducts = companyProducts.filter((companyProduct) => {
      const product = productsById.get(asString(companyProduct.productId));
      const productAsin = asString(product?.asin);
      const productSku = asString(product?.sku);
      if (params.asin) return productAsin === params.asin;
      return Boolean(params.sku && productSku === params.sku);
    });
    const planningProductIds = uniqueStrings(
      matchingCompanyProducts.map((companyProduct) => asString(companyProduct.id)),
    );
    if (planningProductIds.length === 1) {
      return { planningProductId: planningProductIds[0], warning: undefined };
    }

    if (planningProductIds.length > 1) {
      const evidenceBackedPlanningProductId = await this.evidenceBackedPlanningProductId(matchingCompanyProducts);
      if (evidenceBackedPlanningProductId) {
        return { planningProductId: evidenceBackedPlanningProductId, warning: undefined };
      }
      return {
        planningProductId: undefined,
        warning: {
          code: 'planning_product_mapping_ambiguous',
          message: `Ecobase supplier-order import found multiple planning product listings for ${params.company}/${
            params.asin ?? params.sku
          }.`,
          payload: { company: params.company, asin: params.asin, sku: params.sku, planningProductIds },
        } as SupplierOrderImportWarning,
      };
    }

    return {
      planningProductId: undefined,
      warning: {
        code: 'planning_product_mapping_missing',
        message: `Ecobase supplier-order import could not resolve planning product for ${params.company}/${
          params.asin ?? params.sku
        }.`,
        payload: { company: params.company, asin: params.asin, sku: params.sku },
      } as SupplierOrderImportWarning,
    };
  }

  private async findOrCreateSupplier(identity: SupplierIdentityRecord, _importRunId: string): Promise<PlainRecord> {
    const resolvedSupplierName = asString(identity.supplierName) ?? identity.externalSupplierCode;
    if (!resolvedSupplierName) return {};

    const normalizedSupplierName = normalizeName(resolvedSupplierName);
    const supplierRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers);
    let supplier = toPlainRecord(await supplierRepo.findOne({ filter: { normalizedName: normalizedSupplierName } }));
    if (!asString(supplier.id)) {
      supplier = toPlainRecord(
        await supplierRepo.create({
          values: {
            id: randomUUID(),
            normalizedName: normalizedSupplierName,
            displayName: resolvedSupplierName,
            approvalStatus: 'new',
            analysisStatus: 'imported',
          },
        }),
      );
    } else {
      await supplierRepo.update({
        filterByTk: asString(supplier.id),
        values: { displayName: asString(supplier.displayName) ?? resolvedSupplierName, analysisStatus: 'imported' },
      });
      supplier = toPlainRecord(await supplierRepo.findOne({ filterByTk: asString(supplier.id) }));
    }

    const company = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).findOne({ filter: { name: identity.company } }),
    );
    const supplierId = asString(supplier.id);
    const companyId = asString(company.id);
    if (supplierId && companyId) {
      const accountRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts);
      const existingAccount = toPlainRecord(await accountRepo.findOne({ filter: { supplierId, companyId } }));
      if (!asString(existingAccount.id)) {
        await accountRepo.create({
          values: {
            id: randomUUID(),
            supplierId,
            companyId,
            accountName: resolvedSupplierName,
            orderingMethod: 'unknown',
            status: 'active',
          },
        });
      }
    }

    return supplier;
  }

  private leadTimeNaturalKey(params: {
    company: string;
    supplierId: string;
    planningProductId?: string;
    asin?: string;
    sku?: string;
  }) {
    const scope = params.planningProductId
      ? `product:${params.planningProductId}`
      : params.asin || params.sku
        ? `product-key:${params.asin ?? ''}:${params.sku ?? ''}`
        : 'default';
    return `supplier-lead-time:${params.company}:${params.supplierId}:${scope}`;
  }

  private async upsertLeadTime(params: {
    supplierId: string;
    company: string;
    supplierName?: string;
    externalSupplierCode?: string;
    sourceConnectionId: string;
    source: string;
    leadTimeDays: number;
    confirmedAt: string;
    payload: PlainRecord;
    importRunId?: string;
    planningProductId?: string;
    asin?: string;
    sku?: string;
    notes?: string;
  }) {
    const leadTimeDays = validateSupplierLeadTimeDays(params.leadTimeDays, 'Ecobase supplier lead-time upsert failed');
    if (leadTimeDays === undefined) return;
    const resolved = params.planningProductId
      ? { planningProductId: params.planningProductId }
      : await this.resolvePlanningProduct({ company: params.company, asin: params.asin, sku: params.sku });
    if (!resolved.planningProductId) return;

    const companyProduct = await this.ensurePlanningProduct(
      resolved.planningProductId,
      params.company,
      'Ecobase supplier lead-time upsert failed',
    );
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts);
    const existing = toPlainRecord(
      await repo.findOne({ filter: { supplierId: params.supplierId, productId: asString(companyProduct.productId) } }),
    );
    const values = {
      supplierId: params.supplierId,
      productId: asString(companyProduct.productId),
      supplierSku: params.sku,
      leadTimeDays,
      analysisStatus: params.source,
    };
    if (asString(existing.id)) {
      await repo.update({ filterByTk: asString(existing.id), values });
      return;
    }
    await repo.create({ values: { id: randomUUID(), ...values } });
  }

  private async findLeadTime(params: {
    supplierId?: string;
    company?: string;
    externalSupplierCode?: string;
    planningProductId?: string;
  }) {
    if (!params.supplierId || !params.planningProductId) return undefined;
    const companyProduct = await this.ensurePlanningProduct(
      params.planningProductId,
      params.company,
      'Ecobase supplier lead-time lookup failed',
    );
    const supplierProduct = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).findOne({
        filter: { supplierId: params.supplierId, productId: asString(companyProduct.productId) },
      }),
    );
    return asNumber(supplierProduct.leadTimeDays);
  }

  private async editableManualComment(activityId: string, company: string, action: 'update' | 'delete') {
    if (!activityId) {
      throw new Error(`Ecobase supplier-order activity ${action} failed: activityId is required.`);
    }
    if (!company) {
      throw new Error(`Ecobase supplier-order activity ${action} failed: company is required.`);
    }
    const activity = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).findOne({ filterByTk: activityId }),
    );
    if (!asString(activity.id)) {
      throw new Error(`Ecobase supplier-order activity ${action} failed: activity "${activityId}" was not found.`);
    }
    const context = toPlainRecord(activity.contextSnapshotJson);
    if (asString(context.company) !== company) {
      throw new Error(`Ecobase supplier-order activity ${action} failed: activity belongs to a different company.`);
    }
    if (asString(activity.commentType) !== 'note') {
      throw new Error(`Ecobase supplier-order activity ${action} failed: only manual comments can be changed.`);
    }
    if (asString(activity.deletedAt)) {
      throw new Error(`Ecobase supplier-order activity ${action} failed: comment is already deleted.`);
    }
    return activity;
  }

  private async resolveContactRecency(params: { company: string; supplierId: string; supplierOrderId?: string }) {
    const comments = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).find({ limit: 10000 }))
      .map(toPlainRecord)
      .filter((comment) => asString(comment.commentType) === 'contacted_supplier');
    const occurredAt = (comment: PlainRecord) =>
      asString(toPlainRecord(comment.contextSnapshotJson).occurredAt) ?? asString(comment.createdAt) ?? '';

    const orderSpecific = params.supplierOrderId
      ? comments
          .filter(
            (comment) =>
              asString(comment.entityType) === 'supplier_order' &&
              asString(comment.entityId) === params.supplierOrderId,
          )
          .sort((left, right) => occurredAt(right).localeCompare(occurredAt(left)))[0]
      : undefined;
    if (orderSpecific) {
      return {
        occurredAt: occurredAt(orderSpecific),
        notes: asString(orderSpecific.body),
        source: 'order' as const,
        activityId: asString(orderSpecific.id) ?? '',
      };
    }

    const supplierLevel = comments
      .filter(
        (comment) => asString(comment.entityType) === 'supplier' && asString(comment.entityId) === params.supplierId,
      )
      .sort((left, right) => occurredAt(right).localeCompare(occurredAt(left)))[0];
    if (!supplierLevel) return null;
    return {
      occurredAt: occurredAt(supplierLevel),
      notes: asString(supplierLevel.body),
      source: 'supplier' as const,
      activityId: asString(supplierLevel.id) ?? '',
    };
  }

  private async findSupplierOrder(orderId: string | number) {
    if (!orderId) {
      return null;
    }
    const silverOrder = (await silverSupplierOrderReadModel(this.db, { limit: 10000 })).supplierOrders.find(
      (order) => asString(order.id) === String(orderId),
    );
    if (silverOrder) return silverOrder;
    return null;
  }
}
