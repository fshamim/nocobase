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

import { describe, expect, it } from 'vitest';
import { previewSellerboardHistoryBackfill } from '../../features/source-import/server/sellerboard-history-backfill-service';

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

  it('surfaces invalid dates as blocking errors', async () => {
    const result = await previewSellerboardHistoryBackfill({ files: files('bad-date'), sourceVersion: '2026-07-04' });

    expect(result.totalNormalizedRows).toBe(0);
    expect(result.totalErrorCount).toBe(4);
    expect(result.fileSummaries[0].reasonCounts).toEqual({ sellerboard_history_date_invalid: 1 });
  });
});
