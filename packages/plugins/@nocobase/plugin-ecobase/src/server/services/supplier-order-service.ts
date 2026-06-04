import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from './import-service';

export const OPEN_SUPPLIER_ORDER_STATUSES = ['planned', 'po_placed', 'confirmed', 'preparing', 'shipped', 'blocked'];
export const CLOSED_SUPPLIER_ORDER_STATUSES = ['received', 'cancelled'];
const SUPPLIER_ORDER_STATUSES = [...OPEN_SUPPLIER_ORDER_STATUSES, ...CLOSED_SUPPLIER_ORDER_STATUSES];

export interface SupplierOrderImportWarning {
  code: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface SupplierOrderImportResult {
  handled: boolean;
  warnings: SupplierOrderImportWarning[];
  sample?: Record<string, unknown>;
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
  activityType: 'contacted_supplier' | 'status_update' | 'lead_time_checked' | 'note' | 'blocked' | 'unblocked';
  occurredAt?: string;
  actor?: string;
  notes?: string;
  nextFollowUpAt?: string;
  leadTimeDays?: number;
  source?: string;
}

export interface UpdateSupplierOrderLineOperatorFieldsParams {
  supplierOrderLineId: string | number;
  receivedQty?: number;
  expectedSellableDate?: string;
  actor?: string;
}

export interface UpdateSupplierOrderOperatorFieldsParams {
  supplierOrderId: string | number;
  status?: string;
  expectedDeliveryDate?: string;
  blockedReason?: string;
  actor?: string;
}

type PlainRecord = Record<string, unknown>;
type Filter = Record<string, unknown>;

type SupplierIdentityRecord = {
  company: string;
  supplierName: string;
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
  supplierName: string;
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
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
    return {
      sourceOrderLineRef: asString(plain.sourceOrderLineRef) ?? randomUUID(),
      asin: asString(plain.asin)?.toUpperCase(),
      sku: asString(plain.sku),
      brand: asString(plain.brand),
      orderedQty: asNumber(plain.orderedQty) ?? 0,
      receivedQty: asNumber(plain.receivedQty),
      unitCost: asNumber(plain.unitCost),
      expectedDeliveryDate: maybeIsoDate(plain.expectedDeliveryDate),
      expectedSellableDate: maybeIsoDate(plain.expectedSellableDate),
      expectedSellableDateSource: asString(plain.expectedSellableDateSource),
      leadTimeDays: asNumber(plain.leadTimeDays),
      rawStatus: asString(plain.rawStatus),
      observedAt: maybeIsoDateTime(plain.observedAt),
      payload: toImportPayload(plain),
    } satisfies SupplierOrderLineImport;
  });
}

export class EcobaseSupplierOrderService {
  constructor(private db: EcobaseDatabase) {}

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

  async reconcileAfterImport(importRunId: string) {
    const orderLineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const allLines = (await orderLineRepo.find()).map(toPlainRecord);
    const affectedPlanningProductIds = new Set<string>();

    for (const line of allLines) {
      const lineId = asString(line.id);
      if (!lineId) {
        continue;
      }
      const company = asString(line.company);
      if (!company) {
        continue;
      }

      const resolved = await this.resolvePlanningProduct({
        company,
        asin: asString(line.asin),
        sku: asString(line.sku),
      });

      const updateValues: PlainRecord = {};
      if (resolved.planningProductId) {
        updateValues.planningProductId = resolved.planningProductId;
        updateValues.unresolvedMapping = false;
        updateValues.mappingWarning = null;
        affectedPlanningProductIds.add(resolved.planningProductId);
      }

      const derived = await this.deriveExpectedSellableDate({
        line,
        order: await this.findSupplierOrder(asString(line.supplierOrderId) ?? ''),
      });
      Object.assign(updateValues, derived.values);

      if (Object.keys(updateValues).length > 0) {
        await orderLineRepo.update({ filterByTk: lineId, values: updateValues });
      }
    }

    const importedLines = (await orderLineRepo.find({ filter: { lastImportRunId: importRunId } })).map(toPlainRecord);
    importedLines.forEach((line) => {
      const planningProductId = asString(line.planningProductId);
      if (planningProductId) {
        affectedPlanningProductIds.add(planningProductId);
      }
    });

    for (const planningProductId of affectedPlanningProductIds) {
      await this.refreshSupplierProductLinks(planningProductId);
    }
  }

  async updateOrderOperatorFields(params: UpdateSupplierOrderOperatorFieldsParams) {
    if (!params.supplierOrderId) {
      throw new Error('Ecobase supplier-order update failed: supplierOrderId is required.');
    }
    if (!params.status && !params.expectedDeliveryDate && !params.blockedReason) {
      throw new Error('Ecobase supplier-order update failed: status, expectedDeliveryDate, or blockedReason is required.');
    }

    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const existing = toPlainRecord(await orderRepo.findOne({ filterByTk: params.supplierOrderId }));
    if (existing.id === undefined || existing.id === null) {
      throw new Error(`Ecobase supplier-order update failed: order "${params.supplierOrderId}" was not found.`);
    }

    const editedAt = new Date().toISOString();
    const values: PlainRecord = {
      lastOperatorEditAt: editedAt,
      lastOperatorActor: params.actor,
      lastMeaningfulUpdateAt: editedAt,
    };
    if (params.status) {
      if (!SUPPLIER_ORDER_STATUSES.includes(params.status)) {
        throw new Error(`Ecobase supplier-order update failed: status "${params.status}" is not supported.`);
      }
      values.status = params.status;
      values.statusSource = 'manual';
      values.statusUpdatedAt = editedAt;
    }
    if (params.expectedDeliveryDate) {
      values.expectedDeliveryDate = requireIsoDate(params.expectedDeliveryDate, 'expectedDeliveryDate');
      values.expectedDeliveryDateSource = 'manual';
    }
    if (params.blockedReason) {
      values.blockedReason = params.blockedReason;
    }

    await orderRepo.update({ filterByTk: params.supplierOrderId, values });
    return orderRepo.findOne({ filterByTk: params.supplierOrderId });
  }

  async updateLineOperatorFields(params: UpdateSupplierOrderLineOperatorFieldsParams) {
    if (!params.supplierOrderLineId) {
      throw new Error('Ecobase supplier-order line update failed: supplierOrderLineId is required.');
    }
    if (params.receivedQty === undefined && !params.expectedSellableDate) {
      throw new Error('Ecobase supplier-order line update failed: receivedQty or expectedSellableDate is required.');
    }

    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const existing = toPlainRecord(await lineRepo.findOne({ filterByTk: params.supplierOrderLineId }));
    if (existing.id === undefined || existing.id === null) {
      throw new Error(
        `Ecobase supplier-order line update failed: line "${params.supplierOrderLineId}" was not found.`,
      );
    }

    const values: PlainRecord = {
      lastOperatorEditAt: new Date().toISOString(),
      lastOperatorActor: params.actor,
    };
    if (params.receivedQty !== undefined) {
      values.receivedQty = params.receivedQty;
      values.receivedQtySource = 'manual';
    }
    if (params.expectedSellableDate) {
      values.expectedSellableDate = requireIsoDate(params.expectedSellableDate, 'expectedSellableDate');
      values.expectedSellableDateSource = 'manual';
      values.expectedSellableDateEvidence = {
        source: 'operator',
        actor: params.actor,
      };
      values.expectedSellableDateDerivedAt = new Date();
    }

    await lineRepo.update({ filterByTk: params.supplierOrderLineId, values });
    return lineRepo.findOne({ filterByTk: params.supplierOrderLineId });
  }

  async recordActivity(params: RecordSupplierOrderActivityParams) {
    if (!params.company) {
      throw new Error('Ecobase supplier-order activity failed: company is required.');
    }
    if (!params.supplierId) {
      throw new Error('Ecobase supplier-order activity failed: supplierId is required.');
    }

    const activityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities);
    const occurredAt = maybeIsoDateTime(params.occurredAt) ?? new Date().toISOString();
    const naturalKey = [
      params.company,
      params.supplierId,
      params.supplierOrderId ?? 'supplier',
      params.activityType,
      occurredAt,
      params.notes ?? '',
    ].join(':');

    const existing = await activityRepo.findOne({ filter: { naturalKey } });
    const values = {
      naturalKey,
      supplierOrderId: params.supplierOrderId,
      supplierId: params.supplierId,
      company: params.company,
      activityType: params.activityType,
      occurredAt,
      actor: params.actor,
      notes: params.notes,
      nextFollowUpAt: maybeIsoDateTime(params.nextFollowUpAt),
      leadTimeDays: params.leadTimeDays,
      source: params.source ?? 'manual',
      payload: {},
    };

    let record: unknown;
    const existingActivityId = asString(toPlainRecord(existing).id);
    if (existingActivityId) {
      await activityRepo.update({ filterByTk: existingActivityId, values });
      record = await activityRepo.findOne({ filterByTk: existingActivityId });
    } else {
      record = await activityRepo.create({ values: { id: randomUUID(), ...values } });
    }

    if (params.activityType === 'lead_time_checked' && typeof params.leadTimeDays === 'number') {
      const supplier = await this.db
        .getRepository(ECOBASE_COLLECTIONS.suppliers)
        .findOne({ filterByTk: params.supplierId });
      const supplierPlain = toPlainRecord(supplier);
      await this.upsertLeadTime({
        supplierId: params.supplierId,
        company: params.company,
        supplierName: asString(supplierPlain.name) ?? '(unknown supplier)',
        externalSupplierCode: asString(supplierPlain.supplierId),
        sourceConnectionId: asString(supplierPlain.sourceConnectionId) ?? 'manual',
        source: 'manual',
        leadTimeDays: params.leadTimeDays,
        confirmedAt: occurredAt,
        payload: { activityId: asString(toPlainRecord(record).id) },
        importRunId: asString(toPlainRecord(record).lastImportRunId) ?? 'manual-activity',
      });
    }

    return toPlainRecord(record);
  }

  async getCoverage(planningProductId: string, projectedStockoutDate?: string): Promise<SupplierOrderCoverageView> {
    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const lines = (await lineRepo.find({ filter: { planningProductId } })).map(toPlainRecord);
    const coverageLines: SupplierOrderCoverageLine[] = [];

    for (const line of lines) {
      const order = await this.findSupplierOrder(asString(line.supplierOrderId) ?? '');
      if (!order) {
        continue;
      }
      const status = asString(order.status) ?? 'planned';
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
    const sourceSystem = asString(data.sourceSystem);
    const sourceConnectionId = asString(data.sourceConnectionId);
    if (!company || !supplierName || !sourceSystem || !sourceConnectionId) {
      throw new Error(
        'Ecobase supplier identity import failed: company, supplierName, sourceSystem, and sourceConnectionId are required.',
      );
    }
    return {
      company,
      supplierName,
      externalSupplierCode: asString(data.externalSupplierCode),
      sourceSystem,
      observedAt: maybeIsoDateTime(data.observedAt) ?? new Date().toISOString(),
      sourceConnectionId,
      payload: toImportPayload(data),
      leadTimeDays: asNumber(data.leadTimeDays),
    };
  }

  private toSupplierOrderRecord(data: PlainRecord): SupplierOrderRecord {
    const company = asString(data.company);
    const supplierName = asString(data.supplierName);
    const sourceSystem = asString(data.sourceSystem);
    const sourceConnectionId = asString(data.sourceConnectionId);
    const externalOrderRef = asString(data.externalOrderRef);
    if (!company || !supplierName || !sourceSystem || !sourceConnectionId || !externalOrderRef) {
      throw new Error(
        'Ecobase supplier order import failed: company, supplierName, sourceSystem, sourceConnectionId, and externalOrderRef are required.',
      );
    }
    return {
      company,
      supplierName,
      externalSupplierCode: asString(data.externalSupplierCode),
      sourceSystem,
      sourceConnectionId,
      externalOrderRef,
      sourceStage: (asString(data.sourceStage) ?? 'purchase_order') as SupplierOrderRecord['sourceStage'],
      status: asString(data.status) ?? 'planned',
      approvalStatus: asString(data.approvalStatus),
      paymentStatus: asString(data.paymentStatus),
      shippingCarrier: asString(data.shippingCarrier),
      trackingId: asString(data.trackingId),
      expectedDeliveryDate: maybeIsoDate(data.expectedDeliveryDate),
      blockedReason: asString(data.blockedReason),
      orderDate: maybeIsoDate(data.orderDate),
      statusUpdatedAt: maybeIsoDateTime(data.statusUpdatedAt),
      lastMeaningfulUpdateAt: maybeIsoDateTime(data.lastMeaningfulUpdateAt),
      lines: toLineImportRecords(data.lines),
      payload: toImportPayload(data),
    };
  }

  private async importSupplierOrder(record: SupplierOrderRecord, importRunId: string) {
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

    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const orderNaturalKey = `supplier-order:${record.company}:${record.externalOrderRef}`;
    const existingOrder = toPlainRecord(await orderRepo.findOne({ filter: { naturalKey: orderNaturalKey } }));
    const existingOrderId = asString(existingOrder.id);
    const importedStatusUpdatedAt =
      record.statusUpdatedAt ??
      record.lastMeaningfulUpdateAt ??
      `${record.orderDate ?? isoDate(new Date())}T00:00:00.000Z`;

    const orderValues: PlainRecord = {
      naturalKey: orderNaturalKey,
      sourceConnectionId: record.sourceConnectionId,
      company: record.company,
      supplierId: asString(supplier.id),
      externalOrderRef: record.externalOrderRef,
      sourceStage: chooseStage(asString(existingOrder.sourceStage), record.sourceStage),
      approvalStatus: record.approvalStatus,
      paymentStatus: record.paymentStatus,
      shippingCarrier: record.shippingCarrier,
      trackingId: record.trackingId,
      orderDate: record.orderDate,
      lastMeaningfulUpdateAt: maxIsoDate([
        asString(existingOrder.lastMeaningfulUpdateAt),
        record.lastMeaningfulUpdateAt,
        importedStatusUpdatedAt,
      ]),
      payload: record.payload ?? {},
      lastImportRunId: importRunId,
    };

    if (asString(existingOrder.statusSource) !== 'manual' || !asString(existingOrder.lastOperatorEditAt)) {
      orderValues.status = record.status;
      orderValues.statusSource = 'import';
      orderValues.statusUpdatedAt = importedStatusUpdatedAt;
      orderValues.blockedReason = record.blockedReason;
    }

    if (
      asString(existingOrder.expectedDeliveryDateSource) !== 'manual' ||
      !asString(existingOrder.lastOperatorEditAt)
    ) {
      orderValues.expectedDeliveryDate = record.expectedDeliveryDate;
      orderValues.expectedDeliveryDateSource = record.expectedDeliveryDate ? 'import' : 'missing';
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
          status: record.status,
          statusSource: 'import',
          statusUpdatedAt: importedStatusUpdatedAt,
          expectedDeliveryDateSource: record.expectedDeliveryDate ? 'import' : 'missing',
        },
      });
    }
    const order = toPlainRecord(persistedOrder);
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
        supplierId: asString(supplier.id) ?? '',
        externalSupplierCode: record.externalSupplierCode,
        supplierName: record.supplierName,
        sourceConnectionId: record.sourceConnectionId,
        sourceStage: record.sourceStage,
        line,
      });
      warnings.push(...lineWarnings);
      if (typeof line.leadTimeDays === 'number') {
        await this.upsertLeadTime({
          supplierId: asString(supplier.id) ?? '',
          company: record.company,
          supplierName: record.supplierName,
          externalSupplierCode: record.externalSupplierCode,
          sourceConnectionId: record.sourceConnectionId,
          source: record.sourceSystem,
          leadTimeDays: line.leadTimeDays,
          confirmedAt: line.observedAt ?? importedStatusUpdatedAt,
          payload: line.payload ?? {},
          importRunId,
        });
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
    supplierName: string;
    sourceConnectionId: string;
    sourceStage: SupplierOrderRecord['sourceStage'];
    line: SupplierOrderLineImport;
  }) {
    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const existing = toPlainRecord(
      await lineRepo.findOne({
        filter: {
          naturalKey: `supplier-order-line:${asString(params.order.naturalKey)}:${params.line.sourceOrderLineRef}`,
        },
      }),
    );
    const lineId = asString(existing.id);
    const resolved = await this.resolvePlanningProduct({
      company: params.company,
      asin: params.line.asin,
      sku: params.line.sku,
    });
    const warnings: SupplierOrderImportWarning[] = [];
    if (resolved.warning) {
      warnings.push(resolved.warning);
    }

    const baseValues: PlainRecord = {
      naturalKey: `supplier-order-line:${asString(params.order.naturalKey)}:${params.line.sourceOrderLineRef}`,
      supplierOrderId: asString(params.order.id),
      company: params.company,
      supplierId: params.supplierId,
      planningProductId: resolved.planningProductId,
      asin: params.line.asin,
      sku: params.line.sku,
      brand: params.line.brand,
      orderedQty: params.line.orderedQty,
      expectedDeliveryDate: params.line.expectedDeliveryDate ?? asString(params.order.expectedDeliveryDate),
      unitCost: params.line.unitCost,
      sourceOrderLineRef: params.line.sourceOrderLineRef,
      sourceStage: params.sourceStage,
      observedAt: params.line.observedAt,
      unresolvedMapping: !resolved.planningProductId,
      mappingWarning: resolved.warning?.message,
      payload: params.line.payload ?? {},
      lastImportRunId: params.importRunId,
    };

    if (asString(existing.receivedQtySource) !== 'manual' || !asString(existing.lastOperatorEditAt)) {
      baseValues.receivedQty = params.line.receivedQty ?? 0;
      baseValues.receivedQtySource = 'import';
    }

    let persisted: unknown;
    if (lineId) {
      await lineRepo.update({ filterByTk: lineId, values: baseValues });
      persisted = await lineRepo.findOne({ filterByTk: lineId });
    } else {
      persisted = await lineRepo.create({
        values: {
          id: randomUUID(),
          ...baseValues,
          receivedQty: params.line.receivedQty ?? 0,
          receivedQtySource: 'import',
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
    if (existingSource === 'manual' && existingOperatorEditAt) {
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
          expectedSellableDateSource: params.importedLine?.expectedSellableDateSource ?? 'imported_arrival',
          expectedSellableDateEvidence: {
            precedence: 2,
            sourceOrderLineRef: asString(line.sourceOrderLineRef),
            importedExpectedSellableDate,
          },
          expectedSellableDateDerivedAt: new Date(),
        },
        warning: undefined,
      };
    }

    const expectedDeliveryDate = asString(line.expectedDeliveryDate) ?? asString(order.expectedDeliveryDate);
    if (expectedDeliveryDate) {
      return {
        values: {
          expectedSellableDate: addDays(expectedDeliveryDate, prepBufferDays),
          expectedSellableDateSource: 'po_delivery_plus_prep_buffer',
          expectedSellableDateEvidence: {
            precedence: 3,
            expectedDeliveryDate,
            prepBufferDays,
            supplierOrderId: asString(order.id),
          },
          expectedSellableDateDerivedAt: new Date(),
        },
        warning: undefined,
      };
    }

    const leadTime =
      params.importedLine?.leadTimeDays ??
      (await this.findLeadTime({
        supplierId: asString(line.supplierId) ?? asString(order.supplierId),
        company,
        externalSupplierCode: undefined,
      }));
    const baseDate = asString(order.orderDate) ?? asString(order.statusUpdatedAt)?.slice(0, 10);
    if (typeof leadTime === 'number' && baseDate) {
      return {
        values: {
          expectedSellableDate: addDays(baseDate, leadTime + prepBufferDays),
          expectedSellableDateSource: 'lead_time_plus_prep_buffer',
          expectedSellableDateEvidence: {
            precedence: 4,
            baseDate,
            leadTimeDays: leadTime,
            prepBufferDays,
            supplierOrderId: asString(order.id),
          },
          expectedSellableDateDerivedAt: new Date(),
        },
        warning: undefined,
      };
    }

    return {
      values: {
        expectedSellableDate: null,
        expectedSellableDateSource: 'missing',
        expectedSellableDateEvidence: {
          precedence: 5,
          supplierOrderId: asString(order.id),
          supplierOrderLineId: asString(line.id),
          prepBufferDays,
        },
        expectedSellableDateDerivedAt: new Date(),
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

  private async refreshSupplierProductLinks(planningProductId: string) {
    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const lineRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines);
    const linkRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks);
    const lines = (await lineRepo.find({ filter: { planningProductId } })).map(toPlainRecord);
    const historicalLines: Array<PlainRecord & { order: PlainRecord }> = [];

    for (const line of lines) {
      const order = await orderRepo.findOne({ filterByTk: asString(line.supplierOrderId) });
      const orderPlain = toPlainRecord(order);
      if (asString(orderPlain.sourceStage) !== 'order_detail') {
        continue;
      }
      historicalLines.push({ ...line, order: orderPlain });
    }

    const existingLinks = (await linkRepo.find({ filter: { planningProductId } })).map(toPlainRecord);
    const preferredLinks = existingLinks.filter(
      (link) => asString(link.role) === 'preferred' && asBoolean(link.active) !== false,
    );
    const preferredSupplierId = asString(preferredLinks[0]?.supplierId);

    for (const link of existingLinks) {
      const linkId = asString(link.id);
      if (linkId && ['candidate', 'latest_history', 'discovered'].includes(asString(link.role) ?? '')) {
        await linkRepo.update({ filterByTk: linkId, values: { active: false, lastImportRunId: link.lastImportRunId } });
      }
    }

    if (historicalLines.length === 0) {
      return;
    }

    const company = asString(historicalLines[0]?.company) ?? asString(historicalLines[0]?.order.company) ?? '';
    const groups = new Map<string, PlainRecord[]>();
    for (const line of historicalLines) {
      const supplierId = asString(line.supplierId);
      if (!supplierId) {
        continue;
      }
      const group = groups.get(supplierId) ?? [];
      group.push(line);
      groups.set(supplierId, group);
    }

    const observedDate = (line: PlainRecord) => asString(line.observedAt) ?? asString(toPlainRecord(line.order).orderDate);
    const latestLine = [...historicalLines].sort((left, right) => {
      const leftObserved = observedDate(left) ?? '';
      const rightObserved = observedDate(right) ?? '';
      return rightObserved.localeCompare(leftObserved);
    })[0];
    const latestSupplierId = asString(latestLine?.supplierId);

    for (const [supplierId, supplierLines] of groups.entries()) {
      const sorted = [...supplierLines].sort((left, right) => {
        const leftObserved = observedDate(left) ?? '';
        const rightObserved = observedDate(right) ?? '';
        return leftObserved.localeCompare(rightObserved);
      });
      const firstLine = sorted[0];
      const lastLine = sorted[sorted.length - 1];
      const lastObservedAt = observedDate(lastLine) ?? undefined;
      const role = supplierId === latestSupplierId ? 'latest_history' : 'candidate';
      await this.upsertSupplierProductLink({
        company,
        planningProductId,
        supplierId,
        role,
        source: 'order_details',
        confidence: supplierId === latestSupplierId ? 'high' : 'medium',
        firstOrderedAt: observedDate(firstLine),
        lastOrderedAt: lastObservedAt,
        orderCount: sorted.length,
        lastUnitCost: asNumber(lastLine.unitCost),
        latestBrand: asString(lastLine.brand),
        active: true,
        importPayload: {
          supplierOrderLineIds: sorted.map((line) => asString(line.id)),
          supplierOrderIds: sorted.map((line) => asString(line.supplierOrderId)),
        },
      });
    }

    if (latestSupplierId && preferredSupplierId && latestSupplierId !== preferredSupplierId) {
      await this.upsertSupplierProductLink({
        company,
        planningProductId,
        supplierId: latestSupplierId,
        role: 'discovered',
        source: 'order_details',
        confidence: 'medium',
        firstOrderedAt: latestLine ? observedDate(latestLine) : undefined,
        lastOrderedAt: latestLine ? observedDate(latestLine) : undefined,
        orderCount: 1,
        lastUnitCost: asNumber(latestLine?.unitCost),
        latestBrand: asString(latestLine?.brand),
        active: true,
        importPayload: { latestHistorySupplierId: latestSupplierId, preferredSupplierId },
      });
    }
  }

  private async upsertSupplierProductLink(params: {
    company: string;
    planningProductId: string;
    supplierId: string;
    role: string;
    source: string;
    confidence: string;
    firstOrderedAt?: string;
    lastOrderedAt?: string;
    orderCount: number;
    lastUnitCost?: number;
    latestBrand?: string;
    active: boolean;
    importPayload: PlainRecord;
  }) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierProductLinks);
    const naturalKey = `supplier-product-link:${params.company}:${params.planningProductId}:${params.supplierId}:${params.role}:${params.source}`;
    const existing = toPlainRecord(await repo.findOne({ filter: { naturalKey } }));
    const values = {
      naturalKey,
      company: params.company,
      planningProductId: params.planningProductId,
      supplierId: params.supplierId,
      role: params.role,
      source: params.source,
      confidence: params.confidence,
      firstOrderedAt: params.firstOrderedAt ? isoDateTime(params.firstOrderedAt) : undefined,
      lastOrderedAt: params.lastOrderedAt ? isoDateTime(params.lastOrderedAt) : undefined,
      orderCount: params.orderCount,
      lastUnitCost: params.lastUnitCost,
      latestBrand: params.latestBrand,
      active: params.active,
      evidence: params.importPayload,
      payload: params.importPayload,
    };

    if (asString(existing.id)) {
      await repo.update({ filterByTk: asString(existing.id), values });
      return;
    }
    await repo.create({ values });
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
        } satisfies SupplierOrderImportWarning,
      };
    }

    const productRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    const listingRepo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings);
    const matchingProducts = (await productRepo.find({ filter: { company: params.company } }))
      .map(toPlainRecord)
      .filter((product) => asString(product.canonicalAsin) === params.asin);

    if (matchingProducts.length === 1) {
      return { planningProductId: asString(matchingProducts[0].id), warning: undefined };
    }

    if (matchingProducts.length > 1) {
      return {
        planningProductId: undefined,
        warning: {
          code: 'planning_product_mapping_ambiguous',
          message: `Ecobase supplier-order import found multiple planning products for ${params.company}/${params.asin}.`,
          payload: { company: params.company, asin: params.asin, sku: params.sku },
        } satisfies SupplierOrderImportWarning,
      };
    }

    const matchingListings = (await listingRepo.find({ filter: { company: params.company } }))
      .map(toPlainRecord)
      .filter((listing) => {
        const listingAsin = asString(listing.canonicalAsin) ?? asString(listing.asin);
        const listingSku = asString(listing.sku);
        return listingAsin === params.asin || (!!params.sku && listingSku === params.sku);
      });

    const planningProductIds = uniqueStrings(matchingListings.map((listing) => asString(listing.planningProductId)));
    if (planningProductIds.length === 1) {
      return { planningProductId: planningProductIds[0], warning: undefined };
    }

    if (planningProductIds.length > 1) {
      return {
        planningProductId: undefined,
        warning: {
          code: 'planning_product_mapping_ambiguous',
          message: `Ecobase supplier-order import found multiple planning product listings for ${params.company}/${
            params.asin ?? params.sku
          }.`,
          payload: { company: params.company, asin: params.asin, sku: params.sku, planningProductIds },
        } satisfies SupplierOrderImportWarning,
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
      } satisfies SupplierOrderImportWarning,
    };
  }

  private async findOrCreateSupplier(identity: SupplierIdentityRecord, importRunId: string) {
    const supplierRepo = this.db.getRepository(ECOBASE_COLLECTIONS.suppliers);
    const identityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierExternalIdentities);
    const normalizedSupplierName = normalizeName(identity.supplierName);
    const identityNaturalKey = identity.externalSupplierCode
      ? `supplier-identity:${identity.company}:${identity.sourceSystem}:code:${identity.externalSupplierCode}`
      : `supplier-identity:${identity.company}:${identity.sourceSystem}:name:${normalizedSupplierName}`;
    const existingIdentity = toPlainRecord(await identityRepo.findOne({ filter: { naturalKey: identityNaturalKey } }));
    let supplier = existingIdentity.supplierId
      ? toPlainRecord(await supplierRepo.findOne({ filterByTk: asString(existingIdentity.supplierId) }))
      : {};

    if (!asString(supplier.id)) {
      supplier =
        (await supplierRepo.find({ filter: { company: identity.company } }))
          .map(toPlainRecord)
          .find((record) => normalizeName(asString(record.name) ?? '') === normalizedSupplierName) ?? {};
    }

    if (!asString(supplier.id)) {
      supplier = toPlainRecord(
        await supplierRepo.create({
          values: {
            id: randomUUID(),
            naturalKey: `supplier:${identity.company}:${normalizedSupplierName}`,
            sourceConnectionId: identity.sourceConnectionId,
            supplierId: identity.externalSupplierCode,
            name: identity.supplierName,
            normalizedName: normalizedSupplierName,
            company: identity.company,
            active: true,
            lastSeenAt: identity.observedAt,
            payload: identity.payload ?? {},
            lastImportRunId: importRunId,
          },
        }),
      );
    } else {
      await supplierRepo.update({
        filterByTk: asString(supplier.id),
        values: {
          sourceConnectionId: identity.sourceConnectionId,
          supplierId: asString(supplier.supplierId) ?? identity.externalSupplierCode,
          name: asString(supplier.name) ?? identity.supplierName,
          normalizedName: normalizedSupplierName,
          company: identity.company,
          active: true,
          lastSeenAt: identity.observedAt,
          payload: identity.payload ?? {},
          lastImportRunId: importRunId,
        },
      });
      supplier = toPlainRecord(await supplierRepo.findOne({ filterByTk: asString(supplier.id) }));
    }

    const identityValues = {
      naturalKey: identityNaturalKey,
      supplierId: asString(supplier.id),
      company: identity.company,
      sourceSystem: identity.sourceSystem,
      externalSupplierCode: identity.externalSupplierCode,
      externalSupplierName: identity.supplierName,
      normalizedExternalSupplierName: normalizedSupplierName,
      firstSeenAt: asString(existingIdentity.firstSeenAt) ?? identity.observedAt,
      lastSeenAt: identity.observedAt,
      active: true,
      payload: identity.payload ?? {},
      lastImportRunId: importRunId,
    };
    if (asString(existingIdentity.id)) {
      await identityRepo.update({ filterByTk: asString(existingIdentity.id), values: identityValues });
    } else {
      await identityRepo.create({ values: identityValues });
    }

    return supplier;
  }

  private async upsertLeadTime(params: {
    supplierId: string;
    company: string;
    supplierName: string;
    externalSupplierCode?: string;
    sourceConnectionId: string;
    source: string;
    leadTimeDays: number;
    confirmedAt: string;
    payload: PlainRecord;
    importRunId: string;
  }) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes);
    const naturalKey = `supplier-lead-time:${params.company}:${params.supplierId}`;
    const existing = toPlainRecord(await repo.findOne({ filter: { naturalKey } }));
    const values = {
      naturalKey,
      sourceConnectionId: params.sourceConnectionId,
      supplierId: params.externalSupplierCode,
      supplierRefId: params.supplierId,
      supplierName: params.supplierName,
      company: params.company,
      leadTimeDays: params.leadTimeDays,
      confirmedAt: params.confirmedAt,
      source: params.source,
      notes: undefined,
      payload: params.payload,
      lastImportRunId: params.importRunId,
    };
    if (asString(existing.id)) {
      await repo.update({ filterByTk: asString(existing.id), values });
      return;
    }
    await repo.create({ values });
  }

  private async findLeadTime(params: { supplierId?: string; company?: string; externalSupplierCode?: string }) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes);
    const rows = (await repo.find()).map(toPlainRecord);
    const bySupplierRef = rows.find(
      (row) => asString(row.company) === params.company && asString(row.supplierRefId) === params.supplierId,
    );
    if (typeof asNumber(bySupplierRef?.leadTimeDays) === 'number') {
      return asNumber(bySupplierRef?.leadTimeDays);
    }
    const byExternalCode = rows.find(
      (row) => asString(row.company) === params.company && asString(row.supplierId) === params.externalSupplierCode,
    );
    return asNumber(byExternalCode?.leadTimeDays);
  }

  private async resolveContactRecency(params: { company: string; supplierId: string; supplierOrderId?: string }) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities);
    const activities = (await repo.find({ filter: { company: params.company, supplierId: params.supplierId } }))
      .map(toPlainRecord)
      .filter((activity) => asString(activity.activityType) === 'contacted_supplier');

    const orderSpecific = activities
      .filter((activity) => asString(activity.supplierOrderId) === params.supplierOrderId)
      .sort((left, right) => (asString(right.occurredAt) ?? '').localeCompare(asString(left.occurredAt) ?? ''))[0];
    if (orderSpecific) {
      return {
        occurredAt: asString(orderSpecific.occurredAt) ?? '',
        notes: asString(orderSpecific.notes),
        source: 'order' as const,
        activityId: asString(orderSpecific.id) ?? '',
      };
    }

    const supplierLevel = activities
      .filter((activity) => !asString(activity.supplierOrderId))
      .sort((left, right) => (asString(right.occurredAt) ?? '').localeCompare(asString(left.occurredAt) ?? ''))[0];
    if (!supplierLevel) {
      return null;
    }
    return {
      occurredAt: asString(supplierLevel.occurredAt) ?? '',
      notes: asString(supplierLevel.notes),
      source: 'supplier' as const,
      activityId: asString(supplierLevel.id) ?? '',
    };
  }

  private async findSupplierOrder(orderId: string) {
    if (!orderId) {
      return null;
    }
    const order = await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).findOne({ filterByTk: orderId });
    return order ? toPlainRecord(order) : null;
  }
}
