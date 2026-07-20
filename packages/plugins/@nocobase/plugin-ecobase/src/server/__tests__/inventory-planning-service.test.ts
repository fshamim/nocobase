/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import {
  calculateInventoryMoneyRisk,
  commandCenterPaneForRow,
  EcobaseInventoryPlanningService,
  expectedArrivalEvidence,
  supplierCoverageStatus,
} from '../../features/inventory-planning/server/inventory-planning-service';
import { profitTierMovement } from '../../features/inventory-planning/server/profit-tier';
import { EcobaseCompanyProductFamilyService } from '../../features/inventory-planning/server/company-product-family-service';
import { EcobaseSilverIntegrityVerifier } from '../../features/inventory-planning/server/silver-integrity-verifier';
import { EcobaseSupplierOrderService } from '../../features/supplier-management/server/supplier-order-service';
import { EcobaseDailyOperationsBriefService } from '../../features/daily-operations-brief/server/daily-operations-brief-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { currentOnlyAcceptanceFixture } from './fixtures/current-only-acceptance';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  readonly findCalls: FindParams[] = [];

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    this.findCalls.push(params);
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
      throw new Error('MemoryRepository update failed: matching record was not found.');
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
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
        if (typeof expected === 'object' && expected !== null && Array.isArray((expected as { $in?: unknown[] }).$in)) {
          return (expected as { $in: unknown[] }).$in.includes(record[key]);
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
      if (leftValue === rightValue) return 0;
      const result = leftValue > rightValue ? 1 : -1;
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor({ historyLoaded = true }: { historyLoaded?: boolean } = {}) {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository()));
    if (historyLoaded) {
      this.repositories.set(
        ECOBASE_COLLECTIONS.importRuns,
        new MemoryRepository([
          {
            id: 'history-import-evidence',
            adapterName: 'sellerboard-history-csv',
            status: 'success',
            normalizedCount: 1,
          },
        ]),
      );
    }
    this.repositories.set('users', new MemoryRepository());
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) {
      throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    }
    return repository;
  }
}

async function createRecord(db: MemoryDatabase, collection: string, values: Record<string, unknown>) {
  if (collection === ECOBASE_COLLECTIONS.goldInventoryPlanningRows && !values.refreshRunId) {
    const calculationDate = String(values.calculationDate ?? '2026-07-15');
    const runId = `test-published-gold:${calculationDate}`;
    const runs = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns);
    const existingRun = await runs.findOne({ filterByTk: runId });
    if (!existingRun) {
      for (const published of await runs.find({ filter: { status: 'published' } })) {
        await runs.update({ filterByTk: published.id as string, values: { status: 'succeeded' } });
      }
      await runs.create({
        values: {
          id: runId,
          idempotencyKey: runId,
          requestDigest: runId,
          calculationDate,
          status: 'published',
          publishedAt: `${calculationDate}T00:00:00.000Z`,
        },
      });
    }
    values.refreshRunId = runId;
  }
  if (collection === ECOBASE_COLLECTIONS.goldInventoryPlanningRows) {
    const goldCalculationDate = String(values.calculationDate ?? '2026-07-15');
    const companyProductId = String(values.companyProductId ?? values.planningProductId ?? values.id);
    const companyProductFamilyId = String(values.companyProductFamilyId ?? `test-family:${companyProductId}`);
    const existingFamilyTarget = db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .all()
      .find(
        (row) =>
          row.companyProductFamilyId === companyProductFamilyId &&
          (row.familyRole === 'target' || row.isFrozenFamilyTarget === true),
      );
    const targetCompanyProductId =
      values.familyRole === 'review'
        ? null
        : String(
            values.familyTargetCompanyProductId ??
              values.replenishmentTargetCompanyProductId ??
              existingFamilyTarget?.companyProductId ??
              companyProductId,
          );
    values.companyProductId = companyProductId;
    values.planningProductId ??= companyProductId;
    values.companyProductFamilyId = companyProductFamilyId;
    values.companyId ??= `test-company:${String(values.company ?? 'unknown')}`;
    values.amazonAccountId ??= `test-account:${companyProductFamilyId}`;
    values.marketplace ??= values.familyMarketplace ?? 'Amazon.com';
    values.sku ??= `test-sku:${companyProductId}`;
    values.familyTargetCompanyProductId = targetCompanyProductId;
    values.isFrozenFamilyTarget = targetCompanyProductId === companyProductId;
    values.listingReviewCategories ??=
      values.baselineTier === 'D' || values.lastClosedMonthTier === 'D' || values.currentProjectedTier === 'D'
        ? ['tier_d']
        : [];
    const requestedPane = String(values.commandCenterPane ?? '');
    const canonicalPanes = new Set([
      'adminExcluded',
      'supplyAction',
      'activeOrders',
      'inPrepMonitoring',
      'inboundMonitoring',
      'healthyInventory',
      'excessInventory',
      'stuckInventory',
      'zeroStock',
      'dataReadiness',
      'performanceReview',
      'untieredProducts',
    ]);
    const derivedPane = commandCenterPaneForRow(values, goldCalculationDate).pane;
    values.primaryActionPane ??= canonicalPanes.has(requestedPane) ? requestedPane : derivedPane;
    values.primaryActionReasonCode ??=
      values.commandCenterPaneReason ?? commandCenterPaneForRow(values, goldCalculationDate).reason;
    values.replenishmentEligibility ??= 'eligible';
    values.replenishmentBlockReasonCode ??= 'eligible_informational_projection';
    values.newReplenishmentActionable ??= values.primaryActionPane === 'supplyAction';
    values.oosAlertActionable ??= ['supplyAction', 'zeroStock'].includes(String(values.primaryActionPane));
    values.supplyActionable ??= values.primaryActionPane === 'supplyAction';
    values.existingOrderFollowUp ??= false;
    values.existingOrderFollowUpAction ??= 'none';
    values.calculationEvidence = {
      ...(values.calculationEvidence as Record<string, unknown> | undefined),
      familyActionSnapshot: {
        familyKey: companyProductFamilyId,
        companyProductFamilyId,
        companyId: values.companyId,
        amazonAccountId: values.amazonAccountId,
        marketplace: values.marketplace,
        canonicalAsin: values.familyCanonicalAsin ?? values.asin ?? companyProductId,
        targetSelectionState: targetCompanyProductId ? 'automatic' : 'review',
        targetCompanyProductId,
        targetSelectionEvidence: {},
      },
    };
  }
  await db.getRepository(collection).create({ values });
}

async function refreshAndPublish(
  service: EcobaseInventoryPlanningService,
  query: Parameters<EcobaseInventoryPlanningService['refreshReadModel']>[0],
) {
  const result = await service.refreshReadModel(query);
  const run = result.run as Record<string, unknown>;
  if (run.status === 'published') return result;
  const runId = String(run.id);
  await service.verifyRefreshRun(runId);
  await service.publishRefreshRun(runId);
  return result;
}

async function createSilverOrderRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  const company = String(values.company ?? '');
  const companyId = `silver-company:${company}`;
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
  if (values.supplierId) {
    await upsertRecord(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: values.supplierId,
      companyId,
      displayName: values.supplierName,
    });
  }
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverOrders, {
    id: values.id,
    companyId,
    supplierId: values.supplierId,
    orderRef: values.externalOrderRef ?? values.id,
    orderDate: values.orderDate ?? '2025-01-01',
    dailySequenceLetter: 'A',
    orderIntent: values.sourceStage ?? 'imported',
    canonicalStatus: values.status,
    lifecycleStatus: values.status,
    operationalStatus: values.operationalStatus,
    workflowStage: values.workflowStage,
    statusSource: values.statusSource,
    authorityStatus: values.authorityStatus ?? 'alternate_authoritative',
    authoritySource: values.authoritySource,
    authorityTaskRef: values.authorityTaskRef,
    authorityAsOf: values.authorityAsOf,
    authorityEvidenceJson: values.authorityEvidenceJson,
    paymentStatus: values.paymentStatus,
    approvalStatus: values.approvalStatus,
    expectedDeliveryDate: values.expectedDeliveryDate,
    shippingCarrier: values.shippingCarrier,
    amazonReceiptStatus: values.amazonReceiptStatus,
    amazonReceiptObservedAt: values.amazonReceiptObservedAt,
    amazonReceiptCompletionReason: values.amazonReceiptCompletionReason,
    amazonReceiptEvidenceJson: values.amazonReceiptEvidenceJson,
    trackingId: values.trackingId,
    updatedAt: values.lastMeaningfulUpdateAt ?? values.statusUpdatedAt,
  });
}

async function createSilverOrderLineRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  const company = String(values.company ?? '');
  const companyId = `silver-company:${company}`;
  const asin = String(values.asin ?? '');
  const sku = String(values.sku ?? '');
  const productId = `silver-product:${asin}:${sku}`;
  const companyProductId = values.companyProductId ?? `silver-company-product:${company}:${asin}:${sku}`;
  const supplierProductId =
    values.supplierProductId ?? `silver-supplier-product:${values.supplierId ?? ''}:${asin}:${sku}`;
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
    id: productId,
    asin,
    sku,
    title: values.title,
    brand: values.brand,
  });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
    id: companyProductId,
    companyId,
    productId,
    lifecycleStatus: 'active',
  });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
    id: supplierProductId,
    supplierId: values.supplierId,
    productId,
    supplierSku: sku,
    unitCost: values.unitCost,
    leadTimeDays: values.leadTimeDays ?? 30,
  });
  await upsertRecord(db, ECOBASE_COLLECTIONS.silverOrderLines, {
    id: values.id,
    orderId: values.supplierOrderId,
    companyProductId,
    supplierProductId,
    orderedQty: values.orderedQty,
    confirmedQty: values.receivedQty,
    unitCost: values.unitCost,
    expectedDeliveryDate: values.expectedDeliveryDate,
    expectedSellableDate: values.expectedSellableDate,
    sourceAsin: asin,
    sourceSupplierSku: sku,
    mappingScope: values.mappingScope ?? 'exact_member',
    productMappingStatus: 'resolved',
    amazonReceiptStatus: values.amazonReceiptStatus,
    amazonReceiptObservedQty: values.amazonReceiptObservedQty,
    amazonReceiptBaselineAt: values.amazonReceiptBaselineAt,
    amazonReceiptObservedAt: values.amazonReceiptObservedAt,
    amazonReceiptCompletionReason: values.amazonReceiptCompletionReason,
    amazonReceiptEvidenceJson: values.amazonReceiptEvidenceJson,
  });
}

async function createSilverActivityCommentRecord(db: MemoryDatabase, values: Record<string, unknown>) {
  await createRecord(db, ECOBASE_COLLECTIONS.silverActivityComments, {
    id: values.id,
    entityType: 'supplier_order',
    entityId: values.supplierOrderId,
    actorType: values.actorUserId ? 'user' : 'operator',
    actorUserId: values.actorUserId,
    commentType: values.activityType ?? 'note',
    body: values.notes ?? values.activityType ?? 'note',
    occurredAt: values.occurredAt,
    deletedAt: values.deletedAt,
    contextSnapshotJson: {
      supplierOrderId: values.supplierOrderId,
      occurredAt: values.occurredAt,
      actor: values.actor,
      source: values.source,
    },
    createdAt: values.occurredAt,
    updatedAt: values.editedAt ?? values.occurredAt,
  });
}

async function upsertRecord(db: MemoryDatabase, collection: string, values: Record<string, unknown>) {
  const repo = db.getRepository(collection);
  const id = values.id;
  if (id && repo.all().some((record) => record.id === id)) {
    await repo.update({ filterByTk: id as string | number, values });
    return;
  }
  await repo.create({ values });
}

describe('EcobaseInventoryPlanningService', () => {
  it('classifies tiered families into the report panes and checks tier before workflow', () => {
    const row = (values: Record<string, unknown>) =>
      commandCenterPaneForRow(
        {
          productStatus: 'Active',
          familyRole: 'target',
          tier: 'A',
          planningReadinessStatus: 'ready',
          readinessReasonCodes: [],
          supplierOrderState: 'no_open_order',
          actionStatus: 'sufficient_stock',
          familySellableStock: 10,
          familyReservedStock: 0,
          familyOrderedStock: 0,
          familyPrepStock: 0,
          familyInboundStock: 0,
          familyAwdStock: 0,
          familySupplierPipelineStock: 0,
          familyOnHandSellableStock: 10,
          supplierAvailability: 'resolved_family_supplier',
          effectiveLeadTimeDays: 37,
          ...values,
        },
        '2026-07-10',
      ).pane;
    const workflow = (clickupStatus: string) => ({ clickupStatusEvidence: { clickupStatus } });

    expect([
      row({ productStatus: 'Inactive' }),
      row({ tier: undefined, supplierOrderAuthorityEvidence: workflow('inbound-monitoring') }),
      row({ supplierOrderAuthorityEvidence: workflow('to do') }),
      row({ supplierOrderAuthorityEvidence: workflow('ordered') }),
      row({ supplierOrderAuthorityEvidence: workflow('inbound-monitoring') }),
      row({
        supplierOrderAuthorityEvidence: workflow('complete'),
        amazonReceiptStatus: 'review_required',
      }),
      row({ readinessReasonCodes: ['inventory_unknown'] }),
      row({ actionStatus: 'order_today' }),
      row({}),
    ]).toEqual([
      'adminExcluded',
      'untieredProducts',
      'activeOrders',
      'inPrepMonitoring',
      'inboundMonitoring',
      'inboundMonitoring',
      'dataReadiness',
      'supplyAction',
      'healthyInventory',
    ]);
  });
  it('classifies explicit tier transitions', () => {
    expect(profitTierMovement('B', 'A')).toBe('down');
    expect(profitTierMovement('C', 'B')).toBe('down');
    expect(profitTierMovement('A', 'B')).toBe('up');
    expect(profitTierMovement(undefined, 'C')).toBe('lost_tier');
    expect(profitTierMovement('C', undefined)).toBe('new');
  });

  it('derives ETA from order date, explicit lead-time evidence, and receiving buffer without zero-filling', () => {
    expect(
      expectedArrivalEvidence(
        {
          leadTimeDays: 30,
          leadTimeSource: 'silver_order_line.supplier_product_lead_time',
        },
        { orderDate: '2026-06-01' },
        '2026-07-14',
        3,
      ),
    ).toMatchObject({
      expectedArrivalDate: '2026-07-04',
      expectedArrivalStatus: 'derived',
      expectedArrivalSource:
        'silver_order_line.supplier_product_lead_time+silver_order.order_date+planning_settings.fba_receiving_buffer',
      expectedArrivalFreshness: 'stale',
    });
    expect(expectedArrivalEvidence({}, { orderDate: '2026-06-01' }, '2026-07-14', 3)).toMatchObject({
      expectedArrivalStatus: 'unknown',
      expectedArrivalSource: 'insufficient_silver_evidence',
    });
  });

  it('keeps operator expected dates above imported order timing evidence', () => {
    expect(
      expectedArrivalEvidence(
        {
          expectedSellableDate: '2026-08-01',
          expectedArrivalDate: '2026-07-20',
          expectedDateOverrideAt: '2026-07-14T00:00:00.000Z',
        },
        { expectedDeliveryDate: '2026-07-18', orderDate: '2026-06-01' },
        '2026-07-14',
        7,
      ),
    ).toMatchObject({
      expectedArrivalDate: '2026-08-01',
      expectedArrivalStatus: 'operator',
      expectedArrivalSource: 'operator.expected_sellable_date',
      expectedArrivalConfidence: 'authoritative',
    });
  });

  it('keeps imported expected-sellable evidence above delivery and arrival estimates', () => {
    expect(
      expectedArrivalEvidence(
        {
          expectedSellableDate: '2026-07-25',
          expectedDeliveryDate: '2026-07-18',
          expectedArrivalDate: '2026-07-20',
        },
        { expectedDeliveryDate: '2026-07-17', orderDate: '2026-06-01' },
        '2026-07-14',
        7,
      ),
    ).toMatchObject({
      expectedArrivalDate: '2026-07-25',
      expectedArrivalStatus: 'imported',
      expectedArrivalSource: 'silver_order_line.expectedSellableDate',
    });
  });

  it('adds the FBA receiving buffer to an operator expected-delivery date', () => {
    expect(
      expectedArrivalEvidence(
        {
          expectedDeliveryDate: '2026-07-20',
          expectedDateOverrideAt: '2026-07-14T00:00:00.000Z',
        },
        { orderDate: '2026-06-01' },
        '2026-07-14',
        7,
      ),
    ).toMatchObject({
      expectedArrivalDate: '2026-07-27',
      expectedArrivalStatus: 'operator',
      expectedArrivalSource: 'operator.expected_delivery_date+planning_settings.fba_receiving_buffer',
    });
  });

  it('keeps persisted operator status above payment-derived coverage status', () => {
    const rules = {
      placedNotPurchased: new Set(['approval_pending']),
      purchasedPipeline: new Set(['paid']),
      closed: new Set(['completed']),
    };
    expect(
      supplierCoverageStatus(
        {
          status: 'approval_pending',
          statusSource: 'operator',
          operatorStatusOverrideAt: '2026-07-14T00:00:00.000Z',
          paymentStatus: 'Completed',
        },
        rules,
      ),
    ).toBe('approval_pending');
  });

  it('calculates uncovered-stockout money risk without replacing unknown inputs with zero', () => {
    const base = {
      salesVelocity: 2,
      profitPerUnit: 5,
      daysOfCover: 10,
      targetCoverDays: 40,
      openOrderCoverageQty: 0,
      supplierOrderState: 'no_open_order',
      estimatedOosDate: '2026-07-20',
    };

    expect(calculateInventoryMoneyRisk(base)).toMatchObject({
      estimatedProfitRisk: 300,
      moneyRiskStatus: 'resolved_positive',
      moneyRiskUncoveredDays: 30,
    });
    expect(
      calculateInventoryMoneyRisk({
        ...base,
        supplierOrderState: 'purchased_pipeline',
        expectedArrivalDate: '2026-07-15',
        expectedArrivalStatus: 'imported',
        openOrderCoverageQty: 60,
      }),
    ).toMatchObject({ estimatedProfitRisk: 0, moneyRiskStatus: 'resolved_zero', moneyRiskUncoveredDays: 0 });
    expect(
      calculateInventoryMoneyRisk({
        ...base,
        supplierOrderState: 'purchased_pipeline',
        expectedArrivalDate: '2026-07-25',
        expectedArrivalStatus: 'imported',
        openOrderCoverageQty: 60,
      }),
    ).toMatchObject({ estimatedProfitRisk: 50, moneyRiskStatus: 'resolved_positive', moneyRiskUncoveredDays: 5 });
    expect(
      calculateInventoryMoneyRisk({
        ...base,
        supplierOrderState: 'purchased_pipeline',
        expectedArrivalStatus: 'unknown',
      }),
    ).toMatchObject({ estimatedProfitRisk: undefined, moneyRiskStatus: 'unknown_arrival' });
    expect(calculateInventoryMoneyRisk({ ...base, profitPerUnit: undefined })).toMatchObject({
      estimatedProfitRisk: undefined,
      moneyRiskStatus: 'unknown_missing_inputs',
    });
    expect(calculateInventoryMoneyRisk({ ...base, profitPerUnit: -5 })).toMatchObject({
      estimatedProfitRisk: 0,
      moneyRiskStatus: 'resolved_zero',
    });
    expect(calculateInventoryMoneyRisk({ ...base, daysOfCover: 0, targetCoverDays: 30 })).toMatchObject({
      estimatedProfitRisk: 300,
      moneyRiskUncoveredDays: 30,
    });
    expect(calculateInventoryMoneyRisk({ ...base, openOrderCoverageQty: 20 })).toMatchObject({
      estimatedProfitRisk: 200,
      moneyRiskUncoveredDays: 20,
    });
  });

  it('materializes exclusive target supply, active-order, stuck, member, and watch boundaries', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      finalizeGoldContract: (row: Record<string, unknown>, calculationDate: string) => Record<string, unknown>;
      commandCenterRiskBars: (rows: Record<string, unknown>[]) => Record<string, Record<string, unknown>[]>;
    };
    const materialize = (values: Record<string, unknown>) =>
      service.finalizeGoldContract(
        {
          productStatus: 'Active',
          familyRole: 'target',
          actionStatus: 'order_soon',
          tier: 'A',
          salesVelocity: 1,
          salesVelocityBasis: 'historical_rolling_30_days',
          salesVelocityStatus: 'trusted_positive',
          currentPlanningStock: 30,
          onHandStock: 30,
          onHandSellableStock: 30,
          sellableStock: 30,
          daysOfCover: 30,
          targetCoverDays: 45,
          supplierOrderState: 'no_open_order',
          estimatedOosDate: '2026-08-09',
          inventoryAsOfDate: '2026-07-10',
          supplierAvailability: 'resolved_silver_link',
          leadTimeAvailability: 'resolved_silver_link',
          unitCostAvailability: 'resolved_cogs',
          profitAvailability: 'resolved_history',
          effectiveLeadTimeDays: 30,
          profitPerUnit: 5,
          openOrderCoverageQty: 0,
          ...values,
        },
        '2026-07-10',
      );

    expect(materialize({})).toMatchObject({
      commandCenterPane: 'supplyAction',
      sourceFreshnessStatus: 'fresh',
    });
    expect(materialize({ inventoryAsOfDate: undefined })).toMatchObject({
      commandCenterPane: 'dataReadiness',
      dataQualityStatus: 'blocked',
    });
    expect(materialize({ daysOfCover: 30.01 }).commandCenterPane).toBe('supplyAction');
    expect(materialize({ daysOfCover: 30.01 }).stuckClassification).toBe('over_30_doc_watch');
    expect(materialize({ daysOfCover: 60, lastMonthQty: 5, sixMonthAverageQty: 10 }).stuckClassification).toBe(
      'declining_velocity_watch',
    );
    expect(
      materialize({ daysOfCover: 60.01, familyStuckAction: true, familyStuckClassification: 'over_60_doc' }),
    ).toMatchObject({ commandCenterPane: 'excessInventory', stuckClassification: 'over_60_doc' });
    expect(
      service.commandCenterRiskBars([
        materialize({ daysOfCover: 61, familyStuckAction: true, familyStuckClassification: 'over_60_doc' }),
        materialize({ daysOfCover: 45 }),
        materialize({ daysOfCover: 45, lastMonthQty: 5, sixMonthAverageQty: 10 }),
      ]).inventoryHealth,
    ).toEqual([
      { key: 'healthyInventory', count: 0 },
      { key: 'excessInventory', count: 1 },
      { key: 'stuckInventory', count: 0 },
      { key: 'zeroStock', count: 0 },
      { key: 'dataReadiness', count: 0 },
    ]);
    expect(
      materialize({
        currentPlanningStock: 0,
        onHandStock: 0,
        onHandSellableStock: 0,
        sellableStock: 0,
        daysOfCover: 0,
      }).stuck,
    ).toBe(false);
    expect(
      materialize({
        onHandStock: 0,
        onHandSellableStock: 0,
        sellableStock: 0,
        reservedStock: 10,
        expectedArrivalDate: '2026-07-01',
      }).stuckClassification,
    ).toBe('reserved_stalled');
    expect(
      materialize({
        salesVelocity: 0,
        salesVelocityStatus: 'trusted_zero',
        daysOfCover: undefined,
        familyStuckAction: true,
        familyStuckClassification: 'no_sell_through_with_stock',
      }),
    ).toMatchObject({
      commandCenterPane: 'stuckInventory',
      stuckClassification: 'no_sell_through_with_stock',
    });
    expect(
      materialize({
        salesVelocity: 0,
        salesVelocityStatus: 'trusted_zero',
        daysOfCover: undefined,
        pipelineStock: 10,
      }),
    ).toMatchObject({ commandCenterPane: 'stuckInventory', stuckClassification: 'no_sell_through_with_stock' });
    expect(
      materialize({ salesVelocity: undefined, salesVelocityStatus: 'missing', daysOfCover: undefined }),
    ).toMatchObject({ commandCenterPane: 'dataReadiness', stuckClassification: 'insufficient_velocity_data' });
    expect(materialize({ familyRole: 'member', actionStatus: 'family_member_no_reorder' }).commandCenterPane).toBe(
      'adminExcluded',
    );
    expect(materialize({ productStatus: 'Inactive' }).commandCenterPane).toBe('adminExcluded');
    expect(
      materialize({
        daysOfCover: 90,
        supplierOrderState: 'purchased_pipeline',
        supplierOrderWorkflowStage: 'in_prep',
        expectedArrivalDate: '2026-07-01',
        expectedArrivalStatus: 'imported',
        pipelineStock: 10,
        familyStuckAction: true,
        familyStuckClassification: 'pipeline_stalled',
      }),
    ).toMatchObject({
      commandCenterPane: 'inPrepMonitoring',
      stuck: true,
      stuckClassification: 'pipeline_stalled',
      supplierOrderState: 'purchased_pipeline',
    });
    expect(
      materialize({
        daysOfCover: 90,
        supplierOrderState: 'purchased_pipeline',
        supplierOrderAuthorityEvidence: { clickupStatusEvidence: { clickupStatus: 'inbound-monitoring' } },
        amazonReceiptStatus: 'awaiting_amazon_stock',
        familyStuckAction: true,
        familyStuckClassification: 'pipeline_stalled',
      }).commandCenterPane,
    ).toBe('inboundMonitoring');
    expect(materialize({ supplierAvailability: 'unavailable_no_evidence' })).toMatchObject({
      commandCenterPane: 'dataReadiness',
    });
    expect(
      materialize({
        familyRole: 'review',
        actionStatus: 'family_review_required',
        salesVelocity: undefined,
        salesVelocityStatus: 'missing',
        daysOfCover: undefined,
      }).commandCenterPane,
    ).toBe('dataReadiness');
  });

  it('emits one readiness row and no duplicate actions when a family target needs review', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      applyFamilyRollups: (rows: Record<string, unknown>[], calculationDate: string) => Record<string, unknown>[];
      finalizeGoldContract: (row: Record<string, unknown>, calculationDate: string) => Record<string, unknown>;
    };
    const members = ['member-b', 'member-a'].map((companyProductId) => ({
      companyProductId,
      companyProductFamilyId: 'family-review',
      productStatus: 'Active',
      actionStatus: 'missing_velocity',
      salesVelocityStatus: 'missing',
      targetCoverDays: 45,
      tier: 'A',
      inventoryAsOfDate: '2026-07-10',
      onHandStock: 10,
      onHandSellableStock: 10,
      currentPlanningStock: 10,
      supplierOrderState: 'no_open_order',
    }));

    const materialized = service
      .applyFamilyRollups(members, '2026-07-10')
      .map((row) => service.finalizeGoldContract(row, '2026-07-10'));

    expect(materialized.map((row) => [row.companyProductId, row.familyRole, row.commandCenterPane])).toEqual([
      ['member-b', 'member', 'adminExcluded'],
      ['member-a', 'review', 'zeroStock'],
    ]);
  });

  it('projects family source-order receipt evidence onto the replenishment target', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      applyFamilyRollups: (rows: Record<string, unknown>[], calculationDate: string) => Record<string, unknown>[];
    };
    const receiptEvidence = { evidenceKey: 'receipt-evidence' };
    const rows = service.applyFamilyRollups(
      [
        {
          companyProductId: 'family-target',
          companyProductFamilyId: 'family-receipt',
          replenishmentTargetCompanyProductId: 'family-target',
          familyRollupEvidence: { supplierSelection: { sourceCompanyProductId: 'family-source' } },
        },
        {
          companyProductId: 'family-source',
          companyProductFamilyId: 'family-receipt',
          replenishmentTargetCompanyProductId: 'family-target',
          supplierOrderId: 'order-1',
          supplierOrderRef: 'PO-1',
          supplierOrderSortValue: '2026-07-10:PO-1',
          amazonReceiptStatus: 'awaiting_amazon_stock',
          amazonReceiptObservedAt: '2026-07-10T00:00:00.000Z',
          amazonReceiptCompletionReason: 'source_inbound_monitoring',
          amazonReceiptEvidenceJson: receiptEvidence,
        },
      ],
      '2026-07-16',
    );

    expect(rows.find((row) => row.companyProductId === 'family-target')).toMatchObject({
      supplierOrderId: 'order-1',
      supplierOrderRef: 'PO-1',
      amazonReceiptStatus: 'awaiting_amazon_stock',
      amazonReceiptObservedAt: '2026-07-10T00:00:00.000Z',
      amazonReceiptCompletionReason: 'source_inbound_monitoring',
      amazonReceiptEvidenceJson: receiptEvidence,
    });
  });

  it('keeps untiered current-operational targets visible without history enrichment', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase({ historyLoaded: false })) as unknown as {
      finalizeGoldContract: (row: Record<string, unknown>, calculationDate: string) => Record<string, unknown>;
    };
    const materialize = (values: Record<string, unknown>) =>
      service.finalizeGoldContract(
        {
          productStatus: 'Active',
          familyRole: 'target',
          tier: undefined,
          salesVelocity: 2,
          salesVelocityBasis: 'inventory_snapshot_fallback',
          salesVelocityStatus: 'fallback_positive',
          currentPlanningStock: 20,
          daysOfCover: 10,
          targetCoverDays: 45,
          actionStatus: 'overdue',
          supplierOrderState: 'no_open_order',
          inventoryAsOfDate: '2026-07-10',
          supplierAvailability: 'unavailable_no_evidence',
          leadTimeAvailability: 'resolved_default_supplier_lead_time',
          unitCostAvailability: 'unavailable_no_evidence',
          profitAvailability: 'unavailable_no_history',
          ...values,
        },
        '2026-07-10',
      );

    expect(materialize({})).toMatchObject({
      commandCenterPane: 'untieredProducts',
      planningEligibilityStatus: 'ineligible_unclassified_tier',
    });
    expect(materialize({ actionStatus: 'sufficient_stock', currentPlanningStock: 180, daysOfCover: 90 })).toMatchObject(
      {
        commandCenterPane: 'untieredProducts',
        planningEligibilityStatus: 'ineligible_unclassified_tier',
      },
    );
    expect(
      materialize({
        actionStatus: 'missing_velocity',
        salesVelocity: undefined,
        salesVelocityStatus: 'missing',
        daysOfCover: undefined,
      }),
    ).toMatchObject({
      commandCenterPane: 'untieredProducts',
      planningEligibilityStatus: 'ineligible_unclassified_tier',
    });
  });

  it('applies the exclusive report-pane precedence without dropping source evidence', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      finalizeGoldContract: (row: Record<string, unknown>, calculationDate: string) => Record<string, unknown>;
    };
    const sourceEvidence = { clickupStatusEvidence: { taskRef: 'task-1', clickupStatus: 'paid' } };
    const base = {
      productStatus: 'Active',
      familyRole: 'target',
      tier: 'A',
      supplierAvailability: 'resolved_silver_link',
      leadTimeAvailability: 'resolved_silver_link',
      unitCostAvailability: 'resolved_supplier_product',
      profitAvailability: 'resolved_history',
      salesVelocityStatus: 'trusted_positive',
      salesVelocity: 1,
      daysOfCover: 100,
      inventoryAsOfDate: '2026-07-10',
      supplierOrderState: 'no_open_order',
      actionStatus: 'no_reorder_needed',
      targetCoverDays: 45,
      effectiveLeadTimeDays: 30,
      onHandSellableStock: 100,
      sellableStock: 100,
      reservedStock: 0,
      orderedStock: 0,
      prepStock: 0,
      inboundStock: 0,
      awdStock: 0,
      supplierPipelineStock: 0,
      commandCenterPane: 'legacy',
      supplierOrderAuthorityEvidence: sourceEvidence,
    };
    const pane = (values: Record<string, unknown>) =>
      service.finalizeGoldContract({ ...base, ...values }, '2026-07-10');

    const rows = [
      pane({ productStatus: 'Inactive', supplierOrderState: 'purchased_pipeline', expectedArrivalDate: '2026-07-09' }),
      pane({
        supplierOrderState: 'purchased_pipeline',
        supplierOrderWorkflowStage: 'amazon_inbound',
        expectedArrivalStatus: 'imported',
        expectedArrivalDate: '2026-07-09',
      }),
      pane({
        supplierOrderState: 'purchased_pipeline',
        supplierOrderWorkflowStage: 'in_prep',
        expectedArrivalStatus: 'imported',
        expectedArrivalDate: '2026-07-15',
        estimatedOosDate: '2026-07-20',
      }),
      pane({ supplierAvailability: 'unavailable_no_evidence', actionStatus: 'order_today' }),
      pane({ actionStatus: 'order_today', daysOfCover: 10 }),
      pane({}),
    ];

    expect(rows.map((row) => row.commandCenterPane)).toEqual([
      'adminExcluded',
      'inboundMonitoring',
      'inPrepMonitoring',
      'dataReadiness',
      'supplyAction',
      'healthyInventory',
    ]);
    expect(rows.every((row) => row.supplierOrderAuthorityEvidence === sourceEvidence)).toBe(true);
  });

  it('keeps missing inventory values unknown through gold and API projection', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-missing-stock', name: 'ACME' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-missing-stock',
      asin: 'B000NOSTOCK',
      sku: 'NO-STOCK',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: 'company-product-missing-stock',
      companyId: 'company-missing-stock',
      productId: 'product-missing-stock',
      lifecycleStatus: 'active',
    });

    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, { company: 'ACME', calculationDate: '2026-07-10' });
    const commandCenter = await service.commandCenter({ company: 'ACME', calculationDate: '2026-07-10' });
    const [goldRow] = await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({});

    expect(goldRow).toMatchObject({
      naturalKey: expect.stringMatching(/:2026-07-10:ACME:company-product-missing-stock$/),
      planningProductId: 'company-product-missing-stock',
      company: 'ACME',
      asin: 'B000NOSTOCK',
      supplierName: 'Unknown supplier',
      supplierAvailability: 'unavailable_no_evidence',
      unitCostAvailability: 'unavailable_no_evidence',
      profitAvailability: 'unavailable_no_history',
      actionStatus: 'missing_inventory',
      currentPlanningStock: null,
      daysOfCover: null,
      estimatedProfitRisk: null,
      moneyRiskStatus: 'unknown_missing_inputs',
      commandCenterPane: 'untieredProducts',
    });
    expect(goldRow.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(commandCenter.panes.supplyAction.total).toBe(0);
    expect(commandCenter.panes.untieredProducts.total).toBe(1);
    expect(commandCenter.summaryCards.find((card) => card.key === 'moneyAtRisk')).toMatchObject({
      unknownCount: 0,
      denominatorCount: 0,
    });
  });

  it('projects exactly one operator action per family across panes, totals, digest, search, and nested evidence', async () => {
    const db = new MemoryDatabase({ historyLoaded: false });
    const common = {
      company: 'ACME',
      calculationDate: '2026-07-15',
      familyAmazonAccountId: '11111111-1111-4111-8111-111111111111',
      familyMarketplace: 'Amazon.com',
      productStatus: 'Active',
      planningEligibilityStatus: 'eligible',
      tier: 'A',
      inventoryAsOfDate: '2026-07-15',
      familySellableStock: 100,
      familyReservedStock: 0,
      familyOrderedStock: 0,
      familyPrepStock: 0,
      familyInboundStock: 0,
      familyAwdStock: 0,
      familySupplierPipelineStock: 0,
      familyOnHandSellableStock: 100,
      supplierAvailability: 'resolved_silver_link',
      effectiveLeadTimeDays: 30,
      salesVelocity: 2,
      familySalesVelocity: 2,
      profitPerUnit: 5,
      moneyRiskStatus: 'resolved_positive',
    };
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...common,
      id: 'family-one-target',
      companyProductId: 'cp-family-one-target',
      companyProductFamilyId: 'family-one',
      familyCanonicalAsin: 'B00FAMILYONE',
      familyRole: 'target',
      asin: 'B00FAMILYONE',
      sku: 'TARGET-ONE',
      actionStatus: 'overdue',
      commandCenterPane: 'orderNow',
      supplierAvailability: 'resolved_silver_link',
      estimatedProfitRisk: 100,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...common,
      id: 'family-one-member',
      companyProductId: 'cp-family-one-member',
      companyProductFamilyId: 'family-one',
      familyCanonicalAsin: 'B00FAMILYONE',
      familyRole: 'member',
      asin: 'B00FAMILYONE',
      sku: 'MEMBER-ONE',
      actionStatus: 'family_member_no_reorder',
      commandCenterPane: 'watchlist',
      estimatedProfitRisk: 999,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...common,
      id: 'family-two-target',
      companyProductId: 'cp-family-two-target',
      companyProductFamilyId: 'family-two',
      familyCanonicalAsin: 'B00FAMILYTWO',
      familyRole: 'target',
      asin: 'B00FAMILYTWO',
      sku: 'TARGET-TWO',
      actionStatus: 'already_ordered',
      commandCenterPane: 'orderedPipeline',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderId: 'order-current',
      supplierOrderRef: 'PO-CURRENT-42',
      supplierOrderStatus: 'paid',
      supplierOrderWorkflowStage: 'in_prep',
      estimatedProfitRisk: 200,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...common,
      id: 'family-three-review',
      companyProductId: 'cp-family-three-review',
      companyProductFamilyId: 'family-three',
      familyCanonicalAsin: 'B00FAMILYTHREE',
      familyRole: 'review',
      asin: 'B00FAMILYTHREE',
      sku: 'REVIEW-THREE',
      actionStatus: 'missing_velocity',
      commandCenterPane: 'dataQuality',
      planningEligibilityStatus: 'needs_data_readiness',
      estimatedProfitRisk: null,
      salesVelocity: null,
      familySalesVelocity: null,
      profitPerUnit: null,
      moneyRiskStatus: 'unknown_missing_inputs',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...common,
      id: 'family-four-inactive',
      companyProductId: 'cp-family-four-inactive',
      companyProductFamilyId: 'family-four',
      familyCanonicalAsin: 'B00FAMILYFOUR',
      familyRole: 'target',
      asin: 'B00FAMILYFOUR',
      sku: 'INACTIVE-FOUR',
      productStatus: 'Inactive',
      actionStatus: 'sufficient_stock',
      commandCenterPane: 'legacyInactivePane',
      planningEligibilityStatus: 'ineligible_inactive',
      estimatedProfitRisk: 0,
    });

    const service = new EcobaseInventoryPlanningService(db);
    const commandCenter = await service.commandCenter({
      company: 'ACME',
      calculationDate: '2026-07-15',
      pageSize: 100,
    });
    const projectedRows = Object.values(commandCenter.panes).flatMap((pane) => pane.rows);
    const moneyRisk = commandCenter.summaryCards.find((card) => card.key === 'moneyAtRisk');

    expect(commandCenter.metadata).toMatchObject({
      scope: 'family_action',
      rowUnit: 'family',
      calculationDate: '2026-07-15',
      publishedRunId: 'test-published-gold:2026-07-15',
      denominatorCount: 3,
      hiddenEvidenceRowCount: 2,
      moneyRiskDenominatorCount: 2,
    });
    expect(projectedRows).toHaveLength(3);
    expect(Object.values(commandCenter.panes).reduce((total, pane) => total + pane.total, 0)).toBe(3);
    expect(new Set(projectedRows.map((row) => row.companyProductFamilyId)).size).toBe(3);
    expect(commandCenter.panes.supplyAction.rows[0]).toMatchObject({
      companyProductId: 'cp-family-one-target',
      familyMembers: expect.arrayContaining([
        expect.objectContaining({ companyProductId: 'cp-family-one-target' }),
        expect.objectContaining({ companyProductId: 'cp-family-one-member' }),
      ]),
      familyMetrics: expect.objectContaining({
        familyId: 'family-one',
        company: 'ACME',
        amazonAccountId: '11111111-1111-4111-8111-111111111111',
        marketplace: 'Amazon.com',
        asin: 'B00FAMILYONE',
      }),
      targetListingMetrics: expect.objectContaining({ companyProductId: 'cp-family-one-target', sku: 'TARGET-ONE' }),
      familySupplier: expect.any(Object),
      targetOffer: expect.any(Object),
      currentCycle: expect.any(Object),
      readiness: expect.any(Object),
    });
    expect(moneyRisk).toMatchObject({ value: 300, knownCount: 2, unknownCount: 0, denominatorCount: 2 });

    const searched = await service.commandCenter({
      company: 'ACME',
      calculationDate: '2026-07-15',
      pane: 'inPrepMonitoring',
      sortBy: 'company',
      filters: { search: 'PO-CURRENT-42' },
    });
    expect(searched.panes.inPrepMonitoring.rows).toEqual([
      expect.objectContaining({ companyProductFamilyId: 'family-two', supplierOrderRef: 'PO-CURRENT-42' }),
    ]);

    const digest = await service.digestPreview({ company: 'ACME', calculationDate: '2026-07-15' });
    expect(digest.metadata).toMatchObject({ scope: 'family_action', denominatorCount: 3, hiddenEvidenceRowCount: 2 });
    expect(digest.summary).toMatchObject({
      moneyAtRiskKnownTotal: 300,
      moneyAtRiskKnownCount: 2,
      moneyAtRiskUnknownCount: 0,
      moneyAtRiskDenominatorCount: 2,
    });
    expect(
      Object.values(digest.sections)
        .flat()
        .some((row) => row.companyProductId === 'cp-family-one-member'),
    ).toBe(false);
  });

  it('propagates an audited target change through rebuilt Gold, command-center selection, and digest scope', async () => {
    const db = new MemoryDatabase({ historyLoaded: false });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-target-change', name: 'ACME' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductFamilies, {
      id: 'family-target-change',
      companyId: 'company-target-change',
      amazonAccountId: 'account-target-change',
      canonicalAsin: 'B00TARGETCHANGE',
      targetSelectionStatus: 'selected',
      replenishmentTargetCompanyProductId: 'cp-target-a',
    });
    for (const suffix of ['a', 'b']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
        id: `product-target-${suffix}`,
        asin: 'B00TARGETCHANGE',
        sku: `TARGET-${suffix.toUpperCase()}`,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
        id: `cp-target-${suffix}`,
        companyId: 'company-target-change',
        amazonAccountId: 'account-target-change',
        productId: `product-target-${suffix}`,
        companyProductFamilyId: 'family-target-change',
        lifecycleStatus: 'active',
      });
    }

    await new EcobaseCompanyProductFamilyService(db).setReplenishmentTarget({
      familyId: 'family-target-change',
      companyProductId: 'cp-target-b',
      source: 'operator',
      actorUserId: 'operator-1',
      reason: 'Listing B is the reviewed replenishment target.',
    });
    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, { company: 'ACME', calculationDate: '2026-07-16' });

    const goldRows = await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({
      filter: { calculationDate: '2026-07-16' },
    });
    expect(goldRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyProductId: 'cp-target-a',
          familyAmazonAccountId: 'account-target-change',
          familyRole: 'member',
        }),
        expect.objectContaining({
          companyProductId: 'cp-target-b',
          familyAmazonAccountId: 'account-target-change',
          familyRole: 'target',
        }),
      ]),
    );
    const commandCenter = await service.commandCenter({
      company: 'ACME',
      calculationDate: '2026-07-16',
      companyProductId: 'cp-target-b',
    });
    expect(Object.values(commandCenter.panes).flatMap((pane) => pane.rows)).toEqual([
      expect.objectContaining({
        companyProductId: 'cp-target-b',
        replenishmentTargetCompanyProductId: 'cp-target-b',
      }),
    ]);
    expect(commandCenter.selectedRow).toMatchObject({ row: { companyProductId: 'cp-target-b' } });
    expect(await service.digestPreview({ company: 'ACME', calculationDate: '2026-07-16' })).toMatchObject({
      metadata: { denominatorCount: 1, hiddenEvidenceRowCount: 1 },
    });
  });

  it('loads the current order and full family order-line history in the row workspace', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-family-history', name: 'ACME' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverSuppliers, {
      id: 'supplier-family-history',
      companyId: 'company-family-history',
      displayName: 'Family Supplier',
    });
    for (const [suffix, orderId, orderRef] of [
      ['target', 'order-current', 'PO-CURRENT'],
      ['member', 'order-older', 'PO-OLDER'],
    ]) {
      const productId = `product-${suffix}`;
      const companyProductId = `company-product-${suffix}`;
      await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
        id: productId,
        asin: 'B00FAMILYHISTORY',
        sku: `SKU-${suffix.toUpperCase()}`,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
        id: companyProductId,
        companyId: 'company-family-history',
        productId,
        companyProductFamilyId: 'family-history',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
        id: `supplier-product-${suffix}`,
        supplierId: 'supplier-family-history',
        productId,
        unitCost: 5,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverOrders, {
        id: orderId,
        companyId: 'company-family-history',
        supplierId: 'supplier-family-history',
        orderRef,
        canonicalStatus: suffix === 'target' ? 'paid' : 'completed',
        orderDate: suffix === 'target' ? '2026-07-10' : '2026-06-10',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverOrderLines, {
        id: `line-${suffix}`,
        orderId,
        companyProductId,
        supplierProductId: `supplier-product-${suffix}`,
        orderedQty: 10,
      });
    }

    const workspace = await new EcobaseInventoryPlanningService(db).rowWorkspace({
      company: 'ACME',
      familyId: 'family-history',
      currentOrderId: 'order-current',
      planningProductId: 'company-product-target',
      asin: 'B00FAMILYHISTORY',
      sku: 'SKU-TARGET',
    });

    expect(workspace.currentOrder).toMatchObject({ id: 'order-current', externalOrderRef: 'PO-CURRENT' });
    expect(workspace.orderLineHistory.map((line) => line.supplierOrderId)).toEqual(['order-current', 'order-older']);
    expect(workspace.orderLineHistory.map((line) => line.companyProductId)).toEqual([
      'company-product-target',
      'company-product-member',
    ]);
  });

  it('audits product planning overrides and recalculates excluded products', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-product-manager', name: 'ACME' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-manager-product',
      asin: 'B00PRODUCTMANAGER',
      sku: 'PRODUCT-MANAGER',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: 'company-product-manager',
      companyId: 'company-product-manager',
      productId: 'product-manager-product',
      lifecycleStatus: 'active',
    });
    const service = new EcobaseInventoryPlanningService(db);

    await expect(
      service.updateProductPlanningFields({
        companyProductId: 'company-product-manager',
        planningExcluded: true,
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow('Ecobase product planning update failed: reason is required.');

    await service.updateProductPlanningFields({
      companyProductId: 'company-product-manager',
      planningExcluded: true,
      reorderCycleDays: 21,
      targetCoverDays: 60,
      reason: 'Seasonal product paused by the operator.',
      actorUserId: 'user-1',
    });
    await service.refreshReadModel({ company: 'ACME', calculationDate: '2026-07-14' });

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).all()[0]).toMatchObject({
      planningExcluded: true,
      reorderCycleDays: 21,
      targetCoverDays: 60,
      excludedReason: 'Seasonal product paused by the operator.',
      excludedByUserId: 'user-1',
      excludedAt: expect.any(String),
      planningOverrideReason: 'Seasonal product paused by the operator.',
      planningOverrideByUserId: 'user-1',
      planningOverrideAt: expect.any(String),
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all()[0]).toMatchObject({
      actionStatus: 'excluded',
      commandCenterPane: 'adminExcluded',
      planningExcluded: true,
      reorderCycleDays: 21,
      targetCoverDays: 60,
    });
  });

  it('requires a positive optimizer budget', async () => {
    await expect(
      new EcobaseInventoryPlanningService(new MemoryDatabase()).optimizeBudget({ budget: 0 }),
    ).rejects.toThrow('Ecobase budget optimizer requires a budget greater than zero.');
  });

  it('reads only the explicitly published Gold refresh run', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns, {
      id: 'stale-run',
      idempotencyKey: 'stale-run',
      requestDigest: 'stale-run',
      calculationDate: '2026-06-26',
      status: 'succeeded',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns, {
      id: 'current-run',
      idempotencyKey: 'current-run',
      requestDigest: 'current-run',
      calculationDate: '2026-06-26',
      status: 'published',
      publishedAt: '2026-06-27T00:00:00.000Z',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'stale-gold-row',
      refreshRunId: 'stale-run',
      calculationDate: '2026-06-26',
      company: 'Ecofission LLC',
      asin: 'B000STALE',
      sku: 'STALE-SKU',
      tier: 'A',
      estimatedProfitRisk: 999,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'current-gold-row',
      refreshRunId: 'current-run',
      calculationDate: '2026-06-26',
      company: 'Ecofission LLC',
      asin: 'B000CURRENT',
      sku: 'CURRENT-SKU',
      tier: 'A',
      estimatedProfitRisk: 1,
    });

    const rows = await new EcobaseInventoryPlanningService(db).listRows({ calculationDate: '2026-06-26' });

    expect(rows.map((row) => row.asin)).toEqual(['B000CURRENT']);
  });

  it('serves non-action listing review evidence only from the published run', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns, {
      id: 'unpublished-review-run',
      idempotencyKey: 'unpublished-review-run',
      requestDigest: 'unpublished-review-run',
      calculationDate: '2026-06-26',
      status: 'verified',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns, {
      id: 'published-review-run',
      idempotencyKey: 'published-review-run',
      requestDigest: 'published-review-run',
      calculationDate: '2026-06-26',
      status: 'published',
      publishedAt: '2026-06-27T00:00:00.000Z',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'unpublished-review-row',
      refreshRunId: 'unpublished-review-run',
      calculationDate: '2026-06-26',
      companyProductId: 'unpublished-product',
      asin: 'B000UNPUBLISHED',
      sku: 'UNPUBLISHED-SKU',
      baselineTier: 'D',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'published-review-row',
      refreshRunId: 'published-review-run',
      calculationDate: '2026-06-26',
      companyProductId: 'published-product',
      asin: 'B000PUBLISHED',
      sku: 'PUBLISHED-SKU',
      baselineTier: 'D',
      currentProjectedTier: 'C',
    });

    const review = await new EcobaseInventoryPlanningService(db).listingPerformanceReview({
      calculationDate: '2026-06-26',
      categories: ['tier_d'],
    });

    expect(review).toMatchObject({
      listingCount: 1,
      actionCount: 0,
      selectedCategories: ['tier_d'],
    });
    expect(review.rows.map((row) => row.asin)).toEqual(['B000PUBLISHED']);
    expect(review.rows[0].listingReviewCategories).toEqual(['tier_d']);
    expect(review.rows[0].memberPerformanceEvidence).toEqual([
      expect.objectContaining({ companyProductId: 'published-product', baselineTier: 'D' }),
    ]);
    await expect(
      new EcobaseInventoryPlanningService(db).listingPerformanceReview({
        calculationDate: '2026-06-26',
        categories: ['unsupported_category' as never],
      }),
    ).rejects.toThrow('unsupported listing review category "unsupported_category"');
  });

  it('omits administrative exclusions from the report panes', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'excluded-product',
      naturalKey: '2026-07-14:Ecofission LLC:excluded-product',
      calculationDate: '2026-07-14',
      company: 'Ecofission LLC',
      planningProductId: 'excluded-product',
      asin: 'B00EXCLUDED',
      sku: 'EXCLUDED-SKU',
      actionStatus: 'excluded',
      commandCenterPane: 'excluded',
      planningEligibilityStatus: 'ineligible_excluded',
      lastRefreshedAt: '2026-07-14T00:00:00.000Z',
    });

    const center = await new EcobaseInventoryPlanningService(db).commandCenter({
      company: 'Ecofission LLC',
      calculationDate: '2026-07-14',
    });

    expect(center.metadata).toMatchObject({ denominatorCount: 0, hiddenEvidenceRowCount: 1 });
    expect(Object.values(center.panes).every((pane) => pane.total === 0)).toBe(true);
  });

  it('serves inventory planning from gold rows ordered by actionable money at risk', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'low-risk',
      naturalKey: 'low-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'LOW',
      actionStatus: 'overdue',
      tier: 'A',
      estimatedProfitRisk: 50,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'high-risk',
      naturalKey: 'high-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'HIGH',
      actionStatus: 'order_soon',
      tier: 'B',
      estimatedProfitRisk: 500,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'excluded-risk',
      naturalKey: 'excluded-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'EXCLUDED',
      actionStatus: 'excluded',
      tier: 'A',
      estimatedProfitRisk: 5000,
    });

    const rows = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });
    const limitedRows = await new EcobaseInventoryPlanningService(db).listRows({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
      limit: 2,
    });

    expect(rows.map((row) => row.id)).toEqual(['high-risk', 'low-risk', 'excluded-risk']);
    expect(limitedRows.map((row) => row.id)).toEqual(['high-risk', 'low-risk']);
  });

  it('serves filters, rows, and digest through one inventory workspace interface', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'workspace-row',
      naturalKey: 'workspace-row',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000WORK',
      sku: 'WORK-SKU',
      title: 'Workspace product',
      actionStatus: 'order_today',
      tier: 'A',
      productStatus: 'Active',
      familyRole: 'target',
      sellableStock: 20,
      reservedStock: 0,
      orderedStock: 0,
      prepStock: 0,
      inboundStock: 0,
      awdStock: 0,
      supplierPipelineStock: 0,
      onHandSellableStock: 20,
      supplierAvailability: 'resolved_silver_link',
      effectiveLeadTimeDays: 30,
      estimatedProfitRisk: 250,
      supplierOrderState: 'no_open_order',
      leadTimeFreshness: 'fresh',
      lastRefreshedAt: '2026-06-07T10:00:00.000Z',
    });

    const workspace = await new EcobaseInventoryPlanningService(db).workspace({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
      limit: 10,
    });

    expect(workspace.filters.companies).toContain('Ecofission LLC');
    expect(workspace.rows).toHaveLength(1);
    expect(workspace.rows[0]).toMatchObject({ asin: 'B000WORK', actionStatus: 'order_today' });
    expect(workspace.digest.summary).toMatchObject({ orderToday: 1, atRisk: 1 });
    expect(workspace.digest.sections.orderNow[0]).toMatchObject({ asin: 'B000WORK' });
  });

  it('projects persisted Sellerboard COGS evidence without request-time cost guessing', async () => {
    const db = new MemoryDatabase();
    for (const row of [
      {
        id: 'exact',
        asin: 'B000EXACT',
        sku: 'SKU-EXACT',
        qty: 10,
        risk: 300,
        unitCost: 4.5,
        unitCostAvailability: 'resolved_cogs',
        estimatedOrderCost: 45,
      },
      {
        id: 'safe',
        asin: 'B000SAFE',
        sku: 'amzn.gr.safe',
        qty: 4,
        risk: 200,
        unitCost: 7,
        unitCostAvailability: 'resolved_cogs',
        estimatedOrderCost: 28,
      },
      {
        id: 'ambiguous',
        asin: 'B000AMBIG',
        sku: 'amzn.gr.ambig',
        qty: 3,
        risk: 100,
        unitCost: undefined,
        unitCostAvailability: 'unavailable_ambiguous',
        estimatedOrderCost: undefined,
      },
    ]) {
      await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
        id: row.id,
        naturalKey: row.id,
        calculationDate: '2026-06-07',
        company: 'Ecofission LLC',
        asin: row.asin,
        sku: row.sku,
        title: row.id,
        actionStatus: 'order_today',
        tier: 'A',
        productStatus: 'Active',
        familyRole: 'target',
        sellableStock: 20,
        reservedStock: 0,
        orderedStock: 0,
        prepStock: 0,
        inboundStock: 0,
        awdStock: 0,
        supplierPipelineStock: 0,
        onHandSellableStock: 20,
        effectiveLeadTimeDays: 30,
        estimatedProfitRisk: row.risk,
        suggestedReorderQty: row.qty,
        unitCost: row.unitCost,
        unitCostAvailability: row.unitCostAvailability,
        estimatedOrderCost: row.estimatedOrderCost,
        supplierOrderState: 'no_open_order',
        supplierAvailability: 'resolved_silver_link',
        commandCenterPane: 'supplyAction',
      });
    }
    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-06-07',
      pane: 'supplyAction',
      pageSize: 10,
    });
    const rows = commandCenter.panes.supplyAction.rows;
    const row = (asin: string) => rows.find((item) => item.asin === asin);

    expect(row('B000EXACT')).toMatchObject({
      unitCost: 4.5,
      unitCostAvailability: 'resolved_cogs',
      estimatedOrderCost: 45,
    });
    expect(row('B000SAFE')).toMatchObject({
      unitCost: 7,
      unitCostAvailability: 'resolved_cogs',
      estimatedOrderCost: 28,
    });
    expect(row('B000AMBIG')).toMatchObject({
      unitCostAvailability: 'unavailable_ambiguous',
      estimatedOrderCost: undefined,
    });
  });

  it('separates zero stock, healthy inventory, and supply action rows', async () => {
    const db = new MemoryDatabase();
    const baseRow = {
      calculationDate: '2026-07-10',
      lastRefreshedAt: '2026-07-10T00:00:00.000Z',
      company: 'Ecofission LLC',
      asin: 'B000PANE',
      title: 'Pane row',
      tier: 'A',
      productStatus: 'active',
      familyRole: 'target',
      supplierOrderState: 'no_open_order',
      supplierAvailability: 'resolved_silver_link',
      leadTimeFreshness: 'missing',
      effectiveLeadTimeDays: 14,
      actionStatus: 'missing_lead_time',
      targetCoverDays: 45,
      salesVelocity: 1,
      sellableStock: 0,
      reservedStock: 0,
      orderedStock: 0,
      prepStock: 0,
      inboundStock: 0,
      awdStock: 0,
      supplierPipelineStock: 0,
      onHandSellableStock: 0,
      estimatedProfitRisk: 10,
    };
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-soon-missing-lead-time',
      naturalKey: 'pane-soon-missing-lead-time',
      sku: 'SOON-MISSING-LT',
      daysOfCover: 0,
      currentPlanningStock: 0,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-far-missing-lead-time',
      naturalKey: 'pane-far-missing-lead-time',
      sku: 'FAR-MISSING-LT',
      daysOfCover: 120,
      currentPlanningStock: 120,
      sellableStock: 120,
      onHandSellableStock: 120,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-known-soon',
      naturalKey: 'pane-known-soon',
      sku: 'KNOWN-SOON',
      leadTimeFreshness: 'fresh',
      actionStatus: 'order_soon',
      daysOfCover: 20,
      currentPlanningStock: 20,
      sellableStock: 20,
      onHandSellableStock: 20,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      ...baseRow,
      id: 'pane-missing-supplier',
      naturalKey: 'pane-missing-supplier',
      sku: 'MISSING-SUPPLIER',
      supplierAvailability: 'unavailable_no_evidence',
      daysOfCover: 0,
      currentPlanningStock: 0,
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-07-10',
      pane: 'supplyAction',
      pageSize: 10,
    });

    expect(commandCenter.panes.supplyAction.rows.map((row) => row.sku)).toEqual(['KNOWN-SOON']);
    expect(commandCenter.panes.zeroStock.rows.map((row) => row.sku)).toEqual(
      expect.arrayContaining(['SOON-MISSING-LT', 'MISSING-SUPPLIER']),
    );
    expect(commandCenter.panes.healthyInventory.rows.map((row) => row.sku)).toContain('FAR-MISSING-LT');
  });

  it('tiers only products with at least four units in the latest rolling 30-day sales window', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    const companyId = `silver-company:${company}`;
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });

    for (const product of [
      { asin: 'B00RECENT4', sku: 'RECENT-FOUR', recentUnits: 4, stock: 0 },
      { asin: 'B00RECENT2', sku: 'RECENT-TWO', recentUnits: 2, stock: 20 },
      { asin: 'B00RECENT0', sku: 'RECENT-ZERO', recentUnits: 0, stock: 20 },
    ]) {
      const productId = `silver-product:${product.asin}:${product.sku}`;
      const companyProductId = `silver-company-product:${company}:${product.asin}:${product.sku}`;
      await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
        id: productId,
        asin: product.asin,
        sku: product.sku,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
        id: companyProductId,
        companyId,
        productId,
        lifecycleStatus: 'active',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-${product.sku}`,
        companyProductId,
        snapshotDate: '2026-06-06',
        sellableStock: product.stock,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `historical-profit-${product.sku}`,
        companyProductId,
        snapshotDate: '2026-01-15',
        units: 10,
        sales: 1200,
        profit: 1000,
      });
      if (product.recentUnits >= 0) {
        await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
          id: `recent-sales-${product.sku}`,
          companyProductId,
          snapshotDate: '2026-06-06',
          units: product.recentUnits,
          sales: product.recentUnits * 120,
          profit: product.recentUnits * 100,
        });
      }
    }

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company,
      calculationDate: '2026-06-07',
    });

    const rows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(rows.find((row) => row.sku === 'RECENT-FOUR')).toMatchObject({
      recentUnits30: 4,
      profitPerUnit: 100,
      lastMonthQty: null,
      sixMonthAverageQty: 10,
      currentTier: 'unclassified',
      currentTierScore: null,
      averageTier: 'A',
      averageTierScore: 1000,
      bestTier: 'A',
      bestTierScore: 1000,
      salesVelocity: 4 / 30,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityWindowStart: '2026-05-08',
      salesVelocityWindowEnd: '2026-06-06',
      tier: 'A',
      tierScore: 400,
      tierEligibilityReason: 'eligible_recent_demand',
      tierRuleVersion: 'rolling_30d_min_4_v1',
    });
    expect(rows.find((row) => row.sku === 'RECENT-TWO')).toMatchObject({
      recentUnits30: 2,
      salesVelocity: 2 / 30,
      tier: null,
      tierScore: 200,
      tierEligibilityReason: 'low_recent_demand',
      commandCenterPane: 'untieredProducts',
    });
    expect(rows.find((row) => row.sku === 'RECENT-ZERO')).toMatchObject({
      recentUnits30: 0,
      salesVelocity: 0,
      tier: null,
      tierScore: 0,
      tierEligibilityReason: 'low_recent_demand',
      actionStatus: 'no_sell_through',
    });
  });

  it('does not tier snapshot velocity without rolling-30-day sales evidence', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-no-history', name: 'No History Inc' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-no-history',
      asin: 'B00NOHISTORY',
      sku: 'NO-HISTORY',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: 'company-product-no-history',
      companyId: 'company-no-history',
      productId: 'product-no-history',
      lifecycleStatus: 'active',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-no-history',
      companyProductId: 'company-product-no-history',
      snapshotDate: '2026-06-06',
      sellableStock: 10,
      salesVelocity: 5,
    });

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company: 'No History Inc',
      calculationDate: '2026-06-07',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all()[0]).toMatchObject({
      recentUnits30: null,
      salesVelocity: 5,
      salesVelocityBasis: 'inventory_snapshot_fallback',
      tier: null,
      tierEligibilityReason: 'missing_recent_sales_evidence',
      tierRuleVersion: 'rolling_30d_min_4_v1',
    });
  });

  it('keeps history-dependent Gold fields unknown when no Sellerboard history import succeeded', async () => {
    const db = new MemoryDatabase({ historyLoaded: false });
    await createRecord(db, ECOBASE_COLLECTIONS.importRuns, {
      id: 'sellerboard-api-current-only',
      adapterName: 'sellerboard-api',
      status: 'success',
      normalizedCount: 1,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, {
      id: 'company-current-only',
      name: 'Current Only Inc',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-current-only',
      asin: 'B00CURRENT1',
      sku: 'CURRENT-ONLY',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: 'company-product-current-only',
      companyId: 'company-current-only',
      productId: 'product-current-only',
      lifecycleStatus: 'active',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-current-only',
      companyProductId: 'company-product-current-only',
      snapshotDate: '2026-07-13',
      sellableStock: 12,
      reserved: 1,
      inbound: 2,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 3,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
      id: 'api-daily-fact-current-only',
      companyProductId: 'company-product-current-only',
      snapshotDate: '2026-07-13',
      units: 300,
      sales: 3000,
      profit: 1500,
    });

    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, {
      company: 'Current Only Inc',
      calculationDate: '2026-07-13',
    });
    const commandCenter = await service.commandCenter({
      company: 'Current Only Inc',
      calculationDate: '2026-07-13',
    });

    expect(db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all()[0]).toMatchObject({
      sellableStock: 12,
      currentPlanningStock: 15,
      inventoryAsOfDate: '2026-07-13',
      recentUnits30: null,
      profitPerUnit: null,
      sixMonthMargin: null,
      lastMonthQty: null,
      sixMonthAverageQty: null,
      sixMonthWorstQty: null,
      sixMonthBestQty: null,
      tier: null,
      tierScore: null,
      salesVelocity: 3,
      salesVelocityBasis: 'inventory_snapshot_fallback',
      salesVelocityStatus: 'fallback_positive',
      profitAvailability: 'unavailable_no_history',
      evidence: { historyLoadStatus: 'not_loaded', historicalFactCount: 0 },
      commandCenterPane: 'untieredProducts',
    });
    expect(commandCenter.metadata).toMatchObject({
      planningMode: 'current_operational',
      historyReadiness: {
        status: 'not_loaded',
        affectedRowCount: 1,
      },
    });
    expect(commandCenter.panes.untieredProducts.total).toBe(1);
  });

  it('baselines rule changes and emits a lost tier only on the immediate transition', async () => {
    const db = new MemoryDatabase();
    const companyProductId = 'company-product-tier-movement';
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: 'company-tier-movement', name: 'ACME' });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: 'product-tier-movement',
      asin: 'B00TIERMOVE',
      sku: 'TIER-MOVE',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: companyProductId,
      companyId: 'company-tier-movement',
      productId: 'product-tier-movement',
      lifecycleStatus: 'active',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-tier-movement',
      companyProductId,
      snapshotDate: '2026-06-06',
      sellableStock: 0,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
      id: 'historical-tier-movement',
      companyProductId,
      snapshotDate: '2026-01-15',
      units: 10,
      sales: 600,
      profit: 500,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
      id: 'recent-tier-movement',
      companyProductId,
      snapshotDate: '2026-06-06',
      units: 4,
      sales: 240,
      profit: 200,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'legacy-tier-row',
      naturalKey: `2026-06-06:ACME:${companyProductId}`,
      planningProductId: companyProductId,
      company: 'ACME',
      calculationDate: '2026-06-06',
      actionStatus: 'watch',
      tier: 'A',
      tierRuleVersion: 'legacy_best_month_v1',
    });

    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, { company: 'ACME', calculationDate: '2026-06-07' });
    await refreshAndPublish(service, { company: 'ACME', calculationDate: '2026-06-07' });
    await refreshAndPublish(service, { company: 'ACME', calculationDate: '2026-06-08' });
    await db
      .getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts)
      .update({ filterByTk: 'recent-tier-movement', values: { units: 2 } });
    await refreshAndPublish(service, { company: 'ACME', calculationDate: '2026-06-09' });
    await refreshAndPublish(service, { company: 'ACME', calculationDate: '2026-06-10' });

    const rows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(rows.filter((row) => row.calculationDate === '2026-06-07')).toHaveLength(1);
    expect(rows.find((row) => row.calculationDate === '2026-06-07')).toMatchObject({
      tier: 'B',
      previousTier: null,
      tierMovement: null,
    });
    expect(rows.find((row) => row.calculationDate === '2026-06-08')).toMatchObject({
      tier: 'B',
      previousTier: 'B',
      tierMovement: 'same',
    });
    expect(rows.find((row) => row.calculationDate === '2026-06-09')).toMatchObject({
      tier: null,
      previousTier: 'B',
      tierMovement: 'lost_tier',
    });
    expect(rows.find((row) => row.calculationDate === '2026-06-10')).toMatchObject({
      tier: null,
      previousTier: null,
      tierMovement: null,
    });
  });

  it('uses rolling-30-day velocity without inventing zero evidence for uncovered products', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    const companyId = `silver-company:${company}`;
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });

    for (const product of [
      { asin: 'B00HISTORYPOS', sku: 'HISTORY-POS', stock: 0, snapshotVelocity: 0, monthlyUnits: 300 },
      { asin: 'B00HISTORYZERO', sku: 'HISTORY-ZERO', stock: 20, snapshotVelocity: 99, monthlyUnits: 0 },
      { asin: 'B00SNAPSHOT', sku: 'SNAPSHOT-FALLBACK', stock: 20, snapshotVelocity: 2 },
      { asin: 'B00MISSINGVEL', sku: 'MISSING-VELOCITY', stock: 20, snapshotVelocity: 0 },
    ]) {
      const productId = `silver-product:${product.asin}:${product.sku}`;
      const companyProductId = `silver-company-product:${company}:${product.asin}:${product.sku}`;
      await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
        id: productId,
        asin: product.asin,
        sku: product.sku,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
        id: companyProductId,
        companyId,
        productId,
        lifecycleStatus: 'active',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-${product.sku}`,
        companyProductId,
        snapshotDate: '2026-06-06',
        sellableStock: product.stock,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: product.snapshotVelocity,
      });
      if (typeof product.monthlyUnits === 'number') {
        for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
          await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
            id: `fact-${product.sku}-${month}`,
            companyProductId,
            snapshotDate: `${month}-15`,
            units: product.monthlyUnits,
            sales: product.monthlyUnits * 10,
            profit: product.monthlyUnits * 3,
          });
        }
      }
    }

    await createRecord(db, ECOBASE_COLLECTIONS.sellerboardProductCosts, {
      id: 'cogs-history-positive',
      naturalKey: `${company}:B00HISTORYPOS:HISTORY-POS`,
      company,
      asin: 'B00HISTORYPOS',
      sku: 'HISTORY-POS',
      unitCost: 4.5,
      sourceFile: 'Ecofission_Cost_of_Goods_Sold.csv',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.sellerboardProductCosts, {
      id: 'cogs-wrong-company',
      naturalKey: 'Muxtex INC:B00HISTORYPOS:HISTORY-POS',
      company: 'Muxtex INC',
      asin: 'B00HISTORYPOS',
      sku: 'HISTORY-POS',
      unitCost: 999,
      sourceFile: 'Muxtex_Cost_of_Goods_Sold.csv',
    });

    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company,
      calculationDate: '2026-06-07',
    });

    const rows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(rows.find((row) => row.sku === 'HISTORY-POS')).toMatchObject({
      salesVelocity: 10,
      recentUnits30: 300,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityStatus: 'trusted_positive',
      salesVelocityWindowStart: '2026-04-16',
      salesVelocityWindowEnd: '2026-05-15',
      salesVelocityAsOfDate: '2026-05-15',
      daysOfCover: 0,
      estimatedOosDate: '2026-06-07',
      latestSafeReorderDate: '2026-04-24',
      actionStatus: 'overdue',
      supplierAvailability: 'unavailable_no_evidence',
      leadTimeDays: 30,
      leadTimeFreshness: 'default',
      leadTimeAvailability: 'resolved_default_supplier_lead_time',
      unitCost: 4.5,
      unitCostAvailability: 'resolved_cogs',
      profitAvailability: 'resolved_history',
      evidence: {
        leadTime: {
          days: 30,
          source: 'planning_settings.default_supplier_lead_time_days',
          effectiveLeadTimeDays: 37,
          effectiveLeadTimeWithSafetyDays: 44,
          components: {
            supplierLeadTime: { days: 30, source: 'planning_settings.default_supplier_lead_time_days' },
            prepAndLogistics: { days: null, source: 'unavailable' },
            fbaReceivingBuffer: { days: 7, source: 'planning_settings.fba_receiving_buffer_days' },
            safetyBuffer: { days: 7, source: 'planning_settings.safety_buffer_days' },
          },
        },
      },
    });
    expect(rows.find((row) => row.sku === 'HISTORY-ZERO')).toMatchObject({
      salesVelocity: 0,
      recentUnits30: 0,
      salesVelocityBasis: 'historical_rolling_30_days',
      salesVelocityStatus: 'trusted_zero',
      actionStatus: 'no_sell_through',
      profitAvailability: 'unavailable_no_sales',
      digestPriority: expect.any(Number),
    });
    expect(Number.isFinite(Number(rows.find((row) => row.sku === 'HISTORY-ZERO')?.digestPriority))).toBe(true);
    expect(rows.find((row) => row.sku === 'SNAPSHOT-FALLBACK')).toMatchObject({
      recentUnits30: null,
      salesVelocity: 2,
      salesVelocityBasis: 'inventory_snapshot_fallback',
      salesVelocityStatus: 'fallback_positive',
      tierEligibilityReason: 'missing_recent_sales_evidence',
    });
    expect(rows.find((row) => row.sku === 'MISSING-VELOCITY')).toMatchObject({
      recentUnits30: null,
      salesVelocity: null,
      salesVelocityBasis: 'unavailable',
      salesVelocityStatus: 'missing',
      actionStatus: 'missing_velocity',
      tierEligibilityReason: 'missing_recent_sales_evidence',
      unitCostAvailability: 'unavailable_no_evidence',
      profitAvailability: 'unavailable_no_history',
    });
  });

  it('rolls same-family listings into one persisted replenishment target without duplicate heuristics', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    const asin = 'B08CD4SHB4';
    const primarySku = 'B-101 Aramith';
    const duplicateSku = 'B-101';
    const primaryCompanyProductId = `silver-company-product:${company}:${asin}:${primarySku}`;
    const duplicateCompanyProductId = `silver-company-product:${company}:${asin}:${duplicateSku}`;
    const companyId = `silver-company:${company}`;
    const accountId = 'amazon-account-family-test';
    const familyId = 'company-product-family-test';

    await createRecord(db, ECOBASE_COLLECTIONS.planningSettings, {
      id: 'cycle-selection-settings',
      name: 'Cycle selection test',
      isActive: true,
      enableCurrentOrderCycleSelection: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, { id: companyId, name: company });
    await createRecord(db, ECOBASE_COLLECTIONS.silverAmazonAccounts, {
      id: accountId,
      companyId,
      name: 'Ecofission US',
      marketplace: 'amazon.com',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
      id: `silver-product:${asin}:${primarySku}`,
      asin,
      sku: primarySku,
      title: 'Aramith stock alias',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
      id: primaryCompanyProductId,
      companyId,
      amazonAccountId: accountId,
      companyProductFamilyId: familyId,
      productId: `silver-product:${asin}:${primarySku}`,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-primary-duplicate-group',
      companyProductId: primaryCompanyProductId,
      snapshotDate: '2026-07-09',
      sellableStock: 6,
      reserved: 0,
      inbound: 7,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 1,
    });
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-primary-duplicate-${month}`,
        companyProductId: primaryCompanyProductId,
        snapshotDate: `${month}-15`,
        units: 30,
        sales: 300,
        profit: 90,
      });
    }
    await createSilverOrderRecord(db, {
      id: 'order-duplicate-sku',
      company,
      supplierId: 'supplier-ws',
      supplierName: 'ws billiard supply',
      externalOrderRef: 'EF91125A',
      status: 'paid',
      operationalStatus: 'ordered',
      workflowStage: 'in_prep',
      authorityEvidenceJson: { clickupStatusEvidence: { clickupStatus: 'prep-in-progress' } },
      orderDate: '2026-06-01',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-duplicate-sku',
      company,
      supplierOrderId: 'order-duplicate-sku',
      supplierId: 'supplier-ws',
      asin,
      sku: duplicateSku,
      orderedQty: 7,
      receivedQty: 0,
      unitCost: 322,
      mappingScope: 'exact_member',
      sourceMemberSku: duplicateSku,
      amazonReceiptStatus: 'not_applicable',
    });
    await createSilverOrderRecord(db, {
      id: 'order-older-family-cycle',
      company,
      supplierId: 'supplier-ws',
      supplierName: 'ws billiard supply',
      externalOrderRef: 'EF51125A',
      status: 'paid',
      orderDate: '2026-05-01',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-older-family-cycle',
      company,
      supplierOrderId: 'order-older-family-cycle',
      supplierId: 'supplier-ws',
      asin,
      sku: primarySku,
      orderedQty: 100,
      receivedQty: 0,
      unitCost: 322,
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
      filterByTk: primaryCompanyProductId,
      values: { lifecycleStatus: undefined },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).update({
      filterByTk: `silver-supplier-product:supplier-ws:${asin}:${duplicateSku}`,
      values: { leadTimeDays: null },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).update({
      filterByTk: `silver-supplier-product:supplier-ws:${asin}:${primarySku}`,
      values: { leadTimeDays: null },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, {
      id: 'link-primary-sku-supplier',
      companyProductId: primaryCompanyProductId,
      supplierProductId: `silver-supplier-product:supplier-ws:${asin}:${primarySku}`,
      role: 'historical_purchase',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, {
      id: 'link-duplicate-sku-supplier',
      companyProductId: duplicateCompanyProductId,
      supplierProductId: `silver-supplier-product:supplier-ws:${asin}:${duplicateSku}`,
      role: 'latest_used',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-secondary-duplicate-group',
      companyProductId: duplicateCompanyProductId,
      snapshotDate: '2026-07-09',
      sellableStock: 5,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 0,
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).update({
      filterByTk: duplicateCompanyProductId,
      values: { amazonAccountId: accountId, companyProductFamilyId: familyId },
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductFamilies, {
      id: familyId,
      companyId,
      amazonAccountId: accountId,
      marketplace: 'amazon.com',
      canonicalAsin: asin,
      replenishmentTargetCompanyProductId: primaryCompanyProductId,
      targetSelectionSource: 'automatic',
      preferredSupplierId: 'supplier-ws',
      preferredSupplierProductId: `silver-supplier-product:supplier-ws:${asin}:${duplicateSku}`,
      supplierSelectionSource: 'latest_valid_order',
      supplierSelectionEvidenceJson: {
        sourceCompanyProductId: duplicateCompanyProductId,
        sourceSku: duplicateSku,
        sourceOrderRef: 'EF91125A',
        matchType: 'family_projected',
      },
    });
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-secondary-family-${month}`,
        companyProductId: duplicateCompanyProductId,
        snapshotDate: `${month}-15`,
        units: 30,
        sales: 300,
        profit: 90,
      });
    }

    await new EcobaseCompanyProductFamilyService(db).reconcileFamily(familyId);
    const inventoryService = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(inventoryService, {
      company,
      calculationDate: '2026-07-09',
    });

    const materializedRows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    expect(materializedRows.find((row) => row.sku === primarySku)).toMatchObject({
      productStatus: 'Active',
      companyProductFamilyId: familyId,
      familyRole: 'target',
      familyMemberCount: 2,
      familyCurrentPlanningStock: 18,
      familyOnHandStock: 11,
      familyFuturePositionStock: 18,
      familySellableStock: 11,
      familyPipelineStock: 7,
      familySalesVelocity: 2,
      familyDaysOfCover: 5.5,
      familyEstimatedOosDate: '2026-07-14',
      familyPositionDaysOfCover: 9,
      familyPositionEstimatedOosDate: '2026-07-18',
      familyOpenOrderCoverageQty: 0,
      familyTrustedSupplierOrderCoverageQty: 0,
      familySuggestedReorderQty: 72,
      supplierName: 'ws billiard supply',
      supplierAvailability: 'resolved_family_preferred_supplier',
      leadTimeDays: 30,
      leadTimeFreshness: 'default',
      leadTimeAvailability: 'resolved_default_supplier_lead_time',
      supplierSource: 'family_preferred_supplier',
      supplierOrderRef: 'EF91125A',
      supplierOrderOpenQty: 7,
      supplierOrderReferenceOpenQty: 7,
      supplierOrderCycleReviewRequired: true,
      supplierOrderCycleSelection: {
        selectedOrderId: 'order-duplicate-sku',
        selectedOrderRef: 'EF91125A',
        selectedLineIds: ['line-duplicate-sku'],
        selectedOpenQty: 7,
        excludedCycles: [
          {
            orderId: 'order-older-family-cycle',
            orderRef: 'EF51125A',
            decision: 'review_required',
            reason: 'later_cycle_exists_without_terminal_receipt_evidence',
          },
        ],
        reviewRequired: true,
      },
      openOrderCoverageQty: 0,
      unitCost: 322,
      estimatedOrderCost: 23184,
      actionStatus: 'overdue',
      evidence: {
        familyRollup: expect.objectContaining({
          sourceSku: duplicateSku,
          sourceOrderRef: 'EF91125A',
          supplierOrderCoverageTreatment: 'pipeline_netting',
        }),
      },
    });
    expect(materializedRows.find((row) => row.sku === duplicateSku)).toMatchObject({
      productStatus: 'active',
      companyProductFamilyId: familyId,
      familyRole: 'member',
      familyCurrentPlanningStock: 18,
      familySalesVelocity: 2,
      actionStatus: 'family_member_no_reorder',
      supplierName: 'ws billiard supply',
      unitCost: 322,
    });

    const commandCenter = await inventoryService.commandCenter({
      company,
      calculationDate: '2026-07-09',
      pane: 'inPrepMonitoring',
    });

    expect(Object.keys(commandCenter.panes)).toEqual([
      'supplyAction',
      'activeOrders',
      'inPrepMonitoring',
      'inboundMonitoring',
      'healthyInventory',
      'excessInventory',
      'stuckInventory',
      'zeroStock',
      'dataReadiness',
      'performanceReview',
      'untieredProducts',
    ]);
    expect(commandCenter.panes.inPrepMonitoring.metrics.map((metric) => metric.label)).toEqual([
      'Product count',
      'Current Sellable',
      'Amazon Pipeline',
      'Supplier Pipeline',
      'Inventory Position',
      'Estimated Reorder',
      'Value',
      'Days until Stockout',
    ]);
    expect(commandCenter.panes.inPrepMonitoring.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Product count', value: 1 }),
        expect.objectContaining({ label: 'Current Sellable', value: 11 }),
        expect.objectContaining({ label: 'Amazon Pipeline', value: 7 }),
        expect.objectContaining({ label: 'Supplier Pipeline', value: 0 }),
        expect.objectContaining({ label: 'Inventory Position', value: 18 }),
        expect.objectContaining({ label: 'Estimated Reorder', value: 72 }),
        expect.objectContaining({ label: 'Value', value: 23184, format: 'currency' }),
        expect.objectContaining({ label: 'Days until Stockout', value: 5, format: 'days' }),
      ]),
    );
    expect(commandCenter.panes.inPrepMonitoring.rows).toEqual([
      expect.objectContaining({
        sku: primarySku,
        familyRole: 'target',
        familyOnHandStock: 11,
        familyFuturePositionStock: 18,
        familyDaysOfCover: 5.5,
        familyPositionDaysOfCover: 9,
        familyTrustedSupplierOrderCoverageQty: 0,
        supplierOrderRef: 'EF91125A',
        supplierOrderRawStatus: 'prep-in-progress',
        supplierOrderOperationalStatus: 'ordered',
        supplierOrderWorkflowStage: 'in_prep',
        supplierOrderLineMappingScope: 'exact_member',
        supplierOrderSourceMemberSku: duplicateSku,
        familyMembers: expect.arrayContaining([
          expect.objectContaining({ sku: primarySku, familyRole: 'target' }),
          expect.objectContaining({ sku: duplicateSku, familyRole: 'member' }),
        ]),
      }),
    ]);
    expect(commandCenter.panes.supplyAction.rows.some((row) => row.sku === duplicateSku)).toBe(false);

    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).update({
      filterByTk: familyId,
      values: {
        preferredSupplierId: 'missing-supplier',
        preferredSupplierProductId: 'missing-supplier-product',
      },
    });
    await new EcobaseCompanyProductFamilyService(db).reconcileFamily(familyId);
    await new EcobaseInventoryPlanningService(db).refreshReadModel({
      company,
      calculationDate: '2026-07-09',
    });
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
        .all()
        .find((row) => row.sku === primarySku),
    ).toMatchObject({
      familyPreferredSupplierId: 'supplier-ws',
      familyPreferredSupplierProductId: `silver-supplier-product:supplier-ws:${asin}:${primarySku}`,
    });
  });

  it('preserves family stuck evidence while active-order precedence owns the action pane', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      applyFamilyRollups: (rows: Record<string, unknown>[], calculationDate: string) => Record<string, unknown>[];
      finalizeGoldContract: (row: Record<string, unknown>, calculationDate: string) => Record<string, unknown>;
    };
    const base = {
      companyProductFamilyId: 'family-stuck',
      replenishmentTargetCompanyProductId: 'target-product',
      familyPreferredSupplierName: 'Preferred Supplier',
      productStatus: 'Active',
      targetCoverDays: 45,
      orderSoonWindowDays: 14,
      safetyBufferDays: 15,
      salesVelocityBasis: 'historical_rolling_30_days',
      inventoryAsOfDate: '2026-07-10',
      supplierAvailability: 'resolved_silver_link',
      leadTimeAvailability: 'resolved_silver_link',
      unitCostAvailability: 'resolved_supplier_product',
      profitAvailability: 'resolved_history',
      tier: 'A',
    };
    const rows = service.applyFamilyRollups(
      [
        {
          ...base,
          companyProductId: 'target-product',
          sku: 'TARGET',
          currentPlanningStock: 61,
          onHandStock: 61,
          onHandSellableStock: 61,
          sellableStock: 61,
          salesVelocity: 1,
          salesVelocityStatus: 'trusted_positive',
          daysOfCover: 61,
          unitCost: 2,
          supplierOrderState: 'purchased_pipeline',
          supplierOrderWorkflowStage: 'in_prep',
          supplierOrderRef: 'EF-STUCK',
          openOrderCoverageQty: 5,
          expectedArrivalDate: '2026-07-20',
        },
        {
          ...base,
          companyProductId: 'member-product',
          sku: 'MEMBER',
          currentPlanningStock: 10,
          onHandStock: 0,
          onHandSellableStock: 0,
          sellableStock: 0,
          reservedStock: 10,
          salesVelocity: 0,
          salesVelocityStatus: 'trusted_zero',
          unitCost: 3,
          supplierOrderState: 'no_open_order',
          openOrderCoverageQty: 0,
        },
      ],
      '2026-07-10',
    );
    const materialized = rows.map((row) => service.finalizeGoldContract(row, '2026-07-10'));

    expect(materialized.filter((row) => row.commandCenterPane === 'inPrepMonitoring')).toEqual([
      expect.objectContaining({
        companyProductId: 'target-product',
        familyStuckAction: true,
        familyStuckAffectedMemberCount: 1,
        familyStuckAffectedUnits: 61,
        familyStuckAffectedValue: 122,
        familyStuckActiveOrderCount: 1,
        supplierOrderState: 'purchased_pipeline',
        recommendedEscalation: 'review_stuck_inventory',
      }),
    ]);
    expect(materialized.find((row) => row.companyProductId === 'member-product')).toMatchObject({
      familyStuck: true,
      familyStuckAction: false,
      commandCenterPane: 'adminExcluded',
      stuckClassification: 'none',
    });
  });

  it('routes raw imported ordered status into the in-prep monitoring pane', async () => {
    const db = new MemoryDatabase();
    const orderId = '11111111-1111-4111-8111-111111111111';
    const company = 'Ecofission LLC';
    const asin = 'B000ACTIVE';
    const sku = 'ACTIVE-SKU';
    const companyProductId = `silver-company-product:${company}:${asin}:${sku}`;
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-active-status',
      company,
      supplierId: 'supplier-active',
      supplierName: 'Active Supplier',
      externalOrderRef: 'PO-ACTIVE',
      status: 'ORDERED',
      operationalStatus: 'ordered',
      workflowStage: 'in_prep',
      expectedDeliveryDate: '2026-07-15',
    });
    await createSilverOrderLineRecord(db, {
      id: '22222222-2222-4222-8222-222222222222',
      naturalKey: 'line-active-status',
      company,
      supplierOrderId: orderId,
      supplierId: 'supplier-active',
      asin,
      sku,
      orderedQty: 100,
      receivedQty: 0,
      unitCost: 4,
      expectedSellableDate: '2026-07-20',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverOrderLines, {
      id: 'line-unresolved-status',
      orderId,
      sourceAsin: 'B00UNRESOLVED',
      sourceSupplierSku: 'SUPPLIER-ONLY-SKU',
      productMappingStatus: 'unresolved',
      orderedQty: 999,
      unitCost: 100,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-active-status',
      companyProductId,
      snapshotDate: '2026-06-07',
      sellableStock: 0,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 5,
    });
    for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-active-status-${month}`,
        companyProductId,
        snapshotDate: `${month}-15`,
        units: 300,
        sales: 3000,
        netProfit: 900,
      });
    }

    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, { calculationDate: '2026-06-07' });
    const commandCenter = await service.commandCenter({
      calculationDate: '2026-06-07',
      pane: 'inPrepMonitoring',
      pageSize: 10,
    });
    const goldRows = await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({});
    expect(goldRows).toHaveLength(1);
    expect(goldRows[0]).toMatchObject({
      commandCenterPane: 'inPrepMonitoring',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderStatus: 'paid',
      supplierOrderOperationalStatus: 'ordered',
      supplierOrderWorkflowStage: 'in_prep',
      supplierOrderSourceMemberSku: sku,
      supplierOrderLineMappingScope: 'exact_member',
      openOrderCoverageQty: 100,
    });

    expect(commandCenter.panes.inPrepMonitoring.total).toBe(1);
    expect(commandCenter.panes.inPrepMonitoring.rows[0]).toMatchObject({
      asin,
      supplierOrderRef: 'PO-ACTIVE',
      supplierOrderStatus: 'paid',
      supplierOrderState: 'purchased_pipeline',
      openOrderCoverageQty: 100,
      expectedArrivalDate: '2026-07-20',
      expectedArrivalStatus: 'imported',
      expectedArrivalSource: 'silver_order_line.expectedSellableDate',
      expectedArrivalConfidence: 'authoritative',
      expectedArrivalFreshness: 'fresh',
    });
  });

  it('separates sellable coverage from reserved, Amazon pipeline, and net trusted PO position', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    for (const scenario of [
      {
        sku: 'ON-TRACK',
        asin: 'B00ONTRACK',
        orderDate: '2026-07-01',
        expectedSellableDate: '2026-07-15',
        reserved: 100,
      },
      {
        sku: 'NO-RESERVED',
        asin: 'B00NORESERVED',
        orderDate: '2026-07-01',
        expectedSellableDate: '2026-07-15',
        reserved: 0,
      },
      {
        sku: 'OFF-TRACK',
        asin: 'B00OFFTRACK',
        orderDate: '2026-07-01',
        expectedSellableDate: '2026-07-25',
        reserved: 100,
      },
      {
        sku: 'UNKNOWN',
        asin: 'B00UNKNOWNPOS',
        orderDate: 'not-a-date',
        expectedSellableDate: undefined,
        reserved: 100,
      },
    ]) {
      const orderId = `order-position-${scenario.sku}`;
      const supplierId = `supplier-position-${scenario.sku}`;
      const companyProductId = `silver-company-product:${company}:${scenario.asin}:${scenario.sku}`;
      const supplierProductId = `silver-supplier-product:${supplierId}:${scenario.asin}:${scenario.sku}`;
      await createSilverOrderRecord(db, {
        id: orderId,
        company,
        supplierId,
        supplierName: `${scenario.sku} Supplier`,
        externalOrderRef: `PO-${scenario.sku}`,
        status: 'paid',
        orderDate: scenario.orderDate,
        authorityStatus: 'clickup_authoritative',
        authorityTaskRef: `task-${scenario.sku}`,
      });
      await createSilverOrderLineRecord(db, {
        id: `line-position-${scenario.sku}`,
        company,
        supplierOrderId: orderId,
        supplierId,
        supplierProductId,
        asin: scenario.asin,
        sku: scenario.sku,
        orderedQty: 100,
        receivedQty: 0,
        expectedSellableDate: scenario.expectedSellableDate,
      });
      if (scenario.sku === 'UNKNOWN') {
        await db
          .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
          .update({ filterByTk: supplierProductId, values: { leadTimeDays: undefined } });
      }
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-position-${scenario.sku}`,
        companyProductId,
        snapshotDate: '2026-07-10',
        sellableStock: 10,
        reserved: scenario.reserved,
        inbound: 50,
        ordered: 0,
        prepStock: 0,
        salesVelocity: 1,
      });
    }

    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, { company, calculationDate: '2026-07-10', targetCoverDays: 200 });
    const rows = await db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).find({});
    const row = (sku: string) => rows.find((candidate) => candidate.sku === sku);

    expect(row('ON-TRACK')).toMatchObject({
      sellableStock: 10,
      reservedStock: 100,
      pipelineStock: 50,
      currentPlanningStock: 160,
      onHandStock: 10,
      onHandSellableStock: 10,
      amazonPipelineStock: 50,
      supplierPipelineStock: 50,
      inventoryPositionStock: 60,
      daysOfCover: 10,
      estimatedOosDate: '2026-07-20',
      trustedSupplierOrderCoverageQty: 50,
      futurePositionStock: 110,
      positionDaysOfCover: 110,
      positionEstimatedOosDate: '2026-10-28',
      suggestedReorderQty: 90,
      expectedArrivalDate: '2026-07-15',
      pipelineHealthStatus: 'on_track',
      stockoutGapDays: -5,
    });
    expect(row('NO-RESERVED')).toMatchObject({
      reservedStock: 0,
      currentPlanningStock: 60,
      onHandSellableStock: 10,
      amazonPipelineStock: 50,
      supplierPipelineStock: 50,
      inventoryPositionStock: 60,
      futurePositionStock: 110,
      daysOfCover: 10,
      suggestedReorderQty: 90,
    });
    expect(row('OFF-TRACK')).toMatchObject({
      estimatedOosDate: '2026-07-20',
      expectedArrivalDate: '2026-07-25',
      pipelineHealthStatus: 'late',
      stockoutGapDays: 5,
    });
    expect(row('UNKNOWN')).toMatchObject({
      estimatedOosDate: '2026-07-20',
      expectedArrivalStatus: 'unknown',
      pipelineHealthStatus: 'unknown_timing',
      stockoutGapDays: null,
    });

    const commandCenter = await service.commandCenter({ calculationDate: '2026-07-10', pageSize: 100 });
    expect(commandCenter.panes.untieredProducts.rows.find((candidate) => candidate.sku === 'ON-TRACK')).toMatchObject({
      onHandStock: 10,
      onHandSellableStock: 10,
      amazonPipelineStock: 50,
      supplierPipelineStock: 50,
      inventoryPositionStock: 60,
      futurePositionStock: 110,
      daysOfCover: 10,
      positionDaysOfCover: 110,
      trustedSupplierOrderCoverageQty: 50,
    });
  });

  it('separates family inventory position from supplier pipeline future position', () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase()) as unknown as {
      applyFamilyRollups: (rows: Record<string, unknown>[], calculationDate: string) => Record<string, unknown>[];
    };

    const [row] = service.applyFamilyRollups(
      [
        {
          companyProductFamilyId: 'family-position',
          replenishmentTargetCompanyProductId: 'target-position',
          companyProductId: 'target-position',
          familyRole: 'target',
          onHandSellableStock: 10,
          amazonPipelineStock: 5,
          supplierOrderPurchasedOpenQty: 25,
          supplierOrderStale: false,
          salesVelocity: 1,
          targetCoverDays: 45,
        },
      ],
      '2026-07-10',
    );

    expect(row).toMatchObject({
      familyOnHandSellableStock: 10,
      familyAmazonPipelineStock: 5,
      familySupplierPipelineStock: 20,
      familyInventoryPositionStock: 15,
      familyFuturePositionStock: 35,
      familyPositionDaysOfCover: 35,
      familySuggestedReorderQty: 10,
    });
  });

  it('recalculates stale coverage and suggested quantity after an expected-date override', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    const orderId = '54444444-4444-4444-8444-444444444444';
    const lineId = 'line-54444444-4444-4444-8444-444444444444';
    const asin = 'B00DATEOVERRIDE';
    const sku = 'DATE-OVERRIDE';
    const companyProductId = `silver-company-product:${company}:${asin}:${sku}`;
    await createSilverOrderRecord(db, {
      id: orderId,
      company,
      supplierId: 'supplier-date-override',
      supplierName: 'Date Override Supplier',
      externalOrderRef: 'PO-DATE-OVERRIDE',
      status: 'paid',
      orderDate: '2026-05-01',
    });
    await createSilverOrderLineRecord(db, {
      id: lineId,
      company,
      supplierOrderId: orderId,
      supplierId: 'supplier-date-override',
      asin,
      sku,
      orderedQty: 10,
      receivedQty: 0,
      expectedSellableDate: '2026-06-01',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-date-override',
      companyProductId,
      snapshotDate: '2026-07-14',
      sellableStock: 10,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 1,
    });

    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, {
      calculationDate: '2026-07-14',
      idempotencyKey: 'before-expected-date-override',
    });
    const [stale] = await service.listRows({ company, calculationDate: '2026-07-14' });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).update({
      filterByTk: lineId,
      values: {
        expectedSellableDate: '2026-08-01',
        expectedDateOverrideAt: '2026-07-14T00:00:00.000Z',
        expectedDateOverrideReason: 'Supplier confirmed revised timing.',
      },
    });
    await refreshAndPublish(service, {
      calculationDate: '2026-07-14',
      idempotencyKey: 'after-expected-date-override',
    });
    const [fresh] = await service.listRows({ company, calculationDate: '2026-07-14' });

    expect(stale).toMatchObject({ supplierOrderStale: true, trustedSupplierOrderCoverageQty: 0 });
    expect(fresh).toMatchObject({ supplierOrderStale: false, trustedSupplierOrderCoverageQty: 10 });
    expect(stale.suggestedReorderQty).toBe(Number(fresh.suggestedReorderQty) + 10);
  });

  it('classifies derived, unknown, invalid, and stale active-order arrival evidence', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    for (const order of [
      {
        id: '51111111-1111-4111-8111-111111111111',
        asin: 'B00DERIVED',
        sku: 'DERIVED-ETA',
        orderDate: '2026-06-01',
        leadTimeDays: 30,
      },
      {
        id: '52222222-2222-4222-8222-222222222222',
        asin: 'B00UNKNOWN',
        sku: 'UNKNOWN-ETA',
        orderDate: 'not-a-date',
        expectedSellableDate: 'not-a-date',
      },
      {
        id: '53333333-3333-4333-8333-333333333333',
        asin: 'B00STALEETA',
        sku: 'STALE-ETA',
        orderDate: '2026-05-01',
        leadTimeDays: 30,
        expectedSellableDate: '2026-06-01',
      },
    ]) {
      const supplierId = `supplier-${order.sku}`;
      const companyProductId = `silver-company-product:${company}:${order.asin}:${order.sku}`;
      const supplierProductId = `silver-supplier-product:${supplierId}:${order.asin}:${order.sku}`;
      await createSilverOrderRecord(db, {
        id: order.id,
        company,
        supplierId,
        supplierName: `${order.sku} Supplier`,
        externalOrderRef: `PO-${order.sku}`,
        status: 'ORDERED',
        orderDate: order.orderDate,
        authorityStatus: order.sku === 'DERIVED-ETA' ? 'clickup_authoritative' : 'alternate_authoritative',
        authoritySource: order.sku === 'DERIVED-ETA' ? 'clickup_csv' : 'silver_status_evidence',
        authorityTaskRef: order.sku === 'DERIVED-ETA' ? 'task-derived-eta' : undefined,
        authorityAsOf: `${order.orderDate}T00:00:00.000Z`,
        authorityEvidenceJson: { orderRef: `PO-${order.sku}` },
      });
      await createSilverOrderLineRecord(db, {
        id: `line-${order.id}`,
        company,
        supplierOrderId: order.id,
        supplierId,
        supplierProductId,
        asin: order.asin,
        sku: order.sku,
        orderedQty: 10,
        receivedQty: 0,
        leadTimeDays: order.leadTimeDays,
        expectedSellableDate: order.expectedSellableDate,
      });
      if (order.sku === 'UNKNOWN-ETA') {
        await db
          .getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts)
          .update({ filterByTk: supplierProductId, values: { leadTimeDays: undefined } });
      }
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-${order.sku}`,
        companyProductId,
        snapshotDate: '2026-06-07',
        sellableStock: 400,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: 1,
      });
      for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
        await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
          id: `fact-${order.sku}-${month}`,
          companyProductId,
          snapshotDate: `${month}-15`,
          units: 300,
          sales: 3000,
          netProfit: order.sku === 'UNKNOWN-ETA' ? 0 : 900,
        });
      }
    }

    await createRecord(db, 'users', {
      id: 202,
      email: 'clickup-user@example.com',
      nickname: 'ClickUp User',
    });
    await createSilverActivityCommentRecord(db, {
      id: 'activity-derived-eta',
      supplierOrderId: '51111111-1111-4111-8111-111111111111',
      activityType: 'status_update',
      actor: 'clickup-user@example.com',
      actorUserId: '202',
      notes: 'Supplier confirmed dispatch.',
      occurredAt: '2026-06-06T12:00:00.000Z',
      source: 'clickup_csv',
    });
    await createSilverActivityCommentRecord(db, {
      id: 'activity-derived-eta-older-imported-last',
      supplierOrderId: '51111111-1111-4111-8111-111111111111',
      activityType: 'note',
      actor: 'clickup-user@example.com',
      actorUserId: '202',
      notes: 'Older activity imported after the latest comment.',
      occurredAt: '2026-06-05T12:00:00.000Z',
      source: 'clickup_csv',
    });
    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, { company, calculationDate: '2026-06-07' });
    const commandCenter = await service.commandCenter({
      company,
      calculationDate: '2026-06-07',
      pageSize: 10,
    });
    const activeRows = Object.values(commandCenter.panes).flatMap((pane) => pane.rows);
    const row = (sku: string) => activeRows.find((item) => item.sku === sku);
    expect(row('DERIVED-ETA')).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      expectedArrivalDate: '2026-07-08',
      expectedArrivalStatus: 'derived',
      expectedArrivalConfidence: 'estimated',
      expectedArrivalFreshness: 'fresh',
      pipelineHealthStatus: 'on_track',
      commandCenterPane: 'dataReadiness',
      planningEligibilityStatus: 'needs_data_readiness',
      dataQualityStatus: 'blocked',
      supplierOrderAuthorityStatus: 'clickup_authoritative',
      supplierOrderAuthoritySource: 'clickup_csv',
      supplierOrderAuthorityTaskRef: 'task-derived-eta',
      latestSupplierOrderActivityAt: '2026-06-06T12:00:00.000Z',
      latestSupplierOrderActivityNote: 'Supplier confirmed dispatch.',
      latestSupplierOrderActivityActor: 'clickup-user@example.com',
      latestSupplierOrderActivityActorUserId: '202',
      latestSupplierOrderActivityActorDisplayName: 'ClickUp User',
      latestSupplierOrderActivityActorEmail: 'clickup-user@example.com',
      recommendedEscalation: 'recover_supplier',
    });
    expect(row('UNKNOWN-ETA')).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      tier: undefined,
      expectedArrivalStatus: 'unknown',
      expectedArrivalConfidence: 'none',
      expectedArrivalFreshness: 'unknown',
      pipelineHealthStatus: 'unknown_timing',
      commandCenterPane: 'untieredProducts',
      dataQualityStatus: 'blocked',
    });
    expect(row('STALE-ETA')).toMatchObject({
      supplierOrderState: 'purchased_pipeline',
      expectedArrivalDate: '2026-06-01',
      expectedArrivalStatus: 'imported',
      expectedArrivalFreshness: 'stale',
      pipelineHealthStatus: 'late',
      commandCenterPane: 'dataReadiness',
    });
  });

  it('does not count completed order history as open coverage', async () => {
    const db = new MemoryDatabase();
    const orderId = '33333333-3333-4333-8333-333333333333';
    const company = 'Ecofission LLC';
    const asin = 'B000CLOSED';
    const sku = 'CLOSED-SKU';
    const companyProductId = `silver-company-product:${company}:${asin}:${sku}`;
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-closed-status',
      company,
      supplierId: 'supplier-closed',
      supplierName: 'Closed Supplier',
      externalOrderRef: 'PO-CLOSED',
      status: 'COMPLETE',
    });
    await createSilverOrderLineRecord(db, {
      id: '44444444-4444-4444-8444-444444444444',
      naturalKey: 'line-closed-status',
      company,
      supplierOrderId: orderId,
      supplierId: 'supplier-closed',
      asin,
      sku,
      orderedQty: 100,
      receivedQty: 0,
      unitCost: 4,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
      id: 'inventory-closed-status',
      companyProductId,
      snapshotDate: '2026-06-07',
      sellableStock: 0,
      reserved: 0,
      inbound: 0,
      ordered: 0,
      prepStock: 0,
      salesVelocity: 5,
    });
    for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-closed-status-${month}`,
        companyProductId,
        snapshotDate: `${month}-15`,
        units: 300,
        sales: 3000,
        netProfit: 900,
      });
    }

    await new EcobaseInventoryPlanningService(db).refreshReadModel({ calculationDate: '2026-06-07' });
    const row = db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .all()
      .find((item) => item.asin === asin);

    expect(row).toMatchObject({
      supplierOrderRef: 'PO-CLOSED',
      supplierOrderStatus: 'completed',
      supplierOrderState: 'closed_history',
      supplierOrderOpenQty: 0,
      openOrderCoverageQty: 0,
    });
  });

  it('keeps receipt evidence visible for untiered products without routing them into operational panes', async () => {
    const db = new MemoryDatabase();
    const company = 'Ecofission LLC';
    for (const fixture of [
      {
        suffix: 'PARTIAL',
        sourceStatus: 'inbound-monitoring',
        receiptStatus: 'partially_observed',
        lineReceiptStatus: 'amazon_stock_observed',
        observedQty: 4,
        sellableStock: 0,
      },
      {
        suffix: 'LATER',
        sourceStatus: 'inbound-monitoring',
        receiptStatus: 'completed_by_later_inbound',
        lineReceiptStatus: 'completed_by_later_inbound',
        observedQty: undefined,
        sellableStock: 0,
      },
      {
        suffix: 'HEALTHY',
        sourceStatus: 'inbound-monitoring',
        receiptStatus: 'amazon_stock_observed',
        lineReceiptStatus: 'amazon_stock_observed',
        observedQty: 10,
        sellableStock: 5,
      },
      {
        suffix: 'DIRECT',
        sourceStatus: 'direct-ship-fba',
        receiptStatus: 'awaiting_amazon_stock',
        lineReceiptStatus: 'awaiting_amazon_stock',
        observedQty: undefined,
        sellableStock: 0,
      },
    ]) {
      const orderId = `order-${fixture.suffix}`;
      const asin = `B000${fixture.suffix}`;
      const sku = `${fixture.suffix}-SKU`;
      const companyProductId = `silver-company-product:${company}:${asin}:${sku}`;
      await createSilverOrderRecord(db, {
        id: orderId,
        company,
        supplierId: `supplier-${fixture.suffix}`,
        externalOrderRef: `PO-${fixture.suffix}`,
        status: 'shipped_inbound',
        authorityEvidenceJson: { clickupStatusEvidence: { clickupStatus: fixture.sourceStatus } },
        amazonReceiptStatus: fixture.receiptStatus,
        amazonReceiptObservedAt: '2026-06-07T00:00:00.000Z',
        amazonReceiptCompletionReason: 'receipt-test',
        amazonReceiptEvidenceJson: { evidenceKey: `order-${fixture.suffix}` },
      });
      await createSilverOrderLineRecord(db, {
        id: `line-${fixture.suffix}`,
        company,
        supplierOrderId: orderId,
        supplierId: `supplier-${fixture.suffix}`,
        asin,
        sku,
        orderedQty: 10,
        receivedQty: 9,
        amazonReceiptStatus: fixture.lineReceiptStatus,
        amazonReceiptObservedQty: fixture.observedQty,
        amazonReceiptObservedAt: '2026-06-07T00:00:00.000Z',
        amazonReceiptCompletionReason: 'receipt-test',
        amazonReceiptEvidenceJson: { evidenceKey: `line-${fixture.suffix}` },
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `inventory-${fixture.suffix}`,
        companyProductId,
        snapshotDate: '2026-06-07',
        sellableStock: fixture.sellableStock,
        reserved: 0,
        inbound: 0,
        ordered: 0,
        prepStock: 0,
        salesVelocity: 1,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverListingDailyFacts, {
        id: `fact-${fixture.suffix}`,
        companyProductId,
        snapshotDate: '2026-06-06',
        units: 30,
        sales: 300,
        profit: 90,
      });
    }

    const service = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(service, { calculationDate: '2026-06-07' });
    const rows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    const row = (asin: string) => rows.find((item) => item.asin === asin);
    expect(row('B000PARTIAL')).toMatchObject({
      openOrderCoverageQty: 6,
      supplierOrderOpenQty: 6,
      supplierOrderState: 'purchased_pipeline',
      amazonReceiptStatus: 'partially_observed',
      amazonReceiptObservedAt: '2026-06-07T00:00:00.000Z',
      amazonReceiptCompletionReason: 'receipt-test',
      amazonReceiptEvidenceJson: { evidenceKey: 'order-PARTIAL' },
      commandCenterPane: 'untieredProducts',
    });
    expect(row('B000LATER')).toMatchObject({
      openOrderCoverageQty: 0,
      supplierOrderOpenQty: 0,
      supplierOrderState: 'closed_history',
      amazonReceiptStatus: 'completed_by_later_inbound',
      commandCenterPane: 'untieredProducts',
    });
    expect(row('B000HEALTHY')).toMatchObject({
      openOrderCoverageQty: 0,
      supplierOrderState: 'closed_history',
      amazonReceiptStatus: 'amazon_stock_observed',
      commandCenterPane: 'untieredProducts',
    });
    expect(row('B000DIRECT')).toMatchObject({
      openOrderCoverageQty: 10,
      supplierOrderState: 'purchased_pipeline',
      amazonReceiptStatus: 'awaiting_amazon_stock',
      commandCenterPane: 'untieredProducts',
    });

    const commandCenter = await service.commandCenter({ calculationDate: '2026-06-07', pageSize: 20 });
    expect(commandCenter.panes.untieredProducts.rows.map((item) => item.asin)).toContain('B000PARTIAL');
    expect(commandCenter.panes.untieredProducts.rows.find((item) => item.asin === 'B000PARTIAL')).toMatchObject({
      supplierOrderRef: 'PO-PARTIAL',
      inboundMonitoringEvidence: {
        matchState: 'exact_order_reference',
        matchedOrderReference: 'PO-PARTIAL',
        statusEvidence: 'inbound-monitoring',
        stockEvidence: {
          onHandSellableStock: 0,
          amazonPipelineStock: 0,
          inventoryAsOfDate: '2026-06-07',
          receiptStatus: 'partially_observed',
          receiptObservedAt: '2026-06-07T00:00:00.000Z',
        },
      },
    });
    expect(commandCenter.panes.untieredProducts.rows.map((item) => item.asin)).toEqual(
      expect.arrayContaining(['B000HEALTHY', 'B000DIRECT', 'B000LATER']),
    );
    const routedIds = Object.values(commandCenter.panes).flatMap((pane) => pane.rows.map((item) => item.id));
    expect(new Set(routedIds).size).toBe(routedIds.length);
  });

  it('projects persisted latest active-order activity without request-time reclassification', async () => {
    const db = new MemoryDatabase();
    const orderId = '11111111-1111-4111-8111-111111111111';
    await createRecord(db, 'users', {
      id: 201,
      email: 'nauman.ecofission@gmail.com',
      nickname: 'Ahmed Nauman',
    });
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-author',
      company: 'Ecofission LLC',
      externalOrderRef: 'ORD-AUTHOR',
      status: 'approval_pending',
    });
    await createSilverActivityCommentRecord(db, {
      id: '55555555-5555-4555-8555-555555555555',
      naturalKey: 'activity-author',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      activityType: 'note',
      actor: 'nauman.ecofission@gmail.com',
      actorUserId: '201',
      notes: 'Will proceed with the order on Monday.',
      occurredAt: '2026-06-07T14:00:00.000Z',
      source: 'clickup',
    });
    await createSilverActivityCommentRecord(db, {
      id: '66666666-6666-4666-8666-666666666666',
      naturalKey: 'activity-author-deleted',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      activityType: 'note',
      actor: 'operator',
      notes: 'Deleted comment should not drive table preview.',
      occurredAt: '2026-06-07T15:00:00.000Z',
      deletedAt: '2026-06-07T16:00:00.000Z',
      source: 'manual',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'active-author',
      naturalKey: 'active-author',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'B000AUTHOR',
      sku: 'SKU-AUTHOR',
      title: 'Author row',
      actionStatus: 'already_ordered',
      tier: 'A',
      productStatus: 'Active',
      familyRole: 'target',
      sellableStock: 10,
      reservedStock: 0,
      orderedStock: 0,
      prepStock: 0,
      inboundStock: 0,
      awdStock: 0,
      supplierPipelineStock: 1,
      onHandSellableStock: 10,
      estimatedProfitRisk: 120,
      supplierOrderState: 'purchased_pipeline',
      supplierOrderWorkflowStage: 'pre_purchase',
      supplierOrderRef: 'ORD-AUTHOR',
      commandCenterPane: 'activeOrders',
      latestSupplierOrderActivityAt: new Date('2026-06-07T14:00:00.000Z'),
      latestSupplierOrderActivityActor: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityActorUserId: '201',
      latestSupplierOrderActivityActorDisplayName: 'Ahmed Nauman',
      latestSupplierOrderActivityActorEmail: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityNote: 'Will proceed with the order on Monday.',
      latestSupplierOrderActivitySource: 'clickup',
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({
      calculationDate: '2026-06-07',
      pane: 'activeOrders',
      pageSize: 10,
    });

    expect(commandCenter.panes.activeOrders.rows[0]).toMatchObject({
      latestSupplierOrderActivityAt: '2026-06-07T14:00:00.000Z',
      latestSupplierOrderActivityActor: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityActorUserId: '201',
      latestSupplierOrderActivityActorDisplayName: 'Ahmed Nauman',
      latestSupplierOrderActivityActorEmail: 'nauman.ecofission@gmail.com',
      latestSupplierOrderActivityNote: 'Will proceed with the order on Monday.',
      latestSupplierOrderActivitySource: 'clickup',
    });
  });

  it('returns drawer order history for a primary SKU when the order used a duplicate alias SKU', async () => {
    const db = new MemoryDatabase();
    const supplierId = '77777777-7777-4777-8777-777777777777';
    const orderId = '88888888-8888-4888-8888-888888888888';
    await createSilverOrderRecord(db, {
      id: orderId,
      company: 'Ecofission LLC',
      supplierId,
      supplierName: 'Alias Supplier',
      externalOrderRef: 'ALIAS-ORDER-1',
      status: 'approval_pending',
    });
    await createSilverOrderLineRecord(db, {
      id: '99999999-9999-4999-8999-999999999999',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      asin: 'B000ALIAS',
      sku: 'ALIAS-SKU',
      orderedQty: 5,
    });

    const workspace = await new EcobaseInventoryPlanningService(db).rowWorkspace({
      company: 'Ecofission LLC',
      asin: 'B000ALIAS',
      sku: 'PRIMARY-SKU',
      supplierId,
    });

    expect(workspace.orderLineHistory).toEqual([
      expect.objectContaining({
        asin: 'B000ALIAS',
        sku: 'ALIAS-SKU',
        order: expect.objectContaining({ externalOrderRef: 'ALIAS-ORDER-1' }),
      }),
    ]);
  });

  it('shapes row drawer supplier/order history behind the inventory workspace interface', async () => {
    const db = new MemoryDatabase();
    const supplierId = '33333333-3333-4333-8333-333333333333';
    const orderId = '11111111-1111-4111-8111-111111111111';
    await createSilverOrderRecord(db, {
      id: orderId,
      naturalKey: 'order-drawer',
      company: 'Ecofission LLC',
      supplierId,
      supplierName: 'Drawer Supplier',
      externalOrderRef: 'DRAWER-1',
      status: 'approval_pending',
      lastMeaningfulUpdateAt: '2026-06-07T12:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: '44444444-4444-4444-8444-444444444444',
      naturalKey: 'line-drawer',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      asin: 'B000DRAWER',
      sku: 'DRAWER-SKU',
      orderedQty: 12,
      receivedQty: 0,
      observedAt: '2026-06-07T13:00:00.000Z',
    });
    await createRecord(db, 'users', {
      id: 201,
      email: 'nauman.ecofission@gmail.com',
      nickname: 'Ahmed Nauman',
    });
    await createSilverActivityCommentRecord(db, {
      id: '55555555-5555-4555-8555-555555555555',
      naturalKey: 'activity-drawer',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      activityType: 'status_update',
      actor: 'nauman.ecofission@gmail.com',
      actorUserId: '201',
      notes: 'Waiting on payment.',
      occurredAt: new Date('2026-06-07T14:00:00.000Z'),
    });
    await createSilverActivityCommentRecord(db, {
      id: '66666666-6666-4666-8666-666666666666',
      naturalKey: 'activity-drawer-deleted',
      company: 'Ecofission LLC',
      supplierOrderId: orderId,
      supplierId,
      activityType: 'note',
      actor: 'operator',
      notes: 'Deleted but retained.',
      occurredAt: '2026-06-07T15:00:00.000Z',
      deletedAt: '2026-06-07T16:00:00.000Z',
      deletedById: '201',
      source: 'manual',
    });

    const workspace = await new EcobaseInventoryPlanningService(db).rowWorkspace({
      company: 'Ecofission LLC',
      asin: 'B000DRAWER',
      sku: 'DRAWER-SKU',
      supplierId,
    });

    expect(workspace.suppliers).toHaveLength(1);
    expect(workspace.orderLineHistory[0]).toMatchObject({
      asin: 'B000DRAWER',
      order: { externalOrderRef: 'DRAWER-1' },
    });
    expect(workspace.orderActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorDisplayName: 'Ahmed Nauman',
          actorEmail: 'nauman.ecofission@gmail.com',
          occurredAt: '2026-06-07T14:00:00.000Z',
          notes: 'Waiting on payment.',
        }),
        expect.objectContaining({
          id: '66666666-6666-4666-8666-666666666666',
          deletedAt: '2026-06-07T16:00:00.000Z',
          notes: 'Deleted but retained.',
        }),
      ]),
    );
    expect(workspace.initialOrderEdit).toMatchObject({ supplierOrderId: orderId, status: 'approval_pending' });
    expect(workspace.actionDefaults).toMatchObject({
      draftSupplierId: supplierId,
      leadSupplierId: supplierId,
      addSupplierOrderId: orderId,
    });
  });

  it('keeps the daily digest bounded to order-now risk and supplier contact priorities', async () => {
    const db = new MemoryDatabase();
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'gold-risk-1',
      calculationDate: '2026-06-07',
      planningProductId: 'planning-product-1',
      company: 'Ecofission LLC',
      asin: 'B000RISK',
      sku: 'SKU-RISK',
      tier: 'A',
      productStatus: 'Active',
      familyRole: 'target',
      actionStatus: 'order_today',
      supplierName: 'Digest Supplier',
      supplierOrderState: 'placed_not_purchased',
      supplierOrderStatus: 'approval_pending',
      supplierOrderRef: 'ORD-1',
      leadTimeFreshness: 'fresh',
      digestPriority: 1,
    });
    await createSilverOrderRecord(db, {
      id: '11111111-1111-4111-8111-111111111111',
      naturalKey: 'order-1',
      sourceConnectionId: '22222222-2222-4222-8222-222222222222',
      company: 'Ecofission LLC',
      supplierId: '33333333-3333-4333-8333-333333333333',
      externalOrderRef: 'ORD-1',
      sourceStage: 'manual',
      status: 'approval_pending',
      statusSource: 'manual',
      orderDate: '2026-06-07',
    });
    await createSilverOrderLineRecord(db, {
      id: '44444444-4444-4444-8444-444444444444',
      naturalKey: 'order-line-1',
      supplierOrderId: '11111111-1111-4111-8111-111111111111',
      company: 'Ecofission LLC',
      supplierId: '33333333-3333-4333-8333-333333333333',
      planningProductId: 'planning-product-1',
      asin: 'B000RISK',
      sku: 'SKU-RISK',
      orderedQty: 5,
      receivedQty: 0,
      sourceOrderLineRef: 'ORD-1:B000RISK',
      sourceStage: 'manual',
    });
    await createSilverActivityCommentRecord(db, {
      id: '55555555-5555-4555-8555-555555555555',
      naturalKey: 'activity-1',
      supplierOrderId: '11111111-1111-4111-8111-111111111111',
      supplierId: '33333333-3333-4333-8333-333333333333',
      company: 'Ecofission LLC',
      activityType: 'status_update',
      occurredAt: '2026-06-07T12:00:00.000Z',
      notes: 'Invoice received, payment still pending.',
      source: 'manual',
    });

    const digest = await new EcobaseInventoryPlanningService(db).digestPreview({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
    });

    expect(digest.summary).toMatchObject({ orderToday: 1, atRisk: 1, suppliersToContact: 0 });
    expect(digest.sections.orderNow).toHaveLength(1);
    expect(digest.sections.orderNow[0]).toMatchObject({
      supplierOrderRef: 'ORD-1',
      latestSupplierOrderActivityNote: 'Invoice received, payment still pending.',
    });
    expect(digest.sections.supplierActionItems).toEqual([]);
    expect(digest.sections.suppliersToContactFirst).toEqual([]);
  });

  it('puts no-order digest rows before placed-but-not-purchased rows and excludes purchased pipeline rows', async () => {
    const db = new MemoryDatabase();
    const digestRows = [
      {
        id: 'no-order',
        actionStatus: 'overdue',
        supplierOrderState: 'no_open_order',
        leadTimeFreshness: 'fresh',
        digestPriority: 1,
      },
      {
        id: 'payment-pending',
        actionStatus: 'order_today',
        supplierOrderState: 'placed_not_purchased',
        supplierOrderStatus: 'payment_pending',
        supplierOrderRef: 'PP-1',
        leadTimeFreshness: 'stale',
        digestPriority: 2,
      },
      {
        id: 'approval-soon',
        actionStatus: 'order_soon',
        supplierOrderState: 'placed_not_purchased',
        supplierOrderStatus: 'approval_pending',
        supplierOrderRef: 'APP-1',
        leadTimeFreshness: 'fresh',
        digestPriority: 3,
      },
      {
        id: 'paid-pipeline',
        actionStatus: 'order_today',
        supplierOrderState: 'purchased_pipeline',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PAID-1',
        leadTimeFreshness: 'fresh',
        digestPriority: 4,
      },
      {
        id: 'paid-evidence',
        actionStatus: 'order_today',
        supplierOrderState: 'purchased_pipeline',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PAID-EVIDENCE-1',
        leadTimeFreshness: 'fresh',
        digestPriority: 5,
      },
    ];
    for (const row of digestRows) {
      await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
        id: `gold-${row.id}`,
        calculationDate: '2026-06-07',
        planningProductId: row.id,
        company: 'Ecofission LLC',
        asin: `ASIN-${row.id}`,
        sku: `SKU-${row.id}`,
        tier: 'A',
        productStatus: 'Active',
        familyRole: 'target',
        supplierName: 'Digest Supplier',
        openOrderCoverageQty: 0,
        ...row,
      });
    }

    await createSilverOrderRecord(db, {
      id: 'order-payment-pending',
      naturalKey: 'supplier-order:Ecofission LLC:PP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'PP-1',
      sourceStage: 'manual',
      status: 'payment_pending',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-payment-pending',
      naturalKey: 'supplier-order-line:PP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-payment-pending',
      planningProductId: 'payment-pending',
      asin: 'ASIN-payment-pending',
      sku: 'SKU-payment-pending',
      orderedQty: 20,
      receivedQty: 0,
    });
    await createSilverOrderRecord(db, {
      id: 'order-old-paid',
      naturalKey: 'supplier-order:Ecofission LLC:OLD-PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'OLD-PAID-1',
      sourceStage: 'purchase_order',
      status: 'paid',
      lastMeaningfulUpdateAt: '2026-06-01T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-old-paid',
      naturalKey: 'supplier-order-line:OLD-PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-old-paid',
      planningProductId: 'payment-pending',
      asin: 'ASIN-payment-pending',
      sku: 'SKU-payment-pending',
      orderedQty: 90,
      receivedQty: 0,
      expectedSellableDate: '2026-06-20',
    });
    await createSilverOrderRecord(db, {
      id: 'order-approval-soon',
      naturalKey: 'supplier-order:Ecofission LLC:APP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'APP-1',
      sourceStage: 'manual',
      status: 'approval_pending',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-approval-soon',
      naturalKey: 'supplier-order-line:APP-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-approval-soon',
      planningProductId: 'approval-soon',
      asin: 'ASIN-approval-soon',
      sku: 'SKU-approval-soon',
      orderedQty: 20,
      receivedQty: 0,
    });
    await createSilverOrderRecord(db, {
      id: 'order-paid-pipeline',
      naturalKey: 'supplier-order:Ecofission LLC:PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'PAID-1',
      sourceStage: 'manual',
      status: 'paid',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-paid-pipeline',
      naturalKey: 'supplier-order-line:PAID-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-paid-pipeline',
      planningProductId: 'paid-pipeline',
      asin: 'ASIN-paid-pipeline',
      sku: 'SKU-paid-pipeline',
      orderedQty: 20,
      receivedQty: 0,
    });
    await createSilverOrderRecord(db, {
      id: 'order-paid-evidence',
      naturalKey: 'supplier-order:Ecofission LLC:PAID-EVIDENCE-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierId: 'supplier-1',
      externalOrderRef: 'PAID-EVIDENCE-1',
      sourceStage: 'purchase_order',
      status: 'approval_pending',
      paymentStatus: 'Completed',
      approvalStatus: 'Approved',
      lastMeaningfulUpdateAt: '2026-06-06T00:00:00.000Z',
    });
    await createSilverOrderLineRecord(db, {
      id: 'line-paid-evidence',
      naturalKey: 'supplier-order-line:PAID-EVIDENCE-1',
      sourceConnectionId: 'source-1',
      company: 'Ecofission LLC',
      supplierOrderId: 'order-paid-evidence',
      planningProductId: 'paid-evidence',
      asin: 'ASIN-paid-evidence',
      sku: 'SKU-paid-evidence',
      orderedQty: 20,
      receivedQty: 0,
    });

    const digest = await new EcobaseInventoryPlanningService(db).digestPreview({
      company: 'Ecofission LLC',
      calculationDate: '2026-06-07',
      limit: 1,
    });

    expect(digest.summary).toMatchObject({ noSupplierOrder: 1, placedNotPurchased: 2, purchasedPipelineExcluded: 2 });
    expect(digest.sections.orderNow.map((row) => row.planningProductId)).toEqual([
      'no-order',
      'payment-pending',
      'approval-soon',
    ]);
    expect(digest.sections.orderNow[0]).toMatchObject({ supplierOrderState: 'no_open_order' });
    expect(digest.sections.noOrderProducts.map((row) => row.planningProductId)).toEqual(['no-order']);
    expect(digest.sections.orderNow[1]).toMatchObject({
      supplierOrderState: 'placed_not_purchased',
      supplierOrderStatus: 'payment_pending',
      supplierOrderRef: 'PP-1',
      openOrderCoverageQty: 0,
    });
    expect(digest.sections.orderNow[2]).toMatchObject({
      actionStatus: 'order_soon',
      supplierOrderState: 'placed_not_purchased',
      supplierOrderStatus: 'approval_pending',
      supplierOrderRef: 'APP-1',
      openOrderCoverageQty: 0,
    });
    expect(digest.sections.supplierActionItems.map((row) => row.planningProductId)).toEqual(['payment-pending']);
    expect(digest.sections.suppliersToContactFirst).toEqual([
      expect.objectContaining({ supplierName: 'Digest Supplier', urgentCount: 1 }),
    ]);
  });

  it('accepts the four-company current-only fixture end to end and remains idempotent', async () => {
    const fixture = currentOnlyAcceptanceFixture;
    const db = new MemoryDatabase({ historyLoaded: false });
    (db as MemoryDatabase & { sequelize: unknown }).sequelize = {
      transaction: async (run: (transaction: object) => Promise<unknown>) => run({ id: 'fixture-transaction' }),
    };

    for (const company of fixture.companies) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanies, company);
    }
    for (const account of fixture.accounts) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverAmazonAccounts, account);
    }
    for (const listing of fixture.listings) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverProducts, {
        id: listing.productId,
        asin: listing.asin,
        sku: listing.sku,
        title: `Synthetic ${listing.sku}`,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProducts, {
        id: listing.id,
        companyId: listing.companyId,
        amazonAccountId: listing.amazonAccountId,
        productId: listing.productId,
        lifecycleStatus: 'active',
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverInventorySnapshots, {
        id: `snapshot-${listing.id}`,
        companyProductId: listing.id,
        snapshotDate: fixture.calculationDate,
        sellableStock: listing.sellableStock,
        reserved: listing.reserved,
        inbound: listing.inbound,
        ordered: 0,
        prepStock: 0,
        ...('salesVelocity' in listing ? { salesVelocity: listing.salesVelocity } : {}),
      });
    }
    for (const supplier of fixture.suppliers) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverSuppliers, supplier);
    }
    for (const supplierRef of fixture.acceptedSupplierRefs) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverSupplierExternalRefs, {
        ...supplierRef,
        sourceSystem: 'synthetic-current-only-fixture',
        normalizedExternalSupplierCode: supplierRef.externalSupplierCode,
      });
    }
    for (const order of fixture.orders) {
      await createRecord(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
        id: order.supplierProductId,
        supplierId: order.supplierId,
        productId: order.productId,
        supplierSku: order.sourceSupplierSku,
        unitCost: 10,
        leadTimeDays: 14,
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverOrders, {
        id: order.id,
        companyId: order.companyId,
        supplierId: order.supplierId,
        orderRef: order.orderRef,
        orderDate: fixture.calculationDate,
        orderIntent: 'purchase_order',
        canonicalStatus: 'paid',
        lifecycleStatus: 'paid',
        authorityStatus: order.clickupTaskRef ? 'clickup_authoritative' : 'alternate_authoritative',
        authoritySource: order.clickupTaskRef ? 'clickup' : 'synthetic_fixture',
        authorityTaskRef: order.clickupTaskRef,
        authorityEvidenceJson: order.clickupTaskRef
          ? { clickupStatusEvidence: { clickupStatus: 'paid', taskRef: order.clickupTaskRef } }
          : {},
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverOrderLines, {
        id: `line-${order.id}`,
        orderId: order.id,
        companyProductId: order.companyProductId,
        supplierProductId: order.supplierProductId,
        orderedQty: 20,
        confirmedQty: 0,
        unitCost: 10,
        expectedSellableDate: order.expectedSellableDate,
        sourceAsin: order.sourceAsin,
        sourceSupplierSku: order.sourceSupplierSku,
        productMappingStatus: 'resolved',
        productMappingEvidenceJson: { method: 'exact', fixture: 'current-only-acceptance' },
      });
      await createRecord(db, ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, {
        id: `company-product-supplier-${order.id}`,
        companyProductId: order.companyProductId,
        supplierProductId: order.supplierProductId,
        role: 'candidate',
        resolutionSource: 'synthetic_current_only_fixture',
      });
    }
    await createRecord(db, ECOBASE_COLLECTIONS.silverSupplierProducts, {
      id: 'supplier-product-etc',
      supplierId: fixture.etcAliasOrder.supplierId,
      productId: 'product-etc',
      supplierSku: 'ETC-CATALOG-OFFER',
      unitCost: 12,
      leadTimeDays: 14,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverOrders, {
      id: fixture.etcAliasOrder.id,
      companyId: fixture.etcAliasOrder.companyId,
      supplierId: fixture.etcAliasOrder.supplierId,
      orderRef: fixture.etcAliasOrder.orderRef,
      orderDate: fixture.calculationDate,
      orderIntent: 'purchase_order',
      canonicalStatus: 'paid',
      lifecycleStatus: 'paid',
      authorityStatus: 'alternate_authoritative',
    });
    await createRecord(db, ECOBASE_COLLECTIONS.silverOrderLines, {
      id: 'line-etc-alias',
      orderId: fixture.etcAliasOrder.id,
      orderedQty: 5,
      confirmedQty: 0,
      sourceAsin: fixture.etcAliasOrder.sourceAsin,
      sourceSupplierSku: fixture.etcAliasOrder.sourceSupplierSku,
      productMappingStatus: 'unresolved',
      productMappingEvidenceJson: { reason: 'pending_alias_review' },
    });
    await createRecord(db, 'users', fixture.attributionUser);
    await createRecord(db, ECOBASE_COLLECTIONS.silverActivityComments, {
      id: 'comment-off-track-clickup',
      entityType: 'supplier_order',
      entityId: 'order-off-track',
      actorType: 'user',
      actorUserId: fixture.attributionUser.id,
      actorDisplayName: fixture.attributionUser.nickname,
      actorEmail: fixture.attributionUser.email,
      commentType: 'status_update',
      body: 'Synthetic ClickUp follow-up required',
      createdAt: '2026-07-10T09:00:00.000Z',
      contextSnapshotJson: {
        source: 'clickup',
        actor: fixture.attributionUser.nickname,
        occurredAt: '2026-07-10T09:00:00.000Z',
      },
    });

    const familyService = new EcobaseCompanyProductFamilyService(db);
    const firstFamilyRun = await familyService.reconcileAllFamilies();
    const firstLineRun = await new EcobaseSupplierOrderService(db).reconcileAfterImport('current-only-fixture');
    for (const family of db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).all()) {
      await familyService.reconcileFamily(String(family.id));
    }
    const verification = await new EcobaseSilverIntegrityVerifier(db).verify();
    const inventoryService = new EcobaseInventoryPlanningService(db);
    await refreshAndPublish(inventoryService, { calculationDate: fixture.calculationDate });
    const commandCenter = await inventoryService.commandCenter({
      calculationDate: fixture.calculationDate,
      pageSize: 100,
    });
    const dailyBrief = await new EcobaseDailyOperationsBriefService(db).buildEvidencePack({
      date: fixture.calculationDate,
      timezone: 'Asia/Karachi',
      maxItems: 100,
    });

    const families = db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).all();
    const goldRows = db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all();
    const operationalRows = goldRows.filter((row) => row.familyRole !== 'member');
    const paneRows = Object.values(commandCenter.panes).flatMap((payload) => payload.rows);
    expect(firstFamilyRun).toMatchObject({ familyCount: 9, examinedCompanyProductCount: 10 });
    expect(firstLineRun).toMatchObject({ repaired: 1, ambiguous: 0 });
    expect(verification.issues.filter((issue) => issue.classification === 'technical_blocker')).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'sellerboard_history_not_loaded' })]),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(0);
    expect(families).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalAsin: 'B00SYNTHTIE',
          targetReviewRequired: true,
        }),
        expect.objectContaining({
          canonicalAsin: 'B00SYNTHZERO',
          replenishmentTargetCompanyProductId: 'cp-zero',
        }),
      ]),
    );
    expect(families.find((family) => family.canonicalAsin === 'B00SYNTHTIE')).not.toHaveProperty(
      'replenishmentTargetCompanyProductId',
    );
    expect(
      families.filter((family) => family.canonicalAsin === 'B00SYNTHSHARED').map((family) => family.amazonAccountId),
    ).toEqual(expect.arrayContaining(['account-eco-a', 'account-eco-b']));
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'line-etc-alias',
          companyProductId: 'cp-etc',
          supplierProductId: 'supplier-product-etc',
          productMappingStatus: 'resolved',
        }),
      ]),
    );
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs)
        .all()
        .map((row) => row.normalizedExternalSupplierCode),
    ).toEqual(['SRO-12939', 'SRO-12572']);
    expect(
      operationalRows.every((row) =>
        [
          'supplyAction',
          'activeOrders',
          'inPrepMonitoring',
          'inboundMonitoring',
          'healthyInventory',
          'excessInventory',
          'stuckInventory',
          'zeroStock',
          'dataReadiness',
          'untieredProducts',
          'adminExcluded',
        ].includes(String(row.commandCenterPane)),
      ),
    ).toBe(true);
    expect(goldRows.find((row) => row.asin === 'B00SYNTHTIE' && row.familyRole === 'review')).toMatchObject({
      commandCenterPane: 'untieredProducts',
      actionStatus: 'family_review_required',
    });
    expect(new Set(operationalRows.map((row) => row.company))).toEqual(
      new Set(['Ecofission LLC', 'Retail Heaven Inc', 'Muxtex INC', 'Stop Shop LLC']),
    );
    expect(goldRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyProductId: 'cp-shared-a',
          salesVelocityBasis: 'inventory_snapshot_fallback',
          daysOfCover: 2.5,
          positionDaysOfCover: 17.5,
        }),
        expect.objectContaining({ companyProductId: 'cp-missing-velocity', commandCenterPane: 'untieredProducts' }),
        expect.objectContaining({ companyProductId: 'cp-on-track', commandCenterPane: 'untieredProducts' }),
        expect.objectContaining({
          companyProductId: 'cp-off-track',
          commandCenterPane: 'untieredProducts',
          pipelineHealthStatus: 'late',
          latestSupplierOrderActivityNote: 'Synthetic ClickUp follow-up required',
        }),
      ]),
    );
    expect(paneRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ company: 'Ecofission LLC' }),
        expect.objectContaining({ company: 'Retail Heaven Inc' }),
        expect.objectContaining({ company: 'Muxtex INC' }),
        expect.objectContaining({ company: 'Stop Shop LLC' }),
      ]),
    );
    expect(dailyBrief.inventoryCommandCenter.alerts.activeOrdersOffTrack).toEqual([]);
    expect(dailyBrief.inventoryCommandCenter.panes.untieredProducts.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyProductId: 'cp-off-track',
          latestSupplierOrderActivityNote: 'Synthetic ClickUp follow-up required',
        }),
      ]),
    );
    expect(dailyBrief.summaryCounts).toMatchObject({
      dataReadinessCount: expect.any(Number),
      historyReadinessAffectedCount: 9,
    });
    expect(dailyBrief.dataWarnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'inventory_history_not_loaded' })]),
    );

    const firstCounts = {
      families: families.length,
      companyProductSupplierLinks: db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).all().length,
      goldRows: goldRows.length,
      goldNaturalKeys: goldRows.map((row) => row.naturalKey).sort(),
    };
    const secondFamilyRun = await familyService.reconcileAllFamilies();
    const secondLineRun = await new EcobaseSupplierOrderService(db).reconcileAfterImport('current-only-fixture-repeat');
    for (const family of db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).all()) {
      await familyService.reconcileFamily(String(family.id));
    }
    await inventoryService.refreshReadModel({ calculationDate: fixture.calculationDate });
    expect(secondFamilyRun).toMatchObject({ createdFamilyCount: 0, linkedCompanyProductCount: 0 });
    expect(secondLineRun).toMatchObject({ repaired: 0, ambiguous: 0 });
    expect({
      families: db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).all().length,
      companyProductSupplierLinks: db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).all().length,
      goldRows: db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).all().length,
      goldNaturalKeys: db
        .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
        .all()
        .map((row) => row.naturalKey)
        .sort(),
    }).toEqual(firstCounts);
  });
});
