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
  { label: 'Materialized', value: 'materialized', color: 'geekblue' },
  { label: 'Verified', value: 'verified', color: 'green' },
  { label: 'Published', value: 'published', color: 'cyan' },
  { label: 'Failed', value: 'failed', color: 'red' },
  { label: 'Superseded', value: 'superseded', color: 'default' },
  { label: 'Rejected', value: 'rejected', color: 'red' },
  { label: 'Retired', value: 'retired', color: 'default' },
  { label: 'Succeeded (legacy)', value: 'succeeded', color: 'default' },
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
    { name: 'ruleVersion', type: 'string', interface: 'input', uiSchema: { title: 'Rule Version' } },
    {
      name: 'algorithmContractVersion',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Algorithm Contract Version' },
    },
    {
      name: 'canonicalSerializerVersion',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Canonical Serializer Version' },
    },
    {
      name: 'candidateInputDigestVersion',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Candidate Input Digest Version' },
    },
    {
      name: 'sourceCoverageDigestVersion',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Source Coverage Digest Version' },
    },
    {
      name: 'listingRowDigestVersion',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Listing Row Digest Version' },
    },
    {
      name: 'familyActionProjectionDigestVersion',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Family Action Digest Version' },
    },
    {
      name: 'resolvedPlanningSettingsJson',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Resolved Planning Settings' },
    },
    {
      name: 'resolvedPlanningSettingsDigest',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Resolved Settings Digest' },
    },
    {
      name: 'currentProjectionGateMode',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Current Projection Gate Mode' },
    },
    {
      name: 'protectedSilverFingerprint',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Protected Silver Fingerprint' },
    },
    { name: 'sourceCoverageDigest', type: 'string', interface: 'input', uiSchema: { title: 'Coverage Digest' } },
    { name: 'sourceInputsJson', type: 'jsonb', interface: 'json', uiSchema: { title: 'Source Inputs' } },
    { name: 'sourceInputsDigest', type: 'string', interface: 'input', uiSchema: { title: 'Source Inputs Digest' } },
    {
      name: 'candidateInputDigest',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Candidate Input Digest' },
      index: true,
    },
    { name: 'listingRowCount', type: 'integer', interface: 'integer', uiSchema: { title: 'Listing Row Count' } },
    { name: 'listingRowDigest', type: 'string', interface: 'input', uiSchema: { title: 'Listing Row Digest' } },
    {
      name: 'familyActionProjectionCount',
      type: 'integer',
      interface: 'integer',
      uiSchema: { title: 'Family Action Count' },
    },
    {
      name: 'familyActionProjectionDigest',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Family Action Digest' },
    },
    {
      name: 'productionVerificationJson',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Production Verification' },
    },
    {
      name: 'productionVerificationDigest',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Production Verification Digest' },
    },
    {
      name: 'independentVerificationJson',
      type: 'jsonb',
      interface: 'json',
      uiSchema: { title: 'Independent Verification' },
    },
    {
      name: 'independentVerificationDigest',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Independent Verification Digest' },
    },
    { name: 'materializedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Materialized At' } },
    { name: 'verifiedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Verified At' } },
    { name: 'rejectedAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Rejected At' } },
    { name: 'supersededAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Superseded At' } },
    { name: 'retiredAt', type: 'datetimeTz', interface: 'datetime', uiSchema: { title: 'Retired At' } },
    { name: 'terminalReasonCode', type: 'string', interface: 'input', uiSchema: { title: 'Terminal Reason Code' } },
    { name: 'terminalReasonJson', type: 'jsonb', interface: 'json', uiSchema: { title: 'Terminal Reason' } },
    {
      name: 'publicationPayloadDigest',
      type: 'string',
      interface: 'input',
      uiSchema: { title: 'Publication Payload Digest' },
    },
    {
      name: 'rows',
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
      foreignKey: 'refreshRunId',
      sourceKey: 'id',
    },
  ],
});
