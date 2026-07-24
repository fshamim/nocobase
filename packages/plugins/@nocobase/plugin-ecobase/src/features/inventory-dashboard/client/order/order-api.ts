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
}

export interface OrderActivityEntry {
  at?: string;
  kind: string;
  summary: string;
}

export interface OrderDetail {
  header: OrderHeaderDetail;
  lines: OrderLineDetail[];
  activity: OrderActivityEntry[];
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
