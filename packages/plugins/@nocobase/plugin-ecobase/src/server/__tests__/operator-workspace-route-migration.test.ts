/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import Migration from '../migrations/20260716040000-assign-operator-workspace-routes';

describe('operator workspace route migration', () => {
  it('idempotently assigns only the EcoBase workspace routes to the operator role', async () => {
    const assignments: Array<{ desktopRouteId: number; roleName: string }> = [];
    const create = vi.fn(async ({ values }) => {
      assignments.push(values);
      return values;
    });
    const migration = new Migration({
      db: {
        getRepository: (name: string) => {
          if (name === 'roles') return { findOne: vi.fn(async () => ({ name: 'operator' })) };
          if (name === 'desktopRoutes') {
            return {
              find: vi.fn(async () => [
                { id: 1, schemaUid: 'ecobase' },
                { id: 2, schemaUid: 'ecobase-supplier-management-link' },
                { id: 3, schemaUid: 'unrelated' },
              ]),
            };
          }
          if (name === 'rolesDesktopRoutes') {
            return {
              findOne: vi.fn(async ({ filter }) =>
                assignments.find(
                  (assignment) =>
                    assignment.desktopRouteId === filter.desktopRouteId && assignment.roleName === filter.roleName,
                ),
              ),
              create,
            };
          }
          throw new Error(`Unexpected repository: ${name}`);
        },
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();
    await migration.up();

    expect(assignments).toEqual([
      { desktopRouteId: 1, roleName: 'operator' },
      { desktopRouteId: 2, roleName: 'operator' },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
