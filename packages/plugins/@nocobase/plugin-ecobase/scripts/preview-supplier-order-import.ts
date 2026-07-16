import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  buildSupplierOrderImportPlan,
  type SupplierOrderSourceFile,
  type SupplierOrderSourceRole,
} from '../src/features/source-import/server/supplier-order-import/supplier-order-import-plan';
import { validateSupplierOrderImportOverrides } from '../src/features/source-import/server/supplier-order-import/supplier-order-import-overrides';

const [supplierIdsPath, purchaseOrdersPath, orderDetailsPath, supplierTrackerPath] = process.argv.slice(2);
if (!supplierIdsPath || !purchaseOrdersPath || !orderDetailsPath) {
  throw new Error(
    'Usage: preview-supplier-order-import.ts <supplier-ids.csv> <purchase-orders.csv> <order-details.csv> [supplier-tracker.csv]',
  );
}

function source(
  filePath: string,
  role: SupplierOrderSourceRole,
  dateFormat: 'day-first' | 'month-first',
): SupplierOrderSourceFile {
  const absolutePath = path.resolve(filePath);
  if (!existsSync(absolutePath))
    throw new Error(`Supplier/order preview failed: source file is missing: ${absolutePath}`);
  return {
    name: absolutePath,
    role,
    content: readFileSync(absolutePath),
    dateFormat,
    modifiedAt: statSync(absolutePath).mtime.toISOString(),
  };
}

const overrides = validateSupplierOrderImportOverrides(
  JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        '../src/features/source-import/server/supplier-order-import/supplier-order-import-overrides.json',
      ),
      'utf8',
    ),
  ),
);
const files = [
  source(supplierIdsPath, 'supplier_ids', 'month-first'),
  source(purchaseOrdersPath, 'purchase_orders', 'day-first'),
  source(orderDetailsPath, 'order_details', 'day-first'),
  ...(supplierTrackerPath ? [source(supplierTrackerPath, 'supplier_tracker', 'month-first')] : []),
];
const first = buildSupplierOrderImportPlan({ asOfDate: '2026-07-16', files, overrides });
const second = buildSupplierOrderImportPlan({ asOfDate: '2026-07-16', files, overrides });
if (first.digest !== second.digest) {
  throw new Error(`Supplier/order preview failed determinism gate: ${first.digest} != ${second.digest}.`);
}
console.log(JSON.stringify(first, null, 2));
