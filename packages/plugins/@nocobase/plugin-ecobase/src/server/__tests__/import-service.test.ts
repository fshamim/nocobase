/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { createSourceAdapterRegistry, noopTestAdapter } from '../../features/source-import/server/adapters';
import type { SourceAdapter } from '../../features/source-import/server/adapters';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import {
  EcobaseDatabase,
  EcobaseImportService,
  EcobaseRepository,
} from '../../features/source-import/server/import-service';

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
      throw new Error(`MemoryRepository update failed: matching record was not found.`);
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
      if (leftValue === rightValue) {
        return 0;
      }
      const result = leftValue > rightValue ? 1 : -1;
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

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

function createServiceWithSourceConnection() {
  const db = new MemoryDatabase();
  const sourceConnectionRepo = db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
  sourceConnectionRepo.create({
    values: {
      id: 'source-1',
      name: 'No-op source',
      sourceType: 'noop_test',
      domain: 'foundation',
      config: {},
      active: true,
    },
  });
  return {
    db,
    service: new EcobaseImportService(db, createSourceAdapterRegistry([noopTestAdapter])),
  };
}

describe('Ecobase no-op import and status seam', () => {
  it('creates an auditable completed import run with zero rows', async () => {
    const { db, service } = createServiceWithSourceConnection();

    const run = await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      sourceConnectionId: 'source-1',
      adapterName: 'noop-test',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
      idempotencyKey: 'source-1:manual-noop:v1',
      status: 'success',
      rowCount: 0,
      normalizedCount: 0,
      warningCount: 0,
      errorCount: 0,
    });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([]);
  });

  it('reuses the same run for the same source version and idempotency key', async () => {
    const { db, service } = createServiceWithSourceConnection();

    const first = await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });
    const second = await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });

    expect(second.id).toBe(first.id);
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toHaveLength(1);
  });

  it('rejects source connections that do not match the selected adapter source type and domain', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'sellerboard-source',
        name: 'Sellerboard source',
        sourceType: 'sellerboard',
        domain: 'profitability',
        config: {},
        active: true,
      },
    });
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([noopTestAdapter]));

    await expect(
      service.runNoopImport({
        sourceConnectionId: 'sellerboard-source',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
      }),
    ).rejects.toThrow(
      'Ecobase import failed: source connection "sellerboard-source" has sourceType "sellerboard" but adapter "noop-test" requires "noop_test".',
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([]);
  });

  it('rejects source connections with unsupported domains before creating an import run', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'wrong-domain-source',
        name: 'Wrong domain source',
        sourceType: 'noop_test',
        domain: 'sellerboard',
        config: {},
        active: true,
      },
    });
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([noopTestAdapter]));

    await expect(
      service.runNoopImport({
        sourceConnectionId: 'wrong-domain-source',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
      }),
    ).rejects.toThrow(
      'Ecobase import failed: source connection "wrong-domain-source" has domain "sellerboard" but adapter "noop-test" supports domains: foundation.',
    );
    expect(db.getRepository(ECOBASE_COLLECTIONS.importRuns).all()).toEqual([]);
  });

  it('quarantines a Sellerboard refresh row that proposes protected catalog drift instead of aborting', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'sellerboard-source',
        name: 'Sellerboard source',
        sourceType: 'sellerboard',
        domain: 'profitability',
        config: {},
        active: true,
      },
    });
    let sourceReadStarted = false;
    const sellerboardAdapter: SourceAdapter = {
      metadata: {
        name: 'sellerboard-api',
        title: 'Sellerboard API',
        sourceType: 'sellerboard',
        supportedDomains: ['profitability'],
        version: '1',
      },
      async *import() {
        sourceReadStarted = true;
        yield {
          type: 'record',
          rowNumber: 2,
          sourceKey: 'sellerboard.csv:2',
          payload: {
            Company: 'Ecofission LLC',
            Date: '2026-07-17',
            Marketplace: 'Amazon.com',
            ASIN: 'B000000001',
            SKU: 'SKU-1',
            SalesOrganic: '10',
          },
          record: {
            kind: 'listing_daily_fact',
            data: { company: 'Ecofission LLC', asin: 'B000000001', sku: 'SKU-1' },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([sellerboardAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-refresh',
      sourceVersion: 'v1',
    });

    // The one unknown listing is skipped (quarantined) rather than failing the whole refresh:
    // no error, no Bronze row for it, and the identity is surfaced on the run summary.
    expect(run).toMatchObject({
      status: 'success',
      errorCount: 0,
      rowCount: 0,
      normalizedCount: 0,
      summary: {
        reportQuarantine: [
          {
            company: 'Ecofission LLC',
            marketplace: 'Amazon.com',
            asin: 'B000000001',
            listingSku: 'SKU-1',
            missing: ['company', 'amazon account', 'product', 'company product'],
            reasonCode: 'protected_company_product_identity',
          },
        ],
      },
    });
    expect(sourceReadStarted).toBe(true);
    expect(db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).all()).toEqual([]);
  });

  it('auto-adds a new Sellerboard listing (once), imports its row, and quarantines only malformed ones', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'sellerboard-source',
        name: 'Sellerboard source',
        sourceType: 'sellerboard',
        domain: 'profitability',
        companyId: 'company-0',
        config: {},
        active: true,
      },
    });
    // A known company + default account already exist; the listing itself does not.
    await db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanies)
      .create({ values: { id: 'company-0', companyKey: 'ECOFISSION_LLC', name: 'Ecofission LLC' } });
    await db
      .getRepository(ECOBASE_COLLECTIONS.silverAmazonAccounts)
      .create({ values: { id: 'account-0', companyId: 'company-0', marketplace: 'Amazon.com', isDefault: true } });

    const newListingRow = (rowNumber: number) => ({
      type: 'record' as const,
      rowNumber,
      sourceKey: `sellerboard.csv:${rowNumber}`,
      payload: {
        Company: 'Ecofission LLC',
        Date: '2026-07-17',
        Marketplace: 'Amazon.com',
        ASIN: 'B999999999',
        SKU: 'NEW-SKU',
        SalesOrganic: '10',
      },
      record: {
        kind: 'listing_daily_fact' as const,
        data: { company: 'Ecofission LLC', asin: 'B999999999', sku: 'NEW-SKU' },
      },
    });
    const sellerboardAdapter: SourceAdapter = {
      metadata: {
        name: 'sellerboard-api',
        title: 'Sellerboard API',
        sourceType: 'sellerboard',
        supportedDomains: ['profitability'],
        version: '1',
      },
      async *import() {
        // Same new listing twice (double occurrence) plus one genuinely malformed row.
        yield newListingRow(2);
        yield newListingRow(3);
        yield {
          type: 'record',
          rowNumber: 4,
          sourceKey: 'sellerboard.csv:4',
          payload: {
            Company: 'Ecofission LLC',
            Date: '2026-07-17',
            Marketplace: 'Amazon.com',
            ASIN: 'BADXYZ',
            SKU: 'BAD-SKU',
            SalesOrganic: '3',
          },
          record: {
            kind: 'listing_daily_fact',
            data: { company: 'Ecofission LLC', asin: 'BADXYZ', sku: 'BAD-SKU' },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([sellerboardAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'sellerboard-source',
      adapterName: 'sellerboard-api',
      sourceIdentifier: 'sellerboard-refresh',
      sourceVersion: 'v1',
    });

    const summary = run.summary as Record<string, unknown>;
    // The unknown-but-valid listing is auto-added exactly once, counted on the summary. (Daily-fact
    // rows carry no Title column, so no title is projected — that is expected for this dataset.)
    expect(summary.newlyAddedListings).toEqual([
      {
        company: 'Ecofission LLC',
        asin: 'B999999999',
        sku: 'NEW-SKU',
        marketplace: 'Amazon.com',
      },
    ]);
    // The malformed row (invalid ASIN shape) is set aside for review, not auto-added.
    expect(summary.reportQuarantine).toMatchObject([
      { asin: 'BADXYZ', reasonCode: 'protected_company_product_identity' },
    ]);
    // Exactly one catalog record set was created for the new listing.
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverProducts).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).all()).toHaveLength(1);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).all()).toHaveLength(1);
    // Its sales rows imported in the same run (the malformed row did not).
    expect(run.rowCount).toBe(2);
  });

  it('rejects invalid generic supplier lead-time imports before persistence', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'Supplier lead-time source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const invalidLeadTimeAdapter: SourceAdapter = {
      metadata: {
        name: 'invalid-lead-time-test',
        title: 'Invalid lead-time test',
        sourceType: 'noop_test',
        supportedDomains: ['foundation'],
        version: '1',
      },
      async *import() {
        yield {
          type: 'record',
          rowNumber: 1,
          sourceKey: 'lead-times.csv:1',
          payload: {
            'SR ID': 'SRO-BAD',
            'Supplier Name': 'Bad Supplier',
            'Supplier Type': 'Manufacturer',
            'Reached Via': 'Ecofission LLC',
            'Lead time(day)': -1,
          },
          record: {
            kind: 'supplier_lead_time',
            data: {
              naturalKey: 'supplier-lead-time:Ecofission LLC:bad-supplier',
              sourceConnectionId: 'source-1',
              supplierName: 'Bad Supplier',
              company: 'Ecofission LLC',
              leadTimeDays: -1,
              source: 'test',
            },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([invalidLeadTimeAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'invalid-lead-time-test',
      sourceIdentifier: 'invalid-lead-time',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      status: 'failed',
      errorCount: 1,
      errorMessage: 'Ecobase import failed: supplier_lead_time: leadTimeDays must be an integer from 0 to 3650.',
    });
  });

  it('rejects invalid planning-parameter lead-time imports before persistence', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'Planning parameter source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const invalidPlanningParameterAdapter: SourceAdapter = {
      metadata: {
        name: 'invalid-planning-parameter-test',
        title: 'Invalid planning parameter test',
        sourceType: 'noop_test',
        supportedDomains: ['foundation'],
        version: '1',
      },
      async *import() {
        yield {
          type: 'record',
          rowNumber: 1,
          sourceKey: 'profit-planning.csv:1',
          payload: {
            Company: 'Ecofission LLC',
            ASIN: 'B00BADLEAD',
            Month: '2026-07',
            'Exp Sales Vel': '1',
            'Lead time(day)': 1.5,
          },
          record: {
            kind: 'planning_parameter',
            data: {
              naturalKey: 'planning-parameter:Ecofission LLC:B00BADLEAD',
              sourceConnectionId: 'source-1',
              company: 'Ecofission LLC',
              asin: 'B00BADLEAD',
              leadTimeDays: 1.5,
            },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([invalidPlanningParameterAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'invalid-planning-parameter-test',
      sourceIdentifier: 'invalid-planning-parameter',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      status: 'failed',
      errorCount: 1,
      errorMessage: 'Ecobase import failed: planning_parameter: leadTimeDays must be an integer from 0 to 3650.',
    });
  });

  it('rejects non-number planning-parameter lead-time imports before persistence', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: 'source-1',
        name: 'Planning parameter source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    const invalidPlanningParameterAdapter: SourceAdapter = {
      metadata: {
        name: 'invalid-planning-parameter-string-test',
        title: 'Invalid planning parameter string test',
        sourceType: 'noop_test',
        supportedDomains: ['foundation'],
        version: '1',
      },
      async *import() {
        yield {
          type: 'record',
          rowNumber: 1,
          sourceKey: 'profit-planning.csv:1',
          payload: {
            Company: 'Ecofission LLC',
            ASIN: 'B00STRINGLEAD',
            Month: '2026-07',
            'Exp Sales Vel': '1',
            'Lead time(day)': '4000',
          },
          record: {
            kind: 'planning_parameter',
            data: {
              naturalKey: 'planning-parameter:Ecofission LLC:B00STRINGLEAD',
              sourceConnectionId: 'source-1',
              company: 'Ecofission LLC',
              asin: 'B00STRINGLEAD',
              leadTimeDays: '4000',
            },
          },
        };
      },
    };
    const service = new EcobaseImportService(db, createSourceAdapterRegistry([invalidPlanningParameterAdapter]));

    const run = await service.runAdapterImport({
      sourceConnectionId: 'source-1',
      adapterName: 'invalid-planning-parameter-string-test',
      sourceIdentifier: 'invalid-planning-parameter-string',
      sourceVersion: 'v1',
    });

    expect(run).toMatchObject({
      status: 'failed',
      errorCount: 1,
      errorMessage: 'Ecobase import failed: planning_parameter: leadTimeDays must be a number.',
    });
  });

  it('reads source/import status through the service seam used by the public API', async () => {
    const { service } = createServiceWithSourceConnection();
    await service.runNoopImport({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
    });

    await expect(service.listSourceStatuses()).resolves.toEqual([
      expect.objectContaining({
        sourceConnectionId: 'source-1',
        connectionName: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        active: true,
        required: false,
        freshnessSlaMinutes: null,
        latestRunStatus: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        latestRunWarningCount: 0,
        errorCount: 0,
        latestWarning: null,
        warnings: [],
      }),
    ]);
  });

  it('surfaces stale source warnings from source-type freshness policies', async () => {
    const { db, service } = createServiceWithSourceConnection();
    await db.getRepository(ECOBASE_COLLECTIONS.sourceWarningPolicies).create({
      values: {
        naturalKey: 'warning-policy:noop_test',
        sourceType: 'noop_test',
        freshnessSlaMinutes: 60,
        active: true,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-success',
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
        idempotencyKey: 'source-1:manual-noop:v1',
        startedAt: '2025-01-01T00:00:00.000Z',
        finishedAt: '2025-01-01T00:10:00.000Z',
        status: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
    });

    const [status] = await service.listSourceStatuses();

    expect(status).toMatchObject({
      sourceConnectionId: 'source-1',
      required: false,
      freshnessSlaMinutes: 60,
      latestRunStatus: 'success',
      warningCount: 1,
      latestWarning: expect.objectContaining({ code: 'stale_successful_run' }),
    });
    expect(status.warnings).toEqual([
      expect.objectContaining({
        code: 'stale_successful_run',
        message: 'Latest successful import for source "No-op source" is stale.',
      }),
    ]);
  });

  it('surfaces failed latest run warnings separately from successful-run freshness', async () => {
    const { db, service } = createServiceWithSourceConnection();
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-success',
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
        idempotencyKey: 'source-1:manual-noop:v1',
        startedAt: '2025-06-01T00:00:00.000Z',
        finishedAt: '2025-06-01T00:10:00.000Z',
        status: 'success',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
    });
    await db.getRepository(ECOBASE_COLLECTIONS.importRuns).create({
      values: {
        id: 'run-failed',
        sourceConnectionId: 'source-1',
        adapterName: 'noop-test',
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v2',
        idempotencyKey: 'source-1:manual-noop:v2',
        startedAt: '2025-06-02T00:00:00.000Z',
        finishedAt: '2025-06-02T00:10:00.000Z',
        status: 'failed',
        rowCount: 0,
        normalizedCount: 0,
        warningCount: 0,
        errorCount: 1,
        errorMessage: 'Boom',
      },
    });

    const [status] = await service.listSourceStatuses();

    expect(status).toMatchObject({
      latestImportRunId: 'run-failed',
      latestRunStatus: 'failed',
      warningCount: 1,
      latestWarning: expect.objectContaining({ code: 'failed_latest_run' }),
    });
    expect(status.warnings).toEqual([
      expect.objectContaining({
        code: 'failed_latest_run',
        importRunId: 'run-failed',
        message: 'Latest import for source "No-op source" failed.',
      }),
    ]);
  });
});
