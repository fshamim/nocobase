/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
        actions: [
          'filters',
          'refreshReadModel',
          'reconcileFamilies',
          'reconcileReceipts',
          'backfillReceipts',
          'setReceiptOverride',
          'setFamilyTarget',
          'setFamilyPreferredSupplier',
          'workspace',
          'commandCenter',
          'rows',
          'digestPreview',
          'rowWorkspace',
          'optimizeBudget',
        ],
        role: LOGGED_IN,
      },
      { resource: 'ecobasePlanningSettings', actions: ['get', 'save', 'reset'], role: LOGGED_IN },
      { resource: ECOBASE_COLLECTIONS.planningSettings, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
