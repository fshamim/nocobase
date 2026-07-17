/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type SupplierOrderLineOverride =
  | { disposition: 'select'; selectedSourceHash: string; reason: string }
  | {
      disposition: 'repeat';
      occurrences: Array<{ sourceHash: string; suffix: string }>;
      reason: string;
    };

export interface SupplierOrderImportOverrides {
  version: 1;
  supplierIds: Record<string, { acceptedCode: string; reason: string }>;
  supplierNames: Record<string, { displayName: string; reason: string }>;
  purchaseOrders: Record<string, { selectedRowNumber: number; reason: string }>;
  orderLines: Record<string, SupplierOrderLineOverride>;
  excludedOrderDetailRows: Record<string, { reason: string }>;
  clickupTasks: Record<string, { selectedTaskId: string; reason: string }>;
}

export const EMPTY_SUPPLIER_ORDER_IMPORT_OVERRIDES: SupplierOrderImportOverrides = {
  version: 1,
  supplierIds: {},
  supplierNames: {},
  purchaseOrders: {},
  orderLines: {},
  excludedOrderDetailRows: {},
  clickupTasks: {},
};

export function validateSupplierOrderImportOverrides(value: unknown): SupplierOrderImportOverrides {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    throw new Error('Supplier/order import overrides are invalid: expected version 1.');
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    'supplierIds',
    'supplierNames',
    'purchaseOrders',
    'orderLines',
    'excludedOrderDetailRows',
    'clickupTasks',
  ]) {
    if (!record[key] || typeof record[key] !== 'object' || Array.isArray(record[key])) {
      throw new Error(`Supplier/order import overrides are invalid: ${key} must be an object.`);
    }
  }
  return value as SupplierOrderImportOverrides;
}
