import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';
import { EcobasePlanningCalculationService } from './planning-calculation-service';
import { EcobaseSupplierOrderService } from './supplier-order-service';

const ALERT_RULE_VERSION = 'ecobase_alerts_mvp_v1';
const DEFAULT_ALERT_CONFIG = {
  buyBoxRiskThresholdPercent: 80,
  buyBoxHighRiskThresholdPercent: 70,
  marginGapPercent: 15,
  velocityBaselineThresholdPercent: 80,
  leadTimeStaleDays: 30,
  supplierContactStaleDaysByStatus: {
    planned: 3,
    po_placed: 3,
    confirmed: 5,
    preparing: 5,
    shipped: 7,
    blocked: 1,
  },
  supplierOrderMissingUpdateDaysByStatus: {
    planned: 3,
    po_placed: 3,
    confirmed: 5,
    preparing: 5,
    shipped: 7,
    blocked: 1,
  },
  safetyBufferDays: 7,
  prepBufferDays: 0,
  nearOosDaysOfCover: 14,
  highRefundRatePercent: 10,
};

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'suppressed';
export type AlertType =
  | 'oos'
  | 'near_oos'
  | 'reorder_needed'
  | 'replenishment_at_risk'
  | 'off_track'
  | 'supplier_delay'
  | 'stale_lead_time'
  | 'task_inactive'
  | 'data_warning';

type PlainRecord = Record<string, unknown>;

type RootCauseCode =
  | 'current_oos'
  | 'reorder_needed'
  | 'replenishment_at_risk'
  | 'no_supplier_order_placed'
  | 'pipeline_only_inventory'
  | 'near_oos_delayed_inbound_or_supplier_order'
  | 'already_ordered_expected_sellable_late'
  | 'low_buy_box'
  | 'price_margin_issue'
  | 'high_refund_rate'
  | 'slow_sales'
  | 'missing_operational_action_inactive_clickup'
  | 'stale_lead_time'
  | 'supplier_not_recently_contacted'
  | 'supplier_order_missing_update'
  | 'blocked_unreliable_open_order'
  | 'data_warning'
  | 'unknown_manual_review';

interface RootCause {
  code: RootCauseCode;
  priority: number;
  severity: AlertSeverity;
  message: string;
  evidence: PlainRecord;
}

interface AlertCandidate {
  alertType: AlertType;
  severity: AlertSeverity;
  subjectRef: string;
  primaryRootCauseCode: RootCauseCode;
  actionRequired: string;
  rootCauses: RootCause[];
  dataWarnings: unknown[];
  evidence: PlainRecord;
}

export interface EvaluateAlertsParams {
  planningProductId?: string;
  company?: string;
  calculationDate?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function payload(record: PlainRecord): PlainRecord {
  const value = record.payload;
  return typeof value === 'object' && value !== null ? (value as PlainRecord) : {};
}

function payloadNumber(record: PlainRecord, keys: string[]): number | undefined {
  const values = payload(record);
  for (const key of keys) {
    const direct = asNumber(record[key]);
    if (direct !== undefined) {
      return direct;
    }
    const raw = values[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw.replace(/[$,%\s]/g, ''));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function isoDate(value: string | Date) {
  return (value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10);
}

function diffDays(left: string, right: string) {
  const leftDate = new Date(left).getTime();
  const rightDate = new Date(right).getTime();
  return Math.floor((leftDate - rightDate) / 86_400_000);
}

function mostRecent(records: PlainRecord[], dateField: string) {
  return [...records].sort((left, right) => String(right[dateField] ?? '').localeCompare(String(left[dateField] ?? '')))[0];
}

function maxNumber(records: PlainRecord[], keys: string[]) {
  const values = records.map((record) => payloadNumber(record, keys)).filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function averageVelocity(records: PlainRecord[], calculationDate: string, days: number) {
  const end = new Date(`${calculationDate}T00:00:00.000Z`).getTime();
  const start = end - (days - 1) * 86_400_000;
  const units = records.reduce((total, record) => {
    const snapshotDate = asString(record.snapshotDate);
    if (!snapshotDate) {
      return total;
    }
    const time = new Date(`${snapshotDate}T00:00:00.000Z`).getTime();
    if (time < start || time > end) {
      return total;
    }
    return total + (asNumber(record.units) ?? 0);
  }, 0);
  return units / days;
}

function rootCauseSort(causes: RootCause[]) {
  return [...causes].sort((left, right) => left.priority - right.priority || left.code.localeCompare(right.code));
}

function maxSeverity(left: AlertSeverity, right: AlertSeverity): AlertSeverity {
  const order: Record<AlertSeverity, number> = { info: 1, warning: 2, critical: 3 };
  return order[right] > order[left] ? right : left;
}

function dedupeKey(candidate: AlertCandidate, planningProductId: string) {
  return [planningProductId, candidate.alertType, candidate.primaryRootCauseCode, candidate.subjectRef].join(':');
}

function actionFor(code: RootCauseCode) {
  const actions: Record<RootCauseCode, string> = {
    current_oos: 'Restore sellable Amazon stock immediately or confirm an active recovery order.',
    reorder_needed: 'Place or confirm a supplier order before the restock deadline.',
    replenishment_at_risk: 'Review replenishment coverage and fix the blocking supplier-order risk.',
    no_supplier_order_placed: 'Create a supplier order or document why no order is needed.',
    pipeline_only_inventory: 'Verify pipeline/reserved/inbound stock before treating it as recovery coverage.',
    near_oos_delayed_inbound_or_supplier_order: 'Escalate delayed inbound or supplier order recovery before stockout.',
    already_ordered_expected_sellable_late: 'Contact the supplier and expedite or adjust recovery expectations.',
    low_buy_box: 'Investigate Buy Box loss and pricing/availability drivers.',
    price_margin_issue: 'Review price, COGS, and margin gap for this product.',
    high_refund_rate: 'Investigate refund drivers and product/listing quality.',
    slow_sales: 'Review slow velocity against the baseline before replenishment decisions.',
    missing_operational_action_inactive_clickup: 'Assign or update the linked operational task.',
    stale_lead_time: 'Refresh supplier lead-time evidence.',
    supplier_not_recently_contacted: 'Contact the supplier and record the follow-up.',
    supplier_order_missing_update: 'Update the supplier order status or delivery evidence.',
    blocked_unreliable_open_order: 'Resolve the blocked supplier order before relying on its recovery quantity.',
    data_warning: 'Fix the data warning before relying on this alert.',
    unknown_manual_review: 'Review the product manually because available facts are incomplete.',
  };
  return actions[code];
}

export class EcobaseAlertEvaluationService {
  constructor(private db: EcobaseDatabase) {}

  static defaultConfig() {
    return { ...DEFAULT_ALERT_CONFIG };
  }

  async evaluatePlanningProducts(params: EvaluateAlertsParams = {}) {
    const products = await this.findProducts(params);
    const ruleVersion = await this.ensureRuleVersion(params.company);
    const summaries = [];
    for (const product of products) {
      summaries.push(await this.evaluateProduct(product, ruleVersion, params));
    }
    return {
      evaluatedAt: new Date().toISOString(),
      ruleVersion,
      productCount: products.length,
      summaries,
    };
  }

  async listAlerts(params: { company?: string; status?: AlertStatus; limit?: number } = {}) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.alerts);
    const filter: PlainRecord = {};
    if (params.company) {
      filter.company = params.company;
    }
    if (params.status) {
      filter.status = params.status;
    }
    return (await repo.find({ filter, sort: ['-lastSeenAt'], limit: params.limit ?? 100 })).map(toPlainRecord);
  }

  private async findProducts(params: EvaluateAlertsParams) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts);
    if (params.planningProductId) {
      const product = await repo.findOne({ filterByTk: params.planningProductId });
      if (!product) {
        throw new Error(`Ecobase alert evaluation failed: planning product "${params.planningProductId}" was not found.`);
      }
      return [toPlainRecord(product)];
    }
    const filter = params.company ? { company: params.company } : undefined;
    return (await repo.find({ filter, limit: 500 })).map(toPlainRecord);
  }

  private async ensureRuleVersion(company?: string) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.ruleVersions);
    const name = ALERT_RULE_VERSION;
    const existing = await repo.findOne({ filter: { name, active: true } });
    const prepBufferDays = await new EcobaseSupplierOrderService(this.db).getPrepBufferDays(company);
    const values = {
      name,
      ruleType: 'alert_evaluation',
      config: { ...DEFAULT_ALERT_CONFIG, prepBufferDays },
      activeFrom: new Date().toISOString(),
      active: true,
    };
    if (existing) {
      const record = toPlainRecord(existing);
      await repo.update({ filterByTk: asString(record.id) ?? '', values });
      return toPlainRecord(await repo.findOne({ filterByTk: asString(record.id) ?? '' }) ?? record);
    }
    return toPlainRecord(await repo.create({ values: { id: randomUUID(), ...values } }));
  }

  private async evaluateProduct(product: PlainRecord, ruleVersion: PlainRecord, params: EvaluateAlertsParams) {
    const planningProductId = asString(product.id);
    if (!planningProductId) {
      throw new Error('Ecobase alert evaluation failed: planning product is missing id.');
    }
    const calculationDate = isoDate(params.calculationDate ?? new Date());
    const config = toPlainRecord(ruleVersion.config) as typeof DEFAULT_ALERT_CONFIG;
    const calculation = await new EcobasePlanningCalculationService(this.db).calculatePlanningProduct({
      planningProductId,
      calculationDate,
      safetyBufferDays: asNumber(config.safetyBufferDays),
      persist: true,
    });
    const coverage = await new EcobaseSupplierOrderService(this.db).getCoverage(planningProductId, asString(calculation.oosDate));
    const context = await this.productContext(planningProductId, calculationDate);
    const rootCauses = this.evaluateRootCauses({ product, calculation, coverage, context, config, calculationDate });
    const dataWarnings = [
      ...asArray(calculation.warnings),
      ...coverage.dataWarnings.map((warning) => ({ code: warning, message: `Supplier-order coverage warning: ${warning}` })),
    ];
    const estimatedProfitRisk = this.estimateProfitRisk(calculation, coverage);
    const evaluationRepo = this.db.getRepository(ECOBASE_COLLECTIONS.alertEvaluations);
    const evaluation = toPlainRecord(
      await evaluationRepo.create({
        values: {
          id: randomUUID(),
          planningProductId,
          company: asString(product.company),
          canonicalAsin: asString(product.canonicalAsin),
          evaluatedAt: new Date().toISOString(),
          ruleVersionId: asString(ruleVersion.id),
          tier: asString(calculation.tier) ?? 'unclassified',
          sellableStock: asNumber(calculation.sellableStock),
          pipelineStock: asNumber(calculation.pipelineStock),
          salesVelocity: asNumber(calculation.salesVelocity),
          daysOfCover: asNumber(calculation.daysOfCover),
          oosDate: asString(calculation.oosDate),
          restockDeadline: asString(calculation.restockDeadlineImproved) ?? asString(calculation.restockDeadlineParity),
          daysLeftOrOverdue: asNumber(calculation.daysLeftOrOverdue),
          profitGap: asNumber(calculation.profitGap),
          estimatedProfitRisk,
          rootCauses,
          dataWarnings,
          evidence: {
            calculation,
            supplierOrderCoverage: coverage,
            context,
            config,
          },
        },
      }),
    );
    const candidates = this.toAlertCandidates({ rootCauses, dataWarnings, calculation, coverage, estimatedProfitRisk });
    const openAlerts = await this.upsertAlerts({ product, evaluation, candidates });
    await this.resolveClearedAlerts(planningProductId, candidates, evaluation);
    return {
      planningProductId,
      company: asString(product.company),
      canonicalAsin: asString(product.canonicalAsin),
      alertCount: openAlerts.length,
      rootCauseCodes: rootCauses.map((cause) => cause.code),
      openAlerts,
      evaluation,
    };
  }

  private async productContext(planningProductId: string, calculationDate: string) {
    const facts = (await this.db.getRepository(ECOBASE_COLLECTIONS.listingDailyFacts).find({ filter: { planningProductId } })).map(toPlainRecord);
    const inventoryRows = (await this.db.getRepository(ECOBASE_COLLECTIONS.inventorySnapshots).find({ filter: { planningProductId } })).map(toPlainRecord);
    const parameterRows = (await this.db.getRepository(ECOBASE_COLLECTIONS.planningParameters).find({ filter: { planningProductId } })).map(toPlainRecord);
    const leadTimes = (await this.db.getRepository(ECOBASE_COLLECTIONS.supplierLeadTimes).find({})).map(toPlainRecord);
    const latestFact = mostRecent(facts, 'snapshotDate') ?? {};
    const latestInventory = mostRecent(inventoryRows, 'snapshotDate') ?? {};
    const latestLeadTime = mostRecent(leadTimes, 'confirmedAt') ?? {};
    const buyBoxPercentage = maxNumber(facts, ['buyBoxPercentage', 'Buy Box %']) ?? maxNumber(inventoryRows, ['buyBoxPercentage', 'Buy Box %']);
    const margin = payloadNumber(latestFact, ['margin', 'Margin', 'Margin %']);
    const refundRate = payloadNumber(latestFact, ['refundRate', 'Refund Rate', 'Refund %']);
    const baselineVelocity = maxNumber(parameterRows, ['baselineVelocity', 'Baseline Velocity', 'Expected Sales Velocity']);
    const sourceVelocity = payloadNumber(latestInventory, ['salesVelocity', 'Sales Velocity']);
    const sevenDayVelocity = averageVelocity(facts, calculationDate, 7);
    return {
      latestFact,
      latestInventory,
      latestLeadTime,
      buyBoxPercentage,
      margin,
      refundRate,
      baselineVelocity,
      sourceVelocity,
      sevenDayVelocity,
    };
  }

  private evaluateRootCauses(params: {
    product: PlainRecord;
    calculation: PlainRecord;
    coverage: any;
    context: PlainRecord;
    config: PlainRecord;
    calculationDate: string;
  }) {
    const { calculation, coverage, context, config, calculationDate } = params;
    const causes: RootCause[] = [];
    const sellableStock = asNumber(calculation.sellableStock) ?? 0;
    const pipelineStock = asNumber(calculation.pipelineStock) ?? 0;
    const daysOfCover = asNumber(calculation.daysOfCover);
    const daysLeftOrOverdue = asNumber(calculation.daysLeftOrOverdue);
    const profitGap = asNumber(calculation.profitGap);
    const profitPerUnit = asNumber(calculation.profitPerUnit);
    const buyBoxPercentage = asNumber(context.buyBoxPercentage);
    const margin = asNumber(context.margin);
    const refundRate = asNumber(context.refundRate);
    const baselineVelocity = asNumber(context.baselineVelocity);
    const sevenDayVelocity = asNumber(context.sevenDayVelocity);
    const coverageState = asString(coverage.coverageState) ?? 'no_open_order';

    if (sellableStock <= 0) {
      causes.push({ code: 'current_oos', priority: 10, severity: 'critical', message: 'Sellable stock is zero or below.', evidence: { sellableStock } });
    }
    if (asBoolean(calculation.restockNeeded) || (typeof daysLeftOrOverdue === 'number' && daysLeftOrOverdue <= 0)) {
      causes.push({ code: 'reorder_needed', priority: 20, severity: 'critical', message: 'Restock is needed by the deterministic planning rule.', evidence: { daysLeftOrOverdue, restockNeeded: calculation.restockNeeded } });
    }
    if (coverageState !== 'arrives_before_stockout' && (sellableStock <= 0 || (typeof daysOfCover === 'number' && daysOfCover <= (asNumber(config.nearOosDaysOfCover) ?? 14)) || asBoolean(calculation.restockNeeded))) {
      causes.push({ code: 'replenishment_at_risk', priority: 30, severity: coverageState === 'no_open_order' ? 'critical' : 'warning', message: 'Replenishment coverage is not safely arriving before stockout.', evidence: { coverageState } });
    }
    if (coverageState === 'no_open_order' && (sellableStock <= 0 || asBoolean(calculation.restockNeeded))) {
      causes.push({ code: 'no_supplier_order_placed', priority: 40, severity: 'critical', message: 'No open supplier-order line covers this planning product.', evidence: { coverageState } });
    }
    if (sellableStock <= 0 && pipelineStock > 0 && coverageState === 'no_open_order') {
      causes.push({ code: 'pipeline_only_inventory', priority: 50, severity: 'warning', message: 'Only raw pipeline/reserved/inbound/prep inventory exists; no reconciled supplier-order recovery was counted.', evidence: { pipelineStock, coverageState } });
    }
    if (coverageState === 'arrives_late' || coverageState === 'partial_or_mixed_coverage') {
      causes.push({ code: 'near_oos_delayed_inbound_or_supplier_order', priority: 60, severity: 'critical', message: 'Open recovery is delayed or mixed relative to projected stockout.', evidence: { coverageState } });
    }
    if (coverageState === 'arrives_late') {
      causes.push({ code: 'already_ordered_expected_sellable_late', priority: 70, severity: 'critical', message: 'The product is already ordered, but expected sellable date is late.', evidence: { nextLateExpectedSellableDate: coverage.nextLateExpectedSellableDate } });
    }
    if (coverageState === 'blocked_open_order') {
      causes.push({ code: 'blocked_unreliable_open_order', priority: 75, severity: 'critical', message: 'Open supplier-order coverage is blocked and unreliable.', evidence: { blockedOpenQty: coverage.blockedOpenQty } });
    }
    if (typeof buyBoxPercentage === 'number' && buyBoxPercentage < (asNumber(config.buyBoxRiskThresholdPercent) ?? 80)) {
      causes.push({ code: 'low_buy_box', priority: 80, severity: buyBoxPercentage < (asNumber(config.buyBoxHighRiskThresholdPercent) ?? 70) ? 'critical' : 'warning', message: 'Buy Box percentage is below the configured risk threshold.', evidence: { buyBoxPercentage } });
    }
    if ((typeof margin === 'number' && margin < (asNumber(config.marginGapPercent) ?? 15)) || (typeof profitGap === 'number' && profitGap > 0 && typeof profitPerUnit === 'number' && profitPerUnit <= 0)) {
      causes.push({ code: 'price_margin_issue', priority: 90, severity: 'warning', message: 'Margin or price/profit gap requires review.', evidence: { margin, profitGap, profitPerUnit } });
    }
    if (typeof refundRate === 'number' && refundRate >= (asNumber(config.highRefundRatePercent) ?? 10)) {
      causes.push({ code: 'high_refund_rate', priority: 100, severity: 'warning', message: 'Refund rate is above the configured threshold.', evidence: { refundRate } });
    }
    const observedVelocity = Math.max(sevenDayVelocity ?? 0, asNumber(context.sourceVelocity) ?? 0);
    if (typeof baselineVelocity === 'number' && baselineVelocity > 0 && observedVelocity < baselineVelocity * ((asNumber(config.velocityBaselineThresholdPercent) ?? 80) / 100)) {
      causes.push({ code: 'slow_sales', priority: 110, severity: 'warning', message: 'Sales velocity is below the configured baseline threshold.', evidence: { baselineVelocity, observedVelocity, sevenDayVelocity, sourceVelocity: context.sourceVelocity } });
    }
    const leadTimeConfirmedAt = asString(toPlainRecord(context.latestLeadTime).confirmedAt);
    if (leadTimeConfirmedAt && diffDays(`${calculationDate}T00:00:00.000Z`, leadTimeConfirmedAt) > (asNumber(config.leadTimeStaleDays) ?? 30)) {
      causes.push({ code: 'stale_lead_time', priority: 130, severity: 'warning', message: 'Supplier lead-time evidence is stale.', evidence: { leadTimeConfirmedAt } });
    }
    const contactRecency = toPlainRecord(coverage.contactRecency);
    const contactedAt = asString(contactRecency.occurredAt);
    const contactAge = contactedAt ? diffDays(`${calculationDate}T00:00:00.000Z`, contactedAt) : undefined;
    if (coverageState !== 'no_open_order' && (contactAge === undefined || contactAge > 3)) {
      causes.push({ code: 'supplier_not_recently_contacted', priority: 140, severity: 'warning', message: 'Supplier contact is missing or stale for the active recovery.', evidence: { contactedAt, contactAge } });
    }
    if (coverageState === 'incomplete_or_stale') {
      causes.push({ code: 'supplier_order_missing_update', priority: 145, severity: 'warning', message: 'Open supplier-order recovery is missing update or expected sellable evidence.', evidence: { dataWarnings: coverage.dataWarnings } });
    }
    if (asArray(calculation.warnings).length > 0 || asArray(coverage.dataWarnings).length > 0) {
      causes.push({ code: 'data_warning', priority: 170, severity: 'warning', message: 'Data warnings affect this alert evaluation.', evidence: { calculationWarnings: calculation.warnings, coverageWarnings: coverage.dataWarnings } });
    }
    if (asString(calculation.calculationStatus) !== 'calculated') {
      causes.push({ code: 'unknown_manual_review', priority: 180, severity: 'info', message: 'The product requires manual review because deterministic inputs are incomplete.', evidence: { calculationStatus: calculation.calculationStatus } });
    }
    return rootCauseSort(causes);
  }

  private estimateProfitRisk(calculation: PlainRecord, coverage: any) {
    const velocity = asNumber(calculation.salesVelocity);
    const profitPerUnit = asNumber(calculation.profitPerUnit);
    const oosDate = asString(calculation.oosDate);
    const recoveryDate = asString(coverage.nextExpectedSellableDate) ?? asString(coverage.nextLateExpectedSellableDate);
    if (!velocity || velocity <= 0 || typeof profitPerUnit !== 'number' || !oosDate || !recoveryDate) {
      return asNumber(calculation.estimatedProfitRisk);
    }
    return Math.max(0, diffDays(`${recoveryDate}T00:00:00.000Z`, `${oosDate}T00:00:00.000Z`)) * velocity * profitPerUnit;
  }

  private toAlertCandidates(params: { rootCauses: RootCause[]; dataWarnings: unknown[]; calculation: PlainRecord; coverage: any; estimatedProfitRisk?: number }) {
    const candidates: AlertCandidate[] = [];
    const { rootCauses, dataWarnings, coverage, estimatedProfitRisk } = params;
    const byCode = new Map(rootCauses.map((cause) => [cause.code, cause]));
    const add = (alertType: AlertType, codes: RootCauseCode[], subjectRef: string) => {
      const causes = rootCauseSort(codes.map((code) => byCode.get(code)).filter((cause): cause is RootCause => !!cause));
      if (causes.length === 0) {
        return;
      }
      const severity = causes.reduce((result, cause) => maxSeverity(result, cause.severity), 'info' as AlertSeverity);
      candidates.push({
        alertType,
        severity,
        subjectRef,
        primaryRootCauseCode: causes[0].code,
        actionRequired: actionFor(causes[0].code),
        rootCauses: causes,
        dataWarnings,
        evidence: { supplierOrderCoverage: coverage, estimatedProfitRisk },
      });
    };
    add('oos', ['current_oos', 'pipeline_only_inventory'], 'planning_product');
    add('reorder_needed', ['reorder_needed', 'no_supplier_order_placed'], 'planning_product');
    add('near_oos', ['near_oos_delayed_inbound_or_supplier_order'], 'planning_product');
    add('replenishment_at_risk', ['replenishment_at_risk', 'blocked_unreliable_open_order', 'supplier_order_missing_update'], 'planning_product');
    for (const lineId of asArray(coverage.linkedSupplierOrderLineIds).map(String)) {
      add('supplier_delay', ['already_ordered_expected_sellable_late', 'supplier_not_recently_contacted', 'supplier_order_missing_update'], lineId);
    }
    add('off_track', ['low_buy_box', 'price_margin_issue', 'high_refund_rate', 'slow_sales'], 'planning_product');
    add('stale_lead_time', ['stale_lead_time'], 'planning_product');
    add('data_warning', ['data_warning', 'unknown_manual_review'], 'planning_product');
    return candidates;
  }

  private async upsertAlerts(params: { product: PlainRecord; evaluation: PlainRecord; candidates: AlertCandidate[] }) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.alerts);
    const planningProductId = asString(params.product.id) ?? '';
    const now = asString(params.evaluation.evaluatedAt) ?? new Date().toISOString();
    const alerts = [];
    for (const candidate of params.candidates) {
      const key = dedupeKey(candidate, planningProductId);
      const values = {
        planningProductId,
        company: asString(params.product.company),
        canonicalAsin: asString(params.product.canonicalAsin),
        title: asString(params.product.title),
        alertEvaluationId: asString(params.evaluation.id),
        alertType: candidate.alertType,
        severity: candidate.severity,
        status: 'open',
        subjectRef: candidate.subjectRef,
        primaryRootCauseCode: candidate.primaryRootCauseCode,
        actionRequired: candidate.actionRequired,
        rootCauses: candidate.rootCauses,
        dataWarnings: candidate.dataWarnings,
        evidence: candidate.evidence,
        lastSeenAt: now,
        resolvedAt: null,
      };
      const existing = toPlainRecord(await repo.findOne({ filter: { dedupeKey: key } }));
      if (asString(existing.id) && asString(existing.status) !== 'resolved') {
        await repo.update({ filterByTk: asString(existing.id) ?? '', values });
        alerts.push(toPlainRecord(await repo.findOne({ filterByTk: asString(existing.id) ?? '' })));
      } else if (asString(existing.id)) {
        await repo.update({ filterByTk: asString(existing.id) ?? '', values: { ...values, openedAt: now } });
        alerts.push(toPlainRecord(await repo.findOne({ filterByTk: asString(existing.id) ?? '' })));
      } else {
        alerts.push(toPlainRecord(await repo.create({ values: { id: randomUUID(), dedupeKey: key, ...values, openedAt: now } })));
      }
    }
    return alerts;
  }

  private async resolveClearedAlerts(planningProductId: string, candidates: AlertCandidate[], evaluation: PlainRecord) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.alerts);
    const expectedKeys = new Set(candidates.map((candidate) => dedupeKey(candidate, planningProductId)));
    const openAlerts = (await repo.find({ filter: { planningProductId, status: 'open' } })).map(toPlainRecord);
    const now = asString(evaluation.evaluatedAt) ?? new Date().toISOString();
    for (const alert of openAlerts) {
      const key = asString(alert.dedupeKey);
      const id = asString(alert.id);
      if (id && key && !expectedKeys.has(key)) {
        await repo.update({
          filterByTk: id,
          values: {
            status: 'resolved',
            resolvedAt: now,
            lastSeenAt: now,
            alertEvaluationId: asString(evaluation.id),
          },
        });
      }
    }
  }
}
