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
import { bronzePayloadHash } from './bronze-import-service';
import type { EcobaseDatabase } from './import-service';

export const SELLERBOARD_COVERAGE_METRIC_SET = 'sellerboard_units_net_profit_v1';
export const SELLERBOARD_SCOPE_EVIDENCE_VERSION = 'sellerboard_listing_scope_v1';
const COVERAGE_PROJECTION_PAGE_SIZE = 5000;

export const FROZEN_COVERAGE_BOOTSTRAP_MANIFEST = {
  version: 'td02a_strict_source_row_rebaseline_v2',
  feasibilityReportDigest: 'df881488cf049dd473d7ca0d1822a654161946f5e7aaee763289c19f779c350c',
  strictPlanDigest: '362134b7a631794b7cd91db0e1b300ae0583d2dbc47dcf1cf2d13f34de36fe01',
  sourceEvidenceDigests: {
    preflightManifest: '150a6c707cab33c221ba2ed3ade7e2561ffdcb64977f19498ca6e206f2d05875',
    sellerboardSourceIndex: '0bb9ea12e08c49bdf350be5b5cfa4c325d5807b0582a8922eb749541055159b3',
    sellerboardHistoryIndex: 'b6568352dd6c1fc3f32e5d169e86c83781a28bc60b21a01d34d6338048843beb',
    sellerboardHistoryResult: '1b5aa5b0ffe7af8c7696119be3388be0ad29ac9fcf040a1e1e7abd03272873b4',
    sellerboardImportRuns: 'd81307adbfdf6b227246501049a0c90806810f48cfce5950c87b6d679818bba5',
    sellerboardBronzeRecords: 'b0eaefc8ba43b64814bfe4835e07558bc94795e07261a364dbf0a6f4897590d2',
    sellerboardNormalizationLinks: '54d62186e838d84148b915663039cf5433f7c54f7a5004b3b2816e5594a1ae47',
    silverListingDailyFacts: '7688c45e4a75d6ca43804226dc3dafc5e0a6eb1d237bd2ec4a8b06beeaa5b5f9',
    companyProductIdentity: '79947a33fb7df689931b5c9bd29996a5f3c0247c0e0e7965c696cc63a821d0b4',
    strictReferenceImplementation: '78d2c36c4f3c3f290f64f304afb2301fde533efba50d58042116ab71e9aaaa0c',
    strictReferenceResult: '9673927a295b7e42f50e17a94a00c47ffff01b4807cb9e0765d15fb706ffd26d',
    strictCanonicalProjection: 'b69788aeba35ef5f67edf1a2054cadddb82ed893f13f3ea8d7f08be3804e9e7a',
    strictCausalityReport: '6fb2c1eb0f3f8976fb54d0d009750c32444fb76060e22a8c0141e7f3313dfe03',
    strictDependentReference: '59f41f4d6f08c7cdc2a02217911e37e64787cecfb8e4f8160715ba90343e3359',
    strictDependentCalculatorEvidence: '9d2d8642dee226a9ab558b32c0f515eb41054f80fa5a7b3681ac65eaffced379',
  },
  expected: {
    history: {
      intervalCount: 54,
      continuousIntervalCount: 42,
      discontinuousIntervalCount: 12,
      membershipCount: 3718,
    },
    baseline: {
      listingCount: 2363,
      productMonthCount: 14178,
      eligibleCompleteCount: 3667,
      productScopeUnknownCount: 10364,
      coverageDiscontinuousCount: 142,
      metricNormalizationMismatchCount: 5,
      confidenceCounts: { full: 260, moderate: 400, low: 411, none: 1292 },
    },
    current: {
      intervalCount: 10,
      continuousIntervalCount: 5,
      incompleteIntervalCount: 5,
      membershipCount: 2319,
      metricNormalizationMismatchCount: 100,
      completeScopeMetricNormalizationMismatchCount: 88,
    },
    predictedLedgerWriteCount: 6101,
    predictedProtectedDomainMutationCount: 0,
  },
} as const;

export const FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST = bronzePayloadHash(FROZEN_COVERAGE_BOOTSTRAP_MANIFEST);

export function frozenCoverageBootstrapApplyConfirmation(planDigest: string) {
  digest(planDigest, 'planDigest');
  return `APPLY_TD02A_COVERAGE_${planDigest.slice(0, 16)}`;
}

export type CoverageMonthReason =
  | 'eligible_complete_month'
  | 'coverage_interval_missing'
  | 'coverage_discontinuous'
  | 'product_scope_unknown'
  | 'units_metric_incomplete'
  | 'net_profit_metric_incomplete'
  | 'metric_normalization_mismatch'
  | 'invalid_units'
  | 'missing_net_profit';

export class EcobaseCoverageError extends Error {
  constructor(
    readonly code:
      | 'ECOBASE_COVERAGE_CONFLICT'
      | 'ECOBASE_COVERAGE_SCOPE_UNPROVEN'
      | 'ECOBASE_COVERAGE_BOOTSTRAP_DIGEST_MISMATCH',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'EcobaseCoverageError';
  }
}

export interface CoverageProductMonthQuery {
  sourceConnectionId: string;
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  companyProductId: string;
  monthStart: string;
  metricSet?: typeof SELLERBOARD_COVERAGE_METRIC_SET;
}

export interface CoverageProductMonthResult {
  eligible: boolean;
  reasonCode: CoverageMonthReason;
  trustedZeroWhenNoFacts: boolean;
  intervalIds: string[];
  membershipIds: string[];
}

export interface CoverageIntervalEvidence {
  naturalKey: string;
  sourceConnectionId: string;
  companyId: string;
  amazonAccountId: string;
  marketplace: string;
  coveredStartDate: string;
  coveredEndDate: string;
  continuousCoverage: boolean;
  sourceAsOfDate: string;
  sourceVersion: string;
  importRunId: string;
  inputDigest: string;
  scopeDigest: string;
  evidenceJson: Record<string, unknown>;
}

export interface CoverageMembershipEvidence {
  intervalNaturalKey: string;
  companyProductId: string;
  monthStart: string;
  scopeEvidenceKinds: Array<'profit_by_product_daily' | 'stock_daily'>;
  scopeEvidenceDigest: string;
  sourceMetricRowCount: number;
  normalizedFactLinkCount: number;
  metricReconciliationStatus: 'complete' | 'incomplete';
  metricEvidenceDigest: string;
}

export interface CoverageEvidencePlan {
  intervals: CoverageIntervalEvidence[];
  memberships: CoverageMembershipEvidence[];
}

/**
 * An incoming coverage interval whose window sits fully inside an existing ACTIVE interval we
 * already hold from an equal-or-newer source. Sellerboard routinely re-serves an older/stale
 * report for days a fresher pull already covered; refusing to overwrite is correct, but it must
 * be a quiet no-op, not an error. Each skipped metric set is surfaced here so the sources page can
 * show an informational note instead of a red failure.
 */
export interface CoverageSkippedStale {
  metricSet: string;
  incomingAsOf: string;
  heldAsOf: string;
  window: string;
}

export interface CoverageReconciliationResult {
  intervalCreatedCount: number;
  membershipCreatedCount: number;
  supersededIntervalCount: number;
  idempotentIntervalCount: number;
  idempotentMembershipCount: number;
  coverageSkippedStale: CoverageSkippedStale[];
  noOp: boolean;
}

export interface FrozenCoverageBootstrapSummary {
  history: {
    intervalCount: number;
    continuousIntervalCount: number;
    discontinuousIntervalCount: number;
    membershipCount: number;
  };
  baseline: {
    listingCount: number;
    productMonthCount: number;
    eligibleCompleteCount: number;
    productScopeUnknownCount: number;
    coverageDiscontinuousCount: number;
    metricNormalizationMismatchCount: number;
    confidenceCounts: { full: number; moderate: number; low: number; none: number };
  };
  current: {
    intervalCount: number;
    continuousIntervalCount: number;
    incompleteIntervalCount: number;
    membershipCount: number;
    metricNormalizationMismatchCount: number;
    completeScopeMetricNormalizationMismatchCount: number;
  };
  predictedLedgerWriteCount: number;
  predictedProtectedDomainMutationCount: 0;
}

export interface FrozenCoverageBootstrapResult extends FrozenCoverageBootstrapSummary {
  mode: 'dry-run' | 'apply';
  evidenceDigest: string;
  planDigest: string;
  reconciliation: CoverageReconciliationResult | null;
}

export type CoverageMaintenanceResult =
  | {
      recorded: true;
      importRunId: string;
      intervalCount: number;
      membershipCount: number;
      planDigest: string;
      reconciliation: CoverageReconciliationResult;
    }
  | {
      recorded: false;
      importRunId: string;
      reasonCode:
        | 'import_not_successful'
        | 'adapter_not_supported'
        | 'company_scope_unproven'
        | 'account_scope_unproven'
        | 'source_as_of_invalid'
        | 'source_evidence_empty';
    };

type PlainRecord = Record<string, unknown>;

type CoverageProjectionSnapshot = {
  accounts: PlainRecord[];
  bronzeRows: PlainRecord[];
  products: PlainRecord[];
  companyProducts: PlainRecord[];
  links: PlainRecord[];
  facts: PlainRecord[];
};

function toPlainRecord(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const model = value as { get?: (options: { plain: boolean }) => unknown; toJSON?: () => unknown };
  if (typeof model.get === 'function') return (model.get({ plain: true }) ?? {}) as PlainRecord;
  if (typeof model.toJSON === 'function') return (model.toJSON() ?? {}) as PlainRecord;
  return { ...(value as PlainRecord) };
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dateOnly(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new EcobaseCoverageError(
      'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
      `EcoBase source coverage requires ${field} as a UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new EcobaseCoverageError(
      'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
      `EcoBase source coverage requires ${field} as a valid UTC date-only value; received "${value}".`,
      { field, value },
    );
  }
  return date;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthDates(monthStart: string) {
  const start = dateOnly(monthStart, 'monthStart');
  if (start.getUTCDate() !== 1) {
    throw new EcobaseCoverageError(
      'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
      `EcoBase source coverage monthStart must be the first UTC day of a month; received "${monthStart}".`,
      { monthStart },
    );
  }
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const dates: string[] = [];
  for (let date = start; date <= end; date = new Date(date.getTime() + 86_400_000)) dates.push(isoDate(date));
  return dates;
}

function matchesScope(interval: PlainRecord, query: CoverageProductMonthQuery) {
  return (
    interval.coverageStatus === 'active' &&
    interval.sourceConnectionId === query.sourceConnectionId &&
    interval.companyId === query.companyId &&
    interval.amazonAccountId === query.amazonAccountId &&
    interval.marketplace === query.marketplace &&
    interval.metricSet === (query.metricSet ?? SELLERBOARD_COVERAGE_METRIC_SET)
  );
}

function intervalOwnsDate(interval: PlainRecord, date: string) {
  const start = text(interval.coveredStartDate);
  const end = text(interval.coveredEndDate);
  return Boolean(start && end && start <= date && date <= end);
}

function sourceOrder(interval: PlainRecord) {
  return `${text(interval.sourceAsOfDate) ?? ''}\u0000${text(interval.sourceVersion) ?? ''}\u0000${
    text(interval.id) ?? ''
  }`;
}

function digest(value: string, field: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new EcobaseCoverageError(
      'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
      `EcoBase source coverage requires ${field} as a lowercase SHA-256 digest.`,
      { field },
    );
  }
  return value;
}

function nonEmpty(value: string, field: string) {
  if (!value.trim()) {
    throw new EcobaseCoverageError('ECOBASE_COVERAGE_SCOPE_UNPROVEN', `EcoBase source coverage requires ${field}.`, {
      field,
    });
  }
  return value.trim();
}

function intervalProjection(value: PlainRecord) {
  return {
    naturalKey: value.naturalKey,
    sourceConnectionId: value.sourceConnectionId,
    companyId: value.companyId,
    amazonAccountId: value.amazonAccountId,
    marketplace: value.marketplace,
    metricSet: value.metricSet,
    coveredStartDate: value.coveredStartDate,
    coveredEndDate: value.coveredEndDate,
    continuousCoverage: value.continuousCoverage,
    sourceAsOfDate: value.sourceAsOfDate,
    sourceVersion: value.sourceVersion,
    inputDigest: value.inputDigest,
    scopeDigest: value.scopeDigest,
    productScopeEvidenceVersion: value.productScopeEvidenceVersion,
  };
}

function membershipProjection(value: PlainRecord) {
  return {
    naturalKey: value.naturalKey,
    coverageIntervalId: value.coverageIntervalId,
    companyProductId: value.companyProductId,
    monthStart: value.monthStart,
    membershipStatus: value.membershipStatus,
    scopeEvidenceKinds: value.scopeEvidenceKinds,
    scopeEvidenceDigest: value.scopeEvidenceDigest,
    sourceMetricRowCount: value.sourceMetricRowCount,
    normalizedFactLinkCount: value.normalizedFactLinkCount,
    metricReconciliationStatus: value.metricReconciliationStatus,
    metricEvidenceDigest: value.metricEvidenceDigest,
  };
}

function overlaps(left: PlainRecord, right: PlainRecord) {
  return (
    String(left.coveredStartDate) <= String(right.coveredEndDate) &&
    String(right.coveredStartDate) <= String(left.coveredEndDate)
  );
}

function sameIntervalScope(left: PlainRecord, right: PlainRecord) {
  return (
    left.sourceConnectionId === right.sourceConnectionId &&
    left.companyId === right.companyId &&
    left.amazonAccountId === right.amazonAccountId &&
    left.marketplace === right.marketplace &&
    left.metricSet === right.metricSet
  );
}

function numberValue(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim().replace(/[$,%\s]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sourceUnits(payload: PlainRecord) {
  const direct = numberValue(payload.units);
  if (direct !== undefined) return direct;
  const fields = [
    'unitsOrganic',
    'unitsPpc',
    'unitsSponsoredProducts',
    'unitsSponsoredBrands',
    'unitsSponsoredDisplay',
  ];
  const values = fields.map((field) => numberValue(payload[field])).filter((value) => value !== undefined);
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

function monthStartFor(value: string) {
  const date = dateOnly(value, 'sourceAsOfDate');
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function monthEndFor(value: string) {
  const start = dateOnly(value, 'monthStart');
  return isoDate(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)));
}

type SellerboardCoverageAdapter = 'sellerboard-api' | 'sellerboard-history-csv';
type CoverageReportKind = 'profit_by_product_daily' | 'stock_daily';

function reportKind(record: PlainRecord, adapterName: SellerboardCoverageAdapter): CoverageReportKind | undefined {
  const sourceDataset = text(record.sourceDataset)?.toLowerCase();
  if (
    sourceDataset === 'sellerboard_daily_facts' &&
    (adapterName === 'sellerboard-api' || adapterName === 'sellerboard-history-csv')
  ) {
    return 'profit_by_product_daily';
  }
  if (sourceDataset === 'amazon_listing_inventory' && adapterName === 'sellerboard-api') return 'stock_daily';
  return undefined;
}

function canonicalStoredDate(value: unknown) {
  const candidate = text(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return undefined;
  const [year, month, day] = candidate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === candidate ? candidate : undefined;
}

type SellerboardReportDateFormat = 'day-first' | 'month-first';
type SellerboardReportDateEvidence = {
  format?: SellerboardReportDateFormat;
  conflicted: boolean;
};

function calendarDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return isoDate(date);
}

function sellerboardReportDateEvidence(rows: PlainRecord[], adapterName: SellerboardCoverageAdapter) {
  let format: SellerboardReportDateFormat | undefined;
  for (const row of rows) {
    if (reportKind(row, adapterName) !== 'profit_by_product_daily') continue;
    const period = text(toPlainRecord(row.payload).period);
    const match = period?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) continue;
    const left = Number(match[1]);
    const right = Number(match[2]);
    const observed = left > 12 && right <= 12 ? 'day-first' : right > 12 && left <= 12 ? 'month-first' : undefined;
    if (!observed) continue;
    if (format && format !== observed) return { conflicted: true } satisfies SellerboardReportDateEvidence;
    format = observed;
  }
  return { format, conflicted: false } satisfies SellerboardReportDateEvidence;
}

function canonicalSellerboardReportDate(
  value: unknown,
  evidence: SellerboardReportDateEvidence,
  linkedFactDate?: string,
) {
  const iso = canonicalStoredDate(value);
  if (iso) return iso;
  const match = text(value)?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match || evidence.conflicted) return undefined;
  const left = Number(match[1]);
  const right = Number(match[2]);
  const year = Number(match[3]);
  if (evidence.format === 'day-first') return calendarDate(year, right, left);
  if (evidence.format === 'month-first') return calendarDate(year, left, right);
  const candidates = [...new Set([calendarDate(year, right, left), calendarDate(year, left, right)].filter(Boolean))];
  if (candidates.length === 1) return candidates[0];
  return linkedFactDate && candidates.includes(linkedFactDate) ? linkedFactDate : undefined;
}

function coverageEvidenceDate(params: {
  kind: CoverageReportKind;
  sourceAsOfDate: string;
  rawPeriod: unknown;
  reportDateEvidence: SellerboardReportDateEvidence;
  linkedFactDate?: string;
}) {
  if (params.kind === 'stock_daily') return canonicalStoredDate(params.sourceAsOfDate);
  return canonicalSellerboardReportDate(params.rawPeriod, params.reportDateEvidence, params.linkedFactDate);
}

function identityKey(asin: unknown, sku: unknown) {
  const normalizedAsin = text(asin)?.toUpperCase();
  const normalizedSku = text(sku)?.toLowerCase();
  return normalizedAsin && normalizedSku ? `${normalizedAsin}\u0000${normalizedSku}` : undefined;
}

function accountKey(companyId: unknown, marketplace: unknown) {
  const company = text(companyId);
  const market = text(marketplace)?.toLowerCase();
  return company && market ? `${company}\u0000${market}` : undefined;
}

function completeDateRange(start: string, end: string) {
  const first = dateOnly(start, 'coveredStartDate');
  const last = dateOnly(end, 'coveredEndDate');
  const dates: string[] = [];
  for (let date = first; date <= last; date = new Date(date.getTime() + 86_400_000)) dates.push(isoDate(date));
  return dates;
}

function sameNumber(left: unknown, right: unknown) {
  const a = numberValue(left);
  const b = numberValue(right);
  return a !== undefined && b !== undefined && Math.abs(a - b) <= 0.00000001;
}

export class EcobaseSourceCoverageService {
  constructor(private readonly db: EcobaseDatabase) {}

  async reconcileEvidence(
    plan: CoverageEvidencePlan,
    options: { transaction?: unknown } = {},
  ): Promise<CoverageReconciliationResult> {
    if (!options.transaction && this.db.sequelize?.transaction) {
      return this.db.sequelize.transaction((transaction: unknown) => this.reconcileEvidence(plan, { transaction }));
    }
    return this.reconcileEvidenceInTransaction(plan, options.transaction);
  }

  async bootstrapFrozenEvidence(params: {
    mode: 'dry-run' | 'apply';
    expectedEvidenceDigest: string;
    expectedPlanDigest?: string;
    plan: CoverageEvidencePlan;
  }): Promise<FrozenCoverageBootstrapResult> {
    if (params.expectedEvidenceDigest !== FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST) {
      throw this.bootstrapMismatch('approved frozen-evidence digest', {
        expected: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
        received: params.expectedEvidenceDigest,
      });
    }
    this.validateBootstrapPlan(params.plan);
    const canonicalPlan = {
      intervals: [...params.plan.intervals].sort((left, right) => left.naturalKey.localeCompare(right.naturalKey)),
      memberships: [...params.plan.memberships].sort((left, right) =>
        `${left.intervalNaturalKey}\u0000${left.companyProductId}\u0000${left.monthStart}`.localeCompare(
          `${right.intervalNaturalKey}\u0000${right.companyProductId}\u0000${right.monthStart}`,
        ),
      ),
    };
    const planDigest = bronzePayloadHash(canonicalPlan);
    if (params.expectedPlanDigest && params.expectedPlanDigest !== planDigest) {
      throw this.bootstrapMismatch('bootstrap plan digest', {
        expected: params.expectedPlanDigest,
        received: planDigest,
      });
    }
    if (params.mode === 'apply' && !params.expectedPlanDigest) {
      throw this.bootstrapMismatch('bootstrap apply plan digest', {
        expected: planDigest,
        received: null,
      });
    }
    const summary = await this.summarizeBootstrapPlan(canonicalPlan);
    if (bronzePayloadHash(summary) !== bronzePayloadHash(FROZEN_COVERAGE_BOOTSTRAP_MANIFEST.expected)) {
      throw this.bootstrapMismatch('TD-02A bootstrap counts and partitions', {
        expected: FROZEN_COVERAGE_BOOTSTRAP_MANIFEST.expected,
        received: summary,
      });
    }
    const reconciliation = params.mode === 'apply' ? await this.reconcileEvidence(canonicalPlan) : null;
    return {
      mode: params.mode,
      evidenceDigest: FROZEN_COVERAGE_BOOTSTRAP_EVIDENCE_DIGEST,
      planDigest,
      ...summary,
      reconciliation,
    };
  }

  async bootstrapFrozenSuccessfulImports(params: {
    mode: 'dry-run' | 'apply';
    expectedEvidenceDigest: string;
    expectedPlanDigest?: string;
    confirmation?: string;
    importRunIds: string[];
  }): Promise<FrozenCoverageBootstrapResult & { applyConfirmation: string }> {
    const importRunIds = [...new Set(params.importRunIds)].sort();
    if (!importRunIds.length || importRunIds.length !== params.importRunIds.length) {
      throw this.bootstrapMismatch('unique non-empty import-run selection', {
        importRunIds: params.importRunIds,
      });
    }
    const snapshot = await this.loadCoverageProjection(importRunIds);
    const plans: CoverageEvidencePlan[] = [];
    for (const importRunId of importRunIds) plans.push(await this.frozenImportPlan(importRunId, snapshot));
    const plan: CoverageEvidencePlan = {
      intervals: plans.flatMap((item) => item.intervals),
      memberships: plans.flatMap((item) => item.memberships),
    };
    const dryRun = await this.bootstrapFrozenEvidence({
      mode: 'dry-run',
      expectedEvidenceDigest: params.expectedEvidenceDigest,
      expectedPlanDigest: params.expectedPlanDigest ?? FROZEN_COVERAGE_BOOTSTRAP_MANIFEST.strictPlanDigest,
      plan,
    });
    const applyConfirmation = frozenCoverageBootstrapApplyConfirmation(dryRun.planDigest);
    if (params.mode === 'dry-run') return { ...dryRun, applyConfirmation };
    if (params.confirmation !== applyConfirmation) {
      throw this.bootstrapMismatch('explicit bootstrap apply confirmation', {
        expected: applyConfirmation,
        received: params.confirmation ?? null,
      });
    }
    const applied = await this.bootstrapFrozenEvidence({
      mode: 'apply',
      expectedEvidenceDigest: params.expectedEvidenceDigest,
      expectedPlanDigest: params.expectedPlanDigest,
      plan,
    });
    return { ...applied, applyConfirmation };
  }

  async maintainSuccessfulImport(
    importRunId: string,
    options: { transaction?: unknown } = {},
  ): Promise<CoverageMaintenanceResult> {
    const run = toPlainRecord(
      await this.db
        .getRepository(ECOBASE_COLLECTIONS.importRuns)
        .findOne({ filterByTk: importRunId, transaction: options.transaction }),
    );
    if (run.status !== 'success') return { recorded: false, importRunId, reasonCode: 'import_not_successful' };
    const adapterName = text(run.adapterName);
    if (!adapterName || !['sellerboard-api', 'sellerboard-history-csv'].includes(adapterName)) {
      return { recorded: false, importRunId, reasonCode: 'adapter_not_supported' };
    }
    const sourceConnectionId = text(run.sourceConnectionId);
    const source = sourceConnectionId
      ? toPlainRecord(
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.sourceConnections)
            .findOne({ filterByTk: sourceConnectionId, transaction: options.transaction }),
        )
      : {};
    const companyId = text(source.companyId);
    if (!sourceConnectionId || !companyId) {
      return { recorded: false, importRunId, reasonCode: 'company_scope_unproven' };
    }
    const sourceAsOfDate = text(run.sourceVersion)?.slice(0, 10) ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceAsOfDate)) {
      return { recorded: false, importRunId, reasonCode: 'source_as_of_invalid' };
    }

    const plan = await this.planImportEvidence({
      adapterName,
      companyId,
      importRunId,
      sourceAsOfDate,
      sourceConnectionId,
      sourceVersion: text(run.sourceVersion) ?? sourceAsOfDate,
      transaction: options.transaction,
    });
    if (plan === 'account_scope_unproven') {
      return { recorded: false, importRunId, reasonCode: 'account_scope_unproven' };
    }
    if (!plan.intervals.length) return { recorded: false, importRunId, reasonCode: 'source_evidence_empty' };
    const reconciliation = await this.reconcileEvidence(plan, options);
    return {
      recorded: true,
      importRunId,
      intervalCount: plan.intervals.length,
      membershipCount: plan.memberships.length,
      planDigest: bronzePayloadHash(plan),
      reconciliation,
    };
  }

  async evaluateProductMonth(query: CoverageProductMonthQuery): Promise<CoverageProductMonthResult> {
    const dates = monthDates(query.monthStart);
    const intervals = (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals).find({ limit: 100000 }))
      .map(toPlainRecord)
      .filter((interval) => matchesScope(interval, query));
    if (!intervals.length) return this.result('coverage_interval_missing');

    const selected = new Map<string, PlainRecord>();
    for (const date of dates) {
      const owner = intervals
        .filter((interval) => intervalOwnsDate(interval, date))
        .sort((left, right) => sourceOrder(right).localeCompare(sourceOrder(left)))[0];
      if (!owner || owner.continuousCoverage !== true) return this.result('coverage_discontinuous', intervals);
      selected.set(String(owner.id), owner);
    }

    const selectedIds = new Set(selected.keys());
    const memberships = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships).find({ limit: 100000 })
    )
      .map(toPlainRecord)
      .filter(
        (membership) =>
          selectedIds.has(String(membership.coverageIntervalId)) &&
          membership.companyProductId === query.companyProductId &&
          membership.monthStart === query.monthStart &&
          membership.membershipStatus === 'in_scope',
      );
    const membershipIntervalIds = new Set(memberships.map((membership) => String(membership.coverageIntervalId)));
    if (!memberships.length || [...selectedIds].some((intervalId) => !membershipIntervalIds.has(intervalId))) {
      return this.result('product_scope_unknown', [...selected.values()], memberships);
    }
    if (memberships.some((membership) => membership.metricReconciliationStatus !== 'complete')) {
      return this.result('metric_normalization_mismatch', [...selected.values()], memberships);
    }
    return this.result('eligible_complete_month', [...selected.values()], memberships);
  }

  private async frozenImportPlan(
    importRunId: string,
    snapshot: CoverageProjectionSnapshot,
  ): Promise<CoverageEvidencePlan> {
    const run = toPlainRecord(
      await this.db.getRepository(ECOBASE_COLLECTIONS.importRuns).findOne({ filterByTk: importRunId }),
    );
    const adapterName = text(run.adapterName);
    if (
      run.status !== 'success' ||
      !adapterName ||
      !['sellerboard-api', 'sellerboard-history-csv'].includes(adapterName)
    ) {
      throw this.bootstrapMismatch('successful Sellerboard import-run selection', {
        importRunId,
        status: run.status ?? null,
        adapterName: adapterName ?? null,
      });
    }
    const sourceConnectionId = text(run.sourceConnectionId);
    const source = sourceConnectionId
      ? toPlainRecord(
          await this.db
            .getRepository(ECOBASE_COLLECTIONS.sourceConnections)
            .findOne({ filterByTk: sourceConnectionId }),
        )
      : {};
    const companyId = text(source.companyId);
    const sourceAsOfDate = text(run.sourceVersion)?.slice(0, 10) ?? '';
    if (!sourceConnectionId || !companyId || !/^\d{4}-\d{2}-\d{2}$/.test(sourceAsOfDate)) {
      throw this.bootstrapMismatch('complete import-run scope', {
        importRunId,
        sourceConnectionId: sourceConnectionId ?? null,
        companyId: companyId ?? null,
        sourceAsOfDate: sourceAsOfDate || null,
      });
    }
    const plan = await this.planImportEvidence({
      adapterName,
      companyId,
      importRunId,
      sourceAsOfDate,
      sourceConnectionId,
      sourceVersion: text(run.sourceVersion) ?? sourceAsOfDate,
      snapshot,
    });
    if (plan === 'account_scope_unproven' || !plan.intervals.length) {
      throw this.bootstrapMismatch('unambiguous non-empty import evidence', {
        importRunId,
        reason: plan === 'account_scope_unproven' ? plan : 'source_evidence_empty',
      });
    }
    return plan;
  }

  private validateBootstrapPlan(plan: CoverageEvidencePlan) {
    const intervalKeys = new Set<string>();
    for (const interval of plan.intervals) {
      if (intervalKeys.has(interval.naturalKey)) {
        throw this.bootstrapMismatch('unique interval natural keys', { duplicate: interval.naturalKey });
      }
      intervalKeys.add(interval.naturalKey);
      this.intervalValues(interval);
    }
    const membershipKeys = new Set<string>();
    for (const membership of plan.memberships) {
      if (!intervalKeys.has(membership.intervalNaturalKey)) {
        throw this.bootstrapMismatch('membership interval reference', {
          intervalNaturalKey: membership.intervalNaturalKey,
        });
      }
      const naturalKey = `${membership.intervalNaturalKey}\u0000${membership.companyProductId}\u0000${membership.monthStart}`;
      if (membershipKeys.has(naturalKey)) {
        throw this.bootstrapMismatch('unique membership natural keys', { duplicate: naturalKey });
      }
      membershipKeys.add(naturalKey);
      this.membershipValues(membership, naturalKey, membership.intervalNaturalKey);
    }
  }

  private async summarizeBootstrapPlan(plan: CoverageEvidencePlan): Promise<FrozenCoverageBootstrapSummary> {
    const companyProducts = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ limit: 100000 })
    ).map(toPlainRecord);
    const historyIntervals = plan.intervals.filter(
      (interval) => toPlainRecord(interval.evidenceJson).adapterName === 'sellerboard-history-csv',
    );
    const currentIntervals = plan.intervals.filter(
      (interval) => toPlainRecord(interval.evidenceJson).adapterName === 'sellerboard-api',
    );
    const intervalByNaturalKey = new Map(plan.intervals.map((interval) => [interval.naturalKey, interval]));
    const historyByAccountMonth = new Map(
      historyIntervals.map((interval) => [`${interval.amazonAccountId}\u0000${interval.coveredStartDate}`, interval]),
    );
    const historyMemberships = plan.memberships.filter(
      (membership) =>
        toPlainRecord(intervalByNaturalKey.get(membership.intervalNaturalKey)?.evidenceJson).adapterName ===
        'sellerboard-history-csv',
    );
    const currentMemberships = plan.memberships.filter(
      (membership) =>
        toPlainRecord(intervalByNaturalKey.get(membership.intervalNaturalKey)?.evidenceJson).adapterName ===
        'sellerboard-api',
    );
    const historyMembershipByProductMonth = new Map(
      historyMemberships.map((membership) => [
        `${membership.companyProductId}\u0000${membership.monthStart}`,
        membership,
      ]),
    );
    const eligibleMonthsByProduct = new Map<string, number>();
    let eligibleCompleteCount = 0;
    let productScopeUnknownCount = 0;
    let coverageDiscontinuousCount = 0;
    let metricNormalizationMismatchCount = 0;
    const baselineMonths = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];
    for (const companyProduct of companyProducts) {
      const companyProductId = String(companyProduct.id);
      let eligibleMonths = 0;
      for (const monthStart of baselineMonths) {
        const interval = historyByAccountMonth.get(`${companyProduct.amazonAccountId}\u0000${monthStart}`);
        if (!interval || !interval.continuousCoverage) {
          coverageDiscontinuousCount += 1;
          continue;
        }
        const membership = historyMembershipByProductMonth.get(`${companyProductId}\u0000${monthStart}`);
        if (!membership) {
          productScopeUnknownCount += 1;
          continue;
        }
        if (membership.metricReconciliationStatus !== 'complete') {
          metricNormalizationMismatchCount += 1;
          continue;
        }
        eligibleCompleteCount += 1;
        eligibleMonths += 1;
      }
      eligibleMonthsByProduct.set(companyProductId, eligibleMonths);
    }
    const confidenceCounts = { full: 0, moderate: 0, low: 0, none: 0 };
    for (const eligibleMonths of eligibleMonthsByProduct.values()) {
      if (eligibleMonths === 6) confidenceCounts.full += 1;
      else if (eligibleMonths >= 3) confidenceCounts.moderate += 1;
      else if (eligibleMonths >= 1) confidenceCounts.low += 1;
      else confidenceCounts.none += 1;
    }
    const currentIntervalByNaturalKey = new Map(currentIntervals.map((interval) => [interval.naturalKey, interval]));
    const currentMetricMismatches = currentMemberships.filter(
      (membership) => membership.metricReconciliationStatus !== 'complete',
    );
    return {
      history: {
        intervalCount: historyIntervals.length,
        continuousIntervalCount: historyIntervals.filter((interval) => interval.continuousCoverage).length,
        discontinuousIntervalCount: historyIntervals.filter((interval) => !interval.continuousCoverage).length,
        membershipCount: historyMemberships.length,
      },
      baseline: {
        listingCount: companyProducts.length,
        productMonthCount: companyProducts.length * baselineMonths.length,
        eligibleCompleteCount,
        productScopeUnknownCount,
        coverageDiscontinuousCount,
        metricNormalizationMismatchCount,
        confidenceCounts,
      },
      current: {
        intervalCount: currentIntervals.length,
        continuousIntervalCount: currentIntervals.filter((interval) => interval.continuousCoverage).length,
        incompleteIntervalCount: currentIntervals.filter((interval) => !interval.continuousCoverage).length,
        membershipCount: currentMemberships.length,
        metricNormalizationMismatchCount: currentMetricMismatches.length,
        completeScopeMetricNormalizationMismatchCount: currentMetricMismatches.filter(
          (membership) => currentIntervalByNaturalKey.get(membership.intervalNaturalKey)?.continuousCoverage,
        ).length,
      },
      predictedLedgerWriteCount: plan.intervals.length + plan.memberships.length,
      predictedProtectedDomainMutationCount: 0,
    };
  }

  private bootstrapMismatch(gate: string, details: Record<string, unknown>) {
    return new EcobaseCoverageError(
      'ECOBASE_COVERAGE_BOOTSTRAP_DIGEST_MISMATCH',
      `EcoBase source coverage bootstrap blocked: ${gate} does not match the approved frozen evidence.`,
      { gate, ...details },
    );
  }

  private async loadOrderedProjectionRows(
    collection: string,
    options: { filter?: PlainRecord; transaction?: unknown } = {},
  ) {
    const repository = this.db.getRepository(collection);
    const rows: PlainRecord[] = [];
    let cursor: string | undefined;
    let pageLength = COVERAGE_PROJECTION_PAGE_SIZE;
    while (pageLength === COVERAGE_PROJECTION_PAGE_SIZE) {
      const filter = cursor ? { ...(options.filter ?? {}), id: { $gt: cursor } } : options.filter;
      const page = (
        await repository.find({
          filter,
          sort: ['id'],
          limit: COVERAGE_PROJECTION_PAGE_SIZE,
          transaction: options.transaction,
        })
      ).map(toPlainRecord);
      pageLength = page.length;
      let previous = cursor;
      for (const row of page) {
        const id = text(row.id);
        if (!id || (previous && id.localeCompare(previous) <= 0)) {
          throw new EcobaseCoverageError(
            'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
            `EcoBase source coverage projection requires strictly ordered, non-empty IDs while reading ${collection}.`,
            { collection, previousId: previous ?? null, receivedId: id ?? null },
          );
        }
        rows.push(row);
        previous = id;
      }
      cursor = previous;
    }
    return rows;
  }

  private async loadCoverageProjection(
    importRunIds: string[],
    transaction?: unknown,
  ): Promise<CoverageProjectionSnapshot> {
    const selectedRunIds = [...new Set(importRunIds)].sort();
    if (!selectedRunIds.length) {
      throw new EcobaseCoverageError(
        'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
        'EcoBase source coverage projection requires at least one selected import run.',
        { importRunIds },
      );
    }
    const [accounts, products, companyProducts, facts] = await Promise.all([
      this.loadOrderedProjectionRows(ECOBASE_COLLECTIONS.silverAmazonAccounts, { transaction }),
      this.loadOrderedProjectionRows(ECOBASE_COLLECTIONS.silverProducts, { transaction }),
      this.loadOrderedProjectionRows(ECOBASE_COLLECTIONS.silverCompanyProducts, { transaction }),
      this.loadOrderedProjectionRows(ECOBASE_COLLECTIONS.silverListingDailyFacts, { transaction }),
    ]);
    const bronzeRows: PlainRecord[] = [];
    const links: PlainRecord[] = [];
    for (const importRunId of selectedRunIds) {
      bronzeRows.push(
        ...(await this.loadOrderedProjectionRows(ECOBASE_COLLECTIONS.bronzeSourceRecords, {
          filter: { importRunId },
          transaction,
        })),
      );
      links.push(
        ...(await this.loadOrderedProjectionRows(ECOBASE_COLLECTIONS.silverNormalizationLinks, {
          filter: { importRunId, silverEntityType: 'silverListingDailyFact' },
          transaction,
        })),
      );
    }
    return { accounts, bronzeRows, products, companyProducts, links, facts };
  }

  private async planImportEvidence(params: {
    adapterName: string;
    companyId: string;
    importRunId: string;
    sourceAsOfDate: string;
    sourceConnectionId: string;
    sourceVersion: string;
    transaction?: unknown;
    snapshot?: CoverageProjectionSnapshot;
  }): Promise<CoverageEvidencePlan | 'account_scope_unproven'> {
    const { accounts, bronzeRows, products, companyProducts, links, facts } =
      params.snapshot ?? (await this.loadCoverageProjection([params.importRunId], params.transaction));
    const companyAccounts = accounts.filter((account) => account.companyId === params.companyId);
    if (!companyAccounts.length) return 'account_scope_unproven';
    const accountsByKey = new Map<string, PlainRecord[]>();
    for (const account of companyAccounts) {
      const key = accountKey(params.companyId, account.marketplace);
      if (key) accountsByKey.set(key, [...(accountsByKey.get(key) ?? []), account]);
    }
    if ([...accountsByKey.values()].some((matches) => matches.length !== 1)) return 'account_scope_unproven';

    const productByIdentity = new Map<string, PlainRecord>(
      products
        .map((product): [string | undefined, PlainRecord] => [identityKey(product.asin, product.sku), product])
        .filter((entry): entry is [string, PlainRecord] => Boolean(entry[0])),
    );
    const companyProductByAccountProduct = new Map(
      companyProducts
        .filter((companyProduct) => companyProduct.companyId === params.companyId)
        .map((companyProduct) => [
          `${companyProduct.amazonAccountId}\u0000${companyProduct.productId}`,
          companyProduct,
        ]),
    );
    const companyProductById = new Map(
      companyProducts.map((companyProduct) => [String(companyProduct.id), companyProduct]),
    );
    const productById = new Map(products.map((product) => [String(product.id), product]));
    const factById = new Map(facts.map((fact) => [String(fact.id), fact]));
    const linksByBronze = new Map<string, PlainRecord[]>();
    for (const link of links.filter((item) => item.importRunId === params.importRunId)) {
      const bronzeRecordId = text(link.bronzeRecordId);
      if (bronzeRecordId) linksByBronze.set(bronzeRecordId, [...(linksByBronze.get(bronzeRecordId) ?? []), link]);
    }
    const runRows = bronzeRows.filter((row) => row.importRunId === params.importRunId);
    if (!runRows.length) return { intervals: [], memberships: [] };

    const currentMonth = monthStartFor(params.sourceAsOfDate);
    const reportDateEvidence = sellerboardReportDateEvidence(runRows, params.adapterName as SellerboardCoverageAdapter);
    const intervalRows = new Map<string, PlainRecord[]>();
    const evidenceDateByRowId = new Map<string, string>();
    const membershipEvidence = new Map<
      string,
      {
        account: PlainRecord;
        companyProductId: string;
        monthStart: string;
        metricRows: PlainRecord[];
        stockRows: PlainRecord[];
        metricLinks: PlainRecord[];
        reconciled: boolean;
      }
    >();
    let accountAmbiguity = false;

    const catalogCompanyProduct = (account: PlainRecord, payload: PlainRecord) => {
      const product = productByIdentity.get(identityKey(payload.asin, payload.listingSku));
      return product ? companyProductByAccountProduct.get(`${account.id}\u0000${product.id}`) : undefined;
    };
    const targetMonth = (period: string) => {
      const monthStart = monthStartFor(period);
      return params.adapterName === 'sellerboard-api'
        ? monthStart === currentMonth
          ? monthStart
          : undefined
        : monthStart < currentMonth
          ? monthStart
          : undefined;
    };

    for (const row of runRows) {
      const kind = reportKind(row, params.adapterName as SellerboardCoverageAdapter);
      if (!kind) continue;
      const payload = toPlainRecord(row.payload);
      const marketplace = text(payload.marketplace);
      let metricLinks: PlainRecord[] = [];
      let linkedFact: PlainRecord | undefined;
      if (kind === 'profit_by_product_daily') {
        metricLinks = (linksByBronze.get(String(row.id)) ?? []).filter(
          (link) => link.silverEntityType === 'silverListingDailyFact',
        );
        linkedFact = metricLinks.length === 1 ? factById.get(String(metricLinks[0].silverEntityId)) : undefined;
      }
      const linkedFactDate = canonicalStoredDate(linkedFact?.snapshotDate);
      const period = coverageEvidenceDate({
        kind,
        sourceAsOfDate: params.sourceAsOfDate,
        rawPeriod: payload.period,
        reportDateEvidence,
        linkedFactDate,
      });
      const monthStart = period ? targetMonth(period) : undefined;
      if (!marketplace || !period || !monthStart) continue;
      const accountMatches = accountsByKey.get(accountKey(params.companyId, marketplace) ?? '') ?? [];
      if (!accountMatches.length) {
        if (marketplace.toLowerCase().startsWith('amazon.')) accountAmbiguity = true;
        continue;
      }
      if (accountMatches.length !== 1) {
        accountAmbiguity = true;
        continue;
      }
      const account = accountMatches[0];
      const intervalKey = `${account.id}\u0000${monthStart}`;
      intervalRows.set(intervalKey, [...(intervalRows.get(intervalKey) ?? []), row]);
      evidenceDateByRowId.set(String(row.id), period);
      const sourceIdentity = identityKey(payload.asin, payload.listingSku);
      if (!sourceIdentity) continue;

      const companyProduct = catalogCompanyProduct(account, payload);
      let reconciled = kind === 'stock_daily';
      if (kind === 'profit_by_product_daily') {
        const linkedCompanyProduct = linkedFact
          ? companyProductById.get(String(linkedFact.companyProductId))
          : undefined;
        const linkedProduct = linkedCompanyProduct
          ? productById.get(String(linkedCompanyProduct.productId))
          : undefined;
        reconciled = Boolean(
          linkedFact &&
            companyProduct &&
            linkedCompanyProduct &&
            linkedCompanyProduct.id === companyProduct.id &&
            linkedCompanyProduct.amazonAccountId === account.id &&
            identityKey(linkedProduct?.asin, linkedProduct?.sku) === sourceIdentity &&
            linkedFactDate === period &&
            metricLinks[0].sourceRowHash === row.rowHash &&
            sameNumber(sourceUnits(payload), linkedFact.units) &&
            sameNumber(payload.netProfit, linkedFact.profit),
        );
      }
      const companyProductId = text(companyProduct?.id);
      if (!companyProductId) continue;
      const membershipKey = `${account.id}\u0000${companyProductId}\u0000${monthStart}`;
      const evidence = membershipEvidence.get(membershipKey) ?? {
        account,
        companyProductId,
        monthStart,
        metricRows: [],
        stockRows: [],
        metricLinks: [],
        reconciled: true,
      };
      if (kind === 'profit_by_product_daily') {
        evidence.metricRows.push(row);
        evidence.metricLinks.push(...metricLinks);
        evidence.reconciled = evidence.reconciled && reconciled;
      } else {
        evidence.stockRows.push(row);
      }
      membershipEvidence.set(membershipKey, evidence);
    }
    if (accountAmbiguity) return 'account_scope_unproven';

    if (params.adapterName === 'sellerboard-api' && intervalRows.size > 0) {
      for (const account of companyAccounts) {
        const intervalKey = `${account.id}\u0000${currentMonth}`;
        if (!intervalRows.has(intervalKey)) intervalRows.set(intervalKey, []);
      }
    }

    const membershipsByInterval = new Map<string, CoverageMembershipEvidence[]>();
    for (const evidence of membershipEvidence.values()) {
      const intervalNaturalKey = this.intervalNaturalKey(params, String(evidence.account.id), evidence.monthStart);
      const intervalRowsForScope = intervalRows.get(`${evidence.account.id}\u0000${evidence.monthStart}`) ?? [];
      const coveredEndDate =
        params.adapterName === 'sellerboard-api' ? params.sourceAsOfDate : monthEndFor(evidence.monthStart);
      const observedDates = new Set(
        intervalRowsForScope
          .map((row) => evidenceDateByRowId.get(String(row.id)))
          .filter((value): value is string => Boolean(value)),
      );
      const requiredDates = completeDateRange(evidence.monthStart, coveredEndDate);
      const intervalContinuous = requiredDates.every((date) => observedDates.has(date));
      const kinds = [
        ...(evidence.metricRows.length ? (['profit_by_product_daily'] as const) : []),
        ...(evidence.stockRows.length ? (['stock_daily'] as const) : []),
      ];
      const metricComplete = evidence.metricRows.length
        ? evidence.reconciled && evidence.metricLinks.length === evidence.metricRows.length
        : intervalContinuous;
      const membership: CoverageMembershipEvidence = {
        intervalNaturalKey,
        companyProductId: evidence.companyProductId,
        monthStart: evidence.monthStart,
        scopeEvidenceKinds: kinds,
        scopeEvidenceDigest: bronzePayloadHash(
          [...evidence.metricRows, ...evidence.stockRows]
            .map((row) => ({ id: row.id, rowHash: row.rowHash, sourceRecordKey: row.sourceRecordKey }))
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
        ),
        sourceMetricRowCount: evidence.metricRows.length,
        normalizedFactLinkCount: evidence.metricLinks.length,
        metricReconciliationStatus: metricComplete ? 'complete' : 'incomplete',
        metricEvidenceDigest: bronzePayloadHash({
          sourceRows: evidence.metricRows
            .map((row) => ({ id: row.id, rowHash: row.rowHash }))
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
          links: evidence.metricLinks
            .map((link) => ({ id: link.id, silverEntityId: link.silverEntityId, sourceRowHash: link.sourceRowHash }))
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
          reconciled: metricComplete,
        }),
      };
      membershipsByInterval.set(intervalNaturalKey, [
        ...(membershipsByInterval.get(intervalNaturalKey) ?? []),
        membership,
      ]);
    }

    const intervals: CoverageIntervalEvidence[] = [];
    for (const [key, rows] of intervalRows) {
      const [amazonAccountId, monthStart] = key.split('\u0000');
      const account = companyAccounts.find((item) => String(item.id) === amazonAccountId);
      if (!account) return 'account_scope_unproven';
      const coveredEndDate = params.adapterName === 'sellerboard-api' ? params.sourceAsOfDate : monthEndFor(monthStart);
      const observedDates = [
        ...new Set(
          rows
            .filter(
              (row) => reportKind(row, params.adapterName as SellerboardCoverageAdapter) === 'profit_by_product_daily',
            )
            .map((row) => evidenceDateByRowId.get(String(row.id)))
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort();
      const requiredDates = completeDateRange(monthStart, coveredEndDate);
      const intervalNaturalKey = this.intervalNaturalKey(params, amazonAccountId, monthStart);
      const memberships = (membershipsByInterval.get(intervalNaturalKey) ?? []).sort((left, right) =>
        left.companyProductId.localeCompare(right.companyProductId),
      );
      intervals.push({
        naturalKey: intervalNaturalKey,
        sourceConnectionId: params.sourceConnectionId,
        companyId: params.companyId,
        amazonAccountId,
        marketplace: String(account.marketplace),
        coveredStartDate: monthStart,
        coveredEndDate,
        continuousCoverage: requiredDates.every((date) => observedDates.includes(date)),
        sourceAsOfDate: params.sourceAsOfDate,
        sourceVersion: params.sourceVersion,
        importRunId: params.importRunId,
        inputDigest: bronzePayloadHash(
          rows
            .map((row) => ({ id: row.id, rowHash: row.rowHash, sourceRecordKey: row.sourceRecordKey }))
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
        ),
        scopeDigest: bronzePayloadHash(
          memberships.map((membership) => ({
            companyProductId: membership.companyProductId,
            scopeEvidenceKinds: membership.scopeEvidenceKinds,
            scopeEvidenceDigest: membership.scopeEvidenceDigest,
          })),
        ),
        evidenceJson: {
          adapterName: params.adapterName,
          importRunId: params.importRunId,
          observedDateCount: observedDates.length,
          requiredDateCount: requiredDates.length,
        },
      });
    }
    return {
      intervals: intervals.sort((left, right) => left.naturalKey.localeCompare(right.naturalKey)),
      memberships: [...membershipsByInterval.values()]
        .flat()
        .sort((left, right) =>
          `${left.intervalNaturalKey}\u0000${left.companyProductId}`.localeCompare(
            `${right.intervalNaturalKey}\u0000${right.companyProductId}`,
          ),
        ),
    };
  }

  private intervalNaturalKey(
    params: { sourceConnectionId: string; sourceVersion: string },
    amazonAccountId: string,
    monthStart: string,
  ) {
    return [
      'coverage',
      params.sourceConnectionId,
      amazonAccountId,
      SELLERBOARD_COVERAGE_METRIC_SET,
      monthStart,
      params.sourceVersion,
    ].join(':');
  }

  private async reconcileEvidenceInTransaction(
    plan: CoverageEvidencePlan,
    transaction?: unknown,
  ): Promise<CoverageReconciliationResult> {
    const intervalRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageIntervals);
    const membershipRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceCoverageMemberships);
    const existingIntervals = (await intervalRepo.find({ limit: 100000, transaction })).map(toPlainRecord);
    const existingIntervalByNaturalKey = new Map(
      existingIntervals.map((interval) => [String(interval.naturalKey), interval]),
    );
    const intervalIds = new Map<string, string>();
    const staleSkippedIntervalKeys = new Set<string>();
    const coverageSkippedStale: CoverageSkippedStale[] = [];
    let intervalCreatedCount = 0;
    let membershipCreatedCount = 0;
    let supersededIntervalCount = 0;
    let idempotentIntervalCount = 0;
    let idempotentMembershipCount = 0;

    const duplicateIntervalKeys = new Set<string>();
    for (const interval of plan.intervals) {
      if (duplicateIntervalKeys.has(interval.naturalKey)) {
        throw this.conflict(interval.naturalKey, 'plan contains duplicate interval natural keys');
      }
      duplicateIntervalKeys.add(interval.naturalKey);
      const values = this.intervalValues(interval);
      const sameKey = existingIntervalByNaturalKey.get(String(values.naturalKey));
      if (sameKey) {
        if (bronzePayloadHash(intervalProjection(sameKey)) !== bronzePayloadHash(intervalProjection(values))) {
          throw this.conflict(interval.naturalKey, 'the same natural key has different evidence digests or scope');
        }
        intervalIds.set(interval.naturalKey, String(sameKey.id));
        idempotentIntervalCount += 1;
        continue;
      }

      const activeOverlaps = existingIntervals
        .filter((item) => item.coverageStatus === 'active' && sameIntervalScope(item, values) && overlaps(item, values))
        .sort((left, right) => sourceOrder(right).localeCompare(sourceOrder(left)));
      if (activeOverlaps.length > 1) {
        throw this.conflict(interval.naturalKey, 'overlap would branch an active coverage lineage');
      }
      const predecessor = activeOverlaps[0];
      if (predecessor && String(values.sourceAsOfDate) <= String(predecessor.sourceAsOfDate)) {
        const fullyWithinPredecessor =
          String(predecessor.coveredStartDate) <= String(values.coveredStartDate) &&
          String(values.coveredEndDate) <= String(predecessor.coveredEndDate);
        if (fullyWithinPredecessor) {
          // Stale re-serve: the incoming window is already owned by an equal-or-newer active
          // interval. Do not regress the newer daily facts with older ones — write nothing for
          // this metric set, leave the held coverage untouched, and record a quiet note.
          staleSkippedIntervalKeys.add(interval.naturalKey);
          coverageSkippedStale.push({
            metricSet: String(values.metricSet),
            incomingAsOf: String(values.sourceAsOfDate),
            heldAsOf: String(predecessor.sourceAsOfDate),
            window: `${values.coveredStartDate}..${values.coveredEndDate}`,
          });
          continue;
        }
        throw this.conflict(interval.naturalKey, 'overlap is not owned by a strictly later source as-of date');
      }

      const created = toPlainRecord(
        await intervalRepo.create({
          values: {
            id: randomUUID(),
            ...values,
            coverageStatus: 'active',
            ...(predecessor ? { supersedesCoverageIntervalId: predecessor.id } : {}),
          },
          transaction,
        }),
      );
      existingIntervals.push(created);
      existingIntervalByNaturalKey.set(interval.naturalKey, created);
      intervalIds.set(interval.naturalKey, String(created.id));
      intervalCreatedCount += 1;
      if (
        predecessor &&
        String(values.coveredStartDate) <= String(predecessor.coveredStartDate) &&
        String(values.coveredEndDate) >= String(predecessor.coveredEndDate)
      ) {
        await intervalRepo.update({
          filterByTk: predecessor.id as string | number,
          values: { coverageStatus: 'superseded' },
          transaction,
        });
        predecessor.coverageStatus = 'superseded';
        supersededIntervalCount += 1;
      }
    }

    const existingMemberships = (await membershipRepo.find({ limit: 100000, transaction })).map(toPlainRecord);
    const existingMembershipByNaturalKey = new Map(
      existingMemberships.map((membership) => [String(membership.naturalKey), membership]),
    );
    const duplicateMembershipKeys = new Set<string>();
    for (const membership of plan.memberships) {
      // Memberships that belong to a stale-skipped interval are dropped alongside it.
      if (staleSkippedIntervalKeys.has(membership.intervalNaturalKey)) continue;
      const coverageIntervalId = intervalIds.get(membership.intervalNaturalKey);
      if (!coverageIntervalId) {
        throw new EcobaseCoverageError(
          'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
          `EcoBase coverage membership references unknown interval "${membership.intervalNaturalKey}".`,
          { intervalNaturalKey: membership.intervalNaturalKey },
        );
      }
      const naturalKey = `membership:${membership.intervalNaturalKey}:${membership.companyProductId}:${membership.monthStart}`;
      if (duplicateMembershipKeys.has(naturalKey)) {
        throw this.conflict(naturalKey, 'plan contains duplicate membership natural keys');
      }
      duplicateMembershipKeys.add(naturalKey);
      const values = this.membershipValues(membership, naturalKey, coverageIntervalId);
      const existing = existingMembershipByNaturalKey.get(naturalKey);
      if (existing) {
        if (bronzePayloadHash(membershipProjection(existing)) !== bronzePayloadHash(membershipProjection(values))) {
          throw this.conflict(naturalKey, 'the same membership natural key has different evidence');
        }
        idempotentMembershipCount += 1;
        continue;
      }
      const created = toPlainRecord(
        await membershipRepo.create({ values: { id: randomUUID(), ...values }, transaction }),
      );
      existingMemberships.push(created);
      existingMembershipByNaturalKey.set(naturalKey, created);
      membershipCreatedCount += 1;
    }

    return {
      intervalCreatedCount,
      membershipCreatedCount,
      supersededIntervalCount,
      idempotentIntervalCount,
      idempotentMembershipCount,
      coverageSkippedStale,
      noOp: intervalCreatedCount === 0 && membershipCreatedCount === 0 && supersededIntervalCount === 0,
    };
  }

  private intervalValues(interval: CoverageIntervalEvidence): PlainRecord {
    const coveredStartDate = isoDate(dateOnly(interval.coveredStartDate, 'coveredStartDate'));
    const coveredEndDate = isoDate(dateOnly(interval.coveredEndDate, 'coveredEndDate'));
    if (coveredStartDate > coveredEndDate) {
      throw new EcobaseCoverageError(
        'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
        'EcoBase source coverage start date must not be after its end date.',
        { coveredStartDate, coveredEndDate },
      );
    }
    return {
      naturalKey: nonEmpty(interval.naturalKey, 'naturalKey'),
      sourceConnectionId: nonEmpty(interval.sourceConnectionId, 'sourceConnectionId'),
      companyId: nonEmpty(interval.companyId, 'companyId'),
      amazonAccountId: nonEmpty(interval.amazonAccountId, 'amazonAccountId'),
      marketplace: nonEmpty(interval.marketplace, 'marketplace'),
      metricSet: SELLERBOARD_COVERAGE_METRIC_SET,
      coveredStartDate,
      coveredEndDate,
      continuousCoverage: interval.continuousCoverage,
      sourceAsOfDate: isoDate(dateOnly(interval.sourceAsOfDate, 'sourceAsOfDate')),
      sourceVersion: nonEmpty(interval.sourceVersion, 'sourceVersion'),
      importRunId: nonEmpty(interval.importRunId, 'importRunId'),
      inputDigest: digest(interval.inputDigest, 'inputDigest'),
      scopeDigest: digest(interval.scopeDigest, 'scopeDigest'),
      productScopeEvidenceVersion: SELLERBOARD_SCOPE_EVIDENCE_VERSION,
      evidenceJson: interval.evidenceJson,
    };
  }

  private membershipValues(
    membership: CoverageMembershipEvidence,
    naturalKey: string,
    coverageIntervalId: string,
  ): PlainRecord {
    const scopeEvidenceKinds = [...new Set(membership.scopeEvidenceKinds)].sort();
    if (
      !scopeEvidenceKinds.length ||
      scopeEvidenceKinds.some((kind) => !['profit_by_product_daily', 'stock_daily'].includes(kind))
    ) {
      throw new EcobaseCoverageError(
        'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
        'EcoBase coverage membership requires supported product-scope evidence.',
        { scopeEvidenceKinds },
      );
    }
    if (
      !Number.isInteger(membership.sourceMetricRowCount) ||
      membership.sourceMetricRowCount < 0 ||
      !Number.isInteger(membership.normalizedFactLinkCount) ||
      membership.normalizedFactLinkCount < 0
    ) {
      throw new EcobaseCoverageError(
        'ECOBASE_COVERAGE_SCOPE_UNPROVEN',
        'EcoBase coverage membership row/link counts must be non-negative integers.',
      );
    }
    return {
      naturalKey,
      coverageIntervalId,
      companyProductId: nonEmpty(membership.companyProductId, 'companyProductId'),
      monthStart: isoDate(dateOnly(membership.monthStart, 'monthStart')),
      membershipStatus: 'in_scope',
      scopeEvidenceKinds,
      scopeEvidenceDigest: digest(membership.scopeEvidenceDigest, 'scopeEvidenceDigest'),
      sourceMetricRowCount: membership.sourceMetricRowCount,
      normalizedFactLinkCount: membership.normalizedFactLinkCount,
      metricReconciliationStatus: membership.metricReconciliationStatus,
      metricEvidenceDigest: digest(membership.metricEvidenceDigest, 'metricEvidenceDigest'),
    };
  }

  private conflict(naturalKey: string, reason: string) {
    return new EcobaseCoverageError(
      'ECOBASE_COVERAGE_CONFLICT',
      `EcoBase source coverage conflicts for "${naturalKey}": ${reason}.`,
      { naturalKey, reason },
    );
  }

  private result(
    reasonCode: CoverageMonthReason,
    intervals: PlainRecord[] = [],
    memberships: PlainRecord[] = [],
  ): CoverageProductMonthResult {
    const eligible = reasonCode === 'eligible_complete_month';
    return {
      eligible,
      reasonCode,
      trustedZeroWhenNoFacts: eligible,
      intervalIds: intervals.map((interval) => String(interval.id)).sort(),
      membershipIds: memberships.map((membership) => String(membership.id)).sort(),
    };
  }
}
