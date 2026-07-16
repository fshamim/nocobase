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
  updatedFields: Record<string, number>;
  byCollection: Record<string, CollectionWrites>;
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
  ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
] as const;

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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.entries(plain(value))
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
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

function protectedRow(collection: string, row: PlainRecord) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...businessFields } = row;
  if (collection !== ECOBASE_COLLECTIONS.silverCompanyProductFamilies) return businessFields;
  const {
    preferredSupplierId: _preferredSupplierId,
    preferredSupplierProductId: _preferredSupplierProductId,
    supplierSelectionSource: _supplierSelectionSource,
    supplierSelectedAt: _supplierSelectedAt,
    supplierSelectedByUserId: _supplierSelectedByUserId,
    supplierReviewRequired: _supplierReviewRequired,
    supplierSelectionEvidenceJson: _supplierSelectionEvidenceJson,
    ...catalogAndTargetFields
  } = businessFields;
  return catalogAndTargetFields;
}

function sameValue(existing: unknown, desired: unknown) {
  if (typeof desired === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(desired)) {
    const existingDate = existing instanceof Date ? existing.toISOString() : String(existing ?? '');
    return existingDate.slice(0, 10) === desired;
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
      preflightDigest: preflight.preflightDigest,
      sourcePlanDigest: preflight.sourcePlanDigest,
      commentRelinkDigest: transactionResult.commentRelinkDigest,
      protectedFingerprint: transactionResult.protectedFingerprint,
      noOp: totalWrites === 0,
      totalWrites,
      ...totals,
      mappingExceptions: preflight.mappingExceptions.length,
      updatedFields: this.updatedFields,
      byCollection: this.writes,
    };
  }

  private async applyInTransaction(preflight: SupplierOrderImportPreflight, transaction?: unknown) {
    const plan = preflight.plan;
    const protectedBefore = await this.protectedFingerprints(transaction);
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
    const commentRelink = await this.commentRelinkPlan(existingOrders, targetOrders, transaction);
    if (!commentRelink.ready) {
      const reasons = Object.entries(
        commentRelink.blockers.reduce<Record<string, number>>((counts, blocker) => {
          counts[blocker.reason] = (counts[blocker.reason] ?? 0) + 1;
          return counts;
        }, {}),
      )
        .sort(([left], [right]) => left.localeCompare(right))
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
    await this.clearFamilySupplierSelections(transaction);
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

    await this.deleteExcept(ECOBASE_COLLECTIONS.silverOrderLines, desiredLineIds, transaction);
    await this.deleteExcept(ECOBASE_COLLECTIONS.silverOrders, new Set(orderIds.values()), transaction);
    await this.deleteExcept(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, companyProductSupplierIds, transaction);
    await this.deleteExcept(ECOBASE_COLLECTIONS.silverSupplierProducts, supplierProductIds, transaction);
    await this.deleteExcept(ECOBASE_COLLECTIONS.silverSupplierAccounts, desiredAccountIds, transaction);
    await this.deleteExcept(
      ECOBASE_COLLECTIONS.silverSupplierExternalRefs,
      new Set([...identities.values()].map((identity) => identity.externalRefId)),
      transaction,
    );
    await this.assertNoStaleSupplierComments(
      new Set([...identities.values()].map((identity) => identity.supplierId)),
      transaction,
    );
    await this.deleteExcept(
      ECOBASE_COLLECTIONS.silverSuppliers,
      new Set([...identities.values()].map((identity) => identity.supplierId)),
      transaction,
    );

    await this.assertCount(ECOBASE_COLLECTIONS.silverSuppliers, plan.suppliers.length, transaction);
    await this.assertCount(ECOBASE_COLLECTIONS.silverSupplierExternalRefs, plan.suppliers.length, transaction);
    await this.assertCount(ECOBASE_COLLECTIONS.silverSupplierAccounts, plan.supplierAccounts.length, transaction);
    await this.assertCount(ECOBASE_COLLECTIONS.silverOrders, plan.orders.length, transaction);
    await this.assertCount(ECOBASE_COLLECTIONS.silverOrderLines, plan.orderLines.length, transaction);
    await this.assertCount(ECOBASE_COLLECTIONS.silverSupplierProducts, supplierProductIds.size, transaction);
    await this.assertCount(
      ECOBASE_COLLECTIONS.silverCompanyProductSuppliers,
      companyProductSupplierIds.size,
      transaction,
    );

    const protectedAfter = await this.protectedFingerprints(transaction);
    const changedProtectedCollections = PROTECTED_COLLECTIONS.filter(
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
    for (const companyKey of [...new Set(plan.orders.map((order) => order.companyKey))].sort()) {
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
          approvalStatus: supplier.analysisProgress?.toLowerCase() === 'approved' ? 'approved' : 'analyzing',
          analysisStatus: supplier.analysisProgress,
          accountStatus: supplier.activeStatus,
          contactName: supplier.contactName,
          email: supplier.primaryEmail,
          phone: supplier.primaryPhone,
          preferredContactMethod: supplier.primaryEmail ? 'email' : supplier.primaryPhone ? 'phone' : undefined,
          primaryEmail: supplier.primaryEmail,
          additionalEmails: supplier.additionalEmails,
          primaryPhone: supplier.primaryPhone,
          additionalPhones: supplier.additionalPhones,
          contactNotes: supplier.contactNotes,
          country: supplier.country,
          market: supplier.market,
          currency: supplier.currency,
          activeStatus: supplier.activeStatus,
          supplierType: supplier.supplierType,
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
          lifecycleStatus: lifecycleStatusForOperationalStatus(order.operationalStatus),
          canonicalStatus: order.canonicalStatus,
          sourceOrderStatus: order.sourceOrderStatus,
          operationalStatus: order.operationalStatus,
          workflowStage: order.workflowStage,
          orderApproval: order.orderApproval,
          paymentStatus: order.paymentStatus,
          invoiceStatus: order.invoiceStatus,
          prepStatus: order.prepStatus,
          statusSource: 'supplier_order_import',
          statusCheckRequired: order.retentionDisposition === 'review',
          statusEvidenceJson: { preflightDigest, sourceOrderStatus: order.sourceOrderStatus },
          authorityStatus: 'historical_import',
          authoritySource: 'supplier_order_import',
          authorityEvidenceJson: { preflightDigest },
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

  private async clearFamilySupplierSelections(transaction?: unknown) {
    for (const family of await this.all(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, transaction)) {
      await this.upsert(
        ECOBASE_COLLECTIONS.silverCompanyProductFamilies,
        family,
        {
          id: family.id,
          preferredSupplierId: null,
          preferredSupplierProductId: null,
          supplierSelectionSource: null,
          supplierSelectedAt: null,
          supplierSelectedByUserId: null,
          supplierReviewRequired: false,
          supplierSelectionEvidenceJson: {},
        },
        transaction,
      );
    }
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
          String(right.order.orderDate).localeCompare(String(left.order.orderDate)) ||
          right.line.sourceLineKey.localeCompare(left.line.sourceLineKey),
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
    transaction?: unknown,
  ) {
    const orderById = new Map(existingOrders.map((order) => [text(order.id), order]));
    const comments = await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).find(
      params({ filter: { entityType: 'supplier_order' }, limit: 100000 }, transaction),
    );
    const exported: ExportedSupplierOrderComment[] = comments.map((value) => {
      const comment = plain(value);
      const orderId = text(comment.entityId);
      const order = orderId ? orderById.get(orderId) : undefined;
      const companyId = text(order?.companyId);
      const orderRef = text(order?.orderRef);
      if (!orderId || !companyId || !orderRef || !text(comment.id)) {
        throw new Error('Ecobase supplier/order apply failed: an operator comment has no canonical source order.');
      }
      return {
        companyId,
        orderId,
        orderRef,
        comment: comment as ExportedSupplierOrderComment['comment'],
      };
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
        .sort((left, right) => canonical(left).localeCompare(canonical(right)));
      fingerprints[collection] = digest(rows);
    }
    return fingerprints;
  }

  private async assertCount(collection: string, expected: number, transaction?: unknown) {
    const actual = (await this.all(collection, transaction)).length;
    if (actual !== expected) {
      throw new Error(`Ecobase supplier/order apply failed: ${collection} has ${actual} rows; expected ${expected}.`);
    }
  }

  private async deleteExcept(collection: string, desiredIds: Set<string>, transaction?: unknown) {
    const repo = this.repo(collection);
    for (const row of await this.all(collection, transaction)) {
      const id = text(row.id);
      if (!id || desiredIds.has(id)) continue;
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
