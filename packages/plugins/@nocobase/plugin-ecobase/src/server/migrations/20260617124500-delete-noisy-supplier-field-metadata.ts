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
    await this.db.sequelize.query('delete from "fields" where "collectionName" = :collectionName and "name" in (:names)', {
      replacements: { collectionName: ECOBASE_COLLECTIONS.suppliers, names: NOISY_SUPPLIER_FIELDS },
    });
  }
}
