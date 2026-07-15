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
  ['familyAmazonAccountId', 'uuid', 'input', 'Family Amazon Account'],
  ['familyMarketplace', 'string', 'input', 'Family Marketplace'],
  ['familyCanonicalAsin', 'string', 'input', 'Family Canonical ASIN'],
  ['calculationProvenanceJson', 'json', 'json', 'Calculation Provenance'],
] as const;

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const fieldRepo = this.db.getRepository('fields');
    if (!fieldRepo) {
      throw new Error('Ecobase family-action contract migration failed: fields repository is unavailable.');
    }

    for (const [name, type, fieldInterface, title] of FIELDS) {
      const existing = await fieldRepo.findOne({
        filter: { collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows, name },
      });
      if (!existing) {
        await fieldRepo.create({
          values: {
            collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
            name,
            type,
            interface: fieldInterface,
            uiSchema: { title },
          },
        });
      }
    }
  }
}
