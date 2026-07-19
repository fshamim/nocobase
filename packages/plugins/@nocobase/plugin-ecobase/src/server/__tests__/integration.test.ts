/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { resolve } from 'node:path';
import { createMockServer, MockServer } from '@nocobase/test';
import { afterEach, describe, expect, it } from 'vitest';
import PluginEcobaseServer from '..';
import { withGoldInventoryPlanningWriteAuthority } from '../../features/inventory-planning/server/gold-write-guard';
import { EcobaseInventoryPlanningService } from '../../features/inventory-planning/server/inventory-planning-service';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseOperatorWorkspaceService } from '../services/operator-workspace-service';

process.env.NODE_MODULES_PATH ??= resolve(process.cwd(), 'node_modules');

const pluginRegistration = [PluginEcobaseServer, { packageName: '@nocobase/plugin-ecobase' }] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const duplicateMasterStockCsv = `Company,ASIN,SKU,Title,FBA/FBM Stock,Stock value,Estimated Sales Velocity,Days  of stock  left,Recommended quantity for  reordering,Reserved,Sent  to FBA,Ordered,Marketplace,Target stock range after new order days,Manuf. time days,Supplier SKU
Ecofission LLC,B0DX35PTCL,RM-CLIPS/3-01,"OLFA 35"" x 70"" Connecting Grid Rotary Cutting Mat Set (RM-CLIPS/3-01) - sample duplicate",10,100,1.5,40,12,1,0,5,Amazon.com,60,15,SUP-RM
Ecofission LLC,B0DX35PTCL,FBA1935C9P1P.missing1,"OLFA 35"" x 70"" Connecting Grid Rotary Cutting Mat Set (RM-CLIPS/3-01) - duplicate FBA SKU",6,60,1.1,30,8,0,0,3,Amazon.com,60,15,SUP-FBA`;

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).toJSON === 'function') {
    return (value as { toJSON(): Record<string, unknown> }).toJSON();
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

describe('Ecobase plugin NocoBase integration seam', () => {
  let app: MockServer | undefined;

  afterEach(async () => {
    await app?.destroy();
    app = undefined;
  });

  it('loads the plugin, syncs collections, runs no-op import action, and reads status through resources', async () => {
    app = await createMockServer({
      acl: true,
      registerActions: true,
      plugins: [
        'acl',
        'error-handler',
        'field-sort',
        'users',
        'data-source-main',
        'auth',
        'data-source-manager',
        'system-settings',
        pluginRegistration,
      ],
    });

    Object.values(ECOBASE_COLLECTIONS).forEach((collectionName) => {
      expect(app?.db.getCollection(collectionName).repository).toBeDefined();
    });

    const user = await app.db.getRepository('users').findOne({});
    expect(user).toBeTruthy();
    const agent = (await app.agent().login(user)).set('X-Role', 'admin');

    const companyId = '07a31b86-0ab3-4f54-9717-91500e78a7b2';
    await app.db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).create({
      values: { id: companyId, companyKey: 'workspace', name: 'Workspace LLC', active: true },
    });
    const sourceConnectionId = '67a31b86-0ab3-4f54-9717-91500e78a7b2';
    await app.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: sourceConnectionId,
        companyId,
        name: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });

    const adaptersResponse = await agent.resource('ecobaseImport').adapters();
    expect(adaptersResponse.status).toBe(200);
    expect(adaptersResponse.body.data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'noop-test',
          sourceType: 'noop_test',
          title: 'No-op test adapter',
        }),
        expect.objectContaining({
          name: 'amazon-operations-csv',
          sourceType: 'seller_central_file',
          title: 'Amazon operations CSV',
        }),
      ]),
    );

    const runResponse = await agent.resource('ecobaseImport').runNoop({
      values: {
        sourceConnectionId,
        sourceIdentifier: 'manual-noop',
        sourceVersion: 'v1',
      },
    });
    expect(runResponse.status).toBe(200);
    expect(runResponse.body.data.data).toMatchObject({
      sourceConnectionId,
      adapterName: 'noop-test',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
      idempotencyKey: `${sourceConnectionId}:manual-noop:v1`,
      status: 'success',
      rowCount: 0,
      normalizedCount: 0,
      warningCount: 0,
      errorCount: 0,
    });

    const statusResponse = await agent.resource('ecobaseImport').status();
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceConnectionId,
          connectionName: 'No-op source',
          sourceType: 'noop_test',
          domain: 'foundation',
          active: true,
          latestImportRunId: runResponse.body.data.data.id,
          latestRunStatus: 'success',
          rowCount: 0,
          normalizedCount: 0,
          warningCount: 0,
          errorCount: 0,
        }),
      ]),
    );

    const goldRepository = app.db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows) as unknown as {
      create(options: { values: Record<string, unknown> }): Promise<unknown>;
    };
    await withGoldInventoryPlanningWriteAuthority(() =>
      goldRepository.create({
        values: {
          id: '97a31b86-0ab3-4f54-9717-91500e78a7b2',
          naturalKey: 'Workspace LLC:B00REAL',
          calculationDate: '2026-07-13',
          company: 'Workspace LLC',
          planningProductId: 'workspace-product',
          actionStatus: 'watch',
        },
      }),
    );
    await expect(new EcobaseInventoryPlanningService(app.db).listRows()).resolves.toEqual([]);
    const workspaceService = new EcobaseOperatorWorkspaceService(app.db);
    const workspace = await workspaceService.getWorkspace({ sourceConnectionId });
    expect(workspace.filters).toMatchObject({ company: 'Workspace LLC', sourceConnectionId });
    expect(workspace.domains.flatMap((domain) => domain.collections)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collectionName: ECOBASE_COLLECTIONS.sourceConnections, rowCount: 1 }),
      ]),
    );
    expect(workspace.domains.flatMap((domain) => domain.collections)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows }),
      ]),
    );
    await expect(
      workspaceService.previewView({ viewKey: 'latest-products', filters: { sourceConnectionId } }),
    ).rejects.toThrow('collection "unknown" is not exposed');
    const forbiddenGoldList = await agent.resource(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).list();
    expect(forbiddenGoldList.status).toBe(403);
    const forbiddenGoldCreate = await agent.resource(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).create({
      values: {
        id: '97a31b86-0ab3-4f54-9717-91500e78a7b2',
        naturalKey: 'Workspace LLC:B00REAL',
        calculationDate: '2026-07-13',
        company: 'Workspace LLC',
        planningProductId: 'workspace-product',
      },
    });
    expect(forbiddenGoldCreate.status).toBe(403);
    const forbiddenRawCreate = await agent.resource(ECOBASE_COLLECTIONS.bronzeSourceRecords).create({
      values: { id: 'blocked-raw-row', importRunId: runResponse.body.data.data.id, rowNumber: 1, payload: {} },
    });
    expect(forbiddenRawCreate.status).toBe(403);
    const forbiddenConfigCreate = await agent.resource(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: '77a31b86-0ab3-4f54-9717-91500e78a7b2',
        name: 'Forbidden config',
        sourceType: 'noop_test',
        domain: 'foundation',
      },
    });
    expect(forbiddenConfigCreate.status).toBe(403);
  });

  it('persists duplicate MasterStock rows safely through real repositories', async () => {
    app = await createMockServer({
      acl: true,
      registerActions: true,
      plugins: [
        'acl',
        'error-handler',
        'field-sort',
        'users',
        'data-source-main',
        'auth',
        'data-source-manager',
        'system-settings',
        pluginRegistration,
      ],
    });

    const user = await app.db.getRepository('users').findOne({});
    expect(user).toBeTruthy();
    const agent = (await app.agent().login(user)).set('X-Role', 'admin');
    const sourceConnectionId = '3554f272-39d1-4273-a9e5-2e6826479456';

    await app.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: sourceConnectionId,
        name: 'SampleAM duplicate MasterStock source',
        sourceType: 'seller_central_file',
        domain: 'amazon_operations',
        config: {
          files: [
            {
              name: 'SampleAM Weekly Report-July2025 - MasterStock.csv',
              content: duplicateMasterStockCsv,
              expectedRowCount: 2,
              snapshotDate: '2025-07-01',
            },
          ],
        },
        active: true,
      },
    });

    const runResponse = await agent.resource('ecobaseImport').run({
      values: {
        sourceConnectionId,
        adapterName: 'amazon-operations-csv',
        sourceIdentifier: 'SampleAM MasterStock known duplicate',
        sourceVersion: '2025-07-01',
      },
    });
    expect(runResponse.status).toBe(200);
    expect(runResponse.body.data.data).toMatchObject({ status: 'success', rowCount: 2, normalizedCount: 6 });

    const bronzeRecords = (await app.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).find()).map(
      toPlainRecord,
    );
    expect(bronzeRecords).toHaveLength(2);
    expect(bronzeRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceDataset: 'amazon_listing_inventory',
          normalizationStatus: 'normalized',
          payload: expect.objectContaining({
            company: 'Ecofission LLC',
            asin: 'B0DX35PTCL',
            listingSku: 'RM-CLIPS/3-01',
          }),
        }),
        expect.objectContaining({
          sourceDataset: 'amazon_listing_inventory',
          normalizationStatus: 'normalized',
          payload: expect.objectContaining({
            company: 'Ecofission LLC',
            asin: 'B0DX35PTCL',
            listingSku: 'FBA1935C9P1P.missing1',
          }),
        }),
      ]),
    );
    expect(bronzeRecords.map((record) => record.id)).toEqual([
      expect.stringMatching(uuidPattern),
      expect.stringMatching(uuidPattern),
    ]);
  });
});
