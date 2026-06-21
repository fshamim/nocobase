import { createHash, randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import {
  CLOSED_SUPPLIER_ORDER_STATUSES,
  OPEN_SUPPLIER_ORDER_STATUSES,
  EcobaseSupplierOrderService,
  validateSupplierLeadTimeDays,
  validateSupplierOrderActivityType,
  validateSupplierOrderStatus,
} from './supplier-order-service';

type PlainRecord = Record<string, unknown>;

type SupplierAttentionStatus = 'urgent' | 'needs_attention' | 'monitor' | 'ok';

type SupplierAttentionReason =
  | 'product_oos_soon'
  | 'product_oos_urgent'
  | 'missing_lead_time'
  | 'stale_lead_time'
  | 'lead_time_conflict'
  | 'contact_overdue'
  | 'follow_up_due'
  | 'blocked_open_order'
  | 'late_open_order'
  | 'no_open_order_for_risky_product'
  | 'open_order_arrives_late'
  | 'high_money_at_risk';

export interface SupplierAttentionFilters {
  company?: string;
  calculationDate?: string;
  limit?: number;
}

const SUPPLIER_PROFILE_STRING_FIELDS = [
  'name',
  'supplierId',
  'asin',
  'prPortalLink',
  'contactName',
  'reachedVia',
  'receivedEmail',
  'remarks',
  'moq',
  'designation',
  'supplierType',
  'presenceOnAmazon',
  'currentStatus',
  'supplierStatus',
  'activeStatus',
  'emailDone',
  'callDone',
  'wholesalePriceList',
  'dateOfUpdate',
  'approvalStatus',
  'accountStatus',
  'analysisStatus',
  'nextFollowUpAt',
  'lastContactedAt',
  'approvalNotes',
] as const;

const SUPPLIER_PROFILE_NUMBER_FIELDS = [
] as const;

type SupplierProfileStringField = (typeof SUPPLIER_PROFILE_STRING_FIELDS)[number];
type SupplierProfileNumberField = (typeof SUPPLIER_PROFILE_NUMBER_FIELDS)[number];
type SupplierProfileFields = Partial<
  Record<SupplierProfileStringField, string> & Record<SupplierProfileNumberField, number> & { contactEstablished: boolean }
>;

export interface CreateSupplierParams extends SupplierProfileFields {
  company?: string;
  name?: string;
  supplierCode?: string;
  actor?: string;
}

export interface UpdateSupplierProfileParams extends SupplierProfileFields {
  company?: string;
  supplierId?: string;
  active?: boolean;
  activityNotes?: string;
  actor?: string;
}

export interface CreateSupplierOrderParams {
  company?: string;
  supplierId?: string;
  externalOrderRef?: string;
  orderDate?: string;
  expectedDeliveryDate?: string;
  status?: string;
  approvalStatus?: string;
  paymentStatus?: string;
  shippingCarrier?: string;
  trackingId?: string;
  blockedReason?: string;
  notes?: string;
  actor?: string;
}

export interface RecordSupplierActivityParams {
  company?: string;
  supplierId?: string;
  supplierOrderId?: string;
  activityType?: string;
  occurredAt?: string;
  notes?: string;
  nextFollowUpAt?: string;
  leadTimeDays?: number;
  contactEstablished?: boolean;
  source?: string;
  actor?: string;
}

export interface UpdateSupplierProductLeadTimeParams {
  company?: string;
  supplierId?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  leadTimeDays?: number;
  confirmedAt?: string;
  notes?: string;
  actor?: string;
}

export interface LookupParams {
  company?: string;
  search?: string;
  limit?: number;
}

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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizedSearch(value: string | undefined) {
  return normalizeName(value ?? '');
}

function compactNaturalKey(prefix: string, rawKey: string) {
  const naturalKey = `${prefix}:${rawKey}`;
  if (naturalKey.length <= 240) {
    return naturalKey;
  }
  return `${prefix}:hash:${createHash('sha256').update(rawKey).digest('hex')}`;
}

function dateOnly(value: string | undefined) {
  return value ? value.slice(0, 10) : undefined;
}

function isoDateTime(value: string | undefined, fieldName: string) {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Ecobase supplier management failed: ${fieldName} must be a valid date or datetime.`);
  }
  return parsed.toISOString();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(leftIsoDate: string, rightIsoDate: string) {
  const left = new Date(`${leftIsoDate.slice(0, 10)}T00:00:00.000Z`).getTime();
  const right = new Date(`${rightIsoDate.slice(0, 10)}T00:00:00.000Z`).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return undefined;
  }
  return Math.floor((left - right) / 86_400_000);
}

function oneOf(value: string | undefined, allowed: string[], fallback: string) {
  return value && allowed.includes(value) ? value : fallback;
}

function supplierProfileValues(params: SupplierProfileFields) {
  const values: PlainRecord = {};
  for (const field of SUPPLIER_PROFILE_STRING_FIELDS) {
    if (params[field] !== undefined) {
      values[field] = asString(params[field]) ?? null;
    }
  }
  for (const field of SUPPLIER_PROFILE_NUMBER_FIELDS) {
    if (params[field] !== undefined) {
      values[field] = asNumber(params[field]) ?? null;
    }
  }
  if (params.contactEstablished !== undefined) {
    values.contactEstablished = Boolean(params.contactEstablished);
  }
  if ('approvalStatus' in values) {
    values.approvalStatus = oneOf(asString(values.approvalStatus), ['new', 'contacting', 'analyzing', 'approved', 'rejected'], 'new');
  }
  if ('accountStatus' in values) {
    values.accountStatus = oneOf(asString(values.accountStatus), ['not_started', 'submitted', 'approved', 'rejected'], 'not_started');
  }
  if ('analysisStatus' in values) {
    values.analysisStatus = oneOf(asString(values.analysisStatus), ['not_started', 'in_progress', 'done'], 'not_started');
  }
  return values;
}

function unique<T>(values: T[]) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))] as T[];
}

function limitValue(value: number | undefined, defaultValue: number, maxValue: number) {
  return Math.min(Math.max(value ?? defaultValue, 1), maxValue);
}

function matchesSearch(record: PlainRecord, search: string | undefined, fields: string[]) {
  const needle = normalizedSearch(search);
  if (!needle) {
    return true;
  }
  return fields.some((field) => normalizedSearch(asString(record[field])).includes(needle));
}

function attentionStatus(score: number, reasons: SupplierAttentionReason[]): SupplierAttentionStatus {
  if (score >= 90 || reasons.includes('blocked_open_order')) {
    return 'urgent';
  }
  if (score >= 50) {
    return 'needs_attention';
  }
  if (score > 0) {
    return 'monitor';
  }
  return 'ok';
}

function recommendedAction(reasons: SupplierAttentionReason[]) {
  if (reasons.includes('blocked_open_order')) {
    return 'Resolve blocked supplier order';
  }
  if (reasons.includes('stale_lead_time')) {
    return 'Contact supplier soon and update lead time';
  }
  if (reasons.includes('product_oos_urgent') && reasons.includes('no_open_order_for_risky_product')) {
    return 'Confirm lead time and place/expedite order';
  }
  if (reasons.includes('missing_lead_time') || reasons.includes('lead_time_conflict')) {
    return 'Update product lead time';
  }
  if (reasons.includes('contact_overdue') || reasons.includes('follow_up_due')) {
    return 'Contact supplier and record outcome';
  }
  if (reasons.includes('late_open_order') || reasons.includes('open_order_arrives_late')) {
    return 'Update expected delivery or escalate supplier';
  }
  return reasons.length > 0 ? 'Review supplier details' : 'No action needed';
}

function scoreReasons(reasons: SupplierAttentionReason[]) {
  const scores: Array<[SupplierAttentionReason, number]> = [
    ['blocked_open_order', 100],
    ['product_oos_urgent', 90],
    ['open_order_arrives_late', 80],
    ['missing_lead_time', 70],
    ['stale_lead_time', 60],
    ['contact_overdue', 50],
    ['follow_up_due', 40],
    ['late_open_order', 30],
    ['product_oos_soon', 10],
    ['lead_time_conflict', 10],
    ['no_open_order_for_risky_product', 10],
    ['high_money_at_risk', 10],
  ];
  return scores.reduce((total, [reason, score]) => (reasons.includes(reason) ? total + score : total), 0);
}

export class EcobaseSupplierManagementService {
  constructor(private readonly db: EcobaseDatabase) {}

  async refreshSupplierAttentionRows(filters: SupplierAttentionFilters = {}) {
    const company = asString(filters.company);
    const calculationDate = asString(filters.calculationDate) ?? todayIso();
    const suppliers = await this.findSuppliers({ company, limit: 2000 });
    const rows = [];
    for (const supplier of suppliers) {
      const row = await this.buildSupplierAttentionRow(supplier, calculationDate);
      rows.push(await this.upsertAttentionRow(row));
    }

    return {
      calculationDate,
      refreshedCount: rows.length,
      urgentCount: rows.filter((row) => row.attentionStatus === 'urgent').length,
      needsAttentionCount: rows.filter((row) => row.attentionStatus === 'needs_attention').length,
      warnings: company ? [] : ['company_filter_not_supplied'],
      rows: this.sortAttentionRows(rows).slice(0, limitValue(filters.limit, rows.length || 1, 2000)),
    };
  }

  async listSupplierAttentionRows(filters: SupplierAttentionFilters = {}) {
    const limit = limitValue(filters.limit, 100, 1000);
    let rows = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.supplierAttentionRows).find({
        filter: asString(filters.company) ? { company: asString(filters.company) } : {},
        limit: 2000,
      })
    ).map(toPlainRecord);
    const calculationDate = asString(filters.calculationDate);
    if (calculationDate) {
      rows = rows.filter((row) => asString(row.calculationDate) === calculationDate);
    }
    return this.sortAttentionRows(rows).slice(0, limit);
  }

  async summary(filters: SupplierAttentionFilters = {}) {
    const existingRows = await this.listSupplierAttentionRows({ ...filters, limit: 2000 });
    const rows = existingRows.length > 0 ? existingRows : (await this.refreshSupplierAttentionRows(filters)).rows;
    return {
      totalSuppliers: rows.length,
      urgentSuppliers: rows.filter((row) => row.attentionStatus === 'urgent').length,
      needsAttentionSuppliers: rows.filter((row) => row.attentionStatus === 'needs_attention').length,
      leadTimeIssueSuppliers: rows.filter((row) => (asNumber(row.leadTimeIssueCount) ?? 0) > 0).length,
      overdueFollowUps: rows.filter((row) => row.contactStatus === 'overdue').length,
      blockedOrLateOpenOrders: rows.filter(
        (row) => (asNumber(row.blockedOpenOrderCount) ?? 0) > 0 || (asNumber(row.lateOpenOrderCount) ?? 0) > 0,
      ).length,
      totalEstimatedProfitRisk: rows.reduce((total, row) => total + (asNumber(row.totalEstimatedProfitRisk) ?? 0), 0),
      highestEstimatedProfitRisk: Math.max(0, ...rows.map((row) => asNumber(row.highestEstimatedProfitRisk) ?? 0)),
      staleReadModel: rows.length === 0,
    };
  }

  async getSupplierDetail(params: { company?: string; supplierId?: string; calculationDate?: string }) {
    const company = asString(params.company);
    const supplierId = asString(params.supplierId);
    if (!company || !supplierId) {
      throw new Error('Ecobase supplier detail failed: company and supplierId are required.');
    }
    const supplier = await this.applyOrderHistoryWorkflowStatus(
      await this.requireSupplier(company, supplierId, 'Ecobase supplier detail failed'),
    );
    const attentionRow =
      toPlainRecord(
        await this.db.getRepository(ECOBASE_COLLECTIONS.supplierAttentionRows).findOne({
          filter: {
            naturalKey: `supplier-attention:${company}:${supplierId}:${asString(params.calculationDate) ?? todayIso()}`,
          },
        }),
      ) ?? {};
    const productIds = await this.productIdsForSupplier(company, supplierId);
    const atRiskProducts = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.inventoryPlanningRows).find({ filter: { company }, limit: 3000 })
    )
      .map(toPlainRecord)
      .filter((row) => this.rowBelongsToSupplier(row, supplier, productIds));
    const leadTimes = await this.leadTimesForSupplier(company, supplier);
    const productLinks = await this.productLinksForSupplier(company, supplierId);
    const orders = await this.ordersForSupplier(company, supplierId);
    const orderIds = new Set(orders.map((order) => asString(order.id)).filter(Boolean));
    const orderLines = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).find({ filter: { company }, limit: 3000 })
    )
      .map(toPlainRecord)
      .filter((line) => asString(line.supplierId) === supplierId || orderIds.has(asString(line.supplierOrderId)));
    const activities = await this.activitiesForSupplier(company, supplierId);
    const knownSupplierProducts = this.knownProductsFromOrderLines(orderLines, orders);

    return {
      supplier,
      attentionRow,
      atRiskProducts: this.sortRiskRows(atRiskProducts).slice(0, 200),
      leadTimes,
      productLinks,
      knownSupplierProducts,
      orders,
      orderLines,
      activities,
    };
  }

  async createSupplier(params: CreateSupplierParams) {
    const company = asString(params.company);
    const name = asString(params.name);
    if (!company || !name) {
      throw new Error('Ecobase supplier create failed: company and name are required.');
    }
    const normalizedName = normalizeName(name);
    const duplicate = (await this.findSuppliers({ company, limit: 2000 })).find(
      (supplier) => normalizeName(asString(supplier.name) ?? '') === normalizedName,
    );
    if (duplicate) {
      throw new Error(`Ecobase supplier create failed: supplier "${name}" already exists for ${company}.`);
    }

    const sourceConnectionId = await this.ensureManualSourceConnection(company);
    const now = new Date().toISOString();
    const supplier = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).create({
        values: {
          id: randomUUID(),
          naturalKey: compactNaturalKey('supplier', `${company}:manual:name:${normalizedName}`),
          sourceConnectionId,
          ...supplierProfileValues(params),
          supplierId: asString(params.supplierCode) ?? asString(params.supplierId),
          name,
          normalizedName,
          company,
          active: true,
          lastSeenAt: now,
          payload: { source: 'manual_supplier_management' },
        },
      }),
    );

    if (asString(params.remarks)) {
      await this.recordSupplierActivity({
        company,
        supplierId: asString(supplier.id),
        activityType: 'note',
        notes: asString(params.remarks),
        actor: asString(params.actor),
      });
    }
    return supplier;
  }

  async updateSupplierProfile(params: UpdateSupplierProfileParams) {
    const company = asString(params.company);
    const supplierId = asString(params.supplierId);
    if (!company || !supplierId) {
      throw new Error('Ecobase supplier profile update failed: company and supplierId are required.');
    }
    const supplier = await this.requireSupplier(company, supplierId, 'Ecobase supplier profile update failed');
    const values: PlainRecord = supplierProfileValues(params);
    if (params.name !== undefined) {
      const updatedName = asString(params.name);
      if (!updatedName) {
        throw new Error('Ecobase supplier profile update failed: name must not be empty.');
      }
      values.normalizedName = normalizeName(updatedName);
    }
    if (params.active !== undefined) {
      values.active = asBoolean(params.active) ?? false;
    }
    await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).update({ filterByTk: supplierId, values });

    const notes = asString(params.activityNotes);
    if (notes) {
      await this.recordSupplierActivity({
        company,
        supplierId,
        activityType: 'note',
        notes,
        actor: asString(params.actor),
      });
    }
    return this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).findOne({ filterByTk: asString(supplier.id) });
  }

  async createSupplierOrder(params: CreateSupplierOrderParams) {
    const company = asString(params.company);
    const supplierId = asString(params.supplierId);
    if (!company || !supplierId) {
      throw new Error('Ecobase supplier order create failed: company and supplierId are required.');
    }
    const supplier = await this.requireSupplier(company, supplierId, 'Ecobase supplier order create failed');
    const status = validateSupplierOrderStatus(asString(params.status) ?? 'draft');
    const now = new Date().toISOString();
    const externalOrderRef = asString(params.externalOrderRef);
    const naturalKey = externalOrderRef
      ? compactNaturalKey('supplier-order', `${company}:${externalOrderRef}`)
      : compactNaturalKey('supplier-order', `${company}:local-draft:${randomUUID()}`);
    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const existing = externalOrderRef ? toPlainRecord(await orderRepo.findOne({ filter: { naturalKey } })) : {};
    const values = {
      naturalKey,
      sourceConnectionId: asString(supplier.sourceConnectionId) ?? (await this.ensureManualSourceConnection(company)),
      company,
      supplierId,
      externalOrderRef,
      sourceStage: 'manual',
      status,
      statusSource: 'manual',
      statusUpdatedAt: now,
      lastMeaningfulUpdateAt: now,
      lastOperatorEditAt: now,
      lastOperatorActor: asString(params.actor),
      orderDate: dateOnly(asString(params.orderDate)),
      expectedDeliveryDate: dateOnly(asString(params.expectedDeliveryDate)),
      expectedDeliveryDateSource: asString(params.expectedDeliveryDate) ? 'manual' : 'missing',
      approvalStatus: asString(params.approvalStatus),
      paymentStatus: asString(params.paymentStatus),
      shippingCarrier: asString(params.shippingCarrier),
      trackingId: asString(params.trackingId),
      blockedReason: asString(params.blockedReason),
      payload: { source: 'manual_supplier_management' },
    };

    let order: PlainRecord;
    if (asString(existing.id)) {
      await orderRepo.update({ filterByTk: asString(existing.id), values });
      order = toPlainRecord(await orderRepo.findOne({ filterByTk: asString(existing.id) }));
    } else {
      order = toPlainRecord(await orderRepo.create({ values: { id: randomUUID(), ...values } }));
    }

    await this.recordSupplierActivity({
      company,
      supplierId,
      supplierOrderId: asString(order.id),
      activityType: 'status_update',
      notes: asString(params.notes) ?? `Created supplier order${externalOrderRef ? ` ${externalOrderRef}` : ''}.`,
      actor: asString(params.actor),
    });
    return order;
  }

  async recordSupplierActivity(params: RecordSupplierActivityParams) {
    const company = asString(params.company) ?? '';
    const supplierId = asString(params.supplierId) ?? '';
    const activityType = validateSupplierOrderActivityType(asString(params.activityType) ?? 'note');
    const occurredAt = asString(params.occurredAt) ?? new Date().toISOString();
    const activity = await new EcobaseSupplierOrderService(this.db).recordActivity({
      company,
      supplierId,
      supplierOrderId: asString(params.supplierOrderId),
      activityType,
      occurredAt,
      notes: asString(params.notes),
      nextFollowUpAt: asString(params.nextFollowUpAt),
      leadTimeDays: validateSupplierLeadTimeDays(params.leadTimeDays, 'Ecobase supplier management activity failed'),
      source: asString(params.source),
      actor: asString(params.actor),
    });
    if (company && supplierId && ['contacted_supplier', 'note', 'status_update'].includes(activityType)) {
      const values: PlainRecord = {};
      if (activityType === 'contacted_supplier') {
        values.lastContactedAt = occurredAt;
        values.contactEstablished = params.contactEstablished !== false;
        if (asString(params.nextFollowUpAt)) values.approvalStatus = 'contacting';
      }
      if (asString(params.nextFollowUpAt)) {
        values.nextFollowUpAt = asString(params.nextFollowUpAt);
      }
      if (Object.keys(values).length > 0) {
        await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).update({ filterByTk: supplierId, values });
      }
    }
    return activity;
  }

  async updateSupplierProductLeadTime(params: UpdateSupplierProductLeadTimeParams) {
    const company = asString(params.company);
    const supplierId = asString(params.supplierId);
    const leadTimeDays = validateSupplierLeadTimeDays(
      params.leadTimeDays,
      'Ecobase supplier management lead-time update failed',
    );
    if (!company || !supplierId || leadTimeDays === undefined) {
      throw new Error(
        'Ecobase supplier management lead-time update failed: company, supplierId, and leadTimeDays are required.',
      );
    }
    const service = new EcobaseSupplierOrderService(this.db);
    const leadTime = await service.updateSupplierLeadTime({
      company,
      supplierId,
      planningProductId: asString(params.planningProductId),
      asin: asString(params.asin),
      sku: asString(params.sku),
      leadTimeDays,
      confirmedAt: asString(params.confirmedAt),
      notes: asString(params.notes),
      actor: asString(params.actor),
    });
    await this.recordSupplierActivity({
      company,
      supplierId,
      activityType: 'lead_time_checked',
      occurredAt: asString(params.confirmedAt),
      notes: asString(params.notes),
      leadTimeDays,
      actor: asString(params.actor),
    });
    return leadTime;
  }

  async supplierOptions(params: LookupParams = {}) {
    return (await this.findSuppliers({ company: asString(params.company), limit: limitValue(params.limit, 25, 100) }))
      .filter((supplier) =>
        matchesSearch(supplier, asString(params.search), ['name', 'supplierId', 'receivedEmail', 'contactName']),
      )
      .map((supplier) => ({
        value: asString(supplier.id),
        label: asString(supplier.name),
        company: asString(supplier.company),
        supplierCode: asString(supplier.supplierId),
      }));
  }

  async productOptions(params: LookupParams = {}) {
    const limit = limitValue(params.limit, 25, 100);
    const company = asString(params.company);
    const search = asString(params.search);
    const options = new Map<string, PlainRecord>();

    for (const product of (await this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).find({
      filter: company ? { company } : {},
      limit: 1000,
    })).map(toPlainRecord)) {
      if (!matchesSearch(product, search, ['canonicalAsin', 'title', 'naturalKey'])) continue;
      const id = asString(product.id);
      if (!id) continue;
      options.set(`planning:${id}`, {
        value: `planning:${id}`,
        label: [asString(product.canonicalAsin), asString(product.title)].filter(Boolean).join(' · '),
        company: asString(product.company),
        planningProductId: id,
        asin: asString(product.canonicalAsin),
      });
    }

    for (const line of (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).find({
      filter: company ? { company } : {},
      limit: 10000,
    })).map(toPlainRecord)) {
      if (!matchesSearch(line, search, ['asin', 'sku', 'brand'])) continue;
      const asin = asString(line.asin);
      const sku = asString(line.sku);
      if (!asin && !sku) continue;
      const key = `history:${asin ?? ''}:${sku ?? ''}`;
      if (options.has(key)) continue;
      options.set(key, {
        value: key,
        label: [asin, sku, asString(line.brand)].filter(Boolean).join(' · '),
        company: asString(line.company),
        asin,
        sku,
      });
    }

    return [...options.values()].slice(0, limit);
  }

  async orderOptions(params: LookupParams & { supplierId?: string } = {}) {
    const limit = limitValue(params.limit, 25, 100);
    return (
      await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).find({
        filter: asString(params.company) ? { company: asString(params.company) } : {},
        limit: 1000,
      })
    )
      .map(toPlainRecord)
      .filter((order) => !params.supplierId || asString(order.supplierId) === params.supplierId)
      .filter((order) => matchesSearch(order, asString(params.search), ['externalOrderRef', 'status', 'trackingId']))
      .slice(0, limit)
      .map((order) => ({
        value: asString(order.id),
        label: [asString(order.externalOrderRef) ?? '(local draft)', asString(order.status)]
          .filter(Boolean)
          .join(' · '),
        company: asString(order.company),
        supplierId: asString(order.supplierId),
      }));
  }

  private async buildSupplierAttentionRow(supplier: PlainRecord, calculationDate: string) {
    supplier = await this.applyOrderHistoryWorkflowStatus(supplier);
    const company = asString(supplier.company) ?? '';
    const supplierId = asString(supplier.id) ?? '';
    const productIds = await this.productIdsForSupplier(company, supplierId);
    const planningRows = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.inventoryPlanningRows).find({ filter: { company }, limit: 3000 })
    )
      .map(toPlainRecord)
      .filter((row) => this.rowBelongsToSupplier(row, supplier, productIds));
    const riskRows = planningRows.filter((row) => this.rowNeedsAttention(row, calculationDate));
    const leadTimes = await this.leadTimesForSupplier(company, supplier);
    const orders = await this.ordersForSupplier(company, supplierId);
    const activities = await this.activitiesForSupplier(company, supplierId);
    const openOrders = orders.filter((order) => !CLOSED_SUPPLIER_ORDER_STATUSES.includes(asString(order.status) ?? ''));
    const lateOpenOrders = openOrders.filter((order) => {
      const expectedDate = dateOnly(asString(order.expectedDeliveryDate));
      return expectedDate ? expectedDate < calculationDate : false;
    });
    const blockedOpenOrders = openOrders.filter((order) => asString(order.status) === 'blocked');
    const latestContact = activities
      .filter((activity) => asString(activity.activityType) === 'contacted_supplier')
      .sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')))[0];
    const nextFollowUpAt = activities
      .map((activity) => asString(activity.nextFollowUpAt))
      .filter(Boolean)
      .sort()[0];
    const totalEstimatedProfitRisk = riskRows.reduce(
      (total, row) => total + (asNumber(row.estimatedProfitRisk) ?? 0),
      0,
    );
    const highestEstimatedProfitRisk = Math.max(0, ...riskRows.map((row) => asNumber(row.estimatedProfitRisk) ?? 0));
    const earliestEstimatedOosDate = riskRows
      .map((row) => dateOnly(asString(row.estimatedOosDate)))
      .filter(Boolean)
      .sort()[0];
    const staleLeadTimes = leadTimes.filter((leadTime) => this.isStaleLeadTime(leadTime, calculationDate));
    const staleLeadTimeProductIds = new Set(staleLeadTimes.map((leadTime) => asString(leadTime.planningProductId)).filter(Boolean));
    const leadTimeIssueRows = riskRows.filter(
      (row) => this.rowHasLeadTimeIssue(row, leadTimes) || staleLeadTimeProductIds.has(asString(row.planningProductId) ?? ''),
    );
    const missingLeadTimeCount = riskRows.filter(
      (row) => !asNumber(row.leadTimeDays) && !this.findLeadTime(row, leadTimes),
    ).length;
    const rowStaleLeadTimeCount = riskRows.filter((row) => asString(row.leadTimeFreshness) === 'stale').length;
    const staleLeadTimeCount = Math.max(rowStaleLeadTimeCount, staleLeadTimes.length);
    const conflictingLeadTimeCount = riskRows.filter((row) => asString(row.leadTimeFreshness) === 'conflict').length;
    const reasons: SupplierAttentionReason[] = [];
    const urgentRows = riskRows.filter((row) => {
      const estimatedOosDate = dateOnly(asString(row.estimatedOosDate));
      const days = estimatedOosDate ? daysBetween(estimatedOosDate, calculationDate) : undefined;
      return typeof days === 'number' && days <= 14;
    });
    if (riskRows.length > 0) reasons.push('product_oos_soon');
    if (urgentRows.length > 0) reasons.push('product_oos_urgent');
    if (missingLeadTimeCount > 0) reasons.push('missing_lead_time');
    if (staleLeadTimeCount > 0) reasons.push('stale_lead_time');
    if (conflictingLeadTimeCount > 0) reasons.push('lead_time_conflict');
    if (blockedOpenOrders.length > 0) reasons.push('blocked_open_order');
    if (lateOpenOrders.length > 0) reasons.push('late_open_order');
    if (riskRows.length > 0 && openOrders.length === 0) reasons.push('no_open_order_for_risky_product');
    if (totalEstimatedProfitRisk > 0) reasons.push('high_money_at_risk');

    const contactAge = latestContact
      ? daysBetween(calculationDate, dateOnly(asString(latestContact.occurredAt)) ?? calculationDate)
      : undefined;
    if (riskRows.length > 0 && (!latestContact || (typeof contactAge === 'number' && contactAge > 7))) {
      reasons.push('contact_overdue');
    }
    const effectiveNextFollowUpAt = asString(supplier.nextFollowUpAt) ?? nextFollowUpAt;
    const nextFollowUpDate = dateOnly(effectiveNextFollowUpAt);
    if (nextFollowUpDate && nextFollowUpDate <= calculationDate) {
      reasons.push('follow_up_due');
    }
    const uniqueReasons = unique(reasons);
    const attentionScore = scoreReasons(uniqueReasons);
    const contactStatus = !latestContact
      ? 'missing'
      : nextFollowUpDate && nextFollowUpDate <= calculationDate
        ? 'overdue'
        : typeof contactAge === 'number' && contactAge > 7
          ? 'overdue'
          : typeof contactAge === 'number' && contactAge >= 5
            ? 'due_soon'
            : 'recent';

    return {
      id: undefined,
      naturalKey: `supplier-attention:${company}:${supplierId}:${calculationDate}`,
      company,
      supplierId,
      supplierName: asString(supplier.name),
      approvalStatus: asString(supplier.approvalStatus) ?? 'new',
      accountStatus: asString(supplier.accountStatus) ?? 'not_started',
      analysisStatus: asString(supplier.analysisStatus) ?? 'not_started',
      calculationDate,
      attentionStatus: attentionStatus(attentionScore, uniqueReasons),
      attentionScore,
      recommendedAction: recommendedAction(uniqueReasons),
      reasonCodes: uniqueReasons,
      urgentProductCount: urgentRows.length,
      oosSoonProductCount: riskRows.length,
      earliestEstimatedOosDate,
      highestEstimatedProfitRisk,
      totalEstimatedProfitRisk,
      leadTimeIssueCount: leadTimeIssueRows.length,
      missingLeadTimeCount,
      staleLeadTimeCount,
      conflictingLeadTimeCount,
      openOrderCount: openOrders.length,
      lateOpenOrderCount: lateOpenOrders.length,
      blockedOpenOrderCount: blockedOpenOrders.length,
      lastContactedAt: asString(supplier.lastContactedAt) ?? asString(latestContact?.occurredAt),
      nextFollowUpAt: effectiveNextFollowUpAt,
      contactSoon: staleLeadTimeCount > 0,
      contactStatus,
      evidence: {
        supplierId,
        planningProductIds: unique(riskRows.map((row) => asString(row.planningProductId))),
        inventoryPlanningRowIds: unique(riskRows.map((row) => asString(row.id))),
        supplierOrderIds: unique(openOrders.map((order) => asString(order.id))),
        staleLeadTimeIds: unique(staleLeadTimes.map((leadTime) => asString(leadTime.id) ?? asString(leadTime.naturalKey))),
        activityIds: unique(activities.slice(0, 10).map((activity) => asString(activity.id))),
      },
      lastRefreshedAt: new Date().toISOString(),
    };
  }

  private async upsertAttentionRow(row: PlainRecord) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierAttentionRows);
    const existing = toPlainRecord(await repo.findOne({ filter: { naturalKey: row.naturalKey } }));
    const values = { ...row };
    delete values.id;
    if (asString(existing.id)) {
      await repo.update({ filterByTk: asString(existing.id), values });
      return toPlainRecord(await repo.findOne({ filterByTk: asString(existing.id) }));
    }
    return toPlainRecord(await repo.create({ values: { id: randomUUID(), ...values } }));
  }

  private sortAttentionRows(rows: PlainRecord[]) {
    return [...rows].sort((left, right) => {
      const totalRiskDiff =
        (asNumber(right.totalEstimatedProfitRisk) ?? 0) - (asNumber(left.totalEstimatedProfitRisk) ?? 0);
      if (totalRiskDiff !== 0) return totalRiskDiff;
      const highestRiskDiff =
        (asNumber(right.highestEstimatedProfitRisk) ?? 0) - (asNumber(left.highestEstimatedProfitRisk) ?? 0);
      if (highestRiskDiff !== 0) return highestRiskDiff;
      const scoreDiff = (asNumber(right.attentionScore) ?? 0) - (asNumber(left.attentionScore) ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return String(left.earliestEstimatedOosDate ?? '9999-12-31').localeCompare(
        String(right.earliestEstimatedOosDate ?? '9999-12-31'),
      );
    });
  }

  private sortRiskRows(rows: PlainRecord[]) {
    return [...rows].sort((left, right) => {
      const riskDiff = (asNumber(right.estimatedProfitRisk) ?? 0) - (asNumber(left.estimatedProfitRisk) ?? 0);
      if (riskDiff !== 0) return riskDiff;
      return String(left.estimatedOosDate ?? '9999-12-31').localeCompare(
        String(right.estimatedOosDate ?? '9999-12-31'),
      );
    });
  }

  private rowNeedsAttention(row: PlainRecord, calculationDate: string) {
    const actionStatus = asString(row.actionStatus);
    const estimatedOosDate = dateOnly(asString(row.estimatedOosDate));
    const days = estimatedOosDate ? daysBetween(estimatedOosDate, calculationDate) : undefined;
    return (
      actionStatus === 'order_now' ||
      actionStatus === 'order_soon' ||
      (typeof days === 'number' && days <= 30) ||
      (asNumber(row.estimatedProfitRisk) ?? 0) > 0 ||
      this.rowHasLeadTimeIssue(row, [])
    );
  }

  private rowHasLeadTimeIssue(row: PlainRecord, leadTimes: PlainRecord[]) {
    const freshness = asString(row.leadTimeFreshness);
    return (
      freshness === 'missing' ||
      freshness === 'stale' ||
      freshness === 'conflict' ||
      !asNumber(row.leadTimeDays) ||
      !this.findLeadTime(row, leadTimes)
    );
  }

  private isStaleLeadTime(leadTime: PlainRecord, calculationDate: string) {
    const confirmedAt = dateOnly(asString(leadTime.confirmedAt));
    const age = confirmedAt ? daysBetween(calculationDate, confirmedAt) : undefined;
    return typeof age === 'number' && age > 60;
  }

  private findLeadTime(row: PlainRecord, leadTimes: PlainRecord[]) {
    const planningProductId = asString(row.planningProductId);
    const asin = asString(row.asin);
    return leadTimes.find(
      (leadTime) =>
        (planningProductId && asString(leadTime.planningProductId) === planningProductId) ||
        (asin && asString(leadTime.asin) === asin) ||
        asString(leadTime.scope) === 'default',
    );
  }

  private async findSuppliers(params: { company?: string; limit?: number }) {
    return (
      await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).find({
        filter: asString(params.company) ? { company: asString(params.company) } : {},
        limit: limitValue(params.limit, 100, 3000),
      })
    ).map(toPlainRecord);
  }

  private async requireSupplier(company: string, supplierId: string, context: string) {
    const supplier = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).findOne({ filterByTk: supplierId }),
    );
    if (!asString(supplier.id)) {
      throw new Error(`${context}: supplier "${supplierId}" was not found.`);
    }
    if (asString(supplier.company) !== company) {
      throw new Error(`${context}: supplier belongs to a different company.`);
    }
    return supplier;
  }

  private async applyOrderHistoryWorkflowStatus(supplier: PlainRecord) {
    const company = asString(supplier.company);
    const supplierId = asString(supplier.id);
    if (!company || !supplierId) return supplier;
    const supplierCode = asString(supplier.supplierId);
    const supplierName = normalizeName(asString(supplier.name) ?? '');
    const relatedSupplierIds = unique(
      (await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).find({ filter: { company }, limit: 5000 }))
        .map(toPlainRecord)
        .filter((candidate) => {
          if (asString(candidate.id) === supplierId) return true;
          if (supplierCode && asString(candidate.supplierId) === supplierCode) return true;
          return supplierName.length > 0 && normalizeName(asString(candidate.name) ?? '') === supplierName;
        })
        .map((candidate) => asString(candidate.id)),
    );
    const hasOrderHistory = (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).find({ filter: { company }, limit: 5000 }))
      .map(toPlainRecord)
      .some((order) => relatedSupplierIds.includes(asString(order.supplierId) ?? ''));
    if (!hasOrderHistory) return supplier;
    const values = { approvalStatus: 'approved', accountStatus: 'approved', analysisStatus: 'done' };
    if (
      asString(supplier.approvalStatus) === values.approvalStatus &&
      asString(supplier.accountStatus) === values.accountStatus &&
      asString(supplier.analysisStatus) === values.analysisStatus
    ) {
      return supplier;
    }
    await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).update({ filterByTk: supplierId, values });
    return { ...supplier, ...values };
  }

  private knownProductsFromOrderLines(orderLines: PlainRecord[], orders: PlainRecord[]) {
    const orderById = new Map(orders.map((order) => [asString(order.id), order]));
    const groups = new Map<string, PlainRecord[]>();
    for (const line of orderLines) {
      const asin = asString(line.asin);
      const sku = asString(line.sku);
      if (!asin && !sku) continue;
      const key = `${asin ?? ''}:${sku ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    return [...groups.values()]
      .map((lines) => {
        const sorted = [...lines].sort((left, right) => String(right.observedAt ?? '').localeCompare(String(left.observedAt ?? '')));
        const latest = sorted[0];
        const latestOrder = orderById.get(asString(latest.supplierOrderId));
        return {
          asin: asString(latest.asin),
          sku: asString(latest.sku),
          brand: asString(latest.brand),
          lastOrderedAt: asString(latest.observedAt) ?? asString(latestOrder?.orderDate),
          orderCount: lines.length,
          totalOrderedQty: lines.reduce((total, line) => total + (asNumber(line.orderedQty) ?? 0), 0),
          lastUnitCost: asNumber(latest.unitCost),
          lastOrderStatus: asString(latestOrder?.status),
          lastOrderRef: asString(latestOrder?.externalOrderRef),
        };
      })
      .sort((left, right) => String(right.lastOrderedAt ?? '').localeCompare(String(left.lastOrderedAt ?? '')));
  }

  private async productLinksForSupplier(company: string, supplierId: string) {
    return (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks).find({ filter: { company }, limit: 3000 }))
      .map(toPlainRecord)
      .filter((link) => asString(link.supplierId) === supplierId && asBoolean(link.active) !== false);
  }

  private async productIdsForSupplier(company: string, supplierId: string) {
    return unique((await this.productLinksForSupplier(company, supplierId)).map((link) => asString(link.planningProductId)));
  }

  private rowBelongsToSupplier(row: PlainRecord, supplier: PlainRecord, productIds: string[]) {
    const supplierId = asString(supplier.id);
    const supplierName = normalizeName(asString(supplier.name) ?? '');
    return (
      asString(row.supplierId) === supplierId ||
      productIds.includes(asString(row.planningProductId) ?? '') ||
      (supplierName.length > 0 && normalizeName(asString(row.supplierName) ?? '') === supplierName)
    );
  }

  private async leadTimesForSupplier(company: string, supplier: PlainRecord) {
    const supplierId = asString(supplier.id);
    const supplierCode = asString(supplier.supplierId);
    const supplierName = normalizeName(asString(supplier.name) ?? '');
    return (
      await this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).find({ filter: { company }, limit: 3000 })
    )
      .map(toPlainRecord)
      .filter(
        (leadTime) =>
          asString(leadTime.supplierRefId) === supplierId ||
          (supplierCode && asString(leadTime.supplierId) === supplierCode) ||
          (supplierName.length > 0 && normalizeName(asString(leadTime.supplierName) ?? '') === supplierName),
      );
  }

  private async ordersForSupplier(company: string, supplierId: string) {
    return (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).find({ filter: { company }, limit: 3000 }))
      .map(toPlainRecord)
      .filter((order) => asString(order.supplierId) === supplierId);
  }

  private async activitiesForSupplier(company: string, supplierId: string) {
    return (
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities)
        .find({ filter: { company }, limit: 3000 })
    )
      .map(toPlainRecord)
      .filter((activity) => asString(activity.supplierId) === supplierId)
      .sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')));
  }

  private async ensureManualSourceConnection(company: string) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const name = `Supplier Management Manual - ${company}`;
    const existing = toPlainRecord(await repo.findOne({ filter: { name } }));
    const existingId = asString(existing.id);
    if (existingId) {
      return existingId;
    }
    const id = randomUUID();
    await repo.create({
      values: {
        id,
        name,
        sourceType: 'manual_supplier_management',
        domain: 'supplier-management',
        config: { company },
        active: true,
      },
    });
    return id;
  }
}
