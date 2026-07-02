import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { DEFAULT_PROFIT_TIER_THRESHOLDS, type ProfitTierThresholds } from './profit-tier';
import { normalizeSupplierOrderStatus } from './supplier-order-service';

export type PlanningSettingKey =
  | 'safetyBufferDays'
  | 'reorderCycleDays'
  | 'orderSoonWindowDays'
  | 'leadTimeFreshnessDays'
  | 'purchasedPipelineGraceDays';

type ProfitTierSettingKey = keyof ProfitTierThresholds;
type NumberSettingKey = PlanningSettingKey | ProfitTierSettingKey;

export type SupplierOrderStatusBucketKey =
  | 'supplierOrderPlacedNotPurchasedStatuses'
  | 'supplierOrderPurchasedPipelineStatuses'
  | 'supplierOrderClosedStatuses';

export type SupplierOrderStatusBuckets = Record<SupplierOrderStatusBucketKey, string[]>;

export type EcobasePlanningSettings = Record<NumberSettingKey, number> &
  SupplierOrderStatusBuckets & {
    id?: string;
    name: string;
    isActive: boolean;
    updatedBy?: string;
    createdAt?: string;
    updatedAt?: string;
  };

export type SaveEcobasePlanningSettingsParams = Partial<Record<NumberSettingKey, unknown>> &
  Partial<Record<SupplierOrderStatusBucketKey, unknown>> & {
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

const PROFIT_TIER_SETTING_KEYS: ProfitTierSettingKey[] = [
  'profitTierAThreshold',
  'profitTierBThreshold',
  'profitTierCThreshold',
];

const NUMBER_SETTING_KEYS: NumberSettingKey[] = [...SETTING_KEYS, ...PROFIT_TIER_SETTING_KEYS];

const STATUS_BUCKET_KEYS: SupplierOrderStatusBucketKey[] = [
  'supplierOrderPlacedNotPurchasedStatuses',
  'supplierOrderPurchasedPipelineStatuses',
  'supplierOrderClosedStatuses',
];

export const DEFAULT_PLANNING_SETTINGS: Record<PlanningSettingKey, number> = {
  safetyBufferDays: 7,
  reorderCycleDays: 30,
  orderSoonWindowDays: 14,
  leadTimeFreshnessDays: 60,
  purchasedPipelineGraceDays: 3,
};

export const DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS: SupplierOrderStatusBuckets = {
  supplierOrderPlacedNotPurchasedStatuses: [
    'draft',
    'supplier_contacted',
    'supplier_confirmed',
    'approval_pending',
    'payment_pending',
    'blocked',
  ],
  supplierOrderPurchasedPipelineStatuses: ['paid', 'supplier_preparing', 'shipped_inbound'],
  supplierOrderClosedStatuses: ['completed', 'rejected', 'cancelled'],
};

export const DEFAULT_PLANNING_BUSINESS_RULES: Record<ProfitTierSettingKey, number> & SupplierOrderStatusBuckets = {
  ...DEFAULT_PROFIT_TIER_THRESHOLDS,
  ...DEFAULT_SUPPLIER_ORDER_STATUS_BUCKETS,
};

const SETTING_LABELS: Record<NumberSettingKey, string> = {
  safetyBufferDays: 'Safety buffer days',
  reorderCycleDays: 'Reorder cycle days',
  orderSoonWindowDays: 'Order-soon window days',
  leadTimeFreshnessDays: 'Lead-time freshness days',
  purchasedPipelineGraceDays: 'Purchased pipeline grace days',
  profitTierAThreshold: 'Profit tier A threshold',
  profitTierBThreshold: 'Profit tier B threshold',
  profitTierCThreshold: 'Profit tier C threshold',
};

const STATUS_BUCKET_LABELS: Record<SupplierOrderStatusBucketKey, string> = {
  supplierOrderPlacedNotPurchasedStatuses: 'Placed-not-purchased statuses',
  supplierOrderPurchasedPipelineStatuses: 'Purchased-pipeline statuses',
  supplierOrderClosedStatuses: 'Closed statuses',
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

function positiveInteger(value: unknown, key: NumberSettingKey): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`EcoBase planning settings require ${SETTING_LABELS[key]} to be a zero-or-positive whole number.`);
  }
  return number;
}

function statusList(value: unknown, key: SupplierOrderStatusBucketKey): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : undefined;
  if (!rawValues) {
    throw new Error(`EcoBase planning settings require ${STATUS_BUCKET_LABELS[key]} to be a list of statuses.`);
  }
  const normalized = rawValues
    .map((item) => normalizeSupplierOrderStatus(asString(item)))
    .filter((item): item is string => item.length > 0);
  return [...new Set(normalized)];
}

function validateProfitTiers(settings: Record<ProfitTierSettingKey, number>) {
  if (
    settings.profitTierAThreshold <= settings.profitTierBThreshold ||
    settings.profitTierBThreshold <= settings.profitTierCThreshold
  ) {
    throw new Error('EcoBase profit tier thresholds must descend: A threshold > B threshold > C threshold.');
  }
}

function validateStatusBuckets(settings: SupplierOrderStatusBuckets) {
  const ownerByStatus = new Map<string, SupplierOrderStatusBucketKey>();
  for (const key of STATUS_BUCKET_KEYS) {
    for (const status of settings[key]) {
      const existing = ownerByStatus.get(status);
      if (existing) {
        throw new Error(
          `EcoBase supplier order status "${status}" cannot be in both ${STATUS_BUCKET_LABELS[existing]} and ${STATUS_BUCKET_LABELS[key]}.`,
        );
      }
      ownerByStatus.set(status, key);
    }
  }
}

function defaultSettings(): EcobasePlanningSettings {
  return {
    name: 'Default planning settings',
    isActive: true,
    ...DEFAULT_PLANNING_SETTINGS,
    ...DEFAULT_PLANNING_BUSINESS_RULES,
  };
}

function normalize(row: PlainRecord): EcobasePlanningSettings {
  const defaults = defaultSettings();
  const settings: EcobasePlanningSettings = {
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
    profitTierAThreshold:
      positiveInteger(row.profitTierAThreshold, 'profitTierAThreshold') ?? defaults.profitTierAThreshold,
    profitTierBThreshold:
      positiveInteger(row.profitTierBThreshold, 'profitTierBThreshold') ?? defaults.profitTierBThreshold,
    profitTierCThreshold:
      positiveInteger(row.profitTierCThreshold, 'profitTierCThreshold') ?? defaults.profitTierCThreshold,
    supplierOrderPlacedNotPurchasedStatuses:
      statusList(row.supplierOrderPlacedNotPurchasedStatuses, 'supplierOrderPlacedNotPurchasedStatuses') ??
      defaults.supplierOrderPlacedNotPurchasedStatuses,
    supplierOrderPurchasedPipelineStatuses:
      statusList(row.supplierOrderPurchasedPipelineStatuses, 'supplierOrderPurchasedPipelineStatuses') ??
      defaults.supplierOrderPurchasedPipelineStatuses,
    supplierOrderClosedStatuses:
      statusList(row.supplierOrderClosedStatuses, 'supplierOrderClosedStatuses') ??
      defaults.supplierOrderClosedStatuses,
    updatedBy: asString(row.updatedBy),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
  };
  validateProfitTiers(settings);
  validateStatusBuckets(settings);
  return settings;
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
      defaults: { ...DEFAULT_PLANNING_SETTINGS, ...DEFAULT_PLANNING_BUSINESS_RULES },
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
    for (const key of NUMBER_SETTING_KEYS) {
      values[key] = positiveInteger(params[key], key) ?? positiveInteger(existing[key], key) ?? defaultSettings()[key];
    }
    for (const key of STATUS_BUCKET_KEYS) {
      values[key] = statusList(params[key], key) ?? statusList(existing[key], key) ?? defaultSettings()[key];
    }
    const normalized = normalize(values);
    if (existing.id) {
      await repository.update({ filterByTk: id, values: normalized });
    } else {
      await repository.create({ values: normalized });
    }
    return normalize(toPlainRecord(await repository.findOne({ filterByTk: id })));
  }

  async resetSettings() {
    return this.saveSettings({ ...DEFAULT_PLANNING_SETTINGS, ...DEFAULT_PLANNING_BUSINESS_RULES });
  }
}
