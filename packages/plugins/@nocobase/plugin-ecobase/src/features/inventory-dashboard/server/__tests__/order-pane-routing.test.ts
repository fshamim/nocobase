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
import { decideReplenishment, type ReplenishmentDecisionInput } from '../engine/replenishment-decision';
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

  /**
   * Issue 070. The sheet import records the sheet's own "Order status" as evidence only
   * (`statusEvidenceJson.sourceOrderStatus`) and never derives a `canonicalStatus`, so 713
   * orders the sheet had already closed — some dating to 2023 — resolved to the open catch-all
   * and sat in Active Orders forever. These lock the read-model fallback that retires them.
   */
  it('070: a sheet-Completed order with no canonical status resolves closed, and Cancelled too', () => {
    for (const sourceOrderStatus of ['Completed', 'completed', 'COMPLETED', '  Completed  ']) {
      expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('completed');
    }
    for (const sourceOrderStatus of ['Cancelled', 'cancelled', 'CANCELLED']) {
      expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('cancelled');
    }
    // The zombies carry the sheet's workflow stage in `lifecyclePhase`, which is what used to
    // fall through to the catch-all. The evidence still decides.
    expect(
      silverOrderStatus({ lifecyclePhase: 'pre_purchase', statusEvidenceJson: { sourceOrderStatus: 'Completed' } }),
    ).toBe('completed');
    for (const closed of ['completed', 'cancelled']) {
      expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderClosedStatuses).toContain(closed);
    }
  });

  it('070: every other sheet status keeps the catch-all, and an explicit canonicalStatus wins', () => {
    for (const sourceOrderStatus of ['In Progress', 'Ordered', 'Complete', 'Canceled', '']) {
      expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('supplier_contacted');
    }
    // A malformed or absent evidence column must not throw its way through the read model.
    expect(silverOrderStatus({ statusEvidenceJson: null })).toBe('supplier_contacted');
    expect(silverOrderStatus({ statusEvidenceJson: 'not-an-object' })).toBe('supplier_contacted');
    expect(silverOrderStatus({})).toBe('supplier_contacted');
    // An explicitly canonicalized order is decided by its own status, never by sheet evidence.
    expect(silverOrderStatus({ canonicalStatus: 'paid', statusEvidenceJson: { sourceOrderStatus: 'Completed' } })).toBe(
      'paid',
    );
    expect(
      silverOrderStatus({ canonicalStatus: 'shipped_inbound', statusEvidenceJson: { sourceOrderStatus: 'Cancelled' } }),
    ).toBe('shipped_inbound');
  });

  it('070: the sheet-Completed order leaves Active Orders while a sheet-In Progress order stays', () => {
    // Closed statuses carry no open quantity → existingOrderStage `none` → the family is routed
    // by its own reorder need, so no Active Orders row survives for the retired order.
    expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus: 'Completed' } })).toBe('completed');
    const retired = decideReplenishment(eligibleInput({ existingOrderStage: 'none', reorderDueKind: 'trusted' }));
    expect(retired.primaryActionPane).not.toBe('activeOrders');
    expect(retired.primaryActionPane).toBe('supplyAction');
    expect(retired.existingOrderFollowUp).toBe(false);

    // The in-progress order is untouched: still an open placed-not-purchased order → pre_purchase.
    expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus: 'In Progress' } })).toBe('supplier_contacted');
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPlacedNotPurchasedStatuses).toContain(
      'supplier_contacted',
    );
    const stillOpen = decideReplenishment(eligibleInput({ existingOrderStage: 'pre_purchase' }));
    expect(stillOpen.primaryActionPane).toBe('activeOrders');
    expect(stillOpen.existingOrderFollowUp).toBe(true);
  });

  it('a manual create writes a `draft` status that the engine treats as an open (placed-not-purchased) order', () => {
    // createOrder persists canonicalStatus:'draft'; the read model keeps it 'draft'…
    expect(silverOrderStatus({ canonicalStatus: 'draft', orderIntent: 'manual' })).toBe('draft');
    // …and 'draft' is a placed-not-purchased status → open order → pre_purchase stage.
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPlacedNotPurchasedStatuses).toContain('draft');
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPurchasedPipelineStatuses).not.toContain('draft');
  });
});
