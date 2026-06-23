import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

export default defineCollection({
  migrationRules: ['schema-only'],
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.silverTasks,
  title: 'Silver tasks',
  fields: [
    { name: 'id', type: 'uuid', primaryKey: true },
    {
      name: 'parentTask',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverTasks,
      foreignKey: 'parentTaskId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    {
      name: 'sourceComment',
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverActivityComments,
      foreignKey: 'sourceCommentId',
      targetKey: 'id',
      onDelete: 'SET NULL',
    },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'description', type: 'text' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'open' },
    { name: 'priority', type: 'string' },
    { name: 'dueAt', type: 'datetimeTz' },
    { name: 'assignedToUserId', type: 'uuid', autoFill: false },
    { name: 'assignedToAiEmployeeId', type: 'uuid', autoFill: false },
  ],
});
