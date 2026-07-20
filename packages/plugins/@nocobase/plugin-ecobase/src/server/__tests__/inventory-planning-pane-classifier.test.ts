/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyInventoryFamily,
  INVENTORY_PLANNING_PANES,
  type InventoryFamilyClassificationInput,
} from '../../features/inventory-planning/server/inventory-planning-pane-classifier';
import { workflowStageForOperationalStatus } from '../../features/order-planning/order-operational-status';

const readyFamily: InventoryFamilyClassificationInput = {
  active: true,
  excluded: false,
  tier: 'A',
  stockEvidenceTrusted: true,
  totalStockAndPipeline: 10,
  currentStock: 10,
  readinessReasonCodes: [],
  actionStatus: 'sufficient_stock',
  supplierResolved: true,
  effectiveLeadTimeDays: 37,
};

function pane(values: Partial<InventoryFamilyClassificationInput>) {
  return classifyInventoryFamily({ ...readyFamily, ...values }).pane;
}

describe('inventory planning pane classifier', () => {
  it('publishes the exact report pane order', () => {
    expect(INVENTORY_PLANNING_PANES).toEqual([
      'supplyAction',
      'activeOrders',
      'inPrepMonitoring',
      'inboundMonitoring',
      'healthyInventory',
      'excessInventory',
      'stuckInventory',
      'zeroStock',
      'dataReadiness',
      'performanceReview',
      'untieredProducts',
    ]);
  });

  it('checks exclusion and tier before operational stages', () => {
    expect(pane({ excluded: true, workflowStage: 'amazon_inbound' })).toBe('adminExcluded');
    expect(pane({ tier: undefined, workflowStage: 'amazon_inbound', actionStatus: 'overdue' })).toBe(
      'untieredProducts',
    );
  });

  it.each([
    ['pre_purchase', undefined, 'activeOrders'],
    ['hold', undefined, 'activeOrders'],
    ['in_prep', undefined, 'inPrepMonitoring'],
    ['amazon_inbound', undefined, 'inboundMonitoring'],
    ['complete', undefined, 'inboundMonitoring'],
    ['complete', 'review_required', 'inboundMonitoring'],
  ])('routes workflow stage %s with receipt %s to %s', (workflowStage, receiptStatus, expected) => {
    expect(pane({ workflowStage, receiptStatus })).toBe(expected);
  });

  it.each([
    ['to do', 'activeOrders'],
    ['order analysing', 'activeOrders'],
    ['approved-to-order', 'activeOrders'],
    ['in progress', 'activeOrders'],
    ['hold', 'activeOrders'],
    ['ordered', 'inPrepMonitoring'],
    ['in transit to prep', 'inPrepMonitoring'],
    ['prep-in-progress', 'inPrepMonitoring'],
    ['direct-ship-fba', 'inboundMonitoring'],
    ['inbound-monitoring', 'inboundMonitoring'],
    ['complete', 'inboundMonitoring'],
    ['hold/cancelled', 'healthyInventory'],
  ])('routes exact ClickUp status %s to %s', (status, expected) => {
    expect(pane({ workflowStage: workflowStageForOperationalStatus(status) })).toBe(expected);
  });

  it('returns completed and cancelled cycles to stock classification', () => {
    expect(
      pane({
        workflowStage: 'complete',
        receiptStatus: 'amazon_stock_observed',
        totalStockAndPipeline: 0,
        currentStock: 0,
      }),
    ).toBe('zeroStock');
    expect(pane({ workflowStage: 'cancelled', totalStockAndPipeline: 0, currentStock: 0 })).toBe('zeroStock');
  });

  it('keeps every untiered condition out of the first nine panes', () => {
    expect(
      [
        { workflowStage: 'pre_purchase' },
        { workflowStage: 'in_prep' },
        { workflowStage: 'amazon_inbound' },
        { totalStockAndPipeline: 0, currentStock: 0 },
        { readinessReasonCodes: ['inventory_unknown'], stockEvidenceTrusted: false },
        { stuckClassification: 'over_60_doc' },
        { stuckClassification: 'reserved_stalled' },
        { actionStatus: 'order_today' },
        {},
      ].map((values) => pane({ ...values, tier: undefined })),
    ).toEqual(Array(9).fill('untieredProducts'));
  });

  it.each([
    [{ readinessReasonCodes: ['inventory_unknown'], stockEvidenceTrusted: false }, 'dataReadiness'],
    [{ stuckClassification: 'over_60_doc' }, 'excessInventory'],
    [{ stuckClassification: 'reserved_stalled' }, 'stuckInventory'],
    [{ actionStatus: 'order_today' }, 'supplyAction'],
    [{}, 'healthyInventory'],
  ])('applies stock classification precedence for %j', (values, expected) => {
    expect(pane(values)).toBe(expected);
  });
});
