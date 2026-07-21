/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Minimal, read-only published-run reader (AD-1 / T-1.0).
 *
 * Deliberately does NOT import `inventory-planning-gold-access.ts` (the shared
 * frozen class) nor any `features/*` module. It reads the gold collections
 * directly with a locally-defined, structural repository interface so the
 * feature stays fully encapsulated. The published-run lookup mirrors the origin
 * (`inventory-planning-gold-access.ts:107` — `{ status: 'published' }`,
 * `sort: ['-publishedAt']`) and row scoping mirrors `:284` (`refreshRunId`).
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';

export interface DashboardRepositoryFindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
  offset?: number;
}

export interface DashboardRepository {
  find(params?: DashboardRepositoryFindParams): Promise<unknown[]>;
  findOne(params?: DashboardRepositoryFindParams): Promise<unknown | null>;
  create(params: { values: Record<string, unknown> }): Promise<unknown>;
  update(params: {
    filterByTk?: string | number;
    filter?: Record<string, unknown>;
    values: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface DashboardDatabase {
  getRepository(name: string): DashboardRepository;
}

export interface PublishedRun {
  id: string;
  calculationDate: string | null;
  publishedAt: string | null;
  status: string;
}

const GOLD_ROW_QUERY_LIMIT = 100_000;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export class PublishedGoldReader {
  constructor(private readonly db: DashboardDatabase) {}

  /** Single query for the currently published run (or null when none published). */
  async findPublishedRun(): Promise<PublishedRun | null> {
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns)
      .find({ filter: { status: 'published' }, sort: ['-publishedAt'], limit: 1 });
    const record = toRecord(rows[0]);
    const id = asString(record.id);
    if (!id) return null;
    return {
      id,
      calculationDate: asString(record.calculationDate) ?? null,
      publishedAt: asString(record.publishedAt) ?? null,
      status: asString(record.status) ?? 'published',
    };
  }

  /**
   * Exactly one gold-rows query per call (AD-4). Scoped to the pinned run and,
   * optionally, a company. In-memory grouping/pagination happens in the service.
   */
  async findRowsForRun(runId: string, companyId?: string): Promise<Record<string, unknown>[]> {
    const filter: Record<string, unknown> = { refreshRunId: runId };
    const company = asString(companyId);
    if (company) filter.companyId = company;
    const rows = await this.db
      .getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows)
      .find({ filter, limit: GOLD_ROW_QUERY_LIMIT });
    return rows.map(toRecord);
  }
}
