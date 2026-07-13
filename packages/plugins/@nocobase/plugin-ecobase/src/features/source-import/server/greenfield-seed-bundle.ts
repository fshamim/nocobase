/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv, parseDelimitedCsv } from './adapters/csv-utils';
import { FOUR_COMPANY_MIGRATION_PROFILE, type FourCompanyKey } from './four-company-migration-profile';

export type GreenfieldSeedImportKind = 'adapter' | 'sellerboard_cogs' | 'clickup_order_status';

export interface GreenfieldSeedSourceSpec {
  id: string;
  kind: GreenfieldSeedImportKind;
  adapterName?: string;
  sourceType: 'sellerboard' | 'seller_central_file' | 'google_sheets' | 'clickup';
  domain: 'amazon_operations' | 'order_management' | 'supplier_management';
  companyKey?: FourCompanyKey;
  delimiter: ',' | ';';
  paths: string[];
}

export interface GreenfieldSeedFile {
  name: string;
  path: string;
  checksum: string;
  rowCount: number;
  content: string;
}

export interface GreenfieldSeedSourceGroup extends Omit<GreenfieldSeedSourceSpec, 'paths' | 'delimiter'> {
  defaultCompany?: string;
  files: GreenfieldSeedFile[];
}

export interface GreenfieldSeedBundle {
  profileVersion: string;
  asOfDate: string;
  sourceVersion: string;
  bundleChecksum: string;
  groups: GreenfieldSeedSourceGroup[];
}

const HISTORY = 'data/history';

export const GREENFIELD_SEED_SOURCE_SPECS: GreenfieldSeedSourceSpec[] = [
  {
    id: 'sellerboard-history-ecofission',
    kind: 'adapter',
    adapterName: 'sellerboard-history-csv',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'ECOFISSION_LLC',
    delimiter: ';',
    paths: [`${HISTORY}/Fissionem_Dashboard_by_product_01_01_2026-03_07_2026_(2026_07_04_05_00_00_598).csv`],
  },
  {
    id: 'sellerboard-history-muxtex',
    kind: 'adapter',
    adapterName: 'sellerboard-history-csv',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'MUXTEX_INC',
    delimiter: ';',
    paths: [`${HISTORY}/Muxtex_Dashboard_by_product_01_01_2026-03_07_2026_(2026_07_04_09_28_26_538).csv`],
  },
  {
    id: 'sellerboard-history-retail-heaven',
    kind: 'adapter',
    adapterName: 'sellerboard-history-csv',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'RETAIL_HEAVEN_INC',
    delimiter: ';',
    paths: [`${HISTORY}/Retail_Heaven_Inc_Dashboard_by_product_01_01_2026-03_07_2026_(2026_07_04_04_52_29_164).csv`],
  },
  {
    id: 'sellerboard-history-stop-shop',
    kind: 'adapter',
    adapterName: 'sellerboard-history-csv',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'STOP_SHOP_LLC',
    delimiter: ';',
    paths: [`${HISTORY}/Stop_Shop_Llc_Dashboard_by_product_01_01_2026-03_07_2026_(2026_07_04_09_06_43_378).csv`],
  },
  {
    id: 'sellerboard-cogs-ecofission',
    kind: 'sellerboard_cogs',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'ECOFISSION_LLC',
    delimiter: ';',
    paths: [`${HISTORY}/Fissionem_Cost_of_Goods_Sold_(2026_07_04_04_50_18_570).csv`],
  },
  {
    id: 'sellerboard-cogs-muxtex',
    kind: 'sellerboard_cogs',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'MUXTEX_INC',
    delimiter: ';',
    paths: [`${HISTORY}/Muxtex_Cost_of_Goods_Sold_(2026_07_04_08_59_22_030).csv`],
  },
  {
    id: 'sellerboard-cogs-retail-heaven',
    kind: 'sellerboard_cogs',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'RETAIL_HEAVEN_INC',
    delimiter: ';',
    paths: [`${HISTORY}/Retail_Heaven_Inc_Cost_of_Goods_Sold_(2026_07_04_08_57_41_530).csv`],
  },
  {
    id: 'sellerboard-cogs-stop-shop',
    kind: 'sellerboard_cogs',
    sourceType: 'sellerboard',
    domain: 'amazon_operations',
    companyKey: 'STOP_SHOP_LLC',
    delimiter: ';',
    paths: [`${HISTORY}/Stop_Shop_Llc_Cost_of_Goods_Sold_(2026_07_04_09_01_50_733).csv`],
  },
  {
    id: 'order-management',
    kind: 'adapter',
    adapterName: 'google-sheets-migration-csv',
    sourceType: 'google_sheets',
    domain: 'order_management',
    delimiter: ',',
    paths: [
      'data/order-managment-sheets/Ecofission-Order Management - Purchase Orders.csv',
      'data/order-managment-sheets/Ecofission-Order Management - OrderDetails.csv',
    ],
  },
  {
    id: 'supplier-management',
    kind: 'adapter',
    adapterName: 'google-sheets-migration-csv',
    sourceType: 'google_sheets',
    domain: 'supplier_management',
    delimiter: ',',
    paths: [
      'data/supplier-management-sheets/Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
      'data/supplier-management-sheets/Supplier Analysis Tracker - Supplier 2026.csv',
    ],
  },
  {
    id: 'clickup-order-status',
    kind: 'clickup_order_status',
    sourceType: 'clickup',
    domain: 'order_management',
    delimiter: ',',
    paths: ['data/clickup/Order Management Clickup Data 06-07-2026.csv'],
  },
];

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalCompanyName(companyKey: FourCompanyKey | undefined) {
  return FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.find((company) => company.companyKey === companyKey)?.name;
}

function requireAsOfDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new Error(`Ecobase greenfield seed bundle failed: asOfDate "${value}" must be YYYY-MM-DD.`);
  }
  return value;
}

export async function buildGreenfieldSeedBundle(params: {
  projectRoot: string;
  asOfDate: string;
  specs?: GreenfieldSeedSourceSpec[];
}): Promise<GreenfieldSeedBundle> {
  const asOfDate = requireAsOfDate(params.asOfDate);
  const specs = [...(params.specs ?? GREENFIELD_SEED_SOURCE_SPECS)].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const seenPaths = new Set<string>();
  const groups: GreenfieldSeedSourceGroup[] = [];
  for (const spec of specs) {
    const files: GreenfieldSeedFile[] = [];
    const orderedPaths = spec.id === 'order-management' ? spec.paths : [...spec.paths].sort();
    for (const relativePath of orderedPaths) {
      if (seenPaths.has(relativePath)) {
        throw new Error(`Ecobase greenfield seed bundle failed: duplicate source path ${relativePath}.`);
      }
      seenPaths.add(relativePath);
      const content = await readFile(path.resolve(params.projectRoot, relativePath), 'utf8');
      const parsed = spec.delimiter === ';' ? parseDelimitedCsv(content, ';') : parseCsv(content);
      files.push({
        name: path.basename(relativePath),
        path: relativePath,
        checksum: sha256(content),
        rowCount: parsed.rows.length,
        content,
      });
    }
    groups.push({
      id: spec.id,
      kind: spec.kind,
      adapterName: spec.adapterName,
      sourceType: spec.sourceType,
      domain: spec.domain,
      companyKey: spec.companyKey,
      defaultCompany: canonicalCompanyName(spec.companyKey),
      files,
    });
  }
  const sourceVersion = `${asOfDate}T00:00:00.000Z`;
  const bundleChecksum = sha256(
    JSON.stringify({
      profileVersion: FOUR_COMPANY_MIGRATION_PROFILE.profileVersion,
      asOfDate,
      groups: groups.map((group) => ({
        id: group.id,
        files: group.files.map((file) => ({ path: file.path, checksum: file.checksum, rowCount: file.rowCount })),
      })),
    }),
  );
  return {
    profileVersion: FOUR_COMPANY_MIGRATION_PROFILE.profileVersion,
    asOfDate,
    sourceVersion,
    bundleChecksum,
    groups,
  };
}

export function greenfieldSeedBundleManifest(bundle: GreenfieldSeedBundle) {
  return {
    ...bundle,
    groups: bundle.groups.map((group) => ({
      ...group,
      files: group.files.map(({ content: _content, ...file }) => file),
    })),
  };
}
