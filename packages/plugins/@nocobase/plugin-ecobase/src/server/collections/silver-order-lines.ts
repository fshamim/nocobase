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
  name: ECOBASE_COLLECTIONS.silverOrderLines,
  title: 'Silver order lines',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'order',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverOrders,
      foreignKey: 'orderId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'companyProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProducts,
      foreignKey: 'companyProductId',
      targetKey: 'id',
      allowNull: true,
      onDelete: 'RESTRICT',
    },
    {
      name: 'supplierProduct',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSupplierProducts,
      foreignKey: 'supplierProductId',
      targetKey: 'id',
      onDelete: 'RESTRICT',
    },
    { name: 'sourceLineKey', type: 'string', allowNull: false },
    { name: 'sourceAsin', type: 'string' },
    { name: 'sourceSupplierSku', type: 'string' },
    { name: 'productMappingStatus', type: 'string', allowNull: false, defaultValue: 'resolved' },
    { name: 'productMappingEvidenceJson', type: 'jsonb', defaultValue: {} },
    { name: 'orderedQty', type: 'double', allowNull: false },
    { name: 'confirmedQty', type: 'double' },
    { name: 'unitCost', type: 'double' },
    { name: 'expectedSellPrice', type: 'double' },
    { name: 'expectedMargin', type: 'double' },
    { name: 'expectedProfit', type: 'double' },
    { name: 'supplierPackSize', type: 'double' },
    { name: 'fbaExpectedPackSize', type: 'double' },
    { name: 'prepInstruction', type: 'text' },
    { name: 'expectedDeliveryDate', type: 'dateOnly' },
    { name: 'expectedSellableDate', type: 'dateOnly' },
    { name: 'expectedArrivalDate', type: 'dateOnly' },
    { name: 'expectedArrivalStatus', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'expectedArrivalSource', type: 'string' },
    { name: 'expectedArrivalAsOf', type: 'dateOnly' },
    { name: 'expectedArrivalConfidence', type: 'string', allowNull: false, defaultValue: 'none' },
    { name: 'upc', type: 'string' },
    { name: 'mapPrice', type: 'double' },
    { name: 'productAnalysisStatus', type: 'string', allowNull: false, defaultValue: 'unknown' },
    { name: 'priority', type: 'string' },
    { name: 'amazonReceiptStatus', type: 'string', allowNull: true, index: true },
    { name: 'amazonReceiptObservedQty', type: 'double' },
    { name: 'amazonReceiptBaselineAt', type: 'datetimeTz' },
    { name: 'amazonReceiptObservedAt', type: 'datetimeTz' },
    { name: 'amazonReceiptCompletionReason', type: 'string' },
    { name: 'amazonReceiptEvidenceJson', type: 'jsonb', defaultValue: {} },
    { name: 'amazonReceiptOverrideStatus', type: 'string' },
    { name: 'amazonReceiptOverrideReason', type: 'text' },
    { name: 'amazonReceiptOverrideAt', type: 'datetimeTz' },
    { name: 'amazonReceiptOverrideByUserId', type: 'bigInt', autoFill: false },
    { name: 'amazonReceiptOverrideEvidenceJson', type: 'jsonb', defaultValue: {} },
  ],
  indexes: [
    {
      unique: true,
      fields: ['orderId', 'sourceLineKey'],
    },
    {
      fields: ['orderId', 'companyProductId'],
    },
  ],
});
