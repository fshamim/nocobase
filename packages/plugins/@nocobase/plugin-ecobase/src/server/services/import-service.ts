import { randomUUID } from 'node:crypto';
import type { AdapterStreamItem, NormalizedRecord, SourceAdapter, SourceAdapterRegistry } from '../adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';

type Filter = Record<string, unknown>;

type RepositoryFindParams = {
  filter?: Filter;
  filterByTk?: string;
  sort?: string[];
  limit?: number;
};

type RepositoryCreateParams = { values: Record<string, unknown> };
type RepositoryUpdateParams = { filterByTk: string; values: Record<string, unknown> };

const NORMALIZED_RECORD_COLLECTIONS: Record<string, string> = {
  raw_listing: ECOBASE_COLLECTIONS.rawListings,
  listing_daily_fact: ECOBASE_COLLECTIONS.listingDailyFacts,
  inventory_snapshot: ECOBASE_COLLECTIONS.inventorySnapshots,
  traffic_snapshot: ECOBASE_COLLECTIONS.trafficSnapshots,
  planning_parameter: ECOBASE_COLLECTIONS.planningParameters,
  target_row: ECOBASE_COLLECTIONS.targetRows,
  source_access_audit: ECOBASE_COLLECTIONS.sourceAccessAudits,
};

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
}

export interface SourceStatusView {
  sourceConnectionId: string;
  connectionName: string;
  sourceType: string;
  domain: string;
  active: boolean;
  latestImportRunId: string | null;
  latestRunStatus: string | null;
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  errorCount: number;
  lastRunAt: string | null;
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
          rowCount += 1;
          normalizedCount += records.length;
          await this.createRawRow(rawImportRowRepo, importRunId, item);
          await this.upsertNormalizedRecords(records, importRunId);
        } else {
          if (item.issue.rowNumber > 0) {
            rowCount += 1;
          }
          if (item.issue.severity === 'warning') {
            warningCount += 1;
          } else {
            errorCount += 1;
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
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Ecobase import failed: adapter threw a non-Error value.';
      errorCount += 1;
    }

    const finishedAt = new Date();
    const status = this.getFinalStatus(errorMessage, errorCount, normalizedCount);
    await importRunRepo.update({
      filterByTk: importRunId,
      values: {
        finishedAt,
        status,
        rowCount,
        normalizedCount,
        warningCount,
        errorCount,
        errorMessage,
      },
    });

    const completedRun = await importRunRepo.findOne({ filterByTk: importRunId });
    return toPlainRecord(completedRun ?? pendingRun);
  }

  async listSourceStatuses(): Promise<SourceStatusView[]> {
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnections = await sourceConnectionRepo.find({ sort: ['name'] });

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

        return {
          sourceConnectionId,
          connectionName: getString(sourceConnection, 'name') ?? '(unnamed source)',
          sourceType: getString(sourceConnection, 'sourceType') ?? '(unknown source type)',
          domain: getString(sourceConnection, 'domain') ?? '(unknown domain)',
          active: getBoolean(sourceConnection, 'active', true),
          latestImportRunId: getString(latestRun, 'id') ?? null,
          latestRunStatus: getString(latestRun, 'status') ?? null,
          rowCount: getNumber(latestRun, 'rowCount'),
          normalizedCount: getNumber(latestRun, 'normalizedCount'),
          warningCount: getNumber(latestRun, 'warningCount'),
          errorCount: getNumber(latestRun, 'errorCount'),
          lastRunAt: getDateString(latestRun, 'finishedAt') ?? getDateString(latestRun, 'startedAt'),
        };
      }),
    );
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
    await rawImportRowRepo.create({
      values: {
        importRunId,
        rowNumber: item.rowNumber,
        sourceKey: item.sourceKey,
        payload: item.payload,
        normalizedStatus: 'success',
      },
    });
  }

  private async upsertNormalizedRecords(records: NormalizedRecord[], importRunId: string) {
    for (const record of records) {
      const collectionName = NORMALIZED_RECORD_COLLECTIONS[record.kind];
      if (!collectionName) {
        throw new Error(
          `Ecobase import failed: normalized record kind "${record.kind}" is not mapped to a collection.`,
        );
      }
      const values = { ...record.data, lastImportRunId: importRunId };
      const naturalKey = getString(values, 'naturalKey');
      if (!naturalKey) {
        throw new Error(`Ecobase import failed: normalized record kind "${record.kind}" is missing naturalKey.`);
      }
      const repository = this.db.getRepository(collectionName);
      const existing = await repository.findOne({ filter: { naturalKey } });
      if (existing) {
        const existingId = getString(existing, 'id');
        if (!existingId) {
          throw new Error(`Ecobase import failed: existing normalized record "${naturalKey}" is missing id.`);
        }
        await repository.update({ filterByTk: existingId, values });
      } else {
        await repository.create({ values });
      }
    }
  }

  private getFinalStatus(errorMessage: string | null, errorCount: number, normalizedCount: number) {
    if (errorMessage) {
      return 'failed';
    }
    if (errorCount > 0 && normalizedCount > 0) {
      return 'partial';
    }
    if (errorCount > 0) {
      return 'failed';
    }
    return 'success';
  }
}
