# Ecobase BI plugin

This plugin is the Issue 004 source-controlled foundation for Ecofission BI. It owns the initial company/account/source/import schema, source-adapter registry, no-op import action, and import/source status UI source.

## Local source setup

From the `nocobase/` repository root:

```bash
yarn install
# For the repository docker-compose Postgres service, .env must point to the exposed host port:
# DB_HOST=localhost
# DB_PORT=10103
docker compose up -d postgres
# If this source checkout database is empty, initialize NocoBase before enabling plugins:
yarn nocobase install -f
yarn pm enable @nocobase/plugin-ecobase
yarn nocobase upgrade
yarn dev
```

This is the primary development loop. The plugin source of truth stays in `packages/plugins/@nocobase/plugin-ecobase`; do not develop by manually copying built plugin folders into a running app volume.

## Ecobase image build

Build the product image from this fork with:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/build-image.sh ecobase/nocobase:local
```

The image build compiles and packages `@nocobase/plugin-ecobase` from this source tree, then places the packaged plugin in the NocoBase runtime image. Deployment still needs the target database to run upgrade/enable once:

```bash
yarn nocobase upgrade --skip-code-update
yarn pm enable @nocobase/plugin-ecobase
```

## Automated seam validation

The focused NocoBase seam test is:

```bash
yarn test packages/plugins/@nocobase/plugin-ecobase/src/server/__tests__/integration.test.ts --run --reporter=verbose
```

It boots the plugin through `createMockServer`, verifies plugin-owned collection repositories are synced, creates a source connection through the resource API, invokes `ecobaseImport:adapters` and `ecobaseImport:runNoop`, then reads back `ecobaseImport:status`. This test fails closed in normal review and CI runs; the repository includes the `sqlite3` test dependency used by the default `createMockServer` database configuration.

## Live Docker/browser QA gate

For final QA of plugin runtime or UI behavior, run the isolated Docker live gate from the `nocobase/` repository root:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/start-live-gate.sh
```

The script builds the Ecobase image, starts an isolated Postgres + NocoBase Docker Compose project, enables `@nocobase/plugin-ecobase`, waits for `/admin/settings/ecobase`, and prints the URL plus local admin credentials. QA must open the printed URL in a browser, verify the Ecobase status page, capture evidence, then clean up:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/stop-live-gate.sh
```

If Docker or browser automation is unavailable, QA must report the live gate as `BLOCKED`, not `PASS`.

## API smoke test

1. Create a company through the `ecobaseCompanies:create` collection API.
2. Create a source connection through `ecobaseSourceConnections:create` using `sourceType: "noop_test"`.
3. Run the no-op adapter:

```http
POST /api/ecobaseImport:runNoop
{
  "sourceConnectionId": "<source-connection-id>",
  "sourceIdentifier": "manual-noop",
  "sourceVersion": "v1"
}
```

4. Read import/source status:

```http
GET /api/ecobaseImport:status
```

## UI

The status page is registered through the standard NocoBase client plugin surface at `/admin/settings/ecobase` and reads `ecobaseImport:status`. This checkout's plugin loader and build tooling expect `client.js`, `dist/client/index.js`, and `src/client`, matching the existing bundled plugins.

The local pi NocoBase plugin skill currently recommends `src/client-v2`, but this repository's plugin build and server plugin URL endpoint still emit `dist/client/index.js` from `src/client`. Keep Ecobase on `src/client` until the fork has a tested v2 app entry, v2 plugin bundle build, and runtime loader path.
