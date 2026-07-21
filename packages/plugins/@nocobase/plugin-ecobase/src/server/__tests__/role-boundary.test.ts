/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createEcobaseImportActions,
  createEcobaseInventoryPlanningActions,
  createEcobaseOrderPlanningActions,
  createEcobaseReportActions,
  createEcobaseSilverDataActions,
  createEcobaseSupplierOrderActions,
} from '../resource-actions';
import { ecobaseAclCondition, requireEcobaseRole } from '../role-boundary';
import { ECOBASE_PILOT_ROLE_ASSIGNMENT_MANIFEST } from '../role-assignment-manifest';
import { ECOBASE_OPERATOR_ROLE } from '../migrations/20260715144000-create-operator-role';
import { createInventoryPlanningResourceRegistration } from '../../features/inventory-planning/server/resource-registration';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import { createOrderPlanningResourceRegistration } from '../../features/order-planning/server/resource-registration';

const USERS = {
  member: { id: 2, role: 'member' },
  operator: { id: 4, role: 'operator' },
  admin: { id: 1, role: 'admin' },
} as const;

function context(user: (typeof USERS)[keyof typeof USERS], values: Record<string, unknown> = {}) {
  return {
    action: { params: { values } },
    db: {},
    state: { currentUser: { id: user.id }, currentRole: user.role, currentRoles: [user.role] },
    body: undefined as unknown,
    throw(status: number, message: string): never {
      throw Object.assign(new Error(message), { status });
    },
  };
}

describe('EcoBase role boundary', () => {
  it('keeps member reads allowed but rejects mutations before request validation', async () => {
    expect(ecobaseAclCondition('loggedIn')).toBe('loggedIn');
    expect((ecobaseAclCondition('operator') as (ctx: unknown) => boolean)(context(USERS.member))).toBe(false);
    expect((ecobaseAclCondition('operator') as (ctx: unknown) => boolean)(context(USERS.operator))).toBe(true);

    await expect(createEcobaseOrderPlanningActions().updateOrder(context(USERS.member), vi.fn())).rejects.toMatchObject(
      {
        status: 403,
        message: expect.stringContaining('operator, admin, or root'),
      },
    );
    await expect(
      createEcobaseSupplierOrderActions().updateOrderOperatorFields(context(USERS.member), vi.fn()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createEcobaseInventoryPlanningActions().setFamilyTarget(context(USERS.member), vi.fn()),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows the named pilot operator to reach approved operational validation only', async () => {
    await expect(
      createEcobaseOrderPlanningActions().updateOrder(context(USERS.operator), vi.fn()),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('requires orderId') });
    await expect(
      createEcobaseSupplierOrderActions().updateOrderOperatorFields(context(USERS.operator), vi.fn()),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('requires supplierOrderId and company') });
    await expect(
      createEcobaseInventoryPlanningActions().setFamilyTarget(context(USERS.operator), vi.fn()),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('requires familyId') });

    await expect(
      createEcobaseInventoryPlanningActions().applyAutomaticTargetCorrections(context(USERS.operator), vi.fn()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createEcobaseInventoryPlanningActions().refreshReadModel(context(USERS.operator), vi.fn()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(createEcobaseImportActions({} as any).run(context(USERS.operator), vi.fn())).rejects.toMatchObject({
      status: 403,
    });
    await expect(createEcobaseSilverDataActions().updateRecord(context(USERS.operator), vi.fn())).rejects.toMatchObject(
      {
        status: 403,
      },
    );
  });

  it('allows operators and admins to run the supported one-button Gold publication action', async () => {
    const published = { published: true, reused: false, run: { id: 'published-run', status: 'published' } };
    const refreshAndPublish = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshAndPublish')
      .mockResolvedValue(published as never);
    const next = vi.fn();
    const operatorContext = context(USERS.operator, { calculationDate: '2026-07-16' });

    await createEcobaseInventoryPlanningActions().refreshAndPublish(operatorContext, next);

    expect(refreshAndPublish).toHaveBeenCalledWith({
      calculationDate: '2026-07-16',
      requestedByUserId: '4',
    });
    expect(operatorContext.body).toEqual({ data: published });
    expect(next).toHaveBeenCalledOnce();
    await expect(
      createEcobaseInventoryPlanningActions().refreshAndPublish(context(USERS.member), vi.fn()),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('keeps generated reports and linked comments at the operator boundary', async () => {
    await expect(createEcobaseReportActions().generatePreview(context(USERS.member), vi.fn())).rejects.toMatchObject({
      status: 403,
    });
    await expect(createEcobaseReportActions().generatePreview(context(USERS.operator), vi.fn())).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('frequency'),
    });
    await expect(createEcobaseSilverDataActions().addComment(context(USERS.member), vi.fn())).rejects.toMatchObject({
      status: 403,
    });
    await expect(createEcobaseSilverDataActions().addComment(context(USERS.operator), vi.fn())).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('type and id'),
    });
  });

  it('allows admin maintenance to reach confirmation validation', async () => {
    await expect(
      createEcobaseInventoryPlanningActions().applyAutomaticTargetCorrections(context(USERS.admin), vi.fn()),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('decisionDigest and confirmation') });
    await expect(
      createEcobaseInventoryPlanningActions().refreshReadModel(context(USERS.admin), vi.fn()),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('REBUILD GOLD') });
  });

  it('registers distinct read, operator, and admin ACL grants', () => {
    const grants = [
      ...createInventoryPlanningResourceRegistration().acl,
      ...createOrderPlanningResourceRegistration().acl,
    ];
    const isGranted = (resource: string, action: string, user: (typeof USERS)[keyof typeof USERS]) => {
      const grant = grants.find((candidate) => candidate.resource === resource && candidate.actions.includes(action));
      if (!grant) return false;
      const condition = ecobaseAclCondition(grant.role);
      return typeof condition === 'function' ? condition(context(user)) : condition === 'loggedIn';
    };

    expect(isGranted('ecobaseInventoryPlanning', 'rows', USERS.member)).toBe(true);
    expect(isGranted('ecobaseInventoryPlanning', 'listingPerformanceReview', USERS.member)).toBe(true);
    expect(isGranted('ecobaseInventoryPlanning', 'setFamilyTarget', USERS.member)).toBe(false);
    expect(isGranted('ecobaseInventoryPlanning', 'setFamilyTarget', USERS.operator)).toBe(true);
    expect(isGranted('ecobaseInventoryPlanning', 'refreshReadModel', USERS.operator)).toBe(false);
    expect(isGranted('ecobaseInventoryPlanning', 'refreshReadModel', USERS.admin)).toBe(true);
    expect(isGranted('ecobaseInventoryPlanning', 'refreshAndPublish', USERS.member)).toBe(false);
    expect(isGranted('ecobaseInventoryPlanning', 'refreshAndPublish', USERS.operator)).toBe(true);
    expect(isGranted('ecobaseInventoryPlanning', 'refreshAndPublish', USERS.admin)).toBe(true);
    expect(isGranted('ecobaseOrderPlanning', 'updateOrder', USERS.member)).toBe(false);
    expect(isGranted('ecobaseOrderPlanning', 'updateOrder', USERS.operator)).toBe(true);
  });

  it('requires authentication independently of role claims', () => {
    expect(() =>
      requireEcobaseRole(
        {
          state: { currentRoles: ['admin'] },
          throw(status: number, message: string): never {
            throw Object.assign(new Error(message), { status });
          },
        },
        'admin',
      ),
    ).toThrow('requires an authenticated user');
  });

  it('defines one non-default operator role and one explicit non-automatic pilot assignment', () => {
    expect(ECOBASE_OPERATOR_ROLE).toMatchObject({ name: 'operator', default: false, allowConfigure: false });
    expect(ECOBASE_PILOT_ROLE_ASSIGNMENT_MANIFEST).toEqual(
      expect.objectContaining({
        applyAutomatically: false,
        assignments: [expect.objectContaining({ username: 'kiran-mehtab', role: 'operator' })],
      }),
    );
  });
});
