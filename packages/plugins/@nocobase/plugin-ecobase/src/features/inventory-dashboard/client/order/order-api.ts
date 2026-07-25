/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Thin typed client for the `ecobaseInventoryDashboard:*` order-workbench actions
 * (Order Create/View UI, T4/T5). Components hold form state only; every request
 * and envelope-unwrap goes through here.
 */

import { unwrapEnvelope } from '../envelope';

export interface OrderRequestClient {
  request: (options: { url: string; method: 'post'; data: Record<string, unknown> }) => Promise<unknown>;
}

export interface OrderSupplierOption {
  value: string;
  label: string;
}

export interface OrderProductOption {
  value: string;
  companyProductId: string;
  title?: string;
  asin?: string;
  sku?: string;
  brand?: string;
  unitCost?: number;
}

export interface OrderDraftPreparation {
  companyId: string;
  companyName?: string;
  companyKey?: string;
  orderDate: string;
  suggestedOrderRef: string;
  product: { companyProductId?: string; title?: string; asin?: string; sku?: string; brand?: string };
  supplierDefault?: { supplierId: string; displayName: string };
  placedBy?: string;
}

export interface OrderRefCheck {
  normalized: string;
  available: boolean;
}

export interface OrderStatusOption {
  value: string;
  label: string;
  color: string;
  stage: 'before_ordered' | 'after_ordered' | 'complete';
  description: string;
}

export interface OrderLineDetail {
  id?: string;
  companyProductId?: string;
  title?: string;
  asin?: string;
  sku?: string;
  brand?: string;
  orderedQty: number;
  receivedQty: number;
  unitCost?: number;
  expectedCost?: number;
  expectedSellPrice?: number;
  expectedMargin?: number;
  supplierPackSize?: number;
  priority?: string;
  amazonCheckStatus?: string;
  amazonReceiptStatus?: string;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
}

export interface OrderHeaderDetail {
  id: string;
  orderRef?: string;
  companyId?: string;
  companyName?: string;
  supplierId?: string;
  supplierName?: string;
  supplierExternalRef?: string;
  sourceMarketplace?: string;
  orderDate?: string;
  orderIntent?: string;
  deletable: boolean;
  lifecycleStatus?: string;
  canonicalStatus?: string;
  workflowStage?: string;
  placedBy?: string;
  orderApproval?: string;
  paymentStatus?: string;
  paymentMode?: string;
  paymentDate?: string;
  invoiceStatus?: string;
  attachmentReference?: string;
  shippingCarrier?: string;
  trackingId?: string;
  expectedDeliveryDate?: string;
  remarks?: string;
  expectedCost?: number;
  actualCost?: number;
  orderedUnits: number;
  observedUnits: number;
  productCount: number;
  amazonReceiptStatus?: string;
  // Prep details (T5) — surfaced so the drawer's Prep section can prefill.
  hazmatFlag?: boolean;
  prepBoxes?: number;
  prepCartons?: number;
  prepUnits?: number;
  prepDimensions?: { length?: number; breadth?: number; height?: number };
  prepWeightValue?: number;
  prepWeightUnit?: string;
  shippingId?: string;
  labelFilesLink?: string;
  prepStatus?: string;
}

export interface OrderActivityEntry {
  at?: string;
  kind: string;
  summary: string;
}

/** One entry in the order popup's Comments tab (T8): newest-first, deleted excluded. */
export interface OrderCommentEntry {
  author: string;
  at: string;
  body: string;
}

export interface OrderDetail {
  header: OrderHeaderDetail;
  lines: OrderLineDetail[];
  comments: OrderCommentEntry[];
  activity: OrderActivityEntry[];
}

// ---- Order panes (T2.5 / T4) ----------------------------------------------

export type OrderPaneKey = 'activeOrders' | 'inPrepMonitoring' | 'inboundMonitoring';
export type MilestoneStateValue = 'done' | 'current' | 'pending' | 'blocked';
export type PrepMilestoneState = 'done' | 'current' | 'pending';
export type OrderAttentionReason = 'follow_up' | 'prep_idle' | 'inbound_overdue' | 'payment_blocked' | null;

export interface OrderMilestone {
  state: MilestoneStateValue;
  raw?: string;
  paymentMode?: string;
}

export interface OrderPaperwork {
  approval: OrderMilestone;
  order: OrderMilestone;
  payment: OrderMilestone;
  invoice: OrderMilestone;
}

export interface OrderPrep {
  transit: PrepMilestoneState;
  atPrep: PrepMilestoneState;
  prep: PrepMilestoneState;
  ready: PrepMilestoneState;
  prepMeasured: boolean;
}

export interface OrderInbound {
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
  paperwork: OrderPaperwork;
  prep: OrderPrep;
  inbound: OrderInbound;
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

export interface OrderPaneRequest {
  pane: OrderPaneKey;
  runId: string;
  companyId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

async function call<T>(api: OrderRequestClient, action: string, data: Record<string, unknown>): Promise<T> {
  const response = await api.request({ url: `ecobaseInventoryDashboard:${action}`, method: 'post', data });
  return unwrapEnvelope(response) as T;
}

export function createOrderApi(api: OrderRequestClient) {
  return {
    prepareOrderDraft: (planningProductId: string) =>
      call<OrderDraftPreparation>(api, 'prepareOrderDraft', { planningProductId }),
    checkOrderRef: (companyId: string, orderRef: string, excludeOrderId?: string) =>
      call<OrderRefCheck>(api, 'checkOrderRef', { companyId, orderRef, excludeOrderId }),
    productOptions: (companyId: string, search?: string) =>
      call<OrderProductOption[]>(api, 'productOptions', { companyId, search, limit: 25 }),
    orderStatusOptions: () => call<OrderStatusOption[]>(api, 'orderStatusOptions', {}),
    createOrder: (data: Record<string, unknown>) => call<OrderDetail>(api, 'createOrder', data),
    getOrderDetail: (orderId: string) => call<OrderDetail>(api, 'getOrderDetail', { orderId }),
    updateOrderHeader: (data: Record<string, unknown>) => call<OrderDetail>(api, 'updateOrderHeader', data),
    updateOrderLine: (data: Record<string, unknown>) => call<OrderDetail>(api, 'updateOrderLine', data),
    addOrderLine: (orderId: string, line: Record<string, unknown>) =>
      call<OrderDetail>(api, 'addOrderLine', { orderId, line }),
    deleteOrderLine: (orderLineId: string) => call<OrderDetail>(api, 'deleteOrderLine', { orderLineId }),
    deleteOrder: (orderId: string) =>
      call<{ orderId: string; action: 'deleted' | 'cancelled' }>(api, 'deleteOrder', { orderId }),
    setOrderStatus: (orderId: string, status: string) => call<OrderDetail>(api, 'setOrderStatus', { orderId, status }),
    // Order panes (T2.5): order-grain rows for the pinned run.
    paneOrders: (request: OrderPaneRequest) => call<OrderPaneResult>(api, 'paneOrders', { ...request }),
    // Order-pane popup mutations (T2.2–T2.4): each returns the recomputed OrderDetail.
    updatePrepDetails: (data: Record<string, unknown>) => call<OrderDetail>(api, 'updatePrepDetails', data),
    updateOrderPaperwork: (data: Record<string, unknown>) => call<OrderDetail>(api, 'updateOrderPaperwork', data),
    confirmInboundCompletion: (orderId: string) => call<OrderDetail>(api, 'confirmInboundCompletion', { orderId }),
    // Order popup Comments tab (T8): log a comment, get the recomputed detail back.
    addOrderComment: (orderId: string, body: string) => call<OrderDetail>(api, 'addOrderComment', { orderId, body }),
    supplierOptions: async (search?: string, familyId?: string): Promise<OrderSupplierOption[]> => {
      const response = await api.request({
        url: 'ecobaseSupplierManagement:supplierOptions',
        method: 'post',
        data: { limit: 50, search: search?.trim() || undefined, familyId },
      });
      const data = unwrapEnvelope(response);
      if (!Array.isArray(data)) return [];
      return data.flatMap((entry) => {
        const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
        const value = typeof record.value === 'string' ? record.value : null;
        const label = typeof record.label === 'string' ? record.label : value;
        return value ? [{ value, label: label ?? value }] : [];
      });
    },
  };
}

export type OrderApi = ReturnType<typeof createOrderApi>;
