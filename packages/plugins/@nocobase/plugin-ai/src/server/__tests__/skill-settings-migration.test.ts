/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { normalizeSkillSettings } from '../migrations/20260617000000-normalize-skill-settings-tools';

describe('AI skill settings migration', () => {
  it('moves legacy tool objects out of skills without dropping real skill names', () => {
    expect(
      normalizeSkillSettings({
        skills: [
          'business-analysis-report',
          { name: 'ecobase_inventory_digest', autoCall: true },
          { name: 'ecobase_source_status', autoCall: false },
        ],
        tools: [{ name: 'ecobase_source_status', autoCall: true }],
      }),
    ).toEqual({
      skills: ['business-analysis-report'],
      tools: [
        { name: 'ecobase_inventory_digest', autoCall: true },
        { name: 'ecobase_source_status', autoCall: true },
      ],
    });
  });

  it('normalizes legacy all-tool skill settings into tools only', () => {
    expect(
      normalizeSkillSettings({
        tools: [],
        skills: [
          { name: 'ecobase_inventory_digest', autoCall: true },
          { name: 'ecobase_supplier_orders', autoCall: true },
        ],
      }),
    ).toEqual({
      tools: [
        { name: 'ecobase_inventory_digest', autoCall: true },
        { name: 'ecobase_supplier_orders', autoCall: true },
      ],
      skills: [],
    });
  });

  it('preserves top-level auto-call for legacy string tool settings', () => {
    expect(
      normalizeSkillSettings({
        tools: ['formFiller'],
        autoCall: true,
      }),
    ).toEqual({
      tools: [{ name: 'formFiller', autoCall: true }],
      autoCall: true,
      skills: [],
    });
  });
});
