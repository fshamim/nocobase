/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import { CsvRowReader } from '../../source-import/server/adapters/csv-utils';
import { orderDetailSourceIdentity } from '../../source-import/server/order-detail-source-identity';
import { orderRowExclusionReason } from '../../source-import/server/order-import-policy';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';
import { EcobaseMedallionIdentityService, normalizeExternalSupplierCode } from './medallion-identity-service';
import { resolveOrderLifecycle } from '../../order-planning/server/order-lifecycle';
import { requireCanonicalCompany } from '../../../server/company-identity';
import { EcobaseCompanyProductFamilyService } from '../../inventory-planning/server/company-product-family-service';
import { FOUR_COMPANY_MIGRATION_PROFILE } from '../../source-import/server/four-company-migration-profile';

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

const DEFAULT_SUPPLIER_LEAD_TIME_DAYS = 30;

export class EcobaseMedallionNormalizationService {
  private identity: EcobaseMedallionIdentityService;

  constructor(private db: EcobaseDatabase) {
    this.identity = new EcobaseMedallionIdentityService(db);
  }

  async normalizePending(params: NormalizePendingParams = {}): Promise<NormalizePendingResult> {
    const pendingRecords = await this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords).find({
      filter: {
        normalizationStatus: 'pending',
        ...(params.sourceConnectionId ? { sourceConnectionId: params.sourceConnectionId } : {}),
      },
      appends: ['sourceConnection.company'],
      limit: params.limit,
    });
    const records = [...pendingRecords].sort(
      (left, right) => normalizationPriority(left) - normalizationPriority(right),
    );
    const result: NormalizePendingResult = { normalized: 0, ignored: 0, failed: 0, links: 0, errors: [] };

    for (const record of records) {
      const outcome = await this.normalizeRecord(record, params.sourceConnectionId);
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
    scopedSourceConnectionId?: string,
  ): Promise<{ status: 'normalized' | 'ignored'; links: number } | { status: 'failed'; links: 0; error: string }> {
    const bronze = toPlainRecord(record);
    const bronzeId = textValue(bronze.id);
    if (!bronzeId) {
      throw new Error('Ecobase medallion normalization failed: bronze record id is missing.');
    }

    try {
      const entities = await this.mapBronzeRecord(bronze, scopedSourceConnectionId);
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
      await this.markBronzeFailure(bronzeId, message);
      return { status: 'failed', links: 0, error: message };
    }
  }

  private async mapBronzeRecord(bronze: Record<string, unknown>, scopedSourceConnectionId?: string) {
    const row = new CsvRowReader(stringRecord(toPlainRecord(bronze.payload)));
    const entities: SilverEntity[] = [];
    const sourceConnection = toPlainRecord(bronze.sourceConnection);
    const sourceConnectionId =
      textValue(bronze.sourceConnectionId) ?? textValue(sourceConnection.id) ?? scopedSourceConnectionId;
    const sourceDataset = textValue(bronze.sourceDataset)?.toLowerCase() ?? '';
    const safeProjectedDataset = [
      'order_details',
      'purchase_orders',
      'supplier_tracker',
      'supplier_provenance',
    ].includes(sourceDataset);
    const orderShape =
      sourceDataset.includes('orderdetails') || sourceDataset === 'order_details'
        ? 'order-details'
        : sourceDataset.includes('purchase orders') || sourceDataset === 'purchase_orders'
          ? 'purchase-orders'
          : undefined;
    const importRun = toPlainRecord(
      bronze.importRun ??
        (bronze.importRunId
          ? await this.repo(ECOBASE_COLLECTIONS.importRuns).findOne({ filterByTk: bronze.importRunId as string })
          : null),
    );
    const adapterName = textValue(importRun.adapterName);
    const catalogMutationMode = textValue(toPlainRecord(importRun.summary).catalogMutationMode) ?? 'refresh';
    const sellerboardIdentitySource = approvedAmazonIdentitySource({
      sourceType: textValue(bronze.sourceType),
      sourceDataset,
      adapterName,
    });
    const createsAmazonIdentity = sellerboardIdentitySource && catalogMutationMode === 'rebuild';
    const usesAdapterNormalizedSellerboardDate =
      sourceDataset === 'sellerboard_daily_facts' &&
      (adapterName === 'sellerboard-api' || adapterName === 'sellerboard-history-csv');
    if (orderShape && !safeProjectedDataset && orderRowExclusionReason(orderShape, row)) return entities;
    if (
      !safeProjectedDataset &&
      sourceDataset.includes('supplier analysis') &&
      row.string('Reached Via')?.toLowerCase() === 'call & email'
    ) {
      return entities;
    }
    const orderDetailIdentity = sourceDataset.includes('orderdetails') ? orderDetailSourceIdentity(row) : undefined;
    const companyName =
      orderDetailIdentity?.company?.name ??
      row.string('company', 'companyProvenance', 'Company') ??
      row.string('Reached Via') ??
      textValue(toPlainRecord(sourceConnection.company).name) ??
      (await this.sourceCompanyName(sourceConnectionId));
    const supplierName = row.string('supplierName', 'Supplier', 'Supplier ', 'Supplier Name');
    const supplierExternalCode =
      orderDetailIdentity?.supplierCode ??
      normalizeExternalSupplierCode(row.string('supplierExternalRef', 'SR ID', 'SR ID ', 'externalSupplierCode'));
    const asin = orderDetailIdentity?.asin ?? row.string('asin', 'sourceAsin', 'ASIN', 'ASIN ')?.toUpperCase();
    const orderRef = orderDetailIdentity?.orderRef ?? row.string('orderRef', 'Order ID');
    const sku =
      orderDetailIdentity?.sku ??
      row.string('listingSku', 'sourceSupplierSku', 'SKU') ??
      (orderRef ? row.string('UPC') : undefined);
    const snapshotDate = dateOnly(
      usesAdapterNormalizedSellerboardDate
        ? textValue(bronze.observedAt)
        : createsAmazonIdentity
          ? row.string('period') ?? textValue(bronze.observedAt)
          : row.string('occurredAt', 'period', 'orderDate', 'Timestamp', 'Date', 'Order Date') ??
            textValue(bronze.observedAt),
    );
    const marketplace = row.string('marketplace', 'account', 'Marketplace', 'Market ', 'Amazon Account');
    const leadTimeText = row.string('leadTimeDays', 'Lead time(day)', 'Manuf. time days', 'Lead Time');
    const orderedQty = orderDetailIdentity?.orderedQty ?? row.number('quantity', 'Qty', 'Ordered');
    let expectedOrderSupplierId: string | undefined;
    if (orderRef) {
      if (!supplierExternalCode) {
        await this.markBronzeWarning(bronze, 'order_supplier_missing', `Order ${orderRef} has no SR ID.`);
        return entities;
      }
      const supplierRef = toPlainRecord(
        await this.repo(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).findOne({
          filter: { sourceSystem: 'supplier_ids', normalizedExternalSupplierCode: supplierExternalCode },
        }),
      );
      expectedOrderSupplierId = textValue(supplierRef.supplierId);
      if (!expectedOrderSupplierId) {
        await this.markBronzeWarning(
          bronze,
          'order_supplier_not_established',
          `Order ${orderRef} supplier ${supplierExternalCode} was not established by Supplier Management.`,
        );
        return entities;
      }
    }

    const canonicalCompany = companyName ? requireCanonicalCompany(companyName) : null;
    const company = canonicalCompany
      ? await this.identity.upsertCompany({
          companyKey: canonicalCompany.companyKey,
          name: canonicalCompany.name,
        })
      : null;
    if (company) entities.push(entity('silverCompany', company, 'company'));

    const isOrderDetailInput = Boolean(orderRef && asin && orderedQty !== undefined);
    let validatedOrderRecord: unknown | null = null;
    if (company && orderRef) {
      if (isOrderDetailInput) {
        validatedOrderRecord = await this.repo(ECOBASE_COLLECTIONS.silverOrders).findOne({
          filter: { companyId: idOf(company), orderRef },
        });
        const validatedOrder = toPlainRecord(validatedOrderRecord);
        if (!textValue(toPlainRecord(validatedOrderRecord).id)) {
          throw new Error(
            `Ecobase medallion normalization failed: OrderDetails ${orderRef} has no Purchase Orders header for ${canonicalCompany?.name}.`,
          );
        }
        if (textValue(validatedOrder.supplierId) !== expectedOrderSupplierId) {
          throw new Error(
            `Ecobase medallion normalization failed: order ${orderRef} supplier conflicts with OrderDetails supplier ${supplierExternalCode}.`,
          );
        }
      }
    }

    const product =
      createsAmazonIdentity && asin && sku
        ? await this.identity.upsertProduct({
            asin,
            sku,
            title: row.string('title', 'Title', 'Name'),
            brand: row.string('brand', 'Brand', 'Brand '),
          })
        : null;
    if (product) entities.push(entity('silverProduct', product, 'product'));

    const resolutionSku = approvedAmazonListingSku(asin, sku) ?? sku;
    const companyProductIdentity = company
      ? product
        ? await this.resolveCompanyProductIdentity({
            companyId: idOf(company),
            productId: idOf(product),
            marketplace,
          })
        : asin
          ? await this.resolveExistingCompanyProduct({
              companyId: idOf(company),
              asin,
              sku: resolutionSku,
              marketplace,
            })
          : null
      : null;
    const account = companyProductIdentity?.account ?? null;
    const companyProduct = companyProductIdentity?.companyProduct ?? null;
    const supplierProductProduct = product ?? companyProductIdentity?.product ?? null;
    if (sellerboardIdentitySource && catalogMutationMode !== 'rebuild' && company && asin && sku && !companyProduct) {
      throw new Error(
        `Ecobase Sellerboard refresh failed: ${canonicalCompany?.name}/${
          marketplace ?? 'unknown marketplace'
        }/${asin}/${sku} is outside the protected catalog.`,
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

    const supplierProfileSource = sourceDataset === 'supplier_2026' || sourceDataset === 'supplier_ids';
    const supplierStatus = supplierProfileSource ? row.string('supplierStatus', 'Status') : undefined;
    const currentSupplierStatus = supplierProfileSource
      ? row.string('currentStatus', 'Current Status', 'Active Status')
      : undefined;
    const supplierEmail = supplierProfileSource
      ? row.string('primaryEmail', 'receivedEmail', 'Recieved Email', 'Received Email')
      : undefined;
    const supplierDateOfUpdate = supplierProfileSource ? row.string('dateOfUpdate', 'Date of Update') : undefined;
    const supplierApprovalStatus =
      supplierStatus?.toLowerCase() === 'approved'
        ? 'approved'
        : supplierStatus?.toLowerCase() === 'rejected'
          ? 'rejected'
          : undefined;
    const supplier = supplierExternalCode
      ? await this.identity.upsertSupplierExternalRef({
          sourceSystem: 'supplier_ids',
          externalSupplierCode: supplierExternalCode,
          displayName: supplierName,
          sourceConnectionId,
          observedAt: textValue(bronze.observedAt),
          payload: supplierProfileSource ? undefined : toPlainRecord(bronze.payload),
          approvalStatus: supplierApprovalStatus,
          analysisStatus: supplierStatus,
          accountStatus: currentSupplierStatus,
          contactName: supplierProfileSource ? row.string('contactName', 'Contact Person') : undefined,
          primaryEmail: supplierEmail,
          contactNotes: supplierProfileSource ? row.string('remarks', 'Remarks') : undefined,
          supplierUrl: supplierProfileSource ? row.string('supplierUrl', 'prPortalLink', 'PR Portal Link') : undefined,
          activeStatus: currentSupplierStatus,
          supplierType: supplierProfileSource ? row.string('supplierType', 'Supplier Type') : undefined,
          reachedVia: supplierProfileSource ? row.string('reachedVia', 'companyProvenance', 'Reached Via') : undefined,
          receivedEmail: supplierEmail,
          designation: supplierProfileSource ? row.string('designation', 'Designation') : undefined,
          amazonPresence: supplierProfileSource
            ? row.string('amazonPresence', 'presenceOnAmazon', 'Presence on Amazon')
            : undefined,
          trackingStatus: supplierStatus,
          dateOfUpdate: supplierDateOfUpdate ? dateOnly(supplierDateOfUpdate) : undefined,
          analysisProgress: supplierStatus,
          remarksAnalysed: supplierProfileSource
            ? row.string('analysisIssueRemarks', 'Remarks ( Analysed / facing any issue )')
            : undefined,
          identityAuthority: orderRef ? 'reference' : 'authoritative',
        })
      : null;
    const accountName =
      supplierExternalCode && canonicalCompany ? `${supplierExternalCode}:${canonicalCompany.companyKey}` : undefined;
    const supplierAccount =
      supplier && company && accountName
        ? await this.upsertByFilter(
            ECOBASE_COLLECTIONS.silverSupplierAccounts,
            { supplierId: idOf(supplier), accountName },
            {
              supplierId: idOf(supplier),
              companyId: idOf(company),
              accountName,
              orderingMethod: row.string('Ordering Method', 'Order Method'),
              portalUrl: row.string('prPortalLink', 'PR Portal Link', 'Portal URL', 'Website'),
              username: row.string('portalUsername', 'Username', 'Login'),
              loginUsername: row.string('portalUsername', 'Username', 'Login'),
              loginSecret: row.string('portalPassword', 'pass', 'Password'),
              status: currentSupplierStatus ?? 'imported',
              accountType: supplierProfileSource ? 'supplier_portal' : undefined,
              contactName: supplierProfileSource ? row.string('contactName', 'Contact Person') : undefined,
              email: supplierEmail,
              preferredContactMethod: supplierEmail ? 'email' : undefined,
              metadata: supplierProfileSource ? { source: sourceDataset } : undefined,
            },
          )
        : null;
    const supplierProductLeadTime =
      supplier && supplierProductProduct ? leadTimeDaysForSilver(leadTimeText, supplierExternalCode) : undefined;
    const supplierProduct =
      supplier && supplierProductProduct
        ? await this.identity.upsertSupplierProduct({
            supplierId: idOf(supplier),
            productId: idOf(supplierProductProduct),
            supplierSku: row.string('sourceSupplierSku', 'Supplier SKU'),
            unitCost: row.number('unitCost', 'COGS', 'PPU', 'Exp. Cost '),
            leadTimeDays: supplierProductLeadTime?.days,
            leadTimeIsDefault: supplierProductLeadTime?.isDefault,
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
            role: 'candidate',
            lastUsedAt: orderRef && snapshotDate ? `${snapshotDate}T00:00:00.000Z` : undefined,
          }),
          'company_product_supplier',
        ),
      );
    }

    if (
      companyProduct &&
      hasAnyNumber(
        row,
        'sellableStock',
        'reservedStock',
        'inboundStock',
        'orderedStock',
        'awdStock',
        'salesVelocity',
        'FBA/FBM Stock',
        'Current Stock',
        'FBA',
        'Reserved',
        'Inbound',
        'Ordered',
        'AWD Stock',
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
              sourceConnectionId,
              sellableStock: row.number('sellableStock', 'FBA/FBM Stock', 'Current Stock', 'FBA'),
              reserved: row.number('reservedStock', 'Reserved', 'Rerv.'),
              inbound: row.number('inboundStock', 'Inbound', 'Sent  to FBA'),
              ordered: row.number('orderedStock', 'Ordered'),
              awdStock: row.number('awdStock', 'AWD Stock'),
              salesVelocity: row.number('salesVelocity', 'Estimated Sales Velocity', 'Est. Sales Velocity'),
            },
          ),
          'inventory_snapshot',
        ),
      );
    }

    if (
      companyProduct &&
      hasAnyNumber(
        row,
        'sales',
        'salesOrganic',
        'salesPpc',
        'salesSponsoredProducts',
        'salesSponsoredBrands',
        'salesSponsoredDisplay',
        'units',
        'unitsOrganic',
        'unitsPpc',
        'unitsSponsoredProducts',
        'unitsSponsoredBrands',
        'unitsSponsoredDisplay',
        'grossProfit',
        'netProfit',
        'SalesOrganic',
        'SalesPPC',
        'SalesSponsoredProducts',
        'SalesSponsoredDisplay',
        'UnitsOrganic',
        'UnitsPPC',
        'UnitsSponsoredProducts',
        'UnitsSponsoredDisplay',
        'GrossProfit',
        'NetProfit',
        'Profit Achieved',
      )
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
              sales:
                row.number('sales') ??
                sumNumbers(
                  row,
                  'salesOrganic',
                  'salesPpc',
                  'salesSponsoredProducts',
                  'salesSponsoredBrands',
                  'salesSponsoredDisplay',
                ) ??
                sumNumbers(row, 'SalesOrganic', 'SalesPPC', 'SalesSponsoredProducts', 'SalesSponsoredDisplay') ??
                row.number('Ordered Product Sales', 'Total Sales'),
              units:
                row.number('units') ??
                sumNumbers(
                  row,
                  'unitsOrganic',
                  'unitsPpc',
                  'unitsSponsoredProducts',
                  'unitsSponsoredBrands',
                  'unitsSponsoredDisplay',
                ) ??
                sumNumbers(row, 'UnitsOrganic', 'UnitsPPC', 'UnitsSponsoredProducts', 'UnitsSponsoredDisplay') ??
                row.number('Units Achieved', 'Units Ordered'),
              profit: row.number('netProfit', 'grossProfit', 'NetProfit', 'GrossProfit', 'Profit Achieved'),
              margin: row.number('margin', 'Margin', 'Margin '),
              refunds: row.number('refunds', 'Refunds', 'Refund Units'),
            },
          ),
          'listing_daily_fact',
        ),
      );
    }

    if (
      companyProduct &&
      hasAnyNumber(
        row,
        'sessions',
        'pageViews',
        'buyBoxPercentage',
        'unitSessionPercentage',
        'Sessions',
        'Sessions - Total',
        'Featured Offer (Buy Box) Percentage',
        'BB %',
      )
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
              sessions: row.number('sessions', 'Sessions', 'Sessions - Total'),
              pageViews: row.number('pageViews', 'Page Views', 'Page Views - Total'),
              buyBoxPercentage: row.number('buyBoxPercentage', 'Featured Offer (Buy Box) Percentage', 'BB %'),
              conversionRate: row.number('unitSessionPercentage', 'Unit Session Percentage'),
            },
          ),
          'traffic_snapshot',
        ),
      );
    }

    if (company && supplier && orderRef) {
      const orderFilter = { companyId: idOf(company), orderRef };
      const existingOrderRecord =
        validatedOrderRecord ?? (await this.repo(ECOBASE_COLLECTIONS.silverOrders).findOne({ filter: orderFilter }));
      const existingOrder = toPlainRecord(existingOrderRecord);
      const isOrderLine = isOrderDetailInput;
      if (isOrderLine && !textValue(toPlainRecord(existingOrderRecord).id)) {
        throw new Error(
          `Ecobase medallion normalization failed: OrderDetails ${orderRef} has no Purchase Orders header for ${canonicalCompany?.name}.`,
        );
      }
      const rowSupplierId = idOf(supplier);
      const existingOrderSupplierId = textValue(existingOrder.supplierId);
      if (existingOrderSupplierId && existingOrderSupplierId !== rowSupplierId) {
        throw new Error(
          `Ecobase medallion normalization failed: order ${orderRef} supplier conflicts with OrderDetails supplier ${supplierExternalCode}.`,
        );
      }
      const hasProtectedStatus =
        ['operator', 'clickup_csv'].includes(textValue(existingOrder.statusSource) ?? '') ||
        Boolean(textValue(existingOrder.operatorStatusOverrideAt));
      const importedLifecycle = resolveOrderLifecycle({
        canonicalStatus: textValue(existingOrder.canonicalStatus),
        existingStatusCheckRequired: existingOrder.statusCheckRequired === true,
        lifecyclePhase: 'imported',
        lifecycleStatus: row.string('status', 'Order Status', 'PO Status', 'AM Status'),
        sourceOrderStatus: row.string('status', 'Order Status', 'Order status', 'PO Status', 'AM Status'),
        paymentStatus: row.string('Payment Status', 'Payment Status '),
        invoiceStatus: row.string('Invoice Status'),
        poApproval: row.string('PO approval', 'Approval Status', 'PO Approval'),
        prepStatus: row.string('Prep Status', 'Prep Status '),
        orStatus: row.string('OR Status'),
        remarks: row.string('Remarks'),
        dateOfPayment: row.string('Date of Payment'),
        orderDate: textValue(existingOrder.orderDate) ?? snapshotDate,
        calculationDate: snapshotDate,
        trackingId: row.string('Tracking ID', 'Tracking #'),
        shippingCarrier: row.string('Shipping Carrier', 'Carrier'),
      });
      const expectedDeliveryDate = await this.optionalDateOnlyWarning(
        bronze,
        row.string('expectedDeliveryDate', 'Expected Delivery', 'Expected Delivery Date', 'ETA', 'Arrival to Amazon'),
        'expected_delivery_date_unparsed',
        'expected delivery date',
      );
      const arrivalSourceDataset = textValue(bronze.sourceDataset) ?? 'bronze_source_record';
      const order = isOrderLine
        ? existingOrderRecord
        : await this.upsertByFilter(ECOBASE_COLLECTIONS.silverOrders, orderFilter, {
            companyId: idOf(company),
            supplierId: rowSupplierId,
            orderRef,
            orderDate: snapshotDate,
            dailySequenceLetter: orderRef,
            orderIntent: row.string('Order type') ?? 'imported',
            lifecyclePhase: 'imported',
            ...(hasProtectedStatus
              ? {}
              : {
                  lifecycleStatus: importedLifecycle.canonicalStatus,
                  canonicalStatus: importedLifecycle.canonicalStatus,
                  statusSource: importedLifecycle.statusSource,
                  statusCheckRequired: importedLifecycle.statusCheckRequired,
                  statusEvidenceJson: importedLifecycle.statusEvidence,
                }),
            fulfillmentRoute: 'unknown',
            expectedDeliveryDate,
            expectedArrivalDate: expectedDeliveryDate,
            expectedArrivalStatus: expectedDeliveryDate ? 'imported' : 'unknown',
            expectedArrivalSource: expectedDeliveryDate
              ? `${arrivalSourceDataset}:expected_delivery_date`
              : 'insufficient_silver_evidence',
            expectedArrivalAsOf: snapshotDate,
            expectedArrivalConfidence: expectedDeliveryDate ? 'authoritative' : 'none',
            expectedCost: row.number('expectedCost', 'Exp. Cost ', 'Expected Cost'),
          });
      entities.push(entity('silverOrder', order, 'order'));

      if (isOrderLine) {
        const orderRecord = toPlainRecord(order);
        const companyProductRecord = toPlainRecord(companyProduct);
        const supplierProductRecord = toPlainRecord(supplierProduct);
        if (textValue(orderRecord.companyId) !== idOf(company)) {
          throw new Error(`Ecobase medallion normalization failed: order ${orderRef} company relationship is invalid.`);
        }
        const productResolved = Boolean(companyProduct && supplierProduct);
        if (productResolved && textValue(orderRecord.supplierId) !== textValue(supplierProductRecord.supplierId)) {
          throw new Error(
            `Ecobase medallion normalization failed: order ${orderRef} supplier relationship is invalid.`,
          );
        }
        if (
          productResolved &&
          textValue(companyProductRecord.productId) !== textValue(supplierProductRecord.productId)
        ) {
          throw new Error(`Ecobase medallion normalization failed: order ${orderRef} product relationship is invalid.`);
        }
        const sourceLineKey = orderLineSourceKeyForBronze(bronze);
        const expectedSellableDate = await this.optionalDateOnlyWarning(
          bronze,
          expectedSellableDateTextFor(row),
          'expected_sellable_date_unparsed',
          'expected sellable date',
        );
        const expectedArrivalDate = expectedSellableDate ?? expectedDeliveryDate;
        entities.push(
          entity(
            'silverOrderLine',
            await this.upsertByFilter(
              ECOBASE_COLLECTIONS.silverOrderLines,
              { orderId: idOf(order), sourceLineKey },
              {
                orderId: idOf(order),
                companyProductId: productResolved ? idOf(companyProduct) : undefined,
                supplierProductId: productResolved ? idOf(supplierProduct) : undefined,
                sourceLineKey,
                sourceAsin: asin,
                sourceSupplierSku: sku,
                productMappingStatus: productResolved ? 'resolved' : 'unresolved',
                orderedQty,
                unitCost: row.number('unitCost', 'PPU', 'COGS', 'Exp. Cost '),
                expectedProfit: row.number('expectedProfit', 'T.Profit', 'Rec.Best Profit'),
                expectedDeliveryDate,
                expectedSellableDate,
                expectedArrivalDate,
                expectedArrivalStatus: expectedArrivalDate ? 'imported' : 'unknown',
                expectedArrivalSource: expectedSellableDate
                  ? `${arrivalSourceDataset}:expected_sellable_date`
                  : expectedDeliveryDate
                    ? `${arrivalSourceDataset}:expected_delivery_date`
                    : 'insufficient_silver_evidence',
                expectedArrivalAsOf: snapshotDate,
                expectedArrivalConfidence: expectedArrivalDate ? 'authoritative' : 'none',
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
        const paidAt = await this.optionalDateOnlyWarning(
          bronze,
          row.string('Date of Payment'),
          'invoice_paid_date_unparsed',
          'invoice paid date',
        );
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
                paidAt,
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
    const marketplace = params.marketplace?.trim() || 'default';
    const account = await this.identity.ensureDefaultAmazonAccount({ companyId: params.companyId, marketplace });
    const companyProduct = await this.identity.upsertCompanyProduct({
      companyId: params.companyId,
      amazonAccountId: idOf(account),
      productId: params.productId,
      lifecycleStatus: 'active',
      listingStatus: 'listed',
    });
    return { account, companyProduct };
  }

  private async resolveExistingCompanyProduct(params: {
    companyId: string;
    asin: string;
    sku?: string;
    marketplace?: string;
  }): Promise<CompanyProductIdentity | null> {
    const resolution = await new EcobaseCompanyProductFamilyService(this.db).resolveCompanyProduct(params);
    return resolution.companyProductId ? this.companyProductIdentityFromId(resolution.companyProductId) : null;
  }

  private async companyProductIdentityFromId(companyProductId: string): Promise<CompanyProductIdentity> {
    const companyProduct = toPlainRecord(
      await this.repo(ECOBASE_COLLECTIONS.silverCompanyProducts).findOne({ filterByTk: companyProductId }),
    );
    const productId = textValue(companyProduct.productId);
    const product = productId
      ? await this.repo(ECOBASE_COLLECTIONS.silverProducts).findOne({ filterByTk: productId })
      : null;
    return this.companyProductIdentityFromCandidate(companyProduct, new Map([[productId, toPlainRecord(product)]]));
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

  private async sourceCompanyName(sourceConnectionId: string | undefined) {
    if (!sourceConnectionId) return undefined;
    if (this.db.sequelize) {
      const [rows] = await this.db.sequelize.query(
        `SELECT c."name"
         FROM "${ECOBASE_COLLECTIONS.sourceConnections}" s
         JOIN "${ECOBASE_COLLECTIONS.silverCompanies}" c ON c."id" = s."companyId"
         WHERE s."id" = :sourceConnectionId
         LIMIT 1`,
        { replacements: { sourceConnectionId } },
      );
      const databaseCompanyName = textValue(toPlainRecord(rows?.[0]).name);
      if (databaseCompanyName) return databaseCompanyName;
    }
    const source = toPlainRecord(
      await this.repo(ECOBASE_COLLECTIONS.sourceConnections).findOne({
        filterByTk: sourceConnectionId,
        appends: ['company'],
      }),
    );
    const associatedCompanyName = textValue(toPlainRecord(source.company).name);
    if (associatedCompanyName) return associatedCompanyName;
    const companyId = textValue(source.companyId);
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

  private async optionalDateOnlyWarning(
    bronze: Record<string, unknown>,
    value: string | undefined,
    issueCode: string,
    label: string,
  ) {
    if (!value) return undefined;
    try {
      return dateOnly(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'date parser threw a non-Error value';
      await this.markBronzeWarning(bronze, issueCode, `Optional ${label} "${value}" was not imported: ${message}`);
      return undefined;
    }
  }

  private async markBronzeFailure(id: string, message: string) {
    await this.repo(ECOBASE_COLLECTIONS.bronzeSourceRecords).update({
      filterByTk: id,
      values: {
        normalizationStatus: 'failed',
        issueSeverity: 'error',
        issueCode: 'normalization_failed',
        normalizedError: message,
        normalizedAt: new Date().toISOString(),
      },
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

function normalizationPriority(record: unknown) {
  const dataset = textValue(toPlainRecord(record).sourceDataset)?.toLowerCase() ?? '';
  if (dataset === 'purchase_orders' || dataset.includes('purchase orders')) return 1;
  if (dataset === 'order_details' || dataset.includes('orderdetails')) return 2;
  return 1;
}

export function approvedAmazonIdentitySource(input: {
  sourceType?: string;
  sourceDataset: string;
  adapterName?: string;
}) {
  if (input.sourceType !== 'sellerboard') return false;
  if (input.adapterName === 'sellerboard-history-csv') return false;
  return (
    input.adapterName === 'sellerboard-api' &&
    ['amazon_listing_inventory', 'sellerboard_daily_facts'].includes(input.sourceDataset)
  );
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
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}

function approvedAmazonListingSku(asin: string | undefined, sourceSupplierSku: string | undefined) {
  if (!asin || !sourceSupplierSku) return undefined;
  return FOUR_COMPANY_MIGRATION_PROFILE.listingSkuAliasDecisions.find(
    (decision) => decision.asin === asin && decision.sourceSupplierSku === sourceSupplierSku,
  )?.amazonListingSku;
}

function leadTimeDaysForSilver(value: string | undefined, supplierExternalCode: string | undefined) {
  const text = value?.trim();
  const parsed = parseLeadTimeDays(text);
  if (typeof parsed === 'number') return { days: parsed, isDefault: false };
  if (!text || isUnavailableLeadTimeText(text)) return { days: DEFAULT_SUPPLIER_LEAD_TIME_DAYS, isDefault: true };
  throw new Error(
    `Ecobase medallion normalization failed: lead time "${text}" for supplier ${
      supplierExternalCode ?? 'unknown'
    } is not a supported lead-time value.`,
  );
}

function parseLeadTimeDays(value: string | undefined) {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return validLeadTimeDays(numeric);

  const dayRange = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:business|busines)?\s*days?\b/);
  if (dayRange) return validLeadTimeDays(Number(dayRange[2]));

  const weekRange = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*weeks?\b/);
  if (weekRange) return validLeadTimeDays(Number(weekRange[2]) * 7);

  const days = text.match(/^(\d+(?:\.\d+)?)\s*(?:business|busines)?\s*days?\b/);
  if (days) return validLeadTimeDays(Number(days[1]));

  const weeks = text.match(/^(\d+(?:\.\d+)?)\s*weeks?\b/);
  if (weeks) return validLeadTimeDays(Number(weeks[1]) * 7);

  return undefined;
}

function isUnavailableLeadTimeText(value: string) {
  const text = value.trim().toLowerCase();
  return (
    !/\d/.test(text) ||
    text.startsWith('oos') ||
    text.includes('waiting for supplier') ||
    text.includes('restricted') ||
    text.includes('no long allowed') ||
    text.includes('not allowed') ||
    text.includes('amazon allow')
  );
}

function validLeadTimeDays(value: number) {
  return value > 0 && value <= 3650 ? value : undefined;
}

function cleanValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function hasAnyNumber(row: CsvRowReader, ...headers: string[]) {
  return headers.some((header) => row.number(header) !== undefined);
}

function sumNumbers(row: CsvRowReader, ...headers: string[]) {
  const values = headers.map((header) => row.number(header)).filter((value): value is number => value !== undefined);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

export function orderLineSourceKeyForBronze(bronze: Record<string, unknown>) {
  const sourceRecordKey = textValue(bronze.sourceRecordKey);
  const rowHash = textValue(bronze.rowHash);
  if (!sourceRecordKey || !rowHash) {
    throw new Error(
      'Ecobase medallion normalization failed: OrderDetails line requires sourceRecordKey and rowHash evidence.',
    );
  }
  return createHash('sha256').update(`${sourceRecordKey}:${rowHash}`).digest('hex');
}

function expectedSellableDateTextFor(row: CsvRowReader) {
  return row.string('Expected Sellable Date') ?? row.string('ETA on Amazon') ?? row.string('Arrival to Amazon');
}

function dateOnly(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error('Ecobase medallion normalization failed: date value is missing.');
  const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const day = second > 12 ? slashDate[2] : slashDate[1];
    const month = first > 12 ? slashDate[2] : second > 12 ? slashDate[1] : slashDate[2];
    return validDateOnly(`${slashDate[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, trimmed);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Ecobase medallion normalization failed: date "${trimmed}" is not supported.`);
  }
  return validDateOnly(parsed.toISOString().slice(0, 10), trimmed);
}

function validDateOnly(value: string, source: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Ecobase medallion normalization failed: date "${source}" is not a valid calendar date.`);
  }
  return value;
}
