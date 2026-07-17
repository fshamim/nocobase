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

const SOURCE_FIELDS = {
  [ECOBASE_COLLECTIONS.silverSuppliers]: [
    { name: 'primaryEmail', type: 'string', interface: 'input' },
    { name: 'additionalEmails', type: 'jsonb', interface: 'json', defaultValue: [] },
    { name: 'primaryPhone', type: 'string', interface: 'input' },
    { name: 'additionalPhones', type: 'jsonb', interface: 'json', defaultValue: [] },
    { name: 'contactNotes', type: 'text', interface: 'textarea' },
    { name: 'supplierUrl', type: 'text', interface: 'url' },
    { name: 'country', type: 'string', interface: 'input' },
    { name: 'market', type: 'string', interface: 'input' },
    { name: 'currency', type: 'string', interface: 'input' },
    { name: 'activeStatus', type: 'string', interface: 'input' },
    { name: 'supplierType', type: 'string', interface: 'input' },
    { name: 'amazonPresence', type: 'string', interface: 'input' },
    { name: 'reachedVia', type: 'string', interface: 'input' },
    { name: 'receivedEmail', type: 'text', interface: 'textarea' },
    { name: 'designation', type: 'string', interface: 'input' },
    { name: 'category', type: 'string', interface: 'input' },
    { name: 'amazonAllowed', type: 'boolean', interface: 'checkbox' },
    { name: 'lastAnalysedBy', type: 'string', interface: 'input' },
    { name: 'trackingStatus', type: 'string', interface: 'input' },
    { name: 'dateOfUpdate', type: 'dateOnly', interface: 'date' },
    { name: 'analysisProgress', type: 'string', interface: 'input' },
    { name: 'remarksAnalysed', type: 'text', interface: 'textarea' },
    { name: 'sourceEvidence', type: 'jsonb', interface: 'json', defaultValue: {} },
  ],
  [ECOBASE_COLLECTIONS.silverSupplierExternalRefs]: [
    { name: 'sourceEvidence', type: 'jsonb', interface: 'json', defaultValue: {} },
  ],
  [ECOBASE_COLLECTIONS.silverSupplierAccounts]: [
    { name: 'accountType', type: 'string', interface: 'input' },
    { name: 'market', type: 'string', interface: 'input' },
    { name: 'loginUsername', type: 'string', interface: 'input' },
    { name: 'loginSecretRef', type: 'string', interface: 'input' },
    { name: 'loginSecret', type: 'string', interface: 'input' },
    { name: 'contactName', type: 'string', interface: 'input' },
    { name: 'email', type: 'string', interface: 'email' },
    { name: 'phone', type: 'string', interface: 'phone' },
    { name: 'preferredContactMethod', type: 'string', interface: 'input' },
    { name: 'metadata', type: 'jsonb', interface: 'json', defaultValue: {} },
  ],
  [ECOBASE_COLLECTIONS.silverSupplierProducts]: [
    { name: 'lastPriceUpdateDate', type: 'dateOnly', interface: 'date' },
    { name: 'mapPrice', type: 'double', interface: 'number' },
    { name: 'sourceEvidence', type: 'jsonb', interface: 'json', defaultValue: {} },
  ],
  [ECOBASE_COLLECTIONS.silverCompanyProductSuppliers]: [
    { name: 'lastSeenAt', type: 'datetimeTz', interface: 'datetime' },
    { name: 'sourceEvidence', type: 'jsonb', interface: 'json', defaultValue: {} },
  ],
  [ECOBASE_COLLECTIONS.silverOrders]: [
    { name: 'externalOrderId', type: 'string', interface: 'input' },
    {
      name: 'supplierExternalRef',
      type: 'belongsTo',
      interface: 'm2o',
      target: ECOBASE_COLLECTIONS.silverSupplierExternalRefs,
      foreignKey: 'supplierExternalRefId',
      targetKey: 'id',
      onDelete: 'RESTRICT',
    },
    { name: 'sourceOrderStatus', type: 'string', interface: 'input' },
    { name: 'operationalStatus', type: 'string', interface: 'input' },
    { name: 'workflowStage', type: 'string', interface: 'input' },
    { name: 'orderApproval', type: 'string', interface: 'input' },
    { name: 'paymentStatus', type: 'string', interface: 'input' },
    { name: 'invoiceStatus', type: 'string', interface: 'input' },
    { name: 'prepStatus', type: 'string', interface: 'input' },
    { name: 'taskRef', type: 'string', interface: 'input' },
    { name: 'taskLink', type: 'text', interface: 'url' },
    { name: 'sourceEvidence', type: 'jsonb', interface: 'json', defaultValue: {} },
  ],
  [ECOBASE_COLLECTIONS.silverOrderLines]: [
    { name: 'externalOrderId', type: 'string', interface: 'input' },
    { name: 'lineOrdinal', type: 'integer', interface: 'integer' },
    { name: 'expectedCost', type: 'double', interface: 'number' },
    { name: 'actualCost', type: 'double', interface: 'number' },
    { name: 'orderQty', type: 'double', interface: 'number' },
    { name: 'orderType', type: 'string', interface: 'input' },
    { name: 'operationalStatus', type: 'string', interface: 'input' },
    { name: 'poStatus', type: 'string', interface: 'input' },
    { name: 'sourceEvidence', type: 'jsonb', interface: 'json', defaultValue: {} },
  ],
} as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fields = this.db.getRepository('fields');
    if (!fields) {
      throw new Error('Ecobase supplier/order source-schema migration failed: fields repository is unavailable.');
    }

    for (const [collectionName, collectionFields] of Object.entries(SOURCE_FIELDS)) {
      for (const field of collectionFields) {
        const existing = await fields.findOne({ filter: { collectionName, name: field.name } });
        if (!existing) await fields.create({ values: { collectionName, ...field } });
      }
    }
  }
}
