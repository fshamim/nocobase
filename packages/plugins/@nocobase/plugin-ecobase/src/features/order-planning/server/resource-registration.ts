import { createEcobaseOrderPlanningActions } from '../../../server/resource-actions';
import { LOGGED_IN, type EcobaseFeatureResourceRegistration } from '../../../server/resource-registration';

export function createOrderPlanningResourceRegistration(): EcobaseFeatureResourceRegistration {
  return {
    resources: [{ name: 'ecobaseOrderPlanning', actions: createEcobaseOrderPlanningActions() }],
    acl: [
      {
        resource: 'ecobaseOrderPlanning',
        actions: [
          'filters',
          'list',
          'refreshReadModel',
          'detail',
          'updateOrder',
          'updateLine',
          'addComment',
          'updateInvoice',
          'deleteComment',
        ],
        role: LOGGED_IN,
      },
    ],
  };
}
