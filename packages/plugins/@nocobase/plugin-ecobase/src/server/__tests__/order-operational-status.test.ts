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
  CLICKUP_ORDER_OPERATIONAL_STATUSES,
  canonicalOrderStatusForOperationalStatus,
  clickupOrderOperationalStatus,
  isClosedStage,
  isInboundStage,
  isPrepStage,
  isPrePurchaseStage,
  lifecycleStatusForOperationalStatus,
  providesPurchasedCoverage,
  workflowStageForOperationalStatus,
} from '../../features/order-planning/order-operational-status';

describe('order operational status contract', () => {
  it.each([
    ['complete', 'complete'],
    ['to do', 'pre_purchase'],
    ['inbound-monitoring', 'amazon_inbound'],
    ['hold/cancelled', 'cancelled'],
    ['direct-ship-fba', 'amazon_inbound'],
    ['prep-in-progress', 'in_prep'],
    ['ordered', 'in_prep'],
    ['in progress', 'pre_purchase'],
    ['approved-to-order', 'pre_purchase'],
    ['order analysing', 'pre_purchase'],
    ['in transit to prep', 'in_prep'],
    ['hold', 'hold'],
  ] as const)('maps %s to %s without replacing the source status', (status, stage) => {
    expect(clickupOrderOperationalStatus(status.toUpperCase())).toBe(status);
    expect(workflowStageForOperationalStatus(status)).toBe(stage);
  });

  it('covers every supported ClickUp status exactly once', () => {
    expect(CLICKUP_ORDER_OPERATIONAL_STATUSES).toHaveLength(12);
    expect(new Set(CLICKUP_ORDER_OPERATIONAL_STATUSES)).toHaveLength(12);
  });

  it('keeps prep-center states out of Amazon inbound', () => {
    expect(workflowStageForOperationalStatus('ordered')).toBe('in_prep');
    expect(workflowStageForOperationalStatus('prep-in-progress')).toBe('in_prep');
    expect(workflowStageForOperationalStatus('in transit to prep')).toBe('in_prep');
    expect(canonicalOrderStatusForOperationalStatus('prep-in-progress')).toBe('paid');
    expect(lifecycleStatusForOperationalStatus('prep-in-progress')).toBe('PREP IN-PROGRESS');
  });

  it('classifies stage behavior without lossy status aliases', () => {
    expect(isPrePurchaseStage('pre_purchase')).toBe(true);
    expect(isPrePurchaseStage('hold')).toBe(true);
    expect(isPrepStage('in_prep')).toBe(true);
    expect(isInboundStage('amazon_inbound')).toBe(true);
    expect(isClosedStage('cancelled')).toBe(true);
    expect(isClosedStage('complete')).toBe(true);
    expect(providesPurchasedCoverage('in_prep')).toBe(true);
    expect(providesPurchasedCoverage('amazon_inbound')).toBe(true);
    expect(providesPurchasedCoverage('pre_purchase')).toBe(false);
    expect(providesPurchasedCoverage('hold')).toBe(false);
    expect(providesPurchasedCoverage('cancelled')).toBe(false);
    expect(providesPurchasedCoverage('complete')).toBe(false);
  });

  it('rejects an unknown status instead of assigning a workflow stage', () => {
    expect(clickupOrderOperationalStatus('waiting for supplier')).toBeUndefined();
    expect(workflowStageForOperationalStatus('waiting for supplier')).toBeUndefined();
    expect(canonicalOrderStatusForOperationalStatus('waiting for supplier')).toBeUndefined();
  });

  it('folds the at-prep-not started alias into prep-in-progress (user decision 2026-07-24)', () => {
    // Case/whitespace tolerant, resolving to the same status object as prep-in-progress.
    expect(clickupOrderOperationalStatus('At-Prep-Not Started ')).toBe('prep-in-progress');
    expect(canonicalOrderStatusForOperationalStatus('at-prep-not started')).toBe(
      canonicalOrderStatusForOperationalStatus('prep-in-progress'),
    );
    expect(lifecycleStatusForOperationalStatus('at-prep-not started')).toBe('PREP IN-PROGRESS');
    expect(workflowStageForOperationalStatus('at-prep-not started')).toBe('in_prep');
    // The ClickUp importer marks statusCheckRequired exactly when the canonical mapping is
    // absent — a defined mapping means the previous unmapped behavior no longer triggers.
    expect(canonicalOrderStatusForOperationalStatus('at-prep-not started')).toBe('paid');
    // The alias never joins the operator-facing vocabulary.
    expect(CLICKUP_ORDER_OPERATIONAL_STATUSES).not.toContain('at-prep-not started');
  });
});
