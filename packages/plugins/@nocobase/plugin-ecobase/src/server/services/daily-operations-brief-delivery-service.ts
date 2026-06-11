import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase } from './import-service';
import { toPlainRecord } from './import-service';

type MarkSentParams = {
  reportRunId?: string;
  deliveryProvider?: string;
  messageId?: string;
};

type MarkFailedParams = {
  reportRunId?: string;
  error?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export class EcobaseDailyOperationsBriefDeliveryService {
  constructor(private db: EcobaseDatabase) {}

  async markSent(params: MarkSentParams) {
    const reportRunId = asString(params.reportRunId);
    if (!reportRunId) {
      throw new Error('Ecobase daily operations brief delivery failed: reportRunId is required.');
    }
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns);
    const existing = toPlainRecord(await repo.findOne({ filterByTk: reportRunId }));
    if (!asString(existing.id)) {
      throw new Error(`Ecobase daily operations brief delivery failed: report run ${reportRunId} was not found.`);
    }
    if (asString(existing.deliveryStatus) === 'sent') {
      return existing;
    }
    if (asString(existing.status) !== 'ready_to_send' || asString(existing.validationStatus) !== 'passed') {
      throw new Error(`Ecobase daily operations brief delivery failed: report run ${reportRunId} is not ready to send.`);
    }
    await repo.update({
      filterByTk: reportRunId,
      values: {
        deliveryStatus: 'sent',
        emailStatus: 'sent',
        deliveredAt: new Date().toISOString(),
        deliveryProvider: asString(params.deliveryProvider) ?? 'nocobase-email',
        deliveryMessageId: asString(params.messageId),
        deliveryError: null,
      },
    });
    return toPlainRecord(await repo.findOne({ filterByTk: reportRunId }));
  }

  async markFailed(params: MarkFailedParams) {
    const reportRunId = asString(params.reportRunId);
    const error = asString(params.error);
    if (!reportRunId) {
      throw new Error('Ecobase daily operations brief delivery failed: reportRunId is required.');
    }
    if (!error) {
      throw new Error('Ecobase daily operations brief delivery failed: error is required when marking failure.');
    }
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.reportRuns);
    const existing = toPlainRecord(await repo.findOne({ filterByTk: reportRunId }));
    if (!asString(existing.id)) {
      throw new Error(`Ecobase daily operations brief delivery failed: report run ${reportRunId} was not found.`);
    }
    if (asString(existing.deliveryStatus) === 'sent') {
      throw new Error(`Ecobase daily operations brief delivery failed: sent report run ${reportRunId} cannot be marked failed.`);
    }
    await repo.update({
      filterByTk: reportRunId,
      values: {
        deliveryStatus: 'send_failed',
        emailStatus: 'send_failed',
        deliveryError: error,
      },
    });
    return toPlainRecord(await repo.findOne({ filterByTk: reportRunId }));
  }
}
