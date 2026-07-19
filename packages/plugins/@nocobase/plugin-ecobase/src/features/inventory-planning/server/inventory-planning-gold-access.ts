/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';
import { EcobaseGoldError } from './gold-errors';

export type GoldExplicitReadPurpose =
  | 'candidate_preview'
  | 'production_verification'
  | 'independent_verification'
  | 'maintenance'
  | 'archive';

export interface GoldListingReadQuery {
  filter?: Record<string, unknown>;
  sort?: string[];
  limit?: number;
  transaction?: unknown;
}

export interface GoldReadResult {
  published: boolean;
  run: Record<string, unknown> | null;
  rows: Record<string, unknown>[];
  familyActions?: Record<string, unknown>[];
}

interface GoldAccessRepository {
  find(params?: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    sort?: string[];
    limit?: number;
    transaction?: unknown;
  }): Promise<unknown[]>;
  findOne(params?: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    sort?: string[];
    transaction?: unknown;
  }): Promise<unknown | null>;
  create(params: { values: Record<string, unknown>; transaction?: unknown }): Promise<unknown>;
}

interface ExplicitReadQuery extends GoldListingReadQuery {
  runId?: string;
  purpose: GoldExplicitReadPurpose;
  actor?: { type: 'system' } | { type: 'user'; userId?: string | number; roles: string[] };
}

interface CandidatePreviewQuery extends GoldListingReadQuery {
  runId?: string;
  actorUserId?: string | number;
  roles: string[];
  requestId?: string;
}

const EXPLICIT_PURPOSE_STATUSES: Record<Exclude<GoldExplicitReadPurpose, 'candidate_preview'>, Set<string>> = {
  production_verification: new Set(['materialized', 'verified']),
  independent_verification: new Set(['verified']),
  maintenance: new Set(['materialized', 'verified', 'published', 'superseded', 'rejected', 'retired', 'succeeded']),
  archive: new Set(['verified', 'published', 'superseded', 'rejected', 'retired', 'failed', 'succeeded']),
};

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function familyKey(row: Record<string, unknown>) {
  return (
    text(row.companyProductFamilyId) ??
    [row.companyId ?? row.company, row.amazonAccountId, row.marketplace, row.asin, row.companyProductId ?? row.id]
      .map((value) => String(value ?? ''))
      .join(':')
  );
}

function familyRoleRank(row: Record<string, unknown>) {
  if (row.isFrozenFamilyTarget === true || row.familyRole === 'target') return 3;
  if (row.familyRole === 'review') return 2;
  if (row.familyRole === 'unassigned') return 1;
  return 0;
}

export class EcobaseInventoryPlanningGoldAccess {
  constructor(private readonly db: EcobaseDatabase) {}

  async readPublishedListingPerformance(query: GoldListingReadQuery = {}): Promise<GoldReadResult> {
    const runs = await this.runRepository().find({
      filter: { status: 'published' },
      sort: ['-publishedAt'],
      limit: 2,
      transaction: query.transaction,
    });
    if (runs.length === 0) return { published: false, run: null, rows: [] };
    if (runs.length !== 1) {
      throw new EcobaseGoldError(
        'ECOBASE_GOLD_PUBLICATION_MISMATCH',
        'EcoBase Gold operational access requires exactly one published run.',
        { publishedRunIds: runs.map((run) => toPlainRecord(run).id) },
      );
    }
    const plainRun = toPlainRecord(runs[0]);
    const runId = text(plainRun.id);
    if (!runId) {
      throw new EcobaseGoldError('ECOBASE_GOLD_RUN_NOT_FOUND', 'EcoBase published Gold run is missing its run ID.', {
        status: plainRun.status,
      });
    }
    return {
      published: true,
      run: plainRun,
      rows: await this.rowsForRun(runId, query),
    };
  }

  async readPublishedFamilyActions(query: GoldListingReadQuery = {}): Promise<GoldReadResult> {
    const result = await this.readPublishedListingPerformance(query);
    return { ...result, rows: this.familyActions(result.rows) };
  }

  async readExplicitListingPerformance(query: ExplicitReadQuery): Promise<GoldReadResult> {
    const runId = text(query.runId);
    if (!runId) {
      throw new EcobaseGoldError(
        'ECOBASE_GOLD_EXPLICIT_RUN_REQUIRED',
        `EcoBase Gold ${query.purpose} access requires an explicit run ID.`,
        { purpose: query.purpose },
      );
    }
    if (query.purpose === 'candidate_preview') {
      if (query.actor?.type !== 'user') {
        throw new EcobaseGoldError(
          'ECOBASE_CANDIDATE_PREVIEW_FORBIDDEN',
          'EcoBase candidate preview requires an administrator.',
          { runId },
        );
      }
      return this.readCandidatePreview({
        ...query,
        runId,
        actorUserId: query.actor.userId,
        roles: query.actor.roles,
      });
    }
    if (query.actor?.type !== 'system') {
      throw new EcobaseGoldError(
        'ECOBASE_GOLD_UNPUBLISHED_OPERATIONAL_ACCESS',
        'EcoBase internal explicit-run access requires a system actor.',
        { runId, purpose: query.purpose },
      );
    }
    const run = await this.requireRun(runId, query.transaction);
    const status = String(run.status ?? '');
    if (!EXPLICIT_PURPOSE_STATUSES[query.purpose].has(status)) {
      throw new EcobaseGoldError(
        'ECOBASE_GOLD_UNPUBLISHED_OPERATIONAL_ACCESS',
        `EcoBase Gold run "${runId}" with status "${status}" is not available for ${query.purpose}.`,
        { runId, status, purpose: query.purpose },
      );
    }
    return { published: status === 'published', run, rows: await this.rowsForRun(runId, query) };
  }

  async readExplicitFamilyActions(query: ExplicitReadQuery): Promise<GoldReadResult> {
    const result = await this.readExplicitListingPerformance(query);
    return { ...result, rows: this.familyActions(result.rows) };
  }

  async readCandidatePreview(query: CandidatePreviewQuery): Promise<GoldReadResult> {
    const runId = text(query.runId);
    const actorUserId = query.actorUserId ?? null;
    const roles = new Set(query.roles.map((role) => role.toLowerCase()));
    const deny = async (error: EcobaseGoldError) => {
      await this.audit({
        actorUserId,
        runId: runId ?? null,
        outcome: 'denied',
        reasonCode: error.code,
        requestId: query.requestId,
        metadataJson: { roles: [...roles], details: error.details },
      });
      throw error;
    };

    if (!runId) {
      return deny(
        new EcobaseGoldError(
          'ECOBASE_GOLD_EXPLICIT_RUN_REQUIRED',
          'EcoBase Gold candidate_preview access requires an explicit run ID.',
          { purpose: 'candidate_preview' },
        ),
      );
    }
    if (actorUserId === null || (!roles.has('admin') && !roles.has('root'))) {
      return deny(
        new EcobaseGoldError(
          'ECOBASE_CANDIDATE_PREVIEW_FORBIDDEN',
          'EcoBase candidate preview requires an administrator.',
          { runId },
        ),
      );
    }

    let run: Record<string, unknown>;
    try {
      run = await this.requireRun(runId, query.transaction);
    } catch (error) {
      if (error instanceof EcobaseGoldError) return deny(error);
      throw error;
    }
    const status = String(run.status ?? '');
    if (status === 'published') {
      return deny(
        new EcobaseGoldError(
          'ECOBASE_CANDIDATE_PREVIEW_RUN_PUBLISHED',
          `EcoBase candidate preview rejects published run "${runId}"; use the operational page.`,
          { runId, status },
        ),
      );
    }
    if (status !== 'verified') {
      return deny(
        new EcobaseGoldError(
          'ECOBASE_CANDIDATE_PREVIEW_RUN_NOT_VERIFIED',
          `EcoBase candidate preview requires a verified run; "${runId}" is "${status}".`,
          { runId, status },
        ),
      );
    }

    const rows = await this.rowsForRun(runId, query);
    await this.audit({
      actorUserId,
      runId,
      outcome: 'allowed',
      reasonCode: 'candidate_preview_allowed',
      requestId: query.requestId,
      metadataJson: { roles: [...roles] },
    });
    return { published: false, run, rows, familyActions: this.familyActions(rows) };
  }

  private async requireRun(runId: string, transaction?: unknown) {
    const run = await this.runRepository().findOne({ filterByTk: runId, transaction });
    if (!run) {
      throw new EcobaseGoldError('ECOBASE_GOLD_RUN_NOT_FOUND', `EcoBase Gold run "${runId}" does not exist.`, {
        runId,
      });
    }
    return toPlainRecord(run);
  }

  private async rowsForRun(runId: string, query: GoldListingReadQuery) {
    return (
      await this.rowRepository().find({
        filter: { ...(query.filter ?? {}), refreshRunId: runId },
        sort: query.sort,
        limit: query.limit ?? 100000,
        transaction: query.transaction,
      })
    ).map(toPlainRecord);
  }

  private familyActions(rows: Record<string, unknown>[]) {
    const selected = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (row.familyRole === 'member' && row.isFrozenFamilyTarget !== true) continue;
      const key = familyKey(row);
      const current = selected.get(key);
      if (!current || familyRoleRank(row) > familyRoleRank(current)) selected.set(key, row);
    }
    return [...selected.values()];
  }

  private async audit(values: {
    actorUserId: string | number | null;
    runId: string | null;
    outcome: 'allowed' | 'denied';
    reasonCode: string;
    requestId?: string;
    metadataJson: Record<string, unknown>;
  }) {
    await this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningAccessAudits).create({
      values: {
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        purpose: 'candidate_preview',
        ...values,
      },
    });
  }

  private runRepository() {
    return this.db.getRepository(
      ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns,
    ) as unknown as GoldAccessRepository;
  }

  private rowRepository() {
    return this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows) as unknown as GoldAccessRepository;
  }
}
