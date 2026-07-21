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

describe('Gold maintenance operator lifecycle', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('submits one automatic refresh-and-publish request without a manual workflow', async () => {
    request.mockResolvedValue({
      data: {
        data: {
          status: 'published',
          goldRunId: 'gold-run-1',
          inputDigest: 'a'.repeat(64),
        },
      },
    });
    render(<GoldMaintenancePage />);

    expect(screen.queryByRole('textbox', { name: /run id|payload|confirmation/i })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh and publish' }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith({
      url: 'ecobaseInventoryPlanning:refreshAndPublish',
      method: 'post',
      data: {},
    });
    expect(await screen.findByText('Gold publication completed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /verify candidate|publish candidate|load preview/i })).toBeNull();
  });
});
