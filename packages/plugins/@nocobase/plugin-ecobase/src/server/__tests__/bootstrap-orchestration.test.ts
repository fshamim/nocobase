/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/live-gate-bootstrap.mjs'),
  'utf8',
);

describe('live-gate import orchestration', () => {
  it('keeps the required ten-stage order', () => {
    const stages = [...script.matchAll(/runStage\((\d+), '([^']+)'/g)].map((match) => [Number(match[1]), match[2]]);

    expect(stages).toEqual([
      [1, 'read-only source preflight'],
      [2, 'Sellerboard API snapshots'],
      [3, 'Sellerboard history CSVs'],
      [4, 'Sellerboard COGS CSVs'],
      [5, 'Supplier Management historical tracker'],
      [6, 'Supplier Management current 2026 tracker'],
      [7, 'Order Management Purchase Orders then OrderDetails'],
      [8, 'ClickUp order status and comments'],
      [9, 'final gold read-model refresh'],
      [10, 'strict semantic verification'],
    ]);
  });

  it('orders source files and final actions deterministically', () => {
    const importData = script.slice(
      script.indexOf('async function importData()'),
      script.indexOf('async function importSupplierCsvs()'),
    );
    const finalVerification = script.slice(
      script.indexOf('async function verifyLinks()'),
      script.indexOf('function check('),
    );
    expect(script.indexOf('Supplier Analysis Tracker - Supplier Analysis Tracker.csv')).toBeLessThan(
      script.indexOf('Supplier Analysis Tracker - Supplier 2026.csv'),
    );
    expect(script.indexOf('Ecofission-Order Management - Purchase Orders.csv')).toBeLessThan(
      script.indexOf('Ecofission-Order Management - OrderDetails.csv'),
    );
    expect(script.indexOf("'ecobaseImport:importClickupOrderStatuses'")).toBeLessThan(
      script.indexOf("'ecobaseImport:refreshGoldReadModels'"),
    );
    expect(script.indexOf("'ecobaseImport:refreshGoldReadModels'")).toBeLessThan(
      script.indexOf("runStage(10, 'strict semantic verification'"),
    );
    expect(importData.indexOf("'Order management bundle'")).toBeLessThan(
      importData.indexOf("verifyOrderDetailsRelationships(token, 'after-order-import')"),
    );
    expect(importData.indexOf("verifyOrderDetailsRelationships(token, 'after-order-import')")).toBeLessThan(
      importData.indexOf("'ClickUp order status'"),
    );
    expect(finalVerification).toContain("verifyOrderDetailsRelationships(token, 'final')");
    expect(finalVerification).toContain('verifySemanticLinks(token)');
  });
});
