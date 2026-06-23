import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

type SilverEntityType =
  | 'product'
  | 'company'
  | 'companyProduct'
  | 'supplier'
  | 'supplierAccount'
  | 'supplierProduct'
  | 'order'
  | 'orderLine'
  | 'invoice'
  | 'inventorySnapshot'
  | 'listingDailyFact'
  | 'task'
  | 'target'
  | 'approval'
  | 'comment';

export interface SilverFocus {
  type: SilverEntityType;
  id: string;
}

interface SilverDateRange {
  active: boolean;
  from?: number;
  to?: number;
  fromIso?: string;
  toIso?: string;
  fromDay?: string;
  toDay?: string;
}

export interface SilverSearchResult extends SilverFocus {
  label: string;
  subtitle: string;
  match: string;
}

interface SilverSectionDefinition {
  key: string;
  title: string;
  type: SilverEntityType;
  collection: string;
  fields: string[];
}

interface SilverTableSection extends SilverSectionDefinition {
  rows: Record<string, unknown>[];
  highlightIds: string[];
}

interface SilverResolvedContext {
  productIds: Set<string>;
  companyIds: Set<string>;
  companyProductIds: Set<string>;
  supplierIds: Set<string>;
  supplierAccountIds: Set<string>;
  supplierProductIds: Set<string>;
  orderIds: Set<string>;
  orderLineIds: Set<string>;
  invoiceIds: Set<string>;
  inventorySnapshotIds: Set<string>;
  listingDailyFactIds: Set<string>;
  taskIds: Set<string>;
  targetIds: Set<string>;
  approvalIds: Set<string>;
  commentIds: Set<string>;
}

const SECTIONS: SilverSectionDefinition[] = [
  {
    key: 'products',
    title: 'Products',
    type: 'product',
    collection: ECOBASE_COLLECTIONS.silverProducts,
    fields: ['asin', 'sku', 'title', 'brand', 'lifecycleStatus', 'mappingStatus'],
  },
  {
    key: 'companies',
    title: 'Companies',
    type: 'company',
    collection: ECOBASE_COLLECTIONS.silverCompanies,
    fields: ['name', 'companyKey'],
  },
  {
    key: 'suppliers',
    title: 'Suppliers',
    type: 'supplier',
    collection: ECOBASE_COLLECTIONS.silverSuppliers,
    fields: ['displayName', 'approvalStatus', 'analysisStatus', 'accountStatus', 'nextFollowUpAt'],
  },
  {
    key: 'orders',
    title: 'Orders',
    type: 'order',
    collection: ECOBASE_COLLECTIONS.silverOrders,
    fields: ['orderRef', 'orderDate', 'lifecycleStatus', 'nextAction', 'trackingId'],
  },
  {
    key: 'companyProducts',
    title: 'Company products',
    type: 'companyProduct',
    collection: ECOBASE_COLLECTIONS.silverCompanyProducts,
    fields: ['productLabel', 'asin', 'sku', 'companyName', 'lifecycleStatus', 'listingStatus', 'recordRef'],
  },
  {
    key: 'supplierAccounts',
    title: 'Supplier accounts',
    type: 'supplierAccount',
    collection: ECOBASE_COLLECTIONS.silverSupplierAccounts,
    fields: ['supplierName', 'companyName', 'accountName', 'orderingMethod', 'portalUrl', 'status', 'recordRef'],
  },
  {
    key: 'supplierProducts',
    title: 'Supplier products',
    type: 'supplierProduct',
    collection: ECOBASE_COLLECTIONS.silverSupplierProducts,
    fields: [
      'supplierName',
      'productLabel',
      'asin',
      'sku',
      'supplierSku',
      'unitCost',
      'leadTimeDays',
      'analysisStatus',
      'recordRef',
    ],
  },
  {
    key: 'orderLines',
    title: 'Order lines',
    type: 'orderLine',
    collection: ECOBASE_COLLECTIONS.silverOrderLines,
    fields: [
      'orderLabel',
      'productLabel',
      'asin',
      'sku',
      'orderedQty',
      'confirmedQty',
      'unitCost',
      'priority',
      'recordRef',
    ],
  },
  {
    key: 'invoices',
    title: 'Invoices',
    type: 'invoice',
    collection: ECOBASE_COLLECTIONS.silverInvoices,
    fields: ['orderLabel', 'invoiceNumber', 'status', 'amount', 'paymentMode', 'paidAt', 'recordRef'],
  },
  {
    key: 'tasks',
    title: 'Tasks',
    type: 'task',
    collection: ECOBASE_COLLECTIONS.silverTasks,
    fields: ['title', 'status', 'priority', 'dueAt', 'recordRef'],
  },
  {
    key: 'approvals',
    title: 'Approvals',
    type: 'approval',
    collection: ECOBASE_COLLECTIONS.silverHumanApprovals,
    fields: ['title', 'actionType', 'status', 'priority', 'dueAt', 'riskSummary'],
  },
  {
    key: 'targets',
    title: 'Targets',
    type: 'target',
    collection: ECOBASE_COLLECTIONS.silverTargets,
    fields: ['entityLabel', 'metric', 'periodType', 'targetValue', 'status', 'recordRef'],
  },
  {
    key: 'comments',
    title: 'Comments',
    type: 'comment',
    collection: ECOBASE_COLLECTIONS.silverActivityComments,
    fields: ['entityLabel', 'actorType', 'commentType', 'body', 'followUpAt', 'recordRef'],
  },
  {
    key: 'inventorySnapshots',
    title: 'Inventory facts',
    type: 'inventorySnapshot',
    collection: ECOBASE_COLLECTIONS.silverInventorySnapshots,
    fields: [
      'productLabel',
      'asin',
      'sku',
      'snapshotDate',
      'sellableStock',
      'reserved',
      'inbound',
      'ordered',
      'salesVelocity',
      'recordRef',
    ],
  },
  {
    key: 'listingDailyFacts',
    title: 'Listing facts',
    type: 'listingDailyFact',
    collection: ECOBASE_COLLECTIONS.silverListingDailyFacts,
    fields: [
      'productLabel',
      'asin',
      'sku',
      'snapshotDate',
      'sales',
      'units',
      'profit',
      'margin',
      'refunds',
      'recordRef',
    ],
  },
];

const ENTITY = Object.fromEntries(SECTIONS.map((section) => [section.type, section])) as Record<
  SilverEntityType,
  SilverSectionDefinition
>;

const SEARCH_FIELDS: Record<SilverEntityType, string[]> = {
  product: ['id', 'asin', 'sku', 'title', 'brand'],
  company: ['id', 'name', 'companyKey'],
  companyProduct: ['id', 'companyName', 'productLabel', 'asin', 'sku', 'amazonAccountId', 'recordRef'],
  supplier: ['id', 'displayName', 'normalizedName', 'approvalStatus'],
  supplierAccount: ['id', 'supplierName', 'companyName', 'accountName', 'portalUrl', 'username', 'recordRef'],
  supplierProduct: ['id', 'supplierName', 'productLabel', 'asin', 'sku', 'supplierSku', 'recordRef'],
  order: ['id', 'orderRef', 'trackingId', 'lifecycleStatus', 'companyName', 'supplierName'],
  orderLine: ['id', 'orderLabel', 'productLabel', 'asin', 'sku', 'upc', 'productAnalysisStatus', 'recordRef'],
  invoice: ['id', 'orderLabel', 'invoiceNumber', 'status', 'recordRef'],
  inventorySnapshot: ['id', 'productLabel', 'asin', 'sku', 'snapshotDate', 'recordRef'],
  listingDailyFact: ['id', 'productLabel', 'asin', 'sku', 'snapshotDate', 'recordRef'],
  task: ['id', 'title', 'description', 'status', 'priority'],
  target: ['id', 'entityType', 'entityId', 'metric', 'periodType', 'status'],
  approval: ['id', 'title', 'actionType', 'status', 'contextSummary', 'riskSummary'],
  comment: ['id', 'entityType', 'entityId', 'body', 'commentType'],
};

const LOOKUP_FIELDS: Partial<Record<SilverEntityType, string[]>> = {
  product: ['id', 'asin', 'sku', 'title', 'brand'],
  supplier: ['id', 'displayName', 'normalizedName'],
  order: ['id', 'orderRef', 'trackingId'],
  invoice: ['id', 'invoiceNumber', 'status'],
  company: ['id', 'name', 'companyKey'],
};

const DATE_FIELDS: Partial<Record<SilverEntityType, string[]>> = {
  supplier: ['nextFollowUpAt', 'lastContactedAt'],
  order: ['orderDate', 'nextActionDueAt', 'expectedDeliveryDate'],
  orderLine: ['expectedDeliveryDate', 'expectedSellableDate'],
  invoice: ['paidAt'],
  inventorySnapshot: ['snapshotDate'],
  listingDailyFact: ['snapshotDate'],
  task: ['dueAt'],
  target: ['periodStart', 'periodEnd'],
  approval: ['dueAt', 'approvedAt', 'executedAt'],
  comment: ['followUpAt'],
};

const EDITABLE_FIELDS: Record<SilverEntityType, string[]> = {
  product: ['title', 'brand', 'lifecycleStatus', 'mappingStatus'],
  company: [],
  companyProduct: ['lifecycleStatus', 'listingStatus'],
  supplier: ['displayName', 'approvalStatus', 'analysisStatus', 'accountStatus', 'nextFollowUpAt', 'lastContactedAt'],
  supplierAccount: ['accountName', 'orderingMethod', 'portalUrl', 'username', 'secretRef', 'status'],
  supplierProduct: [
    'supplierSku',
    'unitCost',
    'moq',
    'supplierPackSize',
    'leadTimeDays',
    'prepCapability',
    'analysisStatus',
  ],
  order: [
    'lifecyclePhase',
    'lifecycleStatus',
    'nextAction',
    'nextActionDueAt',
    'fulfillmentRoute',
    'expectedDeliveryDate',
    'expectedCost',
    'actualCost',
    'costDifferenceNote',
    'shippingCarrier',
    'trackingId',
    'remarks',
  ],
  orderLine: [
    'orderedQty',
    'confirmedQty',
    'unitCost',
    'expectedSellPrice',
    'expectedMargin',
    'expectedProfit',
    'supplierPackSize',
    'fbaExpectedPackSize',
    'prepInstruction',
    'expectedDeliveryDate',
    'expectedSellableDate',
    'upc',
    'mapPrice',
    'productAnalysisStatus',
    'priority',
  ],
  invoice: ['invoiceType', 'status', 'fileUrl', 'amount', 'paymentMode', 'paidAt', 'remarks'],
  inventorySnapshot: [],
  listingDailyFact: [],
  task: ['title', 'description', 'status', 'priority', 'dueAt', 'assignedToUserId', 'assignedToAiEmployeeId'],
  target: ['targetValue', 'status'],
  approval: ['assignedReviewerId', 'status', 'priority', 'dueAt', 'approvedByUserId', 'approvedAt', 'rejectedReason'],
  comment: [],
};

const ENTITY_ALIASES: Record<SilverEntityType, string[]> = {
  product: ['product', ECOBASE_COLLECTIONS.silverProducts],
  company: ['company', ECOBASE_COLLECTIONS.silverCompanies],
  companyProduct: ['company_product', 'companyProduct', ECOBASE_COLLECTIONS.silverCompanyProducts],
  supplier: ['supplier', ECOBASE_COLLECTIONS.silverSuppliers],
  supplierAccount: ['supplier_account', 'supplierAccount', ECOBASE_COLLECTIONS.silverSupplierAccounts],
  supplierProduct: ['supplier_product', 'supplierProduct', ECOBASE_COLLECTIONS.silverSupplierProducts],
  order: ['order', ECOBASE_COLLECTIONS.silverOrders],
  orderLine: ['order_line', 'orderLine', ECOBASE_COLLECTIONS.silverOrderLines],
  invoice: ['invoice', ECOBASE_COLLECTIONS.silverInvoices],
  inventorySnapshot: ['inventory_snapshot', 'inventorySnapshot', ECOBASE_COLLECTIONS.silverInventorySnapshots],
  listingDailyFact: ['listing_daily_fact', 'listingDailyFact', ECOBASE_COLLECTIONS.silverListingDailyFacts],
  task: ['task', ECOBASE_COLLECTIONS.silverTasks],
  target: ['target', ECOBASE_COLLECTIONS.silverTargets],
  approval: ['approval', 'human_approval', ECOBASE_COLLECTIONS.silverHumanApprovals],
  comment: ['comment', ECOBASE_COLLECTIONS.silverActivityComments],
};

const CONTEXT_KEY: Record<SilverEntityType, keyof SilverResolvedContext> = {
  product: 'productIds',
  company: 'companyIds',
  companyProduct: 'companyProductIds',
  supplier: 'supplierIds',
  supplierAccount: 'supplierAccountIds',
  supplierProduct: 'supplierProductIds',
  order: 'orderIds',
  orderLine: 'orderLineIds',
  invoice: 'invoiceIds',
  inventorySnapshot: 'inventorySnapshotIds',
  listingDailyFact: 'listingDailyFactIds',
  task: 'taskIds',
  target: 'targetIds',
  approval: 'approvalIds',
  comment: 'commentIds',
};

const COLLECTION_TYPES = Object.fromEntries(SECTIONS.map((section) => [section.type, section.collection])) as Record<
  SilverEntityType,
  string
>;

export class EcobaseSilverDataService {
  constructor(private db: EcobaseDatabase) {}

  async search(params: { query?: string; limit?: number } = {}): Promise<SilverSearchResult[]> {
    const query = normalize(params.query);
    if (query.length < 2) {
      return [];
    }
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 500);
    const tables = await this.loadTables();
    return Object.entries(SEARCH_FIELDS)
      .flatMap(([type, fields]) =>
        this.decorateRows(type as SilverEntityType, tables[type] ?? [], tables).flatMap((row) => {
          const match = matchField(row, fields, query);
          if (!match) return [];
          return [{ ...this.describe(type as SilverEntityType, row), match }];
        }),
      )
      .sort(
        (left, right) => searchRank(left, query) - searchRank(right, query) || left.label.localeCompare(right.label),
      )
      .slice(0, limit);
  }

  async lookup(
    params: { type?: SilverEntityType; query?: string; limit?: number; dateFrom?: string; dateTo?: string } = {},
  ): Promise<SilverSearchResult[]> {
    const query = normalize(params.query);
    const dateRange = normalizeDateRange(params);
    const type = params.type;
    if (!type || !LOOKUP_FIELDS[type]) {
      throw new Error(`Ecobase Silver Data lookup failed: unsupported lookup type ${type ?? 'missing'}.`);
    }
    if (query.length < 2) {
      return [];
    }
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const rows = await this.lookupRows(type, LOOKUP_FIELDS[type] ?? [], query, limit, dateRange);
    return rows
      .flatMap((row) => {
        const match = matchField(row, LOOKUP_FIELDS[type] ?? [], query);
        return match ? [{ ...this.describe(type, row), match }] : [];
      })
      .sort(
        (left, right) => searchRank(left, query) - searchRank(right, query) || left.label.localeCompare(right.label),
      )
      .slice(0, limit);
  }

  async context(
    params: { focus?: SilverFocus; query?: string; pageSize?: number; dateFrom?: string; dateTo?: string } = {},
  ) {
    const pageSize = Math.min(Math.max(params.pageSize ?? 10, 1), 10000);
    const dateRange = normalizeDateRange(params);
    const tables = await this.loadTables();
    const resolved = this.resolveContext(tables, params.focus, params.query, dateRange);
    const hasFocus = Boolean(params.focus) || normalize(params.query).length >= 2 || dateRange.active;
    const sections: SilverTableSection[] = SECTIONS.map((section) => {
      const ids = resolved[CONTEXT_KEY[section.type]];
      const rows = this.decorateRows(
        section.type,
        this.pageRows(tables[section.type] ?? [], ids, pageSize, hasFocus),
        tables,
      );
      return { ...section, rows, highlightIds: [...ids] };
    });
    return { focus: params.focus, sections };
  }

  async record(params: SilverFocus) {
    const definition = ENTITY[params.type];
    if (!definition) {
      throw new Error(`Ecobase Silver Data record failed: unknown entity type ${params.type}.`);
    }
    const row = await this.findById(params.type, params.id);
    if (!row) {
      throw new Error(`Ecobase Silver Data record failed: ${params.type} ${params.id} was not found.`);
    }
    const tables = await this.loadTables();
    const resolved = this.resolveContext(tables, params);
    return {
      type: params.type,
      id: params.id,
      title: this.describe(params.type, row).label,
      record: this.decorateRow(params.type, row, tables),
      editableFields: EDITABLE_FIELDS[params.type],
      related: Object.fromEntries(Object.entries(CONTEXT_KEY).map(([type, key]) => [type, [...resolved[key]]])),
      comments: this.relatedSupportRows(tables.comment, params.type, params.id, tables),
    };
  }

  async updateRecord(params: SilverFocus & { values?: Record<string, unknown> }) {
    const editable = new Set(EDITABLE_FIELDS[params.type]);
    if (!editable.size) {
      throw new Error(`Ecobase Silver Data update failed: ${params.type} is read-only in the operator workbench.`);
    }
    const values = cleanEditableValues(params.values ?? {}, editable);
    const rejected = Object.keys(params.values ?? {}).filter((field) => !editable.has(field));
    if (rejected.length) {
      throw new Error(`Ecobase Silver Data update failed: read-only fields rejected: ${rejected.join(', ')}.`);
    }
    if (!Object.keys(values).length) {
      throw new Error('Ecobase Silver Data update failed: no editable values were provided.');
    }
    await this.repo(params.type).update({ filterByTk: params.id, values });
    return this.record(params);
  }

  async addComment(
    params: SilverFocus & { body?: string; commentType?: string; followUpAt?: string; actorUserId?: string },
  ) {
    const body = String(params.body ?? '').trim();
    if (!body) {
      throw new Error('Ecobase Silver Data comment failed: body is required.');
    }
    const comment = await this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments).create({
      values: cleanEditableValues(
        {
          id: randomUUID(),
          entityType: ENTITY_ALIASES[params.type][0],
          entityId: params.id,
          actorType: 'operator',
          actorUserId: params.actorUserId,
          commentType: params.commentType ?? 'note',
          body,
          followUpAt: params.followUpAt,
          workflowDetectionStatus: 'none',
        },
        new Set([
          'id',
          'entityType',
          'entityId',
          'actorType',
          'actorUserId',
          'commentType',
          'body',
          'followUpAt',
          'workflowDetectionStatus',
        ]),
      ),
    });
    return toPlainRecord(comment);
  }

  private async lookupRows(
    type: SilverEntityType,
    fields: string[],
    query: string,
    limit: number,
    dateRange: SilverDateRange,
  ) {
    const sequelize = this.db.sequelize;
    if (sequelize?.getDialect?.() === 'postgres') {
      const searchWhere = fields.map((field) => `"${field}"::text ILIKE :query`).join(' OR ');
      const dateWhere = this.dateSql(type, dateRange);
      return (await sequelize.query(
        `SELECT * FROM "${COLLECTION_TYPES[type]}" WHERE (${searchWhere})${dateWhere} LIMIT :limit`,
        {
          replacements: {
            query: `%${query}%`,
            limit,
            dateFrom: dateRange.fromIso,
            dateTo: dateRange.toIso,
            dateFromDay: dateRange.fromDay,
            dateToDay: dateRange.toDay,
          },
          type: 'SELECT',
        },
      )) as Record<string, unknown>[];
    }
    return (await this.repo(type).find({}))
      .map(toPlainRecord)
      .filter((row) => !DATE_FIELDS[type]?.length || rowMatchesDate(type, row, dateRange));
  }

  private dateSql(type: SilverEntityType, dateRange: SilverDateRange) {
    const fields = DATE_FIELDS[type] ?? [];
    if (!dateRange.active || !fields.length) return '';
    return ` AND (${fields
      .map((field) => `NULLIF("${field}"::text, '')::date BETWEEN :dateFromDay AND :dateToDay`)
      .join(' OR ')})`;
  }

  private async loadTables() {
    const entries = await Promise.all(
      [
        ...Object.entries(COLLECTION_TYPES),
        ['taskLinks', ECOBASE_COLLECTIONS.silverTaskLinks],
        ['approvalLinks', ECOBASE_COLLECTIONS.silverHumanApprovalLinks],
      ].map(async ([type, collection]) => {
        const rows = await this.db.getRepository(collection).find({});
        return [type, rows.map(toPlainRecord)] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<string, Record<string, unknown>[]>;
  }

  private resolveContext(
    tables: Record<string, Record<string, unknown>[]>,
    focus?: SilverFocus,
    rawQuery?: string,
    dateRange: SilverDateRange = { active: false },
  ) {
    const context = emptyContext();
    const query = normalize(rawQuery);
    if (!focus && query.length < 2 && !dateRange.active) return context;

    const searchMatches =
      !focus && query.length >= 2
        ? this.addSearchMatches(context, tables, query)
        : { matchedOrder: false, matchedSupplier: false };
    if (dateRange.active && !focus && query.length < 2) {
      this.addDateMatches(context, tables, dateRange);
    }
    if (focus) {
      add(context[CONTEXT_KEY[focus.type]], focus.id);
    }
    const expansionFocusType =
      focus?.type ?? (searchMatches.matchedOrder ? 'order' : searchMatches.matchedSupplier ? 'supplier' : undefined);
    this.expandBusinessContext(context, tables, expansionFocusType, dateRange);
    this.expandSupportContext(context, tables);
    this.expandBusinessContext(context, tables, expansionFocusType, dateRange);
    this.expandBusinessContext(context, tables, expansionFocusType, dateRange);
    return context;
  }

  private addSearchMatches(
    context: SilverResolvedContext,
    tables: Record<string, Record<string, unknown>[]>,
    query: string,
  ) {
    let matchedOrder = false;
    let matchedSupplier = false;
    for (const [type, fields] of Object.entries(SEARCH_FIELDS)) {
      for (const row of this.decorateRows(type as SilverEntityType, tables[type] ?? [], tables)) {
        const match = matchField(row, fields, query);
        if (match) {
          add(context[CONTEXT_KEY[type as SilverEntityType]], text(row.id));
          matchedOrder ||= type === 'order' && ['id', 'orderRef', 'trackingId'].includes(match);
          matchedSupplier ||= type === 'supplier' && ['id', 'displayName', 'normalizedName'].includes(match);
        }
      }
    }
    return { matchedOrder, matchedSupplier };
  }

  private addDateMatches(
    context: SilverResolvedContext,
    tables: Record<string, Record<string, unknown>[]>,
    dateRange: SilverDateRange,
  ) {
    for (const type of Object.keys(DATE_FIELDS) as SilverEntityType[]) {
      for (const row of tables[type] ?? []) {
        if (rowMatchesDate(type, row, dateRange)) {
          add(context[CONTEXT_KEY[type]], text(row.id));
        }
      }
    }
  }

  private expandBusinessContext(
    context: SilverResolvedContext,
    tables: Record<string, Record<string, unknown>[]>,
    focusType?: SilverEntityType,
    dateRange: SilverDateRange = { active: false },
  ) {
    const orderOnlyFocus = ['order', 'invoice', 'orderLine'].includes(String(focusType));
    const supplierOnlyFocus = focusType === 'supplier';

    for (const row of tables.inventorySnapshot) {
      if (context.inventorySnapshotIds.has(text(row.id))) {
        add(context.companyProductIds, text(row.companyProductId));
      }
    }

    for (const row of tables.listingDailyFact) {
      if (context.listingDailyFactIds.has(text(row.id))) {
        add(context.companyProductIds, text(row.companyProductId));
      }
    }

    for (const row of tables.companyProduct) {
      const id = text(row.id);
      const productId = text(row.productId);
      const companyId = text(row.companyId);
      if (
        context.companyProductIds.has(id) ||
        (!orderOnlyFocus && !supplierOnlyFocus && focusType !== 'company' && context.productIds.has(productId)) ||
        (focusType === 'company' && !dateRange.active && context.companyIds.has(companyId))
      ) {
        add(context.companyProductIds, id);
        add(context.productIds, productId);
        add(context.companyIds, companyId);
        add(
          context.inventorySnapshotIds,
          ...idsWhereDate(tables.inventorySnapshot, 'companyProductId', id, 'inventorySnapshot', dateRange),
        );
        add(
          context.listingDailyFactIds,
          ...idsWhereDate(tables.listingDailyFact, 'companyProductId', id, 'listingDailyFact', dateRange),
        );
      }
    }

    for (const row of tables.supplierAccount) {
      if (
        context.supplierAccountIds.has(text(row.id)) ||
        (focusType === 'supplier' && !dateRange.active && context.supplierIds.has(text(row.supplierId))) ||
        (focusType === 'company' && !dateRange.active && context.companyIds.has(text(row.companyId)))
      ) {
        add(context.supplierAccountIds, text(row.id));
        add(context.supplierIds, text(row.supplierId));
        add(context.companyIds, text(row.companyId));
      }
    }

    for (const row of tables.supplierProduct) {
      if (
        (context.supplierProductIds.has(text(row.id)) &&
          (!supplierOnlyFocus || context.supplierIds.has(text(row.supplierId)))) ||
        (!dateRange.active && !orderOnlyFocus && !supplierOnlyFocus && context.productIds.has(text(row.productId))) ||
        (!dateRange.active && supplierOnlyFocus && context.supplierIds.has(text(row.supplierId)))
      ) {
        add(context.supplierProductIds, text(row.id));
        add(context.productIds, text(row.productId));
        add(context.supplierIds, text(row.supplierId));
      }
    }

    for (const row of tables.order) {
      if (
        context.orderIds.has(text(row.id)) ||
        (rowMatchesDate('order', row, dateRange) &&
          ((focusType === 'company' && context.companyIds.has(text(row.companyId))) ||
            (focusType === 'supplier' && context.supplierIds.has(text(row.supplierId))) ||
            (focusType === 'supplierAccount' && context.supplierAccountIds.has(text(row.supplierAccountId)))))
      ) {
        add(context.orderIds, text(row.id));
        add(context.companyIds, text(row.companyId));
        add(context.supplierIds, text(row.supplierId));
        add(context.supplierAccountIds, text(row.supplierAccountId));
      }
    }

    for (const row of tables.orderLine) {
      const orderScopeFocus = ['order', 'invoice', 'supplierAccount'].includes(String(focusType));
      if (
        context.orderLineIds.has(text(row.id)) ||
        (dateRange.active && context.orderIds.has(text(row.orderId))) ||
        (orderScopeFocus && context.orderIds.has(text(row.orderId))) ||
        (rowMatchesDate('orderLine', row, dateRange) &&
          ((!orderOnlyFocus && !supplierOnlyFocus && context.companyProductIds.has(text(row.companyProductId))) ||
            (!orderOnlyFocus &&
              focusType !== 'company' &&
              context.supplierProductIds.has(text(row.supplierProductId)))))
      ) {
        add(context.orderLineIds, text(row.id));
        add(context.orderIds, text(row.orderId));
        add(context.companyProductIds, text(row.companyProductId));
        add(context.supplierProductIds, text(row.supplierProductId));
      }
    }

    for (const row of tables.invoice) {
      if (context.invoiceIds.has(text(row.id)) || context.orderIds.has(text(row.orderId))) {
        add(context.invoiceIds, text(row.id));
        add(context.orderIds, text(row.orderId));
      }
    }
  }

  private expandSupportContext(context: SilverResolvedContext, tables: Record<string, Record<string, unknown>[]>) {
    const linkedEntities = this.linkedEntities(context);

    for (const row of tables.task) {
      if (context.taskIds.has(text(row.id)) || context.commentIds.has(text(row.sourceCommentId))) {
        add(context.taskIds, text(row.id));
        add(context.commentIds, text(row.sourceCommentId));
      }
    }

    for (const row of tables.taskLinks ?? []) {
      if (context.taskIds.has(text(row.taskId)) || hasLinkedEntity(linkedEntities, row)) {
        add(context.taskIds, text(row.taskId));
        this.addEntity(context, text(row.entityType), text(row.entityId));
      }
    }

    for (const row of tables.target) {
      if (context.targetIds.has(text(row.id)) || hasLinkedEntity(linkedEntities, row)) {
        add(context.targetIds, text(row.id));
        this.addEntity(context, text(row.entityType), text(row.entityId));
      }
    }

    for (const row of tables.approvalLinks ?? []) {
      if (context.approvalIds.has(text(row.humanApprovalId)) || hasLinkedEntity(linkedEntities, row)) {
        add(context.approvalIds, text(row.humanApprovalId));
        this.addEntity(context, text(row.entityType), text(row.entityId));
      }
    }

    for (const row of tables.comment) {
      if (context.commentIds.has(text(row.id)) || hasLinkedEntity(linkedEntities, row)) {
        add(context.commentIds, text(row.id));
        this.addEntity(context, text(row.entityType), text(row.entityId));
      }
    }
  }

  private linkedEntities(context: SilverResolvedContext) {
    return Object.entries(CONTEXT_KEY).flatMap(([type, key]) =>
      [...context[key]].map((id) => ({ type: type as SilverEntityType, id })),
    );
  }

  private addEntity(context: SilverResolvedContext, entityType: string, entityId: string) {
    for (const [type, aliases] of Object.entries(ENTITY_ALIASES)) {
      if (aliases.includes(entityType)) {
        add(context[CONTEXT_KEY[type as SilverEntityType]], entityId);
      }
    }
  }

  private relatedSupportRows(
    rows: Record<string, unknown>[],
    type: SilverEntityType,
    id: string,
    tables: Record<string, Record<string, unknown>[]>,
  ) {
    const aliases = ENTITY_ALIASES[type];
    return this.decorateRows(
      'comment',
      rows.filter((row) => text(row.entityId) === id && aliases.includes(text(row.entityType))),
      tables,
    );
  }

  private decorateRows(
    type: SilverEntityType,
    rows: Record<string, unknown>[],
    tables: Record<string, Record<string, unknown>[]>,
  ) {
    return rows.map((row) => this.decorateRow(type, row, tables));
  }

  private decorateRow(
    type: SilverEntityType,
    row: Record<string, unknown>,
    tables: Record<string, Record<string, unknown>[]>,
  ) {
    const companyProduct = findById(tables.companyProduct, text(row.companyProductId));
    const supplierProduct = findById(tables.supplierProduct, text(row.supplierProductId));
    const product =
      type === 'product'
        ? row
        : findById(
            tables.product,
            text(row.productId) || text(companyProduct?.productId) || text(supplierProduct?.productId),
          );
    const company =
      type === 'company' ? row : findById(tables.company, text(row.companyId) || text(companyProduct?.companyId));
    const supplier =
      type === 'supplier' ? row : findById(tables.supplier, text(row.supplierId) || text(supplierProduct?.supplierId));
    const order = type === 'order' ? row : findById(tables.order, text(row.orderId));

    return {
      ...row,
      recordRef: shortRef(row.id),
      productLabel: productLabel(product),
      asin: row.asin ?? product?.asin,
      sku: row.sku ?? product?.sku,
      companyName: company?.name,
      supplierName: supplier?.displayName ?? supplier?.normalizedName,
      orderLabel: orderLabel(order),
      entityLabel: this.entityLabel(text(row.entityType), text(row.entityId), tables),
    };
  }

  private entityLabel(entityType: string, entityId: string, tables: Record<string, Record<string, unknown>[]>) {
    for (const [type, aliases] of Object.entries(ENTITY_ALIASES)) {
      if (!aliases.includes(entityType)) continue;
      const row = findById(tables[type], entityId);
      if (row) return this.describe(type as SilverEntityType, row).label;
    }
    return [entityType, shortRef(entityId)].filter(Boolean).join(' ');
  }

  private pageRows(rows: Record<string, unknown>[], ids: Set<string>, pageSize: number, hasFocus: boolean) {
    if (hasFocus && !ids.size) return [];
    const filtered = ids.size ? rows.filter((row) => ids.has(text(row.id))) : rows;
    return filtered.slice(0, pageSize);
  }

  private async findById(type: SilverEntityType, id: string) {
    const row = await this.repo(type).findOne({ filterByTk: id });
    return row ? toPlainRecord(row) : null;
  }

  private repo(type: SilverEntityType) {
    return this.db.getRepository(COLLECTION_TYPES[type]);
  }

  private describe(type: SilverEntityType, row: Record<string, unknown>): SilverSearchResult {
    const id = text(row.id);
    const labelByType: Record<SilverEntityType, string> = {
      product: [row.asin, row.sku, row.title].map(text).filter(Boolean).join(' · '),
      company: text(row.name),
      companyProduct: [row.companyName, row.productLabel].map(text).filter(Boolean).join(' · '),
      supplier: text(row.displayName || row.normalizedName),
      supplierAccount: [row.supplierName, row.companyName, row.accountName].map(text).filter(Boolean).join(' · '),
      supplierProduct: [row.supplierName, row.productLabel, row.supplierSku].map(text).filter(Boolean).join(' · '),
      order: [row.orderRef, row.trackingId].map(text).filter(Boolean).join(' · '),
      orderLine: [row.orderLabel, row.productLabel, row.orderedQty].map(text).filter(Boolean).join(' · '),
      invoice: [row.orderLabel, row.invoiceNumber, row.status].map(text).filter(Boolean).join(' · '),
      inventorySnapshot: [row.productLabel, row.snapshotDate].map(text).filter(Boolean).join(' · '),
      listingDailyFact: [row.productLabel, row.snapshotDate].map(text).filter(Boolean).join(' · '),
      task: text(row.title),
      target: [row.metric, row.periodType, row.status].map(text).filter(Boolean).join(' · '),
      approval: [row.title, row.status].map(text).filter(Boolean).join(' · '),
      comment: text(row.body).slice(0, 80),
    };
    return {
      type,
      id,
      label: labelByType[type] || id,
      subtitle: ENTITY[type]?.title ?? type,
      match: 'id',
    };
  }
}

function emptyContext(): SilverResolvedContext {
  return {
    productIds: new Set(),
    companyIds: new Set(),
    companyProductIds: new Set(),
    supplierIds: new Set(),
    supplierAccountIds: new Set(),
    supplierProductIds: new Set(),
    orderIds: new Set(),
    orderLineIds: new Set(),
    invoiceIds: new Set(),
    inventorySnapshotIds: new Set(),
    listingDailyFactIds: new Set(),
    taskIds: new Set(),
    targetIds: new Set(),
    approvalIds: new Set(),
    commentIds: new Set(),
  };
}

function normalize(value: unknown) {
  return text(value).toLowerCase().trim();
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value);
}

function add(target: Set<string>, ...values: string[]) {
  values.filter(Boolean).forEach((value) => target.add(value));
}

function idsWhere(rows: Record<string, unknown>[], field: string, value: string) {
  return rows.filter((row) => text(row[field]) === value).map((row) => text(row.id));
}

function idsWhereDate(
  rows: Record<string, unknown>[],
  field: string,
  value: string,
  type: SilverEntityType,
  dateRange: SilverDateRange,
) {
  return rows
    .filter((row) => text(row[field]) === value && rowMatchesDate(type, row, dateRange))
    .map((row) => text(row.id));
}

function normalizeDateRange(params: { dateFrom?: string; dateTo?: string }): SilverDateRange {
  const selected = text(params.dateFrom || params.dateTo).trim();
  if (!selected) return { active: false };
  const from = parseDateBound(params.dateFrom || selected, 'dateFrom', false);
  const to = parseDateBound(params.dateTo || selected, 'dateTo', true);
  if (from > to) {
    throw new Error('Ecobase Silver Data date filter failed: dateFrom must be before dateTo.');
  }
  return {
    active: true,
    from,
    to,
    fromIso: new Date(from).toISOString(),
    toIso: new Date(to).toISOString(),
    fromDay: toDayString(from),
    toDay: toDayString(to),
  };
}

function toDayString(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

function parseDateBound(value: string, field: string, endOfDay: boolean) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Ecobase Silver Data date filter failed: ${field} must be YYYY-MM-DD.`);
  }
  const [, year, month, day] = match.map(Number);
  return Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
}

function rowMatchesDate(type: SilverEntityType, row: Record<string, unknown>, dateRange: SilverDateRange) {
  if (!dateRange.active) return true;
  const fields = DATE_FIELDS[type] ?? [];
  if (!fields.length) return false;
  return fields.some((field) => valueMatchesDate(row[field], dateRange));
}

function valueMatchesDate(value: unknown, dateRange: SilverDateRange) {
  const raw = text(value).trim();
  if (!raw) return false;
  const time = Date.parse(raw);
  return Number.isFinite(time) && time >= Number(dateRange.from) && time <= Number(dateRange.to);
}

function matchField(row: Record<string, unknown>, fields: string[], query: string) {
  return fields.find((field) => {
    const value = normalize(row[field]);
    return field === 'id' ? value === query : value.includes(query);
  });
}

function searchRank(result: SilverSearchResult, query: string) {
  const label = normalize(result.label);
  const typeRank = ['company', 'product', 'order', 'supplier', 'companyProduct', 'orderLine'].indexOf(result.type);
  return (label === query ? 0 : label.startsWith(query) ? 100 : 200) + (typeRank < 0 ? 50 : typeRank);
}

function findById(rows: Record<string, unknown>[] | undefined, id: string) {
  return rows?.find((row) => text(row.id) === id);
}

function shortRef(value: unknown) {
  const id = text(value);
  return id ? id.slice(-6) : '';
}

function productLabel(row?: Record<string, unknown>) {
  if (!row) return '';
  return [row.asin, row.sku, row.title].map(text).filter(Boolean).join(' · ');
}

function orderLabel(row?: Record<string, unknown>) {
  if (!row) return '';
  return [row.orderRef, row.trackingId].map(text).filter(Boolean).join(' · ') || shortRef(row.id);
}

function cleanEditableValues(values: Record<string, unknown>, allowed: Set<string>) {
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => allowed.has(key) && value !== undefined && value !== ''),
  );
}

function hasLinkedEntity(entities: Array<{ type: SilverEntityType; id: string }>, row: Record<string, unknown>) {
  const entityType = text(row.entityType);
  const entityId = text(row.entityId);
  return entities.some((entity) => entity.id === entityId && ENTITY_ALIASES[entity.type].includes(entityType));
}
