/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import overrides from './supplier-order-import/supplier-order-import-overrides.json';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { detectCsvShape } from './adapters/amazon-operations-csv-adapter';
import { parseCsv, type CsvSourceFile } from './adapters/csv-utils';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import { buildSupplierOrderImportPlan } from './supplier-order-import/supplier-order-import-plan';
import { validateSupplierOrderImportOverrides } from './supplier-order-import/supplier-order-import-overrides';
import {
  preflightSupplierOrderImport,
  type SupplierOrderCatalogSnapshot,
  type SupplierOrderImportMode,
  type SupplierOrderImportPreflight,
} from './supplier-order-import/supplier-order-import-preflight';
import type {
  SupplierOrderSourceFile,
  SupplierOrderSourceRole,
} from './supplier-order-import/supplier-order-import-types';

const SOURCE_ROLE_BY_SHAPE = {
  'supplier-ids': 'supplier_ids',
  'supplier-analysis-tracker': 'supplier_tracker',
  'supplier-analysis-2026': 'supplier_tracker',
  'purchase-orders': 'purchase_orders',
  'order-details': 'order_details',
} as const satisfies Partial<Record<string, SupplierOrderSourceRole>>;

function text(value: unknown) {
  return String(value ?? '').trim();
}

function sourceFile(file: CsvSourceFile): SupplierOrderSourceFile {
  const shape = detectCsvShape(parseCsv(file.content).headers);
  const role = SOURCE_ROLE_BY_SHAPE[shape as keyof typeof SOURCE_ROLE_BY_SHAPE];
  if (!role) throw new Error(`Supplier/order preview failed: ${file.name} is not a canonical supplier/order source.`);
  return {
    name: file.name,
    content: file.content,
    role,
    dateFormat: role === 'purchase_orders' || role === 'order_details' ? 'day-first' : 'month-first',
  };
}

export class EcobaseSupplierOrderImportService {
  constructor(private db: EcobaseDatabase) {}

  async preview(
    files: CsvSourceFile[],
    asOfDate: string,
    importMode: SupplierOrderImportMode,
  ): Promise<SupplierOrderImportPreflight> {
    const plan = buildSupplierOrderImportPlan({
      asOfDate,
      files: files.map(sourceFile),
      overrides: validateSupplierOrderImportOverrides(overrides),
    });
    return preflightSupplierOrderImport(plan, await this.catalogSnapshot(), importMode);
  }

  async assertCatalogCurrent(preflight: SupplierOrderImportPreflight) {
    const current = preflightSupplierOrderImport(preflight.plan, await this.catalogSnapshot(), preflight.importMode);
    if (current.catalogDigest !== preflight.catalogDigest || current.preflightDigest !== preflight.preflightDigest) {
      throw new Error('Ecobase supplier/order apply failed: catalog changed after preflight; run preview again.');
    }
  }

  private async catalogSnapshot(): Promise<SupplierOrderCatalogSnapshot> {
    const all = async (collection: string) =>
      (await this.db.getRepository(collection).find({ limit: 100000 })).map(toPlainRecord);
    const [companies, families, companyProducts, products] = await Promise.all([
      all(ECOBASE_COLLECTIONS.silverCompanies),
      all(ECOBASE_COLLECTIONS.silverCompanyProductFamilies),
      all(ECOBASE_COLLECTIONS.silverCompanyProducts),
      all(ECOBASE_COLLECTIONS.silverProducts),
    ]);
    return {
      database: 'current',
      companies: companies.map((row) => ({ id: text(row.id), companyKey: text(row.companyKey), name: text(row.name) })),
      families: families.map((row) => ({
        id: text(row.id),
        companyId: text(row.companyId),
        marketplace: text(row.marketplace) || null,
        canonicalAsin: text(row.canonicalAsin),
      })),
      companyProducts: companyProducts.map((row) => ({
        id: text(row.id),
        companyId: text(row.companyId),
        companyProductFamilyId: text(row.companyProductFamilyId),
        productId: text(row.productId),
      })),
      products: products.map((row) => ({ id: text(row.id), asin: text(row.asin), sku: text(row.sku) })),
    };
  }
}
