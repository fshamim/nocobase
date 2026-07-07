/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';

type PlainRecord = Record<string, unknown>;

export interface SilverSupplierOrderReadModelQuery {
  company?: string;
  limit?: number;
}

export interface SilverSupplierOrderReadModel {
  supplierOrders: PlainRecord[];
  supplierOrderLines: PlainRecord[];
}

export async function silverSupplierOrderReadModel(
  db: EcobaseDatabase,
  query: SilverSupplierOrderReadModelQuery = {},
): Promise<SilverSupplierOrderReadModel> {
  const limit = Math.min(Math.max(query.limit ?? 1000, 1), 20000);
  const companies = await repoRows(db, ECOBASE_COLLECTIONS.silverCompanies, 5000);
  const companyById = new Map(companies.map((company) => [asString(company.id), company]));
  const companyIds = new Set(
    companies
      .filter((company) => !query.company || asString(company.name) === query.company)
      .map((company) => asString(company.id))
      .filter((id): id is string => Boolean(id)),
  );

  const [suppliers, products, companyProducts, supplierProducts] = await Promise.all([
    repoRows(db, ECOBASE_COLLECTIONS.silverSuppliers, 10000),
    repoRows(db, ECOBASE_COLLECTIONS.silverProducts, 50000),
    repoRows(db, ECOBASE_COLLECTIONS.silverCompanyProducts, 50000),
    repoRows(db, ECOBASE_COLLECTIONS.silverSupplierProducts, 50000),
  ]);
  const supplierById = new Map(suppliers.map((supplier) => [asString(supplier.id), supplier]));
  const productById = new Map(products.map((product) => [asString(product.id), product]));
  const companyProductById = new Map(
    companyProducts.map((companyProduct) => [asString(companyProduct.id), companyProduct]),
  );
  const supplierProductById = new Map(
    supplierProducts.map((supplierProduct) => [asString(supplierProduct.id), supplierProduct]),
  );
  const silverOrders: PlainRecord[] = (await repoRows(db, ECOBASE_COLLECTIONS.silverOrders, limit))
    .filter(
      (order) =>
        !query.company || companyIds.has(asString(order.companyId) ?? '') || asString(order.company) === query.company,
    )
    .map((order) => {
      const company = companyById.get(asString(order.companyId));
      const supplier = supplierById.get(asString(order.supplierId));
      const companyName = asString(company?.name) ?? asString(order.company) ?? query.company;
      const orderRef = asString(order.orderRef) ?? asString(order.externalOrderRef) ?? asString(order.id) ?? '';
      return {
        ...order,
        naturalKey: companyName ? `supplier-order:${companyName}:${orderRef}` : undefined,
        company: companyName,
        externalOrderRef: orderRef,
        status: silverOrderStatus(order),
        statusUpdatedAt: asString(order.updatedAt) ?? asString(order.statusUpdatedAt) ?? orderDateTime(order),
        lastMeaningfulUpdateAt:
          asString(order.updatedAt) ??
          asString(order.lastMeaningfulUpdateAt) ??
          asString(order.statusUpdatedAt) ??
          orderDateTime(order),
        sourceStage:
          asString(order.orderIntent) ?? asString(order.lifecyclePhase) ?? asString(order.sourceStage) ?? 'imported',
        supplierName: asString(supplier?.displayName) ?? asString(supplier?.name) ?? asString(order.supplierName),
      };
    })
    .sort((left, right) =>
      String(right.lastMeaningfulUpdateAt ?? '').localeCompare(String(left.lastMeaningfulUpdateAt ?? '')),
    );
  const orderById = new Map(silverOrders.map((order) => [asString(order.id), order]));
  const orderIds = new Set(orderById.keys());

  const supplierOrderLines = (await repoRows(db, ECOBASE_COLLECTIONS.silverOrderLines, limit * 3))
    .filter((line) => orderIds.has(asString(line.orderId) ?? asString(line.supplierOrderId) ?? ''))
    .map((line) => {
      const orderId = asString(line.orderId) ?? asString(line.supplierOrderId);
      const order = orderById.get(orderId);
      const companyProduct = companyProductById.get(asString(line.companyProductId));
      const supplierProduct = supplierProductById.get(asString(line.supplierProductId));
      const product = productById.get(asString(companyProduct?.productId) ?? asString(supplierProduct?.productId));
      const company = asString(order?.company) ?? asString(line.company);
      const asin = (asString(product?.asin) ?? asString(line.asin))?.toUpperCase();
      const sku = asString(product?.sku) ?? asString(supplierProduct?.supplierSku) ?? asString(line.sku);
      return {
        ...line,
        supplierOrderId: orderId,
        company,
        supplierId: asString(order?.supplierId) ?? asString(supplierProduct?.supplierId) ?? asString(line.supplierId),
        supplierName: asString(order?.supplierName) ?? asString(line.supplierName),
        planningProductId: asString(line.companyProductId) ?? asString(line.planningProductId),
        companyProductId: asString(line.companyProductId) ?? asString(line.planningProductId),
        asin,
        sku,
        title: asString(product?.title) ?? asString(line.title),
        brand: asString(product?.brand) ?? asString(line.brand),
        orderedQty: asNumber(line.orderedQty) ?? 0,
        receivedQty: asNumber(line.confirmedQty) ?? asNumber(line.receivedQty) ?? 0,
        unitCost: asNumber(line.unitCost) ?? asNumber(supplierProduct?.unitCost),
        expectedDeliveryDate: asString(line.expectedDeliveryDate) ?? asString(order?.expectedDeliveryDate),
        expectedSellableDate: asString(line.expectedSellableDate),
        observedAt: orderDateTime(order),
        sourceOrderLineRef:
          asString(line.sourceOrderLineRef) ?? [asString(order?.externalOrderRef), asin, sku].filter(Boolean).join(':'),
      };
    });

  return { supplierOrders: silverOrders, supplierOrderLines };
}

export function silverOrderStatus(order: PlainRecord) {
  const status = normalizeStatus(
    asString(order.canonicalStatus) ??
      asString(order.lifecycleStatus) ??
      asString(order.lifecyclePhase) ??
      asString(order.status),
  );
  if (LEGACY_SUPPLIER_ORDER_STATUSES.has(status)) return status;
  if (['complete', 'completed'].includes(status)) return 'completed';
  if (status.includes('reject')) return 'rejected';
  if (status.includes('cancel')) return 'cancelled';
  if (status.includes('block')) return 'blocked';
  if (status.includes('inbound') || status.includes('shipped') || status.includes('transit')) return 'shipped_inbound';
  if (status.includes('prep')) return 'supplier_preparing';
  if (status === 'ordered' || status.includes('paid')) return 'paid';
  if (status.includes('approved') || status.includes('analys') || status === 'in_progress') return 'approval_pending';
  return 'supplier_contacted';
}

const LEGACY_SUPPLIER_ORDER_STATUSES = new Set([
  'draft',
  'supplier_contacted',
  'supplier_confirmed',
  'approval_pending',
  'payment_pending',
  'paid',
  'supplier_preparing',
  'shipped_inbound',
  'reached_fba',
  'completed',
  'blocked',
  'rejected',
  'cancelled',
]);

async function repoRows(db: EcobaseDatabase, collectionName: string, limit: number) {
  return (await db.getRepository(collectionName).find({ limit })).map(toPlainRecord);
}

function orderDateTime(order: PlainRecord | undefined) {
  const orderDate = asString(order?.orderDate);
  return orderDate ? `${orderDate}T00:00:00.000Z` : undefined;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,%]/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeStatus(value: string | undefined) {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') ?? ''
  );
}
