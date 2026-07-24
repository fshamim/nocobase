/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { normalizeSupplierName } from '../../../semantic-model/server/medallion-identity-service';
import { decideCompanyScope } from '../source-scope-policy';
import { CsvRowReader, normalizeHeader, parseCsv } from '../adapters/csv-utils';
import {
  EMPTY_SUPPLIER_ORDER_IMPORT_OVERRIDES,
  type SupplierOrderImportOverrides,
} from './supplier-order-import-overrides';
import type {
  DuplicateDecision,
  OrderImportPlanRow,
  OrderLineImportPlanRow,
  SourceEvidence,
  SourceReconciliation,
  SupplierAccountImportPlanRow,
  SupplierImportPlanRow,
  SupplierOrderImportIssue,
  SupplierOrderImportPlan,
  SupplierOrderSourceFile,
  SupplierOrderSourceRole,
  SupplierProductImportPlanRow,
} from './supplier-order-import-types';

export type {
  OrderImportPlanRow,
  OrderLineImportPlanRow,
  SupplierOrderImportPlan,
  SupplierOrderSourceFile,
  SupplierOrderSourceRole,
  SupplierProductImportPlanRow,
} from './supplier-order-import-types';

const REQUIRED_SOURCE_ROLES: SupplierOrderSourceRole[] = ['supplier_ids', 'purchase_orders', 'order_details'];

export const EXPECTED_SOURCE_HEADERS: Record<SupplierOrderSourceRole, readonly string[]> = {
  supplier_ids: ['SR ID', 'Supplier Name'],
  supplier_tracker: [
    'Timestamp',
    'SR ID',
    'Supplier Name',
    'PR Portal Link',
    'Username',
    'pass',
    'Contact Person',
    'Reached Via',
    'Recieved Email',
    'Remarks',
    'Designation',
    'Email Done?',
    'Call Done?',
    'Responded By',
    'EF Sent Status',
    'SS Sent Status',
    'MX Sent Status',
    'RH Sent Status',
    'Feedback',
    'Status',
    'Date of Update',
    'Used',
    'Tasks Submitted',
    'Current Status',
    'Remarks ( Analysed / facing any issue ) ',
    'Supplier Type',
    'Presence on Amazon',
    '',
    '',
    '',
    '',
    '',
  ],
  purchase_orders: [
    'Timestamp',
    'Order ID',
    'SR ID ',
    'Supplier',
    'Company',
    'Exp. Cost ',
    'NOP',
    'Placed By',
    'Market ',
    'PO approval',
    'Order status',
    'Payment Status ',
    'TS',
    'Payment Mode',
    'Invoice Status',
    'Shipping Carrier',
    'Invoice No',
    'Tracking ID',
    'Act. Cost',
    'Date of Payment',
    'Remarks',
    'Total units',
    'Invoice Upload Link',
    'Shipping Location',
    'OR Status',
    'OR Status Date',
    'NOD since ordered',
    'Exp. Delivery Date ',
    'Prep Status ',
  ],
  order_details: [
    'Order ID',
    'Timestamp',
    'Company',
    'SR ID',
    'Supplier',
    'Brand ',
    'ASIN',
    'UPC',
    'SKU',
    'Qty',
    'PPU',
    'Pack size',
    'Exp. Margin',
    'MAP',
    'Order type',
    'OD by',
    'SA by',
    'Shipment',
    'S.Price',
    'Total Cost',
    'AM Status',
    'Lead time(day)',
    'Remarks',
    'T.Profit',
    'Invoice No',
    'Order status',
    'ETA on Amazon',
    'AM Remarks',
    'Qty in Prep or Reserved',
    'Priority ',
    'Seasonal',
    'COO Remarks',
    'COO status',
    'PO Status',
    'Possible Profit',
    '',
  ],
};

export const REQUIRED_SOURCE_HEADERS: Record<SupplierOrderSourceRole, readonly string[]> = {
  supplier_ids: ['SR ID', 'Supplier Name'],
  supplier_tracker: ['SR ID'],
  purchase_orders: ['Timestamp', 'Order ID', 'SR ID', 'Company', 'PO approval', 'Order status'],
  order_details: ['Order ID', 'Company', 'SR ID', 'ASIN', 'Qty'],
};

interface ParsedSource {
  file: SupplierOrderSourceFile;
  content: string;
  sha256: string;
  headers: string[];
  rows: Record<string, string>[];
}

interface ParsedPurchaseOrder {
  sourceRow: number;
  identity: string;
  companyKey: string;
  externalOrderId: string;
  externalSupplierCode: string;
  sourceExternalSupplierCode: string;
  orderDate?: string;
  sourceMarketplace?: string;
  sourceOrderStatus?: string;
  orderApproval?: string;
  paymentStatus?: string;
  paymentMode?: string;
  paymentDate?: string;
  placedBy?: string;
  invoiceStatus?: string;
  prepStatus?: string;
  expectedCost?: number;
  actualCost?: number;
  expectedDeliveryDate?: string;
  shippingCarrier?: string;
  trackingId?: string;
  invoiceReference?: string;
  remarks?: string;
  evidence: SourceEvidence;
}

export function text(value: unknown) {
  const result = String(value ?? '')
    .normalize('NFKC')
    .trim();
  return result || undefined;
}

function comparisonKey(value: unknown) {
  return (
    text(value)
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '') ?? ''
  );
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

export function computeSupplierOrderImportPlanDigest(
  planValue: SupplierOrderImportPlan | Omit<SupplierOrderImportPlan, 'digest'>,
) {
  const { digest: _digest, ...plan } = planValue as SupplierOrderImportPlan;
  return sha256(
    canonical({
      ...plan,
      sourceFiles: plan.sourceFiles.map(({ modifiedAt: _modifiedAt, name: _name, ...sourceFile }) => sourceFile),
      orderLines: plan.orderLines.map(
        ({
          companyProductFamilyId: _companyProductFamilyId,
          companyProductId: _companyProductId,
          supplierProductId: _supplierProductId,
          mappingScope: _mappingScope,
          mappingReason: _mappingReason,
          sourceSkuType: _sourceSkuType,
          familyResolution: _familyResolution,
          ...line
        }) => line,
      ),
    }),
  );
}

function sourceEvidence(source: ParsedSource, row: Record<string, string>, rowNumber: number): SourceEvidence {
  return {
    file: source.file.role,
    sheet: source.file.role,
    row: rowNumber,
    hash: sha256(canonical(row)),
  };
}

export function normalizeExternalSupplierCode(value: unknown) {
  const normalized = text(value)
    ?.toUpperCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, '');
  return normalized && /^(?:SR|SRO)-[0-9]+$/.test(normalized) ? normalized : undefined;
}

export function normalizeExternalOrderId(value: unknown) {
  const normalized = text(value)?.toUpperCase().replace(/\s+/g, '');
  return normalized && /^(?:EF|MX|RH|SS)[A-Z0-9]+$/.test(normalized) ? normalized : undefined;
}

function hasCanonicalCompanyPrefix(value: unknown) {
  return /^(?:EF|MX|RH|SS)/.test(text(value)?.toUpperCase().replace(/\s+/g, '') ?? '');
}

export function normalizeSourceAsin(value: unknown) {
  const normalized = text(value)
    ?.toUpperCase()
    .replace(/[\p{Cc}\p{Cf}\s]/gu, '');
  return normalized && /^[A-Z0-9]{10}$/.test(normalized) ? normalized : undefined;
}

export function parseNumber(value: unknown) {
  const raw = text(value);
  if (!raw || raw === '#N/A') return { value: undefined, valid: true };
  const normalized = raw
    .replace(/[$£€,%]/g, '')
    .replace(/,/g, '')
    .trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? { value: parsed, valid: true } : { value: undefined, valid: false };
}

export function parseDate(value: unknown, format: 'day-first' | 'month-first' = 'day-first') {
  const raw = text(value);
  if (!raw) return { value: undefined, valid: true };
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const local = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (local) {
    year = Number(local[3]);
    if (year < 100) year += 2000;
    month = Number(format === 'day-first' ? local[2] : local[1]);
    day = Number(format === 'day-first' ? local[1] : local[2]);
  } else {
    return { value: undefined, valid: false };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { value: undefined, valid: false };
  }
  return { value: date.toISOString().slice(0, 10), valid: true };
}

function normalizeMarketplace(value: unknown) {
  const normalized = text(value)?.toUpperCase().replace(/\s+/g, '');
  if (normalized === 'US' || normalized === 'USA') return 'US';
  if (normalized === 'UK') return 'UK';
  return undefined;
}

function applySupplierCodeOverride(code: string, overrides: SupplierOrderImportOverrides) {
  return overrides.supplierIds[code]?.acceptedCode ?? code;
}

function parseSources(files: SupplierOrderSourceFile[]) {
  for (const role of REQUIRED_SOURCE_ROLES) {
    const count = files.filter((file) => file.role === role).length;
    if (count !== 1) throw new Error(`Supplier/order import requires one ${role} source; received ${count}.`);
  }
  for (const role of [...new Set(files.map((file) => file.role))]) {
    const count = files.filter((file) => file.role === role).length;
    if (count > 1) throw new Error(`Supplier/order import received duplicate ${role} sources.`);
  }
  return files
    .map((file): ParsedSource => {
      const content = typeof file.content === 'string' ? file.content : Buffer.from(file.content).toString('utf8');
      const parsed = parseCsv(content);
      const actualHeaders = new Set(parsed.headers.map(normalizeHeader));
      const missing = REQUIRED_SOURCE_HEADERS[file.role].filter(
        (header) => !actualHeaders.has(normalizeHeader(header)),
      );
      if (missing.length) {
        throw new Error(
          `Supplier/order import source ${file.name} is missing required columns: ${missing.join(', ')}.`,
        );
      }
      return { file, content, sha256: sha256(content), headers: parsed.headers, rows: parsed.rows };
    })
    .sort((left, right) => compareText(left.file.role, right.file.role));
}

function reconciliation(
  role: SupplierOrderSourceRole,
  inputRows: number,
  acceptedRows: number,
  issues: SupplierOrderImportIssue[],
): SourceReconciliation {
  const relevant = issues.filter((issue) => issue.sourceFile === role);
  return {
    role,
    inputRows,
    acceptedRows,
    excludedRows: relevant.filter((issue) => issue.disposition === 'excluded').length,
    blockedRows: relevant.filter((issue) => issue.disposition === 'blocked').length,
    reasonCounts: Object.fromEntries(
      [...new Set(relevant.map((issue) => issue.reason))]
        .sort()
        .map((reason) => [reason, relevant.filter((issue) => issue.reason === reason).length]),
    ),
  };
}

function issue(
  issues: SupplierOrderImportIssue[],
  source: SupplierOrderSourceRole,
  sourceRow: number,
  reason: string,
  disposition: 'excluded' | 'blocked' | 'review',
  externalKey?: string,
  field?: string,
) {
  issues.push({
    severity: disposition === 'blocked' ? 'blocked' : disposition === 'review' ? 'review' : 'info',
    sourceFile: source,
    sourceRow,
    externalKey,
    field,
    reason,
    disposition,
  });
}

export interface SupplierOrderExclusionSummary {
  excludedRows: number;
  blockedRows: number;
  reviewRows: number;
  excludedByReason: Record<string, number>;
  blockedByReason: Record<string, number>;
}

/**
 * Aggregate every row the plan excluded/blocked/flagged, keyed `<source>:<reason>`, so the
 * run/preview summary can surface silent drops — a mass exclusion can never look like a
 * clean success.
 */
export function summarizeSupplierOrderExclusions(issues: SupplierOrderImportIssue[]): SupplierOrderExclusionSummary {
  const excludedByReason: Record<string, number> = {};
  const blockedByReason: Record<string, number> = {};
  let excludedRows = 0;
  let blockedRows = 0;
  let reviewRows = 0;
  for (const item of issues) {
    const key = `${item.sourceFile}:${item.reason}`;
    if (item.disposition === 'excluded') {
      excludedRows += 1;
      excludedByReason[key] = (excludedByReason[key] ?? 0) + 1;
    } else if (item.disposition === 'blocked') {
      blockedRows += 1;
      blockedByReason[key] = (blockedByReason[key] ?? 0) + 1;
    } else if (item.disposition === 'review') {
      reviewRows += 1;
    }
  }
  return { excludedRows, blockedRows, reviewRows, excludedByReason, blockedByReason };
}

function preferredSourceName(names: string[]) {
  const counts = new Map<string, { displayName: string; count: number }>();
  for (const name of names) {
    const key = comparisonKey(name);
    if (!key) continue;
    const current = counts.get(key);
    counts.set(key, {
      displayName: [current?.displayName, name].filter(Boolean).sort()[0]!,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...counts.values()].sort(
    (left, right) => right.count - left.count || compareText(left.displayName, right.displayName),
  )[0]?.displayName;
}

function purchaseEvidenceStatus(order: ParsedPurchaseOrder): OrderImportPlanRow['purchaseEvidenceStatus'] {
  const approval = comparisonKey(order.orderApproval);
  const status = comparisonKey(order.sourceOrderStatus);
  const payment = comparisonKey(order.paymentStatus);
  const invoice = comparisonKey(order.invoiceStatus);
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  const affirmative =
    ['completed', 'inprogress', 'ordered'].includes(status) ||
    ['completed', 'paid', 'inprogress'].includes(payment) ||
    ['uploaded', 'paid'].includes(invoice) ||
    order.actualCost !== undefined ||
    Boolean(order.trackingId || order.invoiceReference);
  if (approval === 'rejected' || status === 'rejected') return affirmative ? 'unknown' : 'rejected';
  return affirmative ? 'confirmed' : 'unknown';
}

function purchaseBusinessFacts(row: ParsedPurchaseOrder) {
  const { sourceRow: _sourceRow, identity: _identity, evidence: _evidence, ...facts } = row;
  return canonical(facts);
}

function normalizeLineReference(value: unknown) {
  return text(value)
    ?.toUpperCase()
    .replace(/[\p{Cc}\p{Cf}\s]/gu, '');
}

function lineIdentity(
  line: Pick<OrderLineImportPlanRow, 'companyKey' | 'externalOrderId' | 'asin' | 'supplierSku' | 'upc'>,
) {
  const sku = normalizeLineReference(line.supplierSku);
  const upc = normalizeLineReference(line.upc);
  const reference = sku ? `SKU:${sku}` : upc ? `UPC:${upc}` : undefined;
  return reference ? `${line.companyKey}:${line.externalOrderId}:${line.asin}:${reference}` : undefined;
}

function lineBusinessFacts(line: OrderLineImportPlanRow) {
  const { sourceEvidence: _sourceEvidence, sourceLineKey: _sourceLineKey, lineOrdinal: _lineOrdinal, ...facts } = line;
  return canonical({
    ...facts,
    supplierSku: normalizeLineReference(facts.supplierSku),
    upc: normalizeLineReference(facts.upc),
  });
}

function withEvidenceRows(line: OrderLineImportPlanRow, rows: SourceEvidence[]) {
  const evidence = line.sourceEvidence;
  return { ...line, sourceEvidence: { ...evidence, rows: [...rows].sort((a, b) => compareText(a.hash, b.hash)) } };
}

export function buildSupplierOrderImportPlan(params: {
  files: SupplierOrderSourceFile[];
  asOfDate: string;
  overrides?: SupplierOrderImportOverrides;
}): SupplierOrderImportPlan {
  const overrides = params.overrides ?? EMPTY_SUPPLIER_ORDER_IMPORT_OVERRIDES;
  const sources = parseSources(params.files);
  const byRole = new Map(sources.map((source) => [source.file.role, source]));
  const issues: SupplierOrderImportIssue[] = [];
  const supplierSource = byRole.get('supplier_ids')!;
  const masterRows = new Map<string, Array<{ name?: string; evidence: SourceEvidence }>>();
  for (const [index, row] of supplierSource.rows.entries()) {
    const sourceRow = index + 2;
    const rawCode = normalizeExternalSupplierCode(new CsvRowReader(row).string('SR ID'));
    if (!rawCode) {
      issue(issues, 'supplier_ids', sourceRow, 'supplier_id_invalid_or_missing', 'excluded', undefined, 'SR ID');
      continue;
    }
    const code = applySupplierCodeOverride(rawCode, overrides);
    masterRows.set(code, [
      ...(masterRows.get(code) ?? []),
      { name: new CsvRowReader(row).string('Supplier Name'), evidence: sourceEvidence(supplierSource, row, sourceRow) },
    ]);
  }

  const supplierCodeOverrides = Object.entries(overrides.supplierIds)
    .map(([rejectedCode, decision]) => ({
      rejectedCode,
      acceptedCode: decision.acceptedCode,
      normalizedName: comparisonKey(
        preferredSourceName((masterRows.get(decision.acceptedCode) ?? []).flatMap((row) => row.name ?? [])),
      ),
    }))
    .sort((left, right) => compareText(left.rejectedCode, right.rejectedCode));

  const trackerSource = byRole.get('supplier_tracker');
  const trackerRows = new Map<
    string,
    Array<{ row: Record<string, string>; sourceRow: number; date?: string; name?: string; evidence: SourceEvidence }>
  >();
  const supplierProductsByKey = new Map<string, SupplierProductImportPlanRow>();
  let acceptedTrackerRows = 0;
  for (const [index, row] of (trackerSource?.rows ?? []).entries()) {
    const sourceRow = index + 2;
    const reader = new CsvRowReader(row);
    const rawCode = normalizeExternalSupplierCode(reader.string('SR ID'));
    if (!rawCode) {
      issue(
        issues,
        'supplier_tracker',
        sourceRow,
        'tracker_supplier_id_invalid_or_missing',
        'excluded',
        undefined,
        'SR ID',
      );
      continue;
    }
    const code = applySupplierCodeOverride(rawCode, overrides);
    if (!masterRows.has(code)) {
      issue(issues, 'supplier_tracker', sourceRow, 'tracker_supplier_not_in_master', 'excluded', code, 'SR ID');
      continue;
    }
    acceptedTrackerRows += 1;
    const date = parseDate(
      reader.string('Date of Update', 'Timestamp'),
      trackerSource!.file.dateFormat ?? 'month-first',
    ).value;
    const evidence = sourceEvidence(trackerSource!, row, sourceRow);
    trackerRows.set(code, [
      ...(trackerRows.get(code) ?? []),
      { row, sourceRow, date, name: reader.string('Supplier Name'), evidence },
    ]);
    const asin = normalizeSourceAsin(reader.string('ASIN'));
    if (asin) {
      const key = `${code}:${asin}`;
      const moq = parseNumber(reader.string('MOQ')).value;
      supplierProductsByKey.set(key, {
        externalSupplierCode: code,
        asin,
        moq,
        lastPriceUpdateDate: date,
        sourceEvidence: evidence,
      });
    }
  }

  const supplierNameOverrides: SupplierOrderImportPlan['supplierNameOverrides'] = [];
  const suppliers: SupplierImportPlanRow[] = [];
  for (const [code, rows] of [...masterRows.entries()].sort(([left], [right]) => compareText(left, right))) {
    const tracker = [...(trackerRows.get(code) ?? [])].sort(
      (left, right) => compareText(right.date ?? '', left.date ?? '') || right.sourceRow - left.sourceRow,
    );
    const sourceNames = [
      ...new Set(rows.map((row) => text(row.name)).filter((name): name is string => Boolean(name))),
    ].sort();
    const trackerName = tracker.find((row) => text(row.name))?.name;
    const nameOverride = overrides.supplierNames[code];
    const displayName = nameOverride?.displayName ?? trackerName ?? preferredSourceName(sourceNames) ?? code;
    if (nameOverride) {
      supplierNameOverrides.push({
        externalSupplierCode: code,
        displayName,
        sourceNames,
        reason: nameOverride.reason,
      });
    }
    const selectedTracker = tracker[0];
    const selectedReader = new CsvRowReader(selectedTracker?.row ?? {});
    const emails = [
      ...new Set(
        tracker
          .map((candidate) => new CsvRowReader(candidate.row).string('Recieved Email', 'Received Email'))
          .filter((email): email is string => Boolean(email)),
      ),
    ];
    const primaryEmail = selectedReader.string('Recieved Email', 'Received Email') ?? emails[0];
    suppliers.push({
      sourceSystem: 'supplier_ids',
      externalSupplierCode: code,
      normalizedExternalSupplierCode: code,
      displayName,
      normalizedName: normalizeSupplierName(displayName),
      aliases: sourceNames.filter((name) => comparisonKey(name) !== comparisonKey(displayName)),
      primaryEmail,
      additionalEmails: emails.filter((email) => email !== primaryEmail),
      additionalPhones: [],
      contactName: selectedReader.string('Contact Person'),
      contactNotes: selectedReader.string('Remarks'),
      supplierUrl: selectedReader.string('PR Portal Link'),
      activeStatus: selectedReader.string('Current Status', 'Active Status'),
      supplierType: selectedReader.string('Supplier Type'),
      amazonPresence: selectedReader.string('Presence on Amazon'),
      reachedVia: selectedReader.string('Reached Via'),
      receivedEmail: primaryEmail,
      designation: selectedReader.string('Designation'),
      category: selectedReader.string('Category'),
      amazonAllowed: comparisonKey(selectedReader.string('Amazon Allow')) === 'yes' ? true : undefined,
      lastAnalysedBy: selectedReader.string('SA By'),
      trackingStatus: selectedReader.string('Status'),
      dateOfUpdate: selectedTracker?.date,
      analysisProgress: selectedReader.string('Status'),
      remarksAnalysed: selectedReader.string('Remarks ( Analysed / facing any issue )'),
      sourceEvidence: { rows: [...rows.map((row) => row.evidence), ...tracker.map((row) => row.evidence)] },
    });
  }

  const supplierCodesByName = new Map<string, Set<string>>();
  for (const supplier of suppliers) {
    supplierCodesByName.set(
      supplier.normalizedName,
      new Set([...(supplierCodesByName.get(supplier.normalizedName) ?? []), supplier.externalSupplierCode]),
    );
  }
  const duplicateSupplierNames = [...supplierCodesByName.entries()]
    .filter(([, codes]) => codes.size > 1)
    .map(([normalizedName, codes]) => ({ normalizedName, externalSupplierCodes: [...codes].sort() }))
    .sort((left, right) => compareText(left.normalizedName, right.normalizedName));

  const poSource = byRole.get('purchase_orders')!;
  const purchaseGroups = new Map<string, ParsedPurchaseOrder[]>();
  for (const [index, row] of poSource.rows.entries()) {
    const sourceRow = index + 2;
    const reader = new CsvRowReader(row);
    const rawOrderId = reader.string('Order ID');
    const externalOrderId = normalizeExternalOrderId(rawOrderId);
    if (!externalOrderId) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        rawOrderId && hasCanonicalCompanyPrefix(rawOrderId)
          ? 'order_id_invalid_or_missing'
          : 'row_blank_or_out_of_scope',
        rawOrderId && hasCanonicalCompanyPrefix(rawOrderId) ? 'blocked' : 'excluded',
        undefined,
        'Order ID',
      );
      continue;
    }
    const scope = decideCompanyScope({
      source: 'legacy_csv',
      explicitCompany: reader.string('Company'),
      orderRef: externalOrderId,
    });
    if (scope.disposition !== 'accept' || !scope.companyKey) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        scope.reasonCode,
        scope.reasonCode === 'company_evidence_conflict' ? 'blocked' : 'excluded',
        externalOrderId,
        'Company',
      );
      continue;
    }
    const supplierCodeInput = reader.string('SR ID');
    if (!supplierCodeInput) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        'purchase_order_supplier_id_missing',
        'excluded',
        externalOrderId,
        'SR ID',
      );
      continue;
    }
    const rawSupplierCode = normalizeExternalSupplierCode(supplierCodeInput);
    if (!rawSupplierCode) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        'purchase_order_supplier_id_invalid',
        'blocked',
        externalOrderId,
        'SR ID',
      );
      continue;
    }
    const externalSupplierCode = applySupplierCodeOverride(rawSupplierCode, overrides);
    if (!masterRows.has(externalSupplierCode)) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        'purchase_order_supplier_not_in_master',
        'blocked',
        externalOrderId,
        'SR ID',
      );
      continue;
    }
    const orderDate = parseDate(reader.string('Timestamp'), poSource.file.dateFormat ?? 'day-first');
    const expectedDeliveryDate = parseDate(
      reader.string('Exp. Delivery Date'),
      poSource.file.dateFormat ?? 'day-first',
    );
    const paymentDate = parseDate(reader.string('Date of Payment'), poSource.file.dateFormat ?? 'day-first');
    const expectedCost = parseNumber(reader.string('Exp. Cost'));
    const actualCost = parseNumber(reader.string('Act. Cost'));
    if (!orderDate.valid) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        'purchase_order_date_invalid',
        'blocked',
        externalOrderId,
        'Timestamp',
      );
      continue;
    }
    if (!expectedDeliveryDate.valid) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        'purchase_order_optional_delivery_date_invalid',
        'review',
        externalOrderId,
        'Exp. Delivery Date',
      );
    }
    if (!paymentDate.valid) {
      issue(
        issues,
        'purchase_orders',
        sourceRow,
        'purchase_order_optional_payment_date_invalid',
        'review',
        externalOrderId,
        'Date of Payment',
      );
    }
    if (!expectedCost.valid || !actualCost.valid) {
      issue(issues, 'purchase_orders', sourceRow, 'purchase_order_optional_money_invalid', 'review', externalOrderId);
    }
    const identity = `${scope.companyKey}:${externalOrderId}`;
    const parsed: ParsedPurchaseOrder = {
      sourceRow,
      identity,
      companyKey: scope.companyKey,
      externalOrderId,
      externalSupplierCode,
      sourceExternalSupplierCode: rawSupplierCode,
      orderDate: orderDate.value,
      sourceMarketplace: normalizeMarketplace(reader.string('Market')),
      sourceOrderStatus: reader.string('Order status'),
      orderApproval: reader.string('PO approval'),
      paymentStatus: reader.string('Payment Status'),
      paymentMode: reader.string('Payment Mode'),
      paymentDate: paymentDate.value,
      placedBy: reader.string('Placed By'),
      invoiceStatus: reader.string('Invoice Status'),
      prepStatus: reader.string('Prep Status'),
      expectedCost: expectedCost.value,
      actualCost: actualCost.value,
      expectedDeliveryDate: expectedDeliveryDate.value,
      shippingCarrier: reader.string('Shipping Carrier'),
      trackingId: reader.string('Tracking ID'),
      invoiceReference: reader.string('Invoice No'),
      remarks: reader.string('Remarks'),
      evidence: sourceEvidence(poSource, row, sourceRow),
    };
    purchaseGroups.set(identity, [...(purchaseGroups.get(identity) ?? []), parsed]);
  }

  const duplicatePurchaseOrders: DuplicateDecision[] = [];
  const selectedPurchaseOrders: ParsedPurchaseOrder[] = [];
  const blockedOrderIds: SupplierOrderImportPlan['blockedOrderIds'] = [];
  for (const [identity, rows] of [...purchaseGroups.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (rows.length === 1) {
      selectedPurchaseOrders.push(rows[0]);
      continue;
    }
    const factGroups = new Map<string, ParsedPurchaseOrder[]>();
    for (const row of rows)
      factGroups.set(purchaseBusinessFacts(row), [...(factGroups.get(purchaseBusinessFacts(row)) ?? []), row]);
    if (factGroups.size === 1) {
      const selected = [...rows].sort((left, right) => left.sourceRow - right.sourceRow)[0];
      selectedPurchaseOrders.push(selected);
      duplicatePurchaseOrders.push({
        identity,
        sourceRows: rows.map((row) => row.sourceRow).sort((left, right) => left - right),
        sourceHashes: rows.map((row) => row.evidence.hash).sort(),
        selectedRowNumber: selected.sourceRow,
        selectedSourceHash: selected.evidence.hash,
        disposition: 'collapsed_exact',
        reason: 'All canonical business facts are identical.',
      });
      for (const row of rows) {
        if (row.sourceRow !== selected.sourceRow) {
          issue(
            issues,
            'purchase_orders',
            row.sourceRow,
            'exact_duplicate_purchase_order_collapsed',
            'excluded',
            identity,
          );
        }
      }
      continue;
    }
    const decision = overrides.purchaseOrders[identity];
    const selected = decision && rows.find((row) => row.sourceRow === decision.selectedRowNumber);
    if (!selected) {
      duplicatePurchaseOrders.push({
        identity,
        sourceRows: rows.map((row) => row.sourceRow).sort((left, right) => left - right),
        sourceHashes: rows.map((row) => row.evidence.hash).sort(),
        disposition: 'blocked',
        reason: decision
          ? 'Override selected a row outside this duplicate group.'
          : 'Non-equivalent duplicate requires an override.',
      });
      blockedOrderIds.push({ externalOrderId: rows[0].externalOrderId, reason: 'duplicate_purchase_order_unresolved' });
      issue(issues, 'purchase_orders', rows[0].sourceRow, 'duplicate_purchase_order_unresolved', 'blocked', identity);
      continue;
    }
    selectedPurchaseOrders.push(selected);
    duplicatePurchaseOrders.push({
      identity,
      sourceRows: rows.map((row) => row.sourceRow).sort((left, right) => left - right),
      sourceHashes: rows.map((row) => row.evidence.hash).sort(),
      selectedRowNumber: selected.sourceRow,
      selectedSourceHash: selected.evidence.hash,
      disposition: 'selected_override',
      reason: decision.reason,
    });
    for (const row of rows) {
      if (row.sourceRow !== selected.sourceRow) {
        issue(
          issues,
          'purchase_orders',
          row.sourceRow,
          'duplicate_purchase_order_row_not_selected',
          'excluded',
          identity,
        );
      }
    }
  }

  const orders: OrderImportPlanRow[] = selectedPurchaseOrders
    .map((order) => ({
      externalOrderId: order.externalOrderId,
      companyKey: order.companyKey,
      externalSupplierCode: order.externalSupplierCode,
      sourceExternalSupplierCode: order.sourceExternalSupplierCode,
      orderDate: order.orderDate,
      sourceMarketplace: order.sourceMarketplace,
      recordType: 'purchase_order' as const,
      purchaseEvidenceStatus: purchaseEvidenceStatus(order),
      sourceOrderStatus: order.sourceOrderStatus,
      orderApproval: order.orderApproval,
      paymentStatus: order.paymentStatus,
      paymentMode: order.paymentMode,
      paymentDate: order.paymentDate,
      placedBy: order.placedBy,
      invoiceStatus: order.invoiceStatus,
      prepStatus: order.prepStatus,
      expectedCost: order.expectedCost,
      actualCost: order.actualCost,
      expectedDeliveryDate: order.expectedDeliveryDate,
      shippingCarrier: order.shippingCarrier,
      trackingId: order.trackingId,
      invoiceReference: order.invoiceReference,
      remarks: order.remarks,
      sourceEvidence: { purchaseOrders: purchaseGroups.get(order.identity)!.map((candidate) => candidate.evidence) },
    }))
    .sort(
      (left, right) =>
        compareText(left.companyKey, right.companyKey) || compareText(left.externalOrderId, right.externalOrderId),
    );
  const orderByIdentity = new Map(orders.map((order) => [`${order.companyKey}:${order.externalOrderId}`, order]));

  const supplierAccountsByKey = new Map<string, SupplierAccountImportPlanRow>();
  for (const order of orders) {
    const key = `${order.externalSupplierCode}:${order.companyKey}`;
    supplierAccountsByKey.set(key, {
      externalSupplierCode: order.externalSupplierCode,
      companyKey: order.companyKey,
      accountName: key,
      accountType: 'ordering_relationship',
      market: order.sourceMarketplace,
      metadata: { source: 'canonical_purchase_order' },
    });
  }
  for (const [externalSupplierCode, candidates] of trackerRows) {
    for (const candidate of [...candidates].sort(
      (left, right) => compareText(right.date ?? '', left.date ?? '') || right.sourceRow - left.sourceRow,
    )) {
      const reader = new CsvRowReader(candidate.row);
      const scope = decideCompanyScope({ source: 'legacy_csv', explicitCompany: reader.string('Reached Via') });
      if (scope.disposition !== 'accept' || !scope.companyKey) continue;
      const key = `${externalSupplierCode}:${scope.companyKey}`;
      if (supplierAccountsByKey.get(key)?.metadata.source === 'supplier_2026') continue;
      const existing = supplierAccountsByKey.get(key);
      const email = reader.string('Recieved Email', 'Received Email');
      supplierAccountsByKey.set(key, {
        ...existing,
        externalSupplierCode,
        companyKey: scope.companyKey,
        accountName: key,
        accountType: 'ordering_relationship',
        contactName: reader.string('Contact Person'),
        email,
        preferredContactMethod: email ? 'email' : undefined,
        portalUrl: reader.string('PR Portal Link'),
        loginUsername: reader.string('Username'),
        loginSecret: reader.string('pass'),
        metadata: { source: 'supplier_2026' },
      });
    }
  }
  const supplierAccounts = [...supplierAccountsByKey.values()].sort(
    (left, right) =>
      compareText(left.externalSupplierCode, right.externalSupplierCode) ||
      compareText(left.companyKey, right.companyKey),
  );

  const detailSource = byRole.get('order_details')!;
  const candidateLines: OrderLineImportPlanRow[] = [];
  const headerless = new Map<string, string>();
  const matchedOrderIds = new Set<string>();
  const detailsByOrder = new Set<string>();
  let supplierMismatchCount = 0;
  let companyMismatchCount = 0;
  for (const [index, row] of detailSource.rows.entries()) {
    const sourceRow = index + 2;
    const reader = new CsvRowReader(row);
    if (overrides.excludedOrderDetailRows[String(sourceRow)]) {
      issue(
        issues,
        'order_details',
        sourceRow,
        'order_detail_explicitly_excluded',
        'excluded',
        reader.string('Order ID'),
      );
      continue;
    }
    const rawOrderId = reader.string('Order ID');
    const externalOrderId = normalizeExternalOrderId(rawOrderId);
    if (!externalOrderId) {
      issue(
        issues,
        'order_details',
        sourceRow,
        rawOrderId && hasCanonicalCompanyPrefix(rawOrderId)
          ? 'order_detail_order_id_invalid_or_missing'
          : 'row_blank_or_out_of_scope',
        rawOrderId && hasCanonicalCompanyPrefix(rawOrderId) ? 'blocked' : 'excluded',
        undefined,
        'Order ID',
      );
      continue;
    }
    const scope = decideCompanyScope({
      source: 'legacy_csv',
      explicitCompany: reader.string('Company'),
      orderRef: externalOrderId,
    });
    if (scope.disposition !== 'accept' || !scope.companyKey) {
      if (scope.reasonCode === 'company_evidence_conflict') companyMismatchCount += 1;
      issue(
        issues,
        'order_details',
        sourceRow,
        scope.reasonCode,
        scope.reasonCode === 'company_evidence_conflict' ? 'blocked' : 'excluded',
        externalOrderId,
        'Company',
      );
      continue;
    }
    const supplierCodeInput = reader.string('SR ID');
    if (!supplierCodeInput) {
      issue(
        issues,
        'order_details',
        sourceRow,
        'order_detail_supplier_id_missing',
        'excluded',
        externalOrderId,
        'SR ID',
      );
      continue;
    }
    const rawSupplierCode = normalizeExternalSupplierCode(supplierCodeInput);
    if (!rawSupplierCode) {
      issue(
        issues,
        'order_details',
        sourceRow,
        'order_detail_supplier_id_invalid',
        'blocked',
        externalOrderId,
        'SR ID',
      );
      continue;
    }
    const asin = normalizeSourceAsin(reader.string('ASIN'));
    const quantity = parseNumber(reader.string('Qty'));
    if (!asin || !quantity.valid || quantity.value === undefined || quantity.value <= 0) {
      issue(issues, 'order_details', sourceRow, 'order_detail_required_field_invalid', 'blocked', externalOrderId);
      continue;
    }
    const externalSupplierCode = applySupplierCodeOverride(rawSupplierCode, overrides);
    const identity = `${scope.companyKey}:${externalOrderId}`;
    detailsByOrder.add(identity);
    const order = orderByIdentity.get(identity);
    if (!order) {
      headerless.set(identity, 'purchase_order_header_missing');
      issue(issues, 'order_details', sourceRow, 'purchase_order_header_missing', 'excluded', identity);
      continue;
    }
    if (order.externalSupplierCode !== externalSupplierCode) {
      supplierMismatchCount += 1;
      const excluded = overrides.excludedOrderDetailRows[String(sourceRow)];
      issue(
        issues,
        'order_details',
        sourceRow,
        excluded ? 'header_detail_supplier_conflict_overridden_exclusion' : 'header_detail_supplier_conflict',
        excluded ? 'excluded' : 'blocked',
        identity,
        'SR ID',
      );
      continue;
    }
    const unitCost = parseNumber(reader.string('PPU'));
    const totalCost = parseNumber(reader.string('Total Cost'));
    const supplierPackSize = parseNumber(reader.string('Pack size'));
    const leadTimeDays = parseNumber(reader.string('Lead time(day)'));
    const mapPrice = parseNumber(reader.string('MAP'));
    // Order Create/View UI (T2): sheet columns that exist but the importer skipped.
    // parseNumber strips the '%' on Exp. Margin and currency symbols on money.
    const expectedSellPrice = parseNumber(reader.string('S.Price'));
    const expectedMargin = parseNumber(reader.string('Exp. Margin'));
    const expectedProfit = parseNumber(reader.string('T.Profit'));
    if (
      !unitCost.valid ||
      !totalCost.valid ||
      !supplierPackSize.valid ||
      !leadTimeDays.valid ||
      !mapPrice.valid ||
      !expectedSellPrice.valid ||
      !expectedMargin.valid ||
      !expectedProfit.valid
    ) {
      issue(issues, 'order_details', sourceRow, 'order_detail_optional_numeric_field_invalid', 'review', identity);
    }
    const evidence = sourceEvidence(detailSource, row, sourceRow);
    const line: OrderLineImportPlanRow = {
      externalOrderId,
      companyKey: scope.companyKey,
      lineOrdinal: 0,
      sourceLineKey: '',
      externalSupplierCode,
      asin,
      sourceMarketplace: order.sourceMarketplace,
      upc: reader.string('UPC'),
      supplierSku: reader.string('SKU'),
      orderQty: quantity.value,
      expectedCost: totalCost.value,
      unitCost: unitCost.value,
      supplierPackSize: supplierPackSize.value,
      leadTimeDays: leadTimeDays.value,
      mapPrice: mapPrice.value,
      expectedSellPrice: expectedSellPrice.value,
      expectedMargin: expectedMargin.value,
      expectedProfit: expectedProfit.value,
      amazonCheckStatus: reader.string('AM Status'),
      shipmentFlag: reader.string('Shipment'),
      priority: reader.string('Priority'),
      orderType: reader.string('Order type'),
      poStatus: comparisonKey(reader.string('PO Status')) === 'addedtopo' ? 'added_to_po' : 'not_added_to_po',
      sourceEvidence: { ...evidence, rows: [evidence] },
    };
    const canonicalIdentity = lineIdentity(line);
    if (!canonicalIdentity) {
      issue(issues, 'order_details', sourceRow, 'order_detail_line_reference_missing', 'blocked', identity, 'SKU/UPC');
      continue;
    }
    candidateLines.push({ ...line, sourceLineKey: canonicalIdentity });
    matchedOrderIds.add(identity);
  }

  const duplicateOrderLines: DuplicateDecision[] = [];
  const selectedLines: OrderLineImportPlanRow[] = [];
  const lineGroups = new Map<string, OrderLineImportPlanRow[]>();
  for (const line of candidateLines) {
    lineGroups.set(line.sourceLineKey, [...(lineGroups.get(line.sourceLineKey) ?? []), line]);
  }
  for (const [identity, rows] of [...lineGroups.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (rows.length === 1) {
      selectedLines.push(rows[0]);
      continue;
    }
    const rowsBySourcePosition = [...rows].sort((a, b) => a.sourceEvidence.row - b.sourceEvidence.row);
    const sourceRows = rowsBySourcePosition.map((row) => row.sourceEvidence.row);
    const sourceHashes = rowsBySourcePosition.map((row) => row.sourceEvidence.hash);
    const evidenceRows = rows.map((row) => ({ ...row.sourceEvidence, rows: undefined }) as unknown as SourceEvidence);
    if (new Set(rows.map(lineBusinessFacts)).size === 1) {
      const selected = [...rows].sort((a, b) => compareText(a.sourceEvidence.hash, b.sourceEvidence.hash))[0];
      selectedLines.push(withEvidenceRows(selected, evidenceRows));
      duplicateOrderLines.push({
        identity,
        sourceRows,
        sourceHashes,
        selectedRowNumber: selected.sourceEvidence.row,
        selectedSourceHash: selected.sourceEvidence.hash,
        disposition: 'collapsed_exact',
        reason: 'All canonical business facts are identical.',
      });
      for (const row of rows) {
        if (row !== selected)
          issue(
            issues,
            'order_details',
            row.sourceEvidence.row,
            'exact_duplicate_order_line_collapsed',
            'excluded',
            identity,
          );
      }
      continue;
    }
    const decision = overrides.orderLines[identity];
    if (decision?.disposition === 'select') {
      const selected = rows.find((row) => row.sourceEvidence.hash === decision.selectedSourceHash);
      if (selected) {
        selectedLines.push(withEvidenceRows(selected, evidenceRows));
        duplicateOrderLines.push({
          identity,
          sourceRows,
          sourceHashes,
          selectedRowNumber: selected.sourceEvidence.row,
          selectedSourceHash: selected.sourceEvidence.hash,
          disposition: 'selected_override',
          reason: decision.reason,
        });
        for (const row of rows) {
          if (row !== selected)
            issue(
              issues,
              'order_details',
              row.sourceEvidence.row,
              'order_line_revision_not_selected',
              'excluded',
              identity,
            );
        }
        continue;
      }
    }
    if (decision?.disposition === 'repeat') {
      const occurrences = new Map(decision.occurrences.map((occurrence) => [occurrence.sourceHash, occurrence.suffix]));
      const valid =
        occurrences.size === rows.length &&
        rows.every((row) => occurrences.has(row.sourceEvidence.hash)) &&
        new Set(decision.occurrences.map((occurrence) => occurrence.suffix)).size === rows.length &&
        decision.occurrences.every((occurrence) => /^[a-z0-9][a-z0-9_-]*$/i.test(occurrence.suffix));
      if (valid) {
        for (const row of rows) {
          selectedLines.push({ ...row, sourceLineKey: `${identity}#${occurrences.get(row.sourceEvidence.hash)}` });
        }
        duplicateOrderLines.push({
          identity,
          sourceRows,
          sourceHashes,
          disposition: 'selected_override',
          reason: decision.reason,
        });
        continue;
      }
    }
    if (!decision) {
      for (const row of rowsBySourcePosition) {
        selectedLines.push({
          ...row,
          sourceLineKey: `${identity}#${row.sourceEvidence.row}-${row.sourceEvidence.hash.slice(0, 12)}`,
        });
      }
      duplicateOrderLines.push({
        identity,
        sourceRows,
        sourceHashes,
        disposition: 'preserved_repeat',
        reason: 'Non-equivalent source rows are preserved as separate ordered line items.',
      });
      continue;
    }
    duplicateOrderLines.push({
      identity,
      sourceRows,
      sourceHashes,
      disposition: 'blocked',
      reason: 'Override does not exactly identify this duplicate group.',
    });
    issue(issues, 'order_details', rows[0].sourceEvidence.row, 'duplicate_order_line_unresolved', 'blocked', identity);
  }

  const orderLines = selectedLines
    .sort((left, right) => compareText(left.sourceLineKey, right.sourceLineKey))
    .map((line, _index, lines) => ({
      ...line,
      lineOrdinal: lines.filter(
        (candidate) =>
          candidate.companyKey === line.companyKey &&
          candidate.externalOrderId === line.externalOrderId &&
          compareText(candidate.sourceLineKey, line.sourceLineKey) <= 0,
      ).length,
    }));
  if (new Set(orderLines.map((line) => line.sourceLineKey)).size !== orderLines.length) {
    issue(issues, 'order_details', 0, 'duplicate_canonical_order_line_key', 'blocked');
  }

  const headerlessOrderOutcomes = [...headerless.entries()]
    .map(([identity, reason]) => ({
      externalOrderId: identity.split(':')[1],
      disposition: 'exception' as const,
      reason,
    }))
    .sort((left, right) => compareText(left.externalOrderId, right.externalOrderId));

  const sourceFiles = sources.map((source) => ({
    name: source.file.name,
    role: source.file.role,
    sha256: source.sha256,
    rowCount: source.rows.length,
    headers: source.headers,
    modifiedAt: source.file.modifiedAt,
  }));
  const bySource = [
    reconciliation(
      'supplier_ids',
      supplierSource.rows.length,
      suppliers.reduce(
        (count, supplier) =>
          count + supplier.sourceEvidence.rows.filter((row) => row.file === supplierSource.file.role).length,
        0,
      ),
      issues,
    ),
    ...(trackerSource
      ? [reconciliation('supplier_tracker', trackerSource.rows.length, acceptedTrackerRows, issues)]
      : []),
    reconciliation('purchase_orders', poSource.rows.length, orders.length, issues),
    reconciliation('order_details', detailSource.rows.length, orderLines.length, issues),
  ];

  const planWithoutDigest = {
    planVersion: 'supplier-order-import-plan-v1' as const,
    asOfDate: params.asOfDate,
    sourceFiles,
    suppliers,
    supplierAccounts,
    supplierProducts: [...supplierProductsByKey.values()].sort(
      (left, right) =>
        compareText(left.externalSupplierCode, right.externalSupplierCode) || compareText(left.asin, right.asin),
    ),
    purchaseOrderSourceSupplierCodes: [
      ...new Set([...purchaseGroups.values()].flat().map((order) => order.sourceExternalSupplierCode)),
    ].sort(),
    orders,
    orderLines,
    supplierCodeOverrides,
    supplierNameOverrides: supplierNameOverrides.sort((left, right) =>
      compareText(left.externalSupplierCode, right.externalSupplierCode),
    ),
    duplicateSupplierNames,
    duplicatePurchaseOrders,
    duplicateOrderLines,
    blockedSupplierCodes: [],
    blockedOrderIds,
    headerlessOrderOutcomes,
    reconciliation: {
      matchedOrderCount: matchedOrderIds.size,
      detailsOnlyOrderCount: headerlessOrderOutcomes.length,
      purchaseOnlyOrderCount: orders.filter(
        (order) => !detailsByOrder.has(`${order.companyKey}:${order.externalOrderId}`),
      ).length,
      supplierMismatchCount,
      companyMismatchCount,
      retainedOrderCount: orders.length,
      retainedOrderLineCount: orderLines.length,
      bySource,
    },
    hasBlockingIssues: issues.some((candidate) => candidate.severity === 'blocked'),
    issues: issues.sort(
      (left, right) =>
        compareText(left.sourceFile, right.sourceFile) ||
        (left.sourceRow ?? 0) - (right.sourceRow ?? 0) ||
        compareText(left.reason, right.reason),
    ),
  };
  return { ...planWithoutDigest, digest: computeSupplierOrderImportPlanDigest(planWithoutDigest) };
}
