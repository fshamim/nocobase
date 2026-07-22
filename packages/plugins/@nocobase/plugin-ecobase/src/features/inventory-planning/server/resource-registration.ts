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
import {
  ADMIN,
  LOGGED_IN,
  OPERATOR,
  type EcobaseFeatureResourceRegistration,
  triggerOnOperatorWrite,
} from '../../../server/resource-registration';

export function createInventoryPlanningResourceRegistration(
  onOperatorWrite?: () => void,
): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      {
        name: 'ecobaseInventoryPlanning',
        // Task 001: operator silver-fact writers only — refreshAndPublish IS the
        // publish and must never re-trigger the debouncer (no loops).
        actions: triggerOnOperatorWrite(
          createEcobaseInventoryPlanningActions(),
          ['setReceiptOverride', 'updateProductPlanningFields', 'setFamilyTarget', 'setFamilyPreferredSupplier'],
          onOperatorWrite,
        ),
      },
      { name: 'ecobasePlanningConfiguration', actions: createEcobasePlanningSettingsActions() },
    ],
    acl: [
      {
        resource: 'ecobaseInventoryPlanning',
        actions: [
          'filters',
          'workspace',
          'commandCenter',
          'listingPerformanceReview',
          'rows',
          'digestPreview',
          'rowWorkspace',
          'optimizeBudget',
          'candidatePreview',
        ],
        role: LOGGED_IN,
      },
      {
        resource: 'ecobaseInventoryPlanning',
        actions: [
          'refreshAndPublish',
          'setReceiptOverride',
          'updateProductPlanningFields',
          'setFamilyTarget',
          'setFamilyPreferredSupplier',
        ],
        role: OPERATOR,
      },
      {
        resource: 'ecobaseInventoryPlanning',
        actions: [
          'refreshReadModel',
          'verifyRefreshRun',
          'reconcileFamilies',
          'previewAutomaticTargetCorrections',
          'applyAutomaticTargetCorrections',
          'verifyAutomaticTargetCorrections',
          'verifySilverIntegrity',
          'reconcileReceipts',
          'backfillReceipts',
        ],
        role: ADMIN,
      },
      { resource: 'ecobasePlanningConfiguration', actions: ['get'], role: LOGGED_IN },
      { resource: 'ecobasePlanningConfiguration', actions: ['save', 'reset'], role: ADMIN },
      { resource: ECOBASE_COLLECTIONS.planningSettings, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
