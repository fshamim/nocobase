/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_WORKSPACE_ROOT, ecobaseWorkspacePages, ecobaseWorkspaceRoutes } from './client-routes';

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
    expect(ecobaseWorkspaceRoutes[previewIndex]).toMatchObject({
      name: 'admin.ecobase.candidate-preview',
      path: previewPath,
    });
    expect(ordinaryRoute?.name).toBe('admin.ecobase.inventory-planning');
    expect(ecobaseWorkspaceRoutes[previewIndex].name).not.toMatch(/^admin\.ecobase\.inventory-planning\./);
    expect(ordinaryRoute?.Component).not.toBe(ecobaseWorkspaceRoutes[previewIndex].Component);
  });

  it('lists Inventory Dashboard as a sibling workspace page next to Inventory Planning (REQ-X4)', () => {
    const entry = ecobaseWorkspacePages.find((page) => page.key === 'inventory-dashboard');
    expect(entry).toMatchObject({
      key: 'inventory-dashboard',
      label: 'Inventory Dashboard',
      icon: 'FundViewOutlined',
      path: `${ECOBASE_WORKSPACE_ROOT}/inventory-dashboard`,
    });
    // No role gate: visible to every logged-in workspace member, like Inventory Planning.
    expect(entry && 'access' in entry).toBe(false);
    const planningIndex = ecobaseWorkspacePages.findIndex((page) => page.key === 'inventory-planning');
    const dashboardIndex = ecobaseWorkspacePages.findIndex((page) => page.key === 'inventory-dashboard');
    expect(planningIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardIndex).toBe(planningIndex + 1);
    const route = ecobaseWorkspaceRoutes.find((candidate) => candidate.name === 'admin.ecobase.inventory-dashboard');
    expect(route?.path).toBe(`${ECOBASE_WORKSPACE_ROOT}/inventory-dashboard`);
  });
});
