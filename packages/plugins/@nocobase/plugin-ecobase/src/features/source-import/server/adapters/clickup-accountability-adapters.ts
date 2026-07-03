import { randomUUID } from 'node:crypto';
import type { AdapterStreamItem, NormalizedRecord, SourceAdapter, SourceAdapterImportInput } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function naturalKey(input: SourceAdapterImportInput, kind: string, parts: Array<string | undefined>) {
  return [input.sourceConnectionId, kind, ...parts.map((part) => part ?? '_')].join(':');
}

function snapshotDate(input: SourceAdapterImportInput, row: Record<string, unknown>) {
  return asString(row.snapshotDate) ?? input.sourceVersion.slice(0, 10);
}

function taskRecord(input: SourceAdapterImportInput, row: Record<string, unknown>): NormalizedRecord {
  const externalTaskId = asString(row.externalTaskId) ?? asString(row.id) ?? randomUUID();
  const date = snapshotDate(input, row);
  return {
    kind: 'clickup_task_snapshot',
    data: {
      naturalKey: naturalKey(input, 'clickup_task_snapshot', [externalTaskId, date]),
      sourceConnectionId: input.sourceConnectionId,
      snapshotDate: date,
      externalTaskId,
      taskName: asString(row.taskName) ?? asString(row.name) ?? externalTaskId,
      status: asString(row.status) ?? 'open',
      priority: asString(row.priority) ?? 'normal',
      assignee: asString(row.assignee),
      assigneeEmail: asString(row.assigneeEmail),
      operationalArea: asString(row.operationalArea) ?? asString(row.area),
      dueDate: asString(row.dueDate),
      updatedAtSource: asString(row.updatedAtSource) ?? asString(row.updatedAt),
      lastMeaningfulUpdateAt: asString(row.lastMeaningfulUpdateAt),
      workspaceId: asString(row.workspaceId),
      workspaceName: asString(row.workspaceName),
      listId: asString(row.listId),
      listName: asString(row.listName),
      url: asString(row.url),
      payload: row,
    },
  };
}

function taskLinkRecord(
  input: SourceAdapterImportInput,
  row: Record<string, unknown>,
  externalTaskId: string,
): NormalizedRecord | null {
  const targetType = asString(row.targetType) ?? (asString(row.planningProductId) ? 'planning_product' : asString(row.supplierOrderId) ? 'supplier_order' : asString(row.okrId) || asString(row.externalOkrId) ? 'okr' : asString(row.generalCategory) ? 'general' : undefined);
  if (!targetType) {
    return null;
  }
  const targetRef = asString(row.planningProductId) ?? asString(row.supplierOrderId) ?? asString(row.okrId) ?? asString(row.externalOkrId) ?? asString(row.generalCategory);
  return {
    kind: 'task_link',
    data: {
      naturalKey: naturalKey(input, 'task_link', [externalTaskId, targetType, targetRef]),
      sourceConnectionId: input.sourceConnectionId,
      externalTaskId,
      targetType,
      planningProductId: asString(row.planningProductId),
      supplierOrderId: asString(row.supplierOrderId),
      okrId: asString(row.okrId),
      generalCategory: asString(row.generalCategory),
      confidence: asNumber(row.confidence) ?? 1,
      evidence: row,
    },
  };
}

function okrRecord(input: SourceAdapterImportInput, row: Record<string, unknown>): NormalizedRecord {
  const externalOkrId = asString(row.externalOkrId) ?? asString(row.id) ?? randomUUID();
  return {
    kind: 'okr',
    data: {
      naturalKey: naturalKey(input, 'okr', [externalOkrId]),
      sourceConnectionId: input.sourceConnectionId,
      externalOkrId,
      company: asString(row.company),
      title: asString(row.title) ?? externalOkrId,
      owner: asString(row.owner),
      operationalArea: asString(row.operationalArea) ?? asString(row.area),
      period: asString(row.period),
      status: asString(row.status) ?? 'active',
      payload: row,
    },
  };
}

function okrMetricRecord(input: SourceAdapterImportInput, row: Record<string, unknown>): NormalizedRecord {
  const externalOkrId = asString(row.externalOkrId) ?? asString(row.okrId) ?? randomUUID();
  const date = snapshotDate(input, row);
  const metricName = asString(row.metricName) ?? 'primary';
  return {
    kind: 'okr_metric_snapshot',
    data: {
      naturalKey: naturalKey(input, 'okr_metric_snapshot', [externalOkrId, metricName, date]),
      sourceConnectionId: input.sourceConnectionId,
      okrId: asString(row.okrId),
      externalOkrId,
      snapshotDate: date,
      metricName,
      targetValue: asNumber(row.targetValue),
      currentValue: asNumber(row.currentValue),
      progressPercent: asNumber(row.progressPercent),
      status: asString(row.status) ?? 'on_track',
      owner: asString(row.owner),
      operationalArea: asString(row.operationalArea) ?? asString(row.area),
      payload: row,
    },
  };
}

async function* fixtureImport(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
  let rowNumber = 0;
  for (const row of asArray(input.config.tasks)) {
    rowNumber += 1;
    const task = taskRecord(input, row);
    const externalTaskId = String(task.data.externalTaskId);
    const records: NormalizedRecord[] = [task];
    const inlineLink = taskLinkRecord(input, row, externalTaskId);
    if (inlineLink) {
      records.push(inlineLink);
    }
    yield { type: 'record', rowNumber, sourceKey: 'clickup-fixture:tasks', payload: row, record: records };
  }
  for (const row of asArray(input.config.taskLinks)) {
    rowNumber += 1;
    const externalTaskId = asString(row.externalTaskId) ?? asString(row.taskId) ?? randomUUID();
    const record = taskLinkRecord(input, row, externalTaskId);
    if (record) {
      yield { type: 'record', rowNumber, sourceKey: 'clickup-fixture:taskLinks', payload: row, record };
    }
  }
  for (const row of asArray(input.config.okrs)) {
    rowNumber += 1;
    yield { type: 'record', rowNumber, sourceKey: 'clickup-fixture:okrs', payload: row, record: okrRecord(input, row) };
  }
  for (const row of asArray(input.config.okrMetricSnapshots)) {
    rowNumber += 1;
    yield { type: 'record', rowNumber, sourceKey: 'clickup-fixture:okrMetricSnapshots', payload: row, record: okrMetricRecord(input, row) };
  }
  if (rowNumber === 0) {
    yield {
      type: 'rowIssue',
      issue: {
        rowNumber: 0,
        severity: 'warning',
        code: 'clickup_fixture_empty',
        message: 'ClickUp fixture import has no tasks, taskLinks, okrs, or okrMetricSnapshots in source connection config.',
      },
    };
  }
}

async function* accessCheckImport(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
  const hasCredential = Boolean(input.secretRef || asString(input.config.apiToken) || asString(input.config.accessToken));
  if (hasCredential) {
    return;
  }
  const checkedAt = new Date().toISOString();
  yield {
    type: 'record',
    rowNumber: 1,
    sourceKey: 'clickup-access-check',
    payload: { status: 'blocked', blockerCode: 'clickup_credentials_missing' },
    record: {
      kind: 'source_access_audit',
      data: {
        naturalKey: [input.sourceConnectionId, 'source_access_audit', 'clickup-access-check', input.sourceVersion].join(':'),
        sourceConnectionId: input.sourceConnectionId,
        sourceType: 'clickup',
        adapterName: 'clickup-access-check',
        status: 'blocked',
        blockerCode: 'clickup_credentials_missing',
        message: 'ClickUp credentials are not configured; fixture/manual imports remain available for downstream development but do not count as live ClickUp acceptance.',
        checkedAt,
        payload: { sourceIdentifier: input.sourceIdentifier, sourceVersion: input.sourceVersion },
      },
    },
  };
}

export const clickupFixtureAdapter: SourceAdapter = {
  metadata: {
    name: 'clickup-fixture',
    title: 'ClickUp fixture/manual accountability import',
    sourceType: 'clickup',
    supportedDomains: ['accountability', 'foundation'],
    version: '1.0.0',
  },
  import: fixtureImport,
};

export const clickupAccessCheckAdapter: SourceAdapter = {
  metadata: {
    name: 'clickup-access-check',
    title: 'ClickUp access check',
    sourceType: 'clickup',
    supportedDomains: ['accountability', 'foundation'],
    version: '1.0.0',
  },
  import: accessCheckImport,
};
