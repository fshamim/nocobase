/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
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
  it('keeps the profile-aware staged order', () => {
    const stages = [...script.matchAll(/runStage\((\d+), '([^']+)'/g)].map((match) => [Number(match[1]), match[2]]);

    expect(stages).toEqual([
      [1, 'read-only source preflight'],
      [2, 'Upsert approved non-login ClickUp attribution users'],
      [3, 'Sellerboard history CSVs'],
      [4, 'Sellerboard COGS CSVs'],
      [7, 'Canonical supplier/order import'],
      [9, 'Reconcile ClickUp status/comments'],
      [10, 'validate Phase A Silver blockers'],
      [11, 'Phase B final gold read-model refresh'],
      [12, 'strict semantic verification'],
    ]);
    expect(script).toContain("SEED_PROFILE === 'staging-fast-clickup' ? 3 : 2, 'Sellerboard API snapshots'");
    expect(script).toContain("SEED_PROFILE !== 'staging-fast-clickup' && seedPhaseEnabled('sellerboard')");
  });

  it('does not shell out to NocoBase initialization during reconciliation', () => {
    expect(script).not.toMatch(/spawnSync\([^\n]*nocobase/i);
    expect(script).not.toContain('nocobase install');
    expect(script).not.toContain('nocobase upgrade');
    expect(script).toContain('drop schema public cascade; create schema public;');
    expect(script).toContain("SEED_PROFILE === 'staging-fast-clickup'");
    expect(script.indexOf('let greenfieldBundleManifest')).toBeLessThan(script.indexOf('main().catch'));
    expect(script.match(/^ {2}\[\d+, [\d_]+\],$/gm)).toHaveLength(12);
    expect(script).toContain('exceeded its ${budgetMs}ms budget');
    for (const metric of ['inputRows', 'acceptedRows', 'discardedRows', 'durationMs']) {
      expect(script).toContain(metric);
    }
  });

  it('emits progress heartbeats and supports bounded phase resumes', () => {
    for (const event of ['seed_stage_started', 'seed_stage_heartbeat', 'seed_stage_completed', 'seed_stage_failed']) {
      expect(script).toContain(`'${event}'`);
    }
    expect(script).toContain('ECOBASE_SEED_START_AT');
    expect(script).toContain('ECOBASE_SEED_STOP_AFTER');
    expect(script).toContain('ECOBASE_SEED_SKIP_GOLD');
    expect(script).toContain('ECOBASE_SEED_HEARTBEAT_MS');
    expect(script).toContain('ECOBASE_GREENFIELD_BUNDLE_PATH');
    expect(script).toContain('supplierOrderFiles().map(csvFile)');
    expect(script).toContain("seedPhaseEnabled('sellerboard')");
    expect(script).toContain("seedPhaseEnabled('orders')");
    expect(script).toContain("seedPhaseEnabled('clickup')");
    expect(script).toContain("seedPhaseEnabled('gold')");
    expect(script).toContain('[3, 3_600_000]');
    expect(script).toContain('writeBusinessFingerprint()');
    expect(script).toContain("'rejected_supplier_refs_absent'");
    expect(script).toContain("'etc_listing_and_source_alias_resolved'");
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
    expect(script.indexOf("'Ecofission-Order Management - Supplier IDs.csv'")).toBeLessThan(
      script.indexOf("'Ecofission-Order Management - Purchase Orders.csv'"),
    );
    expect(script.indexOf("'Ecofission-Order Management - Purchase Orders.csv'")).toBeLessThan(
      script.indexOf("'Ecofission-Order Management - OrderDetails.csv'"),
    );
    expect(script.indexOf("'Ecofission-Order Management - OrderDetails.csv'")).toBeLessThan(
      script.indexOf("'Supplier Analysis Tracker - Supplier Analysis Tracker.csv'"),
    );
    expect(script).toContain(
      "const required = ['Supplier IDs.csv', 'Purchase Orders.csv', 'OrderDetails.csv', 'Supplier Analysis Tracker.csv']",
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
    expect(importData.indexOf("'Supplier/order preview'")).toBeLessThan(importData.indexOf("'ClickUp order status'"));
    expect(importData).not.toContain('skipGoldRefresh');
    expect(importData).toContain('confirmation: `APPLY_SUPPLIER_ORDER_${');
    expect(importData).toContain("confirmation: 'REBUILD GOLD'");
    expect(script).toContain("check('phase_a_gold_inventory_rows_before_rebuild'");
    expect(script).toContain('ECOBASE_PREFLIGHT_SOURCE_EXPORT');
    expect(script).toContain('phase_a_products_without_approved_sellerboard_authority');
    expect(finalVerification).toContain("verifyOrderDetailsRelationships(token, 'final', { strict: false })");
    expect(finalVerification).toContain('verifySemanticLinks(token)');
  });
});
