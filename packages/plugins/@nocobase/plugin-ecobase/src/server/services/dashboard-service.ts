import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { EcobaseComparisonService } from './comparison-service';
import { EcobaseDataWarningService } from './data-warning-service';
import type { EcobaseDatabase } from './import-service';
import { EcobaseSupplierOrderService } from './supplier-order-service';

type PlainRecord = Record<string, unknown>;

type DashboardFilters = {
  company?: string;
  accountKey?: string;
  date?: string;
  periodType?: 'daily' | 'weekly' | 'monthly';
  period?: string;
  alertType?: string;
  severity?: string;
  status?: string;
};

type DashboardSettings = {
  sourceFreshnessSlaMinutes: number;
  buyBoxRiskThreshold: number;
  buyBoxHighRiskThreshold: number;
  marginGapPercent: number;
  velocityBaselinePercent: number;
  refundRateThreshold: number;
  leadTimeStaleDays: number;
  supplierOrderStatusSlaDays: number;
  supplierContactStaleDays: number;
  prepBufferDays: number;
  clickupHighPriorityInactiveHours: number;
  clickupNormalPriorityInactiveHours: number;
  clickupLowPriorityInactiveHours: number;
  safetyBufferDays: number;
  dailyReportSchedule: string;
  timezone: string;
};

const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  sourceFreshnessSlaMinutes: 24 * 60,
  buyBoxRiskThreshold: 80,
  buyBoxHighRiskThreshold: 70,
  marginGapPercent: 15,
  velocityBaselinePercent: 80,
  refundRateThreshold: 10,
  leadTimeStaleDays: 30,
  supplierOrderStatusSlaDays: 7,
  supplierContactStaleDays: 7,
  prepBufferDays: 7,
  clickupHighPriorityInactiveHours: 24,
  clickupNormalPriorityInactiveHours: 72,
  clickupLowPriorityInactiveHours: 168,
  safetyBufferDays: 7,
  dailyReportSchedule: '08:00',
  timezone: 'Asia/Karachi',
};

function toPlainRecord(value: unknown): PlainRecord {
  if (typeof value === 'object' && value !== null) {
    if (typeof (value as { get?: (key?: string) => unknown }).get === 'function') {
      const raw = (value as { get: (key?: string) => unknown }).get();
      return typeof raw === 'object' && raw !== null ? (raw as PlainRecord) : (value as PlainRecord);
    }
    return value as PlainRecord;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): PlainRecord {
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function payloadString(record: PlainRecord, key: string): string | undefined {
  return asString(asRecord(record.payload)[key]);
}

function numberSetting(values: PlainRecord, key: keyof DashboardSettings, current: DashboardSettings) {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : current[key];
}

function latestByDate(records: PlainRecord[], key: string) {
  return [...records].sort((left, right) => String(right[key] ?? '').localeCompare(String(left[key] ?? '')))[0];
}

function filterByDashboard(filters: DashboardFilters, record: PlainRecord) {
  if (filters.company && asString(record.company) !== filters.company) {
    return false;
  }
  if (filters.accountKey && payloadString(record, 'accountKey') !== filters.accountKey && asString(record.accountKey) !== filters.accountKey) {
    return false;
  }
  return true;
}

function sameAlertFilter(filters: DashboardFilters, alert: PlainRecord) {
  if (!filterByDashboard(filters, alert)) {
    return false;
  }
  if (filters.alertType && asString(alert.alertType) !== filters.alertType) {
    return false;
  }
  if (filters.severity && asString(alert.severity) !== filters.severity) {
    return false;
  }
  if (filters.status && asString(alert.status) !== filters.status) {
    return false;
  }
  return true;
}

export class EcobaseDashboardService {
  constructor(private db: EcobaseDatabase) {}

  async getDashboard(filters: DashboardFilters = {}) {
    const normalizedFilters = this.normalizeFilters(filters);
    const importStatuses = await this.listSourceStatuses();
    const comparison = await new EcobaseComparisonService(this.db).comparePerformance({
      periodType: normalizedFilters.periodType ?? 'weekly',
      period: normalizedFilters.period,
      currentStartDate: normalizedFilters.date,
      currentEndDate: normalizedFilters.date,
      groupBy: normalizedFilters.accountKey ? 'account' : 'company',
      company: normalizedFilters.company,
    });
    const productComparison = await new EcobaseComparisonService(this.db).comparePerformance({
      periodType: normalizedFilters.periodType ?? 'weekly',
      period: normalizedFilters.period,
      currentStartDate: normalizedFilters.date,
      currentEndDate: normalizedFilters.date,
      groupBy: 'planning_product',
      company: normalizedFilters.company,
    });
    const rawListingComparison = await new EcobaseComparisonService(this.db).comparePerformance({
      periodType: normalizedFilters.periodType ?? 'weekly',
      period: normalizedFilters.period,
      currentStartDate: normalizedFilters.date,
      currentEndDate: normalizedFilters.date,
      groupBy: 'raw_listing_sku',
      company: normalizedFilters.company,
    });

    const calculations = (await this.db.getRepository(ECOBASE_COLLECTIONS.planningCalculationSnapshots).find({ sort: ['-calculationDate'], limit: 500 })).map(toPlainRecord);
    const alerts = (await this.db.getRepository(ECOBASE_COLLECTIONS.alerts).find({ sort: ['-lastSeenAt'], limit: 500 })).map(toPlainRecord);
    const taskSnapshots = (await this.db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).find({ sort: ['-snapshotDate'], limit: 300 })).map(toPlainRecord);
    const okrSnapshots = (await this.db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).find({ sort: ['-snapshotDate'], limit: 300 })).map(toPlainRecord);
    const workspace = await new EcobaseSupplierOrderService(this.db).getWorkspace({ company: normalizedFilters.company, limit: 100 });

    const openAlerts = alerts.filter((alert) => sameAlertFilter({ ...normalizedFilters, status: normalizedFilters.status ?? 'open' }, alert));
    const settings = await this.getSettings();

    return {
      filters: normalizedFilters,
      settings,
      importStatuses,
      warningSummary: this.warningSummary(importStatuses),
      profitStockRollups: this.profitStockRollups(calculations, normalizedFilters),
      comparison: {
        accountOrCompany: comparison,
        planningProducts: productComparison,
        rawListings: rawListingComparison,
      },
      atRiskProducts: this.atRiskProducts(calculations, openAlerts),
      openAlerts,
      supplierOrderDelays: this.supplierOrderDelays(workspace, openAlerts),
      accountability: this.accountabilityPanel(taskSnapshots, okrSnapshots, openAlerts),
      drilldowns: {
        alerts: openAlerts.map((alert) => ({
          alertId: asString(alert.id),
          subjectRef: asString(alert.subjectRef),
          evidence: asRecord(alert.evidence),
          dataWarnings: Array.isArray(alert.dataWarnings) ? alert.dataWarnings : [],
          rootCauses: Array.isArray(alert.rootCauses) ? alert.rootCauses : [],
        })),
      },
    };
  }

  async getSettings(): Promise<DashboardSettings> {
    const existing = await this.db.getRepository(ECOBASE_COLLECTIONS.ruleVersions).findOne({
      filter: { ruleType: 'management_dashboard_settings', active: true },
      sort: ['-activeFrom'],
    });
    const config = asRecord(toPlainRecord(existing).config);
    return { ...DEFAULT_DASHBOARD_SETTINGS, ...config };
  }

  async updateSettings(values: PlainRecord): Promise<DashboardSettings> {
    const current = await this.getSettings();
    const next: DashboardSettings = {
      ...current,
      sourceFreshnessSlaMinutes: numberSetting(values, 'sourceFreshnessSlaMinutes', current) as number,
      buyBoxRiskThreshold: numberSetting(values, 'buyBoxRiskThreshold', current) as number,
      buyBoxHighRiskThreshold: numberSetting(values, 'buyBoxHighRiskThreshold', current) as number,
      marginGapPercent: numberSetting(values, 'marginGapPercent', current) as number,
      velocityBaselinePercent: numberSetting(values, 'velocityBaselinePercent', current) as number,
      refundRateThreshold: numberSetting(values, 'refundRateThreshold', current) as number,
      leadTimeStaleDays: numberSetting(values, 'leadTimeStaleDays', current) as number,
      supplierOrderStatusSlaDays: numberSetting(values, 'supplierOrderStatusSlaDays', current) as number,
      supplierContactStaleDays: numberSetting(values, 'supplierContactStaleDays', current) as number,
      prepBufferDays: numberSetting(values, 'prepBufferDays', current) as number,
      clickupHighPriorityInactiveHours: numberSetting(values, 'clickupHighPriorityInactiveHours', current) as number,
      clickupNormalPriorityInactiveHours: numberSetting(values, 'clickupNormalPriorityInactiveHours', current) as number,
      clickupLowPriorityInactiveHours: numberSetting(values, 'clickupLowPriorityInactiveHours', current) as number,
      safetyBufferDays: numberSetting(values, 'safetyBufferDays', current) as number,
      dailyReportSchedule: asString(values.dailyReportSchedule) ?? current.dailyReportSchedule,
      timezone: asString(values.timezone) ?? current.timezone,
    };
    const repository = this.db.getRepository(ECOBASE_COLLECTIONS.ruleVersions);
    const existing = toPlainRecord(await repository.findOne({ filter: { ruleType: 'management_dashboard_settings', active: true } }));
    if (asString(existing.id)) {
      await repository.update({ filterByTk: asString(existing.id), values: { config: next, activeFrom: new Date().toISOString() } });
    } else {
      await repository.create({
        values: {
          id: randomUUID(),
          name: 'ecobase_management_dashboard_mvp_settings_v1',
          ruleType: 'management_dashboard_settings',
          config: next,
          activeFrom: new Date().toISOString(),
          active: true,
        },
      });
    }
    return next;
  }

  private normalizeFilters(filters: DashboardFilters): DashboardFilters {
    return {
      company: asString(filters.company),
      accountKey: asString(filters.accountKey),
      date: asString(filters.date),
      periodType: filters.periodType ?? 'weekly',
      period: asString(filters.period) ?? '2026-W23',
      alertType: asString(filters.alertType),
      severity: asString(filters.severity),
      status: asString(filters.status),
    };
  }

  private async listSourceStatuses() {
    const sourceConnections = (await this.db.getRepository(ECOBASE_COLLECTIONS.sourceConnections).find({ sort: ['name'] })).map(toPlainRecord);
    const importRunRepo = this.db.getRepository(ECOBASE_COLLECTIONS.importRuns);
    const warningService = new EcobaseDataWarningService(this.db);
    return Promise.all(
      sourceConnections.map(async (sourceConnection) => {
        const sourceConnectionId = asString(sourceConnection.id);
        if (!sourceConnectionId) {
          throw new Error('Ecobase dashboard failed: source connection record is missing id.');
        }
        const latestRun = toPlainRecord(await importRunRepo.findOne({ filter: { sourceConnectionId }, sort: ['-startedAt'] }));
        const warningAssessment = await warningService.assessSourceConnection(sourceConnectionId);
        return {
          sourceConnectionId,
          connectionName: asString(sourceConnection.name) ?? '(unnamed source)',
          sourceType: asString(sourceConnection.sourceType) ?? '(unknown source type)',
          domain: asString(sourceConnection.domain) ?? '(unknown domain)',
          active: sourceConnection.active !== false,
          required: warningAssessment.required,
          freshnessSlaMinutes: warningAssessment.freshnessSlaMinutes,
          latestImportRunId: asString(latestRun.id) ?? null,
          latestRunStatus: asString(latestRun.status) ?? null,
          latestSuccessfulRunAt: warningAssessment.latestSuccessfulRunAt,
          rowCount: asNumber(latestRun.rowCount) ?? 0,
          normalizedCount: asNumber(latestRun.normalizedCount) ?? 0,
          warningCount: warningAssessment.warnings.length,
          latestRunWarningCount: asNumber(latestRun.warningCount) ?? 0,
          errorCount: asNumber(latestRun.errorCount) ?? 0,
          lastRunAt: asString(latestRun.finishedAt) ?? asString(latestRun.startedAt) ?? null,
          latestWarning: warningAssessment.latestWarning,
          warnings: warningAssessment.warnings,
        };
      }),
    );
  }

  private warningSummary(importStatuses: Awaited<ReturnType<EcobaseDashboardService['listSourceStatuses']>>) {
    return {
      sourceCount: importStatuses.length,
      warningCount: importStatuses.reduce((total, status) => total + status.warningCount, 0),
      staleOrBlockedSources: importStatuses.filter((status) => status.warningCount > 0).map((status) => ({
        sourceConnectionId: status.sourceConnectionId,
        connectionName: status.connectionName,
        latestWarning: status.latestWarning,
      })),
    };
  }

  private profitStockRollups(calculations: PlainRecord[], filters: DashboardFilters) {
    const latestByProduct = new Map<string, PlainRecord>();
    for (const calculation of calculations.filter((record) => filterByDashboard(filters, record))) {
      const key = asString(calculation.planningProductId) ?? `${asString(calculation.company) ?? 'unknown'}:${asString(calculation.canonicalAsin) ?? 'unknown'}`;
      const existing = latestByProduct.get(key);
      if (!existing || String(calculation.calculationDate ?? '') > String(existing.calculationDate ?? '')) {
        latestByProduct.set(key, calculation);
      }
    }
    return this.rollups([...latestByProduct.values()]);
  }

  private rollups(records: PlainRecord[]) {
    const rollup = (keyFn: (record: PlainRecord) => string | undefined) => {
      const groups = new Map<string, PlainRecord>();
      for (const record of records) {
        const key = keyFn(record) ?? 'unclassified';
        const existing = groups.get(key) ?? { key, productCount: 0, sellableStock: 0, pipelineStock: 0, achievedProfitMtd: 0, profitGap: 0, estimatedProfitRisk: 0 };
        existing.productCount = (asNumber(existing.productCount) ?? 0) + 1;
        existing.sellableStock = (asNumber(existing.sellableStock) ?? 0) + (asNumber(record.sellableStock) ?? 0);
        existing.pipelineStock = (asNumber(existing.pipelineStock) ?? 0) + (asNumber(record.pipelineStock) ?? 0);
        existing.achievedProfitMtd = (asNumber(existing.achievedProfitMtd) ?? 0) + (asNumber(record.achievedProfitMtd) ?? 0);
        existing.profitGap = (asNumber(existing.profitGap) ?? 0) + (asNumber(record.profitGap) ?? 0);
        existing.estimatedProfitRisk = (asNumber(existing.estimatedProfitRisk) ?? 0) + (asNumber(record.estimatedProfitRisk) ?? 0);
        groups.set(key, existing);
      }
      return [...groups.values()];
    };
    return {
      byCompany: rollup((record) => asString(record.company)),
      byAccount: rollup((record) => payloadString(record, 'accountKey')),
      byTier: rollup((record) => asString(record.tier)),
    };
  }

  private atRiskProducts(calculations: PlainRecord[], openAlerts: PlainRecord[]) {
    return openAlerts
      .filter((alert) => asString(alert.planningProductId))
      .map((alert) => {
        const calculation = latestByDate(
          calculations.filter((candidate) => asString(candidate.planningProductId) === asString(alert.planningProductId)),
          'calculationDate',
        ) ?? {};
        return {
          alertId: asString(alert.id),
          planningProductId: asString(alert.planningProductId),
          company: asString(alert.company),
          canonicalAsin: asString(alert.canonicalAsin),
          tier: asString(calculation.tier),
          daysOfCover: asNumber(calculation.daysOfCover),
          restockDeadline: asString(calculation.restockDeadlineImproved) ?? asString(calculation.restockDeadlineParity),
          profitGap: asNumber(calculation.profitGap),
          severity: asString(alert.severity),
          primaryRootCauseCode: asString(alert.primaryRootCauseCode),
          actionRequired: asString(alert.actionRequired),
          dataWarnings: Array.isArray(alert.dataWarnings) ? alert.dataWarnings : [],
        };
      });
  }

  private supplierOrderDelays(workspace: PlainRecord, openAlerts: PlainRecord[]) {
    const alertBySubject = new Map(openAlerts.map((alert) => [asString(alert.subjectRef), alert]));
    const orders = Array.isArray(workspace.supplierOrders) ? workspace.supplierOrders.map(toPlainRecord) : [];
    const lines = Array.isArray(workspace.supplierOrderLines) ? workspace.supplierOrderLines.map(toPlainRecord) : [];
    const candidates = Array.isArray(workspace.reorderCandidates) ? workspace.reorderCandidates.map(toPlainRecord) : [];
    return lines.map((line) => {
      const order = orders.find((candidate) => asString(candidate.id) === asString(line.supplierOrderId)) ?? {};
      const product = candidates.find((candidate) => asString(candidate.planningProductId) === asString(line.planningProductId)) ?? {};
      const subjectRef = `supplier_order_line:${asString(line.id)}`;
      const alert = alertBySubject.get(subjectRef);
      return {
        supplier: asString(order.supplierName) ?? asString(order.supplierId),
        orderRef: asString(order.externalOrderRef) ?? asString(order.id),
        status: asString(order.status) ?? asString(line.status),
        statusAgeDays: asNumber(order.statusAgeDays),
        expectedDeliveryDate: asString(line.expectedDeliveryDate),
        expectedSellableDate: asString(line.expectedSellableDate),
        linkedPlanningProductId: asString(line.planningProductId),
        alreadyPlacedForRisk: Boolean(product.coverage),
        latestSupplierContactAt: asString(product.latestContactAt),
        leadTimeAgeDays: asNumber(product.leadTimeAgeDays),
        severity: asString(alert?.severity),
        sourceWarnings: Array.isArray(alert?.dataWarnings) ? alert?.dataWarnings : [],
      };
    });
  }

  private accountabilityPanel(taskSnapshots: PlainRecord[], okrSnapshots: PlainRecord[], openAlerts: PlainRecord[]) {
    const accountabilityAlerts = openAlerts.filter((alert) => ['task_inactive', 'accountability', 'off_track'].includes(asString(alert.alertType) ?? ''));
    return {
      taskAlerts: accountabilityAlerts.filter((alert) => String(alert.subjectRef ?? '').startsWith('clickup_task:')),
      okrAlerts: accountabilityAlerts.filter((alert) => String(alert.subjectRef ?? '').startsWith('okr:')),
      latestTasks: taskSnapshots.slice(0, 50).map((task) => ({
        externalTaskId: asString(task.externalTaskId),
        taskName: asString(task.taskName),
        assignee: asString(task.assignee),
        status: asString(task.status),
        priority: asString(task.priority),
        dueDate: asString(task.dueDate),
        lastMeaningfulUpdateAt: asString(task.lastMeaningfulUpdateAt),
        operationalArea: asString(task.operationalArea),
        sourceWarnings: [],
      })),
      latestOkrMetrics: okrSnapshots.slice(0, 50),
    };
  }
}
