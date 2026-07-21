/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverOrders,
  title: 'Silver orders',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'company',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'amazonAccount',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverAmazonAccounts,
      foreignKey: 'amazonAccountId',
      targetKey: 'id',
      allowNull: true,
      onDelete: 'SET NULL',
    },
    {
      name: 'supplier',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSuppliers,
      foreignKey: 'supplierId',
      targetKey: 'id',
      onDelete: 'RESTRICT',
    },
    {
      name: 'supplierExternalRef',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSupplierExternalRefs,
      foreignKey: 'supplierExternalRefId',
      targetKey: 'id',
      onDelete: 'RESTRICT',
    },
    {
      name: 'supplierAccount',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSupplierAccounts,
      foreignKey: 'supplierAccountId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'orderRef', type: 'string', allowNull: false },
    { name: 'externalOrderId', type: 'string' },
    { name: 'recordType', type: 'string', allowNull: false, defaultValue: 'purchase_order' },
    { name: 'purchaseEvidenceStatus', type: 'string', allowNull: false, defaultValue: 'confirmed' },
    { name: 'historicalPurchaseOutcome', type: 'string' },
    { name: 'sourceMarketplace', type: 'string' },
    { name: 'orderDate', type: 'string', allowNull: false },
    { name: 'dailySequenceLetter', type: 'string', allowNull: false },
    { name: 'orderIntent', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'createdByUserId', type: 'uuid', autoFill: false },
    { name: 'supplierAnalysisByUserId', type: 'uuid', autoFill: false },
    { name: 'lifecyclePhase', type: 'string' },
    { name: 'lifecycleStatus', type: 'string' },
    { name: 'canonicalStatus', type: 'string' },
    { name: 'sourceOrderStatus', type: 'string' },
    { name: 'operationalStatus', type: 'string' },
    { name: 'workflowStage', type: 'string' },
    // Inventory Dashboard (AD-6): stage-entry timestamp for days-in-stage.
    // Nullable by design — null renders "unknown", never 0 days. Maintained at
    // import/status-change (backfill provenance 'derived'); see the dashboard
    // implementation plan §8 (FLAG-1).
    { name: 'workflowStageEnteredAt', type: 'datetimeTz' },
    { name: 'orderApproval', type: 'string' },
    { name: 'paymentStatus', type: 'string' },
    { name: 'invoiceStatus', type: 'string' },
    { name: 'prepStatus', type: 'string' },
    // Inventory Dashboard (T-1.4): structured prep details captured from the
    // In-Prep drawer (`ecobaseInventoryDashboard:savePrepDetails`).
    { name: 'prepBoxes', type: 'integer' },
    { name: 'prepCartons', type: 'integer' },
    { name: 'prepDimensions', type: 'jsonb' },
    { name: 'prepDetailsUpdatedAt', type: 'datetimeTz' },
    { name: 'prepDetailsUpdatedByUserId', type: 'string' },
    { name: 'statusSource', type: 'string' },
    { name: 'statusCheckRequired', type: 'boolean', defaultValue: false },
    { name: 'statusEvidenceJson', type: 'jsonb', defaultValue: {} },
    { name: 'authorityStatus', type: 'string', allowNull: false, defaultValue: 'unresolved' },
    { name: 'authoritySource', type: 'string' },
    { name: 'authorityTaskRef', type: 'string' },
    { name: 'authorityAsOf', type: 'datetimeTz' },
    { name: 'authorityEvidenceJson', type: 'jsonb', defaultValue: {} },
    { name: 'operatorStatusOverrideAt', type: 'datetimeTz' },
    { name: 'operatorStatusOverrideByUserId', type: 'uuid', autoFill: false },
    { name: 'amazonReceiptStatus', type: 'string', allowNull: true, index: true },
    { name: 'amazonReceiptObservedAt', type: 'datetimeTz' },
    { name: 'amazonReceiptCompletionReason', type: 'string' },
    { name: 'amazonReceiptEvidenceJson', type: 'jsonb', defaultValue: {} },
    { name: 'nextAction', type: 'string' },
    { name: 'nextActionDueAt', type: 'datetimeTz' },
    { name: 'nextActionOwnerId', type: 'uuid', autoFill: false },
    { name: 'fulfillmentRoute', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'expectedDeliveryDate', type: 'dateOnly' },
    { name: 'expectedArrivalDate', type: 'dateOnly' },
    { name: 'expectedArrivalStatus', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'expectedArrivalSource', type: 'string' },
    { name: 'expectedArrivalAsOf', type: 'dateOnly' },
    { name: 'expectedArrivalConfidence', type: 'string', allowNull: false, defaultValue: 'none' },
    { name: 'expectedCost', type: 'double' },
    { name: 'actualCost', type: 'double' },
    { name: 'costDifferenceNote', type: 'text' },
    { name: 'shippingCarrier', type: 'string' },
    { name: 'trackingId', type: 'text' },
    { name: 'attachmentReference', type: 'text' },
    { name: 'taskRef', type: 'string' },
    { name: 'taskLink', type: 'text' },
    { name: 'remarks', type: 'text' },
    { name: 'lastImportRunId', type: 'uuid', autoFill: false, index: true },
    { name: 'sourceEvidence', type: 'jsonb', defaultValue: {} },
  ],
  indexes: [
    {
      unique: true,
      fields: ['companyId', 'orderRef'],
    },
    {
      unique: true,
      fields: ['companyId', 'orderDate', 'dailySequenceLetter'],
    },
  ],
});
