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

const FIELDS = [
  {
    name: 'amazonReceiptStatus',
    type: 'string',
    interface: 'input',
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
] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fieldRepo = this.db.getRepository('fields');
    if (!fieldRepo)
      throw new Error('Ecobase Gold receipt-evidence migration failed: fields repository is unavailable.');
    for (const field of FIELDS) {
      const existing = await fieldRepo.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name: field.name },
      });
      if (!existing) {
        await fieldRepo.create({
          values: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, ...field },
        });
      }
    }
  }
}
