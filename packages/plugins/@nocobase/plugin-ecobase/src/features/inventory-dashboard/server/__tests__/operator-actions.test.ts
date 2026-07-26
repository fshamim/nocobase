/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T8a (X4 closure): the dashboard's operator action surface. Every mutation the
 * drawer/table needs is served under `ecobaseInventoryDashboard`; the ported
 * actions delegate to the shared legacy handlers (src/server/resource-actions),
 * so this suite proves (a) the operator guard on every mutation, (b) the
 * delegation wiring per action, and (c) the AD-1 import boundary of the
 * feature directory — mechanically.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import { createEcobaseInventoryDashboardActions } from '../resource-registration';

type PlainRecord = Record<string, unknown>;

class FakeRepository {
  rows: PlainRecord[] = [];

  async find(params?: { filter?: PlainRecord; limit?: number }) {
    const rows = this.rows.filter((row) => matches(row, params?.filter));
    return typeof params?.limit === 'number' ? rows.slice(0, params.limit) : rows;
  }

  async findOne(params?: { filter?: PlainRecord; filterByTk?: string | number }) {
    if (params?.filterByTk !== undefined) return this.rows.find((row) => row.id === params.filterByTk) ?? null;
    return this.rows.find((row) => matches(row, params?.filter)) ?? null;
  }

  async create(params: { values: PlainRecord }) {
    this.rows.push({ ...params.values });
    return params.values;
  }

  async update(params: { filterByTk?: string | number; filter?: PlainRecord; values: PlainRecord }) {
    const rows = this.rows.filter((row) =>
      params.filterByTk !== undefined ? row.id === params.filterByTk : matches(row, params.filter),
    );
    rows.forEach((row) => Object.assign(row, params.values));
    return rows[0] ?? null;
  }
}

function matches(row: PlainRecord, filter?: PlainRecord) {
  return Object.entries(filter ?? {}).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray((value as { $in?: unknown[] }).$in)) {
      return (value as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === value;
  });
}

class FakeDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }
}

function context(db: FakeDatabase, values: PlainRecord, roles: string[]) {
  return {
    action: { params: { values } },
    db,
    state: { currentUser: { id: 4 }, currentRole: roles[0], currentRoles: roles },
    body: undefined as unknown,
    throw(status: number, message: string): never {
      throw Object.assign(new Error(message), { status });
    },
  };
}

const operatorCtx = (db: FakeDatabase, values: PlainRecord) => context(db, values, ['operator']);
const memberCtx = (db: FakeDatabase, values: PlainRecord) => context(db, values, ['member']);

const OPERATOR_MUTATIONS = [
  'savePrepDetails',
  'saveSupplierShipDestination',
  'reactivateFamily',
  'setFamilyTarget',
  'setFamilyPreferredSupplier',
  'updateProductPlanningFields',
  'createPlannedOrder',
  'updateSupplierLeadTime',
  'addComment',
  'addProductComment',
] as const;

/**
 * AD-1 import boundary (issue 055). Two rules, both enforced mechanically below.
 *
 * 1. Zero tolerance: no file under `features/inventory-dashboard/` — the relocated gold
 *    engine included — may import from `features/inventory-planning/`. That folder is
 *    scheduled for deletion (issue 042), so the edge is only ever legal the other way
 *    round: legacy planning code imports the engine at its new home, never the reverse.
 * 2. Every other cross-feature import must be enumerated in ALLOWED_FOREIGN_MODULES, so a
 *    NEW foreign dependency fails this test until somebody adds it here deliberately.
 *
 * Specifiers are resolved to real files before classifying them. The predecessor of this
 * check matched the literal string `features/` in the import text, which real cross-feature
 * imports (`../../order-planning/...`) never contain — it could not fail.
 */
const ALLOWED_FOREIGN_MODULES = new Set([
  'order-planning/order-lifecycle-status',
  'order-planning/order-operational-status',
  'semantic-model/server/medallion-identity-service',
  'semantic-model/server/medallion-order-service',
  // Carried in by the relocated gold engine (issue 055). None of these features is doomed.
  'semantic-model/server/silver-data-service',
  'source-import/server/import-service',
  'source-import/server/sellerboard-cogs-service',
  'supplier-management/server/silver-supplier-order-read-model',
  'supplier-management/server/supplier-order-service',
]);

/** The only part of the dashboard the doomed planning folder is allowed to import. */
const DASHBOARD_ENGINE_MODULE_PREFIX = 'inventory-dashboard/server/engine';

const MODULE_RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx'];

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) files.push(path);
    }
  };
  walk(root);
  return files;
}

function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom|\bimport|\brequire|\bvi\.mock)\s*\(?\s*'(\.[^']*)'/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveModulePath(base: string): string | null {
  for (const suffix of MODULE_RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** `<feature>/<path/to/module>` when the target lives under src/features, else null. */
function featureModuleId(featuresRoot: string, target: string): string | null {
  const fromFeatures = relative(featuresRoot, target);
  if (fromFeatures.startsWith('..')) return null;
  return fromFeatures
    .replace(/\.(tsx?|json)$/, '')
    .split(sep)
    .join('/');
}

describe('ecobaseInventoryDashboard operator actions (T8a, X4 closure)', () => {
  it('rejects every mutation for an authenticated non-operator with 403', async () => {
    const actions = createEcobaseInventoryDashboardActions();
    for (const name of OPERATOR_MUTATIONS) {
      const ctx = memberCtx(new FakeDatabase(), {});
      await expect(actions[name](ctx as never, vi.fn()), `${name} must 403`).rejects.toMatchObject({ status: 403 });
    }
  });

  it('delegates addComment to the legacy order-planning handler (order comment persisted)', async () => {
    const db = new FakeDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({ values: { id: 'company-1', name: 'Acme' } });
    await db.getRepository(ECOBASE_COLLECTIONS.silverOrders).create({
      values: {
        id: 'order-1a',
        companyId: 'company-1',
        orderRef: 'PO-1A',
        orderDate: '2026-07-01',
        dailySequenceLetter: 'A',
        lifecycleStatus: 'ordered',
        canonicalStatus: 'paid',
        workflowStage: 'in_prep',
        statusEvidenceJson: {},
      },
    });
    const ctx = operatorCtx(db, { orderId: 'order-1a', body: 'Drawer order note' });

    await createEcobaseInventoryDashboardActions().addComment(ctx as never, vi.fn());

    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ entityType: 'order', entityId: 'order-1a', body: 'Drawer order note' });
  });

  it('addProductComment writes family/product threads with the reactivation comment shape', async () => {
    const actions = createEcobaseInventoryDashboardActions();
    const db = new FakeDatabase();

    const familyCtx = operatorCtx(db, { familyId: 'fam-1', body: 'Family thread note' });
    await actions.addProductComment(familyCtx as never, vi.fn());
    const comments = db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).rows;
    expect(comments[0]).toMatchObject({
      entityType: 'company_product_family',
      entityId: 'fam-1',
      actorType: 'operator',
      actorUserId: '4',
      commentType: 'note',
      body: 'Family thread note',
      workflowDetectionStatus: 'none',
    });
    expect(typeof comments[0].occurredAt).toBe('string');
    expect((familyCtx.body as { data: { entityType: string } }).data.entityType).toBe('company_product_family');

    const productCtx = operatorCtx(db, { companyProductId: 'cp-1', body: 'Product thread note' });
    await actions.addProductComment(productCtx as never, vi.fn());
    expect(comments[1]).toMatchObject({ entityType: 'company_product', entityId: 'cp-1' });

    // When both ids arrive, the family (broader thread) wins.
    const bothCtx = operatorCtx(db, { familyId: 'fam-1', companyProductId: 'cp-1', body: 'Both ids' });
    await actions.addProductComment(bothCtx as never, vi.fn());
    expect(comments[2]).toMatchObject({ entityType: 'company_product_family', entityId: 'fam-1' });

    // Validation: body and at least one id are mandatory.
    await expect(
      actions.addProductComment(operatorCtx(db, { familyId: 'fam-1' }) as never, vi.fn()),
    ).rejects.toMatchObject({ status: 400 });
    await expect(actions.addProductComment(operatorCtx(db, { body: 'x' }) as never, vi.fn())).rejects.toMatchObject({
      status: 400,
    });
  });

  it('delegates updateProductPlanningFields (row updated, goldRefreshRequired envelope preserved)', async () => {
    const db = new FakeDatabase();
    await db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
      .create({ values: { id: 'cp-1', companyProductFamilyId: 'fam-1', targetCoverDays: 45 } });
    const ctx = operatorCtx(db, { companyProductId: 'cp-1', targetCoverDays: 60, reason: 'longer cover for Q4' });

    await createEcobaseInventoryDashboardActions().updateProductPlanningFields(ctx as never, vi.fn());

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows[0]).toMatchObject({
      targetCoverDays: 60,
      planningOverrideReason: 'longer cover for Q4',
    });
    expect(ctx.body).toMatchObject({ data: { goldRefreshRequired: true } });
  });

  it('delegates setFamilyTarget (family row updated with operator provenance + envelope)', async () => {
    const db = new FakeDatabase();
    await db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).create({ values: { id: 'fam-1' } });
    await db
      .getRepository(ECOBASE_COLLECTIONS.silverProducts)
      .create({ values: { id: 'prod-1', asin: 'B000T8A001', sku: 'SKU-T8A' } });
    await db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts)
      .create({ values: { id: 'cp-1', companyProductFamilyId: 'fam-1', productId: 'prod-1' } });
    const ctx = operatorCtx(db, { familyId: 'fam-1', companyProductId: 'cp-1', reason: 'operator pick' });

    await createEcobaseInventoryDashboardActions().setFamilyTarget(ctx as never, vi.fn());

    expect(db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).rows[0]).toMatchObject({
      replenishmentTargetCompanyProductId: 'cp-1',
      targetSelectionSource: 'operator',
      targetSelectedByUserId: '4',
    });
    expect(ctx.body).toMatchObject({ data: { goldRefreshRequired: true } });
  });

  it('wires the remaining ports to their exact legacy handlers (unique validation messages)', async () => {
    // The 400 texts below exist ONLY in the legacy handlers being delegated to —
    // hitting them through the dashboard resource proves the wiring without
    // rebuilding each service's full fixture world.
    const actions = createEcobaseInventoryDashboardActions();
    await expect(
      actions.setFamilyPreferredSupplier(operatorCtx(new FakeDatabase(), {}) as never, vi.fn()),
    ).rejects.toThrow('Ecobase family supplier selection requires familyId, supplierId, and reason.');
    await expect(actions.createPlannedOrder(operatorCtx(new FakeDatabase(), {}) as never, vi.fn())).rejects.toThrow(
      'Ecobase planned order create requires company, planningProductId, and orderedQty.',
    );
    await expect(actions.updateSupplierLeadTime(operatorCtx(new FakeDatabase(), {}) as never, vi.fn())).rejects.toThrow(
      'Ecobase supplier lead-time update requires company, supplierId, and leadTimeDays.',
    );
    await expect(actions.addComment(operatorCtx(new FakeDatabase(), {}) as never, vi.fn())).rejects.toThrow(
      'Ecobase Order Planning comment requires orderId.',
    );
    await expect(actions.setFamilyTarget(operatorCtx(new FakeDatabase(), {}) as never, vi.fn())).rejects.toThrow(
      'Ecobase family target selection requires familyId, companyProductId, and reason.',
    );
  });

  it('AD-1 import boundary: the dashboard feature imports no foreign feature outside the allowlist, and never inventory-planning', () => {
    const featuresRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const files = collectSourceFiles(join(featuresRoot, 'inventory-dashboard'));
    expect(files.length).toBeGreaterThan(10);

    const unresolved: string[] = [];
    const doomedFolderEdges: string[] = [];
    const unallowlisted: string[] = [];
    for (const file of files) {
      for (const specifier of relativeImportSpecifiers(readFileSync(file, 'utf8'))) {
        const target = resolveModulePath(resolve(dirname(file), specifier));
        if (target === null) {
          unresolved.push(`${relative(featuresRoot, file)} -> ${specifier}`);
          continue;
        }
        const moduleId = featureModuleId(featuresRoot, target);
        if (moduleId === null || moduleId.startsWith('inventory-dashboard/')) continue;
        const edge = `${relative(featuresRoot, file)} -> ${moduleId}`;
        if (moduleId.startsWith('inventory-planning/')) doomedFolderEdges.push(edge);
        else if (!ALLOWED_FOREIGN_MODULES.has(moduleId)) unallowlisted.push(edge);
      }
    }

    expect(unresolved).toEqual([]);
    // Rule 1 — zero tolerance, not allowlistable.
    expect(doomedFolderEdges).toEqual([]);
    // Rule 2 — deliberate, enumerated exceptions only.
    expect(unallowlisted).toEqual([]);
  });

  it('AD-1 reverse edge: legacy inventory-planning may reach the relocated engine and nothing else in the dashboard', () => {
    const featuresRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const files = collectSourceFiles(join(featuresRoot, 'inventory-planning'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of relativeImportSpecifiers(readFileSync(file, 'utf8'))) {
        const target = resolveModulePath(resolve(dirname(file), specifier));
        if (target === null) continue;
        const moduleId = featureModuleId(featuresRoot, target);
        if (moduleId === null || !moduleId.startsWith('inventory-dashboard/')) continue;
        if (!moduleId.startsWith(`${DASHBOARD_ENGINE_MODULE_PREFIX}/`)) {
          offenders.push(`${relative(featuresRoot, file)} -> ${moduleId}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
