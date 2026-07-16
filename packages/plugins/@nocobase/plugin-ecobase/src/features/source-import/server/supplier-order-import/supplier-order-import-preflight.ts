/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { computeSupplierOrderImportPlanDigest } from './supplier-order-import-plan';
import type { OrderLineImportPlanRow, SupplierOrderImportPlan } from './supplier-order-import-types';

interface CatalogCompany {
  id: string;
  companyKey: string;
  name: string;
}

interface CatalogFamily {
  id: string;
  companyId: string;
  marketplace?: string | null;
  canonicalAsin: string;
}

interface CatalogCompanyProduct {
  id: string;
  companyId: string;
  companyProductFamilyId: string;
  productId: string;
}

interface CatalogProduct {
  id: string;
  asin: string;
  sku: string;
}

export interface SupplierOrderCatalogSnapshot {
  database: string;
  companies: CatalogCompany[];
  families: CatalogFamily[];
  companyProducts: CatalogCompanyProduct[];
  products: CatalogProduct[];
}

export interface SupplierOrderPreflightBlocker {
  sourceFile?: string;
  sourceRow?: number;
  sourceIssueReason?: string;
  sourceLineKey?: string;
  externalOrderId?: string;
  companyKey?: string;
  asin?: string;
  sourceMarketplace?: string;
  reason:
    | 'source_plan_blocked'
    | 'supplier_not_in_authority'
    | 'company_not_in_catalog'
    | 'family_not_found'
    | 'family_marketplace_unresolved'
    | 'family_ambiguous'
    | 'listing_sku_ambiguous';
  candidateIds?: string[];
}

export interface SupplierOrderImportPreflight {
  preflightVersion: 'supplier-order-preflight-v1';
  sourcePlanDigest: string;
  catalogDigest: string;
  preflightDigest: string;
  ready: boolean;
  plan: SupplierOrderImportPlan;
  blockers: SupplierOrderPreflightBlocker[];
  mappingExceptions: SupplierOrderPreflightBlocker[];
  counts: {
    structuralBlockers: number;
    purchaseEvidence: { confirmed: number; cancelled: number; rejected: number; unknown: number };
    poSourceSupplierIds: number;
    poCanonicalSupplierIds: number;
    missingPoSupplierIds: number;
    orders: number;
    lines: number;
    exactMemberLines: number;
    familyOnlyLines: number;
    unresolvedLines: number;
    mappingExceptions: number;
    blockedLines: number;
  };
}

function text(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function marketplaceKey(value: unknown) {
  const normalized = text(value).toUpperCase().replace(/\s+/g, '');
  if (normalized === 'US' || normalized === 'USA' || normalized === 'AMAZON.COM') return 'US';
  if (normalized === 'UK' || normalized === 'AMAZON.CO.UK') return 'UK';
  return normalized;
}

function sortedIds(values: Array<{ id: string }>) {
  return values.map((value) => value.id).sort();
}

export function computeSupplierOrderPreflightDigest(
  preflight: Pick<
    SupplierOrderImportPreflight,
    'sourcePlanDigest' | 'catalogDigest' | 'counts' | 'blockers' | 'mappingExceptions' | 'plan'
  >,
) {
  return digest({
    sourcePlanDigest: preflight.sourcePlanDigest,
    catalogDigest: preflight.catalogDigest,
    counts: preflight.counts,
    blockers: preflight.blockers,
    mappingExceptions: preflight.mappingExceptions,
    resolvedLines: preflight.plan.orderLines,
  });
}

export function assertReadySupplierOrderImportPreflight(preflight: SupplierOrderImportPreflight) {
  if (preflight.preflightVersion !== 'supplier-order-preflight-v1') {
    throw new Error('Ecobase supplier/order apply failed: preflight version is invalid.');
  }
  if (
    preflight.sourcePlanDigest !== preflight.plan.digest ||
    preflight.sourcePlanDigest !== computeSupplierOrderImportPlanDigest(preflight.plan)
  ) {
    throw new Error('Ecobase supplier/order apply failed: source plan digest does not match its payload.');
  }
  if (preflight.preflightDigest !== computeSupplierOrderPreflightDigest(preflight)) {
    throw new Error('Ecobase supplier/order apply failed: preflight digest does not match its payload.');
  }
  if (
    !preflight.ready ||
    preflight.blockers.length ||
    preflight.counts.structuralBlockers ||
    preflight.counts.blockedLines
  ) {
    throw new Error('Ecobase supplier/order apply failed: preflight is not ready.');
  }
  const scopeCounts = { exact_member: 0, family_only: 0, unresolved: 0 };
  for (const line of preflight.plan.orderLines) {
    if (!line.mappingScope)
      throw new Error(`Ecobase supplier/order apply failed: line ${line.sourceLineKey} was not preflighted.`);
    scopeCounts[line.mappingScope] += 1;
    if (line.mappingScope === 'exact_member' && (!line.companyProductFamilyId || !line.companyProductId)) {
      throw new Error(
        `Ecobase supplier/order apply failed: exact-member line ${line.sourceLineKey} has incomplete links.`,
      );
    }
    if (
      line.mappingScope === 'family_only' &&
      (!line.companyProductFamilyId || line.companyProductId || line.supplierProductId)
    ) {
      throw new Error(`Ecobase supplier/order apply failed: family-only line ${line.sourceLineKey} has invalid links.`);
    }
    if (
      line.mappingScope === 'unresolved' &&
      (line.companyProductFamilyId || line.companyProductId || line.supplierProductId)
    ) {
      throw new Error(`Ecobase supplier/order apply failed: unresolved line ${line.sourceLineKey} has catalog links.`);
    }
  }
  if (
    scopeCounts.exact_member !== preflight.counts.exactMemberLines ||
    scopeCounts.family_only !== preflight.counts.familyOnlyLines ||
    scopeCounts.unresolved !== preflight.counts.unresolvedLines ||
    preflight.plan.orders.length !== preflight.counts.orders ||
    preflight.plan.orderLines.length !== preflight.counts.lines
  ) {
    throw new Error('Ecobase supplier/order apply failed: preflight counts do not match its plan.');
  }
}

export function preflightSupplierOrderImport(
  sourcePlan: SupplierOrderImportPlan,
  catalog: SupplierOrderCatalogSnapshot,
): SupplierOrderImportPreflight {
  if (sourcePlan.planVersion !== 'supplier-order-import-plan-v1' || !/^[a-f0-9]{64}$/.test(sourcePlan.digest)) {
    throw new Error('Supplier/order preflight failed: source plan version or digest is invalid.');
  }
  const blockers: SupplierOrderPreflightBlocker[] = sourcePlan.issues
    .filter((issue) => issue.severity === 'blocked')
    .map((issue) => ({
      sourceFile: issue.sourceFile,
      sourceRow: issue.sourceRow,
      sourceIssueReason: issue.reason,
      externalOrderId: issue.externalKey,
      reason: 'source_plan_blocked' as const,
    }));
  const mappingExceptions: SupplierOrderPreflightBlocker[] = [];
  const supplierAuthority = new Set(sourcePlan.suppliers.map((supplier) => supplier.externalSupplierCode));
  const poSourceSupplierIds = sourcePlan.purchaseOrderSourceSupplierCodes;
  const poCanonicalSupplierIds = [...new Set(sourcePlan.orders.map((order) => order.externalSupplierCode))].sort();
  const missingPoSupplierIds = poCanonicalSupplierIds.filter((code) => !supplierAuthority.has(code));
  for (const code of missingPoSupplierIds) blockers.push({ reason: 'supplier_not_in_authority', candidateIds: [code] });

  const companiesByKey = new Map(catalog.companies.map((company) => [company.companyKey, company]));
  const productsById = new Map(catalog.products.map((product) => [product.id, product]));
  const familiesByCompanyAsin = new Map<string, CatalogFamily[]>();
  for (const family of catalog.families) {
    const key = `${family.companyId}:${text(family.canonicalAsin).toUpperCase()}`;
    familiesByCompanyAsin.set(key, [...(familiesByCompanyAsin.get(key) ?? []), family]);
  }
  const membersByFamilySku = new Map<string, CatalogCompanyProduct[]>();
  for (const member of catalog.companyProducts) {
    const product = productsById.get(member.productId);
    if (!product) continue;
    const key = `${member.companyProductFamilyId}:${text(product.sku)}`;
    membersByFamilySku.set(key, [...(membersByFamilySku.get(key) ?? []), member]);
  }

  let exactMemberLines = 0;
  let familyOnlyLines = 0;
  let unresolvedLines = 0;
  const resolvedLines: OrderLineImportPlanRow[] = [];
  for (const line of sourcePlan.orderLines) {
    const company = companiesByKey.get(line.companyKey);
    if (!company) {
      blockers.push({
        sourceLineKey: line.sourceLineKey,
        externalOrderId: line.externalOrderId,
        companyKey: line.companyKey,
        asin: line.asin,
        sourceMarketplace: line.sourceMarketplace,
        reason: 'company_not_in_catalog',
      });
      continue;
    }
    const families = familiesByCompanyAsin.get(`${company.id}:${line.asin}`) ?? [];
    const marketplaceFamilies = line.sourceMarketplace
      ? families.filter((family) => marketplaceKey(family.marketplace) === marketplaceKey(line.sourceMarketplace))
      : [];
    const selectedFamily =
      marketplaceFamilies.length === 1 ? marketplaceFamilies[0] : families.length === 1 ? families[0] : undefined;
    if (!selectedFamily) {
      const reason = !families.length
        ? 'family_not_found'
        : line.sourceMarketplace && !marketplaceFamilies.length
          ? 'family_marketplace_unresolved'
          : 'family_ambiguous';
      mappingExceptions.push({
        sourceLineKey: line.sourceLineKey,
        externalOrderId: line.externalOrderId,
        companyKey: line.companyKey,
        asin: line.asin,
        sourceMarketplace: line.sourceMarketplace,
        reason,
        candidateIds: sortedIds(marketplaceFamilies.length ? marketplaceFamilies : families),
      });
      unresolvedLines += 1;
      resolvedLines.push({
        ...line,
        companyProductFamilyId: null,
        companyProductId: null,
        supplierProductId: null,
        mappingScope: 'unresolved',
        mappingReason: reason,
        sourceSkuType: line.supplierSku ? 'supplier_sku' : line.upc ? 'upc' : 'unknown',
      });
      continue;
    }
    const memberCandidates = line.supplierSku
      ? membersByFamilySku.get(`${selectedFamily.id}:${text(line.supplierSku)}`) ?? []
      : [];
    if (memberCandidates.length > 1) {
      mappingExceptions.push({
        sourceLineKey: line.sourceLineKey,
        externalOrderId: line.externalOrderId,
        companyKey: line.companyKey,
        asin: line.asin,
        sourceMarketplace: line.sourceMarketplace,
        reason: 'listing_sku_ambiguous',
        candidateIds: sortedIds(memberCandidates),
      });
      familyOnlyLines += 1;
      resolvedLines.push({
        ...line,
        companyProductFamilyId: selectedFamily.id,
        companyProductId: null,
        supplierProductId: null,
        mappingScope: 'family_only',
        mappingReason: 'listing_sku_ambiguous',
        sourceSkuType: 'supplier_sku',
        familyResolution: marketplaceFamilies.length === 1 ? 'marketplace_exact' : 'company_asin_unique',
      });
      continue;
    }
    if (memberCandidates.length === 1) {
      exactMemberLines += 1;
      resolvedLines.push({
        ...line,
        companyProductFamilyId: selectedFamily.id,
        companyProductId: memberCandidates[0].id,
        supplierProductId: null,
        mappingScope: 'exact_member',
        sourceSkuType: 'listing_sku',
        familyResolution: marketplaceFamilies.length === 1 ? 'marketplace_exact' : 'company_asin_unique',
      });
    } else {
      familyOnlyLines += 1;
      resolvedLines.push({
        ...line,
        companyProductFamilyId: selectedFamily.id,
        companyProductId: null,
        supplierProductId: null,
        mappingScope: 'family_only',
        sourceSkuType: line.supplierSku ? 'supplier_sku' : line.upc ? 'upc' : 'unknown',
        familyResolution: marketplaceFamilies.length === 1 ? 'marketplace_exact' : 'company_asin_unique',
      });
    }
  }

  const plan = { ...sourcePlan, orderLines: resolvedLines };
  const catalogDigest = digest(catalog);
  const purchaseEvidence = { confirmed: 0, cancelled: 0, rejected: 0, unknown: 0 };
  for (const order of sourcePlan.orders) {
    const status = order.purchaseEvidenceStatus === 'unconfirmed_workflow' ? 'unknown' : order.purchaseEvidenceStatus;
    purchaseEvidence[status] += 1;
  }
  const counts = {
    structuralBlockers: sourcePlan.issues.filter((issue) => issue.severity === 'blocked').length,
    purchaseEvidence,
    poSourceSupplierIds: poSourceSupplierIds.length,
    poCanonicalSupplierIds: poCanonicalSupplierIds.length,
    missingPoSupplierIds: missingPoSupplierIds.length,
    orders: sourcePlan.orders.length,
    lines: sourcePlan.orderLines.length,
    exactMemberLines,
    familyOnlyLines,
    unresolvedLines,
    mappingExceptions: mappingExceptions.length,
    blockedLines: sourcePlan.orderLines.length - resolvedLines.length,
  };
  const preflightDigest = computeSupplierOrderPreflightDigest({
    sourcePlanDigest: sourcePlan.digest,
    catalogDigest,
    counts,
    blockers,
    mappingExceptions,
    plan,
  });
  return {
    preflightVersion: 'supplier-order-preflight-v1',
    sourcePlanDigest: sourcePlan.digest,
    catalogDigest,
    preflightDigest,
    ready: !sourcePlan.hasBlockingIssues && blockers.length === 0,
    plan,
    blockers,
    mappingExceptions,
    counts,
  };
}
