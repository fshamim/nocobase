/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const FOUR_COMPANY_MIGRATION_PROFILE = {
  profileVersion: '2026-07-13.1',
  canonicalCompanies: [
    { companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' },
    { companyKey: 'RETAIL_HEAVEN_INC', name: 'Retail Heaven Inc' },
    { companyKey: 'MUXTEX_INC', name: 'Muxtex INC' },
    { companyKey: 'STOP_SHOP_LLC', name: 'Stop Shop LLC' },
  ],
  companyAliasesBySource: {
    sellerboard: [{ alias: 'Fissionem', companyKey: 'ECOFISSION_LLC' }],
    legacy_csv: [
      { alias: 'StopShopLLC', companyKey: 'STOP_SHOP_LLC' },
      { alias: 'StopShop LLC', companyKey: 'STOP_SHOP_LLC' },
    ],
    supplier_csv_provenance: [{ alias: 'Muxtex Inc', companyKey: 'MUXTEX_INC' }],
    clickup: [],
  },
  orderPrefixCompanyKeys: {
    EF: 'ECOFISSION_LLC',
    MX: 'MUXTEX_INC',
    RH: 'RETAIL_HEAVEN_INC',
    SS: 'STOP_SHOP_LLC',
  },
  sellerboardCompanyFilePrefixes: {
    Fissionem: 'ECOFISSION_LLC',
    Muxtex: 'MUXTEX_INC',
    Retail_Heaven_Inc: 'RETAIL_HEAVEN_INC',
    Stop_Shop_Llc: 'STOP_SHOP_LLC',
  },
  sellerboardHistoryMonths: 6,
  completedOrderLookbackDays: 30,
  unknownOrderLookbackDays: 90,
  bronzeRetentionDays: 30,
  supplierExternalRefDecisions: [
    { externalRef: 'SRO-12939', disposition: 'accept', supplierName: 'Delko Tools' },
    { externalRef: 'SRO-1293', disposition: 'reject' },
    { externalRef: 'SRO-12572', disposition: 'accept', supplierName: 'Franklin Machine Products' },
    { externalRef: 'SRO-1257', disposition: 'reject' },
  ],
  listingSkuAliasDecisions: [{ asin: 'B0177E9JPS', amazonListingSku: 'ETC-120A', sourceSupplierSku: 'ETC120A' }],
  migrationOnlySourceTypes: ['google_sheets', 'clickup'],
} as const;

export type FourCompanyMigrationProfile = typeof FOUR_COMPANY_MIGRATION_PROFILE;
export type FourCompanyKey = FourCompanyMigrationProfile['canonicalCompanies'][number]['companyKey'];
export type MigrationCompanySource = keyof FourCompanyMigrationProfile['companyAliasesBySource'];
