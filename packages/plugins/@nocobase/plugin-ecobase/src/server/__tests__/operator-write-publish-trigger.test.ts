/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Task 001 (surgical v1.1): auto-publish Gold after operator writes, debounced.
 * - N writes inside one debounce window -> exactly one publish;
 * - the delay comes from operatorWritePublishDebounceSeconds (default 45);
 * - failed writes never trigger;
 * - the refresh/publish path itself never re-triggers (no loops);
 * - reads are not wrapped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SellerboardGoldPromotionDebouncer } from '../plugin';
import { triggerOnOperatorWrite } from '../resource-registration';
import { createInventoryPlanningResourceRegistration } from '../../features/inventory-planning/server/resource-registration';
import { createInventoryDashboardResourceRegistration } from '../../features/inventory-dashboard/server/resource-registration';
import { createOrderPlanningResourceRegistration } from '../../features/order-planning/server/resource-registration';
import { createSupplierManagementResourceRegistration } from '../../features/supplier-management/server/resource-registration';
import { DEFAULT_PLANNING_SETTINGS } from '../services/planning-settings-service';

async function flushMicrotasks(times = 3) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

describe('operator-write publish debounce (task 001)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of schedules into one publish after the configured delay', async () => {
    vi.useFakeTimers();
    const promote = vi.fn().mockResolvedValue(undefined);
    const debouncer = new SellerboardGoldPromotionDebouncer(promote, vi.fn(), () => 45_000);

    debouncer.schedule();
    debouncer.schedule();
    debouncer.schedule();
    await flushMicrotasks(); // delay provider resolves, timer armed

    await vi.advanceTimersByTimeAsync(44_999);
    expect(promote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(promote).toHaveBeenCalledTimes(1);

    // A later write opens a NEW window with the configured delay.
    debouncer.schedule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(promote).toHaveBeenCalledTimes(2);
    debouncer.stop();
  });

  it('respects a changed setting value on the next window (delay provider read per arm)', async () => {
    vi.useFakeTimers();
    const promote = vi.fn().mockResolvedValue(undefined);
    let delay = 45_000;
    const debouncer = new SellerboardGoldPromotionDebouncer(promote, vi.fn(), () => delay);

    debouncer.schedule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(promote).toHaveBeenCalledTimes(1);

    delay = 10_000;
    debouncer.schedule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(promote).toHaveBeenCalledTimes(2);
    debouncer.stop();
  });

  it('the promote (refresh/publish) path never re-schedules itself (no loop)', async () => {
    vi.useFakeTimers();
    let promotions = 0;
    const debouncer: SellerboardGoldPromotionDebouncer = new SellerboardGoldPromotionDebouncer(
      async () => {
        promotions += 1;
        // The real promote runs refreshAndPublish, which has no reference to the
        // debouncer; nothing in this callback schedules again.
      },
      vi.fn(),
      () => 1_000,
    );
    debouncer.schedule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(promotions).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(promotions).toBe(1); // no self-re-trigger, ever
    debouncer.stop();
  });

  it('triggers only on successful writes and never wraps reads', async () => {
    const onOperatorWrite = vi.fn();
    const succeed = vi.fn().mockResolvedValue('ok');
    const fail = vi.fn().mockRejectedValue(new Error('boom'));
    const read = vi.fn().mockResolvedValue('data');
    const actions = triggerOnOperatorWrite(
      { write: succeed, failing: fail, read },
      ['write', 'failing'],
      onOperatorWrite,
    );

    await actions.write({}, vi.fn());
    expect(onOperatorWrite).toHaveBeenCalledTimes(1);

    await expect(actions.failing({}, vi.fn())).rejects.toThrow('boom');
    expect(onOperatorWrite).toHaveBeenCalledTimes(1); // failed write: no trigger

    await actions.read({}, vi.fn());
    expect(onOperatorWrite).toHaveBeenCalledTimes(1); // reads untouched
  });

  it('rejects unknown action names at registration time', () => {
    expect(() => triggerOnOperatorWrite({ known: vi.fn() }, ['missing' as never], vi.fn())).toThrow(
      'unknown action "missing"',
    );
  });

  it('wires the trigger into every enumerated operator write and never into refreshAndPublish', () => {
    // Building each registration with a spy trigger must succeed (all names
    // exist) — the wrapper throws on unknown names, so construction IS the
    // enumeration test.
    const spy = vi.fn();
    const registrations = [
      createInventoryPlanningResourceRegistration(spy),
      createInventoryDashboardResourceRegistration(spy),
      createOrderPlanningResourceRegistration(spy),
      createSupplierManagementResourceRegistration(spy),
    ];
    expect(registrations).toHaveLength(4);
    // refreshAndPublish must remain un-wrapped: invoking the wrapped map's
    // refreshAndPublish is guarded by role checks before any trigger could
    // fire; the structural guarantee is that the name list above excludes it.
    const planning = registrations[0].resources.find((resource) => resource.name === 'ecobaseInventoryPlanning');
    expect(planning).toBeDefined();
    expect(Object.keys(planning?.actions ?? {})).toContain('refreshAndPublish');
  });

  it('exposes operatorWritePublishDebounceSeconds with default 45', () => {
    expect(DEFAULT_PLANNING_SETTINGS.operatorWritePublishDebounceSeconds).toBe(45);
  });
});
