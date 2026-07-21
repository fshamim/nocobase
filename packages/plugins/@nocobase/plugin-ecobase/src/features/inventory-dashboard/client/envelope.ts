/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Response-envelope handling for the real NocoBase transport.
 *
 * Captured from staging (2026-07-22, image staging-83737af): the HTTP body of
 * `ecobaseInventoryDashboard:header` is `{"data":{"data":{...payload}}}` —
 * the action middleware wraps `ctx.body` (already `{ data: payload }`) in one
 * more `data` envelope, and the axios client adds its own `.data` level. The
 * unwrap therefore peels `data` keys recursively (bounded), exactly like the
 * proven pattern in order-planning's client. Contract payloads never contain a
 * top-level `data` field, so peeling is deterministic.
 *
 * Every payload is then validated by a runtime guard — a shape mismatch turns
 * into a caught error state ("Failed to load" + retry), never a render crash.
 */

import type { DashboardHeader, DrawerContextResult, PaneResult } from '../server/contract';

const MAX_ENVELOPE_DEPTH = 4;

export function unwrapEnvelope(response: unknown): unknown {
  let current: unknown = response;
  for (let depth = 0; depth < MAX_ENVELOPE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) break;
    if (!('data' in (current as Record<string, unknown>))) break;
    current = (current as Record<string, unknown>).data;
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDashboardHeaderPayload(value: unknown): value is DashboardHeader {
  return isRecord(value) && typeof value.publishedRunId === 'string' && Array.isArray(value.tiles);
}

function isSupersededPayload(value: Record<string, unknown>): boolean {
  return value.runSuperseded === true && typeof value.publishedRunId === 'string';
}

export function isPaneResultPayload(value: unknown): value is PaneResult {
  if (!isRecord(value)) return false;
  if (isSupersededPayload(value)) return true;
  return Array.isArray(value.rows) && isRecord(value.pagination);
}

export function isDrawerContextPayload(value: unknown): value is DrawerContextResult {
  if (!isRecord(value)) return false;
  if (isSupersededPayload(value)) return true;
  return Array.isArray(value.familyMembers) && isRecord(value.primaryRow);
}
