/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
  currentSnapshotId?: string;
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
  const baseline = inboundDate
    ? latestPreferredInventorySnapshot(
        matchingSnapshots.filter((snapshot) => snapshot.snapshotDate <= inboundDate),
        input.sellerboardSourceConnectionIds,
      )
    : undefined;
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
    currentSnapshotId: current.id,
    baselineAmazonVisibleStock: baselineStock,
    currentAmazonVisibleStock: currentStock,
    netAmazonIncrease,
    trustedSalesSinceBaseline,
    observedAddition,
    awdIncluded,
  };
}
