import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from './import-service';
import { toPlainRecord } from './import-service';

const ENTITY_TYPES = new Set(['supplier', 'order', 'product', 'company_product', 'invoice', 'task', 'target']);
const ACTOR_TYPES = new Set(['operator', 'ai_employee', 'system', 'workflow']);
const COMMENT_TYPES = new Set([
  'note',
  'status_update',
  'follow_up',
  'supplier_contact',
  'prep_contact',
  'ai_instruction',
  'system_audit',
]);
const APPROVAL_STATUSES = new Set(['pending', 'approved']);

type ProposedByType = 'ai_employee' | 'workflow' | 'operator';
type LinkRelation = 'primary' | 'related' | 'evidence' | 'affected';

export interface EntityLinkParams {
  entityType: string;
  entityId: string;
  relation?: LinkRelation;
}

export interface WorkflowActionParams {
  title: string;
  actionType: string;
  actionPayloadJson?: Record<string, unknown>;
  proposedByType?: ProposedByType;
  proposedById?: string;
  assignedReviewerId?: string;
  priority?: string;
  dueAt?: string;
  contextSummary?: string;
  evidenceJson?: Record<string, unknown>;
  riskSummary?: string;
  links?: EntityLinkParams[];
}

export interface CreateActivityCommentParams {
  entityType: string;
  entityId: string;
  actorType: string;
  actorUserId?: string;
  actorAiEmployeeId?: string;
  commentType: string;
  body: string;
  followUpAt?: string;
  contextSnapshotJson?: Record<string, unknown>;
  workflowAction?: WorkflowActionParams;
}

export interface CreateTaskParams {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  dueAt?: string;
  assignedToUserId?: string;
  assignedToAiEmployeeId?: string;
  parentTaskId?: string;
  sourceCommentId?: string;
  links?: EntityLinkParams[];
}

export interface SetActionPolicyParams {
  actionType: string;
  requiresHumanApproval?: boolean;
  autoExecutable?: boolean;
}

export class EcobaseMedallionWorkflowService {
  constructor(private db: EcobaseDatabase) {}

  async createActivityComment(params: CreateActivityCommentParams) {
    assertKnown(ENTITY_TYPES, params.entityType, 'entityType');
    assertKnown(ACTOR_TYPES, params.actorType, 'actorType');
    assertKnown(COMMENT_TYPES, params.commentType, 'commentType');
    const comment = await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: cleanValues({
        id: randomUUID(),
        entityType: params.entityType,
        entityId: requiredText(params.entityId, 'entityId'),
        actorType: params.actorType,
        actorUserId: params.actorUserId,
        actorAiEmployeeId: params.actorAiEmployeeId,
        commentType: params.commentType,
        body: requiredText(params.body, 'body'),
        followUpAt: params.followUpAt,
        contextSnapshotJson: params.contextSnapshotJson,
        workflowDetectionStatus: params.workflowAction ? 'pending' : 'none',
      }),
    });

    if (!params.workflowAction) return { comment };

    const approval = await this.proposeAction({
      ...params.workflowAction,
      proposedByType: params.workflowAction.proposedByType ?? 'workflow',
      links: [
        { entityType: params.entityType, entityId: params.entityId, relation: 'primary' },
        ...(params.workflowAction.links ?? []),
      ],
    });
    await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).update({
      filterByTk: idOf(comment),
      values: { workflowDetectionStatus: approval.status === 'executed' ? 'triggered' : 'pending' },
    });
    return {
      comment: await this.requireRecord(ECOBASE_COLLECTIONS.silverActivityComments, idOf(comment), 'comment'),
      approval,
    };
  }

  async createTask(params: CreateTaskParams) {
    if (params.parentTaskId)
      await this.requireRecord(ECOBASE_COLLECTIONS.silverTasks, params.parentTaskId, 'parent task');
    if (params.sourceCommentId) {
      await this.requireRecord(ECOBASE_COLLECTIONS.silverActivityComments, params.sourceCommentId, 'source comment');
    }
    const task = await this.repo(ECOBASE_COLLECTIONS.silverTasks).create({
      values: cleanValues({
        id: randomUUID(),
        parentTaskId: params.parentTaskId,
        sourceCommentId: params.sourceCommentId,
        title: requiredText(params.title, 'title'),
        description: params.description,
        status: params.status ?? 'open',
        priority: params.priority ?? 'normal',
        dueAt: params.dueAt,
        assignedToUserId: params.assignedToUserId,
        assignedToAiEmployeeId: params.assignedToAiEmployeeId,
      }),
    });
    for (const link of params.links ?? []) {
      await this.createTaskLink(idOf(task), link);
    }
    return task;
  }

  async proposeAction(params: WorkflowActionParams) {
    const actionType = requiredText(params.actionType, 'actionType');
    const policy = await this.policyFor(actionType);
    const approval = await this.createApproval(params, policy.autoExecutable ? 'approved' : 'pending');
    if (policy.autoExecutable) return this.executeApproval(idOf(approval), 'system');
    return approval;
  }

  async rejectApproval(approvalId: string, rejectedReason: string) {
    const approval = await this.requireRecord(ECOBASE_COLLECTIONS.silverHumanApprovals, approvalId, 'human approval');
    if (toPlainRecord(approval).status !== 'pending') {
      throw new Error('Ecobase medallion workflow failed: only pending approvals can be rejected.');
    }
    await this.repo(ECOBASE_COLLECTIONS.silverHumanApprovals).update({
      filterByTk: approvalId,
      values: { status: 'rejected', rejectedReason: requiredText(rejectedReason, 'rejectedReason') },
    });
    return this.requireRecord(ECOBASE_COLLECTIONS.silverHumanApprovals, approvalId, 'human approval');
  }

  async approveAndExecute(approvalId: string, approvedByUserId: string) {
    const approval = await this.requireRecord(ECOBASE_COLLECTIONS.silverHumanApprovals, approvalId, 'human approval');
    if (!APPROVAL_STATUSES.has(String(toPlainRecord(approval).status))) {
      throw new Error('Ecobase medallion workflow failed: only pending or approved approvals can execute.');
    }
    await this.repo(ECOBASE_COLLECTIONS.silverHumanApprovals).update({
      filterByTk: approvalId,
      values: {
        status: 'approved',
        approvedByUserId: requiredText(approvedByUserId, 'approvedByUserId'),
        approvedAt: now(),
      },
    });
    return this.executeApproval(approvalId, approvedByUserId);
  }

  async setActionPolicy(params: SetActionPolicyParams) {
    const actionType = requiredText(params.actionType, 'actionType');
    const repo = this.repo(ECOBASE_COLLECTIONS.silverWorkflowActionPolicies);
    const existing = await repo.findOne({ filter: { actionType } });
    const values = {
      actionType,
      requiresHumanApproval: params.requiresHumanApproval ?? true,
      autoExecutable: params.autoExecutable ?? false,
    };
    if (existing) {
      await repo.update({ filterByTk: idOf(existing), values });
      return this.requireRecord(ECOBASE_COLLECTIONS.silverWorkflowActionPolicies, idOf(existing), 'workflow policy');
    }
    return repo.create({ values: { id: randomUUID(), ...values } });
  }

  private async createApproval(params: WorkflowActionParams, status: 'pending' | 'approved') {
    const approval = await this.repo(ECOBASE_COLLECTIONS.silverHumanApprovals).create({
      values: cleanValues({
        id: randomUUID(),
        title: requiredText(params.title, 'title'),
        actionType: requiredText(params.actionType, 'actionType'),
        actionPayloadJson: params.actionPayloadJson ?? {},
        proposedByType: params.proposedByType ?? 'operator',
        proposedById: params.proposedById,
        assignedReviewerId: params.assignedReviewerId,
        status,
        priority: params.priority ?? 'normal',
        dueAt: params.dueAt,
        contextSummary: params.contextSummary,
        evidenceJson: params.evidenceJson,
        riskSummary: params.riskSummary,
      }),
    });
    for (const link of params.links ?? []) {
      await this.createApprovalLink(idOf(approval), link);
    }
    return approval;
  }

  private async createTaskLink(taskId: string, link: EntityLinkParams) {
    assertKnown(ENTITY_TYPES, link.entityType, 'entityType');
    return this.repo(ECOBASE_COLLECTIONS.silverTaskLinks).create({
      values: {
        id: randomUUID(),
        taskId,
        entityType: link.entityType,
        entityId: requiredText(link.entityId, 'entityId'),
        relation: link.relation ?? 'related',
      },
    });
  }

  private async createApprovalLink(humanApprovalId: string, link: EntityLinkParams) {
    assertKnown(ENTITY_TYPES, link.entityType, 'entityType');
    return this.repo(ECOBASE_COLLECTIONS.silverHumanApprovalLinks).create({
      values: {
        id: randomUUID(),
        humanApprovalId,
        entityType: link.entityType,
        entityId: requiredText(link.entityId, 'entityId'),
        relation: link.relation ?? 'evidence',
      },
    });
  }

  private async policyFor(actionType: string) {
    const policy = await this.repo(ECOBASE_COLLECTIONS.silverWorkflowActionPolicies).findOne({
      filter: { actionType },
    });
    if (!policy) return { requiresHumanApproval: true, autoExecutable: false };
    const record = toPlainRecord(policy);
    return {
      requiresHumanApproval: record.requiresHumanApproval !== false,
      autoExecutable: record.autoExecutable === true,
    };
  }

  private async executeApproval(approvalId: string, actorId: string) {
    const approval = await this.requireRecord(ECOBASE_COLLECTIONS.silverHumanApprovals, approvalId, 'human approval');
    const actionType = requiredText(String(toPlainRecord(approval).actionType ?? ''), 'actionType');
    const payload = toPlainRecord(toPlainRecord(approval).actionPayloadJson);
    const result = await this.executeNamedAction(actionType, payload, actorId);
    await this.repo(ECOBASE_COLLECTIONS.silverHumanApprovals).update({
      filterByTk: approvalId,
      values: { status: 'executed', executedAt: now(), executionResultJson: result },
    });
    return this.requireRecord(ECOBASE_COLLECTIONS.silverHumanApprovals, approvalId, 'human approval');
  }

  private async executeNamedAction(actionType: string, payload: Record<string, unknown>, actorId: string) {
    if (actionType === 'update_order_status') return this.updateOrderStatus(payload, actorId);
    if (actionType === 'create_task') return this.createTaskFromAction(payload);
    if (actionType === 'update_supplier_follow_up') return this.updateSupplierFollowUp(payload, actorId);
    throw new Error(`Ecobase medallion workflow failed: unsupported actionType ${actionType}.`);
  }

  private async updateOrderStatus(payload: Record<string, unknown>, actorId: string) {
    const orderId = requiredText(textValue(payload.orderId), 'orderId');
    await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, orderId, 'order');
    const values = cleanValues({
      lifecycleStatus: textValue(payload.lifecycleStatus),
      lifecyclePhase: textValue(payload.lifecyclePhase),
      nextAction: textValue(payload.nextAction),
      remarks: textValue(payload.remarks),
    });
    if (Object.keys(values).length === 0) {
      throw new Error('Ecobase medallion workflow failed: update_order_status requires a status field to update.');
    }
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
    return { actionType: 'update_order_status', orderId, updatedBy: actorId, values };
  }

  private async createTaskFromAction(payload: Record<string, unknown>) {
    const task = await this.createTask({
      title: requiredText(textValue(payload.title), 'title'),
      description: textValue(payload.description),
      priority: textValue(payload.priority),
      dueAt: textValue(payload.dueAt),
      sourceCommentId: textValue(payload.sourceCommentId),
      links: linkArray(payload.links),
    });
    return { actionType: 'create_task', taskId: idOf(task) };
  }

  private async updateSupplierFollowUp(payload: Record<string, unknown>, actorId: string) {
    const supplierId = requiredText(textValue(payload.supplierId), 'supplierId');
    await this.requireRecord(ECOBASE_COLLECTIONS.silverSuppliers, supplierId, 'supplier');
    const values = cleanValues({
      nextFollowUpAt: textValue(payload.nextFollowUpAt),
      lastContactedAt: textValue(payload.lastContactedAt),
    });
    if (Object.keys(values).length === 0) {
      throw new Error('Ecobase medallion workflow failed: update_supplier_follow_up requires a follow-up field.');
    }
    await this.repo(ECOBASE_COLLECTIONS.silverSuppliers).update({ filterByTk: supplierId, values });
    return { actionType: 'update_supplier_follow_up', supplierId, updatedBy: actorId, values };
  }

  private async requireRecord(collectionName: string, id: string | undefined, label: string) {
    const record = id ? await this.repo(collectionName).findOne({ filterByTk: id }) : null;
    if (!record) throw new Error(`Ecobase medallion workflow failed: ${label} ${id ?? 'id'} does not exist.`);
    return record;
  }

  private repo(name: string): EcobaseRepository {
    return this.db.getRepository(name);
  }
}

function assertKnown(allowed: Set<string>, value: string | undefined, fieldName: string) {
  const text = requiredText(value, fieldName);
  if (!allowed.has(text)) throw new Error(`Ecobase medallion workflow failed: unsupported ${fieldName} ${text}.`);
}

function requiredText(value: string | undefined, fieldName: string) {
  const text = value?.trim();
  if (!text) throw new Error(`Ecobase medallion workflow failed: ${fieldName} is required.`);
  return text;
}

function idOf(record: unknown) {
  const id = textValue(toPlainRecord(record).id);
  if (!id) throw new Error('Ecobase medallion workflow failed: record id is missing.');
  return id;
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function linkArray(value: unknown): EntityLinkParams[] | undefined {
  return Array.isArray(value) ? value.map((item) => toPlainRecord(item) as unknown as EntityLinkParams) : undefined;
}

function now() {
  return new Date().toISOString();
}
