/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePlanningReadiness } from '../../features/inventory-planning/server/planning-readiness';

const readyInput = {
  familyRole: 'target',
  inventoryFreshnessStatus: 'fresh',
  salesVelocityStatus: 'trusted_positive',
  supplierAvailability: 'resolved_silver_link',
  leadTimeAvailability: 'resolved_silver_link',
  unitCostAvailability: 'resolved_supplier_product',
  profitAvailability: 'resolved_history',
  activeOrder: true,
  expectedArrivalStatus: 'imported',
  expectedArrivalConfidence: 'authoritative',
  expectedArrivalFreshness: 'fresh',
  orderCycleReviewRequired: false,
} as const;

describe('planning readiness', () => {
  it('reports ready only when every readiness domain is ready', () => {
    const result = evaluatePlanningReadiness(readyInput);

    expect(result.status).toBe('ready');
    expect(result.reasonCodes).toEqual([]);
    expect(Object.values(result.domains).map((domain) => domain.state)).toEqual([
      'ready',
      'ready',
      'ready',
      'ready',
      'ready',
      'ready',
    ]);
  });

  it('keeps unavailable inputs explicit with stable domain reason codes', () => {
    const result = evaluatePlanningReadiness({
      activeOrder: true,
      orderCycleReviewRequired: false,
    });

    expect(result.status).toBe('blocked');
    expect(result.domains).toMatchObject({
      inventory: { state: 'unavailable', reasonCodes: ['inventory_unknown'] },
      velocity: { state: 'unavailable', reasonCodes: ['velocity_missing'] },
      cost: { state: 'unavailable', reasonCodes: ['unit_cost_unavailable', 'profit_unavailable'] },
      supplier: { state: 'unavailable', reasonCodes: ['supplier_unavailable', 'lead_time_unavailable'] },
      orderTiming: { state: 'unavailable', reasonCodes: ['expected_arrival_unknown'] },
    });
  });

  it('uses degraded as a readiness state and keeps operational labels separate', () => {
    const result = evaluatePlanningReadiness({
      ...readyInput,
      familyRole: 'review',
      inventoryFreshnessStatus: 'stale',
      salesVelocityStatus: 'fallback_positive',
      supplierAvailability: 'link_defect',
      leadTimeAvailability: 'resolved_default_supplier_lead_time',
      unitCostAvailability: 'source_incomplete',
      profitAvailability: 'source_incomplete',
      expectedArrivalStatus: 'derived',
      expectedArrivalConfidence: 'estimated',
      expectedArrivalFreshness: 'stale',
      orderCycleReviewRequired: true,
    });

    expect(result.status).toBe('partial');
    expect(Object.values(result.domains).every((domain) => domain.state === 'degraded')).toBe(true);
    expect(result.reasonCodes).toContain('order_cycle_review_required');
    expect(result.reasonCodes).not.toContain('watch');
    expect(result.reasonCodes).not.toContain('supplier_order_stale');
  });
});
