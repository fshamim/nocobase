import { z } from 'zod';
import type { ToolsOptions } from '@nocobase/ai';
import { EcobaseAiRetrievalService } from './services/ai-retrieval-service';
import { EcobaseSourceConnectionService } from './services/source-connection-service';

function toToolContent(data: unknown) {
  return JSON.stringify(data, (_key, value) => {
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

function limitNumber(value: unknown, defaultValue: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), max)
    : defaultValue;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toolDate(value: unknown) {
  return optionalString(value) ?? new Date().toISOString().slice(0, 10);
}

function toolError(error: unknown, fallback: string) {
  return {
    status: 'error' as const,
    content: error instanceof Error ? error.message : fallback,
  };
}

function medallionService(ctx: { db: any }) {
  return new EcobaseAiRetrievalService(ctx.db);
}

export function createEcobaseAiTools(): ToolsOptions[] {
  return [
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase source status',
        about: 'Read import freshness, latest run status, record counts, and source warnings for Ecobase data sources.',
      },
      definition: {
        name: 'ecobase_source_status',
        description:
          'Read-only Ecobase tool. Use this to answer questions about import health, stale sources, latest run status, and data warnings. Does not expose source credentials.',
        schema: z.object({ company: z.string().optional().describe('Optional company/legal entity filter.') }),
      },
      invoke: async (ctx, args) => {
        try {
          const service = new EcobaseSourceConnectionService(ctx.db);
          const statuses = await service.listSourceStatuses();
          const company = optionalString(args?.company);
          const scoped = company ? statuses.filter((status) => status.company === company) : statuses;
          return {
            status: 'success' as const,
            content: toToolContent({
              company: company ?? null,
              count: scoped.length,
              sources: scoped.map((status) => ({
                id: status.id,
                name: status.name,
                company: status.company,
                sourceType: status.sourceType,
                domain: status.domain,
                active: status.active,
                latestImportRunId: status.latestImportRunId,
                latestRunStatus: status.latestRunStatus,
                lastRunAt: status.lastRunAt,
                importedCount: status.importedCount,
                skippedCount: status.skippedCount,
                errorCount: status.errorCount,
                warnings: status.warnings,
              })),
            }),
          };
        } catch (error) {
          return toolError(error, 'Ecobase source status lookup failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase daily operations brief',
        about: 'Read a bounded operations brief from silver/gold medallion evidence only.',
      },
      definition: {
        name: 'ecobase_daily_operations_brief',
        description:
          'Read-only Ecobase tool. Uses only silver/gold medallion tables to summarize current inventory focus, supplier attention, and gold alerts.',
        schema: z.object({
          company: z.string().optional(),
          date: z.string().optional(),
          maxItems: z.number().int().positive().max(100).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const digest = await medallionService(ctx).inventoryDigest({
            company: optionalString(args?.company),
            calculationDate: toolDate(args?.date),
            limit: limitNumber(args?.maxItems, 25, 100),
          });
          return { status: 'success' as const, content: toToolContent(digest) };
        } catch (error) {
          return toolError(error, 'Ecobase daily operations brief lookup failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase product context',
        about: 'Read product-specific context from gold inventory rows and silver facts.',
      },
      definition: {
        name: 'ecobase_product_context',
        description:
          'Read-only Ecobase tool. Uses only silver/gold medallion evidence for one ASIN, SKU, or planning product reference.',
        schema: z.object({
          company: z.string().optional(),
          date: z.string().optional(),
          planningProductId: z.string().optional(),
          asin: z.string().optional(),
          sku: z.string().optional(),
          maxItems: z.number().int().positive().max(100).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const facts = await medallionService(ctx).retrieveFacts({
            question: 'Retrieve product context from silver/gold medallion facts.',
            company: optionalString(args?.company),
            calculationDate: toolDate(args?.date),
            limit: limitNumber(args?.maxItems, 25, 100),
          });
          const planningProductId = optionalString(args?.planningProductId);
          const asin = optionalString(args?.asin)?.toUpperCase();
          const sku = optionalString(args?.sku);
          const matches = (item: Record<string, unknown>) =>
            Boolean(
              (planningProductId && item.planningProductId === planningProductId) ||
                (asin && typeof item.asin === 'string' && item.asin.toUpperCase() === asin) ||
                (sku && item.sku === sku),
            );
          return {
            status: 'success' as const,
            content: toToolContent({
              sourceModel: facts.sourceModel,
              oldTablesUsed: facts.oldTablesUsed,
              goldInventoryRows: facts.gold.inventoryPlanningRows.filter(matches),
              silverProducts: facts.silver.products.filter(matches),
              silverInventorySnapshots: facts.silver.inventorySnapshots.filter(matches),
              silverListingDailyFacts: facts.silver.listingDailyFacts.filter(matches),
            }),
          };
        } catch (error) {
          return toolError(error, 'Ecobase product context lookup failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: { title: 'Ecobase performance trends', about: 'Read silver listing and inventory facts.' },
      definition: {
        name: 'ecobase_performance_trends',
        description: 'Read-only Ecobase tool. Uses silver listing daily facts and silver inventory snapshots only.',
        schema: z.object({
          company: z.string().optional(),
          date: z.string().optional(),
          maxItems: z.number().int().positive().max(100).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const facts = await medallionService(ctx).retrieveFacts({
            question: 'Retrieve silver performance trends.',
            company: optionalString(args?.company),
            date: toolDate(args?.date),
            limit: limitNumber(args?.maxItems, 25, 100),
          });
          return {
            status: 'success' as const,
            content: toToolContent({
              sourceModel: facts.sourceModel,
              oldTablesUsed: facts.oldTablesUsed,
              listingDailyFacts: facts.silver.listingDailyFacts,
              inventorySnapshots: facts.silver.inventorySnapshots,
            }),
          };
        } catch (error) {
          return toolError(error, 'Ecobase performance trend lookup failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase Buy Box trends',
        about: 'Report whether Buy Box evidence exists in the medallion model.',
      },
      definition: {
        name: 'ecobase_buybox_trends',
        description:
          'Read-only Ecobase tool. Returns an explicit no-evidence note until Buy Box fields are present in silver/gold tables.',
        schema: z.object({
          company: z.string().optional(),
          date: z.string().optional(),
          maxItems: z.number().int().positive().max(100).optional(),
        }),
      },
      invoke: async () => ({
        status: 'success' as const,
        content: toToolContent({
          sourceModel: 'silver-gold-medallion',
          oldTablesUsed: false,
          buyBoxRisks: [],
          note: 'Buy Box fields are not present in the silver/gold medallion model yet.',
        }),
      }),
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: { title: 'Ecobase OKR status', about: 'Read silver tasks, task links, and human approvals.' },
      definition: {
        name: 'ecobase_okr_status',
        description: 'Read-only Ecobase tool. Uses silver tasks, task links, and human approvals only.',
        schema: z.object({
          company: z.string().optional(),
          date: z.string().optional(),
          maxItems: z.number().int().positive().max(100).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const facts = await medallionService(ctx).retrieveFacts({
            question: 'Retrieve silver task and approval status.',
            company: optionalString(args?.company),
            date: toolDate(args?.date),
            limit: limitNumber(args?.maxItems, 25, 100),
          });
          return {
            status: 'success' as const,
            content: toToolContent({
              sourceModel: facts.sourceModel,
              oldTablesUsed: facts.oldTablesUsed,
              tasks: facts.silver.tasks,
              taskLinks: facts.silver.taskLinks,
              humanApprovals: facts.silver.humanApprovals,
            }),
          };
        } catch (error) {
          return toolError(error, 'Ecobase OKR status lookup failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase inventory digest',
        about: 'Read the current Inventory Planning digest from gold rows and silver context.',
      },
      definition: {
        name: 'ecobase_inventory_digest',
        description:
          'Read-only Ecobase tool. Use before answering urgent reorder, OOS risk, supplier contact priority, and current inventory-planning questions. Uses only silver/gold medallion tables.',
        schema: z.object({
          company: z.string().optional(),
          calculationDate: z.string().optional(),
          leadTimeFreshnessDays: z.number().int().positive().optional(),
          orderSoonWindowDays: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(10).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const digest = await medallionService(ctx).inventoryDigest({
            company: optionalString(args?.company),
            calculationDate: optionalString(args?.calculationDate),
            limit: limitNumber(args?.limit, 10, 10),
          });
          return { status: 'success' as const, content: toToolContent(digest) };
        } catch (error) {
          return toolError(error, 'Ecobase inventory digest failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase budget optimizer',
        about: 'Rank gold inventory rows for budget-constrained review without mutating records.',
      },
      definition: {
        name: 'ecobase_optimize_budget',
        description:
          'Read-only Ecobase tool. Uses gold inventory rows to rank what to approve, pay, or order under a budget. It does not persist optimizer runs.',
        schema: z.object({
          budget: z.number().positive(),
          company: z.string().optional(),
          calculationDate: z.string().optional(),
          horizonDays: z.number().int().positive().optional(),
          leadTimeFreshnessDays: z.number().int().positive().optional(),
          orderSoonWindowDays: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(10).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const result = await medallionService(ctx).budgetRecommendations({
            budget: args?.budget,
            company: optionalString(args?.company),
            calculationDate: optionalString(args?.calculationDate),
            limit: limitNumber(args?.limit, 10, 10),
          });
          return { status: 'success' as const, content: toToolContent(result) };
        } catch (error) {
          return toolError(error, 'Ecobase budget optimization failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase supplier orders',
        about: 'Read silver supplier orders, order lines, suppliers, and gold supplier attention rows.',
      },
      definition: {
        name: 'ecobase_supplier_orders',
        description:
          'Read-only Ecobase tool. Use before answering supplier/order-management questions. Uses only silver/gold medallion tables.',
        schema: z.object({
          company: z.string().min(1).optional(),
          status: z.string().optional(),
          stockoutDate: z.string().optional(),
          limit: z.number().int().positive().max(10).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const workspace = await medallionService(ctx).supplierOrderEvidence({
            company: optionalString(args?.company),
            status: optionalString(args?.status),
            date: optionalString(args?.stockoutDate),
            limit: limitNumber(args?.limit, 10, 10),
          });
          return { status: 'success' as const, content: toToolContent(workspace) };
        } catch (error) {
          return toolError(error, 'Ecobase supplier-order lookup failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: { title: 'Ecobase retrieve facts', about: 'Retrieve a broad silver/gold evidence bundle.' },
      definition: {
        name: 'ecobase_retrieve_facts',
        description:
          'Read-only Ecobase tool. Use for broad evidence retrieval across gold inventory planning, gold supplier attention, gold alerts, and silver product/supplier/order/fact tables.',
        schema: z.object({
          question: z.string().min(1),
          company: z.string().optional(),
          date: z.string().optional(),
          period: z.string().optional(),
          periodType: z.enum(['daily', 'weekly', 'monthly']).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const facts = await medallionService(ctx).retrieveFacts({
            question: optionalString(args?.question) ?? 'Retrieve scoped Ecobase facts.',
            company: optionalString(args?.company),
            date: optionalString(args?.date),
            period: optionalString(args?.period),
            periodType: args?.periodType,
          });
          return { status: 'success' as const, content: toToolContent(facts) };
        } catch (error) {
          return toolError(error, 'Ecobase fact retrieval failed.');
        }
      },
    },
    {
      scope: 'CUSTOM',
      defaultPermission: 'ALLOW',
      execution: 'backend',
      introduction: {
        title: 'Ecobase ephemeral answer',
        about: 'Create a deterministic silver/gold evidence-backed answer without persisting an Ecobase AI answer row.',
      },
      definition: {
        name: 'ecobase_answer_ephemeral',
        description:
          'Read-only Ecobase tool. Use when the user asks for a concise evidence-backed Ecobase answer and does not need an aiAnswers audit record. Uses only silver/gold medallion evidence.',
        schema: z.object({
          question: z.string().min(1),
          company: z.string().optional(),
          date: z.string().optional(),
          period: z.string().optional(),
          periodType: z.enum(['daily', 'weekly', 'monthly']).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const answer = await medallionService(ctx).answerQuestion(
            {
              question: optionalString(args?.question) ?? '',
              company: optionalString(args?.company),
              date: optionalString(args?.date),
              period: optionalString(args?.period),
              periodType: args?.periodType,
            },
            { persist: false },
          );
          return { status: 'success' as const, content: toToolContent(answer) };
        } catch (error) {
          return toolError(error, 'Ecobase ephemeral answer failed.');
        }
      },
    },
  ];
}
