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
  ['onHandSellableStock', 'On-Hand Sellable Stock'],
  ['amazonPipelineStock', 'Amazon Pipeline Stock'],
  ['supplierPipelineStock', 'Supplier Pipeline Stock'],
  ['inventoryPositionStock', 'Inventory Position Stock'],
  ['familyOnHandSellableStock', 'Family On-Hand Sellable Stock'],
  ['familyAmazonPipelineStock', 'Family Amazon Pipeline Stock'],
  ['familySupplierPipelineStock', 'Family Supplier Pipeline Stock'],
  ['familyInventoryPositionStock', 'Family Inventory Position Stock'],
] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fieldRepo = this.db.getRepository('fields');
    if (!fieldRepo) {
      throw new Error('Ecobase inventory-position migration failed: fields repository is unavailable.');
    }

    for (const [name, title] of FIELDS) {
      const existing = await fieldRepo.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name },
      });
      if (!existing) {
        await fieldRepo.create({
          values: {
            collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
            name,
            type: 'double',
            interface: 'number',
            uiSchema: { title },
          },
        });
      }
    }
  }
}
