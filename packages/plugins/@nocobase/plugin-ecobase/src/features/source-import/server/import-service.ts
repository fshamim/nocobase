/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import { analyzeCsvFiles, targetForCsvShape } from './adapters/amazon-operations-csv-adapter';
import type {
  AdapterStreamItem,
  NormalizedRecord,
  SourceAdapter,
  SourceAdapterImportInput,
  SourceAdapterRegistry,
} from './adapters';
import { parseCsv, type CsvSourceFile } from './adapters/csv-utils';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { EcobaseAccountabilityService } from '../../../server/services/accountability-service';
import { bronzePayloadHash, bronzeRetentionUntil, EcobaseBronzeImportService } from './bronze-import-service';
import {
  EcobaseClickupOrderStatusService,
  extractClickupOrderRefsFromTitle,
  type ClickupOrderStatusImportResult,
} from './clickup-order-status-service';
import { FOUR_COMPANY_MIGRATION_PROFILE } from './four-company-migration-profile';
import { applySafeImportBoundary } from './safe-import-boundary';
import { projectSourceRecord } from './source-record-projection';
import { decideCompanyScope } from './source-scope-policy';
import { EcobaseDataWarningService } from '../../../server/services/data-warning-service';
import type { EcobaseDataWarning } from '../../../server/services/data-warning-service';
import { EcobaseInventoryPlanningService } from '../../inventory-planning/server/inventory-planning-service';
import { EcobaseCompanyProductFamilyService } from '../../inventory-planning/server/company-product-family-service';
import {
  EcobaseOrderReceiptReconciliationService,
  receiptReconciliationOrderIdsForRefresh,
  type ReceiptReconciliationResult,
  type ReceiptStateCoverage,
} from '../../inventory-planning/server/order-receipt-reconciliation-service';
import { EcobaseManagementKpiFactsService } from '../../daily-operations-brief/server/management-kpi-facts-service';
import { EcobaseMedallionNormalizationService } from '../../semantic-model/server/medallion-normalization-service';
import type { NormalizePendingResult } from '../../semantic-model/server/medallion-normalization-service';
import { EcobaseOrderPlanningService } from '../../order-planning/server/order-planning-service';
import { EcobasePlanningProductService } from '../../inventory-planning/server/planning-product-service';
import { EcobaseSupplierManagementService } from '../../supplier-management/server/supplier-management-service';
import { validateSupplierLeadTimeDays } from '../../supplier-management/server/supplier-order-service';
import { EcobaseProtectedCatalogBoundary, type ProtectedCatalogReport } from './protected-catalog-boundary';

type Filter = Record<string, unknown>;

type RepositoryFindParams = {
  filter?: Filter;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
  appends?: string[];
};

type RepositoryCreateParams = { values: Record<string, unknown>; transaction?: unknown };
type RepositoryUpdateParams = { filterByTk?: string | number | null; filter?: Filter; values: Record<string, unknown> };
type RepositoryDestroyParams = { filter?: Filter; filterByTk?: string | number; where?: Filter };

type ImportFileSummary = {
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  sampleMappedRecord?: Record<string, unknown>;
};

type ImportDecisionCounts = {
  acceptedCount: number;
  discardedCount: number;
  reviewCount: number;
  droppedFieldCount: number;
  reasons: Record<string, number>;
};

type AdapterImportStreamResult = {
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  errorCount: number;
  errorMessage: string | null;
  statusMessage: string | null;
  firstErrorIssueMessage: string | null;
  finalStatusOverride: string | null;
  fileSummaries: Record<string, ImportFileSummary>;
  accountabilityTouched: boolean;
  migrationSummary: ImportDecisionCounts & { bySourceGroup: Record<string, ImportDecisionCounts> };
  protectedCatalog?: ProtectedCatalogReport;
};

type AdapterImportStreamParams = {
  importRunId: string;
  bronzeService: EcobaseBronzeImportService;
  bronzeContext: {
    importRunId: string;
    sourceConnectionId: string;
    sourceIdentifier: string;
    sourceVersion: string;
    adapter: SourceAdapter;
  };
  adapter: SourceAdapter;
  adapterInput: SourceAdapterImportInput;
  adapterConfig: Record<string, unknown>;
  skipExistingNormalizedKinds: Set<string>;
};

const NORMALIZED_RECORD_COLLECTIONS: Record<string, string> = {
  source_access_audit: ECOBASE_COLLECTIONS.sourceAccessAudits,
};

type NormalizedRecordTarget = {
  collectionName: string;
  values: Record<string, unknown>;
  createValues?: Record<string, unknown>;
};

function validateNormalizedRecord(record: NormalizedRecord) {
  if (!['supplier_lead_time', 'planning_parameter'].includes(record.kind)) return;
  const value = record.data.leadTimeDays;
  const context = `Ecobase import failed: ${record.kind}`;
  if (value !== undefined && typeof value !== 'number') {
    throw new Error(`${context}: leadTimeDays must be a number.`);
  }
  validateSupplierLeadTimeDays(value as number | undefined, context);
}

function normalizedRecordTarget(record: NormalizedRecord, importRunId: string): NormalizedRecordTarget {
  const data = toPlainRecord(record.data);
  const values: Record<string, unknown> = { ...data, lastImportRunId: importRunId };
  if (record.kind === 'clickup_task_snapshot') {
    const sourceTaskRef = getString(values, 'sourceTaskRef') ?? getString(values, 'externalTaskId') ?? 'unknown-task';
    const taskName = getString(values, 'taskName') ?? sourceTaskRef;
    delete values.externalTaskId;
    return {
      collectionName: ECOBASE_COLLECTIONS.silverTasks,
      values: { ...values, sourceTaskRef, title: taskName, taskName, dueAt: getString(values, 'dueDate') },
      createValues: { id: randomUUID() },
    };
  }
  if (record.kind === 'task_link') {
    const sourceTaskRef = getString(values, 'sourceTaskRef') ?? getString(values, 'externalTaskId') ?? 'unknown-task';
    const targetType = getString(values, 'targetType') ?? 'general';
    const targetId = getString(values, 'targetId') ?? getString(values, 'okrId');
    const entityId = getString(values, 'planningProductId') ?? getString(values, 'supplierOrderId') ?? targetId;
    delete values.externalTaskId;
    delete values.okrId;
    return {
      collectionName: ECOBASE_COLLECTIONS.silverTaskLinks,
      values: { ...values, sourceTaskRef, targetId, entityType: targetType, entityId, relation: 'related' },
      createValues: { id: randomUUID() },
    };
  }
  if (record.kind === 'okr') {
    const sourceTargetRef =
      getString(values, 'sourceTargetRef') ?? getString(values, 'externalOkrId') ?? 'unknown-target';
    const period = getString(values, 'period') ?? 'unknown';
    delete values.externalOkrId;
    delete values.okrId;
    return {
      collectionName: ECOBASE_COLLECTIONS.silverTargets,
      values: {
        ...values,
        sourceTargetRef,
        recordKind: 'target',
        entityType: 'objective',
        metric: 'objective',
        periodType: period,
        periodStart: period,
        periodEnd: period,
      },
      createValues: { id: randomUUID() },
    };
  }
  if (record.kind === 'okr_metric_snapshot') {
    const snapshotDate = getString(values, 'snapshotDate') ?? new Date().toISOString().slice(0, 10);
    const metricName = getString(values, 'metricName') ?? 'primary';
    const sourceTargetRef =
      getString(values, 'sourceTargetRef') ?? getString(values, 'externalOkrId') ?? 'unknown-target';
    const parentTargetId = getString(values, 'parentTargetId') ?? getString(values, 'okrId');
    delete values.externalOkrId;
    delete values.okrId;
    return {
      collectionName: ECOBASE_COLLECTIONS.silverTargets,
      values: {
        ...values,
        sourceTargetRef,
        parentTargetId,
        recordKind: 'metric_snapshot',
        entityType: 'objective',
        metric: metricName,
        periodType: 'snapshot',
        periodStart: snapshotDate,
        periodEnd: snapshotDate,
        snapshotDate,
        metricName,
      },
      createValues: { id: randomUUID() },
    };
  }
  const collectionName = NORMALIZED_RECORD_COLLECTIONS[record.kind];
  return { collectionName, values };
}

const BRONZE_ONLY_RECORD_KINDS = new Set([
  'raw_listing',
  'listing_daily_fact',
  'inventory_snapshot',
  'traffic_snapshot',
  'planning_parameter',
  'supplier',
  'supplier_identity',
  'supplier_lead_time',
  'supplier_order',
  'target_row',
]);
const ACCOUNTABILITY_RECORD_KINDS = new Set(['clickup_task_snapshot', 'task_link', 'okr', 'okr_metric_snapshot']);
const CSV_BUNDLE_SYNC_ROW_LIMIT = 1000;
const AUTOMATIC_GOLD_REFRESH_LIMIT = 10000;
const GOLD_REFRESH_SOURCE_TYPES = new Set(['google_sheets', 'seller_central_file', 'sellerboard']);
const GOLD_REFRESH_DOMAINS = new Set(['amazon_operations', 'order_management', 'supplier_management']);

export interface EcobaseRepository {
  find(params?: RepositoryFindParams): Promise<unknown[]>;
  findOne(params?: RepositoryFindParams): Promise<unknown | null>;
  create(params: RepositoryCreateParams): Promise<unknown>;
  update(params: RepositoryUpdateParams): Promise<unknown>;
  destroy?(params: RepositoryDestroyParams): Promise<unknown>;
}

export interface EcobaseDatabase {
  getRepository(name: string): EcobaseRepository;
  sequelize?: any;
}

export interface RunNoopImportParams {
  sourceConnectionId: string;
  sourceIdentifier?: string;
  sourceVersion?: string;
  idempotencyKey?: string;
  preserveAuditRun?: boolean;
  skipIfNoNewerData?: boolean;
  skipExistingNormalizedKinds?: string[];
  runtimeConfig?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

type QueuedImportRun = {
  id: string;
  startedAt: Date;
  idempotencyKey: string;
};

type RunAdapterImportParams = RunNoopImportParams & {
  adapterName: string;
  queuedImportRun?: QueuedImportRun;
  startedAt?: Date;
};

export interface RunCsvBundleImportParams {
  sourceConnectionId: string;
  adapterName: string;
  sourceIdentifier?: string;
  sourceVersion?: string;
  defaultCompany?: string;
  files: CsvSourceFile[];
}

export interface ImportClickupOrderStatusesParams {
  sourceConnectionId?: string;
  sourceIdentifier?: string;
  files: CsvSourceFile[];
  orderDetailFiles?: CsvSourceFile[];
  dryRun?: boolean;
  importedAt?: string;
  snapshotDate?: string;
  forceReconcile?: boolean;
  overrideOperatorStatus?: boolean;
}

interface ClickupReceiptStateCoverage extends ReceiptStateCoverage {
  pendingWorkflowDraftRefs: string[];
}

interface ClickupOrderStatusOrchestrationResult extends ClickupOrderStatusImportResult {
  receiptStateCoverageBefore: ClickupReceiptStateCoverage;
  receiptStateCoverage: ClickupReceiptStateCoverage;
  receiptReconciliation: ReceiptReconciliationResult | null;
}

export interface RunScheduledSellerboardImportsParams {
  now?: string;
  sourceConnectionId?: string;
}

export interface RunMedallionPipelineParams {
  sourceConnectionId?: string;
  sourceVersion?: string;
}

export interface AutomaticGoldRefreshResult {
  calculationDate: string;
  inventory: Record<string, unknown>;
  orders: { rowCount: number; lastRefreshedAt: string | null };
  suppliers: { rowCount: number; summary: Record<string, unknown> };
  managementKpiFacts: { factCount: number; metrics: Record<string, number>; skippedMetrics: string[] };
  receiptReconciliation: Record<string, unknown> | null;
}

export interface RunMedallionPipelineResult {
  imports: Record<string, unknown>[];
  normalization: NormalizePendingResult;
  failures: string[];
  goldRefreshRequired: boolean;
}

export interface SourceStatusView {
  sourceConnectionId: string;
  connectionName: string;
  companyId: string | null;
  companyName: string | null;
  sourceType: string;
  domain: string;
  active: boolean;
  required: boolean;
  freshnessSlaMinutes: number | null;
  latestImportRunId: string | null;
  latestRunStatus: string | null;
  latestSuccessfulRunAt: string | null;
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  latestRunWarningCount: number;
  errorCount: number;
  lastRunAt: string | null;
  latestWarning: EcobaseDataWarning | null;
  warnings: EcobaseDataWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toPlainRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value) && typeof value.toJSON === 'function') {
    const json = value.toJSON();
    if (isRecord(json)) {
      return json;
    }
  }
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function getString(record: unknown, key: string): string | undefined {
  const plain = toPlainRecord(record);
  const value = plain[key];
  return typeof value === 'string' ? value : undefined;
}

function getBoolean(record: unknown, key: string, fallback: boolean): boolean {
  const plain = toPlainRecord(record);
  const value = plain[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getNumber(record: unknown, key: string): number {
  const plain = toPlainRecord(record);
  const value = plain[key];
  return typeof value === 'number' ? value : 0;
}

function getOptionalNumber(record: unknown, key: string): number | undefined {
  const plain = toPlainRecord(record);
  const value = plain[key];
  return typeof value === 'number' ? value : undefined;
}

function getConfig(record: unknown): Record<string, unknown> {
  const config = toPlainRecord(record).config;
  return isRecord(config) ? config : {};
}

function mergeConfig(record: unknown, runtimeConfig?: Record<string, unknown>): Record<string, unknown> {
  return { ...getConfig(record), ...(runtimeConfig ?? {}) };
}

function inlineCsvFiles(config: Record<string, unknown>): CsvSourceFile[] {
  const files = config.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file): CsvSourceFile[] => {
    const record = toPlainRecord(file);
    if (typeof record.name !== 'string' || typeof record.content !== 'string') return [];
    const csvFile: CsvSourceFile = { name: record.name, content: record.content };
    if (typeof record.expectedRowCount === 'number') csvFile.expectedRowCount = record.expectedRowCount;
    if (typeof record.snapshotDate === 'string') csvFile.snapshotDate = record.snapshotDate;
    return [csvFile];
  });
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function bundleHash(files: Array<{ checksum: string }>) {
  return sha256(
    files
      .map((file) => file.checksum)
      .sort()
      .join('\n'),
  );
}

function latestCsvBundleFiles(importRun: unknown): Array<Record<string, unknown>> {
  const summary = toPlainRecord(toPlainRecord(importRun).summary);
  const csvBundle = toPlainRecord(summary.csvBundle);
  return Array.isArray(csvBundle.files) ? csvBundle.files.filter(isRecord) : [];
}

function csvBundleFileKey(file: { name?: unknown; checksum?: unknown }) {
  const name = typeof file.name === 'string' ? file.name : '';
  const checksum = typeof file.checksum === 'string' ? file.checksum : '';
  return `${name}:${checksum}`;
}

function getDateString(record: unknown, key: string): string | null {
  const value = toPlainRecord(record)[key];
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : null;
}

function getSourceFileName(sourceKey?: string) {
  if (!sourceKey) {
    return undefined;
  }
  const separatorIndex = sourceKey.indexOf(':');
  return separatorIndex >= 0 ? sourceKey.slice(0, separatorIndex) : sourceKey;
}

function summarizeRecord(record: NormalizedRecord) {
  const values = toPlainRecord(record.data);
  return {
    kind: record.kind,
    naturalKey: getString(values, 'naturalKey'),
    externalOrderRef: getString(values, 'externalOrderRef'),
    sourceOrderLineRef: getString(values, 'sourceOrderLineRef'),
    company: getString(values, 'company'),
  };
}

function updateFileSummary(
  summaries: Record<string, ImportFileSummary>,
  fileName: string | undefined,
  update: Partial<ImportFileSummary>,
) {
  if (!fileName) {
    return;
  }
  const current = summaries[fileName] ?? { rowCount: 0, normalizedCount: 0, warningCount: 0 };
  summaries[fileName] = {
    ...current,
    ...update,
    rowCount: current.rowCount + (update.rowCount ?? 0),
    normalizedCount: current.normalizedCount + (update.normalizedCount ?? 0),
    warningCount: current.warningCount + (update.warningCount ?? 0),
    sampleMappedRecord: current.sampleMappedRecord ?? update.sampleMappedRecord,
  };
}

function updateMigrationSummary(
  summary: ImportDecisionCounts & { bySourceGroup: Record<string, ImportDecisionCounts> },
  sourceGroup: string | undefined,
  decision: ReturnType<typeof applySafeImportBoundary>,
) {
  const group = sourceGroup ?? '(unknown source group)';
  const groupSummary = summary.bySourceGroup[group] ?? {
    acceptedCount: 0,
    discardedCount: 0,
    reviewCount: 0,
    droppedFieldCount: 0,
    reasons: {},
  };
  const countKey =
    decision.disposition === 'accept'
      ? ('acceptedCount' as const)
      : decision.disposition === 'review'
        ? ('reviewCount' as const)
        : ('discardedCount' as const);
  summary[countKey] += 1;
  summary.droppedFieldCount += decision.droppedFieldCount;
  summary.reasons[decision.reasonCode] = (summary.reasons[decision.reasonCode] ?? 0) + 1;
  groupSummary[countKey] += 1;
  groupSummary.droppedFieldCount += decision.droppedFieldCount;
  groupSummary.reasons[decision.reasonCode] = (groupSummary.reasons[decision.reasonCode] ?? 0) + 1;
  summary.bySourceGroup[group] = groupSummary;
}

function defaultAdapterNameForSourceConnection(sourceConnection: unknown) {
  const config = getConfig(sourceConnection);
  const configured = typeof config.adapterName === 'string' ? config.adapterName : undefined;
  if (configured) return configured;
  const sourceType = getString(sourceConnection, 'sourceType');
  if (sourceType === 'sellerboard') return 'sellerboard-api';
  if (sourceType === 'google_sheets') return 'google-sheets-migration-csv';
  if (sourceType === 'seller_central_file') return 'amazon-operations-csv';
  if (sourceType === 'noop_test') return 'noop-test';
  return undefined;
}

function validateSourceConnectionForAdapter(sourceConnection: unknown, adapter: SourceAdapter) {
  const sourceConnectionId = getString(sourceConnection, 'id') ?? '(missing id)';
  const sourceType = getString(sourceConnection, 'sourceType');
  const domain = getString(sourceConnection, 'domain');

  if (sourceType !== adapter.metadata.sourceType) {
    throw new Error(
      `Ecobase import failed: source connection "${sourceConnectionId}" has sourceType "${
        sourceType ?? '(missing)'
      }" but adapter "${adapter.metadata.name}" requires "${adapter.metadata.sourceType}".`,
    );
  }

  if (!domain || !adapter.metadata.supportedDomains.includes(domain)) {
    throw new Error(
      `Ecobase import failed: source connection "${sourceConnectionId}" has domain "${
        domain ?? '(missing)'
      }" but adapter "${adapter.metadata.name}" supports domains: ${adapter.metadata.supportedDomains.join(', ')}.`,
    );
  }
}

function shouldRefreshGoldAfterImport(sourceConnection: unknown) {
  const sourceType = getString(sourceConnection, 'sourceType');
  const domain = getString(sourceConnection, 'domain');
  return Boolean(sourceType && domain && GOLD_REFRESH_SOURCE_TYPES.has(sourceType) && GOLD_REFRESH_DOMAINS.has(domain));
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function retainClickupSourceRows(params: {
  db: EcobaseDatabase;
  files: CsvSourceFile[];
  importRunId: string;
  sourceConnectionId: string;
  sourceVersion: string;
}) {
  const summary = { acceptedCount: 0, discardedCount: 0, droppedFieldCount: 0, reasons: {} as Record<string, number> };
  const count = (disposition: 'acceptedCount' | 'discardedCount', reason: string) => {
    summary[disposition] += 1;
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
  };
  const repo = params.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords);
  for (const file of params.files) {
    const parsed = parseCsv(file.content);
    for (const [index, source] of parsed.rows.entries()) {
      const rowNumber = index + 2;
      const taskId = getString(source, 'Task ID') ?? `row-${rowNumber}`;
      const orderRefs = extractClickupOrderRefsFromTitle(getString(source, 'Task Name') ?? '');
      if (orderRefs.length !== 1) {
        count('discardedCount', orderRefs.length ? 'clickup_order_ref_ambiguous' : 'clickup_order_ref_missing');
        continue;
      }
      const retainedOrderRef = orderRefs[0];
      const scope = decideCompanyScope({ source: 'clickup', orderRef: retainedOrderRef });
      if (scope.disposition === 'discard') {
        count('discardedCount', scope.reasonCode);
        continue;
      }
      const projection = projectSourceRecord(
        'clickup_order_evidence',
        {
          taskId,
          parentId: getString(source, 'Parent ID'),
          orderRef: retainedOrderRef,
          status: getString(source, 'Status'),
          statusUpdatedAt: getString(source, 'Date Created Text') ?? getString(source, 'Date Created'),
        },
        { retainedOrderRef },
      );
      summary.droppedFieldCount += Object.keys(source).length - Object.keys(projection.payload).length;
      count('acceptedCount', scope.reasonCode);
      const sourceRecordKey = `${file.name}:${taskId}`;
      const rowHash = bronzePayloadHash(projection.payload);
      const existing = await repo.findOne({
        filter: {
          sourceConnectionId: params.sourceConnectionId,
          sourceDataset: 'clickup_order_evidence',
          sourceRecordKey,
          rowHash,
        },
      });
      if (existing) continue;
      await repo.create({
        values: {
          id: randomUUID(),
          sourceConnectionId: params.sourceConnectionId,
          importRunId: params.importRunId,
          sourceType: 'clickup',
          sourceDataset: 'clickup_order_evidence',
          sourceRecordKey,
          sourceKey: taskId,
          rowNumber,
          observedAt: params.sourceVersion,
          payload: projection.payload,
          rowHash,
          normalizationStatus: 'normalized',
          normalizedAt: new Date(),
          retentionUntil: bronzeRetentionUntil(params.sourceVersion),
        },
      });
    }
  }
  return summary;
}

export class EcobaseImportService {
  constructor(
    private db: EcobaseDatabase,
    private registry: SourceAdapterRegistry,
  ) {}

  private async cleanupExpiredBronzeRecords(asOf = new Date()) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords);
    if (!repo.destroy) return null;
    return new EcobaseBronzeImportService(this.db).deleteExpiredSourceRecords(asOf);
  }

  async deactivateMigrationSources() {
    const sourceTypes = [...FOUR_COMPANY_MIGRATION_PROFILE.migrationOnlySourceTypes];
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const sources = await repo.find({ filter: { sourceType: { $in: sourceTypes } }, limit: 100 });
    const deactivatedCount = sources.map(toPlainRecord).filter((source) => source.active !== false).length;
    if (deactivatedCount > 0) {
      await repo.update({ filter: { sourceType: { $in: sourceTypes } }, values: { active: false } });
    }
    return { sourceTypes, matchedCount: sources.length, deactivatedCount };
  }

  async purgeExpiredBronzeRecords(asOf: string) {
    const before = new Date(asOf);
    if (Number.isNaN(before.getTime())) {
      throw new Error(`Ecobase Bronze purge failed: asOf "${asOf}" is not a valid date.`);
    }
    const deletedCount = await new EcobaseBronzeImportService(this.db).deleteExpiredSourceRecords(before);
    return { before: before.toISOString(), deletedCount };
  }

  async refreshGoldReadModels(
    calculationDate = todayIsoDate(),
    affectedOrderIds: string[] = [],
  ): Promise<AutomaticGoldRefreshResult> {
    const assessedOrders = await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({ limit: 20000 });
    const receiptOrderIds = receiptReconciliationOrderIdsForRefresh(
      assessedOrders.map(toPlainRecord),
      affectedOrderIds,
    );
    const receiptReconciliation = receiptOrderIds.length
      ? await new EcobaseOrderReceiptReconciliationService(this.db).reconcileAffectedOrders({
          orderIds: receiptOrderIds,
          evaluatedAt: `${calculationDate}T23:59:59.999Z`,
        })
      : null;
    const inventoryService = new EcobaseInventoryPlanningService(this.db);
    const orderWorkspace = await new EcobaseOrderPlanningService(this.db).refreshReadModel({
      calculationDate,
      limit: AUTOMATIC_GOLD_REFRESH_LIMIT,
    });
    const inventory = await inventoryService.refreshReadModel({
      calculationDate,
      limit: AUTOMATIC_GOLD_REFRESH_LIMIT,
    });
    const supplierDigest = await new EcobaseSupplierManagementService(this.db).refreshSupplierAttentionRows({
      calculationDate,
      limit: AUTOMATIC_GOLD_REFRESH_LIMIT,
    });
    const managementKpiFacts = await new EcobaseManagementKpiFactsService(this.db).refreshForDate({
      date: calculationDate,
    });
    return {
      calculationDate,
      inventory: inventory as Record<string, unknown>,
      orders: {
        rowCount: orderWorkspace.rows.length,
        lastRefreshedAt: getString(orderWorkspace.rows[0], 'lastRefreshedAt') ?? null,
      },
      suppliers: {
        rowCount: supplierDigest.rows.length,
        summary: supplierDigest.summary as Record<string, unknown>,
      },
      managementKpiFacts: {
        factCount: managementKpiFacts.factCount,
        metrics: managementKpiFacts.metrics,
        skippedMetrics: managementKpiFacts.skippedMetrics,
      },
      receiptReconciliation: receiptReconciliation as unknown as Record<string, unknown> | null,
    };
  }

  async importClickupOrderStatuses(
    params: ImportClickupOrderStatusesParams,
  ): Promise<ClickupOrderStatusImportResult | Record<string, unknown>> {
    this.validateCsvBundleFiles(params.files);
    const dryRun = params.dryRun !== false;
    const clickupService = new EcobaseClickupOrderStatusService(this.db);
    const receiptService = new EcobaseOrderReceiptReconciliationService(this.db);
    if (dryRun) {
      const result = await clickupService.importCsvFiles({ ...params, dryRun: true });
      const orderIds = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({ limit: 100000 }))
        .map(toPlainRecord)
        .map((order) => getString(order, 'id'))
        .filter((orderId): orderId is string => Boolean(orderId));
      const coverage = {
        ...(await receiptService.inspectCoverage(orderIds)),
        pendingWorkflowDraftRefs: result.workflowDraftRefs,
      };
      return {
        ...result,
        receiptStateCoverageBefore: coverage,
        receiptStateCoverage: coverage,
        receiptReconciliation: null,
      } satisfies ClickupOrderStatusOrchestrationResult;
    }
    if (!params.sourceConnectionId) {
      throw new Error('Ecobase ClickUp order-status import requires sourceConnectionId.');
    }

    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnection = await sourceConnectionRepo.findOne({ filterByTk: params.sourceConnectionId });
    if (!sourceConnection) {
      throw new Error(
        `Ecobase ClickUp order-status import failed: source connection "${params.sourceConnectionId}" was not found.`,
      );
    }
    if (
      getString(sourceConnection, 'sourceType') !== 'clickup' ||
      getString(sourceConnection, 'domain') !== 'order_management'
    ) {
      throw new Error(
        `Ecobase ClickUp order-status import failed: source connection "${params.sourceConnectionId}" must be clickup/order_management.`,
      );
    }
    if (toPlainRecord(sourceConnection).active === false) {
      throw new Error(
        `Ecobase ClickUp order-status import failed: source connection "${params.sourceConnectionId}" is inactive.`,
      );
    }

    await this.cleanupExpiredBronzeRecords();
    const startedAt = new Date();
    const sourceIdentifier = params.sourceIdentifier ?? 'clickup-order-status-csv';
    const sourceVersion =
      params.snapshotDate ?? params.importedAt?.slice(0, 10) ?? startedAt.toISOString().slice(0, 10);
    const contentHash = createHash('sha256');
    for (const file of [...params.files, ...(params.orderDetailFiles ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      contentHash.update(file.name).update('\0').update(file.content).update('\0');
    }
    const baseIdempotencyKey = `${params.sourceConnectionId}:${sourceIdentifier}:${contentHash.digest('hex')}`;
    const existingRun = (
      await importRunRepo.find({
        filter: { sourceConnectionId: params.sourceConnectionId, sourceIdentifier },
        limit: 10000,
      })
    )
      .map(toPlainRecord)
      .filter((run) => getString(run, 'idempotencyKey')?.startsWith(baseIdempotencyKey))
      .sort(
        (left, right) =>
          new Date(String(left.finishedAt ?? 0)).getTime() - new Date(String(right.finishedAt ?? 0)).getTime(),
      )
      .at(-1);
    if (
      existingRun &&
      getString(existingRun, 'status') === 'success' &&
      !params.forceReconcile &&
      !params.overrideOperatorStatus
    ) {
      return this.createSkippedImportRun(importRunRepo, {
        sourceConnectionId: params.sourceConnectionId,
        adapterName: 'clickup-order-status-csv',
        sourceIdentifier,
        sourceVersion,
        idempotencyKey: `${baseIdempotencyKey}:skipped:${randomUUID()}`,
        startedAt,
        errorMessage: 'Ecobase ClickUp order-status import skipped: CSV content is unchanged.',
        summary: {
          originalImportRunId: getString(existingRun, 'id'),
          contentHash: baseIdempotencyKey.split(':').at(-1),
        },
      });
    }

    const importRunId = randomUUID();
    const idempotencyKey = existingRun ? `${baseIdempotencyKey}:retry:${randomUUID()}` : baseIdempotencyKey;
    await importRunRepo.create({
      values: {
        id: importRunId,
        sourceConnectionId: params.sourceConnectionId,
        adapterName: 'clickup-order-status-csv',
        sourceIdentifier,
        sourceVersion,
        idempotencyKey,
        startedAt,
        status: 'pending',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
    });

    try {
      const result = await clickupService.importCsvFiles({ ...params, dryRun: false });
      const affectedOrderIds = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders).find({ limit: 100000 }))
        .map(toPlainRecord)
        .map((order) => getString(order, 'id'))
        .filter((orderId): orderId is string => Boolean(orderId));
      const receiptStateCoverageBefore = {
        ...(await receiptService.inspectCoverage(affectedOrderIds)),
        pendingWorkflowDraftRefs: [],
      };
      const receiptReconciliation = affectedOrderIds.length
        ? await receiptService.reconcileAffectedOrders({
            orderIds: affectedOrderIds,
            evaluatedAt: params.importedAt ?? startedAt.toISOString(),
          })
        : null;
      const receiptStateCoverage = {
        ...(await receiptService.inspectCoverage(affectedOrderIds)),
        pendingWorkflowDraftRefs: [],
      };
      const orchestratedResult = {
        ...result,
        receiptStateCoverageBefore,
        receiptStateCoverage,
        receiptReconciliation,
      } satisfies ClickupOrderStatusOrchestrationResult;
      const sourceRetention = await retainClickupSourceRows({
        db: this.db,
        files: params.files,
        importRunId,
        sourceConnectionId: params.sourceConnectionId,
        sourceVersion,
      });
      const warningCount =
        result.unmatchedRefCount +
        result.missingMainTaskCount +
        result.duplicateRefCount +
        result.invalidCommentCount +
        result.conflictingMainTaskCount +
        result.companyConflictCount +
        result.ambiguousMultiRefTaskCount +
        result.workflowDraftExceptions.length;
      const receiptErrorCount = receiptReconciliation?.errors.length ?? 0;
      const errorCount = result.blockingIssueCount + receiptErrorCount;
      const goldRefreshRequired =
        errorCount === 0 &&
        (result.updatedOrderCount > 0 ||
          result.workflowDraftCount > 0 ||
          (receiptReconciliation?.updatedOrders ?? 0) > 0 ||
          (receiptReconciliation?.updatedLines ?? 0) > 0);
      await importRunRepo.update({
        filterByTk: importRunId,
        values: {
          finishedAt: new Date(),
          status: errorCount > 0 ? 'partial' : 'success',
          rowCount: result.rowCount,
          normalizedCount: result.updatedOrderCount + result.importedCommentCount,
          warningCount,
          errorCount,
          errorMessage:
            errorCount > 0
              ? `ClickUp import found ${result.blockingIssueCount} status blocker(s) and ${receiptErrorCount} receipt reconciliation error(s).`
              : null,
          summary: {
            clickup: orchestratedResult,
            sourceRetention,
            migration: {
              profileVersion: FOUR_COMPANY_MIGRATION_PROFILE.profileVersion,
              asOfDate: sourceVersion.slice(0, 10),
              ...sourceRetention,
              reviewCount: 0,
            },
            goldRefreshRequired,
          },
        },
      });
      return toPlainRecord(await importRunRepo.findOne({ filterByTk: importRunId }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'ClickUp import threw a non-Error value.';
      await importRunRepo.update({
        filterByTk: importRunId,
        values: { finishedAt: new Date(), status: 'failed', errorCount: 1, errorMessage },
      });
      throw error;
    }
  }

  async runNoopImport(params: RunNoopImportParams) {
    return this.runAdapterImport({ adapterName: 'noop-test', ...params });
  }

  analyzeCsvBundle(files: CsvSourceFile[]) {
    this.validateCsvBundleFiles(files);
    return analyzeCsvFiles(files);
  }

  async runCsvBundleImport(params: RunCsvBundleImportParams) {
    this.validateCsvBundleFiles(params.files);
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnection = await sourceConnectionRepo.findOne({ filterByTk: params.sourceConnectionId });
    if (!sourceConnection) {
      throw new Error(
        `Ecobase CSV bundle import failed: source connection "${params.sourceConnectionId}" was not found.`,
      );
    }
    const adapter = this.registry.get(params.adapterName);
    validateSourceConnectionForAdapter(sourceConnection, adapter);

    const analysis = analyzeCsvFiles(params.files);
    const rejected = analysis.files.filter((file) => !file.importable);
    if (rejected.length > 0) {
      throw new Error(
        `Ecobase CSV bundle import failed: non-importable files were selected: ${rejected
          .map((file) => `${file.name} (${file.detectedShape})`)
          .join(', ')}.`,
      );
    }

    const mismatched = analysis.files.filter((file) => {
      const target = targetForCsvShape(file.detectedShape);
      return (
        !target ||
        target.adapterName !== params.adapterName ||
        target.sourceType !== adapter.metadata.sourceType ||
        !adapter.metadata.supportedDomains.includes(target.domain)
      );
    });
    if (mismatched.length > 0) {
      throw new Error(
        `Ecobase CSV bundle import failed: files do not match adapter "${params.adapterName}": ${mismatched
          .map((file) => `${file.name} (${file.detectedShape})`)
          .join(', ')}.`,
      );
    }

    const analyzedByName = new Map(analysis.files.map((file) => [file.name, file]));
    const latestSuccessfulRun = await importRunRepo.findOne({
      filter: {
        sourceConnectionId: params.sourceConnectionId,
        adapterName: adapter.metadata.name,
        sourceIdentifier: params.sourceIdentifier ?? 'manual-csv-bundle',
        status: 'success',
      },
      sort: ['-startedAt'],
    });
    const previousFiles = new Set(latestCsvBundleFiles(latestSuccessfulRun).map(csvBundleFileKey));
    const changedFiles = params.files.filter((file) => {
      const analyzed = analyzedByName.get(file.name);
      return !analyzed || !previousFiles.has(csvBundleFileKey(analyzed));
    });
    const manifestFiles = analysis.files.map((file) => ({
      name: file.name,
      checksum: file.checksum,
      detectedShape: file.detectedShape,
      rowCount: file.rowCount,
      adapterName: file.adapterName,
      sourceType: file.sourceType,
      domain: file.domain,
      changed: changedFiles.some((changedFile) => changedFile.name === file.name),
    }));
    const csvBundle = {
      bundleHash: bundleHash(manifestFiles),
      files: manifestFiles,
    };

    const sourceIdentifier = params.sourceIdentifier ?? 'manual-csv-bundle';
    const sourceVersion = params.sourceVersion ?? new Date().toISOString().slice(0, 10);
    if (changedFiles.length === 0) {
      return this.createSkippedImportRun(importRunRepo, {
        sourceConnectionId: params.sourceConnectionId,
        adapterName: adapter.metadata.name,
        sourceIdentifier,
        sourceVersion,
        idempotencyKey: `${
          params.sourceConnectionId
        }:${sourceIdentifier}:${sourceVersion}:csv-bundle-skipped:${randomUUID()}`,
        startedAt: new Date(),
        errorMessage: 'Ecobase CSV bundle skipped: uploaded files are unchanged since the latest successful import.',
        summary: { csvBundle },
      });
    }

    const expectedRowCounts = Object.fromEntries(
      changedFiles.map((file) => [file.name, analyzedByName.get(file.name)?.rowCount ?? file.expectedRowCount]),
    );
    const importParams: RunAdapterImportParams = {
      sourceConnectionId: params.sourceConnectionId,
      adapterName: adapter.metadata.name,
      sourceIdentifier,
      sourceVersion,
      preserveAuditRun: true,
      runtimeConfig: {
        files: changedFiles.map((file) => ({
          ...file,
          expectedRowCount: analyzedByName.get(file.name)?.rowCount ?? file.expectedRowCount,
        })),
        expectedRowCounts,
        defaultCompany: params.defaultCompany,
        uploadManifest: csvBundle,
      },
      summary: { csvBundle },
    };

    const changedRowCount = changedFiles.reduce(
      (sum, file) => sum + (analyzedByName.get(file.name)?.rowCount ?? file.expectedRowCount ?? 0),
      0,
    );
    if (changedRowCount > CSV_BUNDLE_SYNC_ROW_LIMIT) {
      return this.queueAdapterImport(importParams);
    }

    return this.runAdapterImport(importParams);
  }

  private async queueAdapterImport(params: RunAdapterImportParams) {
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnection = await sourceConnectionRepo.findOne({ filterByTk: params.sourceConnectionId });

    if (!sourceConnection) {
      throw new Error(`Ecobase import failed: source connection "${params.sourceConnectionId}" was not found.`);
    }

    const adapter = this.registry.get(params.adapterName);
    validateSourceConnectionForAdapter(sourceConnection, adapter);

    const startedAt = new Date();
    const sourceIdentifier = params.sourceIdentifier ?? adapter.metadata.name;
    const sourceVersion = params.sourceVersion ?? startedAt.toISOString();
    const baseIdempotencyKey =
      params.idempotencyKey ?? `${params.sourceConnectionId}:${sourceIdentifier}:${sourceVersion}`;
    const existingRun = await importRunRepo.findOne({ filter: { idempotencyKey: baseIdempotencyKey } });
    const idempotencyKey = existingRun ? `${baseIdempotencyKey}:audit:${randomUUID()}` : baseIdempotencyKey;
    const queuedRun = await importRunRepo.create({
      values: {
        sourceConnectionId: params.sourceConnectionId,
        adapterName: adapter.metadata.name,
        sourceIdentifier,
        sourceVersion,
        idempotencyKey,
        startedAt,
        status: 'pending',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
        summary: params.summary ?? {},
      },
    });
    const queuedRunId = getString(queuedRun, 'id');
    if (!queuedRunId) {
      throw new Error('Ecobase import failed: queued import run was created without an id.');
    }

    setImmediate(() => {
      void this.runAdapterImport({
        ...params,
        sourceIdentifier,
        sourceVersion,
        idempotencyKey,
        queuedImportRun: { id: queuedRunId, startedAt, idempotencyKey },
      }).catch(async (error) => {
        await importRunRepo.update({
          filterByTk: queuedRunId,
          values: {
            finishedAt: new Date(),
            status: 'failed',
            errorCount: 1,
            errorMessage:
              error instanceof Error ? error.message : 'Ecobase import failed: queued import threw a non-Error value.',
          },
        });
      });
    });

    return toPlainRecord(queuedRun);
  }

  async runMedallionPipeline(params: RunMedallionPipelineParams = {}): Promise<RunMedallionPipelineResult> {
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const sourceConnections = await sourceConnectionRepo.find({
      filter: { active: true, ...(params.sourceConnectionId ? { id: params.sourceConnectionId } : {}) },
      sort: ['name'],
    });
    const imports: Record<string, unknown>[] = [];
    const failures: string[] = [];
    const sourceVersion = params.sourceVersion ?? new Date().toISOString().slice(0, 10);

    for (const sourceConnection of sourceConnections) {
      const sourceConnectionId = getString(sourceConnection, 'id');
      const adapterName = defaultAdapterNameForSourceConnection(sourceConnection);
      if (!sourceConnectionId || !adapterName) {
        failures.push(`Ecobase medallion pipeline skipped a source connection with unsupported sourceType.`);
        continue;
      }
      try {
        imports.push(
          await this.runAdapterImport({
            sourceConnectionId,
            adapterName,
            sourceIdentifier: adapterName === 'sellerboard-api' ? 'sellerboard-scheduled' : 'medallion-pipeline',
            sourceVersion,
            preserveAuditRun: true,
          }),
        );
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : 'Ecobase medallion pipeline failed with a non-Error value.',
        );
      }
    }

    const normalization = await new EcobaseMedallionNormalizationService(this.db).normalizePending({
      sourceConnectionId: params.sourceConnectionId,
    });
    const goldRefreshRequired = sourceConnections.some(shouldRefreshGoldAfterImport);
    return { imports, normalization, failures, goldRefreshRequired };
  }

  async runAdapterImport(params: RunAdapterImportParams) {
    if (!params.sourceConnectionId) {
      throw new Error('Ecobase import failed: sourceConnectionId is required.');
    }

    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnection = await sourceConnectionRepo.findOne({ filterByTk: params.sourceConnectionId });

    if (!sourceConnection) {
      throw new Error(`Ecobase import failed: source connection "${params.sourceConnectionId}" was not found.`);
    }

    const adapter = this.registry.get(params.adapterName);
    validateSourceConnectionForAdapter(sourceConnection, adapter);

    const adapterConfig = mergeConfig(sourceConnection, params.runtimeConfig);
    const catalogMutationMode =
      adapter.metadata.name === 'sellerboard-api'
        ? getString(adapterConfig, 'catalogMutationMode') ?? 'refresh'
        : undefined;
    if (catalogMutationMode && !['rebuild', 'refresh'].includes(catalogMutationMode)) {
      throw new Error(
        `Ecobase import failed: catalogMutationMode must be rebuild or refresh, received "${catalogMutationMode}".`,
      );
    }
    if (catalogMutationMode) adapterConfig.catalogMutationMode = catalogMutationMode;
    const companyId = getString(sourceConnection, 'companyId');
    if (companyId && !getString(adapterConfig, 'defaultCompany')) {
      const company = await this.db
        .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
        .findOne({ filterByTk: companyId });
      const companyName = getString(company, 'name');
      if (!companyName) {
        throw new Error(
          `Ecobase import failed: source connection "${params.sourceConnectionId}" references missing company "${companyId}".`,
        );
      }
      adapterConfig.defaultCompany = companyName;
    }

    await this.cleanupExpiredBronzeRecords(params.startedAt ?? new Date());
    const startedAt = params.queuedImportRun?.startedAt ?? params.startedAt ?? new Date();
    const sourceIdentifier = params.sourceIdentifier ?? adapter.metadata.name;
    const sourceVersion = params.sourceVersion ?? startedAt.toISOString();
    const baseIdempotencyKey =
      params.idempotencyKey ?? `${params.sourceConnectionId}:${sourceIdentifier}:${sourceVersion}`;
    const existingRun = params.queuedImportRun
      ? null
      : await importRunRepo.findOne({ filter: { idempotencyKey: baseIdempotencyKey } });

    if (params.skipIfNoNewerData && existingRun && getString(existingRun, 'status') === 'success') {
      return this.createSkippedImportRun(importRunRepo, {
        sourceConnectionId: params.sourceConnectionId,
        adapterName: adapter.metadata.name,
        sourceIdentifier,
        sourceVersion,
        idempotencyKey: `${baseIdempotencyKey}:skipped:${randomUUID()}`,
        startedAt,
      });
    }

    if (existingRun && !params.preserveAuditRun) {
      return toPlainRecord(existingRun);
    }

    const idempotencyKey =
      params.queuedImportRun?.idempotencyKey ??
      (existingRun ? `${baseIdempotencyKey}:audit:${randomUUID()}` : baseIdempotencyKey);

    const pendingRun = params.queuedImportRun
      ? await importRunRepo.findOne({ filterByTk: params.queuedImportRun.id })
      : await importRunRepo.create({
          values: {
            sourceConnectionId: params.sourceConnectionId,
            adapterName: adapter.metadata.name,
            sourceIdentifier,
            sourceVersion,
            idempotencyKey,
            startedAt,
            status: 'pending',
            rowCount: 0,
            normalizedCount: 0,
            warningCount: 0,
            errorCount: 0,
          },
        });
    const importRunId = params.queuedImportRun?.id ?? getString(pendingRun, 'id');

    if (!importRunId) {
      throw new Error('Ecobase import failed: import run was created without an id.');
    }
    if (catalogMutationMode) {
      await importRunRepo.update({
        filterByTk: importRunId,
        values: {
          summary: {
            ...toPlainRecord(toPlainRecord(pendingRun).summary),
            ...(params.summary ?? {}),
            catalogMutationMode,
          },
        },
      });
    }

    const bronzeService = new EcobaseBronzeImportService(this.db);
    const bronzeContext = {
      importRunId,
      sourceConnectionId: params.sourceConnectionId,
      sourceIdentifier,
      sourceVersion,
      adapter,
    };
    const stream = await this.runAdapterStream({
      importRunId,
      bronzeService,
      bronzeContext,
      adapter,
      adapterConfig,
      adapterInput: {
        sourceConnectionId: params.sourceConnectionId,
        sourceIdentifier,
        sourceVersion,
        idempotencyKey,
        config: adapterConfig,
        secretRef: getString(sourceConnection, 'secretRef'),
      },
      skipExistingNormalizedKinds: new Set(params.skipExistingNormalizedKinds ?? []),
    });
    const {
      rowCount,
      normalizedCount,
      warningCount,
      errorMessage,
      firstErrorIssueMessage,
      finalStatusOverride,
      accountabilityTouched,
    } = stream;
    let { errorCount, statusMessage } = stream;
    const fileSummaries = stream.fileSummaries;
    let medallionNormalization: NormalizePendingResult | null = null;
    let familyReconciliation: unknown = null;

    if (!errorMessage && rowCount > 0) {
      try {
        medallionNormalization = await new EcobaseMedallionNormalizationService(this.db).normalizePending({
          sourceConnectionId: params.sourceConnectionId,
        });
        errorCount += medallionNormalization.failed;
      } catch (error) {
        statusMessage =
          error instanceof Error
            ? `Ecobase import completed with a medallion normalization warning: ${error.message}`
            : 'Ecobase import completed with a medallion normalization warning: normalization threw a non-Error value.';
        errorCount += 1;
      }
    }

    if (!errorMessage && normalizedCount > 0 && adapter.metadata.name !== 'google-sheets-migration-csv') {
      try {
        const preservesProtectedCatalog = catalogMutationMode === 'refresh';
        if (preservesProtectedCatalog && stream.protectedCatalog) {
          const currentCatalog = await new EcobaseProtectedCatalogBoundary(this.db).inspect();
          if (currentCatalog.fingerprint !== stream.protectedCatalog.fingerprint) {
            throw new Error(
              'Ecobase protected catalog refresh failed: catalog fingerprint changed during normalization.',
            );
          }
        }
        familyReconciliation = await new EcobaseCompanyProductFamilyService(this.db).reconcileAllFamilies(companyId, {
          preserveCatalog: preservesProtectedCatalog,
        });
        if (preservesProtectedCatalog && stream.protectedCatalog) {
          const currentCatalog = await new EcobaseProtectedCatalogBoundary(this.db).inspect();
          if (currentCatalog.fingerprint !== stream.protectedCatalog.fingerprint) {
            throw new Error(
              'Ecobase protected catalog refresh failed: catalog fingerprint changed during reconciliation.',
            );
          }
        }
        await new EcobasePlanningProductService(this.db).syncFromSilverCompanyProducts();
        if (accountabilityTouched) {
          await new EcobaseAccountabilityService(this.db).evaluateAccountability({
            sourceConnectionId: params.sourceConnectionId,
            evaluationDate: sourceVersion.slice(0, 10),
          });
        }
      } catch (error) {
        statusMessage =
          error instanceof Error
            ? `Ecobase import completed with a post-import reconciliation warning: ${error.message}`
            : 'Ecobase import completed with a post-import reconciliation warning: reconciliation threw a non-Error value.';
        errorCount += 1;
      }
    }

    const goldRefreshRequired =
      !errorMessage &&
      shouldRefreshGoldAfterImport(sourceConnection) &&
      (normalizedCount > 0 || (medallionNormalization?.normalized ?? 0) > 0);

    const finishedAt = new Date();
    const status = this.getFinalStatus(errorMessage, errorCount, normalizedCount, finalStatusOverride);
    await importRunRepo.update({
      filterByTk: importRunId,
      values: {
        finishedAt,
        status,
        rowCount,
        normalizedCount,
        warningCount,
        errorCount,
        errorMessage: errorMessage ?? statusMessage ?? (normalizedCount > 0 ? firstErrorIssueMessage : null),
        summary: {
          files: fileSummaries,
          medallionNormalization,
          familyReconciliation,
          goldRefreshRequired,
          migration: {
            profileVersion: FOUR_COMPANY_MIGRATION_PROFILE.profileVersion,
            asOfDate: sourceVersion.slice(0, 10),
            ...stream.migrationSummary,
          },
          ...(params.summary ?? {}),
          ...(catalogMutationMode ? { catalogMutationMode } : {}),
          ...(stream.protectedCatalog ? { protectedCatalog: stream.protectedCatalog } : {}),
        },
      },
    });

    const completedRun = await importRunRepo.findOne({ filterByTk: importRunId });
    return toPlainRecord(completedRun ?? pendingRun);
  }

  private async runAdapterStream(params: AdapterImportStreamParams): Promise<AdapterImportStreamResult> {
    const result: AdapterImportStreamResult = {
      rowCount: 0,
      normalizedCount: 0,
      warningCount: 0,
      errorCount: 0,
      errorMessage: null,
      statusMessage: null,
      firstErrorIssueMessage: null,
      finalStatusOverride: null,
      fileSummaries: {},
      accountabilityTouched: false,
      migrationSummary: {
        acceptedCount: 0,
        discardedCount: 0,
        reviewCount: 0,
        droppedFieldCount: 0,
        reasons: {},
        bySourceGroup: {},
      },
    };

    try {
      let sourceItems: AsyncIterable<AdapterStreamItem> | AdapterStreamItem[] = params.adapter.import(
        params.adapterInput,
      );
      if (
        params.adapter.metadata.name === 'sellerboard-api' &&
        getString(params.adapterConfig, 'catalogMutationMode') !== 'rebuild'
      ) {
        const boundaryService = new EcobaseProtectedCatalogBoundary(this.db);
        result.protectedCatalog = await boundaryService.inspect();
        const preflightedItems: AdapterStreamItem[] = [];
        for await (const sourceItem of sourceItems) {
          if (sourceItem.type !== 'status') {
            const boundary = applySafeImportBoundary(
              { adapter: params.adapter, defaultCompany: getString(params.adapterConfig, 'defaultCompany') },
              sourceItem,
            );
            if (boundary.disposition !== 'discard' && boundary.item.type === 'record') {
              await boundaryService.assertExistingSellerboardIdentity(boundary.item.payload);
            }
          }
          preflightedItems.push(sourceItem);
        }
        sourceItems = preflightedItems;
      }
      await params.bronzeService.createSourceFiles(params.bronzeContext, inlineCsvFiles(params.adapterConfig));
      for await (const sourceItem of sourceItems) {
        if (sourceItem.type === 'status') {
          result.finalStatusOverride = sourceItem.status;
          if (sourceItem.status === 'blocked' || sourceItem.status === 'failed') {
            result.errorMessage = sourceItem.message;
          } else {
            result.statusMessage = sourceItem.message;
          }
          continue;
        }
        const sourceGroup = getSourceFileName(
          sourceItem.type === 'record' ? sourceItem.sourceKey : sourceItem.issue.sourceKey,
        );
        const aggregateDiscardCount =
          sourceItem.type === 'rowIssue' && sourceItem.issue.severity === 'warning'
            ? getNumber(sourceItem.issue.payload, 'discardedCount')
            : undefined;
        if (sourceItem.type === 'rowIssue' && aggregateDiscardCount && aggregateDiscardCount > 0) {
          const reason = sourceItem.issue.code;
          const group = sourceGroup ?? '(unknown source group)';
          const groupSummary = result.migrationSummary.bySourceGroup[group] ?? {
            acceptedCount: 0,
            discardedCount: 0,
            reviewCount: 0,
            droppedFieldCount: 0,
            reasons: {},
          };
          result.migrationSummary.discardedCount += aggregateDiscardCount;
          result.migrationSummary.reasons[reason] =
            (result.migrationSummary.reasons[reason] ?? 0) + aggregateDiscardCount;
          groupSummary.discardedCount += aggregateDiscardCount;
          groupSummary.reasons[reason] = (groupSummary.reasons[reason] ?? 0) + aggregateDiscardCount;
          result.migrationSummary.bySourceGroup[group] = groupSummary;
          result.warningCount += 1;
          updateFileSummary(result.fileSummaries, group, { warningCount: 1 });
          continue;
        }
        const boundary = applySafeImportBoundary(
          { adapter: params.adapter, defaultCompany: getString(params.adapterConfig, 'defaultCompany') },
          sourceItem,
        );
        updateMigrationSummary(result.migrationSummary, sourceGroup, boundary);
        if (boundary.disposition === 'discard') {
          const rowNumber = sourceItem.type === 'record' ? sourceItem.rowNumber : sourceItem.issue.rowNumber;
          if (rowNumber > 0) {
            result.rowCount += 1;
            updateFileSummary(result.fileSummaries, sourceGroup, { rowCount: 1 });
          }
          if (boundary.reasonCode === 'unsupported_projection_dataset') {
            result.errorCount += 1;
            result.errorMessage = `Ecobase import failed: adapter "${params.adapter.metadata.name}" emitted a source row without an approved safe projection.`;
          }
          continue;
        }
        const item = boundary.item;
        const bronzeRecord = await params.bronzeService.createSourceRecord(params.bronzeContext, item, {
          sourceDataset: boundary.sourceDataset,
        });
        if (item.type === 'record') {
          const records = Array.isArray(item.record) ? item.record : [item.record];
          const fileName = getSourceFileName(item.sourceKey);
          result.rowCount += 1;
          const normalized = await this.upsertNormalizedRecords(
            records,
            params.importRunId,
            params.skipExistingNormalizedKinds,
          );
          result.normalizedCount += normalized.normalizedCount;
          updateFileSummary(result.fileSummaries, fileName, {
            rowCount: 1,
            normalizedCount: normalized.normalizedCount,
          });
          result.accountabilityTouched = result.accountabilityTouched || normalized.accountabilityTouched;
          result.warningCount += normalized.warnings.length;
          updateFileSummary(result.fileSummaries, fileName, {
            warningCount: normalized.warnings.length,
            sampleMappedRecord: normalized.sample ?? summarizeRecord(records[0]),
          });
          if (normalized.warnings.length > 0) {
            await this.markBronzeRecordWarning(bronzeRecord, normalized.warnings);
          }
        } else if (item.type === 'rowIssue') {
          const fileName = getSourceFileName(item.issue.sourceKey);
          if (item.issue.rowNumber > 0) {
            result.rowCount += 1;
            updateFileSummary(result.fileSummaries, fileName, { rowCount: 1 });
          }
          if (item.issue.severity === 'warning') {
            result.warningCount += 1;
            updateFileSummary(result.fileSummaries, fileName, { warningCount: 1 });
          } else {
            result.errorCount += 1;
            result.firstErrorIssueMessage = result.firstErrorIssueMessage ?? item.issue.message;
          }
        }
      }
    } catch (error) {
      result.errorMessage =
        error instanceof Error ? error.message : 'Ecobase import failed: adapter threw a non-Error value.';
      result.errorCount += 1;
    }

    return result;
  }

  async listSourceStatuses(): Promise<SourceStatusView[]> {
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const companyRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnections = await sourceConnectionRepo.find({ sort: ['name'] });
    const warningService = new EcobaseDataWarningService(this.db);

    return Promise.all(
      sourceConnections.map(async (sourceConnection) => {
        const sourceConnectionId = getString(sourceConnection, 'id');
        if (!sourceConnectionId) {
          throw new Error('Ecobase status readback failed: source connection record is missing id.');
        }
        const latestRun = await importRunRepo.findOne({
          filter: { sourceConnectionId },
          sort: ['-startedAt'],
        });
        const warningAssessment = await warningService.assessSourceConnection(sourceConnectionId);
        const companyId = getString(sourceConnection, 'companyId') ?? null;
        const company = companyId ? await companyRepo.findOne({ filterByTk: companyId }) : null;

        return {
          sourceConnectionId,
          connectionName: getString(sourceConnection, 'name') ?? '(unnamed source)',
          companyId,
          companyName: getString(company, 'name') ?? null,
          sourceType: getString(sourceConnection, 'sourceType') ?? '(unknown source type)',
          domain: getString(sourceConnection, 'domain') ?? '(unknown domain)',
          active: getBoolean(sourceConnection, 'active', true),
          required: warningAssessment.required,
          freshnessSlaMinutes: warningAssessment.freshnessSlaMinutes,
          latestImportRunId: getString(latestRun, 'id') ?? null,
          latestRunStatus: getString(latestRun, 'status') ?? null,
          latestSuccessfulRunAt: warningAssessment.latestSuccessfulRunAt,
          rowCount: getNumber(latestRun, 'rowCount'),
          normalizedCount: getNumber(latestRun, 'normalizedCount'),
          warningCount: warningAssessment.warnings.length,
          latestRunWarningCount: getNumber(latestRun, 'warningCount'),
          errorCount: getNumber(latestRun, 'errorCount'),
          lastRunAt: getDateString(latestRun, 'finishedAt') ?? getDateString(latestRun, 'startedAt'),
          latestWarning: warningAssessment.latestWarning,
          warnings: warningAssessment.warnings,
        };
      }),
    );
  }

  async runScheduledSellerboardImports(params: RunScheduledSellerboardImportsParams = {}) {
    const now = params.now ? new Date(params.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error(`Ecobase scheduled Sellerboard import failed: now "${params.now}" is not a valid date.`);
    }
    const today = now.toISOString().slice(0, 10);
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnections = await sourceConnectionRepo.find({
      filter: params.sourceConnectionId ? { id: params.sourceConnectionId } : { sourceType: 'sellerboard' },
      sort: ['name'],
    });
    const results = [] as Array<Record<string, unknown>>;

    for (const sourceConnection of sourceConnections) {
      const sourceConnectionId = getString(sourceConnection, 'id');
      if (!sourceConnectionId) {
        throw new Error('Ecobase scheduled Sellerboard import failed: source connection record is missing id.');
      }
      if (getString(sourceConnection, 'sourceType') !== 'sellerboard') {
        results.push({ sourceConnectionId, status: 'ignored', reason: 'source_type_not_sellerboard' });
        continue;
      }
      if (!getBoolean(sourceConnection, 'active', true)) {
        results.push({ sourceConnectionId, status: 'ignored', reason: 'source_inactive' });
        continue;
      }
      const config = getConfig(sourceConnection);
      const schedule = this.readSellerboardSchedule(config);
      if (!schedule.enabled) {
        results.push({ sourceConnectionId, status: 'ignored', reason: 'schedule_disabled' });
        continue;
      }
      if (!schedule.refreshIntervalMinutes && minuteOfDay < schedule.dailyMinuteOfDay) {
        results.push({
          sourceConnectionId,
          status: 'not_due',
          dailyRefreshTime: schedule.dailyRefreshTime,
          now: now.toISOString(),
        });
        continue;
      }

      const latestScheduledRun = schedule.refreshIntervalMinutes
        ? await importRunRepo.findOne({
            filter: { sourceConnectionId, sourceIdentifier: 'sellerboard-scheduled' },
            sort: ['-startedAt'],
          })
        : null;
      const latestScheduledStatus = getString(latestScheduledRun, 'status');
      const latestScheduledStartedAt = getDateString(latestScheduledRun, 'startedAt');
      if (latestScheduledStartedAt && schedule.refreshIntervalMinutes) {
        if (
          (latestScheduledStatus === 'success' ||
            latestScheduledStatus === 'stale' ||
            latestScheduledStatus === 'skipped') &&
          !this.retryDue(now, latestScheduledStartedAt, schedule.refreshIntervalMinutes)
        ) {
          results.push({
            sourceConnectionId,
            status: 'not_due',
            refreshIntervalMinutes: schedule.refreshIntervalMinutes,
            latestRunStatus: latestScheduledStatus,
            latestRunStartedAt: latestScheduledStartedAt,
            now: now.toISOString(),
          });
          continue;
        }
        if (
          latestScheduledStatus !== 'success' &&
          latestScheduledStatus !== 'stale' &&
          latestScheduledStatus !== 'skipped' &&
          !this.retryDue(now, latestScheduledStartedAt, schedule.retryIntervalMinutes)
        ) {
          results.push({
            sourceConnectionId,
            status: 'waiting_retry',
            retryIntervalMinutes: schedule.retryIntervalMinutes,
            latestRunStatus: latestScheduledStatus,
            latestRunStartedAt: latestScheduledStartedAt,
          });
          continue;
        }
      }

      const sourceVersion = schedule.refreshIntervalMinutes ? now.toISOString() : today;
      const latestForVersion = await importRunRepo.findOne({
        filter: { sourceConnectionId, sourceIdentifier: 'sellerboard-scheduled', sourceVersion },
        sort: ['-startedAt'],
      });
      const latestStatus = getString(latestForVersion, 'status');
      const latestStartedAt = getDateString(latestForVersion, 'startedAt');
      if (
        latestStartedAt &&
        latestStatus !== 'success' &&
        !this.retryDue(now, latestStartedAt, schedule.retryIntervalMinutes)
      ) {
        results.push({
          sourceConnectionId,
          status: 'waiting_retry',
          sourceVersion,
          retryIntervalMinutes: schedule.retryIntervalMinutes,
          latestRunStatus: latestStatus,
          latestRunStartedAt: latestStartedAt,
        });
        continue;
      }

      const run = await this.runAdapterImport({
        sourceConnectionId,
        adapterName: 'sellerboard-api',
        sourceIdentifier: 'sellerboard-scheduled',
        sourceVersion,
        idempotencyKey: `${sourceConnectionId}:sellerboard-scheduled:${sourceVersion}`,
        preserveAuditRun: true,
        startedAt: now,
        skipIfNoNewerData: !schedule.refreshIntervalMinutes,
        skipExistingNormalizedKinds: ['listing_daily_fact', 'traffic_snapshot'],
      });
      results.push({ sourceConnectionId, status: getString(run, 'status') ?? 'unknown', run });
    }

    return { now: now.toISOString(), results };
  }

  private readSellerboardSchedule(config: Record<string, unknown>) {
    const schedule = isRecord(config.schedule) ? config.schedule : {};
    const enabled = schedule.enabled !== false && config.scheduleEnabled !== false;
    const dailyRefreshTime =
      (typeof schedule.dailyRefreshTime === 'string' && schedule.dailyRefreshTime) ||
      (typeof config.dailyRefreshTime === 'string' && config.dailyRefreshTime) ||
      '00:00';
    const match = dailyRefreshTime.match(/^(\d{2}):(\d{2})$/);
    if (!match) {
      throw new Error(
        `Ecobase scheduled Sellerboard import failed: dailyRefreshTime "${dailyRefreshTime}" must use HH:mm.`,
      );
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
      throw new Error(
        `Ecobase scheduled Sellerboard import failed: dailyRefreshTime "${dailyRefreshTime}" is outside 00:00-23:59.`,
      );
    }
    const refreshIntervalMinutes =
      typeof schedule.refreshIntervalMinutes === 'number'
        ? schedule.refreshIntervalMinutes
        : typeof config.refreshIntervalMinutes === 'number'
          ? config.refreshIntervalMinutes
          : undefined;
    if (
      refreshIntervalMinutes !== undefined &&
      (!Number.isFinite(refreshIntervalMinutes) || refreshIntervalMinutes <= 0)
    ) {
      throw new Error('Ecobase scheduled Sellerboard import failed: refreshIntervalMinutes must be a positive number.');
    }
    const retryIntervalMinutes =
      typeof schedule.retryIntervalMinutes === 'number'
        ? schedule.retryIntervalMinutes
        : typeof config.retryIntervalMinutes === 'number'
          ? config.retryIntervalMinutes
          : 60;
    if (!Number.isFinite(retryIntervalMinutes) || retryIntervalMinutes <= 0) {
      throw new Error('Ecobase scheduled Sellerboard import failed: retryIntervalMinutes must be a positive number.');
    }
    return {
      enabled,
      dailyRefreshTime,
      dailyMinuteOfDay: hours * 60 + minutes,
      refreshIntervalMinutes,
      retryIntervalMinutes,
    };
  }

  private retryDue(now: Date, latestStartedAt: string, retryIntervalMinutes: number) {
    const previous = new Date(latestStartedAt);
    if (Number.isNaN(previous.getTime())) {
      return true;
    }
    return now.getTime() - previous.getTime() >= retryIntervalMinutes * 60 * 1000;
  }

  private validateCsvBundleFiles(files: CsvSourceFile[]) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('Ecobase CSV bundle import failed: at least one CSV file is required.');
    }
    if (files.length > 20) {
      throw new Error('Ecobase CSV bundle import failed: at most 20 CSV files can be uploaded at once.');
    }
    const names = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      if (!file.name || file.name.trim().length === 0) {
        throw new Error('Ecobase CSV bundle import failed: every uploaded file must have a name.');
      }
      if (names.has(file.name)) {
        throw new Error(`Ecobase CSV bundle import failed: duplicate file name "${file.name}".`);
      }
      names.add(file.name);
      if (typeof file.content !== 'string' || file.content.length === 0) {
        throw new Error(`Ecobase CSV bundle import failed: file "${file.name}" is empty.`);
      }
      totalBytes += Buffer.byteLength(file.content, 'utf8');
    }
    if (totalBytes > 25 * 1024 * 1024) {
      throw new Error('Ecobase CSV bundle import failed: upload size exceeds the 25 MB limit.');
    }
  }

  private async createSkippedImportRun(
    importRunRepo: EcobaseRepository,
    values: {
      sourceConnectionId: string;
      adapterName: string;
      sourceIdentifier: string;
      sourceVersion: string;
      idempotencyKey: string;
      startedAt: Date;
      errorMessage?: string;
      summary?: Record<string, unknown>;
    },
  ) {
    const finishedAt = new Date();
    const skippedRun = await importRunRepo.create({
      values: {
        id: randomUUID(),
        ...values,
        finishedAt,
        status: 'skipped',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 1,
        errorCount: 0,
        errorMessage:
          values.errorMessage ??
          'Ecobase daily snapshot skipped: no newer source data since the last successful import.',
        summary: values.summary,
      },
    });
    return toPlainRecord(skippedRun);
  }

  private async markBronzeRecordWarning(
    bronzeRecord: unknown,
    warnings: Array<{ code: string; message: string; payload?: Record<string, unknown> }>,
  ) {
    const bronzeRecordId = getString(bronzeRecord, 'id');
    if (!bronzeRecordId) return;
    await this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).update({
      filterByTk: bronzeRecordId,
      values: {
        normalizedError: warnings.map((warning) => warning.message).join(' | '),
        issueSeverity: 'warning',
        issueCode: warnings[0]?.code,
      },
    });
  }

  private async upsertNormalizedRecords(
    records: NormalizedRecord[],
    importRunId: string,
    skipExistingNormalizedKinds: Set<string>,
  ) {
    let normalizedCount = 0;
    let sample: Record<string, unknown> | undefined;
    let accountabilityTouched = false;

    for (const record of records) {
      validateNormalizedRecord(record);
      if (BRONZE_ONLY_RECORD_KINDS.has(record.kind)) {
        normalizedCount += 1;
        sample = sample ?? summarizeRecord(record);
        continue;
      }

      accountabilityTouched = accountabilityTouched || ACCOUNTABILITY_RECORD_KINDS.has(record.kind);
      const target = normalizedRecordTarget(record, importRunId);
      const { collectionName, values } = target;
      if (!collectionName) {
        throw new Error(
          `Ecobase import failed: normalized record kind "${record.kind}" is not mapped to a collection.`,
        );
      }
      const naturalKey = getString(values, 'naturalKey');
      if (!naturalKey) {
        throw new Error(`Ecobase import failed: normalized record kind "${record.kind}" is missing naturalKey.`);
      }
      const repository = this.db.getRepository(collectionName);
      const existing = await repository.findOne({ filter: { naturalKey } });
      if (existing) {
        if (skipExistingNormalizedKinds.has(record.kind)) {
          continue;
        }
        const existingId = toPlainRecord(existing).id;
        if (typeof existingId !== 'string' && typeof existingId !== 'number') {
          throw new Error(`Ecobase import failed: existing normalized record "${naturalKey}" is missing id.`);
        }
        await repository.update({ filterByTk: existingId, values });
      } else {
        await repository.create({ values: { ...target.createValues, ...values } });
      }
      normalizedCount += 1;
      sample = sample ?? summarizeRecord(record);
    }

    return { warnings: [], normalizedCount, sample, accountabilityTouched };
  }

  private getFinalStatus(
    errorMessage: string | null,
    errorCount: number,
    normalizedCount: number,
    finalStatusOverride: string | null,
  ) {
    if (finalStatusOverride === 'blocked') {
      return 'blocked';
    }
    if (errorMessage) {
      return 'failed';
    }
    if (errorCount > 0 && normalizedCount > 0) {
      return 'partial';
    }
    if (errorCount > 0) {
      return 'failed';
    }
    return finalStatusOverride ?? 'success';
  }
}
