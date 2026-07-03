import {
  createEcobaseMedallionWorkflowActions,
  createEcobaseSilverDataActions,
} from '../../../server/resource-actions';
import { LOGGED_IN, type EcobaseFeatureResourceRegistration } from '../../../server/resource-registration';

export function createSemanticModelResourceRegistration(): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      { name: 'ecobaseMedallionWorkflow', actions: createEcobaseMedallionWorkflowActions() },
      { name: 'ecobaseSilverData', actions: createEcobaseSilverDataActions() },
    ],
    acl: [
      {
        resource: 'ecobaseMedallionWorkflow',
        actions: ['createComment', 'createTask', 'proposeAction', 'approveAndExecute', 'rejectApproval', 'setActionPolicy'],
        role: LOGGED_IN,
      },
      {
        resource: 'ecobaseSilverData',
        actions: ['search', 'lookup', 'context', 'record', 'updateRecord', 'addComment'],
        role: LOGGED_IN,
      },
    ],
  };
}
