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
});
