/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { createDailyOperationsBriefResourceRegistration } from '../../features/daily-operations-brief/server/resource-registration';
import { createInventoryPlanningResourceRegistration } from '../../features/inventory-planning/server/resource-registration';
import { createOrderPlanningResourceRegistration } from '../../features/order-planning/server/resource-registration';
import { createSemanticModelResourceRegistration } from '../../features/semantic-model/server/resource-registration';
import { createSourceAdapterRegistry, noopTestAdapter } from '../../features/source-import/server/adapters';
import { createSourceImportResourceRegistration } from '../../features/source-import/server/resource-registration';
import { createSupplierManagementResourceRegistration } from '../../features/supplier-management/server/resource-registration';
import { registerEcobaseResources } from '../resource-registration';

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
    for (const resource of resources) {
      const grantedActions = acl.filter((entry) => entry.resource === resource.name).flatMap((entry) => entry.actions);
      expect(grantedActions.sort()).toEqual(Object.keys(resource.actions).sort());
    }
  });
});
