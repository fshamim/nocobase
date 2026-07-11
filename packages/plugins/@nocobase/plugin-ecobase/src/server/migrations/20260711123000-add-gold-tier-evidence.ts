/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const FIELDS = [
  {
    name: 'recentUnits30',
    type: 'double',
    interface: 'number',
    uiSchema: { title: 'Recent Units (30 Days)' },
  },
  {
    name: 'tierEligibilityReason',
    type: 'string',
    interface: 'input',
    uiSchema: { title: 'Tier Eligibility Reason' },
    index: true,
  },
  {
    name: 'tierRuleVersion',
    type: 'string',
    interface: 'input',
    uiSchema: { title: 'Tier Rule Version' },
    index: true,
  },
];

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fieldRepo = this.db.getRepository('fields');
    if (!fieldRepo) {
      throw new Error('Ecobase tier-evidence migration failed: fields repository is unavailable.');
    }

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
