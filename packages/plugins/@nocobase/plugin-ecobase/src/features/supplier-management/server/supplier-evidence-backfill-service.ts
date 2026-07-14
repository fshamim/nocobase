/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import {
  normalizeExternalSupplierCode,
  normalizeSupplierName,
} from '../../semantic-model/server/medallion-identity-service';
import { parseCsv, type CsvSourceFile } from '../../source-import/server/adapters/csv-utils';
import { FOUR_COMPANY_MIGRATION_PROFILE } from '../../source-import/server/four-company-migration-profile';
import {
  findForbiddenSourceMaterial,
  projectSourceRecord,
  type MigrationDataset,
} from '../../source-import/server/source-record-projection';

const PREVIEW_VERSION = 'supplier-evidence-v2';
const CANONICAL_COMPANIES = new Set(FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.map((item) => item.name));
const REJECTED_REFS = new Set(
  FOUR_COMPANY_MIGRATION_PROFILE.supplierExternalRefDecisions
    .filter((item) => item.disposition === 'reject')
    .map((item) => item.externalRef),
);

type ProjectedRow = {
  payload: Record<string, unknown>;
  rowNumber: number;
};

type HistoricalEvidence = {
  familyId: string;
  company: string;
  supplierRef: string;
  sourceDate: string;
  sourceRowNumber: number;
  headerRowNumber: number;
  matchType: 'exact_member_sku' | 'unique_family_asin';
};

type HistoricalChoice = {
  company: string;
  supplierRef?: string;
  sourceDate: string;
  sourceRowNumber: number;
  headerRowNumber: number;
  matchType: HistoricalEvidence['matchType'];
  supplierCount: number;
};

export type SupplierEvidenceSelection = {
  familyId: string;
  companyId: string;
  supplierRef: string;
  source:
    | 'historical_order_evidence'
    | 'supplier_2026_approved_active'
    | 'supplier_2026_approved_unknown'
    | 'supplier_tracker_active_workflow';
  evidence: {
    ruleVersion: string;
    sourceFileName: string;
    sourceFileSha256: string;
    sourceRowNumber: number;
    headerRowNumber?: number;
    sourceObservedAt?: string;
    matchType: string;
    supplierExternalRef: string;
  };
};

export type SupplierEvidenceMaster = {
  displayName?: string;
  sourceFileName: string;
  sourceFileSha256: string;
  sourceRowNumber: number;
};

export type SupplierEvidenceSnapshot = {
  companies: Array<{ id: string; name: string }>;
  products: Array<{ id: string; asin?: string; sku?: string }>;
  companyProducts: Array<{
    id: string;
    companyId: string;
    amazonAccountId: string;
    productId: string;
    familyId?: string;
  }>;
  families: Array<{
    id: string;
    companyId: string;
    amazonAccountId: string;
    marketplace: string;
    asin: string;
    preferredSupplierId?: string;
    supplierSelectionSource?: string;
  }>;
  supplierExternalRefs?: Array<{
    supplierId: string;
    sourceSystem: string;
    normalizedExternalSupplierCode: string;
  }>;
};

export type SupplierEvidenceFiles = {
  supplierIds: CsvSourceFile;
  supplierTracker: CsvSourceFile;
  supplier2026: CsvSourceFile;
  purchaseOrders: CsvSourceFile;
  orderDetails: CsvSourceFile;
};

function text(value: unknown) {
  const result = String(value ?? '').trim();
  return result || undefined;
}

function operationalValue(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function normalizedOrderRef(value: unknown) {
  const result = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
  return result || undefined;
}

export function normalizeSupplierEvidenceRef(value: unknown) {
  const source = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!source) return undefined;
  const standard = source.replace(/\s+/g, '').match(/^(SRO|SR)[^0-9]*(\d+)$/);
  return standard ? `${standard[1]}-${standard[2]}` : source.replace(/\s+/g, ' ');
}

function normalizedAsin(value: unknown) {
  const result = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, '')
    .toUpperCase();
  return /^B[A-Z0-9]{9}$/.test(result) ? result : undefined;
}

function normalizedSku(value: unknown) {
  const result = String(value ?? '')
    .trim()
    .toLowerCase();
  return result || undefined;
}

function sourceDate(value: unknown) {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return undefined;
  const [, day, month, year, hour = '0', minute = '0', second = '0'] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return undefined;
  }
  return date.toISOString();
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts: Record<string, number>) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function projectedRows(dataset: MigrationDataset, file: CsvSourceFile) {
  const parsed = parseCsv(file.content);
  let droppedFieldCount = 0;
  const forbiddenPaths: string[] = [];
  const rows = parsed.rows.map((row, index): ProjectedRow => {
    const projection = projectSourceRecord(dataset, row);
    droppedFieldCount += projection.droppedFieldCount;
    forbiddenPaths.push(...findForbiddenSourceMaterial(projection.payload));
    return { payload: projection.payload, rowNumber: index + 2 };
  });
  return { rows, rowCount: parsed.rows.length, droppedFieldCount, forbiddenPaths };
}

function familyIndexes(snapshot: SupplierEvidenceSnapshot) {
  const companyById = new Map(snapshot.companies.map((company) => [company.id, company.name]));
  const productById = new Map(snapshot.products.map((product) => [product.id, product]));
  const familyById = new Map(snapshot.families.map((family) => [family.id, family]));
  const exact = new Map<string, Set<string>>();
  const byCompanyAsin = new Map<string, Set<string>>();
  const globalByAsin = new Map<string, Set<string>>();
  const add = (index: Map<string, Set<string>>, key: string, familyId: string) =>
    index.set(key, new Set([...(index.get(key) ?? []), familyId]));

  for (const family of snapshot.families) {
    const asin = normalizedAsin(family.asin);
    if (asin) add(globalByAsin, asin, family.id);
  }
  for (const companyProduct of snapshot.companyProducts) {
    const company = companyById.get(companyProduct.companyId);
    const product = productById.get(companyProduct.productId);
    const familyId = companyProduct.familyId;
    const asin = normalizedAsin(product?.asin);
    if (!company || !familyId || !familyById.has(familyId) || !asin) continue;
    add(byCompanyAsin, `${company}:${asin}`, familyId);
    const sku = normalizedSku(product?.sku);
    if (sku) add(exact, `${company}:${asin}:${sku}`, familyId);
  }
  return { companyById, familyById, exact, byCompanyAsin, globalByAsin };
}

function resolveFamily(
  company: string,
  asin: string,
  sku: string | undefined,
  indexes: ReturnType<typeof familyIndexes>,
) {
  if (sku) {
    const exact = indexes.exact.get(`${company}:${asin}:${sku}`) ?? new Set();
    if (exact.size === 1) return { familyId: [...exact][0], matchType: 'exact_member_sku' as const };
    if (exact.size > 1) return { reason: 'multi_account_boundary_ambiguous' };
  }
  const matches = indexes.byCompanyAsin.get(`${company}:${asin}`) ?? new Set();
  if (matches.size === 1) return { familyId: [...matches][0], matchType: 'unique_family_asin' as const };
  return { reason: matches.size > 1 ? 'multi_account_boundary_ambiguous' : 'not_current_family' };
}

function sourceFamilyCandidates(
  rows: ProjectedRow[],
  indexes: ReturnType<typeof familyIndexes>,
  accepted: (payload: Record<string, unknown>) => boolean,
) {
  const candidates = new Map<string, Set<string>>();
  for (const { payload } of rows) {
    if (!accepted(payload)) continue;
    const supplierRef = normalizeSupplierEvidenceRef(payload.supplierExternalRef);
    if (!supplierRef || REJECTED_REFS.has(supplierRef)) continue;
    const asins = String(payload.sourceAsin ?? '')
      .toUpperCase()
      .match(/B[A-Z0-9]{9}/g);
    for (const asin of new Set(asins ?? [])) {
      const families = indexes.globalByAsin.get(asin) ?? new Set();
      if (families.size !== 1) continue;
      const familyId = [...families][0];
      candidates.set(familyId, new Set([...(candidates.get(familyId) ?? []), supplierRef]));
    }
  }
  return candidates;
}

function selectedHistoricalChoices(evidenceByFamily: Map<string, HistoricalEvidence[]>) {
  const choices = new Map<string, HistoricalChoice>();
  for (const [familyId, evidence] of evidenceByFamily) {
    const latestDate = evidence
      .map((item) => item.sourceDate)
      .sort()
      .at(-1) as string;
    const latest = evidence.filter((item) => item.sourceDate === latestDate);
    const latestRefs = new Set(latest.map((item) => item.supplierRef));
    const allRefs = new Set(evidence.map((item) => item.supplierRef));
    const selected = [...latest].sort((left, right) => left.supplierRef.localeCompare(right.supplierRef))[0];
    choices.set(familyId, {
      company: selected.company,
      supplierRef: latestRefs.size === 1 ? [...latestRefs][0] : undefined,
      sourceDate: latestDate,
      sourceRowNumber: selected.sourceRowNumber,
      headerRowNumber: selected.headerRowNumber,
      matchType: selected.matchType,
      supplierCount: allRefs.size,
    });
  }
  return choices;
}

function candidateFamilyCount(candidates: Map<string, Set<string>>) {
  return [...candidates.values()].filter((refs) => refs.size === 1).length;
}

export function buildSupplierEvidenceBackfillPlan(params: {
  snapshot: SupplierEvidenceSnapshot;
  files: SupplierEvidenceFiles;
}) {
  const indexes = familyIndexes(params.snapshot);
  const supplierIds = projectedRows('supplier_ids', params.files.supplierIds);
  const tracker = projectedRows('supplier_tracker', params.files.supplierTracker);
  const current = projectedRows('supplier_2026', params.files.supplier2026);
  const headers = projectedRows('purchase_orders', params.files.purchaseOrders);
  const details = projectedRows('order_details', params.files.orderDetails);
  const forbiddenPaths = [supplierIds, tracker, current, headers, details].flatMap((source) => source.forbiddenPaths);
  if (forbiddenPaths.length) {
    throw new Error(
      `Supplier evidence dry-run blocked: projected evidence contains prohibited material at ${forbiddenPaths[0]}.`,
    );
  }

  const baseMasterRefs = new Set(
    [...tracker.rows, ...current.rows]
      .map(({ payload }) => normalizeSupplierEvidenceRef(payload.supplierExternalRef))
      .filter((value): value is string => Boolean(value)),
  );
  const supplierIdRowsByRef = new Map<string, ProjectedRow[]>();
  for (const row of supplierIds.rows) {
    const supplierRef = normalizeSupplierEvidenceRef(
      normalizeExternalSupplierCode(text(row.payload.supplierExternalRef)),
    );
    if (!supplierRef || REJECTED_REFS.has(supplierRef) || !text(row.payload.supplierName)) continue;
    supplierIdRowsByRef.set(supplierRef, [...(supplierIdRowsByRef.get(supplierRef) ?? []), row]);
  }
  const conflictingSupplierIdRefs = new Set<string>();
  const supplierIdMasters = new Map<string, SupplierEvidenceMaster>();
  for (const [supplierRef, rows] of supplierIdRowsByRef) {
    const normalizedNames = new Set(
      rows.map((row) => normalizeSupplierName(text(row.payload.supplierName))).filter(Boolean),
    );
    if (normalizedNames.size !== 1) {
      conflictingSupplierIdRefs.add(supplierRef);
      continue;
    }
    const row = rows[0];
    supplierIdMasters.set(supplierRef, {
      displayName: text(row.payload.supplierName),
      sourceFileName: params.files.supplierIds.name,
      sourceFileSha256: hash(params.files.supplierIds.content),
      sourceRowNumber: row.rowNumber,
    });
  }
  const masterByRef = new Map(supplierIdMasters);
  for (const [file, rows] of [
    [params.files.supplierTracker, tracker.rows],
    [params.files.supplier2026, current.rows],
  ] as const) {
    for (const row of rows) {
      const supplierRef = normalizeSupplierEvidenceRef(row.payload.supplierExternalRef);
      if (!supplierRef || REJECTED_REFS.has(supplierRef)) continue;
      const displayName = text(row.payload.supplierName);
      const existing = masterByRef.get(supplierRef);
      masterByRef.set(supplierRef, {
        displayName: displayName ?? existing?.displayName,
        sourceFileName: file.name,
        sourceFileSha256: hash(file.content),
        sourceRowNumber: row.rowNumber,
      });
    }
  }
  const masterRefs = new Set(masterByRef.keys());
  const supplementalSupplierIdRefs = new Set(
    [...supplierIdMasters.keys()].filter((supplierRef) => !baseMasterRefs.has(supplierRef)),
  );
  const latestHeaderByOrder = new Map<string, ProjectedRow>();
  for (const header of headers.rows) {
    const company = text(header.payload.company);
    const orderRef = normalizedOrderRef(header.payload.orderRef);
    if (!company || !CANONICAL_COMPANIES.has(company) || !orderRef) continue;
    const key = `${company}:${orderRef}`;
    const currentHeader = latestHeaderByOrder.get(key);
    const currentDate = sourceDate(currentHeader?.payload.occurredAt) ?? '';
    const nextDate = sourceDate(header.payload.occurredAt) ?? '';
    if (
      !currentHeader ||
      nextDate > currentDate ||
      (nextDate === currentDate && header.rowNumber > currentHeader.rowNumber)
    ) {
      latestHeaderByOrder.set(key, header);
    }
  }

  const reasonCounts: Record<string, number> = {};
  const evidenceByFamily = new Map<string, HistoricalEvidence[]>();
  const acceptedSupplierRefs = new Set<string>();
  for (const detail of details.rows) {
    const company = text(detail.payload.company);
    if (!company || !CANONICAL_COMPANIES.has(company)) {
      increment(reasonCounts, 'company_out_of_scope');
      continue;
    }
    const orderRef = normalizedOrderRef(detail.payload.orderRef);
    const header = orderRef ? latestHeaderByOrder.get(`${company}:${orderRef}`) : undefined;
    if (!header) {
      increment(reasonCounts, 'purchase_order_header_missing');
      continue;
    }
    const orderDate = sourceDate(header.payload.orderDate ?? header.payload.occurredAt);
    if (
      operationalValue(header.payload.approvalStatus) !== 'approved' ||
      !['completed', 'in_progress'].includes(operationalValue(header.payload.status)) ||
      !orderDate
    ) {
      increment(reasonCounts, 'purchase_order_header_not_actual');
      continue;
    }
    if (
      operationalValue(detail.payload.amazonStatus) !== 'cleared' ||
      !Number.isFinite(Number(detail.payload.quantity)) ||
      Number(detail.payload.quantity) <= 0 ||
      ['rejected', 'oos'].includes(operationalValue(detail.payload.cooStatus))
    ) {
      increment(reasonCounts, 'order_detail_not_actual');
      continue;
    }
    const detailRef = normalizeSupplierEvidenceRef(detail.payload.supplierExternalRef);
    const headerRef = normalizeSupplierEvidenceRef(header.payload.supplierExternalRef);
    if (!detailRef || !headerRef) {
      increment(reasonCounts, 'supplier_ref_missing');
      continue;
    }
    if (REJECTED_REFS.has(detailRef) || REJECTED_REFS.has(headerRef)) {
      increment(reasonCounts, 'confirmed_external_ref_rejected');
      continue;
    }
    if (detailRef !== headerRef) {
      increment(reasonCounts, 'header_detail_supplier_mismatch');
      continue;
    }
    const asin = normalizedAsin(detail.payload.sourceAsin);
    if (!asin) {
      increment(reasonCounts, 'product_identity_missing');
      continue;
    }
    const resolution = resolveFamily(company, asin, normalizedSku(detail.payload.sourceSupplierSku), indexes);
    if (!resolution.familyId || !resolution.matchType) {
      increment(reasonCounts, resolution.reason ?? 'not_current_family');
      continue;
    }
    const evidence: HistoricalEvidence = {
      familyId: resolution.familyId,
      company,
      supplierRef: detailRef,
      sourceDate: orderDate,
      sourceRowNumber: detail.rowNumber,
      headerRowNumber: header.rowNumber,
      matchType: resolution.matchType,
    };
    evidenceByFamily.set(resolution.familyId, [...(evidenceByFamily.get(resolution.familyId) ?? []), evidence]);
    acceptedSupplierRefs.add(detailRef);
    increment(reasonCounts, 'accepted_historical_order_evidence');
  }

  const historicalChoices = selectedHistoricalChoices(evidenceByFamily);
  const isApprovedActive = (payload: Record<string, unknown>) =>
    operationalValue(payload.approvalStatus) === 'approved' && operationalValue(payload.currentStatus) === 'active';
  const isApprovedUnknown = (payload: Record<string, unknown>) =>
    operationalValue(payload.approvalStatus) === 'approved' &&
    ['', 'unknown'].includes(operationalValue(payload.currentStatus));
  const isTrackerActive = (payload: Record<string, unknown>) =>
    ['completed', 'in_progress'].includes(operationalValue(payload.workflowStatus)) &&
    ['yes', 'active'].includes(operationalValue(payload.activeStatus));
  const approvedActive = sourceFamilyCandidates(current.rows, indexes, isApprovedActive);
  const approvedUnknown = sourceFamilyCandidates(current.rows, indexes, isApprovedUnknown);
  const trackerActive = sourceFamilyCandidates(tracker.rows, indexes, isTrackerActive);

  const existingPreferredFamilyIds = new Set(
    params.snapshot.families.filter((family) => family.preferredSupplierId).map((family) => family.id),
  );
  const protectedExistingFamilyIds = new Set(
    params.snapshot.families
      .filter(
        (family) =>
          family.preferredSupplierId &&
          (!family.supplierSelectionSource ||
            ['operator', 'latest_valid_order'].includes(family.supplierSelectionSource)),
      )
      .map((family) => family.id),
  );
  const selected = new Map<string, { source: string; supplierRef?: string }>();
  for (const family of params.snapshot.families) {
    if (!protectedExistingFamilyIds.has(family.id)) continue;
    selected.set(family.id, { source: family.supplierSelectionSource ?? 'existing_preferred_supplier' });
  }
  const selectUnique = (source: string, candidates: Map<string, Set<string>>) => {
    for (const [familyId, refs] of candidates) {
      if (selected.has(familyId) || refs.size !== 1) continue;
      selected.set(familyId, { source, supplierRef: [...refs][0] });
    }
  };
  for (const [familyId, choice] of historicalChoices) {
    if (selected.has(familyId) || !choice.supplierRef || !masterRefs.has(choice.supplierRef)) continue;
    selected.set(familyId, { source: 'historical_order_evidence', supplierRef: choice.supplierRef });
  }
  selectUnique('supplier_2026_approved_active', approvedActive);
  selectUnique('supplier_2026_approved_unknown', approvedUnknown);
  selectUnique('supplier_tracker_active_workflow', trackerActive);

  const unresolvedReasons: Record<string, number> = {};
  const redactedReviews: Array<{ reason: string; familyKeyHash: string; supplierRefHash?: string }> = [];
  for (const family of params.snapshot.families) {
    if (selected.has(family.id)) continue;
    const history = historicalChoices.get(family.id);
    let reason = 'no_deterministic_evidence';
    if (history && !history.supplierRef) reason = 'historical_latest_supplier_tie';
    else if (history?.supplierRef && conflictingSupplierIdRefs.has(history.supplierRef)) {
      reason = 'supplier_ids_name_conflict';
    } else if (history?.supplierRef && !masterRefs.has(history.supplierRef))
      reason = 'supplier_ref_absent_from_masters';
    else if (
      [approvedActive, approvedUnknown, trackerActive].some((candidates) => (candidates.get(family.id)?.size ?? 0) > 1)
    ) {
      reason = 'lower_authority_supplier_conflict';
    }
    increment(unresolvedReasons, reason);
    if (reason !== 'no_deterministic_evidence') {
      redactedReviews.push({
        reason,
        familyKeyHash: hash(`${family.companyId}:${family.amazonAccountId}:${family.marketplace}:${family.asin}`).slice(
          0,
          16,
        ),
        supplierRefHash: history?.supplierRef ? hash(history.supplierRef).slice(0, 16) : undefined,
      });
    }
  }

  const selectedSourceDistribution: Record<string, number> = {};
  const selectedRefs = new Set<string>();
  const externalRefBySupplier = new Map(
    (params.snapshot.supplierExternalRefs ?? [])
      .filter((item) => item.sourceSystem === 'supplier_ids')
      .map((item) => [item.supplierId, normalizeSupplierEvidenceRef(item.normalizedExternalSupplierCode)]),
  );
  for (const family of params.snapshot.families) {
    const selection = selected.get(family.id);
    if (!selection) {
      increment(selectedSourceDistribution, 'unresolved');
      continue;
    }
    increment(selectedSourceDistribution, selection.source);
    const supplierRef = selection.supplierRef ?? externalRefBySupplier.get(family.preferredSupplierId ?? '');
    if (supplierRef) selectedRefs.add(supplierRef);
  }

  const historicalByCompany: Record<string, number> = {};
  const historicalByMatchType: Record<string, number> = {};
  const historicalByYear: Record<string, number> = {};
  let historicalMasterResolved = 0;
  let historicalMasterMissing = 0;
  let multiSupplierFamilies = 0;
  let latestDateTieFamilies = 0;
  for (const choice of historicalChoices.values()) {
    increment(historicalByCompany, choice.company);
    increment(historicalByMatchType, choice.matchType);
    increment(historicalByYear, choice.sourceDate.slice(0, 4));
    if (choice.supplierCount > 1) multiSupplierFamilies += 1;
    if (!choice.supplierRef) latestDateTieFamilies += 1;
    else if (masterRefs.has(choice.supplierRef)) historicalMasterResolved += 1;
    else historicalMasterMissing += 1;
  }

  const sourceInputs = Object.fromEntries(
    Object.entries(params.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, file]) => {
        const parsed = parseCsv(file.content);
        return [
          key,
          {
            fileName: file.name,
            sha256: hash(file.content),
            rowCount: parsed.rawRowCount,
            nonEmptyRowCount: parsed.rows.length,
          },
        ];
      }),
  );
  const familyById = new Map(params.snapshot.families.map((family) => [family.id, family]));
  const automatedSources = new Set<SupplierEvidenceSelection['source']>([
    'historical_order_evidence',
    'supplier_2026_approved_active',
    'supplier_2026_approved_unknown',
    'supplier_tracker_active_workflow',
  ]);
  const lowerSourceSpecs = {
    supplier_2026_approved_active: {
      file: params.files.supplier2026,
      rows: current.rows,
      accepted: isApprovedActive,
    },
    supplier_2026_approved_unknown: {
      file: params.files.supplier2026,
      rows: current.rows,
      accepted: isApprovedUnknown,
    },
    supplier_tracker_active_workflow: {
      file: params.files.supplierTracker,
      rows: tracker.rows,
      accepted: isTrackerActive,
    },
  } as const;
  const selections: SupplierEvidenceSelection[] = [];
  for (const [familyId, selection] of selected) {
    if (!selection.supplierRef || !automatedSources.has(selection.source as SupplierEvidenceSelection['source']))
      continue;
    const family = familyById.get(familyId);
    if (!family) throw new Error(`Supplier evidence dry-run failed: selected family ${familyId} is missing.`);
    const source = selection.source as SupplierEvidenceSelection['source'];
    if (source === 'historical_order_evidence') {
      const choice = historicalChoices.get(familyId);
      if (!choice)
        throw new Error(`Supplier evidence dry-run failed: historical choice for family ${familyId} is missing.`);
      selections.push({
        familyId,
        companyId: family.companyId,
        supplierRef: selection.supplierRef,
        source,
        evidence: {
          ruleVersion: PREVIEW_VERSION,
          sourceFileName: params.files.orderDetails.name,
          sourceFileSha256: hash(params.files.orderDetails.content),
          sourceRowNumber: choice.sourceRowNumber,
          headerRowNumber: choice.headerRowNumber,
          sourceObservedAt: choice.sourceDate,
          matchType: choice.matchType,
          supplierExternalRef: selection.supplierRef,
        },
      });
      continue;
    }
    const spec = lowerSourceSpecs[source];
    const familyAsin = normalizedAsin(family.asin);
    const sourceRow = spec.rows.find(({ payload }) => {
      const sourceAsins =
        String(payload.sourceAsin ?? '')
          .toUpperCase()
          .match(/B[A-Z0-9]{9}/g) ?? [];
      return (
        spec.accepted(payload) &&
        normalizeSupplierEvidenceRef(payload.supplierExternalRef) === selection.supplierRef &&
        Boolean(familyAsin && sourceAsins.includes(familyAsin))
      );
    });
    if (!sourceRow) throw new Error(`Supplier evidence dry-run failed: source row for family ${familyId} is missing.`);
    selections.push({
      familyId,
      companyId: family.companyId,
      supplierRef: selection.supplierRef,
      source,
      evidence: {
        ruleVersion: PREVIEW_VERSION,
        sourceFileName: spec.file.name,
        sourceFileSha256: hash(spec.file.content),
        sourceRowNumber: sourceRow.rowNumber,
        matchType: 'unique_global_asin',
        supplierExternalRef: selection.supplierRef,
      },
    });
  }
  selections.sort((left, right) => left.familyId.localeCompare(right.familyId));

  const sroAssertions = Object.fromEntries(
    FOUR_COMPANY_MIGRATION_PROFILE.supplierExternalRefDecisions.map((decision) => {
      const ref = decision.externalRef;
      const masterRows = [...tracker.rows, ...current.rows].filter(
        (row) => normalizeSupplierEvidenceRef(row.payload.supplierExternalRef) === ref,
      ).length;
      const detailRows = details.rows.filter(
        (row) => normalizeSupplierEvidenceRef(row.payload.supplierExternalRef) === ref,
      ).length;
      const selectedRef = selectedRefs.has(ref);
      return [
        ref,
        {
          disposition: decision.disposition,
          masterRows,
          detailRows,
          selected: selectedRef,
          passed: decision.disposition === 'reject' ? !selectedRef : masterRows > 0,
        },
      ];
    }),
  );

  const reportWithoutDigest = {
    mode: 'dry-run',
    version: PREVIEW_VERSION,
    input: sourceInputs,
    baseline: {
      familyCount: params.snapshot.families.length,
      existingPreferredSupplierCount: params.snapshot.families.filter((family) => family.preferredSupplierId).length,
    },
    supplierIdentityEvidence: {
      sourceRowCount: supplierIds.rowCount,
      usableRefCount: supplierIdMasters.size,
      conflictingRefCount: conflictingSupplierIdRefs.size,
      historicalFamiliesResolvedBySupplierIds: [...historicalChoices.values()].filter(
        (choice) => choice.supplierRef && supplementalSupplierIdRefs.has(choice.supplierRef),
      ).length,
    },
    historicalEvidence: {
      acceptedDetailRows: reasonCounts.accepted_historical_order_evidence ?? 0,
      candidateFamilies: historicalChoices.size,
      masterResolvedFamilies: historicalMasterResolved,
      masterMissingFamilies: historicalMasterMissing,
      multiSupplierFamilies,
      latestDateTieFamilies,
      headerDetailSupplierMismatches: reasonCounts.header_detail_supplier_mismatch ?? 0,
      multiBoundaryAmbiguousRows: reasonCounts.multi_account_boundary_ambiguous ?? 0,
      confirmedRejectedRows: reasonCounts.confirmed_external_ref_rejected ?? 0,
      byCompany: sortedCounts(historicalByCompany),
      byMatchType: sortedCounts(historicalByMatchType),
      byLatestEvidenceYear: sortedCounts(historicalByYear),
    },
    candidateSourceDistribution: {
      historical_order_evidence: historicalChoices.size,
      supplier_2026_approved_active: candidateFamilyCount(approvedActive),
      supplier_2026_approved_unknown: candidateFamilyCount(approvedUnknown),
      supplier_tracker_active_workflow: candidateFamilyCount(trackerActive),
    },
    familySelectionProjection: {
      existingPreferredFamilies: existingPreferredFamilyIds.size,
      protectedHigherAuthorityFamilies: protectedExistingFamilyIds.size,
      historicalExistingPreferredOverlap: [...historicalChoices.keys()].filter((familyId) =>
        protectedExistingFamilyIds.has(familyId),
      ).length,
      historicalIncrementalCandidates: [...historicalChoices.keys()].filter(
        (familyId) => !protectedExistingFamilyIds.has(familyId),
      ).length,
      historicalIncrementalAutoApplicable: [...selected.values()].filter(
        (selection) => selection.source === 'historical_order_evidence',
      ).length,
      historicalIncrementalMissingMaster: [...historicalChoices].filter(
        ([familyId, choice]) =>
          !protectedExistingFamilyIds.has(familyId) &&
          typeof choice.supplierRef === 'string' &&
          !masterRefs.has(choice.supplierRef),
      ).length,
      lowerAuthorityIncrementalSelections: [...selected.values()].filter((selection) =>
        selection.source.startsWith('supplier_'),
      ).length,
      projectedPreferredFamilies: selected.size,
      projectedUnresolvedFamilies: params.snapshot.families.length - selected.size,
    },
    selectedSourceDistribution: sortedCounts(selectedSourceDistribution),
    unresolvedReasonDistribution: sortedCounts(unresolvedReasons),
    candidateSupplierRefCount: acceptedSupplierRefs.size,
    exclusionReasonDistribution: sortedCounts(reasonCounts),
    redactedReviews: redactedReviews
      .sort((left, right) =>
        `${left.reason}:${left.familyKeyHash}`.localeCompare(`${right.reason}:${right.familyKeyHash}`),
      )
      .slice(0, 20),
    sroAssertions,
    security: {
      prohibitedFieldCount: 0,
      droppedFieldCount:
        supplierIds.droppedFieldCount +
        tracker.droppedFieldCount +
        current.droppedFieldCount +
        headers.droppedFieldCount +
        details.droppedFieldCount,
      rawRowsPersisted: false,
    },
    stagingWrites: 0,
  };
  const decisionDigest = hash(
    stableJson({
      version: PREVIEW_VERSION,
      input: sourceInputs,
      selections,
      unresolvedReasonDistribution: sortedCounts(unresolvedReasons),
      supplierExternalRefDecisions: FOUR_COMPANY_MIGRATION_PROFILE.supplierExternalRefDecisions.map(
        ({ externalRef, disposition }) => ({ externalRef, disposition }),
      ),
    }),
  );
  return {
    preview: { ...reportWithoutDigest, decisionDigest },
    selections,
    masterByRef,
  };
}

export function previewSupplierEvidenceBackfill(params: {
  snapshot: SupplierEvidenceSnapshot;
  files: SupplierEvidenceFiles;
}) {
  return buildSupplierEvidenceBackfillPlan(params).preview;
}
