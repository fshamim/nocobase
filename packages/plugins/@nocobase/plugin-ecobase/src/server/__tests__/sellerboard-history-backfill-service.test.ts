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

import { describe, expect, it, vi } from 'vitest';
import {
  EcobaseSellerboardHistoryApplyService,
  sellerboardHistorySourceConnectionId,
} from '../../features/source-import/server/sellerboard-history-apply-service';
import {
  previewSellerboardHistoryBackfill,
  sellerboardHistoryCompany,
  sellerboardHistoryConfirmationToken,
} from '../../features/source-import/server/sellerboard-history-backfill-service';
import { EcobaseImportService, type EcobaseDatabase } from '../../features/source-import/server/import-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const header =
  'Date;Marketplace;ASIN;SKU;Name;SalesOrganic;SalesPPC;UnitsOrganic;UnitsPPC;Refunds;GrossProfit;NetProfit';
const prefixes = ['Fissionem', 'Muxtex', 'Retail_Heaven_Inc', 'Stop_Shop_Llc'];

function files(date = '03/07/2026') {
  return prefixes.map((prefix, index) => ({
    name: `${prefix}_Dashboard_by_product_01_01_2026-03_07_2026.csv`,
    content: `${header}\n${date};Amazon.com;B00000000${index};SKU-${index};Product;10;2;1;1;0;4;3`,
  }));
}

describe('Sellerboard history backfill preview', () => {
  it('validates all four company files and reports strict date coverage without writes', async () => {
    const result = await previewSellerboardHistoryBackfill({ files: files(), sourceVersion: '2026-07-04' });

    expect(result).toMatchObject({
      totalSourceRows: 4,
      totalNormalizedRows: 4,
      totalErrorCount: 0,
      stagingWrites: 0,
    });
    expect(result.fileSummaries).toHaveLength(4);
    expect(result.fileSummaries.every((summary) => summary.minDate === '2026-07-03')).toBe(true);
    expect(result.fileSummaries.every((summary) => summary.maxDate === '2026-07-03')).toBe(true);
    expect(result.decisionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves the Sellerboard source through its canonical company relation', () => {
    expect(
      sellerboardHistorySourceConnectionId({
        company: 'Ecofission LLC',
        companies: [{ id: 'company-1', name: 'Ecofission LLC' }],
        sourceConnections: [
          { id: 'source-1', sourceType: 'sellerboard', companyId: 'company-1', name: 'Sellerboard source' },
        ],
      }),
    ).toBe('source-1');
  });

  it('surfaces invalid dates as blocking errors', async () => {
    const result = await previewSellerboardHistoryBackfill({ files: files('bad-date'), sourceVersion: '2026-07-04' });

    expect(result.totalNormalizedRows).toBe(0);
    expect(result.totalErrorCount).toBe(4);
    expect(result.fileSummaries[0].reasonCounts).toEqual({ sellerboard_history_date_invalid: 1 });
  });

  it('does not accept a partial history import as a successful complete apply', async () => {
    const sourceFiles = files();
    const preview = await previewSellerboardHistoryBackfill({ files: sourceFiles, sourceVersion: '2026-07-04' });
    const companies = sourceFiles.map((file, index) => ({
      id: `company-${index}`,
      name: sellerboardHistoryCompany(file.name),
    }));
    const sourceConnections = companies.map((company, index) => ({
      id: `source-${index}`,
      sourceType: 'sellerboard',
      companyId: company.id,
    }));
    const db = {
      getRepository(name: string) {
        const records =
          name === ECOBASE_COLLECTIONS.sourceConnections
            ? sourceConnections
            : name === ECOBASE_COLLECTIONS.silverCompanies
              ? companies
              : [];
        return { find: async () => records };
      },
    } as unknown as EcobaseDatabase;
    const importSpy = vi
      .spyOn(EcobaseImportService.prototype, 'runAdapterImport')
      .mockResolvedValue({ id: 'partial-run', status: 'partial', normalizedCount: 1 });

    try {
      await expect(
        new EcobaseSellerboardHistoryApplyService(db, {} as never).apply({
          files: sourceFiles,
          sourceVersion: '2026-07-04',
          decisionDigest: preview.decisionDigest,
          confirmation: sellerboardHistoryConfirmationToken(preview.decisionDigest),
        }),
      ).rejects.toThrow('import ended partial');
    } finally {
      importSpy.mockRestore();
    }
  });
});
