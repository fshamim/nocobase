/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildCorrectedGoldProjection } from '../../features/inventory-dashboard/server/engine/listing-family-projection';
import { OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS } from '../../features/inventory-dashboard/server/engine/gold-schema-contract';
import goldInventoryPlanningRows from '../collections/gold-inventory-planning-rows';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import Migration from '../migrations/20260720134500-remove-obsolete-gold-inventory-planning-fields';

function collectionFields() {
  return (
    goldInventoryPlanningRows as unknown as {
      fields: Array<{ name: string; foreignKey?: string }>;
    }
  ).fields.map((field) => field.foreignKey ?? field.name);
}

function migrationFixture(options: { rowCount: number; publicationCapableRunCount?: number; columns?: string[] }) {
  const removeField = vi.fn();
  const destroy = vi.fn();
  const removeColumn = vi.fn();
  const transaction = {};
  const countRows = vi.fn(async () => options.rowCount);
  const countRuns = vi.fn(async () => options.publicationCapableRunCount ?? 0);
  const describeTable = vi.fn(async () =>
    Object.fromEntries((options.columns ?? [...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS]).map((name) => [name, {}])),
  );
  const db = {
    getCollection: vi.fn(() => ({ getTableNameWithSchema: () => 'goldInventoryPlanningRows', removeField })),
    getRepository: vi.fn((name: string) => {
      if (name === ECOBASE_COLLECTIONS.goldInventoryPlanningRows) return { count: countRows };
      if (name === ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns) return { count: countRuns };
      if (name === 'fields') return { destroy };
      throw new Error(`Unexpected repository ${name}.`);
    }),
    sequelize: {
      transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback(transaction)),
      getQueryInterface: () => ({ describeTable, removeColumn }),
    },
  };
  const migration = new Migration({ db, queryInterface: undefined, sequelize: undefined } as never);
  return { migration, transaction, removeField, destroy, removeColumn, countRows, countRuns };
}

describe('clean Gold inventory-planning schema', () => {
  it('defines the exact TD-18 removal contract and keeps only corrected listing fields', () => {
    expect(OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS).toHaveLength(74);
    expect(new Set(OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS).size).toBe(74);
    expect(collectionFields()).not.toEqual(expect.arrayContaining([...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS]));
    expect(collectionFields()).toEqual(
      expect.arrayContaining([
        'companyProductId',
        'companyProductFamilyId',
        'refreshRunId',
        'baselineTier',
        'baselineTierScore',
        'currentProjectedTier',
        'inventoryDisposition',
        'recommendedOrderQty',
        'primaryActionPane',
        'calculationEvidence',
      ]),
    );
  });

  it('fails closed before destructive cleanup while any Gold row exists', async () => {
    const fixture = migrationFixture({ rowCount: 1 });

    await expect(fixture.migration.up()).rejects.toThrow(
      'EcoBase obsolete Gold-field cleanup requires zero Gold rows; found 1.',
    );
    expect(fixture.destroy).not.toHaveBeenCalled();
    expect(fixture.removeColumn).not.toHaveBeenCalled();
    expect(fixture.removeField).not.toHaveBeenCalled();
  });

  it('fails closed while a publication-capable refresh run exists', async () => {
    const fixture = migrationFixture({ rowCount: 0, publicationCapableRunCount: 1 });

    await expect(fixture.migration.up()).rejects.toThrow(
      'EcoBase obsolete Gold-field cleanup requires zero publication-capable runs; found 1.',
    );
    expect(fixture.removeColumn).not.toHaveBeenCalled();
  });

  it('removes exactly the obsolete metadata, columns, and in-memory fields transactionally', async () => {
    const fixture = migrationFixture({ rowCount: 0 });

    await fixture.migration.up();

    expect(fixture.countRows).toHaveBeenCalledWith({ transaction: fixture.transaction });
    expect(fixture.countRuns).toHaveBeenCalledWith({
      filter: { status: { $in: ['requested', 'running', 'materialized', 'verified', 'published'] } },
      transaction: fixture.transaction,
    });
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(fixture.destroy).toHaveBeenCalledWith({
      filter: {
        collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
        name: { $in: [...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS] },
      },
      transaction: fixture.transaction,
    });
    expect(fixture.removeColumn).toHaveBeenCalledTimes(74);
    expect(fixture.removeColumn).toHaveBeenCalledWith(
      'goldInventoryPlanningRows',
      OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS[0],
      { transaction: fixture.transaction },
    );
    expect(fixture.removeField).toHaveBeenCalledTimes(74);
  });

  it('strips every obsolete input property before listing persistence and digesting', () => {
    const obsoleteInput = Object.fromEntries(OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS.map((name) => [name, 'legacy']));
    const projection = buildCorrectedGoldProjection({
      runId: 'run-clean',
      calculationDate: '2026-07-16',
      ruleVersion: 'individual_dynamic_6m_profit_trend_v3',
      algorithmContractVersion: 'individual_monthly_profit_performance_v2',
      currentProjectionGateMode: 'informational',
      resolvedPlanningSettingsDigest: '1'.repeat(64),
      sourceCoverageDigest: '2'.repeat(64),
      sourceInputDigest: '3'.repeat(64),
      protectedSilverFingerprint: '4'.repeat(64),
      candidateInputDigest: '5'.repeat(64),
      generatedAt: '2026-07-20T00:00:00.000Z',
      expectedListingCount: 1,
      expectedFamilyActionCount: 1,
      listings: [
        {
          ...obsoleteInput,
          companyProductId: 'cp-1',
          companyProductFamilyId: 'family-1',
          companyId: 'company-1',
          amazonAccountId: 'account-1',
          marketplace: 'Amazon.com',
          asin: 'ASIN-1',
          sku: 'SKU-1',
          baselineTier: 'A',
          baselineTierScore: '300.00000000',
          baselineState: 'ranked',
          baselineConfidence: 'full',
          inventoryDisposition: 'none',
          productCoverageDigest: '6'.repeat(64),
          replenishmentDecision: {
            replenishmentEligibility: 'eligible',
            replenishmentBlockReasonCode: 'eligible',
            newReplenishmentActionable: true,
            oosAlertActionable: false,
            supplyActionable: false,
            recommendedOrderQty: '10.00000000',
            existingOrderFollowUp: false,
            existingOrderFollowUpAction: 'none',
            primaryActionPane: 'replenishment',
            primaryActionReasonCode: 'eligible_replenishment',
            calculationEvidence: {},
          },
        },
      ],
      families: [
        {
          familyKey: 'family-key-1',
          companyProductFamilyId: 'family-1',
          companyId: 'company-1',
          amazonAccountId: 'account-1',
          marketplace: 'Amazon.com',
          canonicalAsin: 'ASIN-1',
          targetSelectionState: 'automatic',
          targetCompanyProductId: 'cp-1',
          memberCompanyProductIds: ['cp-1'],
          targetSelectionEvidence: {},
        },
      ],
    });

    expect(Object.keys(projection.listingRows[0])).not.toEqual(
      expect.arrayContaining([...OBSOLETE_INVENTORY_PLANNING_ROW_FIELDS]),
    );
  });
});
