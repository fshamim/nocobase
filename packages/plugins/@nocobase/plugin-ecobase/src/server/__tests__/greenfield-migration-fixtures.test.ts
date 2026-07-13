/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fakeSensitiveSupplierRow,
  greenfieldClickupCases,
  greenfieldCompanyCases,
  greenfieldIdentityCases,
  greenfieldOrderCases,
} from './fixtures/greenfield-migration/fixtures';

const fixtureDirectory = path.join(__dirname, 'fixtures/greenfield-migration');

describe('greenfield migration fixtures', () => {
  it('covers every required decision family', () => {
    expect(greenfieldCompanyCases.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'ecofission',
        'retail-heaven',
        'muxtex',
        'stop-shop',
        'sellerboard-fissionem',
        'legacy-stopshop',
        'legacy-stopshop-spaced',
        'supplier-muxtex-alias',
        'other-company',
        'formula-tail',
      ]),
    );
    expect(greenfieldOrderCases.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'EF7225C-company-conflict',
        'EF71525A-company-conflict',
        'MX122525G-company-conflict',
        'USA-SS-BS-012426-01-unsupported-prefix',
        'SS42826A-approved-alias',
        'open-old',
        'recent-complete',
        'stale-complete',
        'recent-unknown',
        'stale-unknown',
        'current-orphan',
        'stale-orphan',
      ]),
    );
    expect(greenfieldIdentityCases.supplierRefs).toHaveLength(4);
    expect(greenfieldIdentityCases.sku).toMatchObject({ asin: 'B0177E9JPS', sourceSupplierSku: 'ETC120A' });
    expect(greenfieldIdentityCases.accountListings).toHaveLength(2);
    expect(greenfieldIdentityCases.lines).toHaveLength(3);
    expect(greenfieldClickupCases.map((item) => item.id)).toEqual(['retained-only', 'mixed', 'unrelated']);
    expect(fakeSensitiveSupplierRow).toHaveProperty('pass');
  });

  it('contains only synthetic secret-test values and no personal source material', () => {
    const content = fs
      .readdirSync(fixtureDirectory)
      .map((file) => fs.readFileSync(path.join(fixtureDirectory, file), 'utf8'))
      .join('\n');
    expect(content).not.toMatch(/@(gmail|yahoo|hotmail|outlook)\./i);
    expect(content).not.toMatch(/amazonaws\.com|clickup\.com|sellerboard\.com/i);
    expect(content).not.toMatch(/[?&](?:token|session)=((?!synthetic)[^\s'"&])+/i);
  });
});
