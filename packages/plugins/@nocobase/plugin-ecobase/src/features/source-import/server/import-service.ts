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
import { bronzePayloadHash, EcobaseBronzeImportService } from './bronze-import-service';
import { EcobaseClickupOrderStatusService, type ClickupOrderStatusImportResult } from './clickup-order-status-service';
import { EcobaseDataWarningService } from '../../../server/services/data-warning-service';
import type { EcobaseDataWarning } from '../../../server/services/data-warning-service';
import { EcobaseInventoryPlanningService } from '../../inventory-planning/server/inventory-planning-service';
import { EcobaseManagementKpiFactsService } from '../../daily-operations-brief/server/management-kpi-facts-service';
import { EcobaseMedallionNormalizationService } from '../../semantic-model/server/medallion-normalization-service';
import type { NormalizePendingResult } from '../../semantic-model/server/medallion-normalization-service';
import { EcobaseOrderPlanningService } from '../../order-planning/server/order-planning-service';
import { EcobasePlanningProductService } from '../../inventory-planning/server/planning-product-service';
import { EcobaseSupplierManagementService } from '../../supplier-management/server/supplier-management-service';
import {
  EcobaseSupplierOrderService,
  validateSupplierLeadTimeDays,
} from '../../supplier-management/server/supplier-order-service';

type Filter = Record<string, unknown>;

type RepositoryFindParams = {
  filter?: Filter;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
};

type RepositoryCreateParams = { values: Record<string, unknown> };
type RepositoryUpdateParams = { filterByTk?: string | number | null; filter?: Filter; values: Record<string, unknown> };

type ImportFileSummary = {
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  sampleMappedRecord?: Record<string, unknown>;
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
  supplierOrderTouched: boolean;
  accountabilityTouched: boolean;
};

type AdapterImportStreamParams = {
  importRunId: string;
  supplierOrderService: EcobaseSupplierOrderService;
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
  skipGoldRefresh?: boolean;
  goldCalculationDate?: string;
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
  dryRun?: boolean;
  importedAt?: string;
  snapshotDate?: string;
  skipGoldRefresh?: boolean;
  forceReconcile?: boolean;
  overrideOperatorStatus?: boolean;
}

export interface RunScheduledSellerboardImportsParams {
  now?: string;
  sourceConnectionId?: string;
}

export interface RunMedallionPipelineParams {
  sourceConnectionId?: string;
  sourceVersion?: string;
  goldCalculationDate?: string;
}

export interface AutomaticGoldRefreshResult {
  calculationDate: string;
  inventory: Record<string, unknown>;
  orders: { rowCount: number; lastRefreshedAt: string | null };
  suppliers: { rowCount: number; summary: Record<string, unknown> };
  managementKpiFacts: { factCount: number; metrics: Record<string, number>; skippedMetrics: string[] };
}

export interface RunMedallionPipelineResult {
  imports: Record<string, unknown>[];
  normalization: NormalizePendingResult;
  failures: string[];
  goldRefresh: AutomaticGoldRefreshResult | null;
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
  const repo = params.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords);
  for (const file of params.files) {
    const parsed = parseCsv(file.content);
    for (const [index, payload] of parsed.rows.entries()) {
      const rowNumber = index + 2;
      const taskId = getString(payload, 'Task ID') ?? `row-${rowNumber}`;
      const sourceRecordKey = `${file.name}:${taskId}`;
      const rowHash = bronzePayloadHash(payload);
      const existing = await repo.findOne({
        filter: {
          sourceConnectionId: params.sourceConnectionId,
          sourceDataset: file.name,
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
          sourceDataset: file.name,
          sourceRecordKey,
          sourceKey: taskId,
          rowNumber,
          observedAt: params.sourceVersion,
          payload,
          rowHash,
          normalizationStatus: 'normalized',
          normalizedAt: new Date(),
        },
      });
    }
  }
}

export class EcobaseImportService {
  constructor(
    private db: EcobaseDatabase,
    private registry: SourceAdapterRegistry,
  ) {}

  async refreshGoldReadModels(calculationDate = todayIsoDate()): Promise<AutomaticGoldRefreshResult> {
    const inventoryService = new EcobaseInventoryPlanningService(this.db);
    await inventoryService.refreshReadModel({ calculationDate, limit: AUTOMATIC_GOLD_REFRESH_LIMIT });
    const orderWorkspace = await new EcobaseOrderPlanningService(this.db).refreshReadModel({
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
    };
  }

  async importClickupOrderStatuses(
    params: ImportClickupOrderStatusesParams,
  ): Promise<ClickupOrderStatusImportResult | Record<string, unknown>> {
    this.validateCsvBundleFiles(params.files);
    const dryRun = params.dryRun !== false;
    const clickupService = new EcobaseClickupOrderStatusService(this.db);
    if (dryRun) return clickupService.importCsvFiles({ ...params, dryRun: true });
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

    const startedAt = new Date();
    const sourceIdentifier = params.sourceIdentifier ?? 'clickup-order-status-csv';
    const sourceVersion =
      params.snapshotDate ?? params.importedAt?.slice(0, 10) ?? startedAt.toISOString().slice(0, 10);
    const contentHash = createHash('sha256');
    for (const file of [...params.files].sort((left, right) => left.name.localeCompare(right.name))) {
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
      await retainClickupSourceRows({
        db: this.db,
        files: params.files,
        importRunId,
        sourceConnectionId: params.sourceConnectionId,
        sourceVersion,
      });
      const warningCount =
        result.unmatchedRefCount + result.missingMainTaskCount + result.duplicateRefCount + result.invalidCommentCount;
      const errorCount = result.blockingIssueCount;
      const goldRefresh =
        !params.skipGoldRefresh && errorCount === 0 ? await this.refreshGoldReadModels(sourceVersion) : null;
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
              ? `ClickUp import quarantined ${errorCount} conflicting or ambiguous order reference group(s).`
              : null,
          summary: { clickup: result, goldRefresh },
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
            skipGoldRefresh: true,
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
    const goldRefresh = sourceConnections.some(shouldRefreshGoldAfterImport)
      ? await this.refreshGoldReadModels(params.goldCalculationDate ?? sourceVersion)
      : null;
    return { imports, normalization, failures, goldRefresh };
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

    const supplierOrderService = new EcobaseSupplierOrderService(this.db);
    const bronzeService = new EcobaseBronzeImportService(this.db);
    const adapterConfig = mergeConfig(sourceConnection, params.runtimeConfig);
    const bronzeContext = {
      importRunId,
      sourceConnectionId: params.sourceConnectionId,
      sourceIdentifier,
      sourceVersion,
      adapter,
    };
    const stream = await this.runAdapterStream({
      importRunId,
      supplierOrderService,
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
      supplierOrderTouched,
      accountabilityTouched,
    } = stream;
    let { errorCount, statusMessage } = stream;
    const fileSummaries = stream.fileSummaries;
    let goldRefresh: AutomaticGoldRefreshResult | null = null;
    let medallionNormalization: NormalizePendingResult | null = null;

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

    if (!errorMessage && normalizedCount > 0) {
      try {
        await new EcobasePlanningProductService(this.db).syncFromSilverCompanyProducts();
        if (supplierOrderTouched) {
          await supplierOrderService.reconcileAfterImport(importRunId);
        }
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

    if (
      !errorMessage &&
      !params.skipGoldRefresh &&
      shouldRefreshGoldAfterImport(sourceConnection) &&
      (normalizedCount > 0 || (medallionNormalization?.normalized ?? 0) > 0)
    ) {
      try {
        goldRefresh = await this.refreshGoldReadModels(params.goldCalculationDate);
      } catch (error) {
        statusMessage =
          error instanceof Error
            ? `Ecobase import completed with a gold refresh warning: ${error.message}`
            : 'Ecobase import completed with a gold refresh warning: refresh threw a non-Error value.';
        errorCount += 1;
      }
    }

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
        summary: { files: fileSummaries, medallionNormalization, goldRefresh, ...(params.summary ?? {}) },
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
      supplierOrderTouched: false,
      accountabilityTouched: false,
    };

    try {
      await params.bronzeService.createSourceFiles(params.bronzeContext, inlineCsvFiles(params.adapterConfig));
      for await (const item of params.adapter.import(params.adapterInput)) {
        const bronzeRecord = await params.bronzeService.createSourceRecord(params.bronzeContext, item);
        if (item.type === 'record') {
          const records = Array.isArray(item.record) ? item.record : [item.record];
          const fileName = getSourceFileName(item.sourceKey);
          result.rowCount += 1;
          const normalized = await this.upsertNormalizedRecords(
            records,
            params.importRunId,
            params.supplierOrderService,
            params.skipExistingNormalizedKinds,
          );
          result.normalizedCount += normalized.normalizedCount;
          updateFileSummary(result.fileSummaries, fileName, {
            rowCount: 1,
            normalizedCount: normalized.normalizedCount,
          });
          result.supplierOrderTouched = result.supplierOrderTouched || normalized.supplierOrderTouched;
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
        } else {
          result.finalStatusOverride = item.status;
          if (item.status === 'blocked' || item.status === 'failed') {
            result.errorMessage = item.message;
          } else {
            result.statusMessage = item.message;
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
    supplierOrderService: EcobaseSupplierOrderService,
    skipExistingNormalizedKinds: Set<string>,
  ) {
    const warnings: Array<{ code: string; message: string; payload?: Record<string, unknown> }> = [];
    let normalizedCount = 0;
    let sample: Record<string, unknown> | undefined;
    let supplierOrderTouched = false;
    let accountabilityTouched = false;

    for (const record of records) {
      validateNormalizedRecord(record);
      if (BRONZE_ONLY_RECORD_KINDS.has(record.kind)) {
        normalizedCount += 1;
        sample = sample ?? summarizeRecord(record);
        continue;
      }

      const customResult = await supplierOrderService.applyImportRecord(
        record as { kind: string; data: Record<string, unknown> },
        importRunId,
      );
      if (customResult.handled) {
        supplierOrderTouched = supplierOrderTouched || customResult.requiresReconcile === true;
        normalizedCount += 1;
        warnings.push(...customResult.warnings);
        sample = sample ?? customResult.sample;
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

    return { warnings, normalizedCount, sample, supplierOrderTouched, accountabilityTouched };
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
