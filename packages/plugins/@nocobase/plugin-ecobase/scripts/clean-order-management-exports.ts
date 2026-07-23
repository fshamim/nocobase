/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Repeatable cleaner for the four Order-Management exports (Purchase Orders,
 * OrderDetails, Supplier IDs, ClickUp). It reuses the canonical importer's own
 * primitives so the cleaned output obeys the same contracts the importer enforces,
 * and emits a `cleaning-report.md` that counts every kept and dropped row by rule —
 * nothing vanishes silently.
 *
 * Usage:
 *   tsx scripts/clean-order-management-exports.ts --dir <raw-folder> [--out <folder>] [--as-of YYYY-MM-DD] [--months 6]
 *
 * Exit code is non-zero when any file fails header validation or an expected
 * source file is missing, so a wiring script stops before importing a broken bundle.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CsvRowReader,
  normalizeHeader,
  parseDelimitedCsv,
} from '../src/features/source-import/server/adapters/csv-utils';
import {
  detectCsvShape,
  type CsvShape,
} from '../src/features/source-import/server/adapters/amazon-operations-csv-adapter';
import {
  EXPECTED_SOURCE_HEADERS,
  REQUIRED_SOURCE_HEADERS,
  normalizeExternalOrderId,
  normalizeSourceAsin,
  parseDate,
  parseNumber,
  text,
} from '../src/features/source-import/server/supplier-order-import/supplier-order-import-plan';
import type { SupplierOrderSourceRole } from '../src/features/source-import/server/supplier-order-import/supplier-order-import-types';
import { FOUR_COMPANY_MIGRATION_PROFILE } from '../src/features/source-import/server/four-company-migration-profile';
import {
  MAIN_TASK_LISTS,
  extractClickupOrderRefsFromTitle,
  isRootTask,
} from '../src/features/source-import/server/clickup-order-status-service';

export type CanonicalRole = SupplierOrderSourceRole | 'clickup';
type CsvRow = Record<string, string>;

const CANONICAL_ROLES: SupplierOrderSourceRole[] = ['supplier_ids', 'purchase_orders', 'order_details'];
const EXPECTED_ROLES: CanonicalRole[] = ['supplier_ids', 'purchase_orders', 'order_details', 'clickup'];

const ROLE_BY_SHAPE: Partial<Record<CsvShape, CanonicalRole>> = {
  'supplier-ids': 'supplier_ids',
  'purchase-orders': 'purchase_orders',
  'order-details': 'order_details',
  'clickup-order-status': 'clickup',
};

const OUTPUT_FILE_BY_ROLE: Record<CanonicalRole, string> = {
  supplier_ids: 'supplier-ids.cleaned.csv',
  purchase_orders: 'purchase-orders.cleaned.csv',
  order_details: 'order-details.cleaned.csv',
  supplier_tracker: 'supplier-tracker.cleaned.csv',
  clickup: 'clickup-order-status.cleaned.csv',
};

// Columns the ClickUp importer actually reads (clickup-order-status-service.ts:479-514).
const CLICKUP_REQUIRED_COLUMNS = [
  'Task ID',
  'Task Name',
  'Status',
  'Comments',
  'Parent ID',
  'List Name',
  'Task Link',
  'Date Created',
  'Date Created Text',
];

// Optional PO date columns that benefit from ISO normalization (Timestamp is handled separately).
const PO_OPTIONAL_DATE_COLUMNS = new Set(['Date of Payment', 'Exp. Delivery Date ', 'OR Status Date']);
const ORDER_DETAILS_OPTIONAL_DATE_COLUMNS = new Set(['ETA on Amazon']);
const ORDER_DETAILS_REQUIRED_COLUMNS = new Set(['Order ID', 'Company', 'ASIN', 'Qty']);

export interface CleanFileReport {
  role: CanonicalRole;
  sourceName: string;
  inputRows: number;
  keptRows: number;
  /** order_details only: lines kept because their order id is in the kept-PO set despite their own timestamp. */
  keptViaParentPo?: number;
  droppedByReason: Record<string, number>;
  corruptedOrderIdClasses?: Record<string, number>;
  duplicateOrderIds?: Array<{ orderId: string; keptDate: string | undefined; droppedCount: number }>;
  supplierNameConflicts?: Array<{ srId: string; keptName: string; conflictingNames: string[] }>;
  companyBreakdown?: Record<string, number>;
  keptOrderIds?: string[];
  clickupRefs?: string[];
  outputHeaders: string[];
  outputRows: string[][];
}

export interface HeaderFailure {
  role: CanonicalRole;
  sourceName: string;
  missing: string[];
  expectedRequired: string[];
  expectedCanonical: string[];
  found: string[];
}

// -- pure helpers ------------------------------------------------------------

/** Rolling-window cutoff date (inclusive lower bound) as YYYY-MM-DD. */
export function windowCutoff(asOf: string, months = 6): string {
  const [year, month, day] = asOf.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 - months, day)).toISOString().slice(0, 10);
}

/** Classify a non-canonical order id for the D6 exclusion breakdown. */
export function classifyCorruptedOrderId(raw: string): 'legacy_od' | 'long_form' | 'free_text' {
  const value = raw.trim().toUpperCase();
  if (/^OD-?\d+$/.test(value)) return 'legacy_od';
  if (
    /^(?:USA|US|UK)-/.test(value) ||
    /^[A-Z]{2,4}-[A-Z0-9]{2,}-/.test(value) ||
    (value.match(/-/g)?.length ?? 0) >= 2
  ) {
    return 'long_form';
  }
  return 'free_text';
}

export type CompanyResolution =
  | { status: 'ok'; name: string }
  | { status: 'blank' }
  | { status: 'out_of_scope'; value: string };

function normalizeCompanyKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Build a resolver that maps raw company text to one of the four canonical names (or flags it). */
export function buildCompanyResolver(): (raw: string | undefined) => CompanyResolution {
  const nameByKey = new Map(
    FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.map((company) => [company.companyKey, company.name]),
  );
  const canonicalByNormalized = new Map<string, string>();
  for (const company of FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies) {
    canonicalByNormalized.set(normalizeCompanyKey(company.name), company.name);
  }
  for (const aliases of Object.values(FOUR_COMPANY_MIGRATION_PROFILE.companyAliasesBySource)) {
    for (const alias of aliases) {
      const name = nameByKey.get(alias.companyKey);
      if (name) canonicalByNormalized.set(normalizeCompanyKey(alias.alias), name);
    }
  }
  return (raw) => {
    const value = text(raw);
    if (!value) return { status: 'blank' };
    const name = canonicalByNormalized.get(normalizeCompanyKey(value));
    return name ? { status: 'ok', name } : { status: 'out_of_scope', value };
  };
}

/** Required headers (per the importer) that are absent from `found`. */
export function missingRequiredHeaders(role: SupplierOrderSourceRole, found: string[]): string[] {
  const foundSet = new Set(found.map(normalizeHeader));
  return REQUIRED_SOURCE_HEADERS[role].filter((header) => !foundSet.has(normalizeHeader(header)));
}

/** Fraction of a role's non-empty canonical headers present in `found` (used to identify mis-headed files). */
export function scoreAgainstRole(found: string[], role: SupplierOrderSourceRole): number {
  const foundSet = new Set(found.map(normalizeHeader));
  const expected = EXPECTED_SOURCE_HEADERS[role].filter((header) => header.trim().length);
  const matches = expected.filter((header) => foundSet.has(normalizeHeader(header)));
  return expected.length ? matches.length / expected.length : 0;
}

function incr(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

/** Serialize a table to CSV, quoting only when the value contains a comma, quote or newline. */
export function toCsv(headers: string[], rows: string[][]): string {
  const escape = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [headers, ...rows].map((row) => row.map((value) => escape(value ?? '')).join(',')).join('\n') + '\n';
}

// -- per-file cleaners -------------------------------------------------------

export function cleanPurchaseOrders(
  sourceName: string,
  parsed: { headers: string[]; rows: CsvRow[]; rawRowCount: number },
  resolver: (raw: string | undefined) => CompanyResolution,
  cutoff: string,
): CleanFileReport {
  const headers = EXPECTED_SOURCE_HEADERS.purchase_orders as readonly string[];
  const dropped: Record<string, number> = {};
  const corruptedClasses: Record<string, number> = {};
  const companyBreakdown: Record<string, number> = {};
  const blankRows = parsed.rawRowCount - parsed.rows.length;
  if (blankRows > 0) incr(dropped, 'blank_row', blankRows);

  interface Candidate {
    orderId: string;
    isoDate: string;
    company: string;
    reader: CsvRowReader;
    order: number;
  }
  const candidates: Candidate[] = [];
  parsed.rows.forEach((row, order) => {
    const reader = new CsvRowReader(row);
    const parsedDate = parseDate(reader.string('Timestamp'), 'day-first');
    if (!parsedDate.valid || !parsedDate.value) return incr(dropped, 'junk_unparseable_date');
    if (parsedDate.value < cutoff) return incr(dropped, 'outside_6_month_window');
    const company = resolver(reader.string('Company'));
    if (company.status === 'blank') return incr(dropped, 'company_blank');
    if (company.status === 'out_of_scope') return incr(dropped, 'company_not_in_scope');
    const orderId = normalizeExternalOrderId(reader.string('Order ID'));
    if (!orderId) {
      incr(dropped, 'corrupted_order_id');
      incr(corruptedClasses, classifyCorruptedOrderId(reader.string('Order ID') ?? ''));
      return;
    }
    candidates.push({ orderId, isoDate: parsedDate.value, company: company.name, reader, order });
  });

  // Deduplicate order ids: keep the latest by date, then latest by file order.
  const byOrderId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    byOrderId.set(candidate.orderId, [...(byOrderId.get(candidate.orderId) ?? []), candidate]);
  }
  const duplicateOrderIds: CleanFileReport['duplicateOrderIds'] = [];
  const kept: Candidate[] = [];
  for (const [orderId, group] of byOrderId) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) =>
      a.isoDate === b.isoDate ? a.order - b.order : a.isoDate < b.isoDate ? -1 : 1,
    );
    const winner = sorted[sorted.length - 1];
    kept.push(winner);
    incr(dropped, 'duplicate_order_id', group.length - 1);
    duplicateOrderIds.push({ orderId, keptDate: winner.isoDate, droppedCount: group.length - 1 });
  }
  kept.sort((a, b) => a.order - b.order);

  const outputRows = kept.map((candidate) => {
    incr(companyBreakdown, candidate.company);
    return headers.map((header) => {
      if (header === 'Order ID') return candidate.orderId;
      if (header === 'Company') return candidate.company;
      if (header === 'Timestamp') return candidate.isoDate;
      const value = candidate.reader.string(header) ?? '';
      if (PO_OPTIONAL_DATE_COLUMNS.has(header)) {
        const iso = parseDate(value, 'day-first');
        return iso.valid && iso.value ? iso.value : value;
      }
      return value;
    });
  });

  return {
    role: 'purchase_orders',
    sourceName,
    inputRows: parsed.rawRowCount,
    keptRows: kept.length,
    droppedByReason: dropped,
    corruptedOrderIdClasses: corruptedClasses,
    duplicateOrderIds,
    companyBreakdown,
    keptOrderIds: kept.map((candidate) => candidate.orderId),
    outputHeaders: [...headers],
    outputRows,
  };
}

export function cleanOrderDetails(
  sourceName: string,
  parsed: { headers: string[]; rows: CsvRow[]; rawRowCount: number },
  resolver: (raw: string | undefined) => CompanyResolution,
  cutoff: string,
  keptPoIds: ReadonlySet<string>,
): CleanFileReport {
  const headers = EXPECTED_SOURCE_HEADERS.order_details as readonly string[];
  const dropped: Record<string, number> = {};
  const corruptedClasses: Record<string, number> = {};
  const companyBreakdown: Record<string, number> = {};
  const blankRows = parsed.rawRowCount - parsed.rows.length;
  if (blankRows > 0) incr(dropped, 'blank_row', blankRows);

  const keptOrderIds: string[] = [];
  const outputRows: string[][] = [];
  let keptViaParentPo = 0;
  for (const row of parsed.rows) {
    const reader = new CsvRowReader(row);
    const orderId = normalizeExternalOrderId(reader.string('Order ID'));
    const parsedDate = parseDate(reader.string('Timestamp'), 'day-first');
    const isoTimestamp = parsedDate.valid ? parsedDate.value : undefined;
    const inWindow = isoTimestamp !== undefined && isoTimestamp >= cutoff;
    // The parent order's date governs line items: a line whose order id is in the kept-PO
    // set is kept even when its own timestamp is unparseable or out-of-window (counted as
    // kept_via_parent_po). Company scope and required-field validity below still apply.
    // Lines not under a kept PO are windowed by their own timestamp, exactly as before.
    const underKeptPo = orderId !== undefined && keptPoIds.has(orderId);
    if (!inWindow && !underKeptPo) {
      incr(dropped, isoTimestamp === undefined ? 'junk_unparseable_date' : 'outside_6_month_window');
      continue;
    }
    const company = resolver(reader.string('Company'));
    if (company.status === 'blank') {
      incr(dropped, 'company_blank');
      continue;
    }
    if (company.status === 'out_of_scope') {
      incr(dropped, 'company_not_in_scope');
      continue;
    }
    if (!orderId) {
      // Only reachable for in-window rows: kept-PO membership requires a canonical id.
      incr(dropped, 'corrupted_order_id');
      incr(corruptedClasses, classifyCorruptedOrderId(reader.string('Order ID') ?? ''));
      continue;
    }
    const asin = normalizeSourceAsin(reader.string('ASIN'));
    if (!asin) {
      incr(dropped, 'asin_invalid');
      continue;
    }
    const quantity = parseNumber(reader.string('Qty'));
    if (!quantity.valid || quantity.value === undefined) {
      incr(dropped, 'qty_invalid');
      continue;
    }
    if (!inWindow) keptViaParentPo += 1;
    incr(companyBreakdown, company.name);
    keptOrderIds.push(orderId);
    outputRows.push(
      headers.map((header) => {
        if (header === 'Order ID') return orderId;
        if (header === 'Company') return company.name;
        if (header === 'Timestamp') return isoTimestamp ?? '';
        if (header === 'ASIN') return asin;
        const value = reader.string(header) ?? '';
        if (ORDER_DETAILS_OPTIONAL_DATE_COLUMNS.has(header)) {
          const iso = parseDate(value, 'day-first');
          return iso.valid && iso.value ? iso.value : value === '#REF!' ? '' : value;
        }
        // Blank a broken cell in an optional column instead of dropping the row.
        if (value === '#REF!' && !ORDER_DETAILS_REQUIRED_COLUMNS.has(header)) return '';
        return value;
      }),
    );
  }

  return {
    role: 'order_details',
    sourceName,
    inputRows: parsed.rawRowCount,
    keptRows: outputRows.length,
    keptViaParentPo,
    droppedByReason: dropped,
    corruptedOrderIdClasses: corruptedClasses,
    companyBreakdown,
    keptOrderIds,
    outputHeaders: [...headers],
    outputRows,
  };
}

export function cleanSupplierIds(
  sourceName: string,
  parsed: { headers: string[]; rows: CsvRow[]; rawRowCount: number },
): CleanFileReport {
  const headers = EXPECTED_SOURCE_HEADERS.supplier_ids as readonly string[];
  const dropped: Record<string, number> = {};
  const blankRows = parsed.rawRowCount - parsed.rows.length;
  if (blankRows > 0) incr(dropped, 'blank_row', blankRows);

  const firstByKey = new Map<string, { srId: string; name: string }>();
  const conflicts = new Map<string, { srId: string; keptName: string; conflictingNames: string[] }>();
  const outputRows: string[][] = [];
  for (const row of parsed.rows) {
    const reader = new CsvRowReader(row);
    const rawSrId = reader.string('SR ID');
    if (!rawSrId) {
      incr(dropped, 'sr_id_blank');
      continue;
    }
    if (rawSrId.toLowerCase() === 'duplicate') {
      incr(dropped, 'sr_id_placeholder_duplicate');
      continue;
    }
    const key = rawSrId.toUpperCase().replace(/\s+/g, '');
    const name = reader.string('Supplier Name') ?? '';
    const existing = firstByKey.get(key);
    if (existing) {
      incr(dropped, 'duplicate_sr_id');
      if (normalizeCompanyKey(existing.name) !== normalizeCompanyKey(name)) {
        const conflict = conflicts.get(key) ?? { srId: key, keptName: existing.name, conflictingNames: [] };
        if (name && !conflict.conflictingNames.includes(name)) conflict.conflictingNames.push(name);
        conflicts.set(key, conflict);
      }
      continue;
    }
    firstByKey.set(key, { srId: rawSrId, name });
    outputRows.push(headers.map((header) => (header === 'SR ID' ? rawSrId : header === 'Supplier Name' ? name : '')));
  }

  return {
    role: 'supplier_ids',
    sourceName,
    inputRows: parsed.rawRowCount,
    keptRows: outputRows.length,
    droppedByReason: dropped,
    supplierNameConflicts: [...conflicts.values()],
    outputHeaders: [...headers],
    outputRows,
  };
}

export function cleanClickup(
  sourceName: string,
  parsed: { headers: string[]; rows: CsvRow[]; rawRowCount: number },
): CleanFileReport {
  const dropped: Record<string, number> = {};
  const blankRows = parsed.rawRowCount - parsed.rows.length;
  if (blankRows > 0) incr(dropped, 'blank_row', blankRows);

  const refs = new Set<string>();
  const outputRows: string[][] = [];
  for (const row of parsed.rows) {
    const reader = new CsvRowReader(row);
    if (!isRootTask(reader.string('Parent ID'))) {
      incr(dropped, 'not_root_task');
      continue;
    }
    if (!MAIN_TASK_LISTS.has((reader.string('List Name') ?? '').trim().toLowerCase())) {
      incr(dropped, 'list_not_main');
      continue;
    }
    const nameRefs = extractClickupOrderRefsFromTitle(reader.string('Task Name') ?? '');
    const contentRefs = nameRefs.length
      ? nameRefs
      : extractClickupOrderRefsFromTitle(reader.string('Task Content') ?? '');
    if (!nameRefs.length && !contentRefs.length) {
      incr(dropped, 'no_order_ref');
      continue;
    }
    for (const ref of [...nameRefs, ...contentRefs]) refs.add(ref);
    // Pass every original column through untouched (dates stay epoch-ms).
    outputRows.push(parsed.headers.map((header) => row[header] ?? ''));
  }

  return {
    role: 'clickup',
    sourceName,
    inputRows: parsed.rawRowCount,
    keptRows: outputRows.length,
    droppedByReason: dropped,
    clickupRefs: [...refs],
    outputHeaders: parsed.headers,
    outputRows,
  };
}

// -- orchestration -----------------------------------------------------------

export interface AssignedFile {
  sourceName: string;
  role: CanonicalRole;
  parsed: { headers: string[]; rows: CsvRow[]; rawRowCount: number };
}

export interface RoleAssignment {
  assigned: AssignedFile[];
  headerFailures: HeaderFailure[];
  missingRoles: CanonicalRole[];
  unrecognized: string[];
}

/**
 * Assign every input file to a role. Files whose shape is recognized route directly;
 * an unrecognized file is scored against each still-empty canonical role so a
 * mis-headed export (e.g. a regressed `can ` first column) is still recognized as its
 * intended role and later fails header validation loudly instead of vanishing.
 */
export function assignRoles(
  files: Array<{ sourceName: string; parsed: { headers: string[]; rows: CsvRow[]; rawRowCount: number } }>,
): RoleAssignment {
  const assigned: AssignedFile[] = [];
  const takenRoles = new Set<CanonicalRole>();
  const unknown: typeof files = [];
  const unrecognized: string[] = [];

  for (const file of files) {
    const role = ROLE_BY_SHAPE[detectCsvShape(file.parsed.headers)];
    if (role && !takenRoles.has(role)) {
      assigned.push({ ...file, role });
      takenRoles.add(role);
    } else if (role) {
      unrecognized.push(`${file.sourceName} (duplicate ${role})`);
    } else {
      unknown.push(file);
    }
  }

  for (const file of unknown) {
    let best: { role: SupplierOrderSourceRole; score: number } | undefined;
    for (const role of CANONICAL_ROLES) {
      if (takenRoles.has(role)) continue;
      const score = scoreAgainstRole(file.parsed.headers, role);
      if (!best || score > best.score) best = { role, score };
    }
    if (best && best.score >= 0.5) {
      assigned.push({ ...file, role: best.role });
      takenRoles.add(best.role);
    } else {
      unrecognized.push(`${file.sourceName} (unrecognized shape)`);
    }
  }

  const headerFailures: HeaderFailure[] = [];
  for (const file of assigned) {
    if (file.role === 'clickup') {
      const foundSet = new Set(file.parsed.headers.map(normalizeHeader));
      const missing = CLICKUP_REQUIRED_COLUMNS.filter((header) => !foundSet.has(normalizeHeader(header)));
      if (missing.length) {
        headerFailures.push({
          role: 'clickup',
          sourceName: file.sourceName,
          missing,
          expectedRequired: CLICKUP_REQUIRED_COLUMNS,
          expectedCanonical: CLICKUP_REQUIRED_COLUMNS,
          found: file.parsed.headers,
        });
      }
      continue;
    }
    const missing = missingRequiredHeaders(file.role, file.parsed.headers);
    if (missing.length) {
      headerFailures.push({
        role: file.role,
        sourceName: file.sourceName,
        missing,
        expectedRequired: [...REQUIRED_SOURCE_HEADERS[file.role]],
        expectedCanonical: EXPECTED_SOURCE_HEADERS[file.role].filter((header) => header.trim().length),
        found: file.parsed.headers,
      });
    }
  }

  const missingRoles = EXPECTED_ROLES.filter((role) => !takenRoles.has(role));
  return { assigned, headerFailures, missingRoles, unrecognized };
}

export interface CleanBundleResult {
  asOf: string;
  cutoff: string;
  reports: CleanFileReport[];
  headerFailures: HeaderFailure[];
  missingRoles: CanonicalRole[];
  unrecognized: string[];
  crossFile: {
    recentPoCount: number;
    poCompanyBreakdown: Record<string, number>;
    detailLinesLinkingToKeptPo: number;
    detailLinesOrphan: number;
    clickupTasksKept: number;
    poWithClickupTask: number;
  };
  ok: boolean;
}

/** Clean an already-parsed, header-validated set of assigned files. */
export function cleanAssignedFiles(
  assigned: AssignedFile[],
  failedRoles: Set<CanonicalRole>,
  asOf: string,
  months: number,
): CleanFileReport[] {
  const resolver = buildCompanyResolver();
  const cutoff = windowCutoff(asOf, months);
  // Purchase Orders clean first: their kept order-id set governs OrderDetails line
  // retention (a line under a kept PO survives its own out-of-window/junk timestamp).
  const poFile = assigned.find((file) => file.role === 'purchase_orders' && !failedRoles.has(file.role));
  const poReport = poFile ? cleanPurchaseOrders(poFile.sourceName, poFile.parsed, resolver, cutoff) : undefined;
  const keptPoIds: ReadonlySet<string> = new Set(poReport?.keptOrderIds ?? []);
  const reports: CleanFileReport[] = [];
  for (const file of assigned) {
    if (failedRoles.has(file.role)) continue;
    if (file.role === 'purchase_orders' && poReport) reports.push(poReport);
    else if (file.role === 'order_details')
      reports.push(cleanOrderDetails(file.sourceName, file.parsed, resolver, cutoff, keptPoIds));
    else if (file.role === 'supplier_ids') reports.push(cleanSupplierIds(file.sourceName, file.parsed));
    else if (file.role === 'clickup') reports.push(cleanClickup(file.sourceName, file.parsed));
  }
  return reports;
}

export function crossFileConsistency(reports: CleanFileReport[]): CleanBundleResult['crossFile'] {
  const po = reports.find((report) => report.role === 'purchase_orders');
  const details = reports.find((report) => report.role === 'order_details');
  const clickup = reports.find((report) => report.role === 'clickup');
  const keptPoIds = new Set(po?.keptOrderIds ?? []);
  const clickupRefs = new Set(clickup?.clickupRefs ?? []);
  let linking = 0;
  let orphan = 0;
  for (const orderId of details?.keptOrderIds ?? []) {
    if (keptPoIds.has(orderId)) linking += 1;
    else orphan += 1;
  }
  let poWithClickupTask = 0;
  for (const orderId of keptPoIds) if (clickupRefs.has(orderId)) poWithClickupTask += 1;
  return {
    recentPoCount: po?.keptRows ?? 0,
    poCompanyBreakdown: po?.companyBreakdown ?? {},
    detailLinesLinkingToKeptPo: linking,
    detailLinesOrphan: orphan,
    clickupTasksKept: clickup?.keptRows ?? 0,
    poWithClickupTask,
  };
}

export function cleanBundle(
  files: Array<{ sourceName: string; parsed: { headers: string[]; rows: CsvRow[]; rawRowCount: number } }>,
  asOf: string,
  months: number,
): CleanBundleResult {
  const assignment = assignRoles(files);
  const failedRoles = new Set<CanonicalRole>(assignment.headerFailures.map((failure) => failure.role));
  const reports = cleanAssignedFiles(assignment.assigned, failedRoles, asOf, months);
  return {
    asOf,
    cutoff: windowCutoff(asOf, months),
    reports,
    headerFailures: assignment.headerFailures,
    missingRoles: assignment.missingRoles,
    unrecognized: assignment.unrecognized,
    crossFile: crossFileConsistency(reports),
    ok: assignment.headerFailures.length === 0 && assignment.missingRoles.length === 0,
  };
}

// -- report rendering --------------------------------------------------------

function reasonTable(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return '_none_\n';
  return (
    ['| Reason | Rows |', '| --- | ---: |', ...entries.map(([reason, count]) => `| ${reason} | ${count} |`)].join(
      '\n',
    ) + '\n'
  );
}

export function renderReport(result: CleanBundleResult): string {
  const lines: string[] = [];
  lines.push('# Order-management cleaning report');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- As-of date: ${result.asOf}`);
  lines.push(`- Rolling window cutoff (inclusive): ${result.cutoff}`);
  lines.push(`- Status: ${result.ok ? 'OK' : 'FAILED'}`);
  lines.push('');

  if (result.headerFailures.length || result.missingRoles.length || result.unrecognized.length) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of result.headerFailures) {
      lines.push(`### Header validation failed: ${failure.role} — \`${failure.sourceName}\``);
      lines.push('');
      lines.push(`- Missing required headers: ${failure.missing.map((header) => `\`${header}\``).join(', ')}`);
      lines.push(`- Expected required: ${failure.expectedRequired.map((header) => `\`${header}\``).join(', ')}`);
      lines.push(`- Expected canonical: ${failure.expectedCanonical.map((header) => `\`${header}\``).join(', ')}`);
      lines.push(`- Found: ${failure.found.map((header) => `\`${header}\``).join(', ')}`);
      lines.push('');
    }
    if (result.missingRoles.length) {
      lines.push(`- Missing expected source files (roles): ${result.missingRoles.join(', ')}`);
      lines.push('');
    }
    if (result.unrecognized.length) {
      lines.push(`- Unrecognized files: ${result.unrecognized.join(', ')}`);
      lines.push('');
    }
  }

  for (const report of result.reports) {
    const totalDropped = Object.values(report.droppedByReason).reduce((sum, count) => sum + count, 0);
    lines.push(`## ${report.role} — \`${report.sourceName}\``);
    lines.push('');
    lines.push(`- Input rows: ${report.inputRows}`);
    lines.push(`- Kept rows: ${report.keptRows}`);
    if (report.keptViaParentPo !== undefined) {
      lines.push(
        `- kept_via_parent_po (order id in kept-PO set; own timestamp unparseable or out-of-window): ${report.keptViaParentPo}`,
      );
    }
    lines.push(`- Dropped rows: ${totalDropped}`);
    lines.push(
      `- Integrity: kept + dropped = ${report.keptRows + totalDropped} (input ${report.inputRows}) ${
        report.keptRows + totalDropped === report.inputRows ? 'OK' : 'MISMATCH'
      }`,
    );
    lines.push('');
    lines.push('Dropped by reason:');
    lines.push('');
    lines.push(reasonTable(report.droppedByReason));
    if (report.corruptedOrderIdClasses && Object.keys(report.corruptedOrderIdClasses).length) {
      lines.push('Corrupted order-id classes (D6, excluded — no repair):');
      lines.push('');
      lines.push(reasonTable(report.corruptedOrderIdClasses));
    }
    if (report.companyBreakdown && Object.keys(report.companyBreakdown).length) {
      lines.push('Kept rows by company:');
      lines.push('');
      lines.push(reasonTable(report.companyBreakdown));
    }
    if (report.duplicateOrderIds && report.duplicateOrderIds.length) {
      lines.push(`Duplicate order-id collisions (kept latest by date): ${report.duplicateOrderIds.length}`);
      lines.push('');
      for (const collision of report.duplicateOrderIds.slice(0, 50)) {
        lines.push(`- \`${collision.orderId}\` kept ${collision.keptDate ?? '?'}, dropped ${collision.droppedCount}`);
      }
      lines.push('');
    }
    if (report.supplierNameConflicts && report.supplierNameConflicts.length) {
      lines.push(`SR-ID name conflicts (first-seen kept): ${report.supplierNameConflicts.length}`);
      lines.push('');
      for (const conflict of report.supplierNameConflicts.slice(0, 50)) {
        lines.push(
          `- \`${conflict.srId}\` kept "${conflict.keptName}", conflicting: ${conflict.conflictingNames
            .map((name) => `"${name}"`)
            .join(', ')}`,
        );
      }
      lines.push('');
    }
  }

  lines.push('## Cross-file consistency');
  lines.push('');
  lines.push(`- Recent purchase orders kept: ${result.crossFile.recentPoCount}`);
  lines.push(`- Detail lines linking to a kept PO: ${result.crossFile.detailLinesLinkingToKeptPo}`);
  lines.push(`- Detail lines whose order id is not a kept PO (kept, counted): ${result.crossFile.detailLinesOrphan}`);
  lines.push(`- ClickUp root order-tasks kept: ${result.crossFile.clickupTasksKept}`);
  lines.push(`- Kept POs with at least one ClickUp task: ${result.crossFile.poWithClickupTask}`);
  lines.push('');
  return lines.join('\n');
}

// -- CLI ---------------------------------------------------------------------

export function parseArgs(argv: string[]): { dir: string; out?: string; asOf?: string; months?: number } {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
      args[key] = value;
      index += 1;
    }
  }
  return {
    dir: args.dir ?? process.cwd(),
    out: args.out,
    asOf: args['as-of'],
    months: args.months ? Number(args.months) : undefined,
  };
}

function readCsvFiles(dir: string) {
  if (!existsSync(dir)) throw new Error(`Cleaning failed: input directory does not exist: ${dir}`);
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .sort()
    .map((name) => {
      const content = readFileSync(path.join(dir, name), 'utf8');
      return { sourceName: name, parsed: parseDelimitedCsv(content, ',') };
    });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = path.resolve(options.dir);
  const out = path.resolve(options.out ?? path.join(dir, 'cleaned'));
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const months = options.months ?? 6;

  const files = readCsvFiles(dir);
  if (!files.length) throw new Error(`Cleaning failed: no .csv files found in ${dir}`);

  const result = cleanBundle(files, asOf, months);
  mkdirSync(out, { recursive: true });
  for (const report of result.reports) {
    writeFileSync(
      path.join(out, OUTPUT_FILE_BY_ROLE[report.role]),
      toCsv(report.outputHeaders, report.outputRows),
      'utf8',
    );
  }
  const reportPath = path.join(out, 'cleaning-report.md');
  writeFileSync(reportPath, renderReport(result), 'utf8');

  process.stdout.write(`Cleaning report: ${reportPath}\n`);
  for (const report of result.reports) {
    const totalDropped = Object.values(report.droppedByReason).reduce((sum, count) => sum + count, 0);
    const viaParentPo = report.keptViaParentPo !== undefined ? ` (kept_via_parent_po=${report.keptViaParentPo})` : '';
    process.stdout.write(
      `  ${report.role}: kept ${report.keptRows} / dropped ${totalDropped} / input ${report.inputRows}${viaParentPo}\n`,
    );
  }
  process.stdout.write(
    `  cross-file: recentPO=${result.crossFile.recentPoCount} detailLinking=${result.crossFile.detailLinesLinkingToKeptPo} detailOrphan=${result.crossFile.detailLinesOrphan} clickupKept=${result.crossFile.clickupTasksKept} poWithClickup=${result.crossFile.poWithClickupTask}\n`,
  );
  if (!result.ok) {
    for (const failure of result.headerFailures) {
      process.stderr.write(
        `HEADER VALIDATION FAILED (${failure.role}) ${failure.sourceName}: missing ${failure.missing.join(', ')}\n`,
      );
    }
    for (const role of result.missingRoles) process.stderr.write(`MISSING EXPECTED SOURCE FILE: ${role}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
