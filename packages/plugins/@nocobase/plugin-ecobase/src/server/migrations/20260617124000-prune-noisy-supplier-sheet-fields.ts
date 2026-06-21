import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const NOISY_SUPPLIER_FIELDS = [
  'timestamp',
  'market',
  'srBy',
  'portalUsername',
  'portalPassword',
  'respondedBy',
  'efSentStatus',
  'ssSentStatus',
  'mxSentStatus',
  'rhSentStatus',
  'feedback',
  'analysisRemarks',
  'productCatalog',
  'mapAgreement',
  'category',
  'amazonAllow',
  'saBy',
  'easyMoveSisterCompany',
  'bulkUpload',
  'used',
  'tasksSubmitted',
  'totalNop',
  'tnopAnalysed',
  'profitableProducts',
  'inventoryMarginPositive',
  'inventoryMarginAboveFive',
  'inventoryMarginAboveNine',
  'clearedPosAmount',
  'sheetLink',
  'remarksSa',
];

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    await this.db.sequelize.getQueryInterface().bulkDelete('fields', {
      collectionName: ECOBASE_COLLECTIONS.suppliers,
      name: NOISY_SUPPLIER_FIELDS,
    } as any);

    const queryInterface = this.db.sequelize.getQueryInterface();
    const table = await queryInterface.describeTable(ECOBASE_COLLECTIONS.suppliers);
    for (const field of NOISY_SUPPLIER_FIELDS) {
      if (table[field]) {
        await queryInterface.removeColumn(ECOBASE_COLLECTIONS.suppliers, field);
      }
    }
  }
}
