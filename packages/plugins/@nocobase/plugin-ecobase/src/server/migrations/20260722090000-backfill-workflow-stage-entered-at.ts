/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T-3.0 (Inventory Dashboard): one-time backfill of `workflowStageEnteredAt`
 * for orders currently in an active stage (in_prep / amazon_inbound) from the
 * best available evidence, provenance-tagged `derived` inside
 * `statusEvidenceJson`. Orders with no evidence stay null ("unknown" in the
 * dashboard — never 0 days). The column itself auto-syncs from the collection
 * definition; this migration only transforms data.
 */

import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const ACTIVE_STAGES = ['in_prep', 'amazon_inbound'];

type PlainRecord = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function bestStageEntryEvidence(order: PlainRecord): { at: string; source: string } | null {
  const candidates: Array<{ at: string | undefined; source: string }> = [
    { at: text(order.operatorStatusOverrideAt), source: 'operatorStatusOverrideAt' },
    { at: text(order.authorityAsOf), source: 'authorityAsOf' },
    { at: toIso(order.updatedAt), source: 'updatedAt' },
  ];
  for (const candidate of candidates) {
    if (candidate.at) return { at: candidate.at, source: candidate.source };
  }
  return null;
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

export default class extends Migration {
  declare db: any;
  on = 'afterLoad';
  appVersion = '<2.2.0';

  async up() {
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.silverOrders);
    if (!repository) return;
    const orders: PlainRecord[] = await repository.find({
      filter: { workflowStage: { $in: ACTIVE_STAGES } },
      limit: 100000,
    });
    for (const order of orders) {
      if (text(order.workflowStageEnteredAt) || order.workflowStageEnteredAt instanceof Date) continue;
      const evidence = bestStageEntryEvidence(order);
      if (!evidence) continue; // no evidence -> stays null -> renders "unknown"
      const statusEvidenceJson =
        typeof order.statusEvidenceJson === 'object' && order.statusEvidenceJson !== null
          ? (order.statusEvidenceJson as PlainRecord)
          : {};
      await repository.update({
        filterByTk: order.id,
        values: {
          workflowStageEnteredAt: evidence.at,
          statusEvidenceJson: {
            ...statusEvidenceJson,
            workflowStageEnteredAtProvenance: { kind: 'derived', source: evidence.source },
          },
        },
      });
    }
  }
}
