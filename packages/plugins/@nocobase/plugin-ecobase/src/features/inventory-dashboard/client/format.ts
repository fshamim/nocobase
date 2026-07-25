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

/** T7: em-dash placeholder for deliberately-empty numeric cells (mockup `risk-none`). */
export const EM_DASH = '—';

const MONTH_DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const MONTH_ONLY = new Intl.DateTimeFormat('en', { month: 'short' });

/** `2026-08-01` -> `Aug 1`; invalid/null -> em-dash. */
export function formatMonthDay(value: string | null | undefined): string {
  const parsed = typeof value === 'string' && value.trim() ? Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`) : NaN;
  return Number.isNaN(parsed) ? EM_DASH : MONTH_DAY.format(new Date(parsed));
}

/** `2026-05-31` -> `May`; invalid/null -> empty string. */
export function formatMonth(value: string | null | undefined): string {
  const parsed = typeof value === 'string' && value.trim() ? Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`) : NaN;
  return Number.isNaN(parsed) ? '' : MONTH_ONLY.format(new Date(parsed));
}

/**
 * Relative age of an ISO timestamp against a client-clock millisecond `now`:
 * `just now` → `N min ago` → `N h ago` → `N d ago`; empty string when unparseable.
 * Shared by the order panes' last-activity cell and the order popup's Comments tab.
 */
export function relativeTime(at: string | null | undefined, now: number, t: Translate): string {
  if (!at) return '';
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return '';
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return t(TEXT.relJustNow);
  if (minutes < 60) return `${minutes} ${t(TEXT.opMinAgo)}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${t(TEXT.relHoursAgo)}`;
  return `${Math.floor(hours / 24)} ${t(TEXT.relDaysAgo)}`;
}

/** Whole days from now (client clock) to a date-only value; null when unparseable. */
export function daysFromNow(value: string | null | undefined, now: Date = new Date()): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`) : NaN;
  if (Number.isNaN(parsed)) return null;
  return Math.round((parsed - now.getTime()) / 86_400_000);
}
