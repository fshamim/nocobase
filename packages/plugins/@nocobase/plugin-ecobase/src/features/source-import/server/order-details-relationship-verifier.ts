/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { orderLineSourceKeyForBronze } from '../../semantic-model/server/medallion-normalization-service';
import { bronzePayloadHash } from './bronze-import-service';
import { CsvRowReader, parseCsv, type CsvSourceFile } from './adapters/csv-utils';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import { orderDetailSourceIdentity } from './order-detail-source-identity';
import { orderRowExclusionReason } from './order-import-policy';
import { EcobaseInventoryPlanningGoldAccess } from '../../inventory-planning/server/inventory-planning-gold-access';

type PlainRecord = Record<string, unknown>;
type Classification =
  | 'full_identity'
  | 'asin_only_resolvable'
  | 'excluded_header_missing'
  | 'excluded_supplier_not_established'
  | 'excluded_supplier_mismatch'
  | 'invalid_non_actionable';

export type OrderDetailsRelationshipDiscrepancy = {
  sourceRow: number;
  classification: Classification;
  expectedIdentity: Record<string, unknown>;
  actualIds: Record<string, unknown>;
  reason: string;
};

export type OrderDetailsRelationshipVerification = {
  ok: boolean;
  fileName: string;
  totals: {
    sourceRows: number;
    acceptedRows: number;
    fullIdentityRows: number;
    asinOnlyRows: number;
    headerMissingRows: number;
    supplierNotEstablishedRows: number;
    supplierMismatchRows: number;
    invalidRows: number;
    verifiedRows: number;
    relationshipGaps: number;
    inventoryHistoryGaps: number;
  };
  invalidReasons: Record<string, number>;
  classifications: Array<{
    sourceRow: number;
    classification: Classification;
    invalidReason?: string;
    expectedIdentity: Record<string, unknown>;
  }>;
  discrepancies: OrderDetailsRelationshipDiscrepancy[];
};

function text(value: unknown) {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim()
    ? String(value).trim()
    : undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sameNumber(actual: unknown, expected: unknown) {
  const expectedNumber = numberValue(expected);
  if (expectedNumber === undefined) return true;
  const actualNumber = numberValue(actual);
  return actualNumber !== undefined && Math.abs(actualNumber - expectedNumber) < 0.000001;
}

function idSet(rows: PlainRecord[]) {
  return new Set(rows.map((row) => text(row.id)).filter((id): id is string => Boolean(id)));
}

function classificationReason(row: CsvRowReader) {
  if (!row.string('Order ID', 'ASIN', 'ASIN ', 'SKU', 'SR ID', 'SR ID ')) return 'blank_or_non_actionable';
  return orderRowExclusionReason('order-details', row);
}

function isAcceptedClassification(classification: Classification) {
  return classification === 'full_identity' || classification === 'asin_only_resolvable';
}

export class EcobaseOrderDetailsRelationshipVerifier {
  constructor(private db: EcobaseDatabase) {}

  async verify(
    file: CsvSourceFile,
    params: { runId: string; purpose?: 'production_verification' | 'independent_verification' },
  ): Promise<OrderDetailsRelationshipVerification> {
    const parsed = parseCsv(file.content);
    const rows = parsed.rows.map((raw, index) => {
      const reader = new CsvRowReader(raw);
      return {
        index,
        raw,
        reader,
        identity: orderDetailSourceIdentity(reader),
        sourceRow: index + 2,
        rowHash: bronzePayloadHash(raw),
        invalidReason: classificationReason(reader),
      };
    });
    const classified = rows.map((row) => {
      let classification: Classification;
      if (row.invalidReason) classification = 'invalid_non_actionable';
      else classification = row.identity.sku ? 'full_identity' : 'asin_only_resolvable';
      return { ...row, classification } as typeof row & { classification: Classification };
    });

    const [
      companies,
      supplierRefs,
      products,
      companyProducts,
      supplierProducts,
      orders,
      lines,
      bronzeRows,
      goldResult,
    ] = await Promise.all([
      this.all(ECOBASE_COLLECTIONS.silverCompanies),
      this.all(ECOBASE_COLLECTIONS.silverSupplierExternalRefs),
      this.all(ECOBASE_COLLECTIONS.silverProducts),
      this.all(ECOBASE_COLLECTIONS.silverCompanyProducts),
      this.all(ECOBASE_COLLECTIONS.silverSupplierProducts),
      this.all(ECOBASE_COLLECTIONS.silverOrders),
      this.all(ECOBASE_COLLECTIONS.silverOrderLines),
      this.all(ECOBASE_COLLECTIONS.bronzeSourceRecords),
      new EcobaseInventoryPlanningGoldAccess(this.db).readExplicitListingPerformance({
        runId: params.runId,
        purpose: params.purpose ?? 'production_verification',
        actor: { type: 'system' },
        limit: 100000,
      }),
    ]);
    const gold = goldResult.rows;
    const orderDetailBronzeIds = bronzeRows
      .filter((row) => text(row.sourceDataset)?.toLowerCase().includes('orderdetails'))
      .map((row) => text(row.id))
      .filter((id): id is string => Boolean(id));
    const links = (
      await this.db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).find({
        filter: { bronzeRecordId: { $in: orderDetailBronzeIds } },
        limit: 100000,
      })
    ).map(toPlainRecord);
    const discrepancies: OrderDetailsRelationshipDiscrepancy[] = [];
    let verifiedRows = 0;

    for (const source of classified.filter((row) => isAcceptedClassification(row.classification))) {
      const expectedIdentity = {
        company: source.identity.company?.name,
        orderRef: source.identity.orderRef,
        supplierCode: source.identity.supplierCode,
        asin: source.identity.asin,
        sku: source.identity.sku,
        orderedQty: source.identity.orderedQty,
        unitCost: source.identity.unitCost,
      };
      const actualIds: Record<string, unknown> = {};
      const fail = (reason: string) => {
        discrepancies.push({
          sourceRow: source.sourceRow,
          classification: source.classification,
          expectedIdentity,
          actualIds,
          reason,
        });
      };

      const matchingCompanies = companies.filter((row) => text(row.name) === source.identity.company?.name);
      if (matchingCompanies.length !== 1) {
        fail('canonical_company_not_unique');
        continue;
      }
      const companyId = text(matchingCompanies[0].id);
      actualIds.companyId = companyId;
      const matchingOrders = orders.filter(
        (row) => text(row.companyId) === companyId && text(row.orderRef) === source.identity.orderRef,
      );
      if (matchingOrders.length === 0) {
        source.classification = 'excluded_header_missing';
        source.invalidReason = 'purchase_order_header_missing';
        continue;
      }
      if (matchingOrders.length > 1) {
        actualIds.orderIds = matchingOrders.map((row) => text(row.id));
        fail('canonical_order_not_unique');
        continue;
      }
      const order = matchingOrders[0];
      const orderId = text(order.id);
      actualIds.orderId = orderId;

      const matchingSupplierRefs = supplierRefs.filter(
        (row) =>
          text(row.sourceSystem) === 'supplier_ids' &&
          text(row.normalizedExternalSupplierCode) === source.identity.supplierCode,
      );
      if (matchingSupplierRefs.length === 0) {
        source.classification = 'excluded_supplier_not_established';
        source.invalidReason = 'supplier_not_established';
        continue;
      }
      if (matchingSupplierRefs.length > 1) {
        fail('supplier_external_ref_not_unique');
        continue;
      }
      const supplierId = text(matchingSupplierRefs[0].supplierId);
      actualIds.supplierId = supplierId;
      if (!supplierId || text(order.supplierId) !== supplierId) {
        source.classification = 'excluded_supplier_mismatch';
        source.invalidReason = 'supplier_mismatch_purchase_header';
        continue;
      }

      const productCandidates = products.filter(
        (row) =>
          text(row.asin)?.toUpperCase() === source.identity.asin &&
          (!source.identity.sku || text(row.sku) === source.identity.sku),
      );
      const productIds = idSet(productCandidates);
      const companyProductCandidates = companyProducts.filter(
        (row) => text(row.companyId) === companyId && productIds.has(text(row.productId) ?? ''),
      );
      if (companyProductCandidates.length !== 1) {
        actualIds.companyProductIds = companyProductCandidates.map((row) => text(row.id));
        const identity = source.identity.sku ? 'company_product' : 'asin_only_company_product';
        fail(`${identity}_${companyProductCandidates.length === 0 ? 'not_found' : 'not_unique'}`);
        continue;
      }
      const companyProduct = companyProductCandidates[0];
      const companyProductId = text(companyProduct.id);
      const productId = text(companyProduct.productId);
      actualIds.companyProductId = companyProductId;
      actualIds.productId = productId;

      const supplierProductCandidates = supplierProducts.filter(
        (row) => text(row.supplierId) === supplierId && text(row.productId) === productId,
      );
      if (supplierProductCandidates.length !== 1) {
        actualIds.supplierProductIds = supplierProductCandidates.map((row) => text(row.id));
        fail(supplierProductCandidates.length === 0 ? 'supplier_product_not_found' : 'supplier_product_not_unique');
        continue;
      }
      const supplierProductId = text(supplierProductCandidates[0].id);
      actualIds.supplierProductId = supplierProductId;

      const bronzeCandidates = bronzeRows.filter(
        (row) =>
          text(row.rowHash) === source.rowHash && text(row.sourceDataset)?.toLowerCase().includes('orderdetails'),
      );
      if (bronzeCandidates.length !== 1) {
        actualIds.bronzeRecordIds = bronzeCandidates.map((row) => text(row.id));
        fail('bronze_source_row_not_unique');
        continue;
      }
      const bronze = bronzeCandidates[0];
      const bronzeId = text(bronze.id);
      const sourceLineKey = orderLineSourceKeyForBronze(bronze);
      actualIds.bronzeRecordId = bronzeId;
      actualIds.importRunId = text(bronze.importRunId);
      actualIds.sourceLineKey = sourceLineKey;

      const lineCandidates = lines.filter(
        (row) =>
          text(row.orderId) === orderId &&
          text(row.companyProductId) === companyProductId &&
          text(row.supplierProductId) === supplierProductId &&
          text(row.sourceLineKey) === sourceLineKey,
      );
      if (lineCandidates.length !== 1) {
        actualIds.orderLineIds = lineCandidates.map((row) => text(row.id));
        fail(lineCandidates.length === 0 ? 'silver_order_line_not_found' : 'silver_order_line_not_unique');
        continue;
      }
      const line = lineCandidates[0];
      const lineId = text(line.id);
      actualIds.orderLineId = lineId;
      if (
        !sameNumber(line.orderedQty, source.identity.orderedQty) ||
        !sameNumber(line.unitCost, source.identity.unitCost)
      ) {
        fail('order_line_quantity_or_cost_mismatch');
        continue;
      }
      const evidence = links.filter(
        (row) =>
          text(row.bronzeRecordId) === bronzeId &&
          text(row.silverEntityType) === 'silverOrderLine' &&
          text(row.silverEntityId) === lineId,
      );
      if (evidence.length !== 1) {
        actualIds.normalizationLinkIds = evidence.map((row) => text(row.id));
        fail('normalization_evidence_missing');
        continue;
      }
      actualIds.normalizationLinkId = text(evidence[0].id);
      verifiedRows += 1;
    }

    const latestGoldDate = gold
      .map((row) => text(row.calculationDate) ?? '')
      .sort()
      .at(-1);
    let inventoryHistoryGaps = 0;
    for (const goldRow of gold.filter((row) => !latestGoldDate || text(row.calculationDate) === latestGoldDate)) {
      const companyName = text(goldRow.company);
      const asin = text(goldRow.asin)?.toUpperCase();
      if (!companyName || !asin) continue;
      const sourceRows = classified.filter(
        (row) =>
          isAcceptedClassification(row.classification) &&
          row.identity.company?.name === companyName &&
          row.identity.asin === asin,
      );
      if (sourceRows.length === 0) continue;
      const companyId = text(companies.find((row) => text(row.name) === companyName)?.id);
      const asinProductIds = idSet(products.filter((row) => text(row.asin)?.toUpperCase() === asin));
      const reachableCompanyProductIds = idSet(
        companyProducts.filter(
          (row) => text(row.companyId) === companyId && asinProductIds.has(text(row.productId) ?? ''),
        ),
      );
      const reachableLines = lines.filter((row) => reachableCompanyProductIds.has(text(row.companyProductId) ?? ''));
      if (reachableLines.length > 0) continue;
      inventoryHistoryGaps += 1;
      discrepancies.push({
        sourceRow: sourceRows[0].sourceRow,
        classification: sourceRows[0].classification,
        expectedIdentity: { company: companyName, asin, sku: text(goldRow.sku) },
        actualIds: { goldRowId: text(goldRow.id), companyProductId: text(goldRow.companyProductId) },
        reason: 'inventory_order_history_not_reachable',
      });
    }

    const invalidReasons = Object.fromEntries(
      [
        ...new Set(classified.map((row) => row.invalidReason).filter((reason): reason is string => Boolean(reason))),
      ].map((reason) => [reason, classified.filter((row) => row.invalidReason === reason).length]),
    );
    const relationshipGaps = discrepancies.length - inventoryHistoryGaps;
    const totals = {
      sourceRows: classified.length,
      acceptedRows: classified.filter((row) => isAcceptedClassification(row.classification)).length,
      fullIdentityRows: classified.filter((row) => row.classification === 'full_identity').length,
      asinOnlyRows: classified.filter((row) => row.classification === 'asin_only_resolvable').length,
      headerMissingRows: classified.filter((row) => row.classification === 'excluded_header_missing').length,
      supplierNotEstablishedRows: classified.filter((row) => row.classification === 'excluded_supplier_not_established')
        .length,
      supplierMismatchRows: classified.filter((row) => row.classification === 'excluded_supplier_mismatch').length,
      invalidRows: classified.filter((row) => row.classification === 'invalid_non_actionable').length,
      verifiedRows,
      relationshipGaps,
      inventoryHistoryGaps,
    };
    const classifications = classified.map((row) => ({
      sourceRow: row.sourceRow,
      classification: row.classification,
      invalidReason: row.invalidReason,
      expectedIdentity: {
        company: row.identity.company?.name,
        orderRef: row.identity.orderRef,
        supplierCode: row.identity.supplierCode,
        asin: row.identity.asin,
        sku: row.identity.sku,
        orderedQty: row.identity.orderedQty,
        unitCost: row.identity.unitCost,
      },
    }));
    return {
      ok: discrepancies.length === 0,
      fileName: file.name,
      totals,
      invalidReasons,
      classifications,
      discrepancies,
    };
  }

  private async all(collection: string) {
    return (await this.db.getRepository(collection).find({ limit: 100000 })).map(toPlainRecord);
  }
}
