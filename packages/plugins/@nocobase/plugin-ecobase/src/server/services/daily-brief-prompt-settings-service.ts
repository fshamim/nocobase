import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

type PlainRecord = Record<string, unknown>;

export type DailyBriefPromptSettings = {
  id?: string;
  name: string;
  isActive: boolean;
  company?: string;
  audience?: string;
  tone?: string;
  directorInstructions?: string;
  mustInclude: string[];
  mustAvoid: string[];
  kpiPriority: string[];
  llmService?: string;
  model?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type SaveDailyBriefPromptSettingsParams = Partial<DailyBriefPromptSettings> & { company?: string };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((item): item is string => Boolean(item));
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalize(row: PlainRecord): DailyBriefPromptSettings {
  return {
    id: asString(row.id),
    name: asString(row.name) ?? 'Default director brief',
    isActive: asBoolean(row.isActive, true),
    company: asString(row.company),
    audience: asString(row.audience),
    tone: asString(row.tone),
    directorInstructions: asString(row.directorInstructions),
    mustInclude: stringList(row.mustInclude),
    mustAvoid: stringList(row.mustAvoid),
    kpiPriority: stringList(row.kpiPriority),
    llmService: asString(row.llmService),
    model: asString(row.model),
    updatedBy: asString(row.updatedBy),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
  };
}

function defaultSettings(company?: string): DailyBriefPromptSettings {
  return {
    name: company ? `${company} director brief` : 'Default director brief',
    isActive: true,
    company,
    audience: 'Directors',
    tone: 'direct',
    directorInstructions: '',
    mustInclude: [],
    mustAvoid: [],
    kpiPriority: [],
  };
}

export class EcobaseDailyBriefPromptSettingsService {
  constructor(private db: EcobaseDatabase) {}

  async getActiveSettings(company?: string) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.dailyBriefPromptSettings);
    const rows = (await repository.find({ filter: { isActive: true }, sort: ['-updatedAt'], limit: 100 }))
      .map(toPlainRecord)
      .map(normalize);
    const companySetting = company ? rows.find((row) => row.company === company) : undefined;
    const globalSetting = rows.find((row) => !row.company);
    const selected = companySetting ?? globalSetting ?? defaultSettings(company);
    const duplicateActiveCount = rows.filter((row) => (company ? row.company === company : !row.company)).length;
    return {
      settings: selected,
      warning:
        duplicateActiveCount > 1
          ? `Multiple active daily brief prompt settings found for ${company ?? 'global'}; using latest updated row.`
          : undefined,
    };
  }

  async saveSettings(params: SaveDailyBriefPromptSettingsParams) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.dailyBriefPromptSettings);
    const now = new Date().toISOString();
    const id = asString(params.id) ?? randomUUID();
    const company = asString(params.company);
    const existing = asString(params.id)
      ? toPlainRecord(await repository.findOne({ filterByTk: id }))
      : toPlainRecord(await repository.findOne({ filter: { company: company ?? null, isActive: true } }));
    const nextId = asString(existing.id) ?? id;
    const values = {
      id: nextId,
      name: asString(params.name) ?? asString(existing.name) ?? 'Default director brief',
      isActive: params.isActive !== false,
      company: company ?? null,
      audience: asString(params.audience),
      tone: asString(params.tone),
      directorInstructions: asString(params.directorInstructions) ?? '',
      mustInclude: stringList(params.mustInclude),
      mustAvoid: stringList(params.mustAvoid),
      kpiPriority: stringList(params.kpiPriority),
      llmService: asString(params.llmService),
      model: asString(params.model),
      updatedBy: asString(params.updatedBy),
      createdAt: asString(existing.createdAt) ?? now,
      updatedAt: now,
    };
    if (existing.id) {
      await repository.update({ filterByTk: nextId, values });
    } else {
      await repository.create({ values });
    }
    return normalize(toPlainRecord(await repository.findOne({ filterByTk: nextId })));
  }

  async resetSettings(company?: string) {
    return this.saveSettings({ ...defaultSettings(company), company });
  }
}
