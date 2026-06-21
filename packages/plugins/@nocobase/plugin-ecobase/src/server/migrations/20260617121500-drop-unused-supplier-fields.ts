import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const UNUSED_SUPPLIER_FIELDS = [
  'email',
  'phone',
  'website',
  'preferredContactMethod',
  'contactNotes',
  'lastOperatorEditAt',
  'lastOperatorActor',
];

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.suppliers);
    if (!collection) {
      throw new Error(`Ecobase supplier cleanup migration failed: missing collection ${ECOBASE_COLLECTIONS.suppliers}.`);
    }
    const table = collection.getTableNameWithSchema();
    const queryInterface = this.db.sequelize.getQueryInterface();
    const columns = await queryInterface.describeTable(table as any);
    for (const field of UNUSED_SUPPLIER_FIELDS) {
      if (columns[field]) {
        await queryInterface.removeColumn(table as any, field);
      }
    }
  }
}
