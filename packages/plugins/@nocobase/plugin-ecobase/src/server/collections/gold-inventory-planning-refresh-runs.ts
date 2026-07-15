/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';
import { ECOBASE_COLLECTIONS } from './names';

const STATUS_OPTIONS = [
  { label: 'Requested', value: 'requested', color: 'default' },
  { label: 'Running', value: 'running', color: 'blue' },
  { label: 'Succeeded', value: 'succeeded', color: 'green' },
  { label: 'Failed', value: 'failed', color: 'red' },
  { label: 'Published', value: 'published', color: 'cyan' },
];

export default defineCollection({
  migrationRules: ['schema-only'],
  loadedFromCollectionManager: true,
  autoGenId: false,
  name: ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns,
  title: 'Gold inventory planning refresh runs',
  fields: [
    { name: 'id', type: 'uuid', interface: 'input', uiSchema: { title: 'ID' }, primaryKey: true },
    {
      name: 'idempotencyKey',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Idempotency Key' },
      allowNull: false,
      unique: true,
    },
    {
      name: 'requestDigest',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Request Digest' },
      allowNull: false,
    },
    {
      name: 'calculationDate',
      type: 'dateOnly',
      interface: 'date',
      uiSchema: { title: 'Calculation Date' },
      allowNull: false,
      index: true,
    },
    {
      name: 'status',
      type: 'string',
      interface: 'select',
      uiSchema: { title: 'Status', enum: STATUS_OPTIONS },
      allowNull: false,
      index: true,
    },
    { name: 'requestedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Requested At' } },
    { name: 'startedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Started At' } },
    { name: 'succeededAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Succeeded At' } },
    { name: 'failedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Failed At' } },
    { name: 'publishedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Published At' } },
    {
      name: 'requestedByUserId',
      type: 'bigInt',
      interface: 'integer',
      uiSchema: { title: 'Requested By User' },
    },
    { name: 'rowCount', type: 'integer', interface: 'integer', uiSchema: { title: 'Row Count' } },
    {
      name: 'verificationJson',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Verification' },
      defaultValue: {},
    },
    { name: 'requestJson', type: 'jsonb', interface: 'json', uiSchema: { title: 'Request' }, defaultValue: {} },
    { name: 'resultJson', type: 'jsonb', interface: 'json', uiSchema: { title: 'Result' }, defaultValue: {} },
    { name: 'errorJson', type: 'jsonb', interface: 'json', uiSchema: { title: 'Error' }, defaultValue: {} },
    {
      name: 'rows',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
      foreignKey: 'refreshRunId',
      sourceKey: 'id',
    },
  ],
});
