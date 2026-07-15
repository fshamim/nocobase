/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import bronzeSourceRecords from '../collections/bronze-source-records';
import goldInventoryPlanningRefreshRuns from '../collections/gold-inventory-planning-refresh-runs';
import goldInventoryPlanningRows from '../collections/gold-inventory-planning-rows';
import importRuns from '../collections/import-runs';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import reportItems from '../collections/report-items';
import reportRuns from '../collections/report-runs';
import sellerboardProductCosts from '../collections/sellerboard-product-costs';
import silverOrderLines from '../collections/silver-order-lines';
import sourceAccessAudits from '../collections/source-access-audits';
import sourceConnections from '../collections/source-connections';
import sourceWarningPolicies from '../collections/source-warning-policies';

interface FieldOptions {
  name: string;
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  allowNull?: boolean;
  defaultValue?: unknown;
  target?: string;
  foreignKey?: string;
}

interface CollectionOptions {
  name: string;
  autoGenId?: boolean;
  fields?: FieldOptions[];
}

function field(collection: CollectionOptions, name: string) {
  const match = collection.fields?.find((item) => item.name === name);
  if (!match) throw new Error(`Expected collection ${collection.name} to define field ${name}.`);
  return match;
}

describe('Ecobase plugin-owned schema', () => {
  it('keeps source control and import-run identity explicit', () => {
    expect(sourceConnections.name).toBe(ECOBASE_COLLECTIONS.sourceConnections);
    expect(importRuns.name).toBe(ECOBASE_COLLECTIONS.importRuns);
    expect(field(sourceConnections, 'id')).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(field(sourceConnections, 'company')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.silverCompanies,
      foreignKey: 'companyId',
    });
    expect(field(sourceConnections, 'sourceType')).toMatchObject({ type: 'string' });
    expect(field(sourceConnections, 'config')).toMatchObject({ type: 'jsonb' });
    expect(field(importRuns, 'idempotencyKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(importRuns, 'summary')).toMatchObject({ type: 'jsonb' });
    expect(field(bronzeSourceRecords, 'retentionUntil')).toMatchObject({ type: 'datetimeTz' });
  });

  it('binds Gold rows to explicit refresh runs', () => {
    expect(field(goldInventoryPlanningRefreshRuns, 'idempotencyKey')).toMatchObject({
      type: 'string',
      unique: true,
      allowNull: false,
    });
    expect(field(goldInventoryPlanningRefreshRuns, 'status')).toMatchObject({
      type: 'string',
      allowNull: false,
    });
    expect(field(goldInventoryPlanningRows, 'refreshRun')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.goldInventoryPlanningRefreshRuns,
      foreignKey: 'refreshRunId',
    });
  });

  it('keeps unresolved order-line source identity nullable and explicit', () => {
    expect(field(silverOrderLines, 'companyProduct')).toMatchObject({ allowNull: true });
    expect(field(silverOrderLines, 'sourceAsin')).toMatchObject({ type: 'string' });
    expect(field(silverOrderLines, 'sourceSupplierSku')).toMatchObject({ type: 'string' });
    expect(field(silverOrderLines, 'productMappingStatus')).toMatchObject({
      type: 'string',
      allowNull: false,
      defaultValue: 'resolved',
    });
  });

  it('keeps current source audits, costs, and reports on supported collections', () => {
    expect(field(sellerboardProductCosts, 'naturalKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(sourceAccessAudits, 'blockerCode')).toMatchObject({ type: 'string' });
    expect(field(sourceWarningPolicies, 'sourceType')).toMatchObject({ type: 'string', unique: true });
    expect(field(reportRuns, 'idempotencyKey')).toMatchObject({ type: 'string', unique: true });
    expect(field(reportRuns, 'items')).toMatchObject({
      type: 'hasMany',
      target: ECOBASE_COLLECTIONS.reportItems,
      foreignKey: 'reportRunId',
    });
    expect(field(reportItems, 'reportRun')).toMatchObject({
      type: 'belongsTo',
      target: ECOBASE_COLLECTIONS.reportRuns,
      foreignKey: 'reportRunId',
    });
  });
});
