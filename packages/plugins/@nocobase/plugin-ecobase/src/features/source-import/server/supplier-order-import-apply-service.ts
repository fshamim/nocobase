/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { lifecycleStatusForOperationalStatus } from '../../order-planning/order-operational-status';
import type { EcobaseDatabase, EcobaseRepository } from './import-service';
import {
  assertReadySupplierOrderImportPreflight,
  type SupplierOrderImportPreflight,
} from './supplier-order-import/supplier-order-import-preflight';
import {
  prepareSupplierOrderCommentRelink,
  type ExportedSupplierOrderComment,
} from './supplier-order-import/supplier-order-comment-relink';
import {
  normalizeExternalOrderId,
  summarizeSupplierOrderExclusions,
  type SupplierOrderExclusionSummary,
} from './supplier-order-import/supplier-order-import-plan';
import { EcobaseInventoryPlanningGoldAccess } from '../../inventory-dashboard/server/engine/inventory-planning-gold-access';
import { EcobaseCompanyProductFamilyService } from '../../inventory-planning/server/company-product-family-service';
import type {
  OrderImportPlanRow,
  OrderLineImportPlanRow,
  SupplierOrderImportPlan,
  SupplierProductImportPlanRow,
} from './supplier-order-import/supplier-order-import-types';

type PlainRecord = Record<string, unknown>;
type MutableRepository = EcobaseRepository & { destroy?(params: Record<string, unknown>): Promise<unknown> };
type WriteKind = 'created' | 'updated' | 'deleted' | 'unchanged';

interface CollectionWrites {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

interface SupplierIdentity {
  supplierId: string;
  externalRefId: string;
}

interface LineLinks {
  companyProductFamilyId: string | null;
  companyProductId: string | null;
  productId: string | null;
}

interface OfferCandidate {
  line: OrderLineImportPlanRow;
  order: OrderImportPlanRow;
  supplierId: string;
  productId: string;
  companyProductId: string;
}

export interface SupplierOrderImportApplyResult {
  importMode: SupplierOrderImportPreflight['importMode'];
  preflightDigest: string;
  sourcePlanDigest: string;
  commentRelinkDigest: string;
  protectedFingerprint: string;
  noOp: boolean;
  totalWrites: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  mappingExceptions: number;
  exclusions: SupplierOrderExclusionSummary;
  updatedFields: Record<string, number>;
  byCollection: Record<string, CollectionWrites>;
}

export interface SupplierOrderFamilyReconciliationResult {
  companyCount: number;
  reconciledFamilyCount: number;
  supplierReviewCount: number;
}

const PROTECTED_COLLECTIONS = [
  ECOBASE_COLLECTIONS.silverCompanies,
  ECOBASE_COLLECTIONS.silverAmazonAccounts,
  ECOBASE_COLLECTIONS.silverProducts,
  ECOBASE_COLLECTIONS.silverCompanyProducts,
  ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
  ECOBASE_COLLECTIONS.silverInventorySnapshots,
  ECOBASE_COLLECTIONS.silverListingDailyFacts,
  ECOBASE_COLLECTIONS.silverTrafficSnapshots,
  ECOBASE_COLLECTIONS.sellerboardProductCosts,
] as const;

const PROTECTED_FINGERPRINT_KEYS = [...PROTECTED_COLLECTIONS, ECOBASE_COLLECTIONS.goldInventoryPlanningRows] as const;

function plain(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const record = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function text(value: unknown) {
  const result = String(value ?? '').trim();
  return result || undefined;
}

function stableUuid(value: string) {
  const hex = createHash('sha1').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(
    (parseInt(hex.slice(16, 18), 16) & 0x3f) |
    0x80
  )
    .toString(16)
    .padStart(2, '0')}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.entries(plain(value))
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function compact(values: PlainRecord) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function protectedRow(_collection: string, row: PlainRecord) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...businessFields } = row;
  return businessFields;
}

function sourceEvidence(row: PlainRecord) {
  return plain(row.sourceEvidence);
}

function canonicalOrderOwned(row: PlainRecord) {
  return (
    row.recordType === 'purchase_order' ||
    Boolean(text(sourceEvidence(row).preflightDigest)) ||
    row.statusSource === 'supplier_order_import'
  );
}

function canonicalOrderLineOwned(row: PlainRecord) {
  return Boolean(text(sourceEvidence(row).preflightDigest));
}

function sameValue(existing: unknown, desired: unknown) {
  if (typeof desired === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(desired)) {
    const existingDate =
      existing instanceof Date
        ? `${existing.getFullYear()}-${String(existing.getMonth() + 1).padStart(2, '0')}-${String(
            existing.getDate(),
          ).padStart(2, '0')}`
        : String(existing ?? '').slice(0, 10);
    return existingDate === desired;
  }
  return canonical(existing) === canonical(desired);
}

function sameValues(existing: PlainRecord, desired: PlainRecord) {
  return Object.entries(desired).every(([key, value]) => sameValue(existing[key], value));
}

function params(values: PlainRecord, transaction?: unknown) {
  return transaction ? ({ ...values, transaction } as never) : (values as never);
}

function orderIdentity(companyId: string, orderRef: string) {
  return `${companyId}:${orderRef}`;
}

function orderSequences(orders: OrderImportPlanRow[]) {
  const groups = new Map<string, OrderImportPlanRow[]>();
  for (const order of orders) {
    const key = `${order.companyKey}:${order.orderDate}`;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  const sequences = new Map<string, string>();
  for (const group of groups.values()) {
    const suffixCounts = new Map<string, number>();
    for (const order of group) {
      const suffix = order.externalOrderId.match(/[A-Z]$/)?.[0] ?? order.externalOrderId;
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
    }
    for (const order of group) {
      const suffix = order.externalOrderId.match(/[A-Z]$/)?.[0] ?? order.externalOrderId;
      sequences.set(
        `${order.companyKey}:${order.externalOrderId}`,
        suffixCounts.get(suffix)! > 1 ? order.externalOrderId : suffix,
      );
    }
  }
  return sequences;
}

export class EcobaseSupplierOrderImportApplyService {
  private writes: Record<string, CollectionWrites> = {};
  private updatedFields: Record<string, number> = {};

  constructor(private db: EcobaseDatabase) {}

  async apply(preflight: SupplierOrderImportPreflight): Promise<SupplierOrderImportApplyResult> {
    assertReadySupplierOrderImportPreflight(preflight);
    this.writes = {};
    this.updatedFields = {};
    let transactionResult: { commentRelinkDigest: string; protectedFingerprint: string } | undefined;
    const execute = async (transaction?: unknown) => {
      transactionResult = await this.applyInTransaction(preflight, transaction);
    };
    if (typeof this.db.sequelize?.transaction === 'function') {
      await this.db.sequelize.transaction((transaction: unknown) => execute(transaction));
    } else {
      await execute();
    }
    if (!transactionResult) throw new Error('Ecobase supplier/order apply failed: transaction produced no result.');
    const totals = Object.values(this.writes).reduce(
      (result, count) => ({
        created: result.created + count.created,
        updated: result.updated + count.updated,
        deleted: result.deleted + count.deleted,
        unchanged: result.unchanged + count.unchanged,
      }),
      { created: 0, updated: 0, deleted: 0, unchanged: 0 },
    );
    const totalWrites = totals.created + totals.updated + totals.deleted;
    return {
      importMode: preflight.importMode,
      preflightDigest: preflight.preflightDigest,
      sourcePlanDigest: preflight.sourcePlanDigest,
      commentRelinkDigest: transactionResult.commentRelinkDigest,
      protectedFingerprint: transactionResult.protectedFingerprint,
      noOp: totalWrites === 0,
      totalWrites,
      ...totals,
      mappingExceptions: preflight.mappingExceptions.length,
      exclusions: summarizeSupplierOrderExclusions(preflight.plan.issues),
      updatedFields: this.updatedFields,
      byCollection: this.writes,
    };
  }

  /**
   * Refresh family preferred suppliers from the just-applied orders. Runs after the apply
   * transaction commits (so reconciliation reads committed rows); the
   * applySupplierOrderImportPreflight endpoint invokes it so the supplier-order apply path
   * reconciles — reconciliation was previously skipped for the migration adapter and absent
   * from the apply endpoint, leaving family preferred suppliers stale after an import.
   */
  async reconcileFamiliesAfterApply(
    preflight: SupplierOrderImportPreflight,
  ): Promise<SupplierOrderFamilyReconciliationResult> {
    const companyIds = [...(await this.resolveCompanyIds(preflight.plan)).values()];
    const familyService = new EcobaseCompanyProductFamilyService(this.db);
    let reconciledFamilyCount = 0;
    let supplierReviewCount = 0;
    for (const companyId of companyIds) {
      const result = await familyService.reconcileAllFamilies(companyId, {
        preserveCatalog: preflight.importMode === 'refresh',
      });
      reconciledFamilyCount += result.familyCount;
      supplierReviewCount += result.supplierReviewCount;
    }
    return { companyCount: companyIds.length, reconciledFamilyCount, supplierReviewCount };
  }

  private async applyInTransaction(preflight: SupplierOrderImportPreflight, transaction?: unknown) {
    const plan = preflight.plan;
    const protectedBefore = await this.protectedFingerprints(transaction);
    const protectedFamilies = await this.all(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, transaction);
    const retainedSupplierProductIds = new Set(
      protectedFamilies.map((family) => text(family.preferredSupplierProductId)).filter(Boolean) as string[],
    );
    const retainedSupplierIds = new Set(
      protectedFamilies.map((family) => text(family.preferredSupplierId)).filter(Boolean) as string[],
    );
    for (const supplierProduct of await this.all(ECOBASE_COLLECTIONS.silverSupplierProducts, transaction)) {
      if (retainedSupplierProductIds.has(text(supplierProduct.id) ?? '')) {
        const supplierId = text(supplierProduct.supplierId);
        if (supplierId) retainedSupplierIds.add(supplierId);
      }
    }
    const retainedCompanyProductSupplierIds = new Set(
      (await this.all(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, transaction))
        .filter((relationship) => retainedSupplierProductIds.has(text(relationship.supplierProductId) ?? ''))
        .map((relationship) => text(relationship.id))
        .filter(Boolean) as string[],
    );
    const companyIds = await this.resolveCompanyIds(plan, transaction);
    const existingOrders = await this.all(ECOBASE_COLLECTIONS.silverOrders, transaction);
    const existingOrderByIdentity = new Map(
      existingOrders.map((order) => [orderIdentity(text(order.companyId) ?? '', text(order.orderRef) ?? ''), order]),
    );
    const targetOrders = plan.orders.map((order) => {
      const companyId = companyIds.get(order.companyKey)!;
      const existing = existingOrderByIdentity.get(orderIdentity(companyId, order.externalOrderId));
      return {
        id: text(existing?.id) ?? stableUuid(`order:${companyId}:${order.externalOrderId}`),
        companyId,
        orderRef: order.externalOrderId,
      };
    });
    const commentRelink = await this.commentRelinkPlan(existingOrders, targetOrders, preflight.importMode, transaction);
    if (!commentRelink.ready) {
      const reasons = Object.entries(
        commentRelink.blockers.reduce<Record<string, number>>((counts, blocker) => {
          counts[blocker.reason] = (counts[blocker.reason] ?? 0) + 1;
          return counts;
        }, {}),
      )
        .sort(([left], [right]) => compareText(left, right))
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ');
      throw new Error(
        `Ecobase supplier/order apply failed: ${commentRelink.blockers.length} operator comments cannot be relinked (${reasons}).`,
      );
    }

    const identities = await this.ensureSupplierIdentities(plan, transaction);
    const desiredAccountIds = await this.ensureSupplierAccounts(plan, identities, companyIds, transaction);
    const orderIds = await this.ensureOrders(
      plan,
      preflight.preflightDigest,
      identities,
      companyIds,
      existingOrderByIdentity,
      transaction,
    );
    const linksByLine = await this.resolveLineLinks(plan, companyIds, transaction);
    const { supplierProductIds, companyProductSupplierIds, supplierProductByLine } = await this.ensureConfirmedOffers(
      plan,
      preflight.preflightDigest,
      identities,
      linksByLine,
      transaction,
    );
    const desiredLineIds = await this.ensureOrderLines(
      plan,
      preflight.preflightDigest,
      orderIds,
      linksByLine,
      supplierProductByLine,
      transaction,
    );
    await this.relinkComments(commentRelink.comments, transaction);

    if (preflight.importMode === 'canonical-rebuild') {
      const replacedOrderIds = new Set(
        existingOrders
          .filter(canonicalOrderOwned)
          .map((order) => text(order.id))
          .filter(Boolean) as string[],
      );
      await this.deleteExcept(
        ECOBASE_COLLECTIONS.silverOrderLines,
        desiredLineIds,
        transaction,
        (line) => canonicalOrderLineOwned(line) || replacedOrderIds.has(text(line.orderId) ?? ''),
      );
      await this.deleteExcept(
        ECOBASE_COLLECTIONS.silverOrders,
        new Set(orderIds.values()),
        transaction,
        canonicalOrderOwned,
      );
      const desiredCompanyProductSupplierIds = new Set([
        ...companyProductSupplierIds,
        ...retainedCompanyProductSupplierIds,
      ]);
      await this.deleteExcept(
        ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
        desiredCompanyProductSupplierIds,
        transaction,
      );
      const desiredSupplierProductIds = new Set([...supplierProductIds, ...retainedSupplierProductIds]);
      await this.deleteExcept(ECOBASE_COLLECTIONS.silverSupplierProducts, desiredSupplierProductIds, transaction);
      await this.deleteExcept(ECOBASE_COLLECTIONS.silverSupplierAccounts, desiredAccountIds, transaction);
      await this.deleteExcept(
        ECOBASE_COLLECTIONS.silverSupplierExternalRefs,
        new Set([...identities.values()].map((identity) => identity.externalRefId)),
        transaction,
      );
      const desiredSupplierIds = new Set([
        ...[...identities.values()].map((identity) => identity.supplierId),
        ...retainedSupplierIds,
      ]);
      await this.assertNoStaleSupplierComments(desiredSupplierIds, transaction);
      await this.deleteExcept(ECOBASE_COLLECTIONS.silverSuppliers, desiredSupplierIds, transaction);

      await this.assertCount(ECOBASE_COLLECTIONS.silverSuppliers, desiredSupplierIds.size, transaction);
      await this.assertCount(ECOBASE_COLLECTIONS.silverSupplierExternalRefs, plan.suppliers.length, transaction);
      await this.assertCount(ECOBASE_COLLECTIONS.silverSupplierAccounts, plan.supplierAccounts.length, transaction);
      await this.assertCount(ECOBASE_COLLECTIONS.silverOrders, plan.orders.length, transaction, canonicalOrderOwned);
      await this.assertCount(
        ECOBASE_COLLECTIONS.silverOrderLines,
        plan.orderLines.length,
        transaction,
        canonicalOrderLineOwned,
      );
      await this.assertCount(ECOBASE_COLLECTIONS.silverSupplierProducts, desiredSupplierProductIds.size, transaction);
      await this.assertCount(
        ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
        desiredCompanyProductSupplierIds.size,
        transaction,
      );
    }

    const protectedAfter = await this.protectedFingerprints(transaction);
    const changedProtectedCollections = PROTECTED_FINGERPRINT_KEYS.filter(
      (collection) => protectedAfter[collection] !== protectedBefore[collection],
    );
    if (changedProtectedCollections.length) {
      throw new Error(
        `Ecobase supplier/order apply failed: protected data changed in ${changedProtectedCollections.join(', ')}.`,
      );
    }
    return { commentRelinkDigest: commentRelink.digest, protectedFingerprint: digest(protectedAfter) };
  }

  private async resolveCompanyIds(plan: SupplierOrderImportPlan, transaction?: unknown) {
    const ids = new Map<string, string>();
    for (const companyKey of [
      ...new Set([
        ...plan.orders.map((order) => order.companyKey),
        ...plan.supplierAccounts.map((account) => account.companyKey),
      ]),
    ].sort()) {
      const rows = await this.repo(ECOBASE_COLLECTIONS.silverCompanies).find(
        params({ filter: { companyKey }, limit: 2 }, transaction),
      );
      if (rows.length !== 1) {
        throw new Error(`Ecobase supplier/order apply failed: company ${companyKey} is missing or duplicated.`);
      }
      const id = text(plain(rows[0]).id);
      if (!id) throw new Error(`Ecobase supplier/order apply failed: company ${companyKey} has no ID.`);
      ids.set(companyKey, id);
    }
    return ids;
  }

  private async ensureSupplierIdentities(plan: SupplierOrderImportPlan, transaction?: unknown) {
    const identities = new Map<string, SupplierIdentity>();
    const supplierRepo = this.repo(ECOBASE_COLLECTIONS.silverSuppliers);
    const refRepo = this.repo(ECOBASE_COLLECTIONS.silverSupplierExternalRefs);
    for (const supplier of plan.suppliers) {
      const existingRef = plain(
        await refRepo.findOne(
          params(
            {
              filter: {
                sourceSystem: 'supplier_ids',
                normalizedExternalSupplierCode: supplier.normalizedExternalSupplierCode,
              },
            },
            transaction,
          ),
        ),
      );
      const supplierId = text(existingRef.supplierId) ?? stableUuid(`supplier_ids:${supplier.externalSupplierCode}`);
      const existingSupplier = plain(await supplierRepo.findOne(params({ filterByTk: supplierId }, transaction)));
      await this.upsert(
        ECOBASE_COLLECTIONS.silverSuppliers,
        existingSupplier,
        compact({
          id: supplierId,
          normalizedName: supplier.normalizedName,
          displayName: supplier.displayName,
          approvalStatus:
            supplier.analysisProgress?.toLowerCase() === 'approved'
              ? 'approved'
              : supplier.analysisProgress?.toLowerCase() === 'rejected'
                ? 'rejected'
                : Object.keys(existingSupplier).length
                  ? undefined
                  : 'analyzing',
          analysisStatus: supplier.analysisProgress,
          accountStatus: supplier.activeStatus,
          contactName: supplier.contactName,
          email: supplier.primaryEmail,
          phone: supplier.primaryPhone,
          preferredContactMethod: supplier.primaryEmail ? 'email' : supplier.primaryPhone ? 'phone' : undefined,
          primaryEmail: supplier.primaryEmail,
          additionalEmails: supplier.additionalEmails.length ? supplier.additionalEmails : undefined,
          primaryPhone: supplier.primaryPhone,
          additionalPhones: supplier.additionalPhones.length ? supplier.additionalPhones : undefined,
          contactNotes: supplier.contactNotes,
          supplierUrl: supplier.supplierUrl,
          country: supplier.country,
          market: supplier.market,
          currency: supplier.currency,
          activeStatus: supplier.activeStatus,
          supplierType: supplier.supplierType,
          amazonPresence: supplier.amazonPresence,
          reachedVia: supplier.reachedVia,
          receivedEmail: supplier.receivedEmail,
          designation: supplier.designation,
          category: supplier.category,
          amazonAllowed: supplier.amazonAllowed,
          lastAnalysedBy: supplier.lastAnalysedBy,
          trackingStatus: supplier.trackingStatus,
          dateOfUpdate: supplier.dateOfUpdate,
          analysisProgress: supplier.analysisProgress,
          remarksAnalysed: supplier.remarksAnalysed,
          sourceEvidence: supplier.sourceEvidence,
        }),
        transaction,
      );
      const externalRefId = text(existingRef.id) ?? stableUuid(`supplier_ids:ref:${supplier.externalSupplierCode}`);
      await this.upsert(
        ECOBASE_COLLECTIONS.silverSupplierExternalRefs,
        existingRef,
        {
          id: externalRefId,
          supplierId,
          sourceSystem: 'supplier_ids',
          externalSupplierCode: supplier.externalSupplierCode,
          normalizedExternalSupplierCode: supplier.normalizedExternalSupplierCode,
          displayName: supplier.displayName,
          normalizedName: supplier.normalizedName,
          payload: {},
          sourceEvidence: supplier.sourceEvidence,
        },
        transaction,
      );
      identities.set(supplier.externalSupplierCode, { supplierId, externalRefId });
    }
    return identities;
  }

  private async ensureSupplierAccounts(
    plan: SupplierOrderImportPlan,
    identities: Map<string, SupplierIdentity>,
    companyIds: Map<string, string>,
    transaction?: unknown,
  ) {
    const desired = new Set<string>();
    const repo = this.repo(ECOBASE_COLLECTIONS.silverSupplierAccounts);
    for (const account of plan.supplierAccounts) {
      const supplierId = identities.get(account.externalSupplierCode)?.supplierId;
      const companyId = companyIds.get(account.companyKey);
      if (!supplierId || !companyId) {
        throw new Error(`Ecobase supplier/order apply failed: account ${account.accountName} has unresolved links.`);
      }
      const existing = plain(
        await repo.findOne(params({ filter: { supplierId, accountName: account.accountName } }, transaction)),
      );
      const id = text(existing.id) ?? stableUuid(`supplier-account:${supplierId}:${account.accountName}`);
      await this.upsert(
        ECOBASE_COLLECTIONS.silverSupplierAccounts,
        existing,
        compact({
          id,
          supplierId,
          companyId,
          accountName: account.accountName,
          orderingMethod: account.preferredContactMethod ?? 'email',
          status: 'active',
          accountType: account.accountType,
          market: account.market,
          portalUrl: account.portalUrl,
          username: account.loginUsername,
          loginUsername: account.loginUsername,
          loginSecret: account.loginSecret,
          contactName: account.contactName,
          email: account.email,
          phone: account.phone,
          preferredContactMethod: account.preferredContactMethod,
          metadata: account.metadata,
        }),
        transaction,
      );
      desired.add(id);
    }
    return desired;
  }

  private async ensureOrders(
    plan: SupplierOrderImportPlan,
    preflightDigest: string,
    identities: Map<string, SupplierIdentity>,
    companyIds: Map<string, string>,
    existingOrderByIdentity: Map<string, PlainRecord>,
    transaction?: unknown,
  ) {
    const orderIds = new Map<string, string>();
    const sequences = orderSequences(plan.orders);
    for (const order of plan.orders) {
      const companyId = companyIds.get(order.companyKey);
      const identity = identities.get(order.externalSupplierCode);
      if (!companyId || !identity || !order.orderDate) {
        throw new Error(
          `Ecobase supplier/order apply failed: order ${order.externalOrderId} has unresolved required links.`,
        );
      }
      const key = orderIdentity(companyId, order.externalOrderId);
      const existing = existingOrderByIdentity.get(key) ?? {};
      const id = text(existing.id) ?? stableUuid(`order:${companyId}:${order.externalOrderId}`);
      const preserveClickupStatus =
        existing.statusSource === 'clickup_csv' || Boolean(existing.operatorStatusOverrideAt);
      const preserveDownstreamAuthority =
        Boolean(text(existing.authoritySource)) && existing.authoritySource !== 'supplier_order_import';
      await this.upsert(
        ECOBASE_COLLECTIONS.silverOrders,
        existing,
        compact({
          id,
          companyId,
          supplierId: identity.supplierId,
          supplierExternalRefId: identity.externalRefId,
          orderRef: order.externalOrderId,
          externalOrderId: order.externalOrderId,
          recordType: order.recordType,
          purchaseEvidenceStatus: order.purchaseEvidenceStatus,
          sourceMarketplace: order.sourceMarketplace,
          orderDate: order.orderDate,
          dailySequenceLetter: sequences.get(`${order.companyKey}:${order.externalOrderId}`),
          orderIntent: 'source_import',
          lifecyclePhase: order.workflowStage,
          sourceOrderStatus: order.sourceOrderStatus,
          orderApproval: order.orderApproval,
          paymentStatus: order.paymentStatus,
          paymentMode: order.paymentMode,
          paymentDate: order.paymentDate,
          placedBy: order.placedBy,
          invoiceStatus: order.invoiceStatus,
          prepStatus: order.prepStatus,
          ...(preserveClickupStatus
            ? {}
            : {
                lifecycleStatus: lifecycleStatusForOperationalStatus(order.operationalStatus),
                canonicalStatus: order.canonicalStatus,
                operationalStatus: order.operationalStatus,
                workflowStage: order.workflowStage,
                // T-3.0 (inventory dashboard): stamp stage entry on transition.
                ...((text(existing.workflowStage) ?? null) === (order.workflowStage ?? null)
                  ? {}
                  : { workflowStageEnteredAt: new Date().toISOString() }),
                statusSource: 'supplier_order_import',
                statusEvidenceJson: { preflightDigest, sourceOrderStatus: order.sourceOrderStatus },
              }),
          ...(preserveDownstreamAuthority
            ? {}
            : {
                authorityStatus: 'historical_import',
                authoritySource: 'supplier_order_import',
                authorityEvidenceJson: { preflightDigest },
              }),
          expectedDeliveryDate: order.expectedDeliveryDate,
          expectedCost: order.expectedCost,
          actualCost: order.actualCost,
          shippingCarrier: order.shippingCarrier,
          trackingId: order.trackingId,
          attachmentReference: order.invoiceReference,
          remarks: order.remarks,
          lastImportRunId: stableUuid(`supplier-order-import:${preflightDigest}`),
          sourceEvidence: { preflightDigest, sourcePlanDigest: plan.digest, ...order.sourceEvidence },
        }),
        transaction,
      );
      orderIds.set(`${order.companyKey}:${order.externalOrderId}`, id);
    }
    return orderIds;
  }

  private async resolveLineLinks(
    plan: SupplierOrderImportPlan,
    companyIds: Map<string, string>,
    transaction?: unknown,
  ) {
    const links = new Map<string, LineLinks>();
    const familyCache = new Map<string, PlainRecord>();
    const memberCache = new Map<string, PlainRecord>();
    for (const line of plan.orderLines) {
      if (line.mappingScope === 'unresolved') {
        links.set(line.sourceLineKey, {
          companyProductFamilyId: null,
          companyProductId: null,
          productId: null,
        });
        continue;
      }
      const companyId = companyIds.get(line.companyKey);
      const familyId = text(line.companyProductFamilyId);
      if (!companyId || !familyId) {
        throw new Error(`Ecobase supplier/order apply failed: line ${line.sourceLineKey} has no canonical family.`);
      }
      let family = familyCache.get(familyId);
      if (!family) {
        family = plain(
          await this.repo(ECOBASE_COLLECTIONS.silverCompanyProductFamilies).findOne(
            params({ filterByTk: familyId }, transaction),
          ),
        );
        familyCache.set(familyId, family);
      }
      if (text(family.id) !== familyId || text(family.companyId) !== companyId) {
        throw new Error(`Ecobase supplier/order apply failed: family link changed for line ${line.sourceLineKey}.`);
      }
      if (line.mappingScope === 'family_only') {
        links.set(line.sourceLineKey, {
          companyProductFamilyId: familyId,
          companyProductId: null,
          productId: null,
        });
        continue;
      }
      const memberId = text(line.companyProductId);
      if (!memberId) {
        throw new Error(`Ecobase supplier/order apply failed: exact line ${line.sourceLineKey} has no member.`);
      }
      let member = memberCache.get(memberId);
      if (!member) {
        member = plain(
          await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).findOne(
            params({ filterByTk: memberId }, transaction),
          ),
        );
        memberCache.set(memberId, member);
      }
      const productId = text(member.productId);
      if (
        text(member.id) !== memberId ||
        text(member.companyId) !== companyId ||
        text(member.companyProductFamilyId) !== familyId ||
        !productId
      ) {
        throw new Error(`Ecobase supplier/order apply failed: member link changed for line ${line.sourceLineKey}.`);
      }
      links.set(line.sourceLineKey, {
        companyProductFamilyId: familyId,
        companyProductId: memberId,
        productId,
      });
    }
    return links;
  }

  private async ensureConfirmedOffers(
    plan: SupplierOrderImportPlan,
    preflightDigest: string,
    identities: Map<string, SupplierIdentity>,
    linksByLine: Map<string, LineLinks>,
    transaction?: unknown,
  ) {
    const orderByKey = new Map(plan.orders.map((order) => [`${order.companyKey}:${order.externalOrderId}`, order]));
    const candidates = new Map<string, OfferCandidate[]>();
    for (const line of plan.orderLines) {
      const order = orderByKey.get(`${line.companyKey}:${line.externalOrderId}`);
      const links = linksByLine.get(line.sourceLineKey);
      const supplierId = identities.get(line.externalSupplierCode)?.supplierId;
      if (
        order?.purchaseEvidenceStatus !== 'confirmed' ||
        line.mappingScope !== 'exact_member' ||
        !links?.productId ||
        !links.companyProductId ||
        !supplierId
      ) {
        continue;
      }
      const key = `${supplierId}:${links.productId}`;
      candidates.set(key, [
        ...(candidates.get(key) ?? []),
        {
          line,
          order,
          supplierId,
          productId: links.productId,
          companyProductId: links.companyProductId,
        },
      ]);
    }

    const supplierProductIds = new Set<string>();
    const companyProductSupplierIds = new Set<string>();
    const supplierProductByLine = new Map<string, string>();
    for (const group of candidates.values()) {
      const selected = [...group].sort(
        (left, right) =>
          compareText(String(right.order.orderDate), String(left.order.orderDate)) ||
          compareText(right.line.sourceLineKey, left.line.sourceLineKey),
      )[0];
      const tracker = plan.supplierProducts.find(
        (candidate) =>
          candidate.externalSupplierCode === selected.line.externalSupplierCode &&
          candidate.asin === selected.line.asin,
      );
      const supplierProductId = await this.ensureSupplierProduct(selected, tracker, preflightDigest, transaction);
      supplierProductIds.add(supplierProductId);
      for (const candidate of group) supplierProductByLine.set(candidate.line.sourceLineKey, supplierProductId);
      for (const companyProductId of [...new Set(group.map((candidate) => candidate.companyProductId))]) {
        companyProductSupplierIds.add(
          await this.ensureCompanyProductSupplier(
            companyProductId,
            supplierProductId,
            selected.line,
            preflightDigest,
            transaction,
          ),
        );
      }
    }
    return { supplierProductIds, companyProductSupplierIds, supplierProductByLine };
  }

  private async ensureSupplierProduct(
    candidate: OfferCandidate,
    tracker: SupplierProductImportPlanRow | undefined,
    preflightDigest: string,
    transaction?: unknown,
  ) {
    const repo = this.repo(ECOBASE_COLLECTIONS.silverSupplierProducts);
    const existing = plain(
      await repo.findOne(
        params({ filter: { supplierId: candidate.supplierId, productId: candidate.productId } }, transaction),
      ),
    );
    const id = text(existing.id) ?? stableUuid(`supplier-product:${candidate.supplierId}:${candidate.productId}`);
    await this.upsert(
      ECOBASE_COLLECTIONS.silverSupplierProducts,
      existing,
      compact({
        id,
        supplierId: candidate.supplierId,
        productId: candidate.productId,
        supplierSku: candidate.line.supplierSku ?? tracker?.supplierSku,
        unitCost: candidate.line.unitCost ?? tracker?.unitCost,
        moq: tracker?.moq,
        supplierPackSize: candidate.line.supplierPackSize ?? tracker?.supplierPackSize,
        leadTimeDays: candidate.line.leadTimeDays,
        analysisStatus: 'source_imported',
        lastPriceUpdateDate: tracker?.lastPriceUpdateDate,
        mapPrice: candidate.line.mapPrice ?? tracker?.mapPrice,
        sourceEvidence: {
          preflightDigest,
          externalSupplierCode: candidate.line.externalSupplierCode,
          tracker: tracker?.sourceEvidence,
          orderLine: candidate.line.sourceEvidence,
        },
      }),
      transaction,
    );
    return id;
  }

  private async ensureCompanyProductSupplier(
    companyProductId: string,
    supplierProductId: string,
    line: OrderLineImportPlanRow,
    preflightDigest: string,
    transaction?: unknown,
  ) {
    const repo = this.repo(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers);
    const role = 'historical_purchase';
    const existing = plain(
      await repo.findOne(params({ filter: { companyProductId, supplierProductId, role } }, transaction)),
    );
    const id =
      text(existing.id) ?? stableUuid(`company-product-supplier:${companyProductId}:${supplierProductId}:${role}`);
    await this.upsert(
      ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
      existing,
      {
        id,
        companyProductId,
        supplierProductId,
        role,
        sourceEvidence: { preflightDigest, orderLine: line.sourceEvidence },
      },
      transaction,
    );
    return id;
  }

  private async ensureOrderLines(
    plan: SupplierOrderImportPlan,
    preflightDigest: string,
    orderIds: Map<string, string>,
    linksByLine: Map<string, LineLinks>,
    supplierProductByLine: Map<string, string>,
    transaction?: unknown,
  ) {
    const desired = new Set<string>();
    const repo = this.repo(ECOBASE_COLLECTIONS.silverOrderLines);
    const orderByKey = new Map(plan.orders.map((order) => [`${order.companyKey}:${order.externalOrderId}`, order]));
    for (const line of plan.orderLines) {
      const key = `${line.companyKey}:${line.externalOrderId}`;
      const order = orderByKey.get(key);
      const orderId = orderIds.get(key);
      const links = linksByLine.get(line.sourceLineKey);
      if (!order || !orderId || !links || !line.mappingScope || !line.sourceSkuType) {
        throw new Error(`Ecobase supplier/order apply failed: line ${line.sourceLineKey} has unresolved apply data.`);
      }
      const existing = plain(
        await repo.findOne(params({ filter: { orderId, sourceLineKey: line.sourceLineKey } }, transaction)),
      );
      const id = text(existing.id) ?? stableUuid(`order-line:${orderId}:${line.sourceLineKey}`);
      await this.upsert(
        ECOBASE_COLLECTIONS.silverOrderLines,
        existing,
        compact({
          id,
          orderId,
          companyProductFamilyId: links.companyProductFamilyId,
          companyProductId: links.companyProductId,
          supplierProductId: supplierProductByLine.get(line.sourceLineKey) ?? null,
          sourceLineKey: line.sourceLineKey,
          externalOrderId: line.externalOrderId,
          lineOrdinal: line.lineOrdinal,
          sourceAsin: line.asin,
          sourceSupplierSku: line.supplierSku,
          sourceMarketplace: line.sourceMarketplace,
          sourceSkuType: line.sourceSkuType,
          mappingScope: line.mappingScope,
          purchaseEvidenceStatus: order.purchaseEvidenceStatus,
          sourceRowNumber: line.sourceEvidence.row,
          sourceRowHash: line.sourceEvidence.hash,
          lastImportRunId: stableUuid(`supplier-order-import:${preflightDigest}`),
          productMappingStatus: line.mappingScope,
          productMappingEvidenceJson: {
            preflightDigest,
            companyProductFamilyId: links.companyProductFamilyId,
            companyProductId: links.companyProductId,
            mappingScope: line.mappingScope,
            mappingReason: line.mappingReason,
            familyResolution: line.familyResolution,
          },
          orderedQty: line.orderQty,
          unitCost: line.unitCost,
          expectedCost: line.expectedCost,
          actualCost: line.actualCost,
          orderQty: line.orderQty,
          orderType: line.orderType,
          operationalStatus: line.operationalStatus,
          poStatus: line.poStatus,
          supplierPackSize: line.supplierPackSize,
          expectedDeliveryDate: order.expectedDeliveryDate,
          expectedSellPrice: line.expectedSellPrice,
          expectedMargin: line.expectedMargin,
          expectedProfit: line.expectedProfit,
          amazonCheckStatus: line.amazonCheckStatus,
          shipmentFlag: line.shipmentFlag,
          priority: line.priority,
          upc: line.upc,
          mapPrice: line.mapPrice,
          productAnalysisStatus: 'source_imported',
          sourceEvidence: { preflightDigest, sourcePlanDigest: plan.digest, ...line.sourceEvidence },
        }),
        transaction,
      );
      desired.add(id);
    }
    return desired;
  }

  private async commentRelinkPlan(
    existingOrders: PlainRecord[],
    targetOrders: Array<{ id: string; companyId: string; orderRef: string }>,
    importMode: SupplierOrderImportPreflight['importMode'],
    transaction?: unknown,
  ) {
    const orderById = new Map(existingOrders.map((order) => [text(order.id), order]));
    const targetByIdentity = new Map(
      targetOrders.map((order) => [`${order.companyId}:${normalizeExternalOrderId(order.orderRef)}`, order]),
    );
    const relinkOrderIds = new Set(
      existingOrders.flatMap((order) => {
        const id = text(order.id);
        const companyId = text(order.companyId);
        const orderRef = normalizeExternalOrderId(text(order.orderRef) ?? '');
        if (!id || !companyId || !orderRef) return [];
        const target = targetByIdentity.get(`${companyId}:${orderRef}`);
        return target?.id !== id &&
          (Boolean(target) || (importMode === 'canonical-rebuild' && canonicalOrderOwned(order)))
          ? [id]
          : [];
      }),
    );
    const comments = await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).find(
      params({ filter: { entityType: 'supplier_order' }, limit: 100000 }, transaction),
    );
    const exported: ExportedSupplierOrderComment[] = comments.flatMap((value) => {
      const comment = plain(value);
      const orderId = text(comment.entityId);
      if (!orderId || !relinkOrderIds.has(orderId)) return [];
      const order = orderById.get(orderId);
      const companyId = text(order?.companyId);
      const orderRef = text(order?.orderRef);
      if (!companyId || !orderRef || !text(comment.id)) {
        throw new Error('Ecobase supplier/order apply failed: an operator comment has no canonical source order.');
      }
      return [
        {
          companyId,
          orderId,
          orderRef,
          comment: comment as ExportedSupplierOrderComment['comment'],
        },
      ];
    });
    return prepareSupplierOrderCommentRelink(exported, targetOrders);
  }

  private async relinkComments(comments: PlainRecord[], transaction?: unknown) {
    const repo = this.repo(ECOBASE_COLLECTIONS.silverActivityComments);
    for (const comment of comments) {
      const id = text(comment.id);
      if (!id) throw new Error('Ecobase supplier/order apply failed: relinked comment has no ID.');
      const existing = plain(await repo.findOne(params({ filterByTk: id }, transaction)));
      await this.upsert(
        ECOBASE_COLLECTIONS.silverActivityComments,
        existing,
        { id, entityId: comment.entityId, entityType: 'supplier_order' },
        transaction,
      );
    }
  }

  private async assertNoStaleSupplierComments(desiredSupplierIds: Set<string>, transaction?: unknown) {
    const comments = await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).find(
      params({ filter: { entityType: 'supplier' }, limit: 100000 }, transaction),
    );
    const stale = comments.map(plain).find((comment) => {
      const entityId = text(comment.entityId);
      return entityId && !desiredSupplierIds.has(entityId);
    });
    if (stale) {
      throw new Error(
        `Ecobase supplier/order apply failed: supplier comment ${text(stale.id) ?? 'unknown'} would lose its target.`,
      );
    }
  }

  private async protectedFingerprints(transaction?: unknown) {
    const fingerprints: Record<string, string> = {};
    for (const collection of PROTECTED_COLLECTIONS) {
      const rows = (await this.all(collection, transaction))
        .map((row) => protectedRow(collection, row))
        .sort((left, right) => compareText(canonical(left), canonical(right)));
      fingerprints[collection] = digest(rows);
    }
    const publishedGold = await new EcobaseInventoryPlanningGoldAccess(this.db).readPublishedListingPerformance({
      transaction,
      limit: 100000,
    });
    fingerprints[ECOBASE_COLLECTIONS.goldInventoryPlanningRows] = digest({
      runId: publishedGold.run?.id ?? null,
      rows: publishedGold.rows
        .map((row) => protectedRow(ECOBASE_COLLECTIONS.goldInventoryPlanningRows, row))
        .sort((left, right) => compareText(canonical(left), canonical(right))),
    });
    return fingerprints;
  }

  private async assertCount(
    collection: string,
    expected: number,
    transaction?: unknown,
    predicate: (row: PlainRecord) => boolean = () => true,
  ) {
    const actual = (await this.all(collection, transaction)).filter(predicate).length;
    if (actual !== expected) {
      throw new Error(`Ecobase supplier/order apply failed: ${collection} has ${actual} rows; expected ${expected}.`);
    }
  }

  private async deleteExcept(
    collection: string,
    desiredIds: Set<string>,
    transaction?: unknown,
    predicate: (row: PlainRecord) => boolean = () => true,
  ) {
    const repo = this.repo(collection);
    for (const row of await this.all(collection, transaction)) {
      const id = text(row.id);
      if (!id || desiredIds.has(id) || !predicate(row)) continue;
      if (!repo.destroy)
        throw new Error(`Ecobase supplier/order apply failed: ${collection} cannot delete stale row ${id}.`);
      await repo.destroy(params({ filterByTk: id }, transaction));
      this.increment(collection, 'deleted');
    }
  }

  private async all(collection: string, transaction?: unknown) {
    return (await this.repo(collection).find(params({ limit: 100000 }, transaction))).map(plain);
  }

  private async upsert(
    collection: string,
    existingValue: PlainRecord,
    desiredValue: PlainRecord,
    transaction?: unknown,
  ) {
    const existing = plain(existingValue);
    const desired = compact(desiredValue);
    const id = text(existing.id);
    if (!id) {
      await this.repo(collection).create(params({ values: desired }, transaction));
      this.increment(collection, 'created');
      return;
    }
    if (sameValues(existing, desired)) {
      this.increment(collection, 'unchanged');
      return;
    }
    for (const [key, value] of Object.entries(desired)) {
      if (sameValue(existing[key], value)) continue;
      const field = `${collection}.${key}`;
      this.updatedFields[field] = (this.updatedFields[field] ?? 0) + 1;
    }
    await this.repo(collection).update(params({ filterByTk: id, values: desired }, transaction));
    this.increment(collection, 'updated');
  }

  private increment(collection: string, kind: WriteKind) {
    const count = this.writes[collection] ?? { created: 0, updated: 0, deleted: 0, unchanged: 0 };
    count[kind] += 1;
    this.writes[collection] = count;
  }

  private repo(collection: string): MutableRepository {
    return this.db.getRepository(collection) as MutableRepository;
  }
}
