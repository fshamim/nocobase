/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { parseCsv } from '../../features/source-import/server/adapters/csv-utils';
import { bronzePayloadHash } from '../../features/source-import/server/bronze-import-service';
import { orderLineSourceKeyForBronze } from '../../features/semantic-model/server/medallion-normalization-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { EcobaseOrderDetailsRelationshipVerifier } from '../../features/source-import/server/order-details-relationship-verifier';

type Row = Record<string, unknown>;

class MemoryRepository implements EcobaseRepository {
  constructor(public rows: Row[] = []) {}
  async find() {
    return this.rows;
  }
  async findOne() {
    return this.rows[0] ?? null;
  }
  async create({ values }: { values: Row }) {
    this.rows.push(values);
    return values;
  }
  async update() {
    return null;
  }
}

class MemoryDatabase implements EcobaseDatabase {
  private repositories = new Map<string, MemoryRepository>();
  getRepository(name: string) {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryRepository();
      this.repositories.set(name, repository);
    }
    return repository;
  }
}

function verifierFixture({ includeLine = true } = {}) {
  const db = new MemoryDatabase();
  const row = {
    'Order ID': 'EF1001A',
    Company: 'Ecofission LLC',
    'SR ID': 'SRO-1',
    Supplier: 'Supplier One',
    ASIN: 'B000VERIFY',
    SKU: 'ALIAS-SKU',
    Qty: '4',
    PPU: '2.5',
  };
  const content = [
    'Order ID,Company,SR ID,Supplier,ASIN,SKU,Qty,PPU',
    'EF1001A,Ecofission LLC,SRO-1,Supplier One,B000VERIFY,ALIAS-SKU,4,2.5',
    'EF1001A,Ecofission LLC,SRO-1,Supplier One,B000VERIFY,ALIAS-SKU,4,2.5',
  ].join('\n');
  const parsedRow = parseCsv(content).rows[0];
  expect(parsedRow).toEqual(row);
  const rowHash = bronzePayloadHash(parsedRow);
  const sourceRecordKey = 'OrderDetails.csv:B000VERIFY:ALIAS-SKU';
  const lineId = 'line-1';

  db.getRepository(ECOBASE_COLLECTIONS.silverCompanies).rows.push({ id: 'company-1', name: 'Ecofission LLC' });
  db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs).rows.push({
    id: 'supplier-ref-1',
    sourceSystem: 'supplier_ids',
    normalizedExternalSupplierCode: 'SRO-1',
    supplierId: 'supplier-1',
  });
  db.getRepository(ECOBASE_COLLECTIONS.silverProducts).rows.push(
    { id: 'product-alias', asin: 'B000VERIFY', sku: 'ALIAS-SKU' },
    { id: 'product-primary', asin: 'B000VERIFY', sku: 'PRIMARY-SKU' },
  );
  db.getRepository(ECOBASE_COLLECTIONS.silverCompanyProducts).rows.push(
    { id: 'company-product-alias', companyId: 'company-1', productId: 'product-alias' },
    { id: 'company-product-primary', companyId: 'company-1', productId: 'product-primary' },
  );
  db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows.push({
    id: 'supplier-product-1',
    supplierId: 'supplier-1',
    productId: 'product-alias',
  });
  db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.push({
    id: 'order-1',
    companyId: 'company-1',
    supplierId: 'supplier-1',
    orderRef: 'EF1001A',
  });
  db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords).rows.push({
    id: 'bronze-1',
    importRunId: 'run-1',
    sourceDataset: 'OrderDetails.csv',
    sourceRecordKey,
    rowHash,
    payload: parsedRow,
  });
  if (includeLine) {
    db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows.push({
      id: lineId,
      orderId: 'order-1',
      companyProductId: 'company-product-alias',
      supplierProductId: 'supplier-product-1',
      sourceLineKey: orderLineSourceKeyForBronze({ sourceRecordKey, rowHash }),
      orderedQty: 4,
      unitCost: 2.5,
    });
    db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks).rows.push({
      id: 'link-1',
      bronzeRecordId: 'bronze-1',
      silverEntityType: 'silverOrderLine',
      silverEntityId: lineId,
    });
  }
  db.getRepository(ECOBASE_COLLECTIONS.goldInventoryPlanningRows).rows.push({
    id: 'gold-primary',
    calculationDate: '2026-07-10',
    company: 'Ecofission LLC',
    asin: 'B000VERIFY',
    sku: 'PRIMARY-SKU',
    companyProductId: 'company-product-primary',
  });
  return { db, file: { name: 'OrderDetails.csv', content } };
}

describe('EcobaseOrderDetailsRelationshipVerifier', () => {
  it('verifies only the newest repeated row and primary-SKU history through an alias SKU line', async () => {
    const { db, file } = verifierFixture();

    const result = await new EcobaseOrderDetailsRelationshipVerifier(db).verify(file);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.totals).toMatchObject({
      sourceRows: 2,
      acceptedRows: 1,
      supersededRows: 1,
      verifiedRows: 1,
      relationshipGaps: 0,
      inventoryHistoryGaps: 0,
    });
  });

  it('classifies a source supplier that disagrees with the Purchase Orders header as excluded', async () => {
    const { db, file } = verifierFixture();
    db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0].supplierId = 'another-supplier';

    const result = await new EcobaseOrderDetailsRelationshipVerifier(db).verify(file);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.totals).toMatchObject({ acceptedRows: 0, supplierMismatchRows: 1, relationshipGaps: 0 });
    expect(result.invalidReasons).toMatchObject({ supplier_mismatch_purchase_header: 1 });
  });

  it('reports both a broken silver chain and unreachable inventory history', async () => {
    const { db, file } = verifierFixture({ includeLine: false });

    const result = await new EcobaseOrderDetailsRelationshipVerifier(db).verify(file);

    expect(result.ok).toBe(false);
    expect(result.totals).toMatchObject({ relationshipGaps: 1, inventoryHistoryGaps: 1 });
    expect(result.discrepancies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'silver_order_line_not_unique' }),
        expect.objectContaining({ reason: 'inventory_order_history_not_reachable' }),
      ]),
    );
  });
});
