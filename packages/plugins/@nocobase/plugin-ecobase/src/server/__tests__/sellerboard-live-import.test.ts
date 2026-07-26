/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSourceAdapterRegistry,
  noopTestAdapter,
  sellerboardApiAdapter,
} from '../../features/source-import/server/adapters';
import { parseSellerboardCsv } from '../../features/source-import/server/adapters/live-source-blocker-adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import {
  SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS,
  SellerboardGoldPromotionDebouncer,
  createEcobaseGoldPromotions,
} from '../plugin';
import {
  EcobaseDatabase,
  EcobaseImportService,
  EcobaseRepository,
} from '../../features/source-import/server/import-service';
import { EcobaseInventoryPlanningService } from '../../features/inventory-dashboard/server/engine/inventory-planning-service';
import { EcobaseOrderReceiptReconciliationService } from '../../features/inventory-dashboard/server/engine/order-receipt-reconciliation-service';
import { createEcobaseImportActions } from '../resource-actions';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    const filtered = this.filterRecords(params);
    return this.sortRecords(filtered, params.sort).slice(0, params.limit ?? filtered.length);
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    if (
      typeof values.idempotencyKey === 'string' &&
      this.records.some((record) => record.idempotencyKey === values.idempotencyKey)
    ) {
      const error = new Error(
        `duplicate key value violates unique constraint for ${values.idempotencyKey}`,
      ) as Error & {
        original?: { code: string };
      };
      error.original = { code: '23505' };
      throw error;
    }
    const record = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(record);
    return record;
  }

  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) {
      throw new Error('MemoryRepository update failed: matching record was not found.');
    }
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  all() {
    return this.records;
  }

  private filterRecords(params: FindParams) {
    if (params.filterByTk) {
      return this.records.filter((record) => record.id === params.filterByTk);
    }
    const filter = params.filter ?? {};
    return this.records.filter((record) => Object.entries(filter).every(([key, expected]) => record[key] === expected));
  }

  private sortRecords(records: Record<string, unknown>[], sort: string[] = []) {
    const [firstSort] = sort;
    if (!firstSort) {
      return records;
    }
    const descending = firstSort.startsWith('-');
    const key = descending ? firstSort.slice(1) : firstSort;
    return [...records].sort((left, right) => {
      const leftValue = String(left[key] ?? '');
      const rightValue = String(right[key] ?? '');
      if (leftValue === rightValue) return 0;
      const result = leftValue > rightValue ? 1 : -1;
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();
  readonly sequelize = {
    query: async () => [],
    transaction: async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        | ((transaction: Record<string, never>) => Promise<unknown>)
        | undefined;
      if (!callback) throw new Error('MemoryDatabase transaction requires a callback.');
      return callback({});
    },
  };

  constructor() {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository()));
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) {
      throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    }
    return repository;
  }
}

function sellerboardGoodsCsv(date: string, netProfit: number) {
  return `Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,Refunds,GrossProfit,NetProfit,Sessions,Unit Session Percentage\n${date},Amazon.com,B007P55HOW,DC50944,Dampp Chaser,63.40,3,0,20.1,${netProfit},30,10%`;
}

function createService(csv = sellerboardGoodsCsv('2026-06-05', 15.2)) {
  const db = new MemoryDatabase();
  db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
    values: {
      id: 'sellerboard-source-1',
      name: 'Sellerboard live source',
      sourceType: 'sellerboard',
      domain: 'amazon_operations',
      config: {
        catalogMutationMode: 'rebuild',
        reportUrls: [
          {
            name: 'Profit by Product Dashboard Daily Data',
            category: 'profit_by_product_daily',
            url: 'https://sellerboard.test/report.csv?t=redacted',
          },
        ],
        schedule: { enabled: true, dailyRefreshTime: '09:00', retryIntervalMinutes: 60 },
        requireFreshData: true,
        defaultCompany: 'Ecofission LLC',
      },
      active: true,
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, text: async () => csv })),
  );
  return { db, service: new EcobaseImportService(db, createSourceAdapterRegistry([sellerboardApiAdapter])) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Sellerboard live URL import', () => {
  /**
   * Issue 054 R1 follow-up: the settings page's "Run now" (forceRefresh) went
   * through runAdapterImport with no committed-unit hook, so a manual pull
   * committed thousands of records and then promoted nothing — no receipt
   * reconciliation, no Gold publish. Every Sellerboard entry point must promote.
   */
  it('promotes Gold from a committed forceRefresh: reconciles receipts, then publishes', async () => {
    const { db } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: { companyId: 'company-1' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: { id: 'order-open', companyId: 'company-1', amazonReceiptStatus: 'awaiting_amazon_stock' },
    });

    const sequence: string[] = [];
    const reconcile = vi
      .spyOn(EcobaseOrderReceiptReconciliationService.prototype, 'reconcileAffectedOrders')
      .mockImplementation(async () => {
        sequence.push('reconcile');
        return {
          processedOrders: 1,
          updatedOrders: 1,
          updatedLines: 1,
          unchangedLines: 0,
          reviewRequired: 0,
          affectedFamilyIds: [],
          errors: [],
        };
      });
    const publish = vi
      .spyOn(EcobaseInventoryPlanningService.prototype, 'refreshAndPublish')
      .mockImplementation(async () => {
        sequence.push('publish');
        return { status: 'published' } as never;
      });

    const promotions = createEcobaseGoldPromotions({ db, logger: { info: vi.fn(), error: vi.fn() } });
    const actions = createEcobaseImportActions(
      createSourceAdapterRegistry([sellerboardApiAdapter]),
      promotions.onSellerboardCommittedUnit,
    );
    const ctx = {
      db,
      action: { params: { values: { sourceConnectionId: 'sellerboard-source-1', sourceVersion: '2026-06-05' } } },
      state: { currentUser: { id: 1 }, currentRoles: ['root'] },
      body: undefined as unknown,
      throw(status: number, message: string): never {
        throw Object.assign(new Error(message), { status });
      },
    };

    await actions.forceRefresh(ctx as never, vi.fn());

    expect(ctx.body).toMatchObject({
      data: { status: 'success', normalizedCount: 2, goldTrigger: { status: 'scheduled' } },
    });
    // The debounced promotion fires on its own timer; wait past one window.
    await new Promise((resolve) => setTimeout(resolve, SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS + 300));

    expect(sequence).toEqual(['reconcile', 'publish']);
    expect(reconcile.mock.calls[0][0].orderIds).toEqual(['order-open']);
    expect(publish).toHaveBeenCalledTimes(1);
    promotions.stop();
  });

  it('never fires the Sellerboard committed-unit hook for a non-Sellerboard source', async () => {
    // run/runDailySnapshot may target any adapter, so they pass the hook
    // unconditionally — the service is what keeps it Sellerboard-only.
    const { db } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: 'noop-source-1', name: 'Noop', sourceType: 'noop_test', domain: 'foundation', active: true },
    });
    const onCommittedUnit = vi.fn();

    const run = await new EcobaseImportService(db, createSourceAdapterRegistry([noopTestAdapter])).runAdapterImport({
      sourceConnectionId: 'noop-source-1',
      adapterName: 'noop-test',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
      onCommittedUnit,
    });

    expect(onCommittedUnit).not.toHaveBeenCalled();
    expect(run).not.toHaveProperty('goldTrigger');
  });

  it('debounces successful report-unit commits into the smallest delayed Gold trigger', async () => {
    vi.useFakeTimers();
    const promote = vi.fn(async () => undefined);
    const onError = vi.fn();
    const debouncer = new SellerboardGoldPromotionDebouncer(promote, onError);

    debouncer.schedule();
    await vi.advanceTimersByTimeAsync(500);
    debouncer.schedule();
    await vi.advanceTimersByTimeAsync(SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS - 1);
    expect(promote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(promote).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    debouncer.stop();
  });

  it('keeps Gold promotion single-flight and coalesces running-period commits into one trailing run', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstPromotion = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    let invocation = 0;
    const promote = vi.fn(async () => {
      invocation += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (invocation === 1) await firstPromotion;
      active -= 1;
    });
    const debouncer = new SellerboardGoldPromotionDebouncer(promote, vi.fn());

    debouncer.schedule();
    await vi.advanceTimersByTimeAsync(SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS);
    expect(promote).toHaveBeenCalledOnce();

    debouncer.schedule();
    debouncer.schedule();
    debouncer.schedule();
    await vi.advanceTimersByTimeAsync(SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS);
    expect(maxActive).toBe(1);
    expect(promote).toHaveBeenCalledOnce();

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS);
    expect(promote).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    debouncer.stop();
  });

  it('parses comma- and semicolon-delimited reports', () => {
    expect(parseSellerboardCsv('Date,ASIN\n2026-07-13,B000000001').rows[0]).toEqual({
      Date: '2026-07-13',
      ASIN: 'B000000001',
    });
    expect(parseSellerboardCsv('Date;ASIN\n13/07/2026;B000000002').rows[0]).toEqual({
      Date: '13/07/2026',
      ASIN: 'B000000002',
    });
  });

  it('derives execution metadata behind the two-field report-unit interface and reuses identical input', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { service } = createService(sellerboardGoodsCsv(today, 15.2));

    const first = await service.runSellerboardReportUnit({
      sourceConnectionId: 'sellerboard-source-1',
      reportKind: 'profit_by_product_daily',
    });
    const replay = await service.runSellerboardReportUnit({
      sourceConnectionId: 'sellerboard-source-1',
      reportKind: 'profit_by_product_daily',
    });

    expect(first).toMatchObject({ status: 'success' });
    expect(replay).toMatchObject({ id: first.id, status: 'success', reused: true });
  });

  it('fetches live Sellerboard CSV URLs and normalizes through the existing CSV path', async () => {
    const { db, service } = createService();

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'manual-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 2, warningCount: 0 });
    expect(fetch).toHaveBeenCalledWith(
      'https://sellerboard.test/report.csv?t=redacted',
      expect.objectContaining({ headers: {}, signal: expect.any(AbortSignal) }),
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([
      expect.objectContaining({
        sourceKey: expect.stringContaining('profit_by_product_daily'),
        sourceDataset: 'sellerboard_daily_facts',
        payload: expect.objectContaining({
          company: 'Ecofission LLC',
          asin: 'B007P55HOW',
          listingSku: 'DC50944',
          salesOrganic: '63.40',
          unitsOrganic: '3',
          netProfit: '15.2',
        }),
      }),
    ]);
  });

  it('records complete account-date and product-scope evidence only after a successful current apply', async () => {
    const csv = ['Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,NetProfit']
      .concat([1, 2, 3, 4, 5].map((day) => `2026-06-0${day},Amazon.com,B007P55HOW,DC50944,Dampp Chaser,10,1,3`))
      .join('\n');
    const { db, service } = createService(csv);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Ecofission LLC', companyKey: 'ECOFISSION_LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        companyId: 'company-1',
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            {
              name: 'Profit by Product Dashboard Daily Data',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/report.csv?t=redacted',
            },
          ],
          requireFreshData: true,
          defaultCompany: 'Ecofission LLC',
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'coverage-current',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({
      status: 'success',
      summary: {
        coverageMaintenance: {
          recorded: true,
          intervalCount: 1,
          membershipCount: 1,
          reconciliation: { intervalCreatedCount: 1, membershipCreatedCount: 1 },
        },
      },
    });
  });

  it('extends coverage through a lagging report as-of date without opening a false gap', async () => {
    // Report data ends 2026-06-03 but the run is triggered on 2026-06-05 (a 2-day feed lag).
    // Coverage must advance to the report's real as-of (06-03) and stay continuous — advancing to
    // 06-05 would mark 06-04/06-05 unobserved and open a false gap that starves rolling velocity.
    const csv = ['Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,NetProfit']
      .concat([1, 2, 3].map((day) => `2026-06-0${day},Amazon.com,B007P55HOW,DC50944,Dampp Chaser,10,1,3`))
      .join('\n');
    const { db, service } = createService(csv);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Ecofission LLC', companyKey: 'ECOFISSION_LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        companyId: 'company-1',
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            {
              name: 'Profit by Product Dashboard Daily Data',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/report.csv?t=redacted',
            },
          ],
          defaultCompany: 'Ecofission LLC',
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'coverage-lagging',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({
      status: 'success',
      sourceVersion: '2026-06-03',
      summary: { coverageMaintenance: { recorded: true, intervalCount: 1 } },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([
      expect.objectContaining({
        coveredStartDate: '2026-06-01',
        coveredEndDate: '2026-06-03',
        continuousCoverage: true,
        sourceAsOfDate: '2026-06-03',
      }),
    ]);
  });

  it('records an errored pull without invalidating previously imported coverage', async () => {
    // A refused/failed pull must never delete or supersede coverage already earned by an earlier
    // accepted report — an error leaves the prior interval intact.
    const csv = ['Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,NetProfit']
      .concat([1, 2, 3].map((day) => `2026-06-0${day},Amazon.com,B007P55HOW,DC50944,Dampp Chaser,10,1,3`))
      .join('\n');
    const { db, service } = createService(csv);
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Ecofission LLC', companyKey: 'ECOFISSION_LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        companyId: 'company-1',
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            {
              name: 'Profit by Product Dashboard Daily Data',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/report.csv?t=redacted',
            },
          ],
          defaultCompany: 'Ecofission LLC',
        },
      },
    });

    await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'coverage-accepted',
      sourceVersion: '2026-06-03',
      preserveAuditRun: true,
    });
    const coverageAfterSuccess = db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all().length;
    expect(coverageAfterSuccess).toBeGreaterThan(0);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })),
    );
    const failed = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'coverage-failed',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(failed).toMatchObject({ status: 'failed' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toHaveLength(coverageAfterSuccess);
  });

  it('uses the source company relation when Sellerboard rows omit company', async () => {
    const { db, service } = createService('ASIN,SKU,FBA/FBM Stock,"ROI, %"\nB000TEST,S-1,12,45');
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-1', name: 'Ecofission LLC', companyKey: 'ECOFISSION_LLC' },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        companyId: 'company-1',
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            { name: 'Stock Daily Data', category: 'stock_daily', url: 'https://sellerboard.test/report.csv' },
          ],
          requireFreshData: false,
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'manual-stock-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({
      status: 'success',
      rowCount: 1,
      normalizedCount: 3,
      summary: { migration: { discardedCount: 0 } },
    });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ company: 'Ecofission LLC' }) }),
    ]);
  });

  it('parses Sellerboard live report slash dates as month-first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => sellerboardGoodsCsv('6/9/2026', 15.2) })),
    );
    const items: any[] = [];
    for await (const item of sellerboardApiAdapter.import({
      sourceConnectionId: 'sellerboard-source-1',
      sourceIdentifier: 'manual-live-date-check',
      sourceVersion: '2026-07-10',
      idempotencyKey: 'sellerboard-live-date-check',
      config: {
        reportUrls: [
          {
            name: 'Profit by Product Dashboard Daily Data',
            category: 'profit_by_product_daily',
            url: 'https://sellerboard.test/report.csv',
          },
        ],
      },
    })) {
      items.push(item);
    }

    const records = items
      .filter((item) => item.type === 'record')
      .flatMap((item) => (Array.isArray(item.record) ? item.record : [item.record]));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'listing_daily_fact',
          data: expect.objectContaining({ snapshotDate: '2026-06-09' }),
        }),
      ]),
    );
  });

  it('persists adapter-normalized month-first dates through the safe Bronze boundary', async () => {
    const csv = `Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,NetProfit
6/15/2026,Amazon.com,B007P55HOW,DC50944,Dampp Chaser,63.40,3,15.2
7/12/2026,Amazon.com,B007P55HOW,DC50944,Dampp Chaser,72.10,4,18.3`;
    const { db, service } = createService(csv);

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'manual-live-date-check',
      sourceVersion: '2026-07-12',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 2, errorCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ period: '2026-06-15' }) }),
        expect.objectContaining({ payload: expect.objectContaining({ period: '2026-07-12' }) }),
      ]),
    );
  });

  it('detects day-first live report files before parsing ambiguous dates', async () => {
    const csv = `${sellerboardGoodsCsv(
      '13/6/2026',
      15.2,
    )}\n8/7/2026,Amazon.com,B00DAYFIRST,DAY-FIRST,Day first,10,1,0,2,1,3,10%`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => csv })),
    );
    const items: any[] = [];
    for await (const item of sellerboardApiAdapter.import({
      sourceConnectionId: 'sellerboard-source-1',
      sourceIdentifier: 'manual-live-day-first-check',
      sourceVersion: '2026-07-10',
      idempotencyKey: 'sellerboard-live-day-first-check',
      config: {
        reportUrls: [
          {
            name: 'Profit by Product Dashboard Daily Data',
            category: 'profit_by_product_daily',
            url: 'https://sellerboard.test/report.csv',
          },
        ],
      },
    })) {
      items.push(item);
    }

    const dates = items
      .filter((item) => item.type === 'record')
      .flatMap((item) => (Array.isArray(item.record) ? item.record : [item.record]))
      .filter((record) => record?.kind === 'listing_daily_fact')
      .map((record) => record.data.snapshotDate);
    expect(dates).toEqual(['2026-06-13', '2026-07-08']);
  });

  it('sums live Sellerboard Dashboard by Product sales and unit channels', async () => {
    const csv = `Date,Marketplace,ASIN,SKU,Name,SalesOrganic,SalesPPC,SalesSponsoredProducts,SalesSponsoredDisplay,UnitsOrganic,UnitsPPC,UnitsSponsoredProducts,UnitsSponsoredDisplay,Refunds,GrossProfit,NetProfit,Sessions,Unit Session Percentage
2026-06-05,Amazon.com,B007P55HOW,DC50944,Dampp Chaser,63.40,10.10,5.50,1.00,3,2,1,1,0,20.1,35,30,10%`;
    const { db, service } = createService(csv);

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'manual-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 1, normalizedCount: 2, warningCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()[0]).toMatchObject({
      sourceDataset: 'sellerboard_daily_facts',
      payload: {
        salesOrganic: '63.40',
        salesPpc: '10.10',
        salesSponsoredProducts: '5.50',
        salesSponsoredDisplay: '1.00',
        unitsOrganic: '3',
        unitsPpc: '2',
        unitsSponsoredProducts: '1',
        unitsSponsoredDisplay: '1',
        netProfit: '35',
      },
    });
  });

  it('honors Asia/Karachi daily windows rather than treating configured times as UTC', async () => {
    const { service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));

    const early = await service.runScheduledSellerboardImports({ now: '2026-06-05T03:59:00.000Z' });
    expect(early.results).toEqual([
      expect.objectContaining({ status: 'not_due', dailyRefreshTime: '09:00', timezone: 'Asia/Karachi' }),
    ]);
    expect(fetch).not.toHaveBeenCalled();

    const due = await service.runScheduledSellerboardImports({ now: '2026-06-05T04:01:00.000Z' });
    expect(due.results).toEqual([expect.objectContaining({ status: 'success' })]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not churn a legacy non-retryable report-unit failure in the same Karachi daily cycle', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'legacy-failed-unit',
        sourceConnectionId: 'sellerboard-source-1',
        adapterName: 'sellerboard-api',
        sourceIdentifier: 'sellerboard:profit_by_product_daily',
        sourceVersion: '2026-06-05T08:00:00.000Z',
        idempotencyKey: 'legacy-failed-unit-key',
        startedAt: '2026-06-05T08:00:00.000Z',
        finishedAt: '2026-06-05T08:00:01.000Z',
        status: 'failed',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 1,
        summary: {
          reportUnitRetry: { attemptCount: 1, classification: 'non_retryable', reasonCode: 'stale_report' },
        },
      },
    });

    const result = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });

    expect(result.results).toEqual([
      expect.objectContaining({
        reportKind: 'profit_by_product_daily',
        status: 'terminal',
        reason: 'non_retryable_daily_cycle',
        attemptCount: 1,
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(1);
  });

  it('runs unrelated units independently and triggers Gold before a slower unit finishes', async () => {
    const { db, service } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            { name: 'Slow stock', category: 'stock_daily', url: 'https://sellerboard.test/slow.csv' },
            {
              name: 'Fast profit',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/fast.csv',
            },
          ],
          schedule: { enabled: true, dailyRefreshTime: '09:00' },
          requireFreshData: true,
          defaultCompany: 'Ecofission LLC',
          timezone: 'Asia/Karachi',
        },
      },
    });
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('slow')) await slow;
        return {
          ok: true,
          status: 200,
          text: async () =>
            url.includes('slow')
              ? 'ASIN,SKU,FBA/FBM Stock,"ROI, %"\nB000TEST,S-1,12,45'
              : sellerboardGoodsCsv('2026-06-05', 15.2),
        };
      }),
    );
    let resolveFastCommit!: () => void;
    const fastCommitted = new Promise<void>((resolve) => {
      resolveFastCommit = resolve;
    });
    const committed: string[] = [];

    const running = service.runScheduledSellerboardImports({
      now: '2026-06-05T09:01:00.000Z',
      onCommittedUnit: ({ reportKind }) => {
        committed.push(reportKind);
        if (reportKind === 'profit_by_product_daily') resolveFastCommit();
      },
    });
    const committedBeforeSlow = await Promise.race([
      fastCommitted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    releaseSlow();
    await expect(running).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ reportKind: 'stock_daily', status: 'success' }),
        expect.objectContaining({ reportKind: 'profit_by_product_daily', status: 'success' }),
      ]),
    });
    expect(committedBeforeSlow).toBe(true);
    expect(committed[0]).toBe('profit_by_product_daily');
  });

  it('persists a +10 minute overlap deferral without consuming another unit attempt', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { db, service } = createService(sellerboardGoodsCsv(today, 15.2));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await blocked;
        return { ok: true, status: 200, text: async () => sellerboardGoodsCsv(today, 15.2) };
      }),
    );

    const first = service.runSellerboardReportUnit({
      sourceConnectionId: 'sellerboard-source-1',
      reportKind: 'profit_by_product_daily',
    });
    while ((fetch as ReturnType<typeof vi.fn>).mock.calls.length === 0) await Promise.resolve();
    const overlap = await Promise.race([
      service.runSellerboardReportUnit({
        sourceConnectionId: 'sellerboard-source-1',
        reportKind: 'profit_by_product_daily',
      }),
      new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ status: 'test_timeout' }), 100)),
    ]);

    release();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ status: 'success' });
    expect(overlap).toMatchObject({
      status: 'deferred',
      reason: 'unit_already_running',
      attemptCount: 1,
      nextAttemptAt: expect.any(String),
    });
    expect(fetch).toHaveBeenCalledOnce();
    const runs = db.getRepository(ECOBASE_COLLECTIONS.importRuns).all();
    expect(runs.filter((run) => String(run.sourceIdentifier).startsWith('sellerboard-unit:'))).toHaveLength(1);
    expect(runs.filter((run) => String(run.sourceIdentifier).startsWith('sellerboard-unit-reservation:'))).toHaveLength(
      1,
    );
    expect(runs.filter((run) => String(run.sourceIdentifier).startsWith('sellerboard-unit-deferral:'))).toHaveLength(1);
  });

  it('persists transient retries at +10 then +30 minutes and caps a daily unit cycle at six attempts', async () => {
    const { db, service } = createService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })),
    );
    const runAt = (now: string) => service.runScheduledSellerboardImports({ now });

    await expect(runAt('2026-06-05T04:01:00.000Z')).resolves.toMatchObject({
      results: [expect.objectContaining({ status: 'failed', attemptCount: 1, retryDelayMinutes: 10 })],
    });
    await expect(runAt('2026-06-05T04:10:00.000Z')).resolves.toMatchObject({
      results: [expect.objectContaining({ status: 'waiting_retry', attemptCount: 1 })],
    });
    for (const [attempt, now] of [
      [2, '2026-06-05T04:11:00.000Z'],
      [3, '2026-06-05T04:41:00.000Z'],
      [4, '2026-06-05T05:11:00.000Z'],
      [5, '2026-06-05T05:41:00.000Z'],
      [6, '2026-06-05T06:11:00.000Z'],
    ] as const) {
      await expect(runAt(now)).resolves.toMatchObject({
        results: [
          expect.objectContaining({
            status: attempt === 6 ? 'terminal' : 'failed',
            attemptCount: attempt,
            ...(attempt < 6 ? { retryDelayMinutes: 30 } : { reason: 'retry_attempts_exhausted' }),
          }),
        ],
      });
    }
    await expect(runAt('2026-06-05T06:41:00.000Z')).resolves.toMatchObject({
      results: [expect.objectContaining({ status: 'terminal', reason: 'retry_attempts_exhausted', attemptCount: 6 })],
    });

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(
      db
        .getRepository(ECOBASE_COLLECTIONS.importRuns)
        .all()
        .filter((run) => String(run.sourceIdentifier).startsWith('sellerboard-unit-reservation:')),
    ).toHaveLength(6);
  });

  it('recovers one expired lease into a delayed retry and fails closed on ambiguous repeated recovery', async () => {
    const { db, service } = createService();
    const runs = db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    await runs.create({
      values: {
        id: 'expired-reservation',
        sourceConnectionId: 'sellerboard-source-1',
        adapterName: 'sellerboard-api',
        sourceIdentifier: 'sellerboard-unit-reservation:profit_by_product_daily',
        sourceVersion: '2026-06-05',
        idempotencyKey: 'sellerboard-unit-cycle:sellerboard-source-1:profit_by_product_daily:2026-06-05:attempt:1',
        startedAt: '2026-06-05T03:00:00.000Z',
        status: 'pending',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
        summary: {
          sellerboardUnitCycle: {
            reportKind: 'profit_by_product_daily',
            cycleDate: '2026-06-05',
            attempt: 1,
            leaseOwner: 'expired-owner',
            leaseExpiresAt: '2026-06-05T03:30:00.000Z',
            recoveryCount: 0,
          },
        },
      },
    });

    const recovered = await service.runScheduledSellerboardImports({ now: '2026-06-05T04:01:00.000Z' });
    expect(recovered.results).toEqual([
      expect.objectContaining({
        status: 'waiting_retry',
        reason: 'expired_lease_recovered',
        attemptCount: 1,
        retryDelayMinutes: 10,
      }),
    ]);
    expect(runs.all()[0]).toMatchObject({
      status: 'failed',
      summary: {
        sellerboardUnitCycle: {
          recoveryCount: 1,
          classification: 'retryable_transient',
          reasonCode: 'reservation_lease_expired',
        },
      },
    });
    expect(fetch).not.toHaveBeenCalled();

    await runs.update({
      filterByTk: 'expired-reservation',
      values: {
        status: 'pending',
        summary: {
          sellerboardUnitCycle: {
            reportKind: 'profit_by_product_daily',
            cycleDate: '2026-06-05',
            attempt: 1,
            leaseOwner: 'expired-owner',
            leaseExpiresAt: '2026-06-05T03:30:00.000Z',
            recoveryCount: 1,
          },
        },
      },
    });
    await expect(service.runScheduledSellerboardImports({ now: '2026-06-05T04:02:00.000Z' })).rejects.toThrow(
      'ambiguous expired reservation ownership',
    );
  });

  it('accepts a lagging scheduled report and stamps the run at the report real as-of date', async () => {
    // Sellerboard delivers ~2-day-old reports; the run cycles on 2026-06-05 but the newest data
    // is 2026-06-03. Batch C accepts the newest report rather than refusing it, and stamps the
    // committed run's sourceVersion with the report's real data date so coverage advances there.
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-03', 15.2));

    const first = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });
    expect(first.results[0]).toMatchObject({ reportKind: 'profit_by_product_daily', status: 'success' });

    const committed = db
      .getRepository(ECOBASE_COLLECTIONS.importRuns)
      .all()
      .find((run) => String(run.sourceIdentifier).startsWith('sellerboard-unit:'));
    expect(committed).toMatchObject({ status: 'success', sourceVersion: '2026-06-03' });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all().length).toBeGreaterThan(0);

    const second = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:30:00.000Z' });
    expect(second.results[0]).toMatchObject({
      reportKind: 'profit_by_product_daily',
      status: 'not_due',
      reason: 'report_unit_already_committed',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts the previous-day rolling report during bootstrap', async () => {
    const { service } = createService(sellerboardGoodsCsv('2026-06-04', 15.2));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-api-bootstrap-ecofission_llc',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 1, errorCount: 0 });
  });

  it('does not refetch a same-day report unit that already committed', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));

    const first = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });
    expect(first.results[0]).toMatchObject({ status: 'success' });

    const second = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:02:00.000Z' });
    expect(second.results[0]).toMatchObject({
      reportKind: 'profit_by_product_daily',
      status: 'not_due',
      reason: 'report_unit_already_committed',
    });
    const runs = db.getRepository(ECOBASE_COLLECTIONS.importRuns).all();
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceIdentifier: 'sellerboard-unit-reservation:profit_by_product_daily' }),
        expect.objectContaining({
          sourceIdentifier: 'sellerboard-unit:profit_by_product_daily',
          idempotencyKey: expect.stringMatching(/^sellerboard-source-1:profit_by_product_daily:[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect(runs).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toHaveLength(1);
  });

  it('reuses a canonical digest even when more than 100 newer successful runs exist', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));
    const source = await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).findOne({
      filterByTk: 'sellerboard-source-1',
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: { config: { ...((source as { config: object }).config ?? {}), requireFreshData: false } },
    });
    const importParams = {
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-unit:profit_by_product_daily',
      runtimeConfig: { reportKind: 'profit_by_product_daily' },
    } as const;
    const originalRun = await service.runAdapterImport({ ...importParams, sourceVersion: '2026-06-05' });
    const importRuns = db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    for (let index = 0; index < 101; index += 1) {
      await importRuns.create({
        values: {
          id: `newer-success-${index}`,
          sourceConnectionId: 'sellerboard-source-1',
          adapterName: 'sellerboard-api',
          sourceIdentifier: 'sellerboard-unit:profit_by_product_daily',
          sourceVersion: 'newer-version',
          idempotencyKey: `newer-success-key-${index}`,
          startedAt: new Date(Date.parse('2026-06-05T10:00:00.000Z') + index * 1000).toISOString(),
          finishedAt: new Date(Date.parse('2026-06-05T10:00:00.500Z') + index * 1000).toISOString(),
          status: 'success',
          rowCount: 1,
          normalizedCount: 1,
          warningCount: 0,
          errorCount: 0,
          summary: { reportUnitInputDigest: `newer-digest-${index}` },
        },
      });
    }

    const replay = await service.runAdapterImport({ ...importParams, sourceVersion: '2026-06-06' });

    expect(replay).toMatchObject({ id: originalRun.id, status: 'success', reused: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toHaveLength(1);
  });

  it('keeps Sellerboard scheduling disabled unless configuration explicitly enables it', async () => {
    const { db, service } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            {
              name: 'Profit by Product Dashboard Daily Data',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/report.csv',
            },
          ],
          schedule: { dailyRefreshTime: '09:00', retryIntervalMinutes: 60 },
        },
      },
    });

    await expect(service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' })).resolves.toMatchObject({
      results: [{ status: 'ignored', reason: 'schedule_disabled' }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails explicitly when a configured Sellerboard report kind is unsupported', async () => {
    const { db, service } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          reportUrls: [
            { name: 'Unknown report', category: 'unknown_report', url: 'https://sellerboard.test/unknown.csv' },
          ],
          schedule: { enabled: true, dailyRefreshTime: '09:00' },
        },
      },
    });

    await expect(service.sellerboardReportUnits('sellerboard-source-1')).rejects.toThrow(
      'Unknown report" has unsupported report kind "unknown_report"',
    );
  });

  it('isolates an invalid source/report unit so a later source still commits', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        name: 'A invalid Sellerboard source',
        config: {
          reportUrls: [
            { name: 'Unsupported report', category: 'unsupported_report', url: 'https://sellerboard.test/bad.csv' },
          ],
          schedule: { enabled: true, dailyRefreshTime: '09:00' },
        },
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'sellerboard-source-2',
        name: 'Z valid Sellerboard source',
        sourceType: 'sellerboard',
        domain: 'amazon_operations',
        active: true,
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            {
              name: 'Profit by Product Dashboard Daily Data',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/good.csv',
            },
          ],
          schedule: { enabled: true, dailyRefreshTime: '09:00' },
          defaultCompany: 'Ecofission LLC',
        },
      },
    });

    const result = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });

    expect(result.results).toEqual([
      expect.objectContaining({
        sourceConnectionId: 'sellerboard-source-1',
        status: 'failed',
        reasonCode: 'invalid_report_configuration',
      }),
      expect.objectContaining({
        sourceConnectionId: 'sellerboard-source-2',
        reportKind: 'profit_by_product_daily',
        status: 'success',
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('continues later report units when one unit throws unexpectedly', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));
    const sourceRepository = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    await sourceRepository.update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            { name: 'First report', category: 'stock_daily', url: 'https://sellerboard.test/first.csv' },
            {
              name: 'Later report',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/later.csv',
            },
          ],
          schedule: { enabled: true, dailyRefreshTime: '09:00' },
          defaultCompany: 'Ecofission LLC',
        },
      },
    });
    const find = sourceRepository.find.bind(sourceRepository);
    let sourceFindCount = 0;
    vi.spyOn(sourceRepository, 'find').mockImplementation(async (params) => {
      sourceFindCount += 1;
      if (sourceFindCount === 2) throw new Error('fixture unexpected per-unit lookup failure');
      return find(params);
    });

    const result = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' });

    expect(result.results).toEqual([
      expect.objectContaining({
        reportKind: 'stock_daily',
        status: 'failed',
        reasonCode: 'report_unit_execution_exception',
        message: 'fixture unexpected per-unit lookup failure',
      }),
      expect.objectContaining({ reportKind: 'profit_by_product_daily', status: 'success' }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast when report-unit transaction support is unavailable', async () => {
    const { db, service } = createService();
    const sourceRepository = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const find = sourceRepository.find.bind(sourceRepository);
    let sourceFindCount = 0;
    vi.spyOn(sourceRepository, 'find').mockImplementation(async (params) => {
      sourceFindCount += 1;
      if (sourceFindCount === 2) {
        throw new Error('Ecobase atomic Sellerboard report-unit import requires database transaction support.');
      }
      return find(params);
    });

    await expect(service.runScheduledSellerboardImports({ now: '2026-06-05T09:01:00.000Z' })).rejects.toThrow(
      'requires database transaction support',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('commits both a current-day and a lagging report unit as success', async () => {
    // Both a same-day report and a 2-day-lagging report are now accepted and committed; neither is
    // marked stale/terminal. Once committed, the same cycle does not refetch them.
    const { db, service } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          catalogMutationMode: 'rebuild',
          reportUrls: [
            {
              name: 'Current report',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/current.csv',
            },
            { name: 'Lagging report', category: 'profit_dashboard', url: 'https://sellerboard.test/lagging.csv' },
          ],
          schedule: { enabled: true, dailyRefreshTime: '09:00', retryIntervalMinutes: 60 },
          defaultCompany: 'Ecofission LLC',
        },
      },
    });
    const laggingDate = '2026-06-03';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        text: async () => sellerboardGoodsCsv(url.includes('lagging') ? laggingDate : '2026-06-05', 18.4),
      })),
    );
    const committed: string[] = [];

    const run = await service.runScheduledSellerboardImports({
      now: '2026-06-05T09:01:00.000Z',
      onCommittedUnit: ({ reportKind }) => {
        committed.push(reportKind);
      },
    });

    expect(run.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reportKind: 'profit_by_product_daily', status: 'success' }),
        expect.objectContaining({ reportKind: 'profit_dashboard', status: 'success' }),
      ]),
    );
    expect([...committed].sort()).toEqual(['profit_by_product_daily', 'profit_dashboard']);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all().length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(2);

    const sameCycle = await service.runScheduledSellerboardImports({ now: '2026-06-05T09:30:00.000Z' });
    expect(sameCycle.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reportKind: 'profit_by_product_daily', status: 'not_due' }),
        expect.objectContaining({ reportKind: 'profit_dashboard', status: 'not_due' }),
      ]),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('records missing Sellerboard URL configuration as a credential blocker audit record', async () => {
    const { db, service } = createService();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: { config: {} },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'blocked', normalizedCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits).all()).toEqual([
      expect.objectContaining({ status: 'blocked', blockerCode: 'sellerboard_credentials_missing' }),
    ]);
  });

  it('ties invalid live Sellerboard CSV shapes to raw row errors on the import run', async () => {
    const { db, service } = createService('Unexpected,Header\nvalue,1');
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).update({
      filterByTk: 'sellerboard-source-1',
      values: {
        config: {
          reportUrls: [
            {
              name: 'Malformed report',
              category: 'profit_by_product_daily',
              url: 'https://sellerboard.test/malformed.csv?t=redacted',
            },
          ],
          requireFreshData: false,
        },
      },
    });

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'failed', errorCount: 1, normalizedCount: 0 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([
      expect.objectContaining({ issueCode: 'csv_shape_unknown', normalizationStatus: 'failed' }),
    ]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).all()).toEqual([]);
    expect(db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).all()).toEqual([]);
  });

  it('ties row-level live Sellerboard CSV warnings to the import run while keeping valid sibling rows', async () => {
    const mixedCsv = `Date,Marketplace,ASIN,SKU,Name,SalesOrganic,UnitsOrganic,Refunds,GrossProfit,NetProfit,Sessions,Unit Session Percentage
2026-06-05,Amazon.com,,,Missing Identity,10,1,0,4,3,5,20%
2026-06-05,Amazon.com,B007P55HOW,DC50944,Dampp Chaser,63.40,3,0,20.1,15.2,30,10%`;
    const { db, service } = createService(mixedCsv);

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-live-check',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    expect(run).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 2, warningCount: 1 });
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([
      expect.objectContaining({ rowNumber: 2, issueCode: 'csv_row_identity_missing', issueSeverity: 'warning' }),
      expect.objectContaining({ rowNumber: 3, normalizationStatus: 'normalized' }),
    ]);
  });

  it('force-refresh appends run-scoped safe Bronze evidence', async () => {
    const { db, service } = createService(sellerboardGoodsCsv('2026-06-05', 15.2));

    await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-force-refresh',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => sellerboardGoodsCsv('2026-06-05', 31.5) })),
    );
    await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source-1',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-force-refresh',
      sourceVersion: '2026-06-05',
      preserveAuditRun: true,
    });

    const bronze = db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all();
    expect(bronze).toHaveLength(2);
    expect(bronze[1]).toMatchObject({ payload: expect.objectContaining({ netProfit: '31.5' }) });
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(2);
  });

  it('documents live-gate persistence defaults and destructive-reset guardrails', () => {
    const pluginRoot = resolve(__dirname, '../../..');
    const compose = readFileSync(resolve(pluginRoot, 'docker/live-gate.compose.yml'), 'utf8');
    const start = readFileSync(resolve(pluginRoot, 'scripts/start-live-gate.sh'), 'utf8');
    const stop = readFileSync(resolve(pluginRoot, 'scripts/stop-live-gate.sh'), 'utf8');
    const backup = readFileSync(resolve(pluginRoot, 'scripts/backup-live-gate-db.sh'), 'utf8');
    const startup = readFileSync(resolve(pluginRoot, 'docker/live-gate-startup.sh'), 'utf8');

    expect(compose).toContain('ecobase-live-gate-postgres:/var/lib/postgresql/data');
    expect(startup).toContain('existing QA database detected; preserving data');
    expect(startup).toContain('applicationVersion');
    expect(start).toContain('down --remove-orphans');
    expect(start).toContain('ECOBASE_LIVE_GATE_CONFIRM_DESTROY=destroy-live-sellerboard-data');
    expect(stop).toContain('down --remove-orphans');
    expect(stop).toContain('down --volumes --remove-orphans');
    expect(backup).toContain('pg_dump --username nocobase --dbname nocobase');
  });
});
