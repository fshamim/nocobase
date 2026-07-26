/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { CsvSourceFile } from './adapters/csv-utils';
import { CsvRowReader, parseCsv } from './adapters/csv-utils';
import { EcobaseInboundEntryBaselineStamper } from '../../inventory-dashboard/server/engine/inbound-entry-baseline';
import type { EcobaseDatabase } from './import-service';
import { FOUR_COMPANY_MIGRATION_PROFILE } from './four-company-migration-profile';
import { projectSourceRecord } from './source-record-projection';
import { silverSupplierOrderReadModel } from '../../supplier-management/server/silver-supplier-order-read-model';
import {
  canonicalOrderStatusForOperationalStatus,
  lifecycleStatusForOperationalStatus,
  normalizeOrderOperationalStatus,
  workflowStageForOperationalStatus,
} from '../../order-planning/order-operational-status';
import clickupOverrides from './supplier-order-import/supplier-order-import-overrides.json';
import {
  normalizeExternalOrderId,
  normalizeExternalSupplierCode,
  normalizeSourceAsin,
} from './supplier-order-import/supplier-order-import-plan';
import { validateSupplierOrderImportOverrides } from './supplier-order-import/supplier-order-import-overrides';
import {
  APPROVED_CLICKUP_ATTRIBUTION_USERS,
  approvedClickupAttributionUser,
  normalizeClickupActorIdentity,
  resolveClickupActor,
  type ClickupActorMatchMethod,
} from './clickup-attribution-users';

const COMPANY_NAME_BY_KEY = Object.fromEntries(
  FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.map((company) => [company.companyKey, company.name]),
) as Record<string, string>;
const COMPANY_BY_ORDER_PREFIX = Object.fromEntries(
  Object.entries(FOUR_COMPANY_MIGRATION_PROFILE.orderPrefixCompanyKeys).map(([prefix, companyKey]) => [
    prefix,
    COMPANY_NAME_BY_KEY[companyKey],
  ]),
) as Record<string, string>;
const ORDER_REF_PATTERN = new RegExp(
  `\\b(?:${Object.keys(FOUR_COMPANY_MIGRATION_PROFILE.orderPrefixCompanyKeys).join('|')})\\d{4,8}[A-Z]?\\b`,
  'gi',
);
const MAIN_ORDER_PATTERN = /\b(?:new\s*order|restock|po|order)\b/i;
const HELPER_TASK_PATTERN = /shipping labels?|labels required|time tracking|approval|reimbursement|claim|sample/i;
export const MAIN_TASK_LISTS = new Set(['order management (orm)', 'prep & logistics']);
const CLICKUP_TASK_OVERRIDES = validateSupplierOrderImportOverrides(clickupOverrides).clickupTasks;

const COMMENT_PROPOSAL_LIMIT = 20;

type PlainRecord = Record<string, unknown>;

type ParsedClickupComment = {
  text: string;
  actor?: string;
  occurredAt: string;
  assigned?: boolean;
  resolved?: string;
};

type ParsedTask = {
  ref: string;
  clickupStatus: string;
  mappedStatus?: string;
  lifecycleStatus?: string;
  workflowStage?: string;
  taskId: string;
  taskLink?: string;
  taskName: string;
  dateCreated?: string;
  dateCreatedText?: string;
  parentId?: string;
  listName?: string;
  lineNumber: number;
  mainOrderTask: boolean;
  comments: ParsedClickupComment[];
  invalidCommentCount: number;
  company: string;
  titleCompany?: string;
  companyConflict?: string;
};

export interface ClickupOrderStatusImportResult {
  dryRun: boolean;
  fileCount: number;
  rowCount: number;
  extractedRefCount: number;
  selectedRefCount: number;
  matchedOrderCount: number;
  updatedOrderCount: number;
  unmatchedRefCount: number;
  duplicateRefCount: number;
  unmappedStatusCount: number;
  selectedCommentCount: number;
  proposedCommentCount: number;
  importedCommentCount: number;
  updatedCommentCount: number;
  duplicateCommentCount: number;
  invalidCommentCount: number;
  missingMainTaskCount: number;
  conflictingMainTaskCount: number;
  companyConflictCount: number;
  ambiguousOrderCount: number;
  ambiguousMultiRefTaskCount: number;
  operatorOverrideCount: number;
  overriddenOperatorStatusCount: number;
  selectedTaskOverrideCount: number;
  workflowDraftCount: number;
  workflowDraftLineCount: number;
  reconciledWorkflowDraftLineCount: number;
  workflowDraftRefs: string[];
  workflowDraftExceptions: Array<Record<string, unknown>>;
  blockingIssueCount: number;
  proposedUpdates: Array<Record<string, unknown>>;
  proposedComments: Array<Record<string, unknown>>;
  unmatchedRefs: string[];
  duplicateRefs: Array<Record<string, unknown>>;
  unmappedStatuses: Array<Record<string, unknown>>;
  missingMainTaskRefs: string[];
  conflictingMainTasks: Array<Record<string, unknown>>;
  companyConflicts: Array<Record<string, unknown>>;
  ambiguousOrders: Array<Record<string, unknown>>;
  ambiguousMultiRefTasks: Array<Record<string, unknown>>;
  authorityCounts?: Record<string, number>;
  unresolvedAuthorityOrderIds?: string[];
  discoveredActorCount: number;
  linkedActorCount: number;
  createdUserCount: number;
  unresolvedActors: string[];
  actorMappings: Array<{
    sourceActor: string;
    occurrenceCount: number;
    resolution: 'mapped' | 'unresolved';
    mappedUserKey?: string;
    mappedUserName?: string;
    matchMethod?: ClickupActorMatchMethod;
  }>;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asIdString(value: unknown) {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim().length > 0
    ? String(value).trim()
    : undefined;
}

function asPlainRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as PlainRecord) : {};
}

function toPlainRecord(value: unknown): PlainRecord {
  const record = asPlainRecord(value);
  if (typeof record.toJSON === 'function') return asPlainRecord(record.toJSON());
  return record;
}

function normalizeOrderRef(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function canonicalCompanyName(value: string | undefined) {
  const compact = value?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';
  return FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.find((company) => {
    const companyName = company.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return compact.includes(companyName.replace(/(?:llc|inc)$/i, ''));
  })?.name;
}

function companyForOrderRef(ref: string) {
  return COMPANY_BY_ORDER_PREFIX[ref.slice(0, 2)];
}

function companyFromTaskTitle(taskName: string) {
  return canonicalCompanyName(taskName);
}

export function extractClickupOrderRefsFromTitle(taskName: string) {
  const refs: string[] = [];
  for (const match of taskName.matchAll(ORDER_REF_PATTERN)) {
    const ref = normalizeOrderRef(match[0]);
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

export function isRootTask(parentId: string | undefined) {
  return !parentId || ['blank', 'null', 'none'].includes(parentId.toLowerCase());
}

function isLegacyCompactRootTitle(taskName: string, ref: string) {
  const remainder = taskName
    .replace(new RegExp(ref, 'i'), '')
    .replace(/\b(?:ecofission|muxtex|rehmat|stop\s*shop|llc|inc)\b/gi, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim();
  return !remainder || remainder.toLowerCase() === 'new';
}

function isMainOrderTask(params: { taskName: string; ref: string; parentId?: string; listName?: string }) {
  return (
    isRootTask(params.parentId) &&
    MAIN_TASK_LISTS.has(params.listName?.trim().toLowerCase() ?? '') &&
    !HELPER_TASK_PATTERN.test(params.taskName) &&
    (MAIN_ORDER_PATTERN.test(params.taskName) || isLegacyCompactRootTitle(params.taskName, params.ref))
  );
}

export function canonicalOrderStatusForClickupStatus(status: string | undefined) {
  return canonicalOrderStatusForOperationalStatus(status);
}

function timestamp(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseClickupCommentDate(value: string | undefined) {
  const match = asString(value)?.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\s*GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i,
  );
  if (!match) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hour12 = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9]);
  const offsetMinute = Number(match[10] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour12 < 1 ||
    hour12 > 12 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59
  ) {
    return undefined;
  }
  const hour = (hour12 % 12) + (match[7].toUpperCase() === 'PM' ? 12 : 0);
  const signedOffsetMinutes = (offsetHour * 60 + offsetMinute) * (match[8] === '+' ? 1 : -1);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - signedOffsetMinutes * 60_000);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function parseClickupComments(value: string | undefined) {
  const rawValue = asString(value);
  if (!rawValue) return { comments: [] as ParsedClickupComment[], invalidCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return { comments: [] as ParsedClickupComment[], invalidCount: 1 };
  }
  if (!Array.isArray(parsed)) return { comments: [] as ParsedClickupComment[], invalidCount: 1 };
  let invalidCount = 0;
  const comments = parsed.flatMap((item): ParsedClickupComment[] => {
    const record = asPlainRecord(item);
    const text = asString(record.text);
    const actor = asString(record.by);
    const occurredAt = parseClickupCommentDate(asString(record.date));
    if (!text || !actor || !occurredAt) {
      invalidCount += 1;
      return [];
    }
    return [
      {
        text,
        actor,
        occurredAt,
        assigned: typeof record.assigned === 'boolean' ? record.assigned : undefined,
        resolved: asString(record.resolved),
      },
    ];
  });
  return { comments, invalidCount };
}

function authoritativeTaskForRef(ref: string, tasks: ParsedTask[]) {
  const candidates = tasks.filter((task) => task.mainOrderTask);
  if (candidates.length === 0) return { missingMainTask: true as const };
  const ordered = [...candidates].sort(
    (left, right) => timestamp(right.dateCreated) - timestamp(left.dateCreated) || right.lineNumber - left.lineNumber,
  );
  const companyConflicts = ordered.filter((task) => task.companyConflict);
  const statuses = [...new Set(ordered.map((task) => task.clickupStatus))];
  const override = CLICKUP_TASK_OVERRIDES[ref];
  const selected = statuses.length > 1 ? ordered.find((task) => task.taskId === override?.selectedTaskId) : ordered[0];
  return {
    task: companyConflicts.length ? undefined : selected,
    companyConflicts,
    conflictingTasks: statuses.length > 1 ? ordered : [],
    unresolvedConflict: statuses.length > 1 && !selected,
    override: selected && statuses.length > 1 ? override : undefined,
    statuses,
  };
}

function taskOccurredAt(task: ParsedTask) {
  const value = timestamp(task.dateCreated);
  return value > 0 ? new Date(value).toISOString() : undefined;
}

function statusEvidence(
  task: ParsedTask,
  observedAt: string,
  candidateTaskIds: string[],
  override?: { selectedTaskId: string; reason: string },
) {
  const projection = projectSourceRecord(
    'clickup_order_evidence',
    {
      taskId: task.taskId,
      parentId: task.parentId,
      orderRef: task.ref,
      status: task.clickupStatus,
      statusUpdatedAt: taskOccurredAt(task),
    },
    { retainedOrderRef: task.ref },
  );
  return {
    source: 'clickup_csv',
    extraction: 'task_name_compact_order_ref',
    ...projection.payload,
    clickupStatus: task.clickupStatus,
    taskCreatedAt: taskOccurredAt(task),
    observedAt,
    mappedStatus: task.mappedStatus,
    workflowStage: task.workflowStage,
    candidateTaskIds,
    selectionOverride: override,
    lineNumber: task.lineNumber,
    mainOrderTask: task.mainOrderTask,
  };
}

function compactText(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function commentHash(task: ParsedTask, comment: ParsedClickupComment) {
  return createHash('sha1')
    .update([task.taskId, comment.occurredAt, comment.actor ?? ''].join('\n'))
    .digest('hex')
    .slice(0, 16);
}

function commentActivityValues(params: {
  sourceConnectionId: string;
  task: ParsedTask;
  comment: ParsedClickupComment;
  order: PlainRecord;
  supplierOrderId: string;
  actorUserId?: string;
  actorUserKey?: string;
  actorMatchMethod?: ClickupActorMatchMethod;
}) {
  const company = asString(params.order.company);
  const supplierId = asString(params.order.supplierId);
  if (!company || !supplierId) {
    throw new Error('Ecobase ClickUp comment import failed: matched supplier order is missing company or supplierId.');
  }
  const projection = projectSourceRecord(
    'clickup_order_evidence',
    {
      taskId: params.task.taskId,
      parentId: params.task.parentId,
      orderRef: params.task.ref,
      status: params.task.clickupStatus,
      commentOccurredAt: params.comment.occurredAt,
      commentBody: params.comment.text,
    },
    { retainedOrderRef: params.task.ref },
  );
  const body = asString(projection.payload.commentBody);
  if (!body) return undefined;
  const naturalKey = [
    params.sourceConnectionId,
    'clickup_comment',
    params.supplierOrderId,
    params.comment.occurredAt,
    commentHash(params.task, params.comment),
  ].join(':');
  const actorResolution = params.actorUserId
    ? {
        actorResolution: 'mapped',
        actorUserKey: params.actorUserKey,
        actorMatchMethod: params.actorMatchMethod,
      }
    : {
        actorResolution: 'unresolved',
        sourceActorHash: createHash('sha256')
          .update(normalizeClickupActorIdentity(params.comment.actor))
          .digest('hex')
          .slice(0, 16),
      };
  return {
    entityType: 'supplier_order',
    entityId: params.supplierOrderId,
    actorType: params.actorUserId ? 'user' : 'external',
    actorUserId: params.actorUserId,
    commentType: 'note',
    body,
    sourceCommentKey: naturalKey,
    occurredAt: params.comment.occurredAt,
    contextSnapshotJson: {
      naturalKey,
      source: 'clickup_csv',
      sourceConnectionId: params.sourceConnectionId,
      company,
      supplierId,
      supplierOrderId: params.supplierOrderId,
      orderRef: params.task.ref,
      occurredAt: params.comment.occurredAt,
      ...actorResolution,
    },
    workflowDetectionStatus: 'none',
    createdAt: params.comment.occurredAt,
    updatedAt: params.comment.occurredAt,
  };
}

function commentNaturalKey(comment: PlainRecord) {
  return asString(comment.sourceCommentKey) ?? asString(asPlainRecord(comment.contextSnapshotJson).naturalKey);
}

function recordValuesChanged(existing: PlainRecord, next: PlainRecord) {
  return Object.entries(next).some(([key, value]) => !isDeepStrictEqual(existing[key] ?? null, value ?? null));
}

function commentValuesChanged(existing: PlainRecord, next: PlainRecord) {
  return (
    asString(existing.actorType) !== asString(next.actorType) ||
    asIdString(existing.actorUserId) !== asIdString(next.actorUserId) ||
    asString(existing.commentType) !== asString(next.commentType) ||
    asString(existing.body) !== asString(next.body) ||
    asString(existing.workflowDetectionStatus) !== asString(next.workflowDetectionStatus) ||
    !isDeepStrictEqual(asPlainRecord(existing.contextSnapshotJson), asPlainRecord(next.contextSnapshotJson))
  );
}

function commentProposal(params: { task: ParsedTask; comment: ParsedClickupComment; supplierOrderId: string }) {
  return {
    supplierOrderId: params.supplierOrderId,
    externalOrderRef: params.task.ref,
    taskId: params.task.taskId,
    taskName: params.task.taskName,
    actor: params.comment.actor,
    occurredAt: params.comment.occurredAt,
    notesPreview: compactText(params.comment.text).slice(0, 160),
  };
}

export function parseClickupOrderStatusFiles(files: CsvSourceFile[]) {
  const tasksByRef = new Map<string, ParsedTask[]>();
  const ambiguousMultiRefTasks: Array<Record<string, unknown>> = [];
  let rowCount = 0;
  for (const file of files) {
    const parsed = parseCsv(file.content);
    parsed.rows.forEach((rawRow, index) => {
      rowCount += 1;
      const row = new CsvRowReader(rawRow);
      const taskName = row.string('Task Name') ?? '';
      const clickupStatus = normalizeOrderOperationalStatus(row.string('Status'));
      if (!taskName || !clickupStatus) return;
      const orderRefs = extractClickupOrderRefsFromTitle(taskName);
      if (orderRefs.length > 1) {
        ambiguousMultiRefTasks.push({
          taskId: row.string('Task ID') ?? `${file.name}:${index + 2}`,
          lineNumber: index + 2,
          orderRefs,
        });
        return;
      }
      const parsedComments = parseClickupComments(row.string('Comments'));
      for (const ref of orderRefs) {
        const company = companyForOrderRef(ref);
        if (!company) continue;
        const titleCompany = companyFromTaskTitle(taskName);
        const parentId = row.string('Parent ID');
        const listName = row.string('List Name');
        const task: ParsedTask = {
          ref,
          company,
          titleCompany,
          companyConflict:
            titleCompany && titleCompany !== company
              ? `Order ${ref} implies ${company}, but task title implies ${titleCompany}.`
              : undefined,
          clickupStatus,
          mappedStatus: canonicalOrderStatusForClickupStatus(clickupStatus),
          lifecycleStatus: lifecycleStatusForOperationalStatus(clickupStatus),
          workflowStage: workflowStageForOperationalStatus(clickupStatus),
          taskId: row.string('Task ID') ?? `${file.name}:${index + 2}:${ref}`,
          taskLink: row.string('Task Link'),
          taskName,
          dateCreated: row.string('Date Created'),
          dateCreatedText: row.string('Date Created Text'),
          parentId,
          listName,
          lineNumber: index + 2,
          mainOrderTask: isMainOrderTask({ taskName, ref, parentId, listName }),
          comments: parsedComments.comments,
          invalidCommentCount: parsedComments.invalidCount,
        };
        tasksByRef.set(ref, [...(tasksByRef.get(ref) ?? []), task]);
      }
    });
  }

  const selectedTasks: Array<{
    ref: string;
    company: string;
    task: ParsedTask;
    allTasks: ParsedTask[];
    override?: { selectedTaskId: string; reason: string };
  }> = [];
  const missingMainTaskRefs: string[] = [];
  const conflictingMainTasks: Array<Record<string, unknown>> = [];
  const companyConflicts: Array<Record<string, unknown>> = [];
  for (const [ref, tasks] of tasksByRef.entries()) {
    const selection = authoritativeTaskForRef(ref, tasks);
    if ('missingMainTask' in selection) {
      missingMainTaskRefs.push(ref);
      continue;
    }
    if (selection.companyConflicts.length > 0) {
      companyConflicts.push({
        ref,
        conflicts: selection.companyConflicts.map((task) => ({
          taskId: task.taskId,
          taskName: task.taskName,
          lineNumber: task.lineNumber,
          error: task.companyConflict,
        })),
      });
    }
    if (selection.conflictingTasks.length > 0) {
      conflictingMainTasks.push({
        ref,
        selectedTaskId: selection.task?.taskId,
        selectedStatus: selection.task?.clickupStatus,
        resolvedByOverride: Boolean(selection.override),
        statuses: selection.statuses,
        tasks: selection.conflictingTasks.map((task) => ({
          taskId: task.taskId,
          taskName: task.taskName,
          lineNumber: task.lineNumber,
          clickupStatus: task.clickupStatus,
          dateCreated: task.dateCreated,
        })),
      });
    }
    if (selection.task) {
      selectedTasks.push({
        ref,
        company: selection.task.company,
        task: selection.task,
        allTasks: tasks,
        override: selection.override,
      });
    }
  }

  return {
    rowCount,
    tasksByRef,
    selectedTasks,
    missingMainTaskRefs,
    conflictingMainTasks,
    companyConflicts,
    ambiguousMultiRefTasks,
  };
}

type WorkflowDraftDetail = {
  sourceFile: string;
  sourceRow: number;
  sourceHash: string;
  company: string;
  externalOrderId: string;
  externalSupplierCode: string;
  asin: string;
  supplierSku?: string;
  upc?: string;
  orderQty: number;
  unitCost?: number;
  expectedCost?: number;
  orderType?: string;
  orderDate?: string;
};

function finiteNumber(value: string | undefined) {
  const parsed = Number(
    value
      ?.replace(/[$£€,%]/g, '')
      .replace(/,/g, '')
      .trim(),
  );
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dayFirstDate(value: string | undefined) {
  const match = value?.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!match) return undefined;
  const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : undefined;
}

function parseWorkflowDraftDetails(files: CsvSourceFile[]) {
  const detailsByRef = new Map<string, WorkflowDraftDetail[]>();
  for (const file of files) {
    const parsed = parseCsv(file.content);
    parsed.rows.forEach((rawRow, index) => {
      const row = new CsvRowReader(rawRow);
      const externalOrderId = normalizeExternalOrderId(row.string('Order ID'));
      const company = canonicalCompanyName(row.string('Company'));
      const externalSupplierCode = normalizeExternalSupplierCode(row.string('SR ID'));
      const asin = normalizeSourceAsin(row.string('ASIN'));
      const orderQty = finiteNumber(row.string('Qty'));
      if (!externalOrderId || !company || !externalSupplierCode || !asin || !orderQty || orderQty <= 0) return;
      const detail: WorkflowDraftDetail = {
        sourceFile: file.name,
        sourceRow: index + 2,
        sourceHash: createHash('sha256').update(JSON.stringify(rawRow)).digest('hex'),
        company,
        externalOrderId,
        externalSupplierCode,
        asin,
        supplierSku: asString(row.string('SKU')),
        upc: asString(row.string('UPC')),
        orderQty,
        unitCost: finiteNumber(row.string('PPU')),
        expectedCost: finiteNumber(row.string('Total Cost')),
        orderType: asString(row.string('Order type')),
        orderDate: dayFirstDate(row.string('Timestamp')),
      };
      detailsByRef.set(externalOrderId, [...(detailsByRef.get(externalOrderId) ?? []), detail]);
    });
  }
  return detailsByRef;
}

function marketplaceFromTaskName(value: string) {
  if (/\b(?:usa|us|united states)\b/i.test(value)) return 'amazon.com';
  if (/\b(?:uk|united kingdom)\b/i.test(value)) return 'amazon.co.uk';
  if (/\b(?:mexico|mx)\b/i.test(value)) return 'amazon.com.mx';
  if (/\b(?:canada|ca)\b/i.test(value)) return 'amazon.ca';
  return undefined;
}

function marketplaceFromFamily(value: unknown) {
  const marketplace = asString(value)?.toLowerCase();
  if (marketplace === 'amazon.com') return 'US';
  if (marketplace === 'amazon.co.uk') return 'UK';
  return asString(value);
}

export class EcobaseClickupOrderStatusService {
  constructor(private db: EcobaseDatabase) {}

  async ensureApprovedAttributionUsers(dryRun = false) {
    const userRepo = this.db.getRepository('users');
    const users = (await userRepo.find({ limit: 100000 })).map(toPlainRecord);
    const userIdsByKey = new Map<string, string>();
    const claimedUserIds = new Set<string>();
    let createdUserCount = 0;

    for (const approved of APPROVED_CLICKUP_ATTRIBUTION_USERS) {
      const approvedEmails = new Set((approved.emails ?? []).map(normalizeClickupActorIdentity));
      const matches = users.filter((user) => {
        const username = normalizeClickupActorIdentity(asString(user.username));
        const nickname = normalizeClickupActorIdentity(asString(user.nickname));
        const email = normalizeClickupActorIdentity(asString(user.email));
        return (
          username === normalizeClickupActorIdentity(approved.key) ||
          nickname === normalizeClickupActorIdentity(approved.displayName) ||
          approvedEmails.has(email)
        );
      });
      if (matches.length > 1) {
        throw new Error(
          `Ecobase ClickUp attribution user upsert failed: ${approved.displayName} matches multiple NocoBase users.`,
        );
      }
      let user = matches[0];
      const existingTk = user?.id as string | number | undefined;
      const existingId = asIdString(existingTk);
      if (existingId && claimedUserIds.has(existingId)) {
        throw new Error(
          `Ecobase ClickUp attribution user upsert failed: NocoBase user ${existingId} matches multiple approved identities.`,
        );
      }
      const settings = asPlainRecord(user?.systemSettings);
      const values = {
        username: approved.key,
        nickname: approved.displayName,
        ...(approved.emails?.[0] ? { email: approved.emails[0] } : {}),
        systemSettings: {
          ...settings,
          ecobaseAttribution: {
            state: 'pending_invite',
            loginDisabled: true,
            attributionOnly: true,
            ...(approved.title ? { title: approved.title } : {}),
          },
        },
      };
      if (!dryRun) {
        if (existingId) {
          if (recordValuesChanged(user, values)) await userRepo.update({ filterByTk: existingTk, values });
          user = { ...user, ...values };
        } else {
          user = toPlainRecord(await userRepo.create({ values }));
          createdUserCount += 1;
          users.push(user);
        }
      }
      const userId = asIdString(user?.id);
      if (userId) {
        if (!dryRun) await this.db.getRepository('rolesUsers').destroy?.({ where: { userId: user?.id } });
        claimedUserIds.add(userId);
        userIdsByKey.set(approved.key, userId);
      }
    }

    return { userIdsByKey, createdUserCount };
  }

  parseCsvFiles(files: CsvSourceFile[]) {
    return parseClickupOrderStatusFiles(files);
  }

  private async reconcileWorkflowDraftLineMappings(dryRun: boolean) {
    const orders = (
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverOrders)
        .find({ filter: { recordType: 'workflow_draft' }, limit: 100000 })
    ).map(toPlainRecord);
    const orderIds = orders.map((order) => asIdString(order.id)).filter((id): id is string => Boolean(id));
    if (!orderIds.length) return 0;
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines);
    const lines = (await repo.find({ filter: { orderId: { $in: orderIds } }, limit: 100000 })).map(toPlainRecord);
    let reconciled = 0;
    for (const line of lines) {
      const expected = asIdString(line.companyProductId)
        ? 'exact_member'
        : asIdString(line.companyProductFamilyId)
          ? 'family_only'
          : 'unresolved';
      const values = { mappingScope: expected, productMappingStatus: expected };
      if (!recordValuesChanged(line, values)) continue;
      reconciled += 1;
      const id = asIdString(line.id);
      if (!dryRun && !id) throw new Error('Ecobase ClickUp reconciliation failed: workflow draft line has no ID.');
      if (!dryRun) await repo.update({ filterByTk: id, values });
    }
    return reconciled;
  }

  private async createWorkflowDrafts(params: {
    selectedTasks: ReturnType<typeof parseClickupOrderStatusFiles>['selectedTasks'];
    matchedRefs: Set<string>;
    orderDetailFiles: CsvSourceFile[];
    dryRun: boolean;
    sourceConnectionId: string;
    observedAt: string;
  }) {
    const detailsByRef = parseWorkflowDraftDetails(params.orderDetailFiles);
    const unmatchedTasks = params.selectedTasks.filter(
      ({ ref, task }) => !params.matchedRefs.has(ref) && !['complete', 'cancelled'].includes(task.workflowStage ?? ''),
    );
    const exceptions: Array<Record<string, unknown>> = [];
    const workflowDraftRefs: string[] = [];
    if (!unmatchedTasks.length) {
      return { workflowDraftCount: 0, workflowDraftLineCount: 0, workflowDraftRefs, exceptions };
    }

    const [companies, externalRefs, supplierAccounts, families, companyProducts, products] = await Promise.all([
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({ limit: 1000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: 100000 }),
      this.db.getRepository(ECOBASE_COLLECTIONS.silverProducts).find({ limit: 100000 }),
    ]).then((groups) => groups.map((rows) => rows.map(toPlainRecord)));
    const companyByName = new Map<string, PlainRecord>(
      companies.map((company) => [canonicalCompanyName(asString(company.name)), company]),
    );
    const externalRefByCode = new Map(
      externalRefs.map((externalRef) => [asString(externalRef.normalizedExternalSupplierCode), externalRef]),
    );
    const accountByCompanySupplier = new Map(
      supplierAccounts.map((account) => [
        `${asIdString(account.companyId)}:${asIdString(account.supplierId)}`,
        account,
      ]),
    );
    const productById = new Map(products.map((product) => [asIdString(product.id), product]));
    const membersByFamily = new Map<string, PlainRecord[]>();
    for (const member of companyProducts) {
      const familyId = asIdString(member.companyProductFamilyId);
      if (familyId) membersByFamily.set(familyId, [...(membersByFamily.get(familyId) ?? []), member]);
    }

    let workflowDraftCount = 0;
    let workflowDraftLineCount = 0;
    for (const selected of unmatchedTasks) {
      const details = detailsByRef.get(selected.ref) ?? [];
      const company = companyByName.get(selected.company);
      const companyId = asIdString(company?.id);
      const supplierCodes = [...new Set(details.map((detail) => detail.externalSupplierCode))];
      const externalRef = supplierCodes.length === 1 ? externalRefByCode.get(supplierCodes[0]) : undefined;
      const supplierId = asIdString(externalRef?.supplierId);
      const supplierExternalRefId = asIdString(externalRef?.id);
      const supplierAccountId = asIdString(
        companyId && supplierId ? accountByCompanySupplier.get(`${companyId}:${supplierId}`)?.id : undefined,
      );
      if (
        !details.length ||
        !companyId ||
        details.some((detail) => detail.company !== selected.company) ||
        supplierCodes.length !== 1 ||
        !supplierId ||
        !supplierExternalRefId ||
        !supplierAccountId ||
        details.some((detail) => !detail.orderDate)
      ) {
        exceptions.push({
          ref: selected.ref,
          taskId: selected.task.taskId,
          reason: details.length ? 'workflow_draft_identity_unresolved' : 'order_details_missing',
        });
        continue;
      }
      const taskMarketplace = marketplaceFromTaskName(selected.task.taskName);
      const resolvedLines = details.map((detail) => {
        const familyCandidates = families.filter(
          (family) =>
            asIdString(family.companyId) === companyId &&
            asString(family.canonicalAsin) === detail.asin &&
            (!taskMarketplace || asString(family.marketplace)?.toLowerCase() === taskMarketplace),
        );
        if (familyCandidates.length !== 1) return undefined;
        const family = familyCandidates[0];
        const familyId = asIdString(family.id)!;
        const memberCandidates = (membersByFamily.get(familyId) ?? []).filter((member) => {
          const product = productById.get(asIdString(member.productId));
          return detail.supplierSku && asString(product?.sku) === detail.supplierSku;
        });
        if (memberCandidates.length > 1) return undefined;
        return {
          detail,
          family,
          familyId,
          companyProductId: memberCandidates.length === 1 ? asIdString(memberCandidates[0].id) : undefined,
        };
      });
      if (resolvedLines.some((line) => !line)) {
        exceptions.push({
          ref: selected.ref,
          taskId: selected.task.taskId,
          reason: 'workflow_draft_family_unresolved',
        });
        continue;
      }
      workflowDraftCount += 1;
      workflowDraftLineCount += resolvedLines.length;
      workflowDraftRefs.push(selected.ref);
      if (params.dryRun) continue;

      const persist = async (transaction?: unknown) => {
        const orderId = randomUUID();
        const evidence = statusEvidence(
          selected.task,
          params.observedAt,
          selected.allTasks.filter((task) => task.mainOrderTask).map((task) => task.taskId),
          selected.override,
        );
        const sourceMarketplace = marketplaceFromFamily(resolvedLines[0]!.family.marketplace);
        await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
          values: {
            id: orderId,
            companyId,
            supplierId,
            supplierExternalRefId,
            supplierAccountId,
            orderRef: selected.ref,
            externalOrderId: selected.ref,
            recordType: 'workflow_draft',
            purchaseEvidenceStatus: 'unconfirmed_workflow',
            orderDate: details[0].orderDate,
            dailySequenceLetter: selected.ref.match(/[A-Z]$/)?.[0] ?? 'A',
            orderIntent: details[0].orderType?.toLowerCase() ?? 'unknown',
            sourceMarketplace,
            canonicalStatus: selected.task.mappedStatus,
            lifecycleStatus: selected.task.lifecycleStatus,
            operationalStatus: selected.task.clickupStatus,
            workflowStage: selected.task.workflowStage,
            // T-3.0 (inventory dashboard): a created order enters its stage now.
            workflowStageEnteredAt: params.observedAt,
            statusSource: 'clickup_csv',
            statusCheckRequired: !selected.task.mappedStatus,
            statusEvidenceJson: { clickupStatusImport: evidence, importedAt: params.observedAt, statusHistory: [] },
            authorityStatus: 'clickup_authoritative',
            authoritySource: 'clickup_csv',
            authorityTaskRef: selected.task.taskId,
            authorityAsOf: params.observedAt,
            authorityEvidenceJson: { clickupStatusEvidence: evidence },
            taskRef: selected.task.taskId,
            taskLink: selected.task.taskLink,
            expectedCost: details.reduce((sum, detail) => sum + (detail.expectedCost ?? 0), 0),
            sourceEvidence: {
              sourceConnectionId: params.sourceConnectionId,
              clickupTaskId: selected.task.taskId,
              orderDetails: details.map(({ sourceFile, sourceRow, sourceHash }) => ({
                sourceFile,
                sourceRow,
                sourceHash,
              })),
            },
          },
          transaction,
        });
        for (const [index, resolved] of resolvedLines.entries()) {
          const { detail, familyId, companyProductId } = resolved!;
          await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
            values: {
              id: randomUUID(),
              orderId,
              companyProductFamilyId: familyId,
              companyProductId,
              supplierProductId: null,
              sourceLineKey: `workflow_draft:${detail.sourceHash}`,
              externalOrderId: selected.ref,
              lineOrdinal: index + 1,
              sourceAsin: detail.asin,
              sourceSupplierSku: detail.supplierSku,
              sourceMarketplace: marketplaceFromFamily(resolved!.family.marketplace),
              sourceSkuType: detail.supplierSku ? 'supplier_sku' : detail.upc ? 'upc' : 'unknown',
              mappingScope: companyProductId ? 'exact_member' : 'family_only',
              purchaseEvidenceStatus: 'unconfirmed_workflow',
              sourceRowNumber: detail.sourceRow,
              sourceRowHash: detail.sourceHash,
              productMappingStatus: companyProductId ? 'exact_member' : 'family_only',
              productMappingEvidenceJson: { reason: 'workflow_draft_exact_company_family' },
              orderedQty: detail.orderQty,
              orderQty: detail.orderQty,
              unitCost: detail.unitCost,
              expectedCost: detail.expectedCost,
              orderType: detail.orderType,
              operationalStatus: selected.task.clickupStatus,
              upc: detail.upc,
              sourceEvidence: {
                file: detail.sourceFile,
                row: detail.sourceRow,
                hash: detail.sourceHash,
                clickupTaskId: selected.task.taskId,
              },
            },
            transaction,
          });
        }
        // 054 R2: a draft created straight into inbound monitoring enters the stage now.
        await new EcobaseInboundEntryBaselineStamper(this.db).stampOrderEntry({
          orderId,
          previousStage: undefined,
          nextStage: selected.task.workflowStage,
          transaction,
        });
      };
      const sequelize = (
        this.db as EcobaseDatabase & {
          sequelize?: { transaction: (callback: (transaction: unknown) => Promise<void>) => Promise<void> };
        }
      ).sequelize;
      if (sequelize) await sequelize.transaction(persist);
      else await persist();
    }
    return { workflowDraftCount, workflowDraftLineCount, workflowDraftRefs, exceptions };
  }

  async reconcileAuthority(asOf = new Date().toISOString()) {
    const orderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    const orders = (await silverSupplierOrderReadModel(this.db, { limit: 100000 })).supplierOrders.map(toPlainRecord);
    const counts: Record<string, number> = {};
    const unresolvedAuthorityOrderIds: string[] = [];
    const alternateSources = new Set([
      'operator',
      'shipping_evidence',
      'fulfillment_evidence',
      'payment_evidence',
      'invoice_evidence',
    ]);
    const closedStatuses = new Set([
      'complete',
      'completed',
      'closed',
      'cancelled',
      'received',
      'archived',
      'rejected',
    ]);

    for (const order of orders) {
      const orderId = asIdString(order.id);
      if (!orderId) continue;
      const statusSource = asString(order.statusSource);
      const status = (asString(order.canonicalStatus) ?? asString(order.status) ?? '').toLowerCase();
      const statusEvidenceJson = asPlainRecord(order.statusEvidenceJson);
      const clickupEvidence = asPlainRecord(statusEvidenceJson.clickupStatusImport);
      const clickupTaskRef = asString(clickupEvidence.taskId) ?? asString(order.authorityTaskRef);
      const hasClickupEvidence = statusSource === 'clickup_csv' && Boolean(clickupTaskRef);
      const operatorOverride = statusSource === 'operator' || Boolean(asString(order.operatorStatusOverrideAt));
      const authorityStatus = operatorOverride
        ? 'alternate_authoritative'
        : hasClickupEvidence
          ? 'clickup_authoritative'
          : alternateSources.has(statusSource ?? '')
            ? 'alternate_authoritative'
            : closedStatuses.has(status)
              ? 'intentionally_untracked'
              : 'unresolved';
      const authoritySource = operatorOverride
        ? 'operator_override'
        : hasClickupEvidence
          ? 'clickup_csv'
          : authorityStatus === 'alternate_authoritative'
            ? statusSource
            : authorityStatus === 'intentionally_untracked'
              ? 'closed_order_not_clickup_tracked'
              : 'missing_authoritative_task_or_alternate_evidence';
      counts[authorityStatus] = (counts[authorityStatus] ?? 0) + 1;
      if (authorityStatus === 'unresolved') unresolvedAuthorityOrderIds.push(orderId);
      const values = {
        authorityStatus,
        authoritySource,
        authorityTaskRef: clickupTaskRef,
        authorityAsOf:
          asString(clickupEvidence.observedAt) ??
          asString(statusEvidenceJson.importedAt) ??
          asString(order.authorityAsOf) ??
          asOf,
        authorityEvidenceJson: {
          orderRef: asString(order.externalOrderRef) ?? asString(order.orderRef),
          canonicalStatus: asString(order.canonicalStatus) ?? asString(order.status),
          statusSource,
          operatorOverride,
          clickupStatusEvidence: clickupEvidence,
        },
      };
      if (recordValuesChanged(order, values)) await orderRepo.update({ filterByTk: orderId, values });
    }
    return { authorityCounts: counts, unresolvedAuthorityOrderIds };
  }

  async importCsvFiles(params: {
    files: CsvSourceFile[];
    dryRun?: boolean;
    sourceConnectionId?: string;
    importedAt?: string;
    overrideOperatorStatus?: boolean;
    orderDetailFiles?: CsvSourceFile[];
  }): Promise<ClickupOrderStatusImportResult> {
    const dryRun = params.dryRun !== false;
    if (!dryRun && !params.sourceConnectionId) {
      throw new Error('Ecobase ClickUp order-status apply requires sourceConnectionId.');
    }
    const importedAt = params.importedAt ?? new Date().toISOString();
    const sourceConnectionId = params.sourceConnectionId ?? '00000000-0000-4000-8000-000000000000';
    const {
      rowCount,
      tasksByRef,
      selectedTasks,
      missingMainTaskRefs,
      conflictingMainTasks,
      companyConflicts,
      ambiguousMultiRefTasks,
    } = this.parseCsvFiles(params.files);
    const allTasks = [...tasksByRef.values()].flat();
    const supplierOrderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    const activityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    const initialSupplierOrders = (await silverSupplierOrderReadModel(this.db, { limit: 100000 })).supplierOrders;
    const reconciledWorkflowDraftLineCount = await this.reconcileWorkflowDraftLineMappings(dryRun);
    const initialRefs = new Set(
      initialSupplierOrders
        .map(toPlainRecord)
        .map((order) => asString(order.externalOrderRef))
        .filter((ref): ref is string => Boolean(ref)),
    );
    const workflowDrafts = await this.createWorkflowDrafts({
      selectedTasks,
      matchedRefs: initialRefs,
      orderDetailFiles: params.orderDetailFiles ?? [],
      dryRun,
      sourceConnectionId,
      observedAt: importedAt,
    });
    const supplierOrders = dryRun
      ? initialSupplierOrders
      : (await silverSupplierOrderReadModel(this.db, { limit: 100000 })).supplierOrders;
    const ordersByCompanyRef = new Map<string, PlainRecord[]>();
    for (const order of supplierOrders.map(toPlainRecord)) {
      const ref = asString(order.externalOrderRef);
      const company = canonicalCompanyName(asString(order.company));
      if (!ref || !company) continue;
      const key = `${company}:${normalizeOrderRef(ref)}`;
      ordersByCompanyRef.set(key, [...(ordersByCompanyRef.get(key) ?? []), order]);
    }

    const proposedUpdates: Array<Record<string, unknown>> = [];
    const proposedComments: Array<Record<string, unknown>> = [];
    const unmatchedRefs: string[] = [];
    const duplicateRefs = [...tasksByRef.entries()]
      .filter(([, tasks]) => tasks.length > 1)
      .map(([ref, tasks]) => ({ ref, mentionCount: tasks.length, taskIds: tasks.map((task) => task.taskId) }));
    const unmappedStatuses: Array<Record<string, unknown>> = [];
    const ambiguousOrders: Array<Record<string, unknown>> = [];
    const matchedOrderByRef = new Map<string, PlainRecord>();
    for (const [ref, tasks] of tasksByRef.entries()) {
      const company = companyForOrderRef(ref);
      const orders = company ? ordersByCompanyRef.get(`${company}:${ref}`) ?? [] : [];
      if (orders.length === 0) {
        unmatchedRefs.push(`${company ?? 'unknown'}:${ref}`);
      } else if (orders.length > 1) {
        ambiguousOrders.push({ company, ref, orderIds: orders.map((order) => asString(order.id)) });
      } else {
        matchedOrderByRef.set(ref, orders[0]);
      }
    }
    const matchedTasks = [...tasksByRef.entries()]
      .filter(([ref]) => matchedOrderByRef.has(ref))
      .flatMap(([, tasks]) => tasks);
    const selectedCommentCount = matchedTasks.reduce((count, task) => count + task.comments.length, 0);
    const invalidCommentCount = allTasks.reduce((count, task) => count + task.invalidCommentCount, 0);
    const userLinks = await this.ensureApprovedAttributionUsers(dryRun);
    const actorOccurrences = new Map<string, { sourceActor: string; occurrenceCount: number }>();
    for (const task of matchedTasks) {
      for (const comment of task.comments) {
        const sourceActor = asString(comment.actor);
        const normalizedActor = normalizeClickupActorIdentity(sourceActor);
        if (!sourceActor || !normalizedActor) continue;
        const occurrence = actorOccurrences.get(normalizedActor) ?? { sourceActor, occurrenceCount: 0 };
        occurrence.occurrenceCount += 1;
        actorOccurrences.set(normalizedActor, occurrence);
      }
    }
    const actorMappings = [...actorOccurrences.values()]
      .map(({ sourceActor, occurrenceCount }) => {
        const resolution = resolveClickupActor(sourceActor);
        const user = resolution.userKey ? approvedClickupAttributionUser(resolution.userKey) : undefined;
        return {
          sourceActor,
          occurrenceCount,
          resolution: user ? ('mapped' as const) : ('unresolved' as const),
          mappedUserKey: user?.key,
          mappedUserName: user?.displayName,
          matchMethod: resolution.matchMethod,
        };
      })
      .sort(
        (left, right) =>
          right.occurrenceCount - left.occurrenceCount || left.sourceActor.localeCompare(right.sourceActor),
      );
    const conflictingRefs = new Set(
      conflictingMainTasks
        .filter((conflict) => conflict.resolvedByOverride !== true)
        .map((conflict) => asString(conflict.ref))
        .filter((ref): ref is string => Boolean(ref)),
    );
    let updatedOrderCount = 0;
    let proposedCommentCount = 0;
    let importedCommentCount = 0;
    let updatedCommentCount = 0;
    let duplicateCommentCount = 0;
    let operatorOverrideCount = 0;
    let overriddenOperatorStatusCount = 0;

    for (const [ref, commentTasks] of tasksByRef.entries()) {
      const order = matchedOrderByRef.get(ref);
      const supplierOrderId = asString(order?.id);
      if (!order || !supplierOrderId) continue;
      const existingComments = (
        await activityRepo.find({ filter: { entityType: 'supplier_order', entityId: supplierOrderId }, limit: 10000 })
      ).map(toPlainRecord);
      for (const commentTask of commentTasks) {
        for (const comment of commentTask.comments) {
          const actorResolution = resolveClickupActor(comment.actor);
          const values = commentActivityValues({
            sourceConnectionId,
            task: commentTask,
            comment,
            order,
            supplierOrderId,
            actorUserId: actorResolution.userKey ? userLinks.userIdsByKey.get(actorResolution.userKey) : undefined,
            actorUserKey: actorResolution.userKey,
            actorMatchMethod: actorResolution.matchMethod,
          });
          if (!values) continue;
          proposedCommentCount += 1;
          if (proposedComments.length < COMMENT_PROPOSAL_LIMIT) {
            proposedComments.push(commentProposal({ task: commentTask, comment, supplierOrderId }));
          }
          const naturalKey = commentNaturalKey(values);
          const existingComment = existingComments.find((candidate) => commentNaturalKey(candidate) === naturalKey);
          const existingCommentId = existingComment?.id;
          if (existingCommentId) {
            duplicateCommentCount += 1;
            const changed = commentValuesChanged(existingComment, values);
            if (!dryRun && changed) {
              await activityRepo.update({ filterByTk: existingCommentId as string | number, values });
              updatedCommentCount += 1;
            }
          } else if (!dryRun) {
            const created = toPlainRecord(await activityRepo.create({ values: { id: randomUUID(), ...values } }));
            existingComments.push(created);
            importedCommentCount += 1;
          }
        }
      }
    }

    for (const { ref, company, task, allTasks: candidateTasks, override } of selectedTasks) {
      if (!task.mappedStatus) {
        unmappedStatuses.push({ ref, clickupStatus: task.clickupStatus, taskName: task.taskName });
      }
      const order = matchedOrderByRef.get(ref);
      const supplierOrderId = asString(order?.id);
      if (!order || !supplierOrderId) continue;
      const candidateTaskIds = candidateTasks
        .filter((candidate) => candidate.mainOrderTask)
        .map((candidate) => candidate.taskId);
      const nextEvidence = statusEvidence(task, importedAt, candidateTaskIds, override);
      const statusConflict = conflictingRefs.has(ref);
      const operatorOverride =
        asString(order.statusSource) === 'operator' || Boolean(asString(order.operatorStatusOverrideAt));
      const overrideOperatorStatus = operatorOverride && params.overrideOperatorStatus === true;
      const existingEvidence = asPlainRecord(order.statusEvidenceJson);
      const previousClickupEvidence = asPlainRecord(existingEvidence.clickupStatusImport);
      const sameClickupState =
        asString(previousClickupEvidence.taskId) === task.taskId &&
        asString(previousClickupEvidence.clickupStatus) === task.clickupStatus &&
        isDeepStrictEqual(previousClickupEvidence.candidateTaskIds ?? [], candidateTaskIds) &&
        isDeepStrictEqual(previousClickupEvidence.selectionOverride ?? null, override ?? null);
      const evidence = sameClickupState ? previousClickupEvidence : nextEvidence;
      const previousClickupStatus = asString(previousClickupEvidence.clickupStatus);
      const statusChanged = Boolean(previousClickupStatus && previousClickupStatus !== task.clickupStatus);
      const operatorOperationalStatus = asString(asPlainRecord(existingEvidence.operatorOperationalStatus).status);
      const statusDiscrepancy = Boolean(
        operatorOverride &&
          normalizeOrderOperationalStatus(
            operatorOperationalStatus ?? order.operationalStatus ?? order.lifecycleStatus,
          ) !== task.clickupStatus,
      );
      proposedUpdates.push({
        supplierOrderId,
        company,
        externalOrderRef: ref,
        previousStatus: asString(order.canonicalStatus) ?? asString(order.lifecycleStatus),
        nextStatus: task.mappedStatus,
        clickupStatus: task.clickupStatus,
        workflowStage: task.workflowStage,
        taskId: task.taskId,
        taskName: task.taskName,
        taskLink: task.taskLink,
        operatorOverride,
        overrideOperatorStatus,
        statusDiscrepancy,
        statusChanged,
        requiresReview: !task.mappedStatus || statusDiscrepancy || statusConflict,
      });
      if (operatorOverride && !overrideOperatorStatus) operatorOverrideCount += 1;
      if (overrideOperatorStatus) overriddenOperatorStatusCount += 1;
      if (dryRun) continue;
      const statusHistory = Array.isArray(existingEvidence.statusHistory) ? existingEvidence.statusHistory : [];
      const statusEvidenceJson: PlainRecord = {
        ...existingEvidence,
        clickupStatusImport: evidence,
        importedAt: sameClickupState ? existingEvidence.importedAt ?? importedAt : importedAt,
        statusHistory: statusChanged
          ? [
              ...statusHistory,
              {
                source: 'clickup_csv',
                taskId: task.taskId,
                previousStatus: previousClickupStatus,
                nextStatus: task.clickupStatus,
                observedAt: importedAt,
              },
            ]
          : statusHistory,
        clickupStatusConflict: statusConflict ? conflictingMainTasks.find((conflict) => conflict.ref === ref) : null,
        clickupStatusDiscrepancy: statusDiscrepancy
          ? {
              operatorStatus: operatorOperationalStatus ?? order.operationalStatus ?? order.lifecycleStatus,
              clickupStatus: task.clickupStatus,
              detectedAt: sameClickupState
                ? asString(asPlainRecord(existingEvidence.clickupStatusDiscrepancy).detectedAt) ?? importedAt
                : importedAt,
            }
          : null,
      };
      if (overrideOperatorStatus) delete statusEvidenceJson.operatorOperationalStatus;
      const values: PlainRecord =
        !task.mappedStatus || statusConflict
          ? {
              statusEvidenceJson,
              statusCheckRequired: true,
              taskRef: task.taskId,
              taskLink: task.taskLink,
              authorityAsOf: sameClickupState ? order.authorityAsOf ?? importedAt : importedAt,
            }
          : operatorOverride && !overrideOperatorStatus
            ? {
                statusEvidenceJson,
                statusCheckRequired: statusDiscrepancy || order.statusCheckRequired === true,
                taskRef: task.taskId,
                taskLink: task.taskLink,
                authorityAsOf: sameClickupState ? order.authorityAsOf ?? importedAt : importedAt,
              }
            : {
                canonicalStatus: task.mappedStatus,
                lifecycleStatus: task.lifecycleStatus,
                operationalStatus: task.clickupStatus,
                workflowStage: task.workflowStage,
                // T-3.0 (inventory dashboard): stamp stage entry on transition.
                ...((asString(order.workflowStage) ?? null) === (task.workflowStage ?? null)
                  ? {}
                  : { workflowStageEnteredAt: importedAt }),
                statusSource: 'clickup_csv',
                statusCheckRequired: false,
                statusEvidenceJson,
                taskRef: task.taskId,
                taskLink: task.taskLink,
                authorityAsOf: sameClickupState ? order.authorityAsOf ?? importedAt : importedAt,
                ...(overrideOperatorStatus
                  ? { operatorStatusOverrideAt: null, operatorStatusOverrideByUserId: null }
                  : {}),
              };
      // Read before the write, so "what stage was it in" survives the update below.
      const previousStage = asString(order.workflowStage);
      if (recordValuesChanged(order, values)) {
        await supplierOrderRepo.update({ filterByTk: supplierOrderId, values });
        // 054 R2: an authority-driven move into inbound monitoring stamps the entry baseline.
        await new EcobaseInboundEntryBaselineStamper(this.db).stampOrderEntry({
          orderId: supplierOrderId,
          previousStage,
          nextStage: values.workflowStage,
        });
        if (!operatorOverride || overrideOperatorStatus) updatedOrderCount += 1;
      }
    }

    const blockingIssueCount =
      ambiguousOrders.length + unmappedStatuses.length + conflictingRefs.size + companyConflicts.length;
    const authority = dryRun ? undefined : await this.reconcileAuthority(importedAt);

    return {
      dryRun,
      fileCount: params.files.length,
      rowCount,
      extractedRefCount: [...tasksByRef.values()].reduce((count, tasks) => count + tasks.length, 0),
      selectedRefCount: selectedTasks.length,
      matchedOrderCount: proposedUpdates.length,
      updatedOrderCount,
      unmatchedRefCount: unmatchedRefs.length,
      duplicateRefCount: duplicateRefs.length,
      unmappedStatusCount: unmappedStatuses.length,
      selectedCommentCount,
      proposedCommentCount,
      importedCommentCount,
      updatedCommentCount,
      duplicateCommentCount,
      invalidCommentCount,
      missingMainTaskCount: missingMainTaskRefs.length,
      conflictingMainTaskCount: conflictingMainTasks.length,
      companyConflictCount: companyConflicts.length,
      ambiguousOrderCount: ambiguousOrders.length,
      ambiguousMultiRefTaskCount: ambiguousMultiRefTasks.length,
      operatorOverrideCount,
      overriddenOperatorStatusCount,
      selectedTaskOverrideCount: selectedTasks.filter((selected) => selected.override).length,
      workflowDraftCount: workflowDrafts.workflowDraftCount,
      workflowDraftLineCount: workflowDrafts.workflowDraftLineCount,
      reconciledWorkflowDraftLineCount,
      workflowDraftRefs: workflowDrafts.workflowDraftRefs,
      workflowDraftExceptions: workflowDrafts.exceptions,
      blockingIssueCount,
      proposedUpdates,
      proposedComments,
      unmatchedRefs,
      duplicateRefs,
      unmappedStatuses,
      missingMainTaskRefs,
      conflictingMainTasks,
      companyConflicts,
      ambiguousOrders,
      ambiguousMultiRefTasks,
      authorityCounts: authority?.authorityCounts,
      unresolvedAuthorityOrderIds: authority?.unresolvedAuthorityOrderIds,
      discoveredActorCount: actorMappings.length,
      linkedActorCount: actorMappings.filter((mapping) => mapping.resolution === 'mapped').length,
      createdUserCount: userLinks.createdUserCount,
      unresolvedActors: actorMappings
        .filter((mapping) => mapping.resolution === 'unresolved')
        .map((mapping) => mapping.sourceActor),
      actorMappings,
    };
  }
}
