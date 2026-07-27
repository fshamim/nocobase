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
} from '../features/inventory-dashboard/server/engine/gold-write-guard';
import { createInventoryDashboardResourceRegistration } from '../features/inventory-dashboard/server/resource-registration';
import { createGoldEngineMaintenanceResourceRegistration } from '../features/inventory-dashboard/server/engine/maintenance-resource-registration';
import { EcobaseInventoryPlanningService } from '../features/inventory-dashboard/server/engine/inventory-planning-service';
import {
  EcobaseScheduledReceiptReconciler,
  type ScheduledReceiptReconciliationLogger,
} from '../features/inventory-dashboard/server/engine/scheduled-receipt-reconciliation';
import { createOrderPlanningResourceRegistration } from '../features/order-planning/server/resource-registration';
import { createSemanticModelResourceRegistration } from '../features/semantic-model/server/resource-registration';
import { createSourceImportResourceRegistration } from '../features/source-import/server/resource-registration';
import {
  EcobaseImportService,
  type EcobaseDatabase,
  type SellerboardCommittedUnitHandler,
} from '../features/source-import/server/import-service';
import { EcobaseSourceConnectionService } from '../features/source-import/server/source-connection-service';
import { createSupplierManagementResourceRegistration } from '../features/supplier-management/server/resource-registration';
import { registerEcobaseResources } from './resource-registration';
import { ensureEcobaseCollectionManagerMetadata } from './services/collection-manager-metadata-service';
import { EcobasePlanningSettingsService } from './services/planning-settings-service';

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
    private readonly delayMs: () => number | Promise<number> = () => SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS,
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
    Promise.resolve()
      .then(() => this.delayMs())
      .then((delay) => this.armWithDelay(delay))
      .catch((error) => {
        this.onError(error);
        this.armWithDelay(SELLERBOARD_GOLD_PROMOTION_DEBOUNCE_MS);
      });
  }

  private armWithDelay(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runPromotion();
    }, delay);
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

export interface EcobaseGoldPromotionHost {
  db: EcobaseDatabase;
  logger?: ScheduledReceiptReconciliationLogger;
}

export interface EcobaseGoldPromotions {
  /** Debounced promotion for committed Sellerboard import units — reconciles receipts, then publishes. */
  sellerboardImport: SellerboardGoldPromotionDebouncer;
  /** Debounced promotion for operator writes — publishes only, never reconciles. */
  operatorWrite: SellerboardGoldPromotionDebouncer;
  receiptReconciler: EcobaseScheduledReceiptReconciler;
  onSellerboardCommittedUnit: SellerboardCommittedUnitHandler;
  stop(): void;
}

/**
 * Builds the two Gold promotion paths and the committed-unit hook that feeds
 * the Sellerboard one. Exported so the wiring (order of operations, scope
 * accumulation, failure isolation) is testable without booting the plugin.
 */
export function createEcobaseGoldPromotions(host: EcobaseGoldPromotionHost): EcobaseGoldPromotions {
  const publishGold = async () => {
    const result = await new EcobaseInventoryPlanningService(host.db).refreshAndPublish();
    if (result.status === 'failed') {
      throw new Error(`Ecobase scheduled Gold promotion failed with code ${result.code}.`);
    }
  };
  const onError = (error: unknown) => host.logger?.error?.(error);
  const receiptReconciler = new EcobaseScheduledReceiptReconciler(host.db, host.logger);
  // Issue 054 R1: the Sellerboard-import-triggered promotion stamps arrival
  // evidence onto Silver order lines before Gold reads it. Reconciliation never
  // blocks the publish — the reconciler logs and counts its own failures.
  const sellerboardImport = new SellerboardGoldPromotionDebouncer(async () => {
    await receiptReconciler.reconcilePendingScope();
    await publishGold();
  }, onError);
  // Task 001 (surgical v1.1): operator writes share the same publish but get
  // their own, longer, settings-driven debounce window so a burst of edits
  // produces one publish and imports cannot starve operator triggers. Operator
  // edits do not move Sellerboard evidence, so this path never reconciles.
  const operatorWrite = new SellerboardGoldPromotionDebouncer(publishGold, onError, async () => {
    const settings = await new EcobasePlanningSettingsService(host.db).getResolvedSettings();
    return settings.operatorWritePublishDebounceSeconds * 1000;
  });
  return {
    sellerboardImport,
    operatorWrite,
    receiptReconciler,
    onSellerboardCommittedUnit: (unit) => {
      receiptReconciler.recordCommittedUnit(unit);
      sellerboardImport.schedule();
    },
    stop() {
      sellerboardImport.stop();
      operatorWrite.stop();
    },
  };
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
  private goldPromotions?: EcobaseGoldPromotions;

  private startSellerboardScheduler() {
    if (this.sellerboardScheduler) {
      return;
    }
    const promotions = createEcobaseGoldPromotions({ db: this.app.db, logger: this.app.logger });
    this.goldPromotions = promotions;
    const runScheduledImports = async () => {
      if (this.sellerboardSchedulerRunning) {
        return;
      }
      this.sellerboardSchedulerRunning = true;
      try {
        const service = new EcobaseImportService(this.app.db, this.registry);
        await service.runScheduledSellerboardImports({
          onCommittedUnit: promotions.onSellerboardCommittedUnit,
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
    this.goldPromotions?.stop();
    this.goldPromotions = undefined;
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

    // Task 001: operator writes schedule a debounced Gold publish.
    const onOperatorWrite = () => this.goldPromotions?.operatorWrite.schedule();
    registerEcobaseResources(this.app, [
      createSourceImportResourceRegistration(
        this.registry,
        (unit) => this.goldPromotions?.onSellerboardCommittedUnit(unit),
        // 070: a committed ClickUp apply publishes through the operator-write debouncer.
        onOperatorWrite,
      ),
      createGoldEngineMaintenanceResourceRegistration(onOperatorWrite),
      createInventoryDashboardResourceRegistration(onOperatorWrite),
      createOrderPlanningResourceRegistration(onOperatorWrite),
      createSupplierManagementResourceRegistration(onOperatorWrite),
      createSemanticModelResourceRegistration(),
      createDailyOperationsBriefResourceRegistration(this.app),
    ]);
  }
}

export default PluginEcobaseServer;
