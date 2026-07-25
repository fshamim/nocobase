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
  createEcobaseInventoryPlanningActions,
  createEcobaseOrderPlanningActions,
  createEcobaseSupplierOrderActions,
} from '../../../server/resource-actions';
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
import {
  EcobaseOrderWorkbenchService,
  OrderWorkbenchError,
  type CreateOrderInput,
  type OrderLineInput,
} from './order-workbench-service';
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

function actorDisplayName(ctx: DashboardActionContext): string | undefined {
  const currentUser = ctx.state?.currentUser;
  if (typeof currentUser !== 'object' || currentUser === null) return undefined;
  const record = currentUser as Record<string, unknown>;
  for (const key of ['nickname', 'fullName', 'username', 'email']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Map the workbench's typed errors onto HTTP statuses; other errors bubble. */
async function runWorkbench<T>(
  ctx: DashboardActionContext,
  next: DashboardNext,
  work: (service: EcobaseOrderWorkbenchService) => Promise<T>,
) {
  const service = new EcobaseOrderWorkbenchService(ctx.db);
  try {
    ctx.body = { data: await work(service) };
  } catch (error) {
    if (error instanceof OrderWorkbenchError) ctx.throw(error.status, error.message);
    throw error;
  }
  await next();
}

function toOrderLineInput(value: unknown): OrderLineInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const companyProductId = typeof record.companyProductId === 'string' ? record.companyProductId : undefined;
  const orderedQty = typeof record.orderedQty === 'number' ? record.orderedQty : Number(record.orderedQty);
  if (!companyProductId || !Number.isFinite(orderedQty)) return undefined;
  const num = (key: string) => (typeof record[key] === 'number' ? (record[key] as number) : undefined);
  const str = (key: string) => (typeof record[key] === 'string' && record[key] ? (record[key] as string) : undefined);
  return {
    companyProductId,
    orderedQty,
    unitCost: num('unitCost'),
    supplierPackSize: num('supplierPackSize'),
    expectedSellPrice: num('expectedSellPrice'),
    expectedMargin: num('expectedMargin'),
    expectedDeliveryDate: str('expectedDeliveryDate'),
    expectedSellableDate: str('expectedSellableDate'),
    priority: str('priority'),
  };
}

async function buildService(db: DashboardDatabase): Promise<EcobaseInventoryDashboardService> {
  const settings = await new EcobasePlanningSettingsService(db).getResolvedSettings();
  return new EcobaseInventoryDashboardService(db, {
    leadTimeFreshnessDays: settings.leadTimeFreshnessDays,
    followUpThresholdHours: settings.followUpThresholdHours,
    fbaReceivingBufferDays: settings.fbaReceivingBufferDays,
    targetCoverDays: settings.targetCoverDays,
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
  // T8a (X4 closure): every operator mutation the dashboard UI needs is served
  // under THIS resource. The six ported actions delegate VERBATIM to the shared
  // legacy handlers (same payloads, same validation, same goldRefreshRequired
  // envelopes) — and arrive PRE-guarded by their source factories'
  // guardEcobaseActions role maps, so they are not re-listed in the dashboard
  // map below. Imports come exclusively from shared src/server/ modules (AD-1).
  const planningActions = createEcobaseInventoryPlanningActions();
  const orderPlanningActions = createEcobaseOrderPlanningActions();
  const supplierOrderActions = createEcobaseSupplierOrderActions();
  return guardEcobaseActions(
    {
      setFamilyTarget: planningActions.setFamilyTarget,
      setFamilyPreferredSupplier: planningActions.setFamilyPreferredSupplier,
      updateProductPlanningFields: planningActions.updateProductPlanningFields,
      createPlannedOrder: supplierOrderActions.createPlannedOrder,
      updateSupplierLeadTime: supplierOrderActions.updateSupplierLeadTime,
      addComment: orderPlanningActions.addComment,
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
              includeRaw: values.includeRaw === true,
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
      addProductComment: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const service = await buildService(ctx.db);
        try {
          ctx.body = {
            data: await service.addProductComment({
              familyId: optionalString(values, 'familyId'),
              companyProductId: optionalString(values, 'companyProductId'),
              body: optionalString(values, 'body'),
              actorUserId: actorUserId(ctx),
            }),
          };
        } catch (error) {
          if (error instanceof InventoryDashboardValidationError) ctx.throw(400, error.message);
          throw error;
        }
        await next();
      },
      // ---- Order Create/View workbench (T3) --------------------------------
      prepareOrderDraft: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, async (service) => ({
          ...(await service.prepareOrderDraft({
            planningProductId: optionalString(values, 'planningProductId'),
            company: optionalString(values, 'company'),
          })),
          placedBy: actorDisplayName(ctx),
        }));
      },
      checkOrderRef: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.checkOrderRef({
            companyId: optionalString(values, 'companyId'),
            orderRef: optionalString(values, 'orderRef'),
            excludeOrderId: optionalString(values, 'excludeOrderId'),
          }),
        );
      },
      orderStatusOptions: async (ctx: DashboardActionContext, next: DashboardNext) => {
        await runWorkbench(ctx, next, (service) => Promise.resolve(service.statusOptions()));
      },
      productOptions: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.productOptions({
            companyId: optionalString(values, 'companyId'),
            search: optionalString(values, 'search'),
            limit: optionalNumber(values, 'limit'),
          }),
        );
      },
      getOrderDetail: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.getOrderDetail({ orderId: optionalString(values, 'orderId') }),
        );
      },
      createOrder: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const rawLines = Array.isArray(values.lines) ? values.lines : [];
        const lines = rawLines.map(toOrderLineInput).filter((line): line is OrderLineInput => line !== undefined);
        const input: CreateOrderInput = {
          companyId: optionalString(values, 'companyId'),
          orderRef: optionalString(values, 'orderRef'),
          orderDate: optionalString(values, 'orderDate'),
          supplierId: optionalString(values, 'supplierId'),
          sourceMarketplace: optionalString(values, 'sourceMarketplace'),
          paymentStatus: optionalString(values, 'paymentStatus'),
          paymentMode: optionalString(values, 'paymentMode'),
          paymentDate: optionalString(values, 'paymentDate'),
          invoiceStatus: optionalString(values, 'invoiceStatus'),
          attachmentReference: optionalString(values, 'attachmentReference'),
          shippingCarrier: optionalString(values, 'shippingCarrier'),
          trackingId: optionalString(values, 'trackingId'),
          expectedDeliveryDate: optionalString(values, 'expectedDeliveryDate'),
          remarks: optionalString(values, 'remarks'),
          lines,
          actorUserId: actorUserId(ctx),
          actorDisplayName: actorDisplayName(ctx),
        };
        await runWorkbench(ctx, next, (service) => service.createOrder(input));
      },
      updateOrderHeader: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.updateOrderHeader({ ...values, actorUserId: actorUserId(ctx) }),
        );
      },
      updateOrderLine: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.updateOrderLine({ ...values, actorUserId: actorUserId(ctx) }),
        );
      },
      addOrderLine: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.addOrderLine({
            orderId: optionalString(values, 'orderId'),
            line: toOrderLineInput(values.line),
            actorUserId: actorUserId(ctx),
          }),
        );
      },
      deleteOrderLine: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.deleteOrderLine({
            orderLineId: optionalString(values, 'orderLineId'),
            actorUserId: actorUserId(ctx),
          }),
        );
      },
      deleteOrder: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.deleteOrder({ orderId: optionalString(values, 'orderId'), actorUserId: actorUserId(ctx) }),
        );
      },
      setOrderStatus: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.setOrderStatus({
            orderId: optionalString(values, 'orderId'),
            status: values.status,
            actorUserId: actorUserId(ctx),
          }),
        );
      },
      // ---- Order panes (T2.5) — order-grain read (LOGGED_IN, not an operator write) ----
      paneOrders: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.paneOrders({
            pane: values.pane,
            runId: optionalString(values, 'runId'),
            companyId: optionalString(values, 'companyId'),
            search: optionalString(values, 'search'),
            page: optionalNumber(values, 'page'),
            pageSize: optionalNumber(values, 'pageSize'),
          }),
        );
      },
      // ---- Order-pane popup mutations (T2.2–T2.4) --------------------------
      updateOrderPaperwork: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.updateOrderPaperwork({ ...values, actorUserId: actorUserId(ctx) }),
        );
      },
      updatePrepDetails: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        const payload: Record<string, unknown> = {
          orderId: optionalString(values, 'orderId'),
          actorUserId: actorUserId(ctx),
        };
        for (const field of [
          'prepBoxes',
          'prepCartons',
          'prepUnits',
          'prepDimensions',
          'prepWeightValue',
          'prepWeightUnit',
          'hazmatFlag',
          'shippingId',
          'labelFilesLink',
          'prepStatus',
        ]) {
          if (field in values) payload[field] = values[field];
        }
        await runWorkbench(ctx, next, (service) => service.updatePrepDetails(payload));
      },
      confirmInboundCompletion: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.confirmInboundCompletion({
            orderId: optionalString(values, 'orderId'),
            actorUserId: actorUserId(ctx),
          }),
        );
      },
      // ---- Order popup Comments tab (T8) -----------------------------------
      addOrderComment: async (ctx: DashboardActionContext, next: DashboardNext) => {
        const values = getValues(ctx.action.params);
        await runWorkbench(ctx, next, (service) =>
          service.addOrderComment({
            orderId: optionalString(values, 'orderId'),
            body: values.body,
            actorUserId: actorUserId(ctx),
          }),
        );
      },
    },
    {
      savePrepDetails: 'operator',
      saveSupplierShipDestination: 'operator',
      reactivateFamily: 'operator',
      addProductComment: 'operator',
      prepareOrderDraft: 'operator',
      checkOrderRef: 'operator',
      orderStatusOptions: 'operator',
      productOptions: 'operator',
      getOrderDetail: 'operator',
      createOrder: 'operator',
      updateOrderHeader: 'operator',
      updateOrderLine: 'operator',
      addOrderLine: 'operator',
      deleteOrderLine: 'operator',
      deleteOrder: 'operator',
      setOrderStatus: 'operator',
      updateOrderPaperwork: 'operator',
      updatePrepDetails: 'operator',
      confirmInboundCompletion: 'operator',
      addOrderComment: 'operator',
    },
  );
}

export function createInventoryDashboardResourceRegistration(
  onOperatorWrite?: () => void,
): EcobaseFeatureResourceRegistration {
  return {
    resources: [
      {
        name: 'ecobaseInventoryDashboard',
        // T8a: every operator write rides the 45 s auto-publish debounce.
        actions: triggerOnOperatorWrite(
          createEcobaseInventoryDashboardActions(),
          [
            'savePrepDetails',
            'saveSupplierShipDestination',
            'reactivateFamily',
            'setFamilyTarget',
            'setFamilyPreferredSupplier',
            'updateProductPlanningFields',
            'createPlannedOrder',
            'updateSupplierLeadTime',
            'addComment',
            'addProductComment',
            // Order Create/View workbench mutations (T3): each rides the publish debounce.
            'createOrder',
            'updateOrderHeader',
            'updateOrderLine',
            'addOrderLine',
            'deleteOrderLine',
            'deleteOrder',
            'setOrderStatus',
            // Order-pane popup mutations (T2.2–T2.4) ride the publish debounce too.
            'updateOrderPaperwork',
            'updatePrepDetails',
            'confirmInboundCompletion',
            // T8: logging a comment is an operator write — it rides the debounce too.
            'addOrderComment',
          ],
          onOperatorWrite,
        ),
      },
    ],
    acl: [
      {
        resource: 'ecobaseInventoryDashboard',
        actions: ['header', 'pane', 'drawerContext', 'paneOrders'],
        role: LOGGED_IN,
      },
      {
        resource: 'ecobaseInventoryDashboard',
        actions: [
          'savePrepDetails',
          'saveSupplierShipDestination',
          'reactivateFamily',
          'setFamilyTarget',
          'setFamilyPreferredSupplier',
          'updateProductPlanningFields',
          'createPlannedOrder',
          'updateSupplierLeadTime',
          'addComment',
          'addProductComment',
          'prepareOrderDraft',
          'checkOrderRef',
          'orderStatusOptions',
          'productOptions',
          'getOrderDetail',
          'createOrder',
          'updateOrderHeader',
          'updateOrderLine',
          'addOrderLine',
          'deleteOrderLine',
          'deleteOrder',
          'setOrderStatus',
          'updateOrderPaperwork',
          'updatePrepDetails',
          'confirmInboundCompletion',
          'addOrderComment',
        ],
        role: OPERATOR,
      },
    ],
  };
}
