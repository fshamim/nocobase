import { createHash, randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from './import-service';
import { toPlainRecord } from './import-service';
import { EcobaseDataWarningService, type EcobaseDataWarning } from './data-warning-service';
import { EcobaseInventoryPlanningService } from './inventory-planning-service';
import { isReliableSupplierOrderCoverageStatus, normalizeSupplierOrderStatus } from './supplier-order-service';

type PlainRecord = Record<string, unknown>;
type DailyBriefFocus = 'inventory_risk' | 'supplier_orders' | 'buybox' | 'velocity' | 'profit_gap' | 'okr' | 'source_quality' | 'no_major_exception';

type DailyBriefMode = 'preview' | 'workflow' | 'workflow_send';

type RepositoryWithDestroy = EcobaseRepository & {
  destroy?: (params: { filter?: PlainRecord; filterByTk?: string | number }) => Promise<unknown>;
};

export type GenerateDailyOperationsBriefEvidenceParams = {
  date?: string;
  company?: string;
  timezone?: string;
  recipient?: string;
  mode?: DailyBriefMode;
  maxItems?: number;
  forceRegenerate?: boolean;
};

export type SourceStatusEvidence = {
  evidenceId: string;
  sourceConnectionId: string;
  connectionName: string;
  sourceType: string;
  domain: string;
  active: boolean;
  required: boolean;
  freshnessSlaMinutes: number | null;
  latestImportRunId: string | null;
  latestRunStatus: string | null;
  latestSuccessfulRunAt: string | null;
  lastRunAt: string | null;
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  errorCount: number;
  warnings: Array<Pick<EcobaseDataWarning, 'code' | 'message' | 'severity' | 'observedAt' | 'metadata'>>;
};

export type InventoryRiskEvidence = {
  evidenceId: string;
  company?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  title?: string;
  tier?: string;
  actionStatus?: string;
  sellableStock?: number;
  reservedStock?: number;
  pipelineStock?: number;
  velocityPerDay?: number;
  estimatedOosDate?: string;
  latestSafeReorderDate?: string;
  overdueDays?: number;
  daysUntilAction?: number;
  suggestedReorderQty?: number;
  supplierId?: string;
  supplierName?: string;
  supplierEvidenceState: 'known' | 'fallback_or_inferred' | 'missing';
  leadTimeDays?: number;
  leadTimeFreshness?: string;
  openSupplierOrderCoverageQty?: number;
  supplierOrderState?: string;
  supplierOrderStatus?: string;
  supplierOrderRef?: string;
  latestClosedOrCancelledOrderRef?: string;
  estimatedProfitRisk?: number;
  caveats: string[];
  sourceWarnings: PlainRecord[];
};

export type SupplierOrderEvidence = {
  evidenceId: string;
  company?: string;
  supplierOrderId?: string;
  externalOrderRef?: string;
  supplierId?: string;
  supplierName?: string;
  status?: string;
  coverageState: 'draft_or_planned' | 'approval_pending' | 'payment_pending' | 'purchased_or_inbound' | 'closed_or_paid' | 'cancelled' | 'blocked' | 'unknown';
  isTrustedCoverage: boolean;
  lineCount: number;
  openQty: number;
  relatedProducts: Array<{
    supplierOrderLineId?: string;
    planningProductId?: string;
    asin?: string;
    sku?: string;
    orderedQty?: number;
    receivedQty?: number;
    openQty: number;
    expectedSellableDate?: string;
  }>;
  orderDate?: string;
  expectedDeliveryDate?: string;
  lastMeaningfulUpdateAt?: string;
};

export type LeadTimeIssueEvidence = {
  evidenceId: string;
  company?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  supplierId?: string;
  supplierName?: string;
  leadTimeDays?: number;
  leadTimeFreshness?: string;
  leadTimeConfirmedAt?: string;
  actionRequired: 'contact_supplier_for_lead_time' | 'refresh_stale_lead_time';
};

export type DataWarningEvidence = {
  evidenceId: string;
  code: string;
  message: string;
  severity: 'warning' | 'info';
  sourceConnectionId?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  metadata: PlainRecord;
};

export type PerformanceTrendEvidence = {
  evidenceId: string;
  trendType: 'velocity_drop' | 'profit_gap';
  company?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  currentDate: string;
  baselineDate?: string;
  currentUnits?: number;
  baselineUnits?: number;
  currentRevenue?: number;
  baselineRevenue?: number;
  currentProfit?: number;
  baselineProfit?: number;
  targetUnits?: number;
  targetProfit?: number;
  velocityDropPercent?: number;
  revenueDropPercent?: number;
  profitGap?: number;
  estimatedProfitImpact?: number;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
};

export type BuyBoxRiskEvidence = {
  evidenceId: string;
  company?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  currentDate: string;
  baselineDate?: string;
  currentBuyBoxWinRate?: number;
  baselineBuyBoxWinRate?: number;
  winRateDropPoints?: number;
  thresholdBreach: boolean;
  currentUnitsOrdered?: number;
  currentOrderedProductSales?: number;
  sourceFreshness: 'fresh' | 'stale_or_missing';
  warnings: string[];
};

export type OkrAccountabilityRiskEvidence = {
  evidenceId: string;
  riskType: 'okr_off_track' | 'task_overdue' | 'task_inactive';
  company?: string;
  okrId?: string;
  externalOkrId?: string;
  okrTitle?: string;
  metricName?: string;
  owner?: string;
  operationalArea?: string;
  period?: string;
  progressPercent?: number;
  expectedProgressPercent?: number;
  status?: string;
  taskId?: string;
  taskName?: string;
  taskStatus?: string;
  taskPriority?: string;
  assignee?: string;
  dueDate?: string;
  lastMeaningfulUpdateAt?: string;
  evidenceFreshness: 'fresh' | 'stale_or_incomplete';
  warnings: string[];
};

export type DailyEvidencePack = {
  generatedAt: string;
  date: string;
  timezone: string;
  company?: { id?: string; name?: string };
  focus: DailyBriefFocus;
  focusReason: string;
  summaryCounts: Record<string, number>;
  sourceStatus: SourceStatusEvidence[];
  inventoryRisks: InventoryRiskEvidence[];
  supplierOrderContext: SupplierOrderEvidence[];
  leadTimeIssues: LeadTimeIssueEvidence[];
  performanceTrends: PerformanceTrendEvidence[];
  buyBoxRisks: BuyBoxRiskEvidence[];
  okrAccountabilityRisks: OkrAccountabilityRiskEvidence[];
  dataWarnings: DataWarningEvidence[];
  omissions: string[];
  assumptions: string[];
};

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return asString(value);
}

function recordPayload(record: PlainRecord) {
  return isRecord(record.payload) ? record.payload : {};
}

function payloadString(record: PlainRecord, keys: string[]): string | undefined {
  const payload = recordPayload(record);
  for (const key of keys) {
    const direct = asString(record[key]);
    if (direct) return direct;
    const nested = asString(payload[key]);
    if (nested) return nested;
  }
  return undefined;
}

function safeNumber(value: unknown) {
  return asNumber(value) ?? 0;
}

function stableHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidenceId(prefix: string, value: unknown) {
  return `${prefix}:${stableHash(value).slice(0, 16)}`;
}

function normalizeDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Ecobase daily operations brief failed: ${label} must be an ISO date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Ecobase daily operations brief failed: ${label} is not a valid calendar date.`);
  }
  return value;
}

function dateInTimezone(timezone: string, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch (error) {
    throw new Error(`Ecobase daily operations brief failed: timezone "${timezone}" is not supported.`);
  }
  return now.toISOString().slice(0, 10);
}

function diffDays(left: string, right: string) {
  return Math.round((new Date(`${left}T00:00:00.000Z`).getTime() - new Date(`${right}T00:00:00.000Z`).getTime()) / 86_400_000);
}

function dateBefore(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function monthPeriod(date: string) {
  return date.slice(0, 7);
}

function percentageDrop(current: number | undefined, baseline: number | undefined) {
  if (typeof current !== 'number' || typeof baseline !== 'number' || baseline <= 0 || current >= baseline) return undefined;
  return Math.round(((baseline - current) / baseline) * 1000) / 10;
}

function productIdentity(row: PlainRecord) {
  return [asString(row.company), asString(row.planningProductId), asString(row.asin), asString(row.sku)].join(':');
}

function orderLineMatchesRisk(line: PlainRecord, risk: PlainRecord) {
  const linePlanningProductId = asString(line.planningProductId);
  const riskPlanningProductId = asString(risk.planningProductId);
  const lineAsin = asString(line.asin)?.toUpperCase();
  const riskAsin = asString(risk.asin)?.toUpperCase();
  const lineSku = asString(line.sku);
  const riskSku = asString(risk.sku);
  return Boolean(
    (linePlanningProductId && riskPlanningProductId && linePlanningProductId === riskPlanningProductId) ||
    (lineAsin && riskAsin && lineAsin === riskAsin) ||
    (lineSku && riskSku && lineSku === riskSku)
  );
}

function orderCoverageState(status: string | undefined): SupplierOrderEvidence['coverageState'] {
  const normalized = normalizeSupplierOrderStatus(status);
  if (normalized === 'draft' || normalized === 'supplier_contacted' || normalized === 'supplier_confirmed') return 'draft_or_planned';
  if (normalized === 'approval_pending') return 'approval_pending';
  if (normalized === 'payment_pending') return 'payment_pending';
  if (['paid', 'supplier_preparing', 'shipped_inbound', 'reached_fba'].includes(normalized)) return 'purchased_or_inbound';
  if (normalized === 'completed') return 'closed_or_paid';
  if (normalized === 'cancelled' || normalized === 'rejected') return 'cancelled';
  if (normalized === 'blocked') return 'blocked';
  return 'unknown';
}

type DailyBriefEvidenceItem = InventoryRiskEvidence | SupplierOrderEvidence | LeadTimeIssueEvidence | PerformanceTrendEvidence | BuyBoxRiskEvidence | OkrAccountabilityRiskEvidence | DataWarningEvidence;

function isInventoryRiskEvidence(item: DailyBriefEvidenceItem): item is InventoryRiskEvidence {
  return Object.prototype.hasOwnProperty.call(item, 'actionStatus');
}

function isSupplierOrderEvidence(item: DailyBriefEvidenceItem): item is SupplierOrderEvidence {
  return Object.prototype.hasOwnProperty.call(item, 'coverageState');
}

function isLeadTimeIssueEvidence(item: DailyBriefEvidenceItem): item is LeadTimeIssueEvidence {
  return Object.prototype.hasOwnProperty.call(item, 'actionRequired');
}

function isPerformanceTrendEvidence(item: DailyBriefEvidenceItem): item is PerformanceTrendEvidence {
  return Object.prototype.hasOwnProperty.call(item, 'trendType');
}

function isBuyBoxRiskEvidence(item: DailyBriefEvidenceItem): item is BuyBoxRiskEvidence {
  return Object.prototype.hasOwnProperty.call(item, 'currentBuyBoxWinRate');
}

function isOkrAccountabilityRiskEvidence(item: DailyBriefEvidenceItem): item is OkrAccountabilityRiskEvidence {
  return Object.prototype.hasOwnProperty.call(item, 'riskType');
}

function reportItemTitle(item: DailyBriefEvidenceItem) {
  if (isInventoryRiskEvidence(item)) {
    return `Inventory risk: ${item.asin ?? item.planningProductId ?? item.sku ?? 'unknown product'}`;
  }
  if (isSupplierOrderEvidence(item)) {
    return `Supplier order: ${item.externalOrderRef ?? item.supplierOrderId ?? 'unknown order'}`;
  }
  if (isLeadTimeIssueEvidence(item)) {
    return `Lead-time action: ${item.asin ?? item.planningProductId ?? item.supplierName ?? 'unknown product'}`;
  }
  if (isBuyBoxRiskEvidence(item)) {
    return `Buy Box risk: ${item.asin ?? item.planningProductId ?? item.sku ?? 'unknown product'}`;
  }
  if (isPerformanceTrendEvidence(item)) {
    return item.trendType === 'profit_gap'
      ? `Profit gap: ${item.asin ?? item.planningProductId ?? item.sku ?? 'unknown product'}`
      : `Velocity drop: ${item.asin ?? item.planningProductId ?? item.sku ?? 'unknown product'}`;
  }
  if (isOkrAccountabilityRiskEvidence(item)) {
    return item.riskType === 'okr_off_track'
      ? `OKR off track: ${item.okrTitle ?? item.metricName ?? item.externalOkrId ?? 'unknown OKR'}`
      : `Task needs attention: ${item.taskName ?? item.taskId ?? 'unknown task'}`;
  }
  return `Data warning: ${item.code}`;
}

function reportItemBody(item: DailyBriefEvidenceItem) {
  if (isInventoryRiskEvidence(item)) {
    return `Action ${item.actionStatus ?? 'review'} for ${item.asin ?? item.planningProductId ?? item.sku ?? 'unknown product'}; supplier ${item.supplierName ?? 'unknown'}; lead time ${item.leadTimeDays ?? 'missing'} days; trusted open coverage ${item.openSupplierOrderCoverageQty ?? 0}.`;
  }
  if (isSupplierOrderEvidence(item)) {
    return `Status ${item.status ?? 'unknown'} maps to ${item.coverageState}; trusted coverage ${item.isTrustedCoverage ? 'yes' : 'no'}; open quantity ${item.openQty}.`;
  }
  if (isLeadTimeIssueEvidence(item)) {
    return `${item.actionRequired} for supplier ${item.supplierName ?? 'unknown'}; freshness ${item.leadTimeFreshness ?? 'missing'}.`;
  }
  if (isBuyBoxRiskEvidence(item)) {
    return `Buy Box ${item.currentBuyBoxWinRate ?? 'missing'}% vs baseline ${item.baselineBuyBoxWinRate ?? 'missing'}%; drop ${item.winRateDropPoints ?? 0} points; source ${item.sourceFreshness}.`;
  }
  if (isPerformanceTrendEvidence(item)) {
    return item.trendType === 'profit_gap'
      ? `Profit ${item.currentProfit ?? 'missing'} vs target ${item.targetProfit ?? 'missing'}; gap ${item.profitGap ?? 'unknown'}; confidence ${item.confidence}.`
      : `Units ${item.currentUnits ?? 'missing'} vs baseline ${item.baselineUnits ?? 'missing'}; velocity drop ${item.velocityDropPercent ?? 0}%; confidence ${item.confidence}.`;
  }
  if (isOkrAccountabilityRiskEvidence(item)) {
    return item.riskType === 'okr_off_track'
      ? `Status ${item.status ?? 'unknown'}; progress ${item.progressPercent ?? 'missing'}%; owner ${item.owner ?? 'unknown'}; evidence ${item.evidenceFreshness}.`
      : `Task status ${item.taskStatus ?? 'unknown'}; assignee ${item.assignee ?? 'unknown'}; due ${item.dueDate ?? 'missing'}; last update ${item.lastMeaningfulUpdateAt ?? 'missing'}.`;
  }
  return item.message;
}

function reportSeverity(item: DailyBriefEvidenceItem) {
  if (isInventoryRiskEvidence(item) && ['overdue', 'order_today', 'missing_lead_time'].includes(item.actionStatus ?? '')) return 'warning';
  if (isSupplierOrderEvidence(item) && ['approval_pending', 'payment_pending', 'blocked'].includes(item.coverageState)) return 'warning';
  if (isLeadTimeIssueEvidence(item)) return 'warning';
  if (isPerformanceTrendEvidence(item) || isBuyBoxRiskEvidence(item) || isOkrAccountabilityRiskEvidence(item)) return 'warning';
  return (item as DataWarningEvidence).severity;
}

function compactWarning(warning: EcobaseDataWarning): SourceStatusEvidence['warnings'][number] {
  return {
    code: warning.code,
    message: warning.message,
    severity: warning.severity,
    observedAt: warning.observedAt,
    metadata: warning.metadata,
  };
}

function sourceCompany(record: PlainRecord) {
  return asString(record.company) ?? asString(record.companyName) ?? payloadString(record, ['company', 'Company']);
}

function sourceMatchesCompany(record: PlainRecord, company?: string) {
  if (!company) return true;
  const label = sourceCompany(record);
  return !label || label === company;
}

function openQty(line: PlainRecord) {
  return Math.max(safeNumber(line.orderedQty) - safeNumber(line.receivedQty), 0);
}

function itemTypeFor(item: DailyBriefEvidenceItem) {
  if (isInventoryRiskEvidence(item)) return 'inventory_risk';
  if (isSupplierOrderEvidence(item)) return 'supplier_order_action';
  if (isLeadTimeIssueEvidence(item)) return 'missing_lead_time';
  if (isBuyBoxRiskEvidence(item)) return 'buybox_risk';
  if (isPerformanceTrendEvidence(item)) return item.trendType === 'profit_gap' ? 'profit_gap' : 'velocity_drop';
  if (isOkrAccountabilityRiskEvidence(item)) return item.riskType === 'okr_off_track' ? 'okr_status' : 'accountability_task';
  return item.code === 'no_action_required' ? 'no_action_required' : item.code.includes('source') || item.sourceConnectionId ? 'source_freshness_warning' : 'data_quality';
}

function evidenceRefTypeFor(item: DailyBriefEvidenceItem) {
  if (isInventoryRiskEvidence(item)) return 'daily_inventory_risk';
  if (isSupplierOrderEvidence(item)) return 'daily_supplier_order_context';
  if (isLeadTimeIssueEvidence(item)) return 'daily_lead_time_issue';
  if (isBuyBoxRiskEvidence(item)) return 'daily_buybox_risk';
  if (isPerformanceTrendEvidence(item)) return 'daily_performance_trend';
  if (isOkrAccountabilityRiskEvidence(item)) return 'daily_okr_accountability_risk';
  return 'daily_data_warning';
}

export class EcobaseDailyOperationsBriefService {
  constructor(private db: EcobaseDatabase) {}

  async generateEvidence(params: GenerateDailyOperationsBriefEvidenceParams = {}) {
    const timezone = asString(params.timezone) ?? 'Asia/Karachi';
    const date = normalizeDate(asString(params.date) ?? dateInTimezone(timezone), 'date');
    const company = asString(params.company);
    const companyScope = company ?? 'all';
    const idempotencyKey = `daily_operations:${date}:${companyScope}`;
    const reportRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns);
    const existing = await reportRunRepo.findOne({ filter: { idempotencyKey }, sort: ['-generatedAt'] });

    if (existing && params.forceRegenerate !== true) {
      const existingPlain = toPlainRecord(existing);
      const existingPack = isRecord(existingPlain.evidencePack) ? existingPlain.evidencePack as DailyEvidencePack : undefined;
      const existingReportRunId = asString(existingPlain.id);
      return {
        reportRunId: existingReportRunId,
        idempotencyKey,
        status: asString(existingPlain.status) ?? 'evidence_generated',
        focus: asString(existingPlain.focus) ?? existingPack?.focus ?? 'inventory_risk',
        focusReason: existingPack?.focusReason ?? asString(existingPlain.executiveSummary) ?? 'Existing daily operations evidence reused by idempotency key.',
        evidencePack: existingPack ?? {},
        reportItems: existingReportRunId ? await this.findReportItems(existingReportRunId) : [],
        warnings: Array.isArray(existingPlain.warnings) ? existingPlain.warnings : [],
        omissions: existingPack?.omissions ?? [],
      };
    }

    const maxItems = Math.min(Math.max(Math.floor(params.maxItems ?? 25), 1), 100);
    const evidencePack = await this.buildEvidencePack({ date, timezone, company, maxItems });
    const evidenceHash = stableHash(evidencePack);
    const reportRunId = asString(toPlainRecord(existing).id) ?? randomUUID();
    const reportRunValues = {
      id: reportRunId,
      company,
      frequency: 'daily',
      periodStart: date,
      periodEnd: date,
      status: 'evidence_generated',
      emailStatus: 'not_requested',
      emailEnabled: false,
      emailRecipient: asString(params.recipient),
      generatedAt: evidencePack.generatedAt,
      executiveSummary: evidencePack.focusReason,
      summary: evidencePack.summaryCounts,
      warnings: evidencePack.dataWarnings,
      briefType: 'daily_operations',
      idempotencyKey,
      evidencePack,
      evidenceHash,
      focus: evidencePack.focus,
      validationStatus: 'not_run',
      deliveryStatus: 'not_requested',
    };

    if (existing) {
      await reportRunRepo.update({ filterByTk: reportRunId, values: reportRunValues });
      await this.destroyReportItems(reportRunId);
    } else {
      await reportRunRepo.create({ values: reportRunValues });
    }

    const reportItems = await this.createReportItems(reportRunId, evidencePack);
    return {
      reportRunId,
      idempotencyKey,
      status: 'evidence_generated',
      focus: evidencePack.focus,
      focusReason: evidencePack.focusReason,
      evidencePack,
      reportItems,
      warnings: evidencePack.dataWarnings,
      omissions: evidencePack.omissions,
    };
  }

  async buildEvidencePack(params: { date: string; timezone: string; company?: string; maxItems: number }): Promise<DailyEvidencePack> {
    const sourceStatus = await this.buildSourceStatus(params.company, params.date);
    const rows = await new EcobaseInventoryPlanningService(this.db).listRows({
      company: params.company,
      calculationDate: params.date,
      limit: Math.max(params.maxItems * 4, 100),
    });
    const sortedRows = rows.map(toPlainRecord).sort((left, right) => {
      const priority = safeNumber(left.digestPriority) - safeNumber(right.digestPriority);
      if (priority !== 0) return priority;
      const safeReorder = safeNumber(left.daysUntilSafeReorder) - safeNumber(right.daysUntilSafeReorder);
      if (safeReorder !== 0) return safeReorder;
      return safeNumber(right.estimatedProfitRisk) - safeNumber(left.estimatedProfitRisk);
    });
    const riskRows = sortedRows.filter((row) => ['overdue', 'order_today', 'order_soon', 'missing_lead_time'].includes(asString(row.actionStatus) ?? ''));
    const cappedRiskRows = riskRows.slice(0, params.maxItems);
    const omissions = this.buildOmissions({ riskRows, cappedRiskRows, sourceStatus, params });
    const inventoryRisks = this.buildInventoryRisks(cappedRiskRows, params.date);
    const supplierOrderContext = await this.buildSupplierOrderContext(cappedRiskRows, params.company, params.maxItems);
    const leadTimeIssues = this.buildLeadTimeIssues(cappedRiskRows).slice(0, params.maxItems);
    const performanceTrends = await this.buildPerformanceTrends(params).then((items) => items.slice(0, params.maxItems));
    const buyBoxRisks = await this.buildBuyBoxRisks(params).then((items) => items.slice(0, params.maxItems));
    const okrAccountabilityRisks = await this.buildOkrAccountabilityRisks(params).then((items) => items.slice(0, params.maxItems));
    const dataWarnings = this.buildDataWarnings({ sourceStatus, rows: sortedRows, riskRows: cappedRiskRows, buyBoxRisks, performanceTrends, okrAccountabilityRisks });
    if (inventoryRisks.length === 0 && supplierOrderContext.length === 0 && leadTimeIssues.length === 0 && performanceTrends.length === 0 && buyBoxRisks.length === 0 && okrAccountabilityRisks.length === 0 && dataWarnings.length === 0) {
      dataWarnings.push({
        evidenceId: evidenceId('warning', `${params.date}:${params.company ?? 'all'}:no_action_required`),
        code: 'no_action_required',
        message: 'No urgent inventory risk, performance anomaly, accountability blocker, or source-quality blocker was detected for this daily brief.',
        severity: 'info',
        metadata: { date: params.date, company: params.company ?? null },
      });
    }
    const focus = this.focusFor({ inventoryRisks, supplierOrderContext, leadTimeIssues, performanceTrends, buyBoxRisks, okrAccountabilityRisks, dataWarnings });
    const focusReason = this.focusReasonFor({ focus, inventoryRisks, supplierOrderContext, leadTimeIssues, performanceTrends, buyBoxRisks, okrAccountabilityRisks, dataWarnings });

    return {
      generatedAt: new Date().toISOString(),
      date: params.date,
      timezone: params.timezone,
      ...(params.company ? { company: { name: params.company } } : {}),
      focus,
      focusReason,
      summaryCounts: {
        inventoryRiskCount: riskRows.length,
        includedInventoryRiskCount: inventoryRisks.length,
        omittedInventoryRiskCount: Math.max(riskRows.length - inventoryRisks.length, 0),
        supplierOrderContextCount: supplierOrderContext.length,
        leadTimeIssueCount: leadTimeIssues.length,
        performanceTrendCount: performanceTrends.length,
        buyBoxRiskCount: buyBoxRisks.length,
        okrAccountabilityRiskCount: okrAccountabilityRisks.length,
        sourceStatusCount: sourceStatus.length,
        dataWarningCount: dataWarnings.filter((warning) => warning.severity === 'warning').length,
      },
      sourceStatus,
      inventoryRisks,
      supplierOrderContext,
      leadTimeIssues,
      performanceTrends,
      buyBoxRisks,
      okrAccountabilityRisks,
      dataWarnings,
      omissions,
      assumptions: [
        'This slice prepares deterministic evidence for inventory, supplier-order, performance, Buy Box, OKR/accountability, and source-quality exceptions.',
        'Purchased or inbound supplier orders count as trusted coverage; draft, approval pending, payment pending, blocked, cancelled, and completed orders are evidence but not safe coverage.',
        'Profit risk comes from the inventory-planning read model and may be negative; urgent stockout risk is still retained with a caveat.',
        'Source credentials, raw URLs with tokens, OAuth tokens, and secret references are excluded from the evidence pack.',
      ],
    };
  }

  private async buildSourceStatus(company: string | undefined, date: string) {
    const sourceConnections = (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({ sort: ['name'] }))
      .map(toPlainRecord)
      .filter((sourceConnection) => sourceMatchesCompany(sourceConnection, company));
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const warningService = new EcobaseDataWarningService(this.db);
    const sourceStatus: SourceStatusEvidence[] = [];

    for (const sourceConnection of sourceConnections) {
      const sourceConnectionId = asString(sourceConnection.id);
      if (!sourceConnectionId) continue;
      const latestRun = toPlainRecord(await importRunRepo.findOne({ filter: { sourceConnectionId }, sort: ['-startedAt'] }));
      const warningAssessment = await warningService.assessSourceConnection(sourceConnectionId, date, false);
      sourceStatus.push({
        evidenceId: evidenceId('source', sourceConnectionId),
        sourceConnectionId,
        connectionName: asString(sourceConnection.name) ?? '(unnamed source)',
        sourceType: asString(sourceConnection.sourceType) ?? '(unknown source type)',
        domain: asString(sourceConnection.domain) ?? '(unknown domain)',
        active: asBoolean(sourceConnection.active, true),
        required: warningAssessment.required,
        freshnessSlaMinutes: warningAssessment.freshnessSlaMinutes,
        latestImportRunId: asString(latestRun.id) ?? null,
        latestRunStatus: asString(latestRun.status) ?? null,
        latestSuccessfulRunAt: warningAssessment.latestSuccessfulRunAt,
        lastRunAt: toIsoString(latestRun.finishedAt) ?? toIsoString(latestRun.startedAt) ?? null,
        rowCount: safeNumber(latestRun.rowCount),
        normalizedCount: safeNumber(latestRun.normalizedCount),
        warningCount: warningAssessment.warnings.length,
        errorCount: safeNumber(latestRun.errorCount),
        warnings: warningAssessment.warnings.map(compactWarning),
      });
    }
    return sourceStatus;
  }

  private buildInventoryRisks(rows: PlainRecord[], date: string): InventoryRiskEvidence[] {
    return rows.map((row) => {
      const daysUntilAction = asNumber(row.daysUntilSafeReorder);
      const estimatedProfitRisk = asNumber(row.estimatedProfitRisk);
      const supplierEvidenceState = !asString(row.supplierName)
        ? 'missing'
        : ['order_details_history', 'planning_parameter_fallback'].includes(asString(row.supplierSource) ?? '') || asString(row.supplierConfidence) === 'low'
          ? 'fallback_or_inferred'
          : 'known';
      const caveats = [] as string[];
      if (supplierEvidenceState !== 'known') caveats.push('Supplier identity is missing or inferred from fallback/order history evidence.');
      if ((asString(row.leadTimeFreshness) ?? 'missing') !== 'fresh') caveats.push('Lead time is missing or stale and needs supplier confirmation.');
      if (typeof estimatedProfitRisk === 'number' && estimatedProfitRisk < 0) caveats.push('Estimated profit risk is negative, but urgent OOS timing keeps this in the action list.');
      if (asString(row.supplierOrderState) === 'placed_not_purchased') caveats.push('An order exists but is not paid/purchased, so it is not trusted recovery coverage.');
      return {
        evidenceId: evidenceId('inventory', productIdentity(row)),
        company: asString(row.company),
        planningProductId: asString(row.planningProductId),
        asin: asString(row.asin),
        sku: asString(row.sku),
        title: asString(row.title),
        tier: asString(row.tier),
        actionStatus: asString(row.actionStatus),
        sellableStock: asNumber(row.sellableStock),
        reservedStock: asNumber(row.reservedStock),
        pipelineStock: asNumber(row.pipelineStock),
        velocityPerDay: asNumber(row.salesVelocity),
        estimatedOosDate: asString(row.estimatedOosDate),
        latestSafeReorderDate: asString(row.latestSafeReorderDate),
        overdueDays: typeof daysUntilAction === 'number' && daysUntilAction < 0 ? Math.abs(Math.floor(daysUntilAction)) : undefined,
        daysUntilAction,
        suggestedReorderQty: asNumber(row.suggestedReorderQty),
        supplierId: asString(row.supplierId),
        supplierName: asString(row.supplierName),
        supplierEvidenceState,
        leadTimeDays: asNumber(row.leadTimeDays),
        leadTimeFreshness: asString(row.leadTimeFreshness),
        openSupplierOrderCoverageQty: asNumber(row.openOrderCoverageQty),
        supplierOrderState: asString(row.supplierOrderState),
        supplierOrderStatus: asString(row.supplierOrderStatus),
        supplierOrderRef: asString(row.supplierOrderRef),
        latestClosedOrCancelledOrderRef: asString(row.supplierOrderState) === 'closed_history' ? asString(row.supplierOrderRef) : undefined,
        estimatedProfitRisk,
        caveats,
        sourceWarnings: Array.isArray(toPlainRecord(row.evidence).dataWarnings) ? toPlainRecord(row.evidence).dataWarnings as PlainRecord[] : [],
      };
    });
  }

  private async buildSupplierOrderContext(riskRows: PlainRecord[], company: string | undefined, maxItems: number) {
    const orderFilter = company ? { company } : {};
    const orders = (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrders).find({ filter: orderFilter, sort: ['-lastMeaningfulUpdateAt'], limit: 1000 })).map(toPlainRecord);
    const lines = (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierOrderLines).find({ filter: orderFilter, sort: ['-observedAt'], limit: 5000 })).map(toPlainRecord);
    const suppliers = (await this.db.getRepository(ECOBASE_COLLECTIONS.suppliers).find({ filter: orderFilter, limit: 2000 })).map(toPlainRecord);
    const supplierNameById = new Map(suppliers.map((supplier) => [asString(supplier.id), asString(supplier.name)] as const).filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])));
    const riskMatchingLines = lines.filter((line) => riskRows.some((risk) => orderLineMatchesRisk(line, risk)));
    const linesByOrderId = new Map<string, PlainRecord[]>();
    for (const line of riskMatchingLines) {
      const orderId = asString(line.supplierOrderId);
      if (!orderId) continue;
      const group = linesByOrderId.get(orderId) ?? [];
      group.push(line);
      linesByOrderId.set(orderId, group);
    }
    return orders
      .filter((order) => linesByOrderId.has(asString(order.id) ?? ''))
      .map((order) => {
        const supplierOrderId = asString(order.id);
        const orderLines = linesByOrderId.get(supplierOrderId ?? '') ?? [];
        const status = asString(order.status);
        const lineSummaries = orderLines.map((line) => ({
          supplierOrderLineId: asString(line.id),
          planningProductId: asString(line.planningProductId),
          asin: asString(line.asin),
          sku: asString(line.sku),
          orderedQty: asNumber(line.orderedQty),
          receivedQty: asNumber(line.receivedQty),
          openQty: openQty(line),
          expectedSellableDate: asString(line.expectedSellableDate),
        }));
        const openQuantity = lineSummaries.reduce((total, line) => total + line.openQty, 0);
        return {
          evidenceId: evidenceId('supplier-order', supplierOrderId ?? asString(order.externalOrderRef) ?? order),
          company: asString(order.company),
          supplierOrderId,
          externalOrderRef: asString(order.externalOrderRef),
          supplierId: asString(order.supplierId),
          supplierName: supplierNameById.get(asString(order.supplierId) ?? '') ?? asString(order.supplierName) ?? payloadString(order, ['Supplier', 'supplier']),
          status,
          coverageState: orderCoverageState(status),
          isTrustedCoverage: isReliableSupplierOrderCoverageStatus(status),
          lineCount: orderLines.length,
          openQty: openQuantity,
          relatedProducts: lineSummaries,
          orderDate: asString(order.orderDate),
          expectedDeliveryDate: asString(order.expectedDeliveryDate),
          lastMeaningfulUpdateAt: toIsoString(order.lastMeaningfulUpdateAt),
        } satisfies SupplierOrderEvidence;
      })
      .sort((left, right) => Number(right.isTrustedCoverage) - Number(left.isTrustedCoverage) || right.openQty - left.openQty)
      .slice(0, maxItems);
  }

  private buildLeadTimeIssues(rows: PlainRecord[]) {
    return rows
      .filter((row) => (asString(row.leadTimeFreshness) ?? 'missing') !== 'fresh' || typeof asNumber(row.leadTimeDays) !== 'number')
      .map((row) => ({
        evidenceId: evidenceId('lead-time', productIdentity(row)),
        company: asString(row.company),
        planningProductId: asString(row.planningProductId),
        asin: asString(row.asin),
        sku: asString(row.sku),
        supplierId: asString(row.supplierId),
        supplierName: asString(row.supplierName),
        leadTimeDays: asNumber(row.leadTimeDays),
        leadTimeFreshness: asString(row.leadTimeFreshness) ?? 'missing',
        leadTimeConfirmedAt: toIsoString(row.leadTimeConfirmedAt),
        actionRequired: typeof asNumber(row.leadTimeDays) === 'number' ? 'refresh_stale_lead_time' : 'contact_supplier_for_lead_time',
      }) satisfies LeadTimeIssueEvidence);
  }

  private async buildPerformanceTrends(params: { date: string; company?: string; maxItems: number }) {
    const factFilter = params.company ? { company: params.company } : {};
    const targetFilter = params.company ? { company: params.company } : {};
    const facts = (await this.db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).find({ filter: factFilter, sort: ['-snapshotDate'], limit: 5000 })).map(toPlainRecord);
    const targets = (await this.db.getRepository(ECOBASE_COLLECTIONS.targetRows).find({ filter: targetFilter, sort: ['-period'], limit: 5000 })).map(toPlainRecord);
    const currentFacts = facts.filter((fact) => asString(fact.snapshotDate) === params.date);
    const priorDate = dateBefore(params.date, 1);
    const priorByIdentity = new Map<string, PlainRecord>();
    for (const fact of facts.filter((row) => asString(row.snapshotDate) === priorDate)) {
      priorByIdentity.set(productIdentity(fact), fact);
    }
    const targetByIdentity = new Map<string, PlainRecord>();
    for (const target of targets.filter((row) => asString(row.period) === params.date || asString(row.period) === monthPeriod(params.date))) {
      targetByIdentity.set(productIdentity(target), target);
    }
    const evidence: PerformanceTrendEvidence[] = [];
    for (const current of currentFacts) {
      const identity = productIdentity(current);
      const prior = priorByIdentity.get(identity);
      const target = targetByIdentity.get(identity);
      const currentUnits = asNumber(current.units);
      const baselineUnits = asNumber(prior?.units);
      const currentRevenue = asNumber(current.sales);
      const baselineRevenue = asNumber(prior?.sales);
      const currentProfit = asNumber(current.netProfit) ?? asNumber(current.grossProfit);
      const baselineProfit = asNumber(prior?.netProfit) ?? asNumber(prior?.grossProfit);
      const targetUnits = asNumber(target?.unitTarget);
      const targetProfit = asNumber(target?.profitTarget);
      const velocityDropPercent = percentageDrop(currentUnits, baselineUnits);
      if (typeof velocityDropPercent === 'number' && velocityDropPercent >= 30) {
        evidence.push({
          evidenceId: evidenceId('trend', `velocity:${identity}:${params.date}`),
          trendType: 'velocity_drop',
          company: asString(current.company),
          planningProductId: asString(current.planningProductId),
          asin: asString(current.asin),
          sku: asString(current.sku),
          currentDate: params.date,
          baselineDate: priorDate,
          currentUnits,
          baselineUnits,
          currentRevenue,
          baselineRevenue,
          currentProfit,
          baselineProfit,
          targetUnits,
          targetProfit,
          velocityDropPercent,
          revenueDropPercent: percentageDrop(currentRevenue, baselineRevenue),
          estimatedProfitImpact: typeof currentProfit === 'number' && typeof baselineProfit === 'number' ? Math.max(baselineProfit - currentProfit, 0) : undefined,
          confidence: 'high',
          warnings: [],
        });
      }
      if (typeof targetProfit === 'number' && typeof currentProfit === 'number' && currentProfit < targetProfit) {
        evidence.push({
          evidenceId: evidenceId('trend', `profit:${identity}:${params.date}`),
          trendType: 'profit_gap',
          company: asString(current.company),
          planningProductId: asString(current.planningProductId),
          asin: asString(current.asin),
          sku: asString(current.sku),
          currentDate: params.date,
          baselineDate: prior ? priorDate : undefined,
          currentUnits,
          baselineUnits,
          currentRevenue,
          baselineRevenue,
          currentProfit,
          baselineProfit,
          targetUnits,
          targetProfit,
          profitGap: Math.round((targetProfit - currentProfit) * 100) / 100,
          estimatedProfitImpact: Math.max(targetProfit - currentProfit, 0),
          confidence: prior ? 'high' : 'medium',
          warnings: prior ? [] : ['No prior-period fact exists; profit gap is target-based only.'],
        });
      }
      if (!prior && !target) {
        evidence.push({
          evidenceId: evidenceId('trend', `no-baseline:${identity}:${params.date}`),
          trendType: 'velocity_drop',
          company: asString(current.company),
          planningProductId: asString(current.planningProductId),
          asin: asString(current.asin),
          sku: asString(current.sku),
          currentDate: params.date,
          currentUnits,
          currentRevenue,
          currentProfit,
          confidence: 'low',
          warnings: ['No prior-period or target baseline exists; this product is watch-list only, not off-track.'],
        });
      }
    }
    return evidence.sort((left, right) => safeNumber(right.estimatedProfitImpact) - safeNumber(left.estimatedProfitImpact));
  }

  private async buildBuyBoxRisks(params: { date: string; company?: string; maxItems: number }) {
    const trafficRows = (await this.db.getRepository(ECOBASE_COLLECTIONS.trafficSnapshots).find({ sort: ['-snapshotDate'], limit: 5000 })).map(toPlainRecord);
    const products = (await this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).find({ filter: params.company ? { company: params.company } : {}, limit: 5000 })).map(toPlainRecord);
    const productByAsinSku = new Map<string, PlainRecord>();
    for (const product of products) {
      const asin = asString(product.canonicalAsin) ?? asString(product.asin);
      const sku = asString(product.sku);
      if (asin || sku) productByAsinSku.set([asin?.toUpperCase() ?? '', sku ?? ''].join(':'), product);
    }
    const priorDate = dateBefore(params.date, 1);
    const priorByIdentity = new Map<string, PlainRecord>();
    for (const row of trafficRows.filter((traffic) => asString(traffic.snapshotDate) === priorDate)) {
      priorByIdentity.set([asString(row.asin)?.toUpperCase() ?? '', asString(row.sku) ?? ''].join(':'), row);
    }
    const risks: BuyBoxRiskEvidence[] = [];
    for (const current of trafficRows.filter((traffic) => asString(traffic.snapshotDate) === params.date)) {
      const key = [asString(current.asin)?.toUpperCase() ?? '', asString(current.sku) ?? ''].join(':');
      const product = productByAsinSku.get(key);
      if (params.company && !product) continue;
      const currentBuyBoxWinRate = asNumber(current.buyBoxPercentage);
      const prior = priorByIdentity.get(key);
      const baselineBuyBoxWinRate = asNumber(prior?.buyBoxPercentage);
      const drop = typeof currentBuyBoxWinRate === 'number' && typeof baselineBuyBoxWinRate === 'number'
        ? Math.round((baselineBuyBoxWinRate - currentBuyBoxWinRate) * 10) / 10
        : undefined;
      const thresholdBreach = typeof currentBuyBoxWinRate === 'number' && currentBuyBoxWinRate < 80;
      if (!thresholdBreach && !(typeof drop === 'number' && drop >= 20)) continue;
      risks.push({
        evidenceId: evidenceId('buybox', `${key}:${params.date}`),
        company: asString(product?.company),
        planningProductId: asString(product?.id),
        asin: asString(current.asin),
        sku: asString(current.sku),
        currentDate: params.date,
        baselineDate: prior ? priorDate : undefined,
        currentBuyBoxWinRate,
        baselineBuyBoxWinRate,
        winRateDropPoints: drop,
        thresholdBreach,
        currentUnitsOrdered: asNumber(current.unitsOrdered),
        currentOrderedProductSales: asNumber(current.orderedProductSales),
        sourceFreshness: 'fresh',
        warnings: prior ? [] : ['No prior-period Buy Box baseline exists; rank by threshold breach only.'],
      });
    }
    return risks.sort((left, right) => safeNumber(right.currentOrderedProductSales) - safeNumber(left.currentOrderedProductSales));
  }

  private async buildOkrAccountabilityRisks(params: { date: string; company?: string; maxItems: number }) {
    const okrFilter = params.company ? { company: params.company } : {};
    const okrs = (await this.db.getRepository(ECOBASE_COLLECTIONS.okrs).find({ filter: okrFilter, limit: 2000 })).map(toPlainRecord);
    const okrById = new Map(okrs.map((okr) => [asString(okr.id), okr] as const).filter((entry): entry is [string, PlainRecord] => Boolean(entry[0])));
    const okrSnapshots = (await this.db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).find({ filter: { snapshotDate: params.date }, sort: ['progressPercent'], limit: 2000 })).map(toPlainRecord);
    const taskSnapshots = (await this.db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).find({ filter: { snapshotDate: params.date }, sort: ['dueDate'], limit: 2000 })).map(toPlainRecord);
    const risks: OkrAccountabilityRiskEvidence[] = [];
    for (const snapshot of okrSnapshots) {
      const okr = okrById.get(asString(snapshot.okrId) ?? '');
      if (params.company && !okr) continue;
      const status = asString(snapshot.status) ?? 'unknown';
      const progressPercent = asNumber(snapshot.progressPercent);
      if (!['off_track', 'at_risk', 'blocked'].includes(status) && !(typeof progressPercent === 'number' && progressPercent < 70)) continue;
      risks.push({
        evidenceId: evidenceId('okr', `${asString(snapshot.okrId) ?? asString(snapshot.externalOkrId)}:${asString(snapshot.metricName)}:${params.date}`),
        riskType: 'okr_off_track',
        company: asString(okr?.company),
        okrId: asString(snapshot.okrId),
        externalOkrId: asString(snapshot.externalOkrId) ?? asString(okr?.externalOkrId),
        okrTitle: asString(okr?.title),
        metricName: asString(snapshot.metricName),
        owner: asString(snapshot.owner) ?? asString(okr?.owner),
        operationalArea: asString(snapshot.operationalArea) ?? asString(okr?.operationalArea),
        period: asString(okr?.period),
        progressPercent,
        expectedProgressPercent: 70,
        status,
        evidenceFreshness: 'fresh',
        warnings: okr ? [] : ['OKR snapshot has no linked OKR record; cite metric snapshot fields only.'],
      });
    }
    for (const task of taskSnapshots) {
      const status = (asString(task.status) ?? '').toLowerCase();
      if (['done', 'closed', 'complete', 'completed'].includes(status)) continue;
      const dueDate = asString(task.dueDate);
      const lastMeaningfulUpdateAt = toIsoString(task.lastMeaningfulUpdateAt);
      const overdue = Boolean(dueDate && diffDays(params.date, dueDate) > 0);
      const inactive = Boolean(lastMeaningfulUpdateAt && diffDays(params.date, lastMeaningfulUpdateAt.slice(0, 10)) >= 3);
      if (!overdue && !inactive) continue;
      risks.push({
        evidenceId: evidenceId('task', `${asString(task.externalTaskId)}:${params.date}:${overdue ? 'overdue' : 'inactive'}`),
        riskType: overdue ? 'task_overdue' : 'task_inactive',
        taskId: asString(task.externalTaskId),
        taskName: asString(task.taskName),
        taskStatus: asString(task.status),
        taskPriority: asString(task.priority),
        assignee: asString(task.assignee),
        operationalArea: asString(task.operationalArea),
        dueDate,
        lastMeaningfulUpdateAt,
        evidenceFreshness: 'fresh',
        warnings: [],
      });
    }
    return risks.sort((left, right) => safeNumber(left.progressPercent) - safeNumber(right.progressPercent));
  }

  private buildDataWarnings(params: { sourceStatus: SourceStatusEvidence[]; rows: PlainRecord[]; riskRows: PlainRecord[]; buyBoxRisks: BuyBoxRiskEvidence[]; performanceTrends: PerformanceTrendEvidence[]; okrAccountabilityRisks: OkrAccountabilityRiskEvidence[] }) {
    const warnings: DataWarningEvidence[] = [];
    for (const source of params.sourceStatus) {
      for (const warning of source.warnings) {
        warnings.push({
          evidenceId: evidenceId('warning', `${source.sourceConnectionId}:${warning.code}:${warning.observedAt}`),
          code: warning.code,
          message: warning.message,
          severity: warning.severity,
          sourceConnectionId: source.sourceConnectionId,
          metadata: warning.metadata,
        });
      }
    }
    for (const row of params.riskRows) {
      if (asString(row.mappingWarning) || asString(row.planningProductId)?.startsWith('fallback:')) {
        warnings.push({
          evidenceId: evidenceId('warning', `mapping:${productIdentity(row)}`),
          code: 'duplicate_or_fallback_mapping',
          message: 'Planning product identity is fallback-based or carries a mapping warning; cite ASIN/SKU/company before acting.',
          severity: 'warning',
          planningProductId: asString(row.planningProductId),
          asin: asString(row.asin),
          sku: asString(row.sku),
          metadata: { mappingWarning: asString(row.mappingWarning), planningProductId: asString(row.planningProductId) },
        });
      }
    }
    const identityCounts = new Map<string, PlainRecord[]>();
    for (const row of params.rows) {
      const key = [asString(row.company), asString(row.asin)?.toUpperCase(), asString(row.sku)].join(':');
      if (key === '::') continue;
      const group = identityCounts.get(key) ?? [];
      group.push(row);
      identityCounts.set(key, group);
    }
    for (const [key, group] of identityCounts.entries()) {
      const productIds = new Set(group.map((row) => asString(row.planningProductId)).filter(Boolean));
      if (productIds.size <= 1) continue;
      warnings.push({
        evidenceId: evidenceId('warning', `duplicate:${key}`),
        code: 'duplicate_asin_sku_mapping',
        message: 'Multiple planning product records share the same company/ASIN/SKU identity.',
        severity: 'warning',
        planningProductId: [...productIds].join(','),
        asin: asString(group[0].asin),
        sku: asString(group[0].sku),
        metadata: { productIds: [...productIds], rowCount: group.length },
      });
    }
    for (const risk of params.buyBoxRisks) {
      for (const warning of risk.warnings) {
        warnings.push({
          evidenceId: evidenceId('warning', `buybox:${risk.evidenceId}:${warning}`),
          code: 'buybox_baseline_limited',
          message: warning,
          severity: 'warning',
          planningProductId: risk.planningProductId,
          asin: risk.asin,
          sku: risk.sku,
          metadata: { evidenceId: risk.evidenceId, currentDate: risk.currentDate, baselineDate: risk.baselineDate ?? null },
        });
      }
    }
    for (const trend of params.performanceTrends) {
      for (const warning of trend.warnings) {
        warnings.push({
          evidenceId: evidenceId('warning', `trend:${trend.evidenceId}:${warning}`),
          code: 'performance_baseline_limited',
          message: warning,
          severity: trend.confidence === 'low' ? 'info' : 'warning',
          planningProductId: trend.planningProductId,
          asin: trend.asin,
          sku: trend.sku,
          metadata: { evidenceId: trend.evidenceId, currentDate: trend.currentDate, baselineDate: trend.baselineDate ?? null },
        });
      }
    }
    for (const risk of params.okrAccountabilityRisks) {
      for (const warning of risk.warnings) {
        warnings.push({
          evidenceId: evidenceId('warning', `okr:${risk.evidenceId}:${warning}`),
          code: 'accountability_link_limited',
          message: warning,
          severity: 'warning',
          metadata: { evidenceId: risk.evidenceId, okrId: risk.okrId ?? null, taskId: risk.taskId ?? null },
        });
      }
    }
    return warnings;
  }

  private buildOmissions(params: { riskRows: PlainRecord[]; cappedRiskRows: PlainRecord[]; sourceStatus: SourceStatusEvidence[]; params: { maxItems: number } }) {
    const omissions = [] as string[];
    const omittedRiskCount = params.riskRows.length - params.cappedRiskRows.length;
    if (omittedRiskCount > 0) {
      omissions.push(`${omittedRiskCount} lower-ranked inventory risk item(s) were omitted after maxItems=${params.params.maxItems}.`);
    }
    const inactiveSources = params.sourceStatus.filter((source) => !source.active).length;
    if (inactiveSources > 0) {
      omissions.push(`${inactiveSources} inactive source connection(s) are represented only as source status, not as current risk evidence.`);
    }
    return omissions;
  }

  private focusFor(params: {
    inventoryRisks: InventoryRiskEvidence[];
    supplierOrderContext: SupplierOrderEvidence[];
    leadTimeIssues: LeadTimeIssueEvidence[];
    performanceTrends: PerformanceTrendEvidence[];
    buyBoxRisks: BuyBoxRiskEvidence[];
    okrAccountabilityRisks: OkrAccountabilityRiskEvidence[];
    dataWarnings: DataWarningEvidence[];
  }): DailyBriefFocus {
    const sourceBlockingWarnings = params.dataWarnings.filter((warning) => warning.severity === 'warning' && Boolean(warning.sourceConnectionId) && ['missing_required_source', 'failed_latest_run', 'credential_blocked'].includes(warning.code));
    if (sourceBlockingWarnings.length > 0) return 'source_quality';
    if (params.inventoryRisks.length > 0) return 'inventory_risk';
    if (params.supplierOrderContext.some((order) => !order.isTrustedCoverage)) return 'supplier_orders';
    if (params.leadTimeIssues.length > 0) return 'source_quality';
    if (params.buyBoxRisks.length > 0) return 'buybox';
    if (params.performanceTrends.some((trend) => trend.trendType === 'velocity_drop' && trend.confidence !== 'low')) return 'velocity';
    if (params.performanceTrends.some((trend) => trend.trendType === 'profit_gap' && trend.confidence !== 'low')) return 'profit_gap';
    if (params.okrAccountabilityRisks.length > 0) return 'okr';
    if (params.dataWarnings.some((warning) => warning.severity === 'warning')) return 'source_quality';
    return 'no_major_exception';
  }

  private focusReasonFor(params: {
    focus: DailyBriefFocus;
    inventoryRisks: InventoryRiskEvidence[];
    supplierOrderContext: SupplierOrderEvidence[];
    leadTimeIssues: LeadTimeIssueEvidence[];
    performanceTrends: PerformanceTrendEvidence[];
    buyBoxRisks: BuyBoxRiskEvidence[];
    okrAccountabilityRisks: OkrAccountabilityRiskEvidence[];
    dataWarnings: DataWarningEvidence[];
  }) {
    if (params.focus === 'inventory_risk') {
      const overdue = params.inventoryRisks.filter((risk) => risk.actionStatus === 'overdue').length;
      const missingLeadTime = params.leadTimeIssues.length;
      return `${overdue} overdue reorder actions and ${missingLeadTime} missing/stale lead-time blocker(s) outrank other current signals.`;
    }
    if (params.focus === 'supplier_orders') {
      return `${params.supplierOrderContext.filter((order) => !order.isTrustedCoverage).length} supplier order(s) need operator follow-up before they can be trusted as recovery coverage.`;
    }
    if (params.focus === 'buybox') {
      return `${params.buyBoxRisks.length} Buy Box deterioration signal(s) outrank lower-priority velocity, profit, and accountability signals.`;
    }
    if (params.focus === 'velocity') {
      return `${params.performanceTrends.filter((trend) => trend.trendType === 'velocity_drop' && trend.confidence !== 'low').length} velocity drop signal(s) exceeded the deterministic threshold.`;
    }
    if (params.focus === 'profit_gap') {
      return `${params.performanceTrends.filter((trend) => trend.trendType === 'profit_gap' && trend.confidence !== 'low').length} profit gap signal(s) missed target or baseline expectations.`;
    }
    if (params.focus === 'okr') {
      return `${params.okrAccountabilityRisks.length} OKR/accountability signal(s) need owner attention.`;
    }
    if (params.focus === 'source_quality') {
      return `${params.dataWarnings.filter((warning) => warning.severity === 'warning').length} source/data warning(s) limit confidence in today's operational brief.`;
    }
    return 'No major inventory, supplier-order, performance, Buy Box, OKR, or source-quality exception outranks the watch list today.';
  }

  private async createReportItems(reportRunId: string, evidencePack: DailyEvidencePack) {
    const itemRepo = this.db.getRepository(ECOBASE_COLLECTIONS.reportItems);
    const evidenceItems: DailyBriefEvidenceItem[] = [
      ...evidencePack.inventoryRisks,
      ...evidencePack.supplierOrderContext.filter((order) => !order.isTrustedCoverage),
      ...evidencePack.leadTimeIssues,
      ...evidencePack.buyBoxRisks,
      ...evidencePack.performanceTrends.filter((trend) => trend.confidence !== 'low'),
      ...evidencePack.okrAccountabilityRisks,
      ...evidencePack.dataWarnings,
    ];
    const itemsToPersist = evidenceItems.length > 0
      ? evidenceItems
      : [{
        evidenceId: evidenceId('no-action', `${evidencePack.date}:${evidencePack.company?.name ?? 'all'}`),
        code: 'no_action_required',
        message: 'No major exception requires operator action today.',
        severity: 'info' as const,
        metadata: { date: evidencePack.date, company: evidencePack.company?.name ?? null },
      }];
    const created: PlainRecord[] = [];
    for (let index = 0; index < itemsToPersist.length; index += 1) {
      const item = itemsToPersist[index];
      created.push(toPlainRecord(await itemRepo.create({
        values: {
          id: randomUUID(),
          reportRunId,
          itemType: itemTypeFor(item),
          severity: reportSeverity(item),
          title: reportItemTitle(item),
          body: reportItemBody(item),
          evidenceRefType: evidenceRefTypeFor(item),
          evidenceRefId: item.evidenceId,
          evidence: item,
          sortOrder: index + 1,
        },
      })));
    }
    return created;
  }

  private async findReportItems(reportRunId: string) {
    return (await this.db.getRepository(ECOBASE_COLLECTIONS.reportItems).find({ filter: { reportRunId }, sort: ['sortOrder'] })).map(toPlainRecord);
  }

  private async destroyReportItems(reportRunId: string) {
    const reportItemsRepo = this.db.getRepository(ECOBASE_COLLECTIONS.reportItems) as RepositoryWithDestroy;
    if (typeof reportItemsRepo.destroy !== 'function') {
      throw new Error('Ecobase daily operations brief failed: report item repository cannot replace regenerated evidence.');
    }
    await reportItemsRepo.destroy({ filter: { reportRunId } });
  }
}
