/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CsvRowReader } from './csv-utils';

const TOTAL_SALES_FIELDS = ['Total Sales', 'Sales', 'Ordered Product Sales'];
const SALES_CHANNEL_FIELDS = [
  'SalesOrganic',
  'SalesPPC',
  'SalesSponsoredProducts',
  'SalesSponsoredBrands',
  'SalesSponsoredDisplay',
];
const TOTAL_UNIT_FIELDS = ['Total Units', 'Units', 'Units Achieved', 'Units Ordered'];
const UNIT_CHANNEL_FIELDS = [
  'UnitsOrganic',
  'UnitsPPC',
  'UnitsSponsoredProducts',
  'UnitsSponsoredBrands',
  'UnitsSponsoredDisplay',
];

export interface SellerboardMetricValues {
  sales?: number;
  units?: number;
  grossProfit?: number;
  netProfit?: number;
  margin?: number;
  profitPerUnit?: number;
}

function firstNumber(row: CsvRowReader, fields: string[]) {
  for (const field of fields) {
    const value = row.number(field);
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function sumNumbers(row: CsvRowReader, fields: string[]) {
  let total = 0;
  let found = false;
  for (const field of fields) {
    const value = row.number(field);
    if (typeof value === 'number') {
      total += value;
      found = true;
    }
  }
  return found ? total : undefined;
}

export function sellerboardMetricValues(row: CsvRowReader): SellerboardMetricValues {
  const sales = firstNumber(row, TOTAL_SALES_FIELDS) ?? sumNumbers(row, SALES_CHANNEL_FIELDS);
  const units = firstNumber(row, TOTAL_UNIT_FIELDS) ?? sumNumbers(row, UNIT_CHANNEL_FIELDS);
  const grossProfit = row.number('GrossProfit');
  const netProfit = row.number('NetProfit', 'Profit Achieved');
  const margin =
    row.number('Margin', 'Margin ') ?? (sales && typeof netProfit === 'number' ? (netProfit / sales) * 100 : undefined);
  const profitPerUnit = units && typeof netProfit === 'number' ? netProfit / units : undefined;

  return { sales, units, grossProfit, netProfit, margin, profitPerUnit };
}
