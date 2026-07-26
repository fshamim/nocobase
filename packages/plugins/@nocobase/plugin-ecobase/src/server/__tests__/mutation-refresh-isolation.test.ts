/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EcobaseCompanyProductFamilyService } from '../../features/semantic-model/server/company-product-family-service';
import { EcobaseInventoryPlanningService } from '../../features/inventory-dashboard/server/engine/inventory-planning-service';
import { EcobaseOrderReceiptReconciliationService } from '../../features/inventory-dashboard/server/engine/order-receipt-reconciliation-service';
import { EcobaseOrderPlanningService } from '../../features/order-planning/server/order-planning-service';
import { EcobaseMedallionWorkflowService } from '../../features/semantic-model/server/medallion-workflow-service';
import { EcobaseSupplierOrderService } from '../../features/supplier-management/server/supplier-order-service';
import {
  createEcobaseInventoryPlanningActions,
  createEcobaseMedallionWorkflowActions,
  createEcobaseOrderPlanningActions,
  createEcobasePlanningSettingsActions,
  createEcobaseSupplierOrderActions,
} from '../resource-actions';
import { EcobasePlanningSettingsService } from '../services/planning-settings-service';

function context(values: Record<string, unknown>, role = 'operator') {
  return {
    action: { params: { values } },
    body: undefined as unknown,
    db: {},
    state: { currentRole: role, currentRoles: [role], currentUser: { id: `${role}-1` } },
    throw(status: number, message: string): never {
      throw Object.assign(new Error(message), { status });
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('mutation and full Gold refresh isolation', () => {
  it('does not leave automatic inventory refresh calls in mutation or import paths', () => {
    const root = resolve(process.cwd(), 'packages/plugins/@nocobase/plugin-ecobase/src');
    const actionSource = readFileSync(resolve(root, 'server/resource-actions.ts'), 'utf8');
    const importSource = readFileSync(resolve(root, 'features/source-import/server/import-service.ts'), 'utf8');

    expect(actionSource).not.toMatch(/new EcobaseInventoryPlanningService\(ctx\.db\)\.refreshReadModel/);
    expect(importSource).not.toContain('this.refreshGoldReadModels(');
  });

  it('keeps order, receipt, planning, family, supplier, workflow, and settings mutations local', async () => {
    const refresh = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshReadModel')
      .mockRejectedValue(new Error('mutation attempted a full Gold rebuild'));

    vi.spyOn(EcobaseOrderPlanningService.prototype, 'updateOrder').mockResolvedValue({
      order: { companyName: 'Ecofission LLC' },
    } as never);
    const orderContext = context({ orderId: 'order-1', fields: { status: 'paid' } });
    await createEcobaseOrderPlanningActions().updateOrder(orderContext, vi.fn());
    expect(orderContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();

    vi.spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'setOperatorOverride').mockResolvedValue({
      lineId: 'line-1',
    } as never);
    const receiptContext = context({ lineId: 'line-1', reason: 'Reviewed receipt evidence.' });
    await createEcobaseInventoryPlanningActions().setReceiptOverride(receiptContext, vi.fn());
    expect(receiptContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();

    vi.spyOn(EcobaseInventoryPlanningService.prototype, 'updateProductPlanningFields').mockResolvedValue({
      id: 'company-product-1',
    } as never);
    const productContext = context({ companyProductId: 'company-product-1', planningExcluded: true });
    await createEcobaseInventoryPlanningActions().updateProductPlanningFields(productContext, vi.fn());
    expect(productContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();

    vi.spyOn(EcobaseCompanyProductFamilyService.prototype, 'setReplenishmentTarget').mockResolvedValue({
      id: 'family-1',
    } as never);
    const familyContext = context({
      familyId: 'family-1',
      companyProductId: 'company-product-1',
      reason: 'Reviewed target.',
    });
    await createEcobaseInventoryPlanningActions().setFamilyTarget(familyContext, vi.fn());
    expect(familyContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();
    await expect(
      createEcobaseInventoryPlanningActions().setFamilyTarget(
        context({ familyId: 'family-1', companyProductId: 'company-product-1' }),
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Ecobase family target selection requires familyId, companyProductId, and reason.',
    });

    vi.spyOn(EcobaseSupplierOrderService.prototype, 'updateOrderOperatorFields').mockResolvedValue({
      id: 'supplier-order-1',
    } as never);
    const supplierContext = context({ supplierOrderId: 'supplier-order-1', company: 'Ecofission LLC' });
    await createEcobaseSupplierOrderActions().updateOrderOperatorFields(supplierContext, vi.fn());
    expect(supplierContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();

    vi.spyOn(EcobaseMedallionWorkflowService.prototype, 'approveAndExecute').mockResolvedValue({
      id: 'approval-1',
    } as never);
    const workflowContext = context({ approvalId: 'approval-1' });
    await createEcobaseMedallionWorkflowActions().approveAndExecute(workflowContext, vi.fn());
    expect(workflowContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();

    vi.spyOn(EcobaseCompanyProductFamilyService.prototype, 'applyAutomaticTargetCorrections').mockResolvedValue({
      changedCount: 1,
    } as never);
    const correctionContext = context({ decisionDigest: 'digest', confirmation: 'APPLY' }, 'admin');
    await createEcobaseInventoryPlanningActions().applyAutomaticTargetCorrections(correctionContext, vi.fn());
    expect(correctionContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();

    vi.spyOn(EcobasePlanningSettingsService.prototype, 'saveSettings').mockResolvedValue({ id: 'settings-1' } as never);
    const settingsContext = context({ targetCoverDays: 90 }, 'admin');
    await createEcobasePlanningSettingsActions().save(settingsContext, vi.fn());
    expect(settingsContext.body).toMatchObject({ data: { goldRefreshRequired: true } });
    expect(refresh).not.toHaveBeenCalled();
  });
});
