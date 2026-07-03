import { ECOBASE_COLLECTIONS } from './collections/names';

type ResourceActions = Record<string, unknown>;

interface EcobaseResourceRegistrationApp {
  resourceManager: {
    define: (definition: { name: string; actions: ResourceActions }) => void;
  };
  acl: {
    allow: (resource: string, actions: string[], role: 'loggedIn') => void;
  };
}

export interface EcobaseResourceActions {
  ecobaseImport: ResourceActions;
  ecobaseInventoryPlanning: ResourceActions;
  ecobasePlanningSettings: ResourceActions;
  ecobaseOrderPlanning: ResourceActions;
  ecobaseSupplierOrders: ResourceActions;
  ecobaseSupplierManagement: ResourceActions;
  ecobaseMedallionWorkflow: ResourceActions;
  ecobaseSilverData: ResourceActions;
  ecobaseReports: ResourceActions;
}

interface ResourceAclGrant {
  resource: string;
  actions: string[];
  role: 'loggedIn';
}

const LOGGED_IN = 'loggedIn' as const;

export const ECOBASE_RESOURCE_ACL_GRANTS: ResourceAclGrant[] = [
  {
    resource: 'ecobaseImport',
    actions: [
      'run',
      'runDailySnapshot',
      'forceRefresh',
      'runScheduledSellerboard',
      'runNoop',
      'status',
      'adapters',
      'normalizeBronzeToSilver',
      'runMedallionPipeline',
      'analyzeCsvBundle',
      'runCsvBundle',
      'saveCsvSourceConnection',
      'listSellerboardSources',
      'saveSellerboardSource',
      'deleteSellerboardSource',
    ],
    role: LOGGED_IN,
  },
  {
    resource: 'ecobaseInventoryPlanning',
    actions: ['filters', 'refreshReadModel', 'rows', 'digestPreview', 'optimizeBudget'],
    role: LOGGED_IN,
  },
  {
    resource: 'ecobasePlanningSettings',
    actions: ['get', 'save', 'reset'],
    role: LOGGED_IN,
  },
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
  {
    resource: ECOBASE_COLLECTIONS.companies,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
  {
    resource: ECOBASE_COLLECTIONS.amazonAccounts,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
  {
    resource: ECOBASE_COLLECTIONS.sourceConnections,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
  {
    resource: ECOBASE_COLLECTIONS.importRuns,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
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
  {
    resource: 'ecobaseReports',
    actions: [
      'generatePreview',
      'generateDailyOperationsBriefEvidence',
      'generateDailyOperationsBrief',
      'getDailyManagementSnapshotTrend',
      'backfillManagementKpiFacts',
      'getDailyBriefPromptSettings',
      'saveDailyBriefPromptSettings',
      'resetDailyBriefPromptSettings',
      'markDailyOperationsBriefSent',
      'markDailyOperationsBriefFailed',
    ],
    role: LOGGED_IN,
  },
  {
    resource: ECOBASE_COLLECTIONS.goldManagementKpiDailyFacts,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
  {
    resource: ECOBASE_COLLECTIONS.dailyManagementSnapshots,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
  {
    resource: ECOBASE_COLLECTIONS.dailyBriefPromptSettings,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
  {
    resource: ECOBASE_COLLECTIONS.planningSettings,
    actions: ['list', 'get'],
    role: LOGGED_IN,
  },
];

export function registerEcobaseResources(app: EcobaseResourceRegistrationApp, actions: EcobaseResourceActions) {
  for (const definition of [
    { name: 'ecobaseImport', actions: actions.ecobaseImport },
    { name: 'ecobaseInventoryPlanning', actions: actions.ecobaseInventoryPlanning },
    { name: 'ecobasePlanningSettings', actions: actions.ecobasePlanningSettings },
    { name: 'ecobaseOrderPlanning', actions: actions.ecobaseOrderPlanning },
    { name: 'ecobaseSupplierOrders', actions: actions.ecobaseSupplierOrders },
    { name: 'ecobaseSupplierManagement', actions: actions.ecobaseSupplierManagement },
    { name: 'ecobaseMedallionWorkflow', actions: actions.ecobaseMedallionWorkflow },
    { name: 'ecobaseSilverData', actions: actions.ecobaseSilverData },
    { name: 'ecobaseReports', actions: actions.ecobaseReports },
  ]) {
    app.resourceManager.define(definition);
  }

  for (const grant of ECOBASE_RESOURCE_ACL_GRANTS) {
    app.acl.allow(grant.resource, grant.actions, grant.role);
  }
}
