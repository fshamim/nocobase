/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoldMaintenancePage from './GoldMaintenancePage';

const request = vi.fn();

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => ({ request }),
}));

vi.mock('../locale', () => ({
  useT: () => (value: string) => value,
}));

describe('Gold maintenance candidate preview', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('requires an explicit verified run and keeps the returned unpublished banner visible', async () => {
    request.mockResolvedValue({
      data: {
        data: {
          banner: 'UNPUBLISHED CANDIDATE — NOT OPERATIONAL',
          rows: [
            {
              companyProductId: 'cp-1',
              companyProductFamilyId: 'family-1',
              asin: 'B000000001',
              sku: 'SKU-1',
              baselineTier: 'B',
              inventoryDisposition: 'none',
              replenishmentEligibility: 'eligible',
              listingReviewCategories: [],
            },
            {
              companyProductId: 'cp-2',
              companyProductFamilyId: 'family-1',
              asin: 'B000000001',
              sku: 'SKU-2',
              baselineTier: 'D',
              inventoryDisposition: 'none',
              replenishmentEligibility: 'blocked_baseline_tier_d',
              listingReviewCategories: ['tier_d'],
            },
          ],
        },
      },
    });
    render(<GoldMaintenancePage />);

    const runId = screen.getByRole('textbox', { name: 'Explicit verified run ID' });
    const load = screen.getByRole('button', { name: 'Load read-only candidate preview' });
    expect(load).toBeDisabled();
    fireEvent.change(runId, { target: { value: 'verified-run-1' } });
    expect(load).not.toBeDisabled();
    fireEvent.click(load);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith({
      url: 'ecobaseInventoryPlanning:candidatePreview',
      method: 'post',
      data: { runId: 'verified-run-1' },
    });
    const banner = await screen.findByText('UNPUBLISHED CANDIDATE — NOT OPERATIONAL');
    expect(banner.closest('[role="alert"]')).toHaveTextContent('UNPUBLISHED CANDIDATE — NOT OPERATIONAL');
    expect(screen.getByText(/SKU-1/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Corrected individual listing performance' })).toHaveTextContent(
      'Linked member cp-2',
    );
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
  });
});
