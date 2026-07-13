/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import type { MigrationCompanySource } from '../../features/source-import/server/four-company-migration-profile';
import { decideCompanyScope, resolveMigrationCompany } from '../../features/source-import/server/source-scope-policy';
import { greenfieldCompanyCases, greenfieldOrderCases } from './fixtures/greenfield-migration/fixtures';

describe('greenfield source scope policy', () => {
  it('classifies every company fixture with the exact four-company profile', () => {
    for (const item of greenfieldCompanyCases) {
      expect(
        decideCompanyScope({ source: item.source as MigrationCompanySource, explicitCompany: item.value }).disposition,
        item.id,
      ).toBe(item.disposition);
    }
  });

  it('keeps aliases source-scoped and does not strip punctuation', () => {
    expect(resolveMigrationCompany('Fissionem', 'sellerboard')?.companyKey).toBe('ECOFISSION_LLC');
    expect(resolveMigrationCompany('Fissionem', 'legacy_csv')).toBeUndefined();
    expect(resolveMigrationCompany('StopShopLLC', 'legacy_csv')?.companyKey).toBe('STOP_SHOP_LLC');
    expect(resolveMigrationCompany('StopShopLLC', 'sellerboard')).toBeUndefined();
    expect(resolveMigrationCompany('Ecofission-LLC', 'legacy_csv')).toBeUndefined();
    expect(resolveMigrationCompany('  ecofission   llc ', 'legacy_csv')?.companyKey).toBe('ECOFISSION_LLC');
  });

  it('rejects unsupported order refs and conflicting company evidence', () => {
    for (const item of greenfieldOrderCases.slice(0, 4)) {
      expect(
        decideCompanyScope({
          source: 'legacy_csv',
          explicitCompany: item.explicitCompany,
          orderRef: item.orderRef,
        }).disposition,
        item.id,
      ).toBe('discard');
    }
    expect(
      decideCompanyScope({
        source: 'legacy_csv',
        explicitCompany: 'StopShopLLC',
        orderRef: 'SS42826A',
      }),
    ).toEqual({ disposition: 'accept', companyKey: 'STOP_SHOP_LLC', reasonCode: 'approved_source_alias' });
  });

  it('marks coherent header-only target-company evidence for review rather than guessing', () => {
    expect(
      decideCompanyScope({
        source: 'legacy_csv',
        orderRef: 'RH1001A',
        acceptedHeaderCompany: 'Retail Heaven Inc',
      }),
    ).toEqual({
      disposition: 'review',
      companyKey: 'RETAIL_HEAVEN_INC',
      reasonCode: 'company_from_header_and_order_prefix',
    });
    expect(decideCompanyScope({ source: 'legacy_csv', orderRef: 'RH1001A' })).toEqual({
      disposition: 'discard',
      reasonCode: 'company_evidence_incomplete',
    });
  });
});
