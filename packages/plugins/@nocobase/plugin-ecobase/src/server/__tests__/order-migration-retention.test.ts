/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { decideOrderMigrationRetention } from '../../features/source-import/server/order-migration-retention';
import { decideCompanyScope } from '../../features/source-import/server/source-scope-policy';
import { greenfieldOrderCases, type GreenfieldOrderFixture } from './fixtures/greenfield-migration/fixtures';

const AS_OF_DATE = '2026-07-13';

describe('greenfield order migration retention', () => {
  it('classifies the fixed operational-retention fixtures', () => {
    for (const rawFixture of greenfieldOrderCases.slice(4)) {
      const fixture: GreenfieldOrderFixture = rawFixture;
      const companyDecision = decideCompanyScope({
        source: 'legacy_csv',
        explicitCompany: fixture.explicitCompany,
        orderRef: fixture.orderRef,
      });
      expect(companyDecision.disposition, fixture.id).not.toBe('discard');
      if (companyDecision.disposition === 'discard') continue;
      expect(
        decideOrderMigrationRetention({
          companyKey: companyDecision.companyKey,
          status: fixture.status,
          orderDate: fixture.orderDate,
          asOfDate: AS_OF_DATE,
          orphan: fixture.orphan,
          coherentEvidence: fixture.coherentEvidence,
          hasCurrentClickupEvidence: fixture.hasCurrentClickupEvidence,
        }).disposition,
        fixture.id,
      ).toBe(fixture.expectedDisposition);
    }
  });

  it('retains canonical and adapter-emitted non-terminal orders regardless of age', () => {
    for (const status of [
      'IN TRANSIT TO PREP',
      'draft',
      'planned',
      'po_placed',
      'confirmed',
      'preparing',
      'shipped',
      'supplier_contacted',
      'supplier_confirmed',
      'approval_pending',
      'payment_pending',
      'paid',
      'supplier_preparing',
      'shipped_inbound',
      'reached_fba',
      'blocked',
    ]) {
      expect(
        decideOrderMigrationRetention({
          companyKey: 'ECOFISSION_LLC',
          status,
          orderDate: '2020-01-01',
          asOfDate: AS_OF_DATE,
        }),
        status,
      ).toEqual({ disposition: 'accept', companyKey: 'ECOFISSION_LLC', reasonCode: 'non_terminal_order' });
    }
  });

  it('applies the complete-order window to supplier-order terminal statuses and aliases', () => {
    for (const status of ['completed', 'received']) {
      expect(
        decideOrderMigrationRetention({
          companyKey: 'MUXTEX_INC',
          status,
          orderDate: '2026-06-20',
          asOfDate: AS_OF_DATE,
        }).disposition,
        status,
      ).toBe('accept');
      expect(
        decideOrderMigrationRetention({
          companyKey: 'MUXTEX_INC',
          status,
          orderDate: '2026-05-01',
          asOfDate: AS_OF_DATE,
        }).disposition,
        status,
      ).toBe('discard');
    }
  });

  it('discards cancelled and rejected orders before age or future-delivery exceptions', () => {
    for (const status of ['cancelled', 'canceled', 'rejected', 'hold/cancelled']) {
      expect(
        decideOrderMigrationRetention({
          companyKey: 'STOP_SHOP_LLC',
          status,
          orderDate: '2026-07-01',
          expectedDeliveryDate: '2026-08-01',
          asOfDate: AS_OF_DATE,
        }),
      ).toEqual({ disposition: 'discard', reasonCode: 'cancelled_or_rejected_order' });
    }
  });

  it('reviews stale unknown orders only when current operational evidence exists', () => {
    expect(
      decideOrderMigrationRetention({
        companyKey: 'RETAIL_HEAVEN_INC',
        status: 'Needs review',
        orderDate: '2025-01-01',
        expectedDeliveryDate: '2026-08-01',
        asOfDate: AS_OF_DATE,
      }),
    ).toEqual({
      disposition: 'review',
      companyKey: 'RETAIL_HEAVEN_INC',
      reasonCode: 'unknown_order_with_operational_evidence',
    });
  });

  it('fails fast when the explicit as-of date is invalid', () => {
    expect(() =>
      decideOrderMigrationRetention({
        companyKey: 'MUXTEX_INC',
        status: 'ORDERED',
        orderDate: '2026-01-01',
        asOfDate: 'not-a-date',
      }),
    ).toThrow('asOfDate must be a valid date');
  });
});
