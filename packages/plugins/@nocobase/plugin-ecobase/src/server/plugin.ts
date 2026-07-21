/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
  sellerboardHistoryCsvAdapter,
} from '../features/source-import/server/adapters';
import type { SourceAdapterRegistry } from '../features/source-import/server/adapters';
import { createEcobaseAiTools } from './ecobase-ai-tools';
import { createDailyOperationsBriefResourceRegistration } from '../features/daily-operations-brief/server/resource-registration';
import {
  blockRawGoldInventoryPlanningAccess,
  registerGoldInventoryPlanningWriteGuard,
} from '../features/inventory-planning/server/gold-write-guard';
import { createInventoryDashboardResourceRegistration } from '../features/inventory-dashboard/server/resource-registration';
import { createInventoryPlanningResourceRegistration } from '../features/inventory-planning/server/resource-registration';
import { EcobaseInventoryPlanningService } from '../features/inventory-planning/server/inventory-planning-service';
import { createOrderPlanningResourceRegistration } from '../features/order-planning/server/resource-registration';
import { createSemanticModelResourceRegistration } from '../features/semantic-model/server/resource-registration';
import { createSourceImportResourceRegistration } from '../features/source-import/server/resource-registration';
import { EcobaseImportService } from '../features/source-import/server/import-service';
import { EcobaseSourceConnectionService } from '../features/source-import/server/source-connection-service';
import { createSupplierManagementResourceRegistration } from '../features/supplier-management/server/resource-registration';
import { registerEcobaseResources } from './resource-registration';
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

export const SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS = 1000;

export class SellerboardGoldPromotionDebouncer {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private pending = false;
  private stopped = false;

  constructor(
    private readonly promote: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  schedule() {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.armTimer();
  }

  stop() {
    this.stopped = true;
    this.pending = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private armTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runPromotion();
    }, SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private async runPromotion() {
    this.running = true;
    try {
      await this.promote();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      if (this.pending && !this.stopped) {
        this.pending = false;
        this.armTimer();
      }
    }
  }
}

export class PluginEcobaseServer extends Plugin {
  declare app: any;
  private registry = createSourceAdapterRegistry([
    noopTestAdapter,
    amazonOperationsCsvAdapter,
    googleSheetsMigrationCsvAdapter,
    sellerboardCsvAdapter,
    sellerboardApiAdapter,
    sellerboardHistoryCsvAdapter,
    amazonSpApiAccessCheckAdapter,
    clickupFixtureAdapter,
    clickupAccessCheckAdapter,
  ]);

  private sellerboardScheduler?: ReturnType<typeof setInterval>;
  private sellerboardSchedulerRunning = false;
  private sellerboardGoldPromotion?: SellerboardGoldPromotionDebouncer;

  private startSellerboardScheduler() {
    if (this.sellerboardScheduler) {
      return;
    }
    this.sellerboardGoldPromotion = new SellerboardGoldPromotionDebouncer(
      async () => {
        const result = await new EcobaseInventoryPlanningService(this.app.db).refreshAndPublish();
        if (result.status === 'failed') {
          throw new Error(`Ecobase scheduled Gold promotion failed with code ${result.code}.`);
        }
      },
      (error) => this.app.logger?.error?.(error),
    );
    const runScheduledImports = async () => {
      if (this.sellerboardSchedulerRunning) {
        return;
      }
      this.sellerboardSchedulerRunning = true;
      try {
        const service = new EcobaseImportService(this.app.db, this.registry);
        await service.runScheduledSellerboardImports({
          onCommittedUnit: () => this.sellerboardGoldPromotion?.schedule(),
        });
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
    if (this.sellerboardScheduler) clearInterval(this.sellerboardScheduler);
    this.sellerboardScheduler = undefined;
    this.sellerboardGoldPromotion?.stop();
    this.sellerboardGoldPromotion = undefined;
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
    registerGoldInventoryPlanningWriteGuard(this.app.db);
    this.app.resourceManager.use(blockRawGoldInventoryPlanningAccess);
    this.registerAiEmployeeTools();
    this.app.on('afterStart', async () => {
      await ensureEcobaseCollectionManagerMetadata(this.app.db);
      await new EcobaseSourceConnectionService(this.app.db).ensureDefaultCsvSourceConnections();
      this.startSellerboardScheduler();
    });
    this.app.on('beforeStop', async () => {
      this.stopSellerboardScheduler();
    });

    registerEcobaseResources(this.app, [
      createSourceImportResourceRegistration(this.registry, () => this.sellerboardGoldPromotion?.schedule()),
      createInventoryPlanningResourceRegistration(),
      createInventoryDashboardResourceRegistration(),
      createOrderPlanningResourceRegistration(),
      createSupplierManagementResourceRegistration(),
      createSemanticModelResourceRegistration(),
      createDailyOperationsBriefResourceRegistration(this.app),
    ]);
  }
}

export default PluginEcobaseServer;
