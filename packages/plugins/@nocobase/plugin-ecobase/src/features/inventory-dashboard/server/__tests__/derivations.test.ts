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
  bufferStatus,
  daysInStage,
  effectiveLastActivityAt,
  isDeclining,
  isPerformanceReviewRow,
  isTiered,
  needsFollowUp,
  performanceBand,
  pickLastActivity,
  prepPath,
  projectRowPane,
  staleLeadTime,
  truncatePreview,
  velocityTrend,
} from '../derivations';
import { FIXED_NOW, LEAD_TIME_FRESHNESS_DAYS } from './fixtures/dashboard-fixtures';

const NOW = new Date(FIXED_NOW);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('daysInStage', () => {
  it('is null for null enteredAt (renders unknown, never 0)', () => {
    expect(daysInStage(null, NOW)).toBeNull();
    expect(daysInStage(undefined, NOW)).toBeNull();
    expect(daysInStage('', NOW)).toBeNull();
  });
  it('counts whole days from entry', () => {
    expect(daysInStage(daysAgo(3), NOW)).toBe(3);
    expect(daysInStage(hoursAgo(10), NOW)).toBe(0); // same day is 0, not null
  });
});

describe('needsFollowUp (§4.4)', () => {
  const base = { thresholdHours: 48, now: NOW };
  it('is true when in-stage and no activity since entry > threshold', () => {
    expect(
      needsFollowUp({ ...base, daysInStage: 3, latestActivityAt: null, workflowStageEnteredAt: hoursAgo(72) }),
    ).toBe(true);
  });
  it('is false at exactly 48.0h (strict >)', () => {
    expect(
      needsFollowUp({ ...base, daysInStage: 3, latestActivityAt: hoursAgo(48), workflowStageEnteredAt: hoursAgo(72) }),
    ).toBe(false);
  });
  it('is false when daysInStage is null (unknown entry)', () => {
    expect(
      needsFollowUp({ ...base, daysInStage: null, latestActivityAt: hoursAgo(2), workflowStageEnteredAt: null }),
    ).toBe(false);
  });
  it('uses the latest activity when present', () => {
    expect(
      needsFollowUp({ ...base, daysInStage: 5, latestActivityAt: hoursAgo(10), workflowStageEnteredAt: hoursAgo(200) }),
    ).toBe(false);
  });
});

describe('effectiveLastActivityAt', () => {
  it('prefers explicit activity then falls back to stage entry', () => {
    expect(effectiveLastActivityAt('2026-07-20T00:00:00.000Z', '2026-07-01T00:00:00.000Z')).toBe(
      '2026-07-20T00:00:00.000Z',
    );
    expect(effectiveLastActivityAt(null, '2026-07-01T00:00:00.000Z')).toBe('2026-07-01T00:00:00.000Z');
    expect(effectiveLastActivityAt(null, null)).toBeNull();
  });
});

describe('bufferStatus (§4.5)', () => {
  it('is unknown when either date is null', () => {
    expect(bufferStatus({ expectedArrivalDate: null, estimatedOosDate: null, safetyBufferDays: 7 })).toBe('unknown');
    expect(bufferStatus({ expectedArrivalDate: null, estimatedOosDate: '2026-08-01', safetyBufferDays: 7 })).toBe(
      'unknown',
    );
  });
  it('is late when ETA after OOS', () => {
    expect(
      bufferStatus({ expectedArrivalDate: '2026-08-10', estimatedOosDate: '2026-08-01', safetyBufferDays: 7 }),
    ).toBe('late');
  });
  it('resolves the ETA == OOS - buffer boundary to sufficient', () => {
    // OOS 2026-08-08, buffer 7 -> threshold 2026-08-01; ETA == threshold -> sufficient (strict >).
    expect(
      bufferStatus({ expectedArrivalDate: '2026-08-01', estimatedOosDate: '2026-08-08', safetyBufferDays: 7 }),
    ).toBe('sufficient');
  });
  it('is at_risk inside the buffer window', () => {
    expect(
      bufferStatus({ expectedArrivalDate: '2026-08-05', estimatedOosDate: '2026-08-08', safetyBufferDays: 7 }),
    ).toBe('at_risk');
  });
});

describe('staleLeadTime (REQ-H3)', () => {
  it('is unknown (never stale) for null evidence', () => {
    expect(staleLeadTime(null, LEAD_TIME_FRESHNESS_DAYS, NOW)).toEqual({ stale: false, unknown: true });
  });
  it('is not stale exactly at the freshness boundary (strict >)', () => {
    expect(staleLeadTime(daysAgo(LEAD_TIME_FRESHNESS_DAYS), LEAD_TIME_FRESHNESS_DAYS, NOW)).toEqual({
      stale: false,
      unknown: false,
    });
  });
  it('is stale beyond the boundary', () => {
    expect(staleLeadTime(daysAgo(LEAD_TIME_FRESHNESS_DAYS + 5), LEAD_TIME_FRESHNESS_DAYS, NOW)).toEqual({
      stale: true,
      unknown: false,
    });
  });
});

describe('performanceBand (§4.6)', () => {
  const full = [100, 200, 150, 180, 120, 160].map((units) => ({ units, trusted: true }));
  it('requires >= 3 trusted months', () => {
    expect(
      performanceBand(
        [
          { units: 100, trusted: true },
          { units: 200, trusted: true },
        ],
        120,
      ),
    ).toBe('insufficient_evidence');
    expect(
      performanceBand(
        [
          { units: 100, trusted: true },
          { units: 200, trusted: false },
        ],
        120,
      ),
    ).toBe('insufficient_evidence');
  });
  it('is insufficient when projected velocity is null', () => {
    expect(performanceBand(full, null)).toBe('insufficient_evidence');
  });
  it('bands v against best/worst with inclusive boundaries', () => {
    expect(performanceBand(full, 210)).toBe('above_band');
    expect(performanceBand(full, 200)).toBe('within_band'); // == best
    expect(performanceBand(full, 100)).toBe('within_band'); // == worst
    expect(performanceBand(full, 80)).toBe('below_band');
  });
});

describe('isDeclining + P10 membership', () => {
  it('flags declining when projected tier is worse than last closed', () => {
    expect(isDeclining('C', 'A')).toBe(true);
    expect(isDeclining('A', 'A')).toBe(false);
    expect(isDeclining('A', 'C')).toBe(false);
    expect(isDeclining(null, 'A')).toBe(false);
  });
  it('lists below_band OR declining', () => {
    expect(isPerformanceReviewRow('below_band', false)).toBe(true);
    expect(isPerformanceReviewRow('within_band', true)).toBe(true);
    expect(isPerformanceReviewRow('within_band', false)).toBe(false);
  });
});

describe('velocityTrend (§4.7)', () => {
  it('is unknown when either input missing or last closed is 0', () => {
    expect(velocityTrend(null, 100)).toBe('unknown');
    expect(velocityTrend(100, null)).toBe('unknown');
    expect(velocityTrend(100, 0)).toBe('unknown');
  });
  it('bands within ±10%', () => {
    expect(velocityTrend(120, 100)).toBe('up');
    expect(velocityTrend(80, 100)).toBe('down');
    expect(velocityTrend(105, 100)).toBe('flat');
    expect(velocityTrend(110, 100)).toBe('flat'); // exactly +10% -> flat (not > 110)
  });
});

describe('pickLastActivity (REQ-X1)', () => {
  it('is null for an orphan (no note, no timestamp)', () => {
    expect(pickLastActivity({ note: null, actor: null, actorDisplayName: null, at: null })).toBeNull();
  });
  it('builds a preview with author and timestamp', () => {
    expect(
      pickLastActivity({ note: 'Chased supplier', actor: 'kiran', actorDisplayName: 'Kiran M.', at: hoursAgo(5) }),
    ).toEqual({ preview: 'Chased supplier', author: 'Kiran M.', at: hoursAgo(5) });
  });
  it('truncates long previews', () => {
    expect(truncatePreview('x'.repeat(200)).length).toBe(140);
  });
});

describe('isTiered + prepPath', () => {
  it('detects tier evidence in any slot', () => {
    expect(isTiered(null, 'B', null)).toBe(true);
    expect(isTiered(null, null, null)).toBe(false);
    expect(isTiered('D', 'X', '')).toBe(false);
  });
  it('maps prep path (direct only, else unknown)', () => {
    expect(prepPath({ isDirectShipFba: true })).toBe('direct_fba');
    expect(prepPath({ isDirectShipFba: false })).toBe('unknown');
  });
});

describe('projectRowPane (AD-2)', () => {
  const base = { tiered: true, isDirectShipFba: false, goldWorkflowStage: null, silverWorkflowStage: null };
  it('excludes adminExcluded (null pane, never served)', () => {
    expect(projectRowPane({ ...base, primaryActionPane: 'adminExcluded' }).pane).toBeNull();
  });
  it('keeps a tiered operational row in its persisted pane', () => {
    expect(projectRowPane({ ...base, primaryActionPane: 'supplyAction' })).toMatchObject({
      pane: 'supplyAction',
      untieredProjected: false,
    });
  });
  it('projects an untiered operational row into untieredProducts', () => {
    expect(projectRowPane({ ...base, tiered: false, primaryActionPane: 'healthyInventory' })).toEqual({
      pane: 'untieredProducts',
      staleClassification: false,
      untieredProjected: true,
    });
  });
  it('routes direct-ship-fba to inbound (P4), overriding sub-status', () => {
    expect(projectRowPane({ ...base, primaryActionPane: 'inPrepMonitoring', isDirectShipFba: true }).pane).toBe(
      'inboundMonitoring',
    );
  });
  it('flags staleClassification on gold/silver order-stage disagreement but keeps the gold pane', () => {
    const result = projectRowPane({
      ...base,
      primaryActionPane: 'inPrepMonitoring',
      goldWorkflowStage: 'in_prep',
      silverWorkflowStage: 'amazon_inbound',
    });
    expect(result.pane).toBe('inPrepMonitoring');
    expect(result.staleClassification).toBe(true);
  });
});
