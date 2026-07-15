/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  createEcobaseMedallionWorkflowActions,
  createEcobaseSilverDataActions,
} from '../../../server/resource-actions';
import {
  ADMIN,
  LOGGED_IN,
  OPERATOR,
  type EcobaseFeatureResourceRegistration,
} from '../../../server/resource-registration';

export function createSemanticModelResourceRegistration(): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      { name: 'ecobaseMedallionWorkflow', actions: createEcobaseMedallionWorkflowActions() },
      { name: 'ecobaseSilverData', actions: createEcobaseSilverDataActions() },
    ],
    acl: [
      {
        resource: 'ecobaseMedallionWorkflow',
        actions: ['createComment', 'createTask', 'proposeAction', 'approveAndExecute', 'rejectApproval'],
        role: OPERATOR,
      },
      { resource: 'ecobaseMedallionWorkflow', actions: ['setActionPolicy'], role: ADMIN },
      { resource: 'ecobaseSilverData', actions: ['search', 'lookup', 'context', 'record'], role: LOGGED_IN },
      { resource: 'ecobaseSilverData', actions: ['addComment'], role: OPERATOR },
      { resource: 'ecobaseSilverData', actions: ['updateRecord'], role: ADMIN },
    ],
  };
}
