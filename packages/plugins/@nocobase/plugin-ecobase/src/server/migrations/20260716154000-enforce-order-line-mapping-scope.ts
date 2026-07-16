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

const CONSTRAINT_NAME = 'silver_order_lines_mapping_scope_check';

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.silverOrderLines);
    if (!collection) {
      throw new Error('Ecobase order-line mapping-scope migration failed: Silver order lines collection is missing.');
    }

    const queryInterface = this.db.sequelize.getQueryInterface();
    const quote = (value: string) => queryInterface.queryGenerator.quoteIdentifier(value);
    const quotedTable = queryInterface.queryGenerator.quoteTable(collection.getTableNameWithSchema());
    const [[existing]] = await this.db.sequelize.query(
      'SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = :constraintName) AS exists',
      { replacements: { constraintName: CONSTRAINT_NAME } },
    );
    if (existing?.exists) return;

    await this.db.sequelize.query(`
      ALTER TABLE ${quotedTable}
      ADD CONSTRAINT ${quote(CONSTRAINT_NAME)}
      CHECK (
        (${quote('mappingScope')} = 'exact_member'
          AND ${quote('companyProductFamilyId')} IS NOT NULL
          AND ${quote('companyProductId')} IS NOT NULL)
        OR (${quote('mappingScope')} = 'family_only'
          AND ${quote('companyProductFamilyId')} IS NOT NULL
          AND ${quote('companyProductId')} IS NULL
          AND ${quote('supplierProductId')} IS NULL)
        OR (${quote('mappingScope')} = 'unresolved'
          AND ${quote('companyProductFamilyId')} IS NULL
          AND ${quote('companyProductId')} IS NULL
          AND ${quote('supplierProductId')} IS NULL)
      ) NOT VALID
    `);
  }
}
