/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { CsvRowReader } from '../../source-import/server/adapters/csv-utils';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';
import { EcobaseMedallionIdentityService, normalizeExternalSupplierCode } from './medallion-identity-service';
import { resolveOrderLifecycle } from '../../order-planning/server/order-lifecycle';

export interface NormalizePendingParams {
  sourceConnectionId?: string;
  limit?: number;
}

export interface NormalizePendingResult {
  normalized: number;
  ignored: number;
  failed: number;
  links: number;
  errors: string[];
}

type NormalizationRelation = 'created_from' | 'updated_from' | 'confirmed_by';
type SilverEntity = { type: string; id: string; relation: NormalizationRelation };
type CompanyProductIdentity = { account: unknown | null; companyProduct: unknown; product?: unknown | null };

export class EcobaseMedallionNormalizationService {
  private identity: EcobaseMedallionIdentityService;

  constructor(private db: EcobaseDatabase) {
    this.identity = new EcobaseMedallionIdentityService(db);
  }

  async normalizePending(params: NormalizePendingParams = {}): Promise<NormalizePendingResult> {
    const records = await this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords).find({
      filter: {
        normalizationStatus: 'pending',
        ...(params.sourceConnectionId ? { sourceConnectionId: params.sourceConnectionId } : {}),
      },
      limit: params.limit,
    });
    const result: NormalizePendingResult = { normalized: 0, ignored: 0, failed: 0, links: 0, errors: [] };

    for (const record of records) {
      const outcome = await this.normalizeRecord(record);
      result.links += outcome.links;
      if (outcome.status === 'normalized') result.normalized += 1;
      if (outcome.status === 'ignored') result.ignored += 1;
      if (outcome.status === 'failed') {
        result.failed += 1;
        result.errors.push(outcome.error);
      }
    }

    return result;
  }

  async normalizeRecord(
    record: unknown,
  ): Promise<{ status: 'normalized' | 'ignored'; links: number } | { status: 'failed'; links: 0; error: string }> {
    const bronze = toPlainRecord(record);
    const bronzeId = textValue(bronze.id);
    if (!bronzeId) {
      throw new Error('Ecobase medallion normalization failed: bronze record id is missing.');
    }

    try {
      const entities = await this.mapBronzeRecord(bronze);
      if (entities.length === 0) {
        await this.markBronzeRecord(bronzeId, 'ignored');
        return { status: 'ignored', links: 0 };
      }
      let links = 0;
      for (const entity of entities) {
        if (await this.writeNormalizationLink(bronze, entity)) links += 1;
      }
      await this.markBronzeRecord(bronzeId, 'normalized');
      return { status: 'normalized', links };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Ecobase medallion normalization failed: mapper threw a non-Error value.';
      await this.markBronzeRecord(bronzeId, 'failed');
      return { status: 'failed', links: 0, error: message };
    }
  }

  private async mapBronzeRecord(bronze: Record<string, unknown>) {
    const row = new CsvRowReader(stringRecord(toPlainRecord(bronze.payload)));
    const entities: SilverEntity[] = [];
    const companyName =
      row.string('Company') ??
      row.string('Reached Via') ??
      (await this.sourceCompanyName(textValue(bronze.sourceConnectionId)));
    const supplierName = row.string('Supplier', 'Supplier ', 'Supplier Name');
    const supplierExternalCode = normalizeExternalSupplierCode(row.string('SR ID', 'SR ID ', 'externalSupplierCode'));
    const asin = row.string('ASIN', 'ASIN ')?.toUpperCase();
    const sku = row.string('SKU');
    const orderRef = row.string('Order ID');
    const snapshotDate = dateOnly(row.string('Date', 'Timestamp', 'Order Date') ?? textValue(bronze.observedAt));
    const marketplace = row.string('Marketplace', 'Market ', 'Amazon Account');
    const leadTimeText = row.string('Lead time(day)', 'Manuf. time days', 'Lead Time');
    const importedLeadTimeDays = parseLeadTimeDays(leadTimeText);

    const company = companyName
      ? await this.identity.upsertCompany({ companyKey: companyKeyFor(companyName), name: companyName })
      : null;
    if (company) entities.push(entity('silverCompany', company, 'company'));

    const product =
      asin && sku
        ? await this.identity.upsertProduct({
            asin,
            sku,
            title: row.string('Title', 'Name'),
            brand: row.string('Brand', 'Brand '),
          })
        : null;
    if (product) entities.push(entity('silverProduct', product, 'product'));

    const companyProductIdentity = company
      ? product
        ? await this.resolveCompanyProductIdentity({
            companyId: idOf(company),
            productId: idOf(product),
            marketplace,
          })
        : asin
          ? await this.resolveExistingCompanyProductByAsin(idOf(company), asin)
          : null
      : null;
    const account = companyProductIdentity?.account ?? null;
    const companyProduct = companyProductIdentity?.companyProduct ?? null;
    const supplierProductProduct = product ?? companyProductIdentity?.product ?? null;
    if (supplierExternalCode && leadTimeText && importedLeadTimeDays === undefined) {
      await this.markBronzeWarning(
        bronze,
        'lead_time_unparsed',
        `Lead time "${leadTimeText}" was not imported for supplier ${supplierExternalCode}; planning will use the 30-day default unless another lead time exists.`,
      );
    }
    if (supplierExternalCode && asin && !sku && !companyProductIdentity) {
      await this.markBronzeWarning(
        bronze,
        'supplier_product_unresolved',
        `Supplier row for ${supplierExternalCode}/${asin} was not linked because no unique existing company product was found.`,
      );
    }
    if (account) entities.push(entity('silverAmazonAccount', account, 'amazon_account'));
    if (companyProduct) entities.push(entity('silverCompanyProduct', companyProduct, 'company_product'));

    const supplier = supplierExternalCode
      ? await this.identity.upsertSupplierExternalRef({
          sourceSystem: 'supplier_ids',
          externalSupplierCode: supplierExternalCode,
          displayName: supplierName,
          sourceConnectionId: textValue(bronze.sourceConnectionId),
          observedAt: textValue(bronze.observedAt),
          payload: toPlainRecord(bronze.payload),
        })
      : null;
    const supplierAccount =
      supplier && company
        ? await this.upsertByFilter(
            ECOBASE_COLLECTIONS.silverSupplierAccounts,
            { supplierId: idOf(supplier), companyId: idOf(company), accountName: supplierName ?? supplierExternalCode },
            {
              supplierId: idOf(supplier),
              companyId: idOf(company),
              accountName: supplierName ?? supplierExternalCode,
              orderingMethod: row.string('Ordering Method', 'Order Method'),
              portalUrl: row.string('Portal URL', 'Website'),
              username: row.string('Username', 'Login'),
              status: 'imported',
            },
          )
        : null;
    const supplierProduct =
      supplier && supplierProductProduct
        ? await this.identity.upsertSupplierProduct({
            supplierId: idOf(supplier),
            productId: idOf(supplierProductProduct),
            supplierSku: row.string('Supplier SKU'),
            unitCost: row.number('COGS', 'PPU', 'Exp. Cost '),
            leadTimeDays: importedLeadTimeDays,
            analysisStatus: 'imported',
          })
        : null;
    if (supplier) entities.push(entity('silverSupplier', supplier, 'supplier'));
    if (supplierAccount) entities.push(entity('silverSupplierAccount', supplierAccount, 'supplier_account'));
    if (supplierProduct) entities.push(entity('silverSupplierProduct', supplierProduct, 'supplier_product'));
    if (companyProduct && supplierProduct) {
      entities.push(
        entity(
          'silverCompanyProductSupplier',
          await this.identity.upsertCompanyProductSupplier({
            companyProductId: idOf(companyProduct),
            supplierProductId: idOf(supplierProduct),
            role: 'latest_used',
          }),
          'company_product_supplier',
        ),
      );
    }

    if (
      companyProduct &&
      hasAnyNumber(
        row,
        'FBA/FBM Stock',
        'Current Stock',
        'FBA',
        'Reserved',
        'Inbound',
        'Ordered',
        'Estimated Sales Velocity',
        'Est. Sales Velocity',
      )
    ) {
      entities.push(
        entity(
          'silverInventorySnapshot',
          await this.upsertByFilter(
            ECOBASE_COLLECTIONS.silverInventorySnapshots,
            {
              companyProductId: idOf(companyProduct),
              snapshotDate,
            },
            {
              companyProductId: idOf(companyProduct),
              snapshotDate,
              sellableStock: row.number('FBA/FBM Stock', 'Current Stock', 'FBA'),
              reserved: row.number('Reserved', 'Rerv.'),
              inbound: row.number('Inbound', 'Sent  to FBA'),
              ordered: row.number('Ordered'),
              salesVelocity: row.number('Estimated Sales Velocity', 'Est. Sales Velocity'),
            },
          ),
          'inventory_snapshot',
        ),
      );
    }

    if (
      companyProduct &&
      hasAnyNumber(row, 'SalesOrganic', 'UnitsOrganic', 'GrossProfit', 'NetProfit', 'Profit Achieved')
    ) {
      entities.push(
        entity(
          'silverListingDailyFact',
          await this.upsertByFilter(
            ECOBASE_COLLECTIONS.silverListingDailyFacts,
            {
              companyProductId: idOf(companyProduct),
              snapshotDate,
            },
            {
              companyProductId: idOf(companyProduct),
              snapshotDate,
              sales: row.number('SalesOrganic', 'Ordered Product Sales', 'Total Sales'),
              units: row.number('UnitsOrganic', 'Units Achieved', 'Units Ordered'),
              profit: row.number('NetProfit', 'GrossProfit', 'Profit Achieved'),
              margin: row.number('Margin', 'Margin '),
              refunds: row.number('Refunds', 'Refund Units'),
            },
          ),
          'listing_daily_fact',
        ),
      );
    }

    if (
      companyProduct &&
      hasAnyNumber(row, 'Sessions', 'Sessions - Total', 'Featured Offer (Buy Box) Percentage', 'BB %')
    ) {
      entities.push(
        entity(
          'silverTrafficSnapshot',
          await this.upsertByFilter(
            ECOBASE_COLLECTIONS.silverTrafficSnapshots,
            {
              companyProductId: idOf(companyProduct),
              snapshotDate,
            },
            {
              companyProductId: idOf(companyProduct),
              snapshotDate,
              sessions: row.number('Sessions', 'Sessions - Total'),
              buyBoxPercentage: row.number('Featured Offer (Buy Box) Percentage', 'BB %'),
              conversionRate: row.number('Unit Session Percentage'),
            },
          ),
          'traffic_snapshot',
        ),
      );
    }

    if (company && supplier && orderRef) {
      const orderFilter = { companyId: idOf(company), orderRef };
      const existingOrder = toPlainRecord(
        await this.repo(ECOBASE_COLLECTIONS.silverOrders).findOne({ filter: orderFilter }),
      );
      const hasOperatorOverride =
        textValue(existingOrder.statusSource) === 'operator' ||
        Boolean(textValue(existingOrder.operatorStatusOverrideAt));
      const existingOrderSupplierId = textValue(existingOrder.supplierId);
      const lineHasSupplierProduct = Boolean(
        companyProduct && supplierProduct && row.number('Qty', 'Ordered') !== undefined,
      );
      const rowSupplierId = idOf(supplier);
      const orderSupplierId =
        existingOrderSupplierId && lineHasSupplierProduct ? existingOrderSupplierId : rowSupplierId;
      if (existingOrderSupplierId && existingOrderSupplierId !== rowSupplierId) {
        await this.markBronzeWarning(
          bronze,
          'order_supplier_mismatch',
          lineHasSupplierProduct
            ? `Order ${orderRef} kept existing header supplier while line used supplier ${supplierExternalCode}.`
            : `Order ${orderRef} header supplier changed from previous imported supplier to ${supplierExternalCode}.`,
        );
      }
      const importedLifecycle = resolveOrderLifecycle({
        canonicalStatus: textValue(existingOrder.canonicalStatus),
        existingStatusCheckRequired: existingOrder.statusCheckRequired === true,
        lifecyclePhase: 'imported',
        lifecycleStatus: row.string('Order Status', 'PO Status', 'AM Status'),
        sourceOrderStatus: row.string('Order Status', 'Order status', 'PO Status', 'AM Status'),
        paymentStatus: row.string('Payment Status', 'Payment Status '),
        invoiceStatus: row.string('Invoice Status'),
        poApproval: row.string('PO approval', 'Approval Status', 'PO Approval'),
        prepStatus: row.string('Prep Status', 'Prep Status '),
        orStatus: row.string('OR Status'),
        remarks: row.string('Remarks'),
        dateOfPayment: row.string('Date of Payment'),
        trackingId: row.string('Tracking ID', 'Tracking #'),
        shippingCarrier: row.string('Shipping Carrier', 'Carrier'),
      });
      const order = await this.upsertByFilter(ECOBASE_COLLECTIONS.silverOrders, orderFilter, {
        companyId: idOf(company),
        supplierId: orderSupplierId,
        orderRef,
        orderDate: snapshotDate,
        dailySequenceLetter: orderRef,
        orderIntent: row.string('Order type') ?? 'imported',
        lifecyclePhase: 'imported',
        ...(hasOperatorOverride
          ? {}
          : {
              lifecycleStatus: importedLifecycle.canonicalStatus,
              canonicalStatus: importedLifecycle.canonicalStatus,
              statusSource: importedLifecycle.statusSource,
              statusCheckRequired: importedLifecycle.statusCheckRequired,
              statusEvidenceJson: importedLifecycle.statusEvidence,
            }),
        fulfillmentRoute: 'unknown',
        expectedDeliveryDate: row.string('Expected Delivery', 'Expected Delivery Date', 'ETA', 'Arrival to Amazon'),
        expectedCost: row.number('Exp. Cost ', 'Expected Cost'),
      });
      entities.push(entity('silverOrder', order, 'order'));

      if (companyProduct && supplierProduct && row.number('Qty', 'Ordered') !== undefined) {
        const expectedSellableDate = expectedSellableDateFor(row);
        entities.push(
          entity(
            'silverOrderLine',
            await this.upsertByFilter(
              ECOBASE_COLLECTIONS.silverOrderLines,
              {
                orderId: idOf(order),
                companyProductId: idOf(companyProduct),
                supplierProductId: idOf(supplierProduct),
              },
              {
                orderId: idOf(order),
                companyProductId: idOf(companyProduct),
                supplierProductId: idOf(supplierProduct),
                orderedQty: row.number('Qty', 'Ordered'),
                unitCost: row.number('PPU', 'COGS', 'Exp. Cost '),
                expectedProfit: row.number('T.Profit', 'Rec.Best Profit'),
                expectedDeliveryDate: row.string('Expected Delivery', 'Expected Delivery Date', 'ETA'),
                expectedSellableDate,
                productAnalysisStatus: 'imported',
              },
            ),
            'order_line',
          ),
        );
      }

      const invoiceNumber = row.string('Invoice Number', 'Invoice No');
      const invoiceStatus = row.string('Invoice Status') ?? row.string('Payment Status', 'Payment Status ');
      if (invoiceNumber || invoiceStatus) {
        entities.push(
          entity(
            'silverInvoice',
            await this.upsertByFilter(
              ECOBASE_COLLECTIONS.silverInvoices,
              {
                orderId: idOf(order),
                invoiceNumber: invoiceNumber ?? `${orderRef}:imported`,
              },
              {
                orderId: idOf(order),
                invoiceNumber: invoiceNumber ?? `${orderRef}:imported`,
                invoiceType: 'normal',
                status: invoiceStatus ?? 'imported',
                paidAt: row.string('Date of Payment') ? dateOnly(row.string('Date of Payment')) : undefined,
              },
            ),
            'invoice',
          ),
        );
      }
    }

    return entities;
  }

  private async resolveCompanyProductIdentity(params: {
    companyId: string;
    productId: string;
    marketplace?: string;
  }): Promise<CompanyProductIdentity> {
    const marketplace = params.marketplace?.trim();
    if (!marketplace) {
      const existing = await this.preferredExistingCompanyProduct(params.companyId, params.productId);
      if (existing) {
        const accountId = textValue(toPlainRecord(existing).amazonAccountId);
        const account = accountId
          ? await this.repo(ECOBASE_COLLECTIONS.silverAmazonAccounts).findOne({ filterByTk: accountId })
          : null;
        return { account, companyProduct: existing };
      }
    }

    const account = await this.identity.ensureDefaultAmazonAccount({
      companyId: params.companyId,
      marketplace: marketplace ?? 'default',
    });
    const companyProduct = await this.identity.upsertCompanyProduct({
      companyId: params.companyId,
      amazonAccountId: idOf(account),
      productId: params.productId,
      lifecycleStatus: 'active',
      listingStatus: 'listed',
    });
    return { account, companyProduct };
  }

  private async resolveExistingCompanyProductByAsin(
    companyId: string,
    asin: string,
  ): Promise<CompanyProductIdentity | null> {
    const products = (await this.repo(ECOBASE_COLLECTIONS.silverProducts).find({ filter: { asin }, limit: 500 }))
      .map(toPlainRecord)
      .filter((product) => textValue(product.sku) !== asin);
    const productById = new Map(products.map((product) => [textValue(product.id), product]));
    const candidates = (
      await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).find({ filter: { companyId }, limit: 10000 })
    )
      .map(toPlainRecord)
      .filter((companyProduct) => productById.has(textValue(companyProduct.productId)));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return this.companyProductIdentityFromCandidate(candidates[0], productById);

    let best: Record<string, unknown> | undefined;
    let bestScore = 0;
    let tied = false;
    for (const candidate of candidates) {
      const candidateId = textValue(candidate.id);
      if (!candidateId) continue;
      const score = await this.companyProductEvidenceScore(candidateId, textValue(candidate.amazonAccountId));
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    if (!best || bestScore === 0 || tied) return null;
    return this.companyProductIdentityFromCandidate(best, productById);
  }

  private async companyProductIdentityFromCandidate(
    companyProduct: Record<string, unknown>,
    productById: Map<string | undefined, Record<string, unknown>>,
  ): Promise<CompanyProductIdentity> {
    const accountId = textValue(companyProduct.amazonAccountId);
    const account = accountId
      ? await this.repo(ECOBASE_COLLECTIONS.silverAmazonAccounts).findOne({ filterByTk: accountId })
      : null;
    return {
      account,
      companyProduct,
      product: productById.get(textValue(companyProduct.productId)) ?? null,
    };
  }

  private async preferredExistingCompanyProduct(companyId: string, productId: string) {
    const candidates = await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).find({
      filter: { companyId, productId },
      limit: 100,
    });
    let best: unknown;
    let bestScore = 0;
    for (const candidate of candidates) {
      const candidateRecord = toPlainRecord(candidate);
      const candidateId = textValue(candidateRecord.id);
      if (!candidateId) continue;
      const score = await this.companyProductEvidenceScore(candidateId, textValue(candidateRecord.amazonAccountId));
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  private async companyProductEvidenceScore(companyProductId: string, amazonAccountId: string | undefined) {
    const [fact, inventory, traffic, account] = await Promise.all([
      this.repo(ECOBASE_COLLECTIONS.silverListingDailyFacts).findOne({ filter: { companyProductId } }),
      this.repo(ECOBASE_COLLECTIONS.silverInventorySnapshots).findOne({ filter: { companyProductId } }),
      this.repo(ECOBASE_COLLECTIONS.silverTrafficSnapshots).findOne({ filter: { companyProductId } }),
      amazonAccountId
        ? this.repo(ECOBASE_COLLECTIONS.silverAmazonAccounts).findOne({ filterByTk: amazonAccountId })
        : Promise.resolve(null),
    ]);
    const evidenceScore = (fact ? 1000 : 0) + (inventory ? 500 : 0) + (traffic ? 100 : 0);
    if (evidenceScore === 0) return 0;
    const marketplace = textValue(toPlainRecord(account).marketplace);
    return evidenceScore + (marketplace === 'Amazon.com' ? 5 : marketplace && marketplace !== 'default' ? 1 : 0);
  }

  private async sourceCompanyName(sourceConnectionId: string | undefined) {
    if (!sourceConnectionId) return undefined;
    const source = await this.repo(ECOBASE_COLLECTIONS.sourceConnections).findOne({ filterByTk: sourceConnectionId });
    const companyId = textValue(toPlainRecord(source).companyId);
    if (!companyId) return undefined;
    const company = await this.repo(ECOBASE_COLLECTIONS.silverCompanies).findOne({ filterByTk: companyId });
    return textValue(toPlainRecord(company).name);
  }

  private async upsertByFilter(
    collectionName: string,
    filter: Record<string, unknown>,
    values: Record<string, unknown>,
  ) {
    const repo = this.repo(collectionName);
    const existing = await repo.findOne({ filter });
    if (existing) {
      await repo.update({ filterByTk: idOf(existing), values: cleanValues(values) });
      return repo.findOne({ filterByTk: idOf(existing) });
    }
    return repo.create({ values: { id: randomUUID(), ...cleanValues(values) } });
  }

  private async writeNormalizationLink(bronze: Record<string, unknown>, entityRef: SilverEntity) {
    const repo = this.repo(ECOBASE_COLLECTIONS.silverNormalizationLinks);
    const bronzeRecordId = textValue(bronze.id);
    const existing = await repo.findOne({
      filter: {
        bronzeRecordId,
        silverEntityType: entityRef.type,
        silverEntityId: entityRef.id,
        relation: entityRef.relation,
      },
    });
    if (existing) return false;
    await repo.create({
      values: {
        id: randomUUID(),
        bronzeRecordId,
        importRunId: textValue(bronze.importRunId),
        silverEntityType: entityRef.type,
        silverEntityId: entityRef.id,
        sourceType: textValue(bronze.sourceType) ?? 'unknown',
        sourceDataset: textValue(bronze.sourceDataset) ?? 'unknown',
        sourceRecordKey: textValue(bronze.sourceRecordKey) ?? 'unknown',
        sourceRowHash: textValue(bronze.rowHash) ?? 'unknown',
        relation: entityRef.relation,
        mappedAt: new Date().toISOString(),
        mapperName: 'medallion-csv-row-v1',
      },
    });
    return true;
  }

  private async markBronzeRecord(id: string, normalizationStatus: string) {
    await this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords).update({
      filterByTk: id,
      values: { normalizationStatus, normalizedAt: new Date().toISOString() },
    });
  }

  private async markBronzeWarning(bronze: Record<string, unknown>, issueCode: string, message: string) {
    const id = textValue(bronze.id);
    if (!id) return;
    await this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords).update({
      filterByTk: id,
      values: { issueSeverity: 'warning', issueCode, normalizedError: message },
    });
  }

  private repo(name: string): EcobaseRepository {
    return this.db.getRepository(name);
  }
}

function entity(type: string, record: unknown, relation: string): SilverEntity {
  return {
    type,
    id: idOf(record),
    relation: relation === 'updated_from' || relation === 'confirmed_by' ? relation : 'created_from',
  };
}

function idOf(record: unknown) {
  const id = textValue(toPlainRecord(record).id);
  if (!id) throw new Error('Ecobase medallion normalization failed: mapped silver record id is missing.');
  return id;
}

function stringRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, value === undefined || value === null ? '' : String(value)]),
  );
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseLeadTimeDays(value: string | undefined) {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return validLeadTimeDays(numeric);

  const dayRange = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:business\s*)?days?,?$/);
  if (dayRange) return validLeadTimeDays(Number(dayRange[2]));

  const weekRange = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*weeks?,?$/);
  if (weekRange) return validLeadTimeDays(Number(weekRange[2]) * 7);

  const days = text.match(/^(\d+(?:\.\d+)?)\s*(?:business\s*)?days?,?$/);
  if (days) return validLeadTimeDays(Number(days[1]));

  const weeks = text.match(/^(\d+(?:\.\d+)?)\s*weeks?,?$/);
  if (weeks) return validLeadTimeDays(Number(weeks[1]) * 7);

  return undefined;
}

function validLeadTimeDays(value: number) {
  return value > 0 && value <= 3650 ? value : undefined;
}

function companyKeyFor(companyName: string) {
  const key = companyName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return key.length === 1 ? `${key}_1` : key;
}

function cleanValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function hasAnyNumber(row: CsvRowReader, ...headers: string[]) {
  return headers.some((header) => row.number(header) !== undefined);
}

function expectedSellableDateFor(row: CsvRowReader) {
  return optionalDateOnly(
    row.string('Expected Sellable Date') ?? row.string('ETA on Amazon') ?? row.string('Arrival to Amazon'),
  );
}

function optionalDateOnly(value: string | undefined) {
  return value ? dateOnly(value) : undefined;
}

function dateOnly(value: string | undefined) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const trimmed = value.trim();
  const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const day = second > 12 ? slashDate[2] : slashDate[1];
    const month = first > 12 ? slashDate[2] : second > 12 ? slashDate[1] : slashDate[2];
    return `${slashDate[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}
