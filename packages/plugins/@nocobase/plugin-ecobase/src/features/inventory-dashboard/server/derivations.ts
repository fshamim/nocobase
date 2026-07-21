/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Pure derivations (AD-9). Every function is deterministic given an explicit
 * `now` clock; nulls stay null and surface as "unknown" downstream — never 0,
 * never on-track. Covered by derivations.test.ts against pinned fixtures.
 */

import type {
  BufferStatus,
  DashboardLastActivity,
  PaneKey,
  PerformanceBand,
  PrepPath,
  VelocityTrend,
} from './contract';
import { DASHBOARD_PANE_KEYS } from './contract';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const ACTIVITY_PREVIEW_MAX = 140;

/** Panes P1–P8: the tiered-only operational set (REQ-X5). */
const OPERATIONAL_PANES: ReadonlySet<PaneKey> = new Set<PaneKey>([
  'supplyAction',
  'activeOrders',
  'inPrepMonitoring',
  'inboundMonitoring',
  'healthyInventory',
  'excessInventory',
  'stuckInventory',
  'zeroStock',
]);

export function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function isTiered(...tiers: Array<string | null | undefined>): boolean {
  return tiers.some((tier) => ['a', 'b', 'c'].includes((tier ?? '').trim().toLowerCase()));
}

/** Whole days elapsed since stage entry. Null enteredAt -> null (renders "unknown", never 0). */
export function daysInStage(enteredAt: string | null | undefined, now: Date): number | null {
  const entered = parseInstant(enteredAt);
  if (entered === null) return null;
  return Math.max(0, Math.floor((now.getTime() - entered) / MS_PER_DAY));
}

export function hoursSince(at: string | null | undefined, now: Date): number | null {
  const instant = parseInstant(at);
  if (instant === null) return null;
  return (now.getTime() - instant) / MS_PER_HOUR;
}

/**
 * Effective last-activity timestamp: the latest comment/status change, falling
 * back to stage entry when the order has no explicit activity yet (§4.4).
 */
export function effectiveLastActivityAt(
  latestActivityAt: string | null | undefined,
  workflowStageEnteredAt: string | null | undefined,
): string | null {
  return latestActivityAt ?? workflowStageEnteredAt ?? null;
}

export interface NeedsFollowUpInput {
  daysInStage: number | null;
  latestActivityAt: string | null | undefined;
  workflowStageEnteredAt: string | null | undefined;
  thresholdHours: number;
  now: Date;
}

/** §4.4: daysInStage != null && hoursSinceLastActivity > threshold (strict). */
export function needsFollowUp(input: NeedsFollowUpInput): boolean {
  if (input.daysInStage === null) return false;
  const effectiveAt = effectiveLastActivityAt(input.latestActivityAt, input.workflowStageEnteredAt);
  const hours = hoursSince(effectiveAt, input.now);
  if (hours === null) return false;
  return hours > input.thresholdHours;
}

function dateOnlyMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface BufferStatusInput {
  expectedArrivalDate: string | null | undefined;
  estimatedOosDate: string | null | undefined;
  safetyBufferDays: number | null | undefined;
}

/** §4.5. Either date null -> 'unknown' (never coerced on-track). */
export function bufferStatus(input: BufferStatusInput): BufferStatus {
  const eta = dateOnlyMs(input.expectedArrivalDate);
  const oos = dateOnlyMs(input.estimatedOosDate);
  if (eta === null || oos === null) return 'unknown';
  if (eta > oos) return 'late';
  const buffer = typeof input.safetyBufferDays === 'number' ? input.safetyBufferDays : 0;
  const atRiskThreshold = oos - buffer * MS_PER_DAY;
  // Boundary: ETA == OOS - buffer resolves to 'sufficient' (strict >).
  if (eta > atRiskThreshold) return 'at_risk';
  return 'sufficient';
}

export interface StaleLeadTimeResult {
  stale: boolean;
  unknown: boolean;
}

/** REQ-H3. Null evidence -> unknown (never "stale"). Age == threshold -> not stale (strict >). */
export function staleLeadTime(
  leadTimeConfirmedAt: string | null | undefined,
  freshnessDays: number,
  now: Date,
): StaleLeadTimeResult {
  const confirmed = parseInstant(leadTimeConfirmedAt);
  if (confirmed === null) return { stale: false, unknown: true };
  const ageDays = (now.getTime() - confirmed) / MS_PER_DAY;
  return { stale: ageDays > freshnessDays, unknown: false };
}

export interface MonthlyEvidenceEntry {
  month?: string;
  units: number | null;
  trusted: boolean;
}

/** §4.6. Needs >= 3 trusted months, else insufficient_evidence. Boundaries inclusive. */
export function performanceBand(
  evidence: MonthlyEvidenceEntry[] | null | undefined,
  projectedMonthlyUnits: number | null | undefined,
): PerformanceBand {
  const trusted = (evidence ?? []).filter(
    (entry): entry is MonthlyEvidenceEntry & { units: number } => entry.trusted && typeof entry.units === 'number',
  );
  if (trusted.length < 3 || typeof projectedMonthlyUnits !== 'number') return 'insufficient_evidence';
  const units = trusted.map((entry) => entry.units);
  const best = Math.max(...units);
  const worst = Math.min(...units);
  if (projectedMonthlyUnits > best) return 'above_band';
  if (projectedMonthlyUnits < worst) return 'below_band';
  return 'within_band';
}

/** §4.6 modifier: projected tier strictly below the last closed tier. */
export function isDeclining(
  currentProjectedTier: string | null | undefined,
  lastClosedMonthTier: string | null | undefined,
): boolean {
  const rank = (tier: string | null | undefined): number | null => {
    const normalized = (tier ?? '').trim().toLowerCase();
    const index = ['a', 'b', 'c'].indexOf(normalized);
    return index === -1 ? null : index;
  };
  const current = rank(currentProjectedTier);
  const closed = rank(lastClosedMonthTier);
  if (current === null || closed === null) return false;
  return current > closed; // higher index == worse tier
}

/** P10 membership: below_band OR declining. */
export function isPerformanceReviewRow(band: PerformanceBand, declining: boolean): boolean {
  return band === 'below_band' || declining;
}

/** §4.7. Missing either input -> 'unknown'. ±10% band -> 'flat'. */
export function velocityTrend(
  projectedMonthlyUnits: number | null | undefined,
  lastClosedMonthUnits: number | null | undefined,
): VelocityTrend {
  if (typeof projectedMonthlyUnits !== 'number' || typeof lastClosedMonthUnits !== 'number') return 'unknown';
  if (lastClosedMonthUnits === 0) return 'unknown';
  if (projectedMonthlyUnits > lastClosedMonthUnits * 1.1) return 'up';
  if (projectedMonthlyUnits < lastClosedMonthUnits * 0.9) return 'down';
  return 'flat';
}

export interface LastActivityInput {
  note: string | null | undefined;
  actorDisplayName: string | null | undefined;
  actor: string | null | undefined;
  at: string | null | undefined;
}

/** REQ-X1. Orphan/empty -> null ("no activity yet"), never a crash. */
export function pickLastActivity(input: LastActivityInput): DashboardLastActivity | null {
  const at = typeof input.at === 'string' && input.at.trim() ? input.at : null;
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  if (at === null && note === null) return null;
  const preview = note ? truncatePreview(note) : '';
  const author =
    (typeof input.actorDisplayName === 'string' && input.actorDisplayName.trim()) ||
    (typeof input.actor === 'string' && input.actor.trim())
      ? (input.actorDisplayName?.trim() || input.actor?.trim()) ?? null
      : null;
  return { preview, author, at: at ?? '' };
}

export function truncatePreview(text: string, max: number = ACTIVITY_PREVIEW_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export type PrepPathInput = {
  isDirectShipFba: boolean;
};

/** AD-7. direct-ship -> direct_fba; otherwise unknown (own-prep-center detection deferred, FLAG-2). */
export function prepPath(input: PrepPathInput): PrepPath {
  return input.isDirectShipFba ? 'direct_fba' : 'unknown';
}

export interface PaneProjectionInput {
  primaryActionPane: string;
  tiered: boolean;
  isDirectShipFba: boolean;
  goldWorkflowStage: string | null | undefined;
  silverWorkflowStage: string | null | undefined;
}

export interface PaneProjectionResult {
  /** null == excluded (adminExcluded), never served. */
  pane: PaneKey | null;
  staleClassification: boolean;
  untieredProjected: boolean;
}

function isPaneKeyValue(value: string): value is PaneKey {
  return (DASHBOARD_PANE_KEYS as readonly string[]).includes(value);
}

/**
 * AD-2 sanctioned projections:
 *  - adminExcluded -> excluded (null).
 *  - untiered row in an operational pane (P1–P8) -> untieredProducts (untiered_projected).
 *  - direct-ship-fba -> inboundMonitoring (P4), overriding sub-status.
 *  - otherwise the persisted primaryActionPane is authoritative.
 * staleClassification flags gold/silver stage disagreement (surfaced, not reclassified).
 */
export function projectRowPane(input: PaneProjectionInput): PaneProjectionResult {
  if (input.primaryActionPane === 'adminExcluded') {
    return { pane: null, staleClassification: false, untieredProjected: false };
  }
  if (!isPaneKeyValue(input.primaryActionPane)) {
    // Unknown persisted pane value: quarantine into untieredProducts rather than invent membership.
    return { pane: 'untieredProducts', staleClassification: false, untieredProjected: false };
  }
  const persisted = input.primaryActionPane;

  if (!input.tiered && OPERATIONAL_PANES.has(persisted)) {
    return { pane: 'untieredProducts', staleClassification: false, untieredProjected: true };
  }

  const goldStage = (input.goldWorkflowStage ?? '').trim().toLowerCase() || null;
  const silverStage = (input.silverWorkflowStage ?? '').trim().toLowerCase() || null;
  const staleClassification =
    goldStage !== null && silverStage !== null && goldStage !== silverStage && isOrderPane(persisted);

  if (input.isDirectShipFba) {
    return { pane: 'inboundMonitoring', staleClassification, untieredProjected: false };
  }
  return { pane: persisted, staleClassification, untieredProjected: false };
}

function isOrderPane(pane: PaneKey): boolean {
  return pane === 'activeOrders' || pane === 'inPrepMonitoring' || pane === 'inboundMonitoring';
}
