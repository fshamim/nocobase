/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_WORKSPACE_ROOT, ecobaseWorkspaceRoutes } from './client-routes';

describe('EcoBase client route precedence', () => {
  it('routes the exact candidate-preview path before the workspace wildcard without replacing the ordinary route', () => {
    const previewPath = `${ECOBASE_WORKSPACE_ROOT}/inventory-planning/candidate-preview`;
    const previewIndex = ecobaseWorkspaceRoutes.findIndex((route) => route.path === previewPath);
    const wildcardIndex = ecobaseWorkspaceRoutes.findIndex((route) => route.path === `${ECOBASE_WORKSPACE_ROOT}/*`);
    const ordinaryRoute = ecobaseWorkspaceRoutes.find(
      (route) => route.path === `${ECOBASE_WORKSPACE_ROOT}/inventory-planning`,
    );

    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(previewIndex).toBeLessThan(wildcardIndex);
    expect(ecobaseWorkspaceRoutes[previewIndex].name).toBe('admin.ecobase.inventory-planning.candidate-preview');
    expect(ordinaryRoute?.name).toBe('admin.ecobase.inventory-planning');
    expect(ordinaryRoute?.Component).not.toBe(ecobaseWorkspaceRoutes[previewIndex].Component);
  });
});
