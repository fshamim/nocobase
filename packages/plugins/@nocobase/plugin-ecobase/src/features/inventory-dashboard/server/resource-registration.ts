/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * `ecobaseInventoryDashboard` resource (T-1.3 / AD-3).
 *
 * Actions live inside the feature (AD-1 full encapsulation); only the shared
 * registration points (`resource-registration.ts` types, `role-boundary.ts`
 * guards, `plugin.ts` wiring) are touched outside this directory. Reads are
 * granted to logged-in members; the single mutation `savePrepDetails` requires
 * the operator role and is guarded before request validation.
 */

import {
  LOGGED_IN,
  OPERATOR,
  triggerOnOperatorWrite,
  type EcobaseFeatureResourceRegistration,
} from '../../../server/resource-registration';
import { guardEcobaseActions } from '../../../server/role-boundary';
import { EcobasePlanningSettingsService } from '../../../server/services/planning-settings-service';
import { isPaneKey, type PaneKey, type SortDirection } from './contract';
import { EcobaseInventoryDashboardService, InventoryDashboardValidationError } from './inventory-dashboard-service';
import type { DashboardDatabase } from './published-gold-reader';

interface DashboardActionContext {
  db: DashboardDatabase;
  action: { params: unknown };
  state?: Record<string, unknown>;
  body?: unknown;
  logger?: { info?: (message: string) => void };
  throw: (status: number, message: string) => never;
}

type DashboardNext = () => Promise<void>;

function getValues(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) return {};
  const record = params as Record<string, unknown>;
  const values = record.values;
  return typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : record;
}

function optionalString(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(values: Record<string, unknown>, key: string): number | undefined {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function actorUserId(ctx: DashboardActionContext): string | undefined {
  const currentUser = ctx.state?.currentUser;
  if (typeof currentUser === 'object' && currentUser !== null) {
    const id = (currentUser as Record<string, unknown>).id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
  }
  return undefined;
}

async function buildService(db: DashboardDatabase): Promise<EcobaseInventoryDashboardService> {
  const settings = await new EcobasePlanningSettingsService(db).getResolvedSettings();
  return new EcobaseInventoryDashboardService(db, {
    leadTimeFreshnessDays: settings.leadTimeFreshnessDays,
    followUpThresholdHours: settings.followUpThresholdHours,
  });
}

function requirePane(ctx: DashboardActionContext, value: unknown): PaneKey {
  if (!isPaneKey(value)) {
    ctx.throw(400, `Ecobase Inventory Dashboard requires a valid pane; received "${String(value)}".`);
  }
  return value;
}

function sortDirection(values: Record<string, unknown>): SortDirection | undefined {
  const value = values.sortDirection;
  return value === 'asc' || value === 'desc' ? value : undefined;
}

export function createEcobaseInventoryDashboardActions() {
  return guardEcobaseActions(
    {
      header: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        // T-3.0c(a): timing evidence for the observed staging latency variance.
        const startedAt = Date.now();
        const service = await buildService(ctx.db);
        ctx.body = { data: await service.header({ companyId: optionalString(values, 'companyId') }) };
        ctx.logger?.info?.(`ecobaseInventoryDashboard:header served in ${Date.now() - startedAt}ms`);
        await next();
      },
      pane: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const pane = requirePane(ctx, values.pane);
        const runId = optionalString(values, 'runId');
        if (!runId) {
          ctx.throw(400, 'Ecobase Inventory Dashboard pane requests require the pinned runId.');
        }
        const service = await buildService(ctx.db);
        try {
          ctx.body = {
            data: await service.pane({
              pane,
              runId,
              companyId: optionalString(values, 'companyId'),
              search: optionalString(values, 'search'),
              sort: optionalString(values, 'sort'),
              sortDirection: sortDirection(values),
              page: optionalNumber(values, 'page') ?? 1,
              pageSize: optionalNumber(values, 'pageSize') ?? 25,
            }),
          };
        } catch (error) {
          if (error instanceof InventoryDashboardValidationError) ctx.throw(400, error.message);
          throw error;
        }
        await next();
      },
      drawerContext: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const pane = requirePane(ctx, values.pane);
        const runId = optionalString(values, 'runId');
        const familyId = optionalString(values, 'familyId');
        if (!runId || !familyId) {
          ctx.throw(400, 'Ecobase Inventory Dashboard drawer context requires runId and familyId.');
        }
        const service = await buildService(ctx.db);
        try {
          ctx.body = {
            data: await service.drawerContext({
              pane,
              runId,
              familyId,
              orderId: optionalString(values, 'orderId'),
              listingRowId: optionalString(values, 'listingRowId'),
            }),
          };
        } catch (error) {
          if (error instanceof InventoryDashboardValidationError) ctx.throw(400, error.message);
          throw error;
        }
        await next();
      },
      savePrepDetails: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const orderId = optionalString(values, 'orderId');
        if (!orderId) {
          ctx.throw(400, 'Ecobase Inventory Dashboard savePrepDetails requires orderId.');
        }
        const service = await buildService(ctx.db);
        try {
          ctx.body = {
            data: await service.savePrepDetails({
              orderId,
              prepBoxes: values.prepBoxes,
              prepCartons: values.prepCartons,
              prepDimensions: values.prepDimensions,
              actorUserId: actorUserId(ctx),
            }),
          };
        } catch (error) {
          if (error instanceof InventoryDashboardValidationError) ctx.throw(400, error.message);
          throw error;
        }
        await next();
      },
      reactivateFamily: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const service = await buildService(ctx.db);
        try {
          ctx.body = {
            data: await service.reactivateFamily({
              familyId: optionalString(values, 'familyId'),
              comment: optionalString(values, 'comment'),
              actorUserId: actorUserId(ctx),
            }),
          };
        } catch (error) {
          if (error instanceof InventoryDashboardValidationError) ctx.throw(400, error.message);
          throw error;
        }
        await next();
      },
      saveSupplierShipDestination: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const supplierId = optionalString(values, 'supplierId');
        if (!supplierId) {
          ctx.throw(400, 'Ecobase Inventory Dashboard saveSupplierShipDestination requires supplierId.');
        }
        const service = await buildService(ctx.db);
        try {
          ctx.body = {
            data: await service.saveSupplierShipDestination({
              supplierId,
              shipDestination: values.shipDestination,
              actorUserId: actorUserId(ctx),
            }),
          };
        } catch (error) {
          if (error instanceof InventoryDashboardValidationError) ctx.throw(400, error.message);
          throw error;
        }
        await next();
      },
    },
    { savePrepDetails: 'operator', saveSupplierShipDestination: 'operator', reactivateFamily: 'operator' },
  );
}

export function createInventoryDashboardResourceRegistration(
  onOperatorWrite?: () => void,
): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      {
        name: 'ecobaseInventoryDashboard',
        actions: triggerOnOperatorWrite(
          createEcobaseInventoryDashboardActions(),
          ['savePrepDetails', 'saveSupplierShipDestination', 'reactivateFamily'],
          onOperatorWrite,
        ),
      },
    ],
    acl: [
      { resource: 'ecobaseInventoryDashboard', actions: ['header', 'pane', 'drawerContext'], role: LOGGED_IN },
      {
        resource: 'ecobaseInventoryDashboard',
        actions: ['savePrepDetails', 'saveSupplierShipDestination', 'reactivateFamily'],
        role: OPERATOR,
      },
    ],
  };
}
