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
import type { CsvSourceFile } from './adapters/csv-utils';
import { parseDelimitedCsv } from './adapters/csv-utils';
import { importSellerboardHistoryCsvFiles } from './adapters/sellerboard-history-csv-adapter';
import { FOUR_COMPANY_MIGRATION_PROFILE } from './four-company-migration-profile';

const COMPANY_NAME_BY_KEY = Object.fromEntries(
  FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.map((company) => [company.companyKey, company.name]),
) as Record<string, string>;

export function sellerboardHistoryCompany(fileName: string) {
  const match = Object.entries(FOUR_COMPANY_MIGRATION_PROFILE.sellerboardCompanyFilePrefixes).find(([prefix]) =>
    fileName.startsWith(`${prefix}_Dashboard_by_product_`),
  );
  return match ? COMPANY_NAME_BY_KEY[match[1]] : undefined;
}

export function sellerboardHistoryConfirmationToken(decisionDigest: string) {
  return `APPLY_SELLERBOARD_HISTORY_${decisionDigest.slice(0, 12).toUpperCase()}`;
}

export async function previewSellerboardHistoryBackfill(params: { files: CsvSourceFile[]; sourceVersion: string }) {
  if (params.files.length !== 4) {
    throw new Error(`Sellerboard history preview expected four company files; found ${params.files.length}.`);
  }
  const fileSummaries = [];
  let totalSourceRows = 0;
  let totalNormalizedRows = 0;
  let totalErrorCount = 0;
  let totalWarningCount = 0;
  for (const file of [...params.files].sort((left, right) => left.name.localeCompare(right.name))) {
    const company = sellerboardHistoryCompany(file.name);
    if (!company) throw new Error(`Sellerboard history preview could not infer a canonical company from ${file.name}.`);
    const parsed = parseDelimitedCsv(file.content, ';');
    let normalizedRowCount = 0;
    let errorCount = 0;
    let warningCount = 0;
    let minDate: string | undefined;
    let maxDate: string | undefined;
    const reasonCounts: Record<string, number> = {};
    for await (const item of importSellerboardHistoryCsvFiles({
      sourceConnectionId: 'sellerboard-history-preview',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: params.sourceVersion,
      idempotencyKey: 'sellerboard-history-preview',
      config: { files: [file], defaultCompany: company },
    })) {
      if (item.type === 'record') {
        const records = Array.isArray(item.record) ? item.record : [item.record];
        for (const record of records) {
          if (record.kind !== 'listing_daily_fact') continue;
          normalizedRowCount += 1;
          const date = String(record.data.snapshotDate ?? '');
          if (date && (!minDate || date < minDate)) minDate = date;
          if (date && (!maxDate || date > maxDate)) maxDate = date;
        }
      } else if (item.type === 'rowIssue') {
        reasonCounts[item.issue.code] = (reasonCounts[item.issue.code] ?? 0) + 1;
        if (item.issue.severity === 'error') errorCount += 1;
        else warningCount += 1;
      }
    }
    totalSourceRows += parsed.rawRowCount;
    totalNormalizedRows += normalizedRowCount;
    totalErrorCount += errorCount;
    totalWarningCount += warningCount;
    fileSummaries.push({
      company,
      fileName: file.name,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      sourceRowCount: parsed.rawRowCount,
      nonEmptyRowCount: parsed.rows.length,
      normalizedRowCount,
      minDate,
      maxDate,
      errorCount,
      warningCount,
      reasonCounts: Object.fromEntries(
        Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right)),
      ),
    });
  }
  const result = {
    mode: 'dry-run',
    sourceVersion: params.sourceVersion,
    totalSourceRows,
    totalNormalizedRows,
    totalErrorCount,
    totalWarningCount,
    fileSummaries,
    stagingWrites: 0,
  };
  return {
    ...result,
    decisionDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  };
}
