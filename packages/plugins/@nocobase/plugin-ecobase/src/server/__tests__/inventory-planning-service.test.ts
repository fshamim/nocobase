/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
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
  offset?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;
  readonly findCalls: FindParams[] = [];

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    this.findCalls.push(params);
    const filtered = this.filterRecords(params);
    const offset = params.offset ?? 0;
    return this.sortRecords(filtered, params.sort).slice(offset, offset + (params.limit ?? filtered.length));
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

async function seedCorrectedFamilyListing(db: MemoryDatabase, values: Record<string, unknown>) {
  await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
    calculationDate: '2026-07-10',
    company: 'ACME',
    companyProductFamilyId: 'family-corrected',
    asin: String(values.asin ?? values.companyProductFamilyId ?? 'family-corrected'),
    familyRole: 'target',
    baselineTier: 'A',
    baselineTierScore: '300.00000000',
    baselineState: 'ranked',
    baselineConfidence: 'full',
    averageMonthlyProfit: '300.00000000',
    averageMonthlyUnits: '30.00000000',
    rollingUnits30: '30.00000000',
    inventoryDisposition: 'none',
    currentPlanningStock: 0,
    onHandStock: 0,
    onHandSellableStock: 0,
    reservedStock: 0,
    amazonPipelineStock: 0,
    supplierPipelineStock: 0,
    inventoryPositionStock: 0,
    futurePositionStock: 0,
    sellableStock: 0,
    pipelineStock: 0,
    inboundStock: 0,
    orderedStock: 0,
    prepStock: 0,
    awdStock: 0,
    targetCoverDays: 45,
    unitCost: 2,
    supplierOrderState: 'no_open_order',
    primaryActionPane: 'healthyInventory',
    primaryActionReasonCode: 'sufficient_stock',
    replenishmentEligibility: 'eligible',
    replenishmentBlockReasonCode: 'eligible_informational_projection',
    newReplenishmentActionable: false,
    existingOrderFollowUp: false,
    existingOrderFollowUpAction: 'none',
    listingReviewCategories: [],
    ...values,
  });
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
  it('fails explicitly when repeatable-read transaction support is unavailable', async () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase());
    const refreshReadModel = vi.spyOn(service, 'refreshReadModel');

    await expect(service.refreshAndPublish()).resolves.toEqual({
      status: 'failed',
      code: 'ECOBASE_GOLD_SNAPSHOT_TRANSACTION_REQUIRED',
      previousPublicationRetained: true,
    });
    expect(refreshReadModel).not.toHaveBeenCalled();
  });

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
  it('projects exactly one operator action per family across panes, totals, digest, search, and nested evidence', async () => {
    const db = new MemoryDatabase({ historyLoaded: false });
    const common = {
      company: 'ACME',
      calculationDate: '2026-07-15',
      amazonAccountId: '11111111-1111-4111-8111-111111111111',
      marketplace: 'Amazon.com',
      productStatus: 'Active',
      baselineTier: 'A',
      baselineState: 'ranked',
      baselineConfidence: 'full',
      inventoryAsOfDate: '2026-07-15',
      sellableStock: 100,
      reservedStock: 0,
      orderedStock: 0,
      prepStock: 0,
      inboundStock: 0,
      awdStock: 0,
      supplierPipelineStock: 0,
      onHandSellableStock: 100,
      supplierAvailability: 'resolved_silver_link',
      effectiveLeadTimeDays: 30,
      rollingUnits30: 60,
      baselineWeightedProfitPerUnit: 5,
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
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'new_replenishment_action',
      replenishmentEligibility: 'eligible',
      newReplenishmentActionable: true,
      supplyActionable: true,
      averageMonthlyProfit: 100,
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
      primaryActionPane: 'performanceReview',
      primaryActionReasonCode: 'family_member_evidence_only',
      replenishmentEligibility: 'review_missing_target',
      newReplenishmentActionable: false,
      averageMonthlyProfit: 999,
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
      primaryActionPane: 'inPrepMonitoring',
      primaryActionReasonCode: 'existing_order_follow_up',
      replenishmentEligibility: 'blocked_existing_order',
      newReplenishmentActionable: false,
      existingOrderFollowUp: true,
      supplierOrderState: 'purchased_pipeline',
      supplierOrderId: 'order-current',
      supplierOrderRef: 'PO-CURRENT-42',
      supplierOrderStatus: 'paid',
      supplierOrderWorkflowStage: 'in_prep',
      averageMonthlyProfit: 200,
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
      baselineTier: null,
      baselineState: 'unclassified',
      baselineConfidence: 'low',
      primaryActionPane: 'dataReadiness',
      primaryActionReasonCode: 'insufficient_baseline_evidence',
      replenishmentEligibility: 'blocked_insufficient_evidence',
      newReplenishmentActionable: false,
      averageMonthlyProfit: null,
      rollingUnits30: null,
      baselineWeightedProfitPerUnit: null,
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
      primaryActionPane: 'adminExcluded',
      primaryActionReasonCode: 'inactive_listing',
      replenishmentEligibility: 'excluded',
      newReplenishmentActionable: false,
      averageMonthlyProfit: 0,
    });

    const service = new EcobaseInventoryPlanningService(db);
    const commandCenter = await service.commandCenter({
      company: 'ACME',
      calculationDate: '2026-07-15',
      pageSize: 100,
    });
    const projectedRows = Object.values(commandCenter.panes).flatMap((pane) => pane.rows);
    const averageMonthlyProfit = commandCenter.summaryCards.find((card) => card.key === 'averageMonthlyProfit');

    expect(commandCenter.metadata).toMatchObject({
      scope: 'family_action',
      rowUnit: 'family',
      calculationDate: '2026-07-15',
      publishedRunId: 'test-published-gold:2026-07-15',
      denominatorCount: 3,
      hiddenEvidenceRowCount: 2,
      averageMonthlyProfitDenominatorCount: 2,
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
      amazonAccountId: '11111111-1111-4111-8111-111111111111',
      marketplace: 'Amazon.com',
      asin: 'B00FAMILYONE',
      baselineTier: 'A',
      averageMonthlyProfit: 100,
      primaryActionPane: 'supplyAction',
      newReplenishmentActionable: true,
    });
    expect(averageMonthlyProfit).toMatchObject({ value: 300, knownCount: 2, unknownCount: 0, denominatorCount: 2 });

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
      averageMonthlyProfitKnownTotal: 300,
      averageMonthlyProfitKnownCount: 2,
      averageMonthlyProfitUnknownCount: 0,
      averageMonthlyProfitDenominatorCount: 2,
    });
    expect(
      Object.values(digest.sections)
        .flat()
        .some((row) => row.companyProductId === 'cp-family-one-member'),
    ).toBe(false);
  });

  it('materializes exclusive target supply, active-order, stuck, member, and watch boundaries', async () => {
    const db = new MemoryDatabase();
    await seedCorrectedFamilyListing(db, {
      id: 'exclusive-target',
      companyProductId: 'exclusive-target',
      sku: 'TARGET',
      familyRole: 'target',
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'new_replenishment_action',
      newReplenishmentActionable: true,
      supplyActionable: true,
      recommendedOrderQty: 20,
    });
    await seedCorrectedFamilyListing(db, {
      id: 'exclusive-member',
      companyProductId: 'exclusive-member',
      sku: 'MEMBER',
      familyRole: 'member',
      primaryActionPane: 'stuckInventory',
      replenishmentEligibility: 'blocked_stuck_inventory',
      newReplenishmentActionable: false,
      inventoryDisposition: 'no_sell_through',
      currentPlanningStock: 5,
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({ pageSize: 100 });
    const allRows = Object.values(commandCenter.panes).flatMap((pane) => pane.rows);

    expect(Object.values(commandCenter.panes).reduce((total, pane) => total + pane.total, 0)).toBe(1);
    expect(allRows).toEqual([
      expect.objectContaining({
        companyProductId: 'exclusive-target',
        targetCompanyProductId: 'exclusive-target',
        memberCount: 2,
        newReplenishmentActionable: true,
      }),
    ]);
    expect(allRows[0].familyMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyProductId: 'exclusive-target' }),
        expect.objectContaining({ companyProductId: 'exclusive-member' }),
      ]),
    );
  });

  it('emits one readiness row and no duplicate actions when a family target needs review', async () => {
    const db = new MemoryDatabase();
    for (const [index, id] of ['review-one', 'review-two'].entries()) {
      await seedCorrectedFamilyListing(db, {
        id,
        companyProductId: id,
        companyProductFamilyId: 'family-review',
        familyRole: 'review',
        baselineTier: null,
        baselineState: 'unclassified',
        baselineConfidence: 'low',
        averageMonthlyProfit: null,
        primaryActionPane: index === 0 ? 'supplyAction' : 'dataReadiness',
        primaryActionReasonCode: index === 0 ? 'representative_must_not_own_action' : 'frozen_family_target_review',
        replenishmentEligibility: index === 0 ? 'eligible' : 'review_missing_target',
        replenishmentBlockReasonCode: index === 0 ? 'eligible_informational_projection' : 'review_missing_target',
        newReplenishmentActionable: index === 0,
        recommendedOrderQty: index === 0 ? 999 : null,
        listingReviewCategories: ['data_readiness'],
      });
    }

    const service = new EcobaseInventoryPlanningService(db);
    const [commandCenter, review] = await Promise.all([
      service.commandCenter({ pageSize: 100 }),
      service.listingPerformanceReview(),
    ]);

    expect(commandCenter.panes.dataReadiness).toMatchObject({ total: 1 });
    expect(commandCenter.panes.dataReadiness.rows).toEqual([
      expect.objectContaining({
        companyProductFamilyId: 'family-review',
        targetSelectionState: 'review_required',
        targetCompanyProductId: null,
        actionSourceCompanyProductId: null,
        memberCount: 2,
        primaryActionPane: 'dataReadiness',
        replenishmentEligibility: 'review_missing_target',
        newReplenishmentActionable: false,
        recommendedOrderQty: null,
      }),
    ]);
    expect(Object.values(commandCenter.panes).reduce((total, pane) => total + pane.total, 0)).toBe(1);
    expect(review).toMatchObject({ listingCount: 2, actionCount: 0 });
  });

  it('keeps member receipt evidence linked without overriding the digest-bound target action', async () => {
    const db = new MemoryDatabase();
    await seedCorrectedFamilyListing(db, {
      id: 'receipt-target',
      companyProductId: 'receipt-target',
      companyProductFamilyId: 'family-receipt',
      familyRole: 'target',
      primaryActionPane: 'supplyAction',
      newReplenishmentActionable: true,
      supplyActionable: true,
    });
    await seedCorrectedFamilyListing(db, {
      id: 'receipt-source',
      companyProductId: 'receipt-source',
      companyProductFamilyId: 'family-receipt',
      familyRole: 'member',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderId: 'order-receipt',
      supplierOrderRef: 'PO-RECEIPT',
      supplierOrderStatus: 'paid',
      supplierOrderWorkflowStage: 'in_prep',
      supplierOrderOpenQty: 12,
      amazonReceiptStatus: 'partially_observed',
      amazonReceiptObservedAt: '2026-07-09T12:00:00.000Z',
      amazonReceiptEvidenceJson: { source: 'amazon_inventory' },
      primaryActionPane: 'inPrepMonitoring',
      existingOrderFollowUp: true,
      newReplenishmentActionable: false,
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({ pageSize: 100 });

    expect(commandCenter.panes.supplyAction.rows).toEqual([
      expect.objectContaining({
        companyProductId: 'receipt-target',
        actionSourceCompanyProductId: 'receipt-target',
        primaryActionPane: 'supplyAction',
        existingOrderFollowUp: false,
        newReplenishmentActionable: true,
        familyMembers: expect.arrayContaining([
          expect.objectContaining({
            companyProductId: 'receipt-source',
            supplierOrderRef: 'PO-RECEIPT',
            amazonReceiptStatus: 'partially_observed',
            amazonReceiptObservedAt: '2026-07-09T12:00:00.000Z',
            amazonReceiptEvidenceJson: { source: 'amazon_inventory' },
          }),
        ]),
      }),
    ]);
    expect(commandCenter.panes.inPrepMonitoring.total).toBe(0);
  });

  it('keeps untiered current-operational targets visible without history enrichment', async () => {
    const db = new MemoryDatabase();
    await seedCorrectedFamilyListing(db, {
      id: 'untiered-target',
      companyProductId: 'untiered-target',
      companyProductFamilyId: 'family-untiered',
      baselineTier: null,
      baselineState: 'no_movement',
      baselineConfidence: 'full',
      averageMonthlyProfit: '0.00000000',
      primaryActionPane: 'untieredProducts',
      primaryActionReasonCode: 'baseline_no_movement',
      replenishmentEligibility: 'not_eligible_no_movement',
      replenishmentBlockReasonCode: 'baseline_no_movement',
      listingReviewCategories: ['no_movement'],
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({ pageSize: 100 });

    expect(commandCenter.panes.untieredProducts.rows).toEqual([
      expect.objectContaining({
        companyProductId: 'untiered-target',
        baselineTier: null,
        baselineState: 'no_movement',
        averageMonthlyProfit: '0.00000000',
        newReplenishmentActionable: false,
      }),
    ]);
  });

  it('applies the exclusive report-pane precedence without dropping source evidence', async () => {
    const db = new MemoryDatabase();
    await seedCorrectedFamilyListing(db, {
      id: 'precedence-review',
      companyProductId: 'precedence-review',
      companyProductFamilyId: 'family-precedence-review',
      familyRole: 'review',
      primaryActionPane: 'dataReadiness',
      replenishmentEligibility: 'review_missing_target',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderWorkflowStage: 'inbound',
      supplierOrderRef: 'PO-REVIEW-EVIDENCE',
    });
    await seedCorrectedFamilyListing(db, {
      id: 'precedence-action',
      companyProductId: 'precedence-action',
      companyProductFamilyId: 'family-precedence-action',
      primaryActionPane: 'supplyAction',
      newReplenishmentActionable: true,
      supplyActionable: true,
      supplierOrderState: 'no_open_order',
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({ pageSize: 100 });

    expect(commandCenter.panes.dataReadiness.rows).toEqual([
      expect.objectContaining({
        companyProductId: 'precedence-review',
        supplierOrderRef: 'PO-REVIEW-EVIDENCE',
        newReplenishmentActionable: false,
      }),
    ]);
    expect(commandCenter.panes.supplyAction.rows).toEqual([
      expect.objectContaining({ companyProductId: 'precedence-action', newReplenishmentActionable: true }),
    ]);
    expect(Object.values(commandCenter.panes).reduce((total, pane) => total + pane.total, 0)).toBe(2);
  });

  it('keeps the digest-bound stuck pane while exposing target order and linked member evidence', async () => {
    const db = new MemoryDatabase();
    await seedCorrectedFamilyListing(db, {
      id: 'stuck-order-target',
      companyProductId: 'stuck-order-target',
      companyProductFamilyId: 'family-stuck-order',
      familyRole: 'target',
      supplierOrderState: 'purchased_pipeline',
      supplierOrderRef: 'PO-STUCK',
      supplierOrderWorkflowStage: 'in_prep',
      primaryActionPane: 'stuckInventory',
      replenishmentEligibility: 'blocked_stuck_inventory',
      inventoryDisposition: 'no_sell_through',
      currentPlanningStock: 61,
      existingOrderFollowUp: true,
      existingOrderFollowUpAction: 'follow_up_existing_order',
      newReplenishmentActionable: false,
    });
    await seedCorrectedFamilyListing(db, {
      id: 'stuck-order-member',
      companyProductId: 'stuck-order-member',
      companyProductFamilyId: 'family-stuck-order',
      familyRole: 'member',
      inventoryDisposition: 'none',
      currentPlanningStock: 10,
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({ pageSize: 100 });

    expect(commandCenter.panes.stuckInventory.rows).toEqual([
      expect.objectContaining({
        companyProductId: 'stuck-order-target',
        actionSourceCompanyProductId: 'stuck-order-target',
        primaryActionPane: 'stuckInventory',
        supplierOrderRef: 'PO-STUCK',
        inventoryDisposition: 'no_sell_through',
        currentPlanningStock: 61,
        existingOrderFollowUp: true,
        newReplenishmentActionable: false,
        familyMembers: expect.arrayContaining([
          expect.objectContaining({
            companyProductId: 'stuck-order-member',
            inventoryDisposition: 'none',
            currentPlanningStock: 10,
          }),
        ]),
      }),
    ]);
    expect(commandCenter.panes.inPrepMonitoring.total).toBe(0);
  });

  it('keeps target stock, velocity, and order quantity immutable while linking member stock evidence', async () => {
    const db = new MemoryDatabase();
    await seedCorrectedFamilyListing(db, {
      id: 'position-target',
      companyProductId: 'position-target',
      companyProductFamilyId: 'family-position',
      onHandStock: 10,
      onHandSellableStock: 10,
      currentPlanningStock: 10,
      sellableStock: 10,
      amazonPipelineStock: 5,
      supplierPipelineStock: 20,
      inventoryPositionStock: 15,
      futurePositionStock: 35,
      rollingUnits30: '30.00000000',
      primaryActionPane: 'supplyAction',
      newReplenishmentActionable: true,
      supplyActionable: true,
      recommendedOrderQty: 10,
    });
    await seedCorrectedFamilyListing(db, {
      id: 'position-member',
      companyProductId: 'position-member',
      companyProductFamilyId: 'family-position',
      onHandSellableStock: 100,
      currentPlanningStock: 100,
      inventoryPositionStock: 120,
      futurePositionStock: 140,
      rollingUnits30: '300.00000000',
      recommendedOrderQty: 999,
    });

    const commandCenter = await new EcobaseInventoryPlanningService(db).commandCenter({ pageSize: 100 });

    expect(commandCenter.panes.supplyAction.rows).toEqual([
      expect.objectContaining({
        companyProductId: 'position-target',
        actionSourceCompanyProductId: 'position-target',
        onHandSellableStock: 10,
        amazonPipelineStock: 5,
        supplierPipelineStock: 20,
        inventoryPositionStock: 15,
        futurePositionStock: 35,
        rollingUnits30: '30.00000000',
        positionDaysOfCover: null,
        recommendedOrderQty: 10,
        familyMembers: expect.arrayContaining([
          expect.objectContaining({
            companyProductId: 'position-member',
            onHandSellableStock: 100,
            inventoryPositionStock: 120,
            futurePositionStock: 140,
            rollingUnits30: '300.00000000',
            recommendedOrderQty: 999,
          }),
        ]),
      }),
    ]);
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

  it('rejects invalid budgets and fails the uncontracted corrected optimizer closed', async () => {
    const service = new EcobaseInventoryPlanningService(new MemoryDatabase());
    await expect(service.optimizeBudget({ budget: 0 })).rejects.toThrow(
      'Ecobase budget optimizer requires a budget greater than zero.',
    );
    await expect(service.optimizeBudget({ budget: 100 })).rejects.toMatchObject({
      code: 'ECOBASE_CORRECTED_BUDGET_OPTIMIZER_UNAVAILABLE',
    });
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
      baselineTier: 'A',
      baselineState: 'ranked',
      baselineConfidence: 'full',
      averageMonthlyProfit: 50,
      primaryActionPane: 'supplyAction',
      replenishmentEligibility: 'eligible',
      newReplenishmentActionable: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'high-risk',
      naturalKey: 'high-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'HIGH',
      baselineTier: 'B',
      baselineState: 'ranked',
      baselineConfidence: 'full',
      averageMonthlyProfit: 500,
      primaryActionPane: 'supplyAction',
      replenishmentEligibility: 'eligible',
      newReplenishmentActionable: true,
    });
    await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
      id: 'excluded-risk',
      naturalKey: 'excluded-risk',
      calculationDate: '2026-06-07',
      company: 'Ecofission LLC',
      asin: 'EXCLUDED',
      baselineTier: 'A',
      baselineState: 'ranked',
      baselineConfidence: 'full',
      averageMonthlyProfit: 5000,
      primaryActionPane: 'adminExcluded',
      replenishmentEligibility: 'excluded',
      newReplenishmentActionable: false,
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
      baselineTier: 'A',
      baselineState: 'ranked',
      baselineConfidence: 'full',
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
      averageMonthlyProfit: 250,
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'new_replenishment_action',
      replenishmentEligibility: 'eligible',
      newReplenishmentActionable: true,
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
    expect(workspace.rows[0]).toMatchObject({
      asin: 'B000WORK',
      baselineTier: 'A',
      primaryActionPane: 'supplyAction',
      newReplenishmentActionable: true,
    });
    expect(workspace.digest.summary).toMatchObject({ actionable: 1, atRisk: 1 });
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
      estimatedOrderCost: null,
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
      companyProductId: 'planning-product-1',
      company: 'Ecofission LLC',
      asin: 'B000RISK',
      sku: 'SKU-RISK',
      baselineTier: 'A',
      baselineState: 'ranked',
      baselineConfidence: 'full',
      averageMonthlyProfit: 100,
      productStatus: 'Active',
      familyRole: 'target',
      primaryActionPane: 'supplyAction',
      primaryActionReasonCode: 'new_replenishment_action',
      replenishmentEligibility: 'eligible',
      newReplenishmentActionable: true,
      supplierName: 'Digest Supplier',
      supplierOrderState: 'no_open_order',
      supplierOrderStatus: 'approval_pending',
      supplierOrderRef: 'ORD-1',
      leadTimeFreshness: 'fresh',
      recommendedOrderQty: 5,
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

    expect(digest.summary).toMatchObject({ actionable: 1, atRisk: 1, suppliersToContact: 0 });
    expect(digest.sections.orderNow).toHaveLength(1);
    expect(digest.sections.orderNow[0]).toMatchObject({
      supplierOrderRef: 'ORD-1',
      latestSupplierOrderActivityNote: 'Invoice received, payment still pending.',
    });
    expect(digest.sections.supplierActionItems).toEqual([]);
    expect(digest.sections.suppliersToContactFirst).toEqual([]);
  });

  it('keeps new actions in the digest and excludes existing-order follow-ups and purchased pipeline rows', async () => {
    const db = new MemoryDatabase();
    const digestRows = [
      {
        id: 'no-order',
        primaryActionPane: 'supplyAction',
        replenishmentEligibility: 'eligible',
        newReplenishmentActionable: true,
        existingOrderFollowUp: false,
        supplierOrderState: 'no_open_order',
        leadTimeFreshness: 'fresh',
      },
      {
        id: 'payment-pending',
        primaryActionPane: 'activeOrders',
        replenishmentEligibility: 'blocked_existing_order',
        newReplenishmentActionable: false,
        existingOrderFollowUp: true,
        supplierOrderState: 'placed_not_purchased',
        supplierOrderStatus: 'payment_pending',
        supplierOrderRef: 'PP-1',
        leadTimeFreshness: 'stale',
      },
      {
        id: 'approval-soon',
        primaryActionPane: 'activeOrders',
        replenishmentEligibility: 'blocked_existing_order',
        newReplenishmentActionable: false,
        existingOrderFollowUp: true,
        supplierOrderState: 'placed_not_purchased',
        supplierOrderStatus: 'approval_pending',
        supplierOrderRef: 'APP-1',
        leadTimeFreshness: 'fresh',
      },
      {
        id: 'paid-pipeline',
        primaryActionPane: 'inPrepMonitoring',
        replenishmentEligibility: 'blocked_existing_order',
        newReplenishmentActionable: false,
        existingOrderFollowUp: true,
        supplierOrderState: 'purchased_pipeline',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PAID-1',
        leadTimeFreshness: 'fresh',
      },
      {
        id: 'paid-evidence',
        primaryActionPane: 'inPrepMonitoring',
        replenishmentEligibility: 'blocked_existing_order',
        newReplenishmentActionable: false,
        existingOrderFollowUp: true,
        supplierOrderState: 'purchased_pipeline',
        supplierOrderStatus: 'paid',
        supplierOrderRef: 'PAID-EVIDENCE-1',
        leadTimeFreshness: 'fresh',
      },
    ];
    for (const row of digestRows) {
      await createRecord(db, ECOBASE_COLLECTIONS.goldInventoryPlanningRows, {
        id: `gold-${row.id}`,
        calculationDate: '2026-06-07',
        companyProductId: row.id,
        company: 'Ecofission LLC',
        asin: `ASIN-${row.id}`,
        sku: `SKU-${row.id}`,
        baselineTier: 'A',
        baselineState: 'ranked',
        baselineConfidence: 'full',
        averageMonthlyProfit: 100,
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

    expect(digest.summary).toMatchObject({
      actionable: 1,
      existingOrderFollowUp: 4,
      noSupplierOrder: 1,
      placedNotPurchased: 0,
      purchasedPipelineExcluded: 2,
    });
    expect(digest.sections.orderNow.map((row) => row.companyProductId)).toEqual(['no-order']);
    expect(digest.sections.orderNow[0]).toMatchObject({
      supplierOrderState: 'no_open_order',
      newReplenishmentActionable: true,
      existingOrderFollowUp: false,
    });
    expect(digest.sections.noOrderProducts.map((row) => row.companyProductId)).toEqual(['no-order']);
    expect(digest.sections.orderNow).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyProductId: 'payment-pending' }),
        expect.objectContaining({ companyProductId: 'approval-soon' }),
        expect.objectContaining({ companyProductId: 'paid-pipeline' }),
      ]),
    );
    expect(digest.sections.supplierActionItems).toEqual([]);
    expect(digest.sections.suppliersToContactFirst).toEqual([]);
  });
});

describe('corrected operational supplier fallback chain (Batch B1)', () => {
  type OperationalRows = Map<string, Record<string, unknown>>;
  const buildRows = (overrides: Record<string, unknown>): OperationalRows =>
    (
      new EcobaseInventoryPlanningService({} as never) as unknown as {
        correctedOperationalRowsFromSilver(input: Record<string, unknown>): OperationalRows;
      }
    ).correctedOperationalRowsFromSilver({
      calculationDate: '2026-07-24',
      settings: {
        supplierOrderPlacedNotPurchasedStatuses: [],
        supplierOrderPurchasedPipelineStatuses: [],
        supplierOrderClosedStatuses: [],
      },
      sourceConnections: [],
      inventorySnapshots: [],
      suppliers: [],
      supplierProducts: [],
      productSuppliers: [],
      orders: [],
      orderLines: [],
      companyProducts: [{ id: 'cp-1', productId: 'product-1', companyProductFamilyId: 'family-1' }],
      familyRows: [],
      ...overrides,
    });

  // Mirror the real silverSuppliers shape: displayName + normalizedName, NO `name`
  // column — a fixture `name` field previously masked the null-supplierName bug.
  const linkSupplier = { id: 'supplier-link', displayName: 'Link Supplier', normalizedName: 'link supplier' };
  const familySupplier = { id: 'supplier-family', displayName: 'Family Supplier', normalizedName: 'family supplier' };

  it('keeps the per-product silver link as the strongest evidence over the family fallback', () => {
    const row = buildRows({
      suppliers: [linkSupplier, familySupplier],
      supplierProducts: [
        { id: 'sp-link', supplierId: 'supplier-link', productId: 'product-1', leadTimeDays: 10 },
        { id: 'sp-family', supplierId: 'supplier-family', productId: 'product-1', leadTimeDays: 21 },
      ],
      productSuppliers: [{ id: 'link-1', companyProductId: 'cp-1', supplierProductId: 'sp-link', role: 'preferred' }],
      familyRows: [{ id: 'family-1', preferredSupplierId: 'supplier-family', preferredSupplierProductId: 'sp-family' }],
    }).get('cp-1');
    expect(row).toMatchObject({
      supplierId: 'supplier-link',
      supplierName: 'Link Supplier',
      supplierSource: 'silver_company_product_supplier',
      supplierRole: 'preferred',
      supplierConfidence: 'resolved_silver_link',
      supplierAvailability: 'resolved_silver_link',
      leadTimeDays: 10,
    });
  });

  it('falls back to the family preferred supplier product and carries its lead time', () => {
    const row = buildRows({
      suppliers: [familySupplier],
      supplierProducts: [
        { id: 'sp-family', supplierId: 'supplier-family', productId: 'product-other', leadTimeDays: 21, unitCost: 3 },
      ],
      familyRows: [{ id: 'family-1', preferredSupplierId: 'supplier-family', preferredSupplierProductId: 'sp-family' }],
    }).get('cp-1');
    expect(row).toMatchObject({
      supplierId: 'supplier-family',
      supplierName: 'Family Supplier',
      supplierSource: 'family_preferred',
      supplierConfidence: 'resolved_family_preferred',
      supplierAvailability: 'resolved_family_preferred',
      leadTimeDays: 21,
      leadTimeAvailability: 'resolved_silver_link',
      unitCost: 3,
    });
    expect(row?.supplierRole).toBeUndefined(); // no per-product link -> no link role
  });

  it('falls back to the family preferred supplier id alone with a null lead time', () => {
    const row = buildRows({
      suppliers: [familySupplier],
      familyRows: [{ id: 'family-1', preferredSupplierId: 'supplier-family' }],
    }).get('cp-1');
    expect(row).toMatchObject({
      supplierId: 'supplier-family',
      supplierName: 'Family Supplier',
      supplierSource: 'family_preferred',
      supplierConfidence: 'resolved_family_preferred',
      supplierAvailability: 'resolved_family_preferred',
      leadTimeAvailability: 'resolved_default_supplier_lead_time',
    });
    expect(row?.leadTimeDays).toBeUndefined();
  });

  it('recovers a lead time on the id-only fallback when a supplier product exists for the listing product', () => {
    const row = buildRows({
      suppliers: [familySupplier],
      supplierProducts: [{ id: 'sp-match', supplierId: 'supplier-family', productId: 'product-1', leadTimeDays: 14 }],
      familyRows: [{ id: 'family-1', preferredSupplierId: 'supplier-family' }],
    }).get('cp-1');
    expect(row).toMatchObject({
      supplierId: 'supplier-family',
      supplierSource: 'family_preferred',
      leadTimeDays: 14,
      leadTimeAvailability: 'resolved_silver_link',
    });
  });

  it('stays unavailable_no_evidence when neither a link nor a family supplier exists', () => {
    const row = buildRows({
      familyRows: [{ id: 'family-1' }],
    }).get('cp-1');
    expect(row).toMatchObject({ supplierAvailability: 'unavailable_no_evidence' });
    expect(row?.supplierId).toBeUndefined();
    expect(row?.supplierSource).toBeUndefined();
  });
});
