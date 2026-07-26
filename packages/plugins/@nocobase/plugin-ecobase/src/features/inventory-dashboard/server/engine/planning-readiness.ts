/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type PlanningReadinessState = 'ready' | 'degraded' | 'unavailable';

export interface PlanningReadinessDomain {
  state: PlanningReadinessState;
  reasonCodes: string[];
}

export interface PlanningReadinessInput {
  familyRole?: string;
  inventoryFreshnessStatus?: string;
  salesVelocityStatus?: string;
  supplierAvailability?: string;
  leadTimeAvailability?: string;
  unitCostAvailability?: string;
  profitAvailability?: string;
  activeOrder: boolean;
  expectedArrivalStatus?: string;
  expectedArrivalConfidence?: string;
  expectedArrivalFreshness?: string;
  orderCycleReviewRequired: boolean;
}

export interface PlanningReadinessResult {
  status: 'ready' | 'partial' | 'blocked';
  domains: Record<'family' | 'inventory' | 'velocity' | 'cost' | 'supplier' | 'orderTiming', PlanningReadinessDomain>;
  reasonCodes: string[];
}

const rank: Record<PlanningReadinessState, number> = { ready: 0, degraded: 1, unavailable: 2 };

function domain(...conditions: Array<[boolean, PlanningReadinessState, string]>): PlanningReadinessDomain {
  const matched = conditions.filter(([applies]) => applies);
  return {
    state: matched.reduce<PlanningReadinessState>(
      (state, [, candidate]) => (rank[candidate] > rank[state] ? candidate : state),
      'ready',
    ),
    reasonCodes: [...new Set(matched.map(([, , reason]) => reason))],
  };
}

export function evaluatePlanningReadiness(input: PlanningReadinessInput): PlanningReadinessResult {
  const domains = {
    family: domain(
      [input.familyRole === 'unassigned', 'unavailable', 'family_missing'],
      [input.familyRole === 'review', 'degraded', 'family_review_required'],
    ),
    inventory: domain(
      [
        !input.inventoryFreshnessStatus || input.inventoryFreshnessStatus === 'unknown',
        'unavailable',
        'inventory_unknown',
      ],
      [input.inventoryFreshnessStatus === 'invalid_future', 'unavailable', 'inventory_invalid_future'],
      [input.inventoryFreshnessStatus === 'stale', 'degraded', 'inventory_stale'],
    ),
    velocity: domain(
      [!input.salesVelocityStatus || input.salesVelocityStatus === 'missing', 'unavailable', 'velocity_missing'],
      [input.salesVelocityStatus === 'fallback_positive', 'degraded', 'velocity_fallback'],
    ),
    cost: domain(
      [
        !input.unitCostAvailability || input.unitCostAvailability.startsWith('unavailable_'),
        'unavailable',
        'unit_cost_unavailable',
      ],
      [input.unitCostAvailability === 'source_incomplete', 'degraded', 'unit_cost_incomplete'],
      [
        !input.profitAvailability || input.profitAvailability.startsWith('unavailable_'),
        'unavailable',
        'profit_unavailable',
      ],
      [input.profitAvailability === 'source_incomplete', 'degraded', 'profit_incomplete'],
    ),
    supplier: domain(
      [
        !input.supplierAvailability || input.supplierAvailability === 'unavailable_no_evidence',
        'unavailable',
        'supplier_unavailable',
      ],
      [input.supplierAvailability === 'link_defect', 'degraded', 'supplier_link_defect'],
      [!input.leadTimeAvailability, 'unavailable', 'lead_time_unavailable'],
      [input.leadTimeAvailability === 'resolved_default_supplier_lead_time', 'degraded', 'lead_time_default'],
      [Boolean(input.leadTimeAvailability?.startsWith('unavailable_')), 'unavailable', 'lead_time_unavailable'],
    ),
    orderTiming: input.activeOrder
      ? domain(
          [
            !input.expectedArrivalStatus || input.expectedArrivalStatus === 'unknown',
            'unavailable',
            'expected_arrival_unknown',
          ],
          [input.expectedArrivalStatus === 'invalid', 'unavailable', 'expected_arrival_invalid'],
          [
            input.expectedArrivalStatus === 'derived' || input.expectedArrivalConfidence === 'estimated',
            'degraded',
            'expected_arrival_estimated',
          ],
          [input.expectedArrivalFreshness === 'stale', 'degraded', 'expected_arrival_stale'],
          [input.orderCycleReviewRequired, 'degraded', 'order_cycle_review_required'],
        )
      : domain(),
  };
  const domainValues = Object.values(domains);
  return {
    status: domainValues.some((value) => value.state === 'unavailable')
      ? 'blocked'
      : domainValues.some((value) => value.state === 'degraded')
        ? 'partial'
        : 'ready',
    domains,
    reasonCodes: [...new Set(domainValues.flatMap((value) => value.reasonCodes))],
  };
}
