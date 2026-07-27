/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Order Create/View UI (T6): pane-routing guard for manually-created orders.
 *
 * The user expectation is that once a family has an open order it LEAVES Supply
 * Action and shows up in the orders-in-flight panes. The gold engine already
 * implements this — a `draft` order (the status a manual create writes) is in
 * the placed-not-purchased bucket, which becomes existingOrderStage
 * `pre_purchase`, which `decideReplenishment` routes to `activeOrders` BEFORE the
 * supplyAction branch. These tests lock that end-to-end behaviour in so a future
 * change to either the status buckets or the routing rule fails loudly. The T6 task
 * itself changed no engine behaviour, so it bumped no version constants.
 *
 * The two `070 residual` suites at the bottom are a later addition and DID change
 * engine behaviour (rule version v5 → v6): they drive the real Gold engine over a
 * seeded silver catalog so sheet-closed supplier orders can never drift back into
 * the active panes.
 */

import { describe, expect, it } from 'vitest';
import { decideReplenishment, type ReplenishmentDecisionInput } from '../engine/replenishment-decision';
import {
  sheetTerminalStatus,
  silverOrderStatus,
} from '../../../supplier-management/server/silver-supplier-order-read-model';
import { DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS } from '../../../../server/services/planning-settings-service';
import { EcobaseInventoryPlanningService } from '../engine/inventory-planning-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../../source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';

/** A fully eligible family (passes every readiness/target/performance gate). */
function eligibleInput(overrides: Partial<ReplenishmentDecisionInput> = {}): ReplenishmentDecisionInput {
  return {
    administrativelyExcluded: false,
    lifecycleDiscontinuedOrPaused: false,
    hasFrozenTarget: true,
    targetSelectionState: 'automatic',
    identityEvidenceValid: true,
    baselineEvidenceValid: true,
    inventoryDisposition: 'none',
    baselineState: 'ranked',
    baselineTier: 'A',
    baselineConfidence: 'full',
    lastClosedMonthState: 'ranked',
    lastClosedMonthTier: 'A',
    closedTierMovement: 'stable',
    currentProjectionGateMode: 'informational',
    currentProjectionConfidence: 'trusted',
    currentProjectedState: 'ranked',
    currentProjectedTier: 'A',
    projectedTierMovement: 'stable',
    existingOrderStage: 'none',
    trustedZeroStock: false,
    reorderDueKind: 'trusted',
    ...overrides,
  };
}

describe('T6 order pane routing', () => {
  it('routes a reorder-due family with NO open order to Supply Action', () => {
    const decision = decideReplenishment(eligibleInput({ existingOrderStage: 'none', reorderDueKind: 'trusted' }));
    expect(decision.primaryActionPane).toBe('supplyAction');
    expect(decision.supplyActionable).toBe(true);
  });

  it('routes a family with an open draft (pre-purchase) order to Active Orders, NOT Supply Action', () => {
    const decision = decideReplenishment(
      // Even though the family is reorder-due, the open order wins the routing.
      eligibleInput({ existingOrderStage: 'pre_purchase', reorderDueKind: 'trusted' }),
    );
    expect(decision.primaryActionPane).toBe('activeOrders');
    expect(decision.primaryActionPane).not.toBe('supplyAction');
    expect(decision.existingOrderFollowUp).toBe(true);
    // Split kept explicit: a placed-not-purchased order gives visibility only, it
    // does not make the family "supply-actionable" (no quantity double-count).
    expect(decision.supplyActionable).toBe(false);
  });

  it('routes purchased-pipeline orders to the in-prep / inbound monitoring panes', () => {
    expect(decideReplenishment(eligibleInput({ existingOrderStage: 'in_prep' })).primaryActionPane).toBe(
      'inPrepMonitoring',
    );
    expect(decideReplenishment(eligibleInput({ existingOrderStage: 'inbound' })).primaryActionPane).toBe(
      'inboundMonitoring',
    );
  });

  it('sends a cancelled/completed order (no open stage) back to normal reorder routing', () => {
    // silverOrderStatus resolves the terminal canonical statuses to the closed bucket,
    // which yields existingOrderStage `none` — the family re-enters Supply Action when due.
    for (const canonicalStatus of ['cancelled', 'completed']) {
      expect(silverOrderStatus({ canonicalStatus })).toBe(canonicalStatus);
      expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderClosedStatuses).toContain(canonicalStatus);
    }
    const decision = decideReplenishment(eligibleInput({ existingOrderStage: 'none', reorderDueKind: 'trusted' }));
    expect(decision.primaryActionPane).toBe('supplyAction');
  });

  /**
   * Issue 070. The sheet import records the sheet's own "Order status" as evidence only
   * (`statusEvidenceJson.sourceOrderStatus`) and never derives a `canonicalStatus`, so 713
   * orders the sheet had already closed — some dating to 2023 — resolved to the open catch-all
   * and sat in Active Orders forever. These lock the read-model fallback that retires them.
   */
  it('070: a sheet-Completed order with no canonical status resolves closed, and Cancelled too', () => {
    for (const sourceOrderStatus of ['Completed', 'completed', 'COMPLETED', '  Completed  ']) {
      expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('completed');
    }
    for (const sourceOrderStatus of ['Cancelled', 'cancelled', 'CANCELLED']) {
      expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('cancelled');
    }
    // The zombies carry the sheet's workflow stage in `lifecyclePhase`, which is what used to
    // fall through to the catch-all. The evidence still decides.
    expect(
      silverOrderStatus({ lifecyclePhase: 'pre_purchase', statusEvidenceJson: { sourceOrderStatus: 'Completed' } }),
    ).toBe('completed');
    for (const closed of ['completed', 'cancelled']) {
      expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderClosedStatuses).toContain(closed);
    }
  });

  it('070: every other sheet status keeps the catch-all, and an explicit canonicalStatus wins', () => {
    for (const sourceOrderStatus of ['In Progress', 'Ordered', 'Complete', 'Canceled', '']) {
      expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('supplier_contacted');
    }
    // A malformed or absent evidence column must not throw its way through the read model.
    expect(silverOrderStatus({ statusEvidenceJson: null })).toBe('supplier_contacted');
    expect(silverOrderStatus({ statusEvidenceJson: 'not-an-object' })).toBe('supplier_contacted');
    expect(silverOrderStatus({})).toBe('supplier_contacted');
    // An explicitly canonicalized order is decided by its own status, never by sheet evidence.
    expect(silverOrderStatus({ canonicalStatus: 'paid', statusEvidenceJson: { sourceOrderStatus: 'Completed' } })).toBe(
      'paid',
    );
    expect(
      silverOrderStatus({ canonicalStatus: 'shipped_inbound', statusEvidenceJson: { sourceOrderStatus: 'Cancelled' } }),
    ).toBe('shipped_inbound');
  });

  it('070: the sheet-Completed order leaves Active Orders while a sheet-In Progress order stays', () => {
    // Closed statuses carry no open quantity → existingOrderStage `none` → the family is routed
    // by its own reorder need, so no Active Orders row survives for the retired order.
    expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus: 'Completed' } })).toBe('completed');
    const retired = decideReplenishment(eligibleInput({ existingOrderStage: 'none', reorderDueKind: 'trusted' }));
    expect(retired.primaryActionPane).not.toBe('activeOrders');
    expect(retired.primaryActionPane).toBe('supplyAction');
    expect(retired.existingOrderFollowUp).toBe(false);

    // The in-progress order is untouched: still an open placed-not-purchased order → pre_purchase.
    expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus: 'In Progress' } })).toBe('supplier_contacted');
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPlacedNotPurchasedStatuses).toContain(
      'supplier_contacted',
    );
    const stillOpen = decideReplenishment(eligibleInput({ existingOrderStage: 'pre_purchase' }));
    expect(stillOpen.primaryActionPane).toBe('activeOrders');
    expect(stillOpen.existingOrderFollowUp).toBe(true);
  });

  it('a manual create writes a `draft` status that the engine treats as an open (placed-not-purchased) order', () => {
    // createOrder persists canonicalStatus:'draft'; the read model keeps it 'draft'…
    expect(silverOrderStatus({ canonicalStatus: 'draft', orderIntent: 'manual' })).toBe('draft');
    // …and 'draft' is a placed-not-purchased status → open order → pre_purchase stage.
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPlacedNotPurchasedStatuses).toContain('draft');
    expect(DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS.supplierOrderPurchasedPipelineStatuses).not.toContain('draft');
  });
});

describe('070 residual: sheetTerminalStatus', () => {
  it('reads only the two terminal sheet values, and only when no canonicalStatus exists', () => {
    for (const sourceOrderStatus of ['Completed', 'completed', 'COMPLETED', '  Completed  ']) {
      expect(sheetTerminalStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('completed');
    }
    for (const sourceOrderStatus of ['Cancelled', 'cancelled', 'CANCELLED']) {
      expect(sheetTerminalStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBe('cancelled');
    }
    // Non-terminal sheet values decide nothing — note 'Complete' and 'Canceled' are NOT the
    // sheet's terminal spellings and must stay undefined.
    for (const sourceOrderStatus of ['In Progress', 'Ordered', 'Complete', 'Canceled', '']) {
      expect(sheetTerminalStatus({ statusEvidenceJson: { sourceOrderStatus } })).toBeUndefined();
    }
    // A malformed or absent evidence column must not throw.
    expect(sheetTerminalStatus({ statusEvidenceJson: null })).toBeUndefined();
    expect(sheetTerminalStatus({ statusEvidenceJson: 'not-an-object' })).toBeUndefined();
    expect(sheetTerminalStatus({ statusEvidenceJson: ['Completed'] })).toBeUndefined();
    expect(sheetTerminalStatus({ statusEvidenceJson: {} })).toBeUndefined();
    expect(sheetTerminalStatus({})).toBeUndefined();
    // An explicit canonicalStatus always outranks sheet evidence.
    expect(
      sheetTerminalStatus({ canonicalStatus: 'paid', statusEvidenceJson: { sourceOrderStatus: 'Completed' } }),
    ).toBeUndefined();
    expect(
      sheetTerminalStatus({ canonicalStatus: 'draft', statusEvidenceJson: { sourceOrderStatus: 'Cancelled' } }),
    ).toBeUndefined();
    // lifecycleStatus / lifecyclePhase are NOT canonicalStatus — the zombies carry those.
    expect(
      sheetTerminalStatus({ lifecyclePhase: 'pre_purchase', statusEvidenceJson: { sourceOrderStatus: 'Completed' } }),
    ).toBe('completed');
  });

  it('keeps silverOrderStatus behaviour identical after the extraction', () => {
    expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus: 'Completed' } })).toBe('completed');
    expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus: 'Cancelled' } })).toBe('cancelled');
    expect(silverOrderStatus({ statusEvidenceJson: { sourceOrderStatus: 'In Progress' } })).toBe('supplier_contacted');
    expect(silverOrderStatus({ canonicalStatus: 'paid', statusEvidenceJson: { sourceOrderStatus: 'Completed' } })).toBe(
      'paid',
    );
  });
});

type Row = Record<string, unknown>;

/** Minimal in-memory repository — enough for one full `refreshReadModel` pass. */
class MemoryRepository implements EcobaseRepository {
  constructor(
    private readonly name: string,
    readonly rows: Row[],
  ) {}

  async find(
    params: { filter?: Row; filterByTk?: string | number; sort?: string[]; limit?: number; offset?: number } = {},
  ) {
    const filter = params.filter ?? {};
    let rows = this.rows.filter(
      (row) =>
        (params.filterByTk === undefined || row.id === params.filterByTk) &&
        Object.entries(filter).every(([key, value]) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const operator = value as { $in?: unknown[]; $ne?: unknown };
            if (Array.isArray(operator.$in)) return operator.$in.includes(row[key]);
            if ('$ne' in operator) return row[key] !== operator.$ne;
          }
          return row[key] === value;
        }),
    );
    for (const sort of [...(params.sort ?? [])].reverse()) {
      const descending = sort.startsWith('-');
      const key = descending ? sort.slice(1) : sort;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
        return descending ? -comparison : comparison;
      });
    }
    const offset = params.offset ?? 0;
    return rows.slice(offset, offset + (params.limit ?? rows.length));
  }

  async findOne(params: { filter?: Row; filterByTk?: string | number; sort?: string[] } = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Row }) {
    const row = { id: values.id ?? `${this.name}-${this.rows.length + 1}`, ...values };
    this.rows.push(row);
    return row;
  }

  async update({ filter, filterByTk, values }: { filter?: Row; filterByTk?: string | number; values: Row }) {
    const row = (await this.find({ filter, filterByTk }))[0] as Row | undefined;
    if (!row) throw new Error(`Memory repository update target was not found in ${this.name}.`);
    Object.assign(row, values);
    return row;
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private readonly repositories = new Map<string, MemoryRepository>();

  getRepository(name: string) {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryRepository(name, []);
      this.repositories.set(name, repository);
    }
    return repository;
  }

  rows(name: string) {
    return this.getRepository(name).rows;
  }
}

/**
 * One eligible listing carrying exactly one supplier-order line, so the ONLY variable across the
 * scenarios below is the order's own status evidence. Returns the materialized Gold row.
 */
async function goldRowForSupplierOrder(order: Row) {
  const db = new MemoryDatabase();
  db.rows(ECOBASE_COLLECTIONS.silverCompanies).push({ id: 'company-1', name: 'ACME' });
  db.rows(ECOBASE_COLLECTIONS.silverAmazonAccounts).push({
    id: 'account-1',
    companyId: 'company-1',
    marketplace: 'Amazon.com',
  });
  db.rows(ECOBASE_COLLECTIONS.silverProducts).push({
    id: 'product-1',
    asin: 'B000000001',
    sku: 'SKU-1',
    title: 'Zombie order product',
  });
  db.rows(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).push({
    id: 'family-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    marketplace: 'Amazon.com',
    canonicalAsin: 'B000000001',
    replenishmentTargetCompanyProductId: 'company-product-1',
    targetSelectionEvidenceJson: { source: 'test' },
  });
  db.rows(ECOBASE_COLLECTIONS.silverCompanyProducts).push({
    id: 'company-product-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    productId: 'product-1',
    companyProductFamilyId: 'family-1',
    lifecycleStatus: 'active',
  });
  db.rows(ECOBASE_COLLECTIONS.sourceConnections).push({
    id: 'sellerboard-1',
    companyId: 'company-1',
    sourceType: 'sellerboard',
    active: true,
  });
  db.rows(ECOBASE_COLLECTIONS.silverInventorySnapshots).push({
    id: 'inventory-1',
    companyProductId: 'company-product-1',
    sourceConnectionId: 'sellerboard-1',
    snapshotDate: '2026-07-16',
    sellableStock: 10,
    reserved: 0,
    inbound: 0,
    ordered: 0,
    prepStock: 0,
    awdStock: 0,
  });
  const dates = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-16'];
  db.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts).push(
    ...dates.map((snapshotDate, index) => ({
      id: `fact-${index + 1}`,
      companyProductId: 'company-product-1',
      snapshotDate,
      units: 10,
      netProfit: 300,
      profit: 300,
    })),
  );
  db.rows(ECOBASE_COLLECTIONS.sourceCoverageIntervals).push({
    id: 'coverage-1',
    sourceConnectionId: 'sellerboard-1',
    companyId: 'company-1',
    amazonAccountId: 'account-1',
    marketplace: 'Amazon.com',
    metricSet: 'sellerboard_units_net_profit_v1',
    coveredStartDate: '2026-01-01',
    coveredEndDate: '2026-07-16',
    continuousCoverage: true,
    sourceAsOfDate: '2026-07-16',
    sourceVersion: '2026-07-16',
    coverageStatus: 'active',
  });
  db.rows(ECOBASE_COLLECTIONS.sourceCoverageMemberships).push(
    ...[...dates.slice(0, 6), '2026-07-01'].map((monthStart, index) => ({
      id: `membership-${index + 1}`,
      coverageIntervalId: 'coverage-1',
      companyProductId: 'company-product-1',
      monthStart,
      membershipStatus: 'in_scope',
      metricReconciliationStatus: 'complete',
      normalizedFactLinkCount: 1,
    })),
  );
  db.rows(ECOBASE_COLLECTIONS.silverSuppliers).push({
    id: 'supplier-1',
    companyId: 'company-1',
    displayName: 'Sheet Supplier',
  });
  db.rows(ECOBASE_COLLECTIONS.silverSupplierProducts).push({
    id: 'supplier-product-1',
    supplierId: 'supplier-1',
    productId: 'product-1',
    supplierSku: 'SKU-1',
    unitCost: 4,
    leadTimeDays: 30,
  });
  db.rows(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers).push({
    id: 'company-product-supplier-1',
    companyProductId: 'company-product-1',
    supplierProductId: 'supplier-product-1',
    role: 'preferred',
  });
  db.rows(ECOBASE_COLLECTIONS.silverOrders).push({
    id: 'order-1',
    companyId: 'company-1',
    supplierId: 'supplier-1',
    orderRef: 'SHEET-1',
    orderDate: '2026-07-01',
    orderIntent: 'imported',
    // The zombie shape: every lifecycle column the engine reads is NULL.
    canonicalStatus: null,
    lifecycleStatus: null,
    lifecyclePhase: null,
    ...order,
  });
  db.rows(ECOBASE_COLLECTIONS.silverOrderLines).push({
    id: 'order-line-1',
    orderId: 'order-1',
    companyProductId: 'company-product-1',
    supplierProductId: 'supplier-product-1',
    sourceAsin: 'B000000001',
    sourceSupplierSku: 'SKU-1',
    orderedQty: 5,
    confirmedQty: 0,
    productMappingStatus: 'resolved',
    mappingScope: 'exact_member',
  });

  await new EcobaseInventoryPlanningService(db).refreshReadModel({ calculationDate: '2026-07-16' });
  const row = db
    .rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
    .find((candidate) => candidate.companyProductId === 'company-product-1');
  if (!row) throw new Error('The 070-residual fixture did not materialize a Gold row.');
  return row;
}

/**
 * Issue 070 residual — the Gold engine, not the read model.
 *
 * The 070 read-model fallback was dead code in this pipeline: an order the sheet already closed
 * has NULL canonicalStatus/lifecycleStatus/lifecyclePhase, `normalizeSupplierOrderStatus(undefined)`
 * returns 'draft', 'draft' is a configured (placed-not-purchased) status, so the engine's
 * configured-status bypass returned 'draft' and never called `silverOrderStatus`.
 * `supplierCoverageStatus` then upgraded paymentStatus 'Completed' to 'paid' and the order landed
 * in purchased_pipeline — byte-identically across a full v4→v5 rebuild on staging. The engine now
 * consults `sheetTerminalStatus` BEFORE that bypass.
 */
describe('070 residual: sheet-terminal orders close in the Gold engine', () => {
  it('retires a sheet-Completed zombie (all-NULL lifecycle, paymentStatus Completed) to closed history', async () => {
    const row = await goldRowForSupplierOrder({
      paymentStatus: 'Completed',
      statusEvidenceJson: { sourceOrderStatus: 'Completed' },
    });

    expect(row.supplierOrderState).toBe('closed_history');
    expect(row.supplierOrderState).not.toBe('purchased_pipeline');
    expect(row.supplierOrderStatus).toBe('completed');
    expect(row.existingOrderFollowUp).toBe(false);
    expect(row.primaryActionPane).not.toBe('activeOrders');
    expect(['inPrepMonitoring', 'inboundMonitoring']).not.toContain(row.primaryActionPane);
  });

  it('retires a sheet-Cancelled zombie the same way', async () => {
    const row = await goldRowForSupplierOrder({
      paymentStatus: 'Completed',
      statusEvidenceJson: { sourceOrderStatus: 'Cancelled' },
    });

    expect(row.supplierOrderState).toBe('closed_history');
    expect(row.supplierOrderStatus).toBe('cancelled');
    expect(row.existingOrderFollowUp).toBe(false);
    expect(row.primaryActionPane).not.toBe('activeOrders');
  });

  it('leaves a true draft (all-NULL, no sheet evidence, no payment) open as placed-not-purchased', async () => {
    const row = await goldRowForSupplierOrder({});

    expect(row.supplierOrderState).toBe('placed_not_purchased');
    expect(row.supplierOrderStatus).toBe('draft');
    expect(row.existingOrderFollowUp).toBe(true);
  });

  it('keeps the configured-status bypass: an explicit canonicalStatus outranks sheet evidence', async () => {
    const row = await goldRowForSupplierOrder({
      canonicalStatus: 'paid',
      paymentStatus: 'Completed',
      statusEvidenceJson: { sourceOrderStatus: 'Completed' },
    });

    expect(row.supplierOrderState).toBe('purchased_pipeline');
    expect(row.supplierOrderStatus).toBe('paid');
    expect(row.existingOrderFollowUp).toBe(true);
  });

  it('changes nothing for a non-terminal sheet status with a completed payment', async () => {
    const row = await goldRowForSupplierOrder({
      paymentStatus: 'Completed',
      statusEvidenceJson: { sourceOrderStatus: 'In Progress' },
    });

    expect(row.supplierOrderState).toBe('purchased_pipeline');
    expect(row.supplierOrderStatus).toBe('paid');
    expect(row.existingOrderFollowUp).toBe(true);
  });
});
