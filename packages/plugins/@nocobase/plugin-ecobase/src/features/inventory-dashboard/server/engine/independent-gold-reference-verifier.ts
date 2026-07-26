/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import {
  correctedInventoryPlanningDigestProjection,
  normalizeCorrectedInventoryPlanningDigestValue,
} from './gold-schema-contract';
import type { EcobaseDatabase } from '../../../source-import/server/import-service';
import { readAllRowsById } from './deterministic-repository-pagination';
import { EcobaseGoldError } from './gold-errors';
import { EcobaseInventoryPlanningGoldAccess } from './inventory-planning-gold-access';

const ReferenceDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const REFERENCE_VERIFIER_VERSION = 'independent_gold_reference_v1';
// v2 pins (Batch D sparse-tolerant contract) — must track the engine constants in
// listing-family-projection.ts or every fresh publication fails verification.
const CORRECTED_RULE_VERSION = 'individual_dynamic_6m_profit_trend_v2';
const CORRECTED_ALGORITHM_VERSION = 'individual_monthly_profit_performance_v2';
const CORRECTED_SERIALIZER_VERSION = 'canonical_json_schema_normalized_bytewise_v2';
const CORRECTED_LISTING_DIGEST_VERSION = 'listing_performance_digest_v2';
const CORRECTED_FAMILY_DIGEST_VERSION = 'family_action_digest_v2';
const SHA256 = /^[a-f0-9]{64}$/;

const PROTECTED_SILVER_COLLECTIONS = [
  ECOBASE_COLLECTIONS.silverCompanies,
  ECOBASE_COLLECTIONS.silverAmazonAccounts,
  ECOBASE_COLLECTIONS.silverProducts,
  ECOBASE_COLLECTIONS.silverCompanyProducts,
  ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
  ECOBASE_COLLECTIONS.silverInventorySnapshots,
  ECOBASE_COLLECTIONS.silverListingDailyFacts,
  ECOBASE_COLLECTIONS.silverTrafficSnapshots,
  ECOBASE_COLLECTIONS.sellerboardProductCosts,
] as const;

const LISTING_ENVELOPE_FIELDS = new Set(['id', 'refreshRunId', 'createdAt', 'updatedAt', 'lastRefreshedAt']);

type PlainRecord = Record<string, unknown>;
type Mismatch = { code: string; message: string; details?: PlainRecord };
type ReferenceRepository = {
  find(params?: {
    filter?: PlainRecord;
    filterByTk?: string | number;
    sort?: string[];
    limit?: number;
    offset?: number;
    transaction?: unknown;
  }): Promise<unknown[]>;
};

export interface IndependentGoldReferenceVerification {
  valid: true;
  verifierVersion: typeof REFERENCE_VERIFIER_VERSION;
  contractMode: 'corrected' | 'legacy_additive';
  runId: string;
  calculationDate: string;
  listingRowCount: number;
  listingRowDigest: string;
  familyActionProjectionCount: number;
  familyActionProjectionDigest: string | null;
  formulaVerifiedListingCount: number;
  coverageVerifiedMonthCount: number;
  protectedSilverFingerprintMatched: boolean | null;
  actionLeakCount: 0;
  mismatchCount: 0;
}

function record(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidate = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const MISMATCH_SAMPLE_LIMIT = 3;
const MISMATCH_SAMPLE_MESSAGE_LIMIT = 160;
const MISMATCH_ERROR_MESSAGE_LIMIT = 2000;

function mismatchDiagnostics(mismatches: Mismatch[]) {
  const grouped = new Map<string, { count: number; message: string }>();
  for (const mismatch of mismatches) {
    const code = mismatch.code.replace(/[^A-Z0-9_]/g, '_').slice(0, 80) || 'UNKNOWN_MISMATCH';
    const message = [...mismatch.message]
      .map((character) => {
        const characterCode = character.charCodeAt(0);
        return characterCode <= 31 || characterCode === 127 ? ' ' : character;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MISMATCH_SAMPLE_MESSAGE_LIMIT);
    const current = grouped.get(code);
    grouped.set(code, { count: (current?.count ?? 0) + 1, message: current?.message ?? message });
  }
  const codes = [...grouped.keys()].sort(compareText);
  const mismatchCodeHistogram = Object.fromEntries(codes.map((code) => [code, grouped.get(code)?.count ?? 0]));
  const mismatchSamples = codes.slice(0, MISMATCH_SAMPLE_LIMIT).map((code) => ({
    code,
    message: grouped.get(code)?.message ?? '',
  }));
  return { mismatchCount: mismatches.length, mismatchCodeHistogram, mismatchSamples };
}

function independentVerificationFailure(runId: string, mismatches: Mismatch[]) {
  const diagnostics = mismatchDiagnostics(mismatches);
  const histogram = Object.entries(diagnostics.mismatchCodeHistogram)
    .map(([code, count]) => `${code}:${count}`)
    .join(',');
  const samples = diagnostics.mismatchSamples.map(({ code, message }) => `${code}:${message}`).join(' | ');
  const message =
    `EcoBase independent Gold verification failed for run "${runId}" with ${diagnostics.mismatchCount} mismatch(es). histogram=${histogram}; samples=${samples}`.slice(
      0,
      MISMATCH_ERROR_MESSAGE_LIMIT,
    );
  return new EcobaseGoldError('ECOBASE_GOLD_INDEPENDENT_VERIFICATION_FAILED', message, {
    runId,
    ...diagnostics,
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.entries(record(value))
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function withoutEnvelope(row: PlainRecord) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !LISTING_ENVELOPE_FIELDS.has(key)));
}

function correctedPersistedListingProjection(row: PlainRecord) {
  return correctedInventoryPlanningDigestProjection(row);
}

function normalizedIdentity(row: PlainRecord) {
  return [
    text(row.companyId) ?? '',
    text(row.amazonAccountId) ?? '',
    text(row.marketplace)?.toLowerCase() ?? '',
    text(row.asin)?.toUpperCase() ?? '',
    text(row.sku)?.toLowerCase() ?? '',
    text(row.companyProductId) ?? '',
  ].join('\u0000');
}

function sortedListings(rows: PlainRecord[]) {
  return [...rows].sort((left, right) => compareText(normalizedIdentity(left), normalizedIdentity(right)));
}

function fixed8(value: Decimal | null) {
  return value ? value.toDecimalPlaces(8, ReferenceDecimal.ROUND_HALF_EVEN).toFixed(8) : null;
}

function decimal(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const parsed = new ReferenceDecimal(String(value));
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function sameDecimal(actual: unknown, expected: Decimal | null) {
  if (expected === null) return actual === null || actual === undefined;
  const parsed = decimal(actual);
  return parsed !== null && fixed8(parsed) === fixed8(expected);
}

function isoMonthEnd(monthStart: string) {
  const [year, month] = monthStart.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

type ListingMonthRowIndex = ReadonlyMap<string, readonly PlainRecord[]>;

function listingMonthKey(companyProductId: unknown, date: unknown) {
  const listingId = text(companyProductId);
  const dateValue = text(date);
  return listingId && dateValue && /^\d{4}-\d{2}/.test(dateValue)
    ? `${listingId}\u0000${dateValue.slice(0, 7)}-01`
    : undefined;
}

function indexByListingMonth(rows: PlainRecord[], dateField: string): ListingMonthRowIndex {
  const index = new Map<string, PlainRecord[]>();
  for (const row of rows) {
    const key = listingMonthKey(row.companyProductId, row[dateField]);
    if (key) index.set(key, [...(index.get(key) ?? []), row]);
  }
  return index;
}

function expectedClosedMonths(calculationDate: string) {
  const date = new Date(`${calculationDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== calculationDate) return [];
  const months: string[] = [];
  for (let offset = 6; offset >= 1; offset -= 1) {
    months.push(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1)).toISOString().slice(0, 10));
  }
  return months;
}

function monthTier(score: Decimal) {
  if (score.greaterThanOrEqualTo(250)) return 'A';
  if (score.greaterThanOrEqualTo(100)) return 'B';
  if (score.greaterThanOrEqualTo(0)) return 'C';
  return 'D';
}

function familySnapshot(row: PlainRecord) {
  return record(record(row.calculationEvidence).familyActionSnapshot);
}

function independentFamilyActions(
  rows: PlainRecord[],
  runId: string,
  generatedAt: string,
  mismatches: Mismatch[],
  correctedContract: boolean,
) {
  const groups = new Map<string, { snapshot: PlainRecord; rows: PlainRecord[] }>();
  for (const row of rows) {
    const snapshot = familySnapshot(row);
    const familyKey = text(snapshot.familyKey);
    if (!familyKey) {
      mismatches.push({
        code: 'FAMILY_SNAPSHOT_MISSING',
        message: `Listing ${text(row.companyProductId) ?? 'unknown'} has no immutable family snapshot.`,
      });
      continue;
    }
    if (snapshot.companyProductFamilyId !== row.companyProductFamilyId) {
      mismatches.push({
        code: 'FAMILY_SNAPSHOT_DRIFT',
        message: `Listing ${text(row.companyProductId) ?? 'unknown'} disagrees with its family snapshot.`,
      });
    }
    const current = groups.get(familyKey);
    if (current && canonical(current.snapshot) !== canonical(snapshot)) {
      mismatches.push({
        code: 'FAMILY_SNAPSHOT_CONFLICT',
        message: `Family ${familyKey} has conflicting immutable snapshots.`,
      });
      continue;
    }
    groups.set(familyKey, { snapshot, rows: [...(current?.rows ?? []), row] });
  }

  return [...groups]
    .sort(([left], [right]) => compareText(left, right))
    .map(([familyKey, group]) => {
      const members = sortedListings(group.rows);
      const snapshot = group.snapshot;
      const frozenTargetId = snapshot.targetCompanyProductId === null ? null : text(snapshot.targetCompanyProductId);
      const target = frozenTargetId ? members.find((member) => member.companyProductId === frozenTargetId) : undefined;
      const review = snapshot.targetSelectionState === 'review';
      if ((!review && !target) || (review && frozenTargetId !== null)) {
        mismatches.push({
          code: 'FAMILY_TARGET_INVALID',
          message: `Family ${familyKey} has an invalid frozen target selection.`,
        });
      }
      const representative = members[0] ?? {};
      // Task 002 mirror of listing-family-projection's discontinued fallback —
      // the independent verifier must agree or publishes fail verification.
      const allMembersDiscontinued = members.every((member) => member.primaryActionPane === 'discontinuedPaused');
      const decision = target
        ? {
            primaryActionPane: target.primaryActionPane,
            primaryActionReasonCode: target.primaryActionReasonCode,
            replenishmentEligibility: target.replenishmentEligibility,
            replenishmentBlockReasonCode: target.replenishmentBlockReasonCode,
            existingOrderFollowUp: target.existingOrderFollowUp,
            existingOrderFollowUpAction: target.existingOrderFollowUpAction,
            newReplenishmentActionable: target.newReplenishmentActionable,
            oosAlertActionable: target.oosAlertActionable,
            supplyActionable: target.supplyActionable,
          }
        : allMembersDiscontinued
          ? {
              primaryActionPane: 'discontinuedPaused',
              primaryActionReasonCode: 'lifecycle_discontinued_or_paused',
              replenishmentEligibility: 'excluded_discontinued',
              replenishmentBlockReasonCode: 'excluded_discontinued',
              existingOrderFollowUp: false,
              existingOrderFollowUpAction: 'none',
              newReplenishmentActionable: false,
              oosAlertActionable: false,
              supplyActionable: false,
            }
          : {
              primaryActionPane: 'dataReadiness',
              primaryActionReasonCode: 'frozen_family_target_review',
              replenishmentEligibility: 'review_missing_target',
              replenishmentBlockReasonCode: 'review_missing_target',
              existingOrderFollowUp: false,
              existingOrderFollowUpAction: 'none',
              newReplenishmentActionable: false,
              oosAlertActionable: false,
              supplyActionable: false,
            };
      const alternateRecommendationCompanyProductIds =
        target && target.replenishmentEligibility !== 'eligible'
          ? members
              .filter(
                (member) =>
                  member.companyProductId !== target.companyProductId && member.replenishmentEligibility === 'eligible',
              )
              .map((member) => String(member.companyProductId))
          : [];
      return {
        runId,
        generatedAt,
        naturalKey: familyKey,
        familyKey,
        companyProductFamilyId: snapshot.companyProductFamilyId,
        companyId: snapshot.companyId,
        amazonAccountId: snapshot.amazonAccountId,
        marketplace: snapshot.marketplace,
        canonicalAsin: snapshot.canonicalAsin,
        targetSelectionState: target ? 'frozen_target' : 'review_required',
        targetCompanyProductId: frozenTargetId,
        representativeCompanyProductId: target?.companyProductId ?? representative.companyProductId,
        actionSourceCompanyProductId: target?.companyProductId ?? null,
        memberCount: members.length,
        ...decision,
        recommendedOrderQty: target?.recommendedOrderQty ?? null,
        alternateRecommendationCompanyProductIds,
        targetSelectionEvidence: structuredClone(record(snapshot.targetSelectionEvidence)),
        listing: target
          ? correctedContract
            ? correctedPersistedListingProjection(target)
            : withoutEnvelope(target)
          : null,
        linkedMemberEvidence: members.map((member) => ({
          companyProductId: member.companyProductId,
          listingReviewCategories: Array.isArray(member.listingReviewCategories)
            ? [...member.listingReviewCategories].map(String).sort()
            : [],
        })),
      };
    });
}

const REFERENCE_FAMILY_ACTION_DIGEST_FIELDS = [
  'naturalKey',
  'familyKey',
  'companyProductFamilyId',
  'companyId',
  'amazonAccountId',
  'marketplace',
  'canonicalAsin',
  'targetSelectionState',
  'targetCompanyProductId',
  'representativeCompanyProductId',
  'actionSourceCompanyProductId',
  'memberCount',
  'primaryActionPane',
  'primaryActionReasonCode',
  'replenishmentEligibility',
  'replenishmentBlockReasonCode',
  'existingOrderFollowUp',
  'existingOrderFollowUpAction',
  'newReplenishmentActionable',
  'oosAlertActionable',
  'supplyActionable',
  'recommendedOrderQty',
  'alternateRecommendationCompanyProductIds',
  'targetSelectionEvidence',
  'listing',
  'linkedMemberEvidence',
] as const;

function actionDigest(actions: PlainRecord[]) {
  return digest(
    [...actions]
      .sort((left, right) => compareText(String(left.familyKey), String(right.familyKey)))
      .map((action) =>
        Object.fromEntries(
          REFERENCE_FAMILY_ACTION_DIGEST_FIELDS.map((field) => [
            field,
            normalizeCorrectedInventoryPlanningDigestValue(field, action[field]),
          ]),
        ),
      ),
  );
}

function protectedRow(row: PlainRecord) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...businessFields } = row;
  return businessFields;
}

export async function referenceProtectedSilverFingerprint(db: EcobaseDatabase, transaction?: unknown) {
  const fingerprints: Record<string, string> = {};
  for (const collection of PROTECTED_SILVER_COLLECTIONS) {
    const repository = db.getRepository(collection) as unknown as ReferenceRepository;
    const rows = (await readAllRowsById({ repository, collectionName: collection, transaction }))
      .map((row) => protectedRow(record(row)))
      .sort((left, right) => compareText(canonical(left), canonical(right)));
    fingerprints[collection] = digest(rows);
  }
  return digest(fingerprints);
}

export class EcobaseIndependentGoldReferenceVerifier {
  constructor(private readonly db: EcobaseDatabase) {}

  async verify(runId: string, transaction?: unknown): Promise<IndependentGoldReferenceVerification> {
    const result = await new EcobaseInventoryPlanningGoldAccess(this.db).readExplicitListingPerformance({
      runId,
      purpose: 'independent_verification',
      actor: { type: 'system' },
      transaction,
    });
    const run = record(result.run);
    const rows = result.rows.map(record);
    const calculationDate = text(run.calculationDate);
    const mismatches: Mismatch[] = [];
    if (!calculationDate) {
      mismatches.push({ code: 'RUN_DATE_INVALID', message: `Run ${runId} has no valid calculation date.` });
    }
    const expectedCount = integer(run.rowCount);
    if (expectedCount === undefined || expectedCount !== rows.length) {
      mismatches.push({
        code: 'ROW_COUNT_MISMATCH',
        message: `Run ${runId} expected ${String(run.rowCount)} rows but stored ${rows.length}.`,
      });
    }
    const naturalKeys = rows.map((row) => text(row.naturalKey));
    if (naturalKeys.some((key) => !key) || new Set(naturalKeys).size !== rows.length) {
      mismatches.push({
        code: 'LISTING_IDENTITY_INVALID',
        message: `Run ${runId} has missing or duplicate natural keys.`,
      });
    }
    if (rows.some((row) => row.refreshRunId !== runId)) {
      mismatches.push({ code: 'RUN_COHORT_MISMATCH', message: `Run ${runId} contains rows from another cohort.` });
    }

    const corrected = run.algorithmContractVersion === CORRECTED_ALGORITHM_VERSION;
    const listingRowDigest = digest(
      sortedListings(rows).map((row) => (corrected ? correctedPersistedListingProjection(row) : withoutEnvelope(row))),
    );
    let familyActionProjectionCount = 0;
    let familyActionProjectionDigest: string | null = null;
    let formulaVerifiedListingCount = 0;
    let coverageVerifiedMonthCount = 0;
    let protectedSilverFingerprintMatched: boolean | null = null;
    let actionLeakCount = 0;

    if (corrected) {
      this.verifyCorrectedRunMetadata(run, rows, listingRowDigest, mismatches);
      const actions = independentFamilyActions(
        rows,
        runId,
        text(run.materializedAt) ?? text(run.verifiedAt) ?? '',
        mismatches,
        true,
      );
      familyActionProjectionCount = actions.length;
      familyActionProjectionDigest = actionDigest(actions);
      if (integer(run.familyActionProjectionCount) !== actions.length) {
        mismatches.push({
          code: 'FAMILY_ACTION_COUNT_MISMATCH',
          message: `Run ${runId} family-action count does not match independent derivation.`,
        });
      }
      if (run.familyActionProjectionDigest !== familyActionProjectionDigest) {
        mismatches.push({
          code: 'FAMILY_ACTION_DIGEST_MISMATCH',
          message: `Run ${runId} family-action digest does not match independent derivation.`,
        });
      }
      const sourceFacts = await this.rows(ECOBASE_COLLECTIONS.silverListingDailyFacts, transaction);
      const intervals = await this.rows(ECOBASE_COLLECTIONS.sourceCoverageIntervals, transaction);
      const memberships = await this.rows(ECOBASE_COLLECTIONS.sourceCoverageMemberships, transaction);
      const sourceFactsByListingMonth = indexByListingMonth(sourceFacts, 'snapshotDate');
      const membershipsByListingMonth = indexByListingMonth(memberships, 'monthStart');
      for (const row of rows) {
        const counts = this.verifyMonthlyListing(
          row,
          calculationDate ?? '',
          sourceFactsByListingMonth,
          intervals,
          membershipsByListingMonth,
          mismatches,
        );
        formulaVerifiedListingCount += counts.formulaVerified ? 1 : 0;
        coverageVerifiedMonthCount += counts.coverageVerifiedMonthCount;
        if (this.hasActionLeak(row)) {
          actionLeakCount += 1;
          mismatches.push({
            code: 'ACTION_LEAK',
            message: `Listing ${text(row.companyProductId) ?? 'unknown'} exposes an ineligible new action.`,
          });
        }
      }
      const currentProtectedFingerprint = await referenceProtectedSilverFingerprint(this.db, transaction);
      protectedSilverFingerprintMatched = currentProtectedFingerprint === run.protectedSilverFingerprint;
      if (!protectedSilverFingerprintMatched) {
        mismatches.push({
          code: 'PROTECTED_SILVER_FINGERPRINT_MISMATCH',
          message: `Run ${runId} protected Silver fingerprint changed after materialization.`,
          details: { expected: run.protectedSilverFingerprint, actual: currentProtectedFingerprint },
        });
      }
    } else {
      const snapshotsPresent = rows.every((row) => text(familySnapshot(row).familyKey));
      if (snapshotsPresent && rows.length) {
        const actions = independentFamilyActions(
          rows,
          runId,
          text(run.materializedAt) ?? text(run.verifiedAt) ?? text(run.publishedAt) ?? '',
          mismatches,
          false,
        );
        familyActionProjectionCount = actions.length;
        familyActionProjectionDigest = actionDigest(actions);
      }
    }

    if (mismatches.length) {
      throw independentVerificationFailure(runId, mismatches);
    }
    return {
      valid: true,
      verifierVersion: REFERENCE_VERIFIER_VERSION,
      contractMode: corrected ? 'corrected' : 'legacy_additive',
      runId,
      calculationDate: calculationDate as string,
      listingRowCount: rows.length,
      listingRowDigest,
      familyActionProjectionCount,
      familyActionProjectionDigest,
      formulaVerifiedListingCount,
      coverageVerifiedMonthCount,
      protectedSilverFingerprintMatched,
      actionLeakCount: 0,
      mismatchCount: 0,
    };
  }

  private verifyCorrectedRunMetadata(
    run: PlainRecord,
    rows: PlainRecord[],
    listingRowDigest: string,
    mismatches: Mismatch[],
  ) {
    const exact: Array<[string, unknown, string]> = [
      ['RULE_VERSION_MISMATCH', run.ruleVersion, CORRECTED_RULE_VERSION],
      ['ALGORITHM_VERSION_MISMATCH', run.algorithmContractVersion, CORRECTED_ALGORITHM_VERSION],
      ['SERIALIZER_VERSION_MISMATCH', run.canonicalSerializerVersion, CORRECTED_SERIALIZER_VERSION],
      ['LISTING_DIGEST_VERSION_MISMATCH', run.listingRowDigestVersion, CORRECTED_LISTING_DIGEST_VERSION],
      ['FAMILY_DIGEST_VERSION_MISMATCH', run.familyActionProjectionDigestVersion, CORRECTED_FAMILY_DIGEST_VERSION],
      ['PROJECTION_GATE_MODE_MISMATCH', run.currentProjectionGateMode, 'informational'],
    ];
    for (const [code, actual, expected] of exact) {
      if (actual !== expected) mismatches.push({ code, message: `Expected ${expected}; received ${String(actual)}.` });
    }
    for (const field of [
      'resolvedPlanningSettingsDigest',
      'sourceCoverageDigest',
      'protectedSilverFingerprint',
      'candidateInputDigest',
      'listingRowDigest',
      'familyActionProjectionDigest',
    ]) {
      if (!SHA256.test(text(run[field]) ?? '')) {
        mismatches.push({ code: 'RUN_DIGEST_INVALID', message: `Run digest ${field} is not lowercase SHA-256.` });
      }
    }
    if (integer(run.listingRowCount) !== rows.length) {
      mismatches.push({ code: 'LISTING_COUNT_MISMATCH', message: 'Corrected listingRowCount does not match storage.' });
    }
    if (run.listingRowDigest !== listingRowDigest) {
      mismatches.push({ code: 'LISTING_DIGEST_MISMATCH', message: 'Corrected listing digest does not match storage.' });
    }
    for (const row of rows) {
      const companyProductId = text(row.companyProductId) ?? 'unknown';
      for (const field of ['companyProductFamilyId', 'companyId', 'amazonAccountId', 'marketplace', 'asin', 'sku']) {
        if (!text(row[field])) {
          mismatches.push({
            code: 'LISTING_IDENTITY_INVALID',
            message: `Listing ${companyProductId} requires ${field}.`,
          });
        }
      }
      if (row.ruleVersion !== CORRECTED_RULE_VERSION || row.algorithmContractVersion !== CORRECTED_ALGORITHM_VERSION) {
        mismatches.push({
          code: 'LISTING_PROVENANCE_MISMATCH',
          message: `Listing ${companyProductId} does not use the corrected contract.`,
        });
      }
      if (!SHA256.test(text(row.productCoverageDigest) ?? '')) {
        mismatches.push({
          code: 'PRODUCT_COVERAGE_DIGEST_INVALID',
          message: `Listing ${companyProductId} has no valid coverage digest.`,
        });
      }
      if (row.resolvedPlanningSettingsDigest !== run.resolvedPlanningSettingsDigest) {
        mismatches.push({
          code: 'SETTINGS_PROVENANCE_MISMATCH',
          message: `Listing ${companyProductId} settings digest differs from the run.`,
        });
      }
    }
  }

  private verifyMonthlyListing(
    row: PlainRecord,
    calculationDate: string,
    sourceFactsByListingMonth: ListingMonthRowIndex,
    intervals: PlainRecord[],
    membershipsByListingMonth: ListingMonthRowIndex,
    mismatches: Mismatch[],
  ) {
    const listingId = text(row.companyProductId) ?? 'unknown';
    const evidence = Array.isArray(row.monthlyPerformanceEvidence) ? row.monthlyPerformanceEvidence.map(record) : [];
    const expectedMonths = expectedClosedMonths(calculationDate);
    if (evidence.length !== 6 || canonical(evidence.map((month) => month.monthStart)) !== canonical(expectedMonths)) {
      mismatches.push({
        code: 'MONTH_WINDOW_MISMATCH',
        message: `Listing ${listingId} does not contain the dynamic six-closed-month UTC window.`,
      });
      return { formulaVerified: false, coverageVerifiedMonthCount: 0 };
    }
    const eligible: Array<{ month: PlainRecord; units: Decimal; profit: Decimal }> = [];
    let coverageVerifiedMonthCount = 0;
    for (const month of evidence) {
      const monthStart = text(month.monthStart) as string;
      const monthEnd = isoMonthEnd(monthStart);
      if (month.monthEnd !== monthEnd) {
        mismatches.push({
          code: 'MONTH_END_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} has wrong end.`,
        });
      }
      if (month.eligible !== true) continue;
      // Sparse-tolerant evidence: an eligible month is either fully covered (complete) or a
      // coverage-gap month that still carries facts (partial). Both rank; only the completeness
      // grade differs. Anything else on an eligible month is a contract violation.
      if (month.reasonCode !== 'eligible_complete_month' && month.reasonCode !== 'eligible_partial_month') {
        mismatches.push({
          code: 'ELIGIBLE_REASON_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} has an invalid eligible reason.`,
        });
      }
      const facts = (
        sourceFactsByListingMonth.get(listingMonthKey(row.companyProductId, monthStart) ?? '') ?? []
      ).filter(
        (fact) =>
          fact.companyProductId === row.companyProductId &&
          String(fact.snapshotDate ?? '') >= monthStart &&
          String(fact.snapshotDate ?? '') <= monthEnd,
      );
      let units = new ReferenceDecimal(0);
      let profit = new ReferenceDecimal(0);
      let invalidFact = false;
      for (const fact of facts) {
        const factUnits = decimal(fact.units);
        const factProfit = decimal(fact.netProfit ?? fact.profit);
        if (!factUnits || !factProfit) {
          invalidFact = true;
          continue;
        }
        units = units.plus(factUnits);
        profit = profit.plus(factProfit);
      }
      if (invalidFact || integer(month.sourceFactCount) !== facts.length) {
        mismatches.push({
          code: 'SOURCE_FACT_COUNT_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} source facts do not match evidence.`,
        });
      }
      // F2b mirror: a partial month's persisted contribution is month-rate normalized
      // (observed total × days-in-month ÷ observed days) — reproduce the engine's exact
      // operation order so fixed-scale comparison and baseline aggregation stay byte-identical.
      if (month.reasonCode === 'eligible_partial_month' && facts.length > 0) {
        const daysInMonth = Number(monthEnd.slice(8, 10));
        units = units.mul(daysInMonth).div(facts.length);
        profit = profit.mul(daysInMonth).div(facts.length);
      }
      if (!sameDecimal(month.monthlyUnits, units)) {
        mismatches.push({
          code: 'MONTHLY_UNITS_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} units differ from Silver facts.`,
        });
      }
      if (!sameDecimal(month.monthlyProfit, profit)) {
        mismatches.push({
          code: 'MONTHLY_PROFIT_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} profit differs from Silver facts.`,
        });
      }
      const profitPerUnit = units.isZero() ? null : profit.div(units);
      if (!sameDecimal(month.monthlyProfitPerUnit, profitPerUnit)) {
        mismatches.push({
          code: 'MONTHLY_PROFIT_PER_UNIT_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} profit per unit is inconsistent.`,
        });
      }
      if (!sameDecimal(month.monthlyTierScore, profit)) {
        mismatches.push({
          code: 'MONTHLY_TIER_SCORE_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} score is not monthly NetProfit.`,
        });
      }
      // Independently re-derive completeness and confirm the persisted grade agrees: a
      // 'eligible_complete_month' MUST be gap-free reconciled coverage; a 'eligible_partial_month'
      // must NOT be (else it should have been graded complete). Only fully-covered months count
      // toward coverageVerifiedMonthCount.
      const fullyCovered = this.coverageValid(
        row,
        monthStart,
        monthEnd,
        intervals,
        membershipsByListingMonth.get(listingMonthKey(row.companyProductId, monthStart) ?? '') ?? [],
        facts.length,
      );
      if (fullyCovered) coverageVerifiedMonthCount += 1;
      if (month.reasonCode === 'eligible_complete_month' && !fullyCovered) {
        mismatches.push({
          code: 'COVERAGE_MEMBERSHIP_MISMATCH',
          message: `Listing ${listingId} month ${monthStart} claims complete coverage without gap-free reconciled coverage.`,
        });
      }
      if (month.reasonCode === 'eligible_partial_month' && fullyCovered) {
        mismatches.push({
          code: 'PARTIAL_MONTH_FULLY_COVERED',
          message: `Listing ${listingId} month ${monthStart} is graded partial but has complete coverage.`,
        });
      }
      eligible.push({ month, units, profit });
    }
    const totalUnits = eligible.reduce((sum, item) => sum.plus(item.units), new ReferenceDecimal(0));
    const totalProfit = eligible.reduce((sum, item) => sum.plus(item.profit), new ReferenceDecimal(0));
    const count = eligible.length;
    const averageUnits = count ? totalUnits.div(count) : null;
    const averageProfit = count ? totalProfit.div(count) : null;
    const weightedProfitPerUnit = count && !totalUnits.isZero() ? totalProfit.div(totalUnits) : null;
    // Sparseness lowers confidence, never visibility: 'full' requires all six months fully
    // covered; partial (coverage-gap) months still grant moderate/low and always rank.
    const completeCount = eligible.filter((item) => item.month.reasonCode === 'eligible_complete_month').length;
    const confidence = completeCount === 6 ? 'full' : count >= 3 ? 'moderate' : count >= 1 ? 'low' : 'none';
    const baselineState = count ? (totalUnits.isZero() ? 'no_movement' : 'ranked') : 'unclassified';
    const baselineTier = averageProfit && baselineState === 'ranked' ? monthTier(averageProfit) : null;
    const checks: Array<[string, unknown, Decimal | null]> = [
      ['BASELINE_TOTAL_UNITS_MISMATCH', row.baselineTotalUnits, count ? totalUnits : null],
      ['BASELINE_TOTAL_PROFIT_MISMATCH', row.baselineTotalProfit, count ? totalProfit : null],
      ['AVERAGE_MONTHLY_UNITS_MISMATCH', row.averageMonthlyUnits, averageUnits],
      ['AVERAGE_MONTHLY_PROFIT_MISMATCH', row.averageMonthlyProfit, averageProfit],
      ['BASELINE_SCORE_MISMATCH', row.baselineTierScore, averageProfit],
      ['WEIGHTED_PROFIT_PER_UNIT_MISMATCH', row.baselineWeightedProfitPerUnit, weightedProfitPerUnit],
    ];
    for (const [code, actual, expected] of checks) {
      if (!sameDecimal(actual, expected)) {
        mismatches.push({ code, message: `Listing ${listingId} failed independent monthly aggregation.` });
      }
    }
    if (
      integer(row.baselineEligibleMonthCount) !== count ||
      row.baselineConfidence !== confidence ||
      row.baselineState !== baselineState ||
      (row.baselineTier ?? null) !== baselineTier
    ) {
      mismatches.push({
        code: 'BASELINE_CLASSIFICATION_MISMATCH',
        message: `Listing ${listingId} baseline confidence/state/tier does not match independent calculation.`,
      });
    }
    if (fixed8(averageProfit) !== (row.baselineTierScore ?? null)) {
      mismatches.push({
        code: 'BASELINE_FIXED_SCALE_MISMATCH',
        message: `Listing ${listingId} baseline score is not fixed-scale decimal8.`,
      });
    }
    return { formulaVerified: true, coverageVerifiedMonthCount };
  }

  private coverageValid(
    row: PlainRecord,
    monthStart: string,
    monthEnd: string,
    intervals: readonly PlainRecord[],
    memberships: readonly PlainRecord[],
    factCount: number,
  ) {
    return memberships.some((membership) => {
      if (
        membership.companyProductId !== row.companyProductId ||
        membership.monthStart !== monthStart ||
        membership.membershipStatus !== 'in_scope' ||
        membership.metricReconciliationStatus !== 'complete' ||
        integer(membership.normalizedFactLinkCount) !== factCount
      ) {
        return false;
      }
      const interval = intervals.find((candidate) => candidate.id === membership.coverageIntervalId);
      return Boolean(
        interval &&
          interval.companyId === row.companyId &&
          interval.amazonAccountId === row.amazonAccountId &&
          String(interval.marketplace).toLowerCase() === String(row.marketplace).toLowerCase() &&
          interval.coverageStatus === 'active' &&
          interval.continuousCoverage === true &&
          String(interval.coveredStartDate) <= monthStart &&
          String(interval.coveredEndDate) >= monthEnd,
      );
    });
  }

  private hasActionLeak(row: PlainRecord) {
    if (row.newReplenishmentActionable !== true) return false;
    // Mirror of the decision engine's action gate. Reversed philosophy: a velocity gap no longer
    // blocks, so an actionable row may carry 'none' OR 'insufficient_velocity_evidence' (e.g. an
    // in-stock estimated reorder-due row, or trusted rolling velocity with a stale inventory
    // snapshot). Only the BLOCKING dispositions (stuck/excess) are a leak.
    return !(
      row.replenishmentEligibility === 'eligible' &&
      row.baselineConfidence === 'full' &&
      ['A', 'B', 'C'].includes(String(row.baselineTier)) &&
      !['no_sell_through', 'over_60_days_cover'].includes(String(row.inventoryDisposition)) &&
      row.isFrozenFamilyTarget === true &&
      row.existingOrderFollowUp !== true
    );
  }

  private async rows(collection: string, transaction?: unknown) {
    const repository = this.db.getRepository(collection) as unknown as ReferenceRepository;
    return (await readAllRowsById({ repository, collectionName: collection, transaction })).map(record);
  }
}
