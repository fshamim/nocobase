import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  buildSupplierOrderImportPlan,
  type SupplierOrderSourceFile,
  type SupplierOrderSourceRole,
} from '../src/features/source-import/server/supplier-order-import/supplier-order-import-plan';
import { validateSupplierOrderImportOverrides } from '../src/features/source-import/server/supplier-order-import/supplier-order-import-overrides';
import {
  preflightSupplierOrderImport,
  type SupplierOrderCatalogSnapshot,
} from '../src/features/source-import/server/supplier-order-import/supplier-order-import-preflight';

const [supplierIdsPath, purchaseOrdersPath, orderDetailsPath, catalogPath, importMode, supplierTrackerPath] =
  process.argv.slice(2);
if (
  !supplierIdsPath ||
  !purchaseOrdersPath ||
  !orderDetailsPath ||
  !catalogPath ||
  (importMode !== 'canonical-rebuild' && importMode !== 'refresh')
) {
  throw new Error(
    'Usage: preflight-supplier-order-import.ts <supplier-ids.csv> <purchase-orders.csv> <order-details.csv> <catalog.json> <canonical-rebuild|refresh> [supplier-tracker.csv]',
  );
}

function source(
  filePath: string,
  role: SupplierOrderSourceRole,
  dateFormat: 'day-first' | 'month-first',
): SupplierOrderSourceFile {
  const absolutePath = path.resolve(filePath);
  if (!existsSync(absolutePath))
    throw new Error(`Supplier/order preflight failed: source file is missing: ${absolutePath}`);
  return {
    name: absolutePath,
    role,
    content: readFileSync(absolutePath),
    dateFormat,
    modifiedAt: statSync(absolutePath).mtime.toISOString(),
  };
}

const pluginRoot = path.resolve(__dirname, '..');
const files = [
  source(supplierIdsPath, 'supplier_ids', 'month-first'),
  source(purchaseOrdersPath, 'purchase_orders', 'day-first'),
  source(orderDetailsPath, 'order_details', 'day-first'),
  ...(supplierTrackerPath ? [source(supplierTrackerPath, 'supplier_tracker', 'month-first')] : []),
];
const overrides = validateSupplierOrderImportOverrides(
  JSON.parse(
    readFileSync(
      path.join(
        pluginRoot,
        'src/features/source-import/server/supplier-order-import/supplier-order-import-overrides.json',
      ),
      'utf8',
    ),
  ),
);
const catalog = JSON.parse(readFileSync(path.resolve(catalogPath), 'utf8')) as SupplierOrderCatalogSnapshot;
const plan = buildSupplierOrderImportPlan({ files, asOfDate: '2026-07-16', overrides });
const first = preflightSupplierOrderImport(plan, catalog, importMode);
const second = preflightSupplierOrderImport(plan, catalog, importMode);
if (first.preflightDigest !== second.preflightDigest) {
  throw new Error(
    `Supplier/order preflight failed determinism gate: ${first.preflightDigest} != ${second.preflightDigest}.`,
  );
}
console.log(JSON.stringify(first, null, 2));
if (!first.ready) process.exitCode = 2;
