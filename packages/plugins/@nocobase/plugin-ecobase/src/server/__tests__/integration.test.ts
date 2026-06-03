import { createMockServer, MockServer } from '@nocobase/test';
import { afterEach, describe, expect, it } from 'vitest';
import PluginEcobaseServer from '..';
import { ECOBASE_COLLECTIONS } from '../collections/names';

const pluginRegistration = [PluginEcobaseServer, { packageName: '@nocobase/plugin-ecobase' }] as const;

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

    const sourceConnectionId = '67a31b86-0ab3-4f54-9717-91500e78a7b2';
    const sourceCreateResponse = await agent.resource(ECOBASE_COLLECTIONS.sourceConnections).create({
      values: {
        id: sourceConnectionId,
        name: 'No-op source',
        sourceType: 'noop_test',
        domain: 'foundation',
        config: {},
        active: true,
      },
    });
    expect(sourceCreateResponse.status).toBe(200);

    const adaptersResponse = await agent.resource('ecobaseImport').adapters();
    expect(adaptersResponse.status).toBe(200);
    expect(adaptersResponse.body.data.data).toEqual([
      expect.objectContaining({
        name: 'noop-test',
        sourceType: 'noop_test',
        title: 'No-op test adapter',
      }),
    ]);

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
  });
});
