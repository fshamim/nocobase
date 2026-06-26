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
} from './adapters';
import type { SourceAdapterRegistry } from './adapters';
import type { CsvSourceFile } from './adapters/csv-utils';
import { ECOBASE_COLLECTIONS } from './collections/names';
import { createEcobaseAiTools } from './ecobase-ai-tools';
import { EcobaseAccountabilityService } from './services/accountability-service';
import { EcobaseAccuracyHarnessService } from './services/accuracy-harness-service';
import { EcobaseAiRetrievalService } from './services/ai-retrieval-service';
import { EcobaseAlertEvaluationService } from './services/alert-evaluation-service';
import { ensureEcobaseCollectionManagerMetadata } from './services/collection-manager-metadata-service';
import { EcobaseComparisonService } from './services/comparison-service';
import { EcobaseDashboardService } from './services/dashboard-service';
import { EcobaseDailyOperationsBriefService } from './services/daily-operations-brief-service';
import { EcobaseDailyOperationsBriefDeliveryService } from './services/daily-operations-brief-delivery-service';
import { EcobaseDailyManagementSnapshotService } from './services/daily-management-snapshot-service';
import { EcobaseDailyBriefPromptSettingsService } from './services/daily-brief-prompt-settings-service';
import {
  EcobaseDailyOperationsBriefNarrativeService,
  NocoBaseEcoNarrativeProvider,
} from './services/daily-operations-brief-narrative-service';
import { EcobaseImportService } from './services/import-service';
import { EcobaseInventoryPlanningService } from './services/inventory-planning-service';
import { EcobaseOrderPlanningService } from './services/order-planning-service';
import { EcobaseMedallionNormalizationService } from './services/medallion-normalization-service';
import { EcobaseMedallionOrderService } from './services/medallion-order-service';
import { EcobaseMedallionWorkflowService } from './services/medallion-workflow-service';
import { EcobasePlanningCalculationService } from './services/planning-calculation-service';
import { EcobasePlanningProductService } from './services/planning-product-service';
import { EcobaseOperatorWorkspaceService } from './services/operator-workspace-service';
import { EcobaseReportService } from './services/report-service';
import { EcobaseSilverDataService } from './services/silver-data-service';
import type { SilverFocus } from './services/silver-data-service';
import { EcobaseSourceConnectionService } from './services/source-connection-service';
import { EcobaseSupplierManagementService } from './services/supplier-management-service';
import {
  EcobaseSupplierOrderService,
  validateSupplierLeadTimeDays,
  validateSupplierOrderActivityType,
} from './services/supplier-order-service';

function getValues(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) {
    return {};
  }
  const record = params as Record<string, unknown>;
  const values = record.values;
  return typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : record;
}

function getOptionalString(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getOptionalId(values: Record<string, unknown>, key: string): string | number | undefined {
  const value = values[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function getOptionalNumber(values: Record<string, unknown>, key: string): number | undefined {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getOptionalBoolean(values: Record<string, unknown>, key: string): boolean | undefined {
  const value = values[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getOptionalStringArray(values: Record<string, unknown>, key: string): string[] | undefined {
  const value = values[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (typeof value === 'string')
    return value
      .split(/[\n,]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  return undefined;
}

function getOptionalRecord(values: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = values[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getOptionalRecordArray(values: Record<string, unknown>, key: string): Record<string, unknown>[] | undefined {
  const value = values[key];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : undefined;
}

function getCsvFiles(values: Record<string, unknown>): CsvSourceFile[] {
  const files = values.files;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((file): CsvSourceFile[] => {
    if (typeof file !== 'object' || file === null) {
      return [];
    }
    const record = file as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const content = typeof record.content === 'string' ? record.content : '';
    const csvFile: CsvSourceFile = { name, content };
    if (typeof record.expectedRowCount === 'number') {
      csvFile.expectedRowCount = record.expectedRowCount;
    }
    if (typeof record.snapshotDate === 'string') {
      csvFile.snapshotDate = record.snapshotDate;
    }
    return [csvFile];
  });
}

function getActorId(ctx: { state?: Record<string, unknown> }) {
  const currentUser = ctx.state?.currentUser;
  if (typeof currentUser === 'object' && currentUser !== null) {
    const id = (currentUser as Record<string, unknown>).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function readModelValue(model: { get?: (key?: string) => unknown }, key: string): unknown {
  if (typeof model.get !== 'function') {
    return undefined;
  }
  return model.get(key);
}

function validateSupplierOrderActivityModel(model: { get?: (key?: string) => unknown }) {
  const activityType = readModelValue(model, 'activityType');
  if (typeof activityType !== 'string') {
    throw new Error('Ecobase supplier-order activity failed: activityType is required.');
  }
  validateSupplierOrderActivityType(activityType);
  const leadTimeDays = readModelValue(model, 'leadTimeDays');
  if (leadTimeDays !== undefined && leadTimeDays !== null && typeof leadTimeDays !== 'number') {
    throw new Error('Ecobase supplier-order activity failed: leadTimeDays must be a number.');
  }
  const validatedLeadTimeDays = validateSupplierLeadTimeDays(
    typeof leadTimeDays === 'number' ? leadTimeDays : undefined,
    'Ecobase supplier-order activity failed',
  );
  if (activityType === 'lead_time_checked' && validatedLeadTimeDays === undefined) {
    throw new Error('Ecobase supplier-order activity failed: leadTimeDays is required for lead_time_checked.');
  }
}

function compactServerText(value: unknown) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
}

function numericServerValue(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function orderLineMapKey(company: unknown, asin: unknown, sku: unknown) {
  return [company, asin, sku].map((value) => compactServerText(value).toLowerCase()).join(':');
}

function firstNonEmptyServerText(values: unknown[]) {
  return values.map(compactServerText).find((value) => value.length > 0);
}

function enrichSupplierOrderWorkspaceForBoard(
  workspace: Record<string, unknown>,
  planningRows: Array<Record<string, unknown>>,
) {
  const supplierOrders = Array.isArray(workspace.supplierOrders)
    ? (workspace.supplierOrders as Array<Record<string, unknown>>)
    : [];
  const supplierOrderLines = Array.isArray(workspace.supplierOrderLines)
    ? (workspace.supplierOrderLines as Array<Record<string, unknown>>)
    : [];
  const suppliers = Array.isArray(workspace.suppliers) ? (workspace.suppliers as Array<Record<string, unknown>>) : [];
  const activities = Array.isArray(workspace.activities)
    ? (workspace.activities as Array<Record<string, unknown>>)
    : [];
  const supplierById = new Map<string, Record<string, unknown>>();
  suppliers.forEach((supplier) => {
    const id = compactServerText(supplier.id);
    if (id) supplierById.set(id, supplier);
    const supplierId = compactServerText(supplier.supplierId);
    if (supplierId) supplierById.set(supplierId, supplier);
  });
  const planningById = new Map<string, Record<string, unknown>>();
  const planningByIdentity = new Map<string, Record<string, unknown>>();
  planningRows.forEach((row) => {
    const planningProductId = compactServerText(row.planningProductId);
    if (planningProductId) planningById.set(planningProductId, row);
    planningByIdentity.set(orderLineMapKey(row.company, row.asin, row.sku), row);
  });
  const linesByOrderId = new Map<string, Array<Record<string, unknown>>>();
  supplierOrderLines.forEach((line) => {
    const supplierOrderId = compactServerText(line.supplierOrderId);
    if (!supplierOrderId) return;
    const lines = linesByOrderId.get(supplierOrderId) ?? [];
    lines.push(line);
    linesByOrderId.set(supplierOrderId, lines);
  });
  const activitiesByOrderId = new Map<string, Array<Record<string, unknown>>>();
  activities.forEach((activity) => {
    const supplierOrderId = compactServerText(activity.supplierOrderId);
    if (!supplierOrderId) return;
    const rows = activitiesByOrderId.get(supplierOrderId) ?? [];
    rows.push(activity);
    activitiesByOrderId.set(supplierOrderId, rows);
  });

  const enrichedOrders = supplierOrders.map((order) => {
    const orderId = compactServerText(order.id);
    const lines = linesByOrderId.get(orderId) ?? [];
    const supplier = supplierById.get(compactServerText(order.supplierId));
    const lineSummaries = lines.map((line) => {
      const planningRow =
        planningById.get(compactServerText(line.planningProductId)) ??
        planningByIdentity.get(orderLineMapKey(line.company, line.asin, line.sku));
      return {
        id: line.id,
        planningProductId: line.planningProductId,
        asin: line.asin,
        sku: line.sku,
        brand: line.brand,
        orderedQty: numericServerValue(line.orderedQty),
        receivedQty: numericServerValue(line.receivedQty),
        openQty: Math.max(0, numericServerValue(line.orderedQty) - numericServerValue(line.receivedQty)),
        estimatedOosDate: planningRow?.estimatedOosDate,
        estimatedProfitRisk: planningRow?.estimatedProfitRisk,
        actionStatus: planningRow?.actionStatus,
        tier: planningRow?.tier,
        productStatus: planningRow?.productStatus,
      };
    });
    const planningMatches = lineSummaries.filter(
      (line) => line.estimatedOosDate || line.estimatedProfitRisk !== undefined,
    );
    const riskValues = planningMatches
      .map((line) => numericServerValue(line.estimatedProfitRisk))
      .filter((value) => value > 0);
    const oosDates = planningMatches
      .map((line) => compactServerText(line.estimatedOosDate))
      .filter(Boolean)
      .sort();
    const latestActivity = (activitiesByOrderId.get(orderId) ?? []).sort((left, right) =>
      compactServerText(right.occurredAt).localeCompare(compactServerText(left.occurredAt)),
    )[0];
    const blockerSummary = firstNonEmptyServerText([
      order.blockedReason,
      latestActivity?.notes,
      (order.payload as Record<string, unknown> | undefined)?.Remarks,
      (order.payload as Record<string, unknown> | undefined)?.['AM Remarks'],
      (order.payload as Record<string, unknown> | undefined)?.['COO Remarks'],
      ...lines.flatMap((line) => [
        (line.payload as Record<string, unknown> | undefined)?.Remarks,
        (line.payload as Record<string, unknown> | undefined)?.['AM Remarks'],
        (line.payload as Record<string, unknown> | undefined)?.['COO Remarks'],
      ]),
    ]);
    return {
      ...order,
      supplierName: firstNonEmptyServerText([
        supplier?.name,
        (order.payload as Record<string, unknown> | undefined)?.Supplier,
        order.supplierName,
      ]),
      lineCount: lines.length,
      openQty: lineSummaries.reduce((total, line) => total + line.openQty, 0),
      lineSummaries,
      productRiskSummary: {
        earliestOosDate: oosDates[0],
        maxEstimatedProfitRisk: riskValues.length ? Math.max(...riskValues) : undefined,
        mappedLineCount: planningMatches.length,
      },
      blockerSummary,
    };
  });

  return { ...workspace, supplierOrders: enrichedOrders };
}

export function createEcobaseAccuracyActions() {
  return {
    checklistTemplate: async (ctx, next) => {
      ctx.body = { data: new EcobaseAccuracyHarnessService(ctx.db).checklistTemplate() };
      await next();
    },
    recordSignoff: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseAccuracyHarnessService(ctx.db);
      try {
        ctx.body = {
          data: await service.recordSignoff({
            company: getOptionalString(values, 'company'),
            status: getOptionalString(values, 'status') as
              | 'draft'
              | 'data-quality-signed-off'
              | 'blocked/not-accepted-for-contract-delivery'
              | undefined,
            signedOffBy: getOptionalString(values, 'signedOffBy'),
            checklist:
              typeof values.checklist === 'object' && values.checklist !== null
                ? (values.checklist as Record<string, unknown>)
                : undefined,
            credentialBlockers: Array.isArray(values.credentialBlockers) ? values.credentialBlockers : undefined,
            notes: getOptionalString(values, 'notes'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase data-quality sign-off failed.');
        return;
      }
      await next();
    },
    evaluate: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const dataQualitySignoffId = getOptionalString(values, 'dataQualitySignoffId');
      if (!dataQualitySignoffId) {
        ctx.throw(400, 'Ecobase accuracy evaluation requires dataQualitySignoffId.');
        return;
      }
      const service = new EcobaseAccuracyHarnessService(ctx.db);
      try {
        ctx.body = {
          data: await service.evaluate({ company: getOptionalString(values, 'company'), dataQualitySignoffId }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase accuracy evaluation failed.');
        return;
      }
      await next();
    },
  };
}

export function createEcobaseAiActions() {
  return {
    answer: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const question = getOptionalString(values, 'question');
      if (!question) {
        ctx.throw(400, 'Ecobase AI answer requires question.');
        return;
      }
      const service = new EcobaseAiRetrievalService(ctx.db);
      try {
        ctx.body = {
          data: await service.answerQuestion({
            question,
            company: getOptionalString(values, 'company'),
            date: getOptionalString(values, 'date'),
            period: getOptionalString(values, 'period'),
            periodType: getOptionalString(values, 'periodType') as 'daily' | 'weekly' | 'monthly' | undefined,
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase AI answer failed.');
        return;
      }
      await next();
    },
    askEphemeral: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const question = getOptionalString(values, 'question');
      if (!question) {
        ctx.throw(400, 'Ecobase ephemeral AI answer requires question.');
        return;
      }
      const service = new EcobaseAiRetrievalService(ctx.db);
      try {
        ctx.body = {
          data: await service.answerQuestion(
            {
              question,
              company: getOptionalString(values, 'company'),
              date: getOptionalString(values, 'date'),
              period: getOptionalString(values, 'period'),
              periodType: getOptionalString(values, 'periodType') as 'daily' | 'weekly' | 'monthly' | undefined,
            },
            { persist: false },
          ),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase ephemeral AI answer failed.');
        return;
      }
      await next();
    },
    retrieveFacts: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseAiRetrievalService(ctx.db);
      ctx.body = {
        data: await service.retrieveFacts({
          question: getOptionalString(values, 'question') ?? 'Retrieve scoped Ecobase facts.',
          company: getOptionalString(values, 'company'),
          date: getOptionalString(values, 'date'),
          period: getOptionalString(values, 'period'),
          periodType: getOptionalString(values, 'periodType') as 'daily' | 'weekly' | 'monthly' | undefined,
        }),
      };
      await next();
    },
    coverage: async (ctx, next) => {
      ctx.body = { data: new EcobaseAiRetrievalService(ctx.db).coverageMatrix() };
      await next();
    },
  };
}

export function createEcobaseReportActions(app?: { pm?: { get?: (name: string) => unknown } }) {
  return {
    generatePreview: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const frequency = getOptionalString(values, 'frequency');
      if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') {
        ctx.throw(400, 'Ecobase report generation requires frequency to be daily, weekly, or monthly.');
        return;
      }
      const service = new EcobaseReportService(ctx.db);
      try {
        ctx.body = {
          data: await service.generateReport({
            frequency,
            company: getOptionalString(values, 'company'),
            period: getOptionalString(values, 'period'),
            date: getOptionalString(values, 'date'),
            emailEnabled: values.emailEnabled === true,
            emailRecipient: getOptionalString(values, 'emailRecipient'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase report generation failed.');
        return;
      }
      await next();
    },
    generateDailyOperationsBriefEvidence: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseDailyOperationsBriefService(ctx.db);
      try {
        ctx.body = {
          data: await service.generateEvidence({
            date: getOptionalString(values, 'date'),
            company: getOptionalString(values, 'company'),
            timezone: getOptionalString(values, 'timezone'),
            recipient: getOptionalString(values, 'recipient'),
            mode: getOptionalString(values, 'mode') as 'preview' | 'workflow' | 'workflow_send' | undefined,
            maxItems: getOptionalNumber(values, 'maxItems'),
            forceRegenerate: values.forceRegenerate === true,
          }),
        };
      } catch (error) {
        ctx.throw(
          400,
          error instanceof Error ? error.message : 'Ecobase daily operations brief evidence generation failed.',
        );
        return;
      }
      await next();
    },
    generateDailyOperationsBrief: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseDailyOperationsBriefNarrativeService(ctx.db, new NocoBaseEcoNarrativeProvider(app));
      try {
        ctx.body = {
          data: await service.generateBrief({
            date: getOptionalString(values, 'date'),
            company: getOptionalString(values, 'company'),
            timezone: getOptionalString(values, 'timezone'),
            recipient: getOptionalString(values, 'recipient'),
            mode: getOptionalString(values, 'mode') as 'preview' | 'workflow' | 'workflow_send' | undefined,
            aiEmployeeUsername: getOptionalString(values, 'aiEmployeeUsername'),
            llmService: getOptionalString(values, 'llmService'),
            model: getOptionalString(values, 'model'),
            maxItems: getOptionalNumber(values, 'maxItems'),
            forceRegenerate: values.forceRegenerate === true,
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase daily operations brief generation failed.');
        return;
      }
      await next();
    },
    getDailyManagementSnapshotTrend: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const company = getOptionalString(values, 'company');
      try {
        const evidence = await new EcobaseDailyOperationsBriefService(ctx.db).generateEvidence({
          date: getOptionalString(values, 'date'),
          company,
          timezone: getOptionalString(values, 'timezone'),
          maxItems: getOptionalNumber(values, 'maxItems'),
        });
        ctx.body = {
          data: await new EcobaseDailyManagementSnapshotService(ctx.db).getTrend({
            date: String((evidence.evidencePack as Record<string, unknown>).date ?? getOptionalString(values, 'date')),
            company,
            period: getOptionalString(values, 'period') as 'yesterday' | '7d' | '30d' | undefined,
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase daily management trend failed.');
        return;
      }
      await next();
    },
    getDailyBriefPromptSettings: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      try {
        ctx.body = {
          data: await new EcobaseDailyBriefPromptSettingsService(ctx.db).getActiveSettings(
            getOptionalString(values, 'company'),
          ),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase daily brief prompt settings lookup failed.');
        return;
      }
      await next();
    },
    saveDailyBriefPromptSettings: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      try {
        ctx.body = {
          data: await new EcobaseDailyBriefPromptSettingsService(ctx.db).saveSettings({
            id: getOptionalString(values, 'id'),
            name: getOptionalString(values, 'name'),
            isActive: getOptionalBoolean(values, 'isActive'),
            company: getOptionalString(values, 'company'),
            audience: getOptionalString(values, 'audience'),
            tone: getOptionalString(values, 'tone'),
            directorInstructions: getOptionalString(values, 'directorInstructions'),
            mustInclude: getOptionalStringArray(values, 'mustInclude'),
            mustAvoid: getOptionalStringArray(values, 'mustAvoid'),
            kpiPriority: getOptionalStringArray(values, 'kpiPriority'),
            llmService: getOptionalString(values, 'llmService'),
            model: getOptionalString(values, 'model'),
            updatedBy: getOptionalString(values, 'updatedBy'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase daily brief prompt settings save failed.');
        return;
      }
      await next();
    },
    resetDailyBriefPromptSettings: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      try {
        ctx.body = {
          data: await new EcobaseDailyBriefPromptSettingsService(ctx.db).resetSettings(
            getOptionalString(values, 'company'),
          ),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase daily brief prompt settings reset failed.');
        return;
      }
      await next();
    },
    markDailyOperationsBriefSent: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseDailyOperationsBriefDeliveryService(ctx.db);
      try {
        ctx.body = {
          data: await service.markSent({
            reportRunId: getOptionalString(values, 'reportRunId'),
            deliveryProvider: getOptionalString(values, 'deliveryProvider'),
            messageId: getOptionalString(values, 'messageId'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase daily operations brief mark-sent failed.');
        return;
      }
      await next();
    },
    markDailyOperationsBriefFailed: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseDailyOperationsBriefDeliveryService(ctx.db);
      try {
        ctx.body = {
          data: await service.markFailed({
            reportRunId: getOptionalString(values, 'reportRunId'),
            error: getOptionalString(values, 'error'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase daily operations brief mark-failed failed.');
        return;
      }
      await next();
    },
  };
}

export function createEcobaseDashboardActions() {
  return {
    summary: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseDashboardService(ctx.db);
      ctx.body = {
        data: await service.getDashboard({
          company: getOptionalString(values, 'company'),
          accountKey: getOptionalString(values, 'accountKey'),
          date: getOptionalString(values, 'date'),
          periodType: getOptionalString(values, 'periodType') as 'daily' | 'weekly' | 'monthly' | undefined,
          period: getOptionalString(values, 'period'),
          alertType: getOptionalString(values, 'alertType'),
          severity: getOptionalString(values, 'severity'),
          status: getOptionalString(values, 'status'),
        }),
      };
      await next();
    },
    settings: async (ctx, next) => {
      const service = new EcobaseDashboardService(ctx.db);
      ctx.body = { data: await service.getSettings() };
      await next();
    },
    updateSettings: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseDashboardService(ctx.db);
      ctx.body = { data: await service.updateSettings(values) };
      await next();
    },
  };
}

export function createEcobaseOperatorWorkspaceActions() {
  return {
    workspace: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseOperatorWorkspaceService(ctx.db);
      ctx.body = {
        data: await service.getWorkspace({
          company: getOptionalString(values, 'company'),
          sourceConnectionId: getOptionalString(values, 'sourceConnectionId'),
        }),
      };
      await next();
    },
    preview: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseOperatorWorkspaceService(ctx.db);
      try {
        ctx.body = { data: await service.previewView(values) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase operator workspace preview failed.');
        return;
      }
      await next();
    },
    saveView: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseOperatorWorkspaceService(ctx.db);
      try {
        ctx.body = { data: await service.saveBusinessView(values) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase operator workspace save view failed.');
        return;
      }
      await next();
    },
  };
}

export function createEcobaseSilverDataActions() {
  return {
    search: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSilverDataService(ctx.db);
      ctx.body = {
        data: await service.search({
          query: getOptionalString(values, 'query'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    lookup: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSilverDataService(ctx.db);
      try {
        ctx.body = {
          data: await service.lookup({
            type: getOptionalString(values, 'type') as SilverFocus['type'] | undefined,
            query: getOptionalString(values, 'query'),
            limit: getOptionalNumber(values, 'limit'),
            dateFrom: getOptionalString(values, 'dateFrom'),
            dateTo: getOptionalString(values, 'dateTo'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Silver Data lookup failed.');
        return;
      }
      await next();
    },
    context: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSilverDataService(ctx.db);
      ctx.body = {
        data: await service.context({
          focus: getSilverFocus(values),
          query: getOptionalString(values, 'query'),
          pageSize: getOptionalNumber(values, 'pageSize'),
          dateFrom: getOptionalString(values, 'dateFrom'),
          dateTo: getOptionalString(values, 'dateTo'),
        }),
      };
      await next();
    },
    record: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSilverDataService(ctx.db);
      try {
        ctx.body = { data: await service.record(requiredSilverFocus(values, 'record')) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Silver Data record failed.');
        return;
      }
      await next();
    },
    updateRecord: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSilverDataService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateRecord({
            ...requiredSilverFocus(values, 'update'),
            values: getOptionalRecord(values, 'values') ?? {},
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Silver Data update failed.');
        return;
      }
      await next();
    },
    addComment: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSilverDataService(ctx.db);
      try {
        ctx.body = {
          data: await service.addComment({
            ...requiredSilverFocus(values, 'comment'),
            body: getOptionalString(values, 'body'),
            commentType: getOptionalString(values, 'commentType'),
            followUpAt: getOptionalString(values, 'followUpAt'),
            actorUserId: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Silver Data comment failed.');
        return;
      }
      await next();
    },
  };
}

function getSilverFocus(values: Record<string, unknown>) {
  const focus = getOptionalRecord(values, 'focus') ?? values;
  const type = getOptionalString(focus, 'type');
  const id = getOptionalString(focus, 'id');
  return type && id ? { type: type as SilverFocus['type'], id } : undefined;
}

function requiredSilverFocus(values: Record<string, unknown>, actionName: string) {
  const focus = getSilverFocus(values);
  if (!focus) {
    throw new Error(`Ecobase Silver Data ${actionName} failed: type and id are required.`);
  }
  return focus;
}

export function createEcobaseMedallionWorkflowActions() {
  return {
    createComment: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseMedallionWorkflowService(ctx.db);
      try {
        ctx.body = {
          data: await service.createActivityComment({
            entityType: getOptionalString(values, 'entityType') ?? '',
            entityId: getOptionalString(values, 'entityId') ?? '',
            actorType: getOptionalString(values, 'actorType') ?? 'operator',
            actorUserId: getOptionalString(values, 'actorUserId') ?? getActorId(ctx),
            actorAiEmployeeId: getOptionalString(values, 'actorAiEmployeeId'),
            commentType: getOptionalString(values, 'commentType') ?? 'note',
            body: getOptionalString(values, 'body') ?? '',
            followUpAt: getOptionalString(values, 'followUpAt'),
            contextSnapshotJson: getOptionalRecord(values, 'contextSnapshotJson'),
            workflowAction: getOptionalRecord(values, 'workflowAction'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion comment create failed.');
        return;
      }
      await next();
    },
    createTask: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseMedallionWorkflowService(ctx.db);
      try {
        ctx.body = {
          data: await service.createTask({
            title: getOptionalString(values, 'title') ?? '',
            description: getOptionalString(values, 'description'),
            status: getOptionalString(values, 'status'),
            priority: getOptionalString(values, 'priority'),
            dueAt: getOptionalString(values, 'dueAt'),
            assignedToUserId: getOptionalString(values, 'assignedToUserId'),
            assignedToAiEmployeeId: getOptionalString(values, 'assignedToAiEmployeeId'),
            parentTaskId: getOptionalString(values, 'parentTaskId'),
            sourceCommentId: getOptionalString(values, 'sourceCommentId'),
            links: getOptionalRecordArray(values, 'links'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion task create failed.');
        return;
      }
      await next();
    },
    proposeAction: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseMedallionWorkflowService(ctx.db);
      try {
        ctx.body = {
          data: await service.proposeAction({
            title: getOptionalString(values, 'title') ?? '',
            actionType: getOptionalString(values, 'actionType') ?? '',
            actionPayloadJson: getOptionalRecord(values, 'actionPayloadJson'),
            proposedByType: getOptionalString(values, 'proposedByType') as 'ai_employee' | 'workflow' | 'operator',
            proposedById: getOptionalString(values, 'proposedById'),
            assignedReviewerId: getOptionalString(values, 'assignedReviewerId'),
            priority: getOptionalString(values, 'priority'),
            dueAt: getOptionalString(values, 'dueAt'),
            contextSummary: getOptionalString(values, 'contextSummary'),
            evidenceJson: getOptionalRecord(values, 'evidenceJson'),
            riskSummary: getOptionalString(values, 'riskSummary'),
            links: getOptionalRecordArray(values, 'links'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion action proposal failed.');
        return;
      }
      await next();
    },
    approveAndExecute: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseMedallionWorkflowService(ctx.db);
      try {
        ctx.body = {
          data: await service.approveAndExecute(
            getOptionalString(values, 'approvalId') ?? '',
            getOptionalString(values, 'approvedByUserId') ?? getActorId(ctx) ?? '',
          ),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion approval execution failed.');
        return;
      }
      await next();
    },
    rejectApproval: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseMedallionWorkflowService(ctx.db);
      try {
        ctx.body = {
          data: await service.rejectApproval(
            getOptionalString(values, 'approvalId') ?? '',
            getOptionalString(values, 'rejectedReason') ?? '',
          ),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion approval rejection failed.');
        return;
      }
      await next();
    },
    setActionPolicy: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseMedallionWorkflowService(ctx.db);
      try {
        ctx.body = {
          data: await service.setActionPolicy({
            actionType: getOptionalString(values, 'actionType') ?? '',
            requiresHumanApproval:
              values.requiresHumanApproval === undefined ? undefined : values.requiresHumanApproval === true,
            autoExecutable: values.autoExecutable === undefined ? undefined : values.autoExecutable === true,
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion action policy save failed.');
        return;
      }
      await next();
    },
  };
}

export function createEcobaseComparisonActions() {
  return {
    compare: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const periodType = getOptionalString(values, 'periodType');
      if (periodType !== 'daily' && periodType !== 'weekly' && periodType !== 'monthly') {
        ctx.throw(400, 'Ecobase comparison requires periodType to be daily, weekly, or monthly.');
        return;
      }
      const groupBy = getOptionalString(values, 'groupBy');
      if (groupBy && !['company', 'account', 'planning_product', 'raw_listing_sku', 'tier'].includes(groupBy)) {
        ctx.throw(
          400,
          'Ecobase comparison groupBy must be company, account, planning_product, raw_listing_sku, or tier.',
        );
        return;
      }

      const service = new EcobaseComparisonService(ctx.db);
      try {
        ctx.body = {
          data: await service.comparePerformance({
            periodType,
            period: getOptionalString(values, 'period'),
            currentStartDate: getOptionalString(values, 'currentStartDate'),
            currentEndDate: getOptionalString(values, 'currentEndDate'),
            previousStartDate: getOptionalString(values, 'previousStartDate'),
            previousEndDate: getOptionalString(values, 'previousEndDate'),
            groupBy: groupBy as 'company' | 'account' | 'planning_product' | 'raw_listing_sku' | 'tier' | undefined,
            company: getOptionalString(values, 'company'),
            planningProductId: getOptionalString(values, 'planningProductId'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase comparison failed.');
        return;
      }
      await next();
    },
  };
}

export function createEcobaseOrderPlanningActions() {
  return {
    filters: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseOrderPlanningService(ctx.db);
      ctx.body = { data: await service.getFilters(getOptionalString(values, 'companyId')) };
      await next();
    },
    list: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseOrderPlanningService(ctx.db);
      ctx.body = {
        data: await service.listOrders({
          companyId: getOptionalString(values, 'companyId'),
          company: getOptionalString(values, 'company'),
          supplierId: getOptionalString(values, 'supplierId'),
          status: getOptionalString(values, 'status'),
          search: getOptionalString(values, 'search'),
          minMoneyAtRisk: getOptionalNumber(values, 'minMoneyAtRisk'),
          minWaitingDays: getOptionalNumber(values, 'minWaitingDays'),
          hideClosed: getOptionalBoolean(values, 'hideClosed'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    refreshReadModel: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseOrderPlanningService(ctx.db);
      ctx.body = {
        data: await service.refreshReadModel({
          companyId: getOptionalString(values, 'companyId'),
          company: getOptionalString(values, 'company'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    detail: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const orderId = getOptionalString(values, 'orderId');
      if (!orderId) {
        ctx.throw(400, 'Ecobase Order Planning detail requires orderId.');
        return;
      }
      try {
        ctx.body = { data: await new EcobaseOrderPlanningService(ctx.db).getOrderDetail(orderId) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Order Planning detail failed.');
        return;
      }
      await next();
    },
    updateOrder: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const orderId = getOptionalString(values, 'orderId');
      if (!orderId) {
        ctx.throw(400, 'Ecobase Order Planning order update requires orderId.');
        return;
      }
      try {
        ctx.body = {
          data: await new EcobaseOrderPlanningService(ctx.db).updateOrder({
            orderId,
            values: getOptionalRecord(values, 'fields') ?? values,
            commentBody: getOptionalString(values, 'commentBody'),
            actorUserId: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Order Planning order update failed.');
        return;
      }
      await next();
    },
    updateLine: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const orderLineId = getOptionalString(values, 'orderLineId');
      if (!orderLineId) {
        ctx.throw(400, 'Ecobase Order Planning line update requires orderLineId.');
        return;
      }
      try {
        ctx.body = {
          data: await new EcobaseOrderPlanningService(ctx.db).updateLine({
            orderLineId,
            values: getOptionalRecord(values, 'fields') ?? values,
            commentBody: getOptionalString(values, 'commentBody'),
            actorUserId: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Order Planning line update failed.');
        return;
      }
      await next();
    },
    addComment: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const orderId = getOptionalString(values, 'orderId');
      if (!orderId) {
        ctx.throw(400, 'Ecobase Order Planning comment requires orderId.');
        return;
      }
      try {
        ctx.body = {
          data: await new EcobaseOrderPlanningService(ctx.db).addComment({
            orderId,
            body: getOptionalString(values, 'body'),
            actorUserId: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Order Planning comment failed.');
        return;
      }
      await next();
    },
    updateInvoice: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const invoiceId = getOptionalString(values, 'invoiceId');
      if (!invoiceId) {
        ctx.throw(400, 'Ecobase Order Planning invoice update requires invoiceId.');
        return;
      }
      try {
        ctx.body = {
          data: await new EcobaseOrderPlanningService(ctx.db).updateInvoice({
            invoiceId,
            status: getOptionalString(values, 'status'),
            actorUserId: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Order Planning invoice update failed.');
        return;
      }
      await next();
    },
    deleteComment: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const orderId = getOptionalString(values, 'orderId');
      const commentId = getOptionalString(values, 'commentId');
      if (!orderId || !commentId) {
        ctx.throw(400, 'Ecobase Order Planning comment delete requires orderId and commentId.');
        return;
      }
      try {
        ctx.body = {
          data: await new EcobaseOrderPlanningService(ctx.db).deleteComment({
            orderId,
            commentId,
            actorUserId: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Order Planning comment delete failed.');
        return;
      }
      await next();
    },
  };
}

export function createEcobaseInventoryPlanningActions() {
  return {
    filters: async (ctx, next) => {
      const service = new EcobaseInventoryPlanningService(ctx.db);
      ctx.body = { data: await service.filterOptions() };
      await next();
    },
    refreshReadModel: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseInventoryPlanningService(ctx.db);
      ctx.body = {
        data: await service.refreshReadModel({
          company: getOptionalString(values, 'company'),
          calculationDate: getOptionalString(values, 'calculationDate'),
          leadTimeFreshnessDays: getOptionalNumber(values, 'leadTimeFreshnessDays'),
          safetyBufferDays: getOptionalNumber(values, 'safetyBufferDays'),
          orderSoonWindowDays: getOptionalNumber(values, 'orderSoonWindowDays'),
          reorderCycleDays: getOptionalNumber(values, 'reorderCycleDays'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    rows: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseInventoryPlanningService(ctx.db);
      ctx.body = {
        data: await service.listRows({
          company: getOptionalString(values, 'company'),
          calculationDate: getOptionalString(values, 'calculationDate'),
          leadTimeFreshnessDays: getOptionalNumber(values, 'leadTimeFreshnessDays'),
          safetyBufferDays: getOptionalNumber(values, 'safetyBufferDays'),
          orderSoonWindowDays: getOptionalNumber(values, 'orderSoonWindowDays'),
          reorderCycleDays: getOptionalNumber(values, 'reorderCycleDays'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    digestPreview: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseInventoryPlanningService(ctx.db);
      ctx.body = {
        data: await service.digestPreview({
          company: getOptionalString(values, 'company'),
          calculationDate: getOptionalString(values, 'calculationDate'),
          leadTimeFreshnessDays: getOptionalNumber(values, 'leadTimeFreshnessDays'),
          safetyBufferDays: getOptionalNumber(values, 'safetyBufferDays'),
          orderSoonWindowDays: getOptionalNumber(values, 'orderSoonWindowDays'),
          reorderCycleDays: getOptionalNumber(values, 'reorderCycleDays'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    optimizeBudget: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const budget = getOptionalNumber(values, 'budget');
      if (typeof budget !== 'number' || budget <= 0) {
        ctx.throw(400, 'Ecobase budget optimizer requires a budget greater than zero.');
        return;
      }
      const service = new EcobaseInventoryPlanningService(ctx.db);
      ctx.body = {
        data: await service.optimizeBudget({
          company: getOptionalString(values, 'company'),
          calculationDate: getOptionalString(values, 'calculationDate'),
          leadTimeFreshnessDays: getOptionalNumber(values, 'leadTimeFreshnessDays'),
          safetyBufferDays: getOptionalNumber(values, 'safetyBufferDays'),
          orderSoonWindowDays: getOptionalNumber(values, 'orderSoonWindowDays'),
          reorderCycleDays: getOptionalNumber(values, 'reorderCycleDays'),
          limit: getOptionalNumber(values, 'limit'),
          horizonDays: getOptionalNumber(values, 'horizonDays'),
          budget,
        }),
      };
      await next();
    },
  };
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

export function createEcobaseAlertActions() {
  return {
    evaluate: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseAlertEvaluationService(ctx.db);
      try {
        ctx.body = {
          data: await service.evaluatePlanningProducts({
            planningProductId: getOptionalString(values, 'planningProductId'),
            company: getOptionalString(values, 'company'),
            calculationDate: getOptionalString(values, 'calculationDate'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase alert evaluation failed.');
        return;
      }
      await next();
    },
    list: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseAlertEvaluationService(ctx.db);
      ctx.body = {
        data: await service.listAlerts({
          company: getOptionalString(values, 'company'),
          status: getOptionalString(values, 'status') as never,
          alertType: getOptionalString(values, 'alertType'),
          severity: getOptionalString(values, 'severity') as never,
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    defaults: async (ctx, next) => {
      ctx.body = { data: EcobaseAlertEvaluationService.defaultConfig() };
      await next();
    },
  };
}

export function createEcobaseSupplierOrderActions() {
  return {
    board: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const company = getOptionalString(values, 'company');
      const service = new EcobaseSupplierOrderService(ctx.db);
      const workspace = await service.getWorkspace({
        company,
        status: getOptionalString(values, 'status'),
        stockoutDate: getOptionalString(values, 'stockoutDate'),
        limit: getOptionalNumber(values, 'limit'),
      });
      if (company) {
        const suppliers = Array.isArray(workspace.suppliers)
          ? (workspace.suppliers as Array<Record<string, unknown>>)
          : [];
        const knownSupplierIds = new Set(
          suppliers
            .flatMap((supplier) => [compactServerText(supplier.id), compactServerText(supplier.supplierId)])
            .filter(Boolean),
        );
        const supplierOrderIds = Array.isArray(workspace.supplierOrders)
          ? (workspace.supplierOrders as Array<Record<string, unknown>>)
              .map((order) => compactServerText(order.supplierId))
              .filter(Boolean)
          : [];
        for (const supplierId of supplierOrderIds) {
          if (knownSupplierIds.has(supplierId)) continue;
          const supplier = await ctx.db
            .getRepository(ECOBASE_COLLECTIONS.suppliers)
            .findOne({ filterByTk: supplierId });
          const plainSupplier = supplier
            ? ((typeof supplier.toJSON === 'function'
                ? supplier.toJSON()
                : JSON.parse(JSON.stringify(supplier))) as Record<string, unknown>)
            : undefined;
          if (plainSupplier && compactServerText(plainSupplier.company) === company) {
            suppliers.push(plainSupplier);
            knownSupplierIds.add(supplierId);
          }
        }
        workspace.suppliers = suppliers;
      }
      const planningRows = company
        ? await new EcobaseInventoryPlanningService(ctx.db).listRows({
            company,
            calculationDate: getOptionalString(values, 'calculationDate'),
            limit: 1000,
          })
        : [];
      ctx.body = {
        data: enrichSupplierOrderWorkspaceForBoard(workspace, planningRows as Array<Record<string, unknown>>),
      };
      await next();
    },
    workspace: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierOrderService(ctx.db);
      ctx.body = {
        data: await service.getWorkspace({
          company: getOptionalString(values, 'company'),
          status: getOptionalString(values, 'status'),
          stockoutDate: getOptionalString(values, 'stockoutDate'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    createPlannedOrder: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const company = getOptionalString(values, 'company');
      const planningProductId = getOptionalString(values, 'planningProductId');
      const orderedQty = getOptionalNumber(values, 'orderedQty');
      if (!company || !planningProductId || orderedQty === undefined) {
        ctx.throw(400, 'Ecobase planned order create requires company, planningProductId, and orderedQty.');
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      try {
        ctx.body = {
          data: await service.createPlannedOrder({
            company,
            planningProductId,
            supplierId: getOptionalString(values, 'supplierId'),
            orderedQty,
            unitCost: getOptionalNumber(values, 'unitCost'),
            expectedDeliveryDate: getOptionalString(values, 'expectedDeliveryDate'),
            expectedSellableDate: getOptionalString(values, 'expectedSellableDate'),
            externalOrderRef: getOptionalString(values, 'externalOrderRef'),
            notes: getOptionalString(values, 'notes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase planned order create failed.');
        return;
      }
      await next();
    },
    createOrderLine: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const supplierOrderId = getOptionalId(values, 'supplierOrderId');
      const planningProductId = getOptionalString(values, 'planningProductId');
      const orderedQty = getOptionalNumber(values, 'orderedQty');
      if (!supplierOrderId || !planningProductId || orderedQty === undefined) {
        ctx.throw(
          400,
          'Ecobase supplier-order line create requires supplierOrderId, planningProductId, and orderedQty.',
        );
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      try {
        ctx.body = {
          data: await service.createOrderLine({
            supplierOrderId,
            planningProductId,
            orderedQty,
            unitCost: getOptionalNumber(values, 'unitCost'),
            expectedDeliveryDate: getOptionalString(values, 'expectedDeliveryDate'),
            expectedSellableDate: getOptionalString(values, 'expectedSellableDate'),
            notes: getOptionalString(values, 'notes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier-order line create failed.');
        return;
      }
      await next();
    },
    createMedallionDraftOrder: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const companyId = getOptionalString(values, 'companyId');
      const supplierId = getOptionalString(values, 'supplierId');
      const orderDate = getOptionalString(values, 'orderDate');
      if (!companyId || !supplierId || !orderDate) {
        ctx.throw(400, 'Ecobase medallion draft order create requires companyId, supplierId, and orderDate.');
        return;
      }
      try {
        ctx.body = {
          data: await new EcobaseMedallionOrderService(ctx.db).createDraftOrder({
            companyId,
            supplierId,
            supplierAccountId: getOptionalString(values, 'supplierAccountId'),
            orderDate,
            orderIntent: getOptionalString(values, 'orderIntent'),
            fulfillmentRoute: getOptionalString(values, 'fulfillmentRoute'),
            expectedDeliveryDate: getOptionalString(values, 'expectedDeliveryDate'),
            remarks: getOptionalString(values, 'remarks'),
            actorUserId: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion draft order create failed.');
        return;
      }
      await next();
    },
    addMedallionOrderLine: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const orderId = getOptionalString(values, 'orderId');
      const companyProductId = getOptionalString(values, 'companyProductId');
      const supplierProductId = getOptionalString(values, 'supplierProductId');
      const orderedQty = getOptionalNumber(values, 'orderedQty');
      if (!orderId || !companyProductId || !supplierProductId || orderedQty === undefined) {
        ctx.throw(
          400,
          'Ecobase medallion order line create requires orderId, companyProductId, supplierProductId, and orderedQty.',
        );
        return;
      }
      try {
        ctx.body = {
          data: await new EcobaseMedallionOrderService(ctx.db).createOrderLine({
            orderId,
            companyProductId,
            supplierProductId,
            orderedQty,
            confirmedQty: getOptionalNumber(values, 'confirmedQty'),
            unitCost: getOptionalNumber(values, 'unitCost'),
            expectedSellPrice: getOptionalNumber(values, 'expectedSellPrice'),
            expectedMargin: getOptionalNumber(values, 'expectedMargin'),
            expectedProfit: getOptionalNumber(values, 'expectedProfit'),
            supplierPackSize: getOptionalNumber(values, 'supplierPackSize'),
            fbaExpectedPackSize: getOptionalNumber(values, 'fbaExpectedPackSize'),
            prepInstruction: getOptionalString(values, 'prepInstruction'),
            expectedDeliveryDate: getOptionalString(values, 'expectedDeliveryDate'),
            expectedSellableDate: getOptionalString(values, 'expectedSellableDate'),
            upc: getOptionalString(values, 'upc'),
            mapPrice: getOptionalNumber(values, 'mapPrice'),
            productAnalysisStatus: getOptionalString(values, 'productAnalysisStatus'),
            priority: getOptionalString(values, 'priority'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion order line create failed.');
        return;
      }
      await next();
    },
    recordActivity: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const company = getOptionalString(values, 'company');
      const supplierId = getOptionalString(values, 'supplierId');
      const activityType = getOptionalString(values, 'activityType');
      if (!company || !supplierId || !activityType) {
        ctx.throw(400, 'Ecobase supplier-order activity requires company, supplierId, and activityType.');
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      try {
        ctx.body = {
          data: await service.recordActivity({
            company,
            supplierId,
            supplierOrderId: getOptionalString(values, 'supplierOrderId'),
            activityType: activityType as never,
            occurredAt: getOptionalString(values, 'occurredAt'),
            notes: getOptionalString(values, 'notes'),
            nextFollowUpAt: getOptionalString(values, 'nextFollowUpAt'),
            leadTimeDays: getOptionalNumber(values, 'leadTimeDays'),
            contactEstablished: typeof values.contactEstablished === 'boolean' ? values.contactEstablished : undefined,
            source: getOptionalString(values, 'source'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier-order activity failed.');
        return;
      }
      await next();
    },
    getCoverage: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const planningProductId = getOptionalString(values, 'planningProductId');
      if (!planningProductId) {
        ctx.throw(400, 'Ecobase supplier-order coverage query requires planningProductId.');
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      ctx.body = {
        data: await service.getCoverage(planningProductId, getOptionalString(values, 'stockoutDate')),
      };
      await next();
    },
    updateOrderOperatorFields: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const supplierOrderId = getOptionalId(values, 'supplierOrderId');
      const company = getOptionalString(values, 'company');
      if (!supplierOrderId || !company) {
        ctx.throw(400, 'Ecobase supplier-order update requires supplierOrderId and company.');
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateOrderOperatorFields({
            supplierOrderId,
            company,
            supplierId: getOptionalString(values, 'supplierId'),
            externalOrderRef: getOptionalString(values, 'externalOrderRef'),
            orderDate: getOptionalString(values, 'orderDate'),
            status: getOptionalString(values, 'status'),
            expectedDeliveryDate: getOptionalString(values, 'expectedDeliveryDate'),
            approvalStatus: getOptionalString(values, 'approvalStatus'),
            paymentStatus: getOptionalString(values, 'paymentStatus'),
            shippingCarrier: getOptionalString(values, 'shippingCarrier'),
            trackingId: getOptionalString(values, 'trackingId'),
            blockedReason: getOptionalString(values, 'blockedReason'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier-order update failed.');
        return;
      }
      await next();
    },
    updateSupplierLeadTime: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const company = getOptionalString(values, 'company');
      const supplierId = getOptionalString(values, 'supplierId');
      const leadTimeDays = getOptionalNumber(values, 'leadTimeDays');
      if (!company || !supplierId || leadTimeDays === undefined) {
        ctx.throw(400, 'Ecobase supplier lead-time update requires company, supplierId, and leadTimeDays.');
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateSupplierLeadTime({
            company,
            supplierId,
            leadTimeDays,
            planningProductId: getOptionalString(values, 'planningProductId'),
            asin: getOptionalString(values, 'asin'),
            sku: getOptionalString(values, 'sku'),
            confirmedAt: getOptionalString(values, 'confirmedAt'),
            notes: getOptionalString(values, 'notes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier lead-time update failed.');
        return;
      }
      await next();
    },
    updateLineOperatorFields: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const supplierOrderLineId = getOptionalId(values, 'supplierOrderLineId');
      const company = getOptionalString(values, 'company');
      if (!supplierOrderLineId || !company) {
        ctx.throw(400, 'Ecobase supplier-order line update requires supplierOrderLineId and company.');
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateLineOperatorFields({
            supplierOrderLineId,
            company,
            planningProductId: getOptionalString(values, 'planningProductId'),
            externalOrderRef: getOptionalString(values, 'externalOrderRef'),
            orderedQty: getOptionalNumber(values, 'orderedQty'),
            receivedQty: getOptionalNumber(values, 'receivedQty'),
            unitCost: getOptionalNumber(values, 'unitCost'),
            expectedDeliveryDate: getOptionalString(values, 'expectedDeliveryDate'),
            expectedSellableDate: getOptionalString(values, 'expectedSellableDate'),
            notes: getOptionalString(values, 'notes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier-order line update failed.');
        return;
      }
      await next();
    },
    deleteLineOperatorFields: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const supplierOrderLineId = getOptionalId(values, 'supplierOrderLineId');
      const company = getOptionalString(values, 'company');
      if (!supplierOrderLineId || !company) {
        ctx.throw(400, 'Ecobase supplier-order line delete requires supplierOrderLineId and company.');
        return;
      }

      const service = new EcobaseSupplierOrderService(ctx.db);
      try {
        ctx.body = {
          data: await service.deleteLineOperatorFields({ supplierOrderLineId, company }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier-order line delete failed.');
        return;
      }
      await next();
    },
  };
}

export function createEcobaseSupplierManagementActions() {
  return {
    refreshAttentionRows: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.refreshSupplierAttentionRows({
            company: getOptionalString(values, 'company'),
            calculationDate: getOptionalString(values, 'calculationDate'),
            limit: getOptionalNumber(values, 'limit'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier attention refresh failed.');
        return;
      }
      await next();
    },
    rows: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      ctx.body = {
        data: await service.listSupplierAttentionRows({
          company: getOptionalString(values, 'company'),
          calculationDate: getOptionalString(values, 'calculationDate'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    summary: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      ctx.body = {
        data: await service.summary({
          company: getOptionalString(values, 'company'),
          calculationDate: getOptionalString(values, 'calculationDate'),
        }),
      };
      await next();
    },
    digest: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      ctx.body = {
        data: await service.digest({
          company: getOptionalString(values, 'company'),
          calculationDate: getOptionalString(values, 'calculationDate'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    detail: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.getSupplierDetail({
            company: getOptionalString(values, 'company'),
            supplierId: getOptionalString(values, 'supplierId'),
            calculationDate: getOptionalString(values, 'calculationDate'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier detail failed.');
        return;
      }
      await next();
    },
    createSupplier: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.createSupplier({
            ...values,
            company: getOptionalString(values, 'company'),
            name: getOptionalString(values, 'name'),
            supplierCode: getOptionalString(values, 'supplierCode'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier create failed.');
        return;
      }
      await next();
    },
    updateSupplierProfile: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateSupplierProfile({
            ...values,
            company: getOptionalString(values, 'company'),
            supplierId: getOptionalString(values, 'supplierId'),
            name: getOptionalString(values, 'name'),
            active: typeof values.active === 'boolean' ? values.active : undefined,
            activityNotes: getOptionalString(values, 'activityNotes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier profile update failed.');
        return;
      }
      await next();
    },
    createSupplierOrder: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.createSupplierOrder({
            company: getOptionalString(values, 'company'),
            supplierId: getOptionalString(values, 'supplierId'),
            externalOrderRef: getOptionalString(values, 'externalOrderRef'),
            orderDate: getOptionalString(values, 'orderDate'),
            expectedDeliveryDate: getOptionalString(values, 'expectedDeliveryDate'),
            status: getOptionalString(values, 'status'),
            approvalStatus: getOptionalString(values, 'approvalStatus'),
            paymentStatus: getOptionalString(values, 'paymentStatus'),
            shippingCarrier: getOptionalString(values, 'shippingCarrier'),
            trackingId: getOptionalString(values, 'trackingId'),
            blockedReason: getOptionalString(values, 'blockedReason'),
            notes: getOptionalString(values, 'notes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier order create failed.');
        return;
      }
      await next();
    },
    recordActivity: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.recordSupplierActivity({
            company: getOptionalString(values, 'company'),
            supplierId: getOptionalString(values, 'supplierId'),
            supplierOrderId: getOptionalString(values, 'supplierOrderId'),
            activityType: getOptionalString(values, 'activityType'),
            occurredAt: getOptionalString(values, 'occurredAt'),
            notes: getOptionalString(values, 'notes'),
            nextFollowUpAt: getOptionalString(values, 'nextFollowUpAt'),
            leadTimeDays: getOptionalNumber(values, 'leadTimeDays'),
            contactEstablished: typeof values.contactEstablished === 'boolean' ? values.contactEstablished : undefined,
            source: getOptionalString(values, 'source'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier activity failed.');
        return;
      }
      await next();
    },
    updateProductLeadTime: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateSupplierProductLeadTime({
            company: getOptionalString(values, 'company'),
            supplierId: getOptionalString(values, 'supplierId'),
            supplierProductId: getOptionalString(values, 'supplierProductId'),
            productId: getOptionalString(values, 'productId'),
            planningProductId: getOptionalString(values, 'planningProductId'),
            asin: getOptionalString(values, 'asin'),
            sku: getOptionalString(values, 'sku'),
            leadTimeDays: getOptionalNumber(values, 'leadTimeDays'),
            confirmedAt: getOptionalString(values, 'confirmedAt'),
            notes: getOptionalString(values, 'notes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier lead-time update failed.');
        return;
      }
      await next();
    },
    updateSupplierLifecycle: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateSupplierLifecycle({
            supplierId: getOptionalString(values, 'supplierId'),
            status: getOptionalString(values, 'status'),
            comment: getOptionalString(values, 'comment'),
            followUpAt: getOptionalString(values, 'followUpAt'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier lifecycle update failed.');
        return;
      }
      await next();
    },
    recordComment: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.recordComment({
            supplierId: getOptionalString(values, 'supplierId'),
            body: getOptionalString(values, 'body'),
            commentType: getOptionalString(values, 'commentType'),
            followUpAt: getOptionalString(values, 'followUpAt'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier comment failed.');
        return;
      }
      await next();
    },
    deleteComment: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.deleteComment({
            commentId: getOptionalString(values, 'commentId'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier comment delete failed.');
        return;
      }
      await next();
    },
    updateSupplierAccount: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.updateSupplierAccount({
            supplierId: getOptionalString(values, 'supplierId'),
            company: getOptionalString(values, 'company'),
            accountName: getOptionalString(values, 'accountName'),
            orderingMethod: getOptionalString(values, 'orderingMethod'),
            portalUrl: getOptionalString(values, 'portalUrl'),
            username: getOptionalString(values, 'username'),
            status: getOptionalString(values, 'status'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier account update failed.');
        return;
      }
      await next();
    },
    upsertSupplierProduct: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      try {
        ctx.body = {
          data: await service.upsertSupplierProduct({
            supplierId: getOptionalString(values, 'supplierId'),
            productId: getOptionalString(values, 'productId'),
            supplierSku: getOptionalString(values, 'supplierSku'),
            unitCost: getOptionalNumber(values, 'unitCost'),
            moq: getOptionalNumber(values, 'moq'),
            leadTimeDays: getOptionalNumber(values, 'leadTimeDays'),
            analysisStatus: getOptionalString(values, 'analysisStatus'),
            notes: getOptionalString(values, 'notes'),
            actor: getActorId(ctx),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase supplier product update failed.');
        return;
      }
      await next();
    },
    supplierOptions: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      ctx.body = {
        data: await service.supplierOptions({
          company: getOptionalString(values, 'company'),
          search: getOptionalString(values, 'search'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    productOptions: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      ctx.body = {
        data: await service.productOptions({
          company: getOptionalString(values, 'company'),
          search: getOptionalString(values, 'search'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    orderOptions: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSupplierManagementService(ctx.db);
      ctx.body = {
        data: await service.orderOptions({
          company: getOptionalString(values, 'company'),
          supplierId: getOptionalString(values, 'supplierId'),
          search: getOptionalString(values, 'search'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
  };
}

export function createEcobaseAccountabilityActions() {
  return {
    evaluate: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseAccountabilityService(ctx.db);
      ctx.body = {
        data: await service.evaluateAccountability({
          sourceConnectionId: getOptionalString(values, 'sourceConnectionId'),
          evaluationDate: getOptionalString(values, 'evaluationDate'),
        }),
      };
      await next();
    },
    evidence: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseAccountabilityService(ctx.db);
      ctx.body = {
        data: await service.listAccountabilityEvidence({
          sourceConnectionId: getOptionalString(values, 'sourceConnectionId'),
          limit: getOptionalNumber(values, 'limit'),
        }),
      };
      await next();
    },
    defaults: async (ctx, next) => {
      ctx.body = { data: EcobaseAccountabilityService.defaultConfig() };
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
    forceRefresh: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const sourceConnectionId = getOptionalString(values, 'sourceConnectionId');
      if (!sourceConnectionId) {
        ctx.throw(400, 'Ecobase Sellerboard force refresh requires sourceConnectionId.');
        return;
      }

      const service = new EcobaseImportService(ctx.db, registry);
      try {
        ctx.body = {
          data: await service.runAdapterImport({
            sourceConnectionId,
            adapterName: getOptionalString(values, 'adapterName') ?? 'sellerboard-api',
            sourceIdentifier: getOptionalString(values, 'sourceIdentifier') ?? 'sellerboard-force-refresh',
            sourceVersion: getOptionalString(values, 'sourceVersion'),
            idempotencyKey: getOptionalString(values, 'idempotencyKey'),
            preserveAuditRun: true,
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Sellerboard force refresh failed.');
        return;
      }
      await next();
    },
    runScheduledSellerboard: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseImportService(ctx.db, registry);
      try {
        ctx.body = {
          data: await service.runScheduledSellerboardImports({
            now: getOptionalString(values, 'now'),
            sourceConnectionId: getOptionalString(values, 'sourceConnectionId'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase scheduled Sellerboard import failed.');
        return;
      }
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
    normalizeBronzeToSilver: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      try {
        ctx.body = {
          data: await new EcobaseMedallionNormalizationService(ctx.db).normalizePending({
            sourceConnectionId: getOptionalString(values, 'sourceConnectionId'),
            limit: getOptionalNumber(values, 'limit'),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase bronze-to-silver normalization failed.');
        return;
      }
      await next();
    },
    runMedallionPipeline: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseImportService(ctx.db, registry);
      try {
        const pipeline = await service.runMedallionPipeline({
          sourceConnectionId: getOptionalString(values, 'sourceConnectionId'),
          sourceVersion: getOptionalString(values, 'sourceVersion'),
        });
        const goldInventory = await new EcobaseInventoryPlanningService(ctx.db).refreshReadModel({
          calculationDate: getOptionalString(values, 'sourceVersion'),
          limit: getOptionalNumber(values, 'goldLimit') ?? 500,
        });
        const goldOrders = await new EcobaseOrderPlanningService(ctx.db).refreshReadModel({
          limit: getOptionalNumber(values, 'goldOrderLimit') ?? 5000,
        });
        ctx.body = { data: { ...pipeline, goldInventory, goldOrders } };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase medallion pipeline failed.');
        return;
      }
      await next();
    },
    analyzeCsvBundle: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseImportService(ctx.db, registry);
      try {
        ctx.body = { data: service.analyzeCsvBundle(getCsvFiles(values)) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase CSV bundle analysis failed.');
        return;
      }
      await next();
    },
    runCsvBundle: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const sourceConnectionId = getOptionalString(values, 'sourceConnectionId');
      const adapterName = getOptionalString(values, 'adapterName');
      if (!sourceConnectionId || !adapterName) {
        ctx.throw(400, 'Ecobase CSV bundle import requires sourceConnectionId and adapterName.');
        return;
      }
      const service = new EcobaseImportService(ctx.db, registry);
      try {
        ctx.body = {
          data: await service.runCsvBundleImport({
            sourceConnectionId,
            adapterName,
            sourceIdentifier: getOptionalString(values, 'sourceIdentifier'),
            sourceVersion: getOptionalString(values, 'sourceVersion'),
            defaultCompany: getOptionalString(values, 'defaultCompany'),
            files: getCsvFiles(values),
          }),
        };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase CSV bundle import failed.');
        return;
      }
      await next();
    },
    saveCsvSourceConnection: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSourceConnectionService(ctx.db);
      try {
        ctx.body = { data: await service.saveCsvSourceConnection(values) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase CSV source save failed.');
        return;
      }
      await next();
    },
    listSellerboardSources: async (ctx, next) => {
      const service = new EcobaseSourceConnectionService(ctx.db);
      ctx.body = { data: await service.listSellerboardSources() };
      await next();
    },
    saveSellerboardSource: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const service = new EcobaseSourceConnectionService(ctx.db);
      try {
        ctx.body = { data: await service.saveSellerboardSource(values) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Sellerboard source save failed.');
        return;
      }
      await next();
    },
    deleteSellerboardSource: async (ctx, next) => {
      const values = getValues(ctx.action.params);
      const sourceConnectionId = getOptionalString(values, 'sourceConnectionId');
      if (!sourceConnectionId) {
        ctx.throw(400, 'Ecobase Sellerboard source delete requires sourceConnectionId.');
        return;
      }
      const service = new EcobaseSourceConnectionService(ctx.db);
      try {
        ctx.body = { data: await service.deleteSellerboardSource(sourceConnectionId) };
      } catch (error) {
        ctx.throw(400, error instanceof Error ? error.message : 'Ecobase Sellerboard source delete failed.');
        return;
      }
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
      this.startSellerboardScheduler();
    });
    this.app.on('beforeStop', async () => {
      this.stopSellerboardScheduler();
    });

    this.app.db.on(`${ECOBASE_COLLECTIONS.supplierOrderActivities}.beforeCreate`, validateSupplierOrderActivityModel);
    this.app.db.on(`${ECOBASE_COLLECTIONS.supplierOrderActivities}.beforeUpdate`, validateSupplierOrderActivityModel);

    this.app.resourceManager.define({
      name: 'ecobaseImport',
      actions: createEcobaseImportActions(this.registry),
    });
    this.app.resourceManager.define({
      name: 'ecobaseInventoryPlanning',
      actions: createEcobaseInventoryPlanningActions(),
    });
    this.app.resourceManager.define({
      name: 'ecobaseOrderPlanning',
      actions: createEcobaseOrderPlanningActions(),
    });
    this.app.resourceManager.define({
      name: 'ecobaseSupplierOrders',
      actions: createEcobaseSupplierOrderActions(),
    });
    this.app.resourceManager.define({
      name: 'ecobaseSupplierManagement',
      actions: createEcobaseSupplierManagementActions(),
    });
    this.app.resourceManager.define({
      name: 'ecobaseMedallionWorkflow',
      actions: createEcobaseMedallionWorkflowActions(),
    });
    this.app.resourceManager.define({
      name: 'ecobaseSilverData',
      actions: createEcobaseSilverDataActions(),
    });
    this.app.resourceManager.define({
      name: 'ecobaseReports',
      actions: createEcobaseReportActions(this.app),
    });

    this.app.acl.allow(
      'ecobaseImport',
      [
        'run',
        'runDailySnapshot',
        'forceRefresh',
        'runScheduledSellerboard',
        'runNoop',
        'status',
        'adapters',
        'normalizeBronzeToSilver',
        'runMedallionPipeline',
        'analyzeCsvBundle',
        'runCsvBundle',
        'saveCsvSourceConnection',
        'listSellerboardSources',
        'saveSellerboardSource',
        'deleteSellerboardSource',
      ],
      'loggedIn',
    );
    this.app.acl.allow(
      'ecobaseInventoryPlanning',
      ['filters', 'refreshReadModel', 'rows', 'digestPreview', 'optimizeBudget'],
      'loggedIn',
    );
    this.app.acl.allow(
      'ecobaseOrderPlanning',
      [
        'filters',
        'list',
        'refreshReadModel',
        'detail',
        'updateOrder',
        'updateLine',
        'addComment',
        'updateInvoice',
        'deleteComment',
      ],
      'loggedIn',
    );
    this.app.acl.allow(ECOBASE_COLLECTIONS.companies, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.amazonAccounts, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.sourceConnections, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.importRuns, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(
      'ecobaseSupplierOrders',
      [
        'workspace',
        'getCoverage',
        'createPlannedOrder',
        'createOrderLine',
        'createMedallionDraftOrder',
        'addMedallionOrderLine',
        'updateOrderOperatorFields',
        'updateLineOperatorFields',
        'deleteLineOperatorFields',
        'updateSupplierLeadTime',
        'recordActivity',
      ],
      'loggedIn',
    );
    this.app.acl.allow(
      'ecobaseSupplierManagement',
      [
        'refreshAttentionRows',
        'rows',
        'summary',
        'digest',
        'detail',
        'createSupplier',
        'updateSupplierProfile',
        'createSupplierOrder',
        'recordActivity',
        'updateProductLeadTime',
        'updateSupplierLifecycle',
        'recordComment',
        'deleteComment',
        'updateSupplierAccount',
        'upsertSupplierProduct',
        'supplierOptions',
        'productOptions',
        'orderOptions',
      ],
      'loggedIn',
    );
    this.app.acl.allow(
      'ecobaseMedallionWorkflow',
      ['createComment', 'createTask', 'proposeAction', 'approveAndExecute', 'rejectApproval', 'setActionPolicy'],
      'loggedIn',
    );
    this.app.acl.allow(
      'ecobaseSilverData',
      ['search', 'lookup', 'context', 'record', 'updateRecord', 'addComment'],
      'loggedIn',
    );
    this.app.acl.allow(
      'ecobaseReports',
      [
        'generatePreview',
        'generateDailyOperationsBriefEvidence',
        'generateDailyOperationsBrief',
        'getDailyManagementSnapshotTrend',
        'getDailyBriefPromptSettings',
        'saveDailyBriefPromptSettings',
        'resetDailyBriefPromptSettings',
        'markDailyOperationsBriefSent',
        'markDailyOperationsBriefFailed',
      ],
      'loggedIn',
    );
    this.app.acl.allow(ECOBASE_COLLECTIONS.dailyManagementSnapshots, ['list', 'get'], 'loggedIn');
    this.app.acl.allow(ECOBASE_COLLECTIONS.dailyBriefPromptSettings, ['list', 'get'], 'loggedIn');
  }
}

export default PluginEcobaseServer;
