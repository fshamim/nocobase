/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import enUS from '../../../../locale/en-US.json';
import zhCN from '../../../../locale/zh-CN.json';
import { DASHBOARD_I18N_KEYS, TEXT } from '../dashboard-text';

const en = enUS as Record<string, string>;
const zh = zhCN as Record<string, string>;

describe('Inventory Dashboard i18n parity (T-2.5)', () => {
  it('has every dashboard literal in BOTH en-US and zh-CN', () => {
    for (const key of DASHBOARD_I18N_KEYS) {
      expect(en[key], `en-US missing "${key}"`).toBeTypeOf('string');
      expect(zh[key], `zh-CN missing "${key}"`).toBeTypeOf('string');
      expect(zh[key]?.length, `zh-CN empty "${key}"`).toBeGreaterThan(0);
    }
  });

  it('keeps the full en-US and zh-CN key sets identical', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('exposes each TEXT key exactly once (no duplicate literals shadowing each other)', () => {
    const values = Object.values(TEXT);
    expect(new Set(values).size).toBe(values.length);
  });
});
