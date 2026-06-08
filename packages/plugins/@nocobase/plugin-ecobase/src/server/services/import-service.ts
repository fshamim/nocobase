import { randomUUID } from 'node:crypto';
import type { AdapterStreamItem, NormalizedRecord, SourceAdapter, SourceAdapterRegistry } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseAccountabilityService } from './accountability-service';
import { EcobaseDataWarningService } from './data-warning-service';
import type { EcobaseDataWarning } from './data-warning-service';
import { EcobasePlanningProductService } from './planning-product-service';
import { EcobaseSupplierOrderService, validateSupplierLeadTimeDays } from './supplier-order-service';

type Filter = Record<string, unknown>;

type RepositoryFindParams = {
  filter?: Filter;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
};

type RepositoryCreateParams = { values: Record<string, unknown> };
type RepositoryUpdateParams = { filterByTk?: string | number; filter?: Filter; values: Record<string, unknown> };

type ImportFileSummary = {
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  sampleMappedRecord?: Record<string, unknown>;
};

const NORMALIZED_RECORD_COLLECTIONS: Record<string, string> = {
  raw_listing: ECOBASE_COLLECTIONS.rawListings,
  listing_daily_fact: ECOBASE_COLLECTIONS.listingDailyFacts,
  inventory_snapshot: ECOBASE_COLLECTIONS.inventorySnapshots,
  traffic_snapshot: ECOBASE_COLLECTIONS.trafficSnapshots,
  planning_parameter: ECOBASE_COLLECTIONS.planningParameters,
  supplier: ECOBASE_COLLECTIONS.suppliers,
  supplier_lead_time: ECOBASE_COLLECTIONS.supplierLeadTimes,
  target_row: ECOBASE_COLLECTIONS.targetRows,
  source_access_audit: ECOBASE_COLLECTIONS.sourceAccessAudits,
  clickup_task_snapshot: ECOBASE_COLLECTIONS.clickupTaskSnapshots,
  task_link: ECOBASE_COLLECTIONS.taskLinks,
  okr: ECOBASE_COLLECTIONS.okrs,
  okr_metric_snapshot: ECOBASE_COLLECTIONS.okrMetricSnapshots,
};

const ACCOUNTABILITY_RECORD_KINDS = new Set(['clickup_task_snapshot', 'task_link', 'okr', 'okr_metric_snapshot']);

export interface EcobaseRepository {
  find(params?: RepositoryFindParams): Promise<unknown[]>;
  findOne(params?: RepositoryFindParams): Promise<unknown | null>;
  create(params: RepositoryCreateParams): Promise<unknown>;
  update(params: RepositoryUpdateParams): Promise<unknown>;
}

export interface EcobaseDatabase {
  getRepository(name: string): EcobaseRepository;
}

export interface RunNoopImportParams {
  sourceConnectionId: string;
  sourceIdentifier?: string;
  sourceVersion?: string;
  idempotencyKey?: string;
  preserveAuditRun?: boolean;
  skipIfNoNewerData?: boolean;
  skipExistingNormalizedKinds?: string[];
}

export interface RunScheduledSellerboardImportsParams {
  now?: string;
  sourceConnectionId?: string;
}

export interface SourceStatusView {
  sourceConnectionId: string;
  connectionName: string;
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

function hasField(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireNumberField(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`${context}: ${key} must be a number.`);
  }
  return value;
}

function getOptionalNumberField(record: Record<string, unknown>, key: string, context: string): number | undefined {
  if (!hasField(record, key) || record[key] === undefined) {
    return undefined;
  }
  return requireNumberField(record, key, context);
}

function getConfig(record: unknown): Record<string, unknown> {
  const config = toPlainRecord(record).config;
  return isRecord(config) ? config : {};
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

export class EcobaseImportService {
  constructor(
    private db: EcobaseDatabase,
    private registry: SourceAdapterRegistry,
  ) {}

  async runNoopImport(params: RunNoopImportParams) {
    return this.runAdapterImport({ adapterName: 'noop-test', ...params });
  }

  async runAdapterImport(params: RunNoopImportParams & { adapterName: string }) {
    if (!params.sourceConnectionId) {
      throw new Error('Ecobase import failed: sourceConnectionId is required.');
    }

    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const rawImportRowRepo = this.db.getRepository(ECOBASE_COLLECTIONS.rawImportRows);
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

    const idempotencyKey = existingRun ? `${baseIdempotencyKey}:audit:${randomUUID()}` : baseIdempotencyKey;

    const pendingRun = await importRunRepo.create({
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
    const importRunId = getString(pendingRun, 'id');

    if (!importRunId) {
      throw new Error('Ecobase import failed: import run was created without an id.');
    }

    let rowCount = 0;
    let normalizedCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let errorMessage: string | null = null;
    let statusMessage: string | null = null;
    let firstErrorIssueMessage: string | null = null;
    let finalStatusOverride: string | null = null;
    const skipExistingNormalizedKinds = new Set(params.skipExistingNormalizedKinds ?? []);
    const fileSummaries: Record<string, ImportFileSummary> = {};
    const supplierOrderService = new EcobaseSupplierOrderService(this.db);
    let supplierOrderTouched = false;
    let accountabilityTouched = false;

    try {
      for await (const item of adapter.import({
        sourceConnectionId: params.sourceConnectionId,
        sourceIdentifier,
        sourceVersion,
        idempotencyKey,
        config: getConfig(sourceConnection),
        secretRef: getString(sourceConnection, 'secretRef'),
      })) {
        if (item.type === 'record') {
          const records = Array.isArray(item.record) ? item.record : [item.record];
          const fileName = getSourceFileName(item.sourceKey);
          rowCount += 1;
          const rawRow = await this.createRawRow(rawImportRowRepo, importRunId, item);
          const result = await this.upsertNormalizedRecords(records, importRunId, supplierOrderService, skipExistingNormalizedKinds);
          normalizedCount += result.normalizedCount;
          updateFileSummary(fileSummaries, fileName, { rowCount: 1, normalizedCount: result.normalizedCount });
          supplierOrderTouched = supplierOrderTouched || result.supplierOrderTouched;
          accountabilityTouched = accountabilityTouched || result.accountabilityTouched;
          warningCount += result.warnings.length;
          updateFileSummary(fileSummaries, fileName, {
            warningCount: result.warnings.length,
            sampleMappedRecord: result.sample ?? summarizeRecord(records[0]),
          });
          if (result.warnings.length > 0) {
            const rawRowId = getString(rawRow, 'id');
            if (rawRowId) {
              await rawImportRowRepo.update({
                filterByTk: rawRowId,
                values: {
                  normalizedStatus: 'pending',
                  normalizedError: result.warnings.map((warning) => warning.message).join(' | '),
                  issueSeverity: 'warning',
                  issueCode: result.warnings[0]?.code,
                },
              });
            }
          }
        } else if (item.type === 'rowIssue') {
          const fileName = getSourceFileName(item.issue.sourceKey);
          if (item.issue.rowNumber > 0) {
            rowCount += 1;
            updateFileSummary(fileSummaries, fileName, { rowCount: 1 });
          }
          if (item.issue.severity === 'warning') {
            warningCount += 1;
            updateFileSummary(fileSummaries, fileName, { warningCount: 1 });
          } else {
            errorCount += 1;
            firstErrorIssueMessage = firstErrorIssueMessage ?? item.issue.message;
          }
          await rawImportRowRepo.create({
            values: {
              importRunId,
              rowNumber: item.issue.rowNumber,
              sourceKey: item.issue.sourceKey,
              payload: item.issue.payload ?? {},
              normalizedStatus: item.issue.severity === 'error' ? 'failed' : 'pending',
              normalizedError: item.issue.message,
              issueSeverity: item.issue.severity,
              issueCode: item.issue.code,
            },
          });
        } else {
          finalStatusOverride = item.status;
          if (item.status === 'blocked' || item.status === 'failed') {
            errorMessage = item.message;
          } else {
            statusMessage = item.message;
          }
          await rawImportRowRepo.create({
            values: {
              importRunId,
              rowNumber: 0,
              sourceKey: item.status,
              payload: item.payload ?? {},
              normalizedStatus: item.status,
              normalizedError: item.message,
              issueSeverity: 'warning',
              issueCode: item.status,
            },
          });
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Ecobase import failed: adapter threw a non-Error value.';
      errorCount += 1;
    }

    if (!errorMessage && normalizedCount > 0) {
      await new EcobasePlanningProductService(this.db).syncFromRawListings();
      if (supplierOrderTouched) {
        await supplierOrderService.reconcileAfterImport(importRunId);
      }
      if (accountabilityTouched) {
        await new EcobaseAccountabilityService(this.db).evaluateAccountability({
          sourceConnectionId: params.sourceConnectionId,
          evaluationDate: sourceVersion.slice(0, 10),
        });
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
        summary: { files: fileSummaries },
      },
    });

    const completedRun = await importRunRepo.findOne({ filterByTk: importRunId });
    return toPlainRecord(completedRun ?? pendingRun);
  }

  async listSourceStatuses(): Promise<SourceStatusView[]> {
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
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

        return {
          sourceConnectionId,
          connectionName: getString(sourceConnection, 'name') ?? '(unnamed source)',
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
          (latestScheduledStatus === 'success' || latestScheduledStatus === 'stale' || latestScheduledStatus === 'skipped') &&
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
      if (latestStartedAt && latestStatus !== 'success' && !this.retryDue(now, latestStartedAt, schedule.retryIntervalMinutes)) {
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
      throw new Error(`Ecobase scheduled Sellerboard import failed: dailyRefreshTime "${dailyRefreshTime}" must use HH:mm.`);
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
      throw new Error(`Ecobase scheduled Sellerboard import failed: dailyRefreshTime "${dailyRefreshTime}" is outside 00:00-23:59.`);
    }
    const refreshIntervalMinutes =
      typeof schedule.refreshIntervalMinutes === 'number'
        ? schedule.refreshIntervalMinutes
        : typeof config.refreshIntervalMinutes === 'number'
          ? config.refreshIntervalMinutes
          : 1440;
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
    return { enabled, dailyRefreshTime, dailyMinuteOfDay: hours * 60 + minutes, refreshIntervalMinutes, retryIntervalMinutes };
  }

  private retryDue(now: Date, latestStartedAt: string, retryIntervalMinutes: number) {
    const previous = new Date(latestStartedAt);
    if (Number.isNaN(previous.getTime())) {
      return true;
    }
    return now.getTime() - previous.getTime() >= retryIntervalMinutes * 60 * 1000;
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
        errorMessage: 'Ecobase daily snapshot skipped: no newer source data since the last successful import.',
      },
    });
    return toPlainRecord(skippedRun);
  }

  private async createRawRow(
    rawImportRowRepo: EcobaseRepository,
    importRunId: string,
    item: Extract<AdapterStreamItem, { type: 'record' }>,
  ) {
    return rawImportRowRepo.create({
      values: {
        importRunId,
        rowNumber: item.rowNumber,
        sourceKey: item.sourceKey,
        payload: item.payload,
        normalizedStatus: 'success',
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
      const customResult = await supplierOrderService.applyImportRecord(record as { kind: string; data: Record<string, unknown> }, importRunId);
      if (customResult.handled) {
        supplierOrderTouched = true;
        normalizedCount += 1;
        warnings.push(...customResult.warnings);
        sample = sample ?? customResult.sample;
        continue;
      }

      accountabilityTouched = accountabilityTouched || ACCOUNTABILITY_RECORD_KINDS.has(record.kind);
      const collectionName = NORMALIZED_RECORD_COLLECTIONS[record.kind];
      if (!collectionName) {
        throw new Error(
          `Ecobase import failed: normalized record kind "${record.kind}" is not mapped to a collection.`,
        );
      }
      const values: Record<string, unknown> = { ...record.data, lastImportRunId: importRunId };
      if (record.kind === 'supplier_lead_time') {
        const context = 'Ecobase import failed: supplier_lead_time';
        const leadTimeDays = validateSupplierLeadTimeDays(requireNumberField(values, 'leadTimeDays', context), context);
        if (leadTimeDays === undefined) {
          throw new Error('Ecobase import failed: supplier_lead_time leadTimeDays is required.');
        }
        values.leadTimeDays = leadTimeDays;
      }
      if (record.kind === 'planning_parameter') {
        const context = 'Ecobase import failed: planning_parameter';
        const leadTimeDays = validateSupplierLeadTimeDays(getOptionalNumberField(values, 'leadTimeDays', context), context);
        if (leadTimeDays !== undefined) {
          values.leadTimeDays = leadTimeDays;
        }
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
        await repository.create({ values });
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
