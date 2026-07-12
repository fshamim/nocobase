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

const RECEIPT_FIELDS = {
  [ECOBASE_COLLECTIONS.silverOrderLines]: [
    {
      name: 'amazonReceiptStatus',
      type: 'string',
      interface: 'input',
      allowNull: true,
      index: true,
      uiSchema: { title: 'Amazon Receipt Status' },
    },
    {
      name: 'amazonReceiptObservedQty',
      type: 'double',
      interface: 'number',
      uiSchema: { title: 'Amazon Receipt Observed Quantity' },
    },
    {
      name: 'amazonReceiptBaselineAt',
      type: 'datetimeTz',
      interface: 'datetime',
      uiSchema: { title: 'Amazon Receipt Baseline At' },
    },
    {
      name: 'amazonReceiptObservedAt',
      type: 'datetimeTz',
      interface: 'datetime',
      uiSchema: { title: 'Amazon Receipt Observed At' },
    },
    {
      name: 'amazonReceiptCompletionReason',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Amazon Receipt Completion Reason' },
    },
    {
      name: 'amazonReceiptEvidenceJson',
      type: 'jsonb',
      interface: 'json',
      defaultValue: {},
      uiSchema: { title: 'Amazon Receipt Evidence' },
    },
    {
      name: 'amazonReceiptOverrideStatus',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Amazon Receipt Override Status' },
    },
    {
      name: 'amazonReceiptOverrideReason',
      type: 'text',
      interface: 'textarea',
      uiSchema: { title: 'Amazon Receipt Override Reason' },
    },
    {
      name: 'amazonReceiptOverrideAt',
      type: 'datetimeTz',
      interface: 'datetime',
      uiSchema: { title: 'Amazon Receipt Override At' },
    },
    {
      name: 'amazonReceiptOverrideByUserId',
      type: 'bigInt',
      autoFill: false,
      uiSchema: { title: 'Amazon Receipt Override By User' },
    },
    {
      name: 'amazonReceiptOverrideEvidenceJson',
      type: 'jsonb',
      interface: 'json',
      defaultValue: {},
      uiSchema: { title: 'Amazon Receipt Override Evidence' },
    },
  ],
  [ECOBASE_COLLECTIONS.silverOrders]: [
    {
      name: 'amazonReceiptStatus',
      type: 'string',
      interface: 'input',
      allowNull: true,
      index: true,
      uiSchema: { title: 'Amazon Receipt Status' },
    },
    {
      name: 'amazonReceiptObservedAt',
      type: 'datetimeTz',
      interface: 'datetime',
      uiSchema: { title: 'Amazon Receipt Observed At' },
    },
    {
      name: 'amazonReceiptCompletionReason',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Amazon Receipt Completion Reason' },
    },
    {
      name: 'amazonReceiptEvidenceJson',
      type: 'jsonb',
      interface: 'json',
      defaultValue: {},
      uiSchema: { title: 'Amazon Receipt Evidence' },
    },
  ],
} as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fieldRepo = this.db.getRepository('fields');
    if (!fieldRepo) {
      throw new Error('Ecobase Amazon receipt-state migration failed: fields repository is unavailable.');
    }

    for (const [collectionName, fields] of Object.entries(RECEIPT_FIELDS)) {
      for (const field of fields) {
        const existing = await fieldRepo.findOne({ filter: { collectionName, name: field.name } });
        if (!existing) await fieldRepo.create({ values: { collectionName, ...field } });
      }
    }
  }
}
