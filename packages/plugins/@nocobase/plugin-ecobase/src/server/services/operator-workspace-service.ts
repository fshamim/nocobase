import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';

type PlainRecord = Record<string, unknown>;

type CollectionAccess = 'read_only_audit' | 'operator_editable' | 'system_managed' | 'configuration';

interface CollectionDefinition {
  domain: string;
  collectionName: string;
  title: string;
  access: CollectionAccess;
  companyScoped?: boolean;
  sourceScoped?: boolean;
  latestImportRunScoped?: boolean;
}

interface ScopeContext {
  company?: string;
  companyId?: string;
  sourceConnectionId?: string;
  hasScope: boolean;
  sourceIds: Set<string>;
  importRunIds: Set<string>;
  importRuns: PlainRecord[];
  sourceAudits: PlainRecord[];
  rawRows: PlainRecord[];
}

export interface BusinessViewDefinition {
  key: string;
  title: string;
  domain: string;
  collectionName: string;
  description: string;
  filters: PlainRecord;
  sort: string[];
  columns: string[];
  groupBy?: string[];
  companyScoped: boolean;
  readOnly: boolean;
}

const DOMAIN_TITLES: Record<string, string> = {
  source_import: 'Source and import evidence',
  product_listing_facts: 'Product and listing facts',
  planning: 'Planning and replenishment',
  suppliers_orders: 'Suppliers and orders',
  alerts: 'Alerts and root cause',
  accountability: 'Accountability',
  reports: 'Reports',
  ai: 'AI evidence',
  accuracy: 'Accuracy and sign-off',
};

const COLLECTIONS: CollectionDefinition[] = [
  { domain: 'source_import', collectionName: ECOBASE_COLLECTIONS.companies, title: 'Companies', access: 'configuration', companyScoped: true },
  { domain: 'source_import', collectionName: ECOBASE_COLLECTIONS.amazonAccounts, title: 'Amazon accounts', access: 'configuration', companyScoped: true },
  { domain: 'source_import', collectionName: ECOBASE_COLLECTIONS.sourceConnections, title: 'Source connections', access: 'configuration', companyScoped: true, sourceScoped: true },
  { domain: 'source_import', collectionName: ECOBASE_COLLECTIONS.importRuns, title: 'Import runs', access: 'read_only_audit', sourceScoped: true },
  { domain: 'source_import', collectionName: ECOBASE_COLLECTIONS.rawImportRows, title: 'Raw import rows', access: 'read_only_audit', latestImportRunScoped: true },
  { domain: 'source_import', collectionName: ECOBASE_COLLECTIONS.sourceAccessAudits, title: 'Source access audits', access: 'read_only_audit', sourceScoped: true },
  { domain: 'source_import', collectionName: ECOBASE_COLLECTIONS.sourceWarningPolicies, title: 'Source warning policies', access: 'configuration' },
  { domain: 'product_listing_facts', collectionName: ECOBASE_COLLECTIONS.rawListings, title: 'Raw listings', access: 'read_only_audit', companyScoped: true, sourceScoped: true },
  { domain: 'product_listing_facts', collectionName: ECOBASE_COLLECTIONS.listingDailyFacts, title: 'Listing daily facts', access: 'system_managed', companyScoped: true, sourceScoped: true },
  { domain: 'product_listing_facts', collectionName: ECOBASE_COLLECTIONS.inventorySnapshots, title: 'Inventory snapshots', access: 'system_managed', companyScoped: true, sourceScoped: true },
  { domain: 'product_listing_facts', collectionName: ECOBASE_COLLECTIONS.trafficSnapshots, title: 'Traffic and buy-box snapshots', access: 'system_managed', companyScoped: true, sourceScoped: true },
  { domain: 'planning', collectionName: ECOBASE_COLLECTIONS.planningProducts, title: 'Planning products', access: 'system_managed', companyScoped: true },
  { domain: 'planning', collectionName: ECOBASE_COLLECTIONS.planningProductListings, title: 'Planning product listing links', access: 'system_managed', sourceScoped: true },
  { domain: 'planning', collectionName: ECOBASE_COLLECTIONS.planningProductMappingAudits, title: 'Planning mapping audits', access: 'read_only_audit', companyScoped: true },
  { domain: 'planning', collectionName: ECOBASE_COLLECTIONS.planningParameters, title: 'Planning parameters', access: 'operator_editable', companyScoped: true },
  { domain: 'planning', collectionName: ECOBASE_COLLECTIONS.targetRows, title: 'Target rows', access: 'system_managed', companyScoped: true },
  { domain: 'planning', collectionName: ECOBASE_COLLECTIONS.planningCalculationSnapshots, title: 'Planning calculation snapshots', access: 'read_only_audit', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.suppliers, title: 'Suppliers', access: 'system_managed', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.supplierLeadTimes, title: 'Supplier lead times', access: 'operator_editable', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.supplierExternalIdentities, title: 'Supplier external identities', access: 'read_only_audit', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.supplierProductLinks, title: 'Supplier product links', access: 'operator_editable', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.supplierOrders, title: 'Supplier orders', access: 'operator_editable', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.supplierOrderLines, title: 'Supplier order lines', access: 'operator_editable', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.supplierOrderActivities, title: 'Supplier order activities', access: 'operator_editable', companyScoped: true },
  { domain: 'suppliers_orders', collectionName: ECOBASE_COLLECTIONS.supplierOrderSettings, title: 'Supplier order settings', access: 'configuration' },
  { domain: 'alerts', collectionName: ECOBASE_COLLECTIONS.ruleVersions, title: 'Rule versions', access: 'read_only_audit' },
  { domain: 'alerts', collectionName: ECOBASE_COLLECTIONS.alertEvaluations, title: 'Alert evaluations', access: 'read_only_audit', companyScoped: true },
  { domain: 'alerts', collectionName: ECOBASE_COLLECTIONS.alerts, title: 'Alerts', access: 'operator_editable', companyScoped: true },
  { domain: 'accountability', collectionName: ECOBASE_COLLECTIONS.clickupTaskSnapshots, title: 'ClickUp task snapshots', access: 'read_only_audit', companyScoped: true },
  { domain: 'accountability', collectionName: ECOBASE_COLLECTIONS.taskLinks, title: 'Task links', access: 'system_managed', companyScoped: true },
  { domain: 'accountability', collectionName: ECOBASE_COLLECTIONS.okrs, title: 'OKRs', access: 'system_managed', companyScoped: true },
  { domain: 'accountability', collectionName: ECOBASE_COLLECTIONS.okrMetricSnapshots, title: 'OKR metric snapshots', access: 'read_only_audit', companyScoped: true },
  { domain: 'reports', collectionName: ECOBASE_COLLECTIONS.reportRuns, title: 'Report runs', access: 'read_only_audit', companyScoped: true },
  { domain: 'reports', collectionName: ECOBASE_COLLECTIONS.reportItems, title: 'Report items', access: 'read_only_audit', companyScoped: true },
  { domain: 'ai', collectionName: ECOBASE_COLLECTIONS.aiAnswers, title: 'AI answers', access: 'read_only_audit', companyScoped: true },
  { domain: 'accuracy', collectionName: ECOBASE_COLLECTIONS.dataQualitySignoffs, title: 'Data-quality sign-offs', access: 'operator_editable', companyScoped: true },
  { domain: 'accuracy', collectionName: ECOBASE_COLLECTIONS.benchmarkFixtures, title: 'Benchmark fixtures', access: 'configuration' },
  { domain: 'accuracy', collectionName: ECOBASE_COLLECTIONS.accuracyEvaluationRuns, title: 'Accuracy evaluation runs', access: 'read_only_audit', companyScoped: true },
];

const STARTER_VIEWS: BusinessViewDefinition[] = [
  starterView('latest-products', 'Latest imported products', 'product_listing_facts', ECOBASE_COLLECTIONS.planningProducts, 'Review current planning products by company.', ['company', 'canonicalAsin', 'title', 'mappingStatus', 'listingCount', 'lastImportRunId'], { mappingStatus: 'needs_review' }, ['company', 'canonicalAsin']),
  starterView('oos-reorder-candidates', 'OOS and reorder candidates', 'planning', ECOBASE_COLLECTIONS.planningCalculationSnapshots, 'Find products with reorder or OOS risk evidence.', ['company', 'planningProductId', 'tier', 'calculationStatus', 'estimatedProfitRisk', 'evidence'], { calculationStatus: 'needs_reorder' }, ['-estimatedProfitRisk']),
  starterView('critical-alerts', 'Critical alerts', 'alerts', ECOBASE_COLLECTIONS.alerts, 'Open high-priority alert queue grouped by company.', ['company', 'severity', 'status', 'title', 'primaryRootCauseCode', 'openedAt'], { status: 'open', severity: 'critical' }, ['company', '-openedAt'], ['company']),
  starterView('open-supplier-orders', 'Open supplier orders', 'suppliers_orders', ECOBASE_COLLECTIONS.supplierOrders, 'Supplier orders still in an active operational state.', ['company', 'externalOrderRef', 'supplierId', 'status', 'expectedDeliveryDate', 'lastSupplierContactAt'], { status: 'open' }, ['company', 'expectedDeliveryDate'], ['company']),
  starterView('report-preview-items', 'Report preview items', 'reports', ECOBASE_COLLECTIONS.reportItems, 'Generated report cards and evidence lines for review.', ['company', 'reportRunId', 'section', 'severity', 'title', 'body'], {}, ['company', 'section'], ['company', 'section']),
  starterView('ai-evidence-answers', 'AI evidence answers', 'ai', ECOBASE_COLLECTIONS.aiAnswers, 'AI answers with deterministic database evidence.', ['company', 'question', 'answerStatus', 'createdAt', 'evidence'], {}, ['company', '-createdAt'], ['company']),
  starterView('stale-source-warnings', 'Stale or missing source warnings', 'source_import', ECOBASE_COLLECTIONS.sourceAccessAudits, 'Blocked, stale, or failed source access evidence.', ['sourceConnectionId', 'sourceType', 'status', 'blockerCode', 'message', 'createdAt'], { status: 'stale' }, ['-createdAt']),
];

function starterView(
  key: string,
  title: string,
  domain: string,
  collectionName: string,
  description: string,
  columns: string[],
  filters: PlainRecord,
  sort: string[],
  groupBy: string[] = [],
): BusinessViewDefinition {
  return { key, title, domain, collectionName, description, columns, filters, sort, groupBy, companyScoped: columns.includes('company'), readOnly: true };
}

function asRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function compactFilter(filter: PlainRecord) {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function sourceCompanyId(source: PlainRecord) {
  const relation = asRecord(source.company);
  return asString(source.companyId) ?? asString(relation.id);
}

function sourceCompanyName(source: PlainRecord, companiesById: Map<string, PlainRecord>) {
  const relation = asRecord(source.company);
  return asString(source.companyName) ?? asString(source.company) ?? asString(relation.name) ?? asString(companiesById.get(String(sourceCompanyId(source) ?? ''))?.name);
}

function toPlainRecord(value: unknown): PlainRecord {
  return asRecord(typeof (value as { toJSON?: unknown })?.toJSON === 'function' ? (value as { toJSON: () => unknown }).toJSON() : value);
}

function latestByDate(records: PlainRecord[], field: string) {
  return [...records].sort((left, right) => String(right[field] ?? '').localeCompare(String(left[field] ?? '')))[0];
}

function isWarningAudit(record: PlainRecord) {
  const status = asString(record.status);
  return status === 'blocked' || status === 'stale' || status === 'failed' || status === 'warning';
}

function matchesFilter(row: PlainRecord, filter: PlainRecord) {
  return Object.entries(filter).every(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return true;
    }
    if (typeof value === 'object' && value !== null && Array.isArray((value as PlainRecord).$in)) {
      return ((value as { $in: unknown[] }).$in).includes(row[key]);
    }
    return row[key] === value;
  });
}

function sortRows(rows: PlainRecord[], sort: string[]) {
  return [...rows].sort((left, right) => {
    for (const entry of sort) {
      const descending = entry.startsWith('-');
      const key = descending ? entry.slice(1) : entry;
      const leftValue = String(left[key] ?? '');
      const rightValue = String(right[key] ?? '');
      if (leftValue !== rightValue) {
        const result = leftValue > rightValue ? 1 : -1;
        return descending ? -result : result;
      }
    }
    return 0;
  });
}

function groupRows(rows: PlainRecord[], groupBy: string[]) {
  if (groupBy.length === 0) {
    return [];
  }
  const groups = new Map<string, { key: PlainRecord; rowCount: number }>();
  rows.forEach((row) => {
    const key = Object.fromEntries(groupBy.map((field) => [field, row[field] ?? null]));
    const serialized = JSON.stringify(key);
    const current = groups.get(serialized) ?? { key, rowCount: 0 };
    current.rowCount += 1;
    groups.set(serialized, current);
  });
  return [...groups.values()];
}

export class EcobaseOperatorWorkspaceService {
  constructor(private db: EcobaseDatabase) {}

  async getWorkspace(filters: PlainRecord = {}) {
    const scope = await this.resolveScope(filters);
    const savedViews = await this.savedBusinessViews();
    const collectionSummaries = await Promise.all(COLLECTIONS.map(async (definition) => this.collectionSummary(definition, scope)));

    return {
      filters: { company: scope.company, sourceConnectionId: scope.sourceConnectionId },
      scopeRequired: !scope.hasScope,
      scopeMessage: scope.hasScope ? null : 'Select a company or source connection before opening rows so data from multiple companies is never mixed by default.',
      permissionModel: {
        rawEvidence: 'read-only list/get only; raw rows are scoped through their import run and source connection',
        operationalRecords: 'operator edits use normalized operational records and dedicated resource actions',
        configuration: 'admin/configuration mutations are separate from operator read and preview access',
      },
      domains: Object.entries(DOMAIN_TITLES).map(([key, title]) => ({
        key,
        title,
        collections: collectionSummaries.filter((summary) => summary.domain === key),
      })),
      starterViews: STARTER_VIEWS.map((view) => this.applyScope(view, scope)),
      savedViews: savedViews.map((view) => this.applyScope(view, scope)),
    };
  }

  async previewView(values: PlainRecord) {
    const viewKey = asString(values.viewKey);
    const collectionName = asString(values.collectionName);
    const filters = asRecord(values.filters);
    const scope = await this.resolveScope(filters);
    if (!scope.hasScope) {
      throw new Error('Ecobase operator workspace preview failed: company or sourceConnectionId scope is required.');
    }
    const view = viewKey ? [...STARTER_VIEWS, ...(await this.savedBusinessViews())].find((candidate) => candidate.key === viewKey) : undefined;
    const targetCollection = collectionName ?? view?.collectionName;
    const definition = COLLECTIONS.find((candidate) => candidate.collectionName === targetCollection);
    if (!targetCollection || !definition) {
      throw new Error(`Ecobase operator workspace preview failed: collection "${targetCollection ?? 'unknown'}" is not exposed.`);
    }
    const scopedView = view ? this.applyScope(view, scope) : undefined;
    const viewFilter = { ...(scopedView?.filters ?? {}) };
    delete viewFilter.company;
    delete viewFilter.sourceConnectionId;
    const limit = Math.min(Math.max(Number(values.limit) || 25, 1), 100);
    const scopedFilter = this.collectionFilter(definition, scope);
    if (!scopedFilter) {
      throw new Error(`Ecobase operator workspace preview failed: collection "${targetCollection}" cannot be safely scoped.`);
    }
    const queryFilter = compactFilter({ ...scopedFilter, ...viewFilter });
    const [rows, rowCount] = await Promise.all([
      this.findAll(targetCollection, queryFilter, { limit }),
      this.count(targetCollection, queryFilter),
    ]);
    const sortedRows = sortRows(rows, scopedView?.sort ?? []);
    return {
      viewKey: viewKey ?? null,
      collectionName: targetCollection,
      readOnly: definition.access === 'read_only_audit',
      rows: sortedRows,
      rowCount,
      filters: { ...viewFilter, company: scope.company, sourceConnectionId: scope.sourceConnectionId },
      sort: scopedView?.sort ?? [],
      groupBy: scopedView?.groupBy ?? [],
      groupedRows: groupRows(sortedRows, scopedView?.groupBy ?? []),
      columns: scopedView?.columns.length ? scopedView.columns : Object.keys(sortedRows[0] ?? {}),
    };
  }

  async saveBusinessView(values: PlainRecord) {
    const title = asString(values.title);
    const collectionName = asString(values.collectionName);
    if (!title) {
      throw new Error('Ecobase operator workspace save view failed: title is required.');
    }
    const definition = COLLECTIONS.find((candidate) => candidate.collectionName === collectionName);
    if (!definition) {
      throw new Error(`Ecobase operator workspace save view failed: collection "${collectionName ?? 'unknown'}" is not exposed.`);
    }
    const view: BusinessViewDefinition = {
      key: asString(values.key) ?? `saved-${randomUUID()}`,
      title,
      domain: definition.domain,
      collectionName: definition.collectionName,
      description: asString(values.description) ?? 'Operator saved business view.',
      filters: asRecord(values.filters),
      sort: Array.isArray(values.sort) ? values.sort.filter((item): item is string => typeof item === 'string') : [],
      columns: Array.isArray(values.columns) ? values.columns.filter((item): item is string => typeof item === 'string') : [],
      groupBy: Array.isArray(values.groupBy) ? values.groupBy.filter((item): item is string => typeof item === 'string') : [],
      companyScoped: Boolean(definition.companyScoped),
      readOnly: definition.access === 'read_only_audit',
    };
    await this.db.getRepository(ECOBASE_COLLECTIONS.ruleVersions).create({
      values: {
        id: randomUUID(),
        name: view.title,
        ruleType: 'operator_business_view',
        config: view,
        activeFrom: new Date().toISOString(),
        active: true,
      },
    });
    return view;
  }

  private async resolveScope(filters: PlainRecord): Promise<ScopeContext> {
    const requestedCompany = asString(filters.company);
    const requestedSourceConnectionId = asString(filters.sourceConnectionId);
    const companies = await this.findAll(ECOBASE_COLLECTIONS.companies);
    const companiesById = new Map(companies.map((company) => [String(company.id), company]));
    const companyByRequestedValue = requestedCompany
      ? companies.find((company) => company.name === requestedCompany || company.id === requestedCompany)
      : undefined;
    const requestedCompanyId = asString(companyByRequestedValue?.id);
    const requestedCompanyName = asString(companyByRequestedValue?.name) ?? requestedCompany;
    const sourceConnections = await this.findAll(ECOBASE_COLLECTIONS.sourceConnections);
    const scopedSources = sourceConnections.filter((source) => {
      const id = asString(source.id);
      const companyId = sourceCompanyId(source);
      const companyName = sourceCompanyName(source, companiesById);
      if (requestedSourceConnectionId && id !== requestedSourceConnectionId) {
        return false;
      }
      if (requestedCompany && companyId !== requestedCompanyId && companyName !== requestedCompanyName) {
        return false;
      }
      return Boolean(requestedSourceConnectionId || requestedCompany);
    });
    const sourceIds = new Set(scopedSources.map((source) => asString(source.id)).filter((id): id is string => Boolean(id)));
    if (requestedSourceConnectionId && sourceIds.size === 0) {
      sourceIds.add(requestedSourceConnectionId);
    }
    const importRuns = await this.findAll(ECOBASE_COLLECTIONS.importRuns, sourceIds.size > 0 ? { sourceConnectionId: { $in: [...sourceIds] } } : {});
    const scopedImportRuns = importRuns.filter((run) => sourceIds.has(String(run.sourceConnectionId ?? '')));
    const importRunIds = new Set(scopedImportRuns.map((run) => asString(run.id)).filter((id): id is string => Boolean(id)));
    const sourceAudits = await this.findAll(ECOBASE_COLLECTIONS.sourceAccessAudits, sourceIds.size > 0 ? { sourceConnectionId: { $in: [...sourceIds] } } : {});
    const rawRows = await this.findAll(ECOBASE_COLLECTIONS.rawImportRows, importRunIds.size > 0 ? { importRunId: { $in: [...importRunIds] } } : {});
    const derivedCompanyId = requestedCompanyId ?? sourceCompanyId(scopedSources[0] ?? {});
    const derivedCompanyName = requestedCompanyName ?? sourceCompanyName(scopedSources[0] ?? {}, companiesById);
    return {
      company: derivedCompanyName,
      companyId: derivedCompanyId,
      sourceConnectionId: requestedSourceConnectionId,
      hasScope: Boolean(requestedCompany || requestedSourceConnectionId),
      sourceIds,
      importRunIds,
      importRuns: scopedImportRuns,
      sourceAudits,
      rawRows,
    };
  }

  private applyScope(view: BusinessViewDefinition, scope: ScopeContext) {
    const scopedFilters = { ...view.filters };
    if (view.companyScoped && scope.company) {
      scopedFilters.company = scope.company;
    }
    const definition = COLLECTIONS.find((candidate) => candidate.collectionName === view.collectionName);
    if (scope.sourceConnectionId && definition?.sourceScoped) {
      scopedFilters.sourceConnectionId = scope.sourceConnectionId;
    }
    return { ...view, filters: scopedFilters };
  }

  private async collectionSummary(definition: CollectionDefinition, scope: ScopeContext) {
    const rowCount = await this.scopedRowCount(definition, scope);
    const latestImportRun = latestByDate(scope.importRuns, 'startedAt');
    const warningCount = scope.sourceAudits.filter(isWarningAudit).length + scope.rawRows.filter((row) => row.issueSeverity === 'warning' || row.issueSeverity === 'error' || row.normalizedStatus === 'failed').length;
    const latestRunStatus = asString(latestImportRun?.status);
    return {
      domain: definition.domain,
      collectionName: definition.collectionName,
      title: definition.title,
      access: definition.access,
      readOnly: definition.access === 'read_only_audit',
      companyScoped: Boolean(definition.companyScoped),
      sourceScoped: Boolean(definition.sourceScoped),
      rowCount,
      latestImportRun: latestImportRun
        ? {
            id: latestImportRun.id,
            status: latestRunStatus,
            startedAt: latestImportRun.startedAt,
            completedAt: latestImportRun.completedAt,
          }
        : null,
      freshnessStatus: !scope.hasScope ? 'scope_required' : latestRunStatus === 'success' ? 'fresh' : latestRunStatus === 'stale' ? 'stale' : latestRunStatus ? 'attention' : 'no_imports',
      warningCount,
      starterViewKeys: STARTER_VIEWS.filter((view) => view.collectionName === definition.collectionName).map((view) => view.key),
    };
  }

  private async scopedRowCount(definition: CollectionDefinition, scope: ScopeContext) {
    if (!scope.hasScope) {
      return 0;
    }
    const filter = this.collectionFilter(definition, scope);
    if (filter) {
      const repository = this.db.getRepository(definition.collectionName) as { count?: (params: { filter: PlainRecord }) => Promise<number> | number };
      if (typeof repository.count === 'function') {
        try {
          return await repository.count({ filter });
        } catch {
          return this.scopedRows(definition, await this.findAll(definition.collectionName), scope).length;
        }
      }
    }
    return this.scopedRows(definition, await this.findAll(definition.collectionName), scope).length;
  }

  private collectionFilter(definition: CollectionDefinition, scope: ScopeContext): PlainRecord | null {
    if (!scope.hasScope) {
      return null;
    }
    if (definition.latestImportRunScoped) {
      return scope.importRunIds.size > 0 ? { importRunId: { $in: [...scope.importRunIds] } } : null;
    }
    if (definition.collectionName === ECOBASE_COLLECTIONS.sourceConnections) {
      if (scope.sourceConnectionId) {
        return { id: scope.sourceConnectionId };
      }
      if (scope.companyId) {
        return { companyId: scope.companyId };
      }
      return scope.sourceIds.size > 0 ? { id: { $in: [...scope.sourceIds] } } : null;
    }
    if (definition.sourceScoped) {
      if (scope.sourceConnectionId) {
        return { sourceConnectionId: scope.sourceConnectionId };
      }
      return scope.sourceIds.size > 0 ? { sourceConnectionId: { $in: [...scope.sourceIds] } } : null;
    }
    if (definition.collectionName === ECOBASE_COLLECTIONS.companies && scope.company) {
      return scope.companyId ? { id: scope.companyId } : { name: scope.company };
    }
    if (definition.collectionName === ECOBASE_COLLECTIONS.amazonAccounts && scope.companyId) {
      return { companyId: scope.companyId };
    }
    if (definition.companyScoped && scope.company) {
      return { company: scope.company };
    }
    return !definition.companyScoped && !definition.sourceScoped ? {} : null;
  }

  private scopedRows(definition: CollectionDefinition, rows: PlainRecord[], scope: ScopeContext) {
    if (!scope.hasScope) {
      return [];
    }
    return rows.filter((row) => {
      if (definition.latestImportRunScoped) {
        return scope.importRunIds.has(String(row.importRunId ?? ''));
      }
      if (definition.collectionName === ECOBASE_COLLECTIONS.sourceConnections) {
        return scope.sourceIds.has(String(row.id ?? '')) || (scope.companyId !== undefined && row.companyId === scope.companyId);
      }
      if (definition.sourceScoped && scope.sourceIds.size > 0 && row.sourceConnectionId !== undefined) {
        return scope.sourceIds.has(String(row.sourceConnectionId));
      }
      if (definition.collectionName === ECOBASE_COLLECTIONS.amazonAccounts && scope.companyId && row.companyId !== undefined) {
        return row.companyId === scope.companyId;
      }
      if (definition.companyScoped && scope.company && row.company !== undefined) {
        return row.company === scope.company;
      }
      if (definition.companyScoped && scope.company && row.name !== undefined && definition.collectionName === ECOBASE_COLLECTIONS.companies) {
        return row.name === scope.company;
      }
      return !definition.companyScoped && !definition.sourceScoped;
    });
  }

  private async savedBusinessViews(): Promise<BusinessViewDefinition[]> {
    const rows = await this.findAll(ECOBASE_COLLECTIONS.ruleVersions, { ruleType: 'operator_business_view', active: true });
    return rows
      .map((row) => asRecord(row.config))
      .filter((config) => Boolean(asString(config.key) && asString(config.collectionName)))
      .map((config) => config as unknown as BusinessViewDefinition);
  }

  private async count(collectionName: string, filter: PlainRecord = {}) {
    const repository = this.db.getRepository(collectionName) as { count?: (params: { filter: PlainRecord }) => Promise<number> | number };
    if (typeof repository.count === 'function') {
      try {
        return await repository.count({ filter });
      } catch {
        return (await this.findAll(collectionName, filter)).length;
      }
    }
    return (await this.findAll(collectionName, filter)).length;
  }

  private async findAll(collectionName: string, filter: PlainRecord = {}, options: { limit?: number; sort?: string[] } = {}) {
    const rows = await this.db.getRepository(collectionName).find({ filter, limit: options.limit, sort: options.sort });
    return rows.map(toPlainRecord);
  }
}
