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
    const factRepository = this.db.getRepository(ECOBASE_COLLECTIONS.silverListingDailyFacts);
    const beforeCount = (await factRepository.find({ limit: 1000000 })).length;
    const runs = [];
    for (const file of [...params.files].sort((left, right) => left.name.localeCompare(right.name))) {
      const company = sellerboardHistoryCompany(file.name);
      if (!company) throw new Error(`Sellerboard history apply could not infer company from ${file.name}.`);
      const matches = sourceConnections.filter((source) => {
        const config = record(source.config);
        return (
          text(source.sourceType) === 'sellerboard' &&
          (text(source.company) === company || text(config.company) === company)
        );
      });
      if (matches.length !== 1) {
        throw new Error(
          `Sellerboard history apply expected one ${company} source connection; found ${matches.length}.`,
        );
      }
      const sourceConnectionId = text(matches[0].id);
      if (!sourceConnectionId)
        throw new Error(`Sellerboard history apply found an invalid ${company} source connection.`);
      const run = await new EcobaseImportService(this.db, this.registry).runCsvBundleImport({
        sourceConnectionId,
        adapterName: 'sellerboard-history-csv',
        sourceIdentifier: 'sellerboard-history-backfill',
        sourceVersion: params.sourceVersion,
        defaultCompany: company,
        files: [file],
        skipGoldRefresh: true,
      });
      runs.push({
        company,
        fileName: file.name,
        importRunId: text(toPlainRecord(run).id),
        status: text(toPlainRecord(run).status),
        normalizedCount: Number(toPlainRecord(run).normalizedCount ?? 0),
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
