/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { DEFAULT_PLANNING_SETTINGS, EcobasePlanningSettingsService } from '../services/planning-settings-service';

interface FindParams {
  filter?: Record<string, unknown>;
  filterByTk?: string | number;
  sort?: string[];
  limit?: number;
}

class MemoryRepository implements EcobaseRepository {
  private sequence = 1;

  constructor(private records: Record<string, unknown>[] = []) {}

  async find(params: FindParams = {}) {
    const filtered = this.filterRecords(params);
    return this.sortRecords(filtered, params.sort).slice(0, params.limit ?? filtered.length);
  }

  async findOne(params: FindParams = {}) {
    return (await this.find({ ...params, limit: 1 }))[0] ?? null;
  }

  async create({ values }: { values: Record<string, unknown> }) {
    const record = { id: values.id ?? `record-${this.sequence++}`, ...values };
    this.records.push(record);
    return record;
  }

  async update({
    filter,
    filterByTk,
    values,
  }: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
  }) {
    const records = this.filterRecords({ filter, filterByTk });
    if (records.length === 0) throw new Error('MemoryRepository update failed: matching record was not found.');
    records.forEach((record) => Object.assign(record, values));
    return records[0];
  }

  private filterRecords(params: FindParams) {
    if (params.filterByTk) return this.records.filter((record) => record.id === params.filterByTk);
    const filter = params.filter ?? {};
    return this.records.filter((record) => Object.entries(filter).every(([key, expected]) => record[key] === expected));
  }

  private sortRecords(records: Record<string, unknown>[], sort: string[] = []) {
    const [firstSort] = sort;
    if (!firstSort) return records;
    const descending = firstSort.startsWith('-');
    const key = descending ? firstSort.slice(1) : firstSort;
    return [...records].sort((left, right) => {
      const result = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
      return descending ? -result : result;
    });
  }
}

class MemoryDatabase implements EcobaseDatabase {
  readonly repositories = new Map<string, MemoryRepository>();

  constructor() {
    Object.values(ECOBASE_COLLECTIONS).forEach((name) => this.repositories.set(name, new MemoryRepository()));
  }

  getRepository(name: string) {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`MemoryDatabase failed: repository ${name} was not registered.`);
    return repository;
  }
}

describe('EcobasePlanningSettingsService', () => {
  it('returns operator-visible planning defaults when no settings row exists', async () => {
    const result = await new EcobasePlanningSettingsService(new MemoryDatabase()).getActiveSettings();

    expect(result.settings).toMatchObject({
      ...DEFAULT_PLANNING_SETTINGS,
      defaultSupplierLeadTimeDays: 30,
      fbaReceivingBufferDays: 7,
      enableCurrentOrderCycleSelection: false,
      minimumProjectionCoveredDays: 14,
      paceTolerancePercent: 0,
      projectionPolicyVersion: 'evidence_driven_v1',
      currentProjectionGateMode: 'informational',
    });
  });

  it('saves settings and rejects invalid rule values explicitly', async () => {
    const service = new EcobasePlanningSettingsService(new MemoryDatabase());

    const saved = await service.saveSettings({
      safetyBufferDays: 10,
      reorderCycleDays: 45,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 10,
      supplierOrderPurchasedPipelineStatuses: ['paid', 'custom-paid'],
      defaultSupplierLeadTimeDays: 35,
      fbaReceivingBufferDays: 4,
      enableCurrentOrderCycleSelection: true,
      minimumProjectionCoveredDays: 20,
      paceTolerancePercent: 12.5,
      projectionPolicyVersion: 'evidence_driven_v1',
      currentProjectionGateMode: 'evidence_driven',
    });

    expect(saved).toMatchObject({
      safetyBufferDays: 10,
      reorderCycleDays: 45,
      targetCoverDays: 45,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 10,
      supplierOrderPurchasedPipelineStatuses: ['paid', 'custom_paid'],
      defaultSupplierLeadTimeDays: 35,
      fbaReceivingBufferDays: 4,
      enableCurrentOrderCycleSelection: true,
      minimumProjectionCoveredDays: 20,
      paceTolerancePercent: 12.5,
      projectionPolicyVersion: 'evidence_driven_v1',
      currentProjectionGateMode: 'evidence_driven',
    });
    await expect(service.saveSettings({ safetyBufferDays: -1 })).rejects.toThrow(
      'EcoBase planning settings require Safety buffer days to be a zero-or-positive whole number.',
    );
    await expect(service.saveSettings({ targetCoverDays: 29 })).rejects.toThrow(
      'EcoBase planning settings require Target cover days to be at least 30 days.',
    );
    await expect(service.saveSettings({ profitTierAThreshold: 100, profitTierBThreshold: 200 })).rejects.toThrow(
      'EcoBase profit tier thresholds must descend: A threshold > B threshold > C threshold.',
    );
    await expect(service.saveSettings({ minimumProjectionCoveredDays: 0 })).rejects.toThrow(
      'EcoBase planning settings require Minimum projection covered days to be an integer from 1 through 31.',
    );
    await expect(service.saveSettings({ paceTolerancePercent: 100.01 })).rejects.toThrow(
      'EcoBase planning settings require Pace tolerance percent to be a finite number from 0 through 100.',
    );
    await expect(service.saveSettings({ projectionPolicyVersion: 'legacy' })).rejects.toThrow(
      'EcoBase planning settings require Projection policy version to equal "evidence_driven_v1".',
    );
    await expect(service.saveSettings({ currentProjectionGateMode: 'legacy' })).rejects.toThrow(
      'EcoBase planning settings require Current projection gate mode to be informational or evidence_driven.',
    );
    await expect(
      service.saveSettings({
        supplierOrderPlacedNotPurchasedStatuses: ['paid'],
        supplierOrderPurchasedPipelineStatuses: ['paid'],
      }),
    ).rejects.toThrow('EcoBase supplier order status "paid" cannot be in both');
  });

  it('persists corrected candidate calculation inputs without running a partial catalog refresh', async () => {
    const service = new EcobasePlanningSettingsService(new MemoryDatabase());
    await service.saveSettings({
      safetyBufferDays: 10,
      reorderCycleDays: 40,
      targetCoverDays: 30,
      orderSoonWindowDays: 5,
      leadTimeFreshnessDays: 30,
      purchasedPipelineGraceDays: 1,
      defaultSupplierLeadTimeDays: 12,
      profitTierAThreshold: 500,
      profitTierBThreshold: 200,
      profitTierCThreshold: 0,
    });

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      settings: {
        safetyBufferDays: 10,
        reorderCycleDays: 40,
        targetCoverDays: 30,
        orderSoonWindowDays: 5,
        leadTimeFreshnessDays: 30,
        purchasedPipelineGraceDays: 1,
        defaultSupplierLeadTimeDays: 12,
        profitTierAThreshold: 500,
        profitTierBThreshold: 200,
        profitTierCThreshold: 0,
      },
    });
  });

  it('normalizes and persists an operator-defined purchased-pipeline status', async () => {
    const service = new EcobasePlanningSettingsService(new MemoryDatabase());
    await service.saveSettings({
      supplierOrderPurchasedPipelineStatuses: ['paid', 'Supplier Paid Wire'],
    });

    await expect(service.getActiveSettings()).resolves.toMatchObject({
      settings: {
        supplierOrderPurchasedPipelineStatuses: ['paid', 'supplier_paid_wire'],
      },
    });
  });
});
