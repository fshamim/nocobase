/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { detectCsvShape } from './adapters/amazon-operations-csv-adapter';
import type { AdapterStreamItem, NormalizedRecord, SourceAdapter } from './adapters';
import {
  FOUR_COMPANY_MIGRATION_PROFILE,
  type FourCompanyKey,
  type MigrationCompanySource,
} from './four-company-migration-profile';
import {
  type MigrationDataset,
  projectNormalizedRecordData,
  projectSourceRecord,
  type SourceRecordProjection,
} from './source-record-projection';
import { decideCompanyScope, type MigrationDecision } from './source-scope-policy';

export interface SafeImportBoundaryContext {
  adapter: SourceAdapter;
  defaultCompany?: string;
}

export type SafeImportBoundaryResult =
  | {
      disposition: 'discard';
      reasonCode: string;
      droppedFieldCount: number;
    }
  | {
      disposition: 'accept' | 'review';
      reasonCode: string;
      companyKey?: FourCompanyKey;
      sourceDataset: MigrationDataset;
      droppedFieldCount: number;
      item: AdapterStreamItem;
    };

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordsFor(item: AdapterStreamItem) {
  if (item.type !== 'record') return [];
  return (Array.isArray(item.record) ? item.record : [item.record]) as NormalizedRecord[];
}

function recordValue(item: AdapterStreamItem, key: string) {
  return recordsFor(item)
    .map((record) => stringValue(record.data[key]))
    .find(Boolean);
}

function firstSourceValue(source: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => stringValue(source[key])).find(Boolean);
}

function projectionDataset(context: SafeImportBoundaryContext, item: AdapterStreamItem) {
  if (item.type === 'status') return undefined;
  if (item.type === 'rowIssue') return 'source_issue' as const;
  const kinds = new Set(recordsFor(item).map((record) => record.kind));
  if (kinds.size > 0 && [...kinds].every((kind) => kind === 'source_access_audit'))
    return 'source_access_audit' as const;
  const source = item.payload;
  if (!source) return undefined;
  const shape = detectCsvShape(Object.keys(source));
  if (shape === 'order-details') return 'order_details' as const;
  if (shape === 'purchase-orders' || shape === 'pre-order-sheet') return 'purchase_orders' as const;
  if (shape === 'supplier-analysis-tracker') return 'supplier_tracker' as const;
  if (shape === 'supplier-analysis-2026' || shape === 'supplier-ids') return 'supplier_2026' as const;
  if (
    shape === 'sellerboard-dashboard-goods' ||
    shape === 'sellerboard-dashboard-totals' ||
    shape === 'profit-tracker'
  ) {
    return 'sellerboard_daily_facts' as const;
  }
  if (
    shape === 'master-stock' ||
    shape === 'profit-planning' ||
    shape === 'top-skus' ||
    shape === 'buybox' ||
    shape === 'sellerboard-stock'
  ) {
    return 'amazon_listing_inventory' as const;
  }
  if (
    context.adapter.metadata.name === 'sellerboard-history-csv' ||
    (context.adapter.metadata.name === 'sellerboard-api' &&
      [...kinds].every((kind) => ['listing_daily_fact', 'inventory_snapshot', 'traffic_snapshot'].includes(kind)))
  ) {
    return 'sellerboard_daily_facts' as const;
  }
  if (context.adapter.metadata.sourceType === 'clickup') return 'clickup_order_evidence' as const;
  return undefined;
}

function companySource(context: SafeImportBoundaryContext, dataset: MigrationDataset): MigrationCompanySource {
  if (dataset === 'supplier_tracker' || dataset === 'supplier_2026') return 'supplier_csv_provenance';
  return context.adapter.metadata.sourceType === 'sellerboard' ? 'sellerboard' : 'legacy_csv';
}

function sourceCompany(item: AdapterStreamItem, dataset: MigrationDataset) {
  const source = item.type === 'record' ? item.payload : item.type === 'rowIssue' ? item.issue.payload ?? {} : {};
  return dataset === 'supplier_tracker' || dataset === 'supplier_2026'
    ? firstSourceValue(source, ['Reached Via', 'Company', 'Company Name'])
    : firstSourceValue(source, ['Company', 'Company Name']);
}

function normalizedCompany(item: AdapterStreamItem) {
  return recordValue(item, 'company');
}

function orderRef(item: AdapterStreamItem) {
  const source = item.type === 'record' ? item.payload : item.type === 'rowIssue' ? item.issue.payload ?? {} : {};
  return firstSourceValue(source, ['Order ID', 'Order Ref', 'orderRef']) ?? recordValue(item, 'orderRef');
}

function scopeDecision(
  context: SafeImportBoundaryContext,
  item: AdapterStreamItem,
  dataset: MigrationDataset,
): MigrationDecision {
  const explicitCompany = sourceCompany(item, dataset);
  const derivedCompany = normalizedCompany(item) ?? context.defaultCompany;
  const ref = orderRef(item);
  return decideCompanyScope({
    source: companySource(context, dataset),
    explicitCompany: explicitCompany ?? (!ref ? derivedCompany : undefined),
    orderRef: ref,
    acceptedHeaderCompany: explicitCompany ? undefined : ref ? derivedCompany : undefined,
  });
}

function canonicalCompanyName(companyKey: FourCompanyKey) {
  const company = FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.find((item) => item.companyKey === companyKey);
  if (!company) throw new Error(`Ecobase safe import boundary failed: company ${companyKey} is not in the profile.`);
  return company.name;
}

function safeProjection(
  dataset: MigrationDataset,
  item: AdapterStreamItem,
  companyKey?: FourCompanyKey,
): SourceRecordProjection {
  const source = item.type === 'record' ? item.payload : item.type === 'rowIssue' ? item.issue.payload ?? {} : {};
  const retainedOrderRef = dataset === 'clickup_order_evidence' ? orderRef(item) : undefined;
  const projected = projectSourceRecord(dataset, source, { retainedOrderRef });
  if (companyKey) {
    const companyName = canonicalCompanyName(companyKey);
    if (dataset === 'supplier_tracker' || dataset === 'supplier_2026') {
      projected.payload.companyProvenance = companyName;
    } else {
      projected.payload.company = companyName;
    }
  }
  return projected;
}

function safeItem(
  item: AdapterStreamItem,
  projection: SourceRecordProjection,
  decision: Pick<MigrationDecision, 'disposition' | 'reasonCode'>,
) {
  if (item.type === 'record' && decision.disposition === 'accept') {
    let droppedFieldCount = 0;
    const sanitize = (record: NormalizedRecord) => {
      const safe = projectNormalizedRecordData(record.data);
      droppedFieldCount += safe.droppedFieldCount;
      return { ...record, data: safe.payload };
    };
    const record = Array.isArray(item.record) ? item.record.map(sanitize) : sanitize(item.record);
    return {
      item: { ...item, payload: projection.payload, record } satisfies AdapterStreamItem,
      droppedFieldCount,
    };
  }
  if (item.type === 'rowIssue') {
    return {
      item: { ...item, issue: { ...item.issue, payload: projection.payload } } satisfies AdapterStreamItem,
      droppedFieldCount: 0,
    };
  }
  const rowNumber = item.type === 'record' ? item.rowNumber : 0;
  const sourceKey = item.type === 'record' ? item.sourceKey : undefined;
  return {
    item: {
      type: 'rowIssue',
      issue: {
        rowNumber,
        sourceKey,
        severity: 'warning',
        code: decision.reasonCode,
        message: `Ecobase safe import boundary routed the source row to review: ${decision.reasonCode}.`,
        payload: projection.payload,
      },
    } satisfies AdapterStreamItem,
    droppedFieldCount: 0,
  };
}

export function applySafeImportBoundary(
  context: SafeImportBoundaryContext,
  item: AdapterStreamItem,
): SafeImportBoundaryResult {
  const dataset = projectionDataset(context, item);
  if (!dataset) {
    return { disposition: 'discard', reasonCode: 'unsupported_projection_dataset', droppedFieldCount: 0 };
  }
  const scopeFree = dataset === 'source_access_audit' || dataset === 'source_issue';
  const decision = scopeFree
    ? ({ disposition: 'accept', reasonCode: `safe_${dataset}` } as const)
    : scopeDecision(context, item, dataset);
  if (decision.disposition === 'discard') {
    return { disposition: 'discard', reasonCode: decision.reasonCode, droppedFieldCount: 0 };
  }
  const projection = safeProjection(dataset, item, 'companyKey' in decision ? decision.companyKey : undefined);
  const safe = safeItem(item, projection, decision);
  return {
    disposition: decision.disposition,
    reasonCode: decision.reasonCode,
    ...('companyKey' in decision ? { companyKey: decision.companyKey } : {}),
    sourceDataset: dataset,
    droppedFieldCount: projection.droppedFieldCount + safe.droppedFieldCount,
    item: safe.item,
  };
}
