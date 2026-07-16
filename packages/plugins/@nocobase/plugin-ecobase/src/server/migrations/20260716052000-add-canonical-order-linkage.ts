/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const FIELDS = {
  [ECOBASE_COLLECTIONS.silverOrders]: [
    {
      name: 'amazonAccount',
      type: 'belongsTo',
      interface: 'm2o',
      target: ECOBASE_COLLECTIONS.silverAmazonAccounts,
      foreignKey: 'amazonAccountId',
      targetKey: 'id',
      allowNull: true,
      onDelete: 'SET NULL',
    },
    { name: 'recordType', type: 'string', interface: 'select', allowNull: false, defaultValue: 'purchase_order' },
    {
      name: 'purchaseEvidenceStatus',
      type: 'string',
      interface: 'select',
      allowNull: false,
      defaultValue: 'confirmed',
    },
    { name: 'historicalPurchaseOutcome', type: 'string', interface: 'select' },
    { name: 'sourceMarketplace', type: 'string', interface: 'input' },
    { name: 'lastImportRunId', type: 'uuid', interface: 'input', autoFill: false, index: true },
  ],
  [ECOBASE_COLLECTIONS.silverOrderLines]: [
    {
      name: 'companyProductFamily',
      type: 'belongsTo',
      interface: 'm2o',
      target: ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
      foreignKey: 'companyProductFamilyId',
      targetKey: 'id',
      allowNull: true,
      onDelete: 'RESTRICT',
    },
    { name: 'sourceMarketplace', type: 'string', interface: 'input' },
    { name: 'sourceSkuType', type: 'string', interface: 'select', allowNull: false, defaultValue: 'unknown' },
    { name: 'mappingScope', type: 'string', interface: 'select', allowNull: false, defaultValue: 'unresolved' },
    {
      name: 'purchaseEvidenceStatus',
      type: 'string',
      interface: 'select',
      allowNull: false,
      defaultValue: 'confirmed',
    },
    { name: 'sourceRowNumber', type: 'integer', interface: 'integer' },
    { name: 'sourceRowHash', type: 'string', interface: 'input' },
    { name: 'lastImportRunId', type: 'uuid', interface: 'input', autoFill: false, index: true },
  ],
  [ECOBASE_COLLECTIONS.planningSettings]: [
    {
      name: 'defaultSupplierLeadTimeDays',
      type: 'integer',
      interface: 'integer',
      allowNull: false,
      defaultValue: 30,
    },
  ],
  [ECOBASE_COLLECTIONS.goldInventoryPlanningRows]: [
    { name: 'supplierOrderOperationalStatus', type: 'string', interface: 'input' },
    { name: 'supplierOrderWorkflowStage', type: 'string', interface: 'input', index: true },
    { name: 'supplierOrderSourceMemberSku', type: 'string', interface: 'input' },
    { name: 'supplierOrderLineMappingScope', type: 'string', interface: 'input', index: true },
  ],
} as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fields = this.db.getRepository('fields');
    if (!fields) {
      throw new Error('Ecobase canonical order-linkage migration failed: fields repository is unavailable.');
    }

    for (const [collectionName, collectionFields] of Object.entries(FIELDS)) {
      for (const field of collectionFields) {
        const existing = await fields.findOne({ filter: { collectionName, name: field.name } });
        if (!existing) await fields.create({ values: { collectionName, ...field } });
      }
    }
  }
}
