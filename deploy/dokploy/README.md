# Dokploy deployments

## Staging auto-deploy

`.github/workflows/deploy-staging-dokploy.yml` triggers the existing Dokploy staging compose on pushes to `ecobase/staging` only.

Staging target:

- compose app: `ecobase-staging-2ndggj`
- compose id: `aRy6QtSxet6ceV8hoKbhq`
- branch: `ecobase/staging`
- compose path: `deploy/dokploy/staging/docker-compose.yml`

Required GitHub repository secrets:

- `DOKPLOY_URL`: base URL for the Dokploy instance, without `/api`
- `DOKPLOY_API_KEY`: Dokploy API key with permission to deploy the staging compose

The workflow calls `POST /api/compose.deploy` with the `x-api-key` header and fails on any non-2xx response.

Production is intentionally not wired here. Add a separate workflow and separate Dokploy secret scope before enabling production auto-deploy.
