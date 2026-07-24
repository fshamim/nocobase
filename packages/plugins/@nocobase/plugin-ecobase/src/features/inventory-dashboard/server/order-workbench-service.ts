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
 * boundary: this file never imports from ../../inventory-planning.
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
} from '../../order-planning/order-lifecycle-status';
import {
  computeLineExpectedCost,
  computeLineMargin,
  deriveStatusWrite,
  normalizeOrderRef,
  requireValidOrderRef,
  sumExpectedCost,
  trailingSequenceLetter,
} from './order-workbench-compute';

type PlainRecord = Record<string, unknown>;

/** Manual order intents that own their row and may be hard-deleted. */
const MANUAL_ORDER_INTENTS = new Set(['manual', 'operator_draft']);

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
      },
      lines,
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
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({
      filterByTk: orderId,
      values: {
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
      },
    });
    return this.getOrderDetail({ orderId });
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

// Re-export the normalizer so action wrappers can pre-normalize without importing compute.
export { normalizeOrderRef };
