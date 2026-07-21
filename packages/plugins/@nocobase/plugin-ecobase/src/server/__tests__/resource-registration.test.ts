/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDailyOperationsBriefResourceRegistration } from '../../features/daily-operations-brief/server/resource-registration';
import { createInventoryPlanningResourceRegistration } from '../../features/inventory-planning/server/resource-registration';
import { createOrderPlanningResourceRegistration } from '../../features/order-planning/server/resource-registration';
import { createSemanticModelResourceRegistration } from '../../features/semantic-model/server/resource-registration';
import { createSourceAdapterRegistry, noopTestAdapter } from '../../features/source-import/server/adapters';
import { createSourceImportResourceRegistration } from '../../features/source-import/server/resource-registration';
import { EcobaseImportService } from '../../features/source-import/server/import-service';
import { EcobaseSupplierOrderImportApplyService } from '../../features/source-import/server/supplier-order-import-apply-service';
import { EcobaseSupplierOrderImportService } from '../../features/source-import/server/supplier-order-import-service';
import { EcobaseCompanyProductFamilyService } from '../../features/inventory-planning/server/company-product-family-service';
import { createSupplierManagementResourceRegistration } from '../../features/supplier-management/server/resource-registration';
import { createEcobaseImportActions, createEcobaseInventoryPlanningActions } from '../resource-actions';
import { LOGGED_IN, OPERATOR, registerEcobaseResources } from '../resource-registration';

function registerAll() {
  const resources: { name: string; actions: Record<string, unknown> }[] = [];
  const acl: { resource: string; actions: string[]; role: unknown }[] = [];
  registerEcobaseResources(
    {
      resourceManager: { define: (definition) => resources.push(definition) },
      acl: { allow: (resource, actions, role) => acl.push({ resource, actions, role }) },
    },
    [
      createSourceImportResourceRegistration(createSourceAdapterRegistry([noopTestAdapter])),
      createInventoryPlanningResourceRegistration(),
      createOrderPlanningResourceRegistration(),
      createSupplierManagementResourceRegistration(),
      createSemanticModelResourceRegistration(),
      createDailyOperationsBriefResourceRegistration(),
    ],
  );
  return { resources, acl };
}

describe('Ecobase resource registration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers only active feature resources with aligned ACL actions', () => {
    const { resources, acl } = registerAll();
    const names = resources.map((resource) => resource.name);
    expect(names).toEqual([
      'ecobaseImport',
      'ecobaseInventoryPlanning',
      'ecobasePlanningConfiguration',
      'ecobaseOrderPlanning',
      'ecobaseSupplierOrders',
      'ecobaseSupplierManagement',
      'ecobaseMedallionWorkflow',
      'ecobaseSilverData',
      'ecobaseReports',
    ]);
    expect(names).not.toContain('ecobasePlanning');
    expect(names).not.toContain('ecobaseAccuracy');
    expect(names).not.toContain('ecobaseDashboard');

    const inventoryActions = acl
      .filter((grant) => grant.resource === 'ecobaseInventoryPlanning')
      .flatMap((grant) => grant.actions);
    expect(inventoryActions).toEqual(
      expect.arrayContaining([
        'filters',
        'refreshReadModel',
        'workspace',
        'rows',
        'digestPreview',
        'rowWorkspace',
        'optimizeBudget',
      ]),
    );
    const inventoryGrants = createInventoryPlanningResourceRegistration().acl;
    const operatorActions = inventoryGrants
      .filter((grant) => grant.resource === 'ecobaseInventoryPlanning' && grant.role === OPERATOR)
      .flatMap((grant) => grant.actions);
    const loggedInActions = inventoryGrants
      .filter((grant) => grant.resource === 'ecobaseInventoryPlanning' && grant.role === LOGGED_IN)
      .flatMap((grant) => grant.actions);
    expect(operatorActions).toContain('refreshAndPublish');
    expect(loggedInActions).not.toContain('refreshAndPublish');
    for (const resource of resources) {
      const grantedActions = acl.filter((entry) => entry.resource === resource.name).flatMap((entry) => entry.actions);
      expect(grantedActions.sort()).toEqual(Object.keys(resource.actions).sort());
    }
  });

  it('exposes the deep Sellerboard report-unit action without caller-owned execution controls', async () => {
    const result = { id: 'report-unit-1', status: 'success' };
    const runUnit = vi
      .spyOn(EcobaseImportService.prototype, 'runSellerboardReportUnit')
      .mockResolvedValue(result as never);
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const ctx = {
      state: { currentUser: { id: 1 }, currentRoles: ['root'] },
      action: {
        params: {
          values: {
            sourceConnectionId: 'sellerboard-source-1',
            reportKind: 'stock_daily',
            sourceVersion: 'caller-must-not-control-this',
            skipExistingNormalizedKinds: ['listing_daily_fact'],
          },
        },
      },
      db: {},
      throw: (status: number, message: string): never => {
        throw new Error(`${status}: ${message}`);
      },
      body: undefined as unknown,
    };
    const next = vi.fn();

    await actions.runSellerboardReportUnit(ctx as never, next);

    expect(runUnit).toHaveBeenCalledWith({
      sourceConnectionId: 'sellerboard-source-1',
      reportKind: 'stock_daily',
    });
    expect(ctx.body).toEqual({ data: result });
    expect(next).toHaveBeenCalledOnce();
  });

  it('runs the family reconciliation action with protected catalog identity', async () => {
    const result = { createdFamilyCount: 0, linkedCompanyProductCount: 0 };
    const reconcile = vi
      .spyOn(EcobaseCompanyProductFamilyService.prototype, 'reconcileAllFamilies')
      .mockResolvedValue(result as never);
    const ctx = {
      state: { currentUser: { id: 1 }, currentRoles: ['root'] },
      action: { params: { values: {} } },
      db: {},
      body: undefined as unknown,
    };
    const next = vi.fn();

    await createEcobaseInventoryPlanningActions().reconcileFamilies(ctx as never, next);

    expect(reconcile).toHaveBeenCalledWith(undefined, { preserveCatalog: true });
    expect(ctx.body).toEqual({ data: result });
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps protected family reconciliation outside supplier/order apply', async () => {
    const preflightDigest = '479bb3cb19ce0831bd353dfafc04ed138722d466545c26c94c65c00d2934b8d7';
    const preflight = { preflightDigest };
    const apply = { preflightDigest, totalWrites: 1 };
    vi.spyOn(EcobaseSupplierOrderImportService.prototype, 'assertCatalogCurrent').mockResolvedValue(undefined);
    vi.spyOn(EcobaseSupplierOrderImportApplyService.prototype, 'apply').mockResolvedValue(apply as never);
    const reconcile = vi.spyOn(EcobaseCompanyProductFamilyService.prototype, 'reconcileAllFamilies');
    const ctx = {
      state: { currentUser: { id: 1 }, currentRoles: ['root'] },
      action: {
        params: {
          values: {
            preflight,
            confirmation: `APPLY_SUPPLIER_ORDER_${preflightDigest.slice(0, 12).toUpperCase()}`,
          },
        },
      },
      db: {},
      throw: (status: number, message: string): never => {
        throw new Error(`${status}: ${message}`);
      },
      body: undefined as unknown,
    };
    const next = vi.fn();

    await createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter])).applySupplierOrderImportPreflight(
      ctx as never,
      next,
    );

    expect(ctx.body).toEqual({ data: apply });
    expect(reconcile).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
