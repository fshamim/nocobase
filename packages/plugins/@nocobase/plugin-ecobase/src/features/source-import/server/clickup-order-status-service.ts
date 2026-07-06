/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { CsvSourceFile } from './adapters/csv-utils';
import { CsvRowReader, parseCsv } from './adapters/csv-utils';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

const ORDER_REF_PATTERN = /\b(?:SS|MX|EF|RH)\d{4,8}[A-Z]?\b/gi;
const MAIN_ORDER_PATTERN = /\b(new|restock|po|order)\b/i;
const HELPER_TASK_PATTERN = /shipping labels?|labels required|time tracking|approval/i;

const STATUS_MAP: Record<string, string> = {
  'approved-to-order': 'payment_pending',
  complete: 'completed',
  'direct-ship-fba': 'shipped_inbound',
  hold: 'blocked',
  'hold/cancelled': 'cancelled',
  'in progress': 'supplier_contacted',
  'in transit to prep': 'shipped_inbound',
  'inbound-monitoring': 'shipped_inbound',
  ordered: 'paid',
  'order analysing': 'draft',
  'prep-in-progress': 'shipped_inbound',
  'to do': 'draft',
};
const COMMENT_PROPOSAL_LIMIT = 20;
const CLICKUP_COMMENT_USER_EMAIL_BY_KEY: Record<string, string> = {
  'nauman.ecofission': 'nauman.ecofission@gmail.com',
  'nauman.ecofission@gmail.com': 'nauman.ecofission@gmail.com',
  kiranecofission: 'kiranecofission@gmail.com',
  'kiranecofission@gmail.com': 'kiranecofission@gmail.com',
  'behroz.ecofission': 'behroz.ecofission@gmail.com',
  'behroz.ecofission@gmail.com': 'behroz.ecofission@gmail.com',
  'shabi.ecofission': 'shabi.ecofission@gmail.com',
  'shabi.ecofission@gmail.com': 'shabi.ecofission@gmail.com',
  'rafay.ecofission': 'rafay.ecofission@gmail.com',
  'rafay.ecofission@gmail.com': 'rafay.ecofission@gmail.com',
  'director@eco-fission.com': 'director@eco-fission.com',
  syedatif: 'syedatif.ecofission@gmail.com',
  'syedatif.ecofission': 'syedatif.ecofission@gmail.com',
  'syedatif.ecofission@gmail.com': 'syedatif.ecofission@gmail.com',
  'hassan.mehtab95': 'director@eco-fission.com',
  'hassan.mehtab95@gmail.com': 'director@eco-fission.com',
};

type PlainRecord = Record<string, unknown>;

type ParsedClickupComment = {
  text: string;
  actor?: string;
  occurredAt: string;
  assigned?: boolean;
  resolved?: string;
  raw: PlainRecord;
};

type ParsedTask = {
  ref: string;
  clickupStatus: string;
  mappedStatus?: string;
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
  duplicateCommentCount: number;
  invalidCommentCount: number;
  proposedUpdates: Array<Record<string, unknown>>;
  proposedComments: Array<Record<string, unknown>>;
  unmatchedRefs: string[];
  duplicateRefs: Array<Record<string, unknown>>;
  unmappedStatuses: Array<Record<string, unknown>>;
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

function normalizeOrderRef(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeClickupActorKey(value: string | undefined) {
  return value?.trim().toLowerCase() || undefined;
}

export function resolveClickupCommentActorEmail(actor: string | undefined) {
  const key = normalizeClickupActorKey(actor);
  if (!key) return undefined;
  return CLICKUP_COMMENT_USER_EMAIL_BY_KEY[key] ?? (key.includes('@') ? key : undefined);
}

export function extractClickupOrderRefsFromTitle(taskName: string) {
  const refs: string[] = [];
  for (const match of taskName.matchAll(ORDER_REF_PATTERN)) {
    const ref = normalizeOrderRef(match[0]);
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function isMainOrderTask(taskName: string) {
  return MAIN_ORDER_PATTERN.test(taskName) && !HELPER_TASK_PATTERN.test(taskName);
}

function normalizeClickupStatus(status: string | undefined) {
  return status?.trim().toLowerCase();
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
    day > 31 ||
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
    const occurredAt = parseClickupCommentDate(asString(record.date));
    if (!text || !occurredAt) {
      invalidCount += 1;
      return [];
    }
    return [
      {
        text,
        actor: asString(record.by),
        occurredAt,
        assigned: typeof record.assigned === 'boolean' ? record.assigned : undefined,
        resolved: asString(record.resolved),
        raw: record,
      },
    ];
  });
  return { comments, invalidCount };
}

function selectedTaskForRef(tasks: ParsedTask[]) {
  const candidates = tasks.filter((task) => task.mainOrderTask);
  return [...(candidates.length > 0 ? candidates : tasks)].sort(
    (left, right) => timestamp(right.dateCreated) - timestamp(left.dateCreated),
  )[0];
}

function valuesForTaskSnapshot(params: { task: ParsedTask; sourceConnectionId: string; snapshotDate: string }) {
  return {
    naturalKey: [params.sourceConnectionId, 'clickup_task_snapshot', params.task.taskId, params.snapshotDate].join(':'),
    sourceConnectionId: params.sourceConnectionId,
    snapshotDate: params.snapshotDate,
    externalTaskId: params.task.taskId,
    taskName: params.task.taskName,
    status: params.task.clickupStatus,
    priority: 'normal',
    operationalArea: 'order_management',
    updatedAtSource: params.task.dateCreated ? new Date(timestamp(params.task.dateCreated)).toISOString() : undefined,
    workspaceName: 'ClickUp export',
    listName: params.task.listName,
    url: params.task.taskLink,
    payload: {
      orderRef: params.task.ref,
      dateCreatedText: params.task.dateCreatedText,
      parentId: params.task.parentId,
      lineNumber: params.task.lineNumber,
      mainOrderTask: params.task.mainOrderTask,
    },
  };
}

function statusEvidence(task: ParsedTask) {
  return {
    source: 'clickup_csv',
    extraction: 'task_name_compact_order_ref',
    orderRef: task.ref,
    clickupStatus: task.clickupStatus,
    mappedStatus: task.mappedStatus,
    taskId: task.taskId,
    taskLink: task.taskLink,
    taskName: task.taskName,
    lineNumber: task.lineNumber,
    dateCreatedText: task.dateCreatedText,
    mainOrderTask: task.mainOrderTask,
  };
}

async function upsert(repository: ReturnType<EcobaseDatabase['getRepository']>, values: PlainRecord) {
  const existing = await repository.findOne({ filter: { naturalKey: values.naturalKey } });
  if (!existing) return repository.create({ values });
  const existingId = toPlainRecord(existing).id;
  return repository.update({
    filterByTk: typeof existingId === 'string' || typeof existingId === 'number' ? existingId : undefined,
    filter: { naturalKey: values.naturalKey },
    values,
  });
}

function compactText(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function commentHash(task: ParsedTask, comment: ParsedClickupComment) {
  return createHash('sha1')
    .update([task.taskId, comment.occurredAt, comment.actor ?? '', compactText(comment.text)].join('\n'))
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
}) {
  const company = asString(params.order.company);
  const supplierId = asString(params.order.supplierId);
  if (!company || !supplierId) {
    throw new Error('Ecobase ClickUp comment import failed: matched supplier order is missing company or supplierId.');
  }
  return {
    naturalKey: [
      params.sourceConnectionId,
      'clickup_comment',
      params.task.taskId,
      params.supplierOrderId,
      params.comment.occurredAt,
      commentHash(params.task, params.comment),
    ].join(':'),
    supplierOrderId: params.supplierOrderId,
    supplierId,
    company,
    activityType: 'note',
    occurredAt: params.comment.occurredAt,
    actor: params.comment.actor,
    actorUserId: params.actorUserId,
    notes: params.comment.text,
    source: 'clickup',
    payload: {
      source: 'clickup_csv',
      orderRef: params.task.ref,
      taskId: params.task.taskId,
      taskLink: params.task.taskLink,
      taskName: params.task.taskName,
      lineNumber: params.task.lineNumber,
      comment: params.comment.raw,
    },
  };
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

export class EcobaseClickupOrderStatusService {
  constructor(private db: EcobaseDatabase) {}

  private async clickupActorUserIdsByEmail(selectedTasks: Array<{ task: ParsedTask }>) {
    const emails = [
      ...new Set(
        selectedTasks
          .flatMap(({ task }) => task.comments.map((comment) => resolveClickupCommentActorEmail(comment.actor)))
          .filter((email): email is string => Boolean(email)),
      ),
    ];
    if (emails.length === 0) return new Map<string, string>();

    let users: unknown[];
    try {
      users = await this.db.getRepository('users').find({ filter: { email: { $in: emails } }, limit: 10000 });
    } catch {
      return new Map<string, string>();
    }

    return new Map(
      users
        .map(toPlainRecord)
        .map((user) => [normalizeClickupActorKey(asString(user.email)), asIdString(user.id)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
  }

  parseCsvFiles(files: CsvSourceFile[]) {
    const tasksByRef = new Map<string, ParsedTask[]>();
    let rowCount = 0;
    for (const file of files) {
      const parsed = parseCsv(file.content);
      parsed.rows.forEach((rawRow, index) => {
        rowCount += 1;
        const row = new CsvRowReader(rawRow);
        const taskName = row.string('Task Name') ?? '';
        const clickupStatus = normalizeClickupStatus(row.string('Status'));
        if (!taskName || !clickupStatus) return;
        const parsedComments = parseClickupComments(row.string('Comments'));
        for (const ref of extractClickupOrderRefsFromTitle(taskName)) {
          const task: ParsedTask = {
            ref,
            clickupStatus,
            mappedStatus: STATUS_MAP[clickupStatus],
            taskId: row.string('Task ID') ?? `${file.name}:${index + 2}:${ref}`,
            taskLink: row.string('Task Link'),
            taskName,
            dateCreated: row.string('Date Created'),
            dateCreatedText: row.string('Date Created Text'),
            parentId: row.string('Parent ID'),
            listName: row.string('List Name'),
            lineNumber: index + 2,
            mainOrderTask: isMainOrderTask(taskName),
            comments: parsedComments.comments,
            invalidCommentCount: parsedComments.invalidCount,
          };
          tasksByRef.set(ref, [...(tasksByRef.get(ref) ?? []), task]);
        }
      });
    }

    const selectedTasks = [...tasksByRef.entries()].flatMap(([ref, tasks]) => {
      const selected = selectedTaskForRef(tasks);
      return selected ? [{ ref, task: selected, allTasks: tasks }] : [];
    });

    return { rowCount, tasksByRef, selectedTasks };
  }

  async importCsvFiles(params: {
    files: CsvSourceFile[];
    dryRun?: boolean;
    sourceConnectionId?: string;
    importedAt?: string;
    snapshotDate?: string;
  }): Promise<ClickupOrderStatusImportResult> {
    const dryRun = params.dryRun !== false;
    if (!dryRun && !params.sourceConnectionId) {
      throw new Error('Ecobase ClickUp order-status apply requires sourceConnectionId.');
    }
    const importedAt = params.importedAt ?? new Date().toISOString();
    const snapshotDate = params.snapshotDate ?? importedAt.slice(0, 10);
    const sourceConnectionId = params.sourceConnectionId ?? '00000000-0000-4000-8000-000000000000';
    const { rowCount, tasksByRef, selectedTasks } = this.parseCsvFiles(params.files);
    const supplierOrderRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders);
    const snapshotRepo = this.db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots);
    const taskLinkRepo = this.db.getRepository(ECOBASE_COLLECTIONS.taskLinks);
    const activityRepo = this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderActivities);
    const supplierOrders = await supplierOrderRepo.find({ limit: 100000 });
    const ordersByRef = new Map<string, PlainRecord[]>();
    for (const order of supplierOrders.map(toPlainRecord)) {
      const ref = asString(order.externalOrderRef);
      if (!ref) continue;
      const normalizedRef = normalizeOrderRef(ref);
      ordersByRef.set(normalizedRef, [...(ordersByRef.get(normalizedRef) ?? []), order]);
    }

    const proposedUpdates: Array<Record<string, unknown>> = [];
    const proposedComments: Array<Record<string, unknown>> = [];
    const unmatchedRefs: string[] = [];
    const duplicateRefs: Array<Record<string, unknown>> = [];
    const unmappedStatuses: Array<Record<string, unknown>> = [];
    const selectedCommentCount = selectedTasks.reduce((count, item) => count + item.task.comments.length, 0);
    const invalidCommentCount = selectedTasks.reduce((count, item) => count + item.task.invalidCommentCount, 0);
    const actorUserIdsByEmail = await this.clickupActorUserIdsByEmail(selectedTasks);
    let updatedOrderCount = 0;
    let proposedCommentCount = 0;
    let importedCommentCount = 0;
    let duplicateCommentCount = 0;

    for (const { ref, task, allTasks } of selectedTasks) {
      if (allTasks.length > 1) duplicateRefs.push({ ref, mentionCount: allTasks.length, selectedTaskId: task.taskId });
      if (!task.mappedStatus) {
        unmappedStatuses.push({ ref, clickupStatus: task.clickupStatus, taskName: task.taskName });
        continue;
      }
      const orders = ordersByRef.get(ref) ?? [];
      if (orders.length === 0) {
        unmatchedRefs.push(ref);
        continue;
      }
      for (const order of orders) {
        const supplierOrderId = asString(order.id);
        const evidence = statusEvidence(task);
        proposedUpdates.push({
          supplierOrderId,
          externalOrderRef: ref,
          previousStatus: asString(order.status),
          nextStatus: task.mappedStatus,
          clickupStatus: task.clickupStatus,
          taskId: task.taskId,
          taskName: task.taskName,
          taskLink: task.taskLink,
        });
        if (supplierOrderId) {
          for (const comment of task.comments) {
            const actorEmail = resolveClickupCommentActorEmail(comment.actor);
            const values = commentActivityValues({
              sourceConnectionId,
              task,
              comment,
              order,
              supplierOrderId,
              actorUserId: actorEmail ? actorUserIdsByEmail.get(actorEmail) : undefined,
            });
            proposedCommentCount += 1;
            if (proposedComments.length < COMMENT_PROPOSAL_LIMIT) {
              proposedComments.push(commentProposal({ task, comment, supplierOrderId }));
            }
            const existingComment = await activityRepo.findOne({ filter: { naturalKey: values.naturalKey } });
            const existingCommentId = toPlainRecord(existingComment).id;
            if (existingCommentId) {
              duplicateCommentCount += 1;
              if (!dryRun) {
                await activityRepo.update({ filterByTk: existingCommentId as string | number, values });
              }
            } else if (!dryRun) {
              await activityRepo.create({ values: { id: randomUUID(), ...values } });
              importedCommentCount += 1;
            }
          }
        }
        if (dryRun || !supplierOrderId) continue;
        await upsert(snapshotRepo, valuesForTaskSnapshot({ task, sourceConnectionId, snapshotDate }));
        await upsert(taskLinkRepo, {
          naturalKey: [sourceConnectionId, 'task_link', task.taskId, 'supplier_order', supplierOrderId].join(':'),
          sourceConnectionId,
          externalTaskId: task.taskId,
          targetType: 'supplier_order',
          supplierOrderId,
          confidence: task.mainOrderTask ? 0.95 : 0.75,
          evidence,
        });
        await supplierOrderRepo.update({
          filterByTk: supplierOrderId,
          values: {
            status: task.mappedStatus,
            statusSource: 'clickup_csv',
            statusUpdatedAt: importedAt,
            lastMeaningfulUpdateAt: importedAt,
            payload: { ...asPlainRecord(toPlainRecord(order).payload), clickupStatusImport: evidence },
          },
        });
        updatedOrderCount += 1;
      }
    }

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
      duplicateCommentCount,
      invalidCommentCount,
      proposedUpdates,
      proposedComments,
      unmatchedRefs,
      duplicateRefs,
      unmappedStatuses,
    };
  }
}
