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

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { SourceAdapterRegistry } from './adapters';
import type { CsvSourceFile } from './adapters/csv-utils';
import { EcobaseImportService, toPlainRecord, type EcobaseDatabase } from './import-service';
import {
  previewSellerboardHistoryBackfill,
  sellerboardHistoryCompany,
  sellerboardHistoryConfirmationToken,
} from './sellerboard-history-backfill-service';

type PlainRecord = Record<string, unknown>;

function text(value: unknown) {
  const result = String(value ?? '').trim();
  return result || undefined;
}

function record(value: unknown): PlainRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PlainRecord) : {};
}

export function sellerboardHistorySourceConnectionId(params: {
  company: string;
  companies: PlainRecord[];
  sourceConnections: PlainRecord[];
}) {
  const companyIds = new Set(
    params.companies.filter((company) => text(company.name) === params.company).map((company) => text(company.id)),
  );
  const matches = params.sourceConnections.filter((source) => {
    const config = record(source.config);
    return (
      text(source.sourceType) === 'sellerboard' &&
      (companyIds.has(text(source.companyId)) ||
        text(source.company) === params.company ||
        text(config.company) === params.company)
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `Sellerboard history apply expected one ${params.company} source connection; found ${matches.length}.`,
    );
  }
  const sourceConnectionId = text(matches[0].id);
  if (!sourceConnectionId) {
    throw new Error(`Sellerboard history apply found an invalid ${params.company} source connection.`);
  }
  return sourceConnectionId;
}

export class EcobaseSellerboardHistoryApplyService {
  constructor(
    private db: EcobaseDatabase,
    private registry: SourceAdapterRegistry,
  ) {}

  preview(files: CsvSourceFile[], sourceVersion: string) {
    return previewSellerboardHistoryBackfill({ files, sourceVersion });
  }

  async apply(params: { files: CsvSourceFile[]; sourceVersion: string; decisionDigest: string; confirmation: string }) {
    const preview = await this.preview(params.files, params.sourceVersion);
    if (preview.totalErrorCount > 0) {
      throw new Error(`Sellerboard history apply blocked: preview contains ${preview.totalErrorCount} errors.`);
    }
    if (params.decisionDigest !== preview.decisionDigest) {
      throw new Error(
        `Sellerboard history apply blocked: decision digest changed (expected ${preview.decisionDigest}, received ${params.decisionDigest}).`,
      );
    }
    const expectedConfirmation = sellerboardHistoryConfirmationToken(preview.decisionDigest);
    if (params.confirmation !== expectedConfirmation) {
      throw new Error(`Sellerboard history apply blocked: confirmation must equal ${expectedConfirmation}.`);
    }

    const sourceConnections = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({ limit: 10000 })
    ).map(toPlainRecord);
    const companies = (await this.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).find({ limit: 10000 })).map(
      toPlainRecord,
    );
    const factRepository = this.db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts);
    const beforeCount = (await factRepository.find({ limit: 1000000 })).length;
    const runs = [];
    const importService = new EcobaseImportService(this.db, this.registry);
    const previewByFileName = new Map(preview.fileSummaries.map((summary) => [summary.fileName, summary]));
    for (const file of [...params.files].sort((left, right) => left.name.localeCompare(right.name))) {
      const company = sellerboardHistoryCompany(file.name);
      if (!company) throw new Error(`Sellerboard history apply could not infer company from ${file.name}.`);
      const sourceConnectionId = sellerboardHistorySourceConnectionId({ company, companies, sourceConnections });
      const summary = previewByFileName.get(file.name);
      if (!summary) throw new Error(`Sellerboard history apply found no preview summary for ${file.name}.`);
      const run = await importService.runAdapterImport({
        sourceConnectionId,
        adapterName: 'sellerboard-history-csv',
        sourceIdentifier: 'sellerboard-history-backfill',
        sourceVersion: params.sourceVersion,
        preserveAuditRun: true,
        skipGoldRefresh: true,
        runtimeConfig: {
          files: [{ ...file, expectedRowCount: summary.normalizedRowCount }],
          expectedRowCounts: { [file.name]: summary.normalizedRowCount },
          defaultCompany: company,
        },
        summary: {
          historyBackfill: {
            fileName: file.name,
            sha256: summary.sha256,
            normalizedRowCount: summary.normalizedRowCount,
            decisionDigest: preview.decisionDigest,
          },
        },
      });
      const runRecord = toPlainRecord(run);
      const status = text(runRecord.status);
      if (!['success', 'partial'].includes(status ?? '')) {
        throw new Error(`Sellerboard history apply failed for ${company}: import ended ${status ?? 'unknown'}.`);
      }
      runs.push({
        company,
        fileName: file.name,
        importRunId: text(runRecord.id),
        status,
        normalizedCount: Number(runRecord.normalizedCount ?? 0),
      });
    }
    const afterCount = (await factRepository.find({ limit: 1000000 })).length;
    return {
      decisionDigest: preview.decisionDigest,
      beforeFactCount: beforeCount,
      afterFactCount: afterCount,
      createdFactCount: afterCount - beforeCount,
      runs,
      goldRefreshCount: 0,
    };
  }

  async verifyIdempotency(params: {
    files: CsvSourceFile[];
    sourceVersion: string;
    decisionDigest: string;
    confirmation: string;
  }) {
    const first = await this.apply(params);
    const second = await this.apply(params);
    if (second.createdFactCount !== 0 || second.afterFactCount !== first.afterFactCount) {
      throw new Error('Sellerboard history idempotency failed: second apply changed fact count.');
    }
    return { first, second, idempotent: true };
  }
}
