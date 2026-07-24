/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import Decimal from 'decimal.js';
import type { MonthlyPerformanceCoverageReason } from './monthly-performance';

const DispositionDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export const INVENTORY_FRESHNESS_MAX_AGE_DAYS = 1;

export type RollingVelocityEvidenceStatus = 'trusted_zero' | 'trusted_positive' | 'insufficient_evidence';
// Sparse-tolerant rolling velocity: confidence is graded by how many days in the trailing-30
// window actually carried a fact (feed can miss days; the user will not backfill). ≥1 observed
// day is enough for a velocity — sparseness lowers confidence, never visibility.
export type RollingVelocityConfidence = 'high' | 'medium' | 'low' | 'none';
export const ROLLING_VELOCITY_WINDOW_DAYS = 30;
export const ROLLING_VELOCITY_HIGH_CONFIDENCE_DAYS = 21;
export const ROLLING_VELOCITY_MEDIUM_CONFIDENCE_DAYS = 7;
export type InventoryDisposition = 'none' | 'no_sell_through' | 'over_60_days_cover' | 'insufficient_velocity_evidence';
export type InventoryFreshnessStatus = 'fresh' | 'stale' | 'missing' | 'invalid_future' | 'invalid';
export type PipelineCondition = 'none' | 'active' | 'stalled';

export interface RollingUnitInput {
  date: string;
  units: unknown;
}

export interface InventoryDispositionInput {
  /**
   * Freshness/now reference used only to age the inventory snapshot. Callers pass the
   * freshest data day they hold (never past calculation date) so a uniformly lagging feed
   * does not turn a same-report inventory snapshot stale (D1).
   */
  asOfDate: string;
  /**
   * Anchor for the trailing 30-day rolling velocity window — the latest COVERED sales day
   * (source coverage end), which a lagging feed leaves behind calendar `asOfDate`. Defaults
   * to `asOfDate` so single-date callers (and every existing test) keep prior behavior.
   */
  salesEvidenceAsOfDate?: string;
  coverageReason: MonthlyPerformanceCoverageReason;
  dailyUnits: RollingUnitInput[];
  sellableOnHandStock: unknown;
  inventorySnapshotDate: string | null;
  reservedStock: unknown;
  pipelineStock: unknown;
  orderPipelineStatus: PipelineCondition;
}

export interface InventoryDispositionResult {
  asOfDate: string;
  rollingVelocityWindowStartDate: string;
  rollingVelocityWindowEndDate: string;
  rollingVelocityEvidenceStatus: RollingVelocityEvidenceStatus;
  rollingVelocityReasonCode: MonthlyPerformanceCoverageReason | RollingVelocityEvidenceStatus | 'invalid_units';
  /** Days in the trailing-30 window that carried a fact (the velocity divisor). */
  rollingVelocityCoveredDayCount: number;
  rollingVelocityConfidence: RollingVelocityConfidence;
  rollingUnits30: string | null;
  salesVelocity: string | null;
  sellableOnHandStock: string | null;
  inventorySnapshotDate: string | null;
  inventoryAgeDays: number | null;
  inventoryFreshnessStatus: InventoryFreshnessStatus;
  daysOfCover: string | null;
  inventoryDisposition: InventoryDisposition;
  inventoryDispositionReasonCode: InventoryDisposition;
  reservedStock: string | null;
  pipelineStock: string | null;
  pipelineCondition: PipelineCondition;
}

export class InventoryDispositionError extends Error {
  constructor(
    readonly code:
      | 'ECOBASE_INVENTORY_DISPOSITION_INVALID_DATE'
      | 'ECOBASE_INVENTORY_DISPOSITION_DUPLICATE_ACTIVITY_DATE'
      | 'ECOBASE_INVENTORY_DISPOSITION_ACTIVITY_OUTSIDE_WINDOW'
      | 'ECOBASE_INVENTORY_DISPOSITION_COVERAGE_REASON_INVALID'
      | 'ECOBASE_INVENTORY_DISPOSITION_PIPELINE_STATUS_INVALID',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'InventoryDispositionError';
  }
}

// Coverage-gap reasons (feed missed days) — the rolling window still computes a velocity from
// the observed facts, dividing by observed days. Metric-quality reasons stay non-computing.
const PARTIAL_COVERAGE_REASONS = new Set<MonthlyPerformanceCoverageReason>([
  'coverage_interval_missing',
  'coverage_discontinuous',
  'product_scope_unknown',
]);

const COVERAGE_REASONS = new Set<MonthlyPerformanceCoverageReason>([
  'eligible_complete_month',
  'eligible_partial_month',
  'coverage_interval_missing',
  'coverage_discontinuous',
  'product_scope_unknown',
  'units_metric_incomplete',
  'net_profit_metric_incomplete',
  'metric_normalization_mismatch',
  'invalid_units',
  'missing_net_profit',
]);

function utcDateOnly(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InventoryDispositionError(
      'ECOBASE_INVENTORY_DISPOSITION_INVALID_DATE',
      `EcoBase inventory disposition requires ${field} as a valid UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new InventoryDispositionError(
      'ECOBASE_INVENTORY_DISPOSITION_INVALID_DATE',
      `EcoBase inventory disposition requires ${field} as a valid UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  return date;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function decimalValue(value: unknown) {
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string' && !Decimal.isDecimal(value)) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  try {
    const parsed = new DispositionDecimal(value as Decimal.Value);
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nonNegativeDecimal(value: unknown) {
  const parsed = decimalValue(value);
  return parsed && !parsed.isNegative() ? parsed : undefined;
}

function fixed8(value: Decimal | null | undefined) {
  return value ? value.toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN).toFixed(8) : null;
}

function daysBetween(later: Date, earlier: Date) {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

export function calculateInventoryDisposition(input: InventoryDispositionInput): InventoryDispositionResult {
  const asOf = utcDateOnly(input.asOfDate, 'asOfDate');
  // D1: the rolling velocity window ends at the sales evidence as-of (latest covered sales
  // day), not calendar `asOfDate`; a normally-lagging feed then shortens nothing. Inventory
  // freshness below still ages against `asOfDate`.
  const salesEvidenceAsOf = utcDateOnly(input.salesEvidenceAsOfDate ?? input.asOfDate, 'salesEvidenceAsOfDate');
  const rollingVelocityWindowEndDate = isoDate(salesEvidenceAsOf);
  const rollingVelocityWindowStartDate = isoDate(new Date(salesEvidenceAsOf.getTime() - 29 * 86_400_000));
  if (!COVERAGE_REASONS.has(input.coverageReason)) {
    throw new InventoryDispositionError(
      'ECOBASE_INVENTORY_DISPOSITION_COVERAGE_REASON_INVALID',
      `EcoBase inventory disposition received unsupported coverage reason "${input.coverageReason}".`,
      { coverageReason: input.coverageReason },
    );
  }
  if (!['none', 'active', 'stalled'].includes(input.orderPipelineStatus)) {
    throw new InventoryDispositionError(
      'ECOBASE_INVENTORY_DISPOSITION_PIPELINE_STATUS_INVALID',
      `EcoBase order pipeline status must be none, active, or stalled; received "${input.orderPipelineStatus}".`,
      { orderPipelineStatus: input.orderPipelineStatus },
    );
  }

  const activityDates = new Set<string>();
  const sortedActivity = [...input.dailyUnits].sort((left, right) => left.date.localeCompare(right.date));
  for (const activity of sortedActivity) {
    const date = isoDate(utcDateOnly(activity.date, 'dailyUnits.date'));
    if (date < rollingVelocityWindowStartDate || date > rollingVelocityWindowEndDate) {
      throw new InventoryDispositionError(
        'ECOBASE_INVENTORY_DISPOSITION_ACTIVITY_OUTSIDE_WINDOW',
        `EcoBase daily activity date ${date} is outside rolling window ${rollingVelocityWindowStartDate} through ${rollingVelocityWindowEndDate}.`,
        { date, rollingVelocityWindowStartDate, rollingVelocityWindowEndDate },
      );
    }
    if (activityDates.has(date)) {
      throw new InventoryDispositionError(
        'ECOBASE_INVENTORY_DISPOSITION_DUPLICATE_ACTIVITY_DATE',
        `EcoBase inventory disposition received duplicate daily activity date ${date}.`,
        { date },
      );
    }
    activityDates.add(date);
  }

  const unitValues = sortedActivity.map((activity) => nonNegativeDecimal(activity.units));
  const unitsValid = unitValues.every((value) => value !== undefined);
  const rollingVelocityCoveredDayCount = unitValues.length;
  const rollingWindowComplete = input.coverageReason === 'eligible_complete_month';
  const rollingWindowPartial = PARTIAL_COVERAGE_REASONS.has(input.coverageReason);
  let rollingVelocityEvidenceStatus: RollingVelocityEvidenceStatus = 'insufficient_evidence';
  let rollingVelocityReasonCode: InventoryDispositionResult['rollingVelocityReasonCode'] = input.coverageReason;
  let rollingVelocityConfidence: RollingVelocityConfidence = 'none';
  let rollingUnits30: Decimal | null = null;
  let salesVelocity: Decimal | null = null;
  if (!unitsValid) {
    rollingVelocityReasonCode = 'invalid_units';
  } else if (rollingWindowComplete) {
    // Full coverage vouches for every one of the 30 window days: a missing daily fact is a real
    // zero-sales day, so divide by the whole window (0 facts ⇒ trusted_zero) at high confidence.
    rollingUnits30 = unitValues.reduce<Decimal>(
      (total, value) => total.plus(value as Decimal),
      new DispositionDecimal(0),
    );
    salesVelocity = rollingUnits30.div(ROLLING_VELOCITY_WINDOW_DAYS);
    rollingVelocityEvidenceStatus = rollingUnits30.isZero() ? 'trusted_zero' : 'trusted_positive';
    rollingVelocityReasonCode = rollingVelocityEvidenceStatus;
    rollingVelocityConfidence = 'high';
  } else if (rollingWindowPartial && rollingVelocityCoveredDayCount >= 1) {
    // Coverage gap: a missing daily fact is UNKNOWN, not zero — divide by the OBSERVED days only
    // (never 30, which would understate a real seller) and grade confidence by observed days.
    rollingUnits30 = unitValues.reduce<Decimal>(
      (total, value) => total.plus(value as Decimal),
      new DispositionDecimal(0),
    );
    salesVelocity = rollingUnits30.div(rollingVelocityCoveredDayCount);
    rollingVelocityEvidenceStatus = rollingUnits30.isZero() ? 'trusted_zero' : 'trusted_positive';
    rollingVelocityReasonCode = rollingVelocityEvidenceStatus;
    rollingVelocityConfidence =
      rollingVelocityCoveredDayCount >= ROLLING_VELOCITY_HIGH_CONFIDENCE_DAYS
        ? 'high'
        : rollingVelocityCoveredDayCount >= ROLLING_VELOCITY_MEDIUM_CONFIDENCE_DAYS
          ? 'medium'
          : 'low';
  }

  const sellableOnHandStock = nonNegativeDecimal(input.sellableOnHandStock);
  let inventoryAgeDays: number | null = null;
  let inventoryFreshnessStatus: InventoryFreshnessStatus;
  let inventorySnapshotDate: string | null = null;
  if (!sellableOnHandStock) {
    inventoryFreshnessStatus = 'invalid';
  } else if (!input.inventorySnapshotDate) {
    inventoryFreshnessStatus = 'missing';
  } else {
    const snapshot = utcDateOnly(input.inventorySnapshotDate, 'inventorySnapshotDate');
    inventorySnapshotDate = isoDate(snapshot);
    inventoryAgeDays = daysBetween(asOf, snapshot);
    if (inventoryAgeDays < 0) inventoryFreshnessStatus = 'invalid_future';
    else if (inventoryAgeDays > INVENTORY_FRESHNESS_MAX_AGE_DAYS) inventoryFreshnessStatus = 'stale';
    else inventoryFreshnessStatus = 'fresh';
  }

  // Q1: only a medium-or-better rolling window (complete coverage is 'high' by construction;
  // partial needs ≥ ROLLING_VELOCITY_MEDIUM_CONFIDENCE_DAYS observed days) may assert a BLOCKING
  // disposition. This is a false-alarm guard, not an evidence gate — the velocity itself stays.
  const blockingDispositionConfidence = rollingVelocityConfidence === 'high' || rollingVelocityConfidence === 'medium';
  let daysOfCover: Decimal | null = null;
  let inventoryDisposition: InventoryDisposition = 'insufficient_velocity_evidence';
  if (sellableOnHandStock?.isZero()) {
    inventoryDisposition = 'none';
  } else if (
    sellableOnHandStock &&
    inventoryFreshnessStatus === 'fresh' &&
    rollingVelocityEvidenceStatus === 'trusted_zero'
  ) {
    // Q1 gate (tech-lead decision): the blocking dispositions require MEDIUM+ rolling confidence
    // (complete coverage, or ≥7 observed days in the trailing-30 window). A low-confidence window
    // never asserts stuck/excess off a blip — the row keeps disposition 'none' with its
    // low-confidence velocity fully visible and flows to its otherwise-computed pane.
    inventoryDisposition = blockingDispositionConfidence ? 'no_sell_through' : 'none';
  } else if (
    sellableOnHandStock &&
    inventoryFreshnessStatus === 'fresh' &&
    rollingVelocityEvidenceStatus === 'trusted_positive' &&
    salesVelocity?.isPositive()
  ) {
    daysOfCover = sellableOnHandStock.div(salesVelocity);
    inventoryDisposition = daysOfCover.greaterThan(60) && blockingDispositionConfidence ? 'over_60_days_cover' : 'none';
  }

  return {
    asOfDate: rollingVelocityWindowEndDate,
    rollingVelocityWindowStartDate,
    rollingVelocityWindowEndDate,
    rollingVelocityEvidenceStatus,
    rollingVelocityReasonCode,
    rollingVelocityCoveredDayCount,
    rollingVelocityConfidence,
    rollingUnits30: fixed8(rollingUnits30),
    salesVelocity: fixed8(salesVelocity),
    sellableOnHandStock: fixed8(sellableOnHandStock),
    inventorySnapshotDate,
    inventoryAgeDays,
    inventoryFreshnessStatus,
    daysOfCover: fixed8(daysOfCover),
    inventoryDisposition,
    inventoryDispositionReasonCode: inventoryDisposition,
    reservedStock: fixed8(nonNegativeDecimal(input.reservedStock)),
    pipelineStock: fixed8(nonNegativeDecimal(input.pipelineStock)),
    pipelineCondition: input.orderPipelineStatus,
  };
}
