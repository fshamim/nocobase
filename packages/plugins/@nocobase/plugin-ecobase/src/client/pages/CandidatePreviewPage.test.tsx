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

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CandidatePreviewPage from './CandidatePreviewPage';

const request = vi.fn();

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => ({ request }),
}));

vi.mock('../locale', () => ({
  useT: () => (value: string) => value,
}));

const runId = '41501a75-bdb0-4ea1-8297-cc1ef9b972de';
const route = `/admin/ecobase/inventory-planning/candidate-preview?runId=${runId}`;

function renderPage(path = route) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CandidatePreviewPage />
    </MemoryRouter>,
  );
}

describe('dedicated candidate preview page', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('loads the required query run automatically and exposes only read-only unpublished evidence', async () => {
    request.mockResolvedValue({
      data: {
        data: {
          rows: [
            {
              companyProductId: 'cp-1',
              companyProductFamilyId: 'family-1',
              asin: 'B000000001',
              sku: 'SKU-1',
              baselineTier: 'D',
              baselineConfidence: 'full',
              baselineState: 'ranked',
              inventoryDisposition: 'none',
              replenishmentEligibility: 'blocked_baseline_tier_d',
              listingReviewCategories: ['tier_d'],
              monthlyPerformanceEvidence: [],
            },
          ],
          familyActions: [
            {
              companyProductId: 'cp-1',
              companyProductFamilyId: 'family-1',
              targetCompanyProductId: 'cp-1',
              representativeCompanyProductId: 'cp-1',
              primaryActionPane: 'performanceReview',
              replenishmentEligibility: 'blocked_baseline_tier_d',
              replenishmentBlockReasonCode: 'baseline_tier_d',
              newReplenishmentActionable: false,
            },
          ],
        },
      },
    });

    renderPage();

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        url: 'ecobaseInventoryPlanning:candidatePreview',
        method: 'post',
        data: { runId },
      }),
    );
    expect(await screen.findByRole('region', { name: 'Unpublished candidate preview' })).toHaveTextContent(
      'UNPUBLISHED CANDIDATE — NOT OPERATIONAL',
    );
    expect(screen.getByText(runId)).toBeInTheDocument();
    expect(screen.getByText('Candidate family decision')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /build|verify|publish/i })).toBeNull();
  });

  it('lets the server deny a non-admin request so the authoritative audit path executes', async () => {
    request.mockRejectedValue(new Error('Candidate preview access denied'));

    renderPage();

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Candidate preview access denied');
    expect(screen.queryByRole('region', { name: 'Unpublished candidate preview' })).toBeNull();
  });

  it('fails closed without the required query run ID and sends no request', () => {
    renderPage('/admin/ecobase/inventory-planning/candidate-preview');

    expect(screen.getByRole('alert')).toHaveTextContent('Candidate preview requires an explicit verified run ID.');
    expect(request).not.toHaveBeenCalled();
  });
});
