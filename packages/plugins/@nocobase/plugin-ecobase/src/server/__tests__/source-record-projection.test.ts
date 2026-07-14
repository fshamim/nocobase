/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  findForbiddenSourceMaterial,
  projectNormalizedRecordData,
  projectSourceRecord,
  SOURCE_RECORD_PROJECTION_VERSION,
} from '../../features/source-import/server/source-record-projection';
import { fakeSensitiveSupplierRow } from './fixtures/greenfield-migration/fixtures';

describe('source record projection', () => {
  it('constructs a supplier projection and drops unknown sensitive fields', () => {
    const result = projectSourceRecord('supplier_tracker', fakeSensitiveSupplierRow);
    expect(result).toEqual({
      projectionVersion: SOURCE_RECORD_PROJECTION_VERSION,
      droppedFieldCount: 5,
      payload: {
        supplierExternalRef: 'SRO-FAKE-1',
        supplierName: 'Synthetic Supplier',
        companyProvenance: 'Ecofission LLC',
        sourceAsin: 'B000000001',
        sourceSupplierSku: 'SUP-1',
        leadTimeDays: '30',
        minimumOrderQuantity: '12',
      },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-do-not-use');
    expect(findForbiddenSourceMaterial(result)).toEqual([]);
  });

  it('retains the current Sellerboard daily sales and profitability evidence', () => {
    expect(
      projectSourceRecord('sellerboard_daily_facts', {
        Date: '2026-07-01',
        Marketplace: 'Amazon.com',
        ASIN: 'B000000001',
        SKU: 'SKU-1',
        SalesOrganic: '65.70',
        SalesPPC: '10.00',
        UnitsOrganic: '6',
        UnitsPPC: '2',
        GrossProfit: '20.00',
        NetProfit: '15.00',
        Margin: '20.00',
        Refunds: '1',
        '% Refund': '2.5',
        Sessions: '41',
        'Unit Session Percentage': '14.63',
      }),
    ).toEqual({
      projectionVersion: SOURCE_RECORD_PROJECTION_VERSION,
      droppedFieldCount: 0,
      payload: {
        marketplace: 'Amazon.com',
        period: '2026-07-01',
        asin: 'B000000001',
        listingSku: 'SKU-1',
        salesOrganic: '65.70',
        salesPpc: '10.00',
        unitsOrganic: '6',
        unitsPpc: '2',
        grossProfit: '20.00',
        netProfit: '15.00',
        margin: '20.00',
        refunds: '1',
        refundRate: '2.5',
        sessions: '41',
        unitSessionPercentage: '14.63',
      },
    });
  });

  it('retains only operational order fields', () => {
    const result = projectSourceRecord('order_details', {
      Timestamp: '2026-07-01T00:00:00Z',
      'Order ID': 'EF1001A',
      Company: 'Ecofission LLC',
      'SR ID': 'SRO-1',
      Supplier: 'Supplier',
      ASIN: 'B000000001',
      SKU: 'SUP-1',
      Qty: '4',
      PPU: '3.5',
      pass: 'never-persist',
      Remarks: 'not allowlisted',
    });
    expect(result.payload).toEqual({
      occurredAt: '2026-07-01T00:00:00Z',
      orderRef: 'EF1001A',
      company: 'Ecofission LLC',
      supplierExternalRef: 'SRO-1',
      supplierName: 'Supplier',
      sourceAsin: 'B000000001',
      sourceSupplierSku: 'SUP-1',
      quantity: '4',
      unitCost: '3.5',
    });
    expect(result.droppedFieldCount).toBe(2);
  });

  it('keeps ClickUp comment text only after exact retained-order linkage and only when safe', () => {
    const source = {
      taskId: 'task-1',
      orderRef: 'EF1001A',
      status: 'ORDERED',
      commentId: 'comment-1',
      commentBody: 'Supplier confirmed dispatch.',
      assignees: ['not retained'],
      taskUrl: 'https://invalid.example.test/task-1',
    };
    expect(projectSourceRecord('clickup_order_evidence', source)).toMatchObject({
      payload: { taskId: 'task-1', orderRef: 'EF1001A', status: 'ORDERED', commentId: 'comment-1' },
      droppedFieldCount: 3,
    });
    expect(projectSourceRecord('clickup_order_evidence', source, { retainedOrderRef: 'OTHER' })).toMatchObject({
      droppedFieldCount: 3,
    });
    expect(projectSourceRecord('clickup_order_evidence', source, { retainedOrderRef: 'EF1001A' })).toMatchObject({
      payload: { commentBody: 'Supplier confirmed dispatch.' },
      droppedFieldCount: 2,
    });
    expect(
      projectSourceRecord(
        'clickup_order_evidence',
        { ...source, commentBody: 'Contact operator@example.invalid' },
        { retainedOrderRef: 'EF1001A' },
      ).payload,
    ).not.toHaveProperty('commentBody');
    expect(
      projectSourceRecord(
        'clickup_order_evidence',
        { taskId: 'task-1', orderRef: 'EF1001A', commentBody: '   ' },
        { retainedOrderRef: 'EF1001A' },
      ),
    ).toMatchObject({ payload: { taskId: 'task-1', orderRef: 'EF1001A' }, droppedFieldCount: 1 });
    const credentialComment = projectSourceRecord(
      'clickup_order_evidence',
      {
        taskId: 'task-1',
        orderRef: 'EF1001A',
        commentBody: 'Supplier portal password: synthetic-value; username: buyer-admin',
      },
      { retainedOrderRef: 'EF1001A' },
    );
    expect(credentialComment).toMatchObject({
      payload: { taskId: 'task-1', orderRef: 'EF1001A' },
      droppedFieldCount: 1,
    });
    expect(findForbiddenSourceMaterial(credentialComment)).toEqual([]);
  });

  it('projects only the exact supplier identity fields from Supplier IDs', () => {
    expect(
      projectSourceRecord('supplier_ids', {
        'SR ID': 'SRO-404',
        'Supplier Name': 'Missing Supplier',
        Username: 'discard',
        Password: 'discard',
      }),
    ).toMatchObject({
      payload: { supplierExternalRef: 'SRO-404', supplierName: 'Missing Supplier' },
      droppedFieldCount: 2,
    });
  });

  it('rejects unsafe values and nested objects even under allowlisted keys', () => {
    const result = projectSourceRecord('supplier_tracker', {
      'SR ID': 'SRO-1',
      'Supplier Name': 'https://invalid.example.test/login?token=secret',
      Supplier: { password: 'nested-secret' },
      'Reached Via': 'operator@example.invalid',
      ASIN: 'B000000001',
    });
    expect(result.payload).toEqual({ supplierExternalRef: 'SRO-1', sourceAsin: 'B000000001' });
    expect(result.droppedFieldCount).toBe(3);
    expect(findForbiddenSourceMaterial(result)).toEqual([]);
  });

  it('counts populated but unselected aliases as dropped', () => {
    expect(
      projectSourceRecord('supplier_tracker', {
        Supplier: 'Selected supplier',
        'Supplier Name': 'Conflicting supplier',
        Unknown: 'discarded',
      }),
    ).toMatchObject({ payload: { supplierName: 'Selected supplier' }, droppedFieldCount: 2 });
  });

  it('removes raw nested payloads and sensitive normalized fields before direct persistence', () => {
    expect(
      projectNormalizedRecordData({
        naturalKey: 'synthetic:1',
        company: 'Ecofission LLC',
        payload: { raw: 'discard' },
        portalUrl: 'https://portal.example.invalid',
        username: 'synthetic-user',
        statusEvidenceJson: { source: 'raw' },
      }),
    ).toEqual({
      payload: { naturalKey: 'synthetic:1', company: 'Ecofission LLC' },
      droppedFieldCount: 4,
      projectionVersion: SOURCE_RECORD_PROJECTION_VERSION,
    });
  });

  it('reports forbidden source-style key and value paths without returning their values', () => {
    expect(
      findForbiddenSourceMaterial({
        nested: {
          password: 'secret',
          portalUrl: 'https://invalid.example.test',
          'Contact Email': 'opaque',
          'PR Portal Link': 'opaque',
          'User Name': 'opaque',
          'Attachment Data': 'opaque',
          note: 'portal password: synthetic-value',
        },
      }),
    ).toEqual([
      '$.nested.password',
      '$.nested.portalUrl',
      '$.nested.portalUrl',
      '$.nested.Contact Email',
      '$.nested.PR Portal Link',
      '$.nested.User Name',
      '$.nested.Attachment Data',
      '$.nested.note',
    ]);
  });
});
