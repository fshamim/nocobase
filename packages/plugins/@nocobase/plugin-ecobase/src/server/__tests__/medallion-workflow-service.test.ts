import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../services/import-service';
import { toPlainRecord } from '../services/import-service';
import { EcobaseMedallionWorkflowService } from '../services/medallion-workflow-service';

class FakeRepository implements EcobaseRepository {
  rows: Record<string, unknown>[] = [];

  async find(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.filter((row) => matches(row, params));
  }

  async findOne(params?: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    return this.rows.find((row) => matches(row, params)) ?? null;
  }

  async create(params: { values: Record<string, unknown> }) {
    this.rows.push({ ...params.values });
    return this.rows[this.rows.length - 1];
  }

  async update(params: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const matched = this.rows.filter((row) => matches(row, params));
    matched.forEach((row) => Object.assign(row, params.values));
    return matched[0] ?? null;
  }
}

class FakeDatabase implements EcobaseDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

function matches(
  row: Record<string, unknown>,
  params?: { filter?: Record<string, unknown>; filterByTk?: string | number },
) {
  if (params?.filterByTk !== undefined && row.id !== params.filterByTk) return false;
  return Object.entries(params?.filter ?? {}).every(([key, value]) => row[key] === value);
}

function idOf(record: unknown) {
  const id = toPlainRecord(record).id;
  if (typeof id !== 'string') throw new Error('Expected fake record to have a string id.');
  return id;
}

async function seedOrder(db: FakeDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
    values: {
      id: 'order-1',
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderRef: 'SAM062226A',
      orderDate: '2026-06-22',
      dailySequenceLetter: 'A',
      lifecycleStatus: 'draft',
    },
  });
}

async function seedSupplier(db: FakeDatabase) {
  await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
    values: {
      id: 'supplier-1',
      normalizedName: 'alpha supply',
      displayName: 'Alpha Supply',
      approvalStatus: 'approved',
    },
  });
}

describe('EcobaseMedallionWorkflowService', () => {
  it('creates a comment and pending human approval for detected workflow actions', async () => {
    const db = new FakeDatabase();
    await seedOrder(db);
    const service = new EcobaseMedallionWorkflowService(db);

    const result = await service.createActivityComment({
      entityType: 'order',
      entityId: 'order-1',
      actorType: 'operator',
      actorUserId: 'user-1',
      commentType: 'status_update',
      body: 'Supplier confirmed the order.',
      followUpAt: '2026-06-23T10:00:00.000Z',
      contextSnapshotJson: { orderRef: 'SAM062226A' },
      workflowAction: {
        title: 'Mark order confirmed',
        actionType: 'update_order_status',
        actionPayloadJson: { orderId: 'order-1', lifecycleStatus: 'confirmed' },
        contextSummary: 'Supplier confirmed by phone.',
      },
    });

    expect(toPlainRecord(result.comment)).toMatchObject({
      workflowDetectionStatus: 'pending',
      followUpAt: '2026-06-23T10:00:00.000Z',
    });
    expect(toPlainRecord(result.approval)).toMatchObject({ actionType: 'update_order_status', status: 'pending' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverHumanApprovalLinks).rows[0]).toMatchObject({
      entityType: 'order',
      entityId: 'order-1',
      relation: 'primary',
    });
  });

  it('executes approved actions through named deterministic handlers', async () => {
    const db = new FakeDatabase();
    await seedOrder(db);
    const service = new EcobaseMedallionWorkflowService(db);
    const approval = await service.proposeAction({
      title: 'Mark order paid',
      actionType: 'update_order_status',
      actionPayloadJson: { orderId: 'order-1', lifecycleStatus: 'paid', nextAction: 'ship_to_fba' },
      proposedByType: 'operator',
    });

    const executed = await service.approveAndExecute(idOf(approval), 'reviewer-1');

    expect(toPlainRecord(executed)).toMatchObject({ status: 'executed', approvedByUserId: 'reviewer-1' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0]).toMatchObject({
      lifecycleStatus: 'paid',
      nextAction: 'ship_to_fba',
    });
  });

  it('rejects approvals while preserving context evidence', async () => {
    const db = new FakeDatabase();
    const service = new EcobaseMedallionWorkflowService(db);
    const approval = await service.proposeAction({
      title: 'Create supplier task',
      actionType: 'create_task',
      actionPayloadJson: { title: 'Call supplier' },
      proposedByType: 'ai_employee',
      proposedById: '11111111-1111-1111-1111-111111111111',
      contextSummary: 'AI detected missed follow-up.',
      evidenceJson: { source: 'comment-1' },
      riskSummary: 'Could miss restock date.',
    });

    const rejected = await service.rejectApproval(idOf(approval), 'Already handled manually.');

    expect(toPlainRecord(rejected)).toMatchObject({
      status: 'rejected',
      contextSummary: 'AI detected missed follow-up.',
      evidenceJson: { source: 'comment-1' },
      rejectedReason: 'Already handled manually.',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTasks).rows).toHaveLength(0);
  });

  it('auto-executes only when action policy explicitly allows it', async () => {
    const db = new FakeDatabase();
    await seedSupplier(db);
    const service = new EcobaseMedallionWorkflowService(db);

    const pending = await service.proposeAction({
      title: 'Follow up supplier',
      actionType: 'update_supplier_follow_up',
      actionPayloadJson: { supplierId: 'supplier-1', nextFollowUpAt: '2026-06-24T09:00:00.000Z' },
      proposedByType: 'workflow',
    });
    await service.setActionPolicy({
      actionType: 'update_supplier_follow_up',
      requiresHumanApproval: false,
      autoExecutable: true,
    });
    const executed = await service.proposeAction({
      title: 'Follow up supplier now',
      actionType: 'update_supplier_follow_up',
      actionPayloadJson: { supplierId: 'supplier-1', lastContactedAt: '2026-06-22T09:00:00.000Z' },
      proposedByType: 'workflow',
    });

    expect(toPlainRecord(pending).status).toBe('pending');
    expect(toPlainRecord(executed).status).toBe('executed');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).rows[0]).toMatchObject({
      lastContactedAt: '2026-06-22T09:00:00.000Z',
    });
  });

  it('creates tasks from comments and links them to entities', async () => {
    const db = new FakeDatabase();
    await seedOrder(db);
    const service = new EcobaseMedallionWorkflowService(db);
    const { comment } = await service.createActivityComment({
      entityType: 'order',
      entityId: 'order-1',
      actorType: 'operator',
      commentType: 'note',
      body: 'Need invoice check.',
    });

    const task = await service.createTask({
      title: 'Check invoice',
      sourceCommentId: idOf(comment),
      links: [{ entityType: 'order', entityId: 'order-1', relation: 'primary' }],
    });
    const subtask = await service.createTask({ title: 'Ask supplier for invoice PDF', parentTaskId: idOf(task) });

    expect(toPlainRecord(subtask).parentTaskId).toBe(idOf(task));
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTaskLinks).rows[0]).toMatchObject({
      taskId: idOf(task),
      entityType: 'order',
      relation: 'primary',
    });
  });
});
