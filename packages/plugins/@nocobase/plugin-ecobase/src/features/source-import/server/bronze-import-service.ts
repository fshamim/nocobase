/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { AdapterStreamItem, SourceAdapter } from './adapters';
import type { CsvSourceFile } from './adapters/csv-utils';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { FOUR_COMPANY_MIGRATION_PROFILE } from './four-company-migration-profile';
import type { EcobaseDatabase } from './import-service';

export interface BronzeImportContext {
  importRunId: string;
  sourceConnectionId: string;
  sourceIdentifier: string;
  sourceVersion: string;
  adapter: SourceAdapter;
}

export interface BronzeSourceRecordOptions {
  sourceDataset?: string;
}

export class EcobaseBronzeImportService {
  constructor(private db: EcobaseDatabase) {}

  async createSourceFiles(context: BronzeImportContext, files: CsvSourceFile[]) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceFiles);
    for (const file of files) {
      const contentHash = bronzePayloadHash(file.content);
      const existing = await repo.findOne({
        filter: {
          sourceConnectionId: context.sourceConnectionId,
          importRunId: context.importRunId,
          fileName: file.name,
          contentHash,
        },
      });
      if (existing) continue;
      await repo.create({
        values: {
          id: randomUUID(),
          sourceConnectionId: context.sourceConnectionId,
          importRunId: context.importRunId,
          fileName: file.name,
          contentHash,
        },
      });
    }
  }

  async deleteExpiredSourceRecords(asOf: string | Date) {
    const date = asOf instanceof Date ? asOf : new Date(asOf);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Ecobase Bronze retention cleanup failed: asOf "${asOf}" is not a valid date.`);
    }
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords);
    if (!repo.destroy) {
      throw new Error('Ecobase Bronze retention cleanup failed: repository destroy is unavailable.');
    }
    return repo.destroy({ filter: { retentionUntil: { $lt: date.toISOString() } } });
  }

  async createSourceRecord(
    context: BronzeImportContext,
    item: AdapterStreamItem,
    options: BronzeSourceRecordOptions = {},
  ) {
    const sourceKey = sourceKeyFor(context, item);
    const sourceDataset = options.sourceDataset ?? datasetFor(sourceKey, context.sourceIdentifier);
    const payload = payloadFor(item);
    const rowHash = bronzePayloadHash(payload);
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords);
    const existing = await repo.findOne({
      filter: {
        sourceConnectionId: context.sourceConnectionId,
        sourceDataset,
        sourceRecordKey: sourceKey,
        rowHash,
      },
    });
    if (existing) return existing;
    return repo.create({
      values: {
        id: randomUUID(),
        sourceConnectionId: context.sourceConnectionId,
        importRunId: context.importRunId,
        sourceType: context.adapter.metadata.sourceType,
        sourceDataset,
        sourceRecordKey: sourceKey,
        sourceKey: sourceKeyForAudit(item),
        rowNumber: rowNumberFor(item),
        observedAt: observedAtFor(context, item),
        payload,
        rowHash,
        normalizationStatus: normalizationStatusFor(item),
        normalizedError: normalizedErrorFor(item),
        issueSeverity: issueSeverityFor(item),
        issueCode: issueCodeFor(item),
        retentionUntil: bronzeRetentionUntil(context.sourceVersion),
      },
    });
  }
}

function sourceKeyFor(context: BronzeImportContext, item: AdapterStreamItem) {
  if (item.type === 'record') return item.sourceKey ?? `${context.sourceIdentifier}:row:${item.rowNumber}`;
  if (item.type === 'rowIssue') {
    return item.issue.sourceKey ?? `${context.sourceIdentifier}:issue:${item.issue.rowNumber}:${item.issue.code}`;
  }
  return `${context.sourceIdentifier}:status:${item.status}`;
}

function datasetFor(sourceKey: string, fallback: string) {
  const separatorIndex = sourceKey.indexOf(':');
  return separatorIndex >= 0 ? sourceKey.slice(0, separatorIndex) : sourceKey || fallback;
}

function payloadFor(item: AdapterStreamItem) {
  if (item.type === 'record') return item.payload;
  if (item.type === 'rowIssue') return item.issue.payload ?? { message: item.issue.message, code: item.issue.code };
  return item.payload ?? { message: item.message, status: item.status };
}

function observedAtFor(context: BronzeImportContext, item: AdapterStreamItem) {
  if (item.type === 'record') {
    const records = Array.isArray(item.record) ? item.record : [item.record];
    const snapshotDate = records.map((record) => record.data.snapshotDate).find((value) => typeof value === 'string');
    if (typeof snapshotDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) return snapshotDate;
  }
  return context.sourceVersion;
}

function sourceKeyForAudit(item: AdapterStreamItem) {
  if (item.type === 'record') return item.sourceKey;
  if (item.type === 'rowIssue') return item.issue.sourceKey;
  return item.status;
}

function rowNumberFor(item: AdapterStreamItem) {
  if (item.type === 'record') return item.rowNumber;
  if (item.type === 'rowIssue') return item.issue.rowNumber;
  return 0;
}

function normalizationStatusFor(item: AdapterStreamItem) {
  if (item.type === 'record') return 'pending';
  if (item.type === 'rowIssue') return item.issue.severity === 'error' ? 'failed' : 'ignored';
  return item.status;
}

function normalizedErrorFor(item: AdapterStreamItem) {
  if (item.type === 'rowIssue') return item.issue.message;
  if (item.type === 'status') return item.message;
  return undefined;
}

function issueSeverityFor(item: AdapterStreamItem) {
  if (item.type === 'rowIssue') return item.issue.severity;
  if (item.type === 'status') return 'warning';
  return undefined;
}

function issueCodeFor(item: AdapterStreamItem) {
  if (item.type === 'rowIssue') return item.issue.code;
  if (item.type === 'status') return item.status;
  return undefined;
}

export function bronzeRetentionUntil(sourceVersion: string) {
  const start = new Date(sourceVersion);
  const base = Number.isNaN(start.getTime()) ? new Date() : start;
  base.setUTCDate(base.getUTCDate() + FOUR_COMPANY_MIGRATION_PROFILE.bronzeRetentionDays);
  return base.toISOString();
}

export function bronzePayloadHash(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = plainRecord(value);
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    const json = (value as { toJSON: () => unknown }).toJSON();
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
