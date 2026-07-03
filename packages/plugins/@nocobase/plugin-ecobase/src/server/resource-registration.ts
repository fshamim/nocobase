type ResourceActions = Record<string, unknown>;

interface EcobaseResourceRegistrationApp {
  resourceManager: {
    define: (definition: { name: string; actions: ResourceActions }) => void;
  };
  acl: {
    allow: (resource: string, actions: string[], role: 'loggedIn') => void;
  };
}

export interface EcobaseResourceDefinition {
  name: string;
  actions: ResourceActions;
}

export interface EcobaseResourceAclGrant {
  resource: string;
  actions: string[];
  role: 'loggedIn';
}

export interface EcobaseFeatureResourceRegistration {
  resources: EcobaseResourceDefinition[];
  acl: EcobaseResourceAclGrant[];
}

export const LOGGED_IN = 'loggedIn' as const;

export function registerEcobaseResources(
  app: EcobaseResourceRegistrationApp,
  registrations: EcobaseFeatureResourceRegistration[],
) {
  for (const registration of registrations) {
    for (const definition of registration.resources) {
      app.resourceManager.define(definition);
    }
    for (const grant of registration.acl) {
      app.acl.allow(grant.resource, grant.actions, grant.role);
    }
  }
}
