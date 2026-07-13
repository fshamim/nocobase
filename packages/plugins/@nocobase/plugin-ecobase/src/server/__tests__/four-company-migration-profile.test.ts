/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { FOUR_COMPANY_MIGRATION_PROFILE } from '../../features/source-import/server/four-company-migration-profile';

describe('four-company migration profile', () => {
  it('owns the exact versioned migration defaults', () => {
    expect(FOUR_COMPANY_MIGRATION_PROFILE.profileVersion).toBe('2026-07-13.1');
    expect(FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies).toEqual([
      { companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' },
      { companyKey: 'RETAIL_HEAVEN_INC', name: 'Retail Heaven Inc' },
      { companyKey: 'MUXTEX_INC', name: 'Muxtex INC' },
      { companyKey: 'STOP_SHOP_LLC', name: 'Stop Shop LLC' },
    ]);
    expect(FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies).toHaveLength(4);
    expect(FOUR_COMPANY_MIGRATION_PROFILE).toMatchObject({
      sellerboardHistoryMonths: 6,
      completedOrderLookbackDays: 30,
      unknownOrderLookbackDays: 90,
      bronzeRetentionDays: 30,
      sellerboardCompanyFilePrefixes: {
        Fissionem: 'ECOFISSION_LLC',
        Muxtex: 'MUXTEX_INC',
        Retail_Heaven_Inc: 'RETAIL_HEAVEN_INC',
        Stop_Shop_Llc: 'STOP_SHOP_LLC',
      },
      migrationOnlySourceTypes: ['google_sheets', 'clickup'],
    });
  });

  it('keeps aliases and exact identity decisions explicit', () => {
    expect(FOUR_COMPANY_MIGRATION_PROFILE.companyAliasesBySource).toEqual({
      sellerboard: [{ alias: 'Fissionem', companyKey: 'ECOFISSION_LLC' }],
      legacy_csv: [
        { alias: 'StopShopLLC', companyKey: 'STOP_SHOP_LLC' },
        { alias: 'StopShop LLC', companyKey: 'STOP_SHOP_LLC' },
      ],
      supplier_csv_provenance: [{ alias: 'Muxtex Inc', companyKey: 'MUXTEX_INC' }],
      clickup: [],
    });
    expect(FOUR_COMPANY_MIGRATION_PROFILE.supplierExternalRefDecisions).toEqual([
      { externalRef: 'SRO-12939', disposition: 'accept', supplierName: 'Delko Tools' },
      { externalRef: 'SRO-1293', disposition: 'reject' },
      { externalRef: 'SRO-12572', disposition: 'accept', supplierName: 'Franklin Machine Products' },
      { externalRef: 'SRO-1257', disposition: 'reject' },
    ]);
    expect(FOUR_COMPANY_MIGRATION_PROFILE.listingSkuAliasDecisions).toEqual([
      { asin: 'B0177E9JPS', amazonListingSku: 'ETC-120A', sourceSupplierSku: 'ETC120A' },
    ]);
    expect(JSON.stringify(FOUR_COMPANY_MIGRATION_PROFILE)).not.toMatch(/password|token=|https?:\/\//i);
  });
});
