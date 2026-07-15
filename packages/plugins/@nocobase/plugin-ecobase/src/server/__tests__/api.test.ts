/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createSourceAdapterRegistry,
  googleSheetsMigrationCsvAdapter,
  noopTestAdapter,
} from '../../features/source-import/server/adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseAiTools } from '../ecobase-ai-tools';
import {
  createEcobaseAiActions,
  createEcobaseAlertActions,
  createEcobaseImportActions,
  createEcobaseInventoryPlanningActions,
  createEcobaseMedallionWorkflowActions,
  createEcobaseSilverDataActions,
  createEcobaseSupplierManagementActions,
  createEcobaseSupplierOrderActions,
} from '../plugin';
import { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { EcobaseSourceConnectionService } from '../../features/source-import/server/source-connection-service';
import {
  canonicalOrderStatusForClickupStatus,
  EcobaseClickupOrderStatusService,
  extractClickupOrderRefsFromTitle,
  parseClickupOrderStatusFiles,
} from '../../features/source-import/server/clickup-order-status-service';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    const filtered = this.filterRecords(params);
    return this.sortRecords(filtered, params.sort).slice(0, params.limit ?? filtered.length);
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    const record = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(record);
    return record;
  }

  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error(`MemoryRepository update failed: matching record was not found.`);
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  async destroy({ filter, filterByTk }: { filter?: Record<string, unknown>; filterByTk?: string | number }) {
    const records = this.filterRecords({ filter, filterByTk });
    this.records = this.records.filter((record) => !records.includes(record));
    return records.length;
  }

  all() {
    return this.records;
  }

  private filterRecords(params: FindParams) {
    if (params.filterByTk) {
      return this.records.filter((record) => record.id === params.filterByTk);
    }
    const filter = params.filter ?? {};
    return this.records.filter((record) =>
      Object.entries(filter).every(([key, expected]) => {
        if (typeof expected === 'object' && expected !== null) {
          if (Array.isArray((expected as { $in?: unknown[] }).$in)) {
            return (expected as { $in: unknown[] }).$in.includes(record[key]);
          }
          if (typeof (expected as { $lt?: unknown }).$lt === 'string') {
            return String(record[key] ?? '') < (expected as { $lt: string }).$lt;
          }
        }
        return record[key] === expected;
      }),
    );
  }

  private sortRecords(records: Record<string, unknown>[], sort: string[] = []) {
    const [firstSort] = sort;
    if (!firstSort) {
      return records;
    }
    const descending = firstSort.startsWith('-');
    const key = descending ? firstSort.slice(1) : firstSort;
    return [...records].sort((left, right) => {
      const leftValue = String(left[key] ?? '');
      const rightValue = String(right[key] ?? '');
      if (leftValue === rightValue) {
        return 0;
      }
      const result = leftValue > rightValue ? 1 : -1;
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor() {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository()));
    this.repositories.set('users', new MemoryRepository());
    this.repositories.set('rolesUsers', new MemoryRepository());
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) {
      throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    }
    return repository;
  }
}

function createActionContext(
  db: EcobaseDatabase,
  values: Record<string, unknown> = {},
  currentUser?: Record<string, unknown>,
  currentRoles?: string[],
) {
  return {
    action: { params: { values } },
    db,
    state: { ...(currentUser ? { currentUser } : {}), ...(currentRoles ? { currentRoles } : {}) },
    body: undefined,
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

describe('Ecobase AI public API seam', () => {
  it('answers ephemerally without creating an aiAnswers audit row', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseAiActions();
    const context = createActionContext(db, {
      question: 'Which supplier should I contact first?',
      company: 'Ecofission LLC',
    });

    await actions.askEphemeral(context, vi.fn());

    expect(context.body?.data).toMatchObject({
      question: 'Which supplier should I contact first?',
      company: 'Ecofission LLC',
      provider: 'ecobase-plugin-retrieval',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).all()).toHaveLength(0);
  });

  it('registers read-only Ecobase AI employee tools with stable names', async () => {
    const db = new MemoryDatabase();
    const tools = createEcobaseAiTools();
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      'ecobase_source_status',
      'ecobase_daily_operations_brief',
      'ecobase_product_context',
      'ecobase_performance_trends',
      'ecobase_buybox_trends',
      'ecobase_okr_status',
      'ecobase_inventory_digest',
      'ecobase_optimize_budget',
      'ecobase_supplier_orders',
      'ecobase_retrieve_facts',
      'ecobase_answer_ephemeral',
    ]);
    expect(
      tools.every(
        (tool) => tool.scope === 'CUSTOM' && tool.defaultPermission === 'ALLOW' && tool.execution === 'backend',
      ),
    ).toBe(true);

    const answerTool = tools.find((tool) => tool.definition.name === 'ecobase_answer_ephemeral');
    if (!answerTool) {
      throw new Error('Expected ecobase_answer_ephemeral tool to be registered.');
    }
    const result = await answerTool.invoke(
      { db } as any,
      { question: 'What is stale?', company: 'Ecofission LLC' },
      'tool-call-1',
    );
    expect(result.status).toBe('success');
    expect(db.getRepository(ECOBASE_COLLECTIONS.aiAnswers).all()).toHaveLength(0);
  });

  it('answers inventory questions from silver/gold medallion tables only', async () => {
    const oldBusinessTables = new Set([
      ECOBASE_COLLECTIONS.planningCalculationSnapshots,
      ECOBASE_COLLECTIONS.alerts,
      ECOBASE_COLLECTIONS.supplierLeadTimes,
      ECOBASE_COLLECTIONS.supplierProductLinks,
      ECOBASE_COLLECTIONS.listingDailyFacts,
      ECOBASE_COLLECTIONS.inventorySnapshots,
    ]);
    class GuardedDatabase extends MemoryDatabase {
      getRepository(name: string) {
        if (oldBusinessTables.has(name)) {
          throw new Error(`Old table access is forbidden for Eco AI tools: ${name}`);
        }
        return super.getRepository(name);
      }
    }
    const db = new GuardedDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'gold-row-1',
        calculationDate: '2026-06-24',
        company: 'Ecofission LLC',
        asin: 'B001',
        sku: 'SKU-1',
        actionStatus: 'order_soon',
        estimatedProfitRisk: 1000,
        supplierName: 'Acme',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: { id: 'order-1', company: 'Ecofission LLC', orderRef: 'EF1', lifecycleStatus: 'approval_pending' },
    });

    const tools = createEcobaseAiTools();
    const digestTool = tools.find((tool) => tool.definition.name === 'ecobase_inventory_digest');
    const answerTool = tools.find((tool) => tool.definition.name === 'ecobase_answer_ephemeral');
    if (!digestTool || !answerTool) {
      throw new Error('Expected Ecobase medallion AI tools to be registered.');
    }

    const digest = await digestTool.invoke(
      { db } as any,
      { company: 'Ecofission LLC', calculationDate: '2026-06-24' },
      'tool-call-1',
    );
    const answer = await answerTool.invoke(
      { db } as any,
      { question: 'What are the current inventory planning next actions?', company: 'Ecofission LLC' },
      'tool-call-2',
    );

    expect(digest.status).toBe('success');
    expect(digest.content).toContain('silver-gold-medallion');
    expect(digest.content).toContain('"oldTablesUsed":false');
    expect(answer.status).toBe('success');
    expect(answer.content).toContain('Evidence source: silver/gold medallion tables only.');
  });
});

describe('Ecobase inventory-planning public API seam', () => {
  it('rejects budget optimization without a positive budget', async () => {
    const actions = createEcobaseInventoryPlanningActions();
    await expect(
      actions.optimizeBudget(createActionContext(new MemoryDatabase(), { budget: 0 }), vi.fn()),
    ).rejects.toThrow('Ecobase budget optimizer requires a budget greater than zero.');
  });

  it('exposes the read-only Silver integrity verifier as an independent maintenance action', async () => {
    const context = createActionContext(new MemoryDatabase(), {});
    const next = vi.fn();

    await createEcobaseInventoryPlanningActions().verifySilverIntegrity(context, next);

    expect(context.body).toMatchObject({
      data: {
        ok: false,
        counts: { technical_blocker: expect.any(Number) },
        examined: { companies: 0, companyProducts: 0, families: 0, orderLines: 0 },
      },
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('requires complete, reasoned, operator-authenticated family overrides', async () => {
    const actions = createEcobaseInventoryPlanningActions();
    await expect(
      actions.setFamilyTarget(createActionContext(new MemoryDatabase(), { familyId: 'family-1' }), vi.fn()),
    ).rejects.toThrow('Ecobase family target selection requires familyId, companyProductId, and reason.');
    await expect(
      actions.setFamilyPreferredSupplier(
        createActionContext(
          new MemoryDatabase(),
          { familyId: 'family-1', supplierId: 'supplier-1', reason: 'Approved supplier.' },
          { id: 1 },
          ['viewer'],
        ),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase family overrides require an operator or administrator role.');
  });

  it('restricts product planning overrides to authenticated operator/admin roles', async () => {
    const actions = createEcobaseInventoryPlanningActions();
    const values = {
      companyProductId: 'company-product-1',
      planningExcluded: true,
      reason: 'Operator approved exclusion.',
    };
    await expect(
      actions.updateProductPlanningFields(
        createActionContext(new MemoryDatabase(), values, { id: 1 }, ['viewer']),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase product planning overrides require an operator or administrator role.');
    await expect(
      actions.updateProductPlanningFields(
        createActionContext(new MemoryDatabase(), values, { id: 1 }, ['operator']),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase product planning update failed: company product "company-product-1" was not found.');
  });

  it('restricts receipt overrides to authenticated operator/admin roles', async () => {
    const actions = createEcobaseInventoryPlanningActions();
    const values = { lineId: 'line-1', status: 'review_required', reason: 'Manual evidence review.' };
    await expect(
      actions.setReceiptOverride(createActionContext(new MemoryDatabase(), values, { id: 1 }, ['viewer']), vi.fn()),
    ).rejects.toThrow('require an operator or administrator role');
    await expect(
      actions.setReceiptOverride(createActionContext(new MemoryDatabase(), values, { id: 1 }, ['admin']), vi.fn()),
    ).rejects.toThrow('could not find Silver order line line-1');
    const preview = createActionContext(new MemoryDatabase(), { dryRun: true }, { id: 1 }, ['admin']);
    await actions.backfillReceipts(preview, vi.fn());
    expect(preview.body).toMatchObject({ data: { dryRun: true, totalCandidates: 0, complete: true } });
  });

  it('returns a compact command-center payload with paginated pane rows and drawer data', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseInventoryPlanningActions();
    const goldRows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
    const baseRow = {
      company: 'ACME',
      calculationDate: '2026-07-05',
      lastRefreshedAt: '2026-07-05T08:00:00.000Z',
      targetCoverDays: 45,
      tier: 'A',
      tierScore: 250,
      recentUnits30: 10,
      tierEligibilityReason: 'eligible_recent_demand',
      tierRuleVersion: 'rolling_30d_min_4_v1',
      previousTier: 'B',
      tierMovement: 'up',
      profitPerUnit: 25,
      recommendedBestQty: 10,
      currentTier: 'A',
      currentTierScore: 250,
      averageTier: 'B',
      averageTierScore: 175,
      bestTier: 'A',
      bestTierScore: 300,
      salesVelocity: 5,
      currentPlanningStock: 10,
      sellableStock: 4,
      reservedStock: 2,
      pipelineStock: 4,
      inboundStock: 1,
      orderedStock: 2,
      prepStock: 1,
      sixMonthAverageQty: 22,
      suggestedReorderQty: 215,
      estimatedProfitRisk: 100,
      leadTimeFreshness: 'fresh',
      daysOfCover: 2,
      latestSafeReorderDate: '2026-07-03',
      daysUntilSafeReorder: -2,
      supplierName: 'Supplier A',
      supplierAvailability: 'resolved_silver_link',
      openOrderCoverageQty: 0,
      stuck: false,
    };
    await goldRows.create({
      values: {
        ...baseRow,
        id: 'gold-1',
        naturalKey: '2026-07-05:ACME:B001:SKU-1',
        asin: 'B001',
        sku: 'SKU-1',
        title: 'Order now product',
        actionStatus: 'order_today',
        estimatedOosDate: '2026-07-08',
        daysUntilOos: 3,
        supplierOrderState: 'no_open_order',
        commandCenterPane: 'supplyAction',
      },
    });
    await goldRows.create({
      values: {
        ...baseRow,
        id: 'gold-2',
        naturalKey: '2026-07-05:ACME:B002:SKU-2',
        asin: 'B002',
        sku: 'SKU-2',
        title: 'Pipeline risk product',
        actionStatus: 'overdue',
        estimatedProfitRisk: 500,
        estimatedOosDate: '2026-07-07',
        daysUntilOos: 2,
        expectedArrivalDate: '2026-07-10',
        expectedArrivalStatus: 'imported',
        pipelineHealthStatus: 'late',
        stockoutGapDays: 3,
        supplierOrderState: 'purchased_pipeline',
        supplierOrderId: 'supplier-order-po-2',
        commandCenterPane: 'activeOrders',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PO-2',
        companyProductId: 'company-product-2',
        planningProductId: 'company-product-2',
        supplierId: 'supplier-2',
        latestSupplierOrderActivityAt: '2026-07-01T10:00:00.000Z',
        latestSupplierOrderActivityNote: 'Paid confirmed',
        latestSupplierOrderActivitySource: 'operator',
        recommendedEscalation: 'follow_up_order',
      },
    });
    await goldRows.create({
      values: {
        ...baseRow,
        id: 'gold-3',
        naturalKey: '2026-07-05:ACME:B003:SKU-3',
        asin: 'B003',
        sku: 'SKU-3',
        title: 'Stuck product',
        tier: null,
        actionStatus: 'watch',
        estimatedProfitRisk: 0,
        daysOfCover: 90,
        supplierOrderState: 'closed_history',
        stuck: true,
        stuckClassification: 'over_60_doc',
        commandCenterPane: 'stuckInventory',
      },
    });
    await goldRows.create({
      values: {
        ...baseRow,
        id: 'gold-4',
        naturalKey: '2026-07-05:ACME:B004:SKU-4',
        asin: 'B004',
        sku: 'SKU-4',
        title: 'Untiered active order product',
        tier: null,
        actionStatus: 'overdue',
        estimatedProfitRisk: null,
        moneyRiskStatus: 'unknown_arrival',
        estimatedOosDate: '2026-07-06',
        daysUntilOos: 1,
        expectedArrivalDate: null,
        expectedArrivalStatus: 'unknown',
        pipelineHealthStatus: 'unknown_timing',
        supplierOrderState: 'purchased_pipeline',
        commandCenterPane: 'activeOrders',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PO-4',
        stuck: false,
      },
    });
    await goldRows.create({
      values: {
        ...baseRow,
        id: 'gold-5',
        naturalKey: '2026-07-05:ACME:B005:SKU-5',
        asin: 'B005',
        sku: 'SKU-5',
        title: 'No active order stuck product',
        tier: 'C',
        actionStatus: 'stale_lead_time',
        estimatedProfitRisk: 0,
        daysOfCover: 75,
        supplierOrderState: 'closed_history',
        stuck: true,
        stuckClassification: 'over_60_doc',
        commandCenterPane: 'stuckInventory',
      },
    });
    await goldRows.create({
      values: {
        ...baseRow,
        id: 'gold-6',
        naturalKey: '2026-07-05:ACME:B006:SKU-6',
        asin: 'B006',
        sku: 'SKU-6',
        title: 'Active order stuck product',
        tier: 'C',
        actionStatus: 'already_ordered',
        estimatedProfitRisk: 0,
        daysOfCover: 90,
        estimatedOosDate: '2026-09-30',
        daysUntilOos: 87,
        expectedArrivalDate: '2026-07-12',
        expectedArrivalStatus: 'imported',
        pipelineHealthStatus: 'on_track',
        supplierOrderState: 'purchased_pipeline',
        commandCenterPane: 'activeOrders',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PO-6',
        stuck: false,
        stuckClassification: 'none',
      },
    });
    await goldRows.create({
      values: {
        ...baseRow,
        id: 'gold-7',
        naturalKey: '2026-07-05:ACME:B007:SKU-7',
        asin: 'B007',
        sku: 'SKU-7',
        title: 'Current-only readiness product',
        tier: null,
        profitPerUnit: null,
        estimatedProfitRisk: null,
        moneyRiskStatus: 'unknown_missing_inputs',
        salesVelocity: null,
        salesVelocityStatus: 'missing',
        actionStatus: 'missing_velocity',
        commandCenterPane: 'dataReadiness',
        dataQualityStatus: 'blocked',
        dataQualityIssues: ['velocity_missing'],
        evidence: { historyLoadStatus: 'not_loaded' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-2', name: 'ACME' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-2', asin: 'B002', sku: 'SKU-2', title: 'Pipeline risk product' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-2', companyId: 'company-2', productId: 'product-2' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-2', displayName: 'Supplier A', normalizedName: 'supplier a' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-po-2',
        naturalKey: 'supplier-order:ACME:PO-2',
        companyId: 'company-2',
        supplierId: 'supplier-2',
        orderRef: 'PO-2',
        status: 'paid',
        statusSource: 'operator',
        orderIntent: 'purchase_order',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'supplier-order-line-po-2',
        orderId: 'supplier-order-po-2',
        companyProductId: 'company-product-2',
        orderedQty: 20,
        confirmedQty: 0,
        sourceOrderLineRef: 'PO-2:B002:SKU-2',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'activity-po-2',
        naturalKey: 'supplier-order-activity:supplier-order-po-2:2026-07-01T10:00:00.000Z',
        entityType: 'supplier_order',
        entityId: 'supplier-order-po-2',
        commentType: 'status_update',
        body: 'Paid confirmed',
        createdAt: '2026-07-01T10:00:00.000Z',
        contextSnapshotJson: { occurredAt: '2026-07-01T10:00:00.000Z', source: 'operator' },
      },
    });

    const context = createActionContext(db, {
      company: 'ACME',
      pane: 'supplyAction',
      pageSize: 1,
      sortBy: 'estimatedProfitRisk',
      sortDirection: 'desc',
      selectedRowId: 'gold-2',
    });
    await actions.commandCenter(context, vi.fn());
    const data = context.body?.data as Record<string, any>;

    expect(data.metadata).toMatchObject({
      company: 'ACME',
      calculationDate: '2026-07-05',
      targetCoverDays: 45,
      planningMode: 'current_operational',
      historyReadiness: { status: 'partial', affectedRowCount: 1, totalRowCount: 7 },
    });
    expect(data.summaryCards.map((card: Record<string, unknown>) => card.label)).toEqual([
      'Urgent stockout risk',
      'Money at risk',
      'Supply action needed',
      'Active orders off-track',
      'Follow-ups due today',
      'Stuck inventory',
    ]);
    expect(data.macroRisk.map((item: Record<string, unknown>) => item.label)).toContain('Stuck current stock');
    expect(data.summaryCards.find((card: Record<string, unknown>) => card.key === 'moneyAtRisk')).toMatchObject({
      value: 600,
      unknownCount: 2,
    });
    expect(data.panes.dataReadiness).toMatchObject({
      total: 1,
      rows: [expect.objectContaining({ id: 'gold-7', tier: undefined, profitPerUnit: undefined })],
    });
    expect(data.panes.supplyAction).toMatchObject({ total: 1, pageSize: 1 });
    expect(data.panes.supplyAction.rows[0]).toMatchObject({
      id: 'gold-1',
      tierScore: 250,
      recentUnits30: 10,
      tierEligibilityReason: 'eligible_recent_demand',
      tierRuleVersion: 'rolling_30d_min_4_v1',
      previousTier: 'B',
      tierMovement: 'up',
      currentTier: 'A',
      currentTierScore: 250,
      averageTier: 'B',
      averageTierScore: 175,
      bestTier: 'A',
      bestTierScore: 300,
      profitPerUnit: 25,
      recommendedBestQty: 10,
      daysUntilOos: 3,
      sellableStock: 4,
      reservedStock: 2,
      pipelineStock: 4,
      sixMonthAverageQty: 22,
    });
    expect(data.panes.activeOrders).toMatchObject({ total: 3 });
    expect(data.panes.activeOrders.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gold-2',
          daysUntilOos: 2,
          stockoutGapDays: 3,
          latestSupplierOrderActivityAt: '2026-07-01T10:00:00.000Z',
          latestSupplierOrderActivityNote: 'Paid confirmed',
        }),
        expect.objectContaining({ id: 'gold-4', estimatedProfitRisk: undefined, moneyRiskStatus: 'unknown_arrival' }),
        expect.objectContaining({ id: 'gold-6', stuck: false, stuckClassification: 'none' }),
      ]),
    );
    expect(data.panes.stuckInventory).toMatchObject({ total: 2 });
    expect(data.panes.stuckInventory.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gold-3', tier: undefined, stuckClassification: 'over_60_doc' }),
        expect.objectContaining({ id: 'gold-5', stuckClassification: 'over_60_doc' }),
      ]),
    );
    expect(data.panes.supplyAction.rows.map((row: Record<string, unknown>) => row.id)).not.toContain('gold-5');
    expect(data.panes.stuckInventory.rows.map((row: Record<string, unknown>) => row.id)).not.toContain('gold-6');
    expect(data.selectedRow.row).toMatchObject({
      id: 'gold-2',
      tierScore: 250,
      previousTier: 'B',
      currentTier: 'A',
      bestTierScore: 300,
      recommendedBestQty: 10,
      recommendedEscalation: 'follow_up_order',
      orderedStock: 2,
    });
    expect(data.selectedRow.workspace.orderLineHistory).toHaveLength(1);
    expect(data.selectedRow.workspace.orderActivities).toEqual(
      expect.arrayContaining([expect.objectContaining({ notes: 'Paid confirmed' })]),
    );

    const pageTwoContext = createActionContext(db, {
      company: 'ACME',
      pane: 'activeOrders',
      page: 2,
      pageSize: 1,
      sortBy: 'asin',
      sortDirection: 'asc',
    });
    await actions.commandCenter(pageTwoContext, vi.fn());
    expect(pageTwoContext.body?.data.panes.activeOrders).toMatchObject({ total: 3, page: 2, pageSize: 1 });
    expect(pageTwoContext.body?.data.panes.activeOrders.rows).toHaveLength(1);
  });
});

describe('Ecobase supplier-order public API seam', () => {
  it('exposes operator-authenticated imported-line reconciliation without importing a source', async () => {
    const context = createActionContext(new MemoryDatabase(), { importRunId: 'maintenance-run' }, { id: 1 }, ['admin']);
    const next = vi.fn();

    await createEcobaseSupplierOrderActions().reconcileImportedLines(context, next);

    expect(context.body).toMatchObject({
      data: {
        importRunId: 'maintenance-run',
        repaired: 0,
        ambiguous: 0,
        missing: 0,
        skipped: 0,
      },
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('creates medallion draft orders and lines through the API seam', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', companyKey: 'SAM', name: 'SampleAM' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-1', normalizedName: 'acme', displayName: 'Acme' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-1', asin: 'B001', sku: 'SKU-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-1', companyId: 'company-1', productId: 'product-1', amazonAccountId: 'account-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-1', supplierId: 'supplier-1', productId: 'product-1' },
    });

    const orderContext = createActionContext(db, {
      companyId: 'company-1',
      supplierId: 'supplier-1',
      orderDate: '2026-06-22',
      expectedDeliveryDate: '2026-07-01',
    });
    await actions.createMedallionDraftOrder(orderContext, vi.fn());
    const order = orderContext.body?.data as Record<string, unknown>;

    const lineContext = createActionContext(db, {
      orderId: order.id,
      companyProductId: 'company-product-1',
      supplierProductId: 'supplier-product-1',
      orderedQty: 8,
      unitCost: 2.5,
      expectedSellableDate: '2026-07-05',
    });
    await actions.addMedallionOrderLine(lineContext, vi.fn());

    expect(orderContext.body).toMatchObject({
      data: expect.objectContaining({ orderRef: 'SAM062226A', lifecycleStatus: 'draft' }),
    });
    expect(lineContext.body).toMatchObject({
      data: expect.objectContaining({ orderId: order.id, orderedQty: 8, expectedSellableDate: '2026-07-05' }),
    });
  });

  it('creates comments, approvals, and deterministic workflow execution through API seam', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseMedallionWorkflowActions();
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

    const commentContext = createActionContext(db, {
      entityType: 'order',
      entityId: 'order-1',
      actorType: 'operator',
      commentType: 'status_update',
      body: 'Supplier confirmed.',
      workflowAction: {
        title: 'Confirm order',
        actionType: 'update_order_status',
        actionPayloadJson: { orderId: 'order-1', lifecycleStatus: 'confirmed' },
      },
    });
    await actions.createComment(commentContext, vi.fn());
    const approval = commentContext.body?.data.approval as Record<string, unknown>;
    expect({ ...approval }).toMatchObject({ actionType: 'update_order_status', status: 'pending' });

    const executeContext = createActionContext(db, { approvalId: approval.id, approvedByUserId: 'reviewer-1' });
    await actions.approveAndExecute(executeContext, vi.fn());
    expect(executeContext.body).toMatchObject({ data: expect.objectContaining({ status: 'executed' }) });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({ lifecycleStatus: 'confirmed' });
  });

  it('exposes coverage queries and explicit operator-owned line updates', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: 'planning-product-1',
        naturalKey: 'planning-product:Ecofission LLC:B00TEST',
        company: 'Ecofission LLC',
        canonicalAsin: 'B00TEST',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-1',
        naturalKey: 'supplier-order:Ecofission LLC:PO-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-1',
        status: 'confirmed',
        statusSource: 'import',
        sourceStage: 'purchase_order',
        externalOrderRef: 'PO-1',
        lastImportRunId: 'import-run-1',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'supplier-order-line-1',
        naturalKey: 'supplier-order-line:PO-1:1',
        supplierOrderId: 'supplier-order-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-1',
        planningProductId: 'planning-product-1',
        orderedQty: 20,
        receivedQty: 0,
        receivedQtySource: 'import',
        expectedSellableDate: '2025-07-20',
        expectedSellableDateSource: 'imported_expected_sellable_date',
        sourceOrderLineRef: 'PO-1:1',
        sourceStage: 'purchase_order',
        lastImportRunId: 'import-run-1',
      },
    });
    const actions = createEcobaseSupplierOrderActions();

    const updateOrderContext = createActionContext(db, {
      supplierOrderId: 'supplier-order-1',
      company: 'Ecofission LLC',
      status: 'confirmed',
      expectedDeliveryDate: '2025-07-24',
    });
    await actions.updateOrderOperatorFields(updateOrderContext, vi.fn());
    expect(updateOrderContext.body).toMatchObject({
      data: expect.objectContaining({
        status: 'supplier_confirmed',
        statusSource: 'operator',
        expectedDeliveryDate: '2025-07-24',
      }),
    });

    const updateLineContext = createActionContext(
      db,
      {
        supplierOrderLineId: 'supplier-order-line-1',
        company: 'Ecofission LLC',
        receivedQty: 5,
        expectedSellableDate: '2025-07-25',
        notes: 'Supplier confirmed the sellable date.',
      },
      { id: 201 },
    );
    await actions.updateLineOperatorFields(updateLineContext, vi.fn());
    expect(updateLineContext.body).toMatchObject({
      data: expect.objectContaining({
        confirmedQty: 5,
        receivedQty: 0,
        expectedSellableDate: '2025-07-25',
        expectedDateOverrideReason: 'Supplier confirmed the sellable date.',
        expectedDateOverrideByUserId: '201',
        expectedDateOverrideAt: expect.any(String),
      }),
    });

    await actions.updateOrderOperatorFields(
      createActionContext(db, { supplierOrderId: 'supplier-order-1', company: 'Ecofission LLC', status: 'paid' }),
      vi.fn(),
    );

    const coverageContext = createActionContext(db, {
      planningProductId: 'planning-product-1',
      stockoutDate: '2025-07-30',
    });
    await actions.getCoverage(coverageContext, vi.fn());
    expect(coverageContext.body).toMatchObject({
      data: expect.objectContaining({
        planningProductId: 'planning-product-1',
        totalOpenQty: 20,
        coverageState: 'arrives_before_stockout',
      }),
    });

    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, { supplierOrderId: 'supplier-order-1', company: 'Ecofission LLC', status: 'bad' }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: status "bad" is not supported.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, {
          supplierOrderLineId: 'supplier-order-line-1',
          company: 'Ecofission LLC',
          expectedSellableDate: '2025-07-26',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order line update failed: notes are required for expected-date overrides.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, {
          supplierOrderLineId: 'supplier-order-line-1',
          company: 'Ecofission LLC',
          expectedSellableDate: '25/07/2025',
          notes: 'Supplier confirmation.',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedSellableDate must use YYYY-MM-DD.');
    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, {
          supplierOrderId: 'supplier-order-1',
          company: 'Ecofission LLC',
          expectedDeliveryDate: '2025-02-31',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedDeliveryDate must be a valid calendar date.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, {
          supplierOrderLineId: 'supplier-order-line-1',
          company: 'Ecofission LLC',
          expectedSellableDate: '2025-99-99',
          notes: 'Supplier confirmation.',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: expectedSellableDate must be a valid calendar date.');
    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, { supplierOrderId: 'supplier-order-1', company: 'Other LLC', status: 'confirmed' }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: order belongs to a different company.');
    await expect(
      actions.updateLineOperatorFields(
        createActionContext(db, { supplierOrderLineId: 'supplier-order-line-1', company: 'Other LLC', receivedQty: 1 }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order line update failed: line "supplier-order-line-1" was not found.');

    const leapDateContext = createActionContext(db, {
      supplierOrderLineId: 'supplier-order-line-1',
      company: 'Ecofission LLC',
      expectedSellableDate: '2024-02-29',
      notes: 'Supplier confirmed the leap-day date.',
    });
    await actions.updateLineOperatorFields(leapDateContext, vi.fn());
    expect(leapDateContext.body).toMatchObject({
      data: expect.objectContaining({ expectedSellableDate: '2024-02-29' }),
    });
  });
});

describe('Ecobase supplier-order workspace API seam', () => {
  it('updates an order supplier by company-scoped supplier selection and keeps lines in sync', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-eco', name: 'Ecofission LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-other', name: 'Other LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-old', displayName: 'Old Supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-new', displayName: 'New Supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-other', displayName: 'Other Supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).create({
      values: { id: 'account-old', companyId: 'company-eco', supplierId: 'supplier-old' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).create({
      values: { id: 'account-new', companyId: 'company-eco', supplierId: 'supplier-new' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).create({
      values: { id: 'account-other', companyId: 'company-other', supplierId: 'supplier-other' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-1',
        companyId: 'company-eco',
        orderRef: 'ORDER-1',
        supplierId: 'supplier-old',
        canonicalStatus: 'approval_pending',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'line-1',
        orderId: 'order-1',
        orderedQty: 5,
        confirmedQty: 0,
      },
    });

    await actions.updateOrderOperatorFields(
      createActionContext(db, {
        supplierOrderId: 'order-1',
        company: 'Ecofission LLC',
        supplierId: 'supplier-new',
        externalOrderRef: 'ORDER-1A',
        orderDate: '2026-06-09',
      }),
      vi.fn(),
    );

    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.silverOrders)
        .all()
        .find((record) => record.id === 'order-1'),
    ).toMatchObject({
      supplierId: 'supplier-new',
      orderRef: 'ORDER-1A',
      orderDate: '2026-06-09',
    });
    const workspace = createActionContext(db, { company: 'Ecofission LLC' });
    await actions.workspace(workspace, vi.fn());
    expect(
      workspace.body.data.supplierOrderLines.find((record: Record<string, unknown>) => record.id === 'line-1'),
    ).toMatchObject({
      supplierId: 'supplier-new',
    });
    await expect(
      actions.updateOrderOperatorFields(
        createActionContext(db, {
          supplierOrderId: 'order-1',
          company: 'Ecofission LLC',
          supplierId: 'supplier-other',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order update failed: supplier belongs to a different company.');
  });

  it('creates planned orders from reorder candidates, records activity, and isolates companies', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Order sheet',
        company: 'Ecofission LLC',
        sourceType: 'google_sheets',
        domain: 'order_management',
        config: {},
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: { id: 'eco-import-run', sourceConnectionId: '11111111-1111-4111-8111-111111111111', status: 'success' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-eco', name: 'Ecofission LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-other', name: 'Other LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-eco', asin: 'B00ORDER', title: 'Order candidate' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-other', asin: 'B00ORDER' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: {
        id: '22222222-2222-4222-8222-222222222222',
        companyId: 'company-eco',
        productId: 'product-eco',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: {
        id: '33333333-3333-4333-8333-333333333333',
        companyId: 'company-other',
        productId: 'product-other',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'gold-product-eco',
        calculationDate: '2025-07-10',
        companyProductId: '22222222-2222-4222-8222-222222222222',
        company: 'Ecofission LLC',
        asin: 'B00ORDER',
        title: 'Order candidate',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: '44444444-4444-4444-8444-444444444444', displayName: 'Preferred Supplier' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierAccounts).create({
      values: {
        id: 'supplier-account-eco',
        companyId: 'company-eco',
        supplierId: '44444444-4444-4444-8444-444444444444',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: {
        id: 'supplier-product-eco',
        supplierId: '44444444-4444-4444-8444-444444444444',
        productId: 'product-eco',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).create({
      values: {
        id: '55555555-5555-4555-8555-555555555555',
        companyProductId: '22222222-2222-4222-8222-222222222222',
        supplierProductId: 'supplier-product-eco',
        role: 'preferred',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        id: 'raw-row-eco-company',
        importRunId: 'eco-import-run',
        rowNumber: 1,
        payload: { company: 'Ecofission LLC' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        id: 'raw-row-other-company',
        importRunId: 'other-import-run',
        rowNumber: 2,
        payload: { company: 'Other LLC' },
      },
    });

    const unscopedWorkspace = createActionContext(db, { stockoutDate: '2025-07-20' });
    await actions.workspace(unscopedWorkspace, vi.fn());
    expect(unscopedWorkspace.body.data).toMatchObject({
      reorderCandidates: [],
      supplierOrders: [],
      supplierOrderLines: [],
      bronzeSourceRecords: [],
      dataWarnings: ['company_filter_required'],
    });

    const workspaceBefore = createActionContext(db, { company: 'Ecofission LLC', stockoutDate: '2025-07-20' });
    await actions.workspace(workspaceBefore, vi.fn());
    expect(workspaceBefore.body).toMatchObject({
      data: {
        reorderCandidates: [
          expect.objectContaining({
            planningProductId: '22222222-2222-4222-8222-222222222222',
            preferredSupplierId: '44444444-4444-4444-8444-444444444444',
            coverage: expect.objectContaining({ coverageState: 'no_open_order' }),
          }),
        ],
        bronzeSourceRecords: [expect.objectContaining({ id: 'raw-row-eco-company', importRunId: 'eco-import-run' })],
      },
    });

    await expect(
      actions.createPlannedOrder(
        createActionContext(db, {
          company: 'Ecofission LLC',
          planningProductId: '22222222-2222-4222-8222-222222222222',
          orderedQty: 12,
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase planned order failed: supplier selection is required.');

    const createOrderContext = createActionContext(db, {
      company: 'Ecofission LLC',
      planningProductId: '22222222-2222-4222-8222-222222222222',
      supplierId: '44444444-4444-4444-8444-444444444444',
      orderedQty: 12,
      expectedDeliveryDate: '2025-07-18',
      expectedSellableDate: '2025-07-19',
      externalOrderRef: 'PO-MANUAL-1',
      notes: 'created from workspace',
    });
    await actions.createPlannedOrder(createOrderContext, vi.fn());
    expect(createOrderContext.body).toMatchObject({
      data: {
        order: expect.objectContaining({ canonicalStatus: 'draft', orderIntent: 'manual', orderRef: 'PO-MANUAL-1' }),
        line: expect.objectContaining({ orderedQty: 12, expectedSellableDate: '2025-07-19' }),
        coverage: expect.objectContaining({ coverageState: 'no_open_order', totalOpenQty: 0 }),
      },
    });

    const lineId = String(createOrderContext.body.data.line.id);
    await actions.updateLineOperatorFields(
      createActionContext(db, { supplierOrderLineId: lineId, company: 'Ecofission LLC', receivedQty: 5 }),
      vi.fn(),
    );
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.silverOrderLines)
        .all()
        .find((record) => record.id === lineId),
    ).toMatchObject({
      confirmedQty: 5,
    });

    const orderId = String(createOrderContext.body.data.order.id);
    await actions.recordActivity(
      createActionContext(
        db,
        {
          company: 'Ecofission LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType: 'contacted_supplier',
          occurredAt: '2025-07-10T09:30:00.000Z',
          notes: 'supplier contacted',
          nextFollowUpAt: '2025-07-12T09:30:00.000Z',
          contactEstablished: false,
        },
        { id: 201 },
      ),
      vi.fn(),
    );
    await actions.recordActivity(
      createActionContext(db, {
        company: 'Ecofission LLC',
        supplierId: '44444444-4444-4444-8444-444444444444',
        supplierOrderId: orderId,
        activityType: 'lead_time_checked',
        occurredAt: '2025-07-10T10:00:00.000Z',
        leadTimeDays: 9,
        notes: 'supplier confirmed',
      }),
      vi.fn(),
    );
    expect(
      await db
        .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
        .findOne({ filterByTk: '44444444-4444-4444-8444-444444444444' }),
    ).toMatchObject({
      lastContactedAt: '2025-07-10T09:30:00.000Z',
      nextFollowUpAt: '2025-07-12T09:30:00.000Z',
      approvalStatus: 'contacting',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).all()).toEqual([
      expect.objectContaining({
        supplierId: '44444444-4444-4444-8444-444444444444',
        leadTimeDays: 9,
        analysisStatus: 'manual',
      }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commentType: 'contacted_supplier',
          actorUserId: '201',
          contextSnapshotJson: expect.objectContaining({ actor: '201' }),
        }),
      ]),
    );
    for (const activityType of ['status_update', 'note', 'blocked', 'unblocked']) {
      await actions.recordActivity(
        createActionContext(db, {
          company: 'Ecofission LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType,
          notes: `${activityType} recorded`,
        }),
        vi.fn(),
      );
    }
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.silverActivityComments)
        .all()
        .map((activity) => activity.commentType),
    ).toEqual(
      expect.arrayContaining([
        'contacted_supplier',
        'lead_time_checked',
        'status_update',
        'note',
        'blocked',
        'unblocked',
      ]),
    );
    await expect(
      actions.recordActivity(
        createActionContext(db, {
          company: 'Ecofission LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType: 'free_text_status',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity failed: activityType "free_text_status" is not supported.');
    await expect(
      actions.recordActivity(
        createActionContext(db, {
          company: 'Ecofission LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType: 'lead_time_checked',
          leadTimeDays: -1,
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity failed: leadTimeDays must be an integer from 0 to 3650.');
    await expect(
      actions.recordActivity(
        createActionContext(db, {
          company: 'Other LLC',
          supplierId: '44444444-4444-4444-8444-444444444444',
          supplierOrderId: orderId,
          activityType: 'contacted_supplier',
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity failed: supplier belongs to a different company.');

    await actions.updateOrderOperatorFields(
      createActionContext(db, { supplierOrderId: orderId, company: 'Ecofission LLC', status: 'paid' }),
      vi.fn(),
    );

    const workspaceAfter = createActionContext(db, { company: 'Ecofission LLC', stockoutDate: '2025-07-20' });
    await actions.workspace(workspaceAfter, vi.fn());
    expect(workspaceAfter.body.data.reorderCandidates).toHaveLength(1);
    expect(workspaceAfter.body.data.reorderCandidates[0]).toMatchObject({
      coverage: expect.objectContaining({ totalOpenQty: 12 }),
      leadTimeDays: 9,
      latestContactAt: '2025-07-10T09:30:00.000Z',
    });
  });

  it('edits and soft-deletes manual comments but keeps imported comments read-only', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierOrderActions();
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'manual-comment',
        entityType: 'supplier',
        entityId: 'supplier-1',
        commentType: 'note',
        body: 'Original note',
        contextSnapshotJson: { company: 'Ecofission LLC', source: 'manual' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'clickup-comment',
        entityType: 'supplier',
        entityId: 'supplier-1',
        commentType: 'note',
        body: 'Imported note',
        contextSnapshotJson: { company: 'Ecofission LLC', source: 'clickup' },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'manual-status',
        entityType: 'supplier',
        entityId: 'supplier-1',
        commentType: 'status_update',
        body: 'Status evidence',
        contextSnapshotJson: { company: 'Ecofission LLC', source: 'manual' },
      },
    });

    const updateContext = createActionContext(
      db,
      { company: 'Ecofission LLC', activityId: 'manual-comment', notes: 'Edited note' },
      { id: 201 },
    );
    await actions.updateActivityComment(updateContext, vi.fn());
    expect(updateContext.body.data).toMatchObject({
      body: 'Edited note',
      contextSnapshotJson: {
        editHistory: [expect.objectContaining({ notes: 'Original note', editedById: '201' })],
      },
    });

    const deleteContext = createActionContext(
      db,
      { company: 'Ecofission LLC', activityId: 'manual-comment' },
      { id: 202 },
    );
    await actions.deleteActivityComment(deleteContext, vi.fn());
    expect(deleteContext.body.data).toMatchObject({ deletedByUserId: '202' });
    expect(String(deleteContext.body.data.deletedAt)).toMatch(/^202/);

    await expect(
      actions.updateActivityComment(
        createActionContext(
          db,
          { company: 'Ecofission LLC', activityId: 'clickup-comment', notes: 'Nope' },
          { id: 201 },
        ),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity update failed: imported comments are read-only.');
    await expect(
      actions.deleteActivityComment(
        createActionContext(db, { company: 'Ecofission LLC', activityId: 'clickup-comment' }, { id: 201 }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity delete failed: imported comments are read-only.');
    await expect(
      actions.updateActivityComment(
        createActionContext(db, { company: 'Ecofission LLC', activityId: 'manual-status', notes: 'Nope' }, { id: 201 }),
        vi.fn(),
      ),
    ).rejects.toThrow('Ecobase supplier-order activity update failed: only manual comments can be changed.');
  });
});

describe('Ecobase import public API seam', () => {
  it('restricts migration deactivation and expired Bronze purge to administrators', async () => {
    const db = new MemoryDatabase();
    const sourceRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    await sourceRepo.create({
      values: { id: 'source-supplier', sourceType: 'google_sheets', domain: 'supplier_management', active: true },
    });
    await sourceRepo.create({
      values: { id: 'source-clickup', sourceType: 'clickup', domain: 'order_management', active: true },
    });
    await sourceRepo.create({
      values: { id: 'source-sellerboard', sourceType: 'sellerboard', domain: 'amazon_operations', active: true },
    });
    const bronzeRepo = db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords);
    await bronzeRepo.create({ values: { id: 'bronze-expired', retentionUntil: '2026-08-12T00:00:00.000Z' } });
    await bronzeRepo.create({ values: { id: 'bronze-current', retentionUntil: '2026-08-14T00:00:00.000Z' } });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));

    await expect(
      actions.deactivateMigrationSources(createActionContext(db, {}, undefined, ['loggedIn']), vi.fn()),
    ).rejects.toMatchObject({ status: 403 });

    const deactivateContext = createActionContext(db, {}, undefined, ['admin']);
    await actions.deactivateMigrationSources(deactivateContext, vi.fn());
    expect(deactivateContext.body).toEqual({
      data: {
        sourceTypes: ['google_sheets', 'clickup'],
        matchedCount: 2,
        deactivatedCount: 2,
      },
    });
    expect(sourceRepo.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'source-supplier', active: false }),
        expect.objectContaining({ id: 'source-clickup', active: false }),
        expect.objectContaining({ id: 'source-sellerboard', active: true }),
      ]),
    );

    const purgeContext = createActionContext(db, { before: '2026-08-13T00:00:00.000Z' }, undefined, ['root']);
    await actions.purgeExpiredBronze(purgeContext, vi.fn());
    expect(purgeContext.body).toEqual({
      data: { before: '2026-08-13T00:00:00.000Z', deletedCount: 1 },
    });
    expect(bronzeRepo.all()).toEqual([expect.objectContaining({ id: 'bronze-current' })]);
  });

  it('runs the no-op import through resource actions and reads source status', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));

    const runContext = createActionContext(db, {
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });
    const runNext = vi.fn();
    await actions.runNoop(runContext, runNext);

    expect(runContext.body).toMatchObject({
      data: {
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
        idempotencyKey: 'source-1:manual-noop:v1',
        status: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
    });
    expect(runNext).toHaveBeenCalledOnce();

    const statusContext = createActionContext(db);
    const statusNext = vi.fn();
    await actions.status(statusContext, statusNext);

    expect(statusContext.body).toEqual({
      data: [
        expect.objectContaining({
          sourceConnectionId: 'source-1',
          connectionName: 'No-op source',
          sourceType: 'noop_test',
          domain: 'foundation',
          active: true,
          required: false,
          freshnessSlaMinutes: null,
          latestRunStatus: 'success',
          rowCount: 0,
          normalizedCount: 0,
          warningCount: 0,
          latestRunWarningCount: 0,
          errorCount: 0,
          latestWarning: null,
          warnings: [],
        }),
      ],
    });
    expect(statusNext).toHaveBeenCalledOnce();
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([]);
  });

  it('imports Sellerboard COGS CSV files into product costs', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const next = vi.fn();
    const content = [
      'ASIN;"SKU";"Title";"Labels";"CostPeriodStartDate";"Cost";"ShippingCostPerOrder";"ShippingProfile";"SurchargeForShippingAbroad";"Value_of_unsellable_returns";"VAT";"VAT_DE_2020";"VAT_CATEGORY";"Hide";"Marketplace"',
      'B003WH3SIE;"Black Patina 8 Oz";"Novacan Black Patina for Solder";"";"01/04/2026";"4,61";"";"";"";"";"";"";"A_GEN_STANDARD";"NO";"Amazon.com"',
      'B0006SDOFO;"Olfa-RM-MG-Green";"OLFA Cutting Mat";"";"11/02/2026";"33.4";"";"";"";"";"";"";"A_GEN_STANDARD";"NO";"Amazon.com"',
      'B000SKIP;"Missing cost";"Missing cost";"";"";"";"";"";"";"";"";"";"A_GEN_STANDARD";"NO";"Amazon.com"',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'Muxtex_Cost_of_Goods_Sold_(2026_07_04_08_59_22_030).csv', content }],
      importedAt: '2026-07-06T00:00:00.000Z',
    });
    await actions.importSellerboardCogs(context, next);

    expect(context.body).toMatchObject({ data: { rowCount: 3, importedCount: 2, skippedCount: 1 } });
    expect(next).toHaveBeenCalledOnce();
    expect(db.getRepository(ECOBASE_COLLECTIONS.sellerboardProductCosts).all()).toEqual([
      expect.objectContaining({ company: 'Muxtex INC', asin: 'B003WH3SIE', sku: 'Black Patina 8 Oz', unitCost: 4.61 }),
      expect.objectContaining({ company: 'Muxtex INC', asin: 'B0006SDOFO', sku: 'Olfa-RM-MG-Green', unitCost: 33.4 }),
    ]);

    const updateContext = createActionContext(db, {
      files: [
        {
          name: 'Muxtex_Cost_of_Goods_Sold_(2026_07_04_08_59_22_030).csv',
          content: content.replace('"4,61"', '"5,25"'),
        },
      ],
    });
    await actions.importSellerboardCogs(updateContext, vi.fn());

    const rows = db.getRepository(ECOBASE_COLLECTIONS.sellerboardProductCosts).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ unitCost: 5.25 });
    expect(rows.every((row) => !Object.hasOwn(row, 'rawPayload'))).toBe(true);
  });

  it('extracts only compact ClickUp order refs from task titles', () => {
    expect(extractClickupOrderRefsFromTitle('New Order – SS7226A–Stop Shop Inc – USA – My Weigh')).toEqual(['SS7226A']);
    expect(extractClickupOrderRefsFromTitle('Restock Order – MX101725B – Muxtex')).toEqual(['MX101725B']);
    expect(extractClickupOrderRefsFromTitle('Shipping labels required EF11425C')).toEqual(['EF11425C']);
    expect(extractClickupOrderRefsFromTitle('ASIN B07RGG7TXX and UK-KK-KM-250719-03 should not match')).toEqual([]);
    const ambiguous = parseClickupOrderStatusFiles([
      {
        name: 'synthetic-clickup.csv',
        content: 'Task ID,Task Name,Status,Comments\ntask-1,"Order EF1001A and MX1001A",ordered,"[]"',
      },
    ]);
    expect(ambiguous.tasksByRef.size).toBe(0);
    expect(ambiguous.ambiguousMultiRefTasks).toEqual([
      { taskId: 'task-1', lineNumber: 2, orderRefs: ['EF1001A', 'MX1001A'] },
    ]);
  });

  it('discards multi-order ClickUp tasks as warnings instead of import errors', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const sourceConnectionId = 'clickup-source-multi-ref';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: sourceConnectionId, sourceType: 'clickup', domain: 'order_management', active: true },
    });
    const context = createActionContext(db, {
      files: [
        {
          name: 'clickup.csv',
          content: 'Task ID,Task Name,Status,Comments\ntask-1,"Order EF1001A and MX1001A",ordered,"[]"',
        },
      ],
      dryRun: false,
      sourceConnectionId,
      skipGoldRefresh: true,
    });

    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: {
        status: 'success',
        errorCount: 0,
        warningCount: 1,
        summary: { clickup: { ambiguousMultiRefTaskCount: 1, blockingIssueCount: 0 } },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTasks).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toHaveLength(0);
  });

  it('maps raw ClickUp statuses to canonical order statuses', () => {
    expect(
      Object.fromEntries(
        [
          'approved-to-order',
          'complete',
          'direct-ship-fba',
          'hold',
          'hold/cancelled',
          'in progress',
          'in transit to prep',
          'inbound-monitoring',
          'ordered',
          'order analysing',
          'prep-in-progress',
          'to do',
        ].map((status) => [status, canonicalOrderStatusForClickupStatus(status)]),
      ),
    ).toEqual({
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
    });
    expect(canonicalOrderStatusForClickupStatus('unknown')).toBeUndefined();
  });

  it('preserves unknown ClickUp statuses as reviewable evidence', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const sourceConnectionId = 'clickup-source-unknown-status';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: sourceConnectionId, sourceType: 'clickup', domain: 'order_management', active: true },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'stop-order',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        canonicalStatus: 'draft',
        lifecycleStatus: 'order analysing',
        statusSource: 'google_sheets',
      },
    });
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'task-main,,New Order SS7226A Stop Shop,,awaiting carrier,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: { summary: { clickup: { unmappedStatusCount: 1, blockingIssueCount: 1 } } },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      canonicalStatus: 'draft',
      statusCheckRequired: true,
      statusEvidenceJson: {
        clickupStatusImport: { clickupStatus: 'awaiting carrier', mappedStatus: undefined },
      },
    });
  });

  it('classifies alternate, intentionally untracked, and unresolved order authority', async () => {
    const db = new MemoryDatabase();
    for (const order of [
      {
        id: 'alternate-order',
        externalOrderRef: 'EF1001A',
        canonicalStatus: 'SHIPPED TO FBA',
        statusSource: 'shipping_evidence',
      },
      {
        id: 'unresolved-order',
        externalOrderRef: 'EF1002A',
        canonicalStatus: 'IN-PROGRESS',
        statusSource: 'fallback',
      },
      {
        id: 'closed-order',
        externalOrderRef: 'EF1003A',
        canonicalStatus: 'COMPLETE',
        statusSource: 'source_closed',
      },
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
        values: { ...order, company: 'Ecofission LLC', supplierId: 'supplier-1' },
      });
    }

    const result = await new EcobaseClickupOrderStatusService(db).reconcileAuthority('2026-07-10T00:00:00.000Z');

    expect(result).toEqual({
      authorityCounts: {
        alternate_authoritative: 1,
        unresolved: 1,
        intentionally_untracked: 1,
      },
      unresolvedAuthorityOrderIds: ['unresolved-order'],
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'alternate-order', authorityStatus: 'alternate_authoritative' }),
        expect.objectContaining({ id: 'unresolved-order', authorityStatus: 'unresolved' }),
        expect.objectContaining({ id: 'closed-order', authorityStatus: 'intentionally_untracked' }),
      ]),
    );
  });

  it('dry-runs ClickUp order-status imports without updating supplier orders', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-1',
        naturalKey: 'source:order:SS7226A',
        sourceConnectionId: 'source-orders',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        sourceStage: 'order_detail',
        status: 'approval_pending',
        statusSource: 'google_sheets',
        payload: {},
      },
    });
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'task-1,https://app.clickup.com/t/task-1,New Order – SS7226A–Stop Shop Inc – USA – My Weigh,,approved-to-order,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
      'task-asin,https://app.clickup.com/t/task-asin,OBJ-8 ASIN B07RGG7TXX,,in progress,1782921599421,"7/1/2026, 1:01 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'Order Management Clickup Data 06-07-2026.csv', content }],
      importedAt: '2026-07-06T00:00:00.000Z',
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: {
        dryRun: true,
        rowCount: 2,
        selectedRefCount: 1,
        matchedOrderCount: 1,
        updatedOrderCount: 0,
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      status: 'approval_pending',
      statusSource: 'google_sheets',
    });
  });

  it('matches NewOrder tasks by canonical company and never updates another company sharing the ref', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    for (const order of [
      { id: 'stop-order', company: 'Stop Shop LLC' },
      { id: 'eco-order', company: 'Ecofission LLC' },
    ]) {
      await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
        values: {
          ...order,
          supplierId: `supplier-${order.id}`,
          externalOrderRef: 'SS7226A',
          status: 'approval_pending',
          statusSource: 'google_sheets',
        },
      });
    }
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'task-main,,NewOrder – SS7226A – Stop Shop,,ordered,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      importedAt: '2026-07-06T00:00:00.000Z',
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: {
        selectedRefCount: 1,
        matchedOrderCount: 1,
        proposedUpdates: [expect.objectContaining({ supplierOrderId: 'stop-order', company: 'Stop Shop LLC' })],
      },
    });

    const companyConflictContext = createActionContext(db, {
      files: [
        {
          name: 'clickup-conflict.csv',
          content: content.replace('Stop Shop', 'Ecofission'),
        },
      ],
    });
    await actions.importClickupOrderStatuses(companyConflictContext, vi.fn());
    expect(companyConflictContext.body).toMatchObject({
      data: {
        selectedRefCount: 1,
        matchedOrderCount: 1,
        companyConflictCount: 1,
        blockingIssueCount: 0,
        proposedUpdates: [expect.objectContaining({ supplierOrderId: 'stop-order', company: 'Stop Shop LLC' })],
      },
    });
  });

  it('keeps conflicting authoritative ClickUp statuses reviewable without guessing', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const clickupSourceId = 'clickup-source-conflict';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: clickupSourceId, sourceType: 'clickup', domain: 'order_management', active: true },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'stop-order',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        status: 'approval_pending',
        statusSource: 'google_sheets',
      },
    });
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'task-one,,New Order SS7226A Stop Shop,,ordered,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
      'task-two,,Restock Order SS7226A Stop Shop,,hold,1782921599421,"7/1/2026, 1:01 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: {
        status: 'success',
        errorCount: 0,
        summary: {
          clickup: {
            selectedRefCount: 1,
            updatedOrderCount: 0,
            conflictingMainTaskCount: 1,
            blockingIssueCount: 0,
            proposedUpdates: [expect.objectContaining({ requiresReview: true })],
          },
        },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      status: 'approval_pending',
      statusSource: 'google_sheets',
      statusCheckRequired: true,
      statusEvidenceJson: { clickupStatusConflict: expect.objectContaining({ ref: 'SS7226A' }) },
    });
  });

  it('keeps operator status above a later ClickUp status', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const clickupSourceId = 'clickup-source-operator';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: clickupSourceId, sourceType: 'clickup', domain: 'order_management', active: true },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'stop-order',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        canonicalStatus: 'supplier_confirmed',
        lifecycleStatus: 'supplier_confirmed',
        statusSource: 'operator',
      },
    });
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'task-main,,New Order SS7226A Stop Shop,,ordered,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: { status: 'success', summary: { clickup: { updatedOrderCount: 0, operatorOverrideCount: 1 } } },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      canonicalStatus: 'supplier_confirmed',
      statusSource: 'operator',
      statusCheckRequired: true,
      statusEvidenceJson: {
        clickupStatusImport: { clickupStatus: 'ordered' },
        clickupStatusDiscrepancy: { clickupStatus: 'ordered' },
      },
      authorityStatus: 'alternate_authoritative',
      authoritySource: 'operator_override',
      authorityTaskRef: 'task-main',
    });
  });

  it('overrides operator status only when explicitly requested by the importer', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const clickupSourceId = 'clickup-source-operator-override';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: clickupSourceId, sourceType: 'clickup', domain: 'order_management', active: true },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'stop-order',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        canonicalStatus: 'supplier_confirmed',
        lifecycleStatus: 'supplier_confirmed',
        statusSource: 'operator',
        operatorStatusOverrideAt: '2026-07-01T00:00:00.000Z',
        operatorStatusOverrideByUserId: 'operator-1',
      },
    });
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'task-main,,New Order SS7226A Stop Shop,,ordered,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      overrideOperatorStatus: true,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: {
        status: 'success',
        summary: { clickup: { updatedOrderCount: 1, operatorOverrideCount: 0, overriddenOperatorStatusCount: 1 } },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      canonicalStatus: 'paid',
      lifecycleStatus: 'ordered',
      statusSource: 'clickup_csv',
      operatorStatusOverrideAt: null,
      operatorStatusOverrideByUserId: null,
      authorityStatus: 'clickup_authoritative',
      authoritySource: 'clickup_csv',
      authorityTaskRef: 'task-main',
    });
  });

  it('synchronizes a newer ClickUp status over a previously imported ClickUp status', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const clickupSourceId = 'clickup-source-status-sync';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: clickupSourceId, sourceType: 'clickup', domain: 'order_management', active: true },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'stop-order',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        canonicalStatus: 'approval_pending',
        lifecycleStatus: 'approval_pending',
        statusSource: 'clickup_csv',
        statusEvidenceJson: { clickupStatusImport: { taskId: 'older-task', mappedStatus: 'approval_pending' } },
      },
    });
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'newer-task,,New Order SS7226A Stop Shop,,ordered,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: { status: 'success', summary: { clickup: { updatedOrderCount: 1 } } },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      canonicalStatus: 'paid',
      lifecycleStatus: 'ordered',
      statusSource: 'clickup_csv',
      statusEvidenceJson: { clickupStatusImport: { taskId: 'newer-task', mappedStatus: 'paid' } },
    });
  });

  it('applies ClickUp order-status imports to matched supplier orders with evidence', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const clickupSourceId = '00000000-0000-4000-8000-000000000123';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: clickupSourceId,
        name: 'ClickUp order status CSV upload',
        sourceType: 'clickup',
        domain: 'order_management',
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-1',
        naturalKey: 'source:order:SS7226A',
        sourceConnectionId: 'source-orders',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        sourceStage: 'order_detail',
        status: 'approval_pending',
        statusSource: 'google_sheets',
        payload: { existing: true },
      },
    });
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name',
      'task-helper,https://app.clickup.com/t/task-helper,Shipping labels required SS7226A,,complete,1782921599421,"7/1/2026, 1:01 PM GMT+5",task-main,Order Management (ORM)',
      'task-main,https://app.clickup.com/t/task-main,New Order – SS7226A–Stop Shop Inc – USA – My Weigh,,inbound-monitoring,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM)',
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'Order Management Clickup Data 06-07-2026.csv', content }],
      dryRun: false,
      importedAt: '2026-07-06T00:00:00.000Z',
      sourceConnectionId: clickupSourceId,
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: {
        status: 'success',
        rowCount: 2,
        summary: {
          clickup: { dryRun: false, matchedOrderCount: 1, updatedOrderCount: 1 },
          goldRefresh: { calculationDate: '2026-07-06' },
        },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      canonicalStatus: 'shipped_inbound',
      lifecycleStatus: 'inbound-monitoring',
      statusSource: 'clickup_csv',
      authorityStatus: 'clickup_authoritative',
      authoritySource: 'clickup_csv',
      authorityTaskRef: 'task-main',
      authorityAsOf: '2026-07-01T15:59:59.420Z',
      statusEvidenceJson: {
        clickupStatusImport: expect.objectContaining({
          clickupStatus: 'inbound-monitoring',
          extraction: 'task_name_compact_order_ref',
          taskId: 'task-main',
        }),
        importedAt: '2026-07-06T00:00:00.000Z',
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTasks).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTaskLinks).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([
      expect.objectContaining({ adapterName: 'clickup-order-status-csv', status: 'success' }),
    ]);

    const unchangedContext = createActionContext(db, {
      files: [{ name: 'Order Management Clickup Data 06-07-2026.csv', content }],
      dryRun: false,
      importedAt: '2026-07-07T00:00:00.000Z',
      sourceConnectionId: clickupSourceId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(unchangedContext, vi.fn());
    expect(unchangedContext.body).toMatchObject({
      data: {
        status: 'skipped',
        errorMessage: 'Ecobase ClickUp order-status import skipped: CSV content is unchanged.',
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).all()[0]).toMatchObject({
      canonicalStatus: 'shipped_inbound',
      statusSource: 'clickup_csv',
    });
  });

  it('imports ClickUp comments as idempotent supplier-order notes', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const clickupSourceId = '00000000-0000-4000-8000-000000000123';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: clickupSourceId,
        name: 'ClickUp order status CSV upload',
        sourceType: 'clickup',
        domain: 'order_management',
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-1',
        naturalKey: 'source:order:SS7226A',
        sourceConnectionId: 'source-orders',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-1',
        externalOrderRef: 'SS7226A',
        sourceStage: 'order_detail',
        status: 'approval_pending',
        statusSource: 'google_sheets',
        payload: {},
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-2',
        naturalKey: 'source:order:EF11425C',
        sourceConnectionId: 'source-orders',
        company: 'Ecofission LLC',
        supplierId: 'supplier-2',
        externalOrderRef: 'EF11425C',
        sourceStage: 'order_detail',
        status: 'approval_pending',
        statusSource: 'google_sheets',
        payload: {},
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-3',
        naturalKey: 'source:order:MX12425B',
        sourceConnectionId: 'source-orders',
        company: 'Muxtex INC',
        supplierId: 'supplier-3',
        externalOrderRef: 'MX12425B',
        sourceStage: 'order_detail',
        status: 'approval_pending',
        statusSource: 'google_sheets',
        payload: {},
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        id: 'bronze-order-user-kiran',
        sourceDataset: 'Ecofission-Order Management - OrderDetails.csv',
        sourceRecordKey: 'order-detail-user-kiran',
        payload: { 'SA by': 'Kiran Mehtab' },
      },
    });
    await db.getRepository('users').create({
      values: {
        id: 101,
        email: 'nauman.ecofission@gmail.com',
        nickname: 'Ahmed Nauman',
      },
    });
    const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const validComments = JSON.stringify([
      {
        text: 'Will proceed with the order on Monday.',
        by: 'nauman.ecofission@gmail.com',
        assigned: false,
        date: '7/4/2026, 12:49:37 AM GMT+5',
        resolved: 'N/A',
      },
      { text: '   ', by: 'nauman.ecofission@gmail.com', date: '7/4/2026, 12:50:00 AM GMT+5' },
      { text: 'Bad date should be skipped.', by: 'nauman.ecofission@gmail.com', date: 'not a date' },
      { text: 'Impossible date.', by: 'nauman.ecofission@gmail.com', date: '2/30/2026, 1:00:00 PM GMT+5' },
      { text: 'Missing author.', date: '7/4/2026, 1:00:00 PM GMT+5' },
    ]);
    const nonMainTaskComments = JSON.stringify([
      {
        text: 'Supplier confirmed the shipment.',
        by: 'kiranecofission@gmail.com',
        assigned: false,
        date: '7/5/2026, 2:15:00 PM GMT+5',
        resolved: 'N/A',
      },
    ]);
    const content = [
      'Task ID,Task Link,Task Name,Task Content,Status,Date Created,Date Created Text,Parent ID,List Name,Comments',
      `task-main,https://app.clickup.com/t/task-main,New Order – SS7226A–Stop Shop Inc – USA – My Weigh,,approved-to-order,1782921599420,"7/1/2026, 1:00 PM GMT+5",null,Order Management (ORM),${csvCell(
        validComments,
      )}`,
      `task-invalid,https://app.clickup.com/t/task-invalid,Restock - EF11425C - Ecofission,,complete,1782921599421,"7/1/2026, 1:01 PM GMT+5",null,Order Management (ORM),${csvCell(
        '[{"text":',
      )}`,
      `task-comment,https://app.clickup.com/t/task-comment,MX12425B - Muxtex INC,,ordered,1782921599422,"7/1/2026, 1:02 PM GMT+5",null,Order Management (ORM),${csvCell(
        nonMainTaskComments,
      )}`,
    ].join('\n');

    const dryRunContext = createActionContext(db, {
      files: [{ name: 'Order Management Clickup Data 06-07-2026.csv', content }],
      importedAt: '2026-07-06T00:00:00.000Z',
    });
    await actions.importClickupOrderStatuses(dryRunContext, vi.fn());
    expect(dryRunContext.body).toMatchObject({
      data: {
        dryRun: true,
        matchedOrderCount: 2,
        selectedCommentCount: 2,
        proposedCommentCount: 2,
        importedCommentCount: 0,
        duplicateCommentCount: 0,
        invalidCommentCount: 5,
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toHaveLength(0);

    const applyContext = createActionContext(db, {
      files: [{ name: 'Order Management Clickup Data 06-07-2026.csv', content }],
      dryRun: false,
      importedAt: '2026-07-06T00:00:00.000Z',
      sourceConnectionId: clickupSourceId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(applyContext, vi.fn());
    expect(applyContext.body).toMatchObject({
      data: {
        status: 'success',
        summary: {
          clickup: {
            dryRun: false,
            proposedCommentCount: 2,
            importedCommentCount: 2,
            updatedCommentCount: 0,
            duplicateCommentCount: 0,
            invalidCommentCount: 5,
          },
        },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'supplier_order',
          entityId: 'supplier-order-1',
          commentType: 'note',
          sourceCommentKey: expect.stringContaining('clickup_comment:supplier-order-1'),
          occurredAt: '2026-07-03T19:49:37.000Z',
          createdAt: '2026-07-03T19:49:37.000Z',
          actorUserId: '101',
          body: 'Will proceed with the order on Monday.',
          contextSnapshotJson: expect.objectContaining({
            source: 'clickup_csv',
            company: 'Stop Shop LLC',
            supplierId: 'supplier-1',
            supplierOrderId: 'supplier-order-1',
            orderRef: 'SS7226A',
            actorResolution: 'mapped',
            actorUserKey: 'ahmed-nauman',
          }),
        }),
        expect.objectContaining({
          entityType: 'supplier_order',
          entityId: 'supplier-order-3',
          occurredAt: '2026-07-05T09:15:00.000Z',
          createdAt: '2026-07-05T09:15:00.000Z',
          actorUserId: expect.any(String),
          body: 'Supplier confirmed the shipment.',
          contextSnapshotJson: expect.objectContaining({
            orderRef: 'MX12425B',
            actorResolution: 'mapped',
            actorUserKey: 'kiran-mehtab',
          }),
        }),
      ]),
    );
    expect(JSON.stringify(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all())).not.toMatch(
      /gmail\.com|https?:\/\/|"taskName":|"actor":|"comment":/i,
    );
    expect(db.getRepository('users').all()).toHaveLength(10);
    expect(db.getRepository('users').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: 'nauman.ecofission@gmail.com',
          username: 'ahmed-nauman',
          nickname: 'Ahmed Nauman',
          systemSettings: {
            ecobaseAttribution: { state: 'pending_invite', loginDisabled: true, attributionOnly: true },
          },
        }),
        expect.objectContaining({
          email: 'kiranecofission@gmail.com',
          username: 'kiran-mehtab',
          nickname: 'Kiran Mehtab',
        }),
        expect.objectContaining({
          username: 'hassan-mehtab',
          nickname: 'Hassan Mehtab',
          systemSettings: {
            ecobaseAttribution: {
              state: 'pending_invite',
              loginDisabled: true,
              attributionOnly: true,
              title: 'Director',
            },
          },
        }),
      ]),
    );
    expect(
      db
        .getRepository('users')
        .all()
        .every((user) => !user.password && !user.roles && !user.permissions),
    ).toBe(true);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTasks).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTaskLinks).all()).toHaveLength(0);
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords)
        .all()
        .filter((row) => row.sourceType === 'clickup'),
    ).toHaveLength(3);
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords)
        .all()
        .filter((row) => row.sourceType === 'clickup'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceDataset: 'clickup_order_evidence',
          retentionUntil: '2026-08-05T00:00:00.000Z',
          payload: expect.objectContaining({ taskId: 'task-main', orderRef: 'SS7226A' }),
        }),
      ]),
    );

    const activityRepo = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    for (const comment of activityRepo.all()) {
      await activityRepo.update({
        filterByTk: comment.id as string,
        values: {
          occurredAt: new Date(String(comment.occurredAt)),
          createdAt: new Date(String(comment.createdAt)),
          updatedAt: new Date(String(comment.updatedAt)),
        },
      });
    }

    const rerunContext = createActionContext(db, {
      files: [{ name: 'Order Management Clickup Data 06-07-2026.csv', content: `${content}\n` }],
      dryRun: false,
      importedAt: '2026-07-06T00:00:00.000Z',
      sourceConnectionId: clickupSourceId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(rerunContext, vi.fn());
    expect(rerunContext.body).toMatchObject({
      data: {
        status: 'success',
        summary: {
          clickup: {
            proposedCommentCount: 2,
            importedCommentCount: 0,
            updatedCommentCount: 0,
            duplicateCommentCount: 2,
          },
        },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toHaveLength(2);
    expect(db.getRepository('users').all()).toHaveLength(10);

    const editedContext = createActionContext(db, {
      files: [
        {
          name: 'Order Management Clickup Data 06-07-2026.csv',
          content: content.replace('Supplier confirmed the shipment.', 'Supplier confirmed shipment and ETA.'),
        },
      ],
      dryRun: false,
      importedAt: '2026-07-07T00:00:00.000Z',
      sourceConnectionId: clickupSourceId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(editedContext, vi.fn());
    expect(editedContext.body).toMatchObject({
      data: {
        status: 'success',
        summary: {
          clickup: { importedCommentCount: 0, updatedCommentCount: 1, duplicateCommentCount: 2, createdUserCount: 0 },
        },
      },
    });
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.silverActivityComments)
        .all()
        .find((comment) => comment.entityId === 'supplier-order-3'),
    ).toMatchObject({ body: 'Supplier confirmed shipment and ETA.' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toHaveLength(2);
  });

  it('retains safe comments from unresolved actors without creating users or task entities', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const sourceConnectionId = 'clickup-source-unresolved-actor';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: sourceConnectionId, sourceType: 'clickup', domain: 'order_management', active: true },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-unresolved',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-unresolved',
        externalOrderRef: 'SS7226A',
        status: 'approval_pending',
        statusSource: 'google_sheets',
      },
    });
    const comments = JSON.stringify([
      {
        text: 'Supplier confirmed shipment.',
        by: 'Unknown Contractor',
        date: '7/5/2026, 2:15:00 PM GMT+5',
      },
      {
        text: 'Email unknown@example.com with token abc.',
        by: 'Unknown Contractor',
        date: '7/5/2026, 2:16:00 PM GMT+5',
      },
    ]).replace(/"/g, '""');
    const content = [
      'Task ID,Task Name,Status,Date Created,Comments',
      `task-unresolved,New Order SS7226A Stop Shop,ordered,1782921599420,"${comments}"`,
    ].join('\n');

    const context = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(context, vi.fn());

    expect(context.body).toMatchObject({
      data: {
        status: 'success',
        summary: {
          clickup: {
            selectedCommentCount: 2,
            proposedCommentCount: 1,
            importedCommentCount: 1,
            unresolvedActors: ['Unknown Contractor'],
            actorMappings: [
              {
                sourceActor: 'Unknown Contractor',
                occurrenceCount: 2,
                resolution: 'unresolved',
              },
            ],
          },
        },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toEqual([
      expect.objectContaining({
        entityId: 'supplier-order-unresolved',
        actorType: 'external',
        actorUserId: undefined,
        body: 'Supplier confirmed shipment.',
        contextSnapshotJson: expect.objectContaining({
          actorResolution: 'unresolved',
          sourceActorHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }),
      }),
    ]);
    expect(JSON.stringify(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all())).not.toMatch(
      /Unknown Contractor|unknown@example\.com|task-unresolved/,
    );
    expect(db.getRepository('users').all()).toHaveLength(10);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTasks).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTaskLinks).all()).toHaveLength(0);
  });

  it('reconciles retained ClickUp evidence after its order is imported', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const clickupSourceId = '00000000-0000-4000-8000-000000000456';
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: clickupSourceId,
        name: 'ClickUp order status CSV upload',
        sourceType: 'clickup',
        domain: 'order_management',
        active: true,
      },
    });
    const comments = JSON.stringify([
      {
        text: 'Supplier confirmed the order.',
        by: 'kiranecofission@gmail.com',
        date: '7/5/2026, 2:15:00 PM GMT+5',
      },
    ]).replace(/"/g, '""');
    const content = [
      'Task ID,Task Name,Status,Date Created,Date Created Text,Comments',
      `task-early,New Order SS7226A Stop Shop,ordered,1782921599420,"7/1/2026, 1:00 PM GMT+5","${comments}"`,
    ].join('\n');

    const earlyContext = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      sourceIdentifier: 'clickup-reconcile-test',
      importedAt: '2026-07-06T00:00:00.000Z',
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(earlyContext, vi.fn());
    expect(earlyContext.body).toMatchObject({
      data: {
        status: 'success',
        summary: { clickup: { unmatchedRefCount: 1, importedCommentCount: 0, createdUserCount: 10 } },
      },
    });
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords)
        .all()
        .filter((row) => row.sourceType === 'clickup'),
    ).toHaveLength(1);

    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'supplier-order-early',
        company: 'Stop Shop LLC',
        supplierId: 'supplier-early',
        externalOrderRef: 'SS7226A',
        status: 'approval_pending',
        statusSource: 'google_sheets',
      },
    });
    const skippedReconcileContext = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      sourceIdentifier: 'clickup-reconcile-test',
      importedAt: '2026-07-07T00:00:00.000Z',
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(skippedReconcileContext, vi.fn());
    expect(skippedReconcileContext.body).toMatchObject({ data: { status: 'skipped' } });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toHaveLength(0);

    const reconcileContext = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      sourceIdentifier: 'clickup-reconcile-test',
      importedAt: '2026-07-07T00:00:00.000Z',
      forceReconcile: true,
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(reconcileContext, vi.fn());
    expect(reconcileContext.body).toMatchObject({
      data: {
        status: 'success',
        summary: { clickup: { unmatchedRefCount: 0, importedCommentCount: 1, createdUserCount: 0 } },
      },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toHaveLength(1);
    expect(db.getRepository('users').all()).toHaveLength(10);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverTasks).all()).toHaveLength(0);

    const unchangedContext = createActionContext(db, {
      files: [{ name: 'clickup.csv', content }],
      dryRun: false,
      sourceConnectionId: clickupSourceId,
      sourceIdentifier: 'clickup-reconcile-test',
      importedAt: '2026-07-08T00:00:00.000Z',
      skipGoldRefresh: true,
    });
    await actions.importClickupOrderStatuses(unchangedContext, vi.fn());
    expect(unchangedContext.body).toMatchObject({ data: { status: 'skipped' } });
  });

  it('normalizes pending legacy Bronze rows without creating Amazon identity', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'Master stock',
        company: 'Ecofission LLC',
        sourceType: 'google_sheets',
        domain: 'inventory',
        config: {},
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: { id: 'import-1', sourceConnectionId: 'source-1', status: 'success' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        id: 'bronze-1',
        sourceConnectionId: 'source-1',
        importRunId: 'import-1',
        sourceType: 'google_sheets',
        sourceDataset: 'MasterStock.csv',
        sourceRecordKey: 'MasterStock.csv:B00PUSNY5A:W101',
        rowHash: 'hash-1',
        observedAt: '2026-07-10T00:00:00.000Z',
        payload: {
          Company: 'Ecofission LLC',
          ASIN: 'B00PUSNY5A',
          SKU: 'W101',
          'FBA/FBM Stock': '386',
        },
        normalizationStatus: 'pending',
      },
    });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(db, { sourceConnectionId: 'source-1', limit: 10 });
    const next = vi.fn();

    await actions.normalizeBronzeToSilver(context, next);

    expect(context.body.data.errors).toEqual([]);
    expect(context.body).toMatchObject({ data: { normalized: 1, failed: 0 } });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).all()).toHaveLength(0);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()[0].normalizationStatus).toBe('normalized');
    expect(next).toHaveBeenCalledOnce();
  });

  it('exposes missing required source warnings through the status action', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: { warningPolicy: { required: true } },
        active: true,
      },
    });
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(db);

    await actions.status(context, vi.fn());

    expect(context.body).toEqual({
      data: [
        expect.objectContaining({
          sourceConnectionId: 'source-1',
          required: true,
          warningCount: 1,
          latestWarning: expect.objectContaining({ code: 'missing_required_source' }),
          warnings: [
            expect.objectContaining({
              code: 'missing_required_source',
              message: 'Required source "No-op source" has no successful import run.',
            }),
          ],
        }),
      ],
    });
  });

  it('rejects run requests without sourceConnectionId', async () => {
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(new MemoryDatabase());

    await expect(actions.runNoop(context, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'Ecobase no-op import requires sourceConnectionId.',
    });
  });

  it('analyzes CSV bundles and creates matching manual CSV source connections', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([googleSheetsMigrationCsvAdapter]));
    const analyzeContext = createActionContext(db, {
      files: [{ name: 'Supplier IDs.csv', content: 'Company,SR ID,Supplier Name\nEcofission LLC,SRO-36,3Dmatsusa' }],
    });
    await actions.analyzeCsvBundle(analyzeContext, vi.fn());

    expect(analyzeContext.body.data).toMatchObject({
      files: [
        expect.objectContaining({
          detectedShape: 'supplier-ids',
          adapterName: 'google-sheets-migration-csv',
          importable: true,
        }),
      ],
      groups: [
        expect.objectContaining({
          adapterName: 'google-sheets-migration-csv',
          sourceType: 'google_sheets',
          domain: 'order_management',
        }),
      ],
    });

    const saveContext = createActionContext(db, {
      name: 'Order CSV upload',
      companyName: 'Ecofission LLC',
      sourceType: 'google_sheets',
      domain: 'order_management',
    });
    await actions.saveCsvSourceConnection(saveContext, vi.fn());

    expect(saveContext.body.data).toMatchObject({
      name: 'Order CSV upload',
      sourceType: 'google_sheets',
      domain: 'order_management',
      config: { manualCsvBundle: true },
      active: true,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).all()).toEqual([
      expect.objectContaining({ name: 'Ecofission LLC' }),
    ]);

    const clickupContext = createActionContext(db, {
      name: 'ClickUp order status CSV upload',
      sourceType: 'clickup',
      domain: 'order_management',
    });
    await actions.saveCsvSourceConnection(clickupContext, vi.fn());

    expect(clickupContext.body.data).toMatchObject({
      name: 'ClickUp order status CSV upload',
      sourceType: 'clickup',
      domain: 'order_management',
      config: { manualCsvBundle: true },
      active: true,
    });
  });

  it('ensures default manual CSV source connections', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'legacy-buybox-csv-source',
        name: 'seller_central_file amazon_operations CSV upload',
        sourceType: 'seller_central_file',
        domain: 'amazon_operations',
        config: { manualCsvBundle: true },
        active: true,
      },
    });

    await new EcobaseSourceConnectionService(db).ensureDefaultCsvSourceConnections();
    await new EcobaseSourceConnectionService(db).ensureDefaultCsvSourceConnections();

    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Supplier Management CSV upload',
          sourceType: 'google_sheets',
          domain: 'supplier_management',
        }),
        expect.objectContaining({
          name: 'Order Management CSV upload',
          sourceType: 'google_sheets',
          domain: 'order_management',
        }),
        expect.objectContaining({
          name: 'ClickUp order status CSV upload',
          sourceType: 'clickup',
          domain: 'order_management',
        }),
        expect.objectContaining({
          id: 'legacy-buybox-csv-source',
          name: 'Buybox / Amazon Operations CSV upload',
          sourceType: 'seller_central_file',
          domain: 'amazon_operations',
        }),
      ]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()).toHaveLength(4);
  });

  it('lists available adapters through the public action', async () => {
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const context = createActionContext(new MemoryDatabase());
    const next = vi.fn();

    await actions.adapters(context, next);

    expect(context.body).toEqual({
      data: [
        expect.objectContaining({
          name: 'noop-test',
          sourceType: 'noop_test',
          title: 'No-op test adapter',
        }),
      ],
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('saves, lists, and deletes Sellerboard live source configuration', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));

    const saveContext = createActionContext(db, {
      name: 'Sellerboard Live Company',
      companyName: 'Ecofission LLC',
      timezone: 'UTC',
      dailyRefreshTime: '02:30',
      refreshIntervalMinutes: 720,
      retryIntervalMinutes: 45,
      freshnessSlaMinutes: 180,
      active: true,
      scheduleEnabled: true,
      reportUrls: [
        {
          name: 'Profit Dashboard Data',
          category: 'profit_dashboard',
          url: 'https://app.sellerboard.com/report.csv',
        },
      ],
    });

    await actions.saveSellerboardSource(saveContext, vi.fn());
    const source = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()[0];
    expect(source).toMatchObject({
      name: 'Sellerboard Live Company',
      sourceType: 'sellerboard',
      domain: 'amazon_operations',
      active: true,
      freshnessSlaMinutes: 180,
      config: {
        requireFreshData: true,
        schedule: { enabled: true, dailyRefreshTime: '02:30', refreshIntervalMinutes: 720, retryIntervalMinutes: 45 },
        reportUrls: [
          {
            name: 'Profit Dashboard Data',
            category: 'profit_dashboard',
            url: 'https://app.sellerboard.com/report.csv',
          },
        ],
      },
    });

    const latestRun = await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'sellerboard-run-1',
        sourceConnectionId: source.id,
        adapterName: 'sellerboard-api',
        sourceIdentifier: 'sellerboard-scheduled',
        sourceVersion: '2026-06-08T17:25:00.000Z',
        startedAt: '2026-06-08T17:20:00.000Z',
        finishedAt: '2026-06-08T17:21:00.000Z',
        status: 'partial',
        rowCount: 308,
        normalizedCount: 924,
        warningCount: 0,
        errorCount: 2,
        errorMessage: 'Sellerboard live import failed: URL returned HTTP 401.',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: {
        importRunId: latestRun.id,
        sourceConnectionId: source.id,
        rowNumber: 0,
        sourceKey: 'profit_dashboard:Profit Dashboard Data',
        normalizationStatus: 'failed',
        normalizedError: 'Sellerboard live import failed: URL returned HTTP 401.',
        issueSeverity: 'error',
        issueCode: 'sellerboard_live_fetch_failed',
        payload: { reportName: 'Profit Dashboard Data', category: 'profit_dashboard' },
      },
    });

    const listContext = createActionContext(db);
    await actions.listSellerboardSources(listContext, vi.fn());
    expect(listContext.body.data).toEqual([
      expect.objectContaining({
        sourceConnectionId: source.id,
        name: 'Sellerboard Live Company',
        companyName: 'Ecofission LLC',
        reportUrls: [expect.objectContaining({ category: 'profit_dashboard' })],
        schedule: { enabled: true, dailyRefreshTime: '02:30', refreshIntervalMinutes: 720, retryIntervalMinutes: 45 },
        latestRunStatus: 'partial',
        latestRunWarningCount: 0,
        latestRunErrorCount: 2,
        latestRunErrorMessage: 'Sellerboard live import failed: URL returned HTTP 401.',
        latestRunLogs: [
          expect.objectContaining({
            importRunId: 'sellerboard-run-1',
            status: 'partial',
            issues: [
              expect.objectContaining({
                severity: 'error',
                code: 'sellerboard_live_fetch_failed',
                message: 'Sellerboard live import failed: URL returned HTTP 401.',
              }),
            ],
          }),
        ],
      }),
    ]);

    const deleteContext = createActionContext(db, { sourceConnectionId: String(source.id) });
    await actions.deleteSellerboardSource(deleteContext, vi.fn());
    expect(deleteContext.body.data).toMatchObject({
      sourceConnectionId: source.id,
      deleted: true,
      deletedImportRuns: 1,
      deletedSourceOwnedRows: 1,
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([]);
  });
});

describe('Ecobase alert public API seam', () => {
  it('evaluates deterministic alerts through the public resource action and lists open alerts', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'alert-gold-row',
        calculationDate: '2025-07-10',
        companyProductId: 'alert-product-1',
        company: 'Alerts LLC',
        asin: 'B010API',
        title: 'API alert product',
        actionStatus: 'overdue',
        commandCenterPane: 'supplyAction',
        supplierOrderState: 'no_open_order',
        currentPlanningStock: 0,
        salesVelocity: 4,
        leadTimeDays: 10,
        profitPerUnit: 5,
        suggestedReorderQty: 20,
        estimatedOosDate: '2025-07-10',
        estimatedProfitRisk: 100,
      },
    });

    const actions = createEcobaseAlertActions();
    const evaluateContext = createActionContext(db, {
      planningProductId: 'alert-product-1',
      calculationDate: '2025-07-10',
    });
    await actions.evaluate(evaluateContext, vi.fn());

    expect(evaluateContext.body.data.productCount).toBe(1);
    expect(evaluateContext.body.data.summaries[0].rootCauseCodes).toContain('current_oos');
    expect(evaluateContext.body.data.summaries[0].rootCauseCodes).toContain('no_supplier_order_placed');

    const listContext = createActionContext(db, { company: 'Alerts LLC', status: 'open' });
    await actions.list(listContext, vi.fn());
    expect(listContext.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alertType: 'oos',
          primaryRootCauseCode: 'current_oos',
          actionRequired: 'Restore sellable Amazon stock immediately or confirm an active recovery order.',
        }),
      ]),
    );
  });
});

describe('Ecobase supplier-management public API seam', () => {
  it('drives medallion supplier lifecycle, comments, and risk digest actions', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Money LLC', companyKey: 'money' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-a', asin: 'B0MONEY', sku: 'SKU-MONEY', title: 'Money Product' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: {
        id: 'supplier-a',
        normalizedName: 'high value supplier',
        displayName: 'High Value Supplier',
        approvalStatus: 'contacting',
        nextFollowUpAt: '2025-07-09T00:00:00.000Z',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'inventory-risk-a',
        calculationDate: '2025-07-10',
        companyName: 'Money LLC',
        supplierId: 'supplier-a',
        supplierName: 'High Value Supplier',
        asin: 'B0MONEY',
        sku: 'SKU-MONEY',
        actionStatus: 'missing_lead_time',
        estimatedProfitRisk: 5000,
        leadTimeFreshness: 'missing',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).create({
      values: {
        id: 'order-risk-a',
        orderRef: 'HIGH-1',
        companyName: 'Money LLC',
        supplierId: 'supplier-a',
        supplierName: 'High Value Supplier',
        currentStatus: 'ORDERED',
        daysSinceLastActivity: 8,
        moneyAtRisk: 1200,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).create({
      values: {
        id: 'order-complete-a',
        orderRef: 'HIGH-CLOSED',
        companyName: 'Money LLC',
        supplierId: 'supplier-a',
        supplierName: 'High Value Supplier',
        currentStatus: 'COMPLETE',
        daysSinceLastActivity: 30,
        moneyAtRisk: 9000,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: 'comment-a',
        entityType: 'supplier',
        entityId: 'supplier-a',
        actorType: 'user',
        commentType: 'note',
        body: 'Waiting for supplier price list.',
        followUpAt: '2025-07-09T00:00:00.000Z',
        createdAt: '2025-07-08T00:00:00.000Z',
      },
    });

    const actions = createEcobaseSupplierManagementActions();
    const digestContext = createActionContext(db, { company: 'Money LLC', calculationDate: '2025-07-10' });
    await actions.refreshAttentionRows(digestContext, vi.fn());
    expect(digestContext.body.data.summary).toMatchObject({
      contactToday: 1,
      overdueFollowUps: 1,
      staleOrderSuppliers: 1,
      leadTimeIssueSuppliers: 1,
      waitingApprovalSuppliers: 0,
      moneyAtRisk: 6200,
    });
    expect(digestContext.body.data.rows[0]).toMatchObject({
      supplierId: 'supplier-a',
      lifecycleStatus: 'approved',
      followUpState: 'overdue',
      lastComment: 'Waiting for supplier price list.',
      moneyAtRisk: 6200,
      recommendedAction: 'Contact supplier today',
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldSupplierAttentionRows).all()).toEqual([
      expect.objectContaining({ supplierId: 'supplier-a', lifecycleStatus: 'approved', moneyAtRisk: 6200 }),
    ]);
    const nextDigestContext = createActionContext(db, { company: 'Money LLC', calculationDate: '2025-07-11' });
    await actions.refreshAttentionRows(nextDigestContext, vi.fn());
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldSupplierAttentionRows).all()).toHaveLength(2);
    expect(await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).findOne({ filterByTk: 'supplier-a' })).toEqual(
      expect.objectContaining({ approvalStatus: 'approved' }),
    );

    const createContext = createActionContext(db, { name: 'New Partner', notes: 'Start first outreach.' });
    await actions.createSupplier(createContext, vi.fn());
    expect(createContext.body.data).toMatchObject({ displayName: 'New Partner', approvalStatus: 'new' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: createContext.body.data.id, body: 'Start first outreach.' }),
      ]),
    );

    const productOptionsContext = createActionContext(db, { search: 'B0MONEY' });
    await actions.productOptions(productOptionsContext, vi.fn());
    expect(productOptionsContext.body.data).toEqual([
      expect.objectContaining({ value: 'product-a', asin: 'B0MONEY', sku: 'SKU-MONEY' }),
    ]);

    const blockedApprovalContext = createActionContext(db, {
      supplierId: createContext.body.data.id,
      status: 'approved',
      comment: 'Approve supplier.',
    });
    await expect(actions.updateSupplierLifecycle(blockedApprovalContext, vi.fn())).rejects.toThrow(
      'approve at least one supplier product first',
    );

    const productContext = createActionContext(db, {
      supplierId: 'supplier-a',
      productId: 'product-a',
      analysisStatus: 'approved',
      leadTimeDays: 21,
    });
    await actions.upsertSupplierProduct(productContext, vi.fn());
    expect(productContext.body.data).toMatchObject({
      supplierId: 'supplier-a',
      productId: 'product-a',
      analysisStatus: 'approved',
    });

    const accountContext = createActionContext(db, {
      company: 'Money LLC',
      supplierId: 'supplier-a',
      accountName: 'High Value Account',
      status: 'approved',
    });
    await actions.updateSupplierAccount(accountContext, vi.fn());
    expect(accountContext.body.data).toMatchObject({ supplierId: 'supplier-a', status: 'approved' });

    const approvalContext = createActionContext(db, {
      supplierId: 'supplier-a',
      status: 'approved',
      comment: 'Product fit and account access confirmed.',
    });
    await actions.updateSupplierLifecycle(approvalContext, vi.fn());
    expect(approvalContext.body.data).toMatchObject({ approvalStatus: 'approved' });

    const detailContext = createActionContext(db, {
      company: 'Money LLC',
      supplierId: 'supplier-a',
      calculationDate: '2025-07-10',
    });
    await actions.detail(detailContext, vi.fn());
    expect(detailContext.body.data).toMatchObject({
      supplier: expect.objectContaining({ id: 'supplier-a', approvalStatus: 'approved' }),
      latestComment: expect.objectContaining({ body: 'Product fit and account access confirmed.' }),
    });
    expect(detailContext.body.data.supplierProducts).toEqual([
      expect.objectContaining({ asin: 'B0MONEY', sku: 'SKU-MONEY', analysisStatus: 'approved' }),
    ]);
    expect(detailContext.body.data.inventoryRisks).toEqual([expect.objectContaining({ id: 'inventory-risk-a' })]);
    expect(detailContext.body.data.orderRisks).toEqual([expect.objectContaining({ id: 'order-risk-a' })]);

    const createOrderContext = createActionContext(db, {
      company: 'Money LLC',
      supplierId: 'supplier-a',
      externalOrderRef: 'SUP-PO-1',
      status: 'draft',
    });
    await actions.createSupplierOrder(createOrderContext, vi.fn());
    expect(createOrderContext.body.data).toMatchObject({
      supplierId: 'supplier-a',
      orderRef: 'SUP-PO-1',
      lifecycleStatus: 'draft',
    });
  });

  it('keeps all-unknown supplier risk totals null', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-unknown-risk', displayName: 'Unknown Risk Supplier', approvalStatus: 'approved' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: 'inventory-unknown-risk',
        calculationDate: '2026-07-13',
        supplierId: 'supplier-unknown-risk',
        supplierName: 'Unknown Risk Supplier',
        company: 'Current Only Inc',
        estimatedProfitRisk: null,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.goldOrderPlanningRows).create({
      values: {
        id: 'order-unknown-risk',
        calculationDate: '2026-07-13',
        supplierId: 'supplier-unknown-risk',
        supplierName: 'Unknown Risk Supplier',
        companyName: 'Current Only Inc',
        currentStatus: 'ORDERED',
        statusCheckRequired: true,
        moneyAtRisk: null,
      },
    });

    const context = createActionContext(db, { company: 'Current Only Inc', calculationDate: '2026-07-13' });
    await createEcobaseSupplierManagementActions().refreshAttentionRows(context, vi.fn());

    expect(context.body.data.summary).toMatchObject({ moneyAtRisk: null });
    expect(context.body.data.rows).toEqual([
      expect.objectContaining({
        supplierId: 'supplier-unknown-risk',
        inventoryMoneyAtRisk: null,
        orderMoneyAtRisk: null,
        moneyAtRisk: null,
      }),
    ]);
  });
});

describe('Ecobase Silver Data operator API', () => {
  async function seedSilverData(db: MemoryDatabase) {
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-1', asin: 'B00HHCWH0K', sku: '450316', title: 'Copper Wire', brand: 'Muxtex' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverProducts).create({
      values: { id: 'product-2', asin: 'B07YQ9JYMY', sku: 'B-104C', title: 'Pool Set', brand: 'Aramith' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Muxtex INC', companyKey: 'muxtex' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-1', companyId: 'company-1', productId: 'product-1', lifecycleStatus: 'active' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-2', companyId: 'company-1', productId: 'product-2', lifecycleStatus: 'active' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-1', displayName: 'edhoy', normalizedName: 'edhoy', approvalStatus: 'approved' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-1', supplierId: 'supplier-1', productId: 'product-1', supplierSku: 'ED-450316' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-2', supplierId: 'supplier-1', productId: 'product-2', supplierSku: 'ED-B104C' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-1',
        companyId: 'company-1',
        supplierId: 'supplier-1',
        orderRef: 'MX21324A',
        trackingId: 'TRK-1',
        orderDate: '2026-06-10',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-2',
        companyId: 'company-1',
        supplierId: 'supplier-1',
        orderRef: 'MX99999A',
        trackingId: 'TRK-2',
        orderDate: '2026-05-20',
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-1',
        orderId: 'order-1',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 12,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-2',
        orderId: 'order-1',
        companyProductId: 'company-product-2',
        supplierProductId: 'supplier-product-2',
        orderedQty: 4,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverInvoices).create({
      values: { id: 'invoice-1', orderId: 'order-1', invoiceNumber: 'INV-10481', status: 'waiting' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTasks).create({
      values: { id: 'task-1', title: 'Follow up edhoy', status: 'open' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTaskLinks).create({
      values: { id: 'task-link-1', taskId: 'task-1', entityType: 'supplier', entityId: 'supplier-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverHumanApprovals).create({
      values: { id: 'approval-1', title: 'Approve order change', actionType: 'update_order', status: 'pending' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverHumanApprovalLinks).create({
      values: { id: 'approval-link-1', humanApprovalId: 'approval-1', entityType: 'order', entityId: 'order-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverTargets).create({
      values: {
        id: 'target-1',
        entityType: 'product',
        entityId: 'product-1',
        metric: 'profit',
        periodType: 'month',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        targetValue: 100,
      },
    });
  }

  it('searches across product, supplier, order, and invoice keys', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { query: '450316' });

    await actions.search(context, vi.fn());

    expect(context.body?.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'product', id: 'product-1' }),
        expect.objectContaining({ type: 'orderLine', id: 'order-line-1' }),
      ]),
    );

    const supplierContext = createActionContext(db, { query: 'edhoy' });
    await actions.search(supplierContext, vi.fn());
    expect(supplierContext.body?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'supplier', id: 'supplier-1' })]),
    );

    const orderContext = createActionContext(db, { query: 'MX21324A' });
    await actions.search(orderContext, vi.fn());
    expect(orderContext.body?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'order', id: 'order-1' })]),
    );

    const invoiceContext = createActionContext(db, { query: 'INV-10481' });
    await actions.search(invoiceContext, vi.fn());
    expect(invoiceContext.body?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'invoice', id: 'invoice-1' })]),
    );
  });

  it('looks up bounded entity types without global cross-table matches', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();

    const supplierContext = createActionContext(db, { type: 'supplier', query: 'edhoy' });
    await actions.lookup(supplierContext, vi.fn());
    expect(supplierContext.body?.data).toEqual([expect.objectContaining({ type: 'supplier', id: 'supplier-1' })]);

    const productContext = createActionContext(db, { type: 'product', query: '450316' });
    await actions.lookup(productContext, vi.fn());
    expect(productContext.body?.data).toEqual([expect.objectContaining({ type: 'product', id: 'product-1' })]);

    const orderContext = createActionContext(db, { type: 'order', query: 'MX21324A' });
    await actions.lookup(orderContext, vi.fn());
    expect(orderContext.body?.data).toEqual([expect.objectContaining({ type: 'order', id: 'order-1' })]);
  });

  it('applies date filters to bounded lookup and linked context', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();

    const lookup = createActionContext(db, {
      type: 'order',
      query: 'MX',
      dateFrom: '2026-06-10',
      dateTo: '2026-06-10',
    });
    await actions.lookup(lookup, vi.fn());
    expect(lookup.body?.data).toEqual([expect.objectContaining({ type: 'order', id: 'order-1' })]);

    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-2', name: 'Other LLC', companyKey: 'other' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-3',
        companyId: 'company-2',
        supplierId: 'supplier-1',
        orderRef: 'OT11111A',
        orderDate: '2026-06-10',
      },
    });

    const context = createActionContext(db, {
      focus: { type: 'company', id: 'company-1' },
      dateFrom: '2026-06-10',
      dateTo: '2026-06-10',
      pageSize: 100,
    });
    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('companies')).toEqual(['company-1']);
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orders')).not.toContain('order-2');
    expect(ids('orders')).not.toContain('order-3');
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
  });

  it('resolves search matches into linked records without unrelated same-order products', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { query: '450316', pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('products')).toContain('product-1');
    expect(ids('companyProducts')).toContain('company-product-1');
    expect(ids('supplierProducts')).toContain('supplier-product-1');
    expect(ids('orderLines')).toContain('order-line-1');
    expect(ids('orders')).toContain('order-1');
    expect(ids('products')).not.toContain('product-2');
    expect(ids('orderLines')).not.toContain('order-line-2');
  });

  it('keeps order focus scoped to the selected order only', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-2',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'order', id: 'order-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
    expect(ids('orderLines')).not.toContain('order-line-3');
  });

  it('keeps supplier focus scoped to the selected supplier', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-2', displayName: 'Delphi Glass', normalizedName: 'delphi glass' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).create({
      values: { id: 'supplier-product-3', supplierId: 'supplier-2', productId: 'product-1', supplierSku: 'DG-450316' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: { id: 'order-3', companyId: 'company-1', supplierId: 'supplier-2', orderRef: 'DG11111A' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-3',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-3',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'supplier', id: 'supplier-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('suppliers')).toEqual(['supplier-1']);
    expect(ids('supplierProducts')).toEqual(expect.arrayContaining(['supplier-product-1', 'supplier-product-2']));
    expect(ids('supplierProducts')).not.toContain('supplier-product-3');
    expect(ids('orderLines')).not.toContain('order-line-3');

    const searchContext = createActionContext(db, { query: 'edhoy', pageSize: 100 });
    await actions.context(searchContext, vi.fn());
    const searchSections = searchContext.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const searchIds = (key: string) =>
      searchSections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(searchIds('suppliers')).toEqual(['supplier-1']);
    expect(searchIds('supplierProducts')).not.toContain('supplier-product-3');
  });

  it('keeps order-line focus scoped to the selected line and its order', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-2',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'orderLine', id: 'order-line-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('products')).toEqual(['product-1']);
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orderLines')).toEqual(['order-line-1']);
    expect(ids('invoices')).toEqual(['invoice-1']);
  });

  it('resolves invoice focus through its order lines and products', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'invoice', id: 'invoice-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('invoices')).toEqual(['invoice-1']);
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('products')).toEqual(expect.arrayContaining(['product-1', 'product-2']));
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
  });

  it('keeps exact order search scoped to the matched order only', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: {
        id: 'order-line-3',
        orderId: 'order-2',
        companyProductId: 'company-product-1',
        supplierProductId: 'supplier-product-1',
        orderedQty: 2,
      },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { query: 'MX21324A', pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('orders')).toEqual(['order-1']);
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
    expect(ids('orderLines')).not.toContain('order-line-3');
  });

  it('resolves company focus into only that company products and orders', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-2', name: 'Other LLC', companyKey: 'other' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).create({
      values: { id: 'company-product-3', companyId: 'company-2', productId: 'product-1', lifecycleStatus: 'active' },
    });
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'company', id: 'company-1' }, pageSize: 100 });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('companies')).toEqual(['company-1']);
    expect(ids('products')).toEqual(expect.arrayContaining(['product-1', 'product-2']));
    expect(ids('companyProducts')).toEqual(expect.arrayContaining(['company-product-1', 'company-product-2']));
    expect(ids('companyProducts')).not.toContain('company-product-3');
    expect(ids('orders')).toEqual(expect.arrayContaining(['order-1', 'order-2']));
    expect(ids('orderLines')).toEqual(expect.arrayContaining(['order-line-1', 'order-line-2']));
  });

  it('resolves product focus into related orders, lines, supplier, tasks, approvals, and targets', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();
    const context = createActionContext(db, { focus: { type: 'product', id: 'product-1' } });

    await actions.context(context, vi.fn());

    const sections = context.body?.data.sections as Array<{ key: string; rows: Record<string, unknown>[] }>;
    const ids = (key: string) => sections.find((section) => section.key === key)?.rows.map((row) => row.id) ?? [];
    expect(ids('companyProducts')).toContain('company-product-1');
    expect(ids('supplierProducts')).toContain('supplier-product-1');
    expect(ids('orderLines')).toContain('order-line-1');
    expect(ids('orders')).toContain('order-1');
    expect(ids('invoices')).toContain('invoice-1');
    expect(ids('tasks')).toContain('task-1');
    expect(ids('approvals')).toContain('approval-1');
    expect(ids('targets')).toContain('target-1');
    expect(ids('products')).not.toContain('product-2');
    expect(ids('orders')).not.toContain('order-2');
    expect(ids('orderLines')).not.toContain('order-line-2');
  });

  it('restricts supplier repair preview and apply to root or admin roles', async () => {
    const db = new MemoryDatabase();
    const actions = createEcobaseSupplierManagementActions();
    const memberPreview = createActionContext(db, {}, undefined, ['member']);
    const memberApply = createActionContext(db, {}, undefined, ['member']);
    const memberEvidence = createActionContext(db, {}, undefined, ['member']);

    await expect(actions.previewSupplierResolutionRepair(memberPreview, vi.fn())).rejects.toMatchObject({
      status: 403,
    });
    await expect(actions.applySupplierResolutionRepair(memberApply, vi.fn())).rejects.toMatchObject({ status: 403 });
    await expect(actions.previewSupplierEvidenceBackfill(memberEvidence, vi.fn())).rejects.toMatchObject({
      status: 403,
    });

    const adminPreview = createActionContext(db, {}, undefined, ['admin']);
    const adminEvidence = createActionContext(db, {}, undefined, ['admin']);
    await expect(actions.previewSupplierResolutionRepair(adminPreview, vi.fn())).rejects.toMatchObject({ status: 400 });
    await expect(actions.previewSupplierEvidenceBackfill(adminEvidence, vi.fn())).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects read-only updates and links drawer comments to the selected entity', async () => {
    const db = new MemoryDatabase();
    await seedSilverData(db);
    const actions = createEcobaseSilverDataActions();

    const rejected = createActionContext(db, { type: 'product', id: 'product-1', values: { id: 'bad' } });
    await expect(actions.updateRecord(rejected, vi.fn())).rejects.toThrow('read-only fields rejected: id');

    const update = createActionContext(db, {
      type: 'product',
      id: 'product-1',
      values: { title: 'Updated Copper Wire' },
    });
    await actions.updateRecord(update, vi.fn());
    expect(update.body?.data.record.title).toBe('Updated Copper Wire');

    const comment = createActionContext(db, {
      type: 'product',
      id: 'product-1',
      body: 'Operator confirmed SKU mapping.',
    });
    await actions.addComment(comment, vi.fn());
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).all()).toEqual([
      expect.objectContaining({
        entityType: 'product',
        entityId: 'product-1',
        body: 'Operator confirmed SKU mapping.',
      }),
    ]);
  });
});
