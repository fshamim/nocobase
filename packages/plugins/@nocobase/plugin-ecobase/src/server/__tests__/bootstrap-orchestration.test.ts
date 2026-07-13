/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
  it('keeps the required two-phase twelve-stage order', () => {
    const stages = [...script.matchAll(/runStage\((\d+), '([^']+)'/g)].map((match) => [Number(match[1]), match[2]]);

    expect(stages).toEqual([
      [1, 'read-only source preflight'],
      [2, 'Sellerboard API snapshots'],
      [3, 'Sellerboard history CSVs'],
      [4, 'Sellerboard COGS CSVs'],
      [5, 'Supplier Management historical tracker'],
      [6, 'Supplier Management current 2026 tracker'],
      [7, 'Order Management Purchase Orders then OrderDetails'],
      [8, 'Provision confirmed users and reconcile ClickUp status/comments'],
      [9, 'Reconcile order lines against imported product data'],
      [10, 'validate Phase A Silver blockers'],
      [11, 'Phase B final gold read-model refresh'],
      [12, 'strict semantic verification'],
    ]);
  });

  it('does not shell out to NocoBase initialization during reconciliation', () => {
    expect(script).not.toMatch(/spawnSync\([^\n]*nocobase/i);
    expect(script).not.toContain('nocobase install');
    expect(script).not.toContain('nocobase upgrade');
    expect(script.match(/^ {2}\[\d+, [\d_]+\],$/gm)).toHaveLength(12);
    expect(script).toContain('exceeded its ${budgetMs}ms budget');
    for (const metric of ['inputRows', 'acceptedRows', 'discardedRows', 'durationMs']) {
      expect(script).toContain(metric);
    }
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
    expect(script.indexOf("runStage(10, 'validate Phase A Silver blockers'")).toBeLessThan(
      script.indexOf("'ecobaseImport:refreshGoldReadModels'"),
    );
    expect(script.indexOf("'ecobaseImport:refreshGoldReadModels'")).toBeLessThan(
      script.indexOf("runStage(12, 'strict semantic verification'"),
    );
    expect(importData.indexOf('Supplier management ${path.basename(currentSupplierFile)}')).toBeLessThan(
      importData.indexOf("'Order management ordered bundle'"),
    );
    expect(importData.indexOf("'Order management ordered bundle'")).toBeLessThan(
      importData.indexOf("'ClickUp order status'"),
    );
    expect(importData.match(/skipGoldRefresh: true/g)).toHaveLength(7);
    expect(script).toContain("check('phase_a_gold_inventory_rows_before_rebuild'");
    expect(script).toContain('ECOBASE_PREFLIGHT_SOURCE_EXPORT');
    expect(script).toContain('phase_a_products_without_approved_sellerboard_authority');
    expect(finalVerification).toContain("verifyOrderDetailsRelationships(token, 'final', { strict: false })");
    expect(finalVerification).toContain('verifySemanticLinks(token)');
  });
});
