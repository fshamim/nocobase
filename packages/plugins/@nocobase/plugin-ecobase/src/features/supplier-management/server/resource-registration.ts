import {
  createEcobaseSupplierManagementActions,
  createEcobaseSupplierOrderActions,
} from '../../../server/resource-actions';
import { LOGGED_IN, type EcobaseFeatureResourceRegistration } from '../../../server/resource-registration';

export function createSupplierManagementResourceRegistration(): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      { name: 'ecobaseSupplierOrders', actions: createEcobaseSupplierOrderActions() },
      { name: 'ecobaseSupplierManagement', actions: createEcobaseSupplierManagementActions() },
    ],
    acl: [
      {
        resource: 'ecobaseSupplierOrders',
        actions: [
          'workspace',
          'getCoverage',
          'createPlannedOrder',
          'createOrderLine',
          'createMedallionDraftOrder',
          'addMedallionOrderLine',
          'updateOrderOperatorFields',
          'updateLineOperatorFields',
          'deleteLineOperatorFields',
          'updateSupplierLeadTime',
          'recordActivity',
        ],
        role: LOGGED_IN,
      },
      {
        resource: 'ecobaseSupplierManagement',
        actions: [
          'refreshAttentionRows',
          'rows',
          'summary',
          'digest',
          'detail',
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
          'supplierOptions',
          'productOptions',
          'orderOptions',
        ],
        role: LOGGED_IN,
      },
    ],
  };
}
