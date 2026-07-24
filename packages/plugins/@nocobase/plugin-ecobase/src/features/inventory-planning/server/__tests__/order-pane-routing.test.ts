/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Order Create/View UI (T6): pane-routing guard for manually-created orders.
 *
 * The user expectation is that once a family has an open order it LEAVES Supply
 * Action and shows up in the orders-in-flight panes. The gold engine already
 * implements this — a `draft` order (the status a manual create writes) is in
 * the placed-not-purchased bucket, which becomes existingOrderStage
 * `pre_purchase`, which `decideReplenishment` routes to `activeOrders` BEFORE the
 * supplyAction branch. These tests lock that end-to-end behaviour in so a future
 * change to either the status buckets or the routing rule fails loudly. No engine
 * behaviour changed for this task, so the algorithm/rule version constants are
 * deliberately NOT bumped.
 */

import { describe, expect, it } from 'vitest';
import { decideReplenishment, type ReplenishmentDecisionInput } from '../replenishment-decision';
import { silverOrderStatus } from '../../../supplier-management/server/silver-supplier-order-read-model';
import { DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS } from '../../../../server/services/planning-settings-service';

/** A fully eligible family (passes every readiness/target/performance gate). */
function eligibleInput(overrides: Partial<ReplenishmentDecisionInput> = {}): ReplenishmentDecisionInput {
  return {
    administrativelyExcluded: false,
    lifecycleDiscontinuedOrPaused: false,
    hasFrozenTarget: true,
    targetSelectionState: 'automatic',
    identityEvidenceValid: true,
    baselineEvidenceValid: true,
    inventoryDisposition: 'none',
    baselineState: 'ranked',
    baselineTier: 'A',
    baselineConfidence: 'full',
    lastClosedMonthState: 'ranked',
    lastClosedMonthTier: 'A',
    closedTierMovement: 'stable',
    currentProjectionGateMode: 'informational',
    currentProjectionConfidence: 'trusted',
    currentProjectedState: 'ranked',
    currentProjectedTier: 'A',
    projectedTierMovement: 'stable',
    existingOrderStage: 'none',
    trustedZeroStock: false,
    reorderDueKind: 'trusted',
    ...overrides,
  };
}

describe('T6 order pane routing', () => {
  it('routes a reorder-due family with NO open order to Supply Action', () => {
    const decision = decideReplenishment(eligibleInput({ existingOrderStage: 'none', reorderDueKind: 'trusted' }));
    expect(decision.primaryActionPane).toBe('supplyAction');
    expect(decision.supplyActionable).toBe(true);
  });

  it('routes a family with an open draft (pre-purchase) order to Active Orders, NOT Supply Action', () => {
    const decision = decideReplenishment(
      // Even though the family is reorder-due, the open order wins the routing.
      eligibleInput({ existingOrderStage: 'pre_purchase', reorderDueKind: 'trusted' }),
    );
    expect(decision.primaryActionPane).toBe('activeOrders');
    expect(decision.primaryActionPane).not.toBe('supplyAction');
    expect(decision.existingOrderFollowUp).toBe(true);
    // Split kept explicit: a placed-not-purchased order gives visibility only, it
    // does not make the family "supply-actionable" (no quantity double-count).
    expect(decision.supplyActionable).toBe(false);
  });

  it('routes purchased-pipeline orders to the in-prep / inbound monitoring panes', () => {
    expect(decideReplenishment(eligibleInput({ existingOrderStage: 'in_prep' })).primaryActionPane).toBe(
      'inPrepMonitoring',
    );
    expect(decideReplenishment(eligibleInput({ existingOrderStage: 'inbound' })).primaryActionPane).toBe(
      'inboundMonitoring',
    );
  });

  it('sends a cancelled/completed order (no open stage) back to normal reorder routing', () => {
    // silverOrderStatus resolves the terminal canonical statuses to the closed bucket,
    // which yields existingOrderStage `none` — the family re-enters Supply Action when due.
    for (const canonicalStatus of ['cancelled', 'completed']) {
      expect(silverOrderStatus({ canonicalStatus })).toBe(canonicalStatus);
      expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderClosedStatuses).toContain(canonicalStatus);
    }
    const decision = decideReplenishment(eligibleInput({ existingOrderStage: 'none', reorderDueKind: 'trusted' }));
    expect(decision.primaryActionPane).toBe('supplyAction');
  });

  it('a manual create writes a `draft` status that the engine treats as an open (placed-not-purchased) order', () => {
    // createOrder persists canonicalStatus:'draft'; the read model keeps it 'draft'…
    expect(silverOrderStatus({ canonicalStatus: 'draft', orderIntent: 'manual' })).toBe('draft');
    // …and 'draft' is a placed-not-purchased status → open order → pre_purchase stage.
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPlacedNotPurchasedStatuses).toContain('draft');
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPurchasedPipelineStatuses).not.toContain('draft');
  });
});
