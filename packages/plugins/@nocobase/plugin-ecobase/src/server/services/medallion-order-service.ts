import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from './import-service';
import { toPlainRecord } from './import-service';
import { normalizeCompanyKey } from './medallion-identity-service';

const SEQUENCE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export interface CreateDraftOrderParams {
  companyId: string;
  supplierId: string;
  supplierAccountId?: string;
  orderDate: string;
  orderIntent?: string;
  fulfillmentRoute?: string;
  expectedDeliveryDate?: string;
  remarks?: string;
  actorUserId?: string;
}

export interface CreateOrderLineParams {
  orderId: string;
  companyProductId: string;
  supplierProductId: string;
  orderedQty: number;
  confirmedQty?: number;
  unitCost?: number;
  expectedSellPrice?: number;
  expectedMargin?: number;
  expectedProfit?: number;
  supplierPackSize?: number;
  fbaExpectedPackSize?: number;
  prepInstruction?: string;
  expectedDeliveryDate?: string;
  expectedSellableDate?: string;
  upc?: string;
  mapPrice?: number;
  productAnalysisStatus?: string;
  priority?: string;
}

export interface CreateNormalInvoiceParams {
  orderId: string;
  invoiceNumber: string;
  status?: string;
  fileUrl?: string;
  submittedByUserId?: string;
  amount?: number;
  paymentMode?: string;
  paidAt?: string;
  remarks?: string;
}

export class EcobaseMedallionOrderService {
  constructor(private db: EcobaseDatabase) {}

  async generateOrderRef(companyId: string, orderDate: string) {
    const company = await this.requireRecord(ECOBASE_COLLECTIONS.silverCompanies, companyId, 'company');
    const companyKey = normalizeCompanyKey(String(toPlainRecord(company).companyKey ?? ''));
    const date = normalizeDate(orderDate, 'orderDate');
    const used = new Set(
      (await this.repo(ECOBASE_COLLECTIONS.silverOrders).find({ filter: { companyId, orderDate: date } }))
        .map((record) => String(toPlainRecord(record).dailySequenceLetter ?? ''))
        .filter(Boolean),
    );
    const letter = SEQUENCE_LETTERS.find((candidate) => !used.has(candidate));
    if (!letter) {
      throw new Error(
        `Ecobase medallion order failed: no order reference letters remain for ${companyKey} on ${date}.`,
      );
    }
    return { orderRef: `${companyKey}${date.slice(5, 7)}${date.slice(8, 10)}${date.slice(2, 4)}${letter}`, letter };
  }

  async createDraftOrder(params: CreateDraftOrderParams) {
    await this.requireRecord(ECOBASE_COLLECTIONS.silverCompanies, params.companyId, 'company');
    await this.requireRecord(ECOBASE_COLLECTIONS.silverSuppliers, params.supplierId, 'supplier');
    if (params.supplierAccountId) {
      await this.requireRecord(
        ECOBASE_COLLECTIONS.silverSupplierAccounts,
        params.supplierAccountId,
        'supplier account',
      );
    }
    const orderDate = normalizeDate(params.orderDate, 'orderDate');
    const reference = await this.generateOrderRef(params.companyId, orderDate);
    return this.repo(ECOBASE_COLLECTIONS.silverOrders).create({
      values: cleanValues({
        id: randomUUID(),
        companyId: params.companyId,
        supplierId: params.supplierId,
        supplierAccountId: params.supplierAccountId,
        orderRef: reference.orderRef,
        orderDate,
        dailySequenceLetter: reference.letter,
        orderIntent: params.orderIntent ?? 'operator_draft',
        createdByUserId: params.actorUserId,
        lifecyclePhase: 'draft',
        lifecycleStatus: 'draft',
        nextAction: 'supplier_confirmation',
        fulfillmentRoute: params.fulfillmentRoute ?? 'unknown',
        expectedDeliveryDate: params.expectedDeliveryDate
          ? normalizeDate(params.expectedDeliveryDate, 'expectedDeliveryDate')
          : undefined,
        remarks: params.remarks,
      }),
    });
  }

  async createOrderLine(params: CreateOrderLineParams) {
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, params.orderId, 'order');
    const companyProduct = await this.requireRecord(
      ECOBASE_COLLECTIONS.silverCompanyProducts,
      params.companyProductId,
      'company product',
    );
    const supplierProduct = await this.requireRecord(
      ECOBASE_COLLECTIONS.silverSupplierProducts,
      params.supplierProductId,
      'supplier product',
    );
    if (toPlainRecord(companyProduct).companyId !== toPlainRecord(order).companyId) {
      throw new Error('Ecobase medallion order failed: company product belongs to a different company.');
    }
    if (toPlainRecord(supplierProduct).supplierId !== toPlainRecord(order).supplierId) {
      throw new Error('Ecobase medallion order failed: supplier product belongs to a different supplier.');
    }
    if (!Number.isFinite(params.orderedQty) || params.orderedQty <= 0) {
      throw new Error('Ecobase medallion order failed: orderedQty must be greater than zero.');
    }
    return this.repo(ECOBASE_COLLECTIONS.silverOrderLines).create({
      values: cleanValues({
        id: randomUUID(),
        orderId: params.orderId,
        companyProductId: params.companyProductId,
        supplierProductId: params.supplierProductId,
        orderedQty: params.orderedQty,
        confirmedQty: params.confirmedQty,
        unitCost: params.unitCost,
        expectedSellPrice: params.expectedSellPrice,
        expectedMargin: params.expectedMargin,
        expectedProfit: params.expectedProfit,
        supplierPackSize: params.supplierPackSize,
        fbaExpectedPackSize: params.fbaExpectedPackSize,
        prepInstruction: params.prepInstruction,
        expectedDeliveryDate: params.expectedDeliveryDate
          ? normalizeDate(params.expectedDeliveryDate, 'expectedDeliveryDate')
          : undefined,
        expectedSellableDate: params.expectedSellableDate
          ? normalizeDate(params.expectedSellableDate, 'expectedSellableDate')
          : undefined,
        upc: params.upc,
        mapPrice: params.mapPrice,
        productAnalysisStatus: params.productAnalysisStatus ?? 'unknown',
        priority: params.priority,
      }),
    });
  }

  async createNormalInvoice(params: CreateNormalInvoiceParams) {
    await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, params.orderId, 'order');
    const invoiceNumber = requiredText(params.invoiceNumber, 'invoiceNumber');
    const repo = this.repo(ECOBASE_COLLECTIONS.silverInvoices);
    const values = cleanValues({
      invoiceNumber,
      invoiceType: 'normal',
      status: params.status ?? 'waiting',
      fileUrl: params.fileUrl,
      submittedByUserId: params.submittedByUserId,
      amount: params.amount,
      paymentMode: params.paymentMode,
      paidAt: params.paidAt,
      remarks: params.remarks,
    });
    const existing = await repo.findOne({ filter: { orderId: params.orderId, invoiceType: 'normal' } });
    if (existing) {
      await repo.update({ filterByTk: idOf(existing), values });
      return this.requireRecord(ECOBASE_COLLECTIONS.silverInvoices, idOf(existing), 'invoice');
    }
    return repo.create({ values: { id: randomUUID(), orderId: params.orderId, ...values } });
  }

  async updateOrderRef(orderId: string, orderRef: string, actorUserId?: string) {
    const order = await this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, orderId, 'order');
    const currentRef = String(toPlainRecord(order).orderRef ?? '');
    const nextRef = requiredText(orderRef, 'orderRef');
    if (currentRef === nextRef) return order;
    await this.repo(ECOBASE_COLLECTIONS.silverOrders).update({ filterByTk: orderId, values: { orderRef: nextRef } });
    await this.repo(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: cleanValues({
        id: randomUUID(),
        entityType: ECOBASE_COLLECTIONS.silverOrders,
        entityId: orderId,
        actorType: actorUserId ? 'user' : 'system',
        actorUserId,
        commentType: 'order_ref_edited',
        body: `Order reference changed from ${currentRef} to ${nextRef}.`,
        contextSnapshotJson: { previousOrderRef: currentRef, nextOrderRef: nextRef },
        workflowDetectionStatus: 'none',
      }),
    });
    return this.requireRecord(ECOBASE_COLLECTIONS.silverOrders, orderId, 'order');
  }

  private async requireRecord(collectionName: string, id: string | undefined, label: string) {
    if (!id) throw new Error(`Ecobase medallion order failed: ${label} id is required.`);
    const record = await this.repo(collectionName).findOne({ filterByTk: id });
    if (!record) throw new Error(`Ecobase medallion order failed: ${label} ${id} does not exist.`);
    return record;
  }

  private repo(name: string) {
    return this.db.getRepository(name);
  }
}

function requiredText(value: string | undefined, fieldName: string) {
  const text = value?.trim();
  if (!text) throw new Error(`Ecobase medallion order failed: ${fieldName} is required.`);
  return text;
}

function normalizeDate(value: string, fieldName: string) {
  const text = requiredText(value, fieldName);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Ecobase medallion order failed: ${fieldName} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== text) {
    throw new Error(`Ecobase medallion order failed: ${fieldName} must be a valid calendar date.`);
  }
  return text;
}

function idOf(record: unknown) {
  const id = toPlainRecord(record).id;
  return typeof id === 'string' ? id : undefined;
}

function cleanValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
