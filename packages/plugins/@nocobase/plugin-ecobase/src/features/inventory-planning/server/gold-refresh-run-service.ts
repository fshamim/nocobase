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
import { EcobaseGoldError } from './gold-errors';
import { EcobaseIndependentGoldReferenceVerifier } from './independent-gold-reference-verifier';
import {
  CORRECTED_ALGORITHM_CONTRACT_VERSION,
  CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION,
  CORRECTED_CANONICAL_SERIALIZER_VERSION,
  CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
  CORRECTED_LISTING_ROW_DIGEST_VERSION,
  CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION,
  CORRECTED_TIER_RULE_VERSION,
} from './listing-family-projection';

export type GoldRefreshRunStatus =
  | 'requested'
  | 'running'
  | 'materialized'
  | 'verified'
  | 'published'
  | 'failed'
  | 'superseded'
  | 'rejected'
  | 'retired'
  | 'succeeded';

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

export interface GoldRefreshProjectionMetadata {
  ruleVersion: string;
  algorithmContractVersion: string;
  currentProjectionGateMode: 'informational' | 'evidence_driven';
  resolvedPlanningSettingsDigest: string;
  sourceCoverageDigest: string;
  sourceInputsDigest: string;
  protectedSilverFingerprint: string;
  candidateInputDigest: string;
  canonicalSerializerVersion: string;
  candidateInputDigestVersion: string;
  sourceCoverageDigestVersion: string;
  listingRowDigestVersion: string;
  familyActionProjectionDigestVersion: string;
  listingRowCount: number;
  listingRowDigest: string;
  familyActionProjectionCount: number;
  familyActionProjectionDigest: string;
}

export const GOLD_PUBLICATION_PAYLOAD_FIELDS = [
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

export interface GoldPublicationPayload {
  runId: string;
  status: 'verified';
  ruleVersion: string;
  algorithmContractVersion: string;
  canonicalSerializerVersion: string;
  candidateInputDigestVersion: string;
  sourceCoverageDigestVersion: string;
  listingRowDigestVersion: string;
  familyActionProjectionDigestVersion: string;
  resolvedPlanningSettingsDigest: string;
  currentProjectionGateMode: 'informational' | 'evidence_driven';
  protectedSilverFingerprint: string;
  sourceCoverageDigest: string;
  sourceInputsDigest: string;
  candidateInputDigest: string;
  listingRowCount: number;
  listingRowDigest: string;
  familyActionProjectionCount: number;
  familyActionProjectionDigest: string;
  productionVerificationDigest: string;
  independentVerificationDigest: string;
  confirmation: 'PUBLISH GOLD';
}

export interface GoldRefreshMaterialization extends Partial<GoldRefreshProjectionMetadata> {
  calculationDate: string;
  rowCount: number;
  created: number;
  updated: number;
  lastRefreshedAt: string;
  [key: string]: unknown;
}

export interface GoldCandidateInputDigests {
  sourceInputDigest: string;
  coverageInputDigest: string;
  settingsDigest: string;
  algorithmContractVersion: string;
}

export interface ExecuteGoldRefreshParams {
  calculationDate: string;
  idempotencyKey?: string;
  requestedByUserId?: string;
  publish?: boolean;
  candidateInputDigests: GoldCandidateInputDigests;
  request: PlainRecord;
  materialize: (context: {
    runId: string;
    candidateInputDigest: string;
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
  return obeysPositionContract([
    row.onHandSellableStock,
    row.amazonPipelineStock,
    row.supplierPipelineStock,
    row.inventoryPositionStock,
    row.futurePositionStock,
  ]);
}

export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as PlainRecord)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function requestDigest(request: unknown) {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

function publicationMismatch(runId: string, details: PlainRecord = {}) {
  return new EcobaseGoldError(
    'ECOBASE_GOLD_PUBLICATION_MISMATCH',
    `EcoBase Gold publication payload does not match verified run "${runId}".`,
    { runId, ...details },
  );
}

function requiredPublicationText(run: PlainRecord, field: string, runId: string) {
  const value = text(run[field]);
  if (!value) throw publicationMismatch(runId, { missingField: field });
  return value;
}

function requiredPublicationCount(run: PlainRecord, field: string, runId: string) {
  const value = integer(run[field]);
  if (value === undefined) throw publicationMismatch(runId, { missingField: field });
  return value;
}

function publicationPayloadFromRun(
  run: PlainRecord,
  productionVerificationDigest: string,
  independentVerificationDigest: string,
): GoldPublicationPayload {
  const runId = requiredPublicationText(run, 'id', String(run.id ?? 'unknown'));
  const currentProjectionGateMode = requiredPublicationText(run, 'currentProjectionGateMode', runId);
  if (currentProjectionGateMode !== 'informational' && currentProjectionGateMode !== 'evidence_driven') {
    throw publicationMismatch(runId, { field: 'currentProjectionGateMode', value: currentProjectionGateMode });
  }
  return {
    runId,
    status: 'verified',
    ruleVersion: requiredPublicationText(run, 'ruleVersion', runId),
    algorithmContractVersion: requiredPublicationText(run, 'algorithmContractVersion', runId),
    canonicalSerializerVersion: requiredPublicationText(run, 'canonicalSerializerVersion', runId),
    candidateInputDigestVersion: requiredPublicationText(run, 'candidateInputDigestVersion', runId),
    sourceCoverageDigestVersion: requiredPublicationText(run, 'sourceCoverageDigestVersion', runId),
    listingRowDigestVersion: requiredPublicationText(run, 'listingRowDigestVersion', runId),
    familyActionProjectionDigestVersion: requiredPublicationText(run, 'familyActionProjectionDigestVersion', runId),
    resolvedPlanningSettingsDigest: requiredPublicationText(run, 'resolvedPlanningSettingsDigest', runId),
    currentProjectionGateMode,
    protectedSilverFingerprint: requiredPublicationText(run, 'protectedSilverFingerprint', runId),
    sourceCoverageDigest: requiredPublicationText(run, 'sourceCoverageDigest', runId),
    sourceInputsDigest: requiredPublicationText(run, 'sourceInputsDigest', runId),
    candidateInputDigest: requiredPublicationText(run, 'candidateInputDigest', runId),
    listingRowCount: requiredPublicationCount(run, 'listingRowCount', runId),
    listingRowDigest: requiredPublicationText(run, 'listingRowDigest', runId),
    familyActionProjectionCount: requiredPublicationCount(run, 'familyActionProjectionCount', runId),
    familyActionProjectionDigest: requiredPublicationText(run, 'familyActionProjectionDigest', runId),
    productionVerificationDigest,
    independentVerificationDigest,
    confirmation: 'PUBLISH GOLD',
  };
}

function candidateInputDigests(values: GoldCandidateInputDigests) {
  const digestFields = ['sourceInputDigest', 'coverageInputDigest', 'settingsDigest'] as const;
  for (const field of digestFields) {
    if (!/^[a-f0-9]{64}$/i.test(text(values?.[field]) ?? '')) {
      throw new Error(`EcoBase Gold refresh requires ${field} as a SHA-256 digest.`);
    }
  }
  const algorithmContractVersion = text(values?.algorithmContractVersion);
  if (!algorithmContractVersion) {
    throw new Error('EcoBase Gold refresh requires algorithmContractVersion.');
  }
  return {
    sourceInputDigest: values.sourceInputDigest.toLowerCase(),
    coverageInputDigest: values.coverageInputDigest.toLowerCase(),
    settingsDigest: values.settingsDigest.toLowerCase(),
    algorithmContractVersion,
  };
}

function correctedProjectionMetadata(
  materialization: GoldRefreshMaterialization,
  expected: GoldCandidateInputDigests & { candidateInputDigest: string },
): GoldRefreshProjectionMetadata | undefined {
  const hasCorrectedMetadata = [
    materialization.ruleVersion,
    materialization.listingRowDigest,
    materialization.familyActionProjectionDigest,
  ].some((value) => value !== undefined);
  if (!hasCorrectedMetadata) return undefined;
  const digestFields = [
    'resolvedPlanningSettingsDigest',
    'sourceCoverageDigest',
    'sourceInputDigest',
    'protectedSilverFingerprint',
    'candidateInputDigest',
    'listingRowDigest',
    'familyActionProjectionDigest',
  ] as const;
  for (const field of digestFields) {
    if (!/^[a-f0-9]{64}$/.test(text(materialization[field]) ?? '')) {
      throw new Error(`EcoBase corrected Gold materialization requires ${field} as lowercase SHA-256.`);
    }
  }
  const listingRowCount = integer(materialization.listingRowCount);
  const familyActionProjectionCount = integer(materialization.familyActionProjectionCount);
  if (listingRowCount === undefined || listingRowCount !== materialization.rowCount) {
    throw new Error('EcoBase corrected Gold materialization listingRowCount must equal rowCount.');
  }
  if (familyActionProjectionCount === undefined) {
    throw new Error('EcoBase corrected Gold materialization requires familyActionProjectionCount.');
  }
  const exactFields: Array<[unknown, string, string]> = [
    [materialization.ruleVersion, CORRECTED_TIER_RULE_VERSION, 'ruleVersion'],
    [materialization.algorithmContractVersion, CORRECTED_ALGORITHM_CONTRACT_VERSION, 'algorithmContractVersion'],
    [materialization.canonicalSerializerVersion, CORRECTED_CANONICAL_SERIALIZER_VERSION, 'canonicalSerializerVersion'],
    [
      materialization.candidateInputDigestVersion,
      CORRECTED_CANDIDATE_INPUT_DIGEST_VERSION,
      'candidateInputDigestVersion',
    ],
    [
      materialization.sourceCoverageDigestVersion,
      CORRECTED_SOURCE_COVERAGE_DIGEST_VERSION,
      'sourceCoverageDigestVersion',
    ],
    [materialization.listingRowDigestVersion, CORRECTED_LISTING_ROW_DIGEST_VERSION, 'listingRowDigestVersion'],
    [
      materialization.familyActionProjectionDigestVersion,
      CORRECTED_FAMILY_ACTION_DIGEST_VERSION,
      'familyActionProjectionDigestVersion',
    ],
  ];
  for (const [actual, exactValue, field] of exactFields) {
    if (actual !== exactValue) {
      throw new Error(`EcoBase corrected Gold materialization requires ${field}=${exactValue}.`);
    }
  }
  if (!['informational', 'evidence_driven'].includes(String(materialization.currentProjectionGateMode ?? ''))) {
    throw new Error('EcoBase corrected Gold materialization requires a valid currentProjectionGateMode.');
  }
  if (
    materialization.candidateInputDigest !== expected.candidateInputDigest ||
    materialization.sourceInputDigest !== expected.sourceInputDigest ||
    materialization.sourceCoverageDigest !== expected.coverageInputDigest ||
    materialization.resolvedPlanningSettingsDigest !== expected.settingsDigest ||
    materialization.algorithmContractVersion !== expected.algorithmContractVersion
  ) {
    throw new Error('EcoBase corrected Gold materialization provenance does not match the bound candidate inputs.');
  }
  return {
    ruleVersion: String(materialization.ruleVersion),
    algorithmContractVersion: String(materialization.algorithmContractVersion),
    currentProjectionGateMode: materialization.currentProjectionGateMode as 'informational' | 'evidence_driven',
    resolvedPlanningSettingsDigest: String(materialization.resolvedPlanningSettingsDigest),
    sourceCoverageDigest: String(materialization.sourceCoverageDigest),
    sourceInputsDigest: String(materialization.sourceInputDigest),
    protectedSilverFingerprint: String(materialization.protectedSilverFingerprint),
    candidateInputDigest: String(materialization.candidateInputDigest),
    canonicalSerializerVersion: String(materialization.canonicalSerializerVersion),
    candidateInputDigestVersion: String(materialization.candidateInputDigestVersion),
    sourceCoverageDigestVersion: String(materialization.sourceCoverageDigestVersion),
    listingRowDigestVersion: String(materialization.listingRowDigestVersion),
    familyActionProjectionDigestVersion: String(materialization.familyActionProjectionDigestVersion),
    listingRowCount,
    listingRowDigest: String(materialization.listingRowDigest),
    familyActionProjectionCount,
    familyActionProjectionDigest: String(materialization.familyActionProjectionDigest),
  };
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
    const runs = await this.runRepository().find({
      filter: { status: 'published' },
      sort: ['-publishedAt'],
      limit: 2,
      transaction,
    });
    if (runs.length === 0) return undefined;
    if (runs.length !== 1) {
      throw new EcobaseGoldError(
        'ECOBASE_GOLD_PUBLICATION_MISMATCH',
        'EcoBase Gold operational access requires exactly one published run.',
        { publishedRunIds: runs.map((run) => toPlainRecord(run).id) },
      );
    }
    return toPlainRecord(runs[0]);
  }

  async getRun(runId: string, transaction?: Transaction) {
    const run = await this.runRepository().findOne({ filterByTk: runId, transaction });
    if (!run) {
      throw new EcobaseGoldError('ECOBASE_GOLD_RUN_NOT_FOUND', `EcoBase Gold run "${runId}" does not exist.`, {
        runId,
      });
    }
    return toPlainRecord(run);
  }

  async execute(params: ExecuteGoldRefreshParams) {
    const digest = requestDigest(params.request);
    const inputDigests = candidateInputDigests(params.candidateInputDigests);
    const candidateInputDigest = requestDigest({ requestDigest: digest, ...inputDigests });
    const idempotencyKey = text(params.idempotencyKey) ?? `inventory-planning:${candidateInputDigest}`;
    if (idempotencyKey.length > 255) {
      throw new Error('Ecobase Gold refresh idempotency key must be 255 characters or fewer.');
    }
    if (params.publish === true) {
      throw new EcobaseGoldError(
        'ECOBASE_GOLD_INVALID_TRANSITION',
        'EcoBase Gold refresh execution cannot publish; verify and publish the materialized run explicitly.',
        { idempotencyKey },
      );
    }

    try {
      return await this.withLockedTransaction(async (transaction) => {
        const existing = await this.runRepository().findOne({ filter: { idempotencyKey }, transaction });
        if (existing) {
          const run = toPlainRecord(existing);
          const existingCandidateDigest = text(run.candidateInputDigest) ?? text(run.requestDigest);
          if (existingCandidateDigest !== candidateInputDigest) {
            throw new EcobaseGoldError(
              'ECOBASE_GOLD_IDEMPOTENCY_CONFLICT',
              `EcoBase Gold idempotency key "${idempotencyKey}" is already bound to a different candidate input digest.`,
              { idempotencyKey, candidateInputDigest, existingCandidateDigest },
            );
          }
          const status = String(run.status ?? '');
          if (['materialized', 'verified', 'published'].includes(status)) return this.result(run, true);
          throw this.invalidTransition(String(run.id), status, 'reuse');
        }

        const runId = randomUUID();
        const requestedAt = new Date().toISOString();
        await this.runRepository().create({
          values: {
            id: runId,
            idempotencyKey,
            requestDigest: digest,
            candidateInputDigest,
            ...inputDigests,
            canonicalSerializerVersion: 'canonical_json_v1',
            candidateInputDigestVersion: 'candidate_input_v1',
            sourceCoverageDigestVersion: 'coverage_input_v1',
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
        const materialization = await params.materialize({
          runId,
          candidateInputDigest,
          transaction,
          previousPublishedRunId,
        });
        const projectionMetadata = correctedProjectionMetadata(materialization, {
          ...inputDigests,
          candidateInputDigest,
        });
        const verification = await this.verifyRows(
          runId,
          params.calculationDate,
          materialization.rowCount,
          transaction,
        );
        await this.runRepository().update({
          filterByTk: runId,
          values: {
            status: 'materialized',
            materializedAt: new Date().toISOString(),
            rowCount: materialization.rowCount,
            listingRowCount: materialization.rowCount,
            ...(projectionMetadata ?? {}),
            verificationJson: verification,
            productionVerificationJson: verification,
            productionVerificationDigest: requestDigest(verification),
            resultJson: materialization,
            errorJson: {},
          },
          transaction,
        });
        return this.result(await this.getRun(runId, transaction), false);
      });
    } catch (error) {
      if (error instanceof EcobaseGoldError) throw error;
      await this.persistFailure({
        calculationDate: params.calculationDate,
        candidateInputDigest,
        digest,
        error: errorMessage(error),
        idempotencyKey,
        inputDigests,
        request: params.request,
        requestedByUserId: params.requestedByUserId,
      });
      throw error;
    }
  }

  async verify(runId: string) {
    return this.withLockedTransaction(async (transaction) => {
      const run = await this.getRun(runId, transaction);
      if (run.status === 'verified' || run.status === 'published') return toPlainRecord(run.verificationJson);
      if (run.status !== 'materialized') throw this.invalidTransition(runId, String(run.status), 'verified');
      const expectedRowCount = integer(run.rowCount);
      const calculationDate = text(run.calculationDate);
      if (expectedRowCount === undefined || !calculationDate) {
        throw new EcobaseGoldError(
          'ECOBASE_GOLD_PUBLICATION_MISMATCH',
          `EcoBase Gold publication payload does not match verified run "${runId}".`,
          { runId, rowCount: run.rowCount, calculationDate: run.calculationDate },
        );
      }
      const verification = await this.verifyRows(runId, calculationDate, expectedRowCount, transaction);
      const independentVerification = await new EcobaseIndependentGoldReferenceVerifier(this.db).verify(
        runId,
        transaction,
      );
      await this.runRepository().update({
        filterByTk: runId,
        values: {
          status: 'verified',
          verifiedAt: new Date().toISOString(),
          verificationJson: verification,
          productionVerificationJson: verification,
          productionVerificationDigest: requestDigest(verification),
          independentVerificationJson: independentVerification,
          independentVerificationDigest: requestDigest(independentVerification),
        },
        transaction,
      });
      return verification;
    });
  }

  async publish(payload: GoldPublicationPayload) {
    return this.withLockedTransaction(async (transaction) => {
      const run = await this.publishWithinTransaction(payload, transaction);
      return this.result(run, false);
    });
  }

  async terminate(runId: string, status: 'superseded' | 'rejected', reasonCode: string, reasonJson: PlainRecord = {}) {
    return this.withLockedTransaction(async (transaction) => {
      const run = await this.getRun(runId, transaction);
      const from = String(run.status ?? '');
      if (!['materialized', 'verified', 'succeeded'].includes(from)) {
        throw this.invalidTransition(runId, from, status);
      }
      const reason = text(reasonCode);
      if (!reason) {
        throw new Error(`EcoBase Gold ${status} transition requires a terminal reason code.`);
      }
      await this.runRepository().update({
        filterByTk: runId,
        values: {
          status,
          terminalReasonCode: reason,
          terminalReasonJson: reasonJson,
          [status === 'superseded' ? 'supersededAt' : 'rejectedAt']: new Date().toISOString(),
        },
        transaction,
      });
      return this.getRun(runId, transaction);
    });
  }

  private async publishWithinTransaction(payload: GoldPublicationPayload, transaction?: Transaction) {
    const runId = text(payload?.runId) ?? 'unknown';
    const run = await this.getRun(runId, transaction);
    if (run.status !== 'verified') throw this.invalidTransition(runId, String(run.status), 'published');
    const expectedRowCount = integer(run.rowCount);
    const calculationDate = text(run.calculationDate);
    if (expectedRowCount === undefined || !calculationDate) {
      throw publicationMismatch(runId, { rowCount: run.rowCount, calculationDate: run.calculationDate });
    }
    const verification = await this.verifyRows(runId, calculationDate, expectedRowCount, transaction);
    const productionVerificationDigest = requestDigest(verification);
    const independentVerification = await new EcobaseIndependentGoldReferenceVerifier(this.db).verify(
      runId,
      transaction,
    );
    const independentVerificationDigest = requestDigest(independentVerification);
    const expectedPayload = publicationPayloadFromRun(run, productionVerificationDigest, independentVerificationDigest);
    const expectedCanonicalPayload = canonicalJson(expectedPayload);
    const receivedCanonicalPayload = canonicalJson(payload);
    if (receivedCanonicalPayload !== expectedCanonicalPayload) {
      throw publicationMismatch(runId, {
        expectedPayloadDigest: requestDigest(expectedPayload),
        receivedPayloadDigest: requestDigest(payload),
      });
    }
    const published = await this.runRepository().find({ filter: { status: 'published' }, transaction });
    const retiredAt = new Date().toISOString();
    for (const current of published.map(toPlainRecord)) {
      if (String(current.id) === runId) continue;
      await this.runRepository().update({
        filterByTk: current.id as string | number,
        values: {
          status: 'retired',
          retiredAt,
          terminalReasonCode: 'replaced_by_publication',
          terminalReasonJson: { replacementRunId: runId },
        },
        transaction,
      });
    }
    const publishedAt = new Date().toISOString();
    const publicationPayloadDigest = requestDigest(expectedPayload);
    await this.runRepository().update({
      filterByTk: runId,
      values: {
        status: 'published',
        publishedAt,
        publicationPayloadDigest,
        verificationJson: verification,
        productionVerificationJson: verification,
        productionVerificationDigest: requestDigest(verification),
        independentVerificationJson: independentVerification,
        independentVerificationDigest,
      },
      transaction,
    });
    const publishedAfter = await this.runRepository().find({ filter: { status: 'published' }, transaction });
    if (publishedAfter.length !== 1 || String(toPlainRecord(publishedAfter[0]).id) !== runId) {
      throw new EcobaseGoldError(
        'ECOBASE_GOLD_PUBLICATION_MISMATCH',
        `EcoBase Gold publication payload does not match verified run "${runId}".`,
        { runId, publishedRunIds: publishedAfter.map((value) => toPlainRecord(value).id) },
      );
    }
    return this.getRun(runId, transaction);
  }

  private invalidTransition(runId: string, from: string, to: string) {
    if (to === 'reuse' && ['failed', 'succeeded', 'superseded', 'rejected', 'retired'].includes(from)) {
      return new EcobaseGoldError(
        'ECOBASE_GOLD_TERMINAL_RUN_REUSE',
        `EcoBase Gold terminal run "${runId}" cannot be reused.`,
        { runId, status: from },
      );
    }
    return new EcobaseGoldError(
      'ECOBASE_GOLD_INVALID_TRANSITION',
      `EcoBase Gold run "${runId}" cannot transition from "${from}" to "${to}".`,
      { runId, from, to },
    );
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
        !text(row.companyProductId) ||
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
    candidateInputDigest: string;
    digest: string;
    error: string;
    idempotencyKey: string;
    inputDigests: GoldCandidateInputDigests;
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
      if (
        text(run.requestDigest) === params.digest &&
        text(run.candidateInputDigest) === params.candidateInputDigest &&
        ['requested', 'running'].includes(String(run.status))
      ) {
        await repository.update({ filterByTk: run.id as string | number, values });
      }
      return;
    }
    await repository.create({
      values: {
        id: randomUUID(),
        idempotencyKey: params.idempotencyKey,
        requestDigest: params.digest,
        candidateInputDigest: params.candidateInputDigest,
        ...params.inputDigests,
        canonicalSerializerVersion: 'canonical_json_v1',
        candidateInputDigestVersion: 'candidate_input_v1',
        sourceCoverageDigestVersion: 'coverage_input_v1',
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
          getDialect?: () => string;
          query?: (sql: string, options: { transaction: Transaction }) => Promise<unknown>;
          transaction?: (callback: (transaction: Transaction) => Promise<T>) => Promise<T>;
        }
      | undefined;
    const runTransaction = sequelize?.transaction?.bind(sequelize);
    if (runTransaction) {
      return withProcessRefreshLock(() =>
        runTransaction(async (transaction) => {
          const dialect = sequelize.getDialect?.();
          if ((!dialect || dialect === 'postgres') && typeof sequelize.query === 'function') {
            await sequelize.query("select pg_advisory_xact_lock(hashtext('ecobase.gold_inventory_planning.refresh'))", {
              transaction,
            });
          }
          return run(transaction);
        }),
      );
    }
    return withProcessRefreshLock(() => run(undefined));
  }
}
