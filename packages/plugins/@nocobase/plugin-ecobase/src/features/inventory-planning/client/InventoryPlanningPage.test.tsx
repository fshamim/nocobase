/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { App } from 'antd';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryPlanningPage from './InventoryPlanningPage';

const request = vi.fn();
const api = { request };

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => api,
}));

vi.mock('../../../client/locale', () => ({
  useT: () => (value: string) => value,
}));

vi.mock('../../../client/role-boundary', () => ({
  useEcobaseRoleCapabilities: () => ({ canOperate: false, canAdminister: false }),
}));

const emptyPane = { rows: [], total: 0, page: 1, pageSize: 50, metrics: [] };
const correctedAction = {
  naturalKey: 'action-family-1',
  companyProductId: 'action-product-1',
  companyProductFamilyId: 'family-action-1',
  company: 'ACME',
  asin: 'B000ACTION',
  sku: 'ACTION-SKU',
  baselineTier: 'A',
  baselineTierScore: '300.00000000',
  baselineState: 'ranked',
  baselineConfidence: 'full',
  averageMonthlyProfit: '300.00000000',
  averageMonthlyUnits: '10.00000000',
  primaryActionPane: 'supplyAction',
  primaryActionReasonCode: 'new_replenishment_action',
  replenishmentEligibility: 'eligible',
  newReplenishmentActionable: true,
  existingOrderFollowUp: false,
  recommendedOrderQty: '12.00000000',
  listingReviewCategories: [],
  monthlyPerformanceEvidence: [],
};
const panes = {
  supplyAction: { ...emptyPane, rows: [correctedAction], total: 1 },
  activeOrders: emptyPane,
  inPrepMonitoring: emptyPane,
  inboundMonitoring: emptyPane,
  healthyInventory: emptyPane,
  excessInventory: emptyPane,
  stuckInventory: emptyPane,
  zeroStock: emptyPane,
  dataReadiness: emptyPane,
  performanceReview: emptyPane,
  untieredProducts: emptyPane,
};

function response(data: unknown) {
  return Promise.resolve({ data: { data } });
}

describe('Inventory Planning corrected listing integration', () => {
  beforeEach(() => {
    request.mockReset();
    request.mockImplementation(({ url }: { url: string }) => {
      if (url === 'ecobasePlanningConfiguration:get') return response({ settings: {} });
      if (url === 'ecobaseInventoryPlanning:workspace') {
        return response({
          filters: { companies: ['ACME'], baselineTiers: ['A', 'B', 'C', 'D'] },
          rows: [correctedAction],
          digest: {
            metadata: { denominatorCount: 1, publishedRunId: 'published-run-1' },
            summary: { actionable: 1, atRisk: 1 },
            sections: {
              orderNow: [correctedAction],
              noOrderProducts: [correctedAction],
              suppliersToContactFirst: [],
              supplierActionItems: [correctedAction],
              staleLeadTimes: [],
            },
          },
        });
      }
      if (url === 'ecobaseInventoryPlanning:commandCenter') {
        return response({
          metadata: {
            denominatorCount: 1,
            publishedRunId: 'published-run-1',
            baselineTierCounts: { A: 1, B: 0, C: 0, D: 0 },
            historyReadiness: { status: 'ready', affectedRowCount: 0, totalRowCount: 1 },
          },
          summaryCards: [
            {
              key: 'averageMonthlyProfit',
              label: 'Average monthly profit',
              value: 300,
              format: 'currency',
            },
          ],
          macroRisk: [],
          riskBars: [],
          panes,
          selectedRow: null,
        });
      }
      if (url === 'ecobaseInventoryPlanning:listingPerformanceReview') {
        return response({
          scope: 'listing_performance_review',
          selectedCategories: [],
          listingCount: 1,
          actionCount: 0,
          rows: [
            {
              companyProductId: 'published-product-1',
              companyProductFamilyId: 'family-1',
              asin: 'B000PUBLISHED',
              sku: 'PUBLISHED-SKU',
              baselineTier: 'D',
              baselineConfidence: 'full',
              listingReviewCategories: ['tier_d'],
              inventoryDisposition: 'none',
              replenishmentEligibility: 'blocked_tier_d',
            },
          ],
        });
      }
      throw new Error(`Unexpected Inventory Planning client request: ${url}`);
    });
  });

  it('loads the ACL-backed published review endpoint into the operational page', async () => {
    render(
      <App>
        <InventoryPlanningPage />
      </App>,
    );

    const review = await screen.findByRole('region', { name: 'Listing Performance Review' });
    expect(review).toHaveTextContent('PUBLISHED-SKU');
    expect(review).toHaveTextContent('Listing evidence only · 0 family actions created');
    expect(review).toHaveTextContent('Baseline D');
    for (const pane of [
      'Performance Review',
      'Stuck Inventory',
      'Excess Inventory',
      'Data Readiness',
      'Untiered Products',
    ]) {
      expect(screen.getByRole('button', { name: pane })).toBeTruthy();
    }
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'ecobaseInventoryPlanning:listingPerformanceReview',
          method: 'post',
          data: expect.objectContaining({ categories: [] }),
        }),
      ),
    );
    expect(await screen.findByText('ACTION-SKU')).toBeTruthy();
    expect(screen.getAllByText('Average monthly profit').length).toBeGreaterThan(0);
    expect(screen.queryByText('Money at risk')).toBeNull();
    expect(screen.queryByText('UNPUBLISHED CANDIDATE — NOT OPERATIONAL')).toBeNull();
  });
});
