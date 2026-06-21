import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const collection = this.db.getCollection(ECOBASE_COLLECTIONS.suppliers);
    if (!collection) {
      throw new Error(`Ecobase supplier fields migration failed: missing collection ${ECOBASE_COLLECTIONS.suppliers}.`);
    }
    await collection.sync();
  }
}
