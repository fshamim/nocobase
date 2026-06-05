import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseComparisonService } from './comparison-service';
import { EcobaseDashboardService } from './dashboard-service';
import type { EcobaseDatabase } from './import-service';

type PlainRecord = Record<string, unknown>;
type ReportFrequency = 'daily' | 'weekly' | 'monthly';

type ReportGenerateParams = {
  company?: string;
  frequency: ReportFrequency;
  period?: string;
  date?: string;
  emailEnabled?: boolean;
  emailRecipient?: string;
};

type ReportItemInput = {
  itemType: string;
  severity?: string;
  title: string;
  body: string;
  evidenceRefType?: string;
  evidenceRefId?: string;
  evidence?: PlainRecord;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Ecobase report failed: ${label} must be an ISO date.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== value) {
    throw new Error(`Ecobase report failed: ${label} is not a valid calendar date.`);
  }
  return date;
}

function weekRange(period: string) {
  const match = period.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    throw new Error('Ecobase report failed: weekly period must use YYYY-Www.');
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const day = januaryFourth.getUTCDay() || 7;
  const weekOneMonday = addDays(januaryFourth, 1 - day);
  const start = addDays(weekOneMonday, (week - 1) * 7);
  return { periodStart: isoDate(start), periodEnd: isoDate(addDays(start, 6)) };
}

function monthRange(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error('Ecobase report failed: monthly period must use YYYY-MM.');
  }
  const [year, month] = period.split('-').map(Number);
  return {
    periodStart: isoDate(new Date(Date.UTC(year, month - 1, 1))),
    periodEnd: isoDate(new Date(Date.UTC(year, month, 0))),
  };
}

function dateRange(params: ReportGenerateParams) {
  if (params.frequency === 'daily') {
    const date = asString(params.date) ?? asString(params.period);
    if (!date) {
      throw new Error('Ecobase report failed: daily reports require date or period.');
    }
    parseDate(date, 'date');
    return { periodStart: date, periodEnd: date, comparisonPeriod: date };
  }
  if (params.frequency === 'weekly') {
    const period = asString(params.period);
    if (!period) {
      throw new Error('Ecobase report failed: weekly reports require period.');
    }
    return { ...weekRange(period), comparisonPeriod: period };
  }
  const period = asString(params.period);
  if (!period) {
    throw new Error('Ecobase report failed: monthly reports require period.');
  }
  return { ...monthRange(period), comparisonPeriod: period };
}

function textList(values: unknown[]) {
  return values.length ? values.join('; ') : 'None recorded.';
}

export class EcobaseReportService {
  constructor(private db: EcobaseDatabase) {}

  async generateReport(params: ReportGenerateParams) {
    const range = dateRange(params);
    const dashboard = await new EcobaseDashboardService(this.db).getDashboard({
      company: params.company,
      periodType: params.frequency,
      period: range.comparisonPeriod,
      date: params.frequency === 'daily' ? range.periodStart : undefined,
    });
    const comparison = await new EcobaseComparisonService(this.db).comparePerformance({
      periodType: params.frequency,
      period: range.comparisonPeriod,
      currentStartDate: params.frequency === 'daily' ? range.periodStart : undefined,
      currentEndDate: params.frequency === 'daily' ? range.periodEnd : undefined,
      groupBy: 'planning_product',
      company: params.company,
    });
    const reportRunId = randomUUID();
    const items = this.buildItems(dashboard, comparison);
    const executiveSummary = this.executiveSummary(dashboard, comparison, items);
    const emailStatus = this.emailStatus(params);
    const generatedAt = new Date().toISOString();

    await this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns).create({
      values: {
        id: reportRunId,
        company: params.company,
        frequency: params.frequency,
        periodStart: range.periodStart,
        periodEnd: range.periodEnd,
        status: 'preview_generated',
        emailStatus,
        emailEnabled: params.emailEnabled === true,
        emailRecipient: params.emailRecipient,
        generatedAt,
        executiveSummary,
        summary: {
          criticalAlertCount: (dashboard.openAlerts ?? []).filter((alert: PlainRecord) => asString(alert.severity) === 'critical').length,
          warningCount: dashboard.warningSummary?.warningCount ?? 0,
          comparisonRows: comparison.rows.length,
          dailySchedule: dashboard.settings?.dailyReportSchedule ?? '08:00',
          timezone: dashboard.settings?.timezone ?? 'Asia/Karachi',
        },
        warnings: dashboard.warningSummary?.staleOrBlockedSources ?? [],
      },
    });

    const createdItems = [] as PlainRecord[];
    for (let index = 0; index < items.length; index += 1) {
      createdItems.push(await this.db.getRepository(ECOBASE_COLLECTIONS.reportItems).create({
        values: { id: randomUUID(), reportRunId, sortOrder: index + 1, severity: 'info', ...items[index] },
      }) as PlainRecord);
    }

    return {
      reportRunId,
      frequency: params.frequency,
      periodStart: range.periodStart,
      periodEnd: range.periodEnd,
      status: 'preview_generated',
      emailStatus,
      executiveSummary,
      items: createdItems,
      preview: this.renderPreview(executiveSummary, createdItems),
    };
  }

  private buildItems(dashboard: PlainRecord, comparison: PlainRecord): ReportItemInput[] {
    const items: ReportItemInput[] = [];
    const openAlerts = Array.isArray(dashboard.openAlerts) ? dashboard.openAlerts.map(asRecord) : [];
    const atRiskProducts = Array.isArray(dashboard.atRiskProducts) ? dashboard.atRiskProducts.map(asRecord) : [];
    const supplierOrderDelays = Array.isArray(dashboard.supplierOrderDelays) ? dashboard.supplierOrderDelays.map(asRecord) : [];
    const taskRows = Array.isArray(asRecord(dashboard.accountability).latestTasks) ? (asRecord(dashboard.accountability).latestTasks as unknown[]).map(asRecord) : [];
    const okrRows = Array.isArray(asRecord(dashboard.accountability).latestOkrMetrics) ? (asRecord(dashboard.accountability).latestOkrMetrics as unknown[]).map(asRecord) : [];
    const comparisonRows = Array.isArray(comparison.rows) ? comparison.rows.map(asRecord) : [];

    items.push({
      itemType: 'executive_summary',
      title: 'Executive summary',
      body: `Open alerts: ${openAlerts.length}. At-risk products: ${atRiskProducts.length}. Source warnings: ${asRecord(dashboard.warningSummary).warningCount ?? 0}.`,
      evidenceRefType: 'dashboard_summary',
      evidence: { warningSummary: dashboard.warningSummary },
    });

    for (const alert of openAlerts.filter((item) => asString(item.severity) === 'critical').slice(0, 25)) {
      items.push({
        itemType: 'critical_alert',
        severity: asString(alert.severity) ?? 'critical',
        title: `${asString(alert.alertType) ?? 'alert'}: ${asString(alert.canonicalAsin) ?? asString(alert.subjectRef) ?? 'unknown subject'}`,
        body: asString(alert.actionRequired) ?? 'Review the alert evidence and take the required operational action.',
        evidenceRefType: 'alert',
        evidenceRefId: asString(alert.id),
        evidence: { rootCauses: alert.rootCauses, dataWarnings: alert.dataWarnings, evidence: alert.evidence },
      });
    }

    for (const product of atRiskProducts.slice(0, 25)) {
      items.push({
        itemType: 'oos_reorder_risk',
        severity: asString(product.severity) ?? 'warning',
        title: `OOS/reorder risk: ${asString(product.canonicalAsin) ?? asString(product.planningProductId)}`,
        body: `Days of cover: ${asNumber(product.daysOfCover) ?? 'unknown'}; restock deadline: ${asString(product.restockDeadline) ?? 'unknown'}; order action: ${asString(product.actionRequired) ?? 'review order status'}.`,
        evidenceRefType: 'planning_product',
        evidenceRefId: asString(product.planningProductId),
        evidence: { product },
      });
    }

    for (const order of supplierOrderDelays.slice(0, 25)) {
      items.push({
        itemType: 'supplier_order_risk',
        severity: asString(order.severity) ?? 'warning',
        title: `Supplier-order risk: ${asString(order.orderRef) ?? 'unknown order'}`,
        body: `Supplier ${asString(order.supplier) ?? 'unknown'}; status ${asString(order.status) ?? 'unknown'}; expected sellable ${asString(order.expectedSellableDate) ?? 'unknown'}; latest contact ${asString(order.latestSupplierContactAt) ?? 'not recorded'}; lead-time age ${asNumber(order.leadTimeAgeDays) ?? 'unknown'} days.`,
        evidenceRefType: 'supplier_order',
        evidenceRefId: asString(order.orderRef),
        evidence: { order },
      });
    }

    for (const task of taskRows.slice(0, 25)) {
      items.push({
        itemType: 'accountability_task',
        severity: 'warning',
        title: `Accountability task: ${asString(task.taskName) ?? asString(task.externalTaskId) ?? 'unknown task'}`,
        body: `Owner: ${asString(task.assignee) ?? 'missing'}; area: ${asString(task.operationalArea) ?? 'missing'}; priority: ${asString(task.priority) ?? 'unknown'}; last meaningful update: ${asString(task.lastMeaningfulUpdateAt) ?? 'missing'}.`,
        evidenceRefType: 'clickup_task_snapshot',
        evidenceRefId: asString(task.externalTaskId),
        evidence: { task },
      });
    }

    for (const okr of okrRows.slice(0, 25)) {
      items.push({
        itemType: 'okr_status',
        severity: asString(okr.status) === 'off_track' ? 'warning' : 'info',
        title: `OKR metric: ${asString(okr.okrId) ?? asString(okr.id) ?? 'unknown OKR'}`,
        body: `Status: ${asString(okr.status) ?? 'unknown'}; owner: ${asString(okr.owner) ?? 'missing'}; area: ${asString(okr.area) ?? asString(okr.operationalArea) ?? 'missing'}.`,
        evidenceRefType: 'okr_metric_snapshot',
        evidenceRefId: asString(okr.id),
        evidence: { okr },
      });
    }

    for (const row of comparisonRows.slice(0, 25)) {
      items.push({
        itemType: 'comparative_trend',
        severity: asString(row.classification) === 'declining' || asString(row.classification) === 'consistently_underperforming' ? 'warning' : 'info',
        title: `Trend: ${asString(row.label) ?? asString(row.key) ?? 'unknown group'}`,
        body: `Classification: ${asString(row.classification) ?? 'unknown'}; net profit change: ${asNumber(asRecord(row.change).netProfit) ?? 0}; target gap: ${asNumber(asRecord(row.current).targetGap) ?? 'not targeted'}.`,
        evidenceRefType: 'comparison_row',
        evidenceRefId: asString(row.key),
        evidence: { row, correlationNote: 'Evidence-based correlation only; this does not prove causation.' },
      });
    }

    const sourceWarnings = Array.isArray(asRecord(dashboard.warningSummary).staleOrBlockedSources) ? asRecord(dashboard.warningSummary).staleOrBlockedSources as unknown[] : [];
    if (sourceWarnings.length === 0) {
      items.push({ itemType: 'data_quality', title: 'Source freshness/data warnings', body: 'No source freshness warnings were recorded for this report window.', evidenceRefType: 'source_status' });
    } else {
      for (const warning of sourceWarnings.map(asRecord)) {
        items.push({
          itemType: 'data_quality',
          severity: 'warning',
          title: `Source warning: ${asString(warning.connectionName) ?? asString(warning.sourceConnectionId) ?? 'unknown source'}`,
          body: asString(asRecord(warning.latestWarning).message) ?? 'Source warning recorded; inspect source status evidence.',
          evidenceRefType: 'source_connection',
          evidenceRefId: asString(warning.sourceConnectionId),
          evidence: warning,
        });
      }
    }
    return items;
  }

  private executiveSummary(dashboard: PlainRecord, comparison: PlainRecord, items: ReportItemInput[]) {
    const criticalCount = items.filter((item) => item.itemType === 'critical_alert').length;
    const trendLabels = (Array.isArray(comparison.rows) ? comparison.rows as PlainRecord[] : [])
      .filter((row) => ['declining', 'consistently_underperforming'].includes(asString(row.classification) ?? ''))
      .slice(0, 5)
      .map((row) => asString(row.label) ?? asString(row.key) ?? 'unknown');
    return [
      `${criticalCount} critical alerts need attention.`,
      `${(dashboard.atRiskProducts as unknown[] | undefined)?.length ?? 0} products are currently at risk.`,
      `Declining or underperforming trends: ${textList(trendLabels)}.`,
      `Data warnings: ${asRecord(dashboard.warningSummary).warningCount ?? 0}.`,
    ].join(' ');
  }

  private emailStatus(params: ReportGenerateParams) {
    if (params.emailEnabled !== true) {
      return params.frequency === 'daily' ? 'scheduled_not_configured' : 'preview_only';
    }
    if (!asString(params.emailRecipient)) {
      return 'email_not_configured';
    }
    return 'queued_for_configured_delivery';
  }

  private renderPreview(executiveSummary: string, items: PlainRecord[]) {
    const lines = [`# Ecobase management report`, '', `## Executive summary`, executiveSummary, ''];
    for (const item of items) {
      lines.push(`## ${asString(item.title) ?? 'Report item'}`, asString(item.body) ?? '', '');
    }
    return lines.join('\n');
  }
}
