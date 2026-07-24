/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  EcobaseGoldRefreshRunService,
  type GoldPublicationPayload,
} from '../../features/inventory-planning/server/gold-refresh-run-service';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import {
  CORRECTED_ALGORITHM_CONTRACT_VERSION,
  CORRECTED_CANONICAL_SERIALIZER_VERSION,
  CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION,
  CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
  CORRECTED_LISTING_ROW_DIGEST_VERSION,
  CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION,
  CORRECTED_TIER_RULE_VERSION,
  correctedFamilyActionProjectionDigest,
  correctedListingRowDigest,
  deriveCorrectedFamilyActionsFromListingRows,
  type CorrectedListingPerformanceRow,
} from '../../features/inventory-planning/server/listing-family-projection';
import { EcobaseInventoryPlanningGoldAccess } from '../../features/inventory-planning/server/inventory-planning-gold-access';
import { referenceProtectedSilverFingerprint } from '../../features/inventory-planning/server/independent-gold-reference-verifier';
import {
  blockRawGoldInventoryPlanningAccess,
  registerGoldInventoryPlanningWriteGuard,
  withGoldInventoryPlanningWriteAuthority,
} from '../../features/inventory-planning/server/gold-write-guard';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { EcobaseSupplierOrderService } from '../../features/supplier-management/server/supplier-order-service';
import { EcobaseSupplierManagementService } from '../../features/supplier-management/server/supplier-management-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createEcobaseInventoryPlanningActions } from '../resource-actions';

type Row = Record<string, unknown>;
type Query = { filter?: Row; filterByTk?: string | number; sort?: string[]; limit?: number; offset?: number };

class MemoryRepository implements EcobaseRepository {
  constructor(readonly rows: Row[] = []) {}

  async find(params: Query = {}) {
    const matches = this.matches(params);
    const [sort] = params.sort ?? [];
    const sorted = sort
      ? [...matches].sort((left, right) => {
          const descending = sort.startsWith('-');
          const key = descending ? sort.slice(1) : sort;
          const comparison = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
          return descending ? -comparison : comparison;
        })
      : matches;
    const offset = params.offset ?? 0;
    return sorted.slice(offset, offset + (params.limit ?? sorted.length));
  }

  async findOne(params: Query = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Row }) {
    this.rows.push({ ...values });
    return values;
  }

  async update({ filter, filterByTk, values }: { filter?: Row; filterByTk?: string | number; values: Row }) {
    const matches = this.matches({ filter, filterByTk });
    if (matches.length === 0) throw new Error('Memory refresh repository update failed: row was not found.');
    matches.forEach((row) => Object.assign(row, values));
    return matches[0];
  }

  private matches(params: Query) {
    return this.rows.filter((row) => {
      if (params.filterByTk !== undefined && row.id !== params.filterByTk) return false;
      return Object.entries(params.filter ?? {}).every(([key, value]) => row[key] === value);
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly runs = new MemoryRepository();
  readonly gold = new MemoryRepository();
  private readonly repositories = new Map<string, MemoryRepository>([
    [ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns, this.runs],
    [ECOBASE_COLLECTIONS.goldInventoryPlanningRows, this.gold],
  ]);

  getRepository(name: string) {
    if (!this.repositories.has(name)) this.repositories.set(name, new MemoryRepository());
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Missing in-memory repository ${name}.`);
    return repository;
  }
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function validStockContract() {
  return {
    onHandSellableStock: 10,
    amazonPipelineStock: 5,
    supplierPipelineStock: 20,
    inventoryPositionStock: 15,
    futurePositionStock: 35,
    familyOnHandSellableStock: 10,
    familyAmazonPipelineStock: 5,
    familySupplierPipelineStock: 20,
    familyInventoryPositionStock: 15,
    familyFuturePositionStock: 35,
  };
}

function testCandidateInputDigests(seed: string) {
  const digest = (part: string) => createHash('sha256').update(`${seed}:${part}`).digest('hex');
  return {
    sourceInputDigest: digest('source'),
    coverageInputDigest: digest('coverage'),
    settingsDigest: digest('settings'),
    algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
  };
}

function closedMonthEvidence(calculationDate: string) {
  const date = new Date(`${calculationDate}T00:00:00.000Z`);
  return Array.from({ length: 6 }, (_, offset) => {
    const monthStartDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 6 + offset, 1));
    const monthStart = monthStartDate.toISOString().slice(0, 10);
    const monthEnd = new Date(Date.UTC(monthStartDate.getUTCFullYear(), monthStartDate.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    return {
      monthStart,
      monthEnd,
      eligible: false,
      reasonCode: 'product_scope_unknown',
      sourceFactCount: 0,
      monthlyUnits: null,
      monthlyProfit: null,
      monthlyProfitPerUnit: null,
      monthlyTierScore: null,
    };
  });
}

function correctedProjectionMetadata(input: {
  runId: string;
  candidateInputDigest: string;
  calculationDate: string;
  rows: Row[];
  candidateInputDigests: ReturnType<typeof testCandidateInputDigests>;
  protectedSilverFingerprint: string;
}) {
  const generatedAt = `${input.calculationDate}T00:00:00.000Z`;
  const listingRows = input.rows as unknown as CorrectedListingPerformanceRow[];
  const familyActions = deriveCorrectedFamilyActionsFromListingRows(listingRows, {
    runId: input.runId,
    generatedAt,
  });
  const digest = (part: string) => createHash('sha256').update(`${input.runId}:${part}`).digest('hex');
  return {
    ruleVersion: CORRECTED_TIER_RULE_VERSION,
    algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
    canonicalSerializerVersion: CORRECTED_CANONICAL_SERIALIZER_VERSION,
    candidateInputDigestVersion: CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION,
    sourceCoverageDigestVersion: CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION,
    listingRowDigestVersion: CORRECTED_LISTING_ROW_DIGEST_VERSION,
    familyActionProjectionDigestVersion: CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
    resolvedPlanningSettingsDigest: input.candidateInputDigests.settingsDigest,
    currentProjectionGateMode: 'informational',
    protectedSilverFingerprint: input.protectedSilverFingerprint,
    sourceCoverageDigest: input.candidateInputDigests.coverageInputDigest,
    sourceInputDigest: input.candidateInputDigests.sourceInputDigest,
    candidateInputDigest: input.candidateInputDigest,
    listingRowCount: listingRows.length,
    listingRowDigest: correctedListingRowDigest(listingRows),
    familyActionProjectionCount: familyActions.length,
    familyActionProjectionDigest: correctedFamilyActionProjectionDigest(familyActions),
  };
}

const PUBLICATION_PAYLOAD_FIELDS = [
  'runId',
  'status',
  'ruleVersion',
  'algorithmContractVersion',
  'canonicalSerializerVersion',
  'candidateInputDigestVersion',
  'sourceCoverageDigestVersion',
  'listingRowDigestVersion',
  'familyActionProjectionDigestVersion',
  'resolvedPlanningSettingsDigest',
  'currentProjectionGateMode',
  'protectedSilverFingerprint',
  'sourceCoverageDigest',
  'sourceInputsDigest',
  'candidateInputDigest',
  'listingRowCount',
  'listingRowDigest',
  'familyActionProjectionCount',
  'familyActionProjectionDigest',
  'productionVerificationDigest',
  'independentVerificationDigest',
  'confirmation',
] as const;

function publicationPayloadFixture(db: MemoryDatabase, runId: string): GoldPublicationPayload {
  const run = db.runs.rows.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Publication payload fixture could not find run "${runId}".`);
  const digest = (part: string) => createHash('sha256').update(`${runId}:${part}`).digest('hex');
  Object.assign(run, {
    ruleVersion: run.ruleVersion ?? CORRECTED_TIER_RULE_VERSION,
    algorithmContractVersion: run.algorithmContractVersion ?? CORRECTED_ALGORITHM_CONTRACT_VERSION,
    canonicalSerializerVersion: run.canonicalSerializerVersion ?? CORRECTED_CANONICAL_SERIALIZER_VERSION,
    candidateInputDigestVersion: run.candidateInputDigestVersion ?? CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION,
    sourceCoverageDigestVersion: run.sourceCoverageDigestVersion ?? CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION,
    listingRowDigestVersion: run.listingRowDigestVersion ?? CORRECTED_LISTING_ROW_DIGEST_VERSION,
    familyActionProjectionDigestVersion:
      run.familyActionProjectionDigestVersion ?? CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
    resolvedPlanningSettingsDigest: run.resolvedPlanningSettingsDigest ?? digest('settings'),
    currentProjectionGateMode: run.currentProjectionGateMode ?? 'informational',
    protectedSilverFingerprint: run.protectedSilverFingerprint ?? digest('protected'),
    sourceCoverageDigest: run.sourceCoverageDigest ?? digest('coverage'),
    sourceInputsDigest: run.sourceInputsDigest ?? digest('source'),
    listingRowCount: run.listingRowCount ?? run.rowCount,
    listingRowDigest: run.listingRowDigest ?? digest('listings'),
    familyActionProjectionCount:
      run.familyActionProjectionCount ??
      new Set(db.gold.rows.filter((row) => row.refreshRunId === runId).map((row) => row.companyProductFamilyId)).size,
    familyActionProjectionDigest: run.familyActionProjectionDigest ?? digest('family-actions'),
  });
  return Object.fromEntries(
    PUBLICATION_PAYLOAD_FIELDS.map((field) => {
      if (field === 'runId') return [field, run.id];
      if (field === 'status') return [field, 'verified'];
      if (field === 'confirmation') return [field, 'PUBLISH GOLD'];
      return [field, run[field]];
    }),
  ) as unknown as GoldPublicationPayload;
}

async function buildRun(
  db: MemoryDatabase,
  params: { date: string; key: string; publish?: boolean; rowIds?: string[] },
) {
  const service = new EcobaseGoldRefreshRunService(db);
  const candidateInputDigests = testCandidateInputDigests(params.key);
  const protectedSilverFingerprint = await referenceProtectedSilverFingerprint(db);
  const materialized = await service.execute({
    calculationDate: params.date,
    idempotencyKey: params.key,
    publish: false,
    candidateInputDigests,
    request: { calculationDate: params.date },
    materialize: async ({ runId, candidateInputDigest }) => {
      const rowIds = params.rowIds ?? [params.key];
      for (const rowId of rowIds) {
        await db.gold.create({
          values: {
            id: `${runId}:${rowId}`,
            refreshRunId: runId,
            naturalKey: `${runId}:${rowId}`,
            companyProductId: rowId,
            companyProductFamilyId: `${rowId}:family`,
            companyId: `${rowId}:company`,
            amazonAccountId: `${rowId}:account`,
            marketplace: 'Amazon.com',
            company: 'ACME',
            asin: rowId,
            sku: `${rowId}:sku`,
            calculationDate: params.date,
            candidateInputDigest,
            ruleVersion: CORRECTED_TIER_RULE_VERSION,
            algorithmContractVersion: CORRECTED_ALGORITHM_CONTRACT_VERSION,
            productCoverageDigest: candidateInputDigests.coverageInputDigest,
            resolvedPlanningSettingsDigest: candidateInputDigests.settingsDigest,
            monthlyPerformanceEvidence: closedMonthEvidence(params.date),
            baselineEligibleMonthCount: 0,
            baselineTotalUnits: null,
            baselineTotalProfit: null,
            averageMonthlyUnits: null,
            averageMonthlyProfit: null,
            baselineTierScore: null,
            baselineWeightedProfitPerUnit: null,
            baselineTier: null,
            baselineState: 'unclassified',
            baselineConfidence: 'none',
            listingReviewCategories: ['data_readiness'],
            replenishmentEligibility: 'blocked_insufficient_evidence',
            replenishmentBlockReasonCode: 'blocked_insufficient_evidence',
            primaryActionPane: 'dataReadiness',
            primaryActionReasonCode: 'insufficient_baseline_evidence',
            newReplenishmentActionable: false,
            existingOrderFollowUp: false,
            existingOrderFollowUpAction: 'none',
            oosAlertActionable: false,
            supplyActionable: false,
            calculationEvidence: {
              familyActionSnapshot: {
                familyKey: `${rowId}:family`,
                companyProductFamilyId: `${rowId}:family`,
                companyId: `${rowId}:company`,
                amazonAccountId: `${rowId}:account`,
                marketplace: 'Amazon.com',
                canonicalAsin: rowId,
                targetSelectionState: 'automatic',
                targetCompanyProductId: rowId,
                targetSelectionEvidence: { source: 'test' },
              },
            },
            ...validStockContract(),
          },
        });
      }
      const rows = db.gold.rows.filter((row) => row.refreshRunId === runId);
      return {
        calculationDate: params.date,
        rowCount: rowIds.length,
        created: rowIds.length,
        updated: 0,
        lastRefreshedAt: `${params.date}T00:00:00.000Z`,
        ...correctedProjectionMetadata({
          runId,
          candidateInputDigest,
          calculationDate: params.date,
          rows,
          candidateInputDigests,
          protectedSilverFingerprint,
        }),
      };
    },
  });
  if (params.publish !== true) return materialized;
  return service.verifyAndPublish(String((materialized.run as Row).id));
}

async function seedLifecycleRun(db: MemoryDatabase, id: string, status: string, date: string) {
  await db.runs.create({
    values: {
      id,
      idempotencyKey: id,
      requestDigest: `${id}-request`,
      candidateInputDigest: createHash('sha256').update(`${id}:candidate`).digest('hex'),
      ...testCandidateInputDigests(id),
      calculationDate: date,
      status,
      rowCount: 1,
      materializedAt: `${date}T00:00:00.000Z`,
      publishedAt: status === 'published' ? `${date}T00:00:00.000Z` : null,
    },
  });
  await db.gold.create({
    values: {
      id: `${id}:row`,
      refreshRunId: id,
      naturalKey: `${id}:row`,
      companyProductId: `${id}:product`,
      companyProductFamilyId: `${id}:family`,
      companyId: `${id}:company`,
      amazonAccountId: `${id}:account`,
      marketplace: 'Amazon.com',
      company: 'ACME',
      asin: `B00${id.toUpperCase()}`,
      sku: `${id}:sku`,
      calculationDate: date,
      familyRole: 'target',
      isFrozenFamilyTarget: true,
      familyTargetCompanyProductId: `${id}:product`,
      listingReviewCategories: [],
      replenishmentEligibility: 'eligible',
      replenishmentBlockReasonCode: 'eligible_informational_projection',
      primaryActionPane: 'healthyInventory',
      primaryActionReasonCode: 'sufficient_stock',
      existingOrderFollowUp: false,
      existingOrderFollowUpAction: 'none',
      newReplenishmentActionable: false,
      oosAlertActionable: false,
      supplyActionable: false,
      calculationEvidence: {
        familyActionSnapshot: {
          familyKey: `${id}:family`,
          companyProductFamilyId: `${id}:family`,
          companyId: `${id}:company`,
          amazonAccountId: `${id}:account`,
          marketplace: 'Amazon.com',
          canonicalAsin: `B00${id.toUpperCase()}`,
          targetSelectionState: 'automatic',
          targetCompanyProductId: `${id}:product`,
          targetSelectionEvidence: { source: 'test' },
        },
      },
      ...validStockContract(),
    },
  });
}

describe('Gold refresh publication control', () => {
  it('reads the published run deterministically and ignores a newer unpublished date', async () => {
    const db = new MemoryDatabase();
    const published = await buildRun(db, { date: '2026-07-14', key: 'published', publish: true });
    await buildRun(db, { date: '2026-07-15', key: 'newer-unpublished', publish: false });

    const rows = await new EcobaseInventoryPlanningService(db).listRows();
    const unpublishedRows = await new EcobaseInventoryPlanningService(db).listRows({
      calculationDate: '2026-07-15',
    });

    expect(rows.map((row) => row.refreshRunId)).toEqual([String((published.run as Row).id)]);
    expect(unpublishedRows).toEqual([]);
  });

  it('fails closed when more than one run is marked published', async () => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, 'published-one', 'published', '2026-07-14');
    await seedLifecycleRun(db, 'published-two', 'published', '2026-07-15');

    await expect(new EcobaseInventoryPlanningService(db).listRows()).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_PUBLICATION_MISMATCH',
    });
  });

  it('rejects publish=true during candidate execution', async () => {
    const db = new MemoryDatabase();
    const materialize = vi.fn();

    await expect(
      new EcobaseGoldRefreshRunService(db).execute({
        calculationDate: '2026-07-15',
        idempotencyKey: 'publish-during-build',
        publish: true,
        candidateInputDigests: testCandidateInputDigests('publish-during-build'),
        request: { calculationDate: '2026-07-15' },
        materialize,
      }),
    ).rejects.toMatchObject({ code: 'ECOBASE_GOLD_INVALID_TRANSITION' });
    expect(materialize).not.toHaveBeenCalled();
    expect(db.runs.rows).toEqual([]);
  });

  it('creates one run and one row cohort for concurrent duplicate idempotency keys', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseGoldRefreshRunService(db);
    let materializationCount = 0;
    const execute = () =>
      service.execute({
        calculationDate: '2026-07-15',
        idempotencyKey: 'same-key',
        candidateInputDigests: testCandidateInputDigests('same-key'),
        request: { calculationDate: '2026-07-15' },
        materialize: async ({ runId }) => {
          materializationCount += 1;
          await db.gold.create({
            values: {
              id: `${runId}:row`,
              refreshRunId: runId,
              naturalKey: `${runId}:row`,
              companyProductId: 'row',
              company: 'ACME',
              asin: 'B000ROW',
              calculationDate: '2026-07-15',
              ...validStockContract(),
            },
          });
          return {
            calculationDate: '2026-07-15',
            rowCount: 1,
            created: 1,
            updated: 0,
            lastRefreshedAt: '2026-07-15T00:00:00.000Z',
          };
        },
      });

    const [first, second] = await Promise.all([execute(), execute()]);

    expect(materializationCount).toBe(1);
    expect(db.runs.rows).toHaveLength(1);
    expect(db.gold.rows).toHaveLength(1);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
  });

  it('a bumped algorithm contract version derives a NEW run identity for identical silver inputs', async () => {
    // Batch D regression: the engine behavior changed while silver inputs stayed identical, and
    // the pre-bump refreshAndPublish reused the old published run. The derived idempotency key
    // must incorporate the algorithm contract version so a version bump always computes fresh.
    const db = new MemoryDatabase();
    const service = new EcobaseGoldRefreshRunService(db);
    let materializationCount = 0;
    const execute = (algorithmContractVersion: string) =>
      service.execute({
        calculationDate: '2026-07-15',
        // No explicit idempotency key: exercise the derived `inventory-planning:<digest>` path.
        candidateInputDigests: {
          ...testCandidateInputDigests('unchanged-silver'),
          algorithmContractVersion,
        },
        request: { calculationDate: '2026-07-15', algorithmContractVersion },
        materialize: async ({ runId }) => {
          materializationCount += 1;
          await db.gold.create({
            values: {
              id: `${runId}:row`,
              refreshRunId: runId,
              naturalKey: `${runId}:row`,
              companyProductId: 'row',
              company: 'ACME',
              asin: 'B000ROW',
              calculationDate: '2026-07-15',
              ...validStockContract(),
            },
          });
          return {
            calculationDate: '2026-07-15',
            rowCount: 1,
            created: 1,
            updated: 0,
            lastRefreshedAt: '2026-07-15T00:00:00.000Z',
          };
        },
      });

    type ExecuteResult = { reused: boolean; run: { id: string } };
    const v1 = (await execute('individual_monthly_profit_performance_v1')) as ExecuteResult;
    const v2 = (await execute(CORRECTED_ALGORITHM_CONTRACT_VERSION)) as ExecuteResult;

    expect(materializationCount).toBe(2);
    expect(v1.reused).toBe(false);
    expect(v2.reused).toBe(false);
    expect(v2.run.id).not.toBe(v1.run.id);
    expect(db.runs.rows).toHaveLength(2);
    // Same version + same inputs still reuses — the identity change comes ONLY from the bump.
    const repeat = (await execute(CORRECTED_ALGORITHM_CONTRACT_VERSION)) as ExecuteResult;
    expect(repeat.reused).toBe(true);
    expect(materializationCount).toBe(2);
  });

  it('keeps the published pointer unchanged when a run fails and rejects failed publication', async () => {
    const db = new MemoryDatabase();
    const published = await buildRun(db, { date: '2026-07-14', key: 'current', publish: true });
    await expect(
      new EcobaseGoldRefreshRunService(db).execute({
        calculationDate: '2026-07-15',
        idempotencyKey: 'failed',
        candidateInputDigests: testCandidateInputDigests('failed'),
        request: { calculationDate: '2026-07-15' },
        materialize: async () => {
          throw new Error('fixture materialization failed');
        },
      }),
    ).rejects.toThrow('fixture materialization failed');

    const failed = db.runs.rows.find((run) => run.idempotencyKey === 'failed');
    expect(db.runs.rows.find((run) => run.status === 'published')?.id).toBe((published.run as Row).id);
    expect(failed).toMatchObject({ status: 'failed', errorJson: { message: 'fixture materialization failed' } });
    const failedRunId = String(failed?.id);
    await expect(
      new EcobaseGoldRefreshRunService(db).publish(publicationPayloadFixture(db, failedRunId)),
    ).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_INVALID_TRANSITION',
    });
  });

  it('rejects stock-contract violations at the publication boundary', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseGoldRefreshRunService(db);
    const materialized = await buildRun(db, {
      date: '2026-07-15',
      key: 'invalid-stock-contract',
      publish: false,
    });
    const runId = String((materialized.run as Row).id);
    const row = db.gold.rows.find((candidate) => candidate.refreshRunId === runId);
    if (!row) throw new Error('Missing stock-contract fixture row.');
    row.inventoryPositionStock = 35;

    await expect(service.verifyAndPublish(runId)).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_BOUNDARY_VALIDATION_FAILED',
    });
    expect(db.runs.rows.find((run) => run.id === runId)).toMatchObject({
      status: 'rejected',
      rejectedAt: expect.any(String),
      terminalReasonCode: 'gold_boundary_validation_failed',
      terminalReasonJson: {
        code: 'ECOBASE_GOLD_BOUNDARY_VALIDATION_FAILED',
        reason: 'a listing violates the stock conservation contract',
      },
    });
    await expect(service.verifyAndPublish(runId)).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_INVALID_TRANSITION',
    });
  });

  it('binds every locked Step-20 field and rejects one-field tampering before publication mutation', async () => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, 'existing-publication', 'published', '2026-07-14');
    const candidate = await buildRun(db, { date: '2026-07-15', key: 'locked-publication', publish: false });
    const runId = String((candidate.run as Row).id);
    const service = new EcobaseGoldRefreshRunService(db);
    await service.verify(runId);
    const payload = publicationPayloadFixture(db, runId);
    const before = structuredClone(db.runs.rows);

    expect(Object.keys(payload)).toEqual(PUBLICATION_PAYLOAD_FIELDS);
    for (const field of PUBLICATION_PAYLOAD_FIELDS) {
      const value = payload[field];
      const tampered = {
        ...payload,
        [field]: typeof value === 'number' ? value + 1 : `${String(value)}-tampered`,
      };
      await expect(service.publish(tampered as GoldPublicationPayload)).rejects.toMatchObject({
        code: field === 'runId' ? 'ECOBASE_GOLD_RUN_NOT_FOUND' : 'ECOBASE_GOLD_PUBLICATION_MISMATCH',
      });
      expect(db.runs.rows).toEqual(before);
    }

    const published = await service.publish(payload);
    expect((published.run as Row).publicationPayloadDigest).toBe(
      createHash('sha256').update(canonicalJson(payload)).digest('hex'),
    );
    expect(db.runs.rows.find((run) => run.id === 'existing-publication')).toMatchObject({ status: 'retired' });
  });

  it('server-generates the approved payload and makes duplicate verified promotion idempotent', async () => {
    const db = new MemoryDatabase();
    const candidate = await buildRun(db, { date: '2026-07-15', key: 'operator-publication', publish: false });
    const runId = String((candidate.run as Row).id);
    const service = new EcobaseGoldRefreshRunService(db);

    const concurrent = await Promise.all([service.verifyAndPublish(runId), service.verifyAndPublish(runId)]);
    const published = concurrent.find((result) => result.reused === false);
    const duplicate = concurrent.find((result) => result.reused === true);

    expect(published).toMatchObject({
      published: true,
      reused: false,
      run: {
        id: runId,
        status: 'published',
        productionVerificationJson: { valid: true },
      },
    });
    expect((published.run as Row).independentVerificationJson).toBeUndefined();
    expect((published.run as Row).publicationPayloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(duplicate).toMatchObject({ published: true, reused: true, run: { id: runId, status: 'published' } });
    expect(db.runs.rows.filter((run) => run.status === 'published')).toHaveLength(1);
    await expect(new EcobaseInventoryPlanningService(db).listRows()).resolves.toEqual([
      expect.objectContaining({ refreshRunId: runId }),
    ]);
  });

  it('keeps the prior publication unchanged when automatic verification fails', async () => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, 'prior-publication', 'published', '2026-07-14');
    const candidate = await buildRun(db, { date: '2026-07-15', key: 'failed-operator-publication', publish: false });
    const runId = String((candidate.run as Row).id);
    publicationPayloadFixture(db, runId);
    const candidateRow = db.gold.rows.find((row) => row.refreshRunId === runId);
    if (!candidateRow) throw new Error('Missing failed operator publication fixture row.');
    candidateRow.inventoryPositionStock = 999;

    await expect(new EcobaseGoldRefreshRunService(db).verifyAndPublish(runId)).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_BOUNDARY_VALIDATION_FAILED',
      details: { runId },
    });
    expect(db.runs.rows.find((run) => run.id === 'prior-publication')).toMatchObject({ status: 'published' });
    expect(db.runs.rows.find((run) => run.id === runId)).toMatchObject({
      status: 'rejected',
      terminalReasonCode: 'gold_boundary_validation_failed',
    });
    expect(db.runs.rows.filter((run) => run.status === 'published')).toHaveLength(1);
  });

  it('switches the published pointer to one verified successful run', async () => {
    const db = new MemoryDatabase();
    const first = await buildRun(db, { date: '2026-07-14', key: 'first', publish: true });
    const second = await buildRun(db, { date: '2026-07-15', key: 'second', publish: false });
    const service = new EcobaseGoldRefreshRunService(db);
    await service.verify(String((second.run as Row).id));

    const secondRunId = String((second.run as Row).id);
    const published = await service.publish(publicationPayloadFixture(db, secondRunId));

    expect(db.runs.rows.filter((run) => run.status === 'published')).toHaveLength(1);
    expect(db.runs.rows.find((run) => run.id === (first.run as Row).id)?.status).toBe('retired');
    expect((published.run as Row).id).toBe((second.run as Row).id);
  });

  it('stores row-count verification when the candidate crosses the boundary', async () => {
    const db = new MemoryDatabase();
    const result = await buildRun(db, {
      date: '2026-07-15',
      key: 'verified-count',
      publish: false,
      rowIds: ['one', 'two'],
    });
    const runId = String((result.run as Row).id);

    await expect(new EcobaseGoldRefreshRunService(db).verify(runId)).resolves.toMatchObject({ storedRowCount: 2 });
    expect(db.runs.rows.find((run) => run.id === runId)).toMatchObject({
      status: 'verified',
      verificationJson: {
        valid: true,
        expectedRowCount: 2,
        storedRowCount: 2,
        uniqueNaturalKeyCount: 2,
        calculationDate: '2026-07-15',
      },
    });
  });

  it('persists corrected listing/family projection provenance returned by materialization', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseGoldRefreshRunService(db);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const result = await service.execute({
      calculationDate: '2026-07-18',
      idempotencyKey: 'corrected-projection-provenance',
      candidateInputDigests: {
        sourceInputDigest: digest('source'),
        coverageInputDigest: digest('coverage'),
        settingsDigest: digest('settings'),
        algorithmContractVersion: 'individual_monthly_profit_performance_v2',
      },
      request: { calculationDate: '2026-07-18', ruleVersion: 'individual_dynamic_6m_profit_trend_v2' },
      materialize: async ({ runId, candidateInputDigest }) => {
        await db.gold.create({
          values: {
            id: `${runId}:row`,
            refreshRunId: runId,
            naturalKey: `${runId}:row`,
            companyProductId: 'row',
            company: 'ACME',
            asin: 'B000000001',
            calculationDate: '2026-07-18',
            ...validStockContract(),
          },
        });
        return {
          calculationDate: '2026-07-18',
          rowCount: 1,
          created: 1,
          updated: 0,
          lastRefreshedAt: '2026-07-18T00:00:00.000Z',
          ruleVersion: 'individual_dynamic_6m_profit_trend_v2',
          algorithmContractVersion: 'individual_monthly_profit_performance_v2',
          currentProjectionGateMode: 'informational',
          resolvedPlanningSettingsDigest: digest('settings'),
          sourceCoverageDigest: digest('coverage'),
          sourceInputDigest: digest('source'),
          protectedSilverFingerprint: digest('protected'),
          candidateInputDigest,
          canonicalSerializerVersion: 'canonical_json_schema_normalized_bytewise_v2',
          candidateInputDigestVersion: 'candidate_input_digest_v1',
          sourceCoverageDigestVersion: 'source_coverage_digest_v1',
          listingRowDigestVersion: 'listing_performance_digest_v2',
          familyActionProjectionDigestVersion: 'family_action_digest_v2',
          listingRowCount: 1,
          listingRowDigest: digest('listing'),
          familyActionProjectionCount: 1,
          familyActionProjectionDigest: digest('family'),
        };
      },
    });

    expect(result.run).toMatchObject({
      ruleVersion: 'individual_dynamic_6m_profit_trend_v2',
      algorithmContractVersion: 'individual_monthly_profit_performance_v2',
      currentProjectionGateMode: 'informational',
      resolvedPlanningSettingsDigest: digest('settings'),
      sourceCoverageDigest: digest('coverage'),
      sourceInputsDigest: digest('source'),
      protectedSilverFingerprint: digest('protected'),
      canonicalSerializerVersion: 'canonical_json_schema_normalized_bytewise_v2',
      candidateInputDigestVersion: 'candidate_input_digest_v1',
      sourceCoverageDigestVersion: 'source_coverage_digest_v1',
      listingRowDigestVersion: 'listing_performance_digest_v2',
      familyActionProjectionDigestVersion: 'family_action_digest_v2',
      listingRowCount: 1,
      listingRowDigest: digest('listing'),
      familyActionProjectionCount: 1,
      familyActionProjectionDigest: digest('family'),
    });
  });

  it('keeps omitted publish explicitly materialized and unpublished', async () => {
    const db = new MemoryDatabase();

    const result = await buildRun(db, { date: '2026-07-15', key: 'default-unpublished' });

    expect(result).toMatchObject({ published: false, run: { status: 'materialized' } });
    await expect(new EcobaseGoldRefreshRunService(db).getPublishedRun()).resolves.toBeUndefined();
  });

  it.each(['materialized', 'succeeded', 'superseded'])('rejects publication from %s', async (status) => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, `run-${status}`, status, '2026-07-15');

    const runId = `run-${status}`;
    await expect(
      new EcobaseGoldRefreshRunService(db).publish(publicationPayloadFixture(db, runId)),
    ).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_INVALID_TRANSITION',
    });
  });

  it('retires the previous publication and never makes it republishable', async () => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, 'old-published', 'published', '2026-07-14');
    const replacement = await buildRun(db, { date: '2026-07-15', key: 'replacement', publish: false });
    const replacementRunId = String((replacement.run as Row).id);
    const service = new EcobaseGoldRefreshRunService(db);
    await service.verify(replacementRunId);

    await service.publish(publicationPayloadFixture(db, replacementRunId));

    expect(db.runs.rows.find((run) => run.id === 'old-published')).toMatchObject({ status: 'retired' });
    await expect(service.publish(publicationPayloadFixture(db, 'old-published'))).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_INVALID_TRANSITION',
    });
  });

  it.each(['failed', 'succeeded', 'superseded', 'rejected', 'retired'] as const)(
    'never reuses a %s terminal run',
    async (terminalStatus) => {
      const db = new MemoryDatabase();
      const service = new EcobaseGoldRefreshRunService(db);
      let materializationCount = 0;
      const execute = () =>
        service.execute({
          calculationDate: '2026-07-15',
          idempotencyKey: `terminal-${terminalStatus}`,
          candidateInputDigests: testCandidateInputDigests(`terminal-${terminalStatus}`),
          request: { calculationDate: '2026-07-15', terminalStatus },
          materialize: async ({ runId }) => {
            materializationCount += 1;
            await db.gold.create({
              values: {
                id: `${runId}:row`,
                refreshRunId: runId,
                naturalKey: `${runId}:row`,
                companyProductId: terminalStatus,
                company: 'ACME',
                calculationDate: '2026-07-15',
                ...validStockContract(),
              },
            });
            return {
              calculationDate: '2026-07-15',
              rowCount: 1,
              created: 1,
              updated: 0,
              lastRefreshedAt: '2026-07-15T00:00:00.000Z',
            };
          },
        });
      const first = await execute();
      const runId = String((first.run as Row).id);

      if (terminalStatus === 'superseded' || terminalStatus === 'rejected') {
        await service.terminate(runId, terminalStatus, `test_${terminalStatus}`);
      } else {
        await db.runs.update({ filterByTk: runId, values: { status: terminalStatus } });
      }

      await expect(execute()).rejects.toMatchObject({ code: 'ECOBASE_GOLD_TERMINAL_RUN_REUSE' });
      await expect(service.publish(publicationPayloadFixture(db, runId))).rejects.toMatchObject({
        code: 'ECOBASE_GOLD_INVALID_TRANSITION',
      });
      expect(materializationCount).toBe(1);
    },
  );

  it('binds an idempotency key to the full candidate input digest', async () => {
    const db = new MemoryDatabase();
    const service = new EcobaseGoldRefreshRunService(db);
    const execute = (inputVersion: string) =>
      service.execute({
        calculationDate: '2026-07-15',
        idempotencyKey: 'candidate-key',
        publish: false,
        request: { calculationDate: '2026-07-15' },
        candidateInputDigests: testCandidateInputDigests(inputVersion),
        materialize: async ({ runId }) => {
          await db.gold.create({
            values: {
              id: `${runId}:row`,
              refreshRunId: runId,
              naturalKey: `${runId}:row`,
              companyProductId: 'candidate-product',
              company: 'ACME',
              calculationDate: '2026-07-15',
              ...validStockContract(),
            },
          });
          return {
            calculationDate: '2026-07-15',
            rowCount: 1,
            created: 1,
            updated: 0,
            lastRefreshedAt: '2026-07-15T00:00:00.000Z',
          };
        },
      });

    await execute('candidate-a');
    expect(db.runs.rows[0]).toMatchObject({
      ...testCandidateInputDigests('candidate-a'),
      canonicalSerializerVersion: 'canonical_json_v1',
      candidateInputDigestVersion: 'candidate_input_v1',
      sourceCoverageDigestVersion: 'coverage_input_v1',
    });
    await expect(execute('candidate-b')).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_IDEMPOTENCY_CONFLICT',
    });
  });

  it('keeps unpublished rows out of supplier-order operational recommendations', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: 'company-acme', name: 'ACME' },
    });
    await seedLifecycleRun(db, 'candidate-only', 'materialized', '2026-07-15');

    const workspace = await new EcobaseSupplierOrderService(db).getWorkspace({ company: 'ACME' });

    expect(workspace.reorderCandidates).toEqual([]);
  });

  it('keeps unpublished rows out of supplier-management detail and decisions', async () => {
    const db = new MemoryDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: { id: 'supplier-acme', displayName: 'Supplier ACME', normalizedName: 'supplier acme' },
    });
    await seedLifecycleRun(db, 'supplier-candidate', 'verified', '2026-07-15');
    Object.assign(db.gold.rows[0], { supplierId: 'supplier-acme', supplierName: 'Supplier ACME' });

    const detail = await new EcobaseSupplierManagementService(db).getSupplierDetail({
      supplierId: 'supplier-acme',
    });

    expect(detail.inventoryRisks).toEqual([]);
    expect(detail.listingEvidence).toEqual([]);
  });

  it('derives published and explicit family actions from Date-valued persisted run timestamps', async () => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, 'date-family-actions', 'published', '2026-07-15');
    Object.assign(db.runs.rows[0], {
      materializedAt: new Date('2026-07-15T00:00:00.000Z'),
      publishedAt: '2026-07-16T00:00:00.000Z',
    });
    const access = new EcobaseInventoryPlanningGoldAccess(db);

    const published = await access.readPublishedFamilyActions();
    const explicit = await access.readExplicitFamilyActions({
      runId: 'date-family-actions',
      purpose: 'maintenance',
      actor: { type: 'system' },
    });

    expect(published.rows).toEqual([
      expect.objectContaining({ runId: 'date-family-actions', generatedAt: '2026-07-15T00:00:00.000Z' }),
    ]);
    expect(explicit.rows).toEqual(published.rows);
  });

  it('fails closed when all persisted family-action timestamps are invalid or missing', async () => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, 'invalid-family-action-time', 'published', '2026-07-15');
    Object.assign(db.runs.rows[0], {
      materializedAt: new Date(Number.NaN),
      verifiedAt: null,
      publishedAt: '',
      requestedAt: null,
    });

    await expect(new EcobaseInventoryPlanningGoldAccess(db).readPublishedFamilyActions()).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_PUBLICATION_MISMATCH',
    });
  });

  it('requires an authorized explicit verified run for audited candidate preview', async () => {
    const db = new MemoryDatabase();
    await seedLifecycleRun(db, 'candidate-preview', 'verified', '2026-07-15');
    db.runs.rows[0].materializedAt = new Date('2026-07-15T00:00:00.000Z');
    const candidateRow = db.gold.rows[0];
    const familyActionSnapshot = ((candidateRow.calculationEvidence as Row).familyActionSnapshot ?? {}) as Row;
    candidateRow.calculationEvidence = {
      sourceEvidence: { salesVelocity: 99, source: 'test' },
      coverage: {
        closedMonths: [
          {
            monthStart: '2026-01-01',
            reasonCode: 'eligible_complete_month',
            intervalIds: ['coverage-preview'],
            membershipIds: ['membership-preview'],
            coveredThroughDate: '2026-01-31',
          },
        ],
      },
      pace: { quantity: { actualMtd: '1.00000000' }, profit: { actualMtd: '2.00000000' } },
      disposition: {
        rollingUnits30: '30.00000000',
        salesVelocity: '1.00000000',
        inventoryDisposition: 'none',
        inventoryDispositionReasonCode: 'none',
      },
      familyActionSnapshot,
    };
    const actions = createEcobaseInventoryPlanningActions() as unknown as Record<
      string,
      ((ctx: Row, next: () => Promise<void>) => Promise<void>) | undefined
    >;
    const action = actions.candidatePreview;
    expect(action).toBeTypeOf('function');
    if (!action) return;

    const operatorContext: Row = {
      db,
      action: { params: { values: { runId: 'candidate-preview' } } },
      state: { currentRoles: ['operator'], currentUser: { id: 7 } },
      throw(status: number, message: string): never {
        throw Object.assign(new Error(message), { status });
      },
    };
    await expect(action(operatorContext, async () => undefined)).rejects.toMatchObject({
      code: 'ECOBASE_CANDIDATE_PREVIEW_FORBIDDEN',
    });

    const adminContext: Row = {
      db,
      action: { params: { values: {} } },
      state: { currentRoles: ['admin'], currentUser: { id: 8 } },
      throw(status: number, message: string): never {
        throw Object.assign(new Error(message), { status });
      },
    };
    await expect(action(adminContext, async () => undefined)).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_EXPLICIT_RUN_REQUIRED',
    });
    const allowedContext: Row = {
      db,
      action: { params: { values: { runId: 'candidate-preview' } } },
      state: { currentRoles: ['admin'], currentUser: { id: 8 } },
      throw(status: number, message: string): never {
        throw Object.assign(new Error(message), { status });
      },
    };
    await action(allowedContext, async () => undefined);
    expect(allowedContext.body).toMatchObject({
      data: {
        runId: 'candidate-preview',
        published: false,
        banner: 'UNPUBLISHED CANDIDATE — NOT OPERATIONAL',
        rows: [
          expect.objectContaining({
            refreshRunId: 'candidate-preview',
            calculationEvidence: expect.objectContaining({
              coverage: expect.objectContaining({
                closedMonths: [
                  expect.objectContaining({
                    intervalIds: ['coverage-preview'],
                    membershipIds: ['membership-preview'],
                  }),
                ],
              }),
              pace: expect.objectContaining({ quantity: expect.any(Object), profit: expect.any(Object) }),
              disposition: expect.objectContaining({
                rollingUnits30: '30.00000000',
                inventoryDisposition: 'none',
              }),
              familyActionSnapshot: expect.objectContaining({
                companyProductFamilyId: 'candidate-preview:family',
              }),
            }),
          }),
        ],
        familyActionProjectionCount: 1,
        familyActions: [
          expect.objectContaining({
            refreshRunId: 'candidate-preview',
            companyProductFamilyId: 'candidate-preview:family',
            targetSelectionState: 'frozen_target',
            targetCompanyProductId: 'candidate-preview:product',
            actionSourceCompanyProductId: 'candidate-preview:product',
            listing: expect.objectContaining({ refreshRunId: 'candidate-preview' }),
          }),
        ],
      },
    });
    const previewNames = new Set<string>();
    const collectNames = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(collectNames);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [name, nested] of Object.entries(value as Row)) {
        previewNames.add(name);
        collectNames(nested);
      }
    };
    collectNames((allowedContext.body as Row).data);
    expect(previewNames.has('salesVelocity')).toBe(false);
    expect(db.getRepository('goldInventoryPlanningAccessAudits').rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'candidate-preview', outcome: 'denied' }),
        expect.objectContaining({ runId: null, outcome: 'denied' }),
        expect.objectContaining({ runId: 'candidate-preview', outcome: 'allowed', actorUserId: '8' }),
      ]),
    );
  });

  it('makes listing-row artifacts append-only and owned by the refresh service', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    registerGoldInventoryPlanningWriteGuard({
      on(event, listener) {
        listeners.set(event, listener);
      },
    });
    const event = (name: string) => {
      const listener = listeners.get(`${ECOBASE_COLLECTIONS.goldInventoryPlanningRows}.${name}`);
      if (!listener) throw new Error(`Missing Gold write-guard listener ${name}.`);
      return listener;
    };

    expect(() => event('beforeCreate')({}, {})).toThrowError(
      expect.objectContaining({ code: 'ECOBASE_GOLD_IMMUTABLE_ARTIFACT' }),
    );
    await expect(
      withGoldInventoryPlanningWriteAuthority(async () => event('beforeCreate')({}, {})),
    ).resolves.toBeUndefined();
    await expect(
      withGoldInventoryPlanningWriteAuthority(async () => event('beforeUpdate')({}, {})),
    ).rejects.toMatchObject({ code: 'ECOBASE_GOLD_IMMUTABLE_ARTIFACT' });
    expect(() => event('beforeBulkDestroy')({})).toThrowError(
      expect.objectContaining({ code: 'ECOBASE_GOLD_IMMUTABLE_ARTIFACT' }),
    );

    const next = vi.fn(async () => undefined);
    await expect(
      blockRawGoldInventoryPlanningAccess(
        { action: { params: { resourceName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows } } },
        next,
      ),
    ).rejects.toMatchObject({ code: 'ECOBASE_GOLD_RAW_ACCESS_FORBIDDEN', status: 403 });
    expect(next).not.toHaveBeenCalled();
    await blockRawGoldInventoryPlanningAccess(
      { action: { params: { resourceName: 'ecobaseInventoryPlanning' } } },
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps every operational Gold reader behind the typed published-run boundary', () => {
    const sourceRoot = resolve(process.cwd(), 'packages/plugins/@nocobase/plugin-ecobase/src');
    const allowedOwners = new Set([
      'features/inventory-planning/server/gold-refresh-run-service.ts',
      'features/inventory-planning/server/inventory-planning-gold-access.ts',
      'features/inventory-planning/server/inventory-planning-service.ts',
      // Dashboard v1 AD-1 adjudication: deliberately vendored published-run reader (encapsulation over reuse).
      'features/inventory-dashboard/server/published-gold-reader.ts',
      // v1 plan task 003 (user-approved 2026-07-22): published-run-scoped tiered-first target selection.
      'features/inventory-planning/server/company-product-family-service.ts',
    ]);
    const directRead =
      /(?:getRepository|repoRows|repoRowsFiltered|this\.repo|this\.all)\s*\([\s\S]{0,160}ECOBASE_COLLECTIONS\.goldInventoryPlanningRows/;
    const offenders = filesUnder(sourceRoot)
      .filter((path) => path.endsWith('.ts'))
      .filter(
        (path) => !path.includes('/__tests__/') && !path.includes('/migrations/') && !path.includes('/collections/'),
      )
      .filter((path) => !allowedOwners.has(path.slice(sourceRoot.length + 1)))
      .filter((path) => directRead.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(sourceRoot.length + 1));

    expect(offenders).toEqual([]);
  });

  it('keeps manual rebuild admin-only and exposes only the supported one-button publication action', async () => {
    const action = createEcobaseInventoryPlanningActions().refreshReadModel;
    const next = vi.fn();
    const ctx = {
      state: { currentRoles: ['operator'], currentUser: { id: 1 } },
      action: { params: { values: {} } },
      throw: (status: number, message: string) => {
        throw new Error(`${status}:${message}`);
      },
    };

    await expect(action(ctx as never, next)).rejects.toThrow(
      '403:Ecobase refreshReadModel requires the admin or root role.',
    );
    expect(next).not.toHaveBeenCalled();

    const verifyAction = createEcobaseInventoryPlanningActions().verifyRefreshRun;
    const verifyContext = {
      state: { currentRoles: ['admin'], currentUser: { id: 2 } },
      action: { params: { values: {} } },
      throw: (status: number, message: string) => {
        throw new Error(`${status}:${message}`);
      },
    };
    await expect(verifyAction(verifyContext as never, next)).rejects.toMatchObject({
      code: 'ECOBASE_GOLD_EXPLICIT_RUN_REQUIRED',
      status: 400,
    });

    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        'packages/plugins/@nocobase/plugin-ecobase/src/features/inventory-planning/client/InventoryPlanningPage.tsx',
      ),
      'utf8',
    );
    expect(pageSource).not.toContain('ecobaseInventoryPlanning:refreshReadModel');
    expect(pageSource).not.toContain('Rebuild gold inventory');

    const maintenancePageSource = readFileSync(
      resolve(process.cwd(), 'packages/plugins/@nocobase/plugin-ecobase/src/client/pages/GoldMaintenancePage.tsx'),
      'utf8',
    );
    expect(maintenancePageSource.match(/ecobaseInventoryPlanning:refreshAndPublish/g)).toHaveLength(1);
    expect(maintenancePageSource).not.toContain('ecobaseInventoryPlanning:refreshReadModel');
    expect(maintenancePageSource).not.toContain('ecobaseInventoryPlanning:verifyRefreshRun');
    expect(maintenancePageSource).not.toContain('REBUILD GOLD');
    expect(maintenancePageSource).not.toContain('PUBLISH GOLD');
    expect(maintenancePageSource).not.toContain('idempotencyKey');

    const registrationSource = readFileSync(
      resolve(
        process.cwd(),
        'packages/plugins/@nocobase/plugin-ecobase/src/features/inventory-planning/server/resource-registration.ts',
      ),
      'utf8',
    );
    expect(registrationSource).toContain("'refreshAndPublish'");
    expect(registrationSource).toContain('role: OPERATOR');

    const routesSource = readFileSync(
      resolve(process.cwd(), 'packages/plugins/@nocobase/plugin-ecobase/src/client/client-routes.tsx'),
      'utf8',
    );
    expect(routesSource).toMatch(/key: 'gold-maintenance'[\s\S]*access: 'operator' as const/);
  });
});
