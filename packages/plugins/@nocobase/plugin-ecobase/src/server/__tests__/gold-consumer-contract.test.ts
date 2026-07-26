/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const MATRIX = [
  {
    path: '../services/alert-evaluation-service.ts',
    required: ['readPublishedFamilyActions', 'readPublishedListingPerformance'],
  },
  {
    path: '../../features/daily-operations-brief/server/daily-operations-brief-service.ts',
    required: ['readPublishedListingPerformance', 'EcobaseInventoryPlanningService'],
  },
  {
    path: '../../features/daily-operations-brief/server/daily-management-snapshot-service.ts',
    required: ['readPublishedFamilyActions', 'readPublishedListingPerformance'],
  },
  {
    path: '../../features/daily-operations-brief/server/management-kpi-facts-service.ts',
    required: ['readPublishedFamilyActions'],
  },
  {
    path: '../services/dashboard-service.ts',
    required: ['readPublishedFamilyActions', 'readPublishedListingPerformance'],
  },
  {
    path: '../services/ai-retrieval-service.ts',
    required: ['readPublishedFamilyActions', 'readPublishedListingPerformance', 'listingPerformanceRows'],
  },
  {
    path: '../services/comparison-service.ts',
    required: ['readPublishedListingPerformance'],
  },
  {
    path: '../services/accountability-service.ts',
    required: ['readPublishedFamilyActions', 'readPublishedListingPerformance'],
  },
  {
    path: '../../features/order-planning/server/order-planning-service.ts',
    required: ['readPublishedFamilyActions'],
  },
  {
    path: '../../features/supplier-management/server/supplier-management-service.ts',
    required: ['readPublishedFamilyActions', 'readPublishedListingPerformance'],
  },
  {
    path: '../../features/supplier-management/server/supplier-order-service.ts',
    required: ['readPublishedFamilyActions'],
  },
  {
    path: '../../features/semantic-model/server/semantic-link-verifier.ts',
    required: ['readExplicitListingPerformance'],
  },
  {
    path: '../../features/source-import/server/order-details-relationship-verifier.ts',
    required: ['readExplicitListingPerformance'],
  },
] as const;

describe('TD-15 typed Gold consumer contract', () => {
  it('keeps every operational consumer on its locked listing/family-action boundary', () => {
    for (const consumer of MATRIX) {
      const text = source(consumer.path);
      for (const required of consumer.required) {
        expect(text, `${consumer.path} must use ${required}`).toContain(required);
      }
      expect(text, `${consumer.path} must not read raw Gold listing rows`).not.toMatch(
        /getRepository\([^)]*goldInventoryPlanningRows/,
      );
      expect(text, `${consumer.path} must consume published artifacts rather than recalculate them`).not.toContain(
        "from '../../features/inventory-dashboard/server/engine/monthly-performance'",
      );
    }
  });

  it('exposes corrected terminology and both AI fact grains without legacy tier guidance', () => {
    const help = source('../../client/formula-help.tsx');
    expect(help).toContain('Individual monthly profit tier score');
    expect(help).toContain('dynamic six-closed-month window');
    expect(help).toContain('Only full six-month baseline confidence');
    expect(help).toContain('Listing filters never create or duplicate a family action');
    expect(help).not.toContain('actual units sold in latest rolling 30 days');

    const inventory = source('../../features/inventory-dashboard/server/engine/inventory-planning-service.ts');
    for (const field of [
      'baselineTier',
      'lastClosedMonthTier',
      'currentProjectedTier',
      'aggregatePaceStatus',
      'inventoryDisposition',
      'replenishmentEligibility',
      'linkedMemberEvidence',
    ]) {
      expect(inventory).toContain(field);
    }
  });
});
