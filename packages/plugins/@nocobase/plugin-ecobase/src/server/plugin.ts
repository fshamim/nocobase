import { Plugin } from '@nocobase/server';
import {
  amazonOperationsCsvAdapter,
  amazonSpApiAccessCheckAdapter,
  clickupAccessCheckAdapter,
  clickupFixtureAdapter,
  createSourceAdapterRegistry,
  googleSheetsMigrationCsvAdapter,
  noopTestAdapter,
  sellerboardApiAdapter,
  sellerboardCsvAdapter,
} from '../features/source-import/server/adapters';
import type { SourceAdapterRegistry } from '../features/source-import/server/adapters';
import { ECOBASE_COLLECTIONS } from './collections/names';
import { createEcobaseAiTools } from './ecobase-ai-tools';
import { createDailyOperationsBriefResourceRegistration } from '../features/daily-operations-brief/server/resource-registration';
import { createInventoryPlanningResourceRegistration } from '../features/inventory-planning/server/resource-registration';
import { createOrderPlanningResourceRegistration } from '../features/order-planning/server/resource-registration';
import { createSemanticModelResourceRegistration } from '../features/semantic-model/server/resource-registration';
import { createSourceImportResourceRegistration } from '../features/source-import/server/resource-registration';
import { EcobaseImportService } from '../features/source-import/server/import-service';
import { EcobaseSourceConnectionService } from '../features/source-import/server/source-connection-service';
import { createSupplierManagementResourceRegistration } from '../features/supplier-management/server/resource-registration';
import { registerEcobaseResources } from './resource-registration';
import { validateSupplierOrderActivityModel } from './resource-actions';
import { ensureEcobaseCollectionManagerMetadata } from './services/collection-manager-metadata-service';

export {
  createEcobaseAccountabilityActions,
  createEcobaseAccuracyActions,
  createEcobaseAiActions,
  createEcobaseAlertActions,
  createEcobaseComparisonActions,
  createEcobaseDashboardActions,
  createEcobaseImportActions,
  createEcobaseInventoryPlanningActions,
  createEcobaseMedallionWorkflowActions,
  createEcobaseOperatorWorkspaceActions,
  createEcobaseOrderPlanningActions,
  createEcobasePlanningActions,
  createEcobasePlanningSettingsActions,
  createEcobaseReportActions,
  createEcobaseSilverDataActions,
  createEcobaseSupplierManagementActions,
  createEcobaseSupplierOrderActions,
} from './resource-actions';

export class PluginEcobaseServer extends Plugin {
  declare app: any;
  private registry = createSourceAdapterRegistry([
    noopTestAdapter,
    amazonOperationsCsvAdapter,
    googleSheetsMigrationCsvAdapter,
    sellerboardCsvAdapter,
    sellerboardApiAdapter,
    amazonSpApiAccessCheckAdapter,
    clickupFixtureAdapter,
    clickupAccessCheckAdapter,
  ]);

  private sellerboardScheduler?: ReturnType<typeof setInterval>;
  private sellerboardSchedulerRunning = false;

  private startSellerboardScheduler() {
    if (this.sellerboardScheduler) {
      return;
    }
    const runScheduledImports = async () => {
      if (this.sellerboardSchedulerRunning) {
        return;
      }
      this.sellerboardSchedulerRunning = true;
      try {
        const service = new EcobaseImportService(this.app.db, this.registry);
        await service.runScheduledSellerboardImports();
      } catch (error) {
        this.app.logger?.error?.(error);
      } finally {
        this.sellerboardSchedulerRunning = false;
      }
    };
    this.sellerboardScheduler = setInterval(runScheduledImports, 60 * 1000);
    this.sellerboardScheduler.unref?.();
  }

  private stopSellerboardScheduler() {
    if (!this.sellerboardScheduler) {
      return;
    }
    clearInterval(this.sellerboardScheduler);
    this.sellerboardScheduler = undefined;
  }

  private registerAiEmployeeTools() {
    type AiToolsHost = { ai?: { toolsManager?: { registerTools?: (tools: unknown[]) => void } } };
    type AiManagerHost = { aiManager?: { toolsManager?: { registerTools?: (tools: unknown[]) => void } } };
    const self = this as unknown;
    const app = this.app as unknown;
    const directToolsManager = (self as AiToolsHost).ai?.toolsManager;
    const appToolsManager = (app as AiManagerHost).aiManager?.toolsManager;
    const toolsManager = directToolsManager ?? appToolsManager;
    if (typeof toolsManager?.registerTools !== 'function') {
      this.app.log?.warn?.(
        'Ecobase AI tools were not registered because the NocoBase AI tools manager is unavailable.',
      );
      return;
    }
    try {
      toolsManager.registerTools(createEcobaseAiTools());
    } catch (error) {
      this.app.log?.warn?.('Ecobase AI tools registration failed.', error);
    }
  }

  async load() {
    this.registerAiEmployeeTools();
    this.app.on('afterStart', async () => {
      await ensureEcobaseCollectionManagerMetadata(this.app.db);
      await new EcobaseSourceConnectionService(this.app.db).ensureDefaultCsvSourceConnections();
      this.startSellerboardScheduler();
    });
    this.app.on('beforeStop', async () => {
      this.stopSellerboardScheduler();
    });

    this.app.db.on(`${ECOBASE_COLLECTIONS.supplierOrderActivities}.beforeCreate`, validateSupplierOrderActivityModel);
    this.app.db.on(`${ECOBASE_COLLECTIONS.supplierOrderActivities}.beforeUpdate`, validateSupplierOrderActivityModel);

    registerEcobaseResources(this.app, [
      createSourceImportResourceRegistration(this.registry),
      createInventoryPlanningResourceRegistration(),
      createOrderPlanningResourceRegistration(),
      createSupplierManagementResourceRegistration(),
      createSemanticModelResourceRegistration(),
      createDailyOperationsBriefResourceRegistration(this.app),
    ]);
  }
}

export default PluginEcobaseServer;
