/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';

export type GoldRefreshRunStatus = 'requested' | 'running' | 'succeeded' | 'failed' | 'published';

type PlainRecord = Record<string, unknown>;
type Transaction = unknown;

type TransactionalRepository = EcobaseRepository & {
  find(params?: {
    filter?: PlainRecord;
    filterByTk?: string | number;
    sort?: string[];
    limit?: number;
    transaction?: Transaction;
  }): Promise<unknown[]>;
  findOne(params?: {
    filter?: PlainRecord;
    filterByTk?: string | number;
    sort?: string[];
    transaction?: Transaction;
  }): Promise<unknown | null>;
  create(params: { values: PlainRecord; transaction?: Transaction }): Promise<unknown>;
  update(params: {
    filter?: PlainRecord;
    filterByTk?: string | number;
    values: PlainRecord;
    transaction?: Transaction;
  }): Promise<unknown>;
};

export interface GoldRefreshMaterialization {
  calculationDate: string;
  rowCount: number;
  created: number;
  updated: number;
  lastRefreshedAt: string;
  [key: string]: unknown;
}

export interface ExecuteGoldRefreshParams {
  calculationDate: string;
  idempotencyKey?: string;
  requestedByUserId?: string;
  publish?: boolean;
  request: PlainRecord;
  materialize: (context: {
    runId: string;
    transaction?: Transaction;
    previousPublishedRunId?: string;
  }) => Promise<GoldRefreshMaterialization>;
}

export interface GoldRefreshVerification {
  valid: true;
  expectedRowCount: number;
  storedRowCount: number;
  uniqueNaturalKeyCount: number;
  calculationDate: string;
}

let processRefreshQueue: Promise<void> = Promise.resolve();

class GoldRefreshIdempotencyConflictError extends Error {}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function obeysPositionContract(values: unknown[]) {
  const [onHand, amazon, supplier, inventory, future] = values.map(finiteNumber);
  if ([onHand, amazon, supplier, inventory, future].every((value) => value === undefined)) return true;
  if ([onHand, amazon, supplier, inventory, future].some((value) => value === undefined)) return false;
  return (
    Math.abs(inventory! - (onHand! + amazon!)) <= 0.000001 && Math.abs(future! - (inventory! + supplier!)) <= 0.000001
  );
}

function obeysStockConservationContract(row: PlainRecord) {
  return (
    obeysPositionContract([
      row.onHandSellableStock,
      row.amazonPipelineStock,
      row.supplierPipelineStock,
      row.inventoryPositionStock,
      row.futurePositionStock,
    ]) &&
    obeysPositionContract([
      row.familyOnHandSellableStock,
      row.familyAmazonPipelineStock,
      row.familySupplierPipelineStock,
      row.familyInventoryPositionStock,
      row.familyFuturePositionStock,
    ])
  );
}

function requestDigest(request: PlainRecord) {
  const normalized = Object.fromEntries(Object.entries(request).sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown Gold refresh failure.';
}

async function withProcessRefreshLock<T>(run: () => Promise<T>) {
  const previous = processRefreshQueue;
  let release: () => void = () => undefined;
  processRefreshQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

export class EcobaseGoldRefreshRunService {
  constructor(private readonly db: EcobaseDatabase) {}

  async getPublishedRun(transaction?: Transaction) {
    const run = await this.runRepository().findOne({
      filter: { status: 'published' },
      sort: ['-publishedAt'],
      transaction,
    });
    return run ? toPlainRecord(run) : undefined;
  }

  async getRun(runId: string, transaction?: Transaction) {
    const run = await this.runRepository().findOne({ filterByTk: runId, transaction });
    if (!run) throw new Error(`Ecobase Gold refresh run "${runId}" was not found.`);
    return toPlainRecord(run);
  }

  async execute(params: ExecuteGoldRefreshParams) {
    const digest = requestDigest(params.request);
    const idempotencyKey = text(params.idempotencyKey) ?? `auto:${digest}`;
    if (idempotencyKey.length > 255) {
      throw new Error('Ecobase Gold refresh idempotency key must be 255 characters or fewer.');
    }

    try {
      return await this.withLockedTransaction(async (transaction) => {
        const existing = await this.runRepository().findOne({ filter: { idempotencyKey }, transaction });
        if (existing) {
          const run = toPlainRecord(existing);
          if (text(run.requestDigest) !== digest) {
            throw new GoldRefreshIdempotencyConflictError(
              `Ecobase Gold refresh idempotency key "${idempotencyKey}" was already used for a different request.`,
            );
          }
          if (run.status === 'failed') {
            throw new Error(
              `Ecobase Gold refresh idempotency key "${idempotencyKey}" already failed: ${
                text(toPlainRecord(run.errorJson).message) ?? 'no error was recorded'
              }.`,
            );
          }
          if (run.status === 'requested' || run.status === 'running') {
            throw new Error(`Ecobase Gold refresh run "${String(run.id)}" is incomplete and cannot be reused.`);
          }
          const resolved =
            params.publish === false ? run : await this.publishWithinTransaction(String(run.id), transaction);
          return this.result(resolved, true);
        }

        const runId = randomUUID();
        const requestedAt = new Date().toISOString();
        await this.runRepository().create({
          values: {
            id: runId,
            idempotencyKey,
            requestDigest: digest,
            requestJson: params.request,
            calculationDate: params.calculationDate,
            status: 'requested',
            requestedAt,
            requestedByUserId: params.requestedByUserId ?? null,
            rowCount: 0,
            verificationJson: {},
            resultJson: {},
          },
          transaction,
        });
        await this.runRepository().update({
          filterByTk: runId,
          values: { status: 'running', startedAt: new Date().toISOString() },
          transaction,
        });
        const previousPublishedRunId = text((await this.getPublishedRun(transaction))?.id);
        const materialization = await params.materialize({ runId, transaction, previousPublishedRunId });
        const verification = await this.verifyRows(
          runId,
          params.calculationDate,
          materialization.rowCount,
          transaction,
        );
        await this.runRepository().update({
          filterByTk: runId,
          values: {
            status: 'succeeded',
            succeededAt: new Date().toISOString(),
            rowCount: materialization.rowCount,
            verificationJson: verification,
            resultJson: materialization,
            errorJson: {},
          },
          transaction,
        });
        const succeeded = await this.getRun(runId, transaction);
        const resolved = params.publish === false ? succeeded : await this.publishWithinTransaction(runId, transaction);
        return this.result(resolved, false);
      });
    } catch (error) {
      if (error instanceof GoldRefreshIdempotencyConflictError) throw error;
      await this.persistFailure({
        calculationDate: params.calculationDate,
        digest,
        error: errorMessage(error),
        idempotencyKey,
        request: params.request,
        requestedByUserId: params.requestedByUserId,
      });
      throw error;
    }
  }

  async verify(runId: string) {
    return this.withLockedTransaction(async (transaction) => {
      const run = await this.getRun(runId, transaction);
      if (!['succeeded', 'published'].includes(String(run.status))) {
        throw new Error(`Ecobase Gold refresh run "${runId}" with status "${String(run.status)}" cannot be verified.`);
      }
      const expectedRowCount = integer(run.rowCount);
      const calculationDate = text(run.calculationDate);
      if (expectedRowCount === undefined || !calculationDate) {
        throw new Error(`Ecobase Gold refresh run "${runId}" is missing row-count or calculation-date evidence.`);
      }
      return this.verifyRows(runId, calculationDate, expectedRowCount, transaction);
    });
  }

  async publish(runId: string) {
    return this.withLockedTransaction(async (transaction) => {
      const run = await this.publishWithinTransaction(runId, transaction);
      return this.result(run, false);
    });
  }

  private async publishWithinTransaction(runId: string, transaction?: Transaction) {
    const run = await this.getRun(runId, transaction);
    if (run.status === 'published') return run;
    if (run.status !== 'succeeded') {
      throw new Error(`Ecobase Gold refresh run "${runId}" with status "${String(run.status)}" cannot be published.`);
    }
    const expectedRowCount = integer(run.rowCount);
    const calculationDate = text(run.calculationDate);
    if (expectedRowCount === undefined || !calculationDate) {
      throw new Error(`Ecobase Gold refresh run "${runId}" is missing row-count or calculation-date evidence.`);
    }
    const verification = await this.verifyRows(runId, calculationDate, expectedRowCount, transaction);
    const published = await this.runRepository().find({ filter: { status: 'published' }, transaction });
    for (const current of published.map(toPlainRecord)) {
      if (String(current.id) === runId) continue;
      await this.runRepository().update({
        filterByTk: current.id as string | number,
        values: { status: 'succeeded' },
        transaction,
      });
    }
    const publishedAt = new Date().toISOString();
    await this.runRepository().update({
      filterByTk: runId,
      values: { status: 'published', publishedAt, verificationJson: verification },
      transaction,
    });
    const publishedAfter = await this.runRepository().find({ filter: { status: 'published' }, transaction });
    if (publishedAfter.length !== 1 || String(toPlainRecord(publishedAfter[0]).id) !== runId) {
      throw new Error(`Ecobase Gold refresh run "${runId}" failed atomic publication verification.`);
    }
    return this.getRun(runId, transaction);
  }

  private async verifyRows(
    runId: string,
    calculationDate: string,
    expectedRowCount: number,
    transaction?: Transaction,
  ): Promise<GoldRefreshVerification> {
    if (expectedRowCount === 0) {
      throw new Error(`Ecobase Gold refresh run "${runId}" verification failed: an empty run cannot be published.`);
    }
    const rows = (
      await this.goldRepository().find({ filter: { refreshRunId: runId }, limit: 100000, transaction })
    ).map(toPlainRecord);
    const naturalKeys = rows.map((row) => text(row.naturalKey));
    const invalid = rows.find(
      (row) =>
        text(row.refreshRunId) !== runId ||
        text(row.calculationDate) !== calculationDate ||
        !text(row.id) ||
        !text(row.naturalKey) ||
        !text(row.planningProductId) ||
        !text(row.company) ||
        Object.values(row).some((value) => typeof value === 'number' && !Number.isFinite(value)),
    );
    const uniqueNaturalKeyCount = new Set(naturalKeys).size;
    if (
      rows.length !== expectedRowCount ||
      invalid ||
      naturalKeys.some((key) => !key) ||
      uniqueNaturalKeyCount !== rows.length
    ) {
      throw new Error(
        `Ecobase Gold refresh run "${runId}" verification failed: expected ${expectedRowCount} rows, stored ${rows.length}, unique natural keys ${uniqueNaturalKeyCount}.`,
      );
    }
    const stockContractViolation = rows.find((row) => !obeysStockConservationContract(row));
    if (stockContractViolation) {
      throw new Error(
        `Ecobase Gold refresh run "${runId}" verification failed: row "${String(
          stockContractViolation.id,
        )}" violates the stock conservation contract.`,
      );
    }
    return {
      valid: true,
      expectedRowCount,
      storedRowCount: rows.length,
      uniqueNaturalKeyCount,
      calculationDate,
    };
  }

  private result(run: PlainRecord, reused: boolean) {
    return {
      run,
      reused,
      published: run.status === 'published',
      verification: toPlainRecord(run.verificationJson),
      ...toPlainRecord(run.resultJson),
    };
  }

  private async persistFailure(params: {
    calculationDate: string;
    digest: string;
    error: string;
    idempotencyKey: string;
    request: PlainRecord;
    requestedByUserId?: string;
  }) {
    const repository = this.runRepository();
    const existing = await repository.findOne({ filter: { idempotencyKey: params.idempotencyKey } });
    const values = {
      status: 'failed' as GoldRefreshRunStatus,
      failedAt: new Date().toISOString(),
      errorJson: { message: params.error },
    };
    if (existing) {
      const run = toPlainRecord(existing);
      if (text(run.requestDigest) === params.digest && !['failed', 'published'].includes(String(run.status))) {
        await repository.update({ filterByTk: run.id as string | number, values });
      }
      return;
    }
    await repository.create({
      values: {
        id: randomUUID(),
        idempotencyKey: params.idempotencyKey,
        requestDigest: params.digest,
        requestJson: params.request,
        calculationDate: params.calculationDate,
        requestedAt: new Date().toISOString(),
        requestedByUserId: params.requestedByUserId ?? null,
        rowCount: 0,
        verificationJson: {},
        resultJson: {},
        ...values,
      },
    });
  }

  private runRepository() {
    return this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns) as TransactionalRepository;
  }

  private goldRepository() {
    return this.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows) as TransactionalRepository;
  }

  private async withLockedTransaction<T>(run: (transaction?: Transaction) => Promise<T>) {
    const sequelize = this.db.sequelize as
      | {
          query?: (sql: string, options: { transaction: Transaction }) => Promise<unknown>;
          transaction?: (callback: (transaction: Transaction) => Promise<T>) => Promise<T>;
        }
      | undefined;
    if (typeof sequelize?.transaction === 'function' && typeof sequelize.query === 'function') {
      return sequelize.transaction(async (transaction) => {
        await sequelize.query("select pg_advisory_xact_lock(hashtext('ecobase.gold_inventory_planning.refresh'))", {
          transaction,
        });
        return run(transaction);
      });
    }
    return withProcessRefreshLock(() => run(undefined));
  }
}
