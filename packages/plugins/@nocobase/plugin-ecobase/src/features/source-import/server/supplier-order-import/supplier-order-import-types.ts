/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type SupplierOrderSourceRole = 'supplier_ids' | 'supplier_tracker' | 'purchase_orders' | 'order_details';

export interface SupplierOrderSourceFile {
  name: string;
  role: SupplierOrderSourceRole;
  content: string | Uint8Array;
  dateFormat?: 'day-first' | 'month-first';
  modifiedAt?: string;
}

export interface SourceEvidence {
  file: string;
  sheet: string;
  row: number;
  hash: string;
}

export interface SourceEvidenceBundle extends SourceEvidence {
  rows: SourceEvidence[];
}

export interface SupplierOrderImportIssue {
  severity: 'info' | 'review' | 'blocked';
  sourceFile: string;
  sourceRow?: number;
  externalKey?: string;
  field?: string;
  reason: string;
  value?: string;
  disposition: 'accepted' | 'excluded' | 'blocked' | 'review';
}

export interface SupplierImportPlanRow {
  sourceSystem: 'supplier_ids';
  externalSupplierCode: string;
  normalizedExternalSupplierCode: string;
  displayName: string;
  normalizedName: string;
  aliases: string[];
  primaryEmail?: string;
  additionalEmails: string[];
  primaryPhone?: string;
  additionalPhones: string[];
  contactName?: string;
  contactNotes?: string;
  supplierUrl?: string;
  country?: string;
  market?: string;
  currency?: string;
  activeStatus?: string;
  supplierType?: string;
  amazonPresence?: string;
  reachedVia?: string;
  receivedEmail?: string;
  designation?: string;
  category?: string;
  amazonAllowed?: boolean;
  lastAnalysedBy?: string;
  trackingStatus?: string;
  dateOfUpdate?: string;
  analysisProgress?: string;
  remarksAnalysed?: string;
  sourceEvidence: { rows: SourceEvidence[] };
}

export interface SupplierAccountImportPlanRow {
  externalSupplierCode: string;
  companyKey: string;
  accountName: string;
  accountType: 'ordering_relationship';
  market?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  preferredContactMethod?: 'email' | 'phone';
  portalUrl?: string;
  loginUsername?: string;
  loginSecret?: string;
  metadata: { source: 'canonical_purchase_order' | 'workflow_draft' | 'supplier_2026' };
}

export interface SupplierProductImportPlanRow {
  externalSupplierCode: string;
  asin: string;
  supplierSku?: string;
  unitCost?: number;
  moq?: number;
  supplierPackSize?: number;
  mapPrice?: number;
  lastPriceUpdateDate?: string;
  sourceEvidence: SourceEvidence;
}

export interface OrderImportPlanRow {
  externalOrderId: string;
  companyKey: string;
  externalSupplierCode: string;
  sourceExternalSupplierCode?: string;
  orderDate?: string;
  sourceMarketplace?: string;
  recordType: 'purchase_order' | 'workflow_draft';
  purchaseEvidenceStatus: 'confirmed' | 'cancelled' | 'rejected' | 'unknown' | 'unconfirmed_workflow';
  sourceOrderStatus?: string;
  operationalStatus?: string;
  canonicalStatus?: string;
  workflowStage?: string;
  orderApproval?: string;
  paymentStatus?: string;
  invoiceStatus?: string;
  prepStatus?: string;
  expectedCost?: number;
  actualCost?: number;
  expectedDeliveryDate?: string;
  shippingCarrier?: string;
  trackingId?: string;
  invoiceReference?: string;
  remarks?: string;
  sourceEvidence: { purchaseOrders: SourceEvidence[]; orderDetails?: SourceEvidence[] };
}

export interface OrderLineImportPlanRow {
  externalOrderId: string;
  companyKey: string;
  lineOrdinal: number;
  sourceLineKey: string;
  externalSupplierCode: string;
  asin: string;
  sourceMarketplace?: string;
  upc?: string;
  supplierSku?: string;
  orderQty: number;
  expectedCost?: number;
  actualCost?: number;
  unitCost?: number;
  supplierPackSize?: number;
  leadTimeDays?: number;
  mapPrice?: number;
  orderType?: string;
  operationalStatus?: string;
  poStatus?: 'added_to_po' | 'not_added_to_po';
  sourceEvidence: SourceEvidenceBundle;
  companyProductFamilyId?: string | null;
  companyProductId?: string | null;
  supplierProductId?: string | null;
  mappingScope?: 'exact_member' | 'family_only' | 'unresolved';
  mappingReason?: 'family_not_found' | 'family_marketplace_unresolved' | 'family_ambiguous' | 'listing_sku_ambiguous';
  sourceSkuType?: 'listing_sku' | 'supplier_sku' | 'upc' | 'unknown';
  familyResolution?: 'marketplace_exact' | 'company_asin_unique';
}

export interface DuplicateDecision {
  identity: string;
  sourceRows: number[];
  sourceHashes: string[];
  selectedRowNumber?: number;
  selectedSourceHash?: string;
  disposition: 'collapsed_exact' | 'preserved_repeat' | 'selected_override' | 'blocked';
  reason: string;
}

export interface SourceReconciliation {
  role: SupplierOrderSourceRole;
  inputRows: number;
  acceptedRows: number;
  excludedRows: number;
  blockedRows: number;
  reasonCounts: Record<string, number>;
}

export interface SupplierOrderImportPlan {
  planVersion: 'supplier-order-import-plan-v1';
  asOfDate: string;
  digest: string;
  sourceFiles: Array<{
    name: string;
    role: SupplierOrderSourceRole;
    sha256: string;
    rowCount: number;
    headers: string[];
    modifiedAt?: string;
  }>;
  suppliers: SupplierImportPlanRow[];
  supplierAccounts: SupplierAccountImportPlanRow[];
  supplierProducts: SupplierProductImportPlanRow[];
  purchaseOrderSourceSupplierCodes: string[];
  orders: OrderImportPlanRow[];
  orderLines: OrderLineImportPlanRow[];
  supplierCodeOverrides: Array<{ rejectedCode: string; acceptedCode: string; normalizedName: string }>;
  supplierNameOverrides: Array<{
    externalSupplierCode: string;
    displayName: string;
    sourceNames: string[];
    reason: string;
  }>;
  duplicateSupplierNames: Array<{ normalizedName: string; externalSupplierCodes: string[] }>;
  duplicatePurchaseOrders: DuplicateDecision[];
  duplicateOrderLines: DuplicateDecision[];
  blockedSupplierCodes: Array<{ externalSupplierCode: string; names: string[]; reason: string }>;
  blockedOrderIds: Array<{ externalOrderId: string; reason: string }>;
  headerlessOrderOutcomes: Array<{
    externalOrderId: string;
    disposition: 'workflow_draft' | 'exception';
    reason: string;
  }>;
  reconciliation: {
    matchedOrderCount: number;
    detailsOnlyOrderCount: number;
    purchaseOnlyOrderCount: number;
    supplierMismatchCount: number;
    companyMismatchCount: number;
    retainedOrderCount: number;
    retainedOrderLineCount: number;
    bySource: SourceReconciliation[];
  };
  hasBlockingIssues: boolean;
  issues: SupplierOrderImportIssue[];
}
