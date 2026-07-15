/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createEcobaseOrderPlanningActions } from '../../../server/resource-actions';
import {
  ADMIN,
  LOGGED_IN,
  OPERATOR,
  type EcobaseFeatureResourceRegistration,
} from '../../../server/resource-registration';

export function createOrderPlanningResourceRegistration(): EcobaseFeatureResourceRegistration {
  return {
    resources: [{ name: 'ecobaseOrderPlanning', actions: createEcobaseOrderPlanningActions() }],
    acl: [
      { resource: 'ecobaseOrderPlanning', actions: ['filters', 'list', 'detail'], role: LOGGED_IN },
      {
        resource: 'ecobaseOrderPlanning',
        actions: ['updateOrder', 'updateLine', 'addComment', 'updateInvoice', 'deleteComment'],
        role: OPERATOR,
      },
      { resource: 'ecobaseOrderPlanning', actions: ['refreshReadModel'], role: ADMIN },
    ],
  };
}
