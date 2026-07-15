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

const PUBLISHED_RUN_INDEX = 'gold_inventory_planning_one_published_run_uidx';

export default class extends Migration {
  declare db: {
    getCollection(name: string): { getTableNameWithSchema(): string } | undefined;
    sequelize: {
      getQueryInterface(): {
        addIndex(
          tableName: string,
          fields: string[],
          options: { name: string; unique: boolean; where: { status: string } },
        ): Promise<unknown>;
      };
    };
  };
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns);
    if (!collection) {
      throw new Error('Ecobase Gold publication migration failed: refresh-run collection is unavailable.');
    }
    await this.db.sequelize
      .getQueryInterface()
      .addIndex(collection.getTableNameWithSchema(), ['status'], {
        name: PUBLISHED_RUN_INDEX,
        unique: true,
        where: { status: 'published' },
      })
      .catch(ignoreExistingIndex);
  }
}

function ignoreExistingIndex(error: unknown) {
  if (error instanceof Error && /already exists/i.test(error.message)) return;
  throw error;
}
