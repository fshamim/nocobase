import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import { validateSupplierLeadTimeDays, validateSupplierOrderStatus } from './supplier-order-service';

type PlainRecord = Record<string, unknown>;

type SupplierLifecycleStatus = 'new' | 'contacting' | 'product_review' | 'payment_review' | 'approved' | 'rejected';

type FollowUpState = 'missing_follow_up' | 'scheduled' | 'due_today' | 'overdue';

export interface SupplierAttentionFilters {
  company?: string;
  calculationDate?: string;
  limit?: number;
}

export interface CreateSupplierParams {
  company?: string;
  name?: string;
  supplierCode?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  preferredContactMethod?: string;
  nextFollowUpAt?: string;
  notes?: string;
  actor?: string;
}

export interface UpdateSupplierProfileParams extends CreateSupplierParams {
  supplierId?: string;
  activityNotes?: string;
  approvalStatus?: string;
  accountStatus?: string;
  analysisStatus?: string;
  active?: boolean;
}

export interface UpdateSupplierLifecycleParams {
  supplierId?: string;
  status?: string;
  comment?: string;
  followUpAt?: string;
  actor?: string;
}

export interface RecordSupplierCommentParams {
  supplierId?: string;
  body?: string;
  commentType?: string;
  followUpAt?: string;
  actor?: string;
}

export interface DeleteSupplierCommentParams {
  commentId?: string;
  actor?: string;
}

export interface UpdateSupplierAccountParams {
  supplierId?: string;
  company?: string;
  accountName?: string;
  orderingMethod?: string;
  portalUrl?: string;
  username?: string;
  status?: string;
  actor?: string;
}

export interface UpsertSupplierProductParams {
  supplierId?: string;
  productId?: string;
  supplierSku?: string;
  unitCost?: number;
  moq?: number;
  leadTimeDays?: number;
  analysisStatus?: string;
  notes?: string;
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
  notes?: string;
  activityType?: string;
  nextFollowUpAt?: string;
  occurredAt?: string;
  leadTimeDays?: number;
  contactEstablished?: boolean;
  source?: string;
  actor?: string;
}

export interface UpdateSupplierProductLeadTimeParams {
  company?: string;
  supplierId?: string;
  supplierProductId?: string;
  productId?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  leadTimeDays?: number;
  confirmedAt?: string;
  notes?: string;
  actor?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function normalized(value: unknown) {
  return (
    asString(value)
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() ?? ''
  );
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function dateOnly(value: unknown) {
  return asString(value)?.slice(0, 10);
}

function daysBetween(left: string, right: string) {
  return Math.floor((Date.parse(left) - Date.parse(right)) / 86_400_000);
}

function repoRows(db: EcobaseDatabase, collection: string, limit = 5000) {
  return db
    .getRepository(collection)
    .find({ limit })
    .then((rows) => rows.map(toPlainRecord));
}

function repoRowsFiltered(db: EcobaseDatabase, collection: string, filter: PlainRecord, limit = 5000) {
  return db
    .getRepository(collection)
    .find({ filter, limit })
    .then((rows) => rows.map(toPlainRecord));
}

function repoRowsByIds(db: EcobaseDatabase, collection: string, ids: Array<string | undefined>) {
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!uniqueIds.length) return Promise.resolve([] as PlainRecord[]);
  return repoRowsFiltered(db, collection, { id: { $in: uniqueIds } }, Math.max(uniqueIds.length, 500));
}

function requireStatus(value: string | undefined): SupplierLifecycleStatus {
  const status = (value === 'analyzing' ? 'product_review' : value ?? 'new') as SupplierLifecycleStatus;
  if (!['new', 'contacting', 'product_review', 'payment_review', 'approved', 'rejected'].includes(status)) {
    throw new Error(`Ecobase supplier lifecycle update failed: status "${value}" is not supported.`);
  }
  return status;
}

function followUpState(nextFollowUpAt: unknown, calculationDate: string): FollowUpState {
  const nextDate = dateOnly(nextFollowUpAt);
  if (!nextDate) return 'missing_follow_up';
  if (nextDate < calculationDate) return 'overdue';
  if (nextDate === calculationDate) return 'due_today';
  return 'scheduled';
}

function latestByDate(rows: PlainRecord[], field: string) {
  return rows.reduce<PlainRecord | undefined>((latest, row) => {
    if (!latest) return row;
    return String(row[field] ?? '') >= String(latest[field] ?? '') ? row : latest;
  }, undefined);
}

function matchesCompany(row: PlainRecord, company?: string) {
  if (!company) return true;
  const expected = normalized(company);
  return [row.company, row.companyName, row.companyId].some((value) => normalized(value) === expected);
}

function rowSupplierKey(row: PlainRecord) {
  return asString(row.supplierId) ?? normalized(row.supplierName);
}

function supplierKey(supplier: PlainRecord) {
  return asString(supplier.id) ?? normalized(supplier.displayName);
}

function supplierLookupKeys(supplier: PlainRecord) {
  return [
    ...new Set(
      [asString(supplier.id), normalized(supplier.displayName), normalized(supplier.normalizedName)].filter(Boolean),
    ),
  ] as string[];
}

function rowSupplierLookupKeys(row: PlainRecord) {
  return [asString(row.supplierId), normalized(row.supplierName)].filter(Boolean) as string[];
}

function findSupplierForRow(row: PlainRecord, suppliersByKey: Map<string, PlainRecord>) {
  for (const key of rowSupplierLookupKeys(row)) {
    const supplier = suppliersByKey.get(key);
    if (supplier) return supplier;
  }
  return undefined;
}

function indexByField(rows: PlainRecord[], field: string) {
  const index = new Map<string, PlainRecord[]>();
  for (const row of rows) {
    const key = asString(row[field]);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  return index;
}

function riskMoney(row: PlainRecord, fields: string[]) {
  for (const field of fields) {
    const value = asNumber(row[field]);
    if (value !== undefined) return value;
  }
  return 0;
}

const PRE_ORDER_STATUSES = new Set([
  'new',
  'draft',
  'planned',
  'planning',
  'in progress',
  'order analysing',
  'approved to order',
  'approval pending',
  'pending approval',
  'product review',
  'payment review',
  'analyzing',
]);
const CLOSED_ORDER_STATUS_WORDS = new Set(['complete', 'completed', 'closed', 'cancelled', 'canceled', 'rejected']);

function orderStatusKey(row: PlainRecord) {
  return normalized(row.currentStatus ?? row.canonicalStatus ?? row.lifecycleStatus ?? row.status);
}

function hasPlacedOrderEvidence(row: PlainRecord) {
  const status = orderStatusKey(row);
  return !status || !PRE_ORDER_STATUSES.has(status);
}

function isClosedOrderRow(row: PlainRecord) {
  const status = orderStatusKey(row);
  return Boolean(status && status.split(' ').some((part) => CLOSED_ORDER_STATUS_WORDS.has(part)));
}

function isActiveOrderRiskRow(row: PlainRecord) {
  if (isClosedOrderRow(row)) return false;
  return (
    Boolean(row.statusCheckRequired) ||
    (asNumber(row.daysSinceLastActivity) ?? 0) >= 3 ||
    riskMoney(row, ['moneyAtRisk']) > 0
  );
}

function collectOrderedSupplierKeys(rows: PlainRecord[]) {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!hasPlacedOrderEvidence(row)) continue;
    const supplierId = asString(row.supplierId);
    const supplierName = normalized(row.supplierName);
    if (supplierId) keys.add(supplierId);
    if (supplierName) keys.add(supplierName);
  }
  return keys;
}

function supplierHasOrderedEvidence(supplier: PlainRecord, orderedSupplierKeys: Set<string>) {
  const supplierId = asString(supplier.id);
  const supplierName = normalized(supplier.displayName);
  return Boolean(
    (supplierId && orderedSupplierKeys.has(supplierId)) || (supplierName && orderedSupplierKeys.has(supplierName)),
  );
}

function effectiveSupplierLifecycleStatus(
  supplier: PlainRecord,
  orderedSupplierKeys: Set<string>,
): SupplierLifecycleStatus {
  const storedStatus = requireStatus(asString(supplier.approvalStatus));
  if (storedStatus !== 'rejected' && supplierHasOrderedEvidence(supplier, orderedSupplierKeys)) return 'approved';
  return storedStatus;
}

function sortDigestRows(rows: PlainRecord[]) {
  return [...rows].sort((left, right) => {
    const money = (asNumber(right.moneyAtRisk) ?? 0) - (asNumber(left.moneyAtRisk) ?? 0);
    if (money !== 0) return money;
    return (asNumber(right.priorityScore) ?? 0) - (asNumber(left.priorityScore) ?? 0);
  });
}

export class EcobaseSupplierManagementService {
  constructor(private db: EcobaseDatabase) {}

  async digest(filters: SupplierAttentionFilters = {}) {
    const rows = await this.buildDigestRows(filters);
    const limitedRows = rows.slice(0, filters.limit ?? 1000);
    return {
      summary: this.summaryFromRows(rows),
      rows: limitedRows,
    };
  }

  async refreshSupplierAttentionRows(filters: SupplierAttentionFilters = {}) {
    await this.approveSuppliersWithOrderEvidence();
    const digest = await this.digest(filters);
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.goldSupplierAttentionRows);
    for (const row of digest.rows) {
      const naturalKey = asString(row.naturalKey);
      if (!naturalKey) continue;
      const values = { ...row, id: asString(row.id) ?? randomUUID() };
      const existing = toPlainRecord(await repo.findOne({ filter: { naturalKey } }));
      if (existing.id) {
        await repo.update({ filterByTk: asString(existing.id), values: { ...values, id: existing.id } });
      } else {
        await repo.create({ values });
      }
    }
    return digest;
  }

  async listSupplierAttentionRows(filters: SupplierAttentionFilters = {}) {
    return (await this.digest(filters)).rows;
  }

  async summary(filters: SupplierAttentionFilters = {}) {
    return (await this.digest(filters)).summary;
  }

  async getSupplierDetail(params: SupplierAttentionFilters & { supplierId?: string }) {
    const supplierId = asString(params.supplierId);
    if (!supplierId) throw new Error('Ecobase supplier detail failed: supplierId is required.');
    const supplier = await this.requireSupplier(supplierId);
    const [comments, accounts, supplierProducts, orderedSupplierKeys, rawInventoryRisks, rawOrderRisks] =
      await Promise.all([
        this.commentsForSupplier(supplierId),
        this.accountsForSupplier(supplierId),
        this.productsForSupplier(supplierId),
        this.orderedSupplierKeysForSupplier(supplierId),
        repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, { supplierId }),
        repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.goldOrderPlanningRows, { supplierId }),
      ]);
    const productById = new Map(
      (
        await repoRowsByIds(
          this.db,
          ECOBASE_COLLECTIONS.silverProducts,
          supplierProducts.map((link) => asString(link.productId)),
        )
      ).map((product) => [asString(product.id), product]),
    );
    const enrichedProducts = supplierProducts.map((link) => {
      const product = productById.get(asString(link.productId));
      return {
        ...link,
        product,
        asin: product?.asin,
        sku: product?.sku,
        title: product?.title,
      };
    });
    const effectiveSupplier = {
      ...supplier,
      approvalStatus: effectiveSupplierLifecycleStatus(supplier, orderedSupplierKeys),
    };
    const inventoryRisks = rawInventoryRisks.filter((row) => matchesCompany(row, params.company));
    const orderRisks = rawOrderRisks.filter((row) => matchesCompany(row, params.company) && isActiveOrderRiskRow(row));
    return {
      supplier: effectiveSupplier,
      latestComment: latestByDate(comments, 'createdAt'),
      comments,
      accounts,
      supplierProducts: enrichedProducts,
      inventoryRisks,
      orderRisks,
    };
  }

  async createSupplier(params: CreateSupplierParams) {
    const name = asString(params.name);
    if (!name) throw new Error('Ecobase supplier create failed: supplier name is required.');
    const supplierRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers);
    const supplierNormalizedName = normalized(name);
    const existing = toPlainRecord(await supplierRepo.findOne({ filter: { normalizedName: supplierNormalizedName } }));
    if (existing.id) {
      throw new Error(`Ecobase supplier create failed: supplier "${name}" already exists.`);
    }
    const now = new Date().toISOString();
    const supplier = toPlainRecord(
      await supplierRepo.create({
        values: {
          id: randomUUID(),
          normalizedName: supplierNormalizedName,
          displayName: name,
          approvalStatus: 'new',
          analysisStatus: 'not_started',
          accountStatus: 'not_started',
          contactName: asString(params.contactName),
          email: asString(params.email),
          phone: asString(params.phone),
          website: asString(params.website),
          preferredContactMethod: asString(params.preferredContactMethod),
          nextFollowUpAt: asString(params.nextFollowUpAt),
          lastContactedAt: undefined,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    if (params.notes) {
      await this.recordComment({
        supplierId: asString(supplier.id),
        body: params.notes,
        commentType: 'note',
        actor: params.actor,
      });
    }
    return supplier;
  }

  async updateSupplierProfile(params: UpdateSupplierProfileParams) {
    const supplierId = asString(params.supplierId);
    if (!supplierId) throw new Error('Ecobase supplier profile update failed: supplierId is required.');
    await this.requireSupplier(supplierId);
    const values: PlainRecord = {
      updatedAt: new Date().toISOString(),
    };
    const fieldMap: Record<string, unknown> = {
      displayName: params.name,
      contactName: params.contactName,
      email: params.email,
      phone: params.phone,
      website: params.website,
      preferredContactMethod: params.preferredContactMethod,
      nextFollowUpAt: params.nextFollowUpAt,
      approvalStatus: params.approvalStatus,
      analysisStatus: params.analysisStatus,
      accountStatus: params.accountStatus,
    };
    Object.entries(fieldMap).forEach(([key, value]) => {
      const text = asString(value);
      if (text !== undefined) values[key] = text;
    });
    if (values.displayName) values.normalizedName = normalized(values.displayName);
    const updated = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).update({ filterByTk: supplierId, values }),
    );
    if (params.activityNotes) {
      await this.recordComment({ supplierId, body: params.activityNotes, commentType: 'note', actor: params.actor });
    }
    return updated;
  }

  async updateSupplierLifecycle(params: UpdateSupplierLifecycleParams) {
    const supplierId = asString(params.supplierId);
    if (!supplierId) throw new Error('Ecobase supplier lifecycle update failed: supplierId is required.');
    const status = requireStatus(asString(params.status));
    const supplier = await this.requireSupplier(supplierId);
    if (status === 'approved' && !supplierHasOrderedEvidence(supplier, await this.orderedSupplierKeys())) {
      await this.assertSupplierCanBeApproved(supplierId);
    }
    const now = new Date().toISOString();
    const updatedSupplier = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).update({
        filterByTk: supplierId,
        values: {
          approvalStatus: status,
          nextFollowUpAt: status === 'approved' || status === 'rejected' ? null : asString(params.followUpAt),
          updatedAt: now,
        },
      }),
    );
    await this.recordComment({
      supplierId,
      body: asString(params.comment) ?? `Supplier lifecycle changed to ${status}.`,
      commentType: 'status_update',
      followUpAt: asString(params.followUpAt),
      actor: params.actor,
    });
    return updatedSupplier;
  }

  async recordSupplierActivity(params: RecordSupplierActivityParams) {
    return this.recordComment({
      supplierId: params.supplierId,
      body: params.notes,
      commentType: params.activityType ?? 'note',
      followUpAt: params.nextFollowUpAt,
      actor: params.actor,
    });
  }

  async recordComment(params: RecordSupplierCommentParams) {
    const supplierId = asString(params.supplierId);
    const body = asString(params.body);
    if (!supplierId) throw new Error('Ecobase supplier comment failed: supplierId is required.');
    if (!body) throw new Error('Ecobase supplier comment failed: comment body is required.');
    await this.requireSupplier(supplierId);
    const now = new Date().toISOString();
    const comment = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
        values: {
          id: randomUUID(),
          entityType: 'supplier',
          entityId: supplierId,
          actorType: 'user',
          actorUserId: asString(params.actor),
          commentType: asString(params.commentType) ?? 'note',
          body,
          followUpAt: asString(params.followUpAt),
          contextSnapshotJson: {},
          workflowDetectionStatus: 'none',
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const supplierValues: PlainRecord = { updatedAt: now };
    if (params.followUpAt !== undefined) supplierValues.nextFollowUpAt = asString(params.followUpAt) ?? null;
    if (['contacted_supplier', 'status_update', 'note'].includes(asString(params.commentType) ?? 'note')) {
      supplierValues.lastContactedAt = now;
    }
    await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
      .update({ filterByTk: supplierId, values: supplierValues });
    return comment;
  }

  async deleteComment(params: DeleteSupplierCommentParams) {
    const commentId = asString(params.commentId);
    if (!commentId) throw new Error('Ecobase supplier comment delete failed: commentId is required.');
    return toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).update({
        filterByTk: commentId,
        values: { deletedAt: new Date().toISOString(), deletedByUserId: asString(params.actor) },
      }),
    );
  }

  async updateSupplierAccount(params: UpdateSupplierAccountParams) {
    const supplierId = asString(params.supplierId);
    if (!supplierId) throw new Error('Ecobase supplier account update failed: supplierId is required.');
    await this.requireSupplier(supplierId);
    const company = params.company ? await this.findCompany(params.company) : undefined;
    const accountRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts);
    const existing = toPlainRecord(
      await accountRepo.findOne({ filter: { supplierId, companyId: asString(company?.id) ?? null } }),
    );
    const values = {
      id: asString(existing.id) ?? randomUUID(),
      supplierId,
      companyId: asString(company?.id),
      accountName: asString(params.accountName) ?? asString(existing.accountName) ?? 'Supplier account',
      orderingMethod: asString(params.orderingMethod) ?? asString(existing.orderingMethod) ?? 'email',
      portalUrl: asString(params.portalUrl),
      username: asString(params.username),
      status: asString(params.status) ?? asString(existing.status) ?? 'pending',
    };
    const account = existing.id
      ? toPlainRecord(await accountRepo.update({ filterByTk: asString(existing.id), values }))
      : toPlainRecord(await accountRepo.create({ values }));
    await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).update({
      filterByTk: supplierId,
      values: { accountStatus: values.status, updatedAt: new Date().toISOString() },
    });
    await this.recordComment({
      supplierId,
      body: `Payment/account status updated to ${values.status}.`,
      commentType: 'status_update',
      actor: params.actor,
    });
    return account;
  }

  async upsertSupplierProduct(params: UpsertSupplierProductParams) {
    const supplierId = asString(params.supplierId);
    const productId = asString(params.productId);
    if (!supplierId) throw new Error('Ecobase supplier product update failed: supplierId is required.');
    if (!productId) throw new Error('Ecobase supplier product update failed: productId is required.');
    await this.requireSupplier(supplierId);
    const product = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).findOne({ filterByTk: productId }),
    );
    if (!product.id) throw new Error('Ecobase supplier product update failed: selected product was not found.');
    const leadTimeDays =
      params.leadTimeDays === undefined ? undefined : this.validatePositiveLeadTime(params.leadTimeDays);
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts);
    const existing = toPlainRecord(await repo.findOne({ filter: { supplierId, productId } }));
    const values: PlainRecord = {
      id: asString(existing.id) ?? randomUUID(),
      supplierId,
      productId,
      supplierSku: asString(params.supplierSku) ?? asString(existing.supplierSku),
      unitCost: asNumber(params.unitCost) ?? asNumber(existing.unitCost),
      moq: asNumber(params.moq) ?? asNumber(existing.moq),
      leadTimeDays: leadTimeDays ?? asNumber(existing.leadTimeDays),
      analysisStatus: asString(params.analysisStatus) ?? asString(existing.analysisStatus) ?? 'not_analyzed',
    };
    const row = existing.id
      ? toPlainRecord(await repo.update({ filterByTk: asString(existing.id), values }))
      : toPlainRecord(await repo.create({ values }));
    await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).update({
      filterByTk: supplierId,
      values: { analysisStatus: values.analysisStatus, updatedAt: new Date().toISOString() },
    });
    await this.recordComment({
      supplierId,
      body:
        asString(params.notes) ??
        `Product ${asString(product.asin) ?? asString(product.sku) ?? productId} marked ${values.analysisStatus}.`,
      commentType: 'product_review',
      actor: params.actor,
    });
    return row;
  }

  async updateSupplierProductLeadTime(params: UpdateSupplierProductLeadTimeParams) {
    const supplierId = asString(params.supplierId);
    if (!supplierId) throw new Error('Ecobase supplier lead-time update failed: supplierId is required.');
    const leadTimeDays = this.validatePositiveLeadTime(params.leadTimeDays);
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts);
    const existing = params.supplierProductId
      ? toPlainRecord(await repo.findOne({ filterByTk: asString(params.supplierProductId) }))
      : toPlainRecord(await repo.findOne({ filter: { supplierId, productId: asString(params.productId) } }));
    if (!existing.id) throw new Error('Ecobase supplier lead-time update failed: supplier product was not found.');
    const row = toPlainRecord(await repo.update({ filterByTk: asString(existing.id), values: { leadTimeDays } }));
    await this.recordComment({
      supplierId,
      body: asString(params.notes) ?? `Lead time confirmed at ${leadTimeDays} days.`,
      commentType: 'lead_time_checked',
      actor: params.actor,
    });
    return row;
  }

  async createSupplierOrder(params: CreateSupplierOrderParams) {
    const supplierId = asString(params.supplierId);
    if (!supplierId) throw new Error('Ecobase supplier order create failed: supplierId is required.');
    const supplier = await this.requireSupplier(supplierId);
    if (effectiveSupplierLifecycleStatus(supplier, await this.orderedSupplierKeys()) !== 'approved') {
      throw new Error('Ecobase supplier order create failed: supplier must be approved before ordering.');
    }
    const orderRef = asString(params.externalOrderRef);
    if (!orderRef) throw new Error('Ecobase supplier order create failed: externalOrderRef is required.');
    const company = params.company ? await this.findCompany(params.company) : undefined;
    const orderDate = asString(params.orderDate) ?? todayIso();
    return toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
        values: {
          id: randomUUID(),
          companyId: asString(company?.id),
          supplierId,
          orderRef,
          orderDate,
          dailySequenceLetter: orderRef.slice(-1) || 'A',
          orderIntent: 'manual',
          lifecycleStatus: validateSupplierOrderStatus(params.status),
          expectedDeliveryDate: asString(params.expectedDeliveryDate),
          remarks: asString(params.notes),
        },
      }),
    );
  }

  async supplierOptions(params: { search?: string; limit?: number } = {}) {
    const needle = normalized(params.search);
    const orderedSupplierKeys = await this.orderedSupplierKeys();
    return (await repoRows(this.db, ECOBASE_COLLECTIONS.silverSuppliers, params.limit ?? 50))
      .filter((supplier) => !needle || normalized(supplier.displayName).includes(needle))
      .map((supplier) => ({
        value: supplier.id,
        label: supplier.displayName,
        status: effectiveSupplierLifecycleStatus(supplier, orderedSupplierKeys),
      }));
  }

  async productOptions(params: { search?: string; limit?: number } = {}) {
    const needle = normalized(params.search);
    return (await repoRows(this.db, ECOBASE_COLLECTIONS.silverProducts, params.limit ?? 50))
      .filter(
        (product) =>
          !needle ||
          [product.asin, product.sku, product.title, product.brand].some((value) => normalized(value).includes(needle)),
      )
      .map((product) => ({
        value: product.id,
        label: [product.asin, product.sku, product.title].filter(Boolean).join(' · '),
        asin: product.asin,
        sku: product.sku,
        title: product.title,
      }));
  }

  async orderOptions(params: { supplierId?: string; search?: string; limit?: number } = {}) {
    const needle = normalized(params.search);
    return (await repoRows(this.db, ECOBASE_COLLECTIONS.silverOrders, params.limit ?? 50))
      .filter((order) => !params.supplierId || asString(order.supplierId) === params.supplierId)
      .filter(
        (order) =>
          !needle ||
          [order.orderRef, order.lifecycleStatus, order.canonicalStatus].some((value) =>
            normalized(value).includes(needle),
          ),
      )
      .map((order) => ({
        value: order.id,
        label: order.orderRef,
        status: order.lifecycleStatus ?? order.canonicalStatus,
      }));
  }

  private async buildDigestRows(filters: SupplierAttentionFilters) {
    const calculationDate = asString(filters.calculationDate) ?? todayIso();
    const [
      suppliers,
      rawInventoryRows,
      rawOrderRows,
      silverOrders,
      supplierOrders,
      rawComments,
      accounts,
      supplierProducts,
    ] = await Promise.all([
      repoRows(this.db, ECOBASE_COLLECTIONS.silverSuppliers),
      repoRows(this.db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows),
      repoRows(this.db, ECOBASE_COLLECTIONS.goldOrderPlanningRows),
      repoRows(this.db, ECOBASE_COLLECTIONS.silverOrders),
      repoRows(this.db, ECOBASE_COLLECTIONS.supplierOrders),
      repoRows(this.db, ECOBASE_COLLECTIONS.silverActivityComments),
      repoRows(this.db, ECOBASE_COLLECTIONS.silverSupplierAccounts),
      repoRows(this.db, ECOBASE_COLLECTIONS.silverSupplierProducts),
    ]);
    const inventoryRows = rawInventoryRows.filter((row) => matchesCompany(row, filters.company));
    const orderRows = rawOrderRows.filter((row) => matchesCompany(row, filters.company));
    const orderedSupplierKeys = collectOrderedSupplierKeys([...silverOrders, ...supplierOrders, ...orderRows]);
    const comments = rawComments.filter((comment) => comment.entityType === 'supplier' && !comment.deletedAt);
    const commentsBySupplierId = indexByField(comments, 'entityId');
    const accountsBySupplierId = indexByField(accounts, 'supplierId');
    const productsBySupplierId = indexByField(supplierProducts, 'supplierId');
    const suppliersByKey = new Map<string, PlainRecord>();
    const groups = new Map<
      string,
      { supplier?: PlainRecord; inventoryRows: PlainRecord[]; orderRows: PlainRecord[] }
    >();

    for (const supplier of suppliers) {
      const key = supplierKey(supplier);
      if (!key) continue;
      groups.set(key, { supplier, inventoryRows: [], orderRows: [] });
      for (const lookupKey of supplierLookupKeys(supplier)) suppliersByKey.set(lookupKey, supplier);
    }
    for (const row of inventoryRows) {
      const supplier = findSupplierForRow(row, suppliersByKey);
      const key = supplier ? supplierKey(supplier) : rowSupplierKey(row);
      if (!key) continue;
      const group = groups.get(key) ?? { supplier, inventoryRows: [], orderRows: [] };
      group.supplier = group.supplier ?? supplier;
      group.inventoryRows.push(row);
      groups.set(key, group);
    }
    for (const row of orderRows) {
      const supplier = findSupplierForRow(row, suppliersByKey);
      const key = supplier ? supplierKey(supplier) : rowSupplierKey(row);
      if (!key) continue;
      const group = groups.get(key) ?? { supplier, inventoryRows: [], orderRows: [] };
      group.supplier = group.supplier ?? supplier;
      group.orderRows.push(row);
      groups.set(key, group);
    }

    return sortDigestRows(
      [...groups.entries()].map(([key, group]) => {
        const supplier = group.supplier ?? {};
        const supplierId = asString(supplier.id);
        const supplierName =
          asString(supplier.displayName) ??
          asString(group.inventoryRows[0]?.supplierName) ??
          asString(group.orderRows[0]?.supplierName) ??
          key;
        const supplierComments = supplierId ? commentsBySupplierId.get(supplierId) ?? [] : [];
        const latestComment = latestByDate(supplierComments, 'createdAt');
        const nextFollowUpAt = asString(supplier.nextFollowUpAt) ?? asString(latestComment?.followUpAt);
        const followState = followUpState(nextFollowUpAt, calculationDate);
        const supplierAccounts = supplierId ? accountsBySupplierId.get(supplierId) ?? [] : [];
        const supplierProductRows = supplierId ? productsBySupplierId.get(supplierId) ?? [] : [];
        const leadTimeIssueRows = group.inventoryRows.filter(
          (row) =>
            ['missing', 'stale', 'conflicting'].includes(asString(row.leadTimeFreshness) ?? '') ||
            ['missing_lead_time', 'stale_lead_time'].includes(asString(row.actionStatus) ?? ''),
        );
        const activeOrderRiskRows = group.orderRows.filter(isActiveOrderRiskRow);
        const staleOrderRows = activeOrderRiskRows.filter(
          (row) => Boolean(row.statusCheckRequired) || (asNumber(row.daysSinceLastActivity) ?? 0) >= 3,
        );
        const inventoryMoneyAtRisk = group.inventoryRows.reduce(
          (total, row) => total + riskMoney(row, ['estimatedProfitRisk', 'moneyAtRisk']),
          0,
        );
        const orderMoneyAtRisk = activeOrderRiskRows.reduce((total, row) => total + riskMoney(row, ['moneyAtRisk']), 0);
        const moneyAtRisk = inventoryMoneyAtRisk + orderMoneyAtRisk;
        const approvedProductCount = supplierProductRows.filter(
          (product) => asString(product.analysisStatus) === 'approved',
        ).length;
        const candidateProductCount = supplierProductRows.filter(
          (product) => asString(product.analysisStatus) !== 'approved',
        ).length;
        const lifecycleStatus = effectiveSupplierLifecycleStatus(supplier, orderedSupplierKeys);
        const priorityScore =
          moneyAtRisk +
          (followState === 'overdue' || followState === 'due_today' ? 10_000 : 0) +
          staleOrderRows.length * 3_000 +
          leadTimeIssueRows.length * 1_000 +
          (lifecycleStatus === 'payment_review'
            ? 800
            : lifecycleStatus === 'product_review'
              ? 600
              : lifecycleStatus === 'contacting'
                ? 300
                : 0);
        return {
          id: supplierId ?? `unresolved:${key}`,
          naturalKey: `gold-supplier-attention:${calculationDate}:${key}`,
          calculationDate,
          supplierId,
          supplierName,
          companyName: filters.company,
          lifecycleStatus,
          followUpState: followState,
          nextFollowUpAt,
          lastContactedAt: asString(supplier.lastContactedAt),
          lastComment: asString(latestComment?.body),
          latestCommentAt: asString(latestComment?.createdAt),
          moneyAtRisk,
          inventoryMoneyAtRisk,
          orderMoneyAtRisk,
          staleOrderCount: staleOrderRows.length,
          leadTimeIssueCount: leadTimeIssueRows.length,
          candidateProductCount,
          approvedProductCount,
          accountStatus: asString(supplier.accountStatus) ?? asString(supplierAccounts[0]?.status) ?? 'not_started',
          priorityScore,
          priority:
            priorityScore >= 10_000 || moneyAtRisk > 0
              ? 'urgent'
              : followState === 'overdue'
                ? 'needs_attention'
                : 'monitor',
          recommendedAction: this.recommendedAction({
            followState,
            staleOrderRows,
            leadTimeIssueRows,
            lifecycleStatus,
            supplier,
            moneyAtRisk,
          }),
          evidenceJson: {
            inventoryRowIds: group.inventoryRows.map((row) => row.id).filter(Boolean),
            orderRowIds: activeOrderRiskRows.map((row) => row.id).filter(Boolean),
            commentId: latestComment?.id,
          },
        };
      }),
    );
  }

  private summaryFromRows(rows: PlainRecord[]) {
    return {
      totalSuppliers: rows.length,
      contactToday: rows.filter((row) => ['due_today', 'overdue'].includes(asString(row.followUpState) ?? '')).length,
      overdueFollowUps: rows.filter((row) => row.followUpState === 'overdue').length,
      staleOrderSuppliers: rows.filter((row) => (asNumber(row.staleOrderCount) ?? 0) > 0).length,
      leadTimeIssueSuppliers: rows.filter((row) => (asNumber(row.leadTimeIssueCount) ?? 0) > 0).length,
      waitingApprovalSuppliers: rows.filter((row) =>
        ['product_review', 'payment_review'].includes(asString(row.lifecycleStatus) ?? ''),
      ).length,
      moneyAtRisk: rows.reduce((total, row) => total + (asNumber(row.moneyAtRisk) ?? 0), 0),
    };
  }

  private recommendedAction(input: {
    followState: FollowUpState;
    staleOrderRows: PlainRecord[];
    leadTimeIssueRows: PlainRecord[];
    lifecycleStatus: SupplierLifecycleStatus;
    supplier: PlainRecord;
    moneyAtRisk: number;
  }) {
    if (!asString(input.supplier.id)) return 'Resolve supplier mapping before contacting';
    if (input.followState === 'overdue' || input.followState === 'due_today') return 'Contact supplier today';
    if (input.staleOrderRows.length > 0) return 'Ask supplier for stale order update';
    if (input.leadTimeIssueRows.length > 0) return 'Confirm lead time for affected products';
    if (input.lifecycleStatus === 'new') return 'Start supplier outreach';
    if (input.lifecycleStatus === 'contacting') return 'Log response or schedule follow-up';
    if (input.lifecycleStatus === 'product_review') return 'Analyze supplier product profitability';
    if (input.lifecycleStatus === 'payment_review') return 'Confirm payment/account access';
    if (input.moneyAtRisk > 0) return 'Review supplier risk';
    return 'No action';
  }

  private async orderedSupplierKeys() {
    const [silverOrders, supplierOrders, goldOrderRows] = await Promise.all([
      repoRows(this.db, ECOBASE_COLLECTIONS.silverOrders),
      repoRows(this.db, ECOBASE_COLLECTIONS.supplierOrders),
      repoRows(this.db, ECOBASE_COLLECTIONS.goldOrderPlanningRows),
    ]);
    return collectOrderedSupplierKeys([...silverOrders, ...supplierOrders, ...goldOrderRows]);
  }

  private async orderedSupplierKeysForSupplier(supplierId: string) {
    const [silverOrders, supplierOrders, goldOrderRows] = await Promise.all([
      repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.silverOrders, { supplierId }),
      repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.supplierOrders, { supplierId }),
      repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.goldOrderPlanningRows, { supplierId }),
    ]);
    return collectOrderedSupplierKeys([...silverOrders, ...supplierOrders, ...goldOrderRows]);
  }

  private async approveSuppliersWithOrderEvidence() {
    const orderedSupplierKeys = await this.orderedSupplierKeys();
    const suppliers = await repoRows(this.db, ECOBASE_COLLECTIONS.silverSuppliers);
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers);
    let updatedCount = 0;
    for (const supplier of suppliers) {
      const storedStatus = requireStatus(asString(supplier.approvalStatus));
      if (storedStatus === 'approved' || storedStatus === 'rejected') continue;
      if (!supplierHasOrderedEvidence(supplier, orderedSupplierKeys)) continue;
      await repo.update({
        filterByTk: asString(supplier.id),
        values: { approvalStatus: 'approved', updatedAt: new Date().toISOString() },
      });
      updatedCount += 1;
    }
    return updatedCount;
  }

  private async requireSupplier(supplierId: string) {
    const supplier = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).findOne({ filterByTk: supplierId }),
    );
    if (!supplier.id) throw new Error('Ecobase supplier failed: supplier was not found.');
    return supplier;
  }

  private async assertSupplierCanBeApproved(supplierId: string) {
    const products = await this.productsForSupplier(supplierId);
    const accounts = await this.accountsForSupplier(supplierId);
    if (!products.some((product) => asString(product.analysisStatus) === 'approved')) {
      throw new Error('Ecobase supplier lifecycle update failed: approve at least one supplier product first.');
    }
    if (!accounts.some((account) => ['approved', 'active', 'confirmed'].includes(asString(account.status) ?? ''))) {
      throw new Error('Ecobase supplier lifecycle update failed: confirm supplier payment/account access first.');
    }
  }

  private async commentsForSupplier(supplierId: string) {
    return (
      await repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.silverActivityComments, {
        entityType: 'supplier',
        entityId: supplierId,
      })
    ).filter((comment) => !comment.deletedAt);
  }

  private async accountsForSupplier(supplierId: string) {
    return repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.silverSupplierAccounts, { supplierId });
  }

  private async productsForSupplier(supplierId: string) {
    return repoRowsFiltered(this.db, ECOBASE_COLLECTIONS.silverSupplierProducts, { supplierId });
  }

  private async findCompany(companyName: string) {
    const company = (await repoRows(this.db, ECOBASE_COLLECTIONS.silverCompanies)).find(
      (row) =>
        normalized(row.name) === normalized(companyName) || normalized(row.companyKey) === normalized(companyName),
    );
    if (!company) throw new Error(`Ecobase supplier account update failed: company "${companyName}" was not found.`);
    return company;
  }

  private rowBelongsToSupplier(row: PlainRecord, supplier: PlainRecord) {
    const rowSupplierId = asString(row.supplierId);
    if (rowSupplierId && rowSupplierId === asString(supplier.id)) return true;
    const rowSupplierName = normalized(row.supplierName);
    return Boolean(rowSupplierName && rowSupplierName === normalized(supplier.displayName));
  }

  private validatePositiveLeadTime(value: number | undefined) {
    const leadTimeDays = validateSupplierLeadTimeDays(value, 'Ecobase supplier lead-time update failed');
    if (!leadTimeDays || leadTimeDays <= 0) {
      throw new Error('Ecobase supplier lead-time update failed: leadTimeDays must be greater than zero.');
    }
    return leadTimeDays;
  }
}
