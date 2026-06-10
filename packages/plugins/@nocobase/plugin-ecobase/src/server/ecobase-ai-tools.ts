import { z } from 'zod';
import type { ToolsOptions } from '@nocobase/ai';
import { EcobaseAiRetrievalService } from './services/ai-retrieval-service';
import { EcobaseInventoryPlanningService } from './services/inventory-planning-service';
import { EcobaseSourceConnectionService } from './services/source-connection-service';
import { EcobaseSupplierOrderService } from './services/supplier-order-service';

function toToolContent(data: unknown) {
  return JSON.stringify(data, (_key, value) => {
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

function limitNumber(value: unknown, defaultValue: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), max) : defaultValue;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toolError(error: unknown, fallback: string) {
  return {
    status: 'error' as const,
    content: error instanceof Error ? error.message : fallback,
  };
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
        description: 'Read-only Ecobase tool. Use this to answer questions about import health, stale sources, latest run status, and data warnings. Does not expose source credentials.',
        schema: z.object({
          company: z.string().optional().describe('Optional company/legal entity filter.'),
        }),
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
        title: 'Ecobase inventory digest',
        about: 'Read the current Inventory Planning digest: urgent rows, supplier contact priorities, and lead-time issues.',
      },
      definition: {
        name: 'ecobase_inventory_digest',
        description: 'Read-only Ecobase tool. Use this before answering questions about urgent reorder work, OOS risk, supplier contact priority, and current inventory-planning actions.',
        schema: z.object({
          company: z.string().optional().describe('Optional company/legal entity filter.'),
          calculationDate: z.string().optional().describe('Planning date in YYYY-MM-DD format.'),
          leadTimeFreshnessDays: z.number().int().positive().optional(),
          orderSoonWindowDays: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(100).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const service = new EcobaseInventoryPlanningService(ctx.db);
          const digest = await service.digestPreview({
            company: optionalString(args?.company),
            calculationDate: optionalString(args?.calculationDate),
            leadTimeFreshnessDays: limitNumber(args?.leadTimeFreshnessDays, 60, 365),
            orderSoonWindowDays: limitNumber(args?.orderSoonWindowDays, 14, 90),
            limit: limitNumber(args?.limit, 50, 100),
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
        about: 'Run on-demand budget-constrained reorder/approval recommendations without persisting optimizer history.',
      },
      definition: {
        name: 'ecobase_optimize_budget',
        description: 'Read-only/on-demand Ecobase tool. Use this to answer what to approve, pay, or order under a specific budget. It does not persist optimizer runs.',
        schema: z.object({
          budget: z.number().positive().describe('Available budget. Required and must be greater than zero.'),
          company: z.string().optional().describe('Optional company/legal entity filter.'),
          calculationDate: z.string().optional().describe('Planning date in YYYY-MM-DD format.'),
          horizonDays: z.number().int().positive().optional(),
          leadTimeFreshnessDays: z.number().int().positive().optional(),
          orderSoonWindowDays: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(200).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const service = new EcobaseInventoryPlanningService(ctx.db);
          const result = await service.optimizeBudget({
            budget: args?.budget,
            company: optionalString(args?.company),
            calculationDate: optionalString(args?.calculationDate),
            horizonDays: limitNumber(args?.horizonDays, 30, 365),
            leadTimeFreshnessDays: limitNumber(args?.leadTimeFreshnessDays, 60, 365),
            orderSoonWindowDays: limitNumber(args?.orderSoonWindowDays, 14, 90),
            limit: limitNumber(args?.limit, 150, 200),
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
        about: 'Read the supplier-order workspace for order status, blockers, lines, supplier evidence, and reorder candidates.',
      },
      definition: {
        name: 'ecobase_supplier_orders',
        description: 'Read-only Ecobase tool. Use this before answering supplier/order-management questions such as whether an order exists, what is blocking recovery, supplier contact freshness, and expected sellable timing.',
        schema: z.object({
          company: z.string().min(1).describe('Company/legal entity. Required to prevent broad supplier-order scans.'),
          status: z.string().optional().describe('Optional supplier-order status filter.'),
          stockoutDate: z.string().optional().describe('Optional stockout date in YYYY-MM-DD format.'),
          limit: z.number().int().positive().max(100).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const service = new EcobaseSupplierOrderService(ctx.db);
          const workspace = await service.getWorkspace({
            company: optionalString(args?.company),
            status: optionalString(args?.status),
            stockoutDate: optionalString(args?.stockoutDate),
            limit: limitNumber(args?.limit, 50, 100),
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
      introduction: {
        title: 'Ecobase retrieve facts',
        about: 'Retrieve a broad evidence bundle for complex Ecobase business questions.',
      },
      definition: {
        name: 'ecobase_retrieve_facts',
        description: 'Read-only Ecobase tool. Use this for broad evidence retrieval across alerts, planning calculations, reports, import status, supplier orders, lead times, accountability, and comparisons.',
        schema: z.object({
          question: z.string().min(1).describe('The user question to scope the evidence retrieval.'),
          company: z.string().optional().describe('Optional company/legal entity filter.'),
          date: z.string().optional().describe('Comparison/current date in YYYY-MM-DD format.'),
          period: z.string().optional(),
          periodType: z.enum(['daily', 'weekly', 'monthly']).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const service = new EcobaseAiRetrievalService(ctx.db);
          const facts = await service.retrieveFacts({
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
        about: 'Create a deterministic evidence-backed answer without persisting an Ecobase AI answer row.',
      },
      definition: {
        name: 'ecobase_answer_ephemeral',
        description: 'Read-only Ecobase tool. Use this when the user asks for a concise evidence-backed Ecobase answer and does not need an aiAnswers audit record.',
        schema: z.object({
          question: z.string().min(1).describe('Question to answer from Ecobase evidence.'),
          company: z.string().optional().describe('Optional company/legal entity filter.'),
          date: z.string().optional().describe('Current date in YYYY-MM-DD format.'),
          period: z.string().optional(),
          periodType: z.enum(['daily', 'weekly', 'monthly']).optional(),
        }),
      },
      invoke: async (ctx, args) => {
        try {
          const service = new EcobaseAiRetrievalService(ctx.db);
          const answer = await service.answerQuestion({
            question: optionalString(args?.question) ?? '',
            company: optionalString(args?.company),
            date: optionalString(args?.date),
            period: optionalString(args?.period),
            periodType: args?.periodType,
          }, { persist: false });
          return { status: 'success' as const, content: toToolContent(answer) };
        } catch (error) {
          return toolError(error, 'Ecobase ephemeral answer failed.');
        }
      },
    },
  ];
}
