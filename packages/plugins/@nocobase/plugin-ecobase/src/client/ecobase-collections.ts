/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { CollectionOptions } from '@nocobase/client';

export const ecobaseClientCollections: CollectionOptions[] = [
  {
    name: 'ecobaseSourceConnections',
    title: 'Ecobase Source Connections',
    filterTargetKey: 'id',
    fields: [
      {
        name: 'id',
        type: 'uuid',
        interface: 'uuid',
        primaryKey: true,
        uiSchema: {
          type: 'string',
          title: 'Id',
          'x-component': 'Input',
        },
      },
      {
        name: 'name',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Name',
          'x-component': 'Input',
        },
      },
      {
        name: 'sourceType',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Source Type',
          'x-component': 'Input',
        },
      },
      {
        name: 'domain',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Domain',
          'x-component': 'Input',
        },
      },
      {
        name: 'config',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Config',
          'x-component': 'Input',
        },
      },
      {
        name: 'secretRef',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Secret Ref',
          'x-component': 'Input',
        },
      },
      {
        name: 'freshnessSlaMinutes',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Freshness Sla Minutes',
          'x-component': 'Input',
        },
      },
      {
        name: 'active',
        type: 'boolean',
        interface: 'checkbox',
        uiSchema: {
          type: 'boolean',
          title: 'Active',
          'x-component': 'Checkbox',
        },
      },
    ],
  },
  {
    name: 'ecobaseImportRuns',
    title: 'Ecobase Import Runs',
    filterTargetKey: 'id',
    fields: [
      {
        name: 'id',
        type: 'uuid',
        interface: 'uuid',
        primaryKey: true,
        uiSchema: {
          type: 'string',
          title: 'Id',
          'x-component': 'Input',
        },
      },
      {
        name: 'adapterName',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Adapter Name',
          'x-component': 'Input',
        },
      },
      {
        name: 'sourceIdentifier',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Source Identifier',
          'x-component': 'Input',
        },
      },
      {
        name: 'sourceVersion',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Source Version',
          'x-component': 'Input',
        },
      },
      {
        name: 'idempotencyKey',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Idempotency Key',
          'x-component': 'Input',
        },
      },
      {
        name: 'startedAt',
        type: 'datetimeTz',
        interface: 'datetime',
        uiSchema: {
          type: 'datetime',
          title: 'Started At',
          'x-component': 'DatePicker',
        },
      },
      {
        name: 'finishedAt',
        type: 'datetimeTz',
        interface: 'datetime',
        uiSchema: {
          type: 'datetime',
          title: 'Finished At',
          'x-component': 'DatePicker',
        },
      },
      {
        name: 'status',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Status',
          'x-component': 'Input',
        },
      },
      {
        name: 'rowCount',
        type: 'double',
        interface: 'number',
        uiSchema: {
          type: 'number',
          title: 'Row Count',
          'x-component': 'InputNumber',
        },
      },
      {
        name: 'normalizedCount',
        type: 'double',
        interface: 'number',
        uiSchema: {
          type: 'number',
          title: 'Normalized Count',
          'x-component': 'InputNumber',
        },
      },
      {
        name: 'warningCount',
        type: 'double',
        interface: 'number',
        uiSchema: {
          type: 'number',
          title: 'Warning Count',
          'x-component': 'InputNumber',
        },
      },
      {
        name: 'errorCount',
        type: 'text',
        interface: 'textarea',
        uiSchema: {
          type: 'string',
          title: 'Error Count',
          'x-component': 'Input.TextArea',
        },
      },
      {
        name: 'errorMessage',
        type: 'text',
        interface: 'textarea',
        uiSchema: {
          type: 'string',
          title: 'Error Message',
          'x-component': 'Input.TextArea',
        },
      },
      {
        name: 'summary',
        type: 'text',
        interface: 'textarea',
        uiSchema: {
          type: 'string',
          title: 'Summary',
          'x-component': 'Input.TextArea',
        },
      },
    ],
  },
  {
    name: 'ecobaseAlerts',
    title: 'Ecobase Alerts',
    filterTargetKey: 'id',
    fields: [
      {
        name: 'id',
        type: 'uuid',
        interface: 'uuid',
        primaryKey: true,
        uiSchema: {
          type: 'string',
          title: 'Id',
          'x-component': 'Input',
        },
      },
      {
        name: 'dedupeKey',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Dedupe Key',
          'x-component': 'Input',
        },
      },
      {
        name: 'planningProductId',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Planning Product Id',
          'x-component': 'Input',
        },
      },
      {
        name: 'company',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Company',
          'x-component': 'Input',
        },
      },
      {
        name: 'canonicalAsin',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Canonical Asin',
          'x-component': 'Input',
        },
      },
      {
        name: 'title',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Title',
          'x-component': 'Input',
        },
      },
      {
        name: 'alertEvaluationId',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Alert Evaluation Id',
          'x-component': 'Input',
        },
      },
      {
        name: 'alertType',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Alert Type',
          'x-component': 'Input',
        },
      },
      {
        name: 'severity',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Severity',
          'x-component': 'Input',
        },
      },
      {
        name: 'status',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Status',
          'x-component': 'Input',
        },
      },
      {
        name: 'subjectRef',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Subject Ref',
          'x-component': 'Input',
        },
      },
      {
        name: 'primaryRootCauseCode',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Primary Root Cause Code',
          'x-component': 'Input',
        },
      },
      {
        name: 'actionRequired',
        type: 'string',
        interface: 'input',
        uiSchema: {
          type: 'string',
          title: 'Action Required',
          'x-component': 'Input',
        },
      },
      {
        name: 'rootCauses',
        type: 'text',
        interface: 'textarea',
        uiSchema: {
          type: 'string',
          title: 'Root Causes',
          'x-component': 'Input.TextArea',
        },
      },
      {
        name: 'dataWarnings',
        type: 'text',
        interface: 'textarea',
        uiSchema: {
          type: 'string',
          title: 'Data Warnings',
          'x-component': 'Input.TextArea',
        },
      },
      {
        name: 'evidence',
        type: 'text',
        interface: 'textarea',
        uiSchema: {
          type: 'string',
          title: 'Evidence',
          'x-component': 'Input.TextArea',
        },
      },
      {
        name: 'openedAt',
        type: 'datetimeTz',
        interface: 'datetime',
        uiSchema: {
          type: 'datetime',
          title: 'Opened At',
          'x-component': 'DatePicker',
        },
      },
      {
        name: 'lastSeenAt',
        type: 'datetimeTz',
        interface: 'datetime',
        uiSchema: {
          type: 'datetime',
          title: 'Last Seen At',
          'x-component': 'DatePicker',
        },
      },
      {
        name: 'resolvedAt',
        type: 'datetimeTz',
        interface: 'datetime',
        uiSchema: {
          type: 'datetime',
          title: 'Resolved At',
          'x-component': 'DatePicker',
        },
      },
    ],
  },
];
