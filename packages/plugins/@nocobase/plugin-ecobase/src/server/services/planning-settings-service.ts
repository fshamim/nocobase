import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';

export type PlanningSettingKey =
  | 'safetyBufferDays'
  | 'reorderCycleDays'
  | 'orderSoonWindowDays'
  | 'leadTimeFreshnessDays'
  | 'purchasedPipelineGraceDays';

export type EcobasePlanningSettings = Record<PlanningSettingKey, number> & {
  id?: string;
  name: string;
  isActive: boolean;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type SaveEcobasePlanningSettingsParams = Partial<Record<PlanningSettingKey, unknown>> & {
  id?: string;
  name?: string;
  isActive?: boolean;
  updatedBy?: string;
};

const SETTING_KEYS: PlanningSettingKey[] = [
  'safetyBufferDays',
  'reorderCycleDays',
  'orderSoonWindowDays',
  'leadTimeFreshnessDays',
  'purchasedPipelineGraceDays',
];

export const DEFAULT_PLANNING_SETTINGS: Record<PlanningSettingKey, number> = {
  safetyBufferDays: 7,
  reorderCycleDays: 30,
  orderSoonWindowDays: 14,
  leadTimeFreshnessDays: 60,
  purchasedPipelineGraceDays: 3,
};

const SETTING_LABELS: Record<PlanningSettingKey, string> = {
  safetyBufferDays: 'Safety buffer days',
  reorderCycleDays: 'Reorder cycle days',
  orderSoonWindowDays: 'Order-soon window days',
  leadTimeFreshnessDays: 'Lead-time freshness days',
  purchasedPipelineGraceDays: 'Purchased pipeline grace days',
};

type PlainRecord = Record<string, unknown>;

function toPlainRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function positiveInteger(value: unknown, key: PlanningSettingKey): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`EcoBase planning settings require ${SETTING_LABELS[key]} to be a zero-or-positive whole number.`);
  }
  return number;
}

function defaultSettings(): EcobasePlanningSettings {
  return {
    name: 'Default planning settings',
    isActive: true,
    ...DEFAULT_PLANNING_SETTINGS,
  };
}

function normalize(row: PlainRecord): EcobasePlanningSettings {
  const defaults = defaultSettings();
  return {
    id: asString(row.id),
    name: asString(row.name) ?? defaults.name,
    isActive: asBoolean(row.isActive, true),
    safetyBufferDays: positiveInteger(row.safetyBufferDays, 'safetyBufferDays') ?? defaults.safetyBufferDays,
    reorderCycleDays: positiveInteger(row.reorderCycleDays, 'reorderCycleDays') ?? defaults.reorderCycleDays,
    orderSoonWindowDays:
      positiveInteger(row.orderSoonWindowDays, 'orderSoonWindowDays') ?? defaults.orderSoonWindowDays,
    leadTimeFreshnessDays:
      positiveInteger(row.leadTimeFreshnessDays, 'leadTimeFreshnessDays') ?? defaults.leadTimeFreshnessDays,
    purchasedPipelineGraceDays:
      positiveInteger(row.purchasedPipelineGraceDays, 'purchasedPipelineGraceDays') ??
      defaults.purchasedPipelineGraceDays,
    updatedBy: asString(row.updatedBy),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
  };
}

export function resolvePlanningSettings(
  settings: EcobasePlanningSettings,
  overrides: Partial<Record<PlanningSettingKey, unknown>> = {},
) {
  const resolved = { ...settings };
  for (const key of SETTING_KEYS) {
    resolved[key] = positiveInteger(overrides[key], key) ?? settings[key];
  }
  return resolved;
}

export class EcobasePlanningSettingsService {
  constructor(private db: EcobaseDatabase) {}

  async getActiveSettings() {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.planningSettings);
    const rows = (await repository.find({ filter: { isActive: true }, sort: ['-updatedAt'], limit: 20 }))
      .map(toPlainRecord)
      .map(normalize);
    const settings = rows[0] ?? defaultSettings();
    return {
      settings,
      defaults: DEFAULT_PLANNING_SETTINGS,
      warning:
        rows.length > 1 ? 'Multiple active EcoBase planning settings rows found; using latest updated row.' : undefined,
    };
  }

  async getResolvedSettings(overrides: Partial<Record<PlanningSettingKey, unknown>> = {}) {
    const { settings } = await this.getActiveSettings();
    return resolvePlanningSettings(settings, overrides);
  }

  async saveSettings(params: SaveEcobasePlanningSettingsParams = {}) {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.planningSettings);
    const now = new Date().toISOString();
    const active = await this.getActiveSettings();
    const current = active.settings;
    const existing = current.id ? toPlainRecord(await repository.findOne({ filterByTk: current.id })) : {};
    const id = asString(params.id) ?? asString(existing.id) ?? randomUUID();
    const values: PlainRecord = {
      id,
      name: asString(params.name) ?? asString(existing.name) ?? 'Default planning settings',
      isActive: params.isActive !== false,
      updatedBy: asString(params.updatedBy),
      createdAt: asString(existing.createdAt) ?? now,
      updatedAt: now,
    };
    for (const key of SETTING_KEYS) {
      values[key] =
        positiveInteger(params[key], key) ?? positiveInteger(existing[key], key) ?? DEFAULT_PLANNING_SETTINGS[key];
    }
    if (existing.id) {
      await repository.update({ filterByTk: id, values });
    } else {
      await repository.create({ values });
    }
    return normalize(toPlainRecord(await repository.findOne({ filterByTk: id })));
  }

  async resetSettings() {
    return this.saveSettings({ ...DEFAULT_PLANNING_SETTINGS, name: 'Default planning settings' });
  }
}
