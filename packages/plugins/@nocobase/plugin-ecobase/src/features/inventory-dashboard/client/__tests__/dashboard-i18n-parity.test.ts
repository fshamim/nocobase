/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/*
 * en-US ONLY (user ruling 2026-07-27, 066 amendment): this fork has no Chinese
 * support, now or long-term, so zh-CN is no longer enforced here — new strings
 * ship with an en-US entry and nothing else. Existing zh-CN entries are left
 * alone (harmless), which is exactly why the old "both locales carry the same
 * key set" assertion had to go: en-US now legitimately diverges from zh-CN.
 */

import { describe, expect, it } from 'vitest';
import enUS from '../../../../locale/en-US.json';
import { DASHBOARD_I18N_KEYS, TEXT } from '../dashboard-text';

const en = enUS as Record<string, string>;

describe('Inventory Dashboard i18n parity (T-2.5)', () => {
  it('has every dashboard literal in en-US', () => {
    for (const key of DASHBOARD_I18N_KEYS) {
      expect(en[key], `en-US missing "${key}"`).toBeTypeOf('string');
      expect(en[key]?.length, `en-US empty "${key}"`).toBeGreaterThan(0);
    }
  });

  it('exposes each TEXT key exactly once (no duplicate literals shadowing each other)', () => {
    const values = Object.values(TEXT);
    expect(new Set(values).size).toBe(values.length);
  });
});
