/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Presentational formatters. Values are rendered verbatim from the server —
 * null stays "unknown" (never 0, never a date, never on-track).
 */

import { TEXT } from './dashboard-text';

export type Translate = (key: string) => string;

const EUR = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

export function formatMoney(value: number | null | undefined, t: Translate): string {
  return typeof value === 'number' ? EUR.format(value) : t(TEXT.unknown);
}

export function formatDate(value: string | null | undefined, t: Translate): string {
  return typeof value === 'string' && value.trim() ? value.slice(0, 10) : t(TEXT.unknown);
}

export function formatDays(value: number | null | undefined, t: Translate): string {
  return typeof value === 'number' ? `${value} ${t(TEXT.days)}` : t(TEXT.unknown);
}

export function formatNumber(value: number | null | undefined, t: Translate): string {
  return typeof value === 'number' ? `${value}` : t(TEXT.unknown);
}
