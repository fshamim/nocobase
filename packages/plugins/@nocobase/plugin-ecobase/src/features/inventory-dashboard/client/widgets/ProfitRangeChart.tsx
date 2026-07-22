/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * W7 ProfitRangeChart (T8b, D3): six closed months of profit as an SVG line.
 * The best/worst dashed guides are computed FROM those months, so the best
 * month's dot sits exactly ON the green line and the worst month's ON the red
 * one; the latest closed month is emphasized; the current month's projection
 * is a hollow dot on a dashed connector. Insufficient data renders a plain
 * note — nothing is ever invented.
 */

import { Typography } from 'antd';
import React from 'react';
import type { MonthlyEvidencePoint } from '../../server/contract';
import { TEXT } from '../dashboard-text';
import { formatMonth, type Translate } from '../format';

const WIDTH = 560;
const HEIGHT = 170;
const BEST_Y = 28;
const WORST_Y = 132;
const BASE_Y = 150;
const FIRST_X = 52;
const STEP_X = 86;
const PROJECTION_X = 534;

const COLORS = {
  line: '#0958d9',
  area: '#e6f4ff',
  best: '#389e0d',
  bestGuide: '#b7eb8f',
  worst: '#cf1322',
  worstGuide: '#ffa39e',
  axis: '#e3e3e0',
  text2: 'rgba(0, 0, 0, 0.48)',
  text3: 'rgba(0, 0, 0, 0.28)',
  card: '#ffffff',
} as const;

interface ChartPoint {
  month: string | undefined;
  profit: number;
}

export function ProfitRangeChart({
  points,
  projectedMonthly,
  t,
}: {
  points: MonthlyEvidencePoint[];
  projectedMonthly: number | null;
  t: Translate;
}) {
  const closed: ChartPoint[] = points
    .filter((point): point is MonthlyEvidencePoint & { profit: number } => typeof point.profit === 'number')
    .slice(0, 6)
    .map((point) => ({ month: point.month, profit: point.profit }));
  const best = closed.length > 0 ? Math.max(...closed.map((point) => point.profit)) : null;
  const worst = closed.length > 0 ? Math.min(...closed.map((point) => point.profit)) : null;
  if (closed.length < 2 || best === null || worst === null || best === worst) {
    return <Typography.Text type="secondary">{t(TEXT.chartInsufficient)}</Typography.Text>;
  }
  const y = (profit: number) => WORST_Y - ((profit - worst) / (best - worst)) * (WORST_Y - BEST_Y);
  const clampY = (value: number) => Math.min(Math.max(value, 18), 142);
  const coords = closed.map((point, index) => ({ ...point, x: FIRST_X + index * STEP_X, y: y(point.profit) }));
  const last = coords[coords.length - 1];
  const bestIndex = coords.findIndex((point) => point.profit === best);
  const worstIndex = coords.findIndex((point) => point.profit === worst);
  const projectionY = projectedMonthly !== null ? clampY(y(projectedMonthly)) : null;
  const euro = (value: number) => `€${Math.round(value)}`;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width="100%"
      height={HEIGHT}
      role="img"
      aria-label={t(TEXT.chartTitle)}
      data-testid="profit-range-chart"
    >
      <line
        x1={36}
        y1={BEST_Y}
        x2={548}
        y2={BEST_Y}
        stroke={COLORS.bestGuide}
        strokeWidth={1.5}
        strokeDasharray="5 4"
      />
      <line
        x1={36}
        y1={WORST_Y}
        x2={548}
        y2={WORST_Y}
        stroke={COLORS.worstGuide}
        strokeWidth={1.5}
        strokeDasharray="5 4"
      />
      <line x1={36} y1={BASE_Y} x2={548} y2={BASE_Y} stroke={COLORS.axis} strokeWidth={1} />
      <polygon
        points={[
          ...coords.map((point) => `${point.x},${point.y}`),
          `${last.x},${BASE_Y}`,
          `${coords[0].x},${BASE_Y}`,
        ].join(' ')}
        fill={COLORS.area}
      />
      <polyline
        points={coords.map((point) => `${point.x},${point.y}`).join(' ')}
        fill="none"
        stroke={COLORS.line}
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {projectionY !== null ? (
        <line
          x1={last.x}
          y1={last.y}
          x2={PROJECTION_X}
          y2={projectionY}
          stroke={COLORS.line}
          strokeWidth={2}
          strokeDasharray="3 4"
        />
      ) : null}
      {coords.map((point, index) => {
        const isLast = index === coords.length - 1;
        const isBest = index === bestIndex;
        const isWorst = index === worstIndex;
        return (
          <circle
            key={`${point.x}`}
            cx={point.x}
            cy={point.y}
            r={isLast ? 5 : isBest || isWorst ? 4.5 : 3}
            fill={isBest ? COLORS.best : isWorst ? COLORS.worst : COLORS.line}
            stroke={isLast || isBest || isWorst ? COLORS.card : undefined}
            strokeWidth={isLast ? 2 : isBest || isWorst ? 1.5 : undefined}
            data-testid={
              isLast ? 'chart-dot-last' : isBest ? 'chart-dot-best' : isWorst ? 'chart-dot-worst' : 'chart-dot'
            }
          />
        );
      })}
      {projectionY !== null ? (
        <circle
          cx={PROJECTION_X}
          cy={projectionY}
          r={4}
          fill={COLORS.card}
          stroke={COLORS.line}
          strokeWidth={2}
          data-testid="chart-dot-projected"
        />
      ) : null}
      <text x={36} y={BEST_Y - 4} fontSize={10} fill={COLORS.best}>
        {`${t(TEXT.chartBestPrefix)} ${euro(best)}${
          coords[bestIndex]?.month ? ` — ${formatMonth(`${coords[bestIndex].month}-01`)}` : ''
        }`}
      </text>
      <text x={36} y={WORST_Y - 4} fontSize={10} fill={COLORS.worst}>
        {`${t(TEXT.chartWorstPrefix)} ${euro(worst)}${
          coords[worstIndex]?.month ? ` — ${formatMonth(`${coords[worstIndex].month}-01`)}` : ''
        }`}
      </text>
      {projectedMonthly !== null && projectionY !== null ? (
        <>
          <text x={PROJECTION_X - 62} y={projectionY - 6} fontSize={10} fontWeight={700} fill={COLORS.line}>
            {euro(projectedMonthly)}
          </text>
          <text x={PROJECTION_X - 22} y={projectionY - 14} fontSize={10} fill={COLORS.text2}>
            {t(TEXT.chartProj)}
          </text>
        </>
      ) : null}
      {coords.map((point) => (
        <text key={`label-${point.x}`} x={point.x - 8} y={164} fontSize={10} fill={COLORS.text3}>
          {point.month ? formatMonth(`${point.month}-01`) : ''}
        </text>
      ))}
    </svg>
  );
}
