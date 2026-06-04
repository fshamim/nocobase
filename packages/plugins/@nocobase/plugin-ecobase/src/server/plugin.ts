import { Plugin } from '@nocobase/server';
import {
  amazonOperationsCsvAdapter,
  amazonSpApiAccessCheckAdapter,
  createSourceAdapterRegistry,
  googleSheetsMigrationCsvAdapter,
  noopTestAdapter,
  sellerboardApiAdapter,
  sellerboardCsvAdapter,
} from './adapters';
import type { SourceAdapterRegistry } from './adapters';
import { ECOBASE_COLLECTIONS } from './collections/names';
import { EcobaseImportService } from './services/import-service';
import { EcobasePlanningCalculationService } from './services/planning-calculation-service';
import { EcobasePlanningProductService } from './services/planning-product-service';

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

function getOptionalNumber(values: Record<string, unknown>, key: string): number | undefined {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getActorId(ctx: { state?: Record<string, unknown> }) {
  const currentUser = ctx.state?.currentUser;
  if (typeof currentUser === 'object' && currentUser !== null) {
    const id = (currentUser as Record<string, unknown>).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

export function createEcobasePlanningActions() {
  return {
    listDuplicateMappings: async (ctx, next) => {
      const service = new EcobasePlanningProductService(ctx.db);
      ctx.body = { data: await service.listDuplicateMappings() };
      await next();
    },
    confirmMapping: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const planningProductId = getOptionalString(values, 'planningProductId');
      if (!planningProductId) {
        ctx.throw(400, 'Ecobase planning mapping confirmation requires planningProductId.');
        return;
      }

      const service = new EcobasePlanningProductService(ctx.db);
      ctx.body = {
        data: await service.confirmPlanningProduct({
          planningProductId,
          actorId: getActorId(ctx),
          note: getOptionalString(values, 'note'),
        }),
      };
      await next();
    },
    adjustMapping: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobasePlanningProductService(ctx.db);
      ctx.body = {
        data: await service.adjustMapping({
          planningProductListingId: getOptionalString(values, 'planningProductListingId'),
          rawListingNaturalKey: getOptionalString(values, 'rawListingNaturalKey'),
          targetPlanningProductId: getOptionalString(values, 'targetPlanningProductId'),
          targetCompany: getOptionalString(values, 'targetCompany'),
          targetCanonicalAsin: getOptionalString(values, 'targetCanonicalAsin'),
          targetTitle: getOptionalString(values, 'targetTitle'),
          actorId: getActorId(ctx),
          note: getOptionalString(values, 'note'),
        }),
      };
      await next();
    },
    productData: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const planningProductId = getOptionalString(values, 'planningProductId');
      if (!planningProductId) {
        ctx.throw(400, 'Ecobase planning product data query requires planningProductId.');
        return;
      }

      const service = new EcobasePlanningProductService(ctx.db);
      ctx.body = { data: await service.getPlanningProductData({ planningProductId }) };
      await next();
    },
    calculateProduct: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const planningProductId = getOptionalString(values, 'planningProductId');
      if (!planningProductId) {
        ctx.throw(400, 'Ecobase planning calculation requires planningProductId.');
        return;
      }

      const service = new EcobasePlanningCalculationService(ctx.db);
      ctx.body = {
        data: await service.calculatePlanningProduct({
          planningProductId,
          calculationDate: getOptionalString(values, 'calculationDate'),
          safetyBufferDays: getOptionalNumber(values, 'safetyBufferDays'),
        }),
      };
      await next();
    },
    validationReport: async (ctx, next) => {
      const service = new EcobasePlanningCalculationService(ctx.db);
      ctx.body = { data: await service.validateBenchmarks() };
      await next();
    },
  };
}

export function createEcobaseImportActions(registry: SourceAdapterRegistry) {
  return {
    run: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const sourceConnectionId = getOptionalString(values, 'sourceConnectionId');
      const adapterName = getOptionalString(values, 'adapterName');
      if (!sourceConnectionId || !adapterName) {
        ctx.throw(400, 'Ecobase import requires sourceConnectionId and adapterName.');
        return;
      }

      const service = new EcobaseImportService(ctx.db, registry);
      const importRun = await service.runAdapterImport({
        sourceConnectionId,
        adapterName,
        sourceIdentifier: getOptionalString(values, 'sourceIdentifier'),
        sourceVersion: getOptionalString(values, 'sourceVersion'),
        idempotencyKey: getOptionalString(values, 'idempotencyKey'),
        preserveAuditRun: true,
      });
      ctx.body = { data: importRun };
      await next();
    },
    runDailySnapshot: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const sourceConnectionId = getOptionalString(values, 'sourceConnectionId');
      const adapterName = getOptionalString(values, 'adapterName');
      if (!sourceConnectionId || !adapterName) {
        ctx.throw(400, 'Ecobase daily snapshot requires sourceConnectionId and adapterName.');
        return;
      }

      const service = new EcobaseImportService(ctx.db, registry);
      const importRun = await service.runAdapterImport({
        sourceConnectionId,
        adapterName,
        sourceIdentifier: getOptionalString(values, 'sourceIdentifier'),
        sourceVersion: getOptionalString(values, 'sourceVersion'),
        idempotencyKey: getOptionalString(values, 'idempotencyKey'),
        preserveAuditRun: true,
        skipIfNoNewerData: true,
      });
      ctx.body = { data: importRun };
      await next();
    },
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
  private registry = createSourceAdapterRegistry([
    noopTestAdapter,
    amazonOperationsCsvAdapter,
    googleSheetsMigrationCsvAdapter,
    sellerboardCsvAdapter,
    sellerboardApiAdapter,
    amazonSpApiAccessCheckAdapter,
  ]);

  async load() {
    this.app.resourceManager.define({
      name: 'ecobaseImport',
      actions: createEcobaseImportActions(this.registry),
    });
    this.app.resourceManager.define({
      name: 'ecobasePlanning',
      actions: createEcobasePlanningActions(),
    });

    this.app.acl.allow('ecobaseImport', ['run', 'runDailySnapshot', 'runNoop', 'status', 'adapters'], 'loggedIn');
    this.app.acl.allow(
      'ecobasePlanning',
      [
        'listDuplicateMappings',
        'confirmMapping',
        'adjustMapping',
        'productData',
        'calculateProduct',
        'validationReport',
      ],
      'loggedIn',
    );
    this.app.acl.allow(ECOBASE_COLLECTIONS.companies, ['list', 'get', 'create', 'update', 'destroy'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.amazonAccounts, ['list', 'get', 'create', 'update', 'destroy'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.sourceConnections, ['list', 'get', 'create', 'update'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.importRuns, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.rawImportRows, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.rawListings, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.planningProducts, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.planningProductListings, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.planningProductMappingAudits, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.listingDailyFacts, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.inventorySnapshots, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.trafficSnapshots, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.planningParameters, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.suppliers, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.supplierLeadTimes, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.targetRows, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.planningCalculationSnapshots, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.sourceAccessAudits, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(
      ECOBASE_COLLECTIONS.sourceWarningPolicies,
      ['list', 'get', 'create', 'update', 'destroy'],
      'loggedIn',
    );
  }
}

export default PluginEcobaseServer;
