/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

import { resolveCanonicalCompany } from '../../../server/company-identity';
import {
  analyzeCsvFile,
  detectCsvShape,
  latestOrderDetailRowIndexes,
  orderBundleAuthority,
  type CsvShape,
} from './adapters/amazon-operations-csv-adapter';
import { CsvRowReader, type CsvSourceFile, parseCsv } from './adapters/csv-utils';
import { parseClickupOrderStatusFiles } from './clickup-order-status-service';
import { orderDetailSourceIdentity } from './order-detail-source-identity';
import { orderIdentityKey, orderRowExclusionReason } from './order-import-policy';

export type ImportPreflightSeverity = 'error' | 'warning';

export type ImportPreflightIssue = {
  severity: ImportPreflightSeverity;
  code: string;
  file: string;
  row?: number;
  message: string;
};

export type ImportPreflightResult = {
  ok: boolean;
  fileCount: number;
  rowCount: number;
  errorCount: number;
  warningCount: number;
  issueCounts: Record<string, number>;
  issues: ImportPreflightIssue[];
};

type OrderIdentity = {
  file: string;
  row: number;
  companyKey: string;
  companyName: string;
  orderRef: string;
  supplierCode?: string;
};

type LineIdentity = {
  file: string;
  row: number;
  fingerprint: string;
};

const RELATIONSHIP_SHAPES = new Set<CsvShape>([
  'supplier-analysis-tracker',
  'supplier-analysis-2026',
  'supplier-ids',
  'purchase-orders',
  'order-details',
]);

function normalizedReference(value: string | undefined) {
  const text = value?.trim();
  return text ? text.toUpperCase().replace(/[^A-Z0-9]+/g, '') : undefined;
}

function normalizedSupplierCode(row: CsvRowReader) {
  return normalizedReference(row.string('SR ID', 'SR ID '));
}

function isActionableRow(shape: CsvShape, row: CsvRowReader) {
  if (shape === 'purchase-orders') {
    return Boolean(row.string('Order ID', 'SR ID', 'SR ID ', 'Supplier', 'Company'));
  }
  if (shape === 'order-details') {
    return Boolean(row.string('Order ID', 'Company', 'SR ID', 'Supplier', 'ASIN', 'SKU', 'Qty'));
  }
  return Boolean(row.string('SR ID', 'SR ID ', 'Supplier Name', 'ASIN'));
}

function rowFingerprint(row: Record<string, string>) {
  return JSON.stringify(Object.entries(row).map(([key, value]) => [key.trim(), value.trim()]));
}

function issueSort(left: ImportPreflightIssue, right: ImportPreflightIssue) {
  return (
    left.file.localeCompare(right.file) ||
    (left.row ?? 0) - (right.row ?? 0) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function groupBy<T>(values: T[], keyFor: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

export function preflightImportFiles(files: CsvSourceFile[]): ImportPreflightResult {
  const issues: ImportPreflightIssue[] = [];
  const orderIdentities: OrderIdentity[] = [];
  const lineIdentities = new Map<string, LineIdentity[]>();
  const clickupFiles: CsvSourceFile[] = [];
  const bundleAuthority = orderBundleAuthority(files);
  let rowCount = 0;

  const addIssue = (issue: ImportPreflightIssue) => issues.push(issue);

  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    const analysis = analyzeCsvFile(file);
    if (!analysis.importable) {
      addIssue({
        severity: 'error',
        code: 'file_not_importable',
        file: file.name,
        message: `Ecobase import preflight failed: ${file.name} is not importable (${analysis.detectedShape}).`,
      });
      continue;
    }

    const parsed = parseCsv(file.content);
    const shape = detectCsvShape(parsed.headers);
    const latestOrderDetailRows = shape === 'order-details' ? latestOrderDetailRowIndexes(parsed.rows) : undefined;
    rowCount += parsed.rows.length;
    if (shape === 'clickup-order-status') clickupFiles.push(file);
    if (!RELATIONSHIP_SHAPES.has(shape)) continue;

    parsed.rows.forEach((rawRow, index) => {
      const rowNumber = index + 2;
      const row = new CsvRowReader(rawRow);
      if (!isActionableRow(shape, row)) return;
      if (shape === 'order-details' || shape === 'purchase-orders') {
        const exclusionReason = orderRowExclusionReason(shape, row);
        if (exclusionReason) {
          addIssue({
            severity: 'warning',
            code: 'order_row_excluded',
            file: file.name,
            row: rowNumber,
            message: `Ecobase import preflight excluded ${shape} row ${rowNumber}: ${exclusionReason}.`,
          });
          return;
        }
        const orderKey = orderIdentityKey(row);
        if (shape === 'purchase-orders' && !bundleAuthority.selectedPurchaseRows.has(`${file.name}:${index}`)) {
          addIssue({
            severity: 'warning',
            code: 'purchase_order_superseded',
            file: file.name,
            row: rowNumber,
            message: `Ecobase import preflight excluded Purchase Orders row ${rowNumber} because a newer header has the same company and order identity.`,
          });
          return;
        }
        if (shape === 'order-details') {
          const expectedSupplierCode = orderKey ? bundleAuthority.supplierByOrder.get(orderKey) : undefined;
          const actualSupplierCode = orderDetailSourceIdentity(row).supplierCode;
          if (!expectedSupplierCode) {
            addIssue({
              severity: 'warning',
              code: 'order_detail_header_missing',
              file: file.name,
              row: rowNumber,
              message: `Ecobase import preflight excluded ${file.name} row ${rowNumber}: no accepted Purchase Orders header exists.`,
            });
            return;
          }
          if (actualSupplierCode !== expectedSupplierCode) {
            addIssue({
              severity: 'warning',
              code: 'order_detail_supplier_mismatch',
              file: file.name,
              row: rowNumber,
              message: `Ecobase import preflight excluded ${file.name} row ${rowNumber}: supplier ${actualSupplierCode} conflicts with Purchase Orders supplier ${expectedSupplierCode}.`,
            });
            return;
          }
        }
        if (shape === 'order-details' && !latestOrderDetailRows?.has(index)) {
          addIssue({
            severity: 'warning',
            code: 'order_detail_superseded',
            file: file.name,
            row: rowNumber,
            message: `Ecobase import preflight excluded OrderDetails row ${rowNumber} because a newer row has the same company, order, supplier, ASIN, and SKU identity.`,
          });
          return;
        }
      }
      const supplierShape =
        shape === 'supplier-analysis-tracker' || shape === 'supplier-analysis-2026' || shape === 'supplier-ids';
      const rawCompany =
        shape === 'supplier-analysis-tracker' || shape === 'supplier-analysis-2026' || shape === 'supplier-ids'
          ? row.string('Reached Via', 'Company')
          : row.string('Company');
      const company = resolveCanonicalCompany(rawCompany);
      const supplierCode = normalizedSupplierCode(row);

      if (supplierShape && rawCompany?.trim().toLowerCase() === 'call & email') {
        addIssue({
          severity: 'warning',
          code: 'supplier_row_excluded_invalid_company',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight excluded supplier row ${rowNumber}: Reached Via contains a contact method.`,
        });
        return;
      }
      if (!rawCompany && supplierShape && supplierCode) {
        addIssue({
          severity: 'warning',
          code: 'supplier_registered_without_company',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight will register supplier ${supplierCode} globally without company linkage.`,
        });
      } else if (!rawCompany) {
        addIssue({
          severity: 'error',
          code: 'missing_company',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight failed: ${file.name} row ${rowNumber} is missing company identity.`,
        });
      } else if (!company) {
        addIssue({
          severity: 'error',
          code: 'unknown_company',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight failed: ${file.name} row ${rowNumber} has unrecognized company "${rawCompany}".`,
        });
      }

      if (!supplierCode) {
        addIssue({
          severity: 'error',
          code: 'missing_supplier_code',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight failed: ${file.name} row ${rowNumber} is missing a valid SR ID.`,
        });
      }

      if (shape !== 'purchase-orders' && shape !== 'order-details') return;

      const orderRef = normalizedReference(row.string('Order ID'));
      if (!orderRef) {
        addIssue({
          severity: 'error',
          code: 'missing_order_ref',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight failed: ${file.name} row ${rowNumber} is missing Order ID.`,
        });
        return;
      }
      if (!company) return;

      orderIdentities.push({
        file: file.name,
        row: rowNumber,
        companyKey: company.companyKey,
        companyName: company.name,
        orderRef,
        supplierCode,
      });

      if (shape !== 'order-details') return;
      const asin = normalizedReference(row.string('ASIN', 'ASIN '));
      const sku = normalizedReference(row.string('SKU'));
      const quantity = row.number('Qty');
      if (!asin || quantity === undefined) {
        addIssue({
          severity: 'error',
          code: 'missing_order_line_identity',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight failed: ${file.name} row ${rowNumber} requires ASIN and numeric Qty.`,
        });
        return;
      }
      if (!sku) {
        addIssue({
          severity: 'warning',
          code: 'asin_only_product_identity',
          file: file.name,
          row: rowNumber,
          message: `Ecobase import preflight warning: ${file.name} row ${rowNumber} requires evidence-backed ASIN-only resolution for ${asin}.`,
        });
      }
      const lineKey = [company.companyKey, orderRef, supplierCode ?? '', asin, sku ?? ''].join(':');
      lineIdentities.set(lineKey, [
        ...(lineIdentities.get(lineKey) ?? []),
        { file: file.name, row: rowNumber, fingerprint: rowFingerprint(rawRow) },
      ]);
    });
  }

  const ordersByRef = groupBy(orderIdentities, (identity) => identity.orderRef);
  for (const [orderRef, identities] of ordersByRef) {
    const companies = [...new Set(identities.map((identity) => identity.companyKey))];
    if (companies.length > 1) {
      const first = identities[0];
      addIssue({
        severity: 'error',
        code: 'order_company_conflict',
        file: first.file,
        row: first.row,
        message: `Ecobase import preflight failed: order ${orderRef} maps to multiple companies (${[
          ...new Set(identities.map((identity) => identity.companyName)),
        ].join(', ')}).`,
      });
    }
  }

  const ordersByCompanyAndRef = groupBy(orderIdentities, (identity) => `${identity.companyKey}:${identity.orderRef}`);
  for (const identities of ordersByCompanyAndRef.values()) {
    const suppliers = [...new Set(identities.map((identity) => identity.supplierCode).filter(Boolean))];
    if (suppliers.length > 1) {
      const first = identities[0];
      addIssue({
        severity: 'error',
        code: 'order_supplier_conflict',
        file: first.file,
        row: first.row,
        message: `Ecobase import preflight failed: ${first.companyName} order ${
          first.orderRef
        } maps to multiple supplier codes (${suppliers.join(', ')}).`,
      });
    }
  }

  for (const identities of lineIdentities.values()) {
    if (identities.length < 2) continue;
    const exact = new Set(identities.map((identity) => identity.fingerprint)).size === 1;
    const first = identities[0];
    addIssue({
      severity: exact ? 'warning' : 'error',
      code: exact ? 'duplicate_order_line' : 'conflicting_order_line_identity',
      file: first.file,
      row: first.row,
      message: exact
        ? `Ecobase import preflight warning: ${
            identities.length
          } exact OrderDetails rows share one line identity at ${identities
            .map((identity) => identity.row)
            .join(', ')}.`
        : `Ecobase import preflight failed: non-equivalent OrderDetails rows share one line identity at ${identities
            .map((identity) => identity.row)
            .join(', ')}.`,
    });
  }

  if (clickupFiles.length > 0) {
    const clickup = parseClickupOrderStatusFiles(clickupFiles);
    const clickupFileName = clickupFiles.map((file) => file.name).join(', ');
    for (const conflict of clickup.conflictingMainTasks) {
      const tasks = Array.isArray(conflict.tasks) ? conflict.tasks : [];
      addIssue({
        severity: 'warning',
        code: 'clickup_authoritative_status_resolved_by_recency',
        file: clickupFileName,
        row: Number((tasks[0] as Record<string, unknown> | undefined)?.lineNumber) || undefined,
        message: `Ecobase import preflight selected the most recent ClickUp task for order ${String(
          conflict.ref,
        )} from conflicting statuses (${Array.isArray(conflict.statuses) ? conflict.statuses.join(', ') : ''}).`,
      });
    }
    for (const conflict of clickup.companyConflicts) {
      const conflicts = Array.isArray(conflict.conflicts) ? conflict.conflicts : [];
      addIssue({
        severity: 'warning',
        code: 'clickup_company_title_conflict',
        file: clickupFileName,
        row: Number((conflicts[0] as Record<string, unknown> | undefined)?.lineNumber) || undefined,
        message: `Ecobase import preflight used the supported order prefix company for ClickUp order ${String(
          conflict.ref,
        )} despite a task-title conflict.`,
      });
    }
    for (const item of clickup.selectedTasks.filter(({ task }) => !task.mappedStatus)) {
      addIssue({
        severity: 'error',
        code: 'clickup_status_unmapped',
        file: clickupFileName,
        row: item.task.lineNumber,
        message: `Ecobase import preflight failed: ClickUp order ${item.ref} has unmapped status "${item.task.clickupStatus}".`,
      });
    }
    for (const ref of clickup.missingMainTaskRefs) {
      addIssue({
        severity: 'warning',
        code: 'clickup_main_task_missing',
        file: clickupFileName,
        row: clickup.tasksByRef.get(ref)?.[0]?.lineNumber,
        message: `Ecobase import preflight warning: ClickUp order ${ref} has no authoritative main-order task.`,
      });
    }
  }

  issues.sort(issueSort);
  const issueCounts = Object.fromEntries(
    [...groupBy(issues, (issue) => issue.code).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, entries]) => [code, entries.length]),
  );
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  return {
    ok: errorCount === 0,
    fileCount: files.length,
    rowCount,
    errorCount,
    warningCount,
    issueCounts,
    issues,
  };
}
