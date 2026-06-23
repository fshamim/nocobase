import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverNormalizationLinks,
  title: 'Silver normalization links',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    { name: 'silverEntityType', type: 'string', allowNull: false },
    { name: 'silverEntityId', type: 'uuid', allowNull: false, autoFill: false },
    {
      name: 'bronzeRecord',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.bronzeSourceRecords,
      foreignKey: 'bronzeRecordId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    {
      name: 'importRun',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.importRuns,
      foreignKey: 'importRunId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    { name: 'sourceType', type: 'string', allowNull: false },
    { name: 'sourceDataset', type: 'string', allowNull: false },
    { name: 'sourceRecordKey', type: 'string', allowNull: false },
    { name: 'sourceRowHash', type: 'string', allowNull: false },
    { name: 'relation', type: 'string', allowNull: false },
    { name: 'mappedAt', type: 'datetimeTz', allowNull: false },
    { name: 'mapperName', type: 'string', allowNull: false },
  ],
});
