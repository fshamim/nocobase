/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Inventory Dashboard read service (T-1.2). Fully encapsulated (AD-1): no
 * `features/*` imports. Groups/projects/pages the published Gold read model;
 * never re-runs business classification. Query budget (AD-4): gold rows fetched
 * exactly once per request; silver order joins scoped by `$in`.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import {
  DASHBOARD_PANE_KEYS,
  isPaneKey,
  type DashboardHeader,
  type DashboardHeaderTile,
  type DashboardRow,
  type DrawerContextRequest,
  type DrawerContextResult,
  type HeaderRequest,
  type HeaderTileKey,
  type PaneKey,
  type PaneMetric,
  type PaneRequest,
  type PaneResult,
} from './contract';
import {
  bufferStatus,
  daysInStage,
  isDeclining,
  isPerformanceReviewRow,
  isTiered,
  needsFollowUp,
  performanceBand,
  pickLastActivity,
  prepPath,
  projectRowPane,
  staleLeadTime,
  velocityTrend,
  type MonthlyEvidenceEntry,
} from './derivations';
import { PublishedGoldReader, type DashboardDatabase } from './published-gold-reader';
import { dashboardWorkflowStageForStatus, isDirectShipFba } from './workflow-stage';

const ORDER_PANES: ReadonlySet<PaneKey> = new Set<PaneKey>(['activeOrders', 'inPrepMonitoring', 'inboundMonitoring']);
const SORTABLE_KEYS = new Set(['latestSafeReorderDate', 'estimatedOosDate', 'daysOfCover', 'estimatedProfitRisk']);
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export interface InventoryDashboardServiceOptions {
  now?: Date;
  leadTimeFreshnessDays?: number;
  followUpThresholdHours?: number;
}

export class InventoryDashboardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryDashboardValidationError';
  }
}

export interface SavePrepDetailsParams {
  orderId?: string;
  prepBoxes?: unknown;
  prepCartons?: unknown;
  prepDimensions?: unknown;
  actorUserId?: string;
}

const MAX_PREP_DIMENSIONS_BYTES = 4_096;

function validateCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InventoryDashboardValidationError(`${field} must be a zero-or-positive whole number.`);
  }
  return parsed;
}

function validateDimensions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InventoryDashboardValidationError('prepDimensions must be a structured object.');
  }
  if (JSON.stringify(value).length > MAX_PREP_DIMENSIONS_BYTES) {
    throw new InventoryDashboardValidationError('prepDimensions payload is too large.');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asMonthlyEvidence(value: unknown): MonthlyEvidenceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MonthlyEvidenceEntry[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return [
      {
        month: asString(record.month) ?? undefined,
        units: asNumber(record.units),
        trusted: record.trusted === true,
      },
    ];
  });
}

interface ProjectedRow {
  raw: Record<string, unknown>;
  listingRowId: string;
  familyKey: string;
  pane: PaneKey;
  supplierOrderId: string | null;
  tiered: boolean;
  directShip: boolean;
  goldStage: string | null;
  staleClassification: boolean;
  untieredProjected: boolean;
  isFamilyTarget: boolean;
}

interface SilverOrderView {
  workflowStage: string | null;
  workflowStageEnteredAt: string | null;
  prepBoxes: number | null;
  prepCartons: number | null;
  prepDimensions: Record<string, unknown> | null;
}

export class EcobaseInventoryDashboardService {
  private readonly reader: PublishedGoldReader;
  private readonly now: Date;
  private readonly leadTimeFreshnessDays: number;
  private readonly followUpThresholdHours: number;

  constructor(
    private readonly db: DashboardDatabase,
    options: InventoryDashboardServiceOptions = {},
  ) {
    this.reader = new PublishedGoldReader(db);
    this.now = options.now ?? new Date();
    this.leadTimeFreshnessDays = options.leadTimeFreshnessDays ?? 60;
    this.followUpThresholdHours = options.followUpThresholdHours ?? 48;
  }

  async header(request: HeaderRequest = {}): Promise<DashboardHeader> {
    const run = await this.reader.findPublishedRun();
    if (!run) {
      return { publishedRunId: '', calculationDate: null, dataFreshness: 'unknown', tiles: emptyTiles() };
    }
    const goldRows = await this.reader.findRowsForRun(run.id, request.companyId);
    const projected = this.projectRows(goldRows);
    const silverById = await this.loadSilverOrders(projected.map((row) => row.supplierOrderId));
    const tiles = this.buildTiles(projected, silverById);
    return {
      publishedRunId: run.id,
      calculationDate: run.calculationDate,
      dataFreshness: run.calculationDate ? 'fresh' : 'unknown',
      tiles,
    };
  }

  async pane(request: PaneRequest): Promise<PaneResult> {
    const pane = this.validatePane(request.pane);
    this.validateSort(request.sort);
    const run = await this.reader.findPublishedRun();
    if (!run) {
      return {
        pane,
        publishedRunId: '',
        metrics: [],
        rows: [],
        pagination: { page: 1, pageSize: request.pageSize, total: 0 },
      };
    }
    if (request.runId && request.runId !== run.id) {
      return { runSuperseded: true, publishedRunId: run.id };
    }
    const goldRows = await this.reader.findRowsForRun(run.id, request.companyId);
    const projected = this.projectRows(goldRows);
    const familyPaneSets = this.familyPaneSets(projected);

    const paneRows = this.rowsForPane(projected, pane);
    const searched = this.applySearch(paneRows, request.search);
    const sorted = this.applySort(searched, pane, request.sort, request.sortDirection);
    const { page, pageSize } = this.normalizePagination(request.page, request.pageSize);
    const total = sorted.length;
    const pageSlice = sorted.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

    const silverById = ORDER_PANES.has(pane)
      ? await this.loadSilverOrders(pageSlice.map((row) => row.supplierOrderId))
      : new Map<string, SilverOrderView>();

    const rows = pageSlice.map((row) => this.buildRow(row, familyPaneSets, silverById));
    return {
      pane,
      publishedRunId: run.id,
      metrics: this.paneMetrics(pane, sorted),
      rows,
      pagination: { page, pageSize, total },
    };
  }

  async drawerContext(request: DrawerContextRequest): Promise<DrawerContextResult> {
    const pane = this.validatePane(request.pane);
    const run = await this.reader.findPublishedRun();
    if (!run) {
      throw new InventoryDashboardValidationError('No published run is available.');
    }
    if (request.runId && request.runId !== run.id) {
      return { runSuperseded: true, publishedRunId: run.id };
    }
    const goldRows = await this.reader.findRowsForRun(run.id);
    const projected = this.projectRows(goldRows);
    const familyPaneSets = this.familyPaneSets(projected);
    const members = projected.filter((row) => row.familyKey === request.familyId);
    if (members.length === 0) {
      throw new InventoryDashboardValidationError(`Family ${request.familyId} is not present in the published run.`);
    }
    const orderRowsRaw = members.filter((row) => row.supplierOrderId !== null);
    const silverById = await this.loadSilverOrders(orderRowsRaw.map((row) => row.supplierOrderId));
    const primarySource =
      members.find((row) => (request.orderId ? row.supplierOrderId === request.orderId : row.isFamilyTarget)) ??
      members[0];
    return {
      pane,
      publishedRunId: run.id,
      familyKey: request.familyId,
      familyMembers: members.map((row) => ({
        listingRowId: row.listingRowId,
        asin: asString(row.raw.asin),
        sku: asString(row.raw.sku),
        pane: row.pane,
      })),
      primaryRow: this.buildRow(primarySource, familyPaneSets, silverById),
      orderRows: orderRowsRaw.map((row) => this.buildRow(row, familyPaneSets, silverById)),
    };
  }

  async savePrepDetails(params: SavePrepDetailsParams): Promise<{ orderId: string; updated: true }> {
    const orderId = asString(params.orderId);
    if (!orderId) {
      throw new InventoryDashboardValidationError('savePrepDetails requires an orderId.');
    }
    const prepBoxes = validateCount(params.prepBoxes, 'prepBoxes');
    const prepCartons = validateCount(params.prepCartons, 'prepCartons');
    const prepDimensions = validateDimensions(params.prepDimensions);
    const values: Record<string, unknown> = {
      prepDetailsUpdatedAt: this.now.toISOString(),
      prepDetailsUpdatedByUserId: asString(params.actorUserId),
    };
    if (prepBoxes !== undefined) values.prepBoxes = prepBoxes;
    if (prepCartons !== undefined) values.prepCartons = prepCartons;
    if (prepDimensions !== undefined) values.prepDimensions = prepDimensions;
    await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values });
    return { orderId, updated: true };
  }

  /* ------------------------------- internals ------------------------------ */

  private validatePane(value: unknown): PaneKey {
    if (!isPaneKey(value)) {
      throw new InventoryDashboardValidationError(
        `Unknown dashboard pane "${String(value)}". Expected one of: ${DASHBOARD_PANE_KEYS.join(', ')}.`,
      );
    }
    return value;
  }

  private validateSort(sort: string | undefined): void {
    if (sort !== undefined && !SORTABLE_KEYS.has(sort)) {
      throw new InventoryDashboardValidationError(`Unsupported sort key "${sort}".`);
    }
  }

  private projectRows(goldRows: Record<string, unknown>[]): ProjectedRow[] {
    const projected: ProjectedRow[] = [];
    for (const raw of goldRows) {
      const listingRowId = asString(raw.id) ?? asString(raw.naturalKey) ?? '';
      const primaryActionPane = asString(raw.primaryActionPane) ?? '';
      const tiered = isTiered(
        asString(raw.baselineTier),
        asString(raw.currentProjectedTier),
        asString(raw.lastClosedMonthTier),
      );
      const directShip = isDirectShipFba(raw.supplierOrderOperationalStatus);
      const goldStage =
        asString(raw.supplierOrderWorkflowStage) ??
        dashboardWorkflowStageForStatus(raw.supplierOrderOperationalStatus) ??
        null;
      const result = projectRowPane({
        primaryActionPane,
        tiered,
        isDirectShipFba: directShip,
        goldWorkflowStage: goldStage,
        silverWorkflowStage: goldStage, // refined with silver stage later for order rows
      });
      if (result.pane === null) continue; // adminExcluded — never served
      const familyKey =
        asString(raw.companyProductFamilyId) ?? asString(raw.familyTargetCompanyProductId) ?? listingRowId;
      projected.push({
        raw,
        listingRowId,
        familyKey,
        pane: result.pane,
        supplierOrderId: asString(raw.supplierOrderId),
        tiered,
        directShip,
        goldStage,
        staleClassification: result.staleClassification,
        untieredProjected: result.untieredProjected,
        isFamilyTarget:
          raw.isFrozenFamilyTarget === true ||
          (asString(raw.familyTargetCompanyProductId) !== null &&
            asString(raw.familyTargetCompanyProductId) === listingRowId),
      });
    }
    return projected;
  }

  private familyPaneSets(projected: ProjectedRow[]): Map<string, Set<PaneKey>> {
    const map = new Map<string, Set<PaneKey>>();
    for (const row of projected) {
      const set = map.get(row.familyKey) ?? new Set<PaneKey>();
      set.add(row.pane);
      map.set(row.familyKey, set);
    }
    return map;
  }

  private rowsForPane(projected: ProjectedRow[], pane: PaneKey): ProjectedRow[] {
    const inPane = projected.filter((row) => row.pane === pane);
    if (ORDER_PANES.has(pane)) {
      // Order grain: one row per supplier order.
      const byOrder = new Map<string, ProjectedRow>();
      for (const row of inPane) {
        const key = row.supplierOrderId ?? row.listingRowId;
        if (!byOrder.has(key)) byOrder.set(key, row);
      }
      return [...byOrder.values()];
    }
    // Family grain: one representative listing per family.
    const byFamily = new Map<string, ProjectedRow>();
    for (const row of inPane) {
      const existing = byFamily.get(row.familyKey);
      if (!existing || (row.isFamilyTarget && !existing.isFamilyTarget)) byFamily.set(row.familyKey, row);
    }
    return [...byFamily.values()];
  }

  private applySearch(rows: ProjectedRow[], search: string | undefined): ProjectedRow[] {
    const needle = asString(search)?.toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => {
      const haystack = [row.raw.asin, row.raw.sku, row.raw.title, row.raw.company, row.raw.supplierOrderRef]
        .map((value) => asString(value)?.toLowerCase() ?? '')
        .join(' ');
      return haystack.includes(needle);
    });
  }

  private applySort(
    rows: ProjectedRow[],
    pane: PaneKey,
    sort: string | undefined,
    direction: 'asc' | 'desc' | undefined,
  ): ProjectedRow[] {
    const sortKey = sort ?? (pane === 'supplyAction' ? 'latestSafeReorderDate' : undefined);
    if (!sortKey) return rows;
    const dir = direction === 'desc' ? -1 : 1;
    return [...rows].sort((left, right) => {
      const leftValue = sortValue(left.raw[sortKey]);
      const rightValue = sortValue(right.raw[sortKey]);
      // Nulls always last, regardless of direction (tested).
      if (leftValue === null && rightValue === null) return 0;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      if (leftValue < rightValue) return -1 * dir;
      if (leftValue > rightValue) return 1 * dir;
      return 0;
    });
  }

  private normalizePagination(
    page: number | undefined,
    pageSize: number | undefined,
  ): { page: number; pageSize: number } {
    const safePageSize = Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    const safePage = Math.max(Math.trunc(page ?? 1), 1);
    return { page: safePage, pageSize: safePageSize };
  }

  private async loadSilverOrders(orderIds: Array<string | null>): Promise<Map<string, SilverOrderView>> {
    const ids = [...new Set(orderIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverOrders)
      .find({ filter: { id: { $in: ids } }, limit: ids.length });
    const map = new Map<string, SilverOrderView>();
    for (const value of rows) {
      const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      const id = asString(record.id);
      if (!id) continue;
      map.set(id, {
        workflowStage: asString(record.workflowStage),
        workflowStageEnteredAt: asString(record.workflowStageEnteredAt),
        prepBoxes: asNumber(record.prepBoxes),
        prepCartons: asNumber(record.prepCartons),
        prepDimensions:
          typeof record.prepDimensions === 'object' && record.prepDimensions !== null
            ? (record.prepDimensions as Record<string, unknown>)
            : null,
      });
    }
    return map;
  }

  private buildRow(
    row: ProjectedRow,
    familyPaneSets: Map<string, Set<PaneKey>>,
    silverById: Map<string, SilverOrderView>,
  ): DashboardRow {
    const raw = row.raw;
    const silver = row.supplierOrderId ? silverById.get(row.supplierOrderId) ?? null : null;
    const familySplit = (familyPaneSets.get(row.familyKey)?.size ?? 0) >= 2;
    const evidence = asMonthlyEvidence(raw.monthlyPerformanceEvidence);
    const band = performanceBand(evidence, asNumber(raw.projectedMonthlyUnits));

    const dashboardRow: DashboardRow = {
      identity: {
        familyKey: row.familyKey,
        listingRowId: row.listingRowId,
        company: asString(raw.company),
        amazonAccountId: asString(raw.amazonAccountId),
        marketplace: asString(raw.marketplace),
        asin: asString(raw.asin),
        sku: asString(raw.sku),
        title: asString(raw.title),
      },
      pane: row.pane,
      tier: { baseline: asString(raw.baselineTier), current: asString(raw.currentProjectedTier) },
      stock: {
        currentPlanningStock: asNumber(raw.currentPlanningStock),
        inventoryPositionStock: asNumber(raw.inventoryPositionStock),
        unitCost: asNumber(raw.unitCost),
      },
      daysOfCover: asNumber(raw.daysOfCover),
      estimatedOosDate: asString(raw.estimatedOosDate),
      latestSafeReorderDate: asString(raw.latestSafeReorderDate),
      estimatedProfitRisk: asNumber(raw.estimatedProfitRisk),
      reasonCodes: [
        ...asStringArray(raw.readinessReasonCodes),
        ...(row.untieredProjected ? ['untiered_projected'] : []),
      ],
      velocityTrend: velocityTrend(asNumber(raw.projectedMonthlyUnits), asNumber(raw.lastClosedMonthUnits)),
      performanceBand: band,
    };
    // staleClassification: gold denormalized order stage vs fresh silver stage
    // (surfaced, not reclassified — the row stays in its gold pane).
    let stale = row.staleClassification;
    if (row.supplierOrderId && silver?.workflowStage && row.goldStage) {
      stale = normalizeStage(row.goldStage) !== normalizeStage(silver.workflowStage);
    }
    if (stale) dashboardRow.staleClassification = true;
    if (familySplit) dashboardRow.familySplit = true;

    if (row.supplierOrderId) {
      const enteredAt = silver?.workflowStageEnteredAt ?? null;
      const stageDays = daysInStage(enteredAt, this.now);
      const followUp = needsFollowUp({
        daysInStage: stageDays,
        latestActivityAt: asString(raw.latestSupplierOrderActivityAt),
        workflowStageEnteredAt: enteredAt,
        thresholdHours: this.followUpThresholdHours,
        now: this.now,
      });
      dashboardRow.order = {
        orderId: row.supplierOrderId,
        orderNumber: asString(raw.supplierOrderRef),
        clickupStatus: asString(raw.supplierOrderOperationalStatus),
        workflowStage: silver?.workflowStage ?? row.goldStage,
        workflowStageEnteredAt: enteredAt,
        daysInStage: stageDays,
        needsFollowUp: followUp,
      };
      if (row.pane === 'inPrepMonitoring' || row.pane === 'inboundMonitoring') {
        dashboardRow.order.prepPath = prepPath({ isDirectShipFba: row.directShip });
      }
      if (row.pane === 'inboundMonitoring') {
        dashboardRow.order.expectedArrivalDate = asString(raw.expectedArrivalDate);
        dashboardRow.order.arrivalProvenance = asString(raw.expectedArrivalSource);
        dashboardRow.order.bufferStatus = bufferStatus({
          expectedArrivalDate: asString(raw.expectedArrivalDate),
          estimatedOosDate: asString(raw.estimatedOosDate),
          safetyBufferDays: asNumber(raw.safetyBufferDays),
        });
      }
      dashboardRow.lastActivity = pickLastActivity({
        note: asString(raw.latestSupplierOrderActivityNote),
        actorDisplayName: asString(raw.latestSupplierOrderActivityActorDisplayName),
        actor: asString(raw.latestSupplierOrderActivityActor),
        at: asString(raw.latestSupplierOrderActivityAt),
      });
    }

    if (row.pane === 'performanceReview') {
      dashboardRow.performanceBand = band;
    }
    return dashboardRow;
  }

  private buildTiles(projected: ProjectedRow[], silverById: Map<string, SilverOrderView>): DashboardHeaderTile[] {
    const today = todayDateOnly(this.now);

    const urgent = projected.filter(
      (row) =>
        (row.pane === 'supplyAction' && onOrBeforeToday(asString(row.raw.latestSafeReorderDate), today)) ||
        row.pane === 'zeroStock',
    );
    const orderedLate = projected.filter((row) => asString(row.raw.pipelineHealthStatus) === 'late');
    const stale = projected.filter(
      (row) => staleLeadTime(asString(row.raw.leadTimeConfirmedAt), this.leadTimeFreshnessDays, this.now).stale,
    );
    const staleUnknown = projected.filter(
      (row) => staleLeadTime(asString(row.raw.leadTimeConfirmedAt), this.leadTimeFreshnessDays, this.now).unknown,
    );
    const followUps = projected.filter((row) => {
      if (!row.supplierOrderId) return false;
      if (row.pane !== 'inPrepMonitoring' && row.pane !== 'inboundMonitoring') return false;
      const enteredAt = silverById.get(row.supplierOrderId)?.workflowStageEnteredAt ?? null;
      return needsFollowUp({
        daysInStage: daysInStage(enteredAt, this.now),
        latestActivityAt: asString(row.raw.latestSupplierOrderActivityAt),
        workflowStageEnteredAt: enteredAt,
        thresholdHours: this.followUpThresholdHours,
        now: this.now,
      });
    });
    const stuck = projected.filter((row) => row.pane === 'stuckInventory');

    const profitRiskMoney = (rows: ProjectedRow[]) =>
      moneySum(rows.map((row) => asNumber(row.raw.estimatedProfitRisk)));
    const stuckMoney = moneySum(
      stuck.map((row) => {
        const units = asNumber(row.raw.currentPlanningStock);
        const cost = asNumber(row.raw.unitCost);
        return units !== null && cost !== null ? units * cost : null;
      }),
    );

    const tile = (
      key: HeaderTileKey,
      rows: ProjectedRow[],
      targetPane: PaneKey,
      money: { value: number | null; unknownCount: number },
      countUnitsByFamily = true,
    ): DashboardHeaderTile => ({
      key,
      count: countUnitsByFamily ? new Set(rows.map((row) => row.familyKey)).size : rows.length,
      moneyAtRisk: money.value,
      unknownCount: money.unknownCount,
      currency: 'EUR',
      targetPane,
    });

    return [
      tile('urgentStockout', urgent, 'supplyAction', profitRiskMoney(urgent)),
      tile('orderedButLate', orderedLate, 'inboundMonitoring', profitRiskMoney(orderedLate)),
      {
        ...tile('staleLeadTimes', stale, 'supplyAction', profitRiskMoney(stale)),
        unknownCount: staleUnknown.length,
      },
      tile('needsFollowUp', followUps, 'inPrepMonitoring', profitRiskMoney(followUps), false),
      tile('stuckCapital', stuck, 'stuckInventory', stuckMoney),
    ];
  }

  private paneMetrics(pane: PaneKey, rows: ProjectedRow[]): PaneMetric[] {
    const money = moneySum(rows.map((row) => asNumber(row.raw.estimatedProfitRisk)));
    return [
      { key: 'count', label: 'Rows', value: rows.length },
      { key: 'moneyAtRisk', label: 'Money at risk', value: money.value, format: 'currency' },
      { key: 'unknownMoney', label: 'Unknown money inputs', value: money.unknownCount },
    ];
  }
}

function normalizeStage(value: string): string {
  return value.trim().toLowerCase();
}

function sortValue(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

function moneySum(values: Array<number | null>): { value: number | null; unknownCount: number } {
  let sum = 0;
  let known = 0;
  let unknownCount = 0;
  for (const value of values) {
    if (value === null) unknownCount += 1;
    else {
      sum += value;
      known += 1;
    }
  }
  return { value: known === 0 ? null : sum, unknownCount };
}

function todayDateOnly(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function onOrBeforeToday(dateOnly: string | null, today: string): boolean {
  if (!dateOnly) return false;
  return dateOnly.slice(0, 10) <= today;
}

function emptyTiles(): DashboardHeaderTile[] {
  const keys: Array<{ key: HeaderTileKey; targetPane: PaneKey }> = [
    { key: 'urgentStockout', targetPane: 'supplyAction' },
    { key: 'orderedButLate', targetPane: 'inboundMonitoring' },
    { key: 'staleLeadTimes', targetPane: 'supplyAction' },
    { key: 'needsFollowUp', targetPane: 'inPrepMonitoring' },
    { key: 'stuckCapital', targetPane: 'stuckInventory' },
  ];
  return keys.map(({ key, targetPane }) => ({
    key,
    count: 0,
    moneyAtRisk: null,
    unknownCount: 0,
    currency: 'EUR',
    targetPane,
  }));
}
