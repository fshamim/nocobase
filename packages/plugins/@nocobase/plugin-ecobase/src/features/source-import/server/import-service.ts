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
import { EcobaseInventoryPlanningService } from '../../inventory-dashboard/server/engine/inventory-planning-service';
import { EcobaseCompanyProductFamilyService } from '../../semantic-model/server/company-product-family-service';
import {
  EcobaseOrderReceiptReconciliationService,
  receiptReconciliationOrderIdsForRefresh,
  type ReceiptReconciliationResult,
  type ReceiptStateCoverage,
} from '../../inventory-dashboard/server/engine/order-receipt-reconciliation-service';
import { EcobaseManagementKpiFactsService } from '../../daily-operations-brief/server/management-kpi-facts-service';
import { EcobaseMedallionNormalizationService } from '../../semantic-model/server/medallion-normalization-service';
import type { NormalizePendingResult } from '../../semantic-model/server/medallion-normalization-service';
import { EcobaseOrderPlanningService } from '../../order-planning/server/order-planning-service';
import { EcobasePlanningProductService } from './planning-product-service';
import { EcobaseSupplierManagementService } from '../../supplier-management/server/supplier-management-service';
import { validateSupplierLeadTimeDays } from '../../supplier-management/server/supplier-order-service';
import {
  EcobaseProtectedCatalogBoundary,
  type ProtectedCatalogReport,
  type QuarantinedListingIdentity,
} from './protected-catalog-boundary';
import { EcobaseSellerboardListingAutoAdd, type NewlyAddedListing } from './sellerboard-listing-auto-add';
import { EcobaseCoverageError, EcobaseSourceCoverageService } from './source-coverage-service';

type Filter = Record<string, unknown>;

type RepositoryFindParams = {
  filter?: Filter;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
  offset?: number;
  appends?: string[];
  transaction?: unknown;
};

type RepositoryCreateParams = { values: Record<string, unknown>; transaction?: unknown };
type RepositoryUpdateParams = {
  filterByTk?: string | number | null;
  filter?: Filter;
  values: Record<string, unknown>;
  transaction?: unknown;
};
type RepositoryDestroyParams = {
  filter?: Filter;
  filterByTk?: string | number;
  where?: Filter;
  transaction?: unknown;
};

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
  // Newest listing_daily_fact snapshot date observed in this run: the Sellerboard report's REAL
  // as-of. Stamped onto the run's sourceVersion so coverage advances to the data's actual date.
  reportAsOfDate?: string;
  // Genuinely malformed Sellerboard listings the preflight set aside for review.
  reportQuarantine?: QuarantinedListingIdentity[];
  // New Sellerboard listings the preflight auto-created into the catalog this run.
  newlyAddedListings?: NewlyAddedListing[];
};

type PreparedAdapterReportUnit = {
  items: AdapterStreamItem[];
  inputDigest: string;
  protectedCatalog?: ProtectedCatalogReport;
  quarantinedIdentities?: QuarantinedListingIdentity[];
  newlyAddedListings?: NewlyAddedListing[];
};

class SellerboardReportPreparationError extends Error {
  constructor(
    message: string,
    readonly prepared: PreparedAdapterReportUnit,
  ) {
    super(message);
    this.name = 'SellerboardReportPreparationError';
  }
}

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
  preparedItems?: AdapterStreamItem[];
  preparedProtectedCatalog?: ProtectedCatalogReport;
  preparedQuarantine?: QuarantinedListingIdentity[];
  preparedNewlyAdded?: NewlyAddedListing[];
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

export function databaseInTransaction(db: EcobaseDatabase, transaction: unknown): EcobaseDatabase {
  const repositories = new Map<string, EcobaseRepository>();
  return {
    getRepository(name) {
      const cached = repositories.get(name);
      if (cached) return cached;
      const repository = db.getRepository(name);
      const transactional: EcobaseRepository = {
        find: (params = {}) => repository.find({ ...params, transaction }),
        findOne: (params = {}) => repository.findOne({ ...params, transaction }),
        create: (params) => repository.create({ ...params, transaction }),
        update: (params) => repository.update({ ...params, transaction }),
        ...(repository.destroy ? { destroy: (params) => repository.destroy!({ ...params, transaction }) } : {}),
      };
      repositories.set(name, transactional);
      return transactional;
    },
    sequelize: db.sequelize
      ? new Proxy(db.sequelize, {
          get(target, property) {
            if (property === 'transaction') {
              return (...args: unknown[]) => {
                const callback = args[args.length - 1] as
                  | ((nestedTransaction: unknown) => Promise<unknown>)
                  | undefined;
                if (typeof callback !== 'function') throw new Error('Ecobase transaction requires a callback.');
                return callback(transaction);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      : undefined,
  };
}

export type SellerboardReportKind = 'profit_dashboard' | 'stock_daily' | 'profit_by_product_daily';

const SELLERBOARD_REPORT_KINDS = new Set<SellerboardReportKind>([
  'profit_dashboard',
  'stock_daily',
  'profit_by_product_daily',
]);
const SELLERBOARD_UNIT_MAX_ATTEMPTS = 6;
const SELLERBOARD_UNIT_FIRST_RETRY_DELAY_MS = 10 * 60 * 1000;
const SELLERBOARD_UNIT_LATER_RETRY_DELAY_MS = 30 * 60 * 1000;
const SELLERBOARD_UNIT_OVERLAP_DELAY_MS = 10 * 60 * 1000;
const SELLERBOARD_UNIT_LEASE_MS = 30 * 60 * 1000;
const SELLERBOARD_UNIT_LEASE_HEARTBEAT_MS = 5 * 60 * 1000;

class SellerboardUnitReservationError extends Error {
  readonly code = 'ECOBASE_SELLERBOARD_UNIT_RESERVATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'SellerboardUnitReservationError';
  }
}

type SellerboardReportUnitFailureClassification = 'retryable_transient' | 'non_retryable';

function classifySellerboardReportUnitFailure(message: string): {
  classification: SellerboardReportUnitFailureClassification;
  reasonCode: string;
} {
  const normalized = message.toLowerCase();
  if (/\b(?:408|425|429|5\d\d)\b/.test(normalized)) {
    return { classification: 'retryable_transient', reasonCode: 'transient_http_status' };
  }
  if (
    [
      'econnreset',
      'econnrefused',
      'etimedout',
      'timed out',
      'timeout',
      'fetch failed',
      'network error',
      'socket hang up',
      'temporarily unavailable',
    ].some((token) => normalized.includes(token))
  ) {
    return { classification: 'retryable_transient', reasonCode: 'transient_transport_failure' };
  }
  return { classification: 'non_retryable', reasonCode: 'deterministic_or_unclassified_failure' };
}

function sellerboardReportKind(params: RunAdapterImportParams) {
  const reportKind = getString(params.runtimeConfig ?? {}, 'reportKind');
  return reportKind && SELLERBOARD_REPORT_KINDS.has(reportKind as SellerboardReportKind)
    ? (reportKind as SellerboardReportKind)
    : undefined;
}

/**
 * Adapters whose rows carry Sellerboard listing identity (company + marketplace + ASIN + SKU):
 * the live report pull and the uploaded history CSV bundle. Both feed the same protected-catalog
 * machinery, so both answer catalogMutationMode and both run the unknown-listing preflight. An
 * unknown listing must be auto-added the same way regardless of which transport delivered the row.
 */
const SELLERBOARD_CATALOG_ADAPTER_NAMES = new Set(['sellerboard-api', 'sellerboard-history-csv']);

/**
 * The run's catalog mutation mode: `refresh` (default) preserves the protected catalog and welcomes
 * new listings through the preflight; `rebuild` is the explicit canonical-rebuild escape hatch that
 * skips the preflight because the run is allowed to reshape the catalog itself. Adapters that carry
 * no listing identity have no mode at all.
 */
function sellerboardCatalogMutationMode(adapter: SourceAdapter, adapterConfig: Record<string, unknown>) {
  if (!SELLERBOARD_CATALOG_ADAPTER_NAMES.has(adapter.metadata.name)) return undefined;
  const catalogMutationMode = getString(adapterConfig, 'catalogMutationMode') ?? 'refresh';
  if (!['rebuild', 'refresh'].includes(catalogMutationMode)) {
    throw new Error(
      `Ecobase import failed: catalogMutationMode must be rebuild or refresh, received "${catalogMutationMode}".`,
    );
  }
  return catalogMutationMode;
}

function requiresSellerboardCatalogPreflight(adapter: SourceAdapter, adapterConfig: Record<string, unknown>) {
  return (
    SELLERBOARD_CATALOG_ADAPTER_NAMES.has(adapter.metadata.name) &&
    getString(adapterConfig, 'catalogMutationMode') !== 'rebuild'
  );
}

function configuredSellerboardReports(config: Record<string, unknown>) {
  const configured = config.reportUrls ?? config.sellerboardReportUrls ?? config.urls;
  const reports: Array<{ reportKind: SellerboardReportKind; reportName: string }> = [];
  if (Array.isArray(configured)) {
    for (const [index, value] of configured.entries()) {
      if (typeof value === 'string') {
        reports.push({ reportKind: 'profit_dashboard', reportName: `sellerboard-report-${index + 1}` });
        continue;
      }
      if (!isRecord(value) || !getString(value, 'url')) continue;
      const category = getString(value, 'category') ?? 'profit_dashboard';
      if (!SELLERBOARD_REPORT_KINDS.has(category as SellerboardReportKind)) {
        throw new Error(
          `Ecobase Sellerboard report "${
            getString(value, 'name') ?? index + 1
          }" has unsupported report kind "${category}".`,
        );
      }
      reports.push({
        reportKind: category as SellerboardReportKind,
        reportName: getString(value, 'name') ?? `sellerboard-report-${index + 1}`,
      });
    }
  } else if (getString(config, 'reportUrl')) {
    const category = getString(config, 'reportCategory') ?? 'profit_dashboard';
    if (!SELLERBOARD_REPORT_KINDS.has(category as SellerboardReportKind)) {
      throw new Error(`Ecobase Sellerboard report has unsupported report kind "${category}".`);
    }
    reports.push({
      reportKind: category as SellerboardReportKind,
      reportName: getString(config, 'reportName') ?? 'sellerboard-report',
    });
  }
  const seen = new Set<SellerboardReportKind>();
  for (const report of reports) {
    if (seen.has(report.reportKind)) {
      throw new Error(
        `Ecobase Sellerboard configuration has duplicate report kind "${report.reportKind}"; each source/report unit must be unique.`,
      );
    }
    seen.add(report.reportKind);
  }
  return reports;
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
  unitTransaction?: unknown;
  preparedReportUnit?: PreparedAdapterReportUnit;
  retryPersistedFailure?: boolean;
  assertReservation?: () => Promise<void>;
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

export interface SellerboardReportUnitDescriptor {
  sourceConnectionId: string;
  sourceName: string;
  sourceActive: boolean;
  scheduleEnabled: boolean;
  reportKind: SellerboardReportKind;
  reportName: string;
}

export interface RunSellerboardReportUnitParams {
  sourceConnectionId: string;
  reportKind: SellerboardReportKind;
}

interface SellerboardReportUnitExecutionParams {
  sourceIdentifier: string;
  sourceVersion: string;
  startedAt: Date;
  skipExistingNormalizedKinds?: string[];
  queuedImportRun?: QueuedImportRun;
  summary?: Record<string, unknown>;
  assertReservation?: () => Promise<void>;
}

/**
 * Payload handed to the committed-unit hook. `companyId` carries the Sellerboard
 * source connection's company so downstream consumers (054 R1 receipt
 * reconciliation) can scope their work to the companies whose data just moved.
 * It is optional because a source connection may not be linked to a company.
 */
export interface SellerboardCommittedUnit extends SellerboardReportUnitDescriptor {
  importRunId: string;
  companyId?: string;
}

export type SellerboardCommittedUnitHandler = (unit: SellerboardCommittedUnit) => void | Promise<void>;

interface SellerboardReportUnitHooks {
  now?: Date;
  onCommittedUnit?: SellerboardCommittedUnitHandler;
}

export interface RunScheduledSellerboardImportsParams {
  now?: string;
  sourceConnectionId?: string;
  onCommittedUnit?: SellerboardCommittedUnitHandler;
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

function canonicalReportInput(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalReportInput);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalReportInput(value[key])]),
  );
}

function sellerboardReportInputDigest(items: AdapterStreamItem[]) {
  const inputProjection = items.map((item) => {
    if (item.type === 'record') {
      return {
        type: item.type,
        rowNumber: item.rowNumber,
        sourceKey: item.sourceKey,
        payload: item.payload,
      };
    }
    if (item.type === 'rowIssue') return { type: item.type, issue: item.issue };
    return { type: item.type, status: item.status, message: item.message, payload: item.payload };
  });
  return sha256(JSON.stringify(canonicalReportInput(inputProjection)));
}

function sellerboardUnitRetryDelay(attempt: number) {
  return attempt === 1 ? SELLERBOARD_UNIT_FIRST_RETRY_DELAY_MS : SELLERBOARD_UNIT_LATER_RETRY_DELAY_MS;
}

function sellerboardScheduleClock(now: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch (error) {
    throw new Error(
      `Ecobase scheduled Sellerboard import failed: timezone "${timezone}" is invalid: ${
        error instanceof Error ? error.message : 'Intl rejected a non-Error value.'
      }`,
    );
  }
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hours = Number(value('hour'));
  const minutes = Number(value('minute'));
  if (!year || !month || !day || !Number.isInteger(hours) || !Number.isInteger(minutes)) {
    throw new Error(`Ecobase scheduled Sellerboard import failed: timezone "${timezone}" produced an invalid clock.`);
  }
  return { cycleDate: `${year}-${month}-${day}`, minuteOfDay: hours * 60 + minutes };
}

function isUniqueConstraintError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const record = error as Error & { original?: { code?: unknown }; parent?: { code?: unknown } };
  return (
    record.original?.code === '23505' ||
    record.parent?.code === '23505' ||
    error.name.includes('UniqueConstraint') ||
    error.message.toLowerCase().includes('duplicate key')
  );
}

function isSystemicSellerboardCoordinatorFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = getString(error, 'code') ?? '';
  return (
    error instanceof SellerboardUnitReservationError ||
    error.message.includes('requires database transaction support') ||
    error.name.startsWith('Sequelize') ||
    code === 'ECONNREFUSED' ||
    code === '57P01' ||
    code.startsWith('08')
  );
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

  /**
   * Sellerboard preflight: classify each row against the protected catalog without ever aborting
   * the refresh. A valid identity with no catalog record is a WELCOME new listing — auto-create it
   * through the canonical catalog machinery and keep the row so its sales data imports in the same
   * run. Only genuinely malformed rows (unknown company, invalid ASIN shape, missing SKU) are set
   * aside for review. Both auto-adds and quarantines are de-duplicated by identity so a listing
   * appearing on many daily rows is handled exactly once.
   *
   * Transport-agnostic: the live report pull and an uploaded history CSV bundle both project to the
   * `sellerboard_daily_facts` dataset, so the same classification runs for either. A backfill that
   * contains listings born after the last live pull adds them instead of reporting them as problems.
   */
  private async preflightSellerboardListings(
    boundaryService: EcobaseProtectedCatalogBoundary,
    adapter: SourceAdapter,
    defaultCompany: string | undefined,
    sourceItems: AsyncIterable<AdapterStreamItem> | AdapterStreamItem[],
  ): Promise<{
    items: AdapterStreamItem[];
    quarantine: QuarantinedListingIdentity[];
    newlyAdded: NewlyAddedListing[];
  }> {
    const items: AdapterStreamItem[] = [];
    const quarantineByKey = new Map<string, QuarantinedListingIdentity>();
    const addedByKey = new Map<string, NewlyAddedListing>();
    const autoAdd = new EcobaseSellerboardListingAutoAdd(this.db);
    for await (const sourceItem of sourceItems) {
      if (sourceItem.type !== 'status') {
        const boundary = applySafeImportBoundary({ adapter, defaultCompany }, sourceItem);
        if (boundary.disposition !== 'discard' && boundary.item.type === 'record') {
          const disposition = await boundaryService.classifySellerboardIdentity(boundary.item.payload);
          if (disposition.kind === 'malformed') {
            const q = disposition.quarantine;
            const key = [q.company, q.marketplace, q.asin, q.listingSku].join(' ');
            if (!quarantineByKey.has(key)) quarantineByKey.set(key, q);
            continue;
          }
          if (disposition.kind === 'new_listing') {
            const listing = disposition.listing;
            const key = [listing.companyId, listing.amazonAccountId, listing.asin, listing.listingSku].join(' ');
            if (!addedByKey.has(key)) addedByKey.set(key, await autoAdd.addListing(listing));
            // Fall through: keep the row so its sales data imports in this same run.
          }
        }
      }
      items.push(sourceItem);
    }
    return { items, quarantine: [...quarantineByKey.values()], newlyAdded: [...addedByKey.values()] };
  }

  private async prepareSellerboardReportUnit(
    params: RunAdapterImportParams,
    sourceIdentifier: string,
    sourceVersion: string,
  ): Promise<PreparedAdapterReportUnit> {
    const sourceConnection = await this.db
      .getRepository(ECOBASE_COLLECTIONS.sourceConnections)
      .findOne({ filterByTk: params.sourceConnectionId });
    if (!sourceConnection) {
      throw new Error(`Ecobase import failed: source connection "${params.sourceConnectionId}" was not found.`);
    }
    const adapter = this.registry.get(params.adapterName);
    validateSourceConnectionForAdapter(sourceConnection, adapter);
    const adapterConfig = mergeConfig(sourceConnection, params.runtimeConfig);
    const catalogMutationMode = sellerboardCatalogMutationMode(adapter, adapterConfig);
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
    const adapterInput: SourceAdapterImportInput = {
      sourceConnectionId: params.sourceConnectionId,
      sourceIdentifier,
      sourceVersion,
      idempotencyKey:
        params.idempotencyKey ?? `${params.sourceConnectionId}:${sourceIdentifier}:${sourceVersion}:preparation`,
      config: adapterConfig,
      secretRef: getString(sourceConnection, 'secretRef'),
    };
    let protectedCatalog: ProtectedCatalogReport | undefined;
    let items: AdapterStreamItem[] = [];
    let quarantinedIdentities: QuarantinedListingIdentity[] = [];
    let newlyAddedListings: NewlyAddedListing[] = [];
    const requiresCatalogPreflight = requiresSellerboardCatalogPreflight(adapter, adapterConfig);
    const boundaryService = requiresCatalogPreflight ? new EcobaseProtectedCatalogBoundary(this.db) : undefined;
    if (boundaryService) {
      protectedCatalog = await boundaryService.inspect();
      const preflighted = await this.preflightSellerboardListings(
        boundaryService,
        adapter,
        getString(adapterConfig, 'defaultCompany'),
        adapter.import(adapterInput),
      );
      items = preflighted.items;
      quarantinedIdentities = preflighted.quarantine;
      newlyAddedListings = preflighted.newlyAdded;
      if (newlyAddedListings.length > 0) {
        // Auto-add grew the catalog during preflight; re-baseline the fingerprint so the refresh's
        // preserve-catalog guard compares against the post-add state, not the stale pre-add one.
        protectedCatalog = await new EcobaseProtectedCatalogBoundary(this.db).inspect();
      }
    } else {
      for await (const sourceItem of adapter.import(adapterInput)) {
        items.push(sourceItem);
      }
    }
    const prepared: PreparedAdapterReportUnit = {
      items,
      inputDigest: sellerboardReportInputDigest(items),
      ...(protectedCatalog ? { protectedCatalog } : {}),
      ...(quarantinedIdentities.length > 0 ? { quarantinedIdentities } : {}),
      ...(newlyAddedListings.length > 0 ? { newlyAddedListings } : {}),
    };
    try {
      this.validatePreparedSellerboardReportUnit(adapter, adapterConfig, prepared.items);
    } catch (error) {
      throw new SellerboardReportPreparationError(
        error instanceof Error
          ? error.message
          : 'Ecobase Sellerboard report preparation failed with a non-Error value.',
        prepared,
      );
    }
    return prepared;
  }

  private validatePreparedSellerboardReportUnit(
    adapter: SourceAdapter,
    adapterConfig: Record<string, unknown>,
    items: AdapterStreamItem[],
  ) {
    for (const sourceItem of items) {
      if (sourceItem.type === 'status') {
        if (sourceItem.status !== 'success') throw new Error(sourceItem.message);
        continue;
      }
      if (sourceItem.type === 'rowIssue' && sourceItem.issue.severity === 'error') {
        throw new Error(sourceItem.issue.message);
      }
      const boundary = applySafeImportBoundary(
        { adapter, defaultCompany: getString(adapterConfig, 'defaultCompany') },
        sourceItem,
      );
      if (boundary.disposition === 'discard') {
        if (boundary.reasonCode === 'unsupported_projection_dataset') {
          throw new Error(
            `Ecobase import failed: adapter "${adapter.metadata.name}" emitted a source row without an approved safe projection.`,
          );
        }
        continue;
      }
      if (boundary.item.type !== 'record') continue;
      const records = Array.isArray(boundary.item.record) ? boundary.item.record : [boundary.item.record];
      for (const record of records) {
        validateNormalizedRecord(record);
        if (BRONZE_ONLY_RECORD_KINDS.has(record.kind)) continue;
        const target = normalizedRecordTarget(record, 'prepared-report-unit');
        if (!target.collectionName) {
          throw new Error(
            `Ecobase import failed: normalized record kind "${record.kind}" is not mapped to a collection.`,
          );
        }
        if (!getString(target.values, 'naturalKey')) {
          throw new Error(`Ecobase import failed: normalized record kind "${record.kind}" is missing naturalKey.`);
        }
      }
    }
  }

  private async persistSellerboardReportUnitFailure(params: {
    attempted?: Record<string, unknown>;
    sourceConnectionId: string;
    adapterName: string;
    sourceIdentifier: string;
    sourceVersion: string;
    idempotencyKey: string;
    inputDigest?: string;
    startedAt?: Date;
    summary?: Record<string, unknown>;
    message: string;
    attemptCount: number;
    backoffMs: number;
    failure: ReturnType<typeof classifySellerboardReportUnitFailure>;
  }) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const existing = await repository.findOne({ filter: { idempotencyKey: params.idempotencyKey } });
    const attempted = params.attempted ?? {};
    const values = {
      sourceConnectionId: params.sourceConnectionId,
      adapterName: params.adapterName,
      sourceIdentifier: params.sourceIdentifier,
      sourceVersion: params.sourceVersion,
      idempotencyKey: params.idempotencyKey,
      startedAt: attempted.startedAt ?? params.startedAt ?? new Date(),
      finishedAt: new Date(),
      status: 'failed',
      rowCount: getNumber(attempted, 'rowCount'),
      normalizedCount: 0,
      warningCount: getNumber(attempted, 'warningCount'),
      errorCount: Math.max(1, getNumber(attempted, 'errorCount')),
      errorMessage: params.message,
      summary: {
        ...toPlainRecord(toPlainRecord(existing).summary),
        ...(params.summary ?? {}),
        ...toPlainRecord(attempted.summary),
        ...(params.inputDigest ? { reportUnitInputDigest: params.inputDigest } : {}),
        reportUnitRetry: {
          attemptCount: params.attemptCount,
          backoffMs: params.backoffMs,
          classification: params.failure.classification,
          reasonCode: params.failure.reasonCode,
        },
      },
    };
    if (existing) {
      const id = toPlainRecord(existing).id;
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error(`Ecobase failed report unit "${params.idempotencyKey}" is missing its run id.`);
      }
      await repository.update({ filterByTk: id, values });
      return toPlainRecord((await repository.findOne({ filterByTk: id })) ?? existing);
    }
    return toPlainRecord(
      await repository.create({ values: { id: getString(attempted, 'id') ?? randomUUID(), ...values } }),
    );
  }

  async runAdapterImport(params: RunAdapterImportParams) {
    if (!params.sourceConnectionId) {
      throw new Error('Ecobase import failed: sourceConnectionId is required.');
    }

    const reportKind = sellerboardReportKind(params);
    if (reportKind && !params.unitTransaction) {
      const sourceIdentifier = params.sourceIdentifier ?? `sellerboard:${reportKind}`;
      const sourceVersion = params.sourceVersion;
      if (!sourceVersion) {
        throw new Error(`Ecobase Sellerboard ${reportKind} import requires sourceVersion.`);
      }
      const runTransaction = this.db.sequelize?.transaction?.bind(this.db.sequelize);
      if (!runTransaction) {
        throw new Error(`Ecobase Sellerboard ${reportKind} import requires database transaction support.`);
      }
      const repository = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
      const fallbackIdempotencyKey =
        params.idempotencyKey ?? `${params.sourceConnectionId}:${sourceIdentifier}:${sourceVersion}`;
      const requestedRetry = toPlainRecord((params.summary ?? {}).reportUnitRetry);
      const attemptCount = Math.max(1, getNumber(requestedRetry, 'attemptCount'));
      let idempotencyKey = fallbackIdempotencyKey;
      let preparedReportUnit: PreparedAdapterReportUnit | undefined;
      let failedRun: Record<string, unknown> | undefined;
      try {
        preparedReportUnit = await this.prepareSellerboardReportUnit(params, sourceIdentifier, sourceVersion);
        await params.assertReservation?.();
        const digestIdempotencyKey = `${params.sourceConnectionId}:${reportKind}:${preparedReportUnit.inputDigest}`;
        const existingDigestRun = await repository.findOne({ filter: { idempotencyKey: digestIdempotencyKey } });
        if (getString(existingDigestRun, 'status') === 'success') {
          return { ...toPlainRecord(existingDigestRun), reused: true };
        }
        idempotencyKey = digestIdempotencyKey;
        await params.assertReservation?.();
        const run = await runTransaction(async (transaction: unknown) => {
          await params.assertReservation?.();
          const result = await new EcobaseImportService(
            databaseInTransaction(this.db, transaction),
            this.registry,
          ).runAdapterImport({
            ...params,
            sourceIdentifier,
            sourceVersion,
            idempotencyKey,
            preparedReportUnit,
            queuedImportRun: undefined,
            retryPersistedFailure: getString(existingDigestRun, 'status') === 'failed',
            summary: {
              ...(params.summary ?? {}),
              reportUnitInputDigest: preparedReportUnit.inputDigest,
              reportUnitRetry: {
                attemptCount,
                backoffMs: 0,
                classification: 'not_applicable',
                outcome: attemptCount === 1 ? 'succeeded_without_retry' : 'recovered',
              },
            },
            unitTransaction: transaction,
          });
          if (getString(result, 'status') !== 'success') {
            failedRun = toPlainRecord(result);
            throw new Error(
              getString(result, 'errorMessage') ??
                `Ecobase Sellerboard ${reportKind} import failed before the report unit could commit.`,
            );
          }
          return result;
        });
        return { ...toPlainRecord(run), reused: false };
      } catch (error) {
        if (error instanceof SellerboardUnitReservationError || isSystemicSellerboardCoordinatorFailure(error)) {
          throw error;
        }
        if (error instanceof SellerboardReportPreparationError) {
          preparedReportUnit = error.prepared;
          idempotencyKey = `${params.sourceConnectionId}:${reportKind}:${preparedReportUnit.inputDigest}`;
        }
        const attempted = failedRun ?? {};
        const message =
          getString(attempted, 'errorMessage') ??
          (error instanceof Error
            ? error.message
            : `Ecobase Sellerboard ${reportKind} import failed with a non-Error value.`);
        const failure = classifySellerboardReportUnitFailure(message);
        return this.persistSellerboardReportUnitFailure({
          attempted,
          sourceConnectionId: params.sourceConnectionId,
          adapterName: params.adapterName,
          sourceIdentifier,
          sourceVersion,
          idempotencyKey,
          inputDigest: preparedReportUnit?.inputDigest,
          startedAt: params.startedAt,
          summary: params.summary,
          message,
          attemptCount,
          backoffMs: 0,
          failure,
        });
      }
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
    const catalogMutationMode = sellerboardCatalogMutationMode(adapter, adapterConfig);
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

    if (!params.unitTransaction) {
      await this.cleanupExpiredBronzeRecords(params.startedAt ?? new Date());
    }
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

    const retryingPersistedFailure =
      params.retryPersistedFailure === true && getString(existingRun, 'status') === 'failed';
    if (existingRun && !params.preserveAuditRun && !retryingPersistedFailure) {
      return toPlainRecord(existingRun);
    }

    const idempotencyKey =
      params.queuedImportRun?.idempotencyKey ??
      (existingRun && !retryingPersistedFailure ? `${baseIdempotencyKey}:audit:${randomUUID()}` : baseIdempotencyKey);

    let pendingRun: unknown;
    if (params.queuedImportRun) {
      pendingRun = await importRunRepo.findOne({ filterByTk: params.queuedImportRun.id });
      if (!pendingRun) {
        throw new SellerboardUnitReservationError(
          `Ecobase queued import reservation "${params.queuedImportRun.id}" was not found.`,
        );
      }
    } else if (retryingPersistedFailure) {
      const existingRunId = toPlainRecord(existingRun).id;
      if (typeof existingRunId !== 'string' && typeof existingRunId !== 'number') {
        throw new Error(`Ecobase failed report unit "${baseIdempotencyKey}" is missing its run id.`);
      }
      await importRunRepo.update({
        filterByTk: existingRunId,
        values: {
          sourceIdentifier,
          sourceVersion,
          startedAt,
          finishedAt: null,
          status: 'pending',
          rowCount: 0,
          normalizedCount: 0,
          warningCount: 0,
          errorCount: 0,
          errorMessage: null,
          summary: params.summary ?? {},
        },
      });
      pendingRun = await importRunRepo.findOne({ filterByTk: existingRunId });
    } else {
      pendingRun = await importRunRepo.create({
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
    }
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
      preparedItems: params.preparedReportUnit?.items,
      preparedProtectedCatalog: params.preparedReportUnit?.protectedCatalog,
      preparedQuarantine: params.preparedReportUnit?.quarantinedIdentities,
      preparedNewlyAdded: params.preparedReportUnit?.newlyAddedListings,
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
          importRunId,
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

    if (
      !errorMessage &&
      normalizedCount > 0 &&
      !reportKind &&
      !['google-sheets-migration-csv', 'sellerboard-history-csv'].includes(adapter.metadata.name)
    ) {
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
    // Batch C: stamp the run's as-of with the Sellerboard report's REAL data date (the newest
    // daily fact observed) so coverage advances to the data's actual date instead of the run's
    // schedule day. A normal 2-3 day feed lag then extends coverage through the report's as-of
    // and never opens a false gap. Only the live sellerboard-api adapter is stamped.
    const sellerboardReportAsOf =
      adapter.metadata.name === 'sellerboard-api' && stream.reportAsOfDate ? stream.reportAsOfDate : undefined;
    const effectiveAsOfDate = (sellerboardReportAsOf ?? sourceVersion).slice(0, 10);
    const runSummary = {
      files: fileSummaries,
      medallionNormalization,
      familyReconciliation,
      goldRefreshRequired,
      migration: {
        profileVersion: FOUR_COMPANY_MIGRATION_PROFILE.profileVersion,
        asOfDate: effectiveAsOfDate,
        ...stream.migrationSummary,
      },
      ...(params.summary ?? {}),
      ...(catalogMutationMode ? { catalogMutationMode } : {}),
      ...(stream.protectedCatalog ? { protectedCatalog: stream.protectedCatalog } : {}),
      ...(stream.reportQuarantine && stream.reportQuarantine.length > 0
        ? { reportQuarantine: stream.reportQuarantine }
        : {}),
      ...(stream.newlyAddedListings && stream.newlyAddedListings.length > 0
        ? { newlyAddedListings: stream.newlyAddedListings }
        : {}),
    };
    const completionValues = {
      finishedAt,
      status,
      ...(sellerboardReportAsOf ? { sourceVersion: sellerboardReportAsOf } : {}),
      rowCount,
      normalizedCount,
      warningCount,
      errorCount,
      errorMessage: errorMessage ?? statusMessage ?? (normalizedCount > 0 ? firstErrorIssueMessage : null),
      summary: runSummary,
    };
    const maintainsSellerboardCoverage =
      status === 'success' && ['sellerboard-api', 'sellerboard-history-csv'].includes(adapter.metadata.name);
    const completeRun = async (transaction?: unknown) => {
      await importRunRepo.update({ filterByTk: importRunId, values: completionValues, transaction });
      if (!maintainsSellerboardCoverage) return;
      const coverageMaintenance = await new EcobaseSourceCoverageService(this.db).maintainSuccessfulImport(
        importRunId,
        {
          transaction,
        },
      );
      // A stale Sellerboard re-serve (older/equal as-of, window already held) is a quiet no-op, not
      // an error; surface it as an informational summary note so the sources page can show it.
      const coverageSkippedStale = coverageMaintenance.recorded
        ? coverageMaintenance.reconciliation.coverageSkippedStale
        : [];
      await importRunRepo.update({
        filterByTk: importRunId,
        values: {
          summary: {
            ...runSummary,
            coverageMaintenance,
            ...(coverageSkippedStale.length > 0 ? { coverageSkippedStale } : {}),
          },
        },
        transaction,
      });
    };
    try {
      if (maintainsSellerboardCoverage && this.db.sequelize?.transaction) {
        await this.db.sequelize.transaction((transaction: unknown) => completeRun(transaction));
      } else {
        await completeRun();
      }
    } catch (coverageError) {
      const coverageMessage =
        coverageError instanceof EcobaseCoverageError
          ? `${coverageError.code}: ${coverageError.message}`
          : coverageError instanceof Error
            ? `ECOBASE_COVERAGE_MAINTENANCE_FAILED: ${coverageError.message}`
            : 'ECOBASE_COVERAGE_MAINTENANCE_FAILED: coverage maintenance threw a non-Error value.';
      await importRunRepo.update({
        filterByTk: importRunId,
        values: {
          ...completionValues,
          status: normalizedCount > 0 ? 'partial' : 'failed',
          errorCount: errorCount + 1,
          errorMessage: coverageMessage,
          summary: {
            ...runSummary,
            coverageMaintenance: {
              recorded: false,
              reasonCode: 'maintenance_failed',
              error: coverageMessage,
            },
          },
        },
      });
    }

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
      let sourceItems: AsyncIterable<AdapterStreamItem> | AdapterStreamItem[] =
        params.preparedItems ?? params.adapter.import(params.adapterInput);
      result.protectedCatalog = params.preparedProtectedCatalog;
      if (params.preparedQuarantine && params.preparedQuarantine.length > 0) {
        result.reportQuarantine = params.preparedQuarantine;
      }
      if (params.preparedNewlyAdded && params.preparedNewlyAdded.length > 0) {
        result.newlyAddedListings = params.preparedNewlyAdded;
      }
      if (!params.preparedItems && requiresSellerboardCatalogPreflight(params.adapter, params.adapterConfig)) {
        const boundaryService = new EcobaseProtectedCatalogBoundary(this.db);
        result.protectedCatalog = await boundaryService.inspect();
        const preflighted = await this.preflightSellerboardListings(
          boundaryService,
          params.adapter,
          getString(params.adapterConfig, 'defaultCompany'),
          sourceItems,
        );
        sourceItems = preflighted.items;
        if (preflighted.quarantine.length > 0) result.reportQuarantine = preflighted.quarantine;
        if (preflighted.newlyAdded.length > 0) {
          result.newlyAddedListings = preflighted.newlyAdded;
          // Re-baseline after auto-add so the preserve-catalog fingerprint guard compares the
          // post-add catalog, not the stale pre-add snapshot captured above.
          result.protectedCatalog = await new EcobaseProtectedCatalogBoundary(this.db).inspect();
        }
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
          for (const record of records) {
            if (record.kind !== 'listing_daily_fact') continue;
            const snapshotDate = getString(record.data, 'snapshotDate');
            if (snapshotDate && /^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
              if (!result.reportAsOfDate || snapshotDate > result.reportAsOfDate) {
                result.reportAsOfDate = snapshotDate;
              }
            }
          }
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

  async sellerboardReportUnits(sourceConnectionId?: string): Promise<SellerboardReportUnitDescriptor[]> {
    const sourceConnections = await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({
      filter: sourceConnectionId ? { id: sourceConnectionId } : { sourceType: 'sellerboard' },
      sort: ['name'],
    });
    return sourceConnections.flatMap((sourceConnection) => {
      const id = getString(sourceConnection, 'id');
      if (!id || getString(sourceConnection, 'sourceType') !== 'sellerboard') return [];
      const config = getConfig(sourceConnection);
      const schedule = this.readSellerboardSchedule(config);
      return configuredSellerboardReports(config).map((report) => ({
        sourceConnectionId: id,
        sourceName: getString(sourceConnection, 'name') ?? id,
        sourceActive: getBoolean(sourceConnection, 'active', true),
        scheduleEnabled: schedule.enabled,
        ...report,
      }));
    });
  }

  async runSellerboardReportUnit(params: RunSellerboardReportUnitParams, hooks: SellerboardReportUnitHooks = {}) {
    const now = hooks.now ?? new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error('Ecobase Sellerboard report-unit import requires a valid execution time.');
    }
    const sourceConnection = await this.db
      .getRepository(ECOBASE_COLLECTIONS.sourceConnections)
      .findOne({ filterByTk: params.sourceConnectionId });
    if (!sourceConnection || getString(sourceConnection, 'sourceType') !== 'sellerboard') {
      throw new Error(`Ecobase Sellerboard source "${params.sourceConnectionId}" was not found.`);
    }
    const config = getConfig(sourceConnection);
    const schedule = this.readSellerboardSchedule(config);
    const report = configuredSellerboardReports(config).find((candidate) => candidate.reportKind === params.reportKind);
    if (!report) {
      throw new Error(
        `Ecobase Sellerboard source "${params.sourceConnectionId}" does not configure report kind "${params.reportKind}".`,
      );
    }
    const clock = sellerboardScheduleClock(now, schedule.timezone);
    const result = await this.runSellerboardUnitCycle({
      now,
      cycleDate: clock.cycleDate,
      timezone: schedule.timezone,
      sourceConnection,
      report,
      onCommittedUnit: hooks.onCommittedUnit,
    });
    if (result.status === 'not_due' && isRecord(result.run)) {
      return { ...result.run, reused: true };
    }
    if (result.status === 'success' && isRecord(result.run)) {
      return { ...result.run, ...(result.goldTrigger ? { goldTrigger: result.goldTrigger } : {}) };
    }
    return result;
  }

  private async executeSellerboardReportUnit(
    params: RunSellerboardReportUnitParams,
    execution: SellerboardReportUnitExecutionParams,
  ) {
    if (!params.sourceConnectionId) {
      throw new Error('Ecobase Sellerboard report-unit import requires sourceConnectionId.');
    }
    if (!SELLERBOARD_REPORT_KINDS.has(params.reportKind)) {
      throw new Error(
        `Ecobase Sellerboard report-unit import received unsupported report kind "${params.reportKind}".`,
      );
    }
    const unit = (await this.sellerboardReportUnits(params.sourceConnectionId)).find(
      (candidate) => candidate.reportKind === params.reportKind,
    );
    if (!unit) {
      throw new Error(
        `Ecobase Sellerboard source "${params.sourceConnectionId}" does not configure report kind "${params.reportKind}".`,
      );
    }
    return this.runAdapterImport({
      sourceConnectionId: params.sourceConnectionId,
      adapterName: 'sellerboard-api',
      sourceIdentifier: execution.sourceIdentifier,
      sourceVersion: execution.sourceVersion,
      startedAt: execution.startedAt,
      skipExistingNormalizedKinds: execution.skipExistingNormalizedKinds,
      queuedImportRun: execution.queuedImportRun,
      summary: execution.summary,
      assertReservation: execution.assertReservation,
      runtimeConfig: { reportKind: params.reportKind },
    });
  }

  async runScheduledSellerboardImports(params: RunScheduledSellerboardImportsParams = {}) {
    const now = params.now ? new Date(params.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error(`Ecobase scheduled Sellerboard import failed: now "${params.now}" is not a valid date.`);
    }
    const sourceConnections = await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({
      filter: params.sourceConnectionId ? { id: params.sourceConnectionId } : { sourceType: 'sellerboard' },
      sort: ['name'],
    });
    const results: Array<Record<string, unknown>> = [];
    const unitExecutions: Array<Promise<Record<string, unknown>>> = [];

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
      let reports: ReturnType<typeof configuredSellerboardReports>;
      try {
        reports = configuredSellerboardReports(config);
      } catch (error) {
        results.push({
          sourceConnectionId,
          status: 'failed',
          reasonCode: 'invalid_report_configuration',
          message:
            error instanceof Error
              ? error.message
              : 'Ecobase Sellerboard report configuration failed with a non-Error value.',
        });
        continue;
      }
      if (!reports.length) {
        results.push({ sourceConnectionId, status: 'ignored', reason: 'no_configured_report_units' });
        continue;
      }
      const clock = sellerboardScheduleClock(now, schedule.timezone);
      if (clock.minuteOfDay < schedule.dailyMinuteOfDay) {
        results.push({
          sourceConnectionId,
          status: 'not_due',
          dailyRefreshTime: schedule.dailyRefreshTime,
          timezone: schedule.timezone,
          now: now.toISOString(),
        });
        continue;
      }

      for (const report of reports) {
        unitExecutions.push(
          this.runSellerboardUnitCycle({
            now,
            cycleDate: clock.cycleDate,
            timezone: schedule.timezone,
            sourceConnection,
            report,
            onCommittedUnit: params.onCommittedUnit,
          }).catch((error) => {
            if (isSystemicSellerboardCoordinatorFailure(error)) throw error;
            return {
              sourceConnectionId,
              ...report,
              status: 'failed',
              reasonCode: 'report_unit_execution_exception',
              message:
                error instanceof Error
                  ? error.message
                  : 'Ecobase Sellerboard report-unit execution failed with a non-Error value.',
            };
          }),
        );
      }
    }

    results.push(...(await Promise.all(unitExecutions)));
    return { now: now.toISOString(), results };
  }

  private async runSellerboardUnitCycle(
    params: {
      now: Date;
      cycleDate: string;
      timezone: string;
      sourceConnection: unknown;
      report: { reportKind: SellerboardReportKind; reportName: string };
      onCommittedUnit?: RunScheduledSellerboardImportsParams['onCommittedUnit'];
    },
    reservationCollisionRetried = false,
  ): Promise<Record<string, unknown>> {
    const sourceConnectionId = getString(params.sourceConnection, 'id');
    if (!sourceConnectionId) {
      throw new SellerboardUnitReservationError('Ecobase Sellerboard unit reservation requires sourceConnectionId.');
    }
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const identity = { sourceConnectionId, ...params.report, sourceVersion: params.cycleDate };
    const outcome = (values: Record<string, unknown>, run?: unknown) => ({
      ...identity,
      ...values,
      ...(run ? { run: toPlainRecord(run) } : {}),
    });
    const cycleRuns = await this.sellerboardCycleRuns(
      sourceConnectionId,
      params.report.reportKind,
      params.cycleDate,
      params.timezone,
    );
    const attempts = cycleRuns.attempts;
    const successful = [...attempts].reverse().find((run) => getString(run, 'status') === 'success');
    if (successful) {
      const committedImportRunId = getString(toPlainRecord(toPlainRecord(successful).summary), 'committedImportRunId');
      const committedRun = committedImportRunId
        ? await repository.findOne({ filterByTk: committedImportRunId })
        : successful;
      return outcome(
        {
          status: 'not_due',
          reason: 'report_unit_already_committed',
          attemptCount: this.sellerboardAttemptCount(attempts),
        },
        committedRun ?? successful,
      );
    }

    const active = attempts.filter((run) => ['pending', 'running'].includes(getString(run, 'status') ?? ''));
    if (active.length > 1) {
      throw new SellerboardUnitReservationError(
        `Ecobase Sellerboard unit has ambiguous ownership: ${active.length} active reservations for ${sourceConnectionId}/${params.report.reportKind}/${params.cycleDate}.`,
      );
    }
    if (active.length === 1) {
      return this.handleActiveSellerboardReservation({
        repository,
        reservation: active[0],
        latestDeferral: cycleRuns.deferrals.at(-1),
        now: params.now,
        sourceConnectionId,
        report: params.report,
        cycleDate: params.cycleDate,
      });
    }

    const latest = attempts.at(-1);
    const attemptCount = this.sellerboardAttemptCount(attempts);
    if (latest && getString(latest, 'status') !== 'success') {
      const summary = toPlainRecord(toPlainRecord(latest).summary);
      const cycle = toPlainRecord(summary.sellerboardUnitCycle);
      const retry = toPlainRecord(summary.reportUnitRetry);
      const classification = getString(cycle, 'classification') ?? getString(retry, 'classification');
      if (classification !== 'retryable_transient') {
        return outcome(
          {
            status: 'terminal',
            reason: 'non_retryable_daily_cycle',
            reasonCode:
              getString(cycle, 'reasonCode') ??
              getString(retry, 'reasonCode') ??
              'deterministic_or_unclassified_failure',
            attemptCount,
          },
          latest,
        );
      }
      if (attemptCount >= SELLERBOARD_UNIT_MAX_ATTEMPTS) {
        return outcome({ status: 'terminal', reason: 'retry_attempts_exhausted', attemptCount }, latest);
      }
      const latestFinishedAt = getDateString(latest, 'finishedAt') ?? getDateString(latest, 'startedAt');
      const derivedNextAttemptAt = latestFinishedAt
        ? new Date(new Date(latestFinishedAt).getTime() + sellerboardUnitRetryDelay(attemptCount)).toISOString()
        : undefined;
      const nextAttemptAt =
        getString(cycle, 'nextAttemptAt') ?? getString(retry, 'nextAttemptAt') ?? derivedNextAttemptAt;
      if (!nextAttemptAt || Number.isNaN(new Date(nextAttemptAt).getTime())) {
        throw new SellerboardUnitReservationError(
          `Ecobase Sellerboard transient failure is missing a valid next-attempt time for ${sourceConnectionId}/${params.report.reportKind}/${params.cycleDate}.`,
        );
      }
      if (params.now.getTime() < new Date(nextAttemptAt).getTime()) {
        return outcome(
          { status: 'waiting_retry', reason: 'transient_retry_not_due', attemptCount, nextAttemptAt },
          latest,
        );
      }
    }

    const attempt = attemptCount + 1;
    if (attempt > SELLERBOARD_UNIT_MAX_ATTEMPTS) {
      return outcome({ status: 'terminal', reason: 'retry_attempts_exhausted', attemptCount });
    }
    const leaseOwner = randomUUID();
    const leaseExpiresAt = new Date(params.now.getTime() + SELLERBOARD_UNIT_LEASE_MS).toISOString();
    const idempotencyKey = `sellerboard-unit-cycle:${sourceConnectionId}:${params.report.reportKind}:${params.cycleDate}:attempt:${attempt}`;
    let reservation: unknown;
    try {
      reservation = await repository.create({
        values: {
          id: randomUUID(),
          sourceConnectionId,
          adapterName: 'sellerboard-api',
          sourceIdentifier: `sellerboard-unit-reservation:${params.report.reportKind}`,
          sourceVersion: params.cycleDate,
          idempotencyKey,
          startedAt: params.now,
          status: 'pending',
          rowCount: 0,
          normalizedCount: 0,
          warningCount: 0,
          errorCount: 0,
          summary: {
            sellerboardUnitCycle: {
              version: 'sellerboard_unit_cycle_v1',
              reportKind: params.report.reportKind,
              cycleDate: params.cycleDate,
              attempt,
              leaseOwner,
              leaseAcquiredAt: params.now.toISOString(),
              leaseExpiresAt,
              recoveryCount: 0,
              classification: 'reserved',
            },
            reportUnitRetry: { attemptCount: attempt, backoffMs: 0, classification: 'reserved' },
          },
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      if (reservationCollisionRetried) {
        throw new SellerboardUnitReservationError(
          `Ecobase Sellerboard unit reservation remained ambiguous after a unique-key collision for ${sourceConnectionId}/${params.report.reportKind}/${params.cycleDate}.`,
        );
      }
      return this.runSellerboardUnitCycle(params, true);
    }
    const reservationId = getString(reservation, 'id');
    if (!reservationId) {
      throw new SellerboardUnitReservationError('Ecobase Sellerboard unit reservation was created without an id.');
    }
    const assertReservation = () => this.assertSellerboardReservation(reservationId, leaseOwner);
    const stopHeartbeat = this.startSellerboardReservationHeartbeat(reservationId, leaseOwner);
    let run: Record<string, unknown>;
    try {
      run = await this.executeSellerboardReportUnit(
        { sourceConnectionId, reportKind: params.report.reportKind },
        {
          sourceIdentifier: `sellerboard-unit:${params.report.reportKind}`,
          sourceVersion: params.cycleDate,
          startedAt: params.now,
          skipExistingNormalizedKinds: ['listing_daily_fact', 'traffic_snapshot'],
          summary: toPlainRecord(toPlainRecord(reservation).summary),
          assertReservation,
        },
      );
    } finally {
      stopHeartbeat();
    }

    const status = getString(run, 'status') ?? 'unknown';
    const result: Record<string, unknown> = outcome({ status, attemptCount: attempt }, run);
    if (status === 'success') {
      const currentReservation = await repository.findOne({ filterByTk: reservationId });
      if (!currentReservation) {
        throw new SellerboardUnitReservationError(
          `Ecobase Sellerboard unit reservation "${reservationId}" disappeared after commit.`,
        );
      }
      const reservationSummary = toPlainRecord(toPlainRecord(currentReservation).summary);
      const committedImportRunId = getString(run, 'id');
      await this.updateSellerboardReservation(repository, reservationId, {
        finishedAt: new Date(),
        status: 'success',
        rowCount: getNumber(run, 'rowCount'),
        normalizedCount: getNumber(run, 'normalizedCount'),
        warningCount: getNumber(run, 'warningCount'),
        errorCount: 0,
        errorMessage: null,
        summary: {
          ...reservationSummary,
          committedImportRunId,
          reportUnitInputDigest: getString(toPlainRecord(run.summary), 'reportUnitInputDigest'),
          sellerboardUnitCycle: {
            ...toPlainRecord(reservationSummary.sellerboardUnitCycle),
            classification: 'succeeded',
            leaseReleasedAt: new Date().toISOString(),
          },
        },
      });
      if (run.reused !== true && params.onCommittedUnit) {
        const importRunId = getString(run, 'id');
        if (!importRunId) {
          result.goldTrigger = { status: 'failed', reasonCode: 'committed_import_run_id_missing' };
        } else {
          try {
            await params.onCommittedUnit({
              sourceConnectionId,
              sourceName: getString(params.sourceConnection, 'name') ?? sourceConnectionId,
              sourceActive: getBoolean(params.sourceConnection, 'active', true),
              scheduleEnabled: this.readSellerboardSchedule(getConfig(params.sourceConnection)).enabled,
              companyId: getString(params.sourceConnection, 'companyId'),
              ...params.report,
              importRunId,
            });
            result.goldTrigger = { status: 'scheduled' };
          } catch (error) {
            result.goldTrigger = {
              status: 'failed',
              reasonCode: 'gold_trigger_scheduling_failed',
              message:
                error instanceof Error ? error.message : 'Gold trigger scheduling failed with a non-Error value.',
            };
          }
        }
      }
      return result;
    }

    const runSummary = toPlainRecord(run.summary);
    const retry = toPlainRecord(runSummary.reportUnitRetry);
    const classification = getString(retry, 'classification') ?? 'non_retryable';
    const reasonCode = getString(retry, 'reasonCode') ?? 'deterministic_or_unclassified_failure';
    const retryDelay = sellerboardUnitRetryDelay(attempt);
    const nextAttemptAt =
      classification === 'retryable_transient' && attempt < SELLERBOARD_UNIT_MAX_ATTEMPTS
        ? new Date(params.now.getTime() + retryDelay).toISOString()
        : null;
    const cycle = {
      ...toPlainRecord(runSummary.sellerboardUnitCycle),
      classification,
      reasonCode,
      nextAttemptAt,
      leaseReleasedAt: new Date().toISOString(),
    };
    await this.updateSellerboardReservation(repository, reservationId, {
      finishedAt: new Date(),
      status: 'failed',
      rowCount: getNumber(run, 'rowCount'),
      normalizedCount: getNumber(run, 'normalizedCount'),
      warningCount: getNumber(run, 'warningCount'),
      errorCount: Math.max(1, getNumber(run, 'errorCount')),
      errorMessage: getString(run, 'errorMessage'),
      summary: {
        ...runSummary,
        committedImportRunId: getString(run, 'id'),
        sellerboardUnitCycle: cycle,
        reportUnitRetry: { ...retry, nextAttemptAt },
      },
    });
    const finalizedRun = toPlainRecord((await repository.findOne({ filterByTk: reservationId })) ?? run);
    result.run = finalizedRun;
    result.reasonCode = reasonCode;
    if (classification !== 'retryable_transient') {
      result.status = 'terminal';
      result.reason = 'non_retryable_daily_cycle';
      return result;
    }
    if (attempt >= SELLERBOARD_UNIT_MAX_ATTEMPTS) {
      result.status = 'terminal';
      result.reason = 'retry_attempts_exhausted';
      return result;
    }
    result.status = 'failed';
    result.retryDelayMinutes = retryDelay / 60_000;
    result.nextAttemptAt = nextAttemptAt;
    return result;
  }

  private async sellerboardCycleRuns(
    sourceConnectionId: string,
    reportKind: SellerboardReportKind,
    cycleDate: string,
    timezone: string,
  ) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const identifiers = [
      `sellerboard-unit-reservation:${reportKind}`,
      `sellerboard:${reportKind}`,
      `sellerboard-scheduled:${reportKind}`,
      `sellerboard-unit-deferral:${reportKind}`,
    ];
    const batches = await Promise.all(
      identifiers.map((sourceIdentifier) =>
        repository.find({
          filter: { sourceConnectionId, sourceIdentifier },
          sort: ['-startedAt'],
          limit: SELLERBOARD_UNIT_MAX_ATTEMPTS + 4,
        }),
      ),
    );
    const unique = new Map<string, Record<string, unknown>>();
    for (const run of batches.flat()) {
      const record = toPlainRecord(run);
      const key = getString(record, 'id') ?? getString(record, 'idempotencyKey');
      if (!key) continue;
      const cycle = toPlainRecord(toPlainRecord(record.summary).sellerboardUnitCycle);
      const deferral = toPlainRecord(toPlainRecord(record.summary).sellerboardUnitDeferral);
      let runCycleDate = getString(cycle, 'cycleDate') ?? getString(deferral, 'cycleDate');
      if (!runCycleDate) {
        const startedAt = getDateString(record, 'startedAt');
        if (!startedAt || Number.isNaN(new Date(startedAt).getTime())) continue;
        runCycleDate = sellerboardScheduleClock(new Date(startedAt), timezone).cycleDate;
      }
      if (runCycleDate === cycleDate) unique.set(key, record);
    }
    const records = [...unique.values()].sort((left, right) =>
      String(getDateString(left, 'startedAt') ?? '').localeCompare(String(getDateString(right, 'startedAt') ?? '')),
    );
    return {
      attempts: records.filter(
        (run) => getString(run, 'sourceIdentifier') !== `sellerboard-unit-deferral:${reportKind}`,
      ),
      deferrals: records.filter(
        (run) => getString(run, 'sourceIdentifier') === `sellerboard-unit-deferral:${reportKind}`,
      ),
    };
  }

  private sellerboardAttemptCount(attempts: Record<string, unknown>[]) {
    return attempts.reduce((maximum, run, index) => {
      const cycle = toPlainRecord(toPlainRecord(run.summary).sellerboardUnitCycle);
      const persistedAttempt = getNumber(cycle, 'attempt');
      return Math.max(maximum, persistedAttempt || index + 1);
    }, 0);
  }

  private async handleActiveSellerboardReservation(params: {
    repository: EcobaseRepository;
    reservation: Record<string, unknown>;
    latestDeferral?: Record<string, unknown>;
    now: Date;
    sourceConnectionId: string;
    report: { reportKind: SellerboardReportKind; reportName: string };
    cycleDate: string;
  }): Promise<Record<string, unknown>> {
    const summary = toPlainRecord(params.reservation.summary);
    const cycle = toPlainRecord(summary.sellerboardUnitCycle);
    const attempt = getNumber(cycle, 'attempt');
    const leaseOwner = getString(cycle, 'leaseOwner');
    const leaseExpiresAt = getString(cycle, 'leaseExpiresAt');
    const recoveryCount = getNumber(cycle, 'recoveryCount');
    if (!attempt || !leaseOwner || !leaseExpiresAt || Number.isNaN(new Date(leaseExpiresAt).getTime())) {
      throw new SellerboardUnitReservationError(
        `Ecobase Sellerboard unit has ambiguous reservation ownership for ${params.sourceConnectionId}/${params.report.reportKind}/${params.cycleDate}.`,
      );
    }
    const recoveryEligibleAt = new Date(leaseExpiresAt).getTime() + SELLERBOARD_UNIT_LEASE_HEARTBEAT_MS;
    if (params.now.getTime() <= recoveryEligibleAt) {
      const existingDeferral = toPlainRecord(toPlainRecord(params.latestDeferral).summary).sellerboardUnitDeferral;
      const existingNextAttemptAt = getString(existingDeferral, 'nextAttemptAt');
      if (existingNextAttemptAt && params.now.getTime() < new Date(existingNextAttemptAt).getTime()) {
        return {
          sourceConnectionId: params.sourceConnectionId,
          ...params.report,
          status: 'deferred',
          reason: 'unit_already_running',
          sourceVersion: params.cycleDate,
          attemptCount: attempt,
          nextAttemptAt: existingNextAttemptAt,
        };
      }
      return this.persistSellerboardOverlapDeferral({ ...params, attempt });
    }
    if (recoveryCount >= 1) {
      throw new SellerboardUnitReservationError(
        `Ecobase Sellerboard unit has ambiguous expired reservation ownership for ${params.sourceConnectionId}/${params.report.reportKind}/${params.cycleDate}.`,
      );
    }
    const retryDelay = sellerboardUnitRetryDelay(attempt);
    const nextAttemptAt = new Date(params.now.getTime() + retryDelay).toISOString();
    const reservationId = getString(params.reservation, 'id');
    if (!reservationId) {
      throw new SellerboardUnitReservationError('Ecobase expired Sellerboard reservation is missing its id.');
    }
    await this.updateSellerboardReservation(params.repository, reservationId, {
      finishedAt: params.now,
      status: 'failed',
      errorCount: Math.max(1, getNumber(params.reservation, 'errorCount')),
      errorMessage: 'Ecobase Sellerboard unit reservation lease expired before completion.',
      summary: {
        ...summary,
        sellerboardUnitCycle: {
          ...cycle,
          recoveryCount: 1,
          classification: 'retryable_transient',
          reasonCode: 'reservation_lease_expired',
          nextAttemptAt,
          recoveredAt: params.now.toISOString(),
        },
        reportUnitRetry: {
          ...toPlainRecord(summary.reportUnitRetry),
          attemptCount: attempt,
          classification: 'retryable_transient',
          reasonCode: 'reservation_lease_expired',
          nextAttemptAt,
        },
      },
    });
    return {
      sourceConnectionId: params.sourceConnectionId,
      ...params.report,
      status: 'waiting_retry',
      reason: 'expired_lease_recovered',
      sourceVersion: params.cycleDate,
      attemptCount: attempt,
      retryDelayMinutes: retryDelay / 60_000,
      nextAttemptAt,
    };
  }

  private async persistSellerboardOverlapDeferral(params: {
    repository: EcobaseRepository;
    reservation: Record<string, unknown>;
    now: Date;
    sourceConnectionId: string;
    report: { reportKind: SellerboardReportKind; reportName: string };
    cycleDate: string;
    attempt: number;
  }) {
    const reservationId = getString(params.reservation, 'id');
    if (!reservationId) {
      throw new SellerboardUnitReservationError('Ecobase Sellerboard overlap deferral is missing reservation id.');
    }
    const nextAttemptAt = new Date(params.now.getTime() + SELLERBOARD_UNIT_OVERLAP_DELAY_MS).toISOString();
    const bucket = Math.floor(params.now.getTime() / SELLERBOARD_UNIT_OVERLAP_DELAY_MS);
    const idempotencyKey = `sellerboard-unit-cycle:${params.sourceConnectionId}:${params.report.reportKind}:${params.cycleDate}:deferral:${reservationId}:${bucket}`;
    try {
      await params.repository.create({
        values: {
          id: randomUUID(),
          sourceConnectionId: params.sourceConnectionId,
          adapterName: 'sellerboard-api',
          sourceIdentifier: `sellerboard-unit-deferral:${params.report.reportKind}`,
          sourceVersion: params.cycleDate,
          idempotencyKey,
          startedAt: params.now,
          finishedAt: params.now,
          status: 'skipped',
          rowCount: 0,
          normalizedCount: 0,
          warningCount: 0,
          errorCount: 0,
          errorMessage: 'Sellerboard unit execution deferred because the same unit is already running.',
          summary: {
            sellerboardUnitDeferral: {
              reportKind: params.report.reportKind,
              cycleDate: params.cycleDate,
              blockingReservationId: reservationId,
              attempt: params.attempt,
              nextAttemptAt,
              reasonCode: 'unit_already_running',
            },
          },
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
    return {
      sourceConnectionId: params.sourceConnectionId,
      ...params.report,
      status: 'deferred',
      reason: 'unit_already_running',
      sourceVersion: params.cycleDate,
      attemptCount: params.attempt,
      nextAttemptAt,
    };
  }

  private async updateSellerboardReservation(
    repository: EcobaseRepository,
    reservationId: string,
    values: Record<string, unknown>,
  ) {
    try {
      await repository.update({ filterByTk: reservationId, values });
    } catch (error) {
      throw new SellerboardUnitReservationError(
        `Ecobase Sellerboard unit reservation "${reservationId}" could not be persisted: ${
          error instanceof Error ? error.message : 'repository returned a non-Error failure'
        }.`,
      );
    }
  }

  private async assertSellerboardReservation(reservationId: string, leaseOwner: string) {
    const reservation = await this.db
      .getRepository(ECOBASE_COLLECTIONS.importRuns)
      .findOne({ filterByTk: reservationId });
    const cycle = toPlainRecord(toPlainRecord(toPlainRecord(reservation).summary).sellerboardUnitCycle);
    if (getString(reservation, 'status') !== 'pending' || getString(cycle, 'leaseOwner') !== leaseOwner) {
      throw new SellerboardUnitReservationError(
        `Ecobase Sellerboard unit reservation "${reservationId}" lost ownership before commit.`,
      );
    }
  }

  private startSellerboardReservationHeartbeat(reservationId: string, leaseOwner: string) {
    let stopped = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (stopped || renewing) return;
      renewing = true;
      void (async () => {
        const repository = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
        const reservation = await repository.findOne({ filterByTk: reservationId });
        const summary = toPlainRecord(toPlainRecord(reservation).summary);
        const cycle = toPlainRecord(summary.sellerboardUnitCycle);
        if (getString(reservation, 'status') !== 'pending' || getString(cycle, 'leaseOwner') !== leaseOwner) {
          return;
        }
        await repository.update({
          filterByTk: reservationId,
          values: {
            summary: {
              ...summary,
              sellerboardUnitCycle: {
                ...cycle,
                leaseExpiresAt: new Date(Date.now() + SELLERBOARD_UNIT_LEASE_MS).toISOString(),
                leaseHeartbeatAt: new Date().toISOString(),
              },
            },
          },
        });
      })()
        .catch(() => undefined)
        .finally(() => {
          renewing = false;
        });
    }, SELLERBOARD_UNIT_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private readSellerboardSchedule(config: Record<string, unknown>) {
    const schedule = isRecord(config.schedule) ? config.schedule : {};
    const enabled = schedule.enabled === true || config.scheduleEnabled === true;
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
    const timezone =
      (typeof config.timezone === 'string' && config.timezone.trim()) ||
      (typeof schedule.timezone === 'string' && schedule.timezone.trim()) ||
      'Asia/Karachi';
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
      timezone,
      dailyRefreshTime,
      dailyMinuteOfDay: hours * 60 + minutes,
      refreshIntervalMinutes,
      retryIntervalMinutes,
    };
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
