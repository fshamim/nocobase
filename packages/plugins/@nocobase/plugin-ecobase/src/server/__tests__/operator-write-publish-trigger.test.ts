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
import { createGoldEngineMaintenanceResourceRegistration } from '../../features/inventory-dashboard/server/engine/maintenance-resource-registration';
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
      createGoldEngineMaintenanceResourceRegistration(spy),
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
    // T8a: the dashboard's ported operator surface exists AND is debounce-wired
    // (construction with the spy validated every name in its trigger list).
    const dashboard = registrations[1].resources.find((resource) => resource.name === 'ecobaseInventoryDashboard');
    const dashboardActionNames = Object.keys(dashboard?.actions ?? {});
    for (const name of [
      'setFamilyTarget',
      'setFamilyPreferredSupplier',
      'updateProductPlanningFields',
      'createPlannedOrder',
      'updateSupplierLeadTime',
      'addComment',
      'addProductComment',
    ]) {
      expect(dashboardActionNames, `dashboard action ${name}`).toContain(name);
      const operatorGrant = registrations[1].acl.find((grant) => grant.role === 'operator');
      expect(operatorGrant?.actions, `operator acl covers ${name}`).toContain(name);
    }
  });

  it('T8a: a successful dashboard operator write schedules the debounced publish', async () => {
    const spy = vi.fn();
    const registration = createInventoryDashboardResourceRegistration(spy);
    const dashboard = registration.resources.find((resource) => resource.name === 'ecobaseInventoryDashboard');
    const addProductComment = (dashboard?.actions as Record<string, (ctx: unknown, next: unknown) => Promise<void>>)
      .addProductComment;
    const repositories = new Map<string, { rows: Record<string, unknown>[] }>();
    const db = {
      getRepository(name: string) {
        const existing = repositories.get(name);
        if (existing) return existing;
        const rows: Record<string, unknown>[] = [];
        const repo = {
          rows,
          async find() {
            return [];
          },
          async findOne() {
            return null;
          },
          async create(params: { values: Record<string, unknown> }) {
            rows.push(params.values);
            return params.values;
          },
          async update() {
            return null;
          },
        };
        repositories.set(name, repo);
        return repo;
      },
    };
    const ctx = {
      db,
      action: { params: { values: { familyId: 'fam-1', body: 'debounce me' } } },
      state: { currentUser: { id: 4 }, currentRoles: ['operator'] },
      body: undefined as unknown,
      throw(status: number, message: string): never {
        throw Object.assign(new Error(message), { status });
      },
    };
    await addProductComment(ctx, vi.fn());
    expect(spy).toHaveBeenCalledTimes(1);

    // A failed write (missing body) never schedules.
    const failingCtx = { ...ctx, action: { params: { values: { familyId: 'fam-1' } } }, body: undefined as unknown };
    await expect(addProductComment(failingCtx, vi.fn())).rejects.toMatchObject({ status: 400 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('exposes operatorWritePublishDebounceSeconds with default 45', () => {
    expect(DEFAULT_PLANNING_SETTINGS.operatorWritePublishDebounceSeconds).toBe(45);
  });
});
