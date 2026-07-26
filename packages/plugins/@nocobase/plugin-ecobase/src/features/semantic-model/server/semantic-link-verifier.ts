/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { resolveCanonicalCompany } from '../../../server/company-identity';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { isApprovedOrderLineBusinessAmbiguity } from '../../inventory-planning/server/silver-integrity-verifier';
import { canonicalOrderLifecycleStatus, resolveOrderLifecycle } from '../../order-planning/server/order-lifecycle';
import type { EcobaseDatabase } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';
import { EcobaseInventoryPlanningGoldAccess } from '../../inventory-dashboard/server/engine/inventory-planning-gold-access';

type PlainRecord = Record<string, unknown>;
type Severity = 'error' | 'warning';

export type SemanticLinkIssue = {
  severity: Severity;
  code: string;
  entityIds: string[];
  message: string;
};

export type SemanticLinkSnapshot = {
  bronze: PlainRecord[];
  companies: PlainRecord[];
  suppliers: PlainRecord[];
  products: PlainRecord[];
  companyProducts: PlainRecord[];
  supplierProducts: PlainRecord[];
  companyProductSuppliers: PlainRecord[];
  orders: PlainRecord[];
  orderLines: PlainRecord[];
  taskLinks: PlainRecord[];
  importRuns: PlainRecord[];
  goldOrders: PlainRecord[];
  goldInventory: PlainRecord[];
};

const ORDER_PREFIX_COMPANY_KEY: Record<string, string> = {
  EF: 'ECOFISSION_LLC',
  MX: 'MUXTEX_INC',
  RH: 'RETAIL_HEAVEN_INC',
  SS: 'STOP_SHOP_LLC',
};
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'rejected']);
const PURCHASED_PIPELINE_STATUSES = new Set(['paid', 'supplier_preparing', 'shipped_inbound', 'reached_fba']);

function text(value: unknown) {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim()
    ? String(value).trim()
    : undefined;
}

function comparableOrderStatus(value: unknown) {
  const status = text(value);
  const canonical = canonicalOrderLifecycleStatus(status);
  if (canonical) return canonical;
  const alias = status?.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const aliases: Record<string, string> = {
    approval_pending: 'APPROVED TO ORDER',
    payment_pending: 'APPROVED TO ORDER',
    paid: 'ORDERED',
    supplier_preparing: 'PREP IN-PROGRESS',
    shipped_inbound: 'SHIPPED TO FBA',
    reached_fba: 'INBOUND MONITORING',
    completed: 'COMPLETE',
    cancelled: 'COMPLETE',
    rejected: 'COMPLETE',
    draft: 'ORDER ANALYSING',
  };
  return (
    aliases[alias ?? ''] ??
    resolveOrderLifecycle({ canonicalStatus: status, lifecycleStatus: status, sourceOrderStatus: status })
      .canonicalStatus
  );
}

function effectiveInventoryOrderStatus(order: PlainRecord) {
  const status = text(order.canonicalStatus);
  const statusSource = text(order.statusSource);
  if (
    statusSource === 'operator' ||
    (statusSource === 'manual' && (text(order.operatorStatusOverrideAt) || text(order.lastOperatorEditAt))) ||
    inventoryOrderStatusCategory(status) === 'closed'
  ) {
    return status;
  }
  return /completed|complete|paid/i.test(text(order.paymentStatus) ?? '') ? 'paid' : status;
}

function inventoryOrderStatusCategory(value: unknown) {
  const status = comparableOrderStatus(value);
  if (status === 'COMPLETE') return 'closed';
  if (
    [
      'ORDERED',
      'IN TRANSIT TO PREP',
      'DIRECT SHIP FBA',
      'AT PREP NOT STARTED',
      'PREP IN-PROGRESS',
      'SHIPPED TO FBA',
      'INBOUND MONITORING',
    ].includes(status)
  )
    return 'purchased_pipeline';
  return 'placed_not_purchased';
}

function id(row: PlainRecord | undefined) {
  return text(row?.id) ?? '';
}

function normalizedOrderRef(value: unknown) {
  return text(value)
    ?.toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

function groupBy(rows: PlainRecord[], keyFor: (row: PlainRecord) => string | undefined) {
  const groups = new Map<string, PlainRecord[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

function latestDate(rows: PlainRecord[], field: string) {
  return rows
    .map((row) => text(row[field]) ?? '')
    .sort()
    .at(-1);
}

function nestedRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PlainRecord) : {};
}

export function evaluateSemanticLinkSnapshot(snapshot: SemanticLinkSnapshot) {
  const issues: SemanticLinkIssue[] = [];
  const issue = (severity: Severity, code: string, rows: PlainRecord[], message: string) => {
    issues.push({ severity, code, entityIds: rows.map(id).filter(Boolean), message });
  };
  const byId = (rows: PlainRecord[]) => new Map(rows.map((row) => [id(row), row]));
  const companyById = byId(snapshot.companies);
  const supplierById = byId(snapshot.suppliers);
  const companyProductById = byId(snapshot.companyProducts);
  const supplierProductById = byId(snapshot.supplierProducts);
  const orderById = byId(snapshot.orders);

  for (const rows of groupBy(snapshot.companies, (row) => text(row.companyKey)).values()) {
    if (rows.length > 1) issue('error', 'duplicate_company_key', rows, 'Multiple companies share one companyKey.');
  }
  for (const rows of groupBy(snapshot.companies, (row) => {
    const resolved = resolveCanonicalCompany(text(row.name));
    return (
      resolved?.companyKey ??
      text(row.name)
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
    );
  }).values()) {
    if (rows.length > 1)
      issue('error', 'canonical_company_alias_duplicate', rows, 'Company aliases resolve to multiple rows.');
  }
  for (const rows of groupBy(
    snapshot.orders,
    (row) => `${text(row.companyId) ?? ''}:${normalizedOrderRef(row.orderRef) ?? ''}`,
  ).values()) {
    if (rows.length > 1) issue('error', 'duplicate_company_order_ref', rows, 'Company/order reference is not unique.');
  }

  for (const order of snapshot.orders) {
    const company = companyById.get(text(order.companyId) ?? '');
    const supplier = supplierById.get(text(order.supplierId) ?? '');
    if (!company) issue('error', 'order_company_missing', [order], 'Order has no canonical company.');
    if (!supplier) issue('error', 'order_supplier_missing', [order], 'Order has no canonical supplier.');
    if (supplier && text(supplier.companyId) && text(supplier.companyId) !== text(order.companyId)) {
      issue('error', 'order_supplier_company_mismatch', [order], 'Order supplier belongs to another company.');
    }
    const ref = normalizedOrderRef(order.orderRef);
    const expectedKey = ref ? ORDER_PREFIX_COMPANY_KEY[ref.slice(0, 2)] : undefined;
    if (expectedKey && text(company?.companyKey) !== expectedKey) {
      issue('error', 'order_prefix_company_mismatch', [order], 'Order prefix conflicts with canonical company.');
    }
  }

  for (const line of snapshot.orderLines) {
    const order = orderById.get(text(line.orderId) ?? '');
    const companyProduct = companyProductById.get(text(line.companyProductId) ?? '');
    const supplierProduct = supplierProductById.get(text(line.supplierProductId) ?? '');
    if (!order) issue('error', 'order_line_order_missing', [line], 'Order line has no order.');
    if (!companyProduct || !supplierProduct) {
      const mappingStatus = text(line.productMappingStatus);
      issue(
        text(line.productAnalysisStatus) === 'mapping_missing' ||
          isApprovedOrderLineBusinessAmbiguity(line) ||
          mappingStatus === 'family_only' ||
          mappingStatus === 'unresolved' ||
          (mappingStatus === 'exact_member' && Boolean(companyProduct))
          ? 'warning'
          : 'error',
        'order_line_product_missing',
        [line],
        'Order line is missing a canonical member or supplier-product link.',
      );
      continue;
    }
    if (text(companyProduct.companyId) !== text(order?.companyId)) {
      issue('error', 'order_line_company_mismatch', [line], 'Order line company product conflicts with order company.');
    }
    if (text(supplierProduct.supplierId) !== text(order?.supplierId)) {
      issue(
        'error',
        'order_line_supplier_mismatch',
        [line],
        'Order line supplier product conflicts with order supplier.',
      );
    }
    if (text(companyProduct.productId) !== text(supplierProduct.productId)) {
      issue(
        'error',
        'order_line_product_mismatch',
        [line],
        'Company and supplier products point to different products.',
      );
    }
    const link = snapshot.companyProductSuppliers.find(
      (row) =>
        text(row.companyProductId) === text(line.companyProductId) &&
        text(row.supplierProductId) === text(line.supplierProductId),
    );
    if (!link)
      issue('error', 'order_line_supplier_link_missing', [line], 'Order line has no company-product-supplier link.');
  }

  for (const rows of groupBy(
    snapshot.companyProductSuppliers.filter((row) => text(row.role) === 'latest_used'),
    (row) => text(row.companyProductId),
  ).values()) {
    if (rows.length > 1)
      issue('error', 'multiple_latest_used_supplier_links', rows, 'Company product has multiple latest_used links.');
  }

  for (const rows of groupBy(snapshot.taskLinks, (row) => text(row.sourceTaskRef)).values()) {
    const orderIds = new Set(rows.map((row) => text(row.supplierOrderId) ?? text(row.entityId)).filter(Boolean));
    const companyIds = new Set(
      [...orderIds].map((orderId) => text(orderById.get(orderId ?? '')?.companyId)).filter(Boolean),
    );
    if (orderIds.size > 1 || companyIds.size > 1) {
      issue('error', 'clickup_task_multi_order_target', rows, 'ClickUp task targets multiple orders or companies.');
    }
  }

  const clickupRuns = snapshot.importRuns.filter((row) => text(row.adapterName) === 'clickup-order-status-csv');
  const orderRuns = snapshot.importRuns.filter((row) => {
    const sourceIdentifier = text(row.sourceIdentifier) ?? '';
    return sourceIdentifier.includes('order-management') && !sourceIdentifier.includes('product-reconciliation');
  });
  const clickupRun = [...clickupRuns].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  const orderRun = [...orderRuns].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (!clickupRun) issue('error', 'clickup_import_run_missing', [], 'No ClickUp import run exists.');
  if (clickupRun && orderRun && String(clickupRun.startedAt) <= String(orderRun.startedAt)) {
    issue(
      'error',
      'clickup_import_not_after_orders',
      [clickupRun, orderRun],
      'ClickUp import did not run after Order Management.',
    );
  }
  if (clickupRun && !['success', 'skipped'].includes(text(clickupRun.status) ?? '')) {
    issue('error', 'clickup_import_not_successful', [clickupRun], 'Latest ClickUp import did not succeed.');
  }
  if (clickupRun) {
    const clickup = nestedRecord(nestedRecord(clickupRun.summary).clickup);
    for (const [field, code] of [
      ['unmappedStatusCount', 'clickup_unmapped_statuses'],
      ['ambiguousOrderCount', 'clickup_ambiguous_orders'],
      ['blockingIssueCount', 'clickup_blocking_issues'],
    ] as const) {
      if (Number(clickup[field] ?? 0) > 0) issue('error', code, [clickupRun], `ClickUp summary ${field} is non-zero.`);
    }
    if (Number(clickup.unmatchedRefCount ?? 0) > 0) {
      issue(
        'warning',
        'clickup_unmatched_refs',
        [clickupRun],
        'ClickUp refs without an accepted Purchase Orders header were not linked.',
      );
    }
    if (Number(clickup.conflictingMainTaskCount ?? 0) > 0) {
      issue(
        'warning',
        'clickup_status_conflicts_resolved_by_recency',
        [clickupRun],
        'Conflicting ClickUp statuses were resolved by the most recent authoritative task.',
      );
    }
    if (Number(clickup.companyConflictCount ?? 0) > 0) {
      issue(
        'warning',
        'clickup_company_title_conflicts',
        [clickupRun],
        'ClickUp title conflicts were resolved from the supported order prefix.',
      );
    }
    if (Number(clickup.missingMainTaskCount ?? 0) > 0) {
      issue('warning', 'clickup_main_tasks_missing', [clickupRun], 'ClickUp refs without main tasks were quarantined.');
    }
  }

  const statusAuthorityLinks = snapshot.taskLinks.filter((row) => text(row.relation) === 'status_authority');
  const statusAuthorityOrderIds = new Set(
    statusAuthorityLinks.map((link) => text(link.supplierOrderId) ?? text(link.entityId) ?? ''),
  );
  for (const link of statusAuthorityLinks) {
    const order = orderById.get(text(link.supplierOrderId) ?? text(link.entityId) ?? '');
    if (order && !['clickup_csv', 'operator'].includes(text(order.statusSource) ?? '')) {
      issue(
        'error',
        'clickup_matched_order_status_source_mismatch',
        [order],
        'ClickUp-matched order lacks final status source.',
      );
    }
  }

  for (const gold of snapshot.goldOrders) {
    const orderId = text(gold.orderId) ?? '';
    const order = orderById.get(orderId);
    if (!statusAuthorityOrderIds.has(orderId) && text(order?.statusSource) !== 'operator') continue;
    if (
      !order ||
      comparableOrderStatus(gold.canonicalStatus) !== comparableOrderStatus(order.canonicalStatus) ||
      comparableOrderStatus(gold.lifecycleStatus) !== comparableOrderStatus(order.lifecycleStatus) ||
      text(gold.statusSource) !== text(order.statusSource)
    ) {
      issue('error', 'gold_order_status_stale', [gold], 'Gold order status does not match final silver order.');
    }
  }

  const latestInventoryDate = latestDate(snapshot.goldInventory, 'calculationDate');
  for (const gold of snapshot.goldInventory.filter(
    (row) => !latestInventoryDate || text(row.calculationDate) === latestInventoryDate,
  )) {
    const company = snapshot.companies.find((row) => text(row.name) === text(gold.company));
    const order = snapshot.orders.find(
      (row) => text(row.companyId) === id(company) && text(row.orderRef) === text(gold.supplierOrderRef),
    );
    if (
      text(gold.supplierOrderRef) &&
      (!order ||
        inventoryOrderStatusCategory(gold.supplierOrderStatus) !==
          inventoryOrderStatusCategory(effectiveInventoryOrderStatus(order)))
    ) {
      issue('error', 'gold_inventory_order_status_stale', [gold], 'Gold inventory order status is stale.');
    }
    const status = text(gold.supplierOrderStatus);
    const state = text(gold.supplierOrderState);
    if (status && CLOSED_STATUSES.has(status) && state !== 'closed_history') {
      issue('error', 'gold_inventory_closed_state_mismatch', [gold], 'Closed status is not closed_history.');
    }
    if (
      status &&
      PURCHASED_PIPELINE_STATUSES.has(status) &&
      !['purchased_pipeline', 'closed_history'].includes(state ?? '')
    ) {
      issue('error', 'gold_inventory_pipeline_state_mismatch', [gold], 'Purchased status is not purchased_pipeline.');
    }
    const companyProduct = companyProductById.get(text(gold.companyProductId) ?? '');
    if (text(gold.supplierId) && companyProduct) {
      const supplierProduct = snapshot.supplierProducts.find(
        (row) =>
          text(row.supplierId) === text(gold.supplierId) && text(row.productId) === text(companyProduct.productId),
      );
      const relationship = snapshot.companyProductSuppliers.find(
        (row) =>
          text(row.companyProductId) === text(gold.companyProductId) &&
          text(row.supplierProductId) === id(supplierProduct),
      );
      const duplicateSourceCompanyProduct = companyProductById.get(
        text(nestedRecord(nestedRecord(gold.evidence).duplicateSkuSupplierSource).sourceCompanyProductId) ?? '',
      );
      const duplicateSupplierProduct = duplicateSourceCompanyProduct
        ? snapshot.supplierProducts.find(
            (row) =>
              text(row.supplierId) === text(gold.supplierId) &&
              text(row.productId) === text(duplicateSourceCompanyProduct.productId),
          )
        : undefined;
      const duplicateRelationship = snapshot.companyProductSuppliers.find(
        (row) =>
          text(row.companyProductId) === id(duplicateSourceCompanyProduct) &&
          text(row.supplierProductId) === id(duplicateSupplierProduct),
      );
      const familyId = text(gold.companyProductFamilyId);
      const familyMemberIds = new Set(
        snapshot.goldInventory
          .filter((row) => familyId && text(row.companyProductFamilyId) === familyId)
          .map((row) => text(row.companyProductId))
          .filter(Boolean),
      );
      const familySupplierProductId = text(gold.familyPreferredSupplierProductId);
      const familySupplierProduct = supplierProductById.get(familySupplierProductId ?? '');
      const familyRelationship = snapshot.companyProductSuppliers.find(
        (row) =>
          familyMemberIds.has(text(row.companyProductId)) && text(row.supplierProductId) === id(familySupplierProduct),
      );
      const familySupplierEvidence =
        text(gold.familyPreferredSupplierId) === text(gold.supplierId) &&
        text(familySupplierProduct?.supplierId) === text(gold.supplierId) &&
        Boolean(familyRelationship);
      if (
        (!supplierProduct || !relationship) &&
        (!duplicateSupplierProduct || !duplicateRelationship) &&
        !familySupplierEvidence
      ) {
        const targetOfferMissing =
          !familySupplierProductId && text(gold.familyPreferredSupplierId) === text(gold.supplierId);
        issue(
          targetOfferMissing ? 'warning' : 'error',
          targetOfferMissing ? 'gold_inventory_target_offer_missing' : 'gold_inventory_supplier_product_unresolved',
          [gold],
          targetOfferMissing
            ? 'Family preferred supplier is valid but the target listing has no supplier-product offer.'
            : 'Current gold row lacks supplier product evidence.',
        );
      }
    }
  }

  const broadWarnings = snapshot.bronze.filter((row) => text(row.issueCode) === 'supplier_product_unresolved');
  if (broadWarnings.length > 0) {
    issue(
      'warning',
      'historical_supplier_product_unresolved',
      broadWarnings,
      'Historical unresolved supplier products remain visible.',
    );
  }

  const errors = issues.filter((item) => item.severity === 'error');
  return {
    ok: errors.length === 0,
    errorCount: errors.length,
    warningCount: issues.length - errors.length,
    issues,
  };
}

export class EcobaseSemanticLinkVerifier {
  constructor(private db: EcobaseDatabase) {}

  async verify(params: { runId: string; purpose?: 'production_verification' | 'independent_verification' }) {
    const collections: Array<[Exclude<keyof SemanticLinkSnapshot, 'goldInventory'>, string]> = [
      ['bronze', ECOBASE_COLLECTIONS.bronzeSourceRecords],
      ['companies', ECOBASE_COLLECTIONS.silverCompanies],
      ['suppliers', ECOBASE_COLLECTIONS.silverSuppliers],
      ['products', ECOBASE_COLLECTIONS.silverProducts],
      ['companyProducts', ECOBASE_COLLECTIONS.silverCompanyProducts],
      ['supplierProducts', ECOBASE_COLLECTIONS.silverSupplierProducts],
      ['companyProductSuppliers', ECOBASE_COLLECTIONS.silverCompanyProductSuppliers],
      ['orders', ECOBASE_COLLECTIONS.silverOrders],
      ['orderLines', ECOBASE_COLLECTIONS.silverOrderLines],
      ['taskLinks', ECOBASE_COLLECTIONS.silverTaskLinks],
      ['importRuns', ECOBASE_COLLECTIONS.importRuns],
      ['goldOrders', ECOBASE_COLLECTIONS.goldOrderPlanningRows],
    ];
    const [values, goldInventory] = await Promise.all([
      Promise.all(
        collections.map(
          async ([key, collection]) =>
            [key, (await this.db.getRepository(collection).find({ limit: 100000 })).map(toPlainRecord)] as const,
        ),
      ),
      new EcobaseInventoryPlanningGoldAccess(this.db).readExplicitListingPerformance({
        runId: params.runId,
        purpose: params.purpose ?? 'production_verification',
        actor: { type: 'system' },
        limit: 100000,
      }),
    ]);
    return evaluateSemanticLinkSnapshot({
      ...(Object.fromEntries(values) as Omit<SemanticLinkSnapshot, 'goldInventory'>),
      goldInventory: goldInventory.rows,
    });
  }
}
