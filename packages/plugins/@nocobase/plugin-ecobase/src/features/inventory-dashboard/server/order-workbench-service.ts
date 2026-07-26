/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Order workbench service (Order Create/View UI, T3).
 *
 * A single deep module owning order CRUD for the Inventory Dashboard. Action
 * wrappers stay thin: validate the shape, call one method here, map the typed
 * error to an HTTP status. Business math lives in ./order-workbench-compute
 * (pure, unit-tested); the supplier-product upsert + line write is reused from
 * supplier-management's EcobaseSupplierOrderService.createOrderLine, and the
 * canonical ref algorithm from semantic-model's generateOrderRef. Dependency
 * boundary: cross-feature imports are allowlisted by the AD-1 test.
 */

import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';
import {
  EcobaseMedallionOrderService,
  ORDER_REF_PREFIX_BY_COMPANY_KEY,
} from '../../semantic-model/server/medallion-order-service';
import { normalizeCompanyKey } from '../../semantic-model/server/medallion-identity-service';
import { EcobaseSupplierOrderService } from '../../supplier-management/server/supplier-order-service';
import { amazonReceivedQty } from '../../supplier-management/server/silver-supplier-order-read-model';
import {
  ORDER_LIFECYCLE_STATUS_METADATA,
  ORDER_LIFECYCLE_STATUS_OPTIONS,
  canonicalOrderLifecycleStatus,
  isCompleteLifecycleStatus,
} from '../../order-planning/order-lifecycle-status';
import {
  computeLineExpectedCost,
  computeLineMargin,
  computeOrderMoneyAtRisk,
  deriveOrderAttention,
  deriveOrderPaperworkMilestones,
  deriveOrderPrepMilestones,
  deriveStatusWrite,
  normalizeOrderRef,
  orderArrivalDetected,
  requireValidOrderRef,
  resolveDaysSince,
  sumExpectedCost,
  trailingSequenceLetter,
  type OrderAttentionReason,
  type OrderAttentionThresholds,
  type OrderPaperworkMilestones,
  type OrderPrepMilestones,
  type OrderRiskProduct,
} from './order-workbench-compute';
import { EcobaseInboundEntryBaselineStamper } from './engine/inbound-entry-baseline';
import { PublishedGoldReader, type DashboardDatabase } from './published-gold-reader';
import { EcobasePlanningSettingsService } from '../../../server/services/planning-settings-service';

type PlainRecord = Record<string, unknown>;

/** Manual order intents that own their row and may be hard-deleted. */
const MANUAL_ORDER_INTENTS = new Set(['manual', 'operator_draft']);

/** Author label when a comment's actor id resolves to no known user (T8). */
const DEFAULT_COMMENT_AUTHOR = 'Operator';

/** Line fields the operator may edit via updateOrderLine (T3 #6). */
const LINE_EDITABLE_FIELDS = [
  'orderedQty',
  'unitCost',
  'supplierPackSize',
  'expectedSellPrice',
  'expectedMargin',
  'expectedDeliveryDate',
  'expectedSellableDate',
  'priority',
] as const;

/** Whitelisted prep-detail fields accepted by updatePrepDetails (T2.3). */
const PREP_DETAIL_FIELDS: ReadonlySet<string> = new Set([
  'prepBoxes',
  'prepCartons',
  'prepUnits',
  'prepDimensions',
  'prepWeightValue',
  'prepWeightUnit',
  'hazmatFlag',
  'shippingId',
  'labelFilesLink',
  'prepStatus',
]);

/** The three order panes served by paneOrders (T2.5). */
export const ORDER_PANE_KEYS = ['activeOrders', 'inPrepMonitoring', 'inboundMonitoring'] as const;
export type OrderPaneKey = (typeof ORDER_PANE_KEYS)[number];

export function isOrderPaneKey(value: unknown): value is OrderPaneKey {
  return typeof value === 'string' && (ORDER_PANE_KEYS as readonly string[]).includes(value);
}

export interface OrderPaneInboundBuckets {
  orderedUnits: number;
  arrivedUnits: number;
  arrivalDetected: boolean;
  alreadyConfirmed: boolean;
}

export interface OrderPaneRow {
  orderId: string;
  orderRef?: string;
  companyName?: string;
  sourceMarketplace?: string;
  supplierName?: string;
  supplierShipDestination: 'direct_fba' | 'prep_center' | null;
  lifecycleStatus?: string;
  paperwork: OrderPaperworkMilestones;
  prep: OrderPrepMilestones;
  inbound: OrderPaneInboundBuckets;
  expectedCost?: number;
  actualCost?: number;
  units: number;
  daysInStatus: number | null;
  daysInPane: number | null;
  lastActivity: { at: string; body: string } | null;
  moneyAtRisk: number;
  atRiskProductCount: number;
  productCount: number;
  moneyAtRiskPastSafe: boolean;
  attention: { flagged: boolean; reason: OrderAttentionReason };
}

export interface OrderPaneResponse {
  pane: OrderPaneKey;
  publishedRunId: string;
  rows: OrderPaneRow[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface OrderPaneRunSuperseded {
  runSuperseded: true;
  publishedRunId: string;
}

export type OrderPaneResult = OrderPaneResponse | OrderPaneRunSuperseded;

export function isOrderPaneRunSuperseded(value: OrderPaneResult): value is OrderPaneRunSuperseded {
  return (value as OrderPaneRunSuperseded).runSuperseded === true;
}

export class OrderWorkbenchError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'OrderWorkbenchError';
  }
}

export interface OrderLineInput {
  companyProductId: string;
  orderedQty: number;
  unitCost?: number;
  supplierPackSize?: number;
  expectedSellPrice?: number;
  expectedMargin?: number;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  priority?: string;
}

export interface CreateOrderInput {
  companyId?: string;
  orderRef?: string;
  orderDate?: string;
  supplierId?: string;
  sourceMarketplace?: string;
  paymentStatus?: string;
  paymentMode?: string;
  paymentDate?: string;
  invoiceStatus?: string;
  attachmentReference?: string;
  shippingCarrier?: string;
  trackingId?: string;
  expectedDeliveryDate?: string;
  remarks?: string;
  lines?: OrderLineInput[];
  actorUserId?: string;
  actorDisplayName?: string;
}

export class EcobaseOrderWorkbenchService {
  private readonly medallion: EcobaseMedallionOrderService;
  private readonly supplierOrders: EcobaseSupplierOrderService;

  constructor(private readonly db: EcobaseDatabase) {
    this.medallion = new EcobaseMedallionOrderService(db);
    this.supplierOrders = new EcobaseSupplierOrderService(db);
  }

  // ---- 1. prepareOrderDraft -------------------------------------------------

  async prepareOrderDraft(params: { planningProductId?: string; company?: string }) {
    const companyProduct = await this.requireCompanyProduct(params.planningProductId);
    const companyId = asString(companyProduct.companyId);
    if (!companyId) throw new OrderWorkbenchError('Selected product is not linked to a company.');
    const [company, product] = await Promise.all([
      this.findRecord(ECOBASE_COLLECTIONS.silverCompanies, companyId),
      this.findRecord(ECOBASE_COLLECTIONS.silverProducts, asString(companyProduct.productId)),
    ]);
    const orderDate = todayIso();
    const suggested = await this.medallion.generateOrderRef(companyId, orderDate);
    const supplierDefault =
      (await this.defaultSupplierForProduct(asString(companyProduct.productId))) ??
      (await this.familyPreferredSupplier(asString(companyProduct.companyProductFamilyId)));
    return {
      companyId,
      companyName: asString(company.name),
      companyKey: orderRefPrefix(asString(company.companyKey)),
      orderDate,
      suggestedOrderRef: suggested.orderRef,
      product: {
        companyProductId: asString(companyProduct.id),
        title: asString(product.title),
        asin: asString(product.asin),
        sku: asString(product.sku),
        brand: asString(product.brand),
      },
      supplierDefault,
    };
  }

  // ---- 2. checkOrderRef -----------------------------------------------------

  async checkOrderRef(params: { companyId?: string; orderRef?: string; excludeOrderId?: string }) {
    const companyId = asString(params.companyId);
    if (!companyId) throw new OrderWorkbenchError('companyId is required.');
    const normalized = requireValidOrderRef(params.orderRef);
    const available = await this.isOrderRefAvailable(companyId, normalized, params.excludeOrderId);
    return { normalized, available };
  }

  // ---- 3. createOrder -------------------------------------------------------

  async createOrder(input: CreateOrderInput) {
    const lines = input.lines ?? [];
    if (lines.length === 0) throw new OrderWorkbenchError('An order needs at least one product line.');

    // Resolve company either from the payload or from the first line's product.
    const firstProduct = await this.requireCompanyProduct(lines[0]?.companyProductId);
    const companyId = asString(input.companyId) ?? asString(firstProduct.companyId);
    if (!companyId) throw new OrderWorkbenchError('companyId is required.');

    const supplierId = asString(input.supplierId);
    if (!supplierId) throw new OrderWorkbenchError('A supplier is required.');
    await this.requireSupplierForCompany(supplierId, companyId);

    const company = await this.findRecord(ECOBASE_COLLECTIONS.silverCompanies, companyId);
    const companyKey = orderRefPrefix(asString(company.companyKey));
    const orderDate = normalizeDateOnly(input.orderDate) ?? todayIso();

    // Ref: operator value if given, else generate the next free canonical letter.
    const orderRef = input.orderRef
      ? requireValidOrderRef(input.orderRef)
      : (await this.medallion.generateOrderRef(companyId, orderDate)).orderRef;
    if (!(await this.isOrderRefAvailable(companyId, orderRef))) {
      throw new OrderWorkbenchError(`Order reference ${orderRef} is already used for this company.`, 409);
    }

    // Validate every line's product belongs to the company up-front.
    const validatedLines = await Promise.all(
      lines.map(async (line, index) => {
        const companyProduct = await this.requireCompanyProduct(line.companyProductId);
        if (asString(companyProduct.companyId) !== companyId) {
          throw new OrderWorkbenchError(`Line ${index + 1}: product belongs to a different company.`);
        }
        if (!Number.isFinite(line.orderedQty) || line.orderedQty <= 0) {
          throw new OrderWorkbenchError(`Line ${index + 1}: quantity must be greater than zero.`);
        }
        return line;
      }),
    );

    const now = new Date().toISOString();
    const orderId = randomUUID();
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).create({
      values: cleanValues({
        id: orderId,
        companyId,
        supplierId,
        orderRef,
        orderDate,
        dailySequenceLetter: trailingSequenceLetter(orderRef, companyKey, orderDate),
        orderIntent: 'manual',
        lifecyclePhase: 'manual',
        lifecycleStatus: 'draft',
        canonicalStatus: 'draft',
        statusSource: 'operator',
        operatorStatusOverrideAt: now,
        // NocoBase user ids are integers while these legacy columns are uuid-typed;
        // the actor is always recorded in statusEvidenceJson + placedBy instead.
        operatorStatusOverrideByUserId: uuidOrUndefined(input.actorUserId),
        statusEvidenceJson: {
          source: 'order_workbench',
          createdAt: now,
          actorUserId: input.actorUserId,
          actorName: input.actorDisplayName,
        },
        createdByUserId: uuidOrUndefined(input.actorUserId),
        placedBy: input.actorDisplayName,
        sourceMarketplace: input.sourceMarketplace,
        paymentStatus: input.paymentStatus,
        paymentMode: input.paymentMode,
        paymentDate: normalizeDateOnly(input.paymentDate),
        invoiceStatus: input.invoiceStatus,
        attachmentReference: input.attachmentReference,
        shippingCarrier: input.shippingCarrier,
        trackingId: input.trackingId,
        expectedDeliveryDate: normalizeDateOnly(input.expectedDeliveryDate),
        expectedCost: sumExpectedCost(validatedLines),
        remarks: input.remarks,
        fulfillmentRoute: 'unknown',
      }),
    });

    // Atomic-by-compensation: if any line insert fails (e.g. a DB check
    // constraint), remove the freshly created header + partial lines so no
    // orphan draft order survives and the generated ref stays reusable.
    try {
      for (const line of validatedLines) {
        await this.insertLine(orderId, line, input.actorUserId);
      }
    } catch (error) {
      await this.repo(ECOBASE_COLLECTIONS.silverOrderLines)
        .destroy({ filter: { orderId } })
        .catch(() => undefined);
      await this.repo(ECOBASE_COLLECTIONS.silverOrders)
        .destroy({ filterByTk: orderId })
        .catch(() => undefined);
      throw error instanceof OrderWorkbenchError
        ? error
        : new OrderWorkbenchError(error instanceof Error ? error.message : 'Order line creation failed.');
    }

    return this.getOrderDetail({ orderId });
  }

  // ---- 4. getOrderDetail ----------------------------------------------------

  async getOrderDetail(params: { orderId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    const [company, supplier, supplierRef] = await Promise.all([
      this.findRecord(ECOBASE_COLLECTIONS.silverCompanies, asString(order.companyId)),
      this.findRecord(ECOBASE_COLLECTIONS.silverSuppliers, asString(order.supplierId)),
      this.latestSupplierExternalRef(asString(order.supplierId)),
    ]);
    const lineRows = (await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).find({ filter: { orderId } })).map(
      toPlainRecord,
    );
    const companyProducts = await this.mapByIds(
      ECOBASE_COLLECTIONS.silverCompanyProducts,
      lineRows.map((line) => asString(line.companyProductId)),
    );
    const products = await this.mapByIds(
      ECOBASE_COLLECTIONS.silverProducts,
      [...companyProducts.values()].map((companyProduct) => asString(companyProduct.productId)),
    );

    let observedUnits = 0;
    let orderedUnits = 0;
    let actualCost = 0;
    let hasActualCost = false;
    const lines = lineRows.map((line) => {
      const companyProduct = companyProducts.get(asString(line.companyProductId) ?? '') ?? {};
      const product = products.get(asString(companyProduct.productId) ?? '') ?? {};
      const orderedQty = asNumber(line.orderedQty) ?? 0;
      const receivedQty = amazonReceivedQty(line);
      orderedUnits += orderedQty;
      observedUnits += receivedQty;
      const lineActual = asNumber(line.actualCost);
      if (lineActual !== undefined) {
        actualCost += lineActual;
        hasActualCost = true;
      }
      return {
        id: asString(line.id),
        companyProductId: asString(line.companyProductId),
        title: asString(product.title) ?? asString(line.sourceAsin),
        asin: asString(product.asin) ?? asString(line.sourceAsin),
        sku: asString(product.sku) ?? asString(line.sourceSupplierSku),
        brand: asString(product.brand),
        orderedQty,
        receivedQty,
        unitCost: asNumber(line.unitCost),
        expectedCost: asNumber(line.expectedCost) ?? computeLineExpectedCost(line),
        expectedSellPrice: asNumber(line.expectedSellPrice),
        expectedMargin: asNumber(line.expectedMargin),
        supplierPackSize: asNumber(line.supplierPackSize),
        priority: asString(line.priority),
        amazonCheckStatus: asString(line.amazonCheckStatus),
        amazonReceiptStatus: asString(line.amazonReceiptStatus),
        expectedDeliveryDate: asString(line.expectedDeliveryDate),
        expectedSellableDate: asString(line.expectedSellableDate),
      };
    });

    const lifecycleStatus = canonicalOrderLifecycleStatus(order.lifecycleStatus);
    return {
      header: {
        id: orderId,
        orderRef: asString(order.orderRef),
        companyId: asString(order.companyId),
        companyName: asString(company.name),
        supplierId: asString(order.supplierId),
        supplierName: asString(supplier.displayName),
        supplierExternalRef: supplierRef,
        sourceMarketplace: asString(order.sourceMarketplace),
        orderDate: asString(order.orderDate),
        orderIntent: asString(order.orderIntent),
        deletable: MANUAL_ORDER_INTENTS.has(asString(order.orderIntent) ?? ''),
        lifecycleStatus: lifecycleStatus ?? asString(order.lifecycleStatus),
        canonicalStatus: asString(order.canonicalStatus),
        workflowStage: asString(order.workflowStage),
        placedBy: asString(order.placedBy),
        orderApproval: asString(order.orderApproval),
        paymentStatus: asString(order.paymentStatus),
        paymentMode: asString(order.paymentMode),
        paymentDate: asString(order.paymentDate),
        invoiceStatus: asString(order.invoiceStatus),
        attachmentReference: asString(order.attachmentReference),
        shippingCarrier: asString(order.shippingCarrier),
        trackingId: asString(order.trackingId),
        expectedDeliveryDate: asString(order.expectedDeliveryDate),
        remarks: asString(order.remarks),
        expectedCost: asNumber(order.expectedCost) ?? sumExpectedCost(lineRows),
        actualCost: hasActualCost ? round2(actualCost) : asNumber(order.actualCost),
        orderedUnits,
        observedUnits,
        productCount: lines.length,
        amazonReceiptStatus: asString(order.amazonReceiptStatus),
        // Prep details (T5): surfaced so the popup's Prep section can prefill.
        hazmatFlag: typeof order.hazmatFlag === 'boolean' ? order.hazmatFlag : undefined,
        prepBoxes: asNumber(order.prepBoxes),
        prepCartons: asNumber(order.prepCartons),
        prepUnits: asNumber(order.prepUnits),
        prepDimensions: readDimensions(order.prepDimensions) ?? undefined,
        prepWeightValue: asNumber(order.prepWeightValue),
        prepWeightUnit: asString(order.prepWeightUnit),
        shippingId: asString(order.shippingId),
        labelFilesLink: asString(order.labelFilesLink),
        prepStatus: asString(order.prepStatus),
      },
      lines,
      // T8: the popup's Comments tab reads this thread (newest-first, deleted excluded).
      comments: await this.loadOrderCommentThread(orderId),
      activity: await this.buildActivity(order, orderId),
    };
  }

  // ---- 5. updateOrderHeader -------------------------------------------------

  async updateOrderHeader(params: PlainRecord & { orderId?: string; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    const companyId = String(order.companyId);
    const values: PlainRecord = {};

    if ('orderRef' in params) {
      const orderRef = requireValidOrderRef(params.orderRef);
      if (!(await this.isOrderRefAvailable(companyId, orderRef, orderId))) {
        throw new OrderWorkbenchError(`Order reference ${orderRef} is already used for this company.`, 409);
      }
      const company = await this.findRecord(ECOBASE_COLLECTIONS.silverCompanies, companyId);
      const companyKey = orderRefPrefix(asString(company.companyKey));
      const orderDate = normalizeDateOnly(params.orderDate) ?? asString(order.orderDate) ?? todayIso();
      values.orderRef = orderRef;
      values.dailySequenceLetter = trailingSequenceLetter(orderRef, companyKey, orderDate);
    }
    if ('orderDate' in params) values.orderDate = normalizeDateOnly(params.orderDate) ?? asString(order.orderDate);
    if ('supplierId' in params) {
      const supplierId = asString(params.supplierId);
      if (supplierId) await this.requireSupplierForCompany(supplierId, companyId);
      values.supplierId = supplierId;
    }
    for (const field of [
      'sourceMarketplace',
      'paymentStatus',
      'paymentMode',
      'invoiceStatus',
      'attachmentReference',
      'shippingCarrier',
      'trackingId',
      'remarks',
    ]) {
      if (field in params) values[field] = optionalStringValue(params[field]);
    }
    if ('paymentDate' in params) values.paymentDate = normalizeDateOnly(params.paymentDate);
    if ('expectedDeliveryDate' in params) values.expectedDeliveryDate = normalizeDateOnly(params.expectedDeliveryDate);

    if (Object.keys(values).length > 0) {
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
    }
    return this.getOrderDetail({ orderId });
  }

  // ---- 6. updateOrderLine ---------------------------------------------------

  async updateOrderLine(params: PlainRecord & { orderLineId?: string; actorUserId?: string }) {
    const line = await this.requireLine(params.orderLineId);
    const lineId = String(line.id);
    const orderId = String(line.orderId);
    const values: PlainRecord = {};
    for (const field of LINE_EDITABLE_FIELDS) {
      if (!(field in params)) continue;
      if (field === 'orderedQty') {
        const qty = asNumber(params.orderedQty);
        if (qty === undefined || qty <= 0) throw new OrderWorkbenchError('Quantity must be greater than zero.');
        values.orderedQty = qty;
      } else if (field === 'expectedDeliveryDate' || field === 'expectedSellableDate') {
        values[field] = normalizeDateOnly(params[field]);
      } else if (field === 'priority') {
        values.priority = optionalStringValue(params.priority);
      } else {
        values[field] = asNumber(params[field]);
      }
    }

    const nextOrderedQty = 'orderedQty' in values ? (values.orderedQty as number) : asNumber(line.orderedQty);
    const nextUnitCost = 'unitCost' in values ? (values.unitCost as number | undefined) : asNumber(line.unitCost);
    const nextSellPrice =
      'expectedSellPrice' in values
        ? (values.expectedSellPrice as number | undefined)
        : asNumber(line.expectedSellPrice);
    if ('unitCost' in values || 'orderedQty' in values) {
      values.expectedCost = computeLineExpectedCost({ orderedQty: nextOrderedQty, unitCost: nextUnitCost });
    }
    // Recompute margin only when the operator did not supply one explicitly.
    if (('expectedSellPrice' in values || 'unitCost' in values) && !('expectedMargin' in params)) {
      values.expectedMargin = computeLineMargin({ expectedSellPrice: nextSellPrice, unitCost: nextUnitCost });
    }

    if (Object.keys(values).length > 0) {
      await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).update({ filterByTk: lineId, values });
    }
    return this.getOrderDetail({ orderId });
  }

  // ---- 7. addOrderLine ------------------------------------------------------

  async addOrderLine(params: { orderId?: string; line?: OrderLineInput; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    const line = params.line;
    if (!line) throw new OrderWorkbenchError('A product line is required.');
    const companyProduct = await this.requireCompanyProduct(line.companyProductId);
    if (asString(companyProduct.companyId) !== asString(order.companyId)) {
      throw new OrderWorkbenchError('Product belongs to a different company.');
    }
    if (!Number.isFinite(line.orderedQty) || line.orderedQty <= 0) {
      throw new OrderWorkbenchError('Quantity must be greater than zero.');
    }
    await this.insertLine(orderId, line, params.actorUserId);
    await this.recomputeHeaderExpectedCost(orderId);
    return this.getOrderDetail({ orderId });
  }

  // ---- 8. deleteOrderLine ---------------------------------------------------

  async deleteOrderLine(params: { orderLineId?: string; actorUserId?: string }) {
    const line = await this.requireLine(params.orderLineId);
    const lineId = String(line.id);
    const orderId = String(line.orderId);
    const remaining = await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).count({ filter: { orderId } });
    if (remaining <= 1) {
      throw new OrderWorkbenchError(
        'This is the last product on the order — delete or cancel the whole order instead.',
      );
    }
    await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).destroy({ filterByTk: lineId });
    await this.recomputeHeaderExpectedCost(orderId);
    return this.getOrderDetail({ orderId });
  }

  // ---- 9. deleteOrder -------------------------------------------------------

  async deleteOrder(params: { orderId?: string; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    const isManual = MANUAL_ORDER_INTENTS.has(asString(order.orderIntent) ?? '');
    if (isManual) {
      // Lines CASCADE on the silverOrders FK.
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).destroy({ filterByTk: orderId });
      return { orderId, action: 'deleted' as const };
    }
    const now = new Date().toISOString();
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: orderId,
      values: {
        lifecycleStatus: 'cancelled',
        canonicalStatus: 'cancelled',
        workflowStage: 'cancelled',
        statusSource: 'operator',
        operatorStatusOverrideAt: now,
        operatorStatusOverrideByUserId: uuidOrUndefined(params.actorUserId),
        statusEvidenceJson: {
          source: 'order_workbench',
          action: 'cancel_imported',
          cancelledAt: now,
          actorUserId: params.actorUserId,
        },
      },
    });
    return { orderId, action: 'cancelled' as const };
  }

  // ---- 10. setOrderStatus ---------------------------------------------------

  async setOrderStatus(params: { orderId?: string; status?: unknown; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    const write = deriveStatusWrite(params.status);
    const now = new Date().toISOString();
    // T2.1: the days-in-status / days-in-pane clocks reset ONLY when the MAIN
    // lifecycle status (statusChangedAt) or the mapped workflow stage
    // (workflowStageEnteredAt) actually changes. A same-status re-set leaves both
    // stamps untouched; sub-status/milestone editors never call through here.
    const lifecycleChanged = canonicalOrderLifecycleStatus(order.lifecycleStatus) !== write.lifecycleStatus;
    // Read before the write: the loaded record must not be consulted for "what it was"
    // after the update has been applied to it.
    const previousStage = asString(order.workflowStage);
    const stageChanged = previousStage !== write.workflowStage;
    const values: PlainRecord = {
      lifecycleStatus: write.lifecycleStatus,
      canonicalStatus: write.canonicalStatus,
      workflowStage: write.workflowStage,
      statusSource: 'operator',
      operatorStatusOverrideAt: now,
      operatorStatusOverrideByUserId: uuidOrUndefined(params.actorUserId),
      statusEvidenceJson: {
        source: 'order_workbench',
        action: 'set_status',
        lifecycleStatus: write.lifecycleStatus,
        canonicalStatus: write.canonicalStatus,
        at: now,
        actorUserId: params.actorUserId,
      },
    };
    if (lifecycleChanged) values.statusChangedAt = now;
    if (stageChanged) values.workflowStageEnteredAt = now;
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
    // 054 R2: entering inbound monitoring pins each line's inventory baseline.
    await new EcobaseInboundEntryBaselineStamper(this.db).stampOrderEntry({
      orderId,
      previousStage,
      nextStage: write.workflowStage,
    });
    return this.getOrderDetail({ orderId });
  }

  // ---- 12. updateOrderPaperwork (T2.2) --------------------------------------

  /**
   * Narrow, auditable surface for the popup's paperwork-milestone editor. Writes
   * only the six whitelisted milestone fields. It deliberately NEVER touches the
   * lifecycle status or the status clocks (statusChangedAt / workflowStageEnteredAt) —
   * paperwork edits are sub-status edits, and only setOrderStatus resets the clocks.
   */
  async updateOrderPaperwork(params: PlainRecord & { orderId?: string; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    const values: PlainRecord = {};
    for (const field of ['orderApproval', 'paymentStatus', 'paymentMode', 'invoiceStatus', 'attachmentReference']) {
      if (field in params) values[field] = optionalStringValue(params[field]);
    }
    if ('paymentDate' in params) values.paymentDate = normalizeDateOnly(params.paymentDate);
    if (Object.keys(values).length > 0) {
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
    }
    return this.getOrderDetail({ orderId });
  }

  // ---- 13. updatePrepDetails (T2.3) -----------------------------------------

  /**
   * Workbench prep-details editor (the popup's Prep section). Whitelist-only; any
   * unrecognised field is rejected. Stamps prepDetailsUpdatedAt/ByUserId. The v1
   * dashboard `savePrepDetails` action is a separate, untouched surface.
   */
  async updatePrepDetails(params: PlainRecord & { orderId?: string; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    for (const key of Object.keys(params)) {
      if (key === 'orderId' || key === 'actorUserId') continue;
      if (!PREP_DETAIL_FIELDS.has(key)) {
        throw new OrderWorkbenchError(`Unknown prep-detail field "${key}".`);
      }
    }
    const values: PlainRecord = {};
    if ('prepBoxes' in params) values.prepBoxes = integerOrNull(params.prepBoxes, 'Boxes');
    if ('prepCartons' in params) values.prepCartons = integerOrNull(params.prepCartons, 'Cartons');
    if ('prepUnits' in params) values.prepUnits = nonNegativeNumberOrNull(params.prepUnits, 'Units');
    if ('prepDimensions' in params) values.prepDimensions = normalizePrepDimensions(params.prepDimensions);
    if ('prepWeightValue' in params) values.prepWeightValue = nonNegativeNumberOrNull(params.prepWeightValue, 'Weight');
    if ('prepWeightUnit' in params) values.prepWeightUnit = normalizePrepWeightUnit(params.prepWeightUnit);
    if ('hazmatFlag' in params) values.hazmatFlag = booleanOrNull(params.hazmatFlag);
    if ('shippingId' in params) values.shippingId = normalizeShippingId(params.shippingId);
    if ('labelFilesLink' in params) values.labelFilesLink = normalizeLabelFilesLink(params.labelFilesLink);
    if ('prepStatus' in params) values.prepStatus = normalizePrepStatus(params.prepStatus);
    values.prepDetailsUpdatedAt = new Date().toISOString();
    // Spec (T2.3) mandates uuidOrUndefined here even though the column is string-typed,
    // so integer NocoBase user ids never persist as the "updated by" value.
    // String-typed column (unlike the uuid actor columns) — store the id as-is so
    // prep edits stay attributed, matching the v1 savePrepDetails behavior.
    values.prepDetailsUpdatedByUserId = asString(params.actorUserId);
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
    return this.getOrderDetail({ orderId });
  }

  // ---- 14. confirmInboundCompletion (T2.4) ----------------------------------

  /**
   * Operator confirmation that an inbound-monitored order has fully arrived at
   * Amazon. Guarded: the order must be in the amazon_inbound stage AND show receipt
   * evidence of arrival (the shared orderArrivalDetected predicate). On success it
   * writes COMPLETE through the same operator path deriveStatusWrite drives and
   * resets both status clocks so the family leaves the pane on the next publish.
   */
  async confirmInboundCompletion(params: { orderId?: string; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    if (asString(order.workflowStage) !== 'amazon_inbound') {
      throw new OrderWorkbenchError(
        'This order is not in inbound monitoring, so it cannot be confirmed as inbound-complete.',
      );
    }
    const lineRows = (await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).find({ filter: { orderId } })).map(
      toPlainRecord,
    );
    const arrived = orderArrivalDetected({
      orderReceiptStatus: asString(order.amazonReceiptStatus),
      lines: lineRows.map((line) => ({
        amazonReceiptStatus: asString(line.amazonReceiptStatus),
        amazonReceiptObservedQty: asNumber(line.amazonReceiptObservedQty),
        orderedQty: asNumber(line.orderedQty),
      })),
    });
    if (!arrived) {
      throw new OrderWorkbenchError(
        'No Amazon arrival detected yet — units have not moved from ordered into inbound, so this order cannot be completed.',
      );
    }
    const write = deriveStatusWrite('COMPLETE');
    const now = new Date().toISOString();
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: orderId,
      values: {
        lifecycleStatus: write.lifecycleStatus,
        canonicalStatus: write.canonicalStatus,
        workflowStage: write.workflowStage,
        statusSource: 'operator',
        operatorStatusOverrideAt: now,
        operatorStatusOverrideByUserId: uuidOrUndefined(params.actorUserId),
        statusChangedAt: now,
        workflowStageEnteredAt: now,
        statusEvidenceJson: {
          source: 'order_workbench',
          action: 'confirm_inbound_completion',
          lifecycleStatus: write.lifecycleStatus,
          canonicalStatus: write.canonicalStatus,
          at: now,
          actorUserId: params.actorUserId,
        },
      },
    });
    return this.getOrderDetail({ orderId });
  }

  // ---- 16. addOrderComment (T8) ---------------------------------------------

  /**
   * Log an operator comment on the order (the popup's Comments tab). Writes into
   * silverActivityComments with entityType 'order' — the SAME thread getOrderDetail
   * reads and paneOrders' lastActivity summarises — stamping occurredAt so the
   * newest-first ordering is deterministic. actorUserId lands in the bigInt-typed
   * comment actor column (integer NocoBase ids are fine there). Returns the
   * recomputed OrderDetail so the popup refreshes its list + count in one round trip.
   */
  async addOrderComment(params: { orderId?: string; body?: unknown; actorUserId?: string }) {
    const order = await this.requireOrder(params.orderId);
    const orderId = String(order.id);
    const body = typeof params.body === 'string' ? params.body.trim() : '';
    if (!body) throw new OrderWorkbenchError('A comment cannot be empty.');
    if (body.length > 4000) throw new OrderWorkbenchError('A comment must be 4000 characters or fewer.');
    await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: randomUUID(),
        entityType: 'order',
        entityId: orderId,
        actorType: 'operator',
        actorUserId: params.actorUserId,
        commentType: 'note',
        body,
        occurredAt: new Date().toISOString(),
        workflowDetectionStatus: 'none',
      },
    });
    return this.getOrderDetail({ orderId });
  }

  /**
   * Full order comment thread for the popup: newest-first, soft-deleted excluded,
   * each author resolved through one page-scoped users lookup (fallback 'Operator').
   */
  private async loadOrderCommentThread(orderId: string): Promise<Array<{ author: string; at: string; body: string }>> {
    const rows = (
      await this.repo(ECOBASE_COLLECTIONS.silverActivityComments)
        .find({ filter: { entityType: 'order', entityId: orderId }, limit: 500 })
        .catch(() => [])
    ).map(toPlainRecord);
    const entries: Array<{ at: string; body: string; actorUserId: unknown }> = [];
    for (const row of rows) {
      if (asString(row.deletedAt)) continue;
      const body = asString(row.body);
      const at = asTimestampString(row.occurredAt) ?? asTimestampString(row.createdAt);
      if (!body || !at) continue;
      entries.push({ at, body, actorUserId: row.actorUserId });
    }
    const authors = await this.resolveCommentAuthors(entries.map((entry) => entry.actorUserId));
    return entries
      .map((entry) => ({
        author: authors.get(String(entry.actorUserId)) ?? DEFAULT_COMMENT_AUTHOR,
        at: entry.at,
        body: entry.body,
      }))
      .sort((left, right) => right.at.localeCompare(left.at));
  }

  /**
   * ONE users lookup for the given comment actors (mirrors inventory-dashboard-service's
   * displayName precedence: nickname → name → email → username). Keyed by String(id).
   */
  private async resolveCommentAuthors(actorIds: unknown[]): Promise<Map<string, string>> {
    const ids = new Map<string, unknown>();
    for (const actorUserId of actorIds) {
      if (actorUserId !== null && actorUserId !== undefined) ids.set(String(actorUserId), actorUserId);
    }
    const names = new Map<string, string>();
    if (ids.size === 0) return names;
    const users = (
      await this.repo('users')
        .find({ filter: { id: { $in: [...ids.values()] } }, limit: ids.size })
        .catch(() => [])
    ).map(toPlainRecord);
    for (const user of users) {
      if (user.id === null || user.id === undefined) continue;
      const name = asString(user.nickname) ?? asString(user.name) ?? asString(user.email) ?? asString(user.username);
      if (name) names.set(String(user.id), name);
    }
    return names;
  }

  // ---- 15. paneOrders (T2.5) ------------------------------------------------

  /**
   * Order-grain read for the three order panes. Joins the pinned run's published
   * gold rows with silver orders/lines/suppliers/comments and derives every number
   * at read time (milestones, ages, money-at-risk, attention). Membership stays as
   * published: an order is in the pane when any of its pinned-run gold rows carry
   * primaryActionPane === pane. Mirrors the dashboard pane endpoint's run contract
   * (empty envelope when nothing is published; a runSuperseded signal when the
   * pinned run is stale).
   */
  async paneOrders(params: {
    pane?: unknown;
    runId?: string;
    page?: number;
    pageSize?: number;
    search?: string;
    companyId?: string;
  }): Promise<OrderPaneResult> {
    if (!isOrderPaneKey(params.pane)) {
      throw new OrderWorkbenchError(`paneOrders requires a valid order pane; received "${String(params.pane)}".`);
    }
    const pane = params.pane;
    const requestedRunId = asString(params.runId);
    if (!requestedRunId) throw new OrderWorkbenchError('paneOrders requires the pinned runId.');
    const pageSize = normalizePageSize(params.pageSize);

    const reader = new PublishedGoldReader(this.db as unknown as DashboardDatabase);
    const run = await reader.findPublishedRun();
    if (!run) {
      return { pane, publishedRunId: '', rows: [], pagination: { page: 1, pageSize, total: 0 } };
    }
    if (requestedRunId !== run.id) {
      return { runSuperseded: true, publishedRunId: run.id };
    }

    const goldRows = await reader.findRowsForRun(run.id, asString(params.companyId));
    const goldByCompanyProductId = new Map<string, { estimatedProfitRisk?: number; estimatedOosDate?: string }>();
    const orderIdsInPane = new Set<string>();
    for (const gold of goldRows) {
      const companyProductId = asString(gold.companyProductId);
      if (companyProductId && !goldByCompanyProductId.has(companyProductId)) {
        goldByCompanyProductId.set(companyProductId, {
          estimatedProfitRisk: asNumber(gold.estimatedProfitRisk),
          estimatedOosDate: asString(gold.estimatedOosDate),
        });
      }
      const supplierOrderId = asString(gold.supplierOrderId);
      if (supplierOrderId && asString(gold.primaryActionPane) === pane) orderIdsInPane.add(supplierOrderId);
    }
    if (orderIdsInPane.size === 0) {
      return { pane, publishedRunId: run.id, rows: [], pagination: { page: 1, pageSize, total: 0 } };
    }

    const orderIds = [...orderIdsInPane];
    const now = new Date();
    const thresholds = await this.resolveAttentionThresholds();
    const orders = (
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).find({
        filter: { id: { $in: orderIds } },
        limit: orderIds.length,
      })
    ).map(toPlainRecord);
    const lineRows = (
      await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).find({
        filter: { orderId: { $in: orderIds } },
        limit: 20000,
      })
    ).map(toPlainRecord);
    const linesByOrderId = new Map<string, PlainRecord[]>();
    for (const line of lineRows) {
      const orderId = asString(line.orderId);
      if (!orderId) continue;
      const bucket = linesByOrderId.get(orderId) ?? [];
      bucket.push(line);
      linesByOrderId.set(orderId, bucket);
    }
    const [suppliers, companies, commentsByOrderId] = await Promise.all([
      this.mapByIds(
        ECOBASE_COLLECTIONS.silverSuppliers,
        orders.map((order) => asString(order.supplierId)),
      ),
      this.mapByIds(
        ECOBASE_COLLECTIONS.silverCompanies,
        orders.map((order) => asString(order.companyId)),
      ),
      this.loadLatestOrderComments(orderIds),
    ]);

    const rows = orders.map((order) =>
      this.buildOrderPaneRow({
        order,
        lines: linesByOrderId.get(String(order.id)) ?? [],
        supplier: suppliers.get(asString(order.supplierId) ?? '') ?? {},
        company: companies.get(asString(order.companyId) ?? '') ?? {},
        comment: commentsByOrderId.get(String(order.id)) ?? null,
        goldByCompanyProductId,
        pane,
        thresholds,
        now,
      }),
    );

    const term = asString(params.search)?.toLowerCase();
    const filtered = term
      ? rows.filter((row) =>
          [row.orderRef, row.supplierName, row.companyName].some((field) => (field ?? '').toLowerCase().includes(term)),
        )
      : rows;
    // Attention-flagged first, then longest time in the pane.
    filtered.sort((left, right) => {
      if (left.attention.flagged !== right.attention.flagged) return left.attention.flagged ? -1 : 1;
      return (right.daysInPane ?? -1) - (left.daysInPane ?? -1);
    });

    const total = filtered.length;
    const page = normalizePage(params.page);
    const start = (page - 1) * pageSize;
    return {
      pane,
      publishedRunId: run.id,
      rows: filtered.slice(start, start + pageSize),
      pagination: { page, pageSize, total },
    };
  }

  private buildOrderPaneRow(input: {
    order: PlainRecord;
    lines: PlainRecord[];
    supplier: PlainRecord;
    company: PlainRecord;
    comment: { at: string; body: string } | null;
    goldByCompanyProductId: Map<string, { estimatedProfitRisk?: number; estimatedOosDate?: string }>;
    pane: OrderPaneKey;
    thresholds: OrderAttentionThresholds;
    now: Date;
  }): OrderPaneRow {
    const { order, lines, supplier, company, comment, goldByCompanyProductId, pane, thresholds, now } = input;
    const orderId = String(order.id);
    const lifecycleStatus = canonicalOrderLifecycleStatus(order.lifecycleStatus) ?? asString(order.lifecycleStatus);

    let orderedUnits = 0;
    let arrivedUnits = 0;
    let actualCost = 0;
    let hasActualCost = false;
    for (const line of lines) {
      orderedUnits += asNumber(line.orderedQty) ?? 0;
      arrivedUnits += amazonReceivedQty(line);
      const lineActual = asNumber(line.actualCost);
      if (lineActual !== undefined) {
        actualCost += lineActual;
        hasActualCost = true;
      }
    }

    const paperwork = deriveOrderPaperworkMilestones({
      orderApproval: asString(order.orderApproval),
      canonicalStatus: asString(order.canonicalStatus),
      sourceOrderStatus: asString(order.sourceOrderStatus),
      lifecycleStatus,
      paymentStatus: asString(order.paymentStatus),
      paymentMode: asString(order.paymentMode),
      invoiceStatus: asString(order.invoiceStatus),
    });
    const prep = deriveOrderPrepMilestones({
      lifecycleStatus,
      prepStatus: asString(order.prepStatus),
      prepDimensions: readDimensions(order.prepDimensions),
      prepWeightValue: asNumber(order.prepWeightValue),
      prepBoxes: asNumber(order.prepBoxes),
      prepUnits: asNumber(order.prepUnits),
      labelFilesLink: asString(order.labelFilesLink),
    });
    const arrivalDetected = orderArrivalDetected({
      orderReceiptStatus: asString(order.amazonReceiptStatus),
      lines: lines.map((line) => ({
        amazonReceiptStatus: asString(line.amazonReceiptStatus),
        amazonReceiptObservedQty: asNumber(line.amazonReceiptObservedQty),
        orderedQty: asNumber(line.orderedQty),
      })),
    });

    const daysInStatus = resolveDaysSince(
      [
        asTimestampString(order.statusChangedAt),
        asTimestampString(order.operatorStatusOverrideAt),
        asTimestampString(order.authorityAsOf),
        asTimestampString(order.orderDate),
      ],
      now,
    );
    const daysInPane = resolveDaysSince(
      [
        asTimestampString(order.workflowStageEnteredAt),
        asTimestampString(order.operatorStatusOverrideAt),
        asTimestampString(order.authorityAsOf),
        asTimestampString(order.orderDate),
      ],
      now,
    );

    const etaDate = asString(order.expectedDeliveryDate) ?? asString(order.expectedArrivalDate);
    const products: OrderRiskProduct[] = lines
      .map((line) => asString(line.companyProductId))
      .filter((id): id is string => Boolean(id))
      .map((companyProductId) => {
        const gold = goldByCompanyProductId.get(companyProductId);
        return {
          companyProductId,
          estimatedProfitRisk: gold?.estimatedProfitRisk ?? null,
          estimatedOosDate: gold?.estimatedOosDate ?? null,
        };
      });
    const risk = computeOrderMoneyAtRisk({ products, etaDate, now });

    const statusChangedRef =
      asTimestampString(order.statusChangedAt) ??
      asTimestampString(order.operatorStatusOverrideAt) ??
      asTimestampString(order.authorityAsOf) ??
      asTimestampString(order.orderDate);
    const attention = deriveOrderAttention({
      pane,
      daysInStatus,
      daysInPane,
      lastActivityAt: comment?.at ?? null,
      statusChangedAt: statusChangedRef,
      paymentBlocked: paperwork.payment.state === 'blocked',
      now,
      thresholds,
    });

    return {
      orderId,
      orderRef: asString(order.orderRef),
      companyName: asString(company.name),
      sourceMarketplace: asString(order.sourceMarketplace),
      supplierName: asString(supplier.displayName),
      supplierShipDestination: asShipDestination(supplier.shipDestination),
      lifecycleStatus,
      paperwork,
      prep,
      inbound: {
        orderedUnits,
        arrivedUnits,
        arrivalDetected,
        alreadyConfirmed: isCompleteLifecycleStatus(order.lifecycleStatus),
      },
      expectedCost: asNumber(order.expectedCost) ?? sumExpectedCost(lines),
      actualCost: hasActualCost ? round2(actualCost) : asNumber(order.actualCost),
      units: orderedUnits,
      daysInStatus,
      daysInPane,
      lastActivity: comment,
      moneyAtRisk: risk.moneyAtRisk,
      atRiskProductCount: risk.atRiskProductCount,
      productCount: risk.productCount,
      moneyAtRiskPastSafe: risk.pastSafeDate,
      attention,
    };
  }

  private async resolveAttentionThresholds(): Promise<OrderAttentionThresholds> {
    const settings = await new EcobasePlanningSettingsService(this.db).getResolvedSettings();
    return {
      activeOrderFollowUpDays: settings.activeOrderFollowUpDays,
      prepIdleDays: settings.prepIdleDays,
      inboundOverdueDays: settings.inboundOverdueDays,
    };
  }

  /** Latest non-deleted comment per order (entityType 'order'); body clipped to 120 chars. */
  private async loadLatestOrderComments(orderIds: string[]): Promise<Map<string, { at: string; body: string }>> {
    const result = new Map<string, { at: string; body: string }>();
    if (orderIds.length === 0) return result;
    const rows = (
      await this.repo(ECOBASE_COLLECTIONS.silverActivityComments)
        .find({
          filter: { entityType: 'order', entityId: { $in: orderIds } },
          limit: Math.min(orderIds.length * 100, 10000),
        })
        .catch(() => [])
    ).map(toPlainRecord);
    for (const row of rows) {
      if (asString(row.deletedAt)) continue;
      const entityId = asString(row.entityId);
      const body = asString(row.body);
      const at = asTimestampString(row.occurredAt) ?? asTimestampString(row.createdAt);
      if (!entityId || !body || !at) continue;
      const existing = result.get(entityId);
      if (!existing || at > existing.at) result.set(entityId, { at, body: body.slice(0, 120) });
    }
    return result;
  }

  /** The 11 canonical lifecycle statuses with pill colour + stage, for the Set-status popup. */
  statusOptions() {
    return ORDER_LIFECYCLE_STATUS_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      color: ORDER_LIFECYCLE_STATUS_METADATA[option.value].color,
      stage: ORDER_LIFECYCLE_STATUS_METADATA[option.value].stage,
      description: ORDER_LIFECYCLE_STATUS_METADATA[option.value].description,
    }));
  }

  // ---- 11. productOptions ---------------------------------------------------

  async productOptions(params: { companyId?: string; search?: string; limit?: number }) {
    const companyId = asString(params.companyId);
    if (!companyId) throw new OrderWorkbenchError('companyId is required.');
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
    const search = asString(params.search)?.trim();

    const companyProducts = (
      await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ filter: { companyId }, limit: 20000 })
    ).map(toPlainRecord);
    const companyProductByProductId = new Map<string, PlainRecord>();
    for (const companyProduct of companyProducts) {
      const productId = asString(companyProduct.productId);
      if (productId) companyProductByProductId.set(productId, companyProduct);
    }
    const productIds = [...companyProductByProductId.keys()];
    if (productIds.length === 0) return [];

    // Search runs in the DB across the company's own product universe BEFORE the
    // limit (mirrors the supplierOptions fix), so every product stays findable.
    const filter: PlainRecord = { id: { $in: productIds } };
    if (search) {
      filter.$or = [{ asin: { $includes: search } }, { sku: { $includes: search } }, { title: { $includes: search } }];
    }
    const products = (await this.repo(ECOBASE_COLLECTIONS.silverProducts).find({ filter, limit, sort: ['title'] })).map(
      toPlainRecord,
    );

    const unitCostByProductId = await this.latestUnitCosts(products.map((product) => asString(product.id)));
    return products.map((product) => {
      const companyProduct = companyProductByProductId.get(asString(product.id) ?? '') ?? {};
      return {
        value: asString(companyProduct.id),
        companyProductId: asString(companyProduct.id),
        title: asString(product.title),
        asin: asString(product.asin),
        sku: asString(product.sku),
        brand: asString(product.brand),
        unitCost: unitCostByProductId.get(asString(product.id) ?? ''),
      };
    });
  }

  // ---- internals ------------------------------------------------------------

  private async insertLine(orderId: string, line: OrderLineInput, actorUserId?: string) {
    const expectedMargin =
      line.expectedMargin ?? computeLineMargin({ expectedSellPrice: line.expectedSellPrice, unitCost: line.unitCost });
    return this.supplierOrders.createOrderLine({
      supplierOrderId: orderId,
      planningProductId: line.companyProductId,
      orderedQty: line.orderedQty,
      unitCost: line.unitCost,
      supplierPackSize: line.supplierPackSize,
      expectedSellPrice: line.expectedSellPrice,
      expectedMargin,
      priority: line.priority,
      expectedDeliveryDate: line.expectedDeliveryDate,
      expectedSellableDate: line.expectedSellableDate,
      actor: actorUserId,
    });
  }

  private async recomputeHeaderExpectedCost(orderId: string) {
    const lines = (await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).find({ filter: { orderId } })).map(
      toPlainRecord,
    );
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: orderId,
      values: { expectedCost: sumExpectedCost(lines) ?? null },
    });
  }

  private async isOrderRefAvailable(companyId: string, orderRef: string, excludeOrderId?: string) {
    const existing = toPlainRecord(
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).findOne({ filter: { companyId, orderRef } }),
    );
    const existingId = asString(existing.id);
    return !existingId || existingId === excludeOrderId;
  }

  /** The supplier's sheet SR code (e.g. SRO-12865), newest external ref first. */
  private async latestSupplierExternalRef(supplierId: string | undefined) {
    if (!supplierId) return undefined;
    const ref = toPlainRecord(
      await this.repo(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).findOne({
        filter: { supplierId },
        sort: ['-lastSeenAt'],
      }),
    );
    return asString(ref.externalSupplierCode);
  }

  private async defaultSupplierForProduct(productId: string | undefined) {
    if (!productId) return undefined;
    const supplierProduct = toPlainRecord(
      await this.repo(ECOBASE_COLLECTIONS.silverSupplierProducts).findOne({
        filter: { productId },
        sort: ['-updatedAt'],
      }),
    );
    return this.supplierOption(asString(supplierProduct.supplierId));
  }

  /** Family-level fallback: the family's preferred supplier (same chain the gold engine uses). */
  private async familyPreferredSupplier(familyId: string | undefined) {
    if (!familyId) return undefined;
    const family = await this.findRecord(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, familyId);
    return this.supplierOption(asString(family.preferredSupplierId));
  }

  private async supplierOption(supplierId: string | undefined) {
    if (!supplierId) return undefined;
    const supplier = await this.findRecord(ECOBASE_COLLECTIONS.silverSuppliers, supplierId);
    const displayName = asString(supplier.displayName);
    return displayName ? { supplierId, displayName } : undefined;
  }

  private async latestUnitCosts(productIds: Array<string | undefined>) {
    const ids = productIds.filter((id): id is string => Boolean(id));
    const byProductId = new Map<string, number>();
    if (ids.length === 0) return byProductId;
    const supplierProducts = (
      await this.repo(ECOBASE_COLLECTIONS.silverSupplierProducts).find({
        filter: { productId: { $in: ids } },
        sort: ['-updatedAt'],
      })
    ).map(toPlainRecord);
    for (const supplierProduct of supplierProducts) {
      const productId = asString(supplierProduct.productId);
      const unitCost = asNumber(supplierProduct.unitCost);
      if (productId && unitCost !== undefined && !byProductId.has(productId)) byProductId.set(productId, unitCost);
    }
    return byProductId;
  }

  private async buildActivity(order: PlainRecord, orderId: string) {
    const activity: Array<{ at?: string; kind: string; summary: string }> = [];
    const created = asString(order.createdAt) ?? orderDateIso(order);
    activity.push({ at: created, kind: 'created', summary: 'Order created' });
    const statusAt = asString(order.operatorStatusOverrideAt);
    if (statusAt) {
      activity.push({
        at: statusAt,
        kind: 'status',
        summary: `Status set to ${asString(order.lifecycleStatus) ?? asString(order.canonicalStatus) ?? 'draft'}`,
      });
    }
    const receiptAt = asString(order.amazonReceiptObservedAt);
    if (receiptAt) {
      activity.push({ at: receiptAt, kind: 'receipt', summary: 'Receipt observed on Amazon' });
    }
    const comments = (
      await this.repo(ECOBASE_COLLECTIONS.silverActivityComments)
        .find({ filter: { entityType: ECOBASE_COLLECTIONS.silverOrders, entityId: orderId }, limit: 50 })
        .catch(() => [])
    ).map(toPlainRecord);
    for (const comment of comments) {
      if (asString(comment.deletedAt)) continue;
      activity.push({
        at: asString(comment.occurredAt) ?? asString(comment.createdAt),
        kind: asString(comment.commentType) ?? 'comment',
        summary: asString(comment.body) ?? 'Activity',
      });
    }
    return activity
      .filter((entry) => entry.summary)
      .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')));
  }

  private async requireOrder(orderId: unknown) {
    const id = asString(orderId);
    if (!id) throw new OrderWorkbenchError('orderId is required.');
    const order = toPlainRecord(await this.repo(ECOBASE_COLLECTIONS.silverOrders).findOne({ filterByTk: id }));
    if (!asString(order.id)) throw new OrderWorkbenchError(`Order ${id} was not found.`, 404);
    return order;
  }

  private async requireLine(orderLineId: unknown) {
    const id = asString(orderLineId);
    if (!id) throw new OrderWorkbenchError('orderLineId is required.');
    const line = toPlainRecord(await this.repo(ECOBASE_COLLECTIONS.silverOrderLines).findOne({ filterByTk: id }));
    if (!asString(line.id)) throw new OrderWorkbenchError(`Order line ${id} was not found.`, 404);
    return line;
  }

  private async requireCompanyProduct(companyProductId: unknown) {
    const id = asString(companyProductId);
    if (!id) throw new OrderWorkbenchError('A product selection is required.');
    const companyProduct = toPlainRecord(
      await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).findOne({ filterByTk: id }),
    );
    if (!asString(companyProduct.id)) throw new OrderWorkbenchError(`Product ${id} was not found.`, 404);
    return companyProduct;
  }

  private async requireSupplierForCompany(supplierId: string, companyId: string) {
    const supplier = toPlainRecord(
      await this.repo(ECOBASE_COLLECTIONS.silverSuppliers).findOne({ filterByTk: supplierId }),
    );
    if (!asString(supplier.id)) throw new OrderWorkbenchError(`Supplier ${supplierId} was not found.`, 404);
    const supplierCompanyId = asString(supplier.companyId);
    if (supplierCompanyId && supplierCompanyId !== companyId) {
      throw new OrderWorkbenchError('Selected supplier belongs to a different company.');
    }
    return supplier;
  }

  private async findRecord(collection: string, id: string | undefined) {
    if (!id) return {} as PlainRecord;
    return toPlainRecord(await this.repo(collection).findOne({ filterByTk: id }));
  }

  private async mapByIds(collection: string, ids: Array<string | undefined>) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const map = new Map<string, PlainRecord>();
    if (unique.length === 0) return map;
    const rows = (await this.repo(collection).find({ filter: { id: { $in: unique } }, limit: unique.length })).map(
      toPlainRecord,
    );
    for (const row of rows) {
      const id = asString(row.id);
      if (id) map.set(id, row);
    }
    return map;
  }

  private repo(name: string) {
    return this.db.getRepository(name);
  }
}

/**
 * Datetime columns hydrate as JS Date objects from the real database (the fake
 * test repository seeds ISO strings) — accept both, always returning an ISO
 * string. Red-proofed by the Date-object paneOrders test.
 */
function asTimestampString(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  return asString(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,%]/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Sheet-style compact ref prefix (EF/MX/RH/SS) for a company key. */
function orderRefPrefix(companyKey: string | undefined): string {
  const normalized = normalizeCompanyKey(companyKey ?? '');
  return ORDER_REF_PREFIX_BY_COMPANY_KEY[normalized] ?? normalized;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only pass values that are genuinely uuids into uuid-typed columns (NocoBase user ids are integers). */
function uuidOrUndefined(value: unknown): string | undefined {
  const text = asString(value);
  return text && UUID_PATTERN.test(text) ? text : undefined;
}

function optionalStringValue(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

function cleanValues(values: PlainRecord): PlainRecord {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function normalizeDateOnly(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) throw new OrderWorkbenchError(`Date must be ISO yyyy-mm-dd; received "${text}".`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function orderDateIso(order: PlainRecord): string | undefined {
  const orderDate = asString(order.orderDate);
  return orderDate ? `${orderDate}T00:00:00.000Z` : undefined;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizePageSize(value: unknown): number {
  const page = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 25;
  return Math.min(Math.max(page, 1), 200);
}

function normalizePage(value: unknown): number {
  const page = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.max(page, 1);
}

function asShipDestination(value: unknown): 'direct_fba' | 'prep_center' | null {
  return value === 'direct_fba' || value === 'prep_center' ? value : null;
}

/** Coerce the stored jsonb prep dimensions into numeric length/breadth/height for derivation. */
function readDimensions(value: unknown): { length?: number; breadth?: number; height?: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as PlainRecord;
  return { length: asNumber(source.length), breadth: asNumber(source.breadth), height: asNumber(source.height) };
}

// ---- updatePrepDetails field validators (T2.3) ----------------------------

function integerOrNull(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = asNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0) {
    throw new OrderWorkbenchError(`${label} must be a whole number of zero or more.`);
  }
  return parsed;
}

function nonNegativeNumberOrNull(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = asNumber(value);
  if (parsed === undefined || parsed < 0) throw new OrderWorkbenchError(`${label} must be a number of zero or more.`);
  return parsed;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'Yes' || value === 'yes') return true;
  if (value === 'false' || value === 'No' || value === 'no') return false;
  throw new OrderWorkbenchError('Hazmat must be Yes or No.');
}

function normalizePrepWeightUnit(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'lbs' || text === 'kg') return text;
  throw new OrderWorkbenchError('Weight unit must be lbs or kg.');
}

function normalizePrepStatus(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === 'In progress' || text === 'Completed') return text;
  throw new OrderWorkbenchError("Prep status must be 'In progress' or 'Completed'.");
}

function normalizeShippingId(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > 64) throw new OrderWorkbenchError('Shipping ID must be 64 characters or fewer.');
  return text;
}

function normalizeLabelFilesLink(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > 4096) throw new OrderWorkbenchError('Labels links must be 4096 characters or fewer.');
  // The prep team posts one or more label-file links (they live in chat) — one per
  // line. Every non-empty line must be a valid http(s) URL.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      throw new OrderWorkbenchError(
        `Labels links must be valid http(s) URLs, one per line; "${line.slice(0, 60)}" is not.`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new OrderWorkbenchError(
        `Labels links must be valid http(s) URLs, one per line; "${line.slice(0, 60)}" is not.`,
      );
    }
  }
  return lines.join('\n');
}

function normalizePrepDimensions(value: unknown): PlainRecord | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object') {
    throw new OrderWorkbenchError('Dimensions must be an object of length, breadth and height.');
  }
  const source = value as PlainRecord;
  const dims: PlainRecord = {};
  for (const key of ['length', 'breadth', 'height']) {
    if (source[key] === undefined || source[key] === null || source[key] === '') continue;
    const parsed = asNumber(source[key]);
    if (parsed === undefined || parsed < 0) {
      throw new OrderWorkbenchError(`Dimension ${key} must be a number of zero or more.`);
    }
    dims[key] = parsed;
  }
  return Object.keys(dims).length > 0 ? dims : null;
}

// Re-export the normalizer so action wrappers can pre-normalize without importing compute.
export { normalizeOrderRef };
