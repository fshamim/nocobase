import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from './import-service';
import { toPlainRecord } from './import-service';

type DestroyableRepository = EcobaseRepository & {
  destroy?: (params: { filterByTk?: string | number; filter?: Record<string, unknown> }) => Promise<unknown>;
};

type SellerboardReportCategory = 'profit_dashboard' | 'stock_daily' | 'profit_by_product_daily';

type SellerboardReportUrl = {
  name: string;
  category: SellerboardReportCategory;
  url: string;
};

type SaveSellerboardSourceParams = {
  sourceConnectionId?: string;
  name?: string;
  companyName?: string;
  timezone?: string;
  reportUrls?: unknown;
  dailyRefreshTime?: string;
  refreshIntervalMinutes?: number;
  retryIntervalMinutes?: number;
  freshnessSlaMinutes?: number;
  active?: boolean;
  scheduleEnabled?: boolean;
};

function getString(record: unknown, key: string): string | undefined {
  const value = toPlainRecord(record)[key];
  return typeof value === 'string' ? value : undefined;
}

function getDisplayString(record: unknown, key: string): string | undefined {
  const value = toPlainRecord(record)[key];
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return undefined;
}

function getBoolean(record: unknown, key: string, fallback: boolean): boolean {
  const value = toPlainRecord(record)[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getNumber(record: unknown, key: string): number | undefined {
  const value = toPlainRecord(record)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getConfig(record: unknown): Record<string, unknown> {
  const value = toPlainRecord(record).config;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeDailyRefreshTime(value: string | undefined) {
  const dailyRefreshTime = value?.trim() || '00:00';
  const match = dailyRefreshTime.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Ecobase Sellerboard source save failed: dailyRefreshTime "${dailyRefreshTime}" must use HH:mm.`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Ecobase Sellerboard source save failed: dailyRefreshTime "${dailyRefreshTime}" is outside 00:00-23:59.`);
  }
  return dailyRefreshTime;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`Ecobase Sellerboard source save failed: ${fieldName} must be a positive integer.`);
  }
  return result;
}

function normalizeReportCategory(value: unknown): SellerboardReportCategory {
  if (value === 'profit_dashboard' || value === 'stock_daily' || value === 'profit_by_product_daily') {
    return value;
  }
  throw new Error(
    `Ecobase Sellerboard source save failed: report category must be profit_dashboard, stock_daily, or profit_by_product_daily.`,
  );
}

function normalizeReportUrls(value: unknown): SellerboardReportUrl[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Ecobase Sellerboard source save failed: at least one Sellerboard report URL is required.');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Ecobase Sellerboard source save failed: report URL row ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`Ecobase Sellerboard source save failed: report URL row ${index + 1} must be an http(s) URL.`);
    }
    return {
      name:
        typeof record.name === 'string' && record.name.trim().length > 0
          ? record.name.trim()
          : `Sellerboard report ${index + 1}`,
      category: normalizeReportCategory(record.category),
      url,
    };
  });
}

function readReportUrls(config: Record<string, unknown>): SellerboardReportUrl[] {
  const reportUrls = config.reportUrls;
  if (!Array.isArray(reportUrls)) {
    return [];
  }
  return reportUrls.flatMap((entry): SellerboardReportUrl[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : undefined;
    const category = typeof record.category === 'string' ? record.category : undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    if (!name || !category || !url) {
      return [];
    }
    if (category !== 'profit_dashboard' && category !== 'stock_daily' && category !== 'profit_by_product_daily') {
      return [];
    }
    return [{ name, category, url }];
  });
}

function readSchedule(config: Record<string, unknown>) {
  const schedule =
    typeof config.schedule === 'object' && config.schedule !== null ? (config.schedule as Record<string, unknown>) : {};
  return {
    enabled: schedule.enabled !== false && config.scheduleEnabled !== false,
    dailyRefreshTime:
      typeof schedule.dailyRefreshTime === 'string'
        ? schedule.dailyRefreshTime
        : typeof config.dailyRefreshTime === 'string'
          ? config.dailyRefreshTime
          : '00:00',
    refreshIntervalMinutes:
      typeof schedule.refreshIntervalMinutes === 'number'
        ? schedule.refreshIntervalMinutes
        : typeof config.refreshIntervalMinutes === 'number'
          ? config.refreshIntervalMinutes
          : 1440,
    retryIntervalMinutes:
      typeof schedule.retryIntervalMinutes === 'number'
        ? schedule.retryIntervalMinutes
        : typeof config.retryIntervalMinutes === 'number'
          ? config.retryIntervalMinutes
          : 60,
  };
}

function payloadPreview(record: unknown) {
  const payload = toPlainRecord(record).payload;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const preview: Record<string, unknown> = {};
  Object.entries(payload as Record<string, unknown>)
    .slice(0, 6)
    .forEach(([key, value]) => {
      preview[key] = value;
    });
  return preview;
}

function repoWithDestroy(repository: EcobaseRepository, collectionName: string): DestroyableRepository {
  const destroyable = repository as DestroyableRepository;
  if (typeof destroyable.destroy !== 'function') {
    throw new Error(`Ecobase source connection cleanup failed: ${collectionName} repository does not support destroy.`);
  }
  return destroyable;
}

export class EcobaseSourceConnectionService {
  constructor(private db: EcobaseDatabase) {}

  async listSellerboardSources() {
    const sourceRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const companyRepo = this.db.getRepository(ECOBASE_COLLECTIONS.companies);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const rawImportRowRepo = this.db.getRepository(ECOBASE_COLLECTIONS.rawImportRows);
    const sources = await sourceRepo.find({ filter: { sourceType: 'sellerboard' }, sort: ['name'] });

    return Promise.all(
      sources.map(async (source) => {
        const sourceConnectionId = getString(source, 'id');
        if (!sourceConnectionId) {
          throw new Error('Ecobase Sellerboard source list failed: source connection record is missing id.');
        }
        const sourceRecord = toPlainRecord(source);
        const companyId = getString(sourceRecord, 'companyId');
        const company = companyId ? await companyRepo.findOne({ filterByTk: companyId }) : null;
        const config = getConfig(source);
        const recentRuns = await importRunRepo.find({ filter: { sourceConnectionId }, sort: ['-startedAt'], limit: 5 });
        const latestRun = recentRuns[0] ?? null;
        const latestRunLogs = await Promise.all(
          recentRuns.map(async (run) => {
            const importRunId = getString(run, 'id');
            const rawRows = importRunId
              ? await rawImportRowRepo.find({ filter: { importRunId }, sort: ['rowNumber'] })
              : [];
            const issues = rawRows
              .filter((rawRow) => {
                const severity = getString(rawRow, 'issueSeverity');
                const normalizedStatus = getString(rawRow, 'normalizedStatus');
                return Boolean(severity) || (Boolean(normalizedStatus) && normalizedStatus !== 'success');
              })
              .slice(0, 20)
              .map((rawRow) => ({
                rowNumber: getNumber(rawRow, 'rowNumber') ?? null,
                sourceKey: getString(rawRow, 'sourceKey') ?? null,
                severity: getString(rawRow, 'issueSeverity') ?? null,
                code: getString(rawRow, 'issueCode') ?? null,
                status: getString(rawRow, 'normalizedStatus') ?? null,
                message: getString(rawRow, 'normalizedError') ?? null,
                payloadPreview: payloadPreview(rawRow),
              }));
            return {
              importRunId: importRunId ?? null,
              status: getString(run, 'status') ?? null,
              startedAt: getDisplayString(run, 'startedAt') ?? null,
              finishedAt: getDisplayString(run, 'finishedAt') ?? null,
              sourceIdentifier: getString(run, 'sourceIdentifier') ?? null,
              sourceVersion: getDisplayString(run, 'sourceVersion') ?? null,
              rowCount: getNumber(run, 'rowCount') ?? 0,
              normalizedCount: getNumber(run, 'normalizedCount') ?? 0,
              warningCount: getNumber(run, 'warningCount') ?? 0,
              errorCount: getNumber(run, 'errorCount') ?? 0,
              errorMessage: getString(run, 'errorMessage') ?? null,
              issues,
            };
          }),
        );
        return {
          sourceConnectionId,
          name: getString(source, 'name') ?? '(unnamed Sellerboard source)',
          companyId: companyId ?? null,
          companyName: getString(company, 'name') ?? null,
          timezone: getString(company, 'timezone') ?? null,
          active: getBoolean(source, 'active', true),
          freshnessSlaMinutes: getNumber(source, 'freshnessSlaMinutes') ?? null,
          reportUrls: readReportUrls(config),
          schedule: readSchedule(config),
          latestRunStatus: getString(latestRun, 'status') ?? null,
          latestRunAt: getDisplayString(latestRun, 'finishedAt') ?? getDisplayString(latestRun, 'startedAt') ?? null,
          latestRunRowCount: getNumber(latestRun, 'rowCount') ?? 0,
          latestRunNormalizedCount: getNumber(latestRun, 'normalizedCount') ?? 0,
          latestRunWarningCount: getNumber(latestRun, 'warningCount') ?? 0,
          latestRunErrorCount: getNumber(latestRun, 'errorCount') ?? 0,
          latestRunErrorMessage: getString(latestRun, 'errorMessage') ?? null,
          latestRunLogs,
        };
      }),
    );
  }

  async saveSellerboardSource(params: SaveSellerboardSourceParams) {
    const name = params.name?.trim();
    if (!name) {
      throw new Error('Ecobase Sellerboard source save failed: source name is required.');
    }
    const companyName = params.companyName?.trim();
    if (!companyName) {
      throw new Error('Ecobase Sellerboard source save failed: company name is required.');
    }
    const reportUrls = normalizeReportUrls(params.reportUrls);
    const dailyRefreshTime = normalizeDailyRefreshTime(params.dailyRefreshTime);
    const refreshIntervalMinutes = normalizePositiveInteger(params.refreshIntervalMinutes, 1440, 'refreshIntervalMinutes');
    const retryIntervalMinutes = normalizePositiveInteger(params.retryIntervalMinutes, 60, 'retryIntervalMinutes');
    const freshnessSlaMinutes = normalizePositiveInteger(params.freshnessSlaMinutes, 1440, 'freshnessSlaMinutes');
    const timezone = params.timezone?.trim() || 'Asia/Karachi';

    const companyRepo = this.db.getRepository(ECOBASE_COLLECTIONS.companies);
    const sourceRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    let company = await companyRepo.findOne({ filter: { name: companyName } });
    if (!company) {
      company = await companyRepo.create({
        values: { id: randomUUID(), name: companyName, timezone, active: true },
      });
    }
    const companyId = getString(company, 'id');
    if (!companyId) {
      throw new Error('Ecobase Sellerboard source save failed: company record is missing id.');
    }

    const values = {
      name,
      companyId,
      sourceType: 'sellerboard',
      domain: 'amazon_operations',
      config: {
        reportUrls,
        requireFreshData: true,
        schedule: {
          enabled: params.scheduleEnabled !== false,
          dailyRefreshTime,
          refreshIntervalMinutes,
          retryIntervalMinutes,
        },
      },
      freshnessSlaMinutes,
      active: params.active !== false,
    };

    if (params.sourceConnectionId) {
      const existing = await sourceRepo.findOne({ filterByTk: params.sourceConnectionId });
      if (!existing) {
        throw new Error(`Ecobase Sellerboard source save failed: source connection "${params.sourceConnectionId}" was not found.`);
      }
      if (getString(existing, 'sourceType') !== 'sellerboard') {
        throw new Error(`Ecobase Sellerboard source save failed: source connection "${params.sourceConnectionId}" is not Sellerboard.`);
      }
      await sourceRepo.update({ filterByTk: params.sourceConnectionId, values });
      return (await sourceRepo.findOne({ filterByTk: params.sourceConnectionId })) ?? { id: params.sourceConnectionId, ...values };
    }

    return sourceRepo.create({ values: { id: randomUUID(), ...values } });
  }

  async deleteSellerboardSource(sourceConnectionId: string) {
    const sourceRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const source = await sourceRepo.findOne({ filterByTk: sourceConnectionId });
    if (!source) {
      throw new Error(`Ecobase Sellerboard source delete failed: source connection "${sourceConnectionId}" was not found.`);
    }
    if (getString(source, 'sourceType') !== 'sellerboard') {
      throw new Error(`Ecobase Sellerboard source delete failed: source connection "${sourceConnectionId}" is not Sellerboard.`);
    }
    await repoWithDestroy(sourceRepo, ECOBASE_COLLECTIONS.sourceConnections).destroy?.({ filterByTk: sourceConnectionId });
    return { sourceConnectionId, deleted: true };
  }
}
