import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

const ACCOUNTABILITY_RULE_VERSION = 'ecobase_accountability_mvp_v1';
const DEFAULT_ACCOUNTABILITY_CONFIG = {
  highPriorityInactiveHours: 24,
  normalPriorityInactiveHours: 72,
  lowPriorityInactiveHours: 168,
  okrOffTrackProgressThresholdPercent: 80,
};

type PlainRecord = Record<string, unknown>;

type AccountabilityTaskContext = Pick<AccountabilityCondition, 'subjectRef' | 'evidence'> &
  Pick<AccountabilityCondition, 'planningProductId' | 'company' | 'canonicalAsin' | 'title'>;

type AccountabilityCondition = {
  dedupeKey: string;
  alertType: string;
  severity: 'info' | 'warning' | 'critical';
  primaryRootCauseCode: string;
  actionRequired: string;
  subjectRef: string;
  planningProductId?: string;
  company?: string;
  canonicalAsin?: string;
  title?: string;
  rootCauses: PlainRecord[];
  dataWarnings: PlainRecord[];
  evidence: PlainRecord;
};

export interface EvaluateAccountabilityParams {
  sourceConnectionId?: string;
  evaluationDate?: string;
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

function isoDate(value: string | Date) {
  return (value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10);
}

function dateTime(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hoursSince(referenceDate: string, value: string | undefined) {
  const observed = dateTime(value);
  if (observed === undefined) {
    return undefined;
  }
  return Math.floor((new Date(`${referenceDate}T00:00:00.000Z`).getTime() - observed) / 3_600_000);
}

function daysBefore(referenceDate: string, value: string | undefined) {
  if (!value) {
    return undefined;
  }
  return Math.floor((new Date(`${referenceDate}T00:00:00.000Z`).getTime() - new Date(`${value}T00:00:00.000Z`).getTime()) / 86_400_000);
}

function isClosedStatus(status: string | undefined) {
  return ['closed', 'complete', 'completed', 'done', 'cancelled', 'canceled', 'archived'].includes((status ?? '').toLowerCase());
}

function priorityThresholdHours(priority: string | undefined, config: PlainRecord) {
  const normalized = (priority ?? 'normal').toLowerCase();
  if (normalized === 'high' || normalized === 'urgent') {
    return asNumber(config.highPriorityInactiveHours) ?? DEFAULT_ACCOUNTABILITY_CONFIG.highPriorityInactiveHours;
  }
  if (normalized === 'low') {
    return asNumber(config.lowPriorityInactiveHours) ?? DEFAULT_ACCOUNTABILITY_CONFIG.lowPriorityInactiveHours;
  }
  return asNumber(config.normalPriorityInactiveHours) ?? DEFAULT_ACCOUNTABILITY_CONFIG.normalPriorityInactiveHours;
}

function taskSubject(task: PlainRecord) {
  return `clickup_task:${asString(task.externalTaskId) ?? asString(task.id) ?? 'unknown'}`;
}

function okrSubject(snapshot: PlainRecord) {
  return `okr:${asString(snapshot.okrId) ?? asString(snapshot.externalOkrId) ?? asString(snapshot.id) ?? 'unknown'}`;
}

function taskAction(code: string) {
  if (code === 'clickup_task_missing_owner') {
    return 'Assign a responsible person for the operational task.';
  }
  if (code === 'clickup_task_overdue') {
    return 'Escalate or complete the overdue operational task.';
  }
  return 'Update the linked operational task with meaningful progress.';
}

export class EcobaseAccountabilityService {
  constructor(private db: EcobaseDatabase) {}

  static defaultConfig() {
    return { ...DEFAULT_ACCOUNTABILITY_CONFIG };
  }

  async evaluateAccountability(params: EvaluateAccountabilityParams = {}) {
    const evaluationDate = isoDate(params.evaluationDate ?? new Date());
    const ruleVersion = await this.ensureRuleVersion();
    const tasks = await this.latestTaskSnapshots(params.sourceConnectionId);
    const okrSnapshots = await this.latestOkrMetricSnapshots(params.sourceConnectionId);
    const taskConditions = await this.evaluateTasks(tasks, evaluationDate, asRecord(ruleVersion.config));
    const okrConditions = await this.evaluateOkrs(okrSnapshots, evaluationDate, asRecord(ruleVersion.config));
    const conditions = [...taskConditions, ...okrConditions];
    const evaluation = await this.createEvaluation({ ruleVersion, evaluationDate, conditions, sourceConnectionId: params.sourceConnectionId });
    const openAlerts = await this.upsertAlerts(conditions, evaluation);
    await this.resolveClearedAlerts(conditions, evaluation, params.sourceConnectionId);
    return {
      evaluatedAt: evaluation.evaluatedAt,
      ruleVersion,
      taskCount: tasks.length,
      okrMetricSnapshotCount: okrSnapshots.length,
      conditionCount: conditions.length,
      openAlerts,
    };
  }

  async listAccountabilityEvidence(params: { sourceConnectionId?: string; limit?: number } = {}) {
    const taskFilter = params.sourceConnectionId ? { sourceConnectionId: params.sourceConnectionId } : undefined;
    return {
      tasks: (await this.db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).find({ filter: taskFilter, sort: ['-snapshotDate'], limit: params.limit ?? 100 })).map(toPlainRecord),
      taskLinks: (await this.db.getRepository(ECOBASE_COLLECTIONS.taskLinks).find({ filter: taskFilter, limit: params.limit ?? 100 })).map(toPlainRecord),
      okrs: (await this.db.getRepository(ECOBASE_COLLECTIONS.okrs).find({ filter: taskFilter, limit: params.limit ?? 100 })).map(toPlainRecord),
      okrMetricSnapshots: (await this.db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).find({ filter: taskFilter, sort: ['-snapshotDate'], limit: params.limit ?? 100 })).map(toPlainRecord),
    };
  }

  private async ensureRuleVersion() {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.ruleVersions);
    const existing = await repo.findOne({ filter: { name: ACCOUNTABILITY_RULE_VERSION, active: true } });
    const values = {
      name: ACCOUNTABILITY_RULE_VERSION,
      ruleType: 'accountability_alert_evaluation',
      config: DEFAULT_ACCOUNTABILITY_CONFIG,
      activeFrom: new Date().toISOString(),
      active: true,
    };
    if (existing) {
      const record = toPlainRecord(existing);
      const id = asString(record.id);
      if (id) {
        await repo.update({ filterByTk: id, values });
        return toPlainRecord((await repo.findOne({ filterByTk: id })) ?? record);
      }
    }
    return toPlainRecord(await repo.create({ values: { id: randomUUID(), ...values } }));
  }

  private async latestTaskSnapshots(sourceConnectionId?: string) {
    const filter = sourceConnectionId ? { sourceConnectionId } : undefined;
    const rows = (await this.db.getRepository(ECOBASE_COLLECTIONS.clickupTaskSnapshots).find({ filter })).map(toPlainRecord);
    const latestByTask = new Map<string, PlainRecord>();
    for (const row of rows) {
      const key = asString(row.externalTaskId) ?? asString(row.id);
      if (!key) {
        continue;
      }
      const current = latestByTask.get(key);
      if (!current || String(row.snapshotDate ?? '') > String(current.snapshotDate ?? '')) {
        latestByTask.set(key, row);
      }
    }
    return [...latestByTask.values()];
  }

  private async latestOkrMetricSnapshots(sourceConnectionId?: string) {
    const filter = sourceConnectionId ? { sourceConnectionId } : undefined;
    const rows = (await this.db.getRepository(ECOBASE_COLLECTIONS.okrMetricSnapshots).find({ filter })).map(toPlainRecord);
    const latestByMetric = new Map<string, PlainRecord>();
    for (const row of rows) {
      const key = [asString(row.okrId) ?? asString(row.externalOkrId), asString(row.metricName) ?? 'primary'].join(':');
      const current = latestByMetric.get(key);
      if (!current || String(row.snapshotDate ?? '') > String(current.snapshotDate ?? '')) {
        latestByMetric.set(key, row);
      }
    }
    return [...latestByMetric.values()];
  }

  private async evaluateTasks(tasks: PlainRecord[], evaluationDate: string, config: PlainRecord) {
    const conditions: AccountabilityCondition[] = [];
    for (const task of tasks) {
      const status = asString(task.status);
      if (isClosedStatus(status)) {
        continue;
      }
      const linked = await this.resolveTaskLink(task);
      const common = {
        subjectRef: taskSubject(task),
        planningProductId: linked.planningProductId,
        company: linked.company,
        canonicalAsin: linked.canonicalAsin,
        title: asString(task.taskName),
        evidence: { task, link: linked.link },
      };
      const assignee = asString(task.assignee) ?? asString(task.assigneeEmail);
      if (!assignee) {
        conditions.push(this.taskCondition(task, common, 'clickup_task_missing_owner', 'critical', { code: 'missing_assignee', message: 'ClickUp task has no assignee.', taskId: asString(task.externalTaskId) }));
      }
      const dueAgeDays = daysBefore(evaluationDate, asString(task.dueDate));
      if (typeof dueAgeDays === 'number' && dueAgeDays > 0) {
        conditions.push(this.taskCondition(task, common, 'clickup_task_overdue', 'critical', { code: 'overdue_task', message: 'ClickUp task is overdue.', dueDate: asString(task.dueDate), dueAgeDays }));
      }
      const thresholdHours = priorityThresholdHours(asString(task.priority), config);
      const meaningfulUpdateAgeHours = hoursSince(evaluationDate, asString(task.lastMeaningfulUpdateAt)) ?? hoursSince(evaluationDate, asString(task.updatedAtSource));
      if (meaningfulUpdateAgeHours === undefined || meaningfulUpdateAgeHours > thresholdHours) {
        conditions.push(this.taskCondition(task, common, 'missing_operational_action_inactive_clickup', asString(task.priority)?.toLowerCase() === 'high' ? 'critical' : 'warning', { code: 'inactive_task', message: 'ClickUp task has no recent meaningful update.', thresholdHours, meaningfulUpdateAgeHours }));
      }
    }
    return conditions;
  }

  private taskCondition(
    task: PlainRecord,
    common: AccountabilityTaskContext,
    code: string,
    severity: 'warning' | 'critical',
    warning: PlainRecord,
  ): AccountabilityCondition {
    const sourceConnectionId = asString(task.sourceConnectionId) ?? 'unknown-source';
    const externalTaskId = asString(task.externalTaskId) ?? asString(task.id) ?? 'unknown-task';
    return {
      dedupeKey: ['accountability', sourceConnectionId, externalTaskId, code].join(':'),
      alertType: code === 'missing_operational_action_inactive_clickup' ? 'task_inactive' : 'accountability',
      severity,
      primaryRootCauseCode: code,
      actionRequired: taskAction(code),
      rootCauses: [{ code, priority: code === 'clickup_task_missing_owner' ? 10 : code === 'clickup_task_overdue' ? 20 : 30, severity, message: asString(warning.message) ?? code, evidence: warning }],
      dataWarnings: [warning],
      ...common,
    };
  }

  private async resolveTaskLink(task: PlainRecord) {
    const externalTaskId = asString(task.externalTaskId);
    const link = externalTaskId
      ? toPlainRecord(await this.db.getRepository(ECOBASE_COLLECTIONS.taskLinks).findOne({ filter: { externalTaskId } }))
      : {};
    const planningProductId = asString(link.planningProductId);
    const product = planningProductId
      ? toPlainRecord(await this.db.getRepository(ECOBASE_COLLECTIONS.planningProducts).findOne({ filterByTk: planningProductId }))
      : {};
    return {
      link,
      planningProductId,
      company: asString(product.company),
      canonicalAsin: asString(product.canonicalAsin),
    };
  }

  private async evaluateOkrs(snapshots: PlainRecord[], evaluationDate: string, config: PlainRecord) {
    const conditions: AccountabilityCondition[] = [];
    for (const snapshot of snapshots) {
      const status = asString(snapshot.status)?.toLowerCase();
      const progressPercent = asNumber(snapshot.progressPercent);
      const offTrack = status === 'off_track' || (typeof progressPercent === 'number' && progressPercent < (asNumber(config.okrOffTrackProgressThresholdPercent) ?? DEFAULT_ACCOUNTABILITY_CONFIG.okrOffTrackProgressThresholdPercent));
      if (!offTrack) {
        continue;
      }
      const okr = await this.resolveOkr(snapshot);
      const sourceConnectionId = asString(snapshot.sourceConnectionId) ?? 'unknown-source';
      const okrRef = asString(snapshot.okrId) ?? asString(snapshot.externalOkrId) ?? asString(snapshot.id) ?? 'unknown-okr';
      conditions.push({
        dedupeKey: ['accountability', sourceConnectionId, okrRef, asString(snapshot.metricName) ?? 'primary', 'okr_off_track'].join(':'),
        alertType: 'off_track',
        severity: 'critical',
        primaryRootCauseCode: 'okr_off_track',
        actionRequired: 'Review the off-track OKR and assign a recovery action.',
        subjectRef: okrSubject(snapshot),
        company: asString(okr.company),
        title: asString(okr.title) ?? asString(snapshot.metricName),
        rootCauses: [{ code: 'okr_off_track', priority: 40, severity: 'critical', message: 'OKR metric is off track.', evidence: { snapshot, okr } }],
        dataWarnings: [],
        evidence: { snapshot, okr, evaluationDate },
      });
    }
    return conditions;
  }

  private async resolveOkr(snapshot: PlainRecord) {
    const okrId = asString(snapshot.okrId);
    if (okrId) {
      const byId = await this.db.getRepository(ECOBASE_COLLECTIONS.okrs).findOne({ filterByTk: okrId });
      if (byId) {
        return toPlainRecord(byId);
      }
    }
    const externalOkrId = asString(snapshot.externalOkrId);
    if (externalOkrId) {
      return toPlainRecord(await this.db.getRepository(ECOBASE_COLLECTIONS.okrs).findOne({ filter: { externalOkrId } }));
    }
    return {};
  }

  private async createEvaluation(params: { ruleVersion: PlainRecord; evaluationDate: string; conditions: AccountabilityCondition[]; sourceConnectionId?: string }) {
    return toPlainRecord(await this.db.getRepository(ECOBASE_COLLECTIONS.alertEvaluations).create({
      values: {
        id: randomUUID(),
        evaluatedAt: new Date(`${params.evaluationDate}T00:00:00.000Z`).toISOString(),
        ruleVersionId: asString(params.ruleVersion.id),
        tier: 'accountability',
        rootCauses: params.conditions.flatMap((condition) => condition.rootCauses),
        dataWarnings: params.conditions.flatMap((condition) => condition.dataWarnings),
        evidence: { sourceConnectionId: params.sourceConnectionId, conditionCount: params.conditions.length },
      },
    }));
  }

  private async upsertAlerts(conditions: AccountabilityCondition[], evaluation: PlainRecord) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.alerts);
    const now = asString(evaluation.evaluatedAt) ?? new Date().toISOString();
    const alerts = [];
    for (const condition of conditions) {
      const values = {
        planningProductId: condition.planningProductId,
        company: condition.company,
        canonicalAsin: condition.canonicalAsin,
        title: condition.title,
        alertEvaluationId: asString(evaluation.id),
        alertType: condition.alertType,
        severity: condition.severity,
        status: 'open',
        subjectRef: condition.subjectRef,
        primaryRootCauseCode: condition.primaryRootCauseCode,
        actionRequired: condition.actionRequired,
        rootCauses: condition.rootCauses,
        dataWarnings: condition.dataWarnings,
        evidence: condition.evidence,
        lastSeenAt: now,
        resolvedAt: null,
      };
      const existing = toPlainRecord(await repo.findOne({ filter: { dedupeKey: condition.dedupeKey } }));
      const existingId = asString(existing.id);
      if (existingId) {
        await repo.update({ filterByTk: existingId, values: { ...values, openedAt: asString(existing.openedAt) ?? now } });
        alerts.push(toPlainRecord(await repo.findOne({ filterByTk: existingId })));
      } else {
        alerts.push(toPlainRecord(await repo.create({ values: { id: randomUUID(), dedupeKey: condition.dedupeKey, ...values, openedAt: now } })));
      }
    }
    return alerts;
  }

  private async resolveClearedAlerts(conditions: AccountabilityCondition[], evaluation: PlainRecord, sourceConnectionId?: string) {
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.alerts);
    const expected = new Set(conditions.map((condition) => condition.dedupeKey));
    const openAlerts = (await repo.find({ filter: { status: 'open' } })).map(toPlainRecord).filter((alert) => {
      const key = asString(alert.dedupeKey);
      if (!key?.startsWith('accountability:')) {
        return false;
      }
      return !sourceConnectionId || key.startsWith(`accountability:${sourceConnectionId}:`);
    });
    const now = asString(evaluation.evaluatedAt) ?? new Date().toISOString();
    for (const alert of openAlerts) {
      const key = asString(alert.dedupeKey);
      const id = asString(alert.id);
      if (id && key && !expected.has(key)) {
        await repo.update({ filterByTk: id, values: { status: 'resolved', resolvedAt: now, lastSeenAt: now, alertEvaluationId: asString(evaluation.id) } });
      }
    }
  }
}
