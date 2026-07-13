/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { EcobaseCompanyProductFamilyService } from '../../inventory-planning/server/company-product-family-service';
import { normalizeSupplierName } from '../../semantic-model/server/medallion-identity-service';
import { orderLineSourceKeyForBronze } from '../../semantic-model/server/medallion-normalization-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import { EcobaseSupplierIdentityConvergenceService } from './supplier-identity-convergence-service';

type PlainRecord = Record<string, unknown>;
type RepairItem =
  | {
      step: 'supplier_convergence';
      key: string;
      normalizedName: string;
      canonicalSupplierId: string;
      duplicateSupplierIds: string[];
    }
  | {
      step: 'gold_reference_cleanup';
      key: string;
      goldRowId: string;
      clearSupplierId: boolean;
      clearSupplierProductId: boolean;
      observedSupplierId?: string;
      observedSupplierProductId?: string;
    }
  | {
      step: 'order_line_replay';
      key: string;
      lineId: string;
      orderId: string;
      sourceLineKey: string;
      bronzeRecordId: string;
      bronzeRowHash?: string;
      companyProductId: string;
      orderCompanyId: string;
      orderSupplierId: string;
      sourceSku?: string;
    }
  | {
      step: 'tracker_replay';
      key: string;
      bronzeRecordId: string;
      bronzeRowHash?: string;
      companyId: string;
      companyProductId: string;
      supplierId: string;
      sourceSku?: string;
    };

type RepairExclusion = {
  category: string;
  sourceId: string;
  reason: string;
  evidence?: PlainRecord;
};

type RepairPlan = {
  items: RepairItem[];
  exclusions: RepairExclusion[];
  reasonCounts: Record<string, number>;
  supplierReview: PlainRecord[];
};

type RepairRunSummary = {
  plan: RepairPlan;
  previewedAt: string;
};

type MutableRepository = EcobaseRepository & {
  destroy?(params: Record<string, unknown>): Promise<unknown>;
};

class RepairPreconditionError extends Error {}

function plain(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object') return {};
  const record = value as PlainRecord & { toJSON?: () => PlainRecord };
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function text(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function payloadText(payload: PlainRecord, ...keys: string[]) {
  for (const key of keys) {
    const direct = text(payload[key]);
    if (direct) return direct;
    const match = Object.entries(payload).find(([candidate]) => candidate.trim().toLowerCase() === key.toLowerCase());
    const matched = text(match?.[1]);
    if (matched) return matched;
  }
  return undefined;
}

function lineIdentity(sourceLineKey: string) {
  const [orderRef, asin, ...skuParts] = sourceLineKey.split(':');
  const sku = skuParts.join(':').trim();
  return { orderRef: text(orderRef), asin: text(asin)?.toUpperCase(), sku: text(sku) };
}

function stableDigest(plan: RepairPlan) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        items: [...plan.items].sort((left, right) => left.key.localeCompare(right.key)),
        exclusions: [...plan.exclusions].sort((left, right) =>
          `${left.category}:${left.sourceId}:${left.reason}`.localeCompare(
            `${right.category}:${right.sourceId}:${right.reason}`,
          ),
        ),
      }),
    )
    .digest('hex');
}

export class EcobaseSupplierResolutionRepairService {
  constructor(private db: EcobaseDatabase) {}

  async preview(params: { repairVersion: string; codeSha: string; actorUserId?: string }) {
    const repairVersion = text(params.repairVersion);
    const codeSha = text(params.codeSha);
    if (!repairVersion || !codeSha) {
      throw new Error('EcoBase supplier repair preview requires repairVersion and codeSha.');
    }

    const plan = await this.buildPlan();
    const decisionDigest = stableDigest(plan);
    const repository = this.repo(ECOBASE_COLLECTIONS.repairRuns);
    const existing = plain(await repository.findOne({ filter: { repairVersion, codeSha, decisionDigest } }));
    if (text(existing.id)) return existing;

    const now = new Date().toISOString();
    return repository.create({
      values: {
        id: randomUUID(),
        repairVersion,
        codeSha,
        decisionDigest,
        actorUserId: text(params.actorUserId),
        status: 'previewed',
        step: plan.items[0]?.step ?? 'complete',
        cursor: 0,
        candidateCount: plan.items.length,
        excludedCount: plan.exclusions.length + plan.supplierReview.length,
        changedCount: 0,
        startedAt: now,
        checkpointJson: { cursor: 0, decisionDigest },
        summary: { plan, previewedAt: now } satisfies RepairRunSummary,
      },
    });
  }

  async apply(params: {
    runId: string;
    decisionDigest: string;
    codeSha: string;
    batchSize?: number;
    failAfterItemKey?: string;
  }) {
    const runId = text(params.runId);
    const expectedDigest = text(params.decisionDigest);
    const expectedCodeSha = text(params.codeSha);
    const batchSize = Math.min(Math.max(Math.floor(params.batchSize ?? 25), 1), 100);
    if (!runId || !expectedDigest || !expectedCodeSha) {
      throw new Error('EcoBase supplier repair apply requires runId, decisionDigest, and codeSha.');
    }

    for (;;) {
      let attemptedCursor: number | undefined;
      try {
        const completed = await this.transaction(async (transaction) => {
          const current = plain(
            await this.repo(ECOBASE_COLLECTIONS.repairRuns).findOne({
              filterByTk: runId,
              transaction,
              lock: true,
            } as never),
          );
          this.assertRun(current, expectedDigest, expectedCodeSha);
          const summary = plain(current.summary) as RepairRunSummary;
          const plan = summary.plan;
          const cursor = number(current.cursor) ?? 0;
          attemptedCursor = cursor;
          if (cursor >= plan.items.length) {
            if (text(current.status) !== 'completed') {
              await this.repo(ECOBASE_COLLECTIONS.repairRuns).update({
                filterByTk: runId,
                values: { status: 'completed', step: 'complete', finishedAt: new Date().toISOString() },
                transaction,
              } as never);
            }
            return true;
          }

          const batch = plan.items.slice(cursor, cursor + batchSize);
          let changed = 0;
          for (const item of batch) {
            changed += await this.applyItem(item, runId, text(current.repairVersion) as string, transaction);
            if (params.failAfterItemKey === item.key) {
              throw new Error(`EcoBase supplier repair injected failure after ${item.key}.`);
            }
          }
          const nextCursor = cursor + batch.length;
          const nextStep = plan.items[nextCursor]?.step ?? 'complete';
          await this.repo(ECOBASE_COLLECTIONS.repairRuns).update({
            filterByTk: runId,
            values: {
              status: nextCursor >= plan.items.length ? 'completed' : 'running',
              step: nextStep,
              cursor: nextCursor,
              changedCount: (number(current.changedCount) ?? 0) + changed,
              finishedAt: nextCursor >= plan.items.length ? new Date().toISOString() : null,
              errorMessage: null,
              checkpointJson: {
                cursor: nextCursor,
                lastItemKey: batch.at(-1)?.key,
                decisionDigest: expectedDigest,
                committedAt: new Date().toISOString(),
              },
            },
            transaction,
          } as never);
          return nextCursor >= plan.items.length;
        });
        if (completed) return this.repo(ECOBASE_COLLECTIONS.repairRuns).findOne({ filterByTk: runId });
      } catch (error) {
        if (error instanceof RepairPreconditionError) throw error;
        await this.recordExecutionFailure({
          runId,
          attemptedCursor,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  private async buildPlan(): Promise<RepairPlan> {
    const supplierPreview = await new EcobaseSupplierIdentityConvergenceService(this.db).preview();
    const canonicalSupplierIdByName = new Map(
      supplierPreview.eligible
        .filter((group) => group.canonicalSupplierId)
        .map((group) => [group.normalizedName, group.canonicalSupplierId as string]),
    );
    const [orderLineSelection, trackerSelection, goldReferenceCleanup] = await Promise.all([
      this.selectOrderLineRepairs(),
      this.selectTrackerRepairs(canonicalSupplierIdByName),
      this.selectGoldReferenceCleanup(),
    ]);
    const items: RepairItem[] = [
      ...supplierPreview.eligible.map(
        (group): RepairItem => ({
          step: 'supplier_convergence',
          key: `supplier:${group.normalizedName}`,
          normalizedName: group.normalizedName,
          canonicalSupplierId: group.canonicalSupplierId as string,
          duplicateSupplierIds: [...group.duplicateSupplierIds].sort(),
        }),
      ),
      ...goldReferenceCleanup,
      ...orderLineSelection.items,
      ...trackerSelection.items,
    ];
    const exclusions = [...orderLineSelection.exclusions, ...trackerSelection.exclusions];
    const reasonCounts: Record<string, number> = {};
    for (const exclusion of exclusions) reasonCounts[exclusion.reason] = (reasonCounts[exclusion.reason] ?? 0) + 1;
    for (const group of supplierPreview.reviewRequired) {
      for (const reason of group.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
    return {
      items,
      exclusions,
      reasonCounts,
      supplierReview: supplierPreview.reviewRequired,
    };
  }

  private async selectGoldReferenceCleanup(): Promise<RepairItem[]> {
    const [goldRows, suppliers, supplierProducts, companyProducts] = await Promise.all([
      this.rows(ECOBASE_COLLECTIONS.goldInventoryPlanningRows),
      this.rows(ECOBASE_COLLECTIONS.silverSuppliers),
      this.rows(ECOBASE_COLLECTIONS.silverSupplierProducts),
      this.rows(ECOBASE_COLLECTIONS.silverCompanyProducts),
    ]);
    const supplierIds = new Set(suppliers.map((row) => text(row.id)).filter(Boolean));
    const supplierProductsById = new Map(supplierProducts.map((row) => [text(row.id), row]));
    const productIdsByFamilyId = new Map<string, Set<string>>();
    for (const companyProduct of companyProducts) {
      const familyId = text(companyProduct.companyProductFamilyId);
      const productId = text(companyProduct.productId);
      if (!familyId || !productId) continue;
      const productIds = productIdsByFamilyId.get(familyId) ?? new Set<string>();
      productIds.add(productId);
      productIdsByFamilyId.set(familyId, productIds);
    }
    const items: RepairItem[] = [];
    for (const row of goldRows) {
      const goldRowId = text(row.id);
      const supplierId = text(row.familyPreferredSupplierId);
      const supplierProductId = text(row.familyPreferredSupplierProductId);
      if (!goldRowId || (!supplierId && !supplierProductId)) continue;
      const supplierValid = Boolean(supplierId && supplierIds.has(supplierId));
      const supplierProduct = supplierProductId ? supplierProductsById.get(supplierProductId) : undefined;
      const supplierProductValid = Boolean(
        supplierProduct &&
          supplierValid &&
          text(supplierProduct.supplierId) === supplierId &&
          productIdsByFamilyId.get(text(row.companyProductFamilyId) ?? '')?.has(text(supplierProduct.productId) ?? ''),
      );
      if (supplierValid && (!supplierProductId || supplierProductValid)) continue;
      items.push({
        step: 'gold_reference_cleanup',
        key: `gold-reference:${goldRowId}`,
        goldRowId,
        clearSupplierId: !supplierValid,
        clearSupplierProductId: !supplierProductValid,
        observedSupplierId: supplierId,
        observedSupplierProductId: supplierProductId,
      });
    }
    return items;
  }

  private async selectOrderLineRepairs() {
    const [lines, orders, companyProducts, bronzeRecords] = await Promise.all([
      this.rows(ECOBASE_COLLECTIONS.silverOrderLines),
      this.rows(ECOBASE_COLLECTIONS.silverOrders),
      this.rows(ECOBASE_COLLECTIONS.silverCompanyProducts),
      this.rows(ECOBASE_COLLECTIONS.bronzeSourceRecords),
    ]);
    const unresolved = lines.filter((line) => !text(line.companyProductId) && !text(line.supplierProductId));
    const ordersById = new Map(orders.map((order) => [text(order.id), order]));
    const companyProductsById = new Map(companyProducts.map((row) => [text(row.id), row]));
    const bronzeByLineKey = new Map<string, PlainRecord[]>();
    for (const bronze of bronzeRecords) {
      if (!text(bronze.sourceDataset)?.toLowerCase().includes('orderdetails')) continue;
      try {
        const key = orderLineSourceKeyForBronze(bronze);
        bronzeByLineKey.set(key, [...(bronzeByLineKey.get(key) ?? []), bronze]);
      } catch {
        // Legacy readable source-line keys predate the hashed key contract.
      }
      const payload = plain(bronze.payload);
      const orderRef = payloadText(payload, 'Order ID', 'Order Ref', 'SR ID');
      const asin = payloadText(payload, 'ASIN')?.toUpperCase();
      const sku = payloadText(payload, 'SKU');
      if (orderRef && asin && sku) {
        const legacyKey = `${orderRef}:${asin}:${sku}`;
        bronzeByLineKey.set(legacyKey, [...(bronzeByLineKey.get(legacyKey) ?? []), bronze]);
      }
    }

    const items: RepairItem[] = [];
    const exclusions: RepairExclusion[] = lines
      .filter((line) => Boolean(text(line.companyProductId)) !== Boolean(text(line.supplierProductId)))
      .map((line) => ({
        category: 'order_line',
        sourceId: text(line.id) ?? 'unknown',
        reason: 'partial_existing_product_authority',
        evidence: {
          companyProductId: text(line.companyProductId),
          supplierProductId: text(line.supplierProductId),
        },
      }));
    const familyService = new EcobaseCompanyProductFamilyService(this.db);
    for (const line of unresolved) {
      const lineId = text(line.id);
      const orderId = text(line.orderId);
      const sourceLineKey = text(line.sourceLineKey);
      if (!lineId || !orderId || !sourceLineKey) continue;
      const order = ordersById.get(orderId) ?? {};
      const companyId = text(order.companyId);
      const supplierId = text(order.supplierId);
      const bronzeCandidates = bronzeByLineKey.get(sourceLineKey) ?? [];
      const sourcePayload = plain(bronzeCandidates[0]?.payload);
      const parsedIdentity = lineIdentity(sourceLineKey);
      const identity = {
        asin: payloadText(sourcePayload, 'ASIN')?.toUpperCase() ?? parsedIdentity.asin,
        sku: payloadText(sourcePayload, 'SKU') ?? parsedIdentity.sku,
      };
      if (!companyId || !supplierId || !identity.asin || bronzeCandidates.length !== 1) {
        exclusions.push({
          category: 'order_line',
          sourceId: lineId,
          reason:
            bronzeCandidates.length !== 1
              ? bronzeCandidates.length === 0
                ? 'bronze_source_not_found'
                : 'bronze_source_not_unique'
              : !companyId
                ? 'order_company_missing'
                : !supplierId
                  ? 'order_supplier_missing'
                  : 'source_identity_missing',
          evidence: { orderId, sourceLineKey, bronzeCandidateCount: bronzeCandidates.length },
        });
        continue;
      }
      const existingCompanyProductId = text(line.companyProductId);
      const resolution = existingCompanyProductId
        ? { companyProductId: existingCompanyProductId, sourceSku: identity.sku }
        : await familyService.resolveCompanyProduct({ companyId, asin: identity.asin, sku: identity.sku });
      const companyProductId = resolution.companyProductId;
      if (!companyProductId || !companyProductsById.get(companyProductId)) {
        exclusions.push({
          category: 'order_line',
          sourceId: lineId,
          reason: resolution.exclusionReason ?? 'company_product_not_found',
          evidence: { orderId, sourceLineKey, resolution },
        });
        continue;
      }
      items.push({
        step: 'order_line_replay',
        key: `order-line:${lineId}`,
        lineId,
        orderId,
        sourceLineKey,
        bronzeRecordId: text(bronzeCandidates[0].id) as string,
        bronzeRowHash: text(bronzeCandidates[0].rowHash),
        companyProductId,
        orderCompanyId: companyId,
        orderSupplierId: supplierId,
        sourceSku: identity.sku,
      });
    }
    return { items, exclusions };
  }

  private async selectTrackerRepairs(canonicalSupplierIdByName: Map<string, string>) {
    const [bronzeRecords, companies, suppliers, companyProducts] = await Promise.all([
      this.rows(ECOBASE_COLLECTIONS.bronzeSourceRecords),
      this.rows(ECOBASE_COLLECTIONS.silverCompanies),
      this.rows(ECOBASE_COLLECTIONS.silverSuppliers),
      this.rows(ECOBASE_COLLECTIONS.silverCompanyProducts),
    ]);
    const companyByName = new Map(companies.map((company) => [text(company.name)?.toLowerCase(), company]));
    const suppliersByName = new Map<string, PlainRecord[]>();
    for (const supplier of suppliers) {
      const name = text(supplier.normalizedName);
      if (name) suppliersByName.set(name, [...(suppliersByName.get(name) ?? []), supplier]);
    }
    const companyProductsById = new Map(companyProducts.map((row) => [text(row.id), row]));
    const familyService = new EcobaseCompanyProductFamilyService(this.db);
    const items: RepairItem[] = [];
    const exclusions: RepairExclusion[] = [];

    for (const bronze of bronzeRecords.filter((row) => text(row.issueCode) === 'supplier_product_unresolved')) {
      const bronzeRecordId = text(bronze.id) as string;
      const payload = plain(bronze.payload);
      const companyName = payloadText(payload, 'Company', 'Reached Via');
      const asin = payloadText(payload, 'ASIN')?.toUpperCase();
      const sku = payloadText(payload, 'SKU');
      const supplierName = payloadText(payload, 'Supplier Name', 'Supplier');
      let normalizedSupplierName: string | undefined;
      try {
        normalizedSupplierName = supplierName ? normalizeSupplierName(supplierName) : undefined;
      } catch {
        normalizedSupplierName = undefined;
      }
      const company = companyName ? companyByName.get(companyName.toLowerCase()) : undefined;
      const supplierMatches = normalizedSupplierName ? suppliersByName.get(normalizedSupplierName) ?? [] : [];
      const plannedCanonicalSupplierId = normalizedSupplierName
        ? canonicalSupplierIdByName.get(normalizedSupplierName)
        : undefined;
      const resolvedSupplierId =
        plannedCanonicalSupplierId ?? (supplierMatches.length === 1 ? text(supplierMatches[0].id) : undefined);
      if (!company || !asin || !resolvedSupplierId) {
        exclusions.push({
          category: 'tracker',
          sourceId: bronzeRecordId,
          reason: !company
            ? 'tracker_company_missing'
            : !asin
              ? 'tracker_asin_missing'
              : supplierMatches.length === 0
                ? 'tracker_supplier_missing'
                : 'tracker_supplier_ambiguous',
          evidence: { companyName, asin, supplierName, supplierCandidateCount: supplierMatches.length },
        });
        continue;
      }
      const resolution = await familyService.resolveCompanyProduct({
        companyId: text(company.id) as string,
        asin,
        sku,
      });
      if (!resolution.companyProductId || !companyProductsById.get(resolution.companyProductId)) {
        exclusions.push({
          category: 'tracker',
          sourceId: bronzeRecordId,
          reason: resolution.exclusionReason ?? 'company_product_not_found',
          evidence: { companyName, asin, supplierName, resolution },
        });
        continue;
      }
      items.push({
        step: 'tracker_replay',
        key: `tracker:${bronzeRecordId}`,
        bronzeRecordId,
        bronzeRowHash: text(bronze.rowHash),
        companyId: text(company.id) as string,
        companyProductId: resolution.companyProductId,
        supplierId: resolvedSupplierId,
        sourceSku: sku,
      });
    }
    return { items, exclusions };
  }

  private async applyItem(item: RepairItem, runId: string, repairVersion: string, transaction?: unknown) {
    if (item.step === 'supplier_convergence') {
      await new EcobaseSupplierIdentityConvergenceService(this.db).converge(item.normalizedName, transaction, {
        canonicalSupplierId: item.canonicalSupplierId,
        duplicateSupplierIds: item.duplicateSupplierIds,
      });
      return 1;
    }
    if (item.step === 'gold_reference_cleanup') {
      const repository = this.repo(ECOBASE_COLLECTIONS.goldInventoryPlanningRows);
      const current = plain(await repository.findOne({ filterByTk: item.goldRowId, transaction, lock: true } as never));
      if (
        text(current.familyPreferredSupplierId) !== item.observedSupplierId ||
        text(current.familyPreferredSupplierProductId) !== item.observedSupplierProductId
      ) {
        throw new Error(`EcoBase supplier repair Gold row ${item.goldRowId} changed after preview.`);
      }
      const values: PlainRecord = {};
      if (item.clearSupplierId) values.familyPreferredSupplierId = null;
      if (item.clearSupplierProductId) values.familyPreferredSupplierProductId = null;
      await repository.update({ filterByTk: item.goldRowId, values, transaction } as never);
      return 1;
    }
    if (item.step === 'order_line_replay') return this.applyOrderLine(item, runId, repairVersion, transaction);
    return this.applyTracker(item, runId, repairVersion, transaction);
  }

  private async applyOrderLine(
    item: Extract<RepairItem, { step: 'order_line_replay' }>,
    runId: string,
    repairVersion: string,
    transaction?: unknown,
  ) {
    const lineRepo = this.repo(ECOBASE_COLLECTIONS.silverOrderLines);
    const matches = (
      await lineRepo.find({
        filter: { orderId: item.orderId, sourceLineKey: item.sourceLineKey },
        limit: 2,
        transaction,
        lock: true,
      } as never)
    ).map(plain);
    if (matches.length !== 1 || text(matches[0].id) !== item.lineId) {
      throw new Error(`EcoBase supplier repair expected one stable Silver line for ${item.sourceLineKey}.`);
    }
    const line = matches[0];
    const order = plain(
      await this.repo(ECOBASE_COLLECTIONS.silverOrders).findOne({
        filterByTk: item.orderId,
        transaction,
        lock: true,
      } as never),
    );
    const supplierId = text(order.supplierId);
    if (text(order.companyId) !== item.orderCompanyId || supplierId !== item.orderSupplierId) {
      throw new Error(`EcoBase supplier repair order ${item.orderId} changed company or supplier authority.`);
    }
    const bronze = plain(
      await this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords).findOne({
        filterByTk: item.bronzeRecordId,
        transaction,
        lock: true,
      } as never),
    );
    if (text(bronze.rowHash) !== item.bronzeRowHash) {
      throw new Error(`EcoBase supplier repair Bronze row ${item.bronzeRecordId} changed after preview.`);
    }
    if (text(line.companyProductId) || text(line.supplierProductId)) {
      const supplierProductId = text(line.supplierProductId);
      const [companyProductValue, supplierProductValue] = await Promise.all([
        this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).findOne({
          filterByTk: item.companyProductId,
          transaction,
          lock: true,
        } as never),
        supplierProductId
          ? this.repo(ECOBASE_COLLECTIONS.silverSupplierProducts).findOne({
              filterByTk: supplierProductId,
              transaction,
              lock: true,
            } as never)
          : Promise.resolve(null),
      ]);
      const companyProduct = plain(companyProductValue);
      const supplierProduct = plain(supplierProductValue);
      if (
        text(line.companyProductId) === item.companyProductId &&
        text(companyProduct.companyId) === item.orderCompanyId &&
        text(supplierProduct.supplierId) === item.orderSupplierId &&
        text(supplierProduct.productId) === text(companyProduct.productId)
      ) {
        return 0;
      }
      throw new Error(`EcoBase supplier repair refused changed line ${item.lineId}.`);
    }
    const supplierProductId = await this.ensureSupplierProduct(
      supplierId,
      item.companyProductId,
      item.sourceSku,
      number(line.unitCost),
      item.orderCompanyId,
      transaction,
    );
    await lineRepo.update({
      filterByTk: item.lineId,
      values: {
        companyProductId: item.companyProductId,
        supplierProductId,
        productAnalysisStatus: 'repair_confirmed',
      },
      transaction,
    } as never);
    await this.appendLineage(item.bronzeRecordId, 'silverOrderLine', item.lineId, runId, repairVersion, transaction);
    return 1;
  }

  private async applyTracker(
    item: Extract<RepairItem, { step: 'tracker_replay' }>,
    runId: string,
    repairVersion: string,
    transaction?: unknown,
  ) {
    const bronzeRepo = this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords);
    const bronze = plain(
      await bronzeRepo.findOne({ filterByTk: item.bronzeRecordId, transaction, lock: true } as never),
    );
    if (!text(bronze.id)) throw new Error(`EcoBase supplier repair tracker row ${item.bronzeRecordId} disappeared.`);
    if (text(bronze.rowHash) !== item.bronzeRowHash) {
      throw new Error(`EcoBase supplier repair tracker row ${item.bronzeRecordId} changed after preview.`);
    }
    if (!text(bronze.issueCode)) return 0;
    if (text(bronze.issueCode) !== 'supplier_product_unresolved') {
      throw new Error(`EcoBase supplier repair tracker row ${item.bronzeRecordId} changed issue authority.`);
    }
    const supplierProductId = await this.ensureSupplierProduct(
      item.supplierId,
      item.companyProductId,
      item.sourceSku,
      undefined,
      item.companyId,
      transaction,
    );
    await bronzeRepo.update({
      filterByTk: item.bronzeRecordId,
      values: { issueCode: null, issueSeverity: null, normalizedError: null, normalizedAt: new Date().toISOString() },
      transaction,
    } as never);
    await this.appendLineage(
      item.bronzeRecordId,
      'silverSupplierProduct',
      supplierProductId,
      runId,
      repairVersion,
      transaction,
    );
    return 1;
  }

  private async ensureSupplierProduct(
    supplierId: string,
    companyProductId: string,
    supplierSku: string | undefined,
    unitCost: number | undefined,
    expectedCompanyId: string,
    transaction?: unknown,
  ) {
    const companyProduct = plain(
      await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).findOne({
        filterByTk: companyProductId,
        transaction,
      } as never),
    );
    const productId = text(companyProduct.productId);
    if (text(companyProduct.companyId) !== expectedCompanyId) {
      throw new Error(`EcoBase supplier repair company product ${companyProductId} changed company authority.`);
    }
    if (!productId) throw new Error(`EcoBase supplier repair company product ${companyProductId} has no product.`);
    const supplier = await this.repo(ECOBASE_COLLECTIONS.silverSuppliers).findOne({
      filterByTk: supplierId,
      transaction,
      lock: true,
    } as never);
    if (!supplier) throw new Error(`EcoBase supplier repair supplier ${supplierId} no longer exists.`);
    const supplierProductRepo = this.repo(ECOBASE_COLLECTIONS.silverSupplierProducts);
    let supplierProduct = plain(
      await supplierProductRepo.findOne({ filter: { supplierId, productId }, transaction } as never),
    );
    if (!text(supplierProduct.id)) {
      supplierProduct = plain(
        await supplierProductRepo.create({
          values: {
            id: randomUUID(),
            supplierId,
            productId,
            supplierSku,
            unitCost,
            analysisStatus: 'repair_confirmed',
          },
          transaction,
        } as never),
      );
    }
    const supplierProductId = text(supplierProduct.id) as string;
    const linkRepo = this.repo(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers);
    const linkFilter = { companyProductId, supplierProductId, role: 'candidate' };
    if (!(await linkRepo.findOne({ filter: linkFilter, transaction } as never))) {
      await linkRepo.create({ values: { id: randomUUID(), ...linkFilter }, transaction } as never);
    }
    return supplierProductId;
  }

  private async appendLineage(
    bronzeRecordId: string,
    silverEntityType: string,
    silverEntityId: string,
    runId: string,
    repairVersion: string,
    transaction?: unknown,
  ) {
    const bronze = plain(
      await this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords).findOne({
        filterByTk: bronzeRecordId,
        transaction,
      } as never),
    );
    const mapperName = `supplier-resolution-repair:${repairVersion}:${runId}`;
    const repository = this.repo(ECOBASE_COLLECTIONS.silverNormalizationLinks);
    const existing = await repository.findOne({
      filter: { bronzeRecordId, silverEntityType, silverEntityId, relation: 'confirmed_by', mapperName },
      transaction,
    } as never);
    if (existing) return;
    await repository.create({
      values: {
        id: randomUUID(),
        silverEntityType,
        silverEntityId,
        bronzeRecordId,
        importRunId: text(bronze.importRunId),
        sourceType: text(bronze.sourceType),
        sourceDataset: text(bronze.sourceDataset),
        sourceRecordKey: text(bronze.sourceRecordKey),
        sourceRowHash: text(bronze.rowHash),
        relation: 'confirmed_by',
        mappedAt: new Date().toISOString(),
        mapperName,
      },
      transaction,
    } as never);
  }

  private async recordExecutionFailure(params: { runId: string; attemptedCursor?: number; errorMessage: string }) {
    if (params.attemptedCursor === undefined) return;
    await this.transaction(async (transaction) => {
      const repository = this.repo(ECOBASE_COLLECTIONS.repairRuns);
      const current = plain(await repository.findOne({ filterByTk: params.runId, transaction, lock: true } as never));
      if ((number(current.cursor) ?? 0) !== params.attemptedCursor || text(current.status) === 'completed') return;
      await repository.update({
        filterByTk: params.runId,
        values: { status: 'failed', errorMessage: params.errorMessage },
        transaction,
      } as never);
    });
  }

  private assertRun(run: PlainRecord, decisionDigest: string, codeSha: string) {
    if (!text(run.id)) throw new RepairPreconditionError('EcoBase supplier repair run was not found.');
    if (text(run.decisionDigest) !== decisionDigest || text(run.codeSha) !== codeSha) {
      throw new RepairPreconditionError('EcoBase supplier repair refused mismatched decision digest or code SHA.');
    }
    if (text(run.status) === 'completed') return;
    if (!['previewed', 'running', 'failed'].includes(text(run.status) ?? '')) {
      throw new RepairPreconditionError(`EcoBase supplier repair run has invalid status "${text(run.status)}".`);
    }
  }

  private async rows(collection: string) {
    const rows: PlainRecord[] = [];
    const pageSize = 5000;
    for (let offset = 0; ; offset += pageSize) {
      const page = (await this.repo(collection).find({ limit: pageSize, offset, sort: ['id'] } as never)).map(plain);
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  private repo(collection: string): MutableRepository {
    return this.db.getRepository(collection) as MutableRepository;
  }

  private transaction<T>(run: (transaction?: unknown) => Promise<T>) {
    if (typeof this.db.sequelize?.transaction === 'function') return this.db.sequelize.transaction(run);
    return run();
  }
}
