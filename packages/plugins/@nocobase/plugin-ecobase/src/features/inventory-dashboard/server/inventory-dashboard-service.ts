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

import { randomUUID } from 'node:crypto';
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
  type MonthlyEvidencePoint,
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

export interface ReactivateFamilyParams {
  familyId?: string;
  comment?: string;
  actorUserId?: string;
}

export interface SaveSupplierShipDestinationParams {
  supplierId?: string;
  shipDestination?: unknown;
  actorUserId?: string;
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
  // Real Postgres datetimeTz columns arrive as Date instances (G4 audit
  // finding: string-only coercion silently nulled every stage-entry/activity/
  // lead-time timestamp on live data).
  if (value instanceof Date) return value.toISOString();
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

function asMonthlyEvidence(value: unknown): MonthlyEvidencePoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MonthlyEvidenceEntry[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return [
      {
        // Real gold evidence uses {monthStart, monthlyUnits, monthlyProfit,
        // eligible}; the simplified {month, units, profit, trusted} shape is
        // kept for fixtures (G4 follow-up: the mismatch silently emptied bands
        // on live data).
        month: asString(record.month) ?? asString(record.monthStart) ?? undefined,
        units: asNumber(record.units) ?? asNumber(record.monthlyUnits),
        profit: asNumber(record.profit) ?? asNumber(record.monthlyProfit),
        trusted: record.trusted === true || record.eligible === true,
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

interface SupplierView {
  displayName: string | null;
  shipDestination: 'direct_fba' | 'prep_center' | null;
}

interface LatestCommentView {
  body: string;
  at: string;
}

function asShipDestination(value: unknown): 'direct_fba' | 'prep_center' | null {
  return value === 'direct_fba' || value === 'prep_center' ? value : null;
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
    const commentsById = await this.loadLatestComments(
      projected
        .filter((row) => row.pane === 'inPrepMonitoring' || row.pane === 'inboundMonitoring')
        .map((row) => row.supplierOrderId),
    );
    const tiles = this.buildTiles(projected, silverById, commentsById);
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
    const suppliersById = ORDER_PANES.has(pane)
      ? await this.loadSuppliers(pageSlice.map((row) => asString(row.raw.supplierId)))
      : new Map<string, SupplierView>();
    const commentsById = ORDER_PANES.has(pane)
      ? await this.loadLatestComments(pageSlice.map((row) => row.supplierOrderId))
      : new Map<string, LatestCommentView>();
    const provenanceById =
      pane === 'discontinuedPaused'
        ? await this.loadLifecycleProvenance(pageSlice.map((row) => asString(row.raw.companyProductId)))
        : new Map<string, { kind: string; previousStatus: string | null }>();
    const familyMemberCounts =
      pane === 'discontinuedPaused' ? countFamilyMembers(projected) : new Map<string, number>();

    const rows = pageSlice.map((row) => {
      const built = this.buildRow(row, familyPaneSets, silverById, suppliersById, commentsById);
      if (pane === 'discontinuedPaused') {
        built.supplierName = asString(row.raw.supplierName);
        built.familyMemberCount = familyMemberCounts.get(row.familyKey) ?? 1;
        built.lastMovementMonth = asString(row.raw.lastClosedMonth);
        const provenance = provenanceById.get(asString(row.raw.companyProductId) ?? '') ?? null;
        built.lifecycleProvenance = provenance?.kind ?? null;
        built.lifecyclePreviousStatus = provenance?.previousStatus ?? null;
      }
      return built;
    });
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
    const suppliersById = await this.loadSuppliers(members.map((row) => asString(row.raw.supplierId)));
    const commentsById = await this.loadLatestComments(orderRowsRaw.map((row) => row.supplierOrderId));
    // QA item 2: persisted family target + selection provenance.
    const familyRecord = (await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies)
      .findOne({ filterByTk: request.familyId })) as Record<string, unknown> | null;
    const targetCompanyProductId = familyRecord ? asString(familyRecord.replenishmentTargetCompanyProductId) : null;
    const selectionEvidence =
      familyRecord &&
      typeof familyRecord.targetSelectionEvidenceJson === 'object' &&
      familyRecord.targetSelectionEvidenceJson !== null
        ? (familyRecord.targetSelectionEvidenceJson as Record<string, unknown>)
        : {};
    const familyTarget = familyRecord
      ? {
          companyProductId: targetCompanyProductId,
          selectionSource: asString(familyRecord.targetSelectionSource),
          selectionRule: asString(selectionEvidence.selectionRule),
        }
      : null;
    // QA item 3: the drawer primary carries lifecycle provenance too (was
    // pane-rows-path only).
    const provenanceById =
      pane === 'discontinuedPaused'
        ? await this.loadLifecycleProvenance(members.map((row) => asString(row.raw.companyProductId)))
        : new Map<string, { kind: string; previousStatus: string | null }>();
    // QA item 7: the drawer represents the listing the user clicked, not the
    // family-primary listing; order and family-target are fallbacks.
    const primarySource =
      (request.listingRowId ? members.find((row) => row.listingRowId === request.listingRowId) : undefined) ??
      (request.orderId ? members.find((row) => row.supplierOrderId === request.orderId) : undefined) ??
      members.find((row) => row.isFamilyTarget) ??
      members[0];
    return {
      pane,
      publishedRunId: run.id,
      familyKey: request.familyId,
      performanceEvidence: asMonthlyEvidence(primarySource.raw.monthlyPerformanceEvidence),
      familyTarget,
      familyMembers: members.map((row) => ({
        listingRowId: row.listingRowId,
        asin: asString(row.raw.asin),
        sku: asString(row.raw.sku),
        pane: row.pane,
        isTarget: Boolean(targetCompanyProductId && asString(row.raw.companyProductId) === targetCompanyProductId),
      })),
      primaryRow: this.enrichLifecycle(
        this.buildRow(primarySource, familyPaneSets, silverById, suppliersById, commentsById),
        primarySource,
        provenanceById,
      ),
      orderRows: orderRowsRaw.map((row) => this.buildRow(row, familyPaneSets, silverById, suppliersById, commentsById)),
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

  async saveSupplierShipDestination(params: SaveSupplierShipDestinationParams): Promise<{
    supplierId: string;
    shipDestination: 'direct_fba' | 'prep_center';
    updated: true;
  }> {
    const supplierId = asString(params.supplierId);
    if (!supplierId) {
      throw new InventoryDashboardValidationError('saveSupplierShipDestination requires a supplierId.');
    }
    const shipDestination = asShipDestination(params.shipDestination);
    if (!shipDestination) {
      throw new InventoryDashboardValidationError(
        'saveSupplierShipDestination requires shipDestination to be direct_fba or prep_center.',
      );
    }
    await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
      .update({ filterByTk: supplierId, values: { shipDestination } });
    return { supplierId, shipDestination, updated: true };
  }

  /** Task 002: operator reactivation — restores the pre-sweep lifecycle status. */
  async reactivateFamily(params: ReactivateFamilyParams): Promise<{ familyId: string; reactivatedCount: number }> {
    const familyId = asString(params.familyId);
    if (!familyId) {
      throw new InventoryDashboardValidationError('reactivateFamily requires a familyId.');
    }
    const comment = asString(params.comment);
    if (!comment) {
      throw new InventoryDashboardValidationError('reactivateFamily requires a reason comment.');
    }
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts);
    const members = await repository.find({
      filter: { companyProductFamilyId: familyId, lifecycleStatus: { $in: ['discontinued', 'paused'] } },
      limit: 500,
    });
    if (members.length === 0) {
      throw new InventoryDashboardValidationError(
        `reactivateFamily found no discontinued or paused members for family ${familyId}.`,
      );
    }
    const at = this.now.toISOString();
    // Deliberate ordering in lieu of a transaction (this abstraction has no
    // transaction API): the audit comment is written FIRST — if it fails,
    // nothing has changed; the per-member lifecycle updates that follow are
    // idempotent and safely re-runnable. (QA finding: a failing later step
    // must never strand committed lifecycle changes without an audit trail.)
    await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: {
        id: randomUUID(),
        entityType: 'company_product_family',
        entityId: familyId,
        actorType: 'operator',
        actorUserId: params.actorUserId,
        commentType: 'note',
        body: comment,
        workflowDetectionStatus: 'none',
      },
    });
    for (const value of members) {
      const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      const provenance =
        typeof record.lifecycleStatusProvenance === 'object' && record.lifecycleStatusProvenance !== null
          ? (record.lifecycleStatusProvenance as Record<string, unknown>)
          : {};
      const restored = asString(provenance.previousStatus) ?? 'candidate_new_product';
      await repository.update({
        filterByTk: record.id as string,
        values: {
          lifecycleStatus: restored,
          lifecycleStatusProvenance: {
            kind: 'operator_reactivation',
            previousStatus: asString(record.lifecycleStatus),
            at,
            actorUserId: asString(params.actorUserId),
          },
        },
      });
    }
    return { familyId, reactivatedCount: members.length };
  }

  /** QA item 3: attach lifecycle provenance fields to a built row. */
  private enrichLifecycle(
    row: DashboardRow,
    source: ProjectedRow,
    provenanceById: Map<string, { kind: string; previousStatus: string | null }>,
  ): DashboardRow {
    const provenance = provenanceById.get(asString(source.raw.companyProductId) ?? '') ?? null;
    if (provenance) {
      row.lifecycleProvenance = provenance.kind;
      row.lifecyclePreviousStatus = provenance.previousStatus;
    }
    return row;
  }

  private async loadLifecycleProvenance(
    companyProductIds: Array<string | null>,
  ): Promise<Map<string, { kind: string; previousStatus: string | null }>> {
    const ids = [...new Set(companyProductIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
      .find({ filter: { id: { $in: ids } }, limit: ids.length });
    const map = new Map<string, { kind: string; previousStatus: string | null }>();
    for (const value of rows) {
      const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      const id = asString(record.id);
      const provenance =
        typeof record.lifecycleStatusProvenance === 'object' && record.lifecycleStatusProvenance !== null
          ? (record.lifecycleStatusProvenance as Record<string, unknown>)
          : null;
      const kind = provenance ? asString(provenance.kind) : null;
      if (id && kind) map.set(id, { kind, previousStatus: provenance ? asString(provenance.previousStatus) : null });
    }
    return map;
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
    if (!sortKey) {
      // Task 006: tiered families sort to the TOP of Data Readiness so they
      // are never buried among migration leftovers.
      if (pane === 'dataReadiness') {
        return [...rows].sort((left, right) => Number(right.tiered) - Number(left.tiered));
      }
      return rows;
    }
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

  /**
   * Fresh order comments (QA item 1): the gold latestSupplierOrderActivity*
   * columns only refresh with a gold run, so a comment posted from the drawer
   * would stay invisible until the next refresh. This scoped $in join surfaces
   * the newest silver comment per order immediately.
   */
  private async loadLatestComments(orderIds: Array<string | null>): Promise<Map<string, LatestCommentView>> {
    const ids = [...new Set(orderIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverActivityComments)
      .find({ filter: { entityType: 'order', entityId: { $in: ids } }, limit: Math.min(ids.length * 100, 10_000) });
    const map = new Map<string, LatestCommentView>();
    for (const value of rows) {
      const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      if (record.deletedAt) continue;
      const orderId = asString(record.entityId);
      const body = asString(record.body);
      const at = asString(record.occurredAt) ?? asString(record.createdAt);
      if (!orderId || !body || !at) continue;
      const existing = map.get(orderId);
      if (!existing || at > existing.at) map.set(orderId, { body, at });
    }
    return map;
  }

  private async loadSuppliers(supplierIds: Array<string | null>): Promise<Map<string, SupplierView>> {
    const ids = [...new Set(supplierIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.silverSuppliers)
      .find({ filter: { id: { $in: ids } }, limit: ids.length });
    const map = new Map<string, SupplierView>();
    for (const value of rows) {
      const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      const id = asString(record.id);
      if (!id) continue;
      map.set(id, {
        displayName: asString(record.displayName) ?? asString(record.normalizedName),
        shipDestination: asShipDestination(record.shipDestination),
      });
    }
    return map;
  }

  private buildRow(
    row: ProjectedRow,
    familyPaneSets: Map<string, Set<PaneKey>>,
    silverById: Map<string, SilverOrderView>,
    suppliersById: Map<string, SupplierView> = new Map(),
    commentsById: Map<string, LatestCommentView> = new Map(),
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
      // T4 widened projection (REQ-X5): every group below is served VERBATIM
      // from published gold — no reclassification, nulls stay null.
      stock: {
        currentPlanningStock: asNumber(raw.currentPlanningStock),
        inventoryPositionStock: asNumber(raw.inventoryPositionStock),
        unitCost: asNumber(raw.unitCost),
        sellableStock: asNumber(raw.sellableStock),
        reservedStock: asNumber(raw.reservedStock),
        inboundStock: asNumber(raw.inboundStock),
        prepStock: asNumber(raw.prepStock),
        orderedStock: asNumber(raw.orderedStock),
        awdStock: asNumber(raw.awdStock),
        futurePositionStock: asNumber(raw.futurePositionStock),
      },
      velocity: {
        value: asNumber(raw.salesVelocity),
        basis: asString(raw.salesVelocityBasis),
        asOfDate: asString(raw.salesVelocityAsOfDate),
        evidenceStatus: asString(raw.rollingVelocityEvidenceStatus),
      },
      supplier: {
        id: asString(raw.supplierId),
        name: asString(raw.supplierName),
        leadTimeDays: asNumber(raw.leadTimeDays),
        leadTimeConfirmedAt: asString(raw.leadTimeConfirmedAt),
        leadTimeFreshness: asString(raw.leadTimeFreshness),
      },
      profit: {
        averageMonthly: asNumber(raw.averageMonthlyProfit),
        bestMonthly: asNumber(raw.bestMonthlyProfit),
        worstMonthly: asNumber(raw.worstMonthlyProfit),
        lastClosedMonth: asNumber(raw.lastClosedMonthProfit),
        projectedMonthly: asNumber(raw.projectedMonthlyProfit),
        perUnit: asNumber(raw.baselineWeightedProfitPerUnit),
      },
      daysOfCover: asNumber(raw.daysOfCover),
      positionDaysOfCover: asNumber(raw.positionDaysOfCover),
      estimatedOosDate: asString(raw.estimatedOosDate),
      positionEstimatedOosDate: asString(raw.positionEstimatedOosDate),
      latestSafeReorderDate: asString(raw.latestSafeReorderDate),
      daysUntilSafeReorder: asNumber(raw.daysUntilSafeReorder),
      estimatedProfitRisk: asNumber(raw.estimatedProfitRisk),
      moneyRiskStatus: asString(raw.moneyRiskStatus),
      moneyRiskUncoveredDays: asNumber(raw.moneyRiskUncoveredDays),
      recommendedOrderQty: asNumber(raw.recommendedOrderQty),
      // QA item 7b: readinessReasonCodes is empty on live gold rows; the actual
      // reason lives in primaryActionReasonCode — fall back so P9/P7 drawers
      // and badges never show an empty reason list.
      reasonCodes: [
        ...(asStringArray(raw.readinessReasonCodes).length
          ? asStringArray(raw.readinessReasonCodes)
          : asString(raw.primaryActionReasonCode)
            ? [asString(raw.primaryActionReasonCode) as string]
            : []),
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
      const freshComment = commentsById.get(row.supplierOrderId) ?? null;
      const goldActivityAt = asString(raw.latestSupplierOrderActivityAt);
      const effectiveActivityAt =
        freshComment && (!goldActivityAt || freshComment.at > goldActivityAt) ? freshComment.at : goldActivityAt;
      const followUp = needsFollowUp({
        daysInStage: stageDays,
        latestActivityAt: effectiveActivityAt,
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
      const supplierId = asString(raw.supplierId);
      const supplier = supplierId ? suppliersById.get(supplierId) ?? null : null;
      dashboardRow.order.supplierId = supplierId;
      dashboardRow.order.supplierName = supplier?.displayName ?? asString(raw.supplierName);
      dashboardRow.order.supplierShipDestination = supplier?.shipDestination ?? null;
      if (row.pane === 'inPrepMonitoring' || row.pane === 'inboundMonitoring') {
        dashboardRow.order.prepPath = prepPath({
          isDirectShipFba: row.directShip,
          supplierShipDestination: supplier?.shipDestination ?? null,
        });
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
      const useFreshComment = freshComment && (!goldActivityAt || freshComment.at > goldActivityAt);
      dashboardRow.lastActivity = useFreshComment
        ? pickLastActivity({ note: freshComment.body, actorDisplayName: null, actor: null, at: freshComment.at })
        : pickLastActivity({
            note: asString(raw.latestSupplierOrderActivityNote),
            actorDisplayName: asString(raw.latestSupplierOrderActivityActorDisplayName),
            actor: asString(raw.latestSupplierOrderActivityActor),
            at: goldActivityAt,
          });
    }

    if (row.pane === 'performanceReview') {
      dashboardRow.performanceBand = band;
    }
    return dashboardRow;
  }

  private buildTiles(
    projected: ProjectedRow[],
    silverById: Map<string, SilverOrderView>,
    commentsById: Map<string, LatestCommentView> = new Map(),
  ): DashboardHeaderTile[] {
    const today = todayDateOnly(this.now);
    // Task 002: discontinued/paused families contribute NO signals to any tile.
    const signalRows = projected.filter((row) => row.pane !== 'discontinuedPaused');

    const urgent = signalRows.filter(
      (row) =>
        (row.pane === 'supplyAction' && onOrBeforeToday(asString(row.raw.latestSafeReorderDate), today)) ||
        row.pane === 'zeroStock',
    );
    const orderedLate = signalRows.filter((row) => asString(row.raw.pipelineHealthStatus) === 'late');
    const stale = signalRows.filter(
      (row) => staleLeadTime(asString(row.raw.leadTimeConfirmedAt), this.leadTimeFreshnessDays, this.now).stale,
    );
    const staleUnknown = signalRows.filter(
      (row) => staleLeadTime(asString(row.raw.leadTimeConfirmedAt), this.leadTimeFreshnessDays, this.now).unknown,
    );
    const followUps = signalRows.filter((row) => {
      if (!row.supplierOrderId) return false;
      if (row.pane !== 'inPrepMonitoring' && row.pane !== 'inboundMonitoring') return false;
      const enteredAt = silverById.get(row.supplierOrderId)?.workflowStageEnteredAt ?? null;
      const goldAt = asString(row.raw.latestSupplierOrderActivityAt);
      const comment = commentsById.get(row.supplierOrderId) ?? null;
      const effectiveAt = comment && (!goldAt || comment.at > goldAt) ? comment.at : goldAt;
      return needsFollowUp({
        daysInStage: daysInStage(enteredAt, this.now),
        latestActivityAt: effectiveAt,
        workflowStageEnteredAt: enteredAt,
        thresholdHours: this.followUpThresholdHours,
        now: this.now,
      });
    });
    const stuck = signalRows.filter((row) => row.pane === 'stuckInventory');

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
    const metrics: PaneMetric[] = [
      { key: 'count', label: 'Rows', value: rows.length },
      { key: 'moneyAtRisk', label: 'Money at risk', value: money.value, format: 'currency' },
      { key: 'unknownMoney', label: 'Unknown money inputs', value: money.unknownCount },
    ];
    if (pane === 'dataReadiness') {
      // Task 006: the dashboard's job is to drive this number to 0.
      metrics.push({
        key: 'tieredNeedingAttention',
        label: 'Tiered families needing attention',
        value: new Set(rows.filter((row) => row.tiered).map((row) => row.familyKey)).size,
      });
    }
    return metrics;
  }
}

function countFamilyMembers(projected: ProjectedRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of projected) counts.set(row.familyKey, (counts.get(row.familyKey) ?? 0) + 1);
  return counts;
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
