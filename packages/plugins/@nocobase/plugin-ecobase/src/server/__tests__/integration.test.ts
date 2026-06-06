import { createMockServer, MockServer } from '@nocobase/test';
import { afterEach, describe, expect, it } from 'vitest';
import PluginEcobaseServer from '..';
import { ECOBASE_COLLECTIONS } from '../collections/names';

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
    await app.db.getRepository(ECOBASE_COLLECTIONS.companies).create({
      values: { id: companyId, name: 'Workspace LLC', active: true },
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
    expect(statusResponse.body.data.data).toEqual([
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
    ]);

    await app.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).create({
      values: {
        id: '97a31b86-0ab3-4f54-9717-91500e78a7b2',
        naturalKey: 'Workspace LLC:B00REAL',
        company: 'Workspace LLC',
        canonicalAsin: 'B00REAL',
        mappingStatus: 'needs_review',
        listingCount: 1,
      },
    });
    const workspaceResponse = await agent.resource('ecobaseOperatorWorkspace').workspace({
      values: { sourceConnectionId },
    });
    expect(workspaceResponse.status).toBe(200);
    expect(workspaceResponse.body.data.data.filters).toMatchObject({ company: 'Workspace LLC', sourceConnectionId });
    expect(workspaceResponse.body.data.data.domains.flatMap((domain) => domain.collections)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collectionName: ECOBASE_COLLECTIONS.sourceConnections, rowCount: 1 }),
        expect.objectContaining({ collectionName: ECOBASE_COLLECTIONS.planningProducts, rowCount: 1 }),
      ]),
    );
    const previewResponse = await agent.resource('ecobaseOperatorWorkspace').preview({
      values: { viewKey: 'latest-products', filters: { sourceConnectionId } },
    });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body.data.data.rows).toEqual([expect.objectContaining({ company: 'Workspace LLC', canonicalAsin: 'B00REAL' })]);
    const forbiddenRawCreate = await agent.resource(ECOBASE_COLLECTIONS.rawImportRows).create({
      values: { id: 'blocked-raw-row', importRunId: runResponse.body.data.data.id, rowNumber: 1, payload: {} },
    });
    expect(forbiddenRawCreate.status).toBe(403);
    const forbiddenConfigCreate = await agent.resource(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: { id: '77a31b86-0ab3-4f54-9717-91500e78a7b2', name: 'Forbidden config', sourceType: 'noop_test', domain: 'foundation' },
    });
    expect(forbiddenConfigCreate.status).toBe(403);
  });

  it('creates UUID planning products and mappings through real repositories for duplicate MasterStock rows', async () => {
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

    const products = (await app.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).find()).map(toPlainRecord);
    expect(products).toEqual([
      expect.objectContaining({
        company: 'Ecofission LLC',
        canonicalAsin: 'B0DX35PTCL',
        mappingStatus: 'needs_review',
        listingCount: 2,
      }),
    ]);
    expect(products[0].id).toEqual(expect.stringMatching(uuidPattern));

    const productId = products[0].id as string;
    const mappings = (await app.db.getRepository(ECOBASE_COLLECTIONS.planningProductListings).find()).map(
      toPlainRecord,
    );
    expect(mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planningProductId: productId, sku: 'RM-CLIPS/3-01', mappingStatus: 'needs_review' }),
        expect.objectContaining({
          planningProductId: productId,
          sku: 'FBA1935C9P1P.missing1',
          mappingStatus: 'needs_review',
        }),
      ]),
    );
    expect(mappings.map((mapping) => mapping.id)).toEqual([
      expect.stringMatching(uuidPattern),
      expect.stringMatching(uuidPattern),
    ]);

    const inventorySnapshots = (await app.db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).find()).map(
      toPlainRecord,
    );
    expect(inventorySnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planningProductId: productId, sku: 'RM-CLIPS/3-01', stock: 10 }),
        expect.objectContaining({ planningProductId: productId, sku: 'FBA1935C9P1P.missing1', stock: 6 }),
      ]),
    );

    const duplicateReviewResponse = await agent.resource('ecobasePlanning').listDuplicateMappings();
    expect(duplicateReviewResponse.status).toBe(200);
    expect(duplicateReviewResponse.body.data.data).toEqual([
      expect.objectContaining({
        planningProductId: productId,
        mappingStatus: 'needs_review',
        listingCount: 2,
      }),
    ]);

    const productDataResponse = await agent.resource('ecobasePlanning').productData({
      values: { planningProductId: productId },
    });
    expect(productDataResponse.status).toBe(200);
    expect(productDataResponse.body.data.data).toMatchObject({
      product: expect.objectContaining({ id: productId }),
      listings: expect.arrayContaining([expect.objectContaining({ sku: 'RM-CLIPS/3-01' })]),
      inventorySnapshots: expect.arrayContaining([expect.objectContaining({ planningProductId: productId })]),
      mappingAudits: expect.arrayContaining([expect.objectContaining({ action: 'default_created' })]),
    });

    const mappingToAdjust = mappings.find((mapping) => mapping.sku === 'FBA1935C9P1P.missing1');
    expect(mappingToAdjust?.id).toEqual(expect.stringMatching(uuidPattern));
    const adjustResponse = await agent.resource('ecobasePlanning').adjustMapping({
      values: {
        planningProductListingId: mappingToAdjust?.id,
        targetCompany: 'Ecofission LLC',
        targetCanonicalAsin: 'B0DX35PTCL',
        targetTitle: 'Manual split for FBA duplicate SKU',
      },
    });
    expect(adjustResponse.status).toBe(200);
    expect(adjustResponse.body.data.data).toMatchObject({
      sku: 'FBA1935C9P1P.missing1',
      mappingMode: 'manual',
      mappingStatus: 'adjusted',
    });

    const targetProductId = adjustResponse.body.data.data.planningProductId;
    expect(targetProductId).toEqual(expect.stringMatching(uuidPattern));
    expect(targetProductId).not.toBe(productId);
    const targetProductDataResponse = await agent.resource('ecobasePlanning').productData({
      values: { planningProductId: targetProductId },
    });
    expect(targetProductDataResponse.status).toBe(200);
    expect(targetProductDataResponse.body.data.data).toMatchObject({
      product: expect.objectContaining({ id: targetProductId }),
      listings: [expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', mappingMode: 'manual' })],
      inventorySnapshots: [
        expect.objectContaining({ sku: 'FBA1935C9P1P.missing1', planningProductId: targetProductId }),
      ],
      mappingAudits: expect.arrayContaining([expect.objectContaining({ action: 'adjusted' })]),
    });
  });
});
