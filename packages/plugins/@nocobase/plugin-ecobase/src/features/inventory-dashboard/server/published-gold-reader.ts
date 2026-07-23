/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Minimal, read-only published-run reader (AD-1 / T-1.0).
 *
 * Deliberately does NOT import `inventory-planning-gold-access.ts` (the shared
 * frozen class) nor any `features/*` module. It reads the gold collections
 * directly with a locally-defined, structural repository interface so the
 * feature stays fully encapsulated. The published-run lookup mirrors the origin
 * (`inventory-planning-gold-access.ts:107` — `{ status: 'published' }`,
 * `sort: ['-publishedAt']`) and row scoping mirrors `:284` (`refreshRunId`).
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';

export interface DashboardRepositoryFindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  fields?: string[];
  sort?: string[];
  limit?: number;
  offset?: number;
}

export interface DashboardRepository {
  find(params?: DashboardRepositoryFindParams): Promise<unknown[]>;
  findOne(params?: DashboardRepositoryFindParams): Promise<unknown | null>;
  create(params: { values: Record<string, unknown> }): Promise<unknown>;
  update(params: {
    filterByTk?: string | number;
    filter?: Record<string, unknown>;
    values: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface DashboardDatabase {
  getRepository(name: string): DashboardRepository;
}

export interface PublishedRun {
  id: string;
  calculationDate: string | null;
  publishedAt: string | null;
  status: string;
}

const GOLD_ROW_QUERY_LIMIT = 100_000;

function asString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The gold table has ~150 columns including heavy jsonb evidence blobs; the
 * dashboard reads a fixed subset. Restricting the fetched fields keeps the
 * single-query read under the G4 latency budget (T-4.2 finding: full-row
 * fetches pushed the header median to ~1s on staging).
 */
const GOLD_ROW_FIELDS = [
  'id',
  'naturalKey',
  'refreshRunId',
  'primaryActionPane',
  'primaryActionReasonCode',
  'companyProductFamilyId',
  'familyTargetCompanyProductId',
  'isFrozenFamilyTarget',
  'companyId',
  'amazonAccountId',
  'marketplace',
  'company',
  'asin',
  'sku',
  'title',
  'baselineTier',
  'currentProjectedTier',
  'lastClosedMonthTier',
  'companyProductId',
  'lastClosedMonth',
  'supplierOrderId',
  'supplierId',
  'supplierName',
  'supplierOrderRef',
  'supplierOrderOperationalStatus',
  'supplierOrderWorkflowStage',
  'pipelineHealthStatus',
  'estimatedProfitRisk',
  'latestSafeReorderDate',
  'leadTimeConfirmedAt',
  'currentPlanningStock',
  'inventoryPositionStock',
  'unitCost',
  'daysOfCover',
  'estimatedOosDate',
  'expectedArrivalDate',
  'expectedArrivalSource',
  'safetyBufferDays',
  'latestSupplierOrderActivityAt',
  'latestSupplierOrderActivityNote',
  'latestSupplierOrderActivityActor',
  'latestSupplierOrderActivityActorDisplayName',
  'readinessReasonCodes',
  'monthlyPerformanceEvidence',
  'projectedMonthlyUnits',
  'lastClosedMonthUnits',
  'recommendedOrderQty',
  // T4 widening (dashboard v2): R2 stock buckets.
  'sellableStock',
  'reservedStock',
  'inboundStock',
  'prepStock',
  'orderedStock',
  'awdStock',
  'futurePositionStock',
  // T4: R3 velocity with F4 ladder provenance.
  'salesVelocity',
  'salesVelocityBasis',
  'salesVelocityAsOfDate',
  'rollingVelocityEvidenceStatus',
  // T4: D3/D4 profit stats for the drawer.
  'averageMonthlyProfit',
  'bestMonthlyProfit',
  'worstMonthlyProfit',
  'lastClosedMonthProfit',
  'projectedMonthlyProfit',
  'baselineWeightedProfitPerUnit',
  // T4: R4 supplier lead time (supplierId/supplierName/leadTimeConfirmedAt already fetched).
  'leadTimeDays',
  'leadTimeFreshness',
  // T-D5 rider: the resolved coverage horizon behind recommendedOrderQty.
  'targetCoverDays',
  // T4: T1/T3 position timing + money-risk detail.
  'positionDaysOfCover',
  'positionEstimatedOosDate',
  'daysUntilSafeReorder',
  'moneyRiskStatus',
  'moneyRiskUncoveredDays',
];

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * T-QA1 fix: a full-row fetch can arrive as a live Sequelize model instance
 * whose ENUMERABLE keys are ORM internals (`dataValues`, `_changed`,
 * `_previousDataValues`, `isNewRecord`, `uniqno`) with the real record buried
 * underneath — attribute GETTERS work, enumeration does not. Serve the plain
 * business record instead (codebase toPlainRecord pattern: toJSON() first,
 * dataValues fallback).
 */
function toPlainModelRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const model = value as Record<string, unknown> & { toJSON?: () => Record<string, unknown> };
  if (typeof model.toJSON === 'function') return { ...model.toJSON() };
  if (typeof model.dataValues === 'object' && model.dataValues !== null) {
    return { ...(model.dataValues as Record<string, unknown>) };
  }
  return { ...model };
}

export class PublishedGoldReader {
  constructor(private readonly db: DashboardDatabase) {}

  /** Single query for the currently published run (or null when none published). */
  async findPublishedRun(): Promise<PublishedRun | null> {
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)
      .find({ filter: { status: 'published' }, sort: ['-publishedAt'], limit: 1 });
    const record = toRecord(rows[0]);
    const id = asString(record.id);
    if (!id) return null;
    return {
      id,
      calculationDate: asString(record.calculationDate) ?? null,
      publishedAt: asString(record.publishedAt) ?? null,
      status: asString(record.status) ?? 'published',
    };
  }

  /**
   * Exactly one gold-rows query per call (AD-4). Scoped to the pinned run and,
   * optionally, a company. In-memory grouping/pagination happens in the service.
   */
  async findRowsForRun(runId: string, companyId?: string): Promise<Record<string, unknown>[]> {
    const filter: Record<string, unknown> = { refreshRunId: runId };
    const company = asString(companyId);
    if (company) filter.companyId = company;
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .find({ filter, fields: [...GOLD_ROW_FIELDS], limit: GOLD_ROW_QUERY_LIMIT });
    return rows.map(toRecord);
  }

  /**
   * T6 (D7 Data tab): ONE full-column fetch of a single row at the pinned run —
   * only issued when a drawer explicitly asks for the raw record (includeRaw),
   * so the normal read path keeps its fixed query budget (AD-4).
   */
  async findFullRowById(runId: string, rowId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .find({ filter: { refreshRunId: runId, id: rowId }, limit: 1 });
    return rows.length > 0 ? toPlainModelRecord(rows[0]) : null;
  }
}
