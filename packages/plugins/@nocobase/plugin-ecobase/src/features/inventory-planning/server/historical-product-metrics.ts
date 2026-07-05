/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface HistoricalProductMetrics {
  sales: number;
  units: number;
  profit: number;
  refunds: number;
  monthlyUnits: Record<string, number>;
  lastMonthQty?: number;
  sixMonthAverageQty?: number;
  sixMonthWorstQty?: number;
  sixMonthBestQty?: number;
  profitPerUnit?: number;
  margin?: number;
}

type PlainRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function monthKey(value: string) {
  return value.slice(0, 7);
}

function addMonths(month: string, offset: number) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

export function sixCompleteMonths(calculationDate: string) {
  const currentMonth = monthKey(calculationDate);
  const firstMonth = addMonths(currentMonth, -6);
  const months = Array.from({ length: 6 }, (_, index) => addMonths(firstMonth, index));
  return { months, startDate: `${firstMonth}-01`, endDate: monthEnd(months[5]), lastMonth: months[5] };
}

export function summarizeHistoricalProductFacts(
  facts: PlainRecord[],
  calculationDate: string,
): HistoricalProductMetrics {
  const window = sixCompleteMonths(calculationDate);
  const monthlyUnits: Record<string, number> = {};
  let sales = 0;
  let units = 0;
  let profit = 0;
  let refunds = 0;

  for (const fact of facts) {
    const snapshotDate = asString(fact.snapshotDate);
    if (!snapshotDate || snapshotDate < window.startDate || snapshotDate > window.endDate) continue;
    const factUnits = asNumber(fact.units) ?? 0;
    const month = monthKey(snapshotDate);
    monthlyUnits[month] = (monthlyUnits[month] ?? 0) + factUnits;
    sales += asNumber(fact.sales) ?? 0;
    units += factUnits;
    profit += asNumber(fact.netProfit) ?? asNumber(fact.profit) ?? 0;
    refunds += asNumber(fact.refunds) ?? 0;
  }

  const availableMonthlyUnits = window.months
    .map((month) => monthlyUnits[month])
    .filter((value): value is number => typeof value === 'number');
  const sixMonthAverageQty =
    availableMonthlyUnits.length > 0
      ? availableMonthlyUnits.reduce((total, value) => total + value, 0) / availableMonthlyUnits.length
      : undefined;

  return {
    sales,
    units,
    profit,
    refunds,
    monthlyUnits,
    lastMonthQty: monthlyUnits[window.lastMonth],
    sixMonthAverageQty,
    sixMonthWorstQty: availableMonthlyUnits.length > 0 ? Math.min(...availableMonthlyUnits) : undefined,
    sixMonthBestQty: availableMonthlyUnits.length > 0 ? Math.max(...availableMonthlyUnits) : undefined,
    profitPerUnit: units > 0 ? profit / units : undefined,
    margin: sales > 0 ? (profit / sales) * 100 : undefined,
  };
}
