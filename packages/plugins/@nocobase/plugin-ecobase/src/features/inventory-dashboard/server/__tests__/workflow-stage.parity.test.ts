/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_CLICKUP_OPERATIONAL_STATUSES,
  dashboardWorkflowStageForStatus,
  isDirectShipFba,
  isInboundStage,
  isPrePurchaseStage,
  isPrepStage,
} from '../workflow-stage';

/**
 * Parity reference captured from the vendoring origin
 * `src/<feature dir>/order-planning/order-operational-status.ts`
 * (OPERATIONAL_STATUS_METADATA[status].workflowStage, verified 2026-07-21).
 *
 * The import-boundary guard (AD-1 / plan §6) forbids importing the origin from
 * this feature — including tests — so parity is asserted against this captured
 * snapshot. If the origin ever changes, both it and this snapshot must move
 * together and this test is the tripwire.
 */
const ORIGIN_STAGE_BY_STATUS: Record<string, string> = {
  complete: 'complete',
  'to do': 'pre_purchase',
  'inbound-monitoring': 'amazon_inbound',
  'hold/cancelled': 'cancelled',
  'direct-ship-fba': 'amazon_inbound',
  'prep-in-progress': 'in_prep',
  ordered: 'in_prep',
  'in progress': 'pre_purchase',
  'approved-to-order': 'pre_purchase',
  'order analysing': 'pre_purchase',
  'in transit to prep': 'in_prep',
  hold: 'hold',
};

describe('vendored workflow-stage parity (T-1.0)', () => {
  it('reproduces the origin status list exactly', () => {
    expect([...DASHBOARD_CLICKUP_OPERATIONAL_STATUSES].sort()).toEqual(Object.keys(ORIGIN_STAGE_BY_STATUS).sort());
  });

  it('maps every ClickUp status to the origin workflow stage (case-insensitive)', () => {
    for (const [status, stage] of Object.entries(ORIGIN_STAGE_BY_STATUS)) {
      expect(dashboardWorkflowStageForStatus(status), status).toBe(stage);
      expect(dashboardWorkflowStageForStatus(status.toUpperCase()), `${status} upper`).toBe(stage);
    }
  });

  it('returns undefined for unknown / empty input', () => {
    expect(dashboardWorkflowStageForStatus('not-a-status')).toBeUndefined();
    expect(dashboardWorkflowStageForStatus('')).toBeUndefined();
    expect(dashboardWorkflowStageForStatus(null)).toBeUndefined();
  });

  it('routes only direct-ship-fba through the direct predicate (AD-2 #3)', () => {
    expect(isDirectShipFba('direct-ship-fba')).toBe(true);
    expect(isDirectShipFba('inbound-monitoring')).toBe(false);
    expect(isDirectShipFba('prep-in-progress')).toBe(false);
  });

  it('classifies stage predicates consistently with the origin', () => {
    expect(isPrePurchaseStage('pre_purchase')).toBe(true);
    expect(isPrePurchaseStage('hold')).toBe(true);
    expect(isPrePurchaseStage('in_prep')).toBe(false);
    expect(isPrepStage('in_prep')).toBe(true);
    expect(isInboundStage('amazon_inbound')).toBe(true);
  });
});
