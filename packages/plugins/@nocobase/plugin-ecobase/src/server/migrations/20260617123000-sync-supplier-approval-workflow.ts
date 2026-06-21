import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    for (const name of [ECOBASE_COLLECTIONS.suppliers, ECOBASE_COLLECTIONS.supplierAttentionRows]) {
      const collection = this.db.getCollection(name);
      if (!collection) {
        throw new Error(`Ecobase supplier workflow migration failed: missing collection ${name}.`);
      }
      await collection.sync();
    }
  }
}
