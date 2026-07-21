/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { isDashboardHeaderPayload, isPaneResultPayload, unwrapEnvelope } from '../envelope';
import headerFixture from '../../server/__tests__/fixtures/expected-responses/header.json';
import paneFixture from '../../server/__tests__/fixtures/expected-responses/pane-supplyAction.json';

describe('unwrapEnvelope', () => {
  it('unwraps the real staging envelope (three data levels: axios + middleware + action)', () => {
    // Captured 2026-07-22 from POST /api/ecobaseInventoryDashboard:header on staging.
    const axiosResponse = { status: 200, data: { data: { data: headerFixture } } };
    expect(unwrapEnvelope(axiosResponse)).toBe(headerFixture);
  });

  it('unwraps shallower envelopes and bare payloads (depth-agnostic like the proven order-planning helper)', () => {
    expect(unwrapEnvelope({ data: { data: headerFixture } })).toBe(headerFixture);
    expect(unwrapEnvelope({ data: headerFixture })).toBe(headerFixture);
    expect(unwrapEnvelope(headerFixture)).toBe(headerFixture);
  });

  it('stops at non-object leaves and arrays without throwing', () => {
    expect(unwrapEnvelope(null)).toBeNull();
    expect(unwrapEnvelope(undefined)).toBeUndefined();
    expect(unwrapEnvelope({ data: null })).toBeNull();
    expect(unwrapEnvelope({ data: [1, 2] })).toEqual([1, 2]);
    expect(unwrapEnvelope('text')).toBe('text');
  });
});

describe('payload guards', () => {
  it('accepts the G1 snapshot payloads', () => {
    expect(isDashboardHeaderPayload(headerFixture)).toBe(true);
    expect(isPaneResultPayload(paneFixture)).toBe(true);
    expect(isPaneResultPayload({ runSuperseded: true, publishedRunId: 'run-2' })).toBe(true);
  });

  it('rejects half-unwrapped envelopes and garbage — the exact staging failure shape', () => {
    // This is what the old fixed-depth unwrap produced: one leftover data level.
    expect(isDashboardHeaderPayload({ data: headerFixture })).toBe(false);
    expect(isDashboardHeaderPayload({})).toBe(false);
    expect(isDashboardHeaderPayload(null)).toBe(false);
    expect(isPaneResultPayload({ data: paneFixture })).toBe(false);
    expect(isPaneResultPayload({ rows: 'nope' })).toBe(false);
  });
});
