/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  isoDate,
  optionalIsoDate,
} from '../../features/inventory-dashboard/server/engine/planning-date';

describe('inventory planning date normalization', () => {
  it('normalizes strings and Date values to UTC ISO dates', () => {
    expect(isoDate('2026-07-03')).toBe('2026-07-03');
    expect(isoDate('2026-07-03T23:59:00.000Z')).toBe('2026-07-03');
    expect(isoDate(new Date('2026-07-03T05:00:00.000Z'))).toBe('2026-07-03');
  });

  it('keeps optional parsing permissive for row imports', () => {
    expect(optionalIsoDate('2026-07-03T09:30:00.000Z')).toBe('2026-07-03');
    expect(optionalIsoDate(' 2026-07-03 ')).toBe('2026-07-03');
    expect(optionalIsoDate('')).toBeUndefined();
    expect(optionalIsoDate('not a date')).toBeUndefined();
    expect(optionalIsoDate(new Date('2026-07-03T00:00:00.000Z'))).toBeUndefined();
  });

  it('uses explicit errors for strict planning date math', () => {
    expect(addDays('2026-07-03', 2.9)).toBe('2026-07-05');
    expect(diffDays('2026-07-05', '2026-07-03')).toBe(2);
    expect(() => isoDate('not a date', 'Inventory planning calculation date')).toThrow(
      'Inventory planning calculation date: expected a valid date, got "not a date".',
    );
    expect(() => addDays('2026-07-03', Number.NaN)).toThrow('Ecobase planning date: days must be finite, got NaN.');
    expect(() => isoDate(new Date('not a date'))).toThrow(
      'Ecobase planning date: expected a valid date, got Invalid Date.',
    );
  });
});
