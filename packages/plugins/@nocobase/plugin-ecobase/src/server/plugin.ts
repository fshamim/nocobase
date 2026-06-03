import { Plugin } from '@nocobase/server';
import { createSourceAdapterRegistry, noopTestAdapter } from './adapters';
import type { SourceAdapterRegistry } from './adapters';
import { ECOBASE_COLLECTIONS } from './collections/names';
import { EcobaseImportService } from './services/import-service';

function getValues(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) {
    return {};
  }
  const values = (params as Record<string, unknown>).values;
  return typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : {};
}

function getOptionalString(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createEcobaseImportActions(registry: SourceAdapterRegistry) {
  return {
    runNoop: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const sourceConnectionId = getOptionalString(values, 'sourceConnectionId');
      if (!sourceConnectionId) {
        ctx.throw(400, 'Ecobase no-op import requires sourceConnectionId.');
        return;
      }

      const service = new EcobaseImportService(ctx.db, registry);
      const importRun = await service.runNoopImport({
        sourceConnectionId,
        sourceIdentifier: getOptionalString(values, 'sourceIdentifier'),
        sourceVersion: getOptionalString(values, 'sourceVersion'),
        idempotencyKey: getOptionalString(values, 'idempotencyKey'),
      });
      ctx.body = { data: importRun };
      await next();
    },
    status: async (ctx, next) => {
      const service = new EcobaseImportService(ctx.db, registry);
      ctx.body = { data: await service.listSourceStatuses() };
      await next();
    },
    adapters: async (ctx, next) => {
      ctx.body = { data: registry.list() };
      await next();
    },
  };
}

export class PluginEcobaseServer extends Plugin {
  private registry = createSourceAdapterRegistry([noopTestAdapter]);

  async load() {
    this.app.resourceManager.define({
      name: 'ecobaseImport',
      actions: createEcobaseImportActions(this.registry),
    });

    this.app.acl.allow('ecobaseImport', ['runNoop', 'status', 'adapters'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.companies, ['list', 'get', 'create', 'update', 'destroy'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.amazonAccounts, ['list', 'get', 'create', 'update', 'destroy'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.sourceConnections, ['list', 'get', 'create', 'update'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.importRuns, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.rawImportRows, ['list', 'get'], 'loggedIn');
  }
}

export default PluginEcobaseServer;
