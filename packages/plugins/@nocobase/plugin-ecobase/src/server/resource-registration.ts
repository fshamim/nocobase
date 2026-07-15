/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ecobaseAclCondition, type EcobaseAclAccess } from './role-boundary';

type ResourceActions = Record<string, unknown>;
type EcobaseAclCondition = string | ((ctx: unknown) => boolean);

interface EcobaseResourceRegistrationApp {
  resourceManager: {
    define: (definition: { name: string; actions: ResourceActions }) => void;
  };
  acl: {
    allow: (resource: string, actions: string[], condition: EcobaseAclCondition) => void;
  };
}

export interface EcobaseResourceDefinition {
  name: string;
  actions: ResourceActions;
}

export interface EcobaseResourceAclGrant {
  resource: string;
  actions: string[];
  role: EcobaseAclAccess;
}

export interface EcobaseFeatureResourceRegistration {
  resources: EcobaseResourceDefinition[];
  acl: EcobaseResourceAclGrant[];
}

export const LOGGED_IN = 'loggedIn' as const;
export const OPERATOR = 'operator' as const;
export const ADMIN = 'admin' as const;

export function registerEcobaseResources(
  app: EcobaseResourceRegistrationApp,
  registrations: EcobaseFeatureResourceRegistration[],
) {
  for (const registration of registrations) {
    for (const definition of registration.resources) {
      app.resourceManager.define(definition);
    }
    for (const grant of registration.acl) {
      app.acl.allow(grant.resource, grant.actions, ecobaseAclCondition(grant.role));
    }
  }
}
