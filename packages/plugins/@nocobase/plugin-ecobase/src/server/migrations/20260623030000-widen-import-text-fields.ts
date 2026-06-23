import { Migration } from '@nocobase/server';
import { DataTypes } from 'sequelize';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const TEXT_FIELDS: Record<string, string[]> = {
  [ECOBASE_COLLECTIONS.suppliers]: [
    'wholesalePriceList',
    'productCatalog',
    'mapAgreement',
    'prPortalLink',
    'amazonAllow',
    'feedback',
    'sheetLink',
    'remarksSa',
    'analysisIssueRemarks',
  ],
  [ECOBASE_COLLECTIONS.supplierOrders]: ['trackingId'],
  [ECOBASE_COLLECTIONS.silverOrders]: ['trackingId'],
  [ECOBASE_COLLECTIONS.silverSupplierAccounts]: ['portalUrl'],
  [ECOBASE_COLLECTIONS.silverProducts]: ['title'],
};

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const fieldRepo = this.db.getRepository('fields');

    await this.db.sequelize.transaction(async (transaction) => {
      for (const [collectionName, fields] of Object.entries(TEXT_FIELDS)) {
        const collection = this.db.getCollection(collectionName);
        if (!collection) {
          throw new Error(`Ecobase text-field migration failed: missing collection ${collectionName}.`);
        }

        const tableName = collection.getTableNameWithSchema();
        const table = await queryInterface.describeTable(tableName, { transaction });
        for (const field of fields) {
          if (!table[field]) continue;
          await queryInterface.changeColumn(tableName, field, { type: DataTypes.TEXT }, { transaction });
        }

        await fieldRepo.update({
          filter: { collectionName, name: fields },
          values: { type: 'text', length: null },
          transaction,
        });
      }
    });
  }
}
