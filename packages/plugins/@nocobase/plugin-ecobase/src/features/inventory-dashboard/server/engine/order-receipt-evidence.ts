/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import type { AmazonReceiptStatus } from './order-receipt-state';

export interface ReceiptEvidenceIdentity {
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  companyProductFamilyId: string;
  orderLineId: string;
}

export interface ReceiptInventorySnapshot {
  id: string;
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  companyProductFamilyId: string;
  sourceConnectionId?: string;
  snapshotDate: string;
  sellableStock?: number;
  reservedStock?: number;
  inboundStock?: number;
  awdStock?: number;
  /**
   * Not part of the Amazon-visible-stock sum; carried so the 054 R2 entry baseline can
   * record the same pipeline buckets the operator sees on the row.
   */
  orderedStock?: number;
  prepStock?: number;
}

/**
 * The inventory state stamped on a silver order line when its ORDER entered workflow
 * stage `amazon_inbound` (054 R2). Captured at the SAME family-aggregated grain the
 * evidence math consumes, so `baselineAmazonVisibleStock` and `currentAmazonVisibleStock`
 * stay a like-for-like subtraction. `reserved` is stored alongside the buckets named in
 * the plan because it is part of Amazon-visible stock: omitting it at the baseline while
 * counting it in the current snapshot would manufacture phantom arrivals.
 */
export interface InboundEntryBaseline {
  snapshotId: string | null;
  asOf: string | null;
  ordered: number | null;
  inbound: number | null;
  stock: number | null;
  reserved: number | null;
  prepStock: number | null;
  awdStock: number | null;
}

export interface ReceiptSalesFact {
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  companyProductFamilyId: string;
  snapshotDate: string;
  unitsSold: number;
  trusted: boolean;
}

export interface CalculateAmazonReceiptEvidenceInput {
  identity: ReceiptEvidenceIdentity;
  inboundObservedAt: string;
  evaluatedAt: string;
  sellerboardSourceConnectionIds: Set<string>;
  snapshots: ReceiptInventorySnapshot[];
  salesFacts?: ReceiptSalesFact[];
  fulfillmentRoute?: string;
  /**
   * 054 R2: the state stamped when the order entered inbound monitoring. When present
   * (and carrying a usable `asOf`) it IS the baseline, so the measured shift is anchored
   * to pane entry instead of drifting with `authorityAsOf`. NULL/absent → the pre-R2
   * derivation below, byte for byte.
   */
  inboundEntryBaseline?: InboundEntryBaseline | null;
}

export interface AmazonReceiptEvidence {
  outcome: 'observed' | 'not_observed' | 'review_required';
  status: Extract<AmazonReceiptStatus, 'awaiting_amazon_stock' | 'amazon_stock_observed' | 'review_required'>;
  reason:
    | 'positive_attributed_addition'
    | 'no_post_baseline_addition'
    | 'missing_baseline'
    | 'missing_current_snapshot';
  confidence: 'high' | 'partial' | 'none';
  baselineSnapshotId?: string;
  baselineSnapshotDate?: string;
  currentSnapshotId?: string;
  currentSnapshotDate?: string;
  baselineAmazonVisibleStock?: number;
  currentAmazonVisibleStock?: number;
  netAmazonIncrease?: number;
  trustedSalesSinceBaseline?: number;
  observedAddition?: number;
  awdIncluded: boolean;
}

function isoDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

function sameIdentity(
  row: Pick<ReceiptInventorySnapshot, 'companyId' | 'amazonAccountId' | 'marketplace' | 'companyProductFamilyId'>,
  identity: ReceiptEvidenceIdentity,
) {
  return (
    row.companyId === identity.companyId &&
    row.amazonAccountId === identity.amazonAccountId &&
    row.marketplace.trim().toLowerCase() === identity.marketplace.trim().toLowerCase() &&
    row.companyProductFamilyId === identity.companyProductFamilyId
  );
}

export function latestPreferredInventorySnapshot<T>(snapshots: T[], sellerboardSourceConnectionIds: Set<string>) {
  return [...snapshots].sort((left, right) => {
    const leftSnapshot = left as { sourceConnectionId?: unknown; snapshotDate?: unknown };
    const rightSnapshot = right as { sourceConnectionId?: unknown; snapshotDate?: unknown };
    const leftSource =
      typeof leftSnapshot.sourceConnectionId === 'string' ? leftSnapshot.sourceConnectionId : undefined;
    const rightSource =
      typeof rightSnapshot.sourceConnectionId === 'string' ? rightSnapshot.sourceConnectionId : undefined;
    const leftRank = leftSource && sellerboardSourceConnectionIds.has(leftSource) ? 0 : 1;
    const rightRank = rightSource && sellerboardSourceConnectionIds.has(rightSource) ? 0 : 1;
    return (
      leftRank - rightRank ||
      String(rightSnapshot.snapshotDate ?? '').localeCompare(String(leftSnapshot.snapshotDate ?? ''))
    );
  })[0];
}

function finiteNumber(value: unknown) {
  // `Number(null)` and `Number('')` are 0, which would turn "this bucket was never
  // reported" into a hard zero on the stored baseline. Absent stays absent.
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function trimmedText(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

/**
 * The family-aggregated inventory snapshots the receipt math measures against: one row
 * per (source connection, snapshot date) group in which EVERY family member is covered,
 * with the member buckets summed. Partial groups are dropped — a family total computed
 * from a subset of its listings would read as a stock drop.
 *
 * Single definition on purpose (054 R2): the reconciliation service derives the current
 * snapshot through this function and the inbound-entry stamper captures the baseline
 * through it, so the two sides of `currentStock - baselineStock` can never drift to
 * different grains.
 */
export function aggregateFamilyInventorySnapshots(input: {
  memberIds: string[];
  rows: Array<Record<string, unknown>>;
  identity: Omit<ReceiptEvidenceIdentity, 'orderLineId'>;
}): { snapshots: ReceiptInventorySnapshot[]; snapshotIdsByAggregateId: Map<string, string[]> } {
  const groups = new Map<
    string,
    { rows: Array<Record<string, unknown>>; sourceConnectionId?: string; snapshotDate: string }
  >();
  for (const row of input.rows) {
    const snapshotDate = trimmedText(row.snapshotDate);
    if (!snapshotDate) continue;
    const sourceConnectionId = trimmedText(row.sourceConnectionId);
    const groupKey = `${sourceConnectionId ?? 'unknown'}:${snapshotDate}`;
    const group = groups.get(groupKey) ?? { rows: [], sourceConnectionId, snapshotDate };
    group.rows.push(row);
    groups.set(groupKey, group);
  }
  const snapshotIdsByAggregateId = new Map<string, string[]>();
  const snapshots: ReceiptInventorySnapshot[] = [];
  const sum = (rows: Array<Record<string, unknown>>, field: string) =>
    rows.reduce((total, row) => total + (finiteNumber(row[field]) ?? 0), 0);
  for (const group of groups.values()) {
    const coveredMemberIds = new Set(
      group.rows.map((row) => trimmedText(row.companyProductId)).filter((id): id is string => Boolean(id)),
    );
    if (coveredMemberIds.size !== input.memberIds.length) continue;
    const sourceIds = group.rows
      .map((row) => trimmedText(row.id))
      .filter((id): id is string => Boolean(id))
      .sort();
    const id = createHash('sha256')
      .update(
        JSON.stringify({
          identity: input.identity.companyProductFamilyId,
          group: group.snapshotDate,
          sourceIds,
        }),
      )
      .digest('hex');
    snapshotIdsByAggregateId.set(id, sourceIds);
    snapshots.push({
      id,
      companyId: input.identity.companyId,
      amazonAccountId: input.identity.amazonAccountId,
      marketplace: input.identity.marketplace,
      companyProductFamilyId: input.identity.companyProductFamilyId,
      sourceConnectionId: group.sourceConnectionId,
      snapshotDate: group.snapshotDate,
      sellableStock: sum(group.rows, 'sellableStock'),
      reservedStock: sum(group.rows, 'reserved'),
      inboundStock: sum(group.rows, 'inbound'),
      awdStock: sum(group.rows, 'awdStock'),
      orderedStock: sum(group.rows, 'ordered'),
      prepStock: sum(group.rows, 'prepStock'),
    });
  }
  return { snapshots, snapshotIdsByAggregateId };
}

/** Narrow a raw `inboundEntryBaseline` jsonb column value to the typed baseline (054 R2). */
export function readInboundEntryBaseline(value: unknown): InboundEntryBaseline | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const asOf = trimmedText(raw.asOf);
  if (!asOf) return undefined;
  const bucket = (field: string) => finiteNumber(raw[field]) ?? null;
  return {
    snapshotId: trimmedText(raw.snapshotId) ?? null,
    asOf,
    ordered: bucket('ordered'),
    inbound: bucket('inbound'),
    stock: bucket('stock'),
    reserved: bucket('reserved'),
    prepStock: bucket('prepStock'),
    awdStock: bucket('awdStock'),
  };
}

/** The stamped entry state as a snapshot the evidence math can subtract from. */
function inboundEntryBaselineSnapshot(
  baseline: InboundEntryBaseline | null | undefined,
  identity: ReceiptEvidenceIdentity,
): ReceiptInventorySnapshot | undefined {
  const asOf = isoDate(baseline?.asOf ?? '') ?? undefined;
  if (!baseline || !asOf) return undefined;
  return {
    id: baseline.snapshotId ?? `inbound_entry_baseline:${asOf}`,
    companyId: identity.companyId,
    amazonAccountId: identity.amazonAccountId,
    marketplace: identity.marketplace,
    companyProductFamilyId: identity.companyProductFamilyId,
    snapshotDate: asOf,
    sellableStock: baseline.stock ?? undefined,
    reservedStock: baseline.reserved ?? undefined,
    inboundStock: baseline.inbound ?? undefined,
    awdStock: baseline.awdStock ?? undefined,
    orderedStock: baseline.ordered ?? undefined,
    prepStock: baseline.prepStock ?? undefined,
  };
}

function amazonVisibleStock(snapshot: ReceiptInventorySnapshot, awdIncluded: boolean) {
  return (
    (snapshot.sellableStock ?? 0) +
    (snapshot.reservedStock ?? 0) +
    (snapshot.inboundStock ?? 0) +
    (awdIncluded ? snapshot.awdStock ?? 0 : 0)
  );
}

export function calculateAmazonReceiptEvidence(input: CalculateAmazonReceiptEvidenceInput): AmazonReceiptEvidence {
  const inboundDate = isoDate(input.inboundObservedAt);
  const evaluatedDate = isoDate(input.evaluatedAt);
  const awdIncluded = input.fulfillmentRoute?.trim().toLowerCase() === 'awd';
  const matchingSnapshots = input.snapshots.filter((snapshot) => sameIdentity(snapshot, input.identity));
  // 054 R2: the stamped pane-entry state wins when it exists; otherwise fall back to
  // picking the newest preferred snapshot at or before the observed inbound date.
  const baseline =
    inboundEntryBaselineSnapshot(input.inboundEntryBaseline, input.identity) ??
    (inboundDate
      ? latestPreferredInventorySnapshot(
          matchingSnapshots.filter((snapshot) => snapshot.snapshotDate <= inboundDate),
          input.sellerboardSourceConnectionIds,
        )
      : undefined);
  if (!baseline) {
    return {
      outcome: 'review_required',
      status: 'review_required',
      reason: 'missing_baseline',
      confidence: 'none',
      awdIncluded,
    };
  }

  const current = evaluatedDate
    ? latestPreferredInventorySnapshot(
        matchingSnapshots.filter(
          (snapshot) => snapshot.snapshotDate > baseline.snapshotDate && snapshot.snapshotDate <= evaluatedDate,
        ),
        input.sellerboardSourceConnectionIds,
      )
    : undefined;
  if (!current) {
    return {
      outcome: 'not_observed',
      status: 'awaiting_amazon_stock',
      reason: 'missing_current_snapshot',
      confidence: 'none',
      baselineSnapshotId: baseline.id,
      baselineSnapshotDate: baseline.snapshotDate,
      baselineAmazonVisibleStock: amazonVisibleStock(baseline, awdIncluded),
      awdIncluded,
    };
  }

  const baselineStock = amazonVisibleStock(baseline, awdIncluded);
  const currentStock = amazonVisibleStock(current, awdIncluded);
  const netAmazonIncrease = currentStock - baselineStock;
  const facts = (input.salesFacts ?? []).filter(
    (fact) =>
      sameIdentity(fact, input.identity) &&
      fact.snapshotDate > baseline.snapshotDate &&
      fact.snapshotDate <= current.snapshotDate,
  );
  const trustedSalesSinceBaseline = facts
    .filter((fact) => fact.trusted)
    .reduce((total, fact) => total + Math.max(0, fact.unitsSold), 0);
  const trustedSalesAvailable = facts.length > 0 && facts.every((fact) => fact.trusted);
  const observedAddition = Math.max(0, netAmazonIncrease + trustedSalesSinceBaseline);

  return {
    outcome: observedAddition > 0 ? 'observed' : 'not_observed',
    status: observedAddition > 0 ? 'amazon_stock_observed' : 'awaiting_amazon_stock',
    reason: observedAddition > 0 ? 'positive_attributed_addition' : 'no_post_baseline_addition',
    confidence: trustedSalesAvailable ? 'high' : 'partial',
    baselineSnapshotId: baseline.id,
    baselineSnapshotDate: baseline.snapshotDate,
    currentSnapshotId: current.id,
    currentSnapshotDate: current.snapshotDate,
    baselineAmazonVisibleStock: baselineStock,
    currentAmazonVisibleStock: currentStock,
    netAmazonIncrease,
    trustedSalesSinceBaseline,
    observedAddition,
    awdIncluded,
  };
}
