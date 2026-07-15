/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type EcobaseRoleRequirement = 'operator' | 'admin';
export type EcobaseAclAccess = 'loggedIn' | EcobaseRoleRequirement;

type EcobaseRoleContext = {
  state?: Record<string, unknown>;
  throw: (status: number, message: string) => never;
};

type EcobaseAction = (ctx: any, next: any) => unknown;

function activeRoles(ctx: Pick<EcobaseRoleContext, 'state'>) {
  if (Array.isArray(ctx.state?.currentRoles)) {
    return (ctx.state.currentRoles as unknown[]).filter((role): role is string => typeof role === 'string');
  }
  return typeof ctx.state?.currentRole === 'string' ? [ctx.state.currentRole] : [];
}

export function hasEcobaseRole(ctx: Pick<EcobaseRoleContext, 'state'>, required: EcobaseRoleRequirement) {
  const allowed = required === 'admin' ? ['root', 'admin'] : ['root', 'admin', 'operator'];
  return activeRoles(ctx).some((role) => allowed.includes(role));
}

export function requireEcobaseRole(ctx: EcobaseRoleContext, required: EcobaseRoleRequirement, operation = 'operation') {
  if (!ctx.state?.currentUser) {
    ctx.throw(401, `Ecobase ${operation} requires an authenticated user.`);
  }
  if (!hasEcobaseRole(ctx, required)) {
    const roles = required === 'admin' ? 'admin or root' : 'operator, admin, or root';
    ctx.throw(403, `Ecobase ${operation} requires the ${roles} role.`);
  }
}

export function ecobaseAclCondition(access: EcobaseAclAccess) {
  if (access === 'loggedIn') return 'loggedIn';
  return (ctx: Pick<EcobaseRoleContext, 'state'>) => Boolean(ctx.state?.currentUser) && hasEcobaseRole(ctx, access);
}

export function guardEcobaseActions<T extends Record<string, EcobaseAction>>(
  actions: T,
  requirements: Partial<Record<keyof T, EcobaseRoleRequirement>>,
): T {
  for (const [name, required] of Object.entries(requirements) as [keyof T, EcobaseRoleRequirement][]) {
    const action = actions[name];
    if (typeof action !== 'function') {
      throw new Error(`Ecobase role policy references unknown action "${String(name)}".`);
    }
    actions[name] = (async (ctx, next) => {
      requireEcobaseRole(ctx, required, String(name));
      return action(ctx, next);
    }) as T[keyof T];
  }
  return actions;
}
