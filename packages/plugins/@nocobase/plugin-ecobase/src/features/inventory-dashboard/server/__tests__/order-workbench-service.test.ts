/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../../../../server/collections/names';
import { EcobaseOrderWorkbenchService, OrderWorkbenchError } from '../order-workbench-service';

type PlainRecord = Record<string, unknown>;

function matchesFilter(row: PlainRecord, filter?: PlainRecord): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or' && Array.isArray(value)) {
      return (value as PlainRecord[]).some((sub) => matchesFilter(row, sub));
    }
    if (key === 'transaction') return true;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const clause = value as Record<string, unknown>;
      if (Array.isArray(clause.$in)) return clause.$in.includes(row[key]);
      if (typeof clause.$includes === 'string') {
        return String(row[key] ?? '')
          .toLowerCase()
          .includes(clause.$includes.toLowerCase());
      }
    }
    return row[key] === value;
  });
}

function sortRows(rows: PlainRecord[], sort?: string[]): PlainRecord[] {
  if (!sort || sort.length === 0) return rows;
  const [spec] = sort;
  const desc = spec.startsWith('-');
  const field = desc ? spec.slice(1) : spec;
  return [...rows].sort((left, right) => {
    const a = String(left[field] ?? '');
    const b = String(right[field] ?? '');
    return desc ? b.localeCompare(a) : a.localeCompare(b);
  });
}

class FakeRepository {
  rows: PlainRecord[] = [];

  async find(params?: { filter?: PlainRecord; limit?: number; sort?: string[] }) {
    const rows = sortRows(
      this.rows.filter((row) => matchesFilter(row, params?.filter)),
      params?.sort,
    );
    return typeof params?.limit === 'number' ? rows.slice(0, params.limit) : rows;
  }

  async findOne(params?: { filter?: PlainRecord; filterByTk?: string | number }) {
    if (params?.filterByTk !== undefined) return this.rows.find((row) => row.id === params.filterByTk) ?? null;
    return this.rows.find((row) => matchesFilter(row, params?.filter)) ?? null;
  }

  async count(params?: { filter?: PlainRecord }) {
    return this.rows.filter((row) => matchesFilter(row, params?.filter)).length;
  }

  async create(params: { values: PlainRecord }) {
    const values = { updatedAt: new Date().toISOString(), ...params.values };
    this.rows.push({ ...values });
    return values;
  }

  async update(params: { filterByTk?: string | number; filter?: PlainRecord; values: PlainRecord }) {
    const rows = this.rows.filter((row) =>
      params.filterByTk !== undefined ? row.id === params.filterByTk : matchesFilter(row, params.filter),
    );
    rows.forEach((row) => Object.assign(row, params.values));
    return rows[0] ?? null;
  }

  async destroy(params: { filterByTk?: string | number; filter?: PlainRecord }) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) =>
      params.filterByTk !== undefined ? row.id !== params.filterByTk : !matchesFilter(row, params.filter),
    );
    return before - this.rows.length;
  }
}

class FakeDatabase {
  repositories = new Map<string, FakeRepository>();

  getRepository(name: string) {
    const existing = this.repositories.get(name);
    if (existing) return existing;
    const repo = new FakeRepository();
    this.repositories.set(name, repo);
    return repo;
  }

  seed(name: string, rows: PlainRecord[]) {
    const repo = this.getRepository(name);
    repo.rows.push(...rows.map((row) => ({ ...row })));
  }
}

const COMPANY_ID = 'company-ef';
const SUPPLIER_ID = 'supplier-1';

function buildDatabase() {
  const db = new FakeDatabase();
  db.seed(ECOBASE_COLLECTIONS.silverCompanies, [{ id: COMPANY_ID, name: 'Ecofission LLC', companyKey: 'EF' }]);
  db.seed(ECOBASE_COLLECTIONS.silverSuppliers, [
    { id: SUPPLIER_ID, displayName: 'allied piano and finish', normalizedName: 'alliedpianoandfinish' },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverProducts, [
    { id: 'product-1', asin: 'B007P55HOW', sku: 'DC-50944', title: 'Piano Humidifier Pads', brand: 'Dampp-Chaser' },
    { id: 'product-2', asin: 'B00948OEPQ', sku: 'DC-UHP-2', title: 'Humidifier Treatment 16oz', brand: 'Dampp-Chaser' },
  ]);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProductFamilies, [{ id: 'family-1' }]);
  db.seed(ECOBASE_COLLECTIONS.silverCompanyProducts, [
    { id: 'cp-1', companyId: COMPANY_ID, productId: 'product-1', companyProductFamilyId: 'family-1' },
    { id: 'cp-2', companyId: COMPANY_ID, productId: 'product-2', companyProductFamilyId: 'family-1' },
  ]);
  return db;
}

async function createSampleOrder(service: EcobaseOrderWorkbenchService, orderRef?: string) {
  return service.createOrder({
    companyId: COMPANY_ID,
    orderRef,
    orderDate: '2026-07-24',
    supplierId: SUPPLIER_ID,
    sourceMarketplace: 'US',
    actorUserId: '4',
    actorDisplayName: 'Farhan Shamim',
    lines: [
      { companyProductId: 'cp-1', orderedQty: 72, unitCost: 8.43, expectedSellPrice: 19.95 },
      { companyProductId: 'cp-2', orderedQty: 36, unitCost: 16.87, expectedSellPrice: 34.9 },
    ],
  });
}

describe('EcobaseOrderWorkbenchService', () => {
  let db: FakeDatabase;
  let service: EcobaseOrderWorkbenchService;

  beforeEach(() => {
    db = buildDatabase();
    service = new EcobaseOrderWorkbenchService(db as never);
  });

  it('creates a manual draft order with the supplier display name, summed cost, and manual provenance', async () => {
    const detail = await createSampleOrder(service, 'EF072426A');
    expect(detail.header.orderRef).toBe('EF072426A');
    expect(detail.header.orderIntent).toBe('manual');
    expect(detail.header.lifecycleStatus).toBe('draft');
    expect(detail.header.canonicalStatus).toBe('draft');
    expect(detail.header.placedBy).toBe('Farhan Shamim');
    // Red-proof: the drawer must render the supplier's display name, never the id.
    expect(detail.header.supplierName).toBe('allied piano and finish');
    expect(detail.header.supplierName).not.toBe(SUPPLIER_ID);
    expect(detail.header.expectedCost).toBe(1214.28);
    expect(detail.header.productCount).toBe(2);
    expect(detail.header.orderedUnits).toBe(108);

    const orderRow = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    expect(orderRow.dailySequenceLetter).toBe('A');
    expect(orderRow.statusSource).toBe('operator');
    // The engine reads canonicalStatus 'draft' → placed_not_purchased → activeOrders.
    expect(orderRow.canonicalStatus).toBe('draft');

    const lineRows = db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows;
    expect(lineRows).toHaveLength(2);
    expect(lineRows[0].companyProductId).toBe('cp-1');
    // The silver_order_lines_mapping_scope_check constraint shape for manual lines.
    expect(lineRows[0].mappingScope).toBe('exact_member');
    expect(lineRows[0].companyProductFamilyId).toBe('family-1');
    // supplier-product upsert created a link for the ordering supplier + product.
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverSupplierProducts).rows).toHaveLength(2);
    // Computed gross margin was persisted on the line.
    expect(lineRows[0].expectedMargin).toBeCloseTo(57.7, 1);
  });

  it('rejects a duplicate order reference with a 409-style error (no silent reuse)', async () => {
    await createSampleOrder(service, 'EF072426A');
    await expect(createSampleOrder(service, 'EF072426A')).rejects.toMatchObject({
      status: 409,
    });
    // Only one order row exists — the collision did not append lines to the first order.
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toHaveLength(1);
  });

  it('forbids deleting the last remaining line', async () => {
    const detail = await createSampleOrder(service);
    const [first, second] = detail.lines;
    await service.deleteOrderLine({ orderLineId: second.id });
    await expect(service.deleteOrderLine({ orderLineId: first.id })).rejects.toBeInstanceOf(OrderWorkbenchError);
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrderLines).rows).toHaveLength(1);
  });

  it('hard-deletes a manual order but cancels an imported one', async () => {
    const detail = await createSampleOrder(service);
    const manual = await service.deleteOrder({ orderId: detail.header.id });
    expect(manual.action).toBe('deleted');
    expect(db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows).toHaveLength(0);

    db.seed(ECOBASE_COLLECTIONS.silverOrders, [
      {
        id: 'imported-1',
        companyId: COMPANY_ID,
        supplierId: SUPPLIER_ID,
        orderRef: 'EF010101A',
        orderIntent: 'source_import',
        lifecycleStatus: 'ORDERED',
        canonicalStatus: 'paid',
      },
    ]);
    const imported = await service.deleteOrder({ orderId: 'imported-1' });
    expect(imported.action).toBe('cancelled');
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows.find((r) => r.id === 'imported-1')!;
    expect(row.canonicalStatus).toBe('cancelled');
    expect(row.statusSource).toBe('operator');
  });

  it('setOrderStatus writes the mapped lifecycle + canonical + workflow stage through the operator path', async () => {
    const detail = await createSampleOrder(service);
    const updated = await service.setOrderStatus({
      orderId: detail.header.id,
      status: 'INBOUND MONITORING',
      actorUserId: '4',
    });
    expect(updated.header.lifecycleStatus).toBe('INBOUND MONITORING');
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    expect(row.canonicalStatus).toBe('shipped_inbound');
    expect(row.workflowStage).toBe('amazon_inbound');
    expect(row.statusSource).toBe('operator');
    // Integer NocoBase user ids stay OUT of the uuid column; the actor is recorded in evidence.
    expect(row.operatorStatusOverrideByUserId).toBeUndefined();
    expect(row.statusEvidenceJson).toMatchObject({ actorUserId: '4' });
  });

  it('productOptions searches the company catalog in the DB before limiting', async () => {
    const byAsin = await service.productOptions({ companyId: COMPANY_ID, search: 'B00948OEPQ' });
    expect(byAsin).toHaveLength(1);
    expect(byAsin[0]).toMatchObject({ companyProductId: 'cp-2', title: 'Humidifier Treatment 16oz' });

    const byTitle = await service.productOptions({ companyId: COMPANY_ID, search: 'piano' });
    expect(byTitle.map((option) => option.companyProductId)).toEqual(['cp-1']);
  });

  it('prepareOrderDraft returns a canonical suggested ref and product identity', async () => {
    const draft = await service.prepareOrderDraft({ planningProductId: 'cp-1' });
    expect(draft.companyId).toBe(COMPANY_ID);
    expect(draft.product).toMatchObject({
      companyProductId: 'cp-1',
      asin: 'B007P55HOW',
      title: 'Piano Humidifier Pads',
    });
    expect(draft.suggestedOrderRef).toMatch(/^EF\d{6}[A-Z]$/);
  });

  // Red-proof for the staging 500: NocoBase user ids are integers ("1"), while
  // createdByUserId / operatorStatusOverrideByUserId are uuid columns in postgres.
  // Integer actor ids must never be written into those columns.
  it('never writes non-uuid actor ids into uuid-typed columns; actor lands in evidence + placedBy', async () => {
    await createSampleOrder(service, 'EF072426A'); // actorUserId '4'
    const orderRow = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    expect(orderRow.createdByUserId).toBeUndefined();
    expect(orderRow.operatorStatusOverrideByUserId).toBeUndefined();
    expect(orderRow.placedBy).toBe('Farhan Shamim');
    expect(orderRow.statusEvidenceJson).toMatchObject({ actorUserId: '4', actorName: 'Farhan Shamim' });

    await service.setOrderStatus({ orderId: String(orderRow.id), status: 'ORDERED', actorUserId: '4' });
    expect(orderRow.operatorStatusOverrideByUserId).toBeUndefined();
    expect(orderRow.statusEvidenceJson).toMatchObject({ action: 'set_status', actorUserId: '4' });
  });

  it('keeps genuine uuid actor ids on the uuid columns', async () => {
    const uuidActor = '6b3a2c9e-1d2f-4a5b-8c7d-9e0f1a2b3c4d';
    await service.createOrder({
      companyId: COMPANY_ID,
      orderRef: 'EF072426B',
      orderDate: '2026-07-24',
      supplierId: SUPPLIER_ID,
      actorUserId: uuidActor,
      lines: [{ companyProductId: 'cp-1', orderedQty: 1, unitCost: 2 }],
    });
    const orderRow = db
      .getRepository(ECOBASE_COLLECTIONS.silverOrders)
      .rows.find((row) => row.orderRef === 'EF072426B');
    expect(orderRow?.createdByUserId).toBe(uuidActor);
  });

  it('prepareOrderDraft falls back to the family preferred supplier when no supplier-product link exists', async () => {
    const family = db
      .getRepository(ECOBASE_COLLECTIONS.silverCompanyProductFamilies)
      .rows.find((row) => row.id === 'family-1');
    if (family) family.preferredSupplierId = SUPPLIER_ID;
    const draft = await service.prepareOrderDraft({ planningProductId: 'cp-1' });
    expect(draft.supplierDefault).toMatchObject({
      supplierId: SUPPLIER_ID,
      displayName: 'allied piano and finish',
    });
  });

  // ---- T2.1 status-stamp matrix -------------------------------------------

  const OLD_STAMP = '2000-01-01T00:00:00.000Z';

  it('setOrderStatus leaves both clocks untouched on a same-status re-set', async () => {
    const detail = await createSampleOrder(service);
    await service.setOrderStatus({ orderId: detail.header.id, status: 'ORDERED' });
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    row.statusChangedAt = OLD_STAMP;
    row.workflowStageEnteredAt = OLD_STAMP;
    await service.setOrderStatus({ orderId: detail.header.id, status: 'ORDERED' });
    expect(row.statusChangedAt).toBe(OLD_STAMP);
    expect(row.workflowStageEnteredAt).toBe(OLD_STAMP);
  });

  it('setOrderStatus resets statusChangedAt but NOT the stage clock on a same-stage status change', async () => {
    const detail = await createSampleOrder(service);
    await service.setOrderStatus({ orderId: detail.header.id, status: 'ORDERED' }); // in_prep
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    row.statusChangedAt = OLD_STAMP;
    row.workflowStageEnteredAt = OLD_STAMP;
    await service.setOrderStatus({ orderId: detail.header.id, status: 'IN TRANSIT TO PREP' }); // still in_prep
    expect(row.statusChangedAt).not.toBe(OLD_STAMP);
    expect(row.workflowStageEnteredAt).toBe(OLD_STAMP);
  });

  it('setOrderStatus resets BOTH clocks on a stage change', async () => {
    const detail = await createSampleOrder(service);
    await service.setOrderStatus({ orderId: detail.header.id, status: 'ORDERED' }); // in_prep
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    row.statusChangedAt = OLD_STAMP;
    row.workflowStageEnteredAt = OLD_STAMP;
    await service.setOrderStatus({ orderId: detail.header.id, status: 'INBOUND MONITORING' }); // amazon_inbound
    expect(row.statusChangedAt).not.toBe(OLD_STAMP);
    expect(row.workflowStageEnteredAt).not.toBe(OLD_STAMP);
  });

  // ---- T2.4 confirmInboundCompletion guards --------------------------------

  it('confirmInboundCompletion rejects an order that is not in inbound monitoring', async () => {
    const detail = await createSampleOrder(service);
    await expect(service.confirmInboundCompletion({ orderId: detail.header.id })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('confirmInboundCompletion rejects when no Amazon arrival is detected, then completes once it is', async () => {
    const detail = await createSampleOrder(service);
    await service.setOrderStatus({ orderId: detail.header.id, status: 'INBOUND MONITORING' });
    await expect(service.confirmInboundCompletion({ orderId: detail.header.id })).rejects.toMatchObject({
      status: 400,
    });
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    row.amazonReceiptStatus = 'amazon_stock_observed';
    const completed = await service.confirmInboundCompletion({ orderId: detail.header.id, actorUserId: '4' });
    expect(completed.header.lifecycleStatus).toBe('COMPLETE');
    expect(row.canonicalStatus).toBe('completed');
    expect(row.workflowStage).toBe('complete');
    expect(row.statusEvidenceJson).toMatchObject({ action: 'confirm_inbound_completion', actorUserId: '4' });
    expect(row.statusChangedAt).toBeTruthy();
    expect(row.workflowStageEnteredAt).toBeTruthy();
  });

  // ---- T2.3 updatePrepDetails ----------------------------------------------

  it('updatePrepDetails writes the whitelist, stamps the audit fields, and keeps integer actor ids off the uuid column', async () => {
    const detail = await createSampleOrder(service);
    await service.updatePrepDetails({
      orderId: detail.header.id,
      prepBoxes: 2,
      prepUnits: 108,
      prepDimensions: { length: 21, breadth: 13, height: 7 },
      prepWeightValue: 25,
      prepWeightUnit: 'lbs',
      hazmatFlag: false,
      shippingId: 'FBA185R9Z2W',
      labelFilesLink: 'https://example.com/labels',
      prepStatus: 'Completed',
      actorUserId: '4',
    });
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    expect(row.prepBoxes).toBe(2);
    expect(row.prepUnits).toBe(108);
    expect(row.prepDimensions).toEqual({ length: 21, breadth: 13, height: 7 });
    expect(row.prepWeightValue).toBe(25);
    expect(row.prepWeightUnit).toBe('lbs');
    expect(row.hazmatFlag).toBe(false);
    expect(row.shippingId).toBe('FBA185R9Z2W');
    expect(row.labelFilesLink).toBe('https://example.com/labels');
    expect(row.prepStatus).toBe('Completed');
    expect(row.prepDetailsUpdatedAt).toBeTruthy();
    expect(row.prepDetailsUpdatedByUserId).toBeUndefined();
  });

  it('updatePrepDetails rejects unknown fields and bad values', async () => {
    const detail = await createSampleOrder(service);
    await expect(
      service.updatePrepDetails({ orderId: detail.header.id, somethingElse: 1 } as never),
    ).rejects.toBeInstanceOf(OrderWorkbenchError);
    await expect(
      service.updatePrepDetails({ orderId: detail.header.id, prepWeightUnit: 'stone' }),
    ).rejects.toBeInstanceOf(OrderWorkbenchError);
    await expect(
      service.updatePrepDetails({ orderId: detail.header.id, labelFilesLink: 'not-a-url' }),
    ).rejects.toBeInstanceOf(OrderWorkbenchError);
  });

  // ---- T2.2 updateOrderPaperwork -------------------------------------------

  it('updateOrderPaperwork writes only the milestone whitelist and never stamps statusChangedAt', async () => {
    const detail = await createSampleOrder(service);
    await service.updateOrderPaperwork({
      orderId: detail.header.id,
      orderApproval: 'Approved',
      paymentStatus: 'Completed',
      paymentMode: 'ACH',
      paymentDate: '2026-07-20',
      invoiceStatus: 'Uploaded',
    });
    const row = db.getRepository(ECOBASE_COLLECTIONS.silverOrders).rows[0];
    expect(row.orderApproval).toBe('Approved');
    expect(row.paymentStatus).toBe('Completed');
    expect(row.paymentMode).toBe('ACH');
    expect(row.paymentDate).toBe('2026-07-20');
    expect(row.invoiceStatus).toBe('Uploaded');
    expect(row.statusChangedAt).toBeUndefined();
  });

  // ---- T2.5 paneOrders ------------------------------------------------------

  function seedRun(runId: string, orderId: string) {
    db.seed(ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns, [
      { id: runId, status: 'published', publishedAt: '2026-07-25T00:00:00.000Z', calculationDate: '2026-07-25' },
    ]);
    db.seed(ECOBASE_COLLECTIONS.goldInventoryPlanningRows, [
      {
        id: 'g1',
        refreshRunId: runId,
        supplierOrderId: orderId,
        companyProductId: 'cp-1',
        primaryActionPane: 'activeOrders',
        estimatedProfitRisk: 100,
        estimatedOosDate: '2026-08-01',
      },
      {
        id: 'g2',
        refreshRunId: runId,
        supplierOrderId: orderId,
        companyProductId: 'cp-2',
        primaryActionPane: 'activeOrders',
        estimatedProfitRisk: 250,
        estimatedOosDate: null,
      },
    ]);
  }

  it('paneOrders builds an order row with pessimistic money-at-risk when the ETA is unknown', async () => {
    const detail = await createSampleOrder(service, 'EF072426A');
    seedRun('run-1', detail.header.id);
    const result = await service.paneOrders({ pane: 'activeOrders', runId: 'run-1' });
    if ('runSuperseded' in result) throw new Error('unexpected superseded result');
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.orderId).toBe(detail.header.id);
    expect(row.units).toBe(108);
    expect(row.productCount).toBe(2);
    // No ETA on the order → both products pessimistically at risk (100 + 250).
    expect(row.atRiskProductCount).toBe(2);
    expect(row.moneyAtRisk).toBe(350);
    expect(row.supplierName).toBe('allied piano and finish');
  });

  it('paneOrders signals runSuperseded when the pinned run is stale', async () => {
    const detail = await createSampleOrder(service);
    seedRun('run-2', detail.header.id);
    const result = await service.paneOrders({ pane: 'activeOrders', runId: 'run-OLD' });
    expect(result).toMatchObject({ runSuperseded: true, publishedRunId: 'run-2' });
  });

  it('paneOrders returns an empty envelope when nothing is published', async () => {
    const result = await service.paneOrders({ pane: 'activeOrders', runId: 'run-x' });
    expect(result).toMatchObject({ publishedRunId: '', rows: [] });
  });
});
