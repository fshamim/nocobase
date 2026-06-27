import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import {
  ORDER_LIFECYCLE_STATUSES,
  canonicalOrderLifecycleStatus,
  requireOrderLifecycleStatus,
  resolveOrderLifecycle,
  type OrderLifecycleStatus,
} from './order-lifecycle';
import { isProfitTier, profitTierRank } from './profit-tier';

type PlainRecord = Record<string, unknown>;

type RiskSource = 'gold' | 'silver_estimate' | 'missing';

export interface OrderPlanningListFilters {
  companyId?: string;
  company?: string;
  supplierId?: string;
  status?: string;
  search?: string;
  minMoneyAtRisk?: number;
  minWaitingDays?: number;
  hideClosed?: boolean;
  limit?: number;
}

export interface OrderPlanningRow {
  id: string;
  companyId: string;
  companyName: string;
  supplierId: string;
  supplierName: string;
  orderRef: string;
  lifecyclePhase?: string;
  lifecycleStatus?: string;
  canonicalStatus?: OrderLifecycleStatus;
  currentStatus?: string;
  statusSource?: string;
  statusCheckRequired?: boolean;
  statusEvidence?: PlainRecord;
  tier?: string;
  tierRank?: number;
  nextAction?: string;
  nextActionDueAt?: string;
  expectedDeliveryDate?: string;
  trackingId?: string;
  asinCount: number;
  lineCount: number;
  moneyAtRisk: number;
  riskSource: RiskSource;
  earliestOosDate?: string;
  daysUntilOos?: number;
  daysSinceLastActivity?: number;
  latestComment?: string;
  remarks?: string;
  searchText?: string;
  latestGoldCalculationDate?: string;
  lastRefreshedAt?: string;
  supplierGroupMoneyAtRisk: number;
}

export interface OrderPlanningLine {
  id: string;
  orderId: string;
  companyProductId?: string;
  supplierProductId?: string;
  asin?: string;
  sku?: string;
  title?: string;
  brand?: string;
  orderedQty?: number;
  confirmedQty?: number;
  unitCost?: number;
  expectedSellPrice?: number;
  expectedMargin?: number;
  expectedProfit?: number;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  priority?: string;
}

export interface OrderPlanningInvoice {
  id: string;
  orderId: string;
  invoiceNumber?: string;
  invoiceType?: string;
  status?: string;
  fileUrl?: string;
  amount?: number;
  paymentMode?: string;
  paidAt?: string;
  remarks?: string;
}

export interface OrderPlanningDetail {
  order: OrderPlanningRow;
  lines: OrderPlanningLine[];
  invoices: OrderPlanningInvoice[];
  comments: PlainRecord[];
}

export interface OrderPlanningWorkspace {
  selectedCompanyId?: string;
  selectedCompanyName?: string;
  latestGoldCalculationDate?: string;
  rows: OrderPlanningRow[];
  digestRows: OrderPlanningRow[];
  filterOptions: OrderPlanningFilterOptions;
  dataWarnings: string[];
}

export interface OrderPlanningFilterOptions {
  companies: Array<{ id: string; name: string; label: string }>;
  suppliers: Array<{ id: string; name: string; label: string }>;
  statuses: string[];
}

export interface UpdateOrderPlanningOrderParams {
  orderId: string;
  values?: PlainRecord;
  commentBody?: string;
  actorUserId?: string;
}

export interface UpdateOrderPlanningLineParams {
  orderLineId: string;
  values?: PlainRecord;
  commentBody?: string;
  actorUserId?: string;
}

export interface AddOrderPlanningCommentParams {
  orderId: string;
  body?: string;
  actorUserId?: string;
}

export interface UpdateOrderPlanningInvoiceParams {
  invoiceId: string;
  status?: string;
  actorUserId?: string;
}

export interface DeleteOrderPlanningCommentParams {
  orderId: string;
  commentId: string;
  actorUserId?: string;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const CLOSED_STATUS_WORDS = new Set([
  'closed',
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'rejected',
  'cleared',
]);
const ORDER_EDITABLE_FIELDS = new Set([
  'lifecycleStatus',
  'canonicalStatus',
  'statusCheckRequired',
  'nextAction',
  'nextActionDueAt',
  'expectedDeliveryDate',
  'trackingId',
  'remarks',
]);
const LINE_EDITABLE_FIELDS = new Set([
  'orderedQty',
  'confirmedQty',
  'unitCost',
  'expectedSellPrice',
  'expectedMargin',
  'expectedProfit',
  'expectedDeliveryDate',
  'expectedSellableDate',
  'priority',
]);
const NUMBER_FIELDS = new Set([
  'orderedQty',
  'confirmedQty',
  'unitCost',
  'expectedSellPrice',
  'expectedMargin',
  'expectedProfit',
]);
const ORDER_ENTITY_TYPES = new Set(['order', ECOBASE_COLLECTIONS.silverOrders]);
const ORDER_LINE_ENTITY_TYPES = new Set(['order_line', 'orderLine', ECOBASE_COLLECTIONS.silverOrderLines]);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function positiveNumber(value: unknown): number {
  const numeric = numberValue(value) ?? 0;
  return numeric > 0 ? numeric : 0;
}

function dateOnly(value: unknown): string | undefined {
  const valueText = text(value);
  if (!valueText) return undefined;
  const date = new Date(valueText.includes('T') ? valueText : `${valueText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function dateTime(value: unknown): string | undefined {
  const valueText = text(value);
  if (!valueText) return undefined;
  const date = new Date(valueText);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function orderReferenceDate(value: unknown): string | undefined {
  const ref = text(value)?.toUpperCase();
  const groups = ref?.match(/\d{4,8}/g);
  if (!groups) return undefined;
  for (const digits of [...groups].reverse()) {
    const parsed = parseOrderReferenceDigits(digits);
    if (parsed) return parsed;
  }
  return undefined;
}

function parseOrderReferenceDigits(digits: string) {
  const candidates: Array<[number, number, number]> = [];
  if (digits.length === 8) {
    candidates.push([Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), Number(digits.slice(4))]);
    candidates.push([Number(digits.slice(4, 6)), Number(digits.slice(6)), Number(digits.slice(0, 4))]);
  }
  if (digits.length === 6) {
    candidates.push([Number(digits.slice(2, 4)), Number(digits.slice(4)), 2000 + Number(digits.slice(0, 2))]);
    candidates.push([Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), 2000 + Number(digits.slice(4))]);
  }
  if (digits.length === 5)
    candidates.push([Number(digits.slice(0, 1)), Number(digits.slice(1, 3)), 2000 + Number(digits.slice(3))]);
  if (digits.length === 4)
    candidates.push([Number(digits.slice(0, 1)), Number(digits.slice(1, 2)), 2000 + Number(digits.slice(2))]);
  for (const [month, day, year] of candidates) {
    const parsed = validDate(year, month, day);
    if (parsed) return parsed;
  }
  return undefined;
}

function validDate(year: number, month: number, day: number) {
  if (year < 2020 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return undefined;
  }
  return parsed.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function diffDays(left: string, right: string) {
  const leftTime = new Date(`${left}T00:00:00.000Z`).getTime();
  const rightTime = new Date(`${right}T00:00:00.000Z`).getTime();
  return Math.floor((leftTime - rightTime) / 86_400_000);
}

function maxDate(values: Array<string | undefined>) {
  return values.reduce<string | undefined>((latest, current) => {
    if (!current) return latest;
    return !latest || current > latest ? current : latest;
  }, undefined);
}

function minDate(values: Array<string | undefined>) {
  return values.reduce<string | undefined>((earliest, current) => {
    if (!current) return earliest;
    return !earliest || current < earliest ? current : earliest;
  }, undefined);
}

function currentStatus(order: PlainRecord) {
  return text(order.canonicalStatus) ?? text(order.lifecycleStatus) ?? text(order.lifecyclePhase) ?? 'unknown';
}

function recordValue(value: unknown): PlainRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PlainRecord) : {};
}

function statusEvidence(order: PlainRecord): PlainRecord {
  return recordValue(order.statusEvidenceJson);
}

function joinedText(values: unknown[]) {
  const joined = values
    .map((value) => text(value))
    .filter((value): value is string => Boolean(value))
    .join(' ');
  return joined || undefined;
}

function positiveGoldNumber(rows: PlainRecord[], field: string) {
  return rows.reduce((sum, row) => sum + positiveNumber(row[field]), 0);
}

function tierRank(value: unknown) {
  return profitTierRank(value);
}

function bestTier(rows: PlainRecord[]) {
  return rows
    .map((row) => text(row.tier) ?? text(row.profitTier))
    .filter(isProfitTier)
    .sort((left, right) => tierRank(left) - tierRank(right))[0];
}

function productKey(companyId: string, line: OrderPlanningLine) {
  const asin = text(line.asin)?.toUpperCase();
  if (asin) return `${companyId}::ASIN::${asin}`;
  const sku = text(line.sku)?.toUpperCase();
  return sku ? `${companyId}::SKU::${sku}` : undefined;
}

function orderSequenceValue(order: PlainRecord) {
  return [
    minDate([dateOnly(order.orderDate), orderReferenceDate(order.orderRef)]) ?? '',
    dateTime(order.createdAt) ?? '',
    text(order.orderRef) ?? '',
    text(order.id) ?? '',
  ].join('|');
}

function isClosedStatus(order: { currentStatus?: string; lifecycleStatus?: unknown; lifecyclePhase?: unknown }) {
  const status = order.currentStatus ?? text(order.lifecycleStatus) ?? text(order.lifecyclePhase) ?? 'unknown';
  const normalized = status.toLowerCase().replace(/[\s-]+/g, '_');
  return normalized.split('_').some((part) => CLOSED_STATUS_WORDS.has(part)) || CLOSED_STATUS_WORDS.has(normalized);
}

function compactLimit(limit: number | undefined) {
  return Math.min(Math.max(Math.floor(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

function sortByName(left: { label: string }, right: { label: string }) {
  return left.label.localeCompare(right.label);
}

function rowMatchesSearch(row: OrderPlanningRow, lines: OrderPlanningLine[], search: string) {
  const haystack = [
    row.orderRef,
    row.supplierName,
    row.currentStatus,
    row.nextAction,
    row.trackingId,
    row.latestComment,
    row.remarks,
    row.searchText,
    ...lines.flatMap((line) => [line.asin, line.sku, line.title, line.brand]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

function compareOos(left?: string, right?: string) {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function goldOrderKey(companyName?: string, orderRef?: string) {
  return `${companyName ?? ''}::${orderRef ?? ''}`.toLowerCase();
}

function goldOrderPlanningRowFromRecord(record: PlainRecord): OrderPlanningRow {
  const canonicalStatus = canonicalOrderLifecycleStatus(record.canonicalStatus ?? record.currentStatus);
  const tier = text(record.tier);
  const tiered = isProfitTier(tier);
  return {
    id: text(record.orderId) ?? text(record.id) ?? '',
    companyId: text(record.companyId) ?? '',
    companyName: text(record.companyName) ?? '',
    supplierId: text(record.supplierId) ?? '',
    supplierName: text(record.supplierName) ?? 'Unknown supplier',
    orderRef: text(record.orderRef) ?? '',
    lifecyclePhase: text(record.lifecyclePhase),
    lifecycleStatus: canonicalStatus ?? text(record.lifecycleStatus),
    canonicalStatus,
    currentStatus: canonicalStatus ?? text(record.currentStatus),
    statusSource: text(record.statusSource),
    statusCheckRequired: record.statusCheckRequired === true,
    statusEvidence: recordValue(record.statusEvidenceJson),
    tier,
    tierRank: tiered ? tierRank(tier) : numberValue(record.tierRank),
    nextAction: text(record.nextAction),
    nextActionDueAt: text(record.nextActionDueAt),
    expectedDeliveryDate: dateOnly(record.expectedDeliveryDate),
    trackingId: text(record.trackingId),
    asinCount: positiveNumber(record.asinCount),
    lineCount: positiveNumber(record.lineCount),
    moneyAtRisk: tiered ? positiveNumber(record.moneyAtRisk) : 0,
    riskSource: tiered ? riskSourceFrom(record.riskSource) : 'missing',
    earliestOosDate: dateOnly(record.earliestOosDate),
    daysUntilOos: numberValue(record.daysUntilOos),
    daysSinceLastActivity: numberValue(record.daysSinceLastActivity),
    latestComment: text(record.latestComment),
    remarks: text(record.remarks),
    searchText: text(record.searchText),
    latestGoldCalculationDate: dateOnly(record.latestGoldCalculationDate),
    lastRefreshedAt: dateTime(record.lastRefreshedAt),
    supplierGroupMoneyAtRisk: 0,
  };
}

function invoiceFromRecord(record: PlainRecord): OrderPlanningInvoice {
  return {
    id: text(record.id) ?? '',
    orderId: text(record.orderId) ?? '',
    invoiceNumber: text(record.invoiceNumber),
    invoiceType: text(record.invoiceType),
    status: text(record.status),
    fileUrl: text(record.fileUrl),
    amount: numberValue(record.amount),
    paymentMode: text(record.paymentMode),
    paidAt: dateTime(record.paidAt) ?? dateOnly(record.paidAt),
    remarks: text(record.remarks),
  };
}

function goldOrderPlanningRowValues(
  row: OrderPlanningRow,
  latestGoldCalculationDate: string | undefined,
  lastRefreshedAt: string,
) {
  return cleanValues({
    orderId: row.id,
    orderRef: row.orderRef,
    companyId: row.companyId,
    companyName: row.companyName,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    lifecyclePhase: row.lifecyclePhase,
    lifecycleStatus: row.lifecycleStatus,
    canonicalStatus: row.canonicalStatus,
    currentStatus: row.currentStatus,
    statusSource: row.statusSource,
    statusCheckRequired: row.statusCheckRequired,
    statusEvidenceJson: row.statusEvidence ?? {},
    tier: row.tier,
    tierRank: row.tierRank,
    nextAction: row.nextAction,
    nextActionDueAt: row.nextActionDueAt,
    expectedDeliveryDate: row.expectedDeliveryDate,
    trackingId: row.trackingId,
    asinCount: row.asinCount,
    lineCount: row.lineCount,
    moneyAtRisk: row.moneyAtRisk,
    riskSource: row.riskSource,
    earliestOosDate: row.earliestOosDate,
    daysUntilOos: row.daysUntilOos,
    daysSinceLastActivity: row.daysSinceLastActivity,
    latestComment: row.latestComment ?? null,
    remarks: row.remarks ?? null,
    searchText: row.searchText,
    latestGoldCalculationDate,
    lastRefreshedAt,
  });
}

function riskSourceFrom(value: unknown): RiskSource {
  return value === 'gold' || value === 'silver_estimate' ? value : 'missing';
}

function cleanValues(values: PlainRecord) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function cleanEditableValues(values: PlainRecord, allowed: Set<string>) {
  const rejected = Object.keys(values).filter((field) => !allowed.has(field));
  if (rejected.length) {
    throw new Error(`Ecobase Order Planning update failed: unsupported fields rejected: ${rejected.join(', ')}.`);
  }
  const cleaned: PlainRecord = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (key === 'lifecycleStatus' || key === 'canonicalStatus') {
      const status =
        value === null || value === ''
          ? null
          : requireOrderLifecycleStatus(value, 'Ecobase Order Planning update failed');
      cleaned.lifecycleStatus = status;
      cleaned.canonicalStatus = status;
      continue;
    }
    if (NUMBER_FIELDS.has(key)) {
      cleaned[key] = value === null || value === '' ? null : numberValue(value);
      if (cleaned[key] === undefined) {
        throw new Error(`Ecobase Order Planning update failed: ${key} must be a number.`);
      }
      continue;
    }
    cleaned[key] = value === '' ? null : value;
  }
  return cleaned;
}

export class EcobaseOrderPlanningService {
  constructor(private db: EcobaseDatabase) {}

  async getFilters(companyId?: string): Promise<OrderPlanningFilterOptions> {
    const workspace = await this.listOrders({ companyId, hideClosed: false, limit: DEFAULT_LIMIT });
    return workspace.filterOptions;
  }

  async listOrders(filters: OrderPlanningListFilters = {}): Promise<OrderPlanningWorkspace> {
    const limit = compactLimit(filters.limit);
    const companies = await this.loadCompanies();
    const selectedCompany = this.resolveCompany(companies, filters);
    const selectedCompanies = selectedCompany ? [selectedCompany] : companies;
    if (!selectedCompanies.length) {
      return this.emptyWorkspace(['silver_companies_missing']);
    }

    const materializedRows = await this.loadGoldOrderPlanningRows(selectedCompanies);
    if (materializedRows.length) {
      return this.workspaceFromRows({
        companies,
        selectedCompany,
        rows: materializedRows,
        filters,
        limit,
        warnings: [],
      });
    }

    const refreshed = await this.refreshReadModel({ ...filters, hideClosed: false, limit: MAX_LIMIT });
    return this.workspaceFromRows({
      companies,
      selectedCompany,
      rows: refreshed.rows,
      filters,
      limit,
      warnings: ['gold_order_planning_rows_missing_backfilled'],
    });
  }

  async refreshReadModel(filters: OrderPlanningListFilters = {}): Promise<OrderPlanningWorkspace> {
    const derived = await this.deriveOrderRows({ ...filters, hideClosed: false, limit: MAX_LIMIT });
    const lastRefreshedAt = new Date().toISOString();
    for (const row of derived.rows) {
      await this.upsertGoldOrderPlanningRow(row, derived.latestGoldCalculationDate, lastRefreshedAt);
    }
    const refreshedRows = derived.rows.map((row) => ({
      ...row,
      latestGoldCalculationDate: derived.latestGoldCalculationDate,
      lastRefreshedAt,
    }));
    return { ...derived, rows: refreshedRows, digestRows: refreshedRows };
  }

  private async deriveOrderRows(filters: OrderPlanningListFilters = {}): Promise<OrderPlanningWorkspace> {
    const companies = await this.loadCompanies();
    const selectedCompany = this.resolveCompany(companies, filters);
    const selectedCompanies = selectedCompany ? [selectedCompany] : companies;
    if (!selectedCompanies.length) {
      return this.emptyWorkspace(['silver_companies_missing']);
    }

    const companyById = new Map(companies.map((company) => [text(company.id) ?? '', company]));
    const companyIds = selectedCompanies.map((company) => text(company.id)).filter((id): id is string => Boolean(id));
    const orders = (
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).find({
        filter: companyIds.length === 1 ? { companyId: companyIds[0] } : { companyId: { $in: companyIds } },
        limit: 5000,
      })
    ).map(toPlainRecord);
    const orderIds = orders.map((order) => text(order.id)).filter((id): id is string => Boolean(id));
    const lines = orderIds.length
      ? (
          await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).find({
            filter: { orderId: { $in: orderIds } },
            limit: 20000,
          })
        ).map(toPlainRecord)
      : [];
    const companyProducts = await this.loadByIds(
      ECOBASE_COLLECTIONS.silverCompanyProducts,
      lines.map((line) => text(line.companyProductId)),
    );
    const products = await this.loadByIds(
      ECOBASE_COLLECTIONS.silverProducts,
      [...companyProducts.values()].map((companyProduct) => text(companyProduct.productId)),
    );
    const suppliers = await this.loadByIds(
      ECOBASE_COLLECTIONS.silverSuppliers,
      orders.map((order) => text(order.supplierId)),
    );
    const comments = await this.loadComments(
      orderIds,
      lines.map((line) => text(line.id)).filter((id): id is string => Boolean(id)),
    );
    const invoices = orderIds.length
      ? (
          await this.repo(ECOBASE_COLLECTIONS.silverInvoices).find({
            filter: { orderId: { $in: orderIds } },
            limit: 20000,
          })
        ).map(toPlainRecord)
      : [];
    const invoicesByOrderId = new Map<string, PlainRecord[]>();
    for (const invoice of invoices) {
      const orderId = text(invoice.orderId);
      if (!orderId) continue;
      invoicesByOrderId.set(orderId, [...(invoicesByOrderId.get(orderId) ?? []), invoice]);
    }
    const goldRows = await this.loadLatestGoldRows(
      selectedCompanies
        .flatMap((company) => [text(company.name), text(company.companyKey), text(company.id)])
        .filter((companyName): companyName is string => Boolean(companyName)),
    );
    const rowsByOrderRef = this.groupGoldByOrderRef(goldRows.rows);
    const linesByOrderId = new Map<string, PlainRecord[]>();
    for (const line of lines) {
      const orderId = text(line.orderId);
      if (!orderId) continue;
      linesByOrderId.set(orderId, [...(linesByOrderId.get(orderId) ?? []), line]);
    }

    const detailLinesByOrderId = new Map<string, OrderPlanningLine[]>();
    const productKeysByOrderId = new Map<string, Set<string>>();
    for (const order of orders) {
      const id = text(order.id) ?? '';
      const companyId = text(order.companyId) ?? '';
      const orderLines = linesByOrderId.get(id) ?? [];
      const detailLines = orderLines.map((line) => this.decorateLine(line, companyProducts, products));
      detailLinesByOrderId.set(id, detailLines);
      productKeysByOrderId.set(
        id,
        new Set(detailLines.map((line) => productKey(companyId, line)).filter((key): key is string => Boolean(key))),
      );
    }
    const hasLaterSameProductByOrderId = this.findOrdersWithLaterProductOrder(orders, productKeysByOrderId);
    const rows = orders.map((order) => {
      const id = text(order.id) ?? '';
      const companyId = text(order.companyId) ?? '';
      const companyName =
        text(companyById.get(companyId)?.name) ?? text(companyById.get(companyId)?.companyKey) ?? companyId;
      const orderLines = linesByOrderId.get(id) ?? [];
      return this.decorateOrder({
        order,
        companyId,
        companyName,
        supplier: suppliers.get(text(order.supplierId) ?? ''),
        lines: orderLines,
        detailLines: detailLinesByOrderId.get(id) ?? [],
        comments: comments.filter((comment) => this.commentBelongsToOrder(comment, id, orderLines)),
        invoices: invoicesByOrderId.get(id) ?? [],
        goldRows: rowsByOrderRef.get(goldOrderKey(companyName, text(order.orderRef))) ?? [],
        hasLaterSameProductOrder: hasLaterSameProductByOrderId.has(id),
      });
    });

    return {
      selectedCompanyId: selectedCompany ? text(selectedCompany.id) : undefined,
      selectedCompanyName: selectedCompany
        ? text(selectedCompany.name) ?? text(selectedCompany.companyKey) ?? text(selectedCompany.id)
        : undefined,
      latestGoldCalculationDate: goldRows.latestCalculationDate,
      rows,
      digestRows: rows,
      filterOptions: this.filterOptions(companies, suppliers, rows),
      dataWarnings: [],
    };
  }

  private workspaceFromRows(params: {
    companies: PlainRecord[];
    selectedCompany?: PlainRecord;
    rows: OrderPlanningRow[];
    filters: OrderPlanningListFilters;
    limit: number;
    warnings: string[];
  }): OrderPlanningWorkspace {
    const search = text(params.filters.search)?.toLowerCase();
    let visibleRows = params.rows.filter((row) => {
      if (params.filters.hideClosed === true && isClosedStatus(row)) return false;
      if (params.filters.supplierId && row.supplierId !== params.filters.supplierId) return false;
      if (params.filters.status && row.currentStatus?.toLowerCase() !== params.filters.status.toLowerCase()) {
        return false;
      }
      if (typeof params.filters.minMoneyAtRisk === 'number' && row.moneyAtRisk < params.filters.minMoneyAtRisk) {
        return false;
      }
      if (
        typeof params.filters.minWaitingDays === 'number' &&
        (row.daysSinceLastActivity ?? 0) < params.filters.minWaitingDays
      ) {
        return false;
      }
      if (search && !rowMatchesSearch(row, [], search)) return false;
      return true;
    });

    const supplierRisk = new Map<string, number>();
    for (const row of visibleRows) {
      supplierRisk.set(row.supplierId, (supplierRisk.get(row.supplierId) ?? 0) + row.moneyAtRisk);
    }
    visibleRows = visibleRows
      .map((row) => ({ ...row, supplierGroupMoneyAtRisk: supplierRisk.get(row.supplierId) ?? 0 }))
      .sort((left, right) => this.compareOrderPriority(left, right))
      .slice(0, params.limit);

    return {
      selectedCompanyId: params.selectedCompany ? text(params.selectedCompany.id) : undefined,
      selectedCompanyName: params.selectedCompany
        ? text(params.selectedCompany.name) ??
          text(params.selectedCompany.companyKey) ??
          text(params.selectedCompany.id)
        : undefined,
      latestGoldCalculationDate: maxDate(params.rows.map((row) => dateOnly(row.latestGoldCalculationDate))),
      rows: visibleRows,
      digestRows: visibleRows,
      filterOptions: this.filterOptions(params.companies, new Map(), params.rows),
      dataWarnings: params.warnings,
    };
  }

  private emptyWorkspace(warnings: string[]): OrderPlanningWorkspace {
    return {
      rows: [],
      digestRows: [],
      filterOptions: { companies: [], suppliers: [], statuses: [] },
      dataWarnings: warnings,
    };
  }

  async getOrderDetail(orderId: string): Promise<OrderPlanningDetail> {
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, orderId, 'order');
    const workspace = await this.listOrders({ companyId: text(order.companyId), hideClosed: false, limit: MAX_LIMIT });
    const row = workspace.rows.find((candidate) => candidate.id === orderId);
    if (!row) {
      throw new Error(`Ecobase Order Planning detail failed: order ${orderId} was not found in its company workspace.`);
    }
    const lines = (
      await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).find({ filter: { orderId }, limit: 5000 })
    ).map(toPlainRecord);
    const companyProducts = await this.loadByIds(
      ECOBASE_COLLECTIONS.silverCompanyProducts,
      lines.map((line) => text(line.companyProductId)),
    );
    const products = await this.loadByIds(
      ECOBASE_COLLECTIONS.silverProducts,
      [...companyProducts.values()].map((companyProduct) => text(companyProduct.productId)),
    );
    const comments = await this.loadComments(
      [orderId],
      lines.map((line) => text(line.id)).filter((id): id is string => Boolean(id)),
    );
    const invoices = (
      await this.repo(ECOBASE_COLLECTIONS.silverInvoices).find({ filter: { orderId }, limit: 5000 })
    ).map(toPlainRecord);
    return {
      order: row,
      lines: lines.map((line) => this.decorateLine(line, companyProducts, products)),
      invoices: invoices.map(invoiceFromRecord),
      comments: comments.sort((left, right) =>
        (dateTime(right.createdAt) ?? '').localeCompare(dateTime(left.createdAt) ?? ''),
      ),
    };
  }

  async updateOrder(params: UpdateOrderPlanningOrderParams): Promise<OrderPlanningDetail> {
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, params.orderId, 'order');
    const values = cleanEditableValues(params.values ?? {}, ORDER_EDITABLE_FIELDS);
    const previousStatus = currentStatus(order);
    const nextStatus = text(values.canonicalStatus) ?? text(values.lifecycleStatus);
    const statusChanged = Boolean(nextStatus && nextStatus !== previousStatus);
    if (statusChanged) {
      values.statusSource = 'operator';
      values.statusCheckRequired = false;
      values.operatorStatusOverrideAt = new Date().toISOString();
      if (params.actorUserId) values.operatorStatusOverrideByUserId = params.actorUserId;
    }
    if (Object.keys(values).length) {
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: params.orderId, values });
    }
    const commentBody =
      params.commentBody ?? (statusChanged ? `Status changed from ${previousStatus} to ${nextStatus}.` : undefined);
    if (commentBody) {
      await this.createComment({
        entityType: 'order',
        entityId: params.orderId,
        body: commentBody,
        actorUserId: params.actorUserId,
        snapshot: { previousOrderRef: text(order.orderRef), previousStatus, nextStatus },
      });
    }
    if (!Object.keys(values).length && !commentBody) {
      throw new Error('Ecobase Order Planning update failed: no order fields or comment were provided.');
    }
    await this.refreshReadModel({ companyId: text(order.companyId), limit: MAX_LIMIT });
    return this.getOrderDetail(params.orderId);
  }

  async updateLine(params: UpdateOrderPlanningLineParams): Promise<OrderPlanningDetail> {
    const line = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrderLines, params.orderLineId, 'order line');
    const orderId = text(line.orderId);
    if (!orderId) throw new Error('Ecobase Order Planning line update failed: orderId is missing on the line.');
    const values = cleanEditableValues(params.values ?? {}, LINE_EDITABLE_FIELDS);
    if (Object.keys(values).length) {
      await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).update({ filterByTk: params.orderLineId, values });
    }
    if (params.commentBody) {
      await this.createComment({
        entityType: 'order_line',
        entityId: params.orderLineId,
        body: params.commentBody,
        actorUserId: params.actorUserId,
        snapshot: { orderId },
      });
    }
    if (!Object.keys(values).length && !params.commentBody) {
      throw new Error('Ecobase Order Planning line update failed: no line fields or comment were provided.');
    }
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, orderId, 'order');
    await this.refreshReadModel({ companyId: text(order.companyId), limit: MAX_LIMIT });
    return this.getOrderDetail(orderId);
  }

  async addComment(params: AddOrderPlanningCommentParams): Promise<OrderPlanningDetail> {
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, params.orderId, 'order');
    await this.createComment({
      entityType: 'order',
      entityId: params.orderId,
      body: params.body,
      actorUserId: params.actorUserId,
    });
    await this.refreshReadModel({ companyId: text(order.companyId), limit: MAX_LIMIT });
    return this.getOrderDetail(params.orderId);
  }

  async updateInvoice(params: UpdateOrderPlanningInvoiceParams): Promise<OrderPlanningDetail> {
    const invoice = await this.requireRecord(ECOBASE_COLLECTIONS.silverInvoices, params.invoiceId, 'invoice');
    const orderId = text(invoice.orderId);
    if (!orderId) throw new Error('Ecobase Order Planning invoice update failed: orderId is missing on the invoice.');
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, orderId, 'order');
    const nextStatus = text(params.status);
    if (!nextStatus) throw new Error('Ecobase Order Planning invoice update failed: status is required.');
    const previousStatus = text(invoice.status) ?? 'unknown';
    if (previousStatus !== nextStatus) {
      await this.repo(ECOBASE_COLLECTIONS.silverInvoices).update({
        filterByTk: params.invoiceId,
        values: { status: nextStatus },
      });
      await this.createComment({
        entityType: 'order',
        entityId: orderId,
        body: `Invoice ${
          text(invoice.invoiceNumber) ?? params.invoiceId
        } status changed from ${previousStatus} to ${nextStatus}.`,
        actorUserId: params.actorUserId,
        snapshot: { invoiceId: params.invoiceId, previousStatus, nextStatus },
      });
      await this.refreshReadModel({ companyId: text(order.companyId), limit: MAX_LIMIT });
    }
    return this.getOrderDetail(orderId);
  }

  async deleteComment(params: DeleteOrderPlanningCommentParams): Promise<OrderPlanningDetail> {
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, params.orderId, 'order');
    const comment = await this.requireRecord(ECOBASE_COLLECTIONS.silverActivityComments, params.commentId, 'comment');
    const lines = (
      await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).find({ filter: { orderId: params.orderId }, limit: 5000 })
    ).map(toPlainRecord);
    if (!this.commentBelongsToOrder(comment, params.orderId, lines)) {
      throw new Error('Ecobase Order Planning comment delete failed: comment does not belong to the order.');
    }
    await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).update({
      filterByTk: params.commentId,
      values: {
        deletedAt: new Date().toISOString(),
        deletedByUserId: params.actorUserId,
        workflowDetectionStatus: 'deleted',
      },
    });
    await this.refreshReadModel({ companyId: text(order.companyId), limit: MAX_LIMIT });
    return this.getOrderDetail(params.orderId);
  }

  private decorateOrder(params: {
    order: PlainRecord;
    companyId: string;
    companyName: string;
    supplier?: PlainRecord;
    lines: PlainRecord[];
    detailLines: OrderPlanningLine[];
    comments: PlainRecord[];
    invoices: PlainRecord[];
    goldRows: PlainRecord[];
    hasLaterSameProductOrder: boolean;
  }): OrderPlanningRow {
    const orderRef = text(params.order.orderRef) ?? text(params.order.id) ?? '';
    const orderDate = minDate([dateOnly(params.order.orderDate), orderReferenceDate(orderRef)]);
    const asinCount = new Set(params.detailLines.map((line) => line.asin).filter(Boolean)).size;
    const goldRisk = params.goldRows.reduce((sum, row) => sum + positiveNumber(row.estimatedProfitRisk), 0);
    const silverRisk = params.lines.reduce((sum, line) => sum + positiveNumber(line.expectedProfit), 0);
    const earliestOosDate = minDate(params.goldRows.map((row) => dateOnly(row.estimatedOosDate)));
    const lastActivityAt = maxDate([
      ...params.comments.map((comment) => dateOnly(comment.createdAt) ?? dateOnly(comment.updatedAt)),
      dateOnly(params.order.updatedAt),
      dateOnly(params.order.createdAt),
      orderDate,
    ]);
    const latestComment = this.latestComment(params.comments) ?? text(params.order.remarks);
    const evidence = statusEvidence(params.order);
    const invoiceStatus = joinedText([evidence.invoiceStatus, ...params.invoices.map((invoice) => invoice.status)]);
    const lifecycle = resolveOrderLifecycle({
      canonicalStatus: text(params.order.canonicalStatus),
      lifecycleStatus: text(params.order.lifecycleStatus),
      lifecyclePhase: text(params.order.lifecyclePhase),
      statusSource: text(params.order.statusSource),
      operatorStatusOverrideAt: text(params.order.operatorStatusOverrideAt),
      existingStatusCheckRequired: params.order.statusCheckRequired === true,
      sourceOrderStatus: text(evidence.sourceOrderStatus) ?? text(params.order.lifecycleStatus),
      paymentStatus: text(evidence.paymentStatus),
      invoiceStatus,
      orderDate,
      poApproval: text(evidence.poApproval),
      prepStatus: text(evidence.prepStatus),
      orStatus: text(evidence.orStatus),
      remarks: text(evidence.remarks) ?? text(params.order.remarks),
      dateOfPayment: text(evidence.dateOfPayment) ?? joinedText(params.invoices.map((invoice) => invoice.paidAt)),
      trackingId: text(evidence.trackingId) ?? text(params.order.trackingId),
      shippingCarrier: text(evidence.shippingCarrier),
      hasLaterSameProductOrder: params.hasLaterSameProductOrder,
      inboundStock: positiveGoldNumber(params.goldRows, 'inboundStock'),
      reservedStock: positiveGoldNumber(params.goldRows, 'reservedStock'),
      sellableStock: positiveGoldNumber(params.goldRows, 'sellableStock'),
      receivedQty: params.lines.reduce((sum, line) => sum + positiveNumber(line.receivedQty), 0),
    });
    const tier = bestTier(params.goldRows);
    const tiered = isProfitTier(tier);
    const riskSource: RiskSource = tiered
      ? params.goldRows.length
        ? 'gold'
        : silverRisk > 0
          ? 'silver_estimate'
          : 'missing'
      : 'missing';
    const moneyAtRisk =
      lifecycle.canonicalStatus === 'COMPLETE' || !tiered ? 0 : params.goldRows.length ? goldRisk : silverRisk;
    const searchText = [
      params.companyName,
      text(params.supplier?.displayName) ?? text(params.supplier?.normalizedName),
      orderRef,
      lifecycle.canonicalStatus,
      latestComment,
      text(params.order.remarks),
      ...params.detailLines.flatMap((line) => [line.asin, line.sku, line.title, line.brand]),
    ]
      .filter(Boolean)
      .join(' ');
    return {
      id: text(params.order.id) ?? '',
      companyId: params.companyId,
      companyName: params.companyName,
      supplierId: text(params.order.supplierId) ?? '',
      supplierName: text(params.supplier?.displayName) ?? text(params.supplier?.normalizedName) ?? 'Unknown supplier',
      orderRef,
      lifecyclePhase: text(params.order.lifecyclePhase),
      lifecycleStatus: lifecycle.canonicalStatus,
      canonicalStatus: lifecycle.canonicalStatus,
      currentStatus: lifecycle.canonicalStatus,
      statusSource: lifecycle.statusSource,
      statusCheckRequired: lifecycle.statusCheckRequired,
      statusEvidence: lifecycle.statusEvidence,
      tier,
      tierRank: tierRank(tier),
      nextAction: text(params.order.nextAction),
      nextActionDueAt: text(params.order.nextActionDueAt),
      expectedDeliveryDate: dateOnly(params.order.expectedDeliveryDate),
      trackingId: text(params.order.trackingId),
      asinCount,
      lineCount: params.lines.length,
      moneyAtRisk,
      riskSource,
      earliestOosDate,
      daysUntilOos: earliestOosDate ? diffDays(earliestOosDate, today()) : undefined,
      daysSinceLastActivity: lastActivityAt ? Math.max(0, diffDays(today(), lastActivityAt)) : undefined,
      latestComment,
      remarks: text(params.order.remarks),
      searchText,
      supplierGroupMoneyAtRisk: 0,
    };
  }

  private decorateLine(
    line: PlainRecord,
    companyProducts: Map<string, PlainRecord>,
    products: Map<string, PlainRecord>,
  ): OrderPlanningLine {
    const companyProduct = companyProducts.get(text(line.companyProductId) ?? '');
    const product = products.get(text(companyProduct?.productId) ?? '');
    return {
      id: text(line.id) ?? '',
      orderId: text(line.orderId) ?? '',
      companyProductId: text(line.companyProductId),
      supplierProductId: text(line.supplierProductId),
      asin: text(product?.asin),
      sku: text(product?.sku),
      title: text(product?.title),
      brand: text(product?.brand),
      orderedQty: numberValue(line.orderedQty),
      confirmedQty: numberValue(line.confirmedQty),
      unitCost: numberValue(line.unitCost),
      expectedSellPrice: numberValue(line.expectedSellPrice),
      expectedMargin: numberValue(line.expectedMargin),
      expectedProfit: numberValue(line.expectedProfit),
      expectedDeliveryDate: dateOnly(line.expectedDeliveryDate),
      expectedSellableDate: dateOnly(line.expectedSellableDate),
      priority: text(line.priority),
    };
  }

  private findOrdersWithLaterProductOrder(orders: PlainRecord[], productKeysByOrderId: Map<string, Set<string>>) {
    const laterOrderIds = new Set<string>();
    for (const order of orders) {
      const orderId = text(order.id) ?? '';
      const keys = productKeysByOrderId.get(orderId) ?? new Set<string>();
      if (!orderId || !keys.size) continue;
      const sequence = orderSequenceValue(order);
      const hasLater = orders.some((candidate) => {
        const candidateId = text(candidate.id) ?? '';
        if (!candidateId || candidateId === orderId || orderSequenceValue(candidate) <= sequence) return false;
        const candidateKeys = productKeysByOrderId.get(candidateId) ?? new Set<string>();
        return [...keys].some((key) => candidateKeys.has(key));
      });
      if (hasLater) laterOrderIds.add(orderId);
    }
    return laterOrderIds;
  }

  private compareOrderPriority(left: OrderPlanningRow, right: OrderPlanningRow) {
    const tierDiff = (left.tierRank ?? 999) - (right.tierRank ?? 999);
    if (tierDiff !== 0) return tierDiff;
    const riskDiff = right.moneyAtRisk - left.moneyAtRisk;
    if (riskDiff !== 0) return riskDiff;
    const oosDiff = (left.daysUntilOos ?? Number.MAX_SAFE_INTEGER) - (right.daysUntilOos ?? Number.MAX_SAFE_INTEGER);
    if (oosDiff !== 0) return oosDiff;
    const waitingDiff = (right.daysSinceLastActivity ?? 0) - (left.daysSinceLastActivity ?? 0);
    if (waitingDiff !== 0) return waitingDiff;
    return left.supplierName.localeCompare(right.supplierName);
  }

  private filterOptions(
    companies: PlainRecord[],
    suppliers: Map<string, PlainRecord>,
    rows: OrderPlanningRow[],
  ): OrderPlanningFilterOptions {
    const supplierOptions = [...new Set(rows.map((row) => row.supplierId).filter(Boolean))]
      .map((id) => {
        const supplier = suppliers.get(id);
        const row = rows.find((candidate) => candidate.supplierId === id);
        const name = text(supplier?.displayName) ?? text(supplier?.normalizedName) ?? row?.supplierName ?? id;
        return { id, name, label: name };
      })
      .sort(sortByName);
    return {
      companies: companies
        .map((company) => {
          const id = text(company.id) ?? '';
          const name = text(company.name) ?? text(company.companyKey) ?? id;
          return { id, name, label: name };
        })
        .filter((company) => company.id)
        .sort(sortByName),
      suppliers: supplierOptions,
      statuses: [...ORDER_LIFECYCLE_STATUSES],
    };
  }

  private async loadCompanies() {
    return (await this.repo(ECOBASE_COLLECTIONS.silverCompanies).find({ sort: ['name'], limit: 500 })).map(
      toPlainRecord,
    );
  }

  private resolveCompany(companies: PlainRecord[], filters: OrderPlanningListFilters) {
    const requested = text(filters.companyId) ?? text(filters.company);
    if (!requested) return undefined;
    return (
      companies.find(
        (company) =>
          text(company.id) === requested || text(company.name) === requested || text(company.companyKey) === requested,
      ) ?? companies[0]
    );
  }

  private async loadByIds(collection: string, ids: Array<string | undefined>) {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!uniqueIds.length) return new Map<string, PlainRecord>();
    const rows = (
      await this.repo(collection).find({ filter: { id: { $in: uniqueIds } }, limit: Math.max(uniqueIds.length, 500) })
    ).map(toPlainRecord);
    return new Map(rows.map((row) => [text(row.id) ?? '', row]).filter(([id]) => Boolean(id)));
  }

  private async loadComments(orderIds: string[], lineIds: string[]) {
    const wanted = new Set([...orderIds, ...lineIds]);
    if (!wanted.size) return [];
    return (await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).find({ limit: 5000 }))
      .map(toPlainRecord)
      .filter((comment) => !comment.deletedAt && wanted.has(text(comment.entityId) ?? ''));
  }

  private commentBelongsToOrder(comment: PlainRecord, orderId: string, lines: PlainRecord[]) {
    const entityType = text(comment.entityType);
    const entityId = text(comment.entityId);
    if (!entityType || !entityId) return false;
    if (ORDER_ENTITY_TYPES.has(entityType)) return entityId === orderId;
    if (ORDER_LINE_ENTITY_TYPES.has(entityType)) return lines.some((line) => text(line.id) === entityId);
    return false;
  }

  private async loadGoldOrderPlanningRows(companies: PlainRecord[]) {
    const companyIds = companies.map((company) => text(company.id)).filter((id): id is string => Boolean(id));
    const rows = (
      await this.repo(ECOBASE_COLLECTIONS.goldOrderPlanningRows).find({
        filter: companyIds.length === 1 ? { companyId: companyIds[0] } : { companyId: { $in: companyIds } },
        limit: 5000,
      })
    ).map(toPlainRecord);
    return rows.map(goldOrderPlanningRowFromRecord);
  }

  private async upsertGoldOrderPlanningRow(
    row: OrderPlanningRow,
    latestGoldCalculationDate: string | undefined,
    lastRefreshedAt: string,
  ) {
    const values = goldOrderPlanningRowValues(row, latestGoldCalculationDate, lastRefreshedAt);
    const existing = await this.repo(ECOBASE_COLLECTIONS.goldOrderPlanningRows).findOne({ filterByTk: row.id });
    if (existing) {
      await this.repo(ECOBASE_COLLECTIONS.goldOrderPlanningRows).update({ filterByTk: row.id, values });
      return;
    }
    await this.repo(ECOBASE_COLLECTIONS.goldOrderPlanningRows).create({ values: { id: row.id, ...values } });
  }

  private async loadLatestGoldRows(companyNames: string[]) {
    const wantedCompanies = new Set(companyNames.filter(Boolean));
    const rows = (await this.repo(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({ limit: 10000 }))
      .map(toPlainRecord)
      .filter((row) => {
        const company = text(row.company) ?? '';
        return (
          isProfitTier(row.tier) &&
          text(row.supplierOrderRef) &&
          (!wantedCompanies.size || wantedCompanies.has(company))
        );
      });
    const latestByCompany = new Map<string, string>();
    for (const row of rows) {
      const company = text(row.company) ?? '';
      const calculationDate = dateOnly(row.calculationDate);
      if (!calculationDate) continue;
      const current = latestByCompany.get(company);
      if (!current || calculationDate > current) latestByCompany.set(company, calculationDate);
    }
    return {
      latestCalculationDate: maxDate([...latestByCompany.values()]),
      rows: rows.filter((row) => dateOnly(row.calculationDate) === latestByCompany.get(text(row.company) ?? '')),
    };
  }

  private groupGoldByOrderRef(rows: PlainRecord[]) {
    const byOrderRef = new Map<string, PlainRecord[]>();
    for (const row of rows) {
      const orderRef = text(row.supplierOrderRef);
      if (!orderRef) continue;
      const key = goldOrderKey(text(row.company), orderRef);
      byOrderRef.set(key, [...(byOrderRef.get(key) ?? []), row]);
    }
    return byOrderRef;
  }

  private latestComment(comments: PlainRecord[]) {
    const latest = [...comments]
      .filter((comment) => text(comment.body))
      .sort((left, right) => (dateTime(right.createdAt) ?? '').localeCompare(dateTime(left.createdAt) ?? ''))[0];
    return text(latest?.body);
  }

  private async createComment(params: {
    entityType: 'order' | 'order_line';
    entityId: string;
    body?: string;
    actorUserId?: string;
    snapshot?: PlainRecord;
  }) {
    const body = text(params.body);
    if (!body) throw new Error('Ecobase Order Planning comment failed: body is required.');
    return this.repo(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: randomUUID(),
        entityType: params.entityType,
        entityId: params.entityId,
        actorType: 'operator',
        actorUserId: params.actorUserId,
        commentType: 'note',
        body,
        contextSnapshotJson: params.snapshot,
        workflowDetectionStatus: 'none',
      },
    });
  }

  private async requireRecord(collection: string, id: string | undefined, label: string) {
    if (!id) throw new Error(`Ecobase Order Planning ${label} failed: id is required.`);
    const record = await this.repo(collection).findOne({ filterByTk: id });
    if (!record) throw new Error(`Ecobase Order Planning ${label} failed: ${id} was not found.`);
    return toPlainRecord(record);
  }

  private repo(name: string) {
    return this.db.getRepository(name);
  }
}
