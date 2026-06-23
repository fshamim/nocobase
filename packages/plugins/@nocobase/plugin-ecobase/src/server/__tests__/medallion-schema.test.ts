import { describe, expect, it } from 'vitest';
import bronzeSourceFiles from '../collections/bronze-source-files';
import bronzeSourceRecords from '../collections/bronze-source-records';
import silverCompanies from '../collections/silver-companies';
import silverAmazonAccounts from '../collections/silver-amazon-accounts';
import silverProducts from '../collections/silver-products';
import silverCompanyProducts from '../collections/silver-company-products';
import silverSuppliers from '../collections/silver-suppliers';
import silverSupplierAccounts from '../collections/silver-supplier-accounts';
import silverSupplierProducts from '../collections/silver-supplier-products';
import silverCompanyProductSuppliers from '../collections/silver-company-product-suppliers';
import silverOrders from '../collections/silver-orders';
import silverOrderLines from '../collections/silver-order-lines';
import silverInvoices from '../collections/silver-invoices';
import silverActivityComments from '../collections/silver-activity-comments';
import silverTasks from '../collections/silver-tasks';
import silverTaskLinks from '../collections/silver-task-links';
import silverHumanApprovals from '../collections/silver-human-approvals';
import silverHumanApprovalLinks from '../collections/silver-human-approval-links';
import silverWorkflowActionPolicies from '../collections/silver-workflow-action-policies';
import silverTargets from '../collections/silver-targets';
import silverNormalizationLinks from '../collections/silver-normalization-links';
import silverInventorySnapshots from '../collections/silver-inventory-snapshots';
import silverListingDailyFacts from '../collections/silver-listing-daily-facts';
import silverTrafficSnapshots from '../collections/silver-traffic-snapshots';
import goldTargetEvaluations from '../collections/gold-target-evaluations';
import goldInventoryPlanningRows from '../collections/gold-inventory-planning-rows';
import goldSupplierAttentionRows from '../collections/gold-supplier-attention-rows';
import goldAlerts from '../collections/gold-alerts';
import goldReportRuns from '../collections/gold-report-runs';
import goldReportItems from '../collections/gold-report-items';
import { ECOBASE_COLLECTIONS } from '../collections/names';

interface FieldOptions {
  name: string;
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  target?: string;
  foreignKey?: string;
}

interface CollectionOptions {
  name: string;
  autoGenId?: boolean;
  fields?: FieldOptions[];
  indexes?: Array<{ unique?: boolean; fields?: string[] }>;
}

function field(collection: CollectionOptions, name: string) {
  const match = collection.fields?.find((item) => item.name === name);
  if (!match) {
    throw new Error(`Expected collection ${collection.name} to define field ${name}.`);
  }
  return match;
}

function uniqueIndex(collection: CollectionOptions, fields: string[]) {
  const match = collection.indexes?.find((index) => {
    return index.unique === true && JSON.stringify(index.fields) === JSON.stringify(fields);
  });
  if (!match) {
    throw new Error(`Expected collection ${collection.name} to define unique index on ${fields.join(', ')}.`);
  }
  return match;
}

describe('Ecobase medallion schema foundation', () => {
  const medallionCollections: CollectionOptions[] = [
    bronzeSourceFiles,
    bronzeSourceRecords,
    silverCompanies,
    silverAmazonAccounts,
    silverProducts,
    silverCompanyProducts,
    silverSuppliers,
    silverSupplierAccounts,
    silverSupplierProducts,
    silverCompanyProductSuppliers,
    silverOrders,
    silverOrderLines,
    silverInvoices,
    silverActivityComments,
    silverTasks,
    silverTaskLinks,
    silverHumanApprovals,
    silverHumanApprovalLinks,
    silverWorkflowActionPolicies,
    silverTargets,
    silverNormalizationLinks,
    silverInventorySnapshots,
    silverListingDailyFacts,
    silverTrafficSnapshots,
    goldTargetEvaluations,
    goldInventoryPlanningRows,
    goldSupplierAttentionRows,
    goldAlerts,
    goldReportRuns,
    goldReportItems,
  ];

  it('defines bronze, silver, and gold collection names without the legacy ecobase prefix', () => {
    medallionCollections.forEach((collection) => {
      expect(collection.autoGenId).toBe(false);
      expect(collection.name).toMatch(/^(bronze|silver|gold)/);
      expect(collection.name.startsWith('ecobase')).toBe(false);
      expect(field(collection, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    });
  });

  it('keeps the required business identity constraints explicit', () => {
    expect(silverCompanies.name).toBe(ECOBASE_COLLECTIONS.silverCompanies);
    expect(field(silverCompanies, 'companyKey')).toMatchObject({ type: 'string', unique: true });
    uniqueIndex(silverProducts, ['asin', 'sku']);
    uniqueIndex(silverCompanyProducts, ['amazonAccountId', 'productId']);
    expect(field(silverSuppliers, 'normalizedName')).toMatchObject({ type: 'string', unique: true });
    uniqueIndex(silverSupplierProducts, ['supplierId', 'productId']);
    uniqueIndex(silverOrders, ['companyId', 'orderRef']);
    expect(field(silverOrderLines, 'expectedDeliveryDate')).toMatchObject({ type: 'string' });
    expect(field(silverOrderLines, 'expectedSellableDate')).toMatchObject({ type: 'string' });
    uniqueIndex(bronzeSourceRecords, ['sourceConnectionId', 'sourceDataset', 'sourceRecordKey', 'rowHash']);
  });

  it('defines practical FK relationships across core silver and gold tables', () => {
    expect(field(silverAmazonAccounts, 'company')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
    });
    expect(field(silverCompanyProducts, 'product')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverProducts,
      foreignKey: 'productId',
    });
    expect(field(silverSupplierProducts, 'supplier')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSuppliers,
      foreignKey: 'supplierId',
    });
    expect(field(silverOrders, 'supplier')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverSuppliers,
      foreignKey: 'supplierId',
    });
    expect(field(silverOrderLines, 'order')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverOrders,
      foreignKey: 'orderId',
    });
    expect(field(goldInventoryPlanningRows, 'companyProduct')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanyProducts,
      foreignKey: 'companyProductId',
    });
    expect(field(goldInventoryPlanningRows, 'supplierOrderState')).toMatchObject({ type: 'string' });
    expect(field(goldInventoryPlanningRows, 'supplierOrderRef')).toMatchObject({ type: 'string' });
    expect(field(goldReportItems, 'reportRun')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.goldReportRuns,
      foreignKey: 'reportRunId',
    });
  });
});
