import { ECOBASE_COLLECTIONS } from '../collections/names';

const ISO_DAY_SUFFIX = 'T00:00:00.000Z';

export const DATA_WARNING_CODES = {
  missingRequiredSource: 'missing_required_source',
  staleSuccessfulRun: 'stale_successful_run',
  failedLatestRun: 'failed_latest_run',
  incompleteImport: 'incomplete_import',
  credentialBlocked: 'credential_blocked',
  noNewerDataSkipped: 'no_newer_data_skipped',
  unmappedListing: 'unmapped_listing',
  missingLeadTime: 'missing_lead_time',
  missingTarget: 'missing_target',
  missingVelocity: 'missing_velocity',
} as const;

export type EcobaseDataWarningCode = (typeof DATA_WARNING_CODES)[keyof typeof DATA_WARNING_CODES];

type Filter = Record<string, unknown>;
type PlainRecord = Record<string, unknown>;

type RepositoryFindParams = {
  filter?: Filter;
  filterByTk?: string;
  sort?: string[];
  limit?: number;
};

type EcobaseRepository = {
  find(params?: RepositoryFindParams): Promise<unknown[]>;
  findOne(params?: RepositoryFindParams): Promise<unknown | null>;
};

type EcobaseDatabase = {
  getRepository(name: string): EcobaseRepository;
};

export interface EcobaseDataWarning {
  code: EcobaseDataWarningCode;
  message: string;
  severity: 'warning';
  observedAt: string;
  sourceConnectionId?: string;
  sourceType?: string;
  domain?: string;
  companyId?: string;
  company?: string;
  canonicalAsin?: string;
  planningProductId?: string;
  planningProductListingId?: string;
  rawListingNaturalKey?: string;
  accountKey?: string;
  importRunId?: string;
  latestSuccessfulImportRunId?: string;
  metadata: PlainRecord;
}

export interface SourceWarningAssessment {
  sourceConnectionId: string;
  required: boolean;
  freshnessSlaMinutes: number | null;
  latestSuccessfulRunAt: string | null;
  warnings: EcobaseDataWarning[];
  latestWarning: EcobaseDataWarning | null;
}

export interface PlanningWarningAssessmentParams {
  planningProductId: string;
  calculationDate: string;
  product: PlainRecord;
  planningProductListings: PlainRecord[];
  inventoryRows: PlainRecord[];
  factRows: PlainRecord[];
  parameterRows: PlainRecord[];
  targetRows: PlainRecord[];
  salesVelocity?: number;
  leadTimeDays?: number;
  monthlyTarget?: number;
}

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null;
}

function toPlainRecord(value: unknown): PlainRecord {
  if (isRecord(value) && typeof value.toJSON === 'function') {
    const json = value.toJSON();
    if (isRecord(json)) {
      return json;
    }
  }
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getConfig(record: unknown) {
  const config = toPlainRecord(record).config;
  return isRecord(config) ? config : {};
}

function getWarningPolicyConfig(record: unknown) {
  const warningPolicy = getConfig(record).warningPolicy;
  return isRecord(warningPolicy) ? warningPolicy : {};
}

function getDateString(record: unknown, key: string): string | null {
  const value = toPlainRecord(record)[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

function warningKey(warning: EcobaseDataWarning) {
  return [
    warning.code,
    warning.sourceConnectionId ?? '',
    warning.planningProductId ?? '',
    warning.planningProductListingId ?? '',
    warning.rawListingNaturalKey ?? '',
    warning.accountKey ?? '',
  ].join(':');
}

function sortWarnings(warnings: EcobaseDataWarning[]) {
  return [...warnings].sort((left, right) => {
    const observedAt = right.observedAt.localeCompare(left.observedAt);
    if (observedAt !== 0) {
      return observedAt;
    }
    return warningKey(left).localeCompare(warningKey(right));
  });
}

function sourceLabel(sourceConnection: unknown) {
  return asString(toPlainRecord(sourceConnection).name) ?? '(unnamed source)';
}

function sourceReferenceDate(date: Date | string) {
  return date instanceof Date ? date : new Date(`${date}${ISO_DAY_SUFFIX}`);
}

function minutesSince(referenceDate: Date, observedAt: string) {
  return Math.floor((referenceDate.getTime() - new Date(observedAt).getTime()) / 60_000);
}

function planningObservedAt(calculationDate: string) {
  return new Date(`${calculationDate}${ISO_DAY_SUFFIX}`).toISOString();
}

function productLabel(product: PlainRecord) {
  return asString(product.canonicalAsin) ?? asString(product.title) ?? '(unknown planning product)';
}

function monthlyPeriod(calculationDate: string) {
  return calculationDate.slice(0, 7);
}

function uniqueSourceConnectionIds(rows: PlainRecord[]) {
  return [
    ...new Set(rows.map((row) => asString(row.sourceConnectionId)).filter((value): value is string => Boolean(value))),
  ];
}

export class EcobaseDataWarningService {
  constructor(private db: EcobaseDatabase) {}

  async assessSourceConnection(
    sourceConnectionId: string,
    referenceDate: Date | string = new Date(),
    failIfMissing = true,
  ): Promise<SourceWarningAssessment> {
    const sourceConnectionRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const sourceConnection = await sourceConnectionRepo.findOne({ filterByTk: sourceConnectionId });

    if (!sourceConnection) {
      if (!failIfMissing) {
        return {
          sourceConnectionId,
          required: false,
          freshnessSlaMinutes: null,
          latestSuccessfulRunAt: null,
          warnings: [],
          latestWarning: null,
        };
      }
      throw new Error(`Ecobase data warning failed: source connection "${sourceConnectionId}" was not found.`);
    }

    const latestRun = await importRunRepo.findOne({ filter: { sourceConnectionId }, sort: ['-startedAt'] });
    const latestAccessBlock = await this.db.getRepository(ECOBASE_COLLECTIONS.sourceAccessAudits).findOne({
      filter: { sourceConnectionId, status: 'blocked' },
      sort: ['-checkedAt'],
    });
    const latestSuccessfulRun = await importRunRepo.findOne({
      filter: { sourceConnectionId, status: 'success' },
      sort: ['-finishedAt'],
    });
    const policy = await this.resolveSourcePolicy(sourceConnection);
    const warnings: EcobaseDataWarning[] = [];
    const latestRunPlain = toPlainRecord(latestRun);
    const latestSuccessPlain = toPlainRecord(latestSuccessfulRun);
    const latestRunStatus = asString(latestRunPlain.status);
    const latestRunAt = getDateString(latestRunPlain, 'finishedAt') ?? getDateString(latestRunPlain, 'startedAt');
    const latestSuccessfulRunAt =
      getDateString(latestSuccessPlain, 'finishedAt') ?? getDateString(latestSuccessPlain, 'startedAt');
    const latestSuccessfulImportRunId = asString(latestSuccessPlain.id);
    const reference = sourceReferenceDate(referenceDate);
    const warningContext = {
      sourceConnectionId,
      sourceType: asString(toPlainRecord(sourceConnection).sourceType),
      domain: asString(toPlainRecord(sourceConnection).domain),
      companyId: asString(toPlainRecord(sourceConnection).companyId),
    };

    if (policy.required && !latestSuccessfulRunAt) {
      warnings.push({
        code: DATA_WARNING_CODES.missingRequiredSource,
        message: `Required source "${sourceLabel(sourceConnection)}" has no successful import run.`,
        severity: 'warning',
        observedAt: reference.toISOString(),
        ...warningContext,
        metadata: { required: true },
      });
    }

    if (latestRunStatus === 'failed') {
      warnings.push({
        code: DATA_WARNING_CODES.failedLatestRun,
        message: `Latest import for source "${sourceLabel(sourceConnection)}" failed.`,
        severity: 'warning',
        observedAt: latestRunAt ?? reference.toISOString(),
        ...warningContext,
        importRunId: asString(latestRunPlain.id),
        latestSuccessfulImportRunId,
        metadata: {
          latestRunStatus,
          latestRunAt,
          errorMessage: asString(latestRunPlain.errorMessage),
        },
      });
    }

    if (latestRunStatus === 'partial') {
      warnings.push({
        code: DATA_WARNING_CODES.incompleteImport,
        message: `Latest import for source "${sourceLabel(sourceConnection)}" completed with partial normalization.`,
        severity: 'warning',
        observedAt: latestRunAt ?? reference.toISOString(),
        ...warningContext,
        importRunId: asString(latestRunPlain.id),
        latestSuccessfulImportRunId,
        metadata: {
          latestRunStatus,
          latestRunAt,
          normalizedCount: asNumber(latestRunPlain.normalizedCount),
          errorCount: asNumber(latestRunPlain.errorCount),
        },
      });
    }

    if (latestRunStatus === 'skipped') {
      warnings.push({
        code: DATA_WARNING_CODES.noNewerDataSkipped,
        message: `Latest scheduled import for source "${sourceLabel(sourceConnection)}" was skipped because no newer source data was available.`,
        severity: 'warning',
        observedAt: latestRunAt ?? reference.toISOString(),
        ...warningContext,
        importRunId: asString(latestRunPlain.id),
        latestSuccessfulImportRunId,
        metadata: {
          latestRunStatus,
          latestRunAt,
          sourceIdentifier: asString(latestRunPlain.sourceIdentifier),
          sourceVersion: asString(latestRunPlain.sourceVersion),
        },
      });
    }

    const accessBlock = toPlainRecord(latestAccessBlock);
    if (asString(accessBlock.status) === 'blocked') {
      warnings.push({
        code: DATA_WARNING_CODES.credentialBlocked,
        message: asString(accessBlock.message) ?? `Source "${sourceLabel(sourceConnection)}" is blocked by missing credentials.`,
        severity: 'warning',
        observedAt: getDateString(accessBlock, 'checkedAt') ?? reference.toISOString(),
        ...warningContext,
        metadata: {
          blockerCode: asString(accessBlock.blockerCode),
          adapterName: asString(accessBlock.adapterName),
        },
      });
    }

    if (typeof policy.freshnessSlaMinutes === 'number' && latestSuccessfulRunAt) {
      const ageMinutes = minutesSince(reference, latestSuccessfulRunAt);
      if (ageMinutes > policy.freshnessSlaMinutes) {
        warnings.push({
          code: DATA_WARNING_CODES.staleSuccessfulRun,
          message: `Latest successful import for source "${sourceLabel(sourceConnection)}" is stale.`,
          severity: 'warning',
          observedAt: reference.toISOString(),
          ...warningContext,
          latestSuccessfulImportRunId,
          metadata: {
            latestSuccessfulRunAt,
            freshnessSlaMinutes: policy.freshnessSlaMinutes,
            ageMinutes,
          },
        });
      }
    }

    const sorted = sortWarnings(warnings);
    return {
      sourceConnectionId,
      required: policy.required,
      freshnessSlaMinutes: policy.freshnessSlaMinutes ?? null,
      latestSuccessfulRunAt,
      warnings: sorted,
      latestWarning: sorted[0] ?? null,
    };
  }

  async listPlanningWarnings(params: PlanningWarningAssessmentParams) {
    const warnings: EcobaseDataWarning[] = [];
    const observedAt = planningObservedAt(params.calculationDate);
    const productCompany = asString(params.product.company);
    const canonicalAsin = asString(params.product.canonicalAsin);
    const sourceConnectionIds = new Set<string>([
      ...uniqueSourceConnectionIds(params.inventoryRows),
      ...uniqueSourceConnectionIds(params.factRows),
      ...uniqueSourceConnectionIds(params.parameterRows),
      ...uniqueSourceConnectionIds(params.targetRows),
      ...uniqueSourceConnectionIds(params.planningProductListings),
    ]);

    for (const sourceConnectionId of sourceConnectionIds) {
      const sourceWarnings = await this.assessSourceConnection(sourceConnectionId, params.calculationDate, false);
      warnings.push(
        ...sourceWarnings.warnings.map((warning) => ({
          ...warning,
          planningProductId: params.planningProductId,
          company: productCompany ?? warning.company,
          canonicalAsin: canonicalAsin ?? warning.canonicalAsin,
        })),
      );
    }

    const listingsNeedingReview = params.planningProductListings.filter(
      (listing) => (asString(listing.mappingStatus) ?? 'auto_mapped') !== 'confirmed',
    );
    if (listingsNeedingReview.length > 0) {
      for (const listing of listingsNeedingReview) {
        warnings.push({
          code: DATA_WARNING_CODES.unmappedListing,
          message: `Planning product "${productLabel(
            params.product,
          )}" has a listing that still needs mapping confirmation.`,
          severity: 'warning',
          observedAt,
          planningProductId: params.planningProductId,
          planningProductListingId: asString(listing.id),
          sourceConnectionId: asString(listing.sourceConnectionId),
          rawListingNaturalKey: asString(listing.rawListingNaturalKey),
          company: productCompany,
          canonicalAsin,
          metadata: {
            mappingStatus: asString(listing.mappingStatus) ?? 'auto_mapped',
            mappingMode: asString(listing.mappingMode) ?? 'default',
          },
        });
      }
    } else if ((asString(params.product.mappingStatus) ?? 'auto_mapped') !== 'confirmed') {
      warnings.push({
        code: DATA_WARNING_CODES.unmappedListing,
        message: `Planning product "${productLabel(params.product)}" still needs mapping confirmation.`,
        severity: 'warning',
        observedAt,
        planningProductId: params.planningProductId,
        company: productCompany,
        canonicalAsin,
        metadata: { mappingStatus: asString(params.product.mappingStatus) ?? 'auto_mapped' },
      });
    }

    if (typeof params.leadTimeDays !== 'number') {
      const parameterRow = params.parameterRows[0] ?? {};
      warnings.push({
        code: DATA_WARNING_CODES.missingLeadTime,
        message: `Planning product "${productLabel(params.product)}" is missing lead time.`,
        severity: 'warning',
        observedAt,
        planningProductId: params.planningProductId,
        sourceConnectionId: asString(parameterRow.sourceConnectionId),
        company: productCompany,
        canonicalAsin,
        metadata: {
          supplierId: asString(parameterRow.supplierId),
          supplierName: asString(parameterRow.supplier),
          planningParameterCount: params.parameterRows.length,
        },
      });
    }

    if (typeof params.monthlyTarget !== 'number') {
      const targetRow = params.targetRows[0] ?? {};
      warnings.push({
        code: DATA_WARNING_CODES.missingTarget,
        message: `Planning product "${productLabel(
          params.product,
        )}" is missing a monthly profit target for ${monthlyPeriod(params.calculationDate)}.`,
        severity: 'warning',
        observedAt,
        planningProductId: params.planningProductId,
        sourceConnectionId: asString(targetRow.sourceConnectionId),
        accountKey: asString(targetRow.accountKey),
        company: productCompany,
        canonicalAsin,
        metadata: {
          month: monthlyPeriod(params.calculationDate),
          targetRowCount: params.targetRows.length,
        },
      });
    }

    if (typeof params.salesVelocity !== 'number' || params.salesVelocity <= 0) {
      warnings.push({
        code: DATA_WARNING_CODES.missingVelocity,
        message: `Planning product "${productLabel(params.product)}" is missing sales velocity.`,
        severity: 'warning',
        observedAt,
        planningProductId: params.planningProductId,
        company: productCompany,
        canonicalAsin,
        metadata: {
          factRowCount: params.factRows.length,
          inventoryRowCount: params.inventoryRows.length,
        },
      });
    }

    return sortWarnings(warnings);
  }

  private async resolveSourcePolicy(sourceConnection: unknown) {
    const sourceType = asString(toPlainRecord(sourceConnection).sourceType);
    const warningPolicy = getWarningPolicyConfig(sourceConnection);
    const sourceTypePolicyRepo = this.db.getRepository(ECOBASE_COLLECTIONS.sourceWarningPolicies);
    const sourceTypePolicy = sourceType
      ? toPlainRecord(await sourceTypePolicyRepo.findOne({ filter: { sourceType, active: true } }))
      : {};

    return {
      required: asBoolean(warningPolicy.required) ?? asBoolean(sourceTypePolicy.required) ?? false,
      freshnessSlaMinutes:
        asNumber(toPlainRecord(sourceConnection).freshnessSlaMinutes) ??
        asNumber(warningPolicy.freshnessSlaMinutes) ??
        asNumber(sourceTypePolicy.freshnessSlaMinutes),
    };
  }
}
