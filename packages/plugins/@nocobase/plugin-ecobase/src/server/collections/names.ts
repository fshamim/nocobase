/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const ECOBASE_COLLECTIONS = {
  sourceConnections: 'ecobaseSourceConnections',
  importRuns: 'ecobaseImportRuns',
  planningProducts: 'ecobasePlanningProducts',
  planningProductListings: 'ecobasePlanningProductListings',
  planningProductMappingAudits: 'ecobasePlanningProductMappingAudits',
  sellerboardProductCosts: 'ecobaseSellerboardProductCosts',
  supplierOrderSettings: 'ecobaseSupplierOrderSettings',
  ruleVersions: 'ecobaseRuleVersions',
  alertEvaluations: 'ecobaseAlertEvaluations',
  alerts: 'ecobaseAlerts',
  sourceAccessAudits: 'ecobaseSourceAccessAudits',
  sourceWarningPolicies: 'ecobaseSourceWarningPolicies',
  reportRuns: 'ecobaseReportRuns',
  reportItems: 'ecobaseReportItems',
  dailyManagementSnapshots: 'ecobaseDailyManagementSnapshots',
  dailyBriefPromptSettings: 'ecobaseDailyBriefPromptSettings',
  planningSettings: 'ecobasePlanningSettings',
  aiAnswers: 'ecobaseAiAnswers',
  dataQualitySignoffs: 'ecobaseDataQualitySignoffs',
  benchmarkFixtures: 'ecobaseBenchmarkFixtures',
  accuracyEvaluationRuns: 'ecobaseAccuracyEvaluationRuns',
  bronzeSourceFiles: 'bronzeSourceFiles',
  bronzeSourceRecords: 'bronzeSourceRecords',
  silverCompanies: 'silverCompanies',
  silverAmazonAccounts: 'silverAmazonAccounts',
  silverProducts: 'silverProducts',
  silverCompanyProducts: 'silverCompanyProducts',
  silverCompanyProductFamilies: 'silverCompanyProductFamilies',
  silverSuppliers: 'silverSuppliers',
  silverSupplierExternalRefs: 'silverSupplierExternalRefs',
  silverSupplierAccounts: 'silverSupplierAccounts',
  silverSupplierProducts: 'silverSupplierProducts',
  silverCompanyProductSuppliers: 'silverCompanyProductSuppliers',
  silverOrders: 'silverOrders',
  silverOrderLines: 'silverOrderLines',
  silverInvoices: 'silverInvoices',
  silverActivityComments: 'silverActivityComments',
  silverTasks: 'silverTasks',
  silverTaskLinks: 'silverTaskLinks',
  silverHumanApprovals: 'silverHumanApprovals',
  silverHumanApprovalLinks: 'silverHumanApprovalLinks',
  silverWorkflowActionPolicies: 'silverWorkflowActionPolicies',
  silverTargets: 'silverTargets',
  silverNormalizationLinks: 'silverNormalizationLinks',
  silverInventorySnapshots: 'silverInventorySnapshots',
  silverListingDailyFacts: 'silverListingDailyFacts',
  silverTrafficSnapshots: 'silverTrafficSnapshots',
  goldTargetEvaluations: 'goldTargetEvaluations',
  goldInventoryPlanningRows: 'goldInventoryPlanningRows',
  goldOrderPlanningRows: 'goldOrderPlanningRows',
  goldSupplierAttentionRows: 'goldSupplierAttentionRows',
  goldManagementKpiDailyFacts: 'goldManagementKpiDailyFacts',
  goldAlerts: 'goldAlerts',
  goldReportRuns: 'goldReportRuns',
  goldReportItems: 'goldReportItems',
} as const;

export type EcobaseCollectionName = (typeof ECOBASE_COLLECTIONS)[keyof typeof ECOBASE_COLLECTIONS];
