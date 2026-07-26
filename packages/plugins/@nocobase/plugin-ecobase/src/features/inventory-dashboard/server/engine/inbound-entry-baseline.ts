/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Inbound-entry baseline stamp (issue 054 R2).
 *
 * When an order transitions INTO workflow stage `amazon_inbound`, each of its lines
 * records the inventory state of its listing right then. Receipt evidence later measures
 * the Amazon-visible shift against that stamp instead of re-deriving a baseline from
 * `authorityAsOf`, which every ClickUp import moves forward.
 *
 * Entry-state semantics, enforced by ONE rule: the stamp is written only on a transition
 * into the stage. Saves while the order is already inbound never reach this module, so a
 * stamped baseline is byte-identical across them; leaving the stage and re-entering is a
 * fresh transition, so it restamps with the newer snapshot.
 */

import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import type { EcobaseDatabase } from '../../../source-import/server/import-service';
import {
  aggregateFamilyInventorySnapshots,
  latestPreferredInventorySnapshot,
  type InboundEntryBaseline,
  type ReceiptInventorySnapshot,
} from './order-receipt-evidence';

type Row = Record<string, unknown>;

export const AMAZON_INBOUND_WORKFLOW_STAGE = 'amazon_inbound';

function text(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

/**
 * True only for a move INTO the inbound stage. A same-stage save (inbound → inbound) is
 * false, which is what keeps an existing stamp untouched.
 */
export function entersAmazonInbound(previousStage: unknown, nextStage: unknown): boolean {
  return text(nextStage) === AMAZON_INBOUND_WORKFLOW_STAGE && text(previousStage) !== AMAZON_INBOUND_WORKFLOW_STAGE;
}

function baselineFromSnapshot(snapshot: ReceiptInventorySnapshot | undefined): InboundEntryBaseline | null {
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.id,
    asOf: snapshot.snapshotDate,
    ordered: snapshot.orderedStock ?? null,
    inbound: snapshot.inboundStock ?? null,
    stock: snapshot.sellableStock ?? null,
    reserved: snapshot.reservedStock ?? null,
    prepStock: snapshot.prepStock ?? null,
    awdStock: snapshot.awdStock ?? null,
  };
}

/**
 * Stamps `inboundEntryBaseline` on the lines of orders entering inbound monitoring.
 *
 * Every order write path that can change `workflowStage` calls `stampOrderEntry` after
 * its own update lands: the operator workbench, the legacy Order Planning editor, the
 * ClickUp authority import (update + workflow-draft create), and the supplier-order
 * import apply. The transition guard lives here, so each call site stays one line.
 */
export class EcobaseInboundEntryBaselineStamper {
  constructor(private readonly db: EcobaseDatabase) {}

  /**
   * Returns the number of lines that received a non-null baseline. When a listing has no
   * usable family snapshot the line is written back to NULL rather than keeping a stamp
   * from an earlier visit — an unknown entry state must read as unknown, not as stale.
   */
  async stampOrderEntry(params: {
    orderId: string;
    previousStage: unknown;
    nextStage: unknown;
    transaction?: unknown;
  }): Promise<{ stampedLines: number }> {
    if (!entersAmazonInbound(params.previousStage, params.nextStage)) return { stampedLines: 0 };
    const orderId = text(params.orderId);
    if (!orderId) return { stampedLines: 0 };
    const lines = await this.find(ECOBASE_COLLECTIONS.silverOrderLines, { orderId }, params.transaction);
    if (lines.length === 0) return { stampedLines: 0 };

    const sellerboardSourceConnectionIds = await this.sellerboardSourceConnectionIds(params.transaction);
    const baselineByListingId = new Map<string, InboundEntryBaseline | null>();
    let stampedLines = 0;
    for (const line of lines) {
      const lineId = text(line.id);
      const listingId = text(line.companyProductId);
      if (!lineId) continue;
      let baseline: InboundEntryBaseline | null = null;
      if (listingId) {
        if (!baselineByListingId.has(listingId)) {
          baselineByListingId.set(
            listingId,
            await this.baselineForListing(listingId, sellerboardSourceConnectionIds, params.transaction),
          );
        }
        baseline = baselineByListingId.get(listingId) ?? null;
      }
      // Nothing to write when there is no baseline to record and none was stored before.
      if (baseline === null && (line.inboundEntryBaseline ?? null) === null) continue;
      await this.update(
        ECOBASE_COLLECTIONS.silverOrderLines,
        lineId,
        { inboundEntryBaseline: baseline },
        params.transaction,
      );
      if (baseline !== null) stampedLines += 1;
    }
    return { stampedLines };
  }

  /**
   * The newest preferred family-aggregated snapshot for the listing's family, or null when
   * the listing, its family, or a fully covered snapshot group cannot be resolved.
   */
  private async baselineForListing(
    listingId: string,
    sellerboardSourceConnectionIds: Set<string>,
    transaction?: unknown,
  ): Promise<InboundEntryBaseline | null> {
    const companyProduct = await this.findOne(ECOBASE_COLLECTIONS.silverCompanyProducts, listingId, transaction);
    const companyProductFamilyId = text(companyProduct?.companyProductFamilyId);
    const companyId = text(companyProduct?.companyId);
    const amazonAccountId = text(companyProduct?.amazonAccountId);
    if (!companyProductFamilyId || !companyId || !amazonAccountId) return null;
    const family = await this.findOne(
      ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
      companyProductFamilyId,
      transaction,
    );
    const marketplace = text(family?.marketplace);
    if (!marketplace) return null;

    const members = await this.find(ECOBASE_COLLECTIONS.silverCompanyProducts, { companyProductFamilyId }, transaction);
    const memberIds = members.map((member) => text(member.id)).filter((id): id is string => Boolean(id));
    const rows: Row[] = [];
    for (const memberId of memberIds) {
      rows.push(
        ...(await this.find(ECOBASE_COLLECTIONS.silverInventorySnapshots, { companyProductId: memberId }, transaction)),
      );
    }
    const { snapshots } = aggregateFamilyInventorySnapshots({
      memberIds,
      rows,
      identity: { companyId, amazonAccountId, marketplace, companyProductFamilyId },
    });
    return baselineFromSnapshot(latestPreferredInventorySnapshot(snapshots, sellerboardSourceConnectionIds));
  }

  private async sellerboardSourceConnectionIds(transaction?: unknown) {
    const connections = await this.find(ECOBASE_COLLECTIONS.sourceConnections, {}, transaction);
    return new Set(
      connections
        .filter((connection) => text(connection.sourceType) === 'sellerboard' && connection.active !== false)
        .map((connection) => text(connection.id))
        .filter((id): id is string => Boolean(id)),
    );
  }

  private async find(collection: string, filter: Row, transaction?: unknown) {
    return ((await this.db.getRepository(collection).find({ filter, transaction })) as unknown[]).map(record);
  }

  private async findOne(collection: string, id: string, transaction?: unknown) {
    const value = await this.db.getRepository(collection).findOne({ filterByTk: id, transaction });
    return value ? record(value) : undefined;
  }

  private async update(collection: string, id: string, values: Row, transaction?: unknown) {
    await this.db.getRepository(collection).update({ filterByTk: id, values, transaction });
  }
}
