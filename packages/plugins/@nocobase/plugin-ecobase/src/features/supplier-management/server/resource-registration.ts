/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  createEcobaseSupplierManagementActions,
  createEcobaseSupplierOrderActions,
} from '../../../server/resource-actions';
import {
  ADMIN,
  LOGGED_IN,
  OPERATOR,
  triggerOnOperatorWrite,
  type EcobaseFeatureResourceRegistration,
} from '../../../server/resource-registration';

export function createSupplierManagementResourceRegistration(
  onOperatorWrite?: () => void,
): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      {
        name: 'ecobaseSupplierOrders',
        actions: triggerOnOperatorWrite(
          createEcobaseSupplierOrderActions(),
          [
            'createPlannedOrder',
            'createOrderLine',
            'createMedallionDraftOrder',
            'addMedallionOrderLine',
            'updateOrderOperatorFields',
            'updateLineOperatorFields',
            'deleteLineOperatorFields',
            'updateSupplierLeadTime',
            'recordActivity',
            'updateActivityComment',
            'deleteActivityComment',
          ],
          onOperatorWrite,
        ),
      },
      {
        name: 'ecobaseSupplierManagement',
        actions: triggerOnOperatorWrite(
          createEcobaseSupplierManagementActions(),
          [
            'createSupplier',
            'updateSupplierProfile',
            'createSupplierOrder',
            'recordActivity',
            'updateProductLeadTime',
            'updateSupplierLifecycle',
            'recordComment',
            'deleteComment',
            'updateSupplierAccount',
            'upsertSupplierProduct',
          ],
          onOperatorWrite,
        ),
      },
    ],
    acl: [
      { resource: 'ecobaseSupplierOrders', actions: ['workspace', 'getCoverage'], role: LOGGED_IN },
      {
        resource: 'ecobaseSupplierOrders',
        actions: [
          'createPlannedOrder',
          'createOrderLine',
          'createMedallionDraftOrder',
          'addMedallionOrderLine',
          'updateOrderOperatorFields',
          'updateLineOperatorFields',
          'deleteLineOperatorFields',
          'updateSupplierLeadTime',
          'recordActivity',
          'updateActivityComment',
          'deleteActivityComment',
        ],
        role: OPERATOR,
      },
      { resource: 'ecobaseSupplierOrders', actions: ['reconcileImportedLines'], role: ADMIN },
      {
        resource: 'ecobaseSupplierManagement',
        actions: ['rows', 'summary', 'digest', 'detail', 'supplierOptions', 'productOptions', 'orderOptions'],
        role: LOGGED_IN,
      },
      {
        resource: 'ecobaseSupplierManagement',
        actions: [
          'createSupplier',
          'updateSupplierProfile',
          'createSupplierOrder',
          'recordActivity',
          'updateProductLeadTime',
          'updateSupplierLifecycle',
          'recordComment',
          'deleteComment',
          'updateSupplierAccount',
          'upsertSupplierProduct',
        ],
        role: OPERATOR,
      },
      {
        resource: 'ecobaseSupplierManagement',
        actions: ['previewSupplierResolutionRepair', 'applySupplierResolutionRepair', 'refreshAttentionRows'],
        role: ADMIN,
      },
    ],
  };
}
