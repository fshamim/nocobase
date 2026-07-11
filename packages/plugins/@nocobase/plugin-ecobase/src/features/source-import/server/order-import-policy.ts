/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CsvRowReader } from './adapters/csv-utils';
import { orderDetailSourceIdentity } from './order-detail-source-identity';

export type OrderImportShape = 'order-details' | 'purchase-orders';

const COMPANY_KEY_BY_PREFIX: Record<string, string> = {
  EF: 'ECOFISSION_LLC',
  MX: 'MUXTEX_INC',
  RH: 'RETAIL_HEAVEN_INC',
  SS: 'STOP_SHOP_LLC',
};

export function supportedOrderPrefix(orderRef: string | undefined) {
  const normalized = orderRef?.trim().toUpperCase();
  return normalized ? COMPANY_KEY_BY_PREFIX[normalized.slice(0, 2)] : undefined;
}

export function orderRowExclusionReason(shape: OrderImportShape, row: CsvRowReader) {
  const identity = orderDetailSourceIdentity(row);
  if (!identity.orderRef) return 'missing_order_ref';
  const expectedCompanyKey = supportedOrderPrefix(identity.orderRef);
  if (!expectedCompanyKey) return 'unsupported_order_ref';
  if (!identity.company) return 'missing_or_unknown_company';
  if (identity.company.companyKey !== expectedCompanyKey) return 'order_prefix_company_mismatch';
  if (!identity.supplierCode) return 'missing_supplier_code';
  if (shape === 'order-details' && !identity.asin) return 'missing_asin';
  if (shape === 'order-details' && identity.orderedQty === undefined) return 'missing_ordered_quantity';
  return undefined;
}

export function orderIdentityKey(row: CsvRowReader) {
  const identity = orderDetailSourceIdentity(row);
  return identity.company && identity.orderRef
    ? `${identity.company.companyKey}:${identity.orderRef.trim().toUpperCase()}`
    : undefined;
}

export function orderDetailLineIdentityKey(row: CsvRowReader) {
  if (orderRowExclusionReason('order-details', row)) return undefined;
  const identity = orderDetailSourceIdentity(row);
  return [orderIdentityKey(row), identity.supplierCode, identity.asin, identity.sku?.trim().toUpperCase() ?? ''].join(
    ':',
  );
}
