import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import {
  createEcobaseInventoryPlanningActions,
  createEcobasePlanningSettingsActions,
} from '../../../server/resource-actions';
import { LOGGED_IN, type EcobaseFeatureResourceRegistration } from '../../../server/resource-registration';

export function createInventoryPlanningResourceRegistration(): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      { name: 'ecobaseInventoryPlanning', actions: createEcobaseInventoryPlanningActions() },
      { name: 'ecobasePlanningSettings', actions: createEcobasePlanningSettingsActions() },
    ],
    acl: [
      {
        resource: 'ecobaseInventoryPlanning',
        actions: ['filters', 'refreshReadModel', 'workspace', 'rows', 'digestPreview', 'rowWorkspace', 'optimizeBudget'],
        role: LOGGED_IN,
      },
      { resource: 'ecobasePlanningSettings', actions: ['get', 'save', 'reset'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.planningSettings, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
