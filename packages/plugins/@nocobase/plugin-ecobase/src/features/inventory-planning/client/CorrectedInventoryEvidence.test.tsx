/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CandidatePreviewPanel,
  CorrectedInventoryEvidencePanel,
  ListingPerformanceReviewPanel,
} from './CorrectedInventoryEvidence';

const t = (value: string) => value;

const correctedRow = {
  companyProductId: 'cp-1',
  companyProductFamilyId: 'family-1',
  asin: 'B000000001',
  sku: 'SKU-1',
  algorithmContractVersion: 'individual_monthly_profit_performance_v1',
  baselineTier: 'B',
  baselineTierScore: '150.00000000',
  baselineState: 'ranked',
  baselineConfidence: 'full',
  monthlyPerformanceEvidence: [
    {
      monthStart: '2026-01-01',
      monthlyUnits: '10.00000000',
      monthlyProfit: '100.00000000',
      monthlyTierScore: '100.00000000',
    },
    {
      monthStart: '2026-02-01',
      monthlyUnits: '8.00000000',
      monthlyProfit: '80.00000000',
      monthlyTierScore: '80.00000000',
    },
  ],
  lastClosedMonth: '2026-02-01',
  lastClosedMonthTier: 'C',
  lastClosedMonthState: 'ranked',
  closedTierMovement: 'declined',
  currentProjectedTier: 'D',
  currentProjectedTierScore: '-10.00000000',
  currentProjectedState: 'ranked',
  currentProjectionConfidence: 'trusted',
  projectedTierMovement: 'declined',
  averageMonthlyUnits: '9.00000000',
  bestMonthlyUnits: '10.00000000',
  worstMonthlyUnits: '8.00000000',
  averageMonthlyProfit: '90.00000000',
  bestMonthlyProfit: '100.00000000',
  worstMonthlyProfit: '80.00000000',
  quantityPaceStatus: 'below_average',
  profitPaceStatus: 'below_worst',
  aggregatePaceStatus: 'below_worst',
  paceCause: 'profit',
  inventoryDisposition: 'no_sell_through',
  replenishmentEligibility: 'blocked_stuck_inventory',
  replenishmentBlockReasonCode: 'blocked_stuck_inventory',
  existingOrderFollowUp: true,
  existingOrderFollowUpAction: 'follow_up_existing_order',
  listingReviewCategories: ['closed_decline', 'projected_decline', 'stuck'],
  memberPerformanceEvidence: [
    { companyProductId: 'cp-1', baselineTier: 'B', inventoryDisposition: 'no_sell_through' },
    { companyProductId: 'cp-2', baselineTier: 'D', inventoryDisposition: 'none' },
  ],
};

describe('corrected Inventory Planning evidence UI', () => {
  it('shows baseline/monthly/closed/current, range/pace, disposition, block, and existing-order evidence accessibly', () => {
    render(<CorrectedInventoryEvidencePanel row={correctedRow} t={t} />);

    const panel = screen.getByRole('region', { name: 'Corrected individual listing performance' });
    expect(panel).toHaveTextContent('Baseline B');
    expect(panel).toHaveTextContent('full confidence');
    expect(panel).toHaveTextContent('2026-01-01');
    expect(panel).toHaveTextContent('Closed C');
    expect(panel).toHaveTextContent('Current projected D');
    expect(panel).toHaveTextContent('Average units 9.00000000');
    expect(panel).toHaveTextContent('Best profit 100.00000000');
    expect(panel).toHaveTextContent('Profit pace below_worst');
    expect(panel).toHaveTextContent('Disposition no_sell_through');
    expect(panel).toHaveTextContent('blocked_stuck_inventory');
    expect(within(panel).getByRole('alert')).toHaveTextContent('follow_up_existing_order');
    expect(panel).toHaveTextContent('Linked member cp-2');
  });

  it('renders a published non-action review surface with all seven listing filters', () => {
    render(
      <ListingPerformanceReviewPanel
        rows={[
          correctedRow,
          {
            ...correctedRow,
            companyProductId: 'cp-2',
            sku: 'SKU-2',
            baselineTier: 'D',
            listingReviewCategories: ['tier_d'],
          },
        ]}
        t={t}
      />,
    );

    const review = screen.getByRole('region', { name: 'Listing Performance Review' });
    expect(review).toHaveTextContent('Listing evidence only · 0 family actions created');
    expect(within(review).getAllByRole('checkbox')).toHaveLength(7);
    fireEvent.click(within(review).getByRole('checkbox', { name: 'published-tier_d' }));
    expect(review).toHaveTextContent('SKU-2');
    expect(review).not.toHaveTextContent('SKU-1');
    expect(review).toHaveTextContent('Baseline D');
  });

  it('keeps the unpublished warning persistent and filters listing evidence without action duplication', () => {
    render(
      <CandidatePreviewPanel
        runId="verified-run-1"
        banner="UNPUBLISHED CANDIDATE — NOT OPERATIONAL"
        rows={[
          correctedRow,
          {
            ...correctedRow,
            companyProductId: 'cp-2',
            sku: 'SKU-2',
            listingReviewCategories: ['tier_d'],
            baselineTier: 'D',
          },
        ]}
        familyActions={[
          {
            ...correctedRow,
            targetCompanyProductId: 'cp-1',
            actionSourceCompanyProductId: 'cp-1',
            representativeCompanyProductId: 'cp-1',
            primaryActionPane: 'stuckInventory',
            replenishmentBlockReasonCode: 'blocked_stuck_inventory',
            newReplenishmentActionable: false,
            existingOrderFollowUp: true,
          },
        ]}
        t={t}
      />,
    );

    const preview = screen.getByRole('region', { name: 'Unpublished candidate preview' });
    const bannerAlert = within(preview).getByText('UNPUBLISHED CANDIDATE — NOT OPERATIONAL').closest('[role="alert"]');
    expect(bannerAlert).toHaveTextContent('UNPUBLISHED CANDIDATE — NOT OPERATIONAL');
    expect(screen.getByText(/verified-run-1/)).toBeTruthy();
    expect(screen.getByText('1 read-only family-action projections · 0 operational actions created')).toBeTruthy();
    expect(preview).toHaveTextContent('Candidate family decision');
    expect(preview).toHaveTextContent('stuckInventory');
    expect(preview).toHaveTextContent('candidate blocked');
    for (const category of [
      'tier_d',
      'no_movement',
      'closed_decline',
      'projected_decline',
      'stuck',
      'excess',
      'data_readiness',
    ]) {
      expect(screen.getByRole('checkbox', { name: category })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole('checkbox', { name: 'tier_d' }));
    expect(screen.getByText(/SKU-2/)).toBeTruthy();
    expect(screen.queryByText(/SKU-1/)).toBeNull();
    expect(bannerAlert).toHaveTextContent('UNPUBLISHED CANDIDATE — NOT OPERATIONAL');
  });
});
