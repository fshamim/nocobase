/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useAPIClient, useCurrentRoles } from '@nocobase/client';

const ADMIN_ROLES = new Set(['root', 'admin']);
const OPERATOR_ROLES = new Set([...ADMIN_ROLES, 'operator']);

export function ecobaseRoleCapabilities(currentRole?: string, assignedRoles: string[] = []) {
  const activeRoles = currentRole === '__union__' ? assignedRoles : currentRole ? [currentRole] : [];
  return {
    canOperate: activeRoles.some((role) => OPERATOR_ROLES.has(role)),
    canAdminister: activeRoles.some((role) => ADMIN_ROLES.has(role)),
  };
}

export function useEcobaseRoleCapabilities() {
  const api = useAPIClient();
  const roles = useCurrentRoles();
  return ecobaseRoleCapabilities(
    typeof api.auth.role === 'string' ? api.auth.role : undefined,
    roles.map((role) => role.name),
  );
}
