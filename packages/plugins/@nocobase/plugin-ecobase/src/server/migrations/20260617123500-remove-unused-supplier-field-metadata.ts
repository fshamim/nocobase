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
    await this.db.sequelize.getQueryInterface().bulkDelete('fields', {
      collectionName: ECOBASE_COLLECTIONS.suppliers,
      name: UNUSED_SUPPLIER_FIELDS,
    } as any);
  }
}
