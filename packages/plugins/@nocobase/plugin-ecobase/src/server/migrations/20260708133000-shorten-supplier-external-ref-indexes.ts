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

const LEGACY_UNIQUE_INDEX = 'silver_supplier_external_refs_source_system_normalized_external';
const LEGACY_SUPPLIER_INDEX = 'silver_supplier_external_refs_supplier_id';
const SOURCE_CODE_INDEX = 'silver_supplier_external_refs_source_code_uidx';
const SUPPLIER_INDEX = 'silver_supplier_external_refs_supplier_idx';

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.silverSupplierExternalRefs);
    if (!collection) return;

    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    await queryInterface.removeIndex(tableName, LEGACY_UNIQUE_INDEX).catch(ignoreMissingIndex);
    await queryInterface.removeIndex(tableName, LEGACY_SUPPLIER_INDEX).catch(ignoreMissingIndex);
    await queryInterface
      .addIndex(tableName, ['sourceSystem', 'normalizedExternalSupplierCode'], {
        name: SOURCE_CODE_INDEX,
        unique: true,
      })
      .catch(ignoreExistingIndex);
    await queryInterface.addIndex(tableName, ['supplierId'], { name: SUPPLIER_INDEX }).catch(ignoreExistingIndex);
  }
}

function ignoreMissingIndex(error: unknown) {
  if (error instanceof Error && /does not exist|Unknown constraint|not found/i.test(error.message)) return;
  throw error;
}

function ignoreExistingIndex(error: unknown) {
  if (error instanceof Error && /already exists/i.test(error.message)) return;
  throw error;
}
