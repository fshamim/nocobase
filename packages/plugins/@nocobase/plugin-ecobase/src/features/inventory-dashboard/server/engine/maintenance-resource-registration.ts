/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Gold engine maintenance surface (issue 042).
 *
 * `ecobaseInventoryPlanning` and `ecobasePlanningConfiguration` outlived the legacy
 * Inventory Planning page they were born under: the resource names are the engine's
 * publish/maintenance API (Gold Maintenance page → `refreshAndPublish`, admin-only
 * rebuild/verify/reconcile escape hatches) and the settings that feed the engine
 * (Planning Settings page). The operator writers stay registered because the
 * Inventory Dashboard delegates to the same handlers under its own resource.
 * The resource NAMES are deliberately unchanged — clients and stored ACL rows use them.
 */

import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import {
  createEcobaseInventoryPlanningActions,
  createEcobasePlanningSettingsActions,
} from '../../../../server/resource-actions';
import {
  ADMIN,
  LOGGED_IN,
  OPERATOR,
  type EcobaseFeatureResourceRegistration,
  triggerOnOperatorWrite,
} from '../../../../server/resource-registration';

export function createGoldEngineMaintenanceResourceRegistration(
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
      { resource: 'ecobaseInventoryPlanning', actions: ['candidatePreview'], role: LOGGED_IN },
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
          'backfillOrderStamps',
        ],
        role: ADMIN,
      },
      { resource: 'ecobasePlanningConfiguration', actions: ['get'], role: LOGGED_IN },
      { resource: 'ecobasePlanningConfiguration', actions: ['save', 'reset'], role: ADMIN },
      { resource: ECOBASE_COLLECTIONS.planningSettings, actions: ['list', 'get'], role: LOGGED_IN },
    ],
  };
}
